/* Admin page: APPLICATION-SPECIFIC code. Generic parts (api, polling, session...) are in ../js/utils.js.
   Session: the polling below is read-only and does NOT renew the cookie; every admin action does (server side). */
(function () {
  "use strict";
  const C = window.CONFIG || {};
  const $ = id => document.getElementById(id);
  const EXPIRED = "Session expirée, merci de vous reconnecter.";
  let expiresAt = 0, formLoaded = false, ttlTimer = null;

  const say = (text, bad) => { $("msg").textContent = text; $("msg").className = bad ? "bad" : "ok"; };

  /* ---------- Live view: what visitors currently see (read-only polling) ---------- */
  const poller = Utils.poll(async () => {
    const s = await Utils.api("api/state");   // no client id: the admin page is not counted as a viewer
    if (!formLoaded) { $("message").value = s.message; formLoaded = true; }   // the form is never overwritten afterwards
    $("live").textContent = `Affiché actuellement : « ${s.message} » · 👥 ${s.online} en ligne`;
  }, () => C.adminRefreshSeconds || 3);

  /* ---------- Views ---------- */
  function showLogin(text) {
    poller.stop();
    clearInterval(ttlTimer);
    formLoaded = false;
    $("panel-view").hidden = true;
    $("login-view").hidden = false;
    $("login-error").textContent = text || "";
    $("password").value = "";
    ($("username").value ? $("password") : $("username")).focus();
  }

  function showPanel() {
    $("login-view").hidden = true;
    $("panel-view").hidden = false;
    $("msg").textContent = "";
    poller.start();
    clearInterval(ttlTimer);
    ttlTimer = setInterval(tickTtl, 1000);
    tickTtl();
  }

  function tickTtl() {
    const left = expiresAt - Date.now();
    $("ttl").textContent = Utils.countdown(left);
    if (left <= 0) showLogin(EXPIRED);
  }

  /* ---------- Actions ---------- */
  async function action(name, body) {   // any successful action renews the cookie: the reply carries the new expiry
    try {
      const r = await Utils.api("admin/api/" + name, body || {});
      expiresAt = Utils.toLocal(r.expiresAt);
      tickTtl();
      return r;
    } catch (e) {
      if (e.status === 401) showLogin(EXPIRED);
      throw e;
    }
  }

  $("login-form").onsubmit = async e => {
    e.preventDefault();
    $("login-error").textContent = "";
    try {
      const r = await Utils.api("admin/api/login", { username: $("username").value, password: $("password").value });
      expiresAt = Utils.toLocal(r.expiresAt);
      showPanel();
    } catch (err) {
      $("login-error").textContent = err.status === 401 ? "Identifiants invalides."
        : err.status === 429 ? "Trop de tentatives, réessayez dans quelques minutes." : err.message;
    }
  };

  $("message-form").onsubmit = async e => {
    e.preventDefault();
    try { await action("setMessage", { message: $("message").value }); say("Enregistré ✓"); poller.now(); }
    catch (err) { if (err.status !== 401) say(err.status === 400 ? "Message invalide (1 à 500 caractères)." : err.message, true); }
  };

  $("logout").onclick = async () => {
    try { await Utils.api("admin/api/logout", {}); } catch (e) { /* the cookie expires anyway */ }
    showLogin("Vous êtes déconnecté.");
  };

  /* ---------- Start ---------- */
  Utils.onConnection(ok => { $("conn").hidden = ok; });
  Utils.session().then(s => {
    if (s.authenticated) { expiresAt = s.expiresAt; showPanel(); } else showLogin();
  }, err => showLogin(err.message));
})();
