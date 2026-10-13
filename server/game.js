"use strict";
/* =====================================================================================================
   GAME CONTRACT. To get a game.js written, paste THIS comment + the game rules + config/config.js.
   Stack: Node >= 18, zero dependencies (built-ins only), CommonJS, double quotes, compact style, English comments.

   server.js is generic (never edit it): static files from public/, /config.js, GET /api/state, POST /admin/api/<name>,
   admin cookie auth, hot reload of data/settings.json. THIS file holds ALL game logic and exports:

   module.exports = {
     defaultSettings(ctx) -> object   // optional. Written to data/settings.json when missing (organisers hand-edit it)
     init(ctx)                        // optional. Once at startup: load saved state, start setInterval timers
     onSettings(ctx, next, prev)      // optional. settings.json was hand-edited (checked every 3 s; invalid JSON is ignored)
     state(ctx, query) -> object      // GET /api/state, public, polled by every browser: keep it cheap, JSON-safe, no secrets.
                                      //   Server adds { serverTime, online, warnings }; return warnings: string[] to add yours.
     admin: { name(ctx, body) }       // POST /admin/api/<name>, only with a valid admin cookie. body = parsed JSON (<= 10 KB).
   }                                  //   May return an object merged into { ok: true, expiresAt, ... }. Sync or async.
                                      //   Reject with: throw ctx.fail(400, "message") -> { error: "message" } with that status.
                                      //   Never trust body: validate everything (types, ids, ranges).
   ctx = {
     C                                // window.CONFIG from config/config.js (same file as the browser). Read-only.
     settings                         // live object from data/settings.json. Replaced on reload: always read ctx.settings, never cache it.
     readJSON(name, fallback), writeJSON(name, obj)   // files in data/ (name like "state.json"), atomic writes
     online() -> number               // anonymous viewers seen recently
     log(...args)                     // timestamped console.log
     fail(status, message) -> Error
   }
   Config keys read by server/pages: stateRefreshSeconds, adminRefreshSeconds, adminSessionSeconds (cookie TTL, default 1800).
   Any other key is free for the game.
   Persistence: keep the game state in ONE object, save it with ctx.writeJSON after each change, reload it in init().
   Store a signature of the config parts that matter so a changed config resets stale saved state.
   Admin pages (browser): POST /admin/api/login {username,password} | /logout ; GET /admin/api/session -> { authenticated,
   expiresAt, serverTime }. Every successful action reply carries expiresAt (renewed TTL). HTTP 401 = signed out.
   To request: game rules + config.js shape + the /api/state shape the pages expect + the admin actions needed.
   ===================================================================================================== */

let content;   // demo state: replace with the game

module.exports = {
  defaultSettings: () => ({ epoch: 1 }),

  init(ctx) {
    content = ctx.readJSON("content.json", null) || { message: "Hello! Edit me from /admin/.", updatedAt: Date.now() };
  },

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
