
'use strict';

const http = require('http');
const WebSocket = require('ws');
const Matter = require('matter-js');

const CONFIG = {
    W: 600,
    H: 900,
    R: 22,
    GAP: 50,
    BARRIER: 24,
    PUCKS: 5,
    TICK_RATE: 1000 / 60,
    BROADCAST_RATE: 1000 / 30,
    RESTITUTION: 0.84,
    AIR_FRICTION: 0.014,
    WALL_RESTITUTION: 0.72,
    MAX_SPEED: 14
};

const MID_Y = CONFIG.H / 2;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Sling Puck WebSocket Server Online');
});

const wss = new WebSocket.Server({
    server,
    maxPayload: 16 * 1024
});

const rooms = new Map();

class GameRoom {
    constructor(roomId) {
        this.roomId = roomId;
        this.clients = new Map();
        this.engine = Matter.Engine.create({
            enableSleeping: true
        });

        this.engine.gravity.x = 0;
        this.engine.gravity.y = 0;
        this.engine.gravity.scale = 0;

        this.pucks = [];
        this.winner = null;
        this.started = false;
        this.destroyed = false;

        this.initPhysics();

        this.tickInterval = setInterval(
            () => this.tick(),
            CONFIG.TICK_RATE
        );

        this.broadcastInterval = setInterval(
            () => this.broadcast(),
            CONFIG.BROADCAST_RATE
        );
    }

    initPhysics() {
        const { Bodies, Composite } = Matter;

        const wallOptions = {
            isStatic: true,
            restitution: CONFIG.WALL_RESTITUTION,
            friction: 0
        };

        const walls = [
            Bodies.rectangle(
                CONFIG.W / 2, -18,
                CONFIG.W + 40, 36, wallOptions
            ),
            Bodies.rectangle(
                CONFIG.W / 2, CONFIG.H + 18,
                CONFIG.W + 40, 36, wallOptions
            ),
            Bodies.rectangle(
                -1, CONFIG.H / 2,
                36, CONFIG.H + 50, wallOptions
            ),
            Bodies.rectangle(
                CONFIG.W + 1, CONFIG.H / 2,
                36, CONFIG.H + 50, wallOptions
            )
        ];

        const blockW = (CONFIG.W - CONFIG.GAP) / 2;

        const barriers = [
            Bodies.rectangle(
                blockW / 2,
                MID_Y,
                blockW,
                CONFIG.BARRIER,
                wallOptions
            ),
            Bodies.rectangle(
                CONFIG.W - blockW / 2,
                MID_Y,
                blockW,
                CONFIG.BARRIER,
                wallOptions
            )
        ];

        Composite.add(this.engine.world, [
            ...walls,
            ...barriers
        ]);

        // توزيع الأقراص داخل اللوحة بشكل صحيح.
        const positions = [100, 200, 300, 400, 500];

        for (const x of positions) {
            this.addPuck(1, x, CONFIG.H - 82);
            this.addPuck(2, x, 82);
        }
    }

    addPuck(owner, x, y) {
        const body = Matter.Bodies.circle(
            x,
            y,
            CONFIG.R,
            {
                restitution: CONFIG.RESTITUTION,
                friction: 0.025,
                frictionAir: CONFIG.AIR_FRICTION,
                density: 0.0015,
                sleepThreshold: 60
            }
        );

        body.plugin = {
            owner,
            puckId: body.id
        };

        Matter.Composite.add(this.engine.world, body);
        this.pucks.push(body);
    }

    getState() {
        return {
            roomId: this.roomId,
            started: this.started,
            playerCount: this.clients.size,
            winner: this.winner,

            pucks: this.pucks.map(p => ({
                id: p.id,
                x: p.position.x,
                y: p.position.y,
                vx: p.velocity.x,
                vy: p.velocity.y,
                owner: p.plugin.owner
            }))
        };
    }

    send(ws, type, data = {}) {
        if (ws.readyState !== WebSocket.OPEN) return;

        ws.send(JSON.stringify({
            type,
            ...data
        }));
    }

    sendState(ws) {
        this.send(ws, 'state', {
            state: this.getState()
        });
    }

    broadcast() {
        if (this.destroyed) return;

        const msg = JSON.stringify({
            type: 'state',
            state: this.getState()
        });

        for (const ws of this.clients.keys()) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(msg);
            }
        }
    }

    tick() {
        if (this.destroyed || this.winner) return;

        Matter.Engine.update(
            this.engine,
            CONFIG.TICK_RATE
        );

        let player1 = 0;
        let player2 = 0;

        for (const puck of this.pucks) {
            if (puck.position.y >= MID_Y) {
                player1++;
            } else {
                player2++;
            }
        }

        if (player1 === 0) {
            this.endGame(2);
        } else if (player2 === 0) {
            this.endGame(1);
        }
    }

    endGame(winner) {
        if (this.winner) return;

        this.winner = winner;

        this.broadcast();

        for (const ws of this.clients.keys()) {
            this.send(ws, 'game_over', {
                winner
            });
        }
    }

    handleLaunch(ws, msg) {
        if (!this.started || this.winner) return;

        const owner = ws.playerId;

        const puckId = Number(msg.puckId);
        const dx = Number(msg.dx);
        const dy = Number(msg.dy);

        if (
            !Number.isSafeInteger(puckId) ||
            !Number.isFinite(dx) ||
            !Number.isFinite(dy)
        ) return;

        const puck = this.pucks.find(p =>
            p.id === puckId &&
            p.plugin.owner === owner
        );

        if (!puck) return;

        const distance = Math.hypot(dx, dy);

        if (distance < 10) return;

        const speed = Math.min(
            CONFIG.MAX_SPEED,
            distance * 0.095
        );

        // إطلاق القرص عكس اتجاه السحب.
        Matter.Body.setVelocity(puck, {
            x: (-dx / distance) * speed,
            y: (-dy / distance) * speed
        });

        Matter.Sleeping.set(puck, false);
    }

    addPlayer(ws, playerId) {
        if (this.clients.has(ws)) return;

        if (this.clients.size >= 2) {
            this.send(ws, 'error', {
                message: 'ROOM_FULL'
            });
            ws.close(4002, 'Room full');
            return false;
        }

        for (const client of this.clients.keys()) {
            if (client.playerId === playerId) {
                this.send(ws, 'error', {
                    message: 'PLAYER_SLOT_TAKEN'
                });
                ws.close(4001, 'Player slot taken');
                return false;
            }
        }

        ws.playerId = playerId;
        this.clients.set(ws, true);

        // إرسال المقعد المخصص والحالة فوراً.
        this.send(ws, 'joined', {
            playerId,
            roomId: this.roomId
        });

        this.sendState(ws);

        if (this.clients.size === 2) {
            this.started = true;

            for (const client of this.clients.keys()) {
                this.send(client, 'start', {
                    playerCount: 2
                });

                this.sendState(client);
            }
        }

        return true;
    }

    relayWebRTC(ws, msg) {
        const target = Number(msg.to);

        if (![1, 2].includes(target)) return;
        if (target === ws.playerId) return;

        const recipient = [...this.clients.keys()].find(
            client => client.playerId === target
        );

        if (!recipient) return;

        const allowed = ['offer', 'answer', 'candidate'];

        const signal = {};

        for (const key of allowed) {
            if (msg[key] !== undefined) {
                signal[key] = msg[key];
            }
        }

        if (Object.keys(signal).length === 0) return;

        this.send(recipient, 'webrtc', {
            from: ws.playerId,
            ...signal
        });
    }

    removePlayer(ws) {
        this.clients.delete(ws);

        if (this.clients.size === 0) {
            this.destroy();
        } else {
            this.started = false;
            this.broadcast();

            for (const client of this.clients.keys()) {
                this.send(client, 'opponent_left');
            }
        }
    }

    destroy() {
        if (this.destroyed) return;

        this.destroyed = true;

        clearInterval(this.tickInterval);
        clearInterval(this.broadcastInterval);

        Matter.Engine.clear(this.engine);

        rooms.delete(this.roomId);
    }
}

wss.on('connection', (ws, req) => {
    let url;

    try {
        url = new URL(req.url, 'http://localhost');
    } catch {
        ws.close(4000, 'Invalid URL');
        return;
    }

    const roomId = url.searchParams.get('room_id');
    const playerId = Number(
        url.searchParams.get('player_id')
    );

    if (
        !roomId ||
        roomId.length > 100 ||
        ![1, 2].includes(playerId)
    ) {
        ws.close(4000, 'Invalid room or player');
        return;
    }

    let room = rooms.get(roomId);

    if (!room) {
        room = new GameRoom(roomId);
        rooms.set(roomId, room);
    }

    ws.roomId = roomId;

    if (!room.addPlayer(ws, playerId)) return;

    console.log(
        `[JOIN] Room=${roomId} Player=${playerId}`
    );

    ws.on('message', data => {
        try {
            const msg = JSON.parse(data.toString());

            if (!msg || typeof msg.type !== 'string') {
                return;
            }

            if (msg.type === 'launch') {
                room.handleLaunch(ws, msg);
            }

            if (msg.type === 'webrtc') {
                room.relayWebRTC(ws, msg);
            }

        } catch (error) {
            console.error('Message error:', error.message);
        }
    });

    ws.on('close', () => {
        console.log(
            `[LEAVE] Room=${roomId} Player=${playerId}`
        );

        room.removePlayer(ws);
    });

    ws.on('error', error => {
        console.error('WebSocket error:', error.message);
    });
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, '0.0.0.0', () => {
    console.log(
        `Sling Puck server running on port ${PORT}`
    );
});
