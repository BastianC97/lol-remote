// tunnel.js — Acceso "fuera de casa" con Cloudflare Quick Tunnel.
//
// cloudflared crea un link público y aleatorio (https://xxxx.trycloudflare.com)
// que redirige al servidor de tu PC. No necesita cuenta ni abrir puertos.
// La primera vez se descarga cloudflared.exe desde el GitHub oficial de Cloudflare.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const config = require('./config');

const isWin = process.platform === 'win32';
const exe = path.join(config.dir, 'bin', isWin ? 'cloudflared.exe' : 'cloudflared');
const downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/' +
  (isWin ? 'cloudflared-windows-amd64.exe' : 'cloudflared-linux-amd64');

const state = { status: 'off', url: null, error: null, progress: 0 };
let child = null;

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Demasiadas redirecciones'));
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Descarga falló (${res.statusCode})`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let done = 0;
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.on('data', (d) => {
        done += d.length;
        if (total) state.progress = Math.round((done / total) * 100);
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        fs.renameSync(tmp, dest);
        if (!isWin) fs.chmodSync(dest, 0o755);
        resolve();
      }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function start(port) {
  if (child || state.status === 'downloading' || state.status === 'starting') return;
  state.error = null;
  state.url = null;
  try {
    if (!fs.existsSync(exe)) {
      state.status = 'downloading';
      state.progress = 0;
      fs.mkdirSync(path.dirname(exe), { recursive: true });
      await download(downloadUrl, exe);
    }
    state.status = 'starting';
    child = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      windowsHide: true,
    });

    const onOutput = (buf) => {
      const m = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !state.url) {
        state.url = m[0];
        state.status = 'on';
        console.log(`[Túnel] Acceso fuera de casa activo: ${state.url}`);
      }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.on('exit', (code) => {
      child = null;
      state.url = null;
      if (state.status !== 'off') {
        state.status = 'error';
        state.error = `El túnel se cerró (código ${code}). Intenta activarlo de nuevo.`;
      }
    });
    child.on('error', (err) => {
      state.status = 'error';
      state.error = err.message;
    });

    // Si en 40 s no hay link, algo falló (firewall, sin internet, etc.)
    setTimeout(() => {
      if (state.status === 'starting') {
        stop();
        state.status = 'error';
        state.error = 'No se pudo crear el túnel. Revisa tu conexión a internet.';
      }
    }, 40000);
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
  }
}

function stop() {
  state.status = 'off';
  state.url = null;
  if (child) {
    child.kill();
    child = null;
  }
}

// Al cerrar el programa, cerrar también el túnel
for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (child) child.kill();
    if (sig !== 'exit') process.exit(0);
  });
}

module.exports = { state, start, stop };
