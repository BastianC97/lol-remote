// server.js — Servidor que corre en tu PC.
// El celular habla con este servidor, y este servidor habla con el cliente de LoL.
//
//   Celular  --HTTP-->  server.js (tu PC, puerto 3000)  --HTTPS-->  Cliente LoL (LCU)

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const lcu = require('./lcu');
const config = require('./config');
const setup = require('./setup');
const notifier = require('./notifier');
const live = require('./live');
const chat = require('./chat');

const PORT = Number(process.env.PORT) || 3000;
const cfg = config.load();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Página de configuración con el QR (solo se puede abrir desde el mismo PC)
setup.mount(app, { cfg, port: PORT });

// ---------- Seguridad: código secreto ----------
// El código va dentro del QR. Sin él no se puede usar la API.
function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
app.use('/api', (req, res, next) => {
  const given = String(req.get('x-pin') || req.query.pin || '').trim();
  if (sameSecret(given, cfg.token)) return next();
  res.status(401).json({ error: 'Código incorrecto. Vuelve a escanear el QR.' });
});

// Envuelve los handlers para no repetir try/catch
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    const notFound = err.message === 'LCU_NOT_FOUND' || err.code === 'ECONNREFUSED';
    res.status(notFound ? 503 : 500).json({
      error: notFound ? 'No encuentro el cliente de LoL. ¿Está abierto?' : err.message,
    });
  }
};

// Hace una acción en la LCU y lanza error si el cliente la rechaza
async function act(method, endpoint, body) {
  const r = await lcu.request(method, endpoint, body);
  if (r.status >= 400) {
    const info = r.json();
    throw new Error(info?.message || `El cliente respondió ${r.status}`);
  }
  return { ok: true };
}

// ---------- Estado general ----------
// El celular consulta esto cada segundo.
app.get('/api/state', handle(async () => {
  let phase;
  try {
    phase = await lcu.get('/lol-gameflow/v1/gameflow-phase');
  } catch {
    return { connected: false };
  }
  if (phase === null) return { connected: false };

  const state = { connected: true, phase };
  const flow = await lcu.get('/lol-gameflow/v1/session');
  state.gameMode = flow?.gameData?.queue?.gameMode || null;
  state.queueName = flow?.gameData?.queue?.description || null;

  if (phase === 'Lobby') {
    const lobby = await lcu.get('/lol-lobby/v2/lobby');
    if (lobby) state.lobby = summarizeLobby(lobby);
  }

  if (phase === 'Matchmaking') {
    const s = await lcu.get('/lol-matchmaking/v1/search');
    state.search = s && { timeInQueue: s.timeInQueue, estimatedQueueTime: s.estimatedQueueTime };
  }

  if (phase === 'ReadyCheck') {
    const rc = await lcu.get('/lol-matchmaking/v1/ready-check');
    state.readyCheck = rc && { state: rc.state, playerResponse: rc.playerResponse, timer: rc.timer };
  }

  if (phase === 'ChampSelect') {
    const s = await lcu.get('/lol-champ-select/v1/session');
    if (s) state.champSelect = summarizeSession(s);
    const page = await lcu.get('/lol-perks/v1/currentpage');
    state.currentRunePageId = page?.id ?? null;
  }

  return state;
}));

// Lobby: grupo, líneas elegidas y si el modo permite elegir línea
function summarizeLobby(l) {
  const meM = l.localMember || {};
  const pos = (v) => (v && v !== 'UNSELECTED' ? v : '');
  return {
    // El cliente avisa si este modo usa selección de línea
    canPickPositions: !!l.gameConfig?.showPositionSelector,
    isLeader: !!meM.isLeader,
    first: pos(meM.firstPositionPreference),
    second: pos(meM.secondPositionPreference),
    members: (l.members || []).map((m) => ({
      name: m.gameName || m.summonerName || '',
      isMe: m.puuid ? m.puuid === meM.puuid : m.summonerId === meM.summonerId,
      isLeader: !!m.isLeader,
      first: pos(m.firstPositionPreference),
      second: pos(m.secondPositionPreference),
    })),
  };
}

// Reduce la sesión de selección (muy grande) a lo que la web necesita
function summarizeSession(s) {
  const me = s.localPlayerCellId;
  const actions = (s.actions || []).flat();

  // Acción que está activa AHORA para mí (mi turno de pick o ban)
  const active = actions.find((a) => a.actorCellId === me && a.isInProgress && !a.completed);
  // Mi pick pendiente (sirve para "hoverear" antes de que sea mi turno)
  const pendingPick = actions.find((a) => a.actorCellId === me && a.type === 'pick' && !a.completed);

  const bans = { ally: [], enemy: [] };
  for (const a of actions) {
    if (a.type === 'ban' && a.completed && a.championId) {
      (a.isAllyAction ? bans.ally : bans.enemy).push(a.championId);
    }
  }
  // Algunos modos llenan s.bans directamente
  if (!bans.ally.length && s.bans?.myTeamBans) bans.ally = s.bans.myTeamBans.filter(Boolean);
  if (!bans.enemy.length && s.bans?.theirTeamBans) bans.enemy = s.bans.theirTeamBans.filter(Boolean);

  const mapPlayer = (p) => ({
    cellId: p.cellId,
    isMe: p.cellId === me,
    name: p.gameName || p.summonerName || '',
    position: p.assignedPosition || '',
    championId: p.championId || 0,
    intentId: p.championPickIntent || 0,
    spell1Id: p.spell1Id,
    spell2Id: p.spell2Id,
  });

  const mine = (s.myTeam || []).find((p) => p.cellId === me);

  // Intercambios que ofrece el cliente (cada modo usa los suyos):
  //  - trades:          cambiar campeón con un aliado (ARAM, Draft después de elegir)
  //  - pickOrderSwaps:  cambiar el orden de pick
  //  - positionSwaps:   cambiar de rol
  // state: AVAILABLE (se puede pedir), SENT (lo pedí yo), RECEIVED (me lo pidieron), BUSY, INVALID...
  const swaps = [];
  for (const [kind, list] of [['trades', s.trades], ['swaps', s.pickOrderSwaps], ['position-swaps', s.positionSwaps]]) {
    for (const t of list || []) {
      if (['AVAILABLE', 'SENT', 'RECEIVED'].includes(t.state)) {
        swaps.push({ kind, id: t.id, cellId: t.cellId, state: t.state });
      }
    }
  }

  return {
    timerPhase: s.timer?.phase,                       // PLANNING, BAN_PICK, FINALIZATION
    timeLeftMs: s.timer?.adjustedTimeLeftInPhase ?? 0,
    myTeam: (s.myTeam || []).map(mapPlayer),
    theirTeam: (s.theirTeam || []).map(mapPlayer),
    bans,
    myTurn: active ? { id: active.id, type: active.type, championId: active.championId } : null,
    pendingPickId: pendingPick?.id ?? null,
    mySpells: mine ? [mine.spell1Id, mine.spell2Id] : [0, 0],
    myChampionId: mine?.championId || 0,
    // ¿Este modo me deja elegir/banear con la grilla? (ARAM, por ejemplo, no)
    hasActions: actions.some((a) => a.actorCellId === me && !a.completed),
    // ARAM y modos aleatorios: banca y reroll
    bench: s.benchEnabled ? (s.benchChampions || []).map((b) => b.championId).filter(Boolean) : null,
    allowRerolling: !!s.allowRerolling,
    rerollsRemaining: s.rerollsRemaining ?? 0,
    swaps,
  };
}

// ---------- Datos estáticos (campeones, hechizos, runas) ----------
let championCache = null;
app.get('/api/champions', handle(async () => {
  if (!championCache) {
    const all = await lcu.get('/lol-game-data/assets/v1/champion-summary.json');
    championCache = (all || [])
      .filter((c) => c.id > 0)
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  // Solo existen durante la selección de campeón
  const pickable = await lcu.get('/lol-champ-select/v1/pickable-champion-ids').catch(() => null);
  const bannable = await lcu.get('/lol-champ-select/v1/bannable-champion-ids').catch(() => null);

  // El cliente trae dos versiones de algunos campeones (normal y LoL Classic)
  // con el mismo nombre. Dejamos una sola: la que se puede elegir en esta
  // partida; si no hay info, la de ID más bajo (la versión normal).
  const pickSet = new Set(pickable || []);
  const banSet = new Set(bannable || []);
  const score = (c) => (pickSet.has(c.id) ? 2 : 0) + (banSet.has(c.id) ? 1 : 0);
  const byName = new Map();
  for (const c of championCache) {
    const key = c.name.toLowerCase();
    const prev = byName.get(key);
    if (!prev || score(c) > score(prev) || (score(c) === score(prev) && c.id < prev.id)) {
      byName.set(key, c);
    }
  }
  const champions = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

  return { champions, pickable, bannable };
}));

let spellCache = null;
app.get('/api/spells', handle(async () => {
  if (!spellCache) {
    const all = await lcu.get('/lol-game-data/assets/v1/summoner-spells.json');
    spellCache = (all || [])
      .filter((s) => s.id > 0 && s.gameModes?.length)
      .map((s) => ({ id: s.id, name: s.name, iconPath: s.iconPath, gameModes: s.gameModes }));
  }
  return spellCache;
}));

app.get('/api/runes', handle(async () => {
  const pages = (await lcu.get('/lol-perks/v1/pages')) || [];
  return pages
    .filter((p) => p.isValid !== false)
    .map((p) => ({ id: p.id, name: p.name, isActive: p.isActive }));
}));

// Proxy de imágenes del cliente (íconos de campeones y hechizos)
app.get('/api/img', async (req, res) => {
  const p = String(req.query.p || '');
  if (!p.startsWith('/lol-game-data/assets/')) return res.status(400).end();
  try {
    const r = await lcu.request('GET', p);
    if (r.status !== 200) return res.status(r.status).end();
    res.set('Content-Type', r.headers['content-type'] || 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(r.buffer);
  } catch {
    res.status(503).end();
  }
});

// ---------- Acciones ----------
app.post('/api/accept', handle(() => act('POST', '/lol-matchmaking/v1/ready-check/accept')));
app.post('/api/decline', handle(() => act('POST', '/lol-matchmaking/v1/ready-check/decline')));
app.post('/api/queue/start', handle(() => act('POST', '/lol-lobby/v2/lobby/matchmaking/search')));
app.post('/api/queue/stop', handle(() => act('DELETE', '/lol-lobby/v2/lobby/matchmaking/search')));

// Línea en el lobby: { first, second } con TOP, JUNGLE, MIDDLE, BOTTOM, UTILITY o FILL
const POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'FILL', 'UNSELECTED'];
app.post('/api/positions', handle((req) => {
  const first = String(req.body?.first || 'UNSELECTED');
  let second = String(req.body?.second || 'UNSELECTED');
  if (!POSITIONS.includes(first) || !POSITIONS.includes(second)) throw new Error('Línea inválida');
  if (first === 'FILL' || second === first) second = 'UNSELECTED';
  return act('PUT', '/lol-lobby/v1/lobby/members/localMember/position-preferences', {
    firstPreference: first,
    secondPreference: second,
  });
}));

// Elegir campeón: { championId, lock }
//  - Si es mi turno: marca el campeón y, si lock=true, lo confirma.
//  - Si no es mi turno: solo lo deja como "intención" (hover).
app.post('/api/champ', handle(async (req) => {
  const { championId, lock } = req.body || {};
  if (!Number.isInteger(championId)) throw new Error('championId inválido');

  const s = await lcu.get('/lol-champ-select/v1/session');
  if (!s) throw new Error('No estás en selección de campeón');
  const sum = summarizeSession(s);

  const actionId = sum.myTurn?.id ?? sum.pendingPickId;
  if (actionId == null) throw new Error('No tienes un pick ni ban pendiente');

  const canLock = !!sum.myTurn && !!lock;
  return act('PATCH', `/lol-champ-select/v1/session/actions/${actionId}`, {
    championId,
    ...(canLock ? { completed: true } : {}),
  });
}));

// Hechizos: { spell1Id, spell2Id }
app.post('/api/spells', handle((req) => {
  const { spell1Id, spell2Id } = req.body || {};
  return act('PATCH', '/lol-champ-select/v1/session/my-selection', { spell1Id, spell2Id });
}));

// Página de runas: { id }
app.post('/api/runes', handle((req) => {
  const id = Number(req.body?.id);
  return act('PUT', '/lol-perks/v1/currentpage', id);
}));

// ARAM: tomar un campeón de la banca
app.post('/api/bench', handle((req) => {
  const id = Number(req.body?.championId);
  if (!Number.isInteger(id)) throw new Error('championId inválido');
  return act('POST', `/lol-champ-select/v1/session/bench/swap/${id}`);
}));

// ARAM: reroll (dado)
app.post('/api/reroll', handle(() => act('POST', '/lol-champ-select/v1/session/my-selection/reroll')));

// Intercambios: { kind: trades|swaps|position-swaps, id, action: request|accept|decline|cancel }
app.post('/api/swap', handle((req) => {
  const { kind, id, action } = req.body || {};
  if (!['trades', 'swaps', 'position-swaps'].includes(kind)) throw new Error('Tipo inválido');
  if (!['request', 'accept', 'decline', 'cancel'].includes(action)) throw new Error('Acción inválida');
  if (!Number.isInteger(id)) throw new Error('id inválido');
  return act('POST', `/lol-champ-select/v1/session/${kind}/${id}/${action}`);
}));

// Chat del lobby / selección / post-partida
const currentPhase = () => lcu.get('/lol-gameflow/v1/gameflow-phase').catch(() => null);
app.get('/api/chat', handle(async () => chat.read(await currentPhase())));
app.post('/api/chat', handle(async (req) => chat.send(await currentPhase(), req.body?.body)));

// Estadísticas de la partida en curso (API oficial del juego, puerto 2999)
app.get('/api/live', handle(() => live.summary()));

const server = app.listen(PORT, '0.0.0.0', () => {
  const setupUrl = `http://localhost:${PORT}/setup`;
  console.log('');
  console.log('  ==========================================');
  console.log('              LoL Remote activo');
  console.log('  ==========================================');
  console.log('');
  console.log('  Escanea el QR que se abrió en tu navegador.');
  console.log(`  Si no se abrió, entra a: ${setupUrl}`);
  console.log('');
  console.log('  NO cierres esta ventana mientras lo uses.');
  console.log('');
  if (!process.env.NO_BROWSER) setup.openBrowser(setupUrl);

  // Avisos al celular (partida encontrada / tu turno)
  notifier.startWatching({
    getTopic: () => cfg.ntfyTopic,
    isEnabled: () => cfg.ntfyEnabled,
    getClickUrl: () => setup.clickUrl(cfg, PORT),
  });
});

server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  // El puerto está ocupado: probablemente LoL Remote ya está abierto
  const already = await setup.isRunning(PORT);
  if (already) {
    console.log('\n  LoL Remote ya estaba abierto. Abriendo la página del QR...');
    setup.openBrowser(`http://localhost:${PORT}/setup`);
  } else {
    console.log(`\n  ERROR: otro programa está usando el puerto ${PORT}.`);
    console.log('  Cierra ese programa o reinicia el PC e intenta de nuevo.');
  }
  setTimeout(() => process.exit(0), already ? 4000 : 30000);
});
