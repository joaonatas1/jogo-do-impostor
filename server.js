'use strict';

const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const { CATEGORIES } = require('./words');

const PORT = Number(process.env.PORT) || 3000;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;
const CODE_LENGTH = 5;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_NAME = 18;
const MAX_CLUE = 24;
const ROOM_TTL = 2 * 60 * 60 * 1000;

const rooms = new Map();
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 100_000,
});

const DATABASE_URL = process.env.DATABASE_URL || '';
const db = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;
let dbReady = false;

const TURN_KEY_ID = process.env.TURN_KEY_ID || '';
const TURN_KEY_API_TOKEN = process.env.TURN_KEY_API_TOKEN || '';
const STUN_SERVERS = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];
const TURN_TTL_SECONDS = 2 * 60 * 60;
const TURN_CACHE_MS = 45 * 60 * 1000;
let turnCache = { at: 0, iceServers: null };

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({
  ok: true,
  rooms: rooms.size,
  db: dbReady ? 'ready' : db ? 'pending' : 'off',
  turn: TURN_KEY_ID ? 'configured' : 'off',
}));

app.get('/api/history', async (_req, res) => {
  if (!db || !dbReady) {
    return res.status(503).json({ ok: false, error: 'Histórico indisponível no momento.' });
  }
  try {
    const { rows } = await db.query(`
      SELECT id, room_code, word, category, hint, impostor_name, accused_id,
             winner, player_count, players, tally, created_at
      FROM matches
      ORDER BY created_at DESC
      LIMIT 20
    `);
    return res.json({
      ok: true,
      matches: rows.map((row) => ({
        id: row.id,
        roomCode: row.room_code,
        word: row.word,
        category: row.category,
        hint: row.hint,
        impostorName: row.impostor_name,
        accusedId: row.accused_id,
        winner: row.winner,
        playerCount: row.player_count,
        players: row.players,
        tally: row.tally,
        createdAt: row.created_at,
      })),
    });
  } catch (err) {
    console.error('Banco: falha ao ler histórico:', err.message);
    return res.status(500).json({ ok: false, error: 'Não foi possível carregar o histórico.' });
  }
});

app.get('/api/turn-credentials', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!TURN_KEY_ID || !TURN_KEY_API_TOKEN) {
    return res.json({ ok: true, turn: false, iceServers: STUN_SERVERS });
  }
  if (turnCache.iceServers && Date.now() - turnCache.at < TURN_CACHE_MS) {
    return res.json({ ok: true, turn: true, iceServers: turnCache.iceServers });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(TURN_KEY_ID)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TURN_KEY_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        signal: controller.signal,
      }
    );
    if (!response.ok) throw new Error(`Cloudflare respondeu ${response.status}`);
    const data = await response.json();
    const raw = Array.isArray(data.iceServers) ? data.iceServers : [];
    const filtered = raw
      .map((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return {
          ...server,
          urls: urls.filter((url) => url && !/:53(?:\?|$)/.test(String(url))),
        };
      })
      .filter((server) => server.urls.length > 0);

    const hasStun = filtered.some((server) =>
      server.urls.some((url) => String(url).startsWith('stun:'))
    );
    const iceServers = hasStun ? filtered : [...STUN_SERVERS, ...filtered];
    if (!iceServers.some((server) => server.urls.some((url) => String(url).startsWith('turn')))) {
      throw new Error('Cloudflare não retornou servidores TURN');
    }

    turnCache = { at: Date.now(), iceServers };
    return res.json({ ok: true, turn: true, iceServers });
  } catch (err) {
    console.error('TURN: falha ao gerar credenciais:', err.message);
    return res.json({
      ok: true,
      turn: false,
      iceServers: STUN_SERVERS,
      warning: 'TURN indisponível no momento.',
    });
  } finally {
    clearTimeout(timer);
  }
});

// ---------- database ----------

async function initDb() {
  if (!db) {
    console.log('  Banco: desativado (DATABASE_URL não configurada).');
    return;
  }
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS matches (
        id UUID PRIMARY KEY,
        room_code TEXT NOT NULL,
        word TEXT NOT NULL,
        category TEXT NOT NULL,
        hint TEXT NOT NULL,
        impostor_id TEXT NOT NULL,
        impostor_name TEXT NOT NULL,
        accused_id TEXT,
        winner TEXT NOT NULL,
        player_count INTEGER NOT NULL,
        players JSONB NOT NULL,
        clues JSONB NOT NULL,
        votes JSONB NOT NULL,
        tally JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS matches_created_at_idx ON matches (created_at DESC);
    `);
    dbReady = true;
    console.log('  Banco: conectado e tabela de histórico pronta.');
  } catch (err) {
    dbReady = false;
    console.error('  Banco: falha ao inicializar:', err.message);
  }
}

function saveMatch(room) {
  if (!db || !dbReady || !room.game) return;
  const g = room.game;
  const players = playerList(room).map((p) => ({ id: p.id, name: p.name }));
  db.query(
    `INSERT INTO matches
      (id, room_code, word, category, hint, impostor_id, impostor_name, accused_id,
       winner, player_count, players, clues, votes, tally)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (id) DO NOTHING`,
    [
      g.id,
      room.code,
      g.word,
      g.category,
      g.hint,
      g.impostorId,
      g.impostorName,
      g.accusedId,
      g.winner,
      room.players.size,
      JSON.stringify(players),
      JSON.stringify(g.clues),
      JSON.stringify(g.votes),
      JSON.stringify(g.tally),
    ]
  ).catch((err) => console.error('Banco: falha ao salvar partida:', err.message));
}

// ---------- helpers ----------

function reply(cb, payload) {
  if (typeof cb === 'function') cb(payload);
}

function makeCode() {
  let code;
  do {
    code = Array.from(
      { length: CODE_LENGTH },
      () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function cleanText(raw, max) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanName(raw) {
  return cleanText(raw, MAX_NAME);
}

function cleanClue(raw) {
  return cleanText(raw, MAX_CLUE);
}

function cleanId(raw) {
  const id = String(raw ?? '').trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(id) ? id : null;
}

function pickWord() {
  const category = CATEGORIES[crypto.randomInt(CATEGORIES.length)];
  const word = category.words[crypto.randomInt(category.words.length)];
  return { word, category: category.name, hint: category.hint };
}

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function touch(room) {
  room.lastActivity = Date.now();
}

function playerList(room) {
  return [...room.players.values()];
}

function connectedPlayers(room) {
  return playerList(room).filter((p) => p.connected);
}

function audioPeerList(room) {
  return [...room.audioPeers.values()].map((peer) => ({
    socketId: peer.socketId,
    playerId: peer.playerId,
    name: peer.name,
    muted: !!peer.muted,
  }));
}

function removeAudioPeer(socket, room, notify = true) {
  if (!room?.audioPeers?.has(socket.id)) return;
  const peer = room.audioPeers.get(socket.id);
  room.audioPeers.delete(socket.id);
  if (notify) {
    io.to(room.code).emit('audioPeerLeft', {
      socketId: socket.id,
      playerId: peer.playerId,
    });
  }
}

function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host && host.connected) return;
  const next = connectedPlayers(room)[0] || playerList(room)[0];
  if (next) room.hostId = next.id;
}

function currentPlayerId(room) {
  if (!room.game || room.phase !== 'clues') return null;
  return room.game.turnOrder[room.game.turnIndex] || null;
}

function stateFor(room, playerId) {
  const me = room.players.get(playerId);
  if (!me) return null;
  const g = room.game;
  const inGame = room.phase !== 'lobby' && g;
  const results = room.phase === 'results' && g;

  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    settings: { clueRounds: room.settings.clueRounds },
    scores: { ...room.scores },
    players: playerList(room).map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      isHost: p.id === room.hostId,
      confirmed: !!p.confirmed,
      hasVoted: !!(g && g.votes && g.votes[p.id]),
    })),
    me: {
      id: me.id,
      name: me.name,
      isHost: me.id === room.hostId,
      role: inGame ? me.role : null,
      word: inGame && me.role === 'crew' ? g.word : null,
      category: inGame ? g.category : null,
      hint: inGame && me.role === 'impostor' ? g.hint : null,
      confirmed: !!me.confirmed,
      vote: g && g.votes ? g.votes[me.id] || null : null,
    },
    game: g
      ? {
          id: g.id,
          round: g.round,
          totalRounds: g.totalRounds,
          turnOrder: g.turnOrder,
          currentPlayerId: room.phase === 'clues' ? currentPlayerId(room) : null,
          clues: g.clues.map((c) => ({
            round: c.round,
            playerId: c.playerId,
            text: c.text,
            spoken: !!c.spoken,
            skipped: !!c.skipped,
          })),
          votedIds: g.votes ? Object.keys(g.votes) : [],
          results: results
            ? {
                impostorId: g.impostorId,
                impostorName: g.impostorName || '',
                word: g.word,
                category: g.category,
                hint: g.hint,
                accusedId: g.accusedId,
                leaders: g.leaders,
                tally: g.tally,
                names: g.names,
                votes: g.votes,
                winner: g.winner,
              }
            : null,
        }
      : null,
  };
}

function emitRoom(room) {
  for (const p of room.players.values()) {
    if (!p.socketId) continue;
    const state = stateFor(room, p.id);
    if (state) io.to(p.socketId).emit('state', state);
  }
}

function attachSocket(socket, room, playerId) {
  socket.data.roomCode = room.code;
  socket.data.playerId = playerId;
  socket.join(room.code);
  const player = room.players.get(playerId);
  player.socketId = socket.id;
  player.connected = true;
  touch(room);
}

function detachSocket(socket, remove) {
  const code = socket.data.roomCode;
  const playerId = socket.data.playerId;
  if (!code || !playerId) return;
  socket.data.roomCode = null;
  socket.data.playerId = null;
  socket.leave(code);

  const room = rooms.get(code);
  if (!room) return;
  removeAudioPeer(socket, room, true);
  const player = room.players.get(playerId);
  if (!player) return;

  if (remove) {
    room.players.delete(playerId);
  } else {
    if (player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;
    if (room.phase === 'reveal') player.confirmed = true;
  }

  ensureHost(room);

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }

  if (room.phase === 'voting' && allConnectedVoted(room)) {
    resolveVotes(room);
  } else if (room.phase === 'reveal' && allConfirmed(room)) {
    startClues(room);
  }

  touch(room);
  emitRoom(room);
}

function allConfirmed(room) {
  return playerList(room).every((p) => p.confirmed);
}

function allConnectedVoted(room) {
  const connected = connectedPlayers(room);
  return connected.length > 0 && connected.every((p) => !!room.game.votes[p.id]);
}

// ---------- game flow ----------

function startGameInternal(room) {
  const players = playerList(room);
  const picked = pickWord();
  const impostor = players[crypto.randomInt(players.length)];

  for (const p of players) {
    p.role = p.id === impostor.id ? 'impostor' : 'crew';
    p.confirmed = false;
    p.vote = null;
  }

  room.game = {
    id: crypto.randomUUID(),
    word: picked.word,
    category: picked.category,
    hint: picked.hint,
    impostorId: impostor.id,
    impostorName: impostor.name,
    totalRounds: room.settings.clueRounds,
    round: 0,
    turnOrder: [],
    turnIndex: 0,
    clues: [],
    votes: {},
    accusedId: null,
    leaders: [],
    tally: {},
    names: {},
    winner: null,
  };
  room.phase = 'reveal';
  touch(room);
}

function startClues(room) {
  const g = room.game;
  if (!g) return;
  g.round = 1;
  g.turnOrder = shuffle(connectedPlayers(room).map((p) => p.id));
  g.turnIndex = 0;
  room.phase = 'clues';
  if (g.turnOrder.length === 0) startVoting(room);
  touch(room);
}

function startVoting(room) {
  room.phase = 'voting';
  room.game.votes = {};
  touch(room);
}

function advanceAfterClue(room) {
  const g = room.game;
  g.turnIndex += 1;
  if (g.turnIndex < g.turnOrder.length) return;

  if (g.round < g.totalRounds) {
    g.round += 1;
    g.turnOrder = shuffle(connectedPlayers(room).map((p) => p.id));
    g.turnIndex = 0;
    if (g.turnOrder.length === 0) startVoting(room);
    return;
  }
  startVoting(room);
}

function resolveVotes(room) {
  const g = room.game;
  const tally = {};
  for (const p of room.players.values()) tally[p.id] = 0;
  for (const targetId of Object.values(g.votes)) {
    if (tally[targetId] === undefined) tally[targetId] = 0;
    tally[targetId] += 1;
  }

  const entries = Object.entries(tally);
  const max = Math.max(0, ...entries.map(([, count]) => count));
  g.leaders = max > 0 ? entries.filter(([, count]) => count === max).map(([id]) => id) : [];
  g.accusedId = g.leaders.length === 1 ? g.leaders[0] : null;
  g.tally = tally;
  g.names = Object.fromEntries(playerList(room).map((p) => [p.id, p.name]));
  g.impostorName = g.names[g.impostorId] || '???';
  g.winner = g.accusedId && g.accusedId === g.impostorId ? 'crew' : 'impostor';

  if (g.winner === 'crew') room.scores.crew += 1;
  else room.scores.impostor += 1;

  room.phase = 'results';
  saveMatch(room);
  touch(room);
}

function backToLobby(room) {
  room.phase = 'lobby';
  room.game = null;
  for (const p of room.players.values()) {
    p.role = null;
    p.confirmed = false;
    p.vote = null;
  }
  touch(room);
}

// ---------- socket handlers ----------

function leavePreviousRoom(socket) {
  if (!socket.data.roomCode) return;
  const room = rooms.get(socket.data.roomCode);
  const remove = !room || room.phase === 'lobby' || room.phase === 'results';
  detachSocket(socket, remove);
}

function createRoom(socket, data, cb) {
  const name = cleanName(data.name);
  const playerId = cleanId(data.playerId);
  if (!name) return reply(cb, { ok: false, error: 'Digite seu nome.' });
  if (!playerId) return reply(cb, { ok: false, error: 'Identidade inválida. Recarregue a página.' });
  leavePreviousRoom(socket);

  const code = makeCode();
  const room = {
    code,
    hostId: playerId,
    phase: 'lobby',
    settings: { clueRounds: 1 },
    scores: { crew: 0, impostor: 0 },
    players: new Map(),
    audioPeers: new Map(),
    game: null,
    lastActivity: Date.now(),
  };
  room.players.set(playerId, {
    id: playerId,
    name,
    socketId: socket.id,
    connected: true,
    role: null,
    confirmed: false,
  });
  rooms.set(code, room);
  attachSocket(socket, room, playerId);
  emitRoom(room);
  return reply(cb, { ok: true, code });
}

function joinRoom(socket, data, cb) {
  const code = String(data.code || '').trim().toUpperCase();
  const name = cleanName(data.name);
  const playerId = cleanId(data.playerId);
  if (!playerId) return reply(cb, { ok: false, error: 'Identidade inválida. Recarregue a página.' });

  const room = rooms.get(code);
  if (!room) return reply(cb, { ok: false, error: 'Sala não encontrada. Confira o código.' });

  const existing = room.players.get(playerId);
  if (existing) {
    if (existing.socketId && existing.socketId !== socket.id) {
      const old = io.sockets.sockets.get(existing.socketId);
      if (old) {
        removeAudioPeer(old, room, true);
        old.emit('sessionReplaced');
        old.leave(room.code);
        old.data.roomCode = null;
        old.data.playerId = null;
      }
    }
    if (existing.name && room.phase === 'lobby' && name) existing.name = name;
    attachSocket(socket, room, playerId);
    emitRoom(room);
    return reply(cb, { ok: true, code: room.code, rejoined: true });
  }

  if (!name) return reply(cb, { ok: false, error: 'Digite seu nome.' });
  if (room.phase !== 'lobby') {
    return reply(cb, { ok: false, error: 'Esta partida já começou. Peça o código de uma nova sala.' });
  }
  if (room.players.size >= MAX_PLAYERS) {
    return reply(cb, { ok: false, error: 'Sala cheia (máximo de 12 jogadores).' });
  }
  leavePreviousRoom(socket);

  room.players.set(playerId, {
    id: playerId,
    name,
    socketId: socket.id,
    connected: true,
    role: null,
    confirmed: false,
  });
  attachSocket(socket, room, playerId);
  emitRoom(room);
  return reply(cb, { ok: true, code: room.code });
}

function startGame(socket, cb) {
  const { room, player } = getContext(socket);
  if (!room || !player) return reply(cb, { ok: false, error: 'Você não está em uma sala.' });
  if (room.hostId !== player.id) return reply(cb, { ok: false, error: 'Só o anfitrião pode iniciar.' });
  if (room.phase !== 'lobby') return reply(cb, { ok: false, error: 'A partida já está em andamento.' });

  const players = playerList(room);
  if (players.length < MIN_PLAYERS) {
    return reply(cb, { ok: false, error: `São necessários pelo menos ${MIN_PLAYERS} jogadores.` });
  }
  if (players.some((p) => !p.connected)) {
    return reply(cb, { ok: false, error: 'Todos os jogadores precisam estar conectados para começar.' });
  }

  startGameInternal(room);
  emitRoom(room);
  return reply(cb, { ok: true });
}

function updateSettings(socket, data, cb) {
  const { room, player } = getContext(socket);
  if (!room || !player) return reply(cb, { ok: false, error: 'Você não está em uma sala.' });
  if (room.hostId !== player.id) return reply(cb, { ok: false, error: 'Só o anfitrião pode alterar.' });
  if (room.phase !== 'lobby') return reply(cb, { ok: false, error: 'A partida já começou.' });

  const rounds = Number(data.clueRounds);
  if (![1, 2, 3].includes(rounds)) return reply(cb, { ok: false, error: 'Valor inválido.' });
  room.settings.clueRounds = rounds;
  touch(room);
  emitRoom(room);
  return reply(cb, { ok: true });
}

function confirmRole(socket, cb) {
  const { room, player } = getContext(socket);
  if (!room || !player) return reply(cb, { ok: false, error: 'Você não está em uma sala.' });
  if (room.phase !== 'reveal') return reply(cb, { ok: false, error: 'Agora não é hora de confirmar.' });

  player.confirmed = true;
  if (allConfirmed(room)) startClues(room);
  touch(room);
  emitRoom(room);
  return reply(cb, { ok: true });
}

function forceClues(socket, cb) {
  const { room, player } = getContext(socket);
  if (!room || !player) return reply(cb, { ok: false, error: 'Você não está em uma sala.' });
  if (room.hostId !== player.id) return reply(cb, { ok: false, error: 'Só o anfitrião pode fazer isso.' });
  if (room.phase !== 'reveal') return reply(cb, { ok: false, error: 'Agora não é hora.' });

  for (const p of room.players.values()) p.confirmed = true;
  startClues(room);
  emitRoom(room);
  return reply(cb, { ok: true });
}

function submitClue(socket, data, cb) {
  const { room, player } = getContext(socket);
  if (!room || !player) return reply(cb, { ok: false, error: 'Você não está em uma sala.' });
  if (room.phase !== 'clues') return reply(cb, { ok: false, error: 'Agora não é a fase de dicas.' });
  if (currentPlayerId(room) !== player.id) return reply(cb, { ok: false, error: 'Não é a sua vez.' });

  const spoken = !!data.spoken;
  let text = '';
  if (!spoken) {
    text = cleanClue(data.text);
    if (!text) return reply(cb, { ok: false, error: 'Digite uma palavra ou use "Já falei".' });
    if (/\s/.test(text)) return reply(cb, { ok: false, error: 'Use apenas UMA palavra, sem espaços.' });
  }

  room.game.clues.push({
    round: room.game.round,
    playerId: player.id,
    text,
    spoken,
    skipped: false,
  });
  advanceAfterClue(room);
  touch(room);
  emitRoom(room);
  return reply(cb, { ok: true });
}

function skipTurn(socket, cb) {
  const { room, player } = getContext(socket);
  if (!room || !player) return reply(cb, { ok: false, error: 'Você não está em uma sala.' });
  if (room.hostId !== player.id) return reply(cb, { ok: false, error: 'Só o anfitrião pode pular a vez.' });
  if (room.phase !== 'clues') return reply(cb, { ok: false, error: 'Agora não é a fase de dicas.' });
  const targetId = currentPlayerId(room);
  if (!targetId) return reply(cb, { ok: false, error: 'Não há jogador na vez.' });

  room.game.clues.push({
    round: room.game.round,
    playerId: targetId,
    text: '',
    spoken: false,
    skipped: true,
  });
  advanceAfterClue(room);
  touch(room);
  emitRoom(room);
  return reply(cb, { ok: true });
}

function submitVote(socket, data, cb) {
  const { room, player } = getContext(socket);
  if (!room || !player) return reply(cb, { ok: false, error: 'Você não está em uma sala.' });
  if (room.phase !== 'voting') return reply(cb, { ok: false, error: 'Agora não é a votação.' });
  if (room.game.votes[player.id]) return reply(cb, { ok: false, error: 'Você já votou.' });

  const targetId = String(data.targetId || '');
  if (targetId === player.id) return reply(cb, { ok: false, error: 'Você não pode votar em si mesmo.' });
  if (!room.players.has(targetId)) return reply(cb, { ok: false, error: 'Jogador inválido.' });

  room.game.votes[player.id] = targetId;
  if (allConnectedVoted(room)) resolveVotes(room);
  touch(room);
  emitRoom(room);
  return reply(cb, { ok: true });
}

function forceVote(socket, cb) {
  const { room, player } = getContext(socket);
  if (!room || !player) return reply(cb, { ok: false, error: 'Você não está em uma sala.' });
  if (room.hostId !== player.id) return reply(cb, { ok: false, error: 'Só o anfitrião pode encerrar a votação.' });
  if (room.phase !== 'voting') return reply(cb, { ok: false, error: 'Agora não é a votação.' });
  if (Object.keys(room.game.votes).length === 0) {
    return reply(cb, { ok: false, error: 'Ninguém votou ainda.' });
  }

  resolveVotes(room);
  emitRoom(room);
  return reply(cb, { ok: true });
}

function playAgain(socket, cb) {
  const { room, player } = getContext(socket);
  if (!room || !player) return reply(cb, { ok: false, error: 'Você não está em uma sala.' });
  if (room.hostId !== player.id) return reply(cb, { ok: false, error: 'Só o anfitrião pode iniciar.' });
  if (room.phase !== 'results') return reply(cb, { ok: false, error: 'A partida ainda não terminou.' });

  const players = playerList(room);
  if (players.length < MIN_PLAYERS) {
    return reply(cb, { ok: false, error: `São necessários pelo menos ${MIN_PLAYERS} jogadores.` });
  }
  if (players.some((p) => !p.connected)) {
    return reply(cb, { ok: false, error: 'Todos precisam estar conectados. Voltem ao lobby para ajustar a sala.' });
  }

  startGameInternal(room);
  emitRoom(room);
  return reply(cb, { ok: true });
}

function toLobby(socket, cb) {
  const { room, player } = getContext(socket);
  if (!room || !player) return reply(cb, { ok: false, error: 'Você não está em uma sala.' });
  if (room.hostId !== player.id) return reply(cb, { ok: false, error: 'Só o anfitrião pode voltar ao lobby.' });
  if (room.phase !== 'results') return reply(cb, { ok: false, error: 'A partida ainda não terminou.' });

  backToLobby(room);
  emitRoom(room);
  return reply(cb, { ok: true });
}

function resetScores(socket, cb) {
  const { room, player } = getContext(socket);
  if (!room || !player) return reply(cb, { ok: false, error: 'Você não está em uma sala.' });
  if (room.hostId !== player.id) return reply(cb, { ok: false, error: 'Só o anfitrião pode zerar o placar.' });
  if (room.phase !== 'lobby') return reply(cb, { ok: false, error: 'Volte ao lobby antes.' });

  room.scores = { crew: 0, impostor: 0 };
  touch(room);
  emitRoom(room);
  return reply(cb, { ok: true });
}

function kickPlayer(socket, data, cb) {
  const { room, player } = getContext(socket);
  if (!room || !player) return reply(cb, { ok: false, error: 'Você não está em uma sala.' });
  if (room.hostId !== player.id) return reply(cb, { ok: false, error: 'Só o anfitrião pode remover.' });
  if (room.phase !== 'lobby') return reply(cb, { ok: false, error: 'Só é possível remover no lobby.' });

  const targetId = String(data.targetId || '');
  if (targetId === player.id) return reply(cb, { ok: false, error: 'Você não pode se remover.' });
  const target = room.players.get(targetId);
  if (!target) return reply(cb, { ok: false, error: 'Jogador não encontrado.' });

  const targetSocketId = target.socketId;
  room.players.delete(targetId);
  if (targetSocketId) {
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      removeAudioPeer(targetSocket, room, true);
      targetSocket.emit('kicked');
      targetSocket.leave(room.code);
      targetSocket.data.roomCode = null;
      targetSocket.data.playerId = null;
    }
  }
  touch(room);
  emitRoom(room);
  return reply(cb, { ok: true });
}

function leaveRoom(socket, cb) {
  const { room } = getContext(socket);
  const remove = room ? room.phase === 'lobby' || room.phase === 'results' : false;
  detachSocket(socket, remove);
  return reply(cb, { ok: true });
}

function getContext(socket) {
  const code = socket.data.roomCode;
  const playerId = socket.data.playerId;
  if (!code || !playerId) return { room: null, player: null };
  const room = rooms.get(code);
  if (!room) return { room: null, player: null };
  const player = room.players.get(playerId);
  if (!player || player.socketId !== socket.id) return { room: null, player: null };
  return { room, player };
}

// ---------- audio (WebRTC signaling) ----------

function audioJoin(socket, data, cb) {
  const { room, player } = getContext(socket);
  if (!room || !player) return reply(cb, { ok: false, error: 'Você não está em uma sala.' });
  if (!room.audioPeers) room.audioPeers = new Map();

  for (const [socketId, peer] of room.audioPeers) {
    if (peer.playerId === player.id && socketId !== socket.id) {
      room.audioPeers.delete(socketId);
      io.to(room.code).emit('audioPeerLeft', { socketId, playerId: peer.playerId });
    }
  }

  const existing = audioPeerList(room).filter((peer) => peer.socketId !== socket.id);
  const self = {
    socketId: socket.id,
    playerId: player.id,
    name: player.name,
    muted: !!data.muted,
  };
  const already = room.audioPeers.has(socket.id);
  room.audioPeers.set(socket.id, self);
  socket.to(room.code).emit(already ? 'audioPeerUpdated' : 'audioPeerJoined', { peer: self });
  touch(room);
  return reply(cb, { ok: true, selfId: socket.id, peers: existing });
}

function audioLeave(socket, _data, cb) {
  const { room } = getContext(socket);
  if (room) removeAudioPeer(socket, room, true);
  return reply(cb, { ok: true });
}

function audioMute(socket, data, cb) {
  const { room } = getContext(socket);
  if (!room) return reply(cb, { ok: false, error: 'Você não está em uma sala.' });
  const peer = room.audioPeers?.get(socket.id);
  if (!peer) return reply(cb, { ok: false, error: 'Você não está no áudio.' });
  peer.muted = !!data.muted;
  socket.to(room.code).emit('audioPeerUpdated', { peer });
  return reply(cb, { ok: true });
}

function audioSignal(socket, data, cb) {
  const { room } = getContext(socket);
  if (!room?.audioPeers?.has(socket.id)) {
    return reply(cb, { ok: false, error: 'Você não está no áudio.' });
  }
  const to = String(data.to || '');
  const target = room.audioPeers.get(to);
  if (!target || to === socket.id) {
    return reply(cb, { ok: false, error: 'Jogador não está no áudio.' });
  }
  const payload = data.data;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return reply(cb, { ok: false, error: 'Sinal inválido.' });
  }
  if (!['offer', 'answer', 'candidate'].includes(payload.type)) {
    return reply(cb, { ok: false, error: 'Sinal inválido.' });
  }
  let size = 0;
  try { size = JSON.stringify(payload).length; } catch { size = 0; }
  if (size > 60_000) return reply(cb, { ok: false, error: 'Sinal muito grande.' });

  const sender = room.audioPeers.get(socket.id);
  io.to(to).emit('audioSignal', {
    from: socket.id,
    fromName: sender.name,
    data: payload,
  });
  return reply(cb, { ok: true });
}

// ---------- socket wiring ----------

io.on('connection', (socket) => {
  const handle = (event, fn) => {
    socket.on(event, (data, cb) => {
      try {
        fn(data && typeof data === 'object' ? data : {}, cb);
      } catch (err) {
        console.error(`[${event}]`, err);
        reply(cb, { ok: false, error: 'Erro inesperado no servidor.' });
      }
    });
  };

  handle('createRoom', (data, cb) => createRoom(socket, data, cb));
  handle('joinRoom', (data, cb) => joinRoom(socket, data, cb));
  handle('startGame', (_data, cb) => startGame(socket, cb));
  handle('updateSettings', (data, cb) => updateSettings(socket, data, cb));
  handle('confirmRole', (_data, cb) => confirmRole(socket, cb));
  handle('forceClues', (_data, cb) => forceClues(socket, cb));
  handle('submitClue', (data, cb) => submitClue(socket, data, cb));
  handle('skipTurn', (_data, cb) => skipTurn(socket, cb));
  handle('submitVote', (data, cb) => submitVote(socket, data, cb));
  handle('forceVote', (_data, cb) => forceVote(socket, cb));
  handle('playAgain', (_data, cb) => playAgain(socket, cb));
  handle('toLobby', (_data, cb) => toLobby(socket, cb));
  handle('resetScores', (_data, cb) => resetScores(socket, cb));
  handle('kickPlayer', (data, cb) => kickPlayer(socket, data, cb));
  handle('leaveRoom', (_data, cb) => leaveRoom(socket, cb));
  handle('audioJoin', (data, cb) => audioJoin(socket, data, cb));
  handle('audioLeave', (data, cb) => audioLeave(socket, data, cb));
  handle('audioMute', (data, cb) => audioMute(socket, data, cb));
  handle('audioSignal', (data, cb) => audioSignal(socket, data, cb));

  socket.on('disconnect', () => detachSocket(socket, false));
});

// limpeza de salas abandonadas
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const hasConnected = playerList(room).some((p) => p.connected);
    if (!hasConnected && now - room.lastActivity > ROOM_TTL) rooms.delete(code);
  }
}, 10 * 60 * 1000);

function lanUrls(port) {
  const urls = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) urls.push(`http://${net.address}:${port}`);
    }
  }
  return urls;
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  Jogo do Impostor no ar!');
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const url of lanUrls(PORT)) console.log(`  Rede:    ${url}`);
  console.log('');
  initDb();
});
