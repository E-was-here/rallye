"use strict";
/* Generic server: static files, /config.js, public state, cookie-protected admin API, settings hot reload.
   ALL game logic lives in game.js (its header comment documents the contract). Nothing game-specific here. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const CONFIG = path.join(ROOT, "config");
const CONFIG_FILE = path.join(CONFIG, "config.js");
const PORT = +process.env.PORT || 3000;
const BASE = (process.env.BASE_PATH || "").replace(/\/+$/, "");   // e.g. "/mygame" or ""
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");   // set it to keep sessions across restarts
if (ADMIN_PASSWORD.length < 8) {
  console.error("Set ADMIN_PASSWORD (8+ characters) in .env before starting.");
  process.exit(1);
}

/* ---------- Config: the same file the browser loads (window.CONFIG) ---------- */
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(CONFIG_FILE, "utf8"), sandbox);
const C = sandbox.window.CONFIG || {};
const SESSION_MS = (C.adminSessionSeconds || 1800) * 1000;

/* ---------- Files ---------- */
fs.mkdirSync(DATA, { recursive: true });
const file = n => path.join(DATA, n);
function readJSON(n, fallback) { try { return JSON.parse(fs.readFileSync(file(n), "utf8")); } catch (e) { return fallback; } }
function writeJSON(n, obj) { fs.writeFileSync(file(n) + ".tmp", JSON.stringify(obj)); fs.renameSync(file(n) + ".tmp", file(n)); }

/* ---------- Game (game logic) ---------- */
let settings = readJSON("settings.json", null);   // hand-edited by organisers, hot-reloaded
let settingsMtime = 0, settingsError = false;
const clients = new Map();                         // anonymous viewer id -> last seen (ms)
const ONLINE_MS = Math.max(15, 3 * (C.stateRefreshSeconds || 3)) * 1000;
function onlineCount() {
  const limit = Date.now() - ONLINE_MS;
  let n = 0;
  for (const [id, t] of clients) { if (t < limit) clients.delete(id); else n++; }
  return n;
}
const ctx = {
  C,
  get settings() { return settings; },
  readJSON, writeJSON,
  online: onlineCount,
  log: (...a) => console.log(new Date().toISOString(), ...a),
  fail: (status, message) => Object.assign(new Error(message), { status }),
};
const H = require("./game.js");

if (!settings) {
  settings = H.defaultSettings ? H.defaultSettings(ctx) : {};
  fs.writeFileSync(file("settings.json"), JSON.stringify(settings, null, 2));
}
settingsMtime = fs.statSync(file("settings.json")).mtimeMs;

function checkSettings() {
  let m;
  try { m = fs.statSync(file("settings.json")).mtimeMs; } catch (e) { return; }
  if (m === settingsMtime) return;
  settingsMtime = m;
  const next = readJSON("settings.json", null);
  settingsError = !next;
  if (!next) return;                               // invalid JSON: keep the previous version
  const prev = settings;
  settings = next;
  try { if (H.onSettings) H.onSettings(ctx, next, prev); } catch (e) { console.error(e); }
}

function touchClient(id) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id || "")) return;
  if (!clients.has(id) && clients.size >= 5000) return;   // memory cap against abuse
  clients.set(id, Date.now());
}

/* ---------- Admin auth: signed cookie holding only its expiry, renewed on every admin action ---------- */
const COOKIE = "admin_session";
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const sign = s => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
const failures = new Map();
// last X-Forwarded-For entry = the one added by your own proxy (the first can be forged)
const clientIp = req => (req.headers["x-forwarded-for"] || "").split(",").pop().trim() || req.socket.remoteAddress;

function setCookie(req, res, value, maxAge) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=${BASE || "/"}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}
function issueSession(req, res) {
  const exp = Date.now() + SESSION_MS;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  setCookie(req, res, `${payload}.${sign(payload)}`, Math.round(SESSION_MS / 1000));
  return exp;
}
function getSession(req) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try { const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString()); return exp > Date.now() ? { exp } : null; } catch (e) { return null; }
}

function login(req, res, body) {
  const ip = clientIp(req), f = failures.get(ip) || { count: 0, until: 0 };
  if (f.until > Date.now()) return send(res, 429, { error: "Too many failed attempts. Try again in a few minutes." });
  const okU = crypto.timingSafeEqual(sha(body.username ?? ""), sha(ADMIN_USER));
  const okP = crypto.timingSafeEqual(sha(body.password ?? ""), sha(ADMIN_PASSWORD));
  if (okU && okP) { failures.delete(ip); ctx.log(ip, "LOGIN"); return send(res, 200, { ok: true, expiresAt: issueSession(req, res) }); }
  f.count++;
  if (f.count >= 5) { f.until = Date.now() + 5 * 60000; f.count = 0; }
  if (failures.size > 1000) failures.clear();
  failures.set(ip, f);
  ctx.log(ip, "FAILED LOGIN");
  send(res, 401, { error: "Invalid username or password" });
}

/* ---------- HTTP ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function send(res, code, body) {
  const isObj = typeof body === "object";
  res.writeHead(code, { "Content-Type": isObj ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(isObj ? JSON.stringify(body) : body);
}

function serveStatic(res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch (e) { return send(res, 400, "Bad request"); }
  if (rel.includes("\0")) return send(res, 400, "Bad request");
  let p = path.normalize(path.join(PUBLIC, rel));
  if (p !== PUBLIC && !p.startsWith(PUBLIC + path.sep)) return send(res, 403, "Forbidden");
  fs.stat(p, (err, st) => {
    if (!err && st.isDirectory()) p = path.join(p, "index.html");
    fs.readFile(p, (err2, data) => {
      if (err2) return send(res, 404, "Not found");
      const ext = path.extname(p).toLowerCase();
      const isImg = [".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(ext);
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": isImg ? "public, max-age=300" : "no-cache", "X-Content-Type-Options": "nosniff" });
      res.end(data);
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, big = false; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size <= 10000) chunks.push(c);
      else if (!big) { big = true; reject(new Error("Body too large")); }   // keep draining so the reply can be sent
    });
    req.on("end", () => {
      if (big) return;
      try { const b = JSON.parse(Buffer.concat(chunks).toString() || "{}"); resolve(b && typeof b === "object" ? b : {}); }
      catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

async function adminApi(req, res, p) {
  const name = p.slice("/admin/api/".length);
  if (req.headers["x-forwarded-proto"] === "http") return send(res, 403, { error: "Admin requires HTTPS" });
  if (name === "session" && req.method === "GET") {   // read-only: does not renew the TTL
    const s = getSession(req);
    return send(res, 200, { authenticated: !!s, expiresAt: s ? s.exp : null, serverTime: Date.now() });
  }
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  // anti-CSRF (on top of SameSite=Strict): same origin + JSON only
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (req.headers.origin) {
    let oh = null;
    try { oh = new URL(req.headers.origin).host; } catch (e) {}
    if (oh !== host) return send(res, 403, { error: "Bad origin" });
  }
  if (!(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "JSON required" });
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }

  if (name === "login") return login(req, res, body);
  if (name === "logout") { setCookie(req, res, "", 0); return send(res, 200, { ok: true }); }
  if (!getSession(req)) return send(res, 401, { error: "Not signed in" });
  const fn = H.admin && Object.hasOwn(H.admin, name) ? H.admin[name] : null;
  if (typeof fn !== "function") return send(res, 404, { error: "Unknown action" });
  const exp = issueSession(req, res);                 // any admin action renews the TTL
  try {
    const out = await fn(ctx, body);
    ctx.log(clientIp(req), "ADMIN", name);
    return send(res, 200, { ok: true, ...(out && typeof out === "object" ? out : {}), expiresAt: exp });
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.message });
    throw e;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x");
    let p = u.pathname;
    if (BASE) {
      if (p === BASE) { res.writeHead(301, { Location: BASE + "/" }); return res.end(); }
      if (p.startsWith(BASE + "/")) p = p.slice(BASE.length);   // strip the prefix, the rest is unchanged
    }
    if (p === "/admin") { res.writeHead(301, { Location: BASE + "/admin/" }); return res.end(); }
    if (p.startsWith("/admin/api/")) return await adminApi(req, res, p);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    if (p === "/api/health") return send(res, 200, { ok: true });
    if (p === "/api/state") {
      touchClient(u.searchParams.get("c"));
      const s = (H.state && await H.state(ctx, Object.fromEntries(u.searchParams))) || {};
      const warnings = [...(s.warnings || [])];
      if (settingsError) warnings.push("settings.json has a syntax error (previous version kept)");
      return send(res, 200, { ...s, serverTime: Date.now(), online: onlineCount(), warnings });
    }
    if (p === "/config.js") {
      return fs.readFile(CONFIG_FILE, (e, d) => {
        if (e) return send(res, 404, "Not found");
        res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-cache" });
        res.end(d);
      });
    }
    return serveStatic(res, p);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, "Server error");
  }
});

/* ---------- Start ---------- */
if (H.init) H.init(ctx);
setInterval(checkSettings, 3000);
server.listen(PORT, () => ctx.log(`Server running on port ${PORT}${BASE ? " (base " + BASE + ")" : ""}`));
