'use strict';

const assert = require('assert');
const { io } = require('socket.io-client');

const URL = process.env.URL || 'http://localhost:3102';
const NAMES = ['Ana', 'Bia', 'Caio', 'Davi'];
const IDS = NAMES.map((_, i) => `audio-player-${i}-abcdef`);
const clients = [];
const states = [];
const events = NAMES.map(() => []);
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
    const value = predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Timeout aguardando: ${label}`);
}

function eventsOf(index, name) {
  return events[index].filter((event) => event.name === name).map((event) => event.data);
}

async function main() {
  for (let i = 0; i < NAMES.length; i += 1) {
    const socket = await connect();
    clients.push(socket);
    socket.on('state', (next) => { states[i] = next; });
    for (const event of ['audioPeerJoined', 'audioPeerLeft', 'audioPeerUpdated', 'audioSignal']) {
      socket.on(event, (data) => events[i].push({ name: event, data }));
    }
  }

  const created = await request(0, 'createRoom', { name: NAMES[0], playerId: IDS[0] });
  assert.equal(created.ok, true, created.error);
  const code = created.code;

  for (let i = 1; i < NAMES.length; i += 1) {
    const joined = await request(i, 'joinRoom', { code, name: NAMES[i], playerId: IDS[i] });
    assert.equal(joined.ok, true, joined.error);
  }
  await waitFor('lobby com 4 jogadores', () => states[0]?.players.length === 4);
  console.log('✓ Sala com 4 jogadores criada');

  // Ana entra sozinha no áudio.
  const anaJoin = await request(0, 'audioJoin', { muted: false });
  assert.equal(anaJoin.ok, true, anaJoin.error);
  assert.equal(anaJoin.peers.length, 0);
  assert.equal(anaJoin.selfId, clients[0].id);

  // Bia entra e recebe Ana na lista; Ana é avisada da entrada.
  const biaJoin = await request(1, 'audioJoin', { muted: true });
  assert.equal(biaJoin.ok, true, biaJoin.error);
  assert.equal(biaJoin.peers.length, 1);
  assert.equal(biaJoin.peers[0].playerId, IDS[0]);
  const anaSeesBia = await waitFor('Ana vê Bia no áudio', () =>
    eventsOf(0, 'audioPeerJoined').find((event) => event.peer?.socketId === clients[1].id)
  );
  assert.equal(anaSeesBia.peer.name, NAMES[1]);
  assert.equal(anaSeesBia.peer.muted, true);
  console.log('✓ Entrada no áudio lista os participantes e notifica os outros');

  // Caio entra e recebe os dois anteriores.
  const caioJoin = await request(2, 'audioJoin', { muted: false });
  assert.equal(caioJoin.ok, true, caioJoin.error);
  assert.equal(caioJoin.peers.length, 2);
  assert.deepEqual(
    caioJoin.peers.map((peer) => peer.playerId).sort(),
    [IDS[0], IDS[1]].sort()
  );
  await waitFor('Ana vê Caio no áudio', () =>
    eventsOf(0, 'audioPeerJoined').some((event) => event.peer?.socketId === clients[2].id)
  );
  console.log('✓ Quem entra depois recebe a lista de quem já está no áudio');

  // Mute propaga para os outros participantes.
  const mute = await request(1, 'audioMute', { muted: false });
  assert.equal(mute.ok, true, mute.error);
  await waitFor('Ana vê Bia sem mudo', () =>
    eventsOf(0, 'audioPeerUpdated').some(
      (event) => event.peer?.socketId === clients[1].id && event.peer.muted === false
    )
  );
  console.log('✓ Estado de microfone é sincronizado');

  // Sinalização offer/answer/candidate é entregue ao destinatário.
  const offer = { type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' } };
  const offerRes = await request(0, 'audioSignal', { to: clients[1].id, data: offer });
  assert.equal(offerRes.ok, true, offerRes.error);
  const deliveredOffer = await waitFor('Bia recebe offer', () =>
    eventsOf(1, 'audioSignal').find((event) => event.from === clients[0].id && event.data?.type === 'offer')
  );
  assert.equal(deliveredOffer.data.sdp.type, 'offer');

  const answer = { type: 'answer', sdp: { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n' } };
  const answerRes = await request(1, 'audioSignal', { to: clients[0].id, data: answer });
  assert.equal(answerRes.ok, true, answerRes.error);
  await waitFor('Ana recebe answer', () =>
    eventsOf(0, 'audioSignal').some((event) => event.from === clients[1].id && event.data?.type === 'answer')
  );

  const candidate = { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0' } };
  const candidateRes = await request(0, 'audioSignal', { to: clients[1].id, data: candidate });
  assert.equal(candidateRes.ok, true, candidateRes.error);
  await waitFor('Bia recebe candidate', () =>
    eventsOf(1, 'audioSignal').some((event) => event.from === clients[0].id && event.data?.type === 'candidate')
  );
  console.log('✓ Offer, answer e candidate são retransmitidos');

  // Sinais inválidos e destinatários fora do áudio são recusados.
  const badType = await request(0, 'audioSignal', { to: clients[1].id, data: { type: 'bogus' } });
  assert.equal(badType.ok, false);
  const toSelf = await request(0, 'audioSignal', { to: clients[0].id, data: offer });
  assert.equal(toSelf.ok, false);
  const toOutsider = await request(0, 'audioSignal', { to: clients[3].id, data: offer });
  assert.equal(toOutsider.ok, false);
  const outsiderMute = await request(3, 'audioMute', { muted: true });
  assert.equal(outsiderMute.ok, false);
  console.log('✓ Sinais inválidos e jogadores fora do áudio são bloqueados');

  // Sair do áudio notifica os demais e encerra o relay.
  const caioLeave = await request(2, 'audioLeave');
  assert.equal(caioLeave.ok, true, caioLeave.error);
  await waitFor('Ana vê Caio sair do áudio', () =>
    eventsOf(0, 'audioPeerLeft').some((event) => event.socketId === clients[2].id)
  );
  const signalAfterLeave = await request(0, 'audioSignal', { to: clients[2].id, data: offer });
  assert.equal(signalAfterLeave.ok, false);
  console.log('✓ Sair do áudio remove o participante e fecha a sinalização');

  // Desconexão abrupta também limpa o participante.
  const biaSocketId = clients[1].id;
  clients[1].close();
  await waitFor('Ana vê Bia desconectar do áudio', () =>
    eventsOf(0, 'audioPeerLeft').some((event) => event.socketId === biaSocketId)
  );
  console.log('✓ Desconexão do socket limpa o participante do áudio');

  // Endpoint de credenciais funciona sem TURN configurado (STUN only).
  const healthRes = await fetch(`${URL}/health`);
  const health = await healthRes.json();
  assert.equal(health.ok, true);
  assert.ok(['off', 'configured'].includes(health.turn), 'Health deve informar o estado do TURN');

  const iceRes = await fetch(`${URL}/api/turn-credentials`);
  const ice = await iceRes.json();
  assert.equal(ice.ok, true);
  assert.ok(Array.isArray(ice.iceServers) && ice.iceServers.length > 0, 'Deve retornar servidores ICE');
  if (health.turn === 'off') {
    assert.equal(ice.turn, false);
    assert.ok(
      ice.iceServers.every((server) =>
        (Array.isArray(server.urls) ? server.urls : [server.urls]).every((url) => String(url).startsWith('stun:'))
      ),
      'Sem TURN configurado, apenas STUN deve ser retornado'
    );
  }
  console.log(`✓ /health e /api/turn-credentials respondem (turn: ${health.turn})`);

  console.log('\nTodos os testes de áudio passaram.');
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
