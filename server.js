const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const Matter = require('matter-js');

const CONFIG = Object.freeze({
  W: 600, H: 900, R: 22, GAP: 50, BARRIER: 24,
  TICK_RATE: 1000 / 60,
  BROADCAST_RATE: 1000 / 20,
  RESTITUTION: 0.84,
  AIR_FRICTION: 0.014,
  WALL_RESTITUTION: 0.72,
  MAX_SPEED: 14,
  MAX_DRAG: 145,
  MIN_DRAG: 10,
  MAX_LAUNCHES_PER_SECOND: 8,
  IDLE_SPEED: 0.35
});
const MID_Y = CONFIG.H / 2;
const PORT = Number(process.env.PORT || 8080);
const WS_HMAC_SECRET = process.env.SP_WS_HMAC_SECRET || '';
const MATCH_RESULT_SECRET = process.env.SP_MATCH_RESULT_SECRET || '';
const MATCH_RESULT_URL = process.env.MATCH_RESULT_URL || 'https://YOUR-DOMAIN.example/api/receive_match_result.php';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);

if (WS_HMAC_SECRET.length < 32) throw new Error('SP_WS_HMAC_SECRET must be at least 32 characters.');
if (MATCH_RESULT_SECRET.length < 32) throw new Error('SP_MATCH_RESULT_SECRET must be at least 32 characters.');
if (MATCH_RESULT_URL.includes('YOUR-DOMAIN')) throw new Error('Set MATCH_RESULT_URL to your real PHP API URL.');

const rooms = new Map();

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
  catch { return false; }
}

function verifyTicket(ticket, requestedRoomId) {
  if (typeof ticket !== 'string' || ticket.length > 2048) return null;
  const parts = ticket.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = crypto.createHmac('sha256', WS_HMAC_SECRET).update(body).digest('hex');
  if (!safeEqualHex(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(payload.uid) || payload.uid < 1) return null;
    if (!Number.isSafeInteger(payload.mid) || payload.mid < 1) return null;
    if (![1, 2].includes(payload.slot)) return null;
    if (typeof payload.rid !== 'string' || payload.rid !== requestedRoomId) return null;
    if (!Number.isSafeInteger(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocket.Server({ server, maxPayload: 4096, perMessageDeflate: false });

class GameRoom {
  constructor(matchId, roomId) {
    this.matchId = matchId;
    this.roomId = roomId;
    this.clients = new Map();
    this.engine = Matter.Engine.create({ enableSleeping: true });
    this.engine.gravity.y = 0; this.engine.gravity.scale = 0;
    this.pucks = [];
    this.winnerId = null;
    this.started = false;
    this.resultSubmitted = false;
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
      this.addPuck(1, x, CONFIG.H - 82); // Slot 1 starts bottom
      this.addPuck(2, x, 82);            // Slot 2 starts top
    }
  }

  addPuck(owner, x, y) {
    const body = Matter.Bodies.circle(x, y, CONFIG.R, { restitution: CONFIG.RESTITUTION, friction: 0.025, frictionAir: CONFIG.AIR_FRICTION, density: 0.0015 });
    body.plugin = { owner };
    Matter.Composite.add(this.engine.world, body);
    this.pucks.push(body);
  }

  send(ws, data) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }

  addPlayer(ws, identity) {
    this.clients.set(ws, { slot: identity.slot, userId: identity.uid, lastLaunchTimes: [] });
    this.send(ws, { type: 'joined', slot: identity.slot });
    this.send(ws, { type: 'state', state: { started: this.started, pucks: this.pucks.map(p => ({ id: p.id, x: p.position.x, y: p.position.y, owner: p.plugin.owner })) } });
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
      
      const pucks = this.pucks.map(p => {
        let px = p.position.x;
        let py = p.position.y;
        let owner = p.plugin.owner;
        if (isSlot2) {
          px = CONFIG.W - px;
          py = CONFIG.H - py;
          owner = owner === 1 ? 2 : 1; // عكس الملكية للاعب الثاني
        }
        return { id: p.id, x: px, y: py, owner: owner };
      });
      
      this.send(ws, { type: 'state', state: { started: this.started, pucks } });
    }
  }

  tick() {
    if (!this.started || this.winnerId !== null) return;
    Matter.Engine.update(this.engine, CONFIG.TICK_RATE);
    
    let p1Count = 0, p2Count = 0;
    this.pucks.forEach(p => {
      if (p.position.y >= MID_Y) p1Count++;
      else p2Count++;
    });

    if (p1Count === 0) this.endGame(2); // اللاعب 1 أخرج كل أقراصه، اللاعب 2 فاز
    else if (p2Count === 0) this.endGame(1); // اللاعب 2 أخرج كل أقراصه، اللاعب 1 فاز
  }

  async endGame(winnerSlot) {
    if (this.winnerId !== null) return;
    let winnerUserId = null;
    for (const data of this.clients.values()) {
      if (data.slot === winnerSlot) winnerUserId = data.userId;
    }
    if (!winnerUserId) return;
    this.winnerId = winnerUserId;
    
    // إرسال النتيجة
    try {
      await fetch(MATCH_RESULT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': MATCH_RESULT_SECRET },
        body: JSON.stringify({ match_id: this.matchId, winner_id: winnerUserId })
      });
    } catch (error) {}

    for (const [ws, data] of this.clients) {
      this.send(ws, { type: 'game_over', isWinner: data.userId === winnerUserId });
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

    // التحقق من أن القرص في نصف اللاعب
    const isInMyHalf = client.slot === 1 ? (puck.position.y >= MID_Y) : (puck.position.y < MID_Y);
    if (!isInMyHalf) return;
    if (Math.hypot(puck.velocity.x, puck.velocity.y) > CONFIG.IDLE_SPEED) return;

    const speed = Math.min(CONFIG.MAX_SPEED, distance * 0.095);
    Matter.Body.setVelocity(puck, { x: (-dx / distance) * speed, y: (-dy / distance) * speed });
    Matter.Sleeping.set(puck, false);
  }

  relayWebRTC(ws, msg) {
    const sender = this.clients.get(ws);
    for (const [otherWs, other] of this.clients) {
      if (otherWs !== ws && other.userId !== sender.userId) {
        this.send(otherWs, { type: 'webrtc', from_user_id: sender.userId, offer: msg.offer, answer: msg.answer, candidate: msg.candidate });
        break;
      }
    }
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
  const roomId = url.searchParams.get('room_id') || '';
  const identity = verifyTicket(url.searchParams.get('ticket') || '', roomId);
  if (!roomId || !identity) return ws.close();

  let room = rooms.get(roomId);
  if (!room) {
    room = new GameRoom(identity.mid, roomId);
    rooms.set(roomId, room);
  }
  room.addPlayer(ws, identity);

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'launch') room.handleLaunch(ws, msg);
    else if (msg.type === 'webrtc') room.relayWebRTC(ws, msg);
  });
  ws.on('close', () => room.removePlayer(ws));
});

server.listen(PORT, () => console.log(`Server on ${PORT}`));
