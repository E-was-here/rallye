"use strict";
// Game logic: missions are scored per participant, rankings by points / km / missions.
//  - Players live in config/players.json (hand-editable; also written by the admin "addPlayer" action).
//  - Missions are runtime data in data/missions.json.
// Every participant of a mission receives its full points and km. The global km total counts each mission once.

const fs = require("fs");
const path = require("path");

const PLAYERS_FILE = path.join(__dirname, "..", "config", "players.json");
const MISSIONS_FILE = "missions.json";
const MAX_PLAYERS = 500;
const MAX_MISSIONS = 5000;
const MAX_KM = 10000;
const MAX_POINTS = 100000;

let players = [];            // [{ id, name }]
let playersMtime = 0;        // mtime of players.json when last loaded (-1 = file missing)
let playersInvalid = false;  // players.json currently unreadable: previous list kept
let data = { nextId: 1, missions: [] }; // missions: [{ id, name, participants: [playerId], km, points, at }]
let cache = null;            // computed totals + rankings; null = dirty

const round2 = (n) => Math.round(n * 100) / 100;
const obj = (b) => (b && typeof b === "object" ? b : {});

function slug(s) {
  return (
    String(s)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "joueur"
  );
}

function uniqueId(base, taken) {
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

// Accepts [{ id?, name }] or ["Name", ...]; returns a clean list, or null if raw is not an array.
function normalizePlayers(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  const ids = new Set();
  for (const entry of raw) {
    const rawName = typeof entry === "string" ? entry : entry && entry.name;
    const name = String(rawName || "").trim().slice(0, 60);
    if (!name) continue;
    const rawId = entry && typeof entry.id === "string" ? entry.id : "";
    const id = uniqueId(/^[A-Za-z0-9_-]{1,64}$/.test(rawId) ? rawId : slug(name), ids);
    ids.add(id);
    out.push({ id, name });
  }
  return out;
}

function loadPlayers(ctx) {
  let st;
  try {
    st = fs.statSync(PLAYERS_FILE);
  } catch {
    if (playersMtime !== -1) ctx.log("config/players.json not found: empty player list");
    playersMtime = -1;
    return;
  }
  if (st.mtimeMs === playersMtime) return;
  playersMtime = st.mtimeMs;
  try {
    const list = normalizePlayers(JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8")));
    if (!list) throw new Error("must be a JSON array");
    players = list;
    playersInvalid = false;
    cache = null;
    ctx.log(`players.json loaded (${list.length} players)`);
  } catch (e) {
    playersInvalid = true;
    ctx.log("players.json ignored:", e.message);
  }
}

function savePlayers(list) {
  const text = "[\n" + list.map((p) => "  " + JSON.stringify({ id: p.id, name: p.name })).join(",\n") + "\n]\n";
  const tmp = PLAYERS_FILE + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, PLAYERS_FILE);
  playersMtime = fs.statSync(PLAYERS_FILE).mtimeMs;
  playersInvalid = false;
}

function saveMissions(ctx) {
  cache = null;
  ctx.writeJSON(MISSIONS_FILE, data);
}

function compute() {
  const stats = new Map(players.map((p) => [p.id, { id: p.id, name: p.name, points: 0, km: 0, missions: 0 }]));
  const unknown = new Set();
  let km = 0;
  for (const m of data.missions) {
    km += m.km;
    for (const id of m.participants) {
      const s = stats.get(id);
      if (!s) {
        unknown.add(id);
        continue;
      }
      s.points += m.points;
      s.km += m.km;
      s.missions += 1;
    }
  }
  // Competition ranking: equal values share a rank (1, 1, 3).
  const rank = (key) => {
    const rows = [...stats.values()]
      .map((s) => ({ id: s.id, name: s.name, value: round2(s[key]) }))
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "fr"));
    let prev = null;
    let pos = 0;
    rows.forEach((r, i) => {
      if (r.value !== prev) {
        pos = i + 1;
        prev = r.value;
      }
      r.rank = pos;
    });
    return rows;
  };
  return {
    totals: { km: round2(km), missions: data.missions.length },
    rankings: { points: rank("points"), km: rank("km"), missions: rank("missions") },
    unknown: unknown.size,
  };
}

function wantsFull(query) {
  if (!query) return false;
  if (typeof query.get === "function") return query.get("full") === "1";
  return query.full === "1";
}

// Validates and normalizes a mission payload (never trust the body).
function parseMission(ctx, body) {
  body = obj(body);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) throw ctx.fail(400, "Nom de tâche invalide (1 à 100 caractères).");

  if (!Array.isArray(body.participants) || body.participants.length === 0 || body.participants.length > MAX_PLAYERS) {
    throw ctx.fail(400, "Choisissez au moins un participant.");
  }
  const known = new Set(players.map((p) => p.id));
  const participants = [...new Set(body.participants)];
  if (!participants.every((id) => typeof id === "string" && known.has(id))) {
    throw ctx.fail(400, "Participant inconnu.");
  }

  const km = body.km;
  if (typeof km !== "number" || !Number.isFinite(km) || km < 0 || km > MAX_KM) {
    throw ctx.fail(400, `Kilomètres invalides (0 à ${MAX_KM}).`);
  }
  const points = body.points;
  if (!Number.isInteger(points) || points < 0 || points > MAX_POINTS) {
    throw ctx.fail(400, `Points invalides (entier de 0 à ${MAX_POINTS}).`);
  }
  return { name, participants, km: round2(km), points };
}

function findMission(ctx, id) {
  const m = Number.isInteger(id) ? data.missions.find((x) => x.id === id) : undefined;
  if (!m) throw ctx.fail(404, "Mission introuvable.");
  return m;
}

module.exports = {
  defaultSettings: () => ({}),

  init(ctx) {
    const saved = ctx.readJSON(MISSIONS_FILE, null);
    if (saved && Array.isArray(saved.missions)) {
      data = { nextId: 1, missions: saved.missions };
      const maxId = data.missions.reduce((mx, m) => Math.max(mx, m.id || 0), 0);
      data.nextId = Math.max(Number.isInteger(saved.nextId) ? saved.nextId : 1, maxId + 1);
    }
    loadPlayers(ctx);
    // players.json can be hand-edited while the server runs.
    setInterval(() => loadPlayers(ctx), 3000);
  },

  state(ctx, query) {
    if (!cache) cache = compute();
    const warnings = [];
    if (playersInvalid) warnings.push("players.json illisible : l'ancienne liste est conservée.");
    if (cache.unknown) warnings.push("Des missions citent des participants absents de players.json.");
    const out = { totals: cache.totals, rankings: cache.rankings, warnings };
    // Admin page asks for the full lists (/api/state?full=1); public pages do not.
    if (wantsFull(query)) {
      out.players = players;
      out.missions = data.missions;
    }
    return out;
  },

  admin: {
    addMission(ctx, body) {
      loadPlayers(ctx);
      if (data.missions.length >= MAX_MISSIONS) throw ctx.fail(400, "Limite de missions atteinte.");
      const parsed = parseMission(ctx, body);
      // `at` is the creation timecode (ms); edits never change it.
      const mission = { id: data.nextId++, ...parsed, at: Date.now() };
      data.missions.push(mission);
      saveMissions(ctx);
      return { mission };
    },

    updateMission(ctx, body) {
      loadPlayers(ctx);
      const m = findMission(ctx, obj(body).id);
      Object.assign(m, parseMission(ctx, body)); // id and at are kept
      saveMissions(ctx);
      return { mission: m };
    },

    deleteMission(ctx, body) {
      const m = findMission(ctx, obj(body).id);
      data.missions.splice(data.missions.indexOf(m), 1);
      saveMissions(ctx);
    },

    addPlayer(ctx, body) {
      loadPlayers(ctx);
      const name = typeof obj(body).name === "string" ? body.name.trim() : "";
      if (!name || name.length > 60) throw ctx.fail(400, "Nom invalide (1 à 60 caractères).");
      if (players.length >= MAX_PLAYERS) throw ctx.fail(400, "Limite de participants atteinte.");
      const lower = name.toLocaleLowerCase("fr");
      if (players.some((p) => p.name.toLocaleLowerCase("fr") === lower)) {
        throw ctx.fail(409, "Ce participant existe déjà.");
      }
      const player = { id: uniqueId(slug(name), new Set(players.map((p) => p.id))), name };
      const next = [...players, player];
      try {
        savePlayers(next);
      } catch (e) {
        ctx.log("cannot write players.json:", e.message);
        throw ctx.fail(500, "Impossible d'écrire config/players.json.");
      }
      players = next;
      cache = null;
      return { player };
    },
  },
};
