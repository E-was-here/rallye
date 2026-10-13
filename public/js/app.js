/* Public page: APPLICATION-SPECIFIC code. Generic parts (api, polling, session...) are in utils.js. */
(function () {
  "use strict";
  const C = window.CONFIG || {};
  const $ = id => document.getElementById(id);
  let S = null, lastFetch = null, adminUntil = 0;   // adminUntil: admin cookie expiry (browser clock), 0 = not signed in

  /* ---------- App ---------- */
  function renderApp() { $("message").textContent = S.message; }

  /* ---------- Page chrome: status lines + admin button ---------- */
  function renderStatus() {
    const el = $("status");
    el.replaceChildren();
    const add = (text, warn) => { const d = document.createElement("div"); d.textContent = text; if (warn) d.className = "warn"; el.append(d); };
    if (S) add(`Dernière mise à jour : ${Utils.time(lastFetch)} · 👥 ${S.online ?? "?"} en ligne`);
    ((S && S.warnings) || []).forEach(w => add("⚠ " + w, true));
    if (!Utils.connected) add("⚠ Serveur injoignable (dernières données affichées)", true);
    $("admin-btn").hidden = Date.now() >= adminUntil;
  }

  async function checkAdmin() {
    try { adminUntil = (await Utils.session()).expiresAt; } catch (e) { adminUntil = 0; }
    renderStatus();
  }

  async function refresh() {
    S = await Utils.api("api/state?c=" + encodeURIComponent(Utils.clientId));
    lastFetch = new Date();
    renderApp();
    renderStatus();
  }

  /* ---------- Start ---------- */
  if (C.title) { document.title = C.title; $("title").textContent = C.title; }
  Utils.onConnection(renderStatus);
  Utils.poll(refresh, () => C.stateRefreshSeconds || 3).start();
  checkAdmin();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkAdmin(); });   // e.g. signed in from another tab
  setInterval(renderStatus, 1000);                                                                 // hides the button when the session expires
})();
