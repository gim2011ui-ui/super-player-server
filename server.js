const http = require('http');
const WebSocket = require('ws');
const Matter = require('matter-js');

const CONFIG = { W: 600, H: 900, R: 22, GAP: 50, BARRIER: 24, PUCKS: 5, RESTITUTION: 0.84, AIR_FRICTION: 0.014, WALL_RESTITUTION: 0.72 };
const MID_Y = CONFIG.H / 2;
const server = http.createServer();
const wss = new WebSocket.Server({ server });
const rooms = new Map();

class GameRoom {
    constructor(roomId, p1Id, p2Id) {
        this.roomId = roomId;
        this.players = [p1Id, p2Id];
        this.clients = new Map();
        this.engine = Matter.Engine.create({ enableSleeping: true });
        this.engine.gravity.y = 0; this.engine.gravity.scale = 0;
        this.pucks = [];
        this.winner = null;
        this.isStarted = false;
        this.initPhysics();
        this.tickInterval = setInterval(() => this.tick(), 1000 / 60);
        this.broadcastInterval = setInterval(() => this.broadcast(), 1000 / 20);
    }
    
    initPhysics() {
        const { Engine, Bodies, Composite } = Matter;
        const wallOpt = { isStatic: true, restitution: CONFIG.WALL_RESTITUTION, friction: 0 };
        const walls = [
            Bodies.rectangle(CONFIG.W/2, -18, CONFIG.W+40, 36, wallOpt),
            Bodies.rectangle(CONFIG.W/2, CONFIG.H+18, CONFIG.W+40, 36, wallOpt),
            Bodies.rectangle(-1, CONFIG.H/2, 36, CONFIG.H+50, wallOpt),
            Bodies.rectangle(CONFIG.W+1, CONFIG.H/2, 36, CONFIG.H+50, wallOpt)
        ];
        const blockW = (CONFIG.W - CONFIG.GAP) / 2;
        const leftBarrier = Bodies.rectangle(blockW/2, MID_Y, blockW, CONFIG.BARRIER, wallOpt);
        const rightBarrier = Bodies.rectangle(CONFIG.W - blockW/2, MID_Y, blockW, CONFIG.BARRIER, wallOpt);
        Composite.add(this.engine.world, [...walls, leftBarrier, rightBarrier]);
        
        const startX = CONFIG.W/2 - 105*2;
        for (let i = 0; i < CONFIG.PUCKS; i++) {
            const x = startX + i * 105;
            this.addPuck(1, x, CONFIG.H - 82, i);
            this.addPuck(2, x, 82, i);
        }
    }

    addPuck(owner, x, y, idx) {
        const body = Matter.Bodies.circle(x, y, CONFIG.R, { restitution: CONFIG.RESTITUTION, friction: 0.025, frictionAir: CONFIG.AIR_FRICTION, density: 0.0015 });
        body.plugin = { owner, index: idx };
        Matter.Composite.add(this.engine.world, body);
        this.pucks.push(body);
    }

    tick() {
        if (this.winner || !this.isStarted) return;
        Matter.Engine.update(this.engine, 1000 / 60);
        let p1 = 0, p2 = 0;
        this.pucks.forEach(p => {
            if (p.position.y >= MID_Y) p1++; else p2++;
        });
        if (p1 === 0 && !this.winner) this.endGame(2);
        else if (p2 === 0 && !this.winner) this.endGame(1);
    }

    async endGame(winnerOwner) {
        this.winner = winnerOwner;
        clearInterval(this.tickInterval);
        clearInterval(this.broadcastInterval);
        // إرسال النتيجة إلى الاستضافة
        fetch('https://zxm.zya.me/api/receive_match_result.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': 'SuperPlayer_Secure_2026_XYZ!' },
            body: JSON.stringify({ match_id: this.roomId, winner_id: this.players[winnerOwner === 1 ? 0 : 1], loser_id: this.players[winnerOwner === 1 ? 1 : 0] })
        }).catch(console.error);
    }

    broadcast() {
        const state = {
            pucks: this.pucks.map(p => ({ x: p.position.x, y: p.position.y, owner: p.plugin.owner })),
            winner: this.winner
        };
        const msg = JSON.stringify({ type: 'state', state });
        this.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
    }

    startGame() {
        this.isStarted = true;
        this.clients.forEach(c => { 
            if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'start' })); 
        });
    }

    handleLaunch(x, y, dx, dy, owner) {
        const puck = this.pucks.find(p => p.plugin.owner === owner && Math.hypot(p.position.x - x, p.position.y - y) < 40);
        if (puck) {
            const speed = Math.min(14, Math.hypot(dx, dy) * 0.095);
            const dist = Math.hypot(dx, dy) || 1;
            Matter.Body.setVelocity(puck, { x: (-dx / dist) * speed, y: (-dy / dist) * speed });
            puck.isSleeping = false;
        }
    }
}

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const roomId = url.searchParams.get('room_id'); 
    const playerId = parseInt(url.searchParams.get('player_id')) || 1;

    if (!roomId) return ws.close();
    if (!rooms.has(roomId)) rooms.set(roomId, new GameRoom(roomId, playerId, 0));
    
    const room = rooms.get(roomId);
    ws.roomId = roomId;
    room.clients.set(ws, true);
    
    if (room.clients.size === 2) {
        room.players[1] = playerId;
        room.startGame();
    }
    
    ws.on('message', data => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'launch' && room.isStarted) {
                const owner = playerId === 1 ? 1 : 2;
                room.handleLaunch(msg.x, msg.y, msg.dx, msg.dy, owner);
            }
        } catch(e) {}
    });
    
    ws.on('close', () => { room.clients.delete(ws); });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('WebSocket running on port ' + PORT));
