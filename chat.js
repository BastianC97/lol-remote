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

// Nombres de quienes escriben (lobby, selección y amigos)
async function nameMap() {
  const map = new Map();
  const add = (id, name) => { if (id && name) map.set(String(id), name); };

  const lobby = await lcu.get('/lol-lobby/v2/lobby').catch(() => null);
  for (const m of lobby?.members || []) add(m.summonerId, m.gameName || m.summonerName);

  const cs = await lcu.get('/lol-champ-select/v1/session').catch(() => null);
  for (const p of cs?.myTeam || []) add(p.summonerId, p.gameName || p.summonerName);

  const friends = await lcu.get('/lol-chat/v1/friends').catch(() => null);
  for (const f of friends || []) add(f.summonerId, f.gameName || f.name);

  return map;
}

let meCache = null;
async function me() {
  if (!meCache) meCache = await lcu.get('/lol-chat/v1/me').catch(() => null);
  return meCache || {};
}

async function read(phase) {
  const conv = await activeConversation(phase);
  if (!conv) return { available: false, messages: [] };

  const [msgs, names, self] = await Promise.all([
    lcu.get(`/lol-chat/v1/conversations/${encodeURIComponent(conv.id)}/messages`).catch(() => []),
    nameMap(),
    me(),
  ]);

  const messages = (msgs || []).slice(-60).map((m) => {
    const mine = (self.summonerId && String(m.fromSummonerId) === String(self.summonerId))
      || (self.id && m.fromId === self.id);
    const from = mine ? 'Tú' : names.get(String(m.fromSummonerId)) || 'Jugador';
    let body = m.body;
    let system = m.type === 'system';
    if (system && body === 'joined_room') body = `${from} se unió al chat`;
    else if (system && body === 'left_room') body = `${from} salió del chat`;
    return { id: m.id, from, mine, system, body, time: m.timestamp };
  });

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

module.exports = { read, send, conversations };
