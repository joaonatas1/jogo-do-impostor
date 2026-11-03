'use strict';

const assert = require('assert');
const { io } = require('socket.io-client');

const URL = process.env.URL || 'http://localhost:3100';
const NAMES = ['Ana', 'Bia', 'Caio', 'Davi'];
const IDS = NAMES.map((_, i) => `test-player-${i}-abcdef`);
const clients = [];
const states = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connectClient() {
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
    const value = predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Timeout aguardando: ${label}`);
}

async function main() {
  for (let i = 0; i < NAMES.length; i += 1) {
    const socket = await connectClient();
    clients.push(socket);
    socket.on('state', (next) => { states[i] = next; });
  }

  const created = await request(0, 'createRoom', { name: NAMES[0], playerId: IDS[0] });
  assert.equal(created.ok, true, created.error);
  const code = created.code;

  for (let i = 1; i < NAMES.length; i += 1) {
    const joined = await request(i, 'joinRoom', { code, name: NAMES[i], playerId: IDS[i] });
    assert.equal(joined.ok, true, joined.error);
  }

  await waitFor('lobby com 4 jogadores', () => states[0]?.players.length === 4);
  console.log('✓ Sala criada e 4 jogadores entraram');

  const settings = await request(0, 'updateSettings', { clueRounds: 2 });
  assert.equal(settings.ok, true, settings.error);

  const started = await request(0, 'startGame');
  assert.equal(started.ok, true, started.error);
  await waitFor('fase reveal', () => states.every((s) => s?.phase === 'reveal'));
  console.log('✓ Partida iniciada e papéis distribuídos');

  const impostorIndex = states.findIndex((s) => s.me.role === 'impostor');
  assert.notEqual(impostorIndex, -1, 'Deveria existir um impostor');
  assert.equal(states.filter((s) => s.me.role === 'impostor').length, 1);

  const crewWords = states.filter((s) => s.me.role === 'crew').map((s) => s.me.word);
  assert.ok(crewWords.every((word) => word === crewWords[0]), 'Todos da equipe devem ver a mesma palavra');
  assert.ok(states[impostorIndex].me.word === null, 'Impostor não deve receber a palavra');
  assert.ok(states[impostorIndex].me.hint, 'Impostor deve receber uma dica');
  console.log(`✓ Impostor: ${NAMES[impostorIndex]} | palavra da equipe: ${crewWords[0]}`);

  for (let i = 0; i < NAMES.length; i += 1) {
    const res = await request(i, 'confirmRole');
    assert.equal(res.ok, true, res.error);
  }
  await waitFor('fase de dicas', () => states.every((s) => s?.phase === 'clues'));

  for (let clueIndex = 0; clueIndex < 8; clueIndex += 1) {
    const currentId = await waitFor('jogador da vez', () => states[0]?.game?.currentPlayerId);
    const currentIndex = states.findIndex((s) => s.me.id === currentId);
    assert.notEqual(currentIndex, -1);
    const spoken = clueIndex === 3;
    const res = await request(currentIndex, 'submitClue', spoken ? { spoken: true } : { text: `dica${clueIndex + 1}` });
    assert.equal(res.ok, true, res.error);
    await sleep(35);
  }

  await waitFor('fase de votação', () => states.every((s) => s?.phase === 'voting'));
  console.log('✓ Duas voltas de dicas concluídas');

  for (let i = 0; i < NAMES.length; i += 1) {
    const targetIndex = i === impostorIndex ? (impostorIndex + 1) % NAMES.length : impostorIndex;
    const res = await request(i, 'submitVote', { targetId: IDS[targetIndex] });
    assert.equal(res.ok, true, res.error);
  }

  await waitFor('resultado', () => states.every((s) => s?.phase === 'results'));
  assert.equal(states[0].game.results.winner, 'crew');
  assert.equal(states[0].scores.crew, 1);
  assert.equal(states[0].game.results.impostorId, IDS[impostorIndex]);
  console.log('✓ Votação apontou o impostor e a equipe venceu');

  const back = await request(0, 'toLobby');
  assert.equal(back.ok, true, back.error);
  await waitFor('volta ao lobby', () => states.every((s) => s?.phase === 'lobby'));

  const settings2 = await request(0, 'updateSettings', { clueRounds: 1 });
  assert.equal(settings2.ok, true, settings2.error);

  const started2 = await request(0, 'startGame');
  assert.equal(started2.ok, true, started2.error);
  await waitFor('segunda partida', () => states.every((s) => s?.phase === 'reveal'));
  for (let i = 0; i < NAMES.length; i += 1) {
    const res = await request(i, 'confirmRole');
    assert.equal(res.ok, true, res.error);
  }
  await waitFor('dicas da segunda partida', () => states.every((s) => s?.phase === 'clues'));

  const impostor2 = states.findIndex((s) => s.me.role === 'impostor');
  for (let i = 0; i < 4; i += 1) {
    const currentId = await waitFor('jogador da segunda partida', () => states[0]?.game?.currentPlayerId);
    const currentIndex = states.findIndex((s) => s.me.id === currentId);
    const res = await request(currentIndex, 'submitClue', { text: `x${i}` });
    assert.equal(res.ok, true, res.error);
    await sleep(35);
  }
  await waitFor('votação da segunda partida', () => states.every((s) => s?.phase === 'voting'));

  const nonImpostors = [0, 1, 2, 3].filter((i) => i !== impostor2);
  const targetA = nonImpostors[0];
  const targetB = nonImpostors[1];
  const neutralVoters = [0, 1, 2, 3].filter((i) => i !== targetA && i !== targetB);
  const votePlan = {};
  votePlan[targetA] = targetB;
  votePlan[targetB] = targetA;
  votePlan[neutralVoters[0]] = targetA;
  votePlan[neutralVoters[1]] = targetB;
  for (let i = 0; i < NAMES.length; i += 1) {
    const res = await request(i, 'submitVote', { targetId: IDS[votePlan[i]] });
    assert.equal(res.ok, true, res.error);
  }

  await waitFor('resultado da segunda partida', () => states.every((s) => s?.phase === 'results'));
  assert.equal(states[0].game.results.leaders.length, 2, 'Deveria haver empate');
  assert.equal(states[0].game.results.winner, 'impostor');
  assert.equal(states[0].scores.impostor, 1);
  console.log('✓ Empate na votação deu a vitória ao impostor');

  console.log('\nTodos os testes passaram.');
}

main()
  .catch((err) => {
    console.error('\nFALHOU:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sleep(100);
    for (const socket of clients) socket.close();
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  });
