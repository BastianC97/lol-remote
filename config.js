// config.js — Guarda la configuración en %APPDATA%\LoLRemote\config.json
// (así el código secreto se mantiene entre reinicios y el celular no tiene
// que volver a escanear el QR cada vez).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dir = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'LoLRemote');
const file = path.join(dir, 'config.json');

function newToken() {
  return crypto.randomBytes(18).toString('base64url'); // 24 caracteres
}

function newTopic() {
  // Nombre secreto y difícil de adivinar, ej: lolr-k3j9x2m8qp7d
  return 'lolr-' + crypto.randomBytes(10).toString('hex').slice(0, 14);
}

function load() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* primera vez */ }
  let changed = false;
  if (!cfg.token) { cfg.token = newToken(); changed = true; }
  if (!cfg.ntfyTopic) { cfg.ntfyTopic = newTopic(); changed = true; }
  if (cfg.ntfyEnabled === undefined) { cfg.ntfyEnabled = true; changed = true; }
  if (changed) save(cfg);
  return cfg;
}

function save(cfg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

module.exports = { dir, load, save, newToken, newTopic };
