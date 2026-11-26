// app.js — Lógica de la web del celular.
// Cada 1 s pide /api/state al PC y muestra la pantalla que corresponde a la fase.

const $ = (id) => document.getElementById(id);

// ---------- PIN (guardado en el navegador) ----------
// El QR trae el código en el link: http://IP:3000/#k=CODIGO
let pin = '';
try { pin = localStorage.getItem('lolremote-pin') || ''; } catch { /* modo privado */ }
const fromLink = new URLSearchParams(location.hash.slice(1)).get('k');
if (fromLink) {
  pin = fromLink;
  try { localStorage.setItem('lolremote-pin', pin); } catch { /* ignorar */ }
  history.replaceState(null, '', location.pathname); // quitar el código de la barra
}

async function api(path, body) {
  const res = await fetch('/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-pin': pin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    showView('pin-view');
    if (pin) toast('Código incorrecto. Vuelve a escanear el QR del PC.');
    throw new Error('PIN');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error');
  return data;
}
const img = (p) => `/api/img?p=${encodeURIComponent(p)}&pin=${encodeURIComponent(pin)}`;
const champImg = (id) => img(`/lol-game-data/assets/v1/champion-icons/${id}.png`);

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 2500);
}

async function run(fn) {
  try { await fn(); } catch (e) { if (e.message !== 'PIN') toast(e.message); }
}

// ---------- Vistas ----------
const views = ['pin-view', 'idle-view', 'ready-view', 'cs-view', 'live-view', 'other-view'];
function showView(id) {
  views.forEach((v) => ($(v).hidden = v !== id));
  if (id !== 'cs-view') $('champ-bar').hidden = true;
  syncDock();
}
// La barra de confirmar y el botón de chat no deben taparse
function syncDock() { document.body.classList.toggle('has-dock', !$('champ-bar').hidden); }

const PHASE_NAME = {
  None: 'En el menú', Lobby: 'En lobby', Matchmaking: 'Buscando', ReadyCheck: 'Partida encontrada',
  ChampSelect: 'Selección', GameStart: 'Cargando', InProgress: 'En partida', Reconnect: 'Reconectar',
  WaitingForStats: 'Fin de partida', PreEndOfGame: 'Fin de partida', EndOfGame: 'Fin de partida',
};
function setStatus(text, ok) {
  $('status').querySelector('b').textContent = text;
  $('status').classList.toggle('ok', !!ok);
}

$('pin-save').onclick = () => {
  pin = $('pin-input').value.trim();
  toast('Comprobando…');
  try { localStorage.setItem('lolremote-pin', pin); } catch { /* ignorar */ }
  tick();
};

// ---------- Datos estáticos ----------
let champions = [];          // [{id, name}]
let pickable = null;         // ids o null
let bannable = null;
let spells = [];             // [{id, name, iconPath, gameModes}]
let lastState = null;
let selectedId = 0;          // campeón seleccionado en el celular
let spellSlot = 0;

async function loadChampions() {
  const data = await api('/champions');
  champions = data.champions;
  pickable = data.pickable;
  bannable = data.bannable;
  renderChampGrid();
}
async function loadSpells() {
  spells = await api('/spells');
  renderSpells();
}
async function loadRunes() {
  const pages = await api('/runes');
  const list = $('rune-list');
  list.innerHTML = '';
  for (const p of pages) {
    const li = document.createElement('li');
    li.textContent = p.name;
    li.dataset.id = p.id;
    li.className = p.id === lastState?.currentRunePageId ? 'active' : '';
    li.onclick = () => run(async () => {
      await api('/runes', { id: p.id });
      toast(`Runas: ${p.name}`);
      loadRunes();
    });
    list.appendChild(li);
  }
}

// ---------- Ciclo principal ----------
let prevPhase = null;
let tickCount = 0;
async function tick() {
  tickCount += 1;
  let state;
  try {
    state = await api('/state');
  } catch (e) {
    if (e.message !== 'PIN') {
      setStatus('PC sin conexión', false);
    }
    return;
  }
  lastState = state;

  if (!state.connected) {
    setStatus('LoL cerrado', false);
    $('idle-text').textContent = 'No encuentro el cliente de LoL en el PC. Ábrelo y espera unos segundos.';
    $('queue-start').hidden = $('queue-stop').hidden = true;
    showView('idle-view');
    prevPhase = null;
    return;
  }

  setStatus(PHASE_NAME[state.phase] || state.phase, true);
  updateChat(state.phase);

  const entered = state.phase !== prevPhase;
  prevPhase = state.phase;

  if (state.phase !== 'Lobby') { $('lobby-box').hidden = true; $('leader-hint').hidden = true; }

  switch (state.phase) {
    case 'None':
      $('idle-text').textContent = 'Crea un lobby en el PC y desde aquí podrás buscar partida.';
      $('queue-start').hidden = $('queue-stop').hidden = true;
      showView('idle-view');
      break;
    case 'Lobby': {
      $('idle-text').textContent = state.queueName ? `Lobby de ${state.queueName}` : 'En lobby';
      const lb = state.lobby;
      $('queue-start').hidden = !!lb && !lb.isLeader;
      $('leader-hint').hidden = !lb || lb.isLeader;
      $('queue-stop').hidden = true;
      renderLobby(lb);
      showView('idle-view');
      break;
    }
    case 'Matchmaking': {
      const t = Math.floor(state.search?.timeInQueue || 0);
      const est = Math.floor(state.search?.estimatedQueueTime || 0);
      $('idle-text').textContent = `Buscando partida ${fmt(t)}`;
      $('idle-text').title = `Tiempo estimado: ${fmt(est)}`;
      $('queue-start').hidden = true;
      $('queue-stop').hidden = false;
      showView('idle-view');
      break;
    }
    case 'ReadyCheck':
      if (entered) alertReady();
      renderReady(state.readyCheck);
      $('ready-queue').textContent = state.queueName || '';
      showView('ready-view');
      break;
    case 'ChampSelect':
      if (entered) {
        selectedId = 0;
        $('champ-selected').textContent = 'Elige un campeón';
        run(loadChampions);
        run(loadSpells);
        run(loadRunes);
      }
      renderChampSelect(state);
      showView('cs-view');
      break;
    case 'InProgress':
      showView('live-view');
      // Las estadísticas se piden cada 2 s
      if (entered || !(tickCount % 2)) run(loadLive);
      break;
    default:
      $('other-text').textContent = `Fase: ${state.phase}`;
      showView('other-view');
  }
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// ---------- Ready check ----------
function renderReady(rc) {
  const answered = rc?.playerResponse && rc.playerResponse !== 'None';
  const left = Math.max(0, 12 - (rc?.timer || 0));
  $('ready-text').textContent = answered
    ? (rc.playerResponse === 'Accepted' ? 'Aceptaste. Esperando al resto de jugadores.' : 'Rechazaste la partida.')
    : `${Math.ceil(left)} segundos para responder`;
  // El anillo dorado se vacía con el tiempo (circunferencia ≈ 578)
  $('ready-ring').style.strokeDashoffset = String(578 * (1 - left / 12));
  $('accept').disabled = $('decline').disabled = !!answered;
  $('accept').querySelector('span').textContent = answered && rc.playerResponse === 'Accepted' ? 'Aceptada' : 'Aceptar';
}

function alertReady() {
  try { navigator.vibrate?.([400, 150, 400, 150, 400]); } catch { /* sin vibración */ }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    o.frequency.value = 880;
    o.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.4);
  } catch { /* el navegador bloqueó el audio */ }
}

$('accept').onclick = () => run(async () => { await api('/accept', {}); toast('Partida aceptada'); });
$('decline').onclick = () => run(async () => { await api('/decline', {}); toast('Partida rechazada'); });
$('queue-start').onclick = () => run(() => api('/queue/start', {}));
$('queue-stop').onclick = () => run(() => api('/queue/stop', {}));

// ---------- Selección de campeón ----------
const POS = { top: 'Top', jungle: 'Jungla', middle: 'Mid', bottom: 'ADC', utility: 'Support' };
const PHASE = { PLANNING: 'Declarando intención', BAN_PICK: 'Picks y bans', FINALIZATION: 'Últimos ajustes' };

function renderChampSelect(state) {
  const cs = state.champSelect;
  if (!cs) return;

  $('cs-phase').textContent = PHASE[cs.timerPhase] || cs.timerPhase || '';
  $('cs-timer').textContent = Math.ceil(cs.timeLeftMs / 1000);

  // Mi turno
  const turn = $('cs-turn');
  if (cs.myTurn) {
    turn.hidden = false;
    turn.textContent = cs.myTurn.type === 'ban' ? 'Tu turno de banear' : 'Tu turno de elegir';
    $('champ-lock').textContent = cs.myTurn.type === 'ban' ? 'Banear' : 'Confirmar';
  } else {
    turn.hidden = true;
    $('champ-lock').textContent = 'Confirmar';
  }
  $('champ-lock').disabled = !cs.myTurn || !selectedId;

  // Si cambió el tipo de turno (pick ↔ ban), redibujar grilla con la lista correcta
  const mode = cs.myTurn?.type || 'pick';
  if (mode !== renderChampSelect.mode) {
    renderChampSelect.mode = mode;
    run(loadChampions);
  } else {
    const takenKey = [...takenIds()].sort().join(',');
    if (takenKey !== renderChampSelect.takenKey) {
      renderChampSelect.takenKey = takenKey;
      renderChampGrid();
    }
  }

  renderModeUi(cs);
  renderSwaps(cs);

  renderTeam($('team-ally'), cs.myTeam, true, cs.swaps);
  renderTeam($('team-enemy'), cs.theirTeam, false, []);
  // Modos sin equipo enemigo visible o sin bans (ARAM, Arena...)
  $('enemy-col').hidden = !cs.theirTeam.length;
  $('teams').style.gridTemplateColumns = cs.theirTeam.length ? '' : '1fr';
  $('bans').hidden = !cs.bans.ally.length && !cs.bans.enemy.length && !cs.myTurn;
  $('bans-ally').innerHTML = cs.bans.ally.map((id) => `<img src="${champImg(id)}">`).join('') || '—';
  $('bans-enemy').innerHTML = cs.bans.enemy.map((id) => `<img src="${champImg(id)}">`).join('') || '—';

  renderSpellSlots(cs.mySpells);
}

const champName = (id) => champions.find((c) => c.id === id)?.name || '';
const spellIcon = (id) => spells.find((s) => s.id === id)?.iconPath;

function renderTeam(ul, team, isAlly, swaps) {
  ul.innerHTML = team.map((p) => {
    const id = p.championId || p.intentId;
    const pic = id
      ? `<img class="champ ${p.championId ? '' : 'intent'}" src="${champImg(id)}">`
      : '<span class="champ-empty"></span>';
    const sp = isAlly
      ? [p.spell1Id, p.spell2Id].map((s) => (spellIcon(s) ? `<img class="spell" src="${img(spellIcon(s))}">` : '')).join('')
      : '';
    const role = POS[p.position] || '';
    // Botones de intercambio con este aliado (lo que el cliente ofrezca)
    const btns = (swaps || []).filter((w) => w.cellId === p.cellId && w.state !== 'RECEIVED').map((w) => {
      const sent = w.state === 'SENT';
      return `<button class="swap-btn ${sent ? 'sent' : ''}" data-kind="${w.kind}" data-id="${w.id}"
        data-action="${sent ? 'cancel' : 'request'}">${sent ? 'Cancelar' : SWAP_LABEL[w.kind]}</button>`;
    }).join(' ');
    return `<li class="${p.isMe ? 'me' : ''}">${pic}<div class="info">
      <span>${p.isMe ? 'Tú' : escapeHtml(p.name) || (isAlly ? 'Aliado' : 'Enemigo')}</span>
      <small>${escapeHtml(champName(id)) || (role ? '' : 'Eligiendo…')}${role ? `${champName(id) ? '<br>' : ''}${role}` : ''}</small><div>${sp}</div>${btns ? `<div>${btns}</div>` : ''}</div></li>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderChampGrid() {
  const q = $('champ-search').value.trim().toLowerCase();
  const isBan = renderChampSelect.mode === 'ban';
  // Para elegir: solo los que el cliente permite (tus campeones).
  // Para banear: cualquiera, salvo los ya baneados o elegidos.
  const allowed = !isBan && pickable && pickable.length ? new Set(pickable) : null;
  const taken = takenIds();
  const grid = $('champ-grid');
  grid.innerHTML = '';
  for (const c of champions) {
    if (q && !c.name.toLowerCase().includes(q)) continue;
    const b = document.createElement('button');
    b.dataset.id = c.id;
    b.innerHTML = `<img loading="lazy" src="${champImg(c.id)}"><span>${escapeHtml(c.name)}</span>`;
    if (taken.has(c.id) || (allowed && !allowed.has(c.id))) b.disabled = true;
    if (c.id === selectedId) b.className = 'sel';
    b.onclick = () => selectChamp(c.id);
    grid.appendChild(b);
  }
}
$('champ-search').oninput = renderChampGrid;

// Campeones ya baneados o confirmados por cualquier jugador
function takenIds() {
  const cs = lastState?.champSelect;
  if (!cs) return new Set();
  const ids = [...cs.bans.ally, ...cs.bans.enemy];
  for (const p of [...cs.myTeam, ...cs.theirTeam]) {
    if (p.championId && !p.isMe) ids.push(p.championId);
  }
  return new Set(ids);
}

function selectChamp(id) {
  selectedId = id;
  document.querySelectorAll('#champ-grid button').forEach((b) => b.classList.toggle('sel', Number(b.dataset.id) === id));
  $('champ-selected').textContent = champName(id);
  $('champ-lock').disabled = !lastState?.champSelect?.myTurn;
  // Hover / intención: se ve en el cliente pero no confirma
  run(() => api('/champ', { championId: id, lock: false }));
}

$('champ-lock').onclick = () => run(async () => {
  if (!selectedId) return;
  const isBan = lastState?.champSelect?.myTurn?.type === 'ban';
  await api('/champ', { championId: selectedId, lock: true });
  toast(`${champName(selectedId)} ${isBan ? 'baneado' : 'confirmado'}`);
});

// ---------- ARAM / modos sin turnos ----------
const SWAP_LABEL = { trades: '⇄ Cambiar campeón', swaps: '⇅ Cambiar orden', 'position-swaps': '⇄ Cambiar rol' };

function renderModeUi(cs) {
  const aram = !!cs.bench;
  $('aram').hidden = !aram;
  // La grilla solo sirve si tengo pick/ban en este modo
  $('picker').hidden = !cs.hasActions;
  $('champ-bar').hidden = !cs.hasActions || $('tab-champs').hidden;
  $('no-actions').hidden = cs.hasActions || aram;

  if (aram) {
    const id = cs.myChampionId;
    $('my-champ-img').src = id ? champImg(id) : '';
    $('my-champ-name').textContent = champName(id) || '—';
    $('reroll').hidden = !cs.allowRerolling;
    $('reroll-count').textContent = `(${cs.rerollsRemaining})`;
    $('reroll').disabled = cs.rerollsRemaining <= 0;

    const key = cs.bench.join(',') + '|' + champions.length;
    if (key !== renderModeUi.benchKey) {
      renderModeUi.benchKey = key;
      $('bench-grid').innerHTML = cs.bench.length
        ? cs.bench.map((b) => `<button data-bench="${b}"><img src="${champImg(b)}"><span>${escapeHtml(champName(b))}</span></button>`).join('')
        : '<p class="muted">La banca está vacía.</p>';
    }
  }
}

$('bench-grid').onclick = (e) => {
  const b = e.target.closest('[data-bench]');
  if (!b) return;
  const id = Number(b.dataset.bench);
  run(async () => {
    await api('/bench', { championId: id });
    toast(`Cambiaste a ${champName(id)}`);
  });
};
$('reroll').onclick = () => run(async () => { await api('/reroll', {}); toast('🎲 Reroll'); });

// Solicitudes que me hicieron otros jugadores
function renderSwaps(cs) {
  const incoming = cs.swaps.filter((w) => w.state === 'RECEIVED');
  const key = incoming.map((w) => w.kind + w.id).join(',') + '|' + champions.length;
  if (key === renderSwaps.key) return;
  renderSwaps.key = key;
  $('swap-incoming').innerHTML = incoming.map((w) => {
    const p = cs.myTeam.find((x) => x.cellId === w.cellId);
    const who = escapeHtml(p?.name || 'Un aliado');
    const what = w.kind === 'trades'
      ? `quiere cambiar su <b>${escapeHtml(champName(p?.championId) || 'campeón')}</b> por el tuyo`
      : w.kind === 'swaps' ? 'quiere cambiar el orden de pick contigo' : 'quiere cambiar de rol contigo';
    return `<div class="incoming">🔄 <b>${who}</b> ${what}
      <div class="row">
        <button class="btn primary" data-kind="${w.kind}" data-id="${w.id}" data-action="accept">Aceptar</button>
        <button class="btn ghost" data-kind="${w.kind}" data-id="${w.id}" data-action="decline">Rechazar</button>
      </div></div>`;
  }).join('');
  if (incoming.length) try { navigator.vibrate?.(200); } catch { /* sin vibración */ }
}

// Un solo manejador para todos los botones de intercambio
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind][data-action]');
  if (!b) return;
  const body = { kind: b.dataset.kind, id: Number(b.dataset.id), action: b.dataset.action };
  run(async () => {
    await api('/swap', body);
    toast({ request: 'Solicitud enviada', accept: 'Intercambio aceptado', decline: 'Rechazado', cancel: 'Cancelado' }[body.action]);
    renderSwaps.key = null;
  });
});

// ---------- En partida ----------
async function loadLive() {
  const d = await api('/live');
  $('live-loading').hidden = d.inGame;
  $('live').hidden = !d.inGame;
  if (!d.inGame) return;

  $('live-time').textContent = fmt(d.time);
  $('ally-kills').textContent = d.ally.kills;
  $('enemy-kills').textContent = d.enemy.kills;
  const total = d.ally.kills + d.enemy.kills;
  $('kill-bar').style.width = `${total ? (d.ally.kills / total) * 100 : 50}%`;
  $('live-result').hidden = !d.result;
  if (d.result) $('live-result').textContent = d.result === 'Win' ? '🏆 ¡Victoria!' : 'Derrota';

  const objs = (t) => {
    const parts = [];
    const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    parts.push(`🗼 ${n(t.towers, 'torre', 'torres')}`);
    if (t.dragons.length) parts.push(`🐉 ${n(t.dragons.length, 'dragón', 'dragones')}`);
    if (t.grubs) parts.push(`🪲 ${n(t.grubs, 'larva', 'larvas')}`);
    if (t.heralds) parts.push(`👁️ ${n(t.heralds, 'heraldo', 'heraldos')}`);
    if (t.barons) parts.push(`🟣 ${n(t.barons, 'barón', 'barones')}`);
    if (t.inhibs) parts.push(`🏛️ ${n(t.inhibs, 'inhibidor', 'inhibidores')}`);
    return parts.join('<br>');
  };
  $('obj-ally').innerHTML = objs(d.ally);
  $('obj-enemy').innerHTML = objs(d.enemy);

  const st = d.me.stats;
  $('me-box').innerHTML = `<div><span class="gold">💰 ${d.me.gold}</span><span class="lvl">Nivel ${d.me.level ?? '-'}</span>❤️ ${st.hp}</div>
    <div class="stats">
      <span>AD <b>${st.ad}</b></span><span>AP <b>${st.ap}</b></span><span>Vel. at. <b>${st.as}</b></span>
      <span>Armadura <b>${st.armor}</b></span><span>Res. mág. <b>${st.mr}</b></span><span>Celeridad <b>${st.haste}</b></span>
      <span>Crítico <b>${st.crit}%</b></span><span>Vel. mov. <b>${st.ms}</b></span>
    </div>`;

  const row = (p) => {
    const items = Array.from({ length: 7 }, (_, i) => {
      const it = p.items[i];
      return it?.icon ? `<img src="${img(it.icon)}" title="${escapeHtml(it.name)}">` : '<span></span>';
    }).join('');
    const pic = p.championId ? `<img class="champ" src="${champImg(p.championId)}">` : '<span class="champ-empty"></span>';
    return `<li class="${p.isMe ? 'me' : ''} ${p.isDead ? 'dead' : ''}">${pic}
      <div class="who"><div>${p.isMe ? 'Tú' : escapeHtml(p.name)} <small>Nv ${p.level}</small>${p.isDead ? ` <small>☠️ ${p.respawn} s</small>` : ''}</div>
        <div class="items">${items}</div></div>
      <div class="kda">${p.kills}/${p.deaths}/${p.assists}<small>${p.cs} CS</small></div></li>`;
  };
  $('live-ally').innerHTML = d.ally.players.map(row).join('');
  $('live-enemy').innerHTML = d.enemy.players.map(row).join('');
  $('live-feed').innerHTML = d.feed.length
    ? d.feed.map((f) => `<li class="${f.ally ? 'ally' : ''}"><small>${fmt(Math.floor(f.t))}</small>${escapeHtml(f.text)}</li>`).join('')
    : '<li class="ally"><small>—</small>Todavía no pasa nada</li>';
}

// ---------- Lobby: línea ----------
const ROLES = [['TOP', 'Top'], ['JUNGLE', 'Jungla'], ['MIDDLE', 'Mid'], ['BOTTOM', 'ADC'], ['UTILITY', 'Support'], ['FILL', 'Cualquiera']];
const ROLE_NAME = Object.fromEntries(ROLES);
let lobbyPos = { first: '', second: '' };
let posBusy = false;

document.querySelectorAll('.roles').forEach((box) => {
  box.innerHTML = ROLES.map(([v, label]) => `<button data-role="${v}">${label}</button>`).join('');
  box.onclick = (e) => {
    const b = e.target.closest('[data-role]');
    if (!b || b.disabled) return;
    choosePosition(box.dataset.pref, b.dataset.role);
  };
});

function renderLobby(lb) {
  $('lobby-box').hidden = !lb;
  if (!lb) return;
  $('positions').hidden = !lb.canPickPositions;
  if (!posBusy) lobbyPos = { first: lb.first, second: lb.second };
  paintRoles();

  $('party').innerHTML = lb.members.length > 1 || lb.canPickPositions
    ? lb.members.map((m) => {
      const roles = lb.canPickPositions
        ? [m.first, m.second].filter(Boolean).map((r) => ROLE_NAME[r] || r).join(' y ') || 'Sin línea'
        : '';
      return `<li class="${m.isMe ? 'me' : ''}"><span>${m.isMe ? 'Tú' : escapeHtml(m.name || 'Jugador')}${m.isLeader ? ' 👑' : ''}</span><small>${escapeHtml(roles)}</small></li>`;
    }).join('')
    : '';
}

function paintRoles() {
  const { first, second } = lobbyPos;
  document.querySelectorAll('.roles[data-pref="first"] button').forEach((b) => b.classList.toggle('sel', b.dataset.role === first));
  document.querySelectorAll('.roles[data-pref="second"] button').forEach((b) => {
    b.classList.toggle('sel', b.dataset.role === second);
    b.disabled = b.dataset.role === first; // no puede repetir la principal
  });
  // Con "Cualquiera" de principal no hay secundaria
  $('second-wrap').hidden = !first || first === 'FILL';
}

function choosePosition(pref, role) {
  const next = { ...lobbyPos };
  if (pref === 'first') {
    if (role === next.second) next.second = next.first && next.first !== 'FILL' ? next.first : '';
    next.first = role;
    if (role === 'FILL') next.second = '';
  } else {
    next.second = role;
  }
  lobbyPos = next;
  paintRoles();
  posBusy = true;
  run(async () => {
    try {
      await api('/positions', { first: next.first || 'UNSELECTED', second: next.second || 'UNSELECTED' });
    } finally {
      // Dar un momento al cliente antes de volver a leer su estado
      setTimeout(() => { posBusy = false; }, 1200);
    }
  });
}

// ---------- Chat ----------
const CHAT_PHASES = ['Lobby', 'Matchmaking', 'ReadyCheck', 'ChampSelect', 'WaitingForStats', 'PreEndOfGame', 'EndOfGame'];
const CHAT_TITLE = { championSelect: 'Chat de selección', postGame: 'Chat de fin de partida' };
let chatOpen = false;
let chatMsgs = [];
let chatSeen = null;   // último mensaje visto
let chatPhase = null;
let chatBusy = false;

function updateChat(phase) {
  if (!CHAT_PHASES.includes(phase)) {
    $('chat-fab').hidden = true;
    closeChat();
    chatPhase = null;
    return;
  }
  if (phase !== chatPhase) {
    // Cada fase tiene su propio chat: empezar de cero sin contar el historial
    chatPhase = phase;
    chatMsgs = [];
    chatSeen = null;
  }
  if (chatOpen || tickCount % 3 === 0) loadChat();
}

async function loadChat() {
  if (chatBusy) return;
  chatBusy = true;
  try {
    const d = await api('/chat');
    if (!d.available) {
      $('chat-fab').hidden = true;
      closeChat();
      return;
    }
    $('chat-title').textContent = CHAT_TITLE[d.type] || 'Chat del lobby';
    const prevLast = chatMsgs.at(-1)?.id;
    chatMsgs = d.messages;
    const last = chatMsgs.at(-1)?.id ?? '';
    if (chatSeen === null) chatSeen = last;
    if (chatOpen) {
      chatSeen = last;
      if (prevLast !== last || !$('chat-list').children.length) renderChat();
    }
    const seenAt = chatMsgs.findIndex((m) => m.id === chatSeen);
    const unread = chatMsgs.slice(seenAt + 1).filter((m) => !m.mine && !m.system).length;
    $('chat-badge').hidden = !unread;
    $('chat-badge').textContent = unread > 9 ? '9+' : unread;
    $('chat-fab').hidden = chatOpen;
  } catch { /* el chat es secundario: no mostrar errores */ }
  finally { chatBusy = false; }
}

function renderChat() {
  const list = $('chat-list');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.innerHTML = chatMsgs.length
    ? chatMsgs.map((m) => (m.system
      ? `<li class="system">${escapeHtml(m.body)}</li>`
      : `<li class="${m.mine ? 'mine' : ''}"><div class="from">${escapeHtml(m.from)}</div><div class="bubble">${escapeHtml(m.body)}</div></li>`)).join('')
    : '<li class="empty">Todavía no hay mensajes. Escribe el primero.</li>';
  if (atBottom || !renderChat.done) list.scrollTop = list.scrollHeight;
  renderChat.done = true;
}

function openChat() {
  chatOpen = true;
  renderChat.done = false;
  $('chat-sheet').hidden = false;
  $('chat-fab').hidden = true;
  chatSeen = chatMsgs.at(-1)?.id ?? '';
  $('chat-badge').hidden = true;
  renderChat();
  loadChat();
}
function closeChat() {
  if (!chatOpen) return;
  chatOpen = false;
  $('chat-sheet').hidden = true;
  $('chat-input').blur();
}
$('chat-fab').onclick = openChat;
$('chat-close').onclick = () => { closeChat(); $('chat-fab').hidden = false; };
$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  const body = $('chat-input').value.trim();
  if (!body) return;
  run(async () => {
    await api('/chat', { body });
    $('chat-input').value = '';
    renderChat.done = false;
    await loadChat();
  });
};

// ---------- Hechizos ----------
function renderSpells() {
  const mode = lastState?.gameMode || 'CLASSIC';
  const grid = $('spell-grid');
  grid.innerHTML = '';
  for (const s of spells.filter((x) => x.gameModes.includes(mode))) {
    const b = document.createElement('button');
    b.innerHTML = `<img src="${img(s.iconPath)}"><span>${escapeHtml(s.name)}</span>`;
    b.onclick = () => run(async () => {
      const cur = [...(lastState?.champSelect?.mySpells || [0, 0])];
      const other = 1 - spellSlot;
      if (cur[other] === s.id) cur[other] = cur[spellSlot]; // si ya estaba en el otro espacio, se intercambian
      cur[spellSlot] = s.id;
      await api('/spells', { spell1Id: cur[0], spell2Id: cur[1] });
      toast(`Hechizo: ${s.name}`);
    });
    grid.appendChild(b);
  }
}

function renderSpellSlots(mySpells) {
  document.querySelectorAll('.slot').forEach((el, i) => {
    const icon = spellIcon(mySpells[i]);
    el.style.backgroundImage = icon ? `url("${img(icon)}")` : '';
  });
}
document.querySelectorAll('.slot').forEach((el) => {
  el.onclick = () => {
    spellSlot = Number(el.dataset.slot);
    document.querySelectorAll('.slot').forEach((s) => s.classList.toggle('active', s === el));
  };
});

// ---------- Pestañas ----------
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    ['champs', 'spells', 'runes'].forEach((t) => ($('tab-' + t).hidden = t !== btn.dataset.tab));
    $('champ-bar').hidden = btn.dataset.tab !== 'champs' || !lastState?.champSelect?.hasActions;
    syncDock();
    if (btn.dataset.tab === 'runes') run(loadRunes);
  };
});

// ---------- Arranque ----------
tick();
setInterval(tick, 1000);
