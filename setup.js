// setup.js — Página de configuración (/setup) con los QR para el celular.
// Solo se puede abrir desde el mismo PC: nadie de la red ni del túnel
// puede verla, porque ahí se muestra el código secreto.

const os = require('os');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');
const QRCode = require('qrcode');
const lcu = require('./lcu');
const config = require('./config');
const tunnel = require('./tunnel');
const notifier = require('./notifier');

// IPs de la red local (WiFi / Ethernet), ignorando adaptadores virtuales
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|tailscale|zerotier|hamachi|radmin/i.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const private_ = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      if (private_) out.push({ name, address: a.address });
    }
  }
  // Primero las que suelen ser el router de la casa
  return out.sort((a, b) => (b.address.startsWith('192.168.') ? 1 : 0) - (a.address.startsWith('192.168.') ? 1 : 0));
}

// Solo peticiones hechas desde este mismo PC, directas (no por el túnel)
function isLocal(req, port) {
  const ip = req.socket.remoteAddress || '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const viaProxy = req.get('cf-connecting-ip') || req.get('cf-ray') || req.get('x-forwarded-for');
  const host = (req.get('host') || '').toLowerCase();
  const goodHost = host === `localhost:${port}` || host === `127.0.0.1:${port}`;
  return loopback && !viaProxy && goodHost;
}

const STORES = {
  ios: 'https://apps.apple.com/app/ntfy/id1625396347',
  android: 'https://play.google.com/store/apps/details?id=io.heckel.ntfy',
};
let storeQr = null;

function mount(app, { cfg, port }) {
  const onlyLocal = (req, res, next) => {
    if (isLocal(req, port)) return next();
    res.status(403).send('Esta página solo se puede abrir desde el PC donde corre LoL Remote.');
  };
  // Las acciones exigen un header propio: así otra página web no puede
  // dispararlas a escondidas desde tu navegador.
  const needHeader = (req, res, next) => (req.get('x-setup') === '1' ? next() : res.status(403).end());

  app.get('/setup/ping', (req, res) => res.json({ app: 'lol-remote' }));

  app.get('/setup', onlyLocal, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'setup.html'));
  });

  app.get('/setup/info', onlyLocal, async (req, res) => {
    const link = (base) => `${base}/#k=${cfg.token}`;
    const lan = await Promise.all(lanAddresses().map(async (a) => {
      const url = link(`http://${a.address}:${port}`);
      return { label: a.name, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 280 }) };
    }));

    let tun = { ...tunnel.state };
    if (tun.url) {
      const url = link(tun.url);
      tun = { ...tun, link: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 280 }) };
    }

    let lol = false;
    try { lol = (await lcu.get('/lol-gameflow/v1/gameflow-phase')) !== null; } catch { lol = false; }

    res.json({
      lan, tunnel: tun, lolConnected: lol,
      ntfy: { topic: cfg.ntfyTopic, enabled: cfg.ntfyEnabled, stores: await getStoreQr() },
    });
  });

  app.post('/setup/tunnel/start', onlyLocal, needHeader, (req, res) => {
    tunnel.start(port);
    res.json({ ok: true });
  });
  app.post('/setup/tunnel/stop', onlyLocal, needHeader, (req, res) => {
    tunnel.stop();
    res.json({ ok: true });
  });
  // Genera códigos nuevos: los celulares tendrán que escanear de nuevo
  // y suscribirse al nuevo tema de notificaciones
  app.post('/setup/reset', onlyLocal, needHeader, (req, res) => {
    cfg.token = config.newToken();
    cfg.ntfyTopic = config.newTopic();
    config.save(cfg);
    res.json({ ok: true });
  });

  // Diagnóstico: descarga lo que el cliente está entregando ahora mismo,
  // para revisar modos de juego nuevos o raros. No incluye el código secreto.
  app.get('/setup/debug', onlyLocal, async (req, res) => {
    const grab = async (fn) => { try { return await fn(); } catch (e) { return { error: e.message }; } };
    const data = {
      generado: new Date().toISOString(),
      phase: await grab(() => lcu.get('/lol-gameflow/v1/gameflow-phase')),
      gameflow: await grab(() => lcu.get('/lol-gameflow/v1/session')),
      champSelect: await grab(() => lcu.get('/lol-champ-select/v1/session')),
      live: await grab(() => require('./live').summary()),
      chats: await grab(async () => (await require('./chat').conversations()).map((c) => ({ id: c.id, type: c.type, name: c.name }))),
      chatMensajes: await grab(async () => require('./chat').sample(await lcu.get('/lol-gameflow/v1/gameflow-phase'))),
    };
    res.set('Content-Disposition', 'attachment; filename="lolremote-diagnostico.json"');
    res.json(data);
  });

  // Notificaciones
  app.post('/setup/ntfy/toggle', onlyLocal, needHeader, (req, res) => {
    cfg.ntfyEnabled = !cfg.ntfyEnabled;
    config.save(cfg);
    res.json({ enabled: cfg.ntfyEnabled });
  });
  app.post('/setup/ntfy/test', onlyLocal, needHeader, async (req, res) => {
    try {
      await notifier.send(cfg.ntfyTopic, {
        title: '✅ LoL Remote funciona',
        message: 'Así te avisaré cuando encuentre partida.',
        priority: 4,
        tags: 'white_check_mark',
        click: clickUrl(cfg, port),
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// Link que se abre al tocar la notificación (sin el código secreto:
// el celular ya lo tiene guardado)
function clickUrl(cfg, port) {
  if (tunnel.state.url) return tunnel.state.url + '/';
  const lan = lanAddresses()[0];
  return lan ? `http://${lan.address}:${port}/` : '';
}

async function getStoreQr() {
  if (!storeQr) {
    storeQr = {
      ios: await QRCode.toDataURL(STORES.ios, { margin: 1, width: 160 }),
      android: await QRCode.toDataURL(STORES.android, { margin: 1, width: 160 }),
    };
  }
  return storeQr;
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => { /* si falla, la consola ya muestra el link */ });
}

function isRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/setup/ping', timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(body.includes('lol-remote')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

module.exports = { mount, openBrowser, isRunning, clickUrl };
