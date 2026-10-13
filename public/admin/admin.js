(() => {
  "use strict";
  const C = window.CONFIG;
  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });

  let expiresAt = 0; // browser clock (ms)
  let players = [];
  let missions = [];
  let editingId = null;
  let playersKey = "";
  let missionsKey = "";
  const selected = new Set(); // participant ids ticked in the mission form

  document.title = "Administration – " + C.title;

  const errText = (e) => (e && e.offline ? "Serveur injoignable." : (e && e.message) || "Erreur inattendue.");
  function say(el, text, isErr) {
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }

  // ---- screens -------------------------------------------------------------
  function showLogin(msg) {
    $("panel").hidden = true;
    $("login").hidden = false;
    $("loginError").textContent = msg || "";
  }
  function showPanel() {
    $("login").hidden = true;
    $("panel").hidden = false;
  }

  // ---- data refresh (read-only calls: they never renew the session) -------
  async function refresh() {
    const ses = await Utils.session();
    if (!ses.authenticated) {
      showLogin($("panel").hidden ? "" : "Session expirée : reconnectez-vous.");
      return;
    }
    expiresAt = ses.expiresAt;
    const s = await Utils.api("api/state?full=1");
    showPanel();
    players = s.players || [];
    missions = s.missions || [];

    const pk = JSON.stringify(players);
    if (pk !== playersKey) {
      playersKey = pk;
      const ids = new Set(players.map((p) => p.id));
      for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
      renderPlayers();
    }
    const mk = pk + JSON.stringify(missions); // names are resolved through players
    if (mk !== missionsKey) {
      missionsKey = mk;
      renderMissions();
    }
  }
  async function safeRefresh() {
    try {
      await refresh();
    } catch {
      /* connection state is tracked by Utils */
    }
  }

  // Admin action: renews the session; a 401 sends the user back to the login form.
  async function act(name, body) {
    try {
      const r = await Utils.api("admin/api/" + name, body);
      if (r.expiresAt) expiresAt = Utils.toLocal(r.expiresAt);
      await safeRefresh();
      return r;
    } catch (e) {
      if (e.status === 401) {
        showLogin("Session expirée : reconnectez-vous.");
        return null;
      }
      throw e;
    }
  }

  // ---- participants picker -------------------------------------------------
  function updateCount() {
    const n = selected.size;
    $("selCount").textContent = n === 0 ? "Aucun participant choisi" : n === 1 ? "1 participant choisi" : `${n} participants choisis`;
  }
  function renderPlayers() {
    const f = $("filter").value.trim().toLowerCase();
    const box = $("playerList");
    box.replaceChildren();
    if (!players.length) {
      const p = document.createElement("div");
      p.className = "g-count";
      p.style.padding = "10px";
      p.textContent = "Aucun participant : ajoutez-en un ci-dessous.";
      box.append(p);
    }
    for (const p of players) {
      if (f && !p.name.toLowerCase().includes(f)) continue;
      const label = document.createElement("label");
      label.className = "g-check";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(p.id);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(p.id);
        else selected.delete(p.id);
        updateCount();
      });
      label.append(cb, p.name);
      box.append(label);
    }
    updateCount();
  }
  $("filter").addEventListener("input", renderPlayers);

  // ---- missions list -------------------------------------------------------
  function renderMissions() {
    const names = new Map(players.map((p) => [p.id, p.name]));
    const list = $("missions");
    list.replaceChildren();
    if (!missions.length) {
      const li = document.createElement("li");
      li.className = "g-count";
      li.textContent = "Aucune mission encodée.";
      list.append(li);
      return;
    }
    for (const m of [...missions].reverse()) {
      const li = document.createElement("li");
      li.className = "g-mission";

      const info = document.createElement("div");
      const h = document.createElement("h3");
      h.textContent = m.name;
      const meta = document.createElement("p");
      const when = new Date(m.at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
      meta.textContent = `${nf.format(m.km)} km, ${nf.format(m.points)} pts, ${when}`;
      const who = document.createElement("p");
      who.textContent = m.participants.map((id) => names.get(id) || id + " (inconnu)").join(", ");
      info.append(h, meta, who);

      const actions = document.createElement("div");
      actions.className = "g-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "g-btn";
      edit.textContent = "Modifier";
      edit.addEventListener("click", () => startEdit(m));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "g-btn g-btn-danger";
      del.textContent = "Supprimer";
      del.addEventListener("click", () => removeMission(m));
      actions.append(edit, del);

      li.append(info, actions);
      list.append(li);
    }
  }

  // ---- mission form ----------------------------------------------------------
  function resetForm() {
    editingId = null;
    $("missionForm").reset();
    selected.clear();
    $("formTitle").textContent = "Encoder une mission";
    $("mSubmit").textContent = "Enregistrer la mission";
    $("mCancel").hidden = true;
    renderPlayers();
  }
  function startEdit(m) {
    editingId = m.id;
    const known = new Set(players.map((p) => p.id));
    selected.clear();
    for (const id of m.participants) if (known.has(id)) selected.add(id);
    $("mName").value = m.name;
    $("mKm").value = m.km;
    $("mPoints").value = m.points;
    $("filter").value = "";
    $("formTitle").textContent = `Modifier la mission n°${m.id}`;
    $("mSubmit").textContent = "Enregistrer les modifications";
    $("mCancel").hidden = false;
    say($("missionMsg"), "");
    renderPlayers();
    $("formTitle").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("mCancel").addEventListener("click", () => {
    resetForm();
    say($("missionMsg"), "");
  });

  $("missionForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("mSubmit");
    btn.disabled = true; // avoid double submissions
    const body = {
      name: $("mName").value,
      participants: [...selected],
      km: Number($("mKm").value),
      points: Number($("mPoints").value),
    };
    const editing = editingId !== null;
    if (editing) body.id = editingId;
    try {
      const r = await act(editing ? "updateMission" : "addMission", body);
      if (r) {
        resetForm();
        say($("missionMsg"), editing ? "Mission modifiée." : "Mission enregistrée.");
      }
    } catch (e) {
      say($("missionMsg"), errText(e), true);
    } finally {
      btn.disabled = false;
    }
  });

  async function removeMission(m) {
    if (!confirm(`Supprimer la mission « ${m.name} » ?`)) return;
    try {
      const r = await act("deleteMission", { id: m.id });
      if (r && editingId === m.id) resetForm();
    } catch (e) {
      alert(errText(e));
    }
  }

  // ---- add participant ---------------------------------------------------------
  $("playerForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("pSubmit");
    btn.disabled = true;
    try {
      const r = await act("addPlayer", { name: $("pName").value });
      if (r) {
        $("pName").value = "";
        say($("playerMsg"), `${r.player.name} ajouté.`);
      }
    } catch (e) {
      say($("playerMsg"), errText(e), true);
    } finally {
      btn.disabled = false;
    }
  });

  // ---- login / logout / session ----------------------------------------------------
  $("loginForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const r = await Utils.api("admin/api/login", { username: $("user").value, password: $("pass").value });
      $("pass").value = "";
      expiresAt = Utils.toLocal(r.expiresAt);
      await safeRefresh();
    } catch (e) {
      $("loginError").textContent =
        e.status === 401 ? "Identifiants invalides." :
        e.status === 429 ? "Trop d'essais : réessayez dans quelques minutes." :
        errText(e);
    }
  });
  $("logout").addEventListener("click", async () => {
    try {
      await Utils.api("admin/api/logout", {});
    } catch {
      /* ignore */
    }
    showLogin();
  });

  setInterval(() => {
    $("countdown").textContent = Utils.countdown(Math.max(0, expiresAt - Date.now()));
  }, 1000);
  Utils.onConnection(() => { $("offline").hidden = Utils.connected; });

  safeRefresh();
  Utils.poll(safeRefresh, () => C.adminRefreshSeconds).start();
})();
