const http = require('http');
const WebSocket = require('ws');
const Matter = require('matter-js');

const CONFIG = { W: 600, H: 900, R: 22, GAP: 50, BARRIER: 24, PUCKS: 5, TICK_RATE: 1000/60, BROADCAST_RATE: 1000/20, RESTITUTION: 0.84, AIR_FRICTION: 0.014, WALL_RESTITUTION: 0.72, MAX_SPEED: 14 };
const MID_Y = CONFIG.H / 2;
const server = http.createServer((req, res) => { res.writeHead(200); res.end('OK'); });
const wss = new WebSocket.Server({ server });
const rooms = new Map();

class GameRoom {
    constructor(roomId) {
        this.roomId = roomId;
        this.clients = new Map(); // ws -> { userId, slot }
        this.engine = Matter.Engine.create({ enableSleeping: true });
        this.engine.gravity.y = 0; this.engine.gravity.scale = 0;
        this.pucks = [];
        this.winnerId = null;
        this.started = false;
        this.initPhysics();
        this.tickInterval = setInterval(() => this.tick(), CONFIG.TICK_RATE);
        this.broadcastInterval = setInterval(() => this.broadcast(), CONFIG.BROADCAST_RATE);
    }
    
    initPhysics() {
        const { Bodies, Composite } = Matter;
        const wallOpt = { isStatic: true, restitution: CONFIG.WALL_RESTITUTION, friction: 0 };
        const walls = [
            Bodies.rectangle(CONFIG.W/2, -18, CONFIG.W+40, 36, wallOpt),
            Bodies.rectangle(CONFIG.W/2, CONFIG.H+18, CONFIG.W+40, 36, wallOpt),
            Bodies.rectangle(-1, CONFIG.H/2, 36, CONFIG.H+50, wallOpt),
            Bodies.rectangle(CONFIG.W+1, CONFIG.H/2, 36, CONFIG.H+50, wallOpt)
        ];
        const blockW = (CONFIG.W - CONFIG.GAP) / 2;
        Composite.add(this.engine.world, [
            ...walls,
            Bodies.rectangle(blockW/2, MID_Y, blockW, CONFIG.BARRIER, wallOpt),
            Bodies.rectangle(CONFIG.W - blockW/2, MID_Y, blockW, CONFIG.BARRIER, wallOpt)
        ]);
        
        const positions = [100, 200, 300, 400, 500];
        for (const x of positions) {
            this.addPuck(1, x, CONFIG.H - 82); // Slot 1
            this.addPuck(2, x, 82);            // Slot 2
        }
    }

    addPuck(owner, x, y) {
        const body = Matter.Bodies.circle(x, y, CONFIG.R, { restitution: CONFIG.RESTITUTION, friction: 0.025, frictionAir: CONFIG.AIR_FRICTION, density: 0.0015 });
        body.plugin = { owner, puckId: body.id };
        Matter.Composite.add(this.engine.world, body);
        this.pucks.push(body);
    }

    broadcast() {
        if (this.winnerId) return;
        this.clients.forEach((data, ws) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            
            // عكس الإحداثيات للاعب الثاني ليرى نفسه دائماً في الأسفل
            const isSlot2 = data.slot === 2;
            const pucksForClient = this.pucks.map(p => {
                let px = p.position.x;
                let py = p.position.y;
                let ownerForClient = p.plugin.owner;
                
                if (isSlot2) {
                    px = CONFIG.W - px;
                    py = CONFIG.H - py;
                    ownerForClient = (p.plugin.owner === 1) ? 2 : 1; // عكس الملكية
                }
                
                return { id: p.id, x: px, y: py, owner: ownerForClient };
            });

            ws.send(JSON.stringify({ type: 'state', state: { started: this.started, pucks: pucksForClient } }));
        });
    }

    tick() {
        if (!this.started || this.winnerId) return;
        Matter.Engine.update(this.engine, CONFIG.TICK_RATE);
        
        let p1 = 0, p2 = 0;
        this.pucks.forEach(p => { if (p.position.y >= MID_Y) p1++; else p2++; });
        
        if (p1 === 0) this.endGame(2);
        else if (p2 === 0) this.endGame(1);
    }

    async endGame(winnerSlot) {
        if (this.winnerId) return;
        
        let winnerRealId = 0;
        this.clients.forEach((data, ws) => {
            if (data.slot === winnerSlot) winnerRealId = data.userId;
        });
        this.winnerId = winnerRealId;

        try {
            await fetch('https://zxm.zya.me/api/receive_match_result.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-KEY': 'SuperPlayer_Secure_2026_XYZ!' },
                body: JSON.stringify({ match_id: this.roomId, winner_id: winnerRealId })
            });
        } catch(e) {}

        this.clients.forEach((data, ws) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'game_over', isWinner: (data.userId === winnerRealId) }));
            }
        });
    }

    handleLaunch(ws, msg) {
        if (!this.started || this.winnerId) return;
        const clientData = this.clients.get(ws);
        if(!clientData) return;

        const puckId = Number(msg.puckId);
        let dx = Number(msg.dx);
        let dy = Number(msg.dy);
        
        // إذا كان اللاعب 2، نعكس اتجاه السحب
        if (clientData.slot === 2) {
            dx = -dx;
            dy = -dy;
        }
        
        const puck = this.pucks.find(p => p.id === puckId);
        if (!puck) return;
        
        const distance = Math.hypot(dx, dy);
        if (distance < 10) return;
        
        const speed = Math.min(CONFIG.MAX_SPEED, distance * 0.095);
        Matter.Body.setVelocity(puck, { x: (-dx / distance) * speed, y: (-dy / distance) * speed });
        Matter.Sleeping.set(puck, false);
    }

    addPlayer(ws, slot, userId) {
        this.clients.set(ws, { slot, userId });
        ws.send(JSON.stringify({ type: 'joined', userId, slot }));

        if (this.clients.size === 2) {
            this.started = true;
            this.clients.forEach((data, c) => {
                if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'start' }));
            });
        }
    }

    relayWebRTC(ws, msg) {
        this.clients.forEach((data, clientWs) => {
            if (String(data.userId) === String(msg.to) && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: 'webrtc', from_user_id: this.clients.get(ws).userId, ...msg }));
            }
        });
    }
}

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const roomId = url.searchParams.get('room_id'); 
    const slot = parseInt(url.searchParams.get('player_id')) || 1;
    const userId = url.searchParams.get('user_id') || '0';

    if (!roomId) return ws.close();
    if (!rooms.has(roomId)) rooms.set(roomId, new GameRoom(roomId));
    
    const room = rooms.get(roomId);
    if (room.clients.size >= 2) return ws.close();
    
    room.addPlayer(ws, slot, userId);

    ws.on('message', data => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'launch') room.handleLaunch(ws, msg);
            if (msg.type === 'webrtc') room.relayWebRTC(ws, msg);
        } catch(e) {}
    });
    
    ws.on('close', () => { 
        room.clients.delete(ws); 
        if (room.clients.size === 0) rooms.delete(roomId);
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('Server running on ' + PORT));
