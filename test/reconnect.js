'use strict';

const assert = require('assert');
const { io } = require('socket.io-client');

const URL = process.env.URL || 'http://localhost:3102';
const NAMES = ['Ana', 'Bia', 'Caio'];
const IDS = NAMES.map((_, i) => `reconnect-player-${i}-abcdef`);
const clients = [];
const states = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function request(index, event, payload = {}) {
  return new Promise((resolve) => {
    clients[index].timeout(5000).emit(event, payload, (err, res) => {
      if (err) resolve({ ok: false, error: String(err) });
      else resolve(res);
    });
  });
}

async function waitFor(label, predicate, timeout = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await sleep(30);
  }
  throw new Error(`Timeout aguardando: ${label}`);
}

async function main() {
  for (let i = 0; i < NAMES.length; i += 1) {
    clients[i] = await connect();
    clients[i].on('state', (next) => { states[i] = next; });
  }

  const created = await request(0, 'createRoom', { name: NAMES[0], playerId: IDS[0] });
  assert.equal(created.ok, true, created.error);
  const code = created.code;

  for (let i = 1; i < NAMES.length; i += 1) {
    const res = await request(i, 'joinRoom', { code, name: NAMES[i], playerId: IDS[i] });
    assert.equal(res.ok, true, res.error);
  }
  await waitFor('lobby', () => states[0]?.players.length === 3);

  clients[2].close();
  await waitFor('jogador marcado offline', () => states[0]?.players.some((p) => p.id === IDS[2] && !p.connected));

  const blocked = await request(0, 'startGame');
  assert.equal(blocked.ok, false, 'Não deveria iniciar com jogador offline');
  console.log('✓ Início bloqueado com jogador desconectado');

  const reconnected = await connect();
  clients[2] = reconnected;
  reconnected.on('state', (next) => { states[2] = next; });
  const rejoin = await new Promise((resolve) => {
    reconnected.timeout(5000).emit('joinRoom', { code, name: NAMES[2], playerId: IDS[2] }, (err, res) => resolve(err ? { ok: false, error: String(err) } : res));
  });
  assert.equal(rejoin.ok, true, rejoin.error);
  await waitFor('jogador online', () => states[0]?.players.some((p) => p.id === IDS[2] && p.connected));
  console.log('✓ Jogador reconectou e voltou à sala');

  const started = await request(0, 'startGame');
  assert.equal(started.ok, true, started.error);
  await waitFor('reveal', () => states.every((s) => s?.phase === 'reveal'));
  for (let i = 0; i < 3; i += 1) {
    const res = await request(i, 'confirmRole');
    assert.equal(res.ok, true, res.error);
  }
  await waitFor('clues', () => states.every((s) => s?.phase === 'clues'));
  console.log('✓ Partida começou após a reconexão');

  clients[1].close();
  await waitFor('Bia offline', () => states[0]?.players.some((p) => p.id === IDS[1] && !p.connected));

  const extra = await connect();
  const extraResult = await new Promise((resolve) => {
    extra.timeout(5000).emit('joinRoom', { code, name: 'Extra', playerId: 'extra-player-999-abcdef' }, (err, res) => resolve(err ? { ok: false, error: String(err) } : res));
  });
  assert.equal(extraResult.ok, false, 'Novo jogador não deveria entrar em partida em andamento');
  extra.close();
  console.log('✓ Entrada de novo jogador bloqueada durante a partida');

  const biaAgain = await connect();
  clients[1] = biaAgain;
  biaAgain.on('state', (next) => { states[1] = next; });
  const biaRejoin = await new Promise((resolve) => {
    biaAgain.timeout(5000).emit('joinRoom', { code, name: NAMES[1], playerId: IDS[1] }, (err, res) => resolve(err ? { ok: false, error: String(err) } : res));
  });
  assert.equal(biaRejoin.ok, true, biaRejoin.error);
  await waitFor('Bia online', () => states[0]?.players.some((p) => p.id === IDS[1] && p.connected));
  console.log('✓ Jogador reconectou no meio da partida');

  console.log('\nTestes de reconexão passaram.');
}

main()
  .catch((err) => {
    console.error('\nFALHOU:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sleep(100);
    for (const socket of clients) socket?.close();
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  });
