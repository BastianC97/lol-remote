// notifier.js — Notificaciones al celular con ntfy (https://ntfy.sh)
//
// ntfy es una app gratis (iPhone/Android). El celular se suscribe a un "tema"
// (un nombre secreto y aleatorio) y el PC publica mensajes en ese tema.
// Funciona con el celular bloqueado, sin la página abierta y desde cualquier red.
//
// Este módulo revisa el cliente de LoL cada segundo (aunque no haya ningún
// celular conectado) y avisa cuando:
//   - se encuentra partida (ReadyCheck)
//   - es tu turno de elegir o banear

const https = require('https');
const lcu = require('./lcu');

const NTFY_SERVER = process.env.NTFY_SERVER || 'https://ntfy.sh';

function send(topic, { title, message, priority = 4, tags = '', click = '' }) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${NTFY_SERVER}/${encodeURIComponent(topic)}`);
    const body = Buffer.from(message, 'utf8');
    const headers = {
      // Las cabeceras HTTP no aceptan tildes: ntfy permite codificarlas así
      Title: `=?UTF-8?B?${Buffer.from(title, 'utf8').toString('base64')}?=`,
      Priority: String(priority),
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
    };
    if (tags) headers.Tags = tags;
    if (click) headers.Click = click;

    const lib = url.protocol === 'http:' ? require('http') : https;
    const req = lib.request(url, { method: 'POST', headers, timeout: 8000 }, (res) => {
      res.resume();
      res.statusCode < 300 ? resolve() : reject(new Error(`ntfy respondió ${res.statusCode}`));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('ntfy no respondió')));
    req.end(body);
  });
}

// getTopic / getClickUrl son funciones para leer siempre la config actual
function startWatching({ getTopic, isEnabled, getClickUrl }) {
  let lastPhase = null;
  let lastTurnId = null;

  const notify = (opts) => {
    if (!isEnabled()) return;
    send(getTopic(), { ...opts, click: getClickUrl() })
      .catch((err) => console.log(`[Aviso] No se pudo enviar la notificación: ${err.message}`));
  };

  setInterval(async () => {
    let phase;
    try { phase = await lcu.get('/lol-gameflow/v1/gameflow-phase'); } catch { phase = null; }

    if (phase === 'ReadyCheck' && lastPhase !== 'ReadyCheck') {
      notify({
        title: '¡Partida encontrada!',
        message: 'Toca para aceptarla desde LoL Remote.',
        priority: 5,
        tags: 'rotating_light',
      });
    }

    if (phase === 'ChampSelect') {
      try {
        const s = await lcu.get('/lol-champ-select/v1/session');
        const me = s?.localPlayerCellId;
        const turn = (s?.actions || []).flat()
          .find((a) => a.actorCellId === me && a.isInProgress && !a.completed);
        if (turn && turn.id !== lastTurnId) {
          lastTurnId = turn.id;
          notify({
            title: turn.type === 'ban' ? '🚫 Tu turno de banear' : '⭐ Tu turno de elegir',
            message: 'Toca para abrir LoL Remote.',
            priority: 5,
            tags: turn.type === 'ban' ? 'no_entry' : 'star',
          });
        }
      } catch { /* ignorar */ }
    } else {
      lastTurnId = null;
    }

    lastPhase = phase;
  }, 1000);
}

module.exports = { send, startWatching };
