const http = require('http');
const WebSocket = require('ws');
const Matter = require('matter-js');

const CONFIG = { W: 600, H: 900, R: 22, GAP: 50, BARRIER: 24, TICK_RATE: 1000/60, BROADCAST_RATE: 1000/20, RESTITUTION: 0.84, AIR_FRICTION: 0.014, WALL_RESTITUTION: 0.72, MAX_SPEED: 14, MAX_DRAG: 145, MIN_DRAG: 10, MAX_LAUNCHES_PER_SECOND: 8, IDLE_SPEED: 0.35 };
const MID_Y = CONFIG.H / 2;
const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => { res.writeHead(200); res.end('OK'); });
const wss = new WebSocket.Server({ server });
const rooms = new Map();

class GameRoom {
  constructor(matchId, roomId) {
    this.matchId = matchId; this.roomId = roomId;
    this.clients = new Map();
    this.engine = Matter.Engine.create({ enableSleeping: true });
    this.engine.gravity.y = 0; this.engine.gravity.scale = 0;
    this.pucks = []; this.winnerId = null; this.started = false;
    this.initPhysics();
    this.tickInterval = setInterval(() => this.tick(), CONFIG.TICK_RATE);
    this.broadcastInterval = setInterval(() => this.broadcast(), CONFIG.BROADCAST_RATE);
  }

  initPhysics() {
    const { Bodies, Composite } = Matter;
    const wallOpt = { isStatic: true, restitution: CONFIG.WALL_RESTITUTION, friction: 0 };
    const walls = [
      Bodies.rectangle(CONFIG.W / 2, -18, CONFIG.W + 40, 36, wallOpt),
      Bodies.rectangle(CONFIG.W / 2, CONFIG.H + 18, CONFIG.W + 40, 36, wallOpt),
      Bodies.rectangle(-1, CONFIG.H / 2, 36, CONFIG.H + 50, wallOpt),
      Bodies.rectangle(CONFIG.W + 1, CONFIG.H / 2, 36, CONFIG.H + 50, wallOpt)
    ];
    const blockW = (CONFIG.W - CONFIG.GAP) / 2;
    Composite.add(this.engine.world, [
      ...walls,
      Bodies.rectangle(blockW / 2, MID_Y, blockW, CONFIG.BARRIER, wallOpt),
      Bodies.rectangle(CONFIG.W - blockW / 2, MID_Y, blockW, CONFIG.BARRIER, wallOpt)
    ]);
    for (const x of [100, 200, 300, 400, 500]) {
      this.addPuck(1, x, CONFIG.H - 82);
      this.addPuck(2, x, 82);
    }
  }

  addPuck(owner, x, y) {
    const body = Matter.Bodies.circle(x, y, CONFIG.R, { restitution: CONFIG.RESTITUTION, friction: 0.025, frictionAir: CONFIG.AIR_FRICTION, density: 0.0015 });
    body.plugin = { owner };
    Matter.Composite.add(this.engine.world, body);
    this.pucks.push(body);
  }

  send(ws, data) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }

  addPlayer(ws, slot, userId) {
    this.clients.set(ws, { slot, userId });
    this.send(ws, { type: 'joined' });
    this.send(ws, { type: 'state', state: { pucks: this.pucks.map(p => ({ id: p.id, x: p.position.x, y: p.position.y, owner: p.plugin.owner })) } });
    if (this.clients.size === 2) {
      this.started = true;
      for (const c of this.clients.keys()) this.send(c, { type: 'start' });
    }
  }

  broadcast() {
    if (this.winnerId !== null) return;
    for (const [ws, data] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const isSlot2 = data.slot === 2;
      const pucks = this.pucks.map(p => ({
        id: p.id,
        x: isSlot2 ? CONFIG.W - p.position.x : p.position.x,
        y: isSlot2 ? CONFIG.H - p.position.y : p.position.y,
        owner: isSlot2 ? (p.plugin.owner === 1 ? 2 : 1) : p.plugin.owner
      }));
      this.send(ws, { type: 'state', state: { pucks } });
    }
  }

  tick() {
    if (!this.started || this.winnerId !== null) return;
    Matter.Engine.update(this.engine, CONFIG.TICK_RATE);
    let p1Count = 0, p2Count = 0;
    this.pucks.forEach(p => { if (p.position.y >= MID_Y) p1Count++; else p2Count++; });
    if (p1Count === 0) this.endGame(2);
    else if (p2Count === 0) this.endGame(1);
  }

  endGame(winnerSlot) {
    if (this.winnerId !== null) return;
    let winnerUserId = null;
    for (const data of this.clients.values()) {
      if (data.slot === winnerSlot) winnerUserId = data.userId;
    }
    this.winnerId = winnerUserId;
    for (const [ws, data] of this.clients) {
      this.send(ws, { type: 'game_over', isWinner: data.userId === winnerUserId, winnerId: winnerUserId });
    }
  }

  handleLaunch(ws, msg) {
    if (!this.started || this.winnerId !== null) return;
    const client = this.clients.get(ws);
    if (!client) return;
    const puckId = Number(msg.puckId);
    let dx = Number(msg.dx);
    let dy = Number(msg.dy);
    if (client.slot === 2) { dx = -dx; dy = -dy; }
    const distance = Math.hypot(dx, dy);
    if (distance < CONFIG.MIN_DRAG || distance > CONFIG.MAX_DRAG) return;
    const puck = this.pucks.find(p => p.id === puckId);
    if (!puck) return;
    const isInMyHalf = client.slot === 1 ? (puck.position.y >= MID_Y) : (puck.position.y < MID_Y);
    if (!isInMyHalf) return;
    if (Math.hypot(puck.velocity.x, puck.velocity.y) > CONFIG.IDLE_SPEED) return;
    const speed = Math.min(CONFIG.MAX_SPEED, distance * 0.095);
    Matter.Body.setVelocity(puck, { x: (-dx / distance) * speed, y: (-dy / distance) * speed });
    Matter.Sleeping.set(puck, false);
  }

  removePlayer(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0) {
      clearInterval(this.tickInterval);
      clearInterval(this.broadcastInterval);
      if (rooms.get(this.roomId) === this) rooms.delete(this.roomId);
    }
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room_id');
  const matchId = url.searchParams.get('match_id');
  const slot = Number(url.searchParams.get('slot')) || 1;
  const userId = url.searchParams.get('user_id') || '';
  if (!roomId || !matchId || !userId) return ws.close();

  let room = rooms.get(roomId);
  if (!room) {
    room = new GameRoom(matchId, roomId);
    rooms.set(roomId, room);
  }
  room.addPlayer(ws, slot, userId);

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'launch') room.handleLaunch(ws, msg);
  });
  ws.on('close', () => room.removePlayer(ws));
});

server.listen(PORT, () => console.log(`Server on ${PORT}`));
