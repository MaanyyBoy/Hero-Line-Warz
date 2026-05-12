// Server-auktoritativ Hero Line Warz multiplayer-server.
// Hostar två-spelarsessioner och kör hela simuleringen själv via game-engine.
// Klienterna skickar bara inputs och renderar mottagen state.

const http = require('http');
const { WebSocketServer } = require('ws');
const engine = require('./game-engine.js');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30;                       // simuleringssteg per sekund
const STATE_RATE = 20;                      // state-broadcasts per sekund
const TICK_INTERVAL_MS = 1000 / TICK_RATE;
const STATE_INTERVAL_MS = 1000 / STATE_RATE;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Spel server running. Rooms: ${rooms.size}`);
});

const wss = new WebSocketServer({ server });

// roomCode -> { host, client, game, tickHandle, lastStateMs }
const rooms = new Map();

function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  let tries = 0;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    tries++;
    if (tries > 1000) throw new Error('Room codes exhausted');
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function startGame(room) {
  if (room.tickHandle || room.game) return;
  room.game = engine.createGameState();
  room.lastStateMs = 0;
  room.lastTickMs = Date.now();
  room.tickHandle = setInterval(() => gameLoopTick(room), TICK_INTERVAL_MS);
  console.log(`[${room.code}] game started`);
}

function stopGame(room) {
  if (room.tickHandle) {
    clearInterval(room.tickHandle);
    room.tickHandle = null;
  }
  room.game = null;
}

function gameLoopTick(room) {
  if (!room.game) return;
  const now = Date.now();
  const dt = Math.min(0.1, Math.max(0.001, (now - room.lastTickMs) / 1000));
  room.lastTickMs = now;
  try {
    engine.tickGame(room.game, dt);
  } catch (e) {
    console.error(`[${room.code}] tickGame error:`, e && e.stack || e);
    return;
  }
  if (now - room.lastStateMs >= STATE_INTERVAL_MS) {
    room.lastStateMs = now;
    try {
      const stateMsg = engine.serializeState(room.game);
      const envelope = { t: 'msg', d: stateMsg };
      send(room.host, envelope);
      send(room.client, envelope);
    } catch (e) {
      console.error(`[${room.code}] serialize/send error:`, e && e.stack || e);
    }
  }
}

function handleGameInput(room, ws, payload) {
  if (!room.game || !payload || payload.t !== 'in') return;
  const sideIdx = (ws.role === 'host') ? 1 : 2;
  if (payload.j) {
    const j = payload.j;
    // Sanitize: numeric, clamp magnitude <= 1
    const jx = Number(j.x) || 0;
    const jz = Number(j.z) || 0;
    const mag = Math.hypot(jx, jz);
    if (mag > 1) {
      room.game.lastInputs[sideIdx].j = { x: jx / mag, z: jz / mag };
    } else {
      room.game.lastInputs[sideIdx].j = { x: jx, z: jz };
    }
  }
  if (Array.isArray(payload.ev) && payload.ev.length) {
    for (const ev of payload.ev) {
      if (!ev || typeof ev !== 'object') continue;
      try { engine.applyEvent(room.game, sideIdx, ev); }
      catch (e) { console.warn('applyEvent error', e); }
    }
  }
}

wss.on('connection', (ws) => {
  ws.role = null;
  ws.roomCode = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.t === 'host') {
      if (ws.roomCode) return;
      const code = genCode();
      const room = { code, host: ws, client: null, game: null, tickHandle: null, lastStateMs: 0, lastTickMs: 0 };
      rooms.set(code, room);
      ws.role = 'host';
      ws.roomCode = code;
      send(ws, { t: 'hosted', code });
      console.log(`[${code}] hosted (rooms=${rooms.size})`);
    } else if (msg.t === 'join') {
      if (ws.roomCode) return;
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { send(ws, { t: 'join-error', msg: 'Rummet finns inte.' }); return; }
      if (room.client) { send(ws, { t: 'join-error', msg: 'Rummet är fullt.' }); return; }
      room.client = ws;
      ws.role = 'client';
      ws.roomCode = code;
      send(ws, { t: 'joined', code });
      send(room.host, { t: 'peer-joined' });
      console.log(`[${code}] client joined`);
      // Båda inne — starta simulation
      startGame(room);
    } else if (msg.t === 'msg') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      handleGameInput(room, ws, msg.d);
    } else if (msg.t === 'leave') {
      closeRoom(ws);
    }
  });

  ws.on('close', () => { closeRoom(ws); });
  ws.on('error', () => {});
});

function closeRoom(ws) {
  const code = ws.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  ws.roomCode = null;
  ws.role = null;
  if (!room) return;
  const other = (room.host === ws) ? room.client : room.host;
  send(other, { t: 'peer-left' });
  if (other) { other.roomCode = null; other.role = null; }
  stopGame(room);
  rooms.delete(code);
  console.log(`[${code}] closed (rooms=${rooms.size})`);
}

// Heartbeat så zombi-anslutningar inte hänger kvar
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { try { ws.terminate(); } catch (_) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Spel server listening on :${PORT}`);
});
