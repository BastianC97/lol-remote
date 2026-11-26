// chat.js — Chat del lobby, de la selección de campeones y de después de la partida.
//
// El cliente guarda los chats como "conversaciones" en /lol-chat/v1/conversations.
// Los mensajes privados con amigos son de tipo "chat" (esos NO se muestran aquí);
// los chats de grupo tienen otros tipos: "championSelect", "postGame", "customGame"...

const lcu = require('./lcu');

// Qué conversación mostrar según la fase del juego
function preferredTypes(phase) {
  if (phase === 'ChampSelect') return ['championSelect'];
  if (['PreEndOfGame', 'EndOfGame', 'WaitingForStats'].includes(phase)) return ['postGame'];
  return ['customGame', 'lobby', 'party'];
}

async function activeConversation(phase) {
  const convs = (await lcu.get('/lol-chat/v1/conversations')) || [];
  const groups = convs.filter((c) => c.type && c.type !== 'chat');
  const prefer = preferredTypes(phase);
  return groups.find((c) => prefer.includes(c.type))
    || (phase === 'ChampSelect' ? null : groups.find((c) => c.type !== 'championSelect'))
    || null;
}

// ---------- Nombres de quienes escriben ----------
// Según la versión del cliente, un mensaje identifica a quien escribe con
// fromSummonerId, fromPid o fromId ("<puuid>@servidor"). Juntamos todos los
// identificadores que conocemos de cada jugador para encontrar su nombre.

const known = new Map(); // cualquier id -> nombre (se recuerda entre llamadas)
const failed = new Set(); // ids que ya preguntamos sin éxito

const displayName = (o) => {
  const n = o?.gameName || o?.summonerName || o?.name || o?.displayName || '';
  return String(n).trim();
};

function remember(obj) {
  const name = displayName(obj);
  if (!name) return;
  for (const id of [obj.summonerId, obj.puuid, obj.pid, obj.id]) {
    if (!id) continue;
    known.set(String(id), name);
    // "<puuid>@la1.pvp.net" -> también por el puuid solo
    const local = String(id).split('@')[0];
    if (local) known.set(local, name);
  }
}

function senderKeys(m) {
  const keys = [m.fromSummonerId, m.fromPid, m.fromId, m.fromObfuscatedId]
    .filter((k) => k && k !== 0 && k !== '0')
    .map(String);
  for (const k of [...keys]) if (k.includes('@')) keys.push(k.split('@')[0]);
  return keys;
}

async function refreshNames(convId) {
  const sources = await Promise.all([
    lcu.get(`/lol-chat/v1/conversations/${encodeURIComponent(convId)}/participants`).catch(() => null),
    lcu.get('/lol-lobby/v2/lobby').then((l) => l?.members).catch(() => null),
    lcu.get('/lol-champ-select/v1/session').then((s) => s?.myTeam).catch(() => null),
    lcu.get('/lol-chat/v1/friends').catch(() => null),
  ]);
  for (const list of sources) for (const o of list || []) remember(o);
}

// Último recurso: preguntarle al cliente por ese jugador
async function lookup(keys) {
  for (const k of keys) {
    if (failed.has(k)) continue;
    let s = null;
    if (/^[0-9a-f-]{36,}$/i.test(k)) {
      s = await lcu.get(`/lol-summoner/v2/summoners/puuid/${encodeURIComponent(k)}`).catch(() => null);
    } else if (/^\d+$/.test(k)) {
      s = await lcu.get(`/lol-summoner/v1/summoners/${k}`).catch(() => null);
    }
    const name = displayName(s);
    if (name) {
      for (const kk of keys) known.set(kk, name);
      return name;
    }
    failed.add(k);
  }
  return null;
}

async function nameFor(m) {
  const keys = senderKeys(m);
  for (const k of keys) if (known.has(k)) return known.get(k);
  return lookup(keys);
}

let meCache = null;
async function me() {
  if (!meCache) meCache = await lcu.get('/lol-chat/v1/me').catch(() => null);
  return meCache || {};
}

async function read(phase) {
  const conv = await activeConversation(phase);
  if (!conv) return { available: false, messages: [] };

  const [msgs, self] = await Promise.all([
    lcu.get(`/lol-chat/v1/conversations/${encodeURIComponent(conv.id)}/messages`).catch(() => []),
    me(),
    refreshNames(conv.id),
  ]);
  const myKeys = new Set(senderKeys({ fromSummonerId: self.summonerId, fromPid: self.pid, fromId: self.id })
    .concat(self.puuid ? [String(self.puuid)] : []));

  const messages = [];
  for (const m of (msgs || []).slice(-60)) {
    const mine = senderKeys(m).some((k) => myKeys.has(k));
    const from = mine ? 'Tú' : (await nameFor(m)) || 'Jugador';
    let body = m.body;
    let system = m.type === 'system';
    if (system && body === 'joined_room') body = `${from} se unió al chat`;
    else if (system && body === 'left_room') body = `${from} salió del chat`;
    messages.push({ id: m.id, from, mine, system, body, time: m.timestamp });
  }

  return { available: true, type: conv.type, messages };
}

async function send(phase, body) {
  const text = String(body || '').trim().slice(0, 500);
  if (!text) throw new Error('Escribe un mensaje');
  const conv = await activeConversation(phase);
  if (!conv) throw new Error('No hay un chat abierto en este momento');
  const r = await lcu.request('POST', `/lol-chat/v1/conversations/${encodeURIComponent(conv.id)}/messages`, {
    body: text,
    type: 'chat',
  });
  if (r.status >= 400) throw new Error(r.json()?.message || 'El cliente no aceptó el mensaje');
  return { ok: true };
}

// Para el diagnóstico
async function conversations() {
  return (await lcu.get('/lol-chat/v1/conversations')) || [];
}

// Para el diagnóstico: de quién son los últimos mensajes (sin su texto)
async function sample(phase) {
  const conv = await activeConversation(phase);
  if (!conv) return null;
  const msgs = (await lcu.get(`/lol-chat/v1/conversations/${encodeURIComponent(conv.id)}/messages`).catch(() => [])) || [];
  return msgs.slice(-5).map(({ body, ...rest }) => ({ ...rest, body: '(oculto)' }));
}

module.exports = { read, send, conversations, sample };
