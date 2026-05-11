// Mini WebSocket-relay för Hero Line Warz multiplayer.
// Host kör sin lobby med kod, client ansluter med kod, servern relayar
// alla speldata-meddelanden mellan dem. Inget statslager — servern bryr sig
// inte om innehållet, bara om vem som är i vilket rum.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Wake-up / health check
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Spel relay running. Rooms: ' + rooms.size);
});

const wss = new WebSocketServer({ server });

// roomCode -> { host: ws, client: ws | null }
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

wss.on('connection', (ws) => {
  ws.role = null;
  ws.roomCode = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.t === 'host') {
      // Ignorera om redan i ett rum
      if (ws.roomCode) return;
      const code = genCode();
      rooms.set(code, { host: ws, client: null });
      ws.role = 'host';
      ws.roomCode = code;
      send(ws, { t: 'hosted', code });
      console.log(`[${code}] hosted (rooms=${rooms.size})`);
    } else if (msg.t === 'join') {
      if (ws.roomCode) return;
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { t: 'join-error', msg: 'Rummet finns inte.' });
        return;
      }
      if (room.client) {
        send(ws, { t: 'join-error', msg: 'Rummet är fullt.' });
        return;
      }
      room.client = ws;
      ws.role = 'client';
      ws.roomCode = code;
      send(ws, { t: 'joined', code });
      send(room.host, { t: 'peer-joined' });
      console.log(`[${code}] client joined`);
    } else if (msg.t === 'msg') {
      // Relay speldata till motparten
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const target = ws.role === 'host' ? room.client : room.host;
      send(target, { t: 'msg', d: msg.d });
    } else if (msg.t === 'leave') {
      // Frivilligt lämna rummet (utan att stänga websocket)
      closeRoom(ws);
    }
  });

  ws.on('close', () => {
    closeRoom(ws);
  });

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
  if (other) {
    other.roomCode = null;
    other.role = null;
  }
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
  console.log(`Relay listening on :${PORT}`);
});
