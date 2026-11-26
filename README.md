# LoL Remote

Desde el celular puedes aceptar partidas, pickear y banear campeones, cambiar hechizos y runas, y ver qué eligió cada jugador en League of Legends. También te llega una notificación cuando se encuentra partida o cuando es tu turno.

**[⬇️ Descargar LoLRemote.exe](https://github.com/BastianC97/lol-remote/releases/latest)** (Windows, no necesita instalar nada)

> Proyecto no oficial. No está afiliado ni respaldado por Riot Games.

```
Celular (navegador)  ──HTTP──►  server.js en tu PC  ──HTTPS──►  Cliente de LoL (LCU API)
```

## 1. Para tus amigos (sin programar nada)
Pásales **`LoLRemote.exe`** y **`LEEME.txt`**. Solo tienen que:
1. Abrir el cliente de LoL.
2. Hacer doble clic en `LoLRemote.exe`. Si sale "Windows protegió su PC", elegir **Más información → Ejecutar de todas formas**.
3. Escanear con el celular el QR que se abre en el navegador.

## 2. Para desarrollar (tú)
```bash
npm install
npm start            # o doble clic en iniciar.bat
npm run build        # genera dist/LoLRemote.exe
```
Al arrancar se abre `http://localhost:3000/setup` con los QR.

## 3. Cómo se conecta el celular
- **Código secreto**: se genera solo la primera vez y se guarda en `%APPDATA%\LoLRemote\config.json`. Va dentro del QR (`http://IP:3000/#k=CODIGO`) y el celular lo guarda, así que no hay que escribir ningún PIN. El botón "Generar códigos nuevos" lo cambia.
- **Mismo WiFi**: el QR usa la IP local del PC, que el programa detecta solo.
- **Desde cualquier lugar**: el botón del túnel descarga `cloudflared.exe` (oficial de Cloudflare, desde GitHub) y crea un link `https://xxxx.trycloudflare.com`. No necesita cuenta ni abrir puertos.
- **Notificaciones**: `notifier.js` revisa el cliente cada segundo y publica en ntfy.sh (tema secreto `lolr-...` guardado en la config) cuando aparece el ReadyCheck o cuando es tu turno de pick o ban. El celular se suscribe a ese tema con la app ntfy.
- **Página /setup**: solo se abre desde el mismo PC. Se bloquea si la piden desde la red, por el túnel o con otro dominio, porque ahí aparece el código.

## 4. Cómo funciona (para que lo entiendas y lo extiendas)

### `lcu.js`: conexión con el cliente
Cada vez que abres LoL, el cliente levanta un servidor HTTPS en `127.0.0.1`. El puerto y la contraseña cambian en cada inicio y quedan escritos en el `lockfile`:
```
LeagueClient:12345:54321:Abc123Password:https
             pid   puerto  contraseña
```
Las peticiones usan Basic Auth con usuario `riot` y esa contraseña. El certificado es autofirmado, por eso se desactiva la verificación TLS **solo** para esa conexión local.

### `server.js`: la API para el celular
| Ruta del celular | Endpoint LCU que llama | Qué hace |
|---|---|---|
| `GET /api/state` | `/lol-gameflow/v1/gameflow-phase` + otros según la fase | Estado actual (el celular lo consulta cada 1 s) |
| `POST /api/accept` | `POST /lol-matchmaking/v1/ready-check/accept` | Aceptar partida |
| `POST /api/decline` | `POST /lol-matchmaking/v1/ready-check/decline` | Rechazar partida |
| `POST /api/queue/start` / `stop` | `/lol-lobby/v2/lobby/matchmaking/search` | Buscar o cancelar la búsqueda |
| `POST /api/champ` | `PATCH /lol-champ-select/v1/session/actions/{id}` | Hover, pick o ban (`completed: true` confirma) |
| `POST /api/spells` | `PATCH /lol-champ-select/v1/session/my-selection` | Hechizos de invocador |
| `GET/POST /api/runes` | `/lol-perks/v1/pages`, `PUT /lol-perks/v1/currentpage` | Ver y elegir página de runas |
| `POST /api/bench` | `POST /lol-champ-select/v1/session/bench/swap/{id}` | ARAM: tomar campeón de la banca |
| `POST /api/reroll` | `POST /lol-champ-select/v1/session/my-selection/reroll` | ARAM: reroll |
| `POST /api/swap` | `POST /lol-champ-select/v1/session/{trades\|swaps\|position-swaps}/{id}/{request\|accept\|decline\|cancel}` | Intercambiar campeón, orden de pick o rol |
| `GET /api/live` | `https://127.0.0.1:2999/liveclientdata/allgamedata` | Estadísticas de la partida en curso |
| `GET /api/img` | `/lol-game-data/assets/...` | Íconos de campeones y hechizos |

Fases de `gameflow-phase`: `None` → `Lobby` → `Matchmaking` → `ReadyCheck` → `ChampSelect` → `InProgress` → ...

Sobre la selección de campeón (`/lol-champ-select/v1/session`):
- `localPlayerCellId` indica quién eres tú.
- `actions` es una lista de turnos (pick o ban). Tu turno es el que tiene `actorCellId === localPlayerCellId` e `isInProgress === true`.
- `myTeam` y `theirTeam` muestran el campeón de cada jugador (`championId`) y su intención (`championPickIntent`).

### `live.js`: estadísticas en partida
Durante la partida, el **juego** (no el cliente) levanta una API oficial de solo lectura en `https://127.0.0.1:2999/liveclientdata/`, la misma que usan los overlays. De ahí salen el tiempo, las kills, los objetivos, el nivel, el K/D/A, el CS y los ítems de cada jugador, además de tus stats. Es lo mismo que muestra la tecla Tab. El evento `GameStart` indica que terminó la pantalla de carga, y con eso se manda el aviso "La partida comenzó".

### Modos de juego
- **Draft / Clasificatoria / A ciegas**: turnos de `actions` (pick/ban).
- **ARAM y modos aleatorios**: `benchEnabled`, `benchChampions` y `rerollsRemaining`. No hay turnos: cambias con la banca o haces reroll.
- **Intercambios** (`trades`, `pickOrderSwaps`, `positionSwaps`): aparecen como botones en cada aliado cuando el cliente los permite.
- Si un modo no se comporta bien, abre `/setup` y pulsa **"Descargar diagnóstico"** durante la selección. El archivo trae lo que entrega el cliente.

### `public/`: la web del celular
HTML, CSS y JavaScript sin frameworks. `app.js` consulta `/api/state` cada segundo y muestra la pantalla que corresponde a la fase. Cuando se encuentra una partida, el celular vibra y suena un pitido.

## 5. Para explorar más endpoints
- El cliente tiene documentación interna. Con el cliente abierto, `GET /help?format=Full` (con la misma autenticación) lista todos los endpoints.
- Herramientas de la comunidad: **Needlework** y **LCU Explorer** te dejan probar endpoints de forma visual, al estilo Postman.
- Tutoriales y recursos: https://hextechdocs.dev

## 6. Ideas para seguir
- **Editar runas** (no solo elegir una página): `PUT /lol-perks/v1/pages/{id}` con `primaryStyleId`, `subStyleId` y `selectedPerkIds`. Los árboles disponibles salen de `/lol-perks/v1/styles`.
- **Tiempo real con WebSocket**: la LCU acepta `wss://127.0.0.1:<puerto>/` y emite eventos (`[5, "OnJsonApiEvent"]`) en vez de hacer polling.
- Cambiar skin (`selectedSkinId` en `my-selection`) y tomar campeones de la banca en ARAM.

## ⚠️ Avisos
- La LCU API no es oficial. Riot tolera herramientas que la usan (Blitz, Porofessor, etc.), pero puede cambiar sin aviso.
- No dejes partidas aceptadas si no vas a llegar a tiempo: te pueden penalizar por dodge o AFK.
- No compartas el QR. Para acceder desde fuera usa el túnel; no abras el puerto 3000 en tu router.
