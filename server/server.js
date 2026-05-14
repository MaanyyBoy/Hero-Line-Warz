// Server-auktoritativ Hero Line Warz multiplayer-server.
// Hostar två-spelarsessioner och kör hela simuleringen själv via game-engine.
// Klienterna skickar bara inputs och renderar mottagen state.

const http = require('http');
const { WebSocketServer } = require('ws');
const engine = require('./game-engine.js');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30;                       // simuleringssteg per sekund
// State-broadcast 20 Hz: klienter interpolerar mesh.position med 80 ms halflife,
// så 20 Hz ger samma visuella smoothness som 30 Hz men sparar CPU + bandbredd
// (viktigt på Render's free-tier-server).
const STATE_RATE = 20;
const TICK_INTERVAL_MS = 1000 / TICK_RATE;
const STATE_INTERVAL_MS = 1000 / STATE_RATE;
// Grace-period när host disconnect:ar utan client. Rummet behålls så
// host kan reclaim:a med samma kod (t.ex. efter mobile-bakgrund/proxy-blip).
const HOST_GRACE_MS = 30000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Spel server running. Rooms: ${rooms.size}`);
});

const wss = new WebSocketServer({ server });

// roomCode -> { host, client, game, tickHandle, lastStateMs, hostGoneAt? }
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

// Arena MP är peer-to-peer (host simulerar lokalt). Servern relayar
// arena-meddelanden mellan peers; den klassiska engine tickar fortfarande
// men ignoreras av klienterna när APP.gameMode === 'arena1v1'.
function relayArenaMessage(room, fromWs, envelope) {
  // Spoof-skydd: bara host får broadcasta auktoritativ state.
  if (envelope.d && envelope.d.t === 'a-state' && fromWs !== room.host) return;
  const peer = (fromWs === room.host) ? room.client : room.host;
  if (peer) send(peer, envelope);
}

// Boss Wars MP relay (3-peer). Host broadcastar state till alla; klienter
// skickar inputs till host. Vi skickar till ALLA peers utom avsändaren.
function relayBossWarsMessage(room, fromWs, envelope) {
  // Spoof-skydd: bara host får skicka 'b-state' och 'b-start'
  if (envelope.d && envelope.d.t === 'b-state' && fromWs !== room.host) return;
  if (envelope.d && envelope.d.t === 'b-start' && fromWs !== room.host) return;
  // Klient → host: bara dessa meddelanden går enkelriktat till host
  const onlyToHost = envelope.d && envelope.d.t && (envelope.d.t === 'b-input' || envelope.d.t === 'b-pick' || envelope.d.t === 'b-hero-confirm' || envelope.d.t === 'b-ready');
  if (onlyToHost) {
    if (room.host && fromWs !== room.host) send(room.host, envelope);
    return;
  }
  // Annars broadcast till alla peers utom avsändaren
  if (room.host && fromWs !== room.host) send(room.host, envelope);
  if (room.client && fromWs !== room.client) send(room.client, envelope);
  for (const c of room.clients) if (c !== fromWs) send(c, envelope);
}

wss.on('connection', (ws) => {
  ws.role = null;
  ws.roomCode = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.t === 'ping') {
      // Keepalive från klient — håller WS levande mot proxy. Svara med pong-app.
      send(ws, { t: 'pong' });
      ws.isAlive = true;
      return;
    }

    if (msg.t === 'host') {
      if (ws.roomCode) return;
      const code = genCode();
      // maxPeers default 2 (klassisk + arena). Boss Wars host skickar 3 för 3-spelar-co-op.
      const maxPeers = Math.max(2, Math.min(3, parseInt(msg.maxPeers, 10) || 2));
      const room = {
        code, host: ws, client: null,
        clients: [],          // multi-peer: lista av extra klienter (utöver host)
        maxPeers,
        game: null, tickHandle: null, lastStateMs: 0, lastTickMs: 0, hostGoneAt: null,
      };
      rooms.set(code, room);
      ws.role = 'host';
      ws.roomCode = code;
      ws.peerIdx = 1;          // host = peer 1
      send(ws, { t: 'hosted', code, maxPeers, peerIdx: 1 });
      console.log(`[${code}] hosted maxPeers=${maxPeers} (rooms=${rooms.size})`);
    } else if (msg.t === 'reclaim') {
      // Host försöker återansluta till sitt gamla rum efter WS-disconnect
      if (ws.roomCode) return;
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { t: 'reclaim-error', msg: 'Rummet finns inte längre.' });
        console.log(`[reclaim-fail] code=${code} not found`);
        return;
      }
      if (room.host) {
        // Någon är redan host — kan inte reclaim:a
        send(ws, { t: 'reclaim-error', msg: 'Rummet är upptaget.' });
        return;
      }
      room.host = ws;
      room.hostGoneAt = null;
      ws.role = 'host';
      ws.roomCode = code;
      send(ws, { t: 'reclaimed', code, hasClient: !!room.client });
      if (room.client) send(room.client, { t: 'peer-rejoined' });
      console.log(`[${code}] host reclaimed (rooms=${rooms.size})`);
    } else if (msg.t === 'join') {
      if (ws.roomCode) return;
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { t: 'join-error', msg: 'Rummet finns inte. Kontrollera koden eller be hosten skapa ett nytt rum.' });
        console.log(`[join-fail] code=${code} not found. Existing: ${[...rooms.keys()].join(',') || '(none)'}`);
        return;
      }
      if (!room.host) {
        send(ws, { t: 'join-error', msg: 'Hosten har tappat anslutningen. Be hosten skapa ett nytt rum.' });
        console.log(`[join-fail] code=${code} host gone`);
        return;
      }
      const maxPeers = room.maxPeers || 2;
      const peersNow = 1 + (room.client ? 1 : 0) + (room.clients ? room.clients.length : 0);
      if (peersNow >= maxPeers) {
        send(ws, { t: 'join-error', msg: 'Rummet är fullt.' });
        return;
      }
      // Klassisk 2-peer: använd room.client slot (kompatibel med befintlig kod).
      // Multi-peer (3+): tilläggsklienter i room.clients[].
      if (maxPeers <= 2) {
        room.client = ws;
        ws.role = 'client';
        ws.peerIdx = 2;
      } else {
        if (!room.client) {
          room.client = ws;
          ws.role = 'client';
          ws.peerIdx = 2;
        } else {
          room.clients.push(ws);
          ws.role = 'client' + (1 + room.clients.length);   // 'client2', 'client3', ...
          ws.peerIdx = 2 + room.clients.length;             // 3, 4, ...
        }
      }
      ws.roomCode = code;
      const newPeersTotal = 1 + (room.client ? 1 : 0) + room.clients.length;
      send(ws, { t: 'joined', code, peersTotal: newPeersTotal, maxPeers, peerIdx: ws.peerIdx });
      // Notify alla andra om peer-joined + nytt antal
      const peerJoinedMsg = { t: 'peer-joined', peersTotal: newPeersTotal, maxPeers };
      send(room.host, peerJoinedMsg);
      for (const c of room.clients) if (c !== ws) send(c, peerJoinedMsg);
      if (room.client && room.client !== ws) send(room.client, peerJoinedMsg);
      console.log(`[${code}] peer joined (${newPeersTotal}/${maxPeers})`);
      // 2-peer-rum: starta klassisk engine direkt (oförändrat beteende).
      // 3-peer-rum: host bestämmer själv när matchen startar via separat 'start-match'-meddelande.
      if (maxPeers <= 2) startGame(room);
    } else if (msg.t === 'msg') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const payload = msg.d;
      if (payload && typeof payload.t === 'string' && payload.t.startsWith('a-')) {
        relayArenaMessage(room, ws, msg);
      } else if (payload && typeof payload.t === 'string' && payload.t.startsWith('b-')) {
        relayBossWarsMessage(room, ws, msg);
      } else {
        handleGameInput(room, ws, payload);
      }
    } else if (msg.t === 'leave') {
      closeRoom(ws);
    }
  });

  ws.on('close', () => { handleDisconnect(ws); });
  ws.on('error', () => {});
});

// Anropas när ws stänger. Skiljer på "host disconnect utan client" (grace-period
// så host kan reclaim:a) och "normal disconnect" (stäng rummet direkt).
function handleDisconnect(ws) {
  const code = ws.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  ws.roomCode = null;
  ws.role = null;
  if (!room) return;

  // Host disconnect utan andra peers → grace-period
  const peerCount = (room.client ? 1 : 0) + (room.clients ? room.clients.length : 0);
  if (room.host === ws && peerCount === 0) {
    room.host = null;
    room.hostGoneAt = Date.now();
    console.log(`[${code}] host disconnected, grace ${HOST_GRACE_MS}ms`);
    return;
  }
  // Multi-peer: en extra-klient lämnar → bara ta bort den, behåll rummet
  if (room.maxPeers && room.maxPeers > 2 && ws !== room.host) {
    let removed = false;
    if (room.client === ws) { room.client = null; removed = true; }
    if (room.clients) {
      const idx = room.clients.indexOf(ws);
      if (idx >= 0) { room.clients.splice(idx, 1); removed = true; }
    }
    if (removed) {
      const newTotal = 1 + (room.client ? 1 : 0) + room.clients.length;
      const leftMsg = { t: 'peer-left', peersTotal: newTotal, maxPeers: room.maxPeers };
      if (room.host) send(room.host, leftMsg);
      if (room.client) send(room.client, leftMsg);
      for (const c of room.clients) send(c, leftMsg);
      console.log(`[${code}] peer left (${newTotal}/${room.maxPeers})`);
      return;
    }
  }
  // Annars normal stängning (klassisk 2-peer eller host i multi-peer)
  closeRoomNow(room);
}

// Tvinga stängning oavsett state — används av 'leave' + grace-timeout
function closeRoom(ws) {
  const code = ws.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  ws.roomCode = null;
  ws.role = null;
  if (!room) return;
  closeRoomNow(room);
}

function closeRoomNow(room) {
  if (!rooms.has(room.code)) return;  // redan stängt
  const all = [];
  if (room.client && room.client !== room.host) all.push(room.client);
  if (room.clients) for (const c of room.clients) all.push(c);
  for (const ws of all) {
    send(ws, { t: 'peer-left' });
    ws.roomCode = null;
    ws.role = null;
  }
  if (room.host) {
    send(room.host, { t: 'peer-left' });
    room.host.roomCode = null;
    room.host.role = null;
  }
  stopGame(room);
  rooms.delete(room.code);
  console.log(`[${room.code}] closed (rooms=${rooms.size})`);
}

// Cleanup: stäng rum vars grace-period gått ut
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.host && room.hostGoneAt && (now - room.hostGoneAt) > HOST_GRACE_MS) {
      console.log(`[${code}] grace expired, closing`);
      closeRoomNow(room);
    }
  }
}, 5000);

// Heartbeat så zombi-anslutningar inte hänger kvar (server-pingar var 30s)
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
