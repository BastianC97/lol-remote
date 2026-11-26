// lcu.js — Conexión con el cliente de League of Legends (LCU API)
//
// El cliente de LoL levanta un servidor HTTPS local (127.0.0.1) con un puerto
// y una contraseña que cambian cada vez que lo abres. Esos datos se pueden
// sacar de dos lugares:
//   1) El archivo "lockfile" en la carpeta de instalación de LoL.
//      Formato: LeagueClient:<pid>:<puerto>:<password>:https
//   2) Los argumentos con los que se ejecutó LeagueClientUx.exe
//      (--app-port=XXXX --remoting-auth-token=YYYY).
// La autenticación es Basic Auth con usuario "riot" y esa contraseña.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

// El certificado del cliente es autofirmado por Riot, por eso se desactiva
// la verificación SOLO para esta conexión local.
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

let creds = null; // { port, password }

function fromLockfile() {
  const candidates = [
    process.env.LOL_PATH && path.join(process.env.LOL_PATH, 'lockfile'),
    'C:\\Riot Games\\League of Legends\\lockfile',
    'D:\\Riot Games\\League of Legends\\lockfile',
    '/Applications/League of Legends.app/Contents/LoL/lockfile',
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      const [, , port, password] = fs.readFileSync(file, 'utf8').trim().split(':');
      if (port && password) return { port: Number(port), password };
    } catch { /* no existe, probar el siguiente */ }
  }
  return null;
}

function fromProcess() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object Name -eq 'LeagueClientUx.exe' | Select-Object -ExpandProperty CommandLine",
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const port = out.match(/--app-port=(\d+)/);
    const token = out.match(/--remoting-auth-token=([\w-]+)/);
    if (port && token) return { port: Number(port[1]), password: token[1] };
  } catch { /* cliente cerrado */ }
  return null;
}

let lastLookup = 0;
function getCreds() {
  if (creds) return creds;
  // No buscar más de una vez cada 3 s cuando el cliente está cerrado
  if (Date.now() - lastLookup < 3000) return null;
  lastLookup = Date.now();
  creds = fromLockfile() || fromProcess();
  if (creds) console.log(`[LCU] Cliente encontrado en el puerto ${creds.port}`);
  return creds;
}

// Hace una petición a la LCU. Devuelve { status, buffer, json() }.
function request(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const c = getCreds();
    if (!c) return reject(new Error('LCU_NOT_FOUND'));

    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = {
      Authorization: 'Basic ' + Buffer.from(`riot:${c.password}`).toString('base64'),
      Accept: 'application/json',
    };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = https.request(
      { host: '127.0.0.1', port: c.port, path: endpoint, method, agent, headers },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            buffer,
            json() {
              try { return JSON.parse(buffer.toString('utf8')); } catch { return null; }
            },
          });
        });
      }
    );
    req.on('error', (err) => {
      // Si el cliente se cerró o se reinició, olvidamos las credenciales
      creds = null;
      reject(err);
    });
    req.setTimeout(5000, () => req.destroy(new Error('LCU_TIMEOUT')));
    if (data) req.write(data);
    req.end();
  });
}

// Atajos: devuelven el JSON o null si falla
async function get(endpoint) {
  const r = await request('GET', endpoint);
  return r.status >= 200 && r.status < 300 ? r.json() : null;
}

module.exports = { request, get };
