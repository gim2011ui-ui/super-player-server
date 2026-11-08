const http = require('http');
const WebSocket = require('ws');
const Matter = require('matter-js');

const CONFIG = {
    W: 600, H: 900, R: 22, GAP: 50, BARRIER: 24, PUCKS: 5,
    RESTITUTION: 0.84, AIR_FRICTION: 0.014, WALL_RESTITUTION: 0.72
};
const MID_Y = CONFIG.H / 2;

const server = http.createServer();
const wss = new WebSocket.Server({ server });
const rooms = new Map();

class GameRoom {
    constructor(roomId) {
        this.roomId = roomId;
        this.clients = new Map();
        this.engine = Matter.Engine.create({ enableSleeping: true });
        this.engine.gravity.y = 0; 
        this.engine.gravity.scale = 0;
        this.pucks = [];
        this.winner = null;
        this.scores = { 1: 5, 2: 5 };
        this.isStarted = false;
        this.initPhysics();
        this.tickInterval = setInterval(() => this.tick(), 1000 / 60);
        this.broadcastInterval = setInterval(() => this.broadcast(), 1000 / 20);
    }
    
    initPhysics() {
        const { Bodies, Composite } = Matter;
        const wallOpt = { isStatic: true, restitution: CONFIG.WALL_RESTITUTION, friction: 0, render: { visible: false } };
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
        const body = Matter.Bodies.circle(x, y, CONFIG.R, {
            restitution: CONFIG.RESTITUTION, friction: 0.025, frictionAir: CONFIG.AIR_FRICTION, density: 0.0015
        });
        body.plugin = { owner, index: idx };
        Matter.Composite.add(this.engine.world, body);
        this.pucks.push(body);
    }

    tick() {
        if (this.winner || !this.isStarted) return;
        Matter.Engine.update(this.engine, 1000 / 60);
        this.checkScores();
    }

    checkScores() {
        let p1 = 0, p2 = 0;
        this.pucks.forEach(p => {
            if (p.position.y >= MID_Y) p1++; else p2++;
        });
        this.scores = { 1: p1, 2: p2 };
        if (p1 === 0) this.endGame(2);
        else if (p2 === 0) this.endGame(1);
    }

    async endGame(winnerOwner) {
        this.winner = winnerOwner;
        clearInterval(this.tickInterval);
        clearInterval(this.broadcastInterval);
        
        try {
            const response = await fetch('https://zxm.zya.me/api/receive_match_result.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-KEY': 'SuperPlayer_Secure_2026_XYZ!' },
                body: JSON.stringify({ match_id: this.roomId, winner_id: winnerOwner })
            });
            console.log('Result sync:', await response.json());
        } catch(e) { 
            console.error('Sync Error:', e.message); 
        }
        
        this.broadcast();
        setTimeout(() => rooms.delete(this.roomId), 5000);
    }

    broadcast() {
        if (this.clients.size === 0) return;
        const state = {
            pucks: this.pucks.map(p => ({ x: p.position.x, y: p.position.y, owner: p.plugin.owner })),
            winner: this.winner,
            scores: this.scores
        };
        const msg = JSON.stringify({ type: 'state', state, server_time: Date.now() / 1000 });
        this.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
    }

    handleInput(playerId, action, data) {
        if (action === 'launch') {
            const puck = this.pucks.find(p => p.plugin.owner === playerId && p.plugin.index === data.index);
            if (puck) {
                Matter.Body.setVelocity(puck, { x: data.vx, y: data.vy });
                puck.isSleeping = false;
            }
        }
    }
}

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const roomId = url.searchParams.get('room_id');
    const playerId = parseInt(url.searchParams.get('player_id')) || 1;

    if (!roomId) return ws.close();
    
    if (!rooms.has(roomId)) {
        rooms.set(roomId, new GameRoom(roomId)); 
    }
    
    const room = rooms.get(roomId);
    
    if (room.clients.size >= 2) {
        return ws.close();
    }
    
    ws.roomId = roomId;
    ws.playerId = playerId;
    room.clients.set(ws, playerId);
    
    if (room.clients.size === 2) {
        room.isStarted = true;
        room.clients.forEach((pId, client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'start_countdown' }));
            }
        });
    }
    
    room.broadcast();
    
    ws.on('message', data => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'action') {
                room.handleInput(playerId, msg.action, msg.data);
            }
        } catch(e) {}
    });
    
    ws.on('close', () => { 
        room.clients.delete(ws); 
        if (room.clients.size === 0) rooms.delete(roomId);
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('WebSocket running on port ' + PORT));
