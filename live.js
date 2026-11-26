// live.js — Datos de la partida en curso (Live Client Data API).
//
// Mientras juegas, el propio juego (no el cliente) levanta una API oficial
// de solo lectura en https://127.0.0.1:2999/liveclientdata/...
// Es la que usan los overlays de streamers. No necesita contraseña.
// Muestra lo mismo que ves con la tecla Tab: no da información oculta.

const https = require('https');
const lcu = require('./lcu');

const PORT = Number(process.env.LIVE_PORT) || 2999;
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function get(path) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: '127.0.0.1', port: PORT, path, agent, timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`LIVE_${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('LIVE_TIMEOUT')));
  });
}

// ---------- Datos estáticos desde el cliente (para íconos) ----------
let champByKey = null; // "ahri" -> 103
let itemIcons = null;  // 3031 -> "/lol-game-data/assets/..."
async function loadStatic() {
  if (!champByKey) {
    const list = await lcu.get('/lol-game-data/assets/v1/champion-summary.json').catch(() => null);
    if (list) {
      champByKey = new Map();
      for (const c of list) {
        if (c.id <= 0) continue;
        // Si hay versiones repetidas (ej. LoL Classic), quedarse con el ID más bajo
        for (const k of [c.alias, c.name]) {
          const key = String(k || '').toLowerCase();
          if (key && (!champByKey.has(key) || c.id < champByKey.get(key))) champByKey.set(key, c.id);
        }
      }
    }
  }
  if (!itemIcons) {
    const items = await lcu.get('/lol-game-data/assets/v1/items.json').catch(() => null);
    if (items) itemIcons = new Map(items.map((i) => [i.id, i.iconPath]));
  }
}

function champId(p) {
  if (!champByKey) return 0;
  const raw = String(p.rawChampionName || '').replace('game_character_displayname_', '').toLowerCase();
  return champByKey.get(raw) || champByKey.get(String(p.championName || '').toLowerCase()) || 0;
}

const DRAGONS = { Fire: 'Infernal', Water: 'del Océano', Earth: 'de Montaña', Air: 'de Nube', Hextech: 'Hextech', Chemtech: 'Quimtech', Elder: 'Ancestral' };

const names = (p) => [p.riotId, p.riotIdGameName, p.summonerName].filter(Boolean);

// ---------- Resumen para el celular ----------
async function summary() {
  let d;
  try {
    d = await get('/liveclientdata/allgamedata');
  } catch {
    return { inGame: false }; // pantalla de carga o no hay partida
  }
  await loadStatic();

  const players = d.allPlayers || [];
  const active = d.activePlayer || {};
  const meP = players.find((p) => names(p).some((n) => names(active).includes(n)));
  const myTeam = meP?.team || 'ORDER';

  // Equipo de cada jugador según su nombre (para atribuir dragones, barones, etc.)
  const teamOf = new Map();
  for (const p of players) for (const n of names(p)) teamOf.set(n, p.team);
  const nameOf = (n) => {
    const p = players.find((x) => names(x).includes(n));
    return p ? (p.riotIdGameName || p.summonerName || n) : n;
  };

  const obj = () => ({ kills: 0, dragons: [], barons: 0, heralds: 0, grubs: 0, towers: 0, inhibs: 0 });
  const teams = { ORDER: obj(), CHAOS: obj() };
  const feed = [];
  let result = null;

  for (const e of d.events?.Events || []) {
    const killerTeam = teamOf.get(e.KillerName);
    switch (e.EventName) {
      case 'ChampionKill': {
        const victimTeam = teamOf.get(e.VictimName);
        const t = victimTeam === 'ORDER' ? 'CHAOS' : victimTeam === 'CHAOS' ? 'ORDER' : killerTeam;
        if (t) teams[t].kills += 1;
        feed.push({ t: e.EventTime, text: `${nameOf(e.KillerName)} mató a ${nameOf(e.VictimName)}`, ally: t === myTeam });
        break;
      }
      case 'DragonKill':
        if (killerTeam) teams[killerTeam].dragons.push(e.DragonType);
        feed.push({ t: e.EventTime, text: `Dragón ${DRAGONS[e.DragonType] || e.DragonType || ''}${e.Stolen === 'True' ? ' (robado)' : ''}`, ally: killerTeam === myTeam });
        break;
      case 'BaronKill':
        if (killerTeam) teams[killerTeam].barons += 1;
        feed.push({ t: e.EventTime, text: 'Barón Nashor', ally: killerTeam === myTeam });
        break;
      case 'HeraldKill':
        if (killerTeam) teams[killerTeam].heralds += 1;
        break;
      case 'HordeKill':
        if (killerTeam) teams[killerTeam].grubs += 1;
        break;
      case 'TurretKilled': {
        // Turret_T1_... es una torre del equipo ORDER: el punto es para CHAOS
        const t = /_T1_/.test(e.TurretKilled) ? 'CHAOS' : /_T2_/.test(e.TurretKilled) ? 'ORDER' : null;
        if (t) teams[t].towers += 1;
        break;
      }
      case 'InhibKilled': {
        const t = /_T1_/.test(e.InhibKilled) ? 'CHAOS' : /_T2_/.test(e.InhibKilled) ? 'ORDER' : null;
        if (t) teams[t].inhibs += 1;
        break;
      }
      case 'GameEnd':
        result = e.Result; // "Win" / "Lose"
        break;
      default:
    }
  }

  const mapP = (p) => ({
    name: p.riotIdGameName || p.summonerName || '',
    championId: champId(p),
    championName: p.championName,
    isMe: p === meP,
    level: p.level,
    kills: p.scores?.kills ?? 0,
    deaths: p.scores?.deaths ?? 0,
    assists: p.scores?.assists ?? 0,
    cs: p.scores?.creepScore ?? 0,
    wards: Math.round(p.scores?.wardScore ?? 0),
    isDead: !!p.isDead,
    respawn: Math.ceil(p.respawnTimer || 0),
    position: p.position || '',
    items: (p.items || [])
      .filter((i) => i.slot <= 6)
      .sort((a, b) => a.slot - b.slot)
      .map((i) => ({ id: i.itemID, name: i.displayName, icon: itemIcons?.get(i.itemID) || null, count: i.count })),
  });

  const enemyTeam = myTeam === 'ORDER' ? 'CHAOS' : 'ORDER';
  const st = active.championStats || {};

  return {
    inGame: true,
    time: Math.floor(d.gameData?.gameTime || 0),
    mode: d.gameData?.gameMode || '',
    result,
    ally: { ...teams[myTeam], players: players.filter((p) => p.team === myTeam).map(mapP) },
    enemy: { ...teams[enemyTeam], players: players.filter((p) => p.team === enemyTeam).map(mapP) },
    me: {
      level: active.level,
      gold: Math.floor(active.currentGold || 0),
      stats: {
        hp: `${Math.round(st.currentHealth || 0)}/${Math.round(st.maxHealth || 0)}`,
        ad: Math.round(st.attackDamage || 0),
        ap: Math.round(st.abilityPower || 0),
        armor: Math.round(st.armor || 0),
        mr: Math.round(st.magicResist || 0),
        as: Number(st.attackSpeed || 0).toFixed(2),
        haste: Math.round(st.abilityHaste || 0),
        ms: Math.round(st.moveSpeed || 0),
        crit: Math.round((st.critChance || 0) * 100),
      },
    },
    feed: feed.slice(-6).reverse(),
  };
}

// Para el aviso de "la partida comenzó"
async function events() {
  const d = await get('/liveclientdata/eventdata');
  return d.Events || [];
}

module.exports = { summary, events };
