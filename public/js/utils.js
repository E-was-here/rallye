/* Generic browser utilities shared by every page. No game logic. Exposed as window.Utils.
   Paths are relative to the SITE ROOT (e.g. "api/state"), so BASE_PATH needs no configuration. */
(function (global) {
  "use strict";
  // Site root relative to the current page, read from this script's own src: "js/utils.js" -> "", "../js/utils.js" -> "../"
  const ROOT = (document.currentScript.getAttribute("src") || "").replace(/js\/utils\.js.*$/, "");
  const U = { connected: true, skew: 0 };   // skew = server clock - browser clock (ms)
  const listeners = [];

  /* ---------- Connection state ---------- */
  U.onConnection = fn => listeners.push(fn);
  function setConnected(ok) {
    if (ok === U.connected) return;
    U.connected = ok;
    listeners.forEach(fn => fn(ok));
  }
  U.check = () => fetch(ROOT + "api/health", { cache: "no-store" }).then(r => { setConnected(r.ok); return r.ok; }, () => { setConnected(false); return false; });
  global.addEventListener("online", U.check);
  global.addEventListener("offline", () => setConnected(false));

  /* ---------- API: GET, or POST JSON when a body is given. Errors carry .status (HTTP) or .offline ---------- */
  U.api = async function (path, body) {
    const post = body !== undefined;
    let res;
    try {
      res = await fetch(ROOT + path, { method: post ? "POST" : "GET", cache: "no-store", credentials: "same-origin",
        headers: post ? { "Content-Type": "application/json" } : {}, body: post ? JSON.stringify(body) : undefined });
    } catch (e) {
      setConnected(false);
      const err = new Error("Serveur injoignable");
      err.offline = true;
      throw err;
    }
    setConnected(![502, 503, 504].includes(res.status));   // 502-504: reverse proxy with no server behind it
    const data = await res.json().catch(() => null);
    if (data && typeof data.serverTime === "number") U.skew = data.serverTime - Date.now();
    if (!res.ok) {
      const err = new Error((data && data.error) || "HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    return data;
  };

  /* ---------- Periodic refresh: no overlap, interval re-read each cycle, paused while the tab is hidden ---------- */
  U.poll = function (task, getSeconds) {
    let timer = null, stopped = true, running = false;
    async function tick() {
      if (stopped || running) return;
      running = true;
      if (!document.hidden) { try { await task(); } catch (e) { if (!e.offline) console.warn(e); } }
      running = false;
      if (!stopped) timer = setTimeout(tick, Math.max(1, getSeconds()) * 1000);
    }
    const now = () => { if (stopped) return; clearTimeout(timer); tick(); };
    document.addEventListener("visibilitychange", () => { if (!document.hidden) now(); });
    return { start() { if (!stopped) return; stopped = false; tick(); }, stop() { stopped = true; clearTimeout(timer); }, now };
  };

  /* ---------- Admin session (the cookie is HttpOnly: only the server can tell) ---------- */
  U.toLocal = serverMs => serverMs - U.skew;   // server timestamp -> browser clock
  U.session = async () => {
    const s = await U.api("admin/api/session");
    return { authenticated: s.authenticated, expiresAt: s.authenticated ? U.toLocal(s.expiresAt) : 0 };
  };

  /* ---------- Anonymous id for the "online" counter ---------- */
  U.clientId = (() => {
    const gen = () => (global.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      let id = localStorage.getItem("clientId");
      if (!id) { id = gen(); localStorage.setItem("clientId", id); }
      return id;
    } catch (e) { return gen(); }
  })();

  /* ---------- Formatting ---------- */
  U.time = d => new Date(d).toLocaleTimeString("fr-FR");
  U.countdown = ms => {
    const t = Math.max(0, Math.floor(ms / 1000));
    return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
  };

  global.Utils = U;
})(window);
