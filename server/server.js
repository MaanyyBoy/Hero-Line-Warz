// Server-auktoritativ Hero Line Warz multiplayer-server.
// Hostar två-spelarsessioner och kör hela simuleringen själv via game-engine.
// Klienterna skickar bara inputs och renderar mottagen state.

const http = require('http');
const { WebSocketServer } = require('ws');
const engine = require('./game-engine.js');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30;                       // simuleringssteg per sekund
// State-broadcast 30 Hz (matchar tick). Decision 052 testade 20 Hz för CPU-spar
// på free-tier men user rapporterade choppy duel-rörelse — 50ms snap-intervall
// är för långt för combat-tempo (hero-vs-hero i duel-arena, hero-skill-dodging).
// Defensiva fixarna från 052 (velocity-extrapolation 150ms + lägre backpressure
// 40/48 KB) behålls — de hjälper utan att kosta combat-feel.
const STATE_RATE = 30;
const TICK_INTERVAL_MS = 1000 / TICK_RATE;
const STATE_INTERVAL_MS = 1000 / STATE_RATE;
// Grace-period när host disconnect:ar utan client. Rummet behålls så
// host kan reclaim:a med samma kod (t.ex. efter mobile-bakgrund/proxy-blip).
const HOST_GRACE_MS = 30000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Spel server running. Rooms: ${rooms.size}`);
});

// TCP_NODELAY på alla inkommande sockets — disable Nagle's algorithm. Utan
// detta buntar OS-kärnan små paket (60Hz input ~50 byte, pong, små state-deltas)
// i upp till ~40-200ms innan send → upplevs som input-lag i MP. Med setNoDelay
// skickas varje paket direkt → snappast möjlig svarstid över WebSocket.
// 'connection'-eventet emit:as INNAN socket upgradas till WS, vilket är när
// vi vill sätta TCP-flaggor. Påverkar både HTTP- och WS-trafik.
server.on('connection', (socket) => {
  try { socket.setNoDelay(true); } catch (_) {}
});

// WebSocket compression (permessage-deflate). Reducerar text-JSON-payload med
// 60-80% — på 10-15 KB game-state-snap blir det 3-5 KB över wire. Stort
// bandbredds-spar för mobile + WiFi som kan stappla på bursts.
// threshold:256 = skippa compression för små messages (input/ping).
// level:1 = snabbaste zlib-compression (~1ms CPU, near-default ratio).
// maxPayload:256KB = DoS-skydd; spel-state är aldrig nära det.
const wss = new WebSocketServer({
  server,
  maxPayload: 256 * 1024,
  perMessageDeflate: {
    zlibDeflateOptions: { level: 1, memLevel: 7 },
    zlibInflateOptions: { chunkSize: 10 * 1024 },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 256,
  },
});

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
  room.nextTickAt = Date.now();
  scheduleNextTick(room);
  console.log(`[${room.code}] game started`);
}

function stopGame(room) {
  if (room.tickHandle) {
    clearTimeout(room.tickHandle);
    room.tickHandle = null;
  }
  room.game = null;
  // Defensiv härdning: nollställ server-auth-flaggor så ett ev. återanvänt rum (framtida
  // rematch utan disconnect) kan skicka b-end/a-end igen och starta ny sim rent.
  room.bossEndSent = false;
  room.bossSim = false;
  room.arenaSim = false;
}

// Self-correcting tick-loop: räknar ut nästa absolut tick-deadline och kompenserar
// för Node:s setTimeout-drift. setInterval ackumulerar fel över tid + kan koalescera
// missade ticks; setTimeout-rekursion låter oss styra exakt när nästa tick ska
// köras + skippa redan-passerade om vi halkar efter (catch-up utan tick-stack).
function scheduleNextTick(room) {
  if (!room.game) return;
  const now = Date.now();
  const delay = Math.max(0, room.nextTickAt - now);
  room.tickHandle = setTimeout(() => gameLoopTick(room), delay);
}

// Tick-spike-tröskel: logga om en enskild tick (sim + serialize + send) tar
// > 50ms. På 30 Hz ska vi vara klara på <33ms per tick; >50ms = vi missar
// nästa deadline = potential snap-lag mot klienterna. Diagnostik för Render
// free-tier-spikes (delad CPU kan ge sporadiska pauser).
const TICK_SPIKE_WARN_MS = 50;

// Server-telemetri: periodisk summering av tick-stats till Render-loggen (var 10s)
// så vi ser steady-state-distributionen (avg/p95/max), inte bara spike-outliers.
// För djup MP-lagg-analys på botmatcher (komplement till klient-telemetrin).
const TELEMETRY_LOG_INTERVAL_MS = 10000;
function _telFmt(arr) {
  if (!arr.length) return '0';
  const s = arr.slice().sort((a, b) => a - b);
  const avg = arr.reduce((x, y) => x + y, 0) / arr.length;
  const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
  return `avg${avg.toFixed(1)} p95:${p95} max:${s[s.length - 1]}`;
}
function _telEntityCount(game) {
  let n = 0;
  if (!game || !game.sides) return 0;
  const seen = new Set();
  for (const idx of [1, 2, 3, 4]) {
    const s = game.sides[idx];
    if (!s) continue;
    if (s.monsters && !seen.has(s.monsters)) { seen.add(s.monsters); n += s.monsters.length; }
    if (s.playerCreeps) n += s.playerCreeps.length;
    if (s.projectiles) n += s.projectiles.length;
    if (s.monsterProjectiles) n += s.monsterProjectiles.length;
  }
  return n;
}

function gameLoopTick(room) {
  if (!room.game) { room.tickHandle = null; return; }
  const now = Date.now();
  const dt = Math.min(0.1, Math.max(0.001, (now - room.lastTickMs) / 1000));
  room.lastTickMs = now;
  // Mät simuleringskostnad separat från serialize för bättre spike-diagnostik.
  const _simStart = Date.now();
  const _isArena = !!room.arenaSim;          // decision 120: server-auth arena
  const _isBoss = !!room.bossSim;            // decision 122 Fas 2: server-auth boss wars (3-peer)
  try {
    if (_isArena) engine.tickArena(room.game, dt);
    else if (_isBoss) engine.tickBossWars(room.game, dt);
    else engine.tickGame(room.game, dt);
  } catch (e) {
    console.error(`[${room.code}] tick error:`, e && e.stack || e);
  }
  const _simMs = Date.now() - _simStart;
  if (room.game && now - room.lastStateMs >= STATE_INTERVAL_MS) {
    room.lastStateMs = now;
    try {
      const stateMsg = _isArena ? engine.serializeArenaState(room.game)
                     : _isBoss ? engine.serializeBossWarsState(room.game)
                     : engine.serializeState(room.game);
      // Pre-stringify EN gång + skicka samma raw-string till båda peers.
      // Tidigare körde send-helpern JSON.stringify 2x per broadcast (en gång per
      // peer). Vid 30 Hz × ~10-15 KB payload sparar detta ~50% serialize-tid.
      const payload = JSON.stringify({ t: 'msg', d: stateMsg });
      room._lastPayloadLen = payload.length;   // för telemetri
      // Backpressure-skip: om peer-socket har > 40 KB buffrad (sänkt från 64 KB)
      // skippa frame. Aggressivare drop = mindre kö-djup = snabbare återhämtning
      // när socket flushas. State är redundant — nästa snap (33ms senare vid
      // 30 Hz) är redan färskare. Att skicka mer på en stockad socket ger bara
      // exponentiell latens-spiral.
      const BACKPRESSURE_LIMIT = 40 * 1024;
      if (room.host && room.host.readyState === 1 && room.host.bufferedAmount < BACKPRESSURE_LIMIT) {
        try { room.host.send(payload); } catch (_) {}
      }
      if (room.client && room.client.readyState === 1 && room.client.bufferedAmount < BACKPRESSURE_LIMIT) {
        try { room.client.send(payload); } catch (_) {}
      }
      // 3-peer (boss wars): broadcasta även till extra-klienterna i room.clients[].
      if (_isBoss && room.clients) {
        for (const c of room.clients) {
          if (c && c.readyState === 1 && c.bufferedAmount < BACKPRESSURE_LIMIT) {
            try { c.send(payload); } catch (_) {}
          }
        }
      }
    } catch (e) {
      console.error(`[${room.code}] serialize/send error:`, e && e.stack || e);
    }
  }
  // Diagnostik: spike-log för långa ticks. Decision 044.
  const _totalMs = Date.now() - now;
  if (_totalMs >= TICK_SPIKE_WARN_MS) {
    console.warn(`[${room.code}] tick-spike ${_totalMs}ms (sim ${_simMs}ms)`);
  }
  // Telemetri: rullande tick-stats → periodisk summering i Render-loggen.
  const _tel = room._tel || (room._tel = { sim: [], total: [], pay: [], lastLog: now });
  _tel.sim.push(_simMs); _tel.total.push(_totalMs);
  if (room._lastPayloadLen) _tel.pay.push(room._lastPayloadLen);
  if (now - _tel.lastLog >= TELEMETRY_LOG_INTERVAL_MS) {
    _tel.lastLog = now;
    const mode = _isArena ? 'arena' : (_isBoss ? 'boss' : 'lw');
    console.log(`[${room.code}] TEL ${mode} ticks:${_tel.total.length} sim[${_telFmt(_tel.sim)}]ms total[${_telFmt(_tel.total)}]ms payload[${_telFmt(_tel.pay)}]B ents:${_telEntityCount(room.game)}`);
    _tel.sim.length = 0; _tel.total.length = 0; _tel.pay.length = 0;
  }
  // Schemalägg nästa tick mot absolut deadline (eliminerar drift). Om vi
  // halkar efter mer än 2 ticks, hoppa till nu — undviker tick-storm.
  // Arena: matchen slut → stoppa loopen (slut-staten broadcastades just ovan, så
  // klienterna fick phase='matchEnd'). Utan detta tickar ett avslutat arena-rum i
  // 30 Hz tills spelarna lämnar = onödig CPU. (Bug-hunter-fynd, decision 120.)
  if ((_isArena || _isBoss) && room.game && room.game.matchState.gameOver) {
    // Boss wars: signalera match-slut till ALLA peers innan simmen stoppas (server-auth).
    if (_isBoss && !room.bossEndSent) {
      room.bossEndSent = true;
      const endMsg = JSON.stringify({ t: 'msg', d: { t: 'b-end', won: room.game.matchState.winner === 1 } });
      if (room.host && room.host.readyState === 1) { try { room.host.send(endMsg); } catch (_) {} }
      if (room.client && room.client.readyState === 1) { try { room.client.send(endMsg); } catch (_) {} }
      if (room.clients) for (const c of room.clients) { if (c && c.readyState === 1) { try { c.send(endMsg); } catch (_) {} } }
    }
    stopGame(room); return;
  }
  room.nextTickAt += TICK_INTERVAL_MS;
  if (room.nextTickAt < now - TICK_INTERVAL_MS * 2) room.nextTickAt = now + TICK_INTERVAL_MS;
  scheduleNextTick(room);
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

// Backpressure-tröskel: om mottagar-socketens skicka-buffert är fylld (TCP-stockning,
// långsam mobil), skippa redundanta state-frames istället för att stacka upp.
// Input/pick/ready är kritiska och skickas alltid. State är redundant —
// nästa snap kommer 33ms senare (30 Hz) och är färskare. Sänkt från 96 KB →
// 48 KB för aggressivare drop = snabbare återhämtning under spikar.
const RELAY_STATE_BACKPRESSURE_LIMIT = 48 * 1024;

function isStateMsgType(t) {
  // Frames som är säkra att skippa under backpressure (redundant snapshot-data).
  return t === 'a-state' || t === 'b-state';
}

function relayPeerSend(peer, envelope, isState) {
  if (!peer || peer.readyState !== 1) return;
  if (isState && peer.bufferedAmount > RELAY_STATE_BACKPRESSURE_LIMIT) return;
  send(peer, envelope);
}

// ── Decision 120: server-auktoritativ arena (opt-in via a-sim-start) ──────
// Bakåtkompatibelt: en arena-klient som INTE skickar a-sim-start får gammalt
// P2P-relä-beteende (host-auth) → deploy av servern ensam bryter inget. När den
// nya klientens host skickar a-sim-start startar servern arena-engine:n och äger
// a-state; host:ens egna a-state ignoreras då.
function startArenaSim(room, heroes) {
  if (room.game || room.tickHandle) return;        // redan igång
  room.arenaSim = true;
  room.game = engine.initArenaMatch(heroes);
  room.lastStateMs = 0;
  room.lastTickMs = Date.now();
  room.nextTickAt = Date.now();
  scheduleNextTick(room);
  console.log(`[${room.code}] arena sim started (server-auth)`);
}

function applyArenaInput(room, ws, payload) {
  if (!room.game) return;
  const sideIdx = (ws === room.host) ? 1 : 2;       // socket-identitet, ej payload (spoof-skydd)
  const inp = room.game.lastInputs[sideIdx];
  if (inp) {
    let jx = Number(payload.jx) || 0, jz = Number(payload.jz) || 0;
    const mag = Math.hypot(jx, jz);
    if (mag > 1) { jx /= mag; jz /= mag; }
    inp.j = { x: jx, z: jz };
  }
  if (Array.isArray(payload.events) && payload.events.length) {
    for (const ev of payload.events) {
      if (!ev || typeof ev !== 'object') continue;
      try { engine.applyEvent(room.game, sideIdx, ev); }
      catch (e) { console.warn('arena applyEvent error', e); }
    }
  }
}

// ── Decision 122 Fas 2: server-auktoritativ boss wars (opt-in via b-sim-start) ──
// Bakåtkompatibelt: en boss-klient som INTE skickar b-sim-start får gammalt host-auth
// relä-beteende (relayBossWarsMessage) → deploy bryter inget. När den nya klientens host
// skickar b-sim-start startar servern boss-engine:n + äger b-state. 3-peer broadcast.
function startBossWarsSim(room, heroes, tier, loadouts, bots) {
  if (room.game || room.tickHandle) return;        // redan igång
  room.bossSim = true;
  room.game = engine.initBossWarsMatch(heroes, tier, loadouts);
  // Host fyller tomma co-op-slots (2/3) med bots. bots = { "2": "medium", "3": "hard" }.
  // Bara slots utan ansluten peer (säkerställs klient-side; här sätts bara flaggan).
  if (bots && typeof bots === 'object' && !Array.isArray(bots)) {
    for (const k of Object.keys(bots)) {
      const idx = Number(k);
      const side = room.game.sides[idx];
      if (side && (idx === 2 || idx === 3)) {
        side.isBot = true;
        side.botDifficulty = ['easy', 'medium', 'hard'].includes(bots[k]) ? bots[k] : 'medium';
      }
    }
  }
  room.lastStateMs = 0;
  room.lastTickMs = Date.now();
  room.nextTickAt = Date.now();
  scheduleNextTick(room);
  console.log(`[${room.code}] boss wars sim started (server-auth, tier ${tier})`);
}

function applyBossWarsInput(room, ws, payload) {
  if (!room.game) return;
  const sideIdx = ws.peerIdx;                       // 1=host, 2/3=klienter (satt vid join, spoof-skydd)
  if (!(sideIdx >= 1 && sideIdx <= 3)) return;
  const inp = room.game.lastInputs[sideIdx];
  if (inp) {
    let jx = Number(payload.jx) || 0, jz = Number(payload.jz) || 0;
    const mag = Math.hypot(jx, jz);
    if (mag > 1) { jx /= mag; jz /= mag; }
    inp.j = { x: jx, z: jz };
  }
  // OBS: boss-klienten skickar events i fältet `ev` (inte `events` som arena).
  if (Array.isArray(payload.ev) && payload.ev.length) {
    for (const ev of payload.ev) {
      if (!ev || typeof ev !== 'object') continue;
      try { engine.applyEvent(room.game, sideIdx, ev); }
      catch (e) { console.warn('boss applyEvent error', e); }
    }
  }
}

function handleBossMessage(room, fromWs, envelope) {
  const payload = envelope.d;
  const t = payload && payload.t;
  // Host begär server-auth boss-sim (skickas vid match-launch). Bara host.
  if (t === 'b-sim-start') {
    if (fromWs === room.host) startBossWarsSim(room, payload.heroes, payload.tier, payload.loadouts, payload.bots);
    return;
  }
  if (room.bossSim) {
    // Server-auth aktivt: input → engine, b-state ägs av servern (ignorera host:ens).
    if (t === 'b-input') { applyBossWarsInput(room, fromWs, payload); return; }
    if (t === 'b-state') return;
    // Övriga b- (b-tier/b-ready/b-pick/b-launch/b-end lobby-flöde) reläas — de skickas
    // före sim-start, eller är match-flödes-signaler host fortf. äger.
  }
  relayBossWarsMessage(room, fromWs, envelope);
}

function handleArenaMessage(room, fromWs, envelope) {
  const payload = envelope.d;
  const t = payload && payload.t;
  // Host begär server-auth-sim (skickas vid fight-start). Bara host.
  if (t === 'a-sim-start') {
    if (fromWs === room.host) startArenaSim(room, payload.heroes);
    return;
  }
  if (room.arenaSim) {
    // Server-auth aktivt: input → engine, a-state ägs av servern (ignorera host:ens),
    // ready → server-state (driver prep→fight-övergången).
    if (t === 'a-input') { applyArenaInput(room, fromWs, payload); return; }
    if (t === 'a-state') return;
    if (t === 'a-ready') {
      const sideIdx = (fromWs === room.host) ? 1 : 2;
      if (room.game && room.game.ready) room.game.ready[sideIdx] = !!payload.value;
      return;
    }
    if (t === 'a-talent') {
      const sideIdx = (fromWs === room.host) ? 1 : 2;
      const tal = room.game && room.game.talents && room.game.talents[sideIdx];
      if (tal) {
        const id = payload.talentId;
        if (payload.remove) { const i = tal.chosen.indexOf(id); if (i >= 0) { tal.chosen.splice(i, 1); tal.points++; } }
        else if (tal.points > 0 && id && tal.chosen.indexOf(id) < 0) { tal.chosen.push(id); tal.points--; }
        // Recompute stats so talent stat-bonuses (HP/dmg/AS/MS/CDR/DR) take effect immediately
        const side = room.game.sides && room.game.sides[sideIdx];
        if (side) engine.recomputeArenaSideStats(room.game, side);
      }
      return;
    }
    // Övriga a- (a-pick/a-mvote/a-mvstate/a-mvres/a-pick-confirm): relä till peer (lobby-flöde)
  }
  relayArenaMessage(room, fromWs, envelope);
}

// Arena MP (host-auth, legacy): servern relayar arena-meddelanden mellan peers.
// Används när a-sim-start ej skickats (gammal klient). Den klassiska engine:n
// startas aldrig för arena-rum — se 'join'-handlern.
function relayArenaMessage(room, fromWs, envelope) {
  // Spoof-skydd: bara host får broadcasta auktoritativ state.
  if (envelope.d && envelope.d.t === 'a-state' && fromWs !== room.host) return;
  const peer = (fromWs === room.host) ? room.client : room.host;
  const isState = isStateMsgType(envelope.d && envelope.d.t);
  relayPeerSend(peer, envelope, isState);
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
  const isState = isStateMsgType(envelope.d && envelope.d.t);
  // Annars broadcast till alla peers utom avsändaren
  if (room.host && fromWs !== room.host) relayPeerSend(room.host, envelope, isState);
  if (room.client && fromWs !== room.client) relayPeerSend(room.client, envelope, isState);
  for (const c of (room.clients || [])) if (c !== fromWs) relayPeerSend(c, envelope, isState);
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
      // Keepalive från klient — håller WS levande mot proxy. Svara med pong.
      // Eko:a klientens ts tillbaka → klienten kan räkna RTT (round-trip-latens).
      send(ws, msg.ts != null ? { t: 'pong', ts: msg.ts } : { t: 'pong' });
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
        // Spel-läge från host-meddelandet. Arena är host-auktoritativt i
        // webbläsaren → servern ska INTE köra den klassiska engine:n för
        // arena-rum (se 'join'-handlern nedan). Saniteras: bara 'arena1v1'
        // eller 'classic'. Gammal klient utan fältet → 'classic' (oförändrat).
        mode: (msg.mode === 'arena1v1') ? 'arena1v1' : (msg.mode === 'bosswars') ? 'bosswars' : 'classic',
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
      // 2-peer-rum: starta klassisk engine direkt — MEN bara för classic-rum.
      // Arena är host-auktoritativt i webbläsaren och rör aldrig den server-
      // körda engine:n; att köra den skulle slösa CPU + broadcasta en full
      // classic-state (~10-15 KB) 30 ggr/s till båda peers som ändå kastar bort
      // varje paket → mättad nedlänk → jitter/hack trots låg ping.
      // 3-peer-rum (boss wars): host bestämmer själv när matchen startar.
      if (maxPeers <= 2 && room.mode === 'classic') startGame(room);   // bara classic-rum kör server-engine direkt (ej arena/bosswars)
    } else if (msg.t === 'msg') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const payload = msg.d;
      if (payload && typeof payload.t === 'string' && payload.t.startsWith('a-')) {
        handleArenaMessage(room, ws, msg);
      } else if (payload && typeof payload.t === 'string' && payload.t.startsWith('b-')) {
        handleBossMessage(room, ws, msg);
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
      const leftMsg = { t: 'peer-left', peersTotal: newTotal, maxPeers: room.maxPeers, leftPeerIdx: ws.peerIdx };
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

// Heartbeat så zombi-anslutningar inte hänger kvar. Decision 044: 30s → 15s
// så död socket detekteras snabbare (worst-case detection ~15s istället för
// ~30s). Snabbare detection = host slipper pumpa state till en stockad/död
// peer-socket vars bufferedAmount sakta växer → catch-up-spiral.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { try { ws.terminate(); } catch (_) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 15000);

server.listen(PORT, () => {
  console.log(`Spel server listening on :${PORT}`);
});
