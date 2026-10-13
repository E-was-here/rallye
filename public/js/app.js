(() => {
  "use strict";
  const C = window.CONFIG;
  const $ = (id) => document.getElementById(id);
  const UNITS = { points: "pts", km: "km", missions: "" };
  const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });

  let tab = "points";
  let state = null;
  let renderedKey = "";

  document.title = C.title;
  $("title").textContent = C.title;

  function render() {
    if (!state) return;
    const { totals, rankings } = state;
    $("totalKm").textContent = nf.format(totals.km);
    $("totalMissions").textContent = nf.format(totals.missions);
    $("missionsLabel").textContent = totals.missions > 1 ? "missions complétées" : "mission complétée";

    const rows = rankings[tab] || [];
    const key = tab + JSON.stringify(rows);
    if (key === renderedKey) return; // nothing changed: leave the DOM alone
    renderedKey = key;

    const list = $("ranking");
    list.replaceChildren();
    if (!rows.length) {
      const li = document.createElement("li");
      li.className = "g-empty";
      li.textContent = "Aucun participant pour l'instant.";
      list.append(li);
      return;
    }
    const max = Math.max(...rows.map((r) => r.value), 0);
    for (const r of rows) {
      const li = document.createElement("li");
      li.className = "g-row";
      if (r.rank <= 3 && r.value > 0) li.dataset.top = "1";
      li.style.setProperty("--fill", (max > 0 ? (r.value / max) * 100 : 0) + "%");

      const rank = document.createElement("span");
      rank.className = "g-rank";
      rank.textContent = r.rank;

      const name = document.createElement("span");
      name.className = "g-name";
      name.textContent = r.name;

      const value = document.createElement("span");
      value.className = "g-value";
      value.textContent = nf.format(r.value);
      if (UNITS[tab]) {
        const unit = document.createElement("small");
        unit.textContent = UNITS[tab];
        value.append(unit);
      }
      li.append(rank, name, value);
      list.append(li);
    }
  }

  function renderStatus() {
    $("updated").textContent = "Mis à jour à " + Utils.time(new Date());
    $("online").textContent = state.online != null ? `${state.online} en ligne` : "";
    $("warnings").textContent = (state.warnings || []).join(" ");
  }

  async function refresh() {
    try {
      state = await Utils.api("api/state?c=" + encodeURIComponent(Utils.clientId));
      render();
      renderStatus();
    } catch {
      // connection state is tracked by Utils and shown below
    }
    try {
      const ses = await Utils.session();
      $("adminBtn").hidden = !ses.authenticated;
    } catch {
      /* ignore */
    }
  }

  for (const btn of document.querySelectorAll(".g-tab")) {
    btn.addEventListener("click", () => {
      tab = btn.dataset.tab;
      for (const b of document.querySelectorAll(".g-tab")) b.setAttribute("aria-selected", String(b === btn));
      render();
    });
  }

  const showConnection = () => { $("offline").hidden = Utils.connected; };
  Utils.onConnection(showConnection);

  refresh();
  Utils.poll(refresh, () => C.stateRefreshSeconds).start();
})();
