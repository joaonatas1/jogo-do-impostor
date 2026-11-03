(() => {
  'use strict';

  const socket = io();
  const $ = (id) => document.getElementById(id);
  const MAX_PLAYERS = 12;
  const ID_KEY = 'impostor.playerId';
  const SESSION_KEY = 'impostor.session';
  const NAME_KEY = 'impostor.name';

  const screens = {
    home: $('screen-home'),
    lobby: $('screen-lobby'),
    reveal: $('screen-reveal'),
    clues: $('screen-game'),
    voting: $('screen-voting'),
    results: $('screen-results'),
  };

  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
  };

  function makePlayerId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  let playerId = storage.get(ID_KEY);
  if (!playerId) {
    playerId = makePlayerId();
    storage.set(ID_KEY, playerId);
  }

  let session = readSession();
  let state = null;
  let currentScreen = null;
  let rejoining = false;
  let selectedVote = null;
  let revealOpen = false;
  let revealGameId = null;
  let voteGameId = null;
  let lastClueCount = 0;
  let toastTimer = null;
  let connectionErrorShown = false;
  const locks = new Set();

  function readSession() {
    try {
      const raw = storage.get(SESSION_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && parsed.code && parsed.name) return parsed;
    } catch { /* ignore */ }
    return null;
  }

  function saveSession(next) {
    session = next;
    storage.set(SESSION_KEY, JSON.stringify(next));
    if (next?.name) storage.set(NAME_KEY, next.name);
  }

  function clearSession() {
    session = null;
    storage.remove(SESSION_KEY);
  }

  function request(event, payload = {}) {
    return new Promise((resolve) => {
      if (!socket.connected) {
        resolve({ ok: false, error: 'Sem conexão com o servidor.' });
        return;
      }
      socket.timeout(10000).emit(event, payload, (err, response) => {
        if (err) resolve({ ok: false, error: 'O servidor demorou para responder. Tente novamente.' });
        else resolve(response && typeof response === 'object' ? response : { ok: false, error: 'Resposta inválida.' });
      });
    });
  }

  async function once(key, fn) {
    if (locks.has(key)) return undefined;
    locks.add(key);
    try { return await fn(); } finally { locks.delete(key); }
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function hashHue(value) {
    let hash = 0;
    for (const char of String(value)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    return hash % 360;
  }

  function avatarHtml(player, extraClass = '') {
    const name = player?.name || '?';
    const initial = [...String(name).trim()][0] || '?';
    const hue = hashHue(player?.id || name);
    return `<span class="avatar ${extraClass}" style="--hue:${hue}" aria-hidden="true">${esc(initial.toUpperCase())}</span>`;
  }

  function toast(message, kind = '') {
    const el = $('toast');
    el.textContent = message;
    el.className = `toast show${kind === 'error' ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 3400);
  }

  function setOnline(online) {
    $('connection-banner').hidden = online;
    document.body.classList.toggle('is-offline', !online);
  }

  function showBoot(text = 'Entrando na sala…') {
    $('boot-text').textContent = text;
    $('boot').hidden = false;
  }

  function hideBoot() {
    $('boot').hidden = true;
  }

  function showScreen(name) {
    if (currentScreen === name) return;
    for (const [key, el] of Object.entries(screens)) el.classList.toggle('active', key === name);
    currentScreen = name;
    window.scrollTo(0, 0);
  }

  function showHome() {
    state = null;
    showScreen('home');
  }

  function closeModal(modal) {
    if (modal) modal.hidden = true;
  }

  function closeAllModals() {
    document.querySelectorAll('.modal:not([hidden])').forEach(closeModal);
  }

  function openModal(modal) {
    if (!modal) return;
    modal.hidden = false;
    const focusable = modal.querySelector('.modal-close');
    focusable?.focus();
  }

  function openRoleModal() {
    if (!state?.me) return;
    $('modal-role-content').innerHTML = rolePreviewHtml(state.me);
    openModal($('modal-role'));
  }

  function rolePreviewHtml(me) {
    if (!me?.role) return '<p class="muted center">Seu papel aparece quando a partida começar.</p>';
    if (me.role === 'impostor') {
      return `<div class="role-preview is-impostor">
        <span class="eyebrow">Seu papel</span>
        <h2 class="secret-word">Impostor</h2>
        <span class="chip">${esc(me.category || '')}</span>
        <p class="impostor-hint">${esc(me.hint || '')}</p>
        <p class="role-note">Blefe. Você não sabe a palavra secreta.</p>
      </div>`;
    }
    return `<div class="role-preview">
      <span class="eyebrow">Sua palavra secreta</span>
      <h2 class="secret-word">${esc(me.word || '')}</h2>
      <span class="chip">${esc(me.category || '')}</span>
      <p class="role-note">Dê dicas sem entregar a palavra de bandeja.</p>
    </div>`;
  }

  // ---------- rendering ----------

  function render(previous) {
    if (!state) {
      showScreen('home');
      return;
    }

    const gameChanged = !previous || (previous.game?.id || null) !== (state.game?.id || null);
    if (gameChanged) {
      $('clue-input').value = '';
      selectedVote = null;
      revealOpen = false;
      revealGameId = null;
      voteGameId = null;
      lastClueCount = 0;
      hideClueError();
    }

    switch (state.phase) {
      case 'lobby':
        showScreen('lobby');
        renderLobby();
        break;
      case 'reveal':
        showScreen('reveal');
        renderReveal(gameChanged);
        break;
      case 'clues':
        showScreen('clues');
        renderGame(previous);
        break;
      case 'voting':
        showScreen('voting');
        renderVoting();
        break;
      case 'results':
        showScreen('results');
        renderResults();
        break;
      default:
        showHome();
    }
  }

  function renderLobby() {
    const s = state;
    $('room-code-value').textContent = s.code;
    $('player-count').textContent = `${s.players.length}/${MAX_PLAYERS}`;
    $('lobby-empty').hidden = s.players.length > 1;

    $('lobby-players').innerHTML = s.players.map((p) => {
      const isHost = p.id === s.hostId;
      const isMe = p.id === s.me.id;
      const tags = [];
      if (isHost) tags.push('<span class="badge">anfitrião</span>');
      if (isMe) tags.push('<span class="player-status">você</span>');
      if (!p.connected) tags.push('<span class="player-status offline">desconectado</span>');
      const kick = s.me.isHost && !isMe
        ? `<button class="kick-btn" type="button" data-kick="${esc(p.id)}">remover</button>`
        : '';
      return `<li class="player-row${p.connected ? '' : ' is-offline'}">
        ${avatarHtml(p)}
        <div class="player-meta">
          <strong>${esc(p.name)}</strong>
          <div class="player-tags">${tags.join('')}</div>
        </div>
        ${kick}
      </li>`;
    }).join('');

    $('host-settings').hidden = !s.me.isHost;
    $('waiting-panel').hidden = s.me.isHost;

    const host = s.players.find((p) => p.id === s.hostId);
    $('waiting-host-text').textContent = `Aguardando ${host?.name || 'o anfitrião'} iniciar a partida…`;

    document.querySelectorAll('#rounds-options button').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.rounds) === s.settings.clueRounds);
    });

    const anyOffline = s.players.some((p) => !p.connected);
    const canStart = s.me.isHost && s.players.length >= 3 && !anyOffline;
    $('btn-start').disabled = !canStart;
    if (s.players.length < 3) $('start-hint').textContent = 'Mínimo de 3 jogadores.';
    else if (anyOffline) $('start-hint').textContent = 'Todos precisam estar online.';
    else $('start-hint').textContent = 'Tudo pronto para começar.';

    const totalScore = s.scores.crew + s.scores.impostor;
    $('lobby-score').hidden = totalScore === 0;
    $('score-crew').textContent = s.scores.crew;
    $('score-impostor').textContent = s.scores.impostor;
    $('btn-reset-score').hidden = !(s.me.isHost && totalScore > 0);
  }

  function roleBackHtml(me) {
    if (me.role === 'impostor') {
      return `<span class="impostor-mark">Impostor</span>
        <h2>Você é o impostor</h2>
        <p class="role-note">Não sabe a palavra secreta. Use a dica abaixo e blefe com convicção.</p>
        <span class="chip">${esc(me.category || 'Categoria')}</span>
        <p class="impostor-hint">${esc(me.hint || 'Dica genérica indisponível.')}</p>`;
    }
    return `<span class="chip">Palavra secreta</span>
      <h2 class="secret-word">${esc(me.word || '?')}</h2>
      <span class="chip">${esc(me.category || 'Categoria')}</span>
      <p class="role-note">Dê dicas que combinem com a palavra, sem entregá-la de bandeja.</p>`;
  }

  function renderReveal(gameChanged) {
    const s = state;
    const me = s.me;
    const gameId = s.game?.id;

    if (gameChanged || revealGameId !== gameId) {
      revealGameId = gameId;
      revealOpen = !!me.confirmed;
      const card = $('role-card');
      card.classList.toggle('revealed', revealOpen);
      card.tabIndex = me.confirmed ? -1 : 0;
      const back = $('role-back');
      back.className = `role-face role-back${me.role === 'impostor' ? ' role-back--impostor' : ''}`;
      back.innerHTML = roleBackHtml(me);
    }

    const confirmed = !!me.confirmed;
    const ready = s.players.filter((p) => p.confirmed).length;
    const total = s.players.length;
    $('reveal-ready').textContent = `${ready} de ${total} prontos`;
    $('btn-confirm-role').disabled = !revealOpen || confirmed || !me.role;
    $('btn-confirm-role').textContent = confirmed ? 'Aguardando os outros…' : 'Entendi, estou pronto';
    $('btn-force-clues').hidden = !(me.isHost && ready < total);
  }

  function renderGame(previous) {
    const s = state;
    const g = s.game;
    const me = s.me;
    if (!g) return;

    $('game-round').textContent = `Volta ${g.round} de ${g.totalRounds}`;

    const personal = $('game-personal');
    personal.className = `personal-card${me.role === 'impostor' ? ' is-impostor' : ''}`;
    personal.innerHTML = me.role === 'impostor'
      ? `<div><span class="eyebrow">Seu papel</span><strong>IMPOSTOR</strong></div>
         <span class="chip">${esc(me.category || '')}</span>
         <p class="personal-hint">${esc(me.hint || '')}</p>`
      : `<div><span class="eyebrow">Sua palavra</span><strong>${esc(me.word || '')}</strong></div>
         <span class="chip">${esc(me.category || '')}</span>`;

    const current = s.players.find((p) => p.id === g.currentPlayerId);
    const myTurn = g.currentPlayerId === me.id;
    const banner = $('turn-banner');
    banner.className = `turn-banner${myTurn ? ' is-mine' : ''}`;
    if (myTurn) {
      banner.innerHTML = `<span class="turn-pulse"></span>
        <div><p class="eyebrow">Sua vez</p><h2>Diga uma palavra</h2>
        <p>Una palavra relacionada ao seu papel. Sem entregar demais.</p></div>`;
    } else if (current) {
      banner.innerHTML = `<div class="turn-avatar">${avatarHtml(current)}</div>
        <div><p class="eyebrow">Vez de</p><h2>${esc(current.name)}</h2>
        <p>${current.connected ? 'Aguarde sua vez de dar a dica.' : 'Este jogador está desconectado.'}</p></div>`;
    } else {
      banner.innerHTML = `<div><p class="eyebrow">Aguarde</p><h2>Preparando a volta…</h2></div>`;
    }

    const groups = {};
    for (const clue of g.clues) {
      if (!groups[clue.round]) groups[clue.round] = [];
      groups[clue.round].push(clue);
    }
    let logHtml = '';
    for (let round = 1; round <= g.round; round += 1) {
      const clues = groups[round] || [];
      if (!clues.length && round !== g.round) continue;
      logHtml += `<div class="clue-round-title">Volta ${round}</div>`;
      if (!clues.length) {
        logHtml += '<p class="clue-empty">Ninguém deu dica nesta volta ainda.</p>';
      }
      for (const clue of clues) {
        const player = s.players.find((p) => p.id === clue.playerId) || { name: 'Jogador', id: clue.playerId };
        const value = clue.skipped ? 'passou a vez' : clue.spoken ? 'falou no áudio' : clue.text;
        const spokenClass = clue.skipped || clue.spoken ? ' is-spoken' : '';
        logHtml += `<div class="clue-entry">
          ${avatarHtml(player)}
          <span class="clue-entry-name">${esc(player.name)}</span>
          <strong class="clue-entry-word${spokenClass}">${esc(value)}</strong>
        </div>`;
      }
    }
    if (!g.clues.length) logHtml = '<p class="clue-empty">A primeira dica está chegando…</p>';
    $('clue-log').innerHTML = logHtml;

    const roundClues = g.clues.filter((c) => c.round === g.round).length;
    $('clue-count').textContent = `${roundClues}/${g.turnOrder.length}`;

    const form = $('clue-form');
    const spokenBtn = $('btn-spoken-clue');
    form.hidden = !myTurn;
    spokenBtn.hidden = !myTurn;

    const waiting = $('game-waiting');
    if (!myTurn && current) {
      waiting.hidden = false;
      waiting.innerHTML = current.connected
        ? `Aguardando <strong>${esc(current.name)}</strong> dar a dica…`
        : `<strong>${esc(current.name)}</strong> está desconectado. O anfitrião pode pular a vez.`;
    } else {
      waiting.hidden = true;
      waiting.innerHTML = '';
    }

    const skip = $('btn-skip-turn');
    skip.hidden = !me.isHost || !current || current.id === me.id;
    if (current) skip.textContent = `Pular a vez de ${current.name} (anfitrião)`;
    if (!myTurn) hideClueError();

    if (g.clues.length !== lastClueCount) {
      const log = $('clue-log');
      log.scrollTop = log.scrollHeight;
      lastClueCount = g.clues.length;
    }

    if (myTurn && (!previous || previous.phase !== 'clues' || previous.game?.currentPlayerId !== g.currentPlayerId)) {
      setTimeout(() => $('clue-input')?.focus(), 80);
    }
  }

  function renderVoting() {
    const s = state;
    const g = s.game;
    const me = s.me;

    if (voteGameId !== g.id) {
      voteGameId = g.id;
      selectedVote = me.vote || null;
    }
    if (me.vote) selectedVote = me.vote;

    const hasVoted = !!me.vote;
    const others = s.players.filter((p) => p.id !== me.id);
    $('vote-grid').innerHTML = others.map((p) => {
      const selected = selectedVote === p.id;
      return `<button class="vote-option${selected ? ' selected' : ''}" type="button"
        data-vote-id="${esc(p.id)}"${hasVoted ? ' disabled' : ''}>
        ${avatarHtml(p)}
        <span class="vote-name">${esc(p.name)}</span>
      </button>`;
    }).join('');

    $('btn-confirm-vote').disabled = hasVoted || !selectedVote;
    $('btn-confirm-vote').textContent = hasVoted ? 'Voto registrado' : 'Confirmar voto';

    const connected = s.players.filter((p) => p.connected);
    const votedIds = new Set(g.votedIds);
    const pending = connected.filter((p) => !votedIds.has(p.id));
    const othersPending = pending.filter((p) => p.id !== me.id);
    const chosen = s.players.find((p) => p.id === selectedVote);
    if (hasVoted) {
      $('vote-waiting').textContent = chosen
        ? `Você votou em ${chosen.name}. ${votedIds.size} de ${connected.length} votaram.`
        : `${votedIds.size} de ${connected.length} votaram.`;
    } else if (othersPending.length) {
      $('vote-waiting').textContent = `Faltam ${othersPending.length} voto(s): ${othersPending.map((p) => p.name).join(', ')}.`;
    } else {
      $('vote-waiting').textContent = 'Falta só o seu voto.';
    }

    const allVoted = connected.length > 0 && pending.length === 0;
    $('btn-force-vote').hidden = !(me.isHost && !allVoted && votedIds.size > 0);
  }

  function renderResults() {
    const s = state;
    const r = s.game?.results;
    if (!r) return;

    const crewWon = r.winner === 'crew';
    const accusedName = r.accusedId ? (r.names[r.accusedId] || 'Jogador') : null;
    const impostorName = r.impostorName || r.names[r.impostorId] || '???';
    const tie = Array.isArray(r.leaders) && r.leaders.length > 1;

    const hero = $('result-hero');
    hero.className = `result-hero${crewWon ? '' : ' is-impostor'}`;
    $('result-icon').textContent = crewWon ? '✓' : '!';
    $('result-title').textContent = crewWon ? 'A equipe pegou o impostor!' : 'O impostor escapou!';

    if (crewWon) {
      $('result-subtitle').textContent = `${accusedName} foi o mais votado — e era o impostor.`;
    } else if (tie) {
      $('result-subtitle').textContent = 'Empate na votação. Na dúvida, o impostor leva.';
    } else if (accusedName) {
      $('result-subtitle').textContent = `${accusedName} foi o mais votado, mas não era o impostor.`;
    } else {
      $('result-subtitle').textContent = 'Ninguém foi acusado. O impostor agradece.';
    }

    const impostor = s.players.find((p) => p.id === r.impostorId);
    $('result-impostor').innerHTML = `${avatarHtml(impostor || { name: impostorName, id: r.impostorId }, 'avatar--lg')}
      <div><strong>${esc(impostorName)}</strong><span class="badge badge--danger">impostor</span></div>`;

    $('result-word').textContent = r.word;
    $('result-category').textContent = r.category;
    $('result-hint').textContent = `A dica genérica do impostor era: “${r.hint}”`;
    $('result-tie').textContent = tie ? 'Empate' : '';

    const rows = Object.entries(r.tally || {})
      .map(([id, count]) => ({ id, count, name: r.names[id] || 'Jogador' }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pt-BR'));
    const max = Math.max(1, ...rows.map((row) => row.count));
    $('result-tally').innerHTML = rows.map((row) => {
      const classes = ['tally-row'];
      if (row.id === r.impostorId) classes.push('is-impostor');
      if (row.id === r.accusedId) classes.push('is-accused');
      return `<div class="${classes.join(' ')}">
        <div class="tally-name">${avatarHtml({ name: row.name, id: row.id })}
          <span>${esc(row.name)}</span>
          ${row.id === r.impostorId ? '<span class="badge badge--danger">impostor</span>' : ''}
        </div>
        <span class="tally-count">${row.count} voto${row.count === 1 ? '' : 's'}</span>
        <div class="tally-track"><div class="tally-fill" style="width:${Math.round((row.count / max) * 100)}%"></div></div>
      </div>`;
    }).join('');

    $('result-score').innerHTML = scoreboardHtml(s.scores);

    const actions = $('result-actions');
    if (s.me.isHost) {
      const canAgain = s.players.length >= 3 && s.players.every((p) => p.connected);
      const reason = s.players.length < 3
        ? 'Mínimo de 3 jogadores para uma nova partida.'
        : 'Todos precisam estar online para jogar novamente.';
      actions.innerHTML = `<button class="btn btn--primary" type="button" data-action="again"${canAgain ? '' : ' disabled'}>Jogar novamente</button>
        <button class="btn btn--ghost" type="button" data-action="lobby">Voltar ao lobby</button>
        ${canAgain ? '' : `<p class="hint center">${reason}</p>`}
        <button class="link-btn" type="button" data-action="leave">Sair da sala</button>`;
    } else {
      actions.innerHTML = `<p class="hint center">Aguardando o anfitrião iniciar a próxima partida…</p>
        <button class="link-btn" type="button" data-action="leave">Sair da sala</button>`;
    }
  }

  function scoreboardHtml(scores) {
    return `<div class="score-team"><span>Equipe</span><strong>${scores.crew}</strong></div>
      <span class="score-x">×</span>
      <div class="score-team score-team--impostor"><span>Impostor</span><strong>${scores.impostor}</strong></div>`;
  }

  // ---------- actions ----------

  const homeName = () => $('input-name').value.trim();

  function normalizeCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  }

  async function createRoom() {
    const name = homeName();
    if (!name) return toast('Digite seu nome.', 'error');
    if (!socket.connected) return toast('Conectando ao servidor…', 'error');
    storage.set(NAME_KEY, name);
    return once('create', async () => {
      $('btn-create').disabled = true;
      $('btn-create').textContent = 'Criando…';
      const res = await request('createRoom', { name, playerId });
      $('btn-create').disabled = false;
      $('btn-create').textContent = 'Criar sala';
      if (!res.ok) return toast(res.error, 'error');
      saveSession({ code: res.code, name });
    });
  }

  async function joinRoom() {
    const name = homeName();
    const code = normalizeCode($('input-code').value);
    if (!name) return toast('Digite seu nome.', 'error');
    if (code.length !== 5) return toast('Digite o código de 5 caracteres.', 'error');
    if (!socket.connected) return toast('Conectando ao servidor…', 'error');
    storage.set(NAME_KEY, name);
    return once('join', async () => {
      $('btn-join').disabled = true;
      $('btn-join').textContent = 'Entrando…';
      const res = await request('joinRoom', { code, name, playerId });
      $('btn-join').disabled = false;
      $('btn-join').textContent = 'Entrar com código';
      if (!res.ok) return toast(res.error, 'error');
      saveSession({ code: res.code, name });
    });
  }

  async function updateSettings(rounds) {
    if (!state?.me?.isHost) return;
    const res = await request('updateSettings', { clueRounds: rounds });
    if (!res.ok) toast(res.error, 'error');
  }

  async function startGame() {
    return once('start', async () => {
      const res = await request('startGame');
      if (!res.ok) toast(res.error, 'error');
    });
  }

  async function confirmRole() {
    if (!revealOpen || state?.me?.confirmed) return;
    return once('confirm', async () => {
      const res = await request('confirmRole');
      if (!res.ok) toast(res.error, 'error');
    });
  }

  async function submitClue(text, spoken = false) {
    return once('clue', async () => {
      const res = await request('submitClue', spoken ? { spoken: true } : { text });
      if (!res.ok) {
        showClueError(res.error);
        return;
      }
      $('clue-input').value = '';
      hideClueError();
    });
  }

  function showClueError(message) {
    const el = $('clue-error');
    el.textContent = message;
    el.hidden = false;
  }

  function hideClueError() {
    const el = $('clue-error');
    el.hidden = true;
    el.textContent = '';
  }

  async function submitVote() {
    if (!selectedVote || state?.me?.vote) return;
    return once('vote', async () => {
      const res = await request('submitVote', { targetId: selectedVote });
      if (!res.ok) toast(res.error, 'error');
    });
  }

  async function forceVote() {
    if (!state?.me?.isHost) return;
    if (!confirm('Encerrar a votação agora? Quem ainda não votou ficará de fora.')) return;
    const res = await request('forceVote');
    if (!res.ok) toast(res.error, 'error');
  }

  async function skipTurn() {
    if (!state?.me?.isHost) return;
    const current = state.players.find((p) => p.id === state.game?.currentPlayerId);
    if (!confirm(`Pular a vez de ${current?.name || 'jogador'}?`)) return;
    const res = await request('skipTurn');
    if (!res.ok) toast(res.error, 'error');
  }

  async function leaveCurrentRoom(message) {
    if (!confirm(message)) return;
    await request('leaveRoom');
    clearSession();
    hideBoot();
    showHome();
    toast('Você saiu da sala.');
  }

  async function leaveGame() {
    return leaveCurrentRoom('Sair da partida? A sala continua sem você.');
  }

  async function leaveLobby() {
    return leaveCurrentRoom('Sair da sala?');
  }

  async function copyInvite() {
    if (!state) return;
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('sala', state.code);
    const text = `Entra no Impostor! Sala ${state.code} — ${url.toString()}`;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.focus();
        area.select();
        ok = document.execCommand('copy');
        area.remove();
      } catch { ok = false; }
    }
    toast(ok ? 'Convite copiado!' : 'Não foi possível copiar.', ok ? '' : 'error');
  }

  // ---------- socket lifecycle ----------

  socket.on('state', (next) => {
    if (!next?.me) return;
    const previous = state;
    state = next;
    saveSession({ code: next.code, name: next.me.name });
    hideBoot();
    setOnline(true);
    render(previous);
  });

  socket.on('connect', () => {
    setOnline(true);
    if (session) {
      tryRejoin();
    } else {
      hideBoot();
      if (!state) showScreen('home');
    }
  });

  socket.on('disconnect', () => setOnline(false));

  socket.on('connect_error', () => {
    setOnline(false);
    if (session && !state) {
      hideBoot();
      showScreen('home');
      if (!connectionErrorShown) {
        connectionErrorShown = true;
        toast('Não foi possível conectar. Verifique se o servidor está rodando.', 'error');
      }
    }
  });

  socket.on('kicked', () => {
    clearSession();
    hideBoot();
    showHome();
    toast('Você foi removido da sala.', 'error');
  });

  socket.on('sessionReplaced', () => {
    clearSession();
    hideBoot();
    showHome();
    toast('Esta sala foi aberta em outra aba ou dispositivo.', 'error');
  });

  async function tryRejoin() {
    if (!session || rejoining) return;
    rejoining = true;
    if (!state) showBoot('Entrando na sala…');
    const res = await request('joinRoom', {
      code: session.code,
      name: session.name,
      playerId,
    });
    rejoining = false;
    if (!res.ok) {
      const error = res.error;
      clearSession();
      state = null;
      hideBoot();
      showScreen('home');
      toast(error || 'Não foi possível entrar na sala.', 'error');
      return;
    }
    hideBoot();
  }

  // ---------- event bindings ----------

  $('input-code').addEventListener('input', (event) => {
    event.target.value = normalizeCode(event.target.value);
  });

  $('btn-create').addEventListener('click', createRoom);
  $('btn-join').addEventListener('click', joinRoom);

  $('input-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !normalizeCode($('input-code').value)) createRoom();
  });
  $('input-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') joinRoom();
  });

  $('btn-rules-home').addEventListener('click', () => openModal($('modal-rules')));
  $('btn-rules-lobby').addEventListener('click', () => openModal($('modal-rules')));
  $('btn-copy-code').addEventListener('click', copyInvite);

  $('lobby-players').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-kick]');
    if (!btn) return;
    const target = state?.players.find((p) => p.id === btn.dataset.kick);
    if (!target) return;
    if (!confirm(`Remover ${target.name} da sala?`)) return;
    const res = await request('kickPlayer', { targetId: target.id });
    if (!res.ok) toast(res.error, 'error');
  });

  $('rounds-options').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-rounds]');
    if (btn) updateSettings(Number(btn.dataset.rounds));
  });

  $('btn-start').addEventListener('click', startGame);
  $('btn-reset-score').addEventListener('click', async () => {
    if (!confirm('Zerar o placar da série?')) return;
    const res = await request('resetScores');
    if (!res.ok) toast(res.error, 'error');
  });

  $('btn-leave-lobby').addEventListener('click', leaveLobby);
  $('btn-leave-reveal').addEventListener('click', leaveGame);
  $('btn-leave-game').addEventListener('click', leaveGame);

  $('role-card').addEventListener('click', revealCard);
  $('role-card').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      revealCard();
    }
  });

  function revealCard() {
    if (!state || state.phase !== 'reveal' || revealOpen) return;
    revealOpen = true;
    $('role-card').classList.add('revealed');
    if (!state.me.confirmed) $('btn-confirm-role').disabled = false;
    navigator.vibrate?.(18);
  }

  $('btn-confirm-role').addEventListener('click', confirmRole);
  $('btn-force-clues').addEventListener('click', async () => {
    if (!confirm('Iniciar as dicas sem esperar todos confirmarem?')) return;
    const res = await request('forceClues');
    if (!res.ok) toast(res.error, 'error');
  });

  $('btn-view-role').addEventListener('click', openRoleModal);
  $('btn-view-role-vote').addEventListener('click', openRoleModal);

  $('clue-input').addEventListener('input', () => {
    hideClueError();
  });

  $('clue-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('clue-input').value.trim();
    if (!text) return showClueError('Digite uma palavra ou use “Já falei no áudio”.');
    if (/\s/.test(text)) return showClueError('Use apenas UMA palavra, sem espaços.');
    if (text.length > 24) return showClueError('A palavra pode ter no máximo 24 caracteres.');
    return submitClue(text);
  });

  $('btn-spoken-clue').addEventListener('click', () => submitClue('', true));
  $('btn-skip-turn').addEventListener('click', skipTurn);

  $('vote-grid').addEventListener('click', (event) => {
    if (!state || state.phase !== 'voting' || state.me.vote) return;
    const btn = event.target.closest('[data-vote-id]');
    if (!btn) return;
    selectedVote = btn.dataset.voteId;
    renderVoting();
  });
  $('btn-confirm-vote').addEventListener('click', submitVote);
  $('btn-force-vote').addEventListener('click', forceVote);

  $('result-actions').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'again') {
      return once('again', async () => {
        const res = await request('playAgain');
        if (!res.ok) toast(res.error, 'error');
      });
    }
    if (btn.dataset.action === 'lobby') {
      const res = await request('toLobby');
      if (!res.ok) toast(res.error, 'error');
      return;
    }
    if (btn.dataset.action === 'leave') {
      return leaveCurrentRoom('Sair da sala?');
    }
    return undefined;
  });

  document.addEventListener('click', (event) => {
    const closer = event.target.closest('[data-close]');
    if (!closer) return;
    const modal = closer.closest('.modal');
    if (modal) closeModal(modal);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAllModals();
  });

  // ---------- boot ----------

  const initialName = storage.get(NAME_KEY) || '';
  if (initialName) $('input-name').value = initialName;

  const initialCode = new URLSearchParams(location.search).get('sala');
  if (initialCode) $('input-code').value = normalizeCode(initialCode);

  showScreen('home');
  if (session) showBoot('Entrando na sala…');
  if (socket.connected && session) tryRejoin();
})();
