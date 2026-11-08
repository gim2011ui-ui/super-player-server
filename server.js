const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const Matter = require('matter-js');

const CONFIG = Object.freeze({
  W: 600, H: 900, R: 22, GAP: 50, BARRIER: 24,
  TICK_RATE: 1000 / 60,
  BROADCAST_RATE: 1000 / 30,
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
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'super-player-game-server' }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});
const wss = new WebSocket.Server({ server, maxPayload: 4096, perMessageDeflate: false });

class GameRoom {
  constructor(matchId, roomId) {
    this.matchId = matchId;
    this.roomId = roomId;
    this.clients = new Map();
    this.engine = Matter.Engine.create({ enableSleeping: true });
    this.engine.gravity.x = 0;
    this.engine.gravity.y = 0;
    this.engine.gravity.scale = 0;
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
      this.addPuck(1, x, CONFIG.H - 82);
      this.addPuck(2, x, 82);
    }
  }

  addPuck(owner, x, y) {
    const body = Matter.Bodies.circle(x, y, CONFIG.R, {
      restitution: CONFIG.RESTITUTION,
      friction: 0.025,
      frictionAir: CONFIG.AIR_FRICTION,
      density: 0.0015
    });
    body.plugin = { owner };
    Matter.Composite.add(this.engine.world, body);
    this.pucks.push(body);
  }

  send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }

  addPlayer(ws, identity) {
    // One authenticated identity per slot and one slot per identity.
    for (const [existingWs, data] of this.clients) {
      if (data.slot === identity.slot || data.userId === identity.uid) {
        this.send(ws, { type: 'error', code: 'SLOT_OCCUPIED' });
        ws.close(4003, 'Slot already connected');
        return false;
      }
    }
    this.clients.set(ws, {
      slot: identity.slot,
      userId: identity.uid,
      lastLaunchTimes: []
    });
    this.send(ws, { type: 'joined', slot: identity.slot });
    if (this.clients.size === 2) {
      this.started = true;
      for (const client of this.clients.keys()) this.send(client, { type: 'start' });
    }
    return true;
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
        owner: isSlot2 ? (p.plugin.owner === 1 ? 2 : 1) : p.plugin.owner,
        vx: isSlot2 ? -p.velocity.x : p.velocity.x,
        vy: isSlot2 ? -p.velocity.y : p.velocity.y
      }));
      this.send(ws, { type: 'state', state: { started: this.started, pucks } });
    }
  }

  tick() {
    if (!this.started || this.winnerId !== null) return;
    Matter.Engine.update(this.engine, CONFIG.TICK_RATE);
    let bottomCount = 0;
    let topCount = 0;
    for (const puck of this.pucks) {
      if (puck.position.y >= MID_Y) bottomCount++;
      else topCount++;
    }
    if (bottomCount === 0) this.endGame(2);
    else if (topCount === 0) this.endGame(1);
  }

  async endGame(winnerSlot) {
    if (this.winnerId !== null) return;
    let winnerUserId = null;
    for (const data of this.clients.values()) {
      if (data.slot === winnerSlot) winnerUserId = data.userId;
    }
    if (!winnerUserId) return;
    this.winnerId = winnerUserId;
    let rewardsSaved = false;
    if (!this.resultSubmitted) {
      this.resultSubmitted = true;
      for (let attempt = 1; attempt <= 3 && !rewardsSaved; attempt++) {
        try {
          const response = await fetch(MATCH_RESULT_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-KEY': MATCH_RESULT_SECRET
            },
            body: JSON.stringify({ match_id: this.matchId, winner_id: winnerUserId }),
            signal: AbortSignal.timeout(10000)
          });
          if (!response.ok) throw new Error(`Result API HTTP ${response.status}`);
          const result = await response.json();
          if (!result.success) throw new Error('Result API rejected result');
          rewardsSaved = true;
        } catch (error) {
          console.error(`Result API attempt ${attempt}/3 failed for match ${this.matchId}:`, error.message);
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1500));
        }
      }
    }
    for (const [ws, data] of this.clients) {
      this.send(ws, { type: 'game_over', isWinner: data.userId === winnerUserId, rewardsSaved });
    }
  }

  handleLaunch(ws, msg) {
    if (!this.started || this.winnerId !== null) return;
    const client = this.clients.get(ws);
    if (!client) return;
    const puckId = Number(msg.puckId);
    let dx = Number(msg.dx);
    let dy = Number(msg.dy);
    if (!Number.isSafeInteger(puckId) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (client.slot === 2) { dx = -dx; dy = -dy; }
    const distance = Math.hypot(dx, dy);
    if (distance < CONFIG.MIN_DRAG || distance > CONFIG.MAX_DRAG) return;

    const now = Date.now();
    client.lastLaunchTimes = client.lastLaunchTimes.filter(t => now - t < 1000);
    if (client.lastLaunchTimes.length >= CONFIG.MAX_LAUNCHES_PER_SECOND) return;

    const puck = this.pucks.find(p => p.id === puckId);
    if (!puck || puck.plugin.owner !== client.slot) return;
    // Prevent launching a puck that is already moving (e.g. duplicate/replayed requests).
    if (Math.hypot(puck.velocity.x, puck.velocity.y) > CONFIG.IDLE_SPEED) return;

    const speed = Math.min(CONFIG.MAX_SPEED, distance * 0.095);
    Matter.Body.setVelocity(puck, { x: (-dx / distance) * speed, y: (-dy / distance) * speed });
    Matter.Sleeping.set(puck, false);
    client.lastLaunchTimes.push(now);
  }

  relayWebRTC(ws, msg) {
    const sender = this.clients.get(ws);
    if (!sender || !this.started || this.winnerId !== null) return;
    const allowed = {};
    if (msg.offer && typeof msg.offer === 'object') allowed.offer = msg.offer;
    if (msg.answer && typeof msg.answer === 'object') allowed.answer = msg.answer;
    if (msg.candidate && typeof msg.candidate === 'object') allowed.candidate = msg.candidate;
    if (Object.keys(allowed).length !== 1) return;
    for (const [otherWs, other] of this.clients) {
      if (otherWs !== ws && other.userId !== sender.userId) {
        this.send(otherWs, { type: 'webrtc', from_user_id: sender.userId, ...allowed });
        break;
      }
    }
  }

  removePlayer(ws) {
    const existed = this.clients.delete(ws);
    if (!existed) return;
    for (const client of this.clients.keys()) this.send(client, { type: 'opponent_disconnected' });
    if (this.clients.size === 0) this.destroy();
  }

  destroy() {
    clearInterval(this.tickInterval);
    clearInterval(this.broadcastInterval);
    if (rooms.get(this.roomId) === this) rooms.delete(this.roomId);
  }
}

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) {
    ws.close(4004, 'Origin not allowed');
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room_id') || '';
  const identity = verifyTicket(url.searchParams.get('ticket') || '', roomId);
  if (!roomId || !identity) {
    ws.close(4001, 'Invalid or expired ticket');
    return;
  }

  let room = rooms.get(roomId);
  if (!room) {
    room = new GameRoom(identity.mid, roomId);
    rooms.set(roomId, room);
  } else if (room.matchId !== identity.mid) {
    ws.close(4002, 'Match identity mismatch');
    return;
  }
  if (!room.addPlayer(ws, identity)) return;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'launch') room.handleLaunch(ws, msg);
    else if (msg.type === 'webrtc') room.relayWebRTC(ws, msg);
  });
  ws.on('close', () => room.removePlayer(ws));
  ws.on('error', () => room.removePlayer(ws));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Super Player authoritative game server listening on ${PORT}`);
});

process.on('SIGTERM', () => {
  for (const room of rooms.values()) room.destroy();
  wss.close(() => server.close(() => process.exit(0)));
});
