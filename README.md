# Node.js game site template

A small, **dependency-free** Node.js template for live "game" sites (dashboards shown on a screen, played from phones):
a public page that polls the server, plus a password-protected admin page. All game logic lives in **one file**
(`server/game.js`); everything else is generic and reusable.

- Zero npm dependencies (Node built-ins only), no build step. Runs in the stock `node:22-alpine` image with the repo bind-mounted.
- Built to sit behind a reverse proxy, under a sub-path (`/<GAME_NAME>/`).
- UI text is in **French**; code, comments and docs are in **English**.

> **Using this README as a briefing for Claude:** paste it together with the files you want changed (at least
> `server/game.js`, `config/config.js`, and the page files involved) and the game rules. See "Asking Claude for a game" at the end.

## Layout

```
.env                    secrets and per-site values (git-ignored)
compose.yaml            container definition (reverse-proxy setup)
compose.override.yaml   local-only: publishes the port (git-ignored)
config/config.js        window.CONFIG: shared by server AND browser (served at /config.js)
data/                   runtime files (git-ignored): settings.json, saved game state
server/server.js        GENERIC server. Do not put game logic here
server/game.js          ALL game logic: state, rules, timers, admin actions
public/index.html       public page          (loads config.js, js/utils.js, js/app.js)
public/js/app.js        public page logic    (game-specific)
public/js/utils.js      generic browser utilities, shared by every page
public/admin/index.html admin page           (login form + panel)
public/admin/admin.js   admin page logic     (game-specific)
public/css/style.css    shared dark theme
```

## Run it

Requirements: Docker Desktop (Windows/macOS) or Docker + Compose (Linux). Node is not needed on the host.

`.env` (next to `compose.yaml`, UTF-8):

```env
GAME_NAME=todo
PORT=3000
ADMIN_USER=admin
ADMIN_PASSWORD=at-least-8-characters
SESSION_SECRET=a-long-random-string
```

| Variable | Required | Meaning |
|---|---|---|
| `GAME_NAME` | yes (compose) | Container/project name `scouts-<GAME_NAME>` and URL prefix `/<GAME_NAME>` |
| `PORT` | yes | Port the server listens on |
| `ADMIN_USER` | no (`admin`) | Admin username |
| `ADMIN_PASSWORD` | yes | **8+ characters**, otherwise the server refuses to start |
| `SESSION_SECRET` | recommended | Signs the admin cookie. If empty, a random one is generated at each start and everyone is signed out on restart |

`compose.yaml`:

```yaml
name: scouts-${GAME_NAME:?GAME_NAME must be set in .env}

services:
  game:
    image: docker.io/library/node:22-alpine
    container_name: scouts-${GAME_NAME}
    working_dir: /app
    command: node server/server.js
    restart: unless-stopped
    volumes:
      - ./:/app
    environment:
      PORT: ${PORT}
      ADMIN_USER: ${ADMIN_USER:-admin}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD}
      SESSION_SECRET: ${SESSION_SECRET:-}
      BASE_PATH: /${GAME_NAME}
    networks:
      - proxy-net

networks:
  proxy-net:
    external: true
```

`compose.override.yaml` (local only, merged automatically):

```yaml
services:
  game:
    ports:
      - "${PORT}:${PORT}"
```

First run (PowerShell or any shell, from the project folder):

```
docker network create proxy-net        # once: the network is declared external
docker compose up -d
docker compose logs -f game
```

Then open `http://localhost:<PORT>/<GAME_NAME>/` (public) and `http://localhost:<PORT>/<GAME_NAME>/admin/` (admin).

| Task | Command |
|---|---|
| Restart after editing `server/*.js` or `config/config.js` | `docker compose restart game` |
| Edit `public/*` | just refresh the browser (no restart) |
| Stop | `docker compose down` |
| Reset the game | delete `data/*.json` and restart |

Without Docker (Node 18+): `ADMIN_PASSWORD=... node server/server.js` (PowerShell: `$env:ADMIN_PASSWORD="..."; node server/server.js`),
served at `http://localhost:3000/` with no prefix.

## Configuration: `config/config.js`

Plain data assigned to `window.CONFIG`. **The same file** is read by the server (once, at startup, via `vm`) and served to browsers at `/config.js`.
It is therefore public: never put secrets in it.

```js
window.CONFIG = {
  title: "Tableau de bord",
  stateRefreshSeconds: 10,    // public page poll rate; also sets the "online viewers" window (max(15, 3x) seconds)
  adminRefreshSeconds: 3,     // admin page poll rate
  adminSessionSeconds: 1800   // admin cookie lifetime, renewed on every admin action
  // ...game-specific keys
};
```

The server reads `adminSessionSeconds` and `stateRefreshSeconds`; pages read `title` and both refresh rates; any other key is free for the game.
**Restart after editing**: browsers see changes immediately but the server only at startup.

## Server contract: `server/game.js`

`server.js` is generic (static files, `/config.js`, state endpoint, admin auth, `settings.json` hot reload) and calls this module.

```js
module.exports = {
  defaultSettings(ctx) -> object   // optional. Written to data/settings.json when missing (organisers hand-edit it)
  init(ctx)                        // optional. Once at startup: load saved state, start setInterval timers
  onSettings(ctx, next, prev)      // optional. settings.json was hand-edited (checked every 3 s; invalid JSON is ignored)
  state(ctx, query) -> object      // GET /api/state: public, polled by every browser. Cheap, JSON-safe, NO secrets.
                                   //   Server adds { serverTime, online, warnings }; return warnings: string[] to add yours.
  admin: { name(ctx, body) }       // POST /admin/api/<name>, valid admin cookie required. body = parsed JSON (<= 10 KB).
}                                  //   May return an object merged into { ok: true, expiresAt, ... }. Sync or async.
                                   //   Reject with: throw ctx.fail(400, "message") -> { error: "message" } with that status.
                                   //   Never trust body: validate everything (types, ids, ranges).
ctx = {
  C                                // window.CONFIG (read-only)
  settings                         // live object from data/settings.json; replaced on reload: always read ctx.settings, never cache it
  readJSON(name, fallback), writeJSON(name, obj)   // files in data/ (e.g. "state.json"), atomic writes
  online() -> number               // anonymous viewers seen recently
  log(...args)                     // timestamped console.log
  fail(status, message) -> Error
}
```

Persistence rule: keep the game state in **one object**, save it with `ctx.writeJSON` after every change, reload it in `init()`.
Store a signature of the config parts that matter so a changed config resets stale saved state.

The current file is a demo (a message editable from admin). Its shape, as a style reference:

```js
let content;
module.exports = {
  defaultSettings: () => ({ epoch: 1 }),
  init(ctx) { content = ctx.readJSON("content.json", null) || { message: "Bonjour", updatedAt: Date.now() }; },
  state: () => content,
  admin: {
    setMessage(ctx, body) {
      const m = typeof body.message === "string" ? body.message.trim() : "";
      if (!m || m.length > 500) throw ctx.fail(400, "Invalid message");
      content = { message: m, updatedAt: Date.now() };
      ctx.writeJSON("content.json", content);
    },
  },
};
```

## HTTP API

All paths below are relative to the site root, i.e. `/<GAME_NAME>/` in production.

| Route | Auth | Notes |
|---|---|---|
| `GET /api/state?c=<clientId>` | public | `{ ...game.state(), serverTime, online, warnings }`. `c` (8-64 chars `[A-Za-z0-9_-]`) feeds the online counter; omit it for non-viewers (the admin page does) |
| `GET /api/health` | public | `{ ok: true }` |
| `GET /config.js` | public | the config file |
| `GET /admin/api/session` | public | `{ authenticated, expiresAt, serverTime }`. Never renews the cookie |
| `POST /admin/api/login` | public | `{ username, password }` -> `{ ok, expiresAt }` + cookie. 401 invalid, 429 locked out |
| `POST /admin/api/logout` | public | clears the cookie |
| `POST /admin/api/<action>` | cookie | runs `game.admin[action]`. 401 not signed in, 404 unknown action, handler errors as `{ error }` |
| anything else | public | static files from `public/` (`/admin` redirects to `/admin/`) |

`expiresAt` and `serverTime` are server timestamps in ms; the browser corrects with `Utils.skew` / `Utils.toLocal()`.

## Admin security model

- Cookie `admin_session`: HMAC-SHA256 signed token containing only its expiry. `HttpOnly`, `SameSite=Strict`, `Path=/<GAME_NAME>`,
  `Secure` when the proxy sends `X-Forwarded-Proto: https`. JavaScript cannot read it: pages ask `GET admin/api/session`.
- **TTL** = `adminSessionSeconds`, **renewed on every admin action** (`POST /admin/api/<action>` with a valid cookie). Read-only polling
  (`session`, `state`) does **not** renew it.
- Admin POSTs require `Content-Type: application/json`, and an `Origin` (when present) equal to the host. Bodies are capped at 10 KB.
- Login: 5 failures per client IP -> 5 minute lockout. Client IP = last `X-Forwarded-For` entry (the one your proxy appends).
- Requests with `X-Forwarded-Proto: http` are refused on `/admin/api/*`: admin requires HTTPS behind the proxy.
- The admin **HTML/JS files are public** (needed to show the login form); only `/admin/api/*` is protected.
  Never put secrets in `public/`.

## Browser side

`public/js/utils.js` (loaded by every page, exposes `window.Utils`) is generic; page scripts contain only page logic.

| Utils | Purpose |
|---|---|
| `api(path[, body])` | JSON call, path relative to the site root (`"api/state"`); a `body` makes it a POST. Throws errors with `.status` (HTTP) or `.offline` |
| `poll(task, getSeconds)` | returns `{ start, stop, now }`; no overlapping runs, interval re-read each cycle, paused while the tab is hidden |
| `session()` | `{ authenticated, expiresAt }` with `expiresAt` on the browser clock |
| `toLocal(serverMs)`, `skew` | server -> browser clock |
| `connected`, `onConnection(fn)`, `check()` | connection state, updated by every `api` call |
| `clientId` | anonymous id stored in `localStorage` |
| `time(d)`, `countdown(ms)` | `fr-FR` time, `mm:ss` |

Current pages: the public page shows the title, the message, a status block (last update, online count, warnings, "server unreachable")
and an **Admin** button that appears only while an admin cookie is valid. The admin page shows a login form, then a panel
(session countdown, message editor, live read-only view, sign out). A 401 from any action returns to the login form.

Rules for page code:
- **Every URL must be relative** (`api/state`, `admin/`, `../`), never `/api/...`, so the `/<GAME_NAME>` prefix keeps working.
  Inside `public/admin/`, links and script paths go up with `../`; API paths still go through `Utils.api` (relative to the site root).
- Render server-provided strings with `textContent` (or escape them before `innerHTML`).
- Visual style lives in `css/style.css` (CSS variables in `:root`); keep UI text in French.

## Gotchas

- `server.js` reads `config.js` once: **restart** after editing it (browsers get the new file immediately, the server does not).
- Code is bind-mounted: there is no image to rebuild, and `docker compose up -d` will not restart a running container.
  Use `docker compose restart game`.
- `GET /api/state` is public and polled by every screen: keep `state()` cheap and free of secrets.
- Sessions are lost on restart unless `SESSION_SECRET` is set.
- The reverse proxy must forward `Host` (or `X-Forwarded-Host`), `X-Forwarded-For` (appended) and `X-Forwarded-Proto`.
- `data/` is git-ignored and created on demand; the server writes JSON atomically (`*.tmp` then rename).

## Asking Claude for a game

Provide, in one message: this README, the current `server/game.js` and `config/config.js`, the page files to change, and:

1. the game rules (what players do, what is computed, what time-based events happen);
2. the data shape the pages should display (or let Claude propose it);
3. the admin actions needed (what an organiser can do, with which inputs);
4. which values belong in `config.js` (tunable numbers, names, colours) and which in `settings.json` (hand-edited live).

Working agreements for Claude: keep zero dependencies; put game logic in `game.js` and leave `server.js` generic unless a change
is truly generic; never trust request bodies; return **complete changed files** with their paths (a zip is fine); test the server with
curl and the pages in jsdom when possible; list anything that needs a restart.
