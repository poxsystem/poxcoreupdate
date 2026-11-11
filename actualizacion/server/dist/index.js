// src/async-patch.ts
import Layer from "express/lib/router/layer.js";
var proto = Layer.prototype;
if (!Object.getOwnPropertyDescriptor(proto, "handle")) {
  Object.defineProperty(proto, "handle", {
    enumerable: true,
    get() {
      return this.__handle;
    },
    set(fn) {
      if (typeof fn === "function" && fn.length <= 3) {
        const orig = fn;
        fn = ((req, res, next) => {
          Promise.resolve(orig(req, res, next)).catch(next);
        });
      }
      this.__handle = fn;
    }
  });
}

// src/index.ts
import cors from "cors";
import express from "express";
import fs7 from "node:fs";
import os2 from "node:os";
import path7 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/routes/teams.ts
import { Router } from "express";

// src/prisma.ts
import { PrismaClient } from "@prisma/client";
var prisma = new PrismaClient();

// src/auth.ts
import crypto from "node:crypto";
var RANK = { visita: 0, anotador: 1, admin: 2 };
var TOKEN_TTL_MS = 30 * 24 * 36e5;
function hashPassword(pass) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(pass, salt, 64).toString("hex")}`;
}
function checkPassword(pass, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const cand = crypto.scryptSync(pass, salt, 64);
  const real = Buffer.from(hash, "hex");
  return cand.length === real.length && crypto.timingSafeEqual(cand, real);
}
async function issueToken(userId) {
  return prisma.authToken.create({
    data: { token: crypto.randomBytes(24).toString("hex"), userId, expiresAt: new Date(Date.now() + TOKEN_TTL_MS) }
  });
}
var cache = null;
function invalidateAuthCache() {
  cache = null;
}
async function authEnabled() {
  try {
    if (!cache || Date.now() - cache.at > 1e4) cache = { n: await prisma.user.count(), at: Date.now() };
    return cache.n > 0;
  } catch {
    return cache ? cache.n > 0 : true;
  }
}
async function reqUser(req) {
  const tok = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  const t = await prisma.authToken.findUnique({ where: { token: tok }, include: { user: true } });
  return t && t.expiresAt > /* @__PURE__ */ new Date() && t.user.active ? t.user : null;
}
async function adminOk(pass) {
  if (!pass) return { ok: false, error: "Clave de administrador requerida", code: 401 };
  const admins = await prisma.user.findMany({ where: { role: "admin", active: true } });
  if (admins.length) {
    return admins.some((u) => checkPassword(pass, u.passHash)) ? { ok: true } : { ok: false, error: "Clave de administrador incorrecta", code: 401 };
  }
  const envKey = process.env.ADMIN_KEY?.trim();
  if (!envKey) return { ok: false, error: "No hay clave de admin configurada \u2014 crea un usuario admin en \u{1F465} Usuarios", code: 503 };
  return pass === envKey ? { ok: true } : { ok: false, error: "Clave de administrador incorrecta", code: 401 };
}
function guard(min) {
  return async (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    if (!await authEnabled()) return next();
    const tok = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!tok) return res.status(401).json({ error: "Sesi\xF3n requerida" });
    const t = await prisma.authToken.findUnique({ where: { token: tok }, include: { user: true } });
    if (!t || t.expiresAt < /* @__PURE__ */ new Date() || !t.user.active) return res.status(401).json({ error: "Sesi\xF3n inv\xE1lida o expirada" });
    if ((RANK[t.user.role] ?? 0) < RANK[min]) return res.status(403).json({ error: `Requiere rol ${min}` });
    req.user = t.user;
    next();
  };
}

// src/routes/teams.ts
var r = Router();
r.get("/", async (_req, res) => {
  const teams = await prisma.team.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { players: true } }, league: { select: { name: true, year: true } } }
  });
  res.json(teams);
});
r.post("/", async (req, res) => {
  const { name, shortName, color, division, leagueId } = req.body;
  if (!name) return res.status(400).json({ error: "name requerido" });
  const team = await prisma.team.create({ data: { name, shortName, color, division: division || null, leagueId: leagueId || null } });
  res.status(201).json(team);
});
r.get("/:id", async (req, res) => {
  const team = await prisma.team.findUnique({
    where: { id: req.params.id },
    // alfabético por apellido — al anotar se arma el lineup del pool del
    // roster y el orden por número de camisa lo volvía imposible de buscar
    include: { players: { orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { number: "asc" }] } }
  });
  if (!team) return res.status(404).json({ error: "Equipo no encontrado" });
  res.json(team);
});
r.put("/:id", async (req, res) => {
  const { name, shortName, color, division, leagueId, lineupTemplate } = req.body;
  const team = await prisma.team.update({ where: { id: req.params.id }, data: { name, shortName, color, division, leagueId, lineupTemplate } });
  res.json(team);
});
r.put("/:id/block", async (req, res) => {
  const { blocked } = req.body;
  const t = await prisma.team.update({ where: { id: req.params.id }, data: { blocked: !!blocked } });
  res.json(t);
});
r.delete("/:id", async (req, res) => {
  const auth = await adminOk(String(req.body?.password ?? ""));
  if (!auth.ok) return res.status(auth.code ?? 401).json({ error: auth.error });
  try {
    await prisma.team.delete({ where: { id: req.params.id } });
  } catch {
    return res.status(404).json({ error: "Equipo no encontrado" });
  }
  res.status(204).end();
});
r.post("/:id/players", async (req, res) => {
  const { firstName, lastName, number, bats, throws, positions, photo } = req.body;
  if (!firstName || !lastName) return res.status(400).json({ error: "firstName y lastName requeridos" });
  const player = await prisma.player.create({
    data: {
      teamId: req.params.id,
      firstName,
      lastName,
      number: number != null ? Number(number) : null,
      bats,
      throws,
      positions: Array.isArray(positions) ? positions.join(",") : positions,
      photo: photo || null
    }
  });
  res.status(201).json(player);
});
r.post("/:id/players/bulk", async (req, res) => {
  const rows = req.body.players;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "players[] requerido" });
  const existing = await prisma.player.findMany({ where: { teamId: req.params.id }, select: { firstName: true, lastName: true } });
  const have = new Set(existing.map((p) => `${p.firstName} ${p.lastName}`.toLowerCase()));
  const data = rows.filter((p) => p.firstName && p.lastName && !have.has(`${p.firstName} ${p.lastName}`.toLowerCase())).map((p) => ({
    teamId: req.params.id,
    firstName: String(p.firstName).trim(),
    lastName: String(p.lastName).trim(),
    number: p.number != null && p.number !== "" ? Number(p.number) : null,
    bats: p.bats || null,
    throws: p.throws || null,
    positions: Array.isArray(p.positions) ? p.positions.join(",") : p.positions || null
  }));
  const created = await prisma.player.createMany({ data });
  res.status(201).json({ created: created.count, skipped: rows.length - data.length });
});
r.put("/:id/players/:playerId", async (req, res) => {
  const { firstName, lastName, number, bats, throws, positions, active, teamId, photo } = req.body;
  const player = await prisma.player.update({
    where: { id: req.params.playerId },
    data: {
      firstName,
      lastName,
      number: number != null ? Number(number) : null,
      bats,
      throws,
      positions: Array.isArray(positions) ? positions.join(",") : positions,
      active,
      // foto: solo se toca si viene en el body ('' = quitar foto)
      ...photo !== void 0 ? { photo: photo || null } : {},
      // transferencia: el jugador se mueve de equipo conservando su ID →
      // sus stats, historial y líneas de temporada lo siguen intactos
      teamId: teamId || void 0
    }
  });
  res.json(player);
});
r.post("/:id/players/bulk-move", async (req, res) => {
  const { playerIds, toTeamId } = req.body;
  if (!Array.isArray(playerIds) || !playerIds.length || !toTeamId)
    return res.status(400).json({ error: "playerIds[] y toTeamId requeridos" });
  const target = await prisma.team.findUnique({ where: { id: toTeamId } });
  if (!target) return res.status(404).json({ error: "Equipo destino no encontrado" });
  const done = await prisma.player.updateMany({
    where: { id: { in: playerIds } },
    data: { teamId: toTeamId }
  });
  res.json({ moved: done.count });
});
r.put("/:id/players/:playerId/block", async (req, res) => {
  const { blocked } = req.body;
  const p = await prisma.player.update({ where: { id: req.params.playerId }, data: { blocked: !!blocked } });
  res.json(p);
});
r.delete("/:id/players/:playerId", async (req, res) => {
  const auth = await adminOk(String(req.body?.password ?? ""));
  if (!auth.ok) return res.status(auth.code ?? 401).json({ error: auth.error });
  try {
    await prisma.player.delete({ where: { id: req.params.playerId } });
  } catch {
    return res.status(404).json({ error: "Jugador no encontrado" });
  }
  res.status(204).end();
});
var teams_default = r;

// src/routes/games.ts
import { Router as Router2 } from "express";
import { Prisma } from "@prisma/client";

// src/backup-lib.ts
import fs from "node:fs";
import path from "node:path";
var ALL_TABLES = ["leagues", "seasons", "teams", "series", "players", "games", "lineups", "events", "seasonStats", "users"];
async function exportAll() {
  const [leagues, seasons, teams, series, players, games, lineups, events, seasonStats, users] = await Promise.all([
    prisma.league.findMany(),
    prisma.season.findMany(),
    prisma.team.findMany(),
    prisma.series.findMany(),
    prisma.player.findMany(),
    prisma.game.findMany(),
    prisma.lineupEntry.findMany(),
    prisma.gameEvent.findMany(),
    prisma.playerSeasonStat.findMany(),
    prisma.user.findMany()
    // cuentas con su passHash — restaurar sin ellas borraba el admin
  ]);
  return { version: 2, exportedAt: (/* @__PURE__ */ new Date()).toISOString(), leagues, seasons, teams, series, players, games, lineups, events, seasonStats, users };
}
async function exportLeague(leagueId) {
  const league = await prisma.league.findUnique({ where: { id: leagueId } });
  if (!league) return null;
  const teams = await prisma.team.findMany({ where: { leagueId } });
  const tids = teams.map((t) => t.id);
  const games = await prisma.game.findMany({ where: { leagueId } });
  const gids = games.map((g) => g.id);
  const players = await prisma.player.findMany({ where: { teamId: { in: tids } } });
  const pids = players.map((p) => p.id);
  const [seasons, series, lineups, events, seasonStats] = await Promise.all([
    prisma.season.findMany({ where: { leagueId } }),
    prisma.series.findMany({ where: { leagueId } }),
    prisma.lineupEntry.findMany({ where: { gameId: { in: gids } } }),
    prisma.gameEvent.findMany({ where: { gameId: { in: gids } } }),
    prisma.playerSeasonStat.findMany({ where: { playerId: { in: pids } } })
  ]);
  return {
    version: 2,
    exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
    leagueOnly: leagueId,
    leagues: [league],
    seasons,
    teams,
    series,
    players,
    games,
    lineups,
    events,
    seasonStats
  };
}
function isBackupFile(raw) {
  const o = raw;
  if (!o || typeof o !== "object" || Array.isArray(o) || typeof o.league === "string") return false;
  const s0 = Array.isArray(o.seasons) ? o.seasons[0] : void 0;
  if (s0 && (Array.isArray(s0.teams) || Array.isArray(s0.games) || Array.isArray(s0.players))) return false;
  return Array.isArray(o.leagues) || Array.isArray(o.seasons) || Array.isArray(o.teams) || Array.isArray(o.players) || Array.isArray(o.games) || Array.isArray(o.lineups) || Array.isArray(o.events) || Array.isArray(o.seasonStats);
}
async function importBackup(b) {
  await autoBackup("antes de restaurar respaldo");
  const rows = (t) => b[t] ?? [];
  await prisma.league.createMany({ data: rows("leagues"), skipDuplicates: true });
  await prisma.season.createMany({ data: rows("seasons"), skipDuplicates: true });
  await prisma.team.createMany({ data: rows("teams"), skipDuplicates: true });
  await prisma.series.createMany({ data: rows("series"), skipDuplicates: true });
  await prisma.player.createMany({ data: rows("players"), skipDuplicates: true });
  await prisma.game.createMany({ data: rows("games"), skipDuplicates: true });
  await prisma.lineupEntry.createMany({ data: rows("lineups"), skipDuplicates: true });
  await prisma.gameEvent.createMany({ data: rows("events"), skipDuplicates: true });
  await prisma.playerSeasonStat.createMany({ data: rows("seasonStats"), skipDuplicates: true });
  await prisma.user.createMany({ data: rows("users"), skipDuplicates: true });
  return { imported: Object.fromEntries(ALL_TABLES.map((t) => [t, b[t]?.length ?? 0])) };
}
var norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
var bkRows = (b, k) => Array.isArray(b[k]) ? b[k] : [];
function leagueRows(b, lg) {
  const seasons = bkRows(b, "seasons").filter((s) => s.leagueId === lg.id);
  const teams = bkRows(b, "teams").filter((t) => t.leagueId === lg.id);
  const tids = new Set(teams.map((t) => t.id));
  const series = bkRows(b, "series").filter((s) => s.leagueId === lg.id);
  const players = bkRows(b, "players").filter((p) => tids.has(p.teamId));
  const pids = new Set(players.map((p) => p.id));
  const games = bkRows(b, "games").filter((g) => g.leagueId === lg.id);
  const gids = new Set(games.map((g) => g.id));
  const lineups = bkRows(b, "lineups").filter((l) => gids.has(l.gameId));
  const events = bkRows(b, "events").filter((e) => gids.has(e.gameId));
  const seasonStats = bkRows(b, "seasonStats").filter((s) => pids.has(s.playerId));
  return { seasons, teams, series, players, games, lineups, events, seasonStats };
}
function previewBackupLeagues(b) {
  return bkRows(b, "leagues").map((lg) => {
    const r10 = leagueRows(b, lg);
    const years = [...new Set(r10.seasons.map((s) => s.year))].sort();
    const dates = r10.games.map((g) => String(g.date ?? "").slice(0, 10)).sort();
    return {
      name: lg.name,
      years,
      teams: r10.teams.length,
      players: r10.players.length,
      games: r10.games.length,
      events: r10.events.length,
      from: dates[0] ?? null,
      to: dates[dates.length - 1] ?? null
    };
  });
}
async function restoreLeagueFromBackup(b, leagueName) {
  const lgB = bkRows(b, "leagues").find((l) => norm(l.name) === norm(leagueName));
  if (!lgB) {
    throw new Error(`"${leagueName}" no est\xE1 en el respaldo \u2014 hay: ${bkRows(b, "leagues").map((l) => l.name).join(", ")}`);
  }
  const R = leagueRows(b, lgB);
  await autoBackup("antes de restaurar liga");
  const lgDb = await prisma.league.findFirst({ where: { name: { equals: lgB.name } } });
  if (lgDb) {
    const gids = (await prisma.game.findMany({ where: { leagueId: lgDb.id }, select: { id: true } })).map((g) => g.id);
    const pids = (await prisma.player.findMany({ where: { team: { leagueId: lgDb.id } }, select: { id: true } })).map((p) => p.id);
    await prisma.gameEvent.deleteMany({ where: { gameId: { in: gids } } });
    await prisma.lineupEntry.deleteMany({ where: { OR: [{ gameId: { in: gids } }, { playerId: { in: pids } }] } });
    await prisma.playerSeasonStat.deleteMany({ where: { playerId: { in: pids } } });
    await prisma.game.deleteMany({ where: { leagueId: lgDb.id } });
    await prisma.series.deleteMany({ where: { leagueId: lgDb.id } });
    await prisma.player.deleteMany({ where: { id: { in: pids } } });
    await prisma.team.deleteMany({ where: { leagueId: lgDb.id } });
    await prisma.league.delete({ where: { id: lgDb.id } });
  }
  await prisma.league.create({ data: lgB });
  await prisma.season.createMany({ data: R.seasons });
  await prisma.team.createMany({ data: R.teams });
  await prisma.series.createMany({ data: R.series });
  await prisma.player.createMany({ data: R.players });
  await prisma.game.createMany({ data: R.games });
  await prisma.lineupEntry.createMany({ data: R.lineups });
  await prisma.gameEvent.createMany({ data: R.events });
  await prisma.playerSeasonStat.createMany({ data: R.seasonStats });
  return {
    league: lgB.name,
    replaced: !!lgDb,
    years: R.seasons.map((s) => s.year).sort(),
    teams: R.teams.length,
    players: R.players.length,
    games: R.games.length
  };
}
var KEEP = 30;
var lastAutoAt = 0;
function backupDir() {
  return process.env.BACKUP_DIR || path.resolve(process.cwd(), "backups");
}
async function autoBackup(reason = "auto") {
  if (Date.now() - lastAutoAt < 9e4) return;
  lastAutoAt = Date.now();
  try {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const data = await exportAll();
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 16);
    const file = path.join(dir, `auto-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(data));
    const files = fs.readdirSync(dir).filter((f) => f.startsWith("auto-") && f.endsWith(".json")).sort();
    while (files.length > KEEP) {
      fs.unlinkSync(path.join(dir, files.shift()));
    }
    console.log(`Respaldo autom\xE1tico (${reason}) \u2192 ${file} (${files.length} conservados)`);
  } catch (e) {
    console.error("Respaldo autom\xE1tico fall\xF3:", e);
  }
}
var timer = null;
function startAutoBackup() {
  if (timer) return;
  setTimeout(() => autoBackup("arranque"), 3e4);
  timer = setInterval(() => autoBackup("programado"), 6 * 36e5);
  timer.unref();
}

// src/routes/game-queue.ts
var gameChains = /* @__PURE__ */ new Map();
function enqueue(gameId, fn) {
  const prev = gameChains.get(gameId) ?? Promise.resolve();
  const p = prev.then(fn, fn);
  const tail = p.catch(() => void 0);
  gameChains.set(gameId, tail);
  void tail.finally(() => {
    if (gameChains.get(gameId) === tail) gameChains.delete(gameId);
  });
  return p;
}

// src/dates.ts
function gameDate(d) {
  if (!d) return void 0;
  if (typeof d === "string") {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  }
  return new Date(d);
}

// ../shared/src/types.ts
var FIELD_NUM = {
  P: 1,
  C: 2,
  "1B": 3,
  "2B": 4,
  "3B": 5,
  SS: 6,
  LF: 7,
  CF: 8,
  RF: 9,
  JC: 10
};
var HITS = ["1B", "2B", "3B", "HR", "RHB", "1BE", "2BE", "3BE", "HRIP"];
var NON_AB = ["BB", "IBB", "HBP", "SAC", "SF", "CI", "OOT"];

// ../shared/src/engine.ts
function initialState() {
  return {
    inning: 1,
    half: "TOP",
    outs: 0,
    bases: { 1: null, 2: null, 3: null },
    score: { away: 0, home: 0 },
    awayBatterIndex: 0,
    homeBatterIndex: 0,
    lastOut: { away: null, home: null },
    status: "LIVE"
  };
}
var MID_RESULTS = ["SB", "CS", "WP", "PB", "BK", "PK", "DI", "CR", "PC", "INT", "OBS", "GR", "B", "S", "F", "IPL", "LE", "EF", "EI", "ADJ", "RBI", "EU", "LG", "SK", "DE", "LIB", "T"];
function isMidResult(r10) {
  return MID_RESULTS.includes(r10);
}
function defaultAdvances(state, batterId, result) {
  const { bases } = state;
  const adv = [];
  const r1 = bases[1], r22 = bases[2], r32 = bases[3];
  switch (result) {
    case "K":
    case "OOT":
    // turno robado: el bateador correcto es out, corredores regresan
    case "XF":
    // elevado foul atrapado: bateador out, corredores se esperan
    case "AIL":
    // acción ilegal del bateador: out por regla
    case "FI":
    // interferencia de fanático: juicio del ampáyer (default: out)
    case "AO":
      return [{ playerId: batterId, to: "OUT" }];
    case "KWP":
    case "KPB": {
      const batterCanRun = !r1 || state.outs >= 2;
      adv.push({ playerId: batterId, to: batterCanRun ? 1 : "OUT" });
      if (batterCanRun && r1) adv.push({ playerId: r1, to: 2 });
      if (r22) adv.push({ playerId: r22, to: 2 });
      if (r32) adv.push({ playerId: r32, to: 3 });
      return adv;
    }
    case "BB":
    case "IBB":
    case "HBP":
    case "CI": {
      adv.push({ playerId: batterId, to: 1 });
      if (r1) {
        adv.push({ playerId: r1, to: 2 });
        if (r22) {
          adv.push({ playerId: r22, to: 3 });
          if (r32) adv.push({ playerId: r32, to: "HOME" });
        }
      }
      return adv;
    }
    case "RHB": {
      const hitRunner = r32 ?? r22 ?? r1;
      adv.push({ playerId: batterId, to: 1 });
      if (hitRunner) adv.push({ playerId: hitRunner, to: "OUT" });
      let push = true;
      for (const [b, pid] of [[1, r1], [2, r22], [3, r32]]) {
        if (!pid || pid === hitRunner) {
          push = false;
          continue;
        }
        adv.push({ playerId: pid, to: push ? b === 3 ? "HOME" : b + 1 : b });
      }
      return adv;
    }
    case "1B":
    case "E":
      adv.push({ playerId: batterId, to: 1 });
      if (r32) adv.push({ playerId: r32, to: "HOME" });
      if (r22) adv.push({ playerId: r22, to: 3 });
      if (r1) adv.push({ playerId: r1, to: 2 });
      return adv;
    case "1BE":
      adv.push({ playerId: batterId, to: 2 });
      if (r32) adv.push({ playerId: r32, to: "HOME" });
      if (r22) adv.push({ playerId: r22, to: 3 });
      if (r1) adv.push({ playerId: r1, to: 2 });
      return adv;
    case "2B":
      adv.push({ playerId: batterId, to: 2 });
      if (r32) adv.push({ playerId: r32, to: "HOME" });
      if (r22) adv.push({ playerId: r22, to: "HOME" });
      if (r1) adv.push({ playerId: r1, to: 3 });
      return adv;
    case "2BE":
      adv.push({ playerId: batterId, to: 3 });
      if (r32) adv.push({ playerId: r32, to: "HOME" });
      if (r22) adv.push({ playerId: r22, to: "HOME" });
      if (r1) adv.push({ playerId: r1, to: "HOME" });
      return adv;
    case "3B":
      adv.push({ playerId: batterId, to: 3 });
      if (r32) adv.push({ playerId: r32, to: "HOME" });
      if (r22) adv.push({ playerId: r22, to: "HOME" });
      if (r1) adv.push({ playerId: r1, to: "HOME" });
      return adv;
    case "3BE":
    // triple + error: bateador anota (su carrera es inmerecida por el error)
    case "HR":
    // jonrón
    case "HRIP":
      adv.push({ playerId: batterId, to: "HOME" });
      if (r32) adv.push({ playerId: r32, to: "HOME" });
      if (r22) adv.push({ playerId: r22, to: "HOME" });
      if (r1) adv.push({ playerId: r1, to: "HOME" });
      return adv;
    case "FC":
      adv.push({ playerId: batterId, to: 1 });
      if (r1) adv.push({ playerId: r1, to: 2 });
      if (r22) adv.push({ playerId: r22, to: 3 });
      if (r32) adv.push({ playerId: r32, to: "HOME" });
      return adv;
    case "GO": {
      adv.push({ playerId: batterId, to: "OUT" });
      if (state.outs < 2) {
        if (r32) adv.push({ playerId: r32, to: 3 });
        if (r22) adv.push({ playerId: r22, to: r32 ? 2 : 3 });
        if (r1) adv.push({ playerId: r1, to: !r22 || !r32 ? 2 : 1 });
      } else {
        if (r32) adv.push({ playerId: r32, to: 3 });
        if (r22) adv.push({ playerId: r22, to: 2 });
        if (r1) adv.push({ playerId: r1, to: 1 });
      }
      return adv;
    }
    case "IF":
    // infield fly: bateador out automático, corredores a su riesgo (se esperan por defecto)
    case "FO":
    case "LO":
    case "PO":
      adv.push({ playerId: batterId, to: "OUT" });
      if (r1) adv.push({ playerId: r1, to: 1 });
      if (r22) adv.push({ playerId: r22, to: 2 });
      if (r32) adv.push({ playerId: r32, to: 3 });
      return adv;
    case "SAC":
      adv.push({ playerId: batterId, to: "OUT" });
      if (r1) adv.push({ playerId: r1, to: 2 });
      if (r22) adv.push({ playerId: r22, to: 3 });
      if (r32) adv.push({ playerId: r32, to: "HOME" });
      return adv;
    case "SF":
      adv.push({ playerId: batterId, to: "OUT" });
      if (r32) adv.push({ playerId: r32, to: "HOME" });
      if (r22) adv.push({ playerId: r22, to: 2 });
      if (r1) adv.push({ playerId: r1, to: 1 });
      return adv;
    case "DP":
      adv.push({ playerId: batterId, to: "OUT" });
      if (r1) adv.push({ playerId: r1, to: "OUT" });
      else if (r22) adv.push({ playerId: r22, to: "OUT" });
      else if (r32) adv.push({ playerId: r32, to: "OUT" });
      if (r32 && adv.length < 4 && r32 !== adv[1]?.playerId) adv.push({ playerId: r32, to: 3 });
      if (r22 && r22 !== adv[1]?.playerId) adv.push({ playerId: r22, to: 3 });
      if (r1 && r1 !== adv[1]?.playerId) adv.push({ playerId: r1, to: 2 });
      return adv;
    case "TP":
      adv.push({ playerId: batterId, to: "OUT" });
      if (r1) adv.push({ playerId: r1, to: "OUT" });
      if (r22) adv.push({ playerId: r22, to: "OUT" });
      else if (r32) adv.push({ playerId: r32, to: "OUT" });
      return adv;
    default:
      return adv;
  }
}
var BATTER_RUNNER = /* @__PURE__ */ new Set([
  "1B",
  "2B",
  "3B",
  "HR",
  "HRIP",
  "1BE",
  "2BE",
  "3BE",
  "E",
  "FC",
  "GO",
  "DP",
  "TP",
  "RHB",
  "SAC",
  "BB",
  "IBB",
  "HBP",
  "CI",
  "KWP",
  "KPB"
]);
var BATTER_FORCE_OUT = /* @__PURE__ */ new Set(["GO", "DP", "TP", "SAC", "KWP", "KPB"]);
function thirdOutIsForce(prev, ev) {
  const outs = ev.advances.filter((a) => a.to === "OUT");
  if (!outs.length || prev.outs + outs.length < 3) return false;
  if (ev.result === "RHB") return false;
  const last = outs[outs.length - 1];
  if (last.playerId === ev.batterId) return BATTER_FORCE_OUT.has(ev.result);
  if (outs.slice(0, -1).some((a) => a.playerId === ev.batterId)) return false;
  if (!BATTER_RUNNER.has(ev.result)) return false;
  const base = [1, 2, 3].find((b) => prev.bases[b] === last.playerId);
  if (!base) return false;
  for (let b = 1; b < base; b++) if (!prev.bases[b]) return false;
  let maxForcedBase = 1;
  while (maxForcedBase <= 3 && prev.bases[maxForcedBase]) maxForcedBase++;
  const forcedTo = base + 1;
  const m = /(\d)(?!.*\d)/.exec(ev.notation ?? "");
  if (m) {
    const outBase = { 2: 4, 3: 1, 4: 2, 5: 3, 6: 2 }[Number(m[1])];
    if (outBase != null) {
      if (outBase > maxForcedBase) return false;
      if (outBase === 4 && forcedTo < 4 && ev.advances.some((a) => a.playerId === prev.bases[3] && a.to === "HOME")) return false;
    }
  }
  return true;
}
function applyEvent(state, ev, maxInnings = 9) {
  const s = {
    ...state,
    bases: { ...state.bases },
    score: { ...state.score },
    lastOut: { ...state.lastOut }
  };
  if (ev.result === "EI" || ev.result === "ADJ") {
    if (ev.result === "ADJ") {
      const m = /O:(\d)/.exec(ev.notation ?? "");
      if (m) s.outs = Math.min(3, Number(m[1]));
      s.bases = { 1: null, 2: null, 3: null };
      for (const a of ev.advances) {
        if (a.to === 1 || a.to === 2 || a.to === 3) s.bases[a.to] = a.playerId;
      }
    } else {
      s.outs = 3;
    }
    if (s.outs >= 3) {
      if (s.half === "TOP") {
        s.half = "BOTTOM";
      } else {
        const tied = s.score.home === s.score.away;
        if (s.inning >= maxInnings && !tied) s.status = "FINAL";
        else {
          s.inning += 1;
          s.half = "TOP";
        }
      }
      s.outs = 0;
      s.bases = { 1: null, 2: null, 3: null };
    }
    return s;
  }
  const outsInPlay = ev.advances.filter((a) => a.to === "OUT");
  if (outsInPlay.length) {
    const last = outsInPlay[outsInPlay.length - 1].playerId;
    if (ev.half === "TOP") s.lastOut.away = last;
    else s.lastOut.home = last;
  }
  for (const a of ev.advances) {
    for (const b of [1, 2, 3]) {
      if (s.bases[b] === a.playerId) s.bases[b] = null;
    }
  }
  const cancelRuns = thirdOutIsForce(state, ev);
  let outs = s.outs;
  for (const a of ev.advances) {
    if (a.to === "OUT") {
      outs += 1;
    } else if (a.to === "HOME") {
      if (!cancelRuns) {
        if (ev.half === "TOP") s.score.away += 1;
        else s.score.home += 1;
      }
    } else {
      s.bases[a.to] = a.playerId;
    }
  }
  s.outs = outs;
  if (!isMidResult(ev.result) || ev.result === "SK") {
    if (ev.half === "TOP") s.awayBatterIndex += 1;
    else s.homeBatterIndex += 1;
  }
  if (s.outs >= 3) {
    if (s.half === "TOP") {
      s.half = "BOTTOM";
    } else {
      const tied = s.score.home === s.score.away;
      if (s.inning >= maxInnings && !tied) {
        s.status = "FINAL";
      } else {
        s.inning += 1;
        s.half = "TOP";
      }
    }
    s.outs = 0;
    s.bases = { 1: null, 2: null, 3: null };
  }
  if (s.half === "BOTTOM" && s.inning >= maxInnings && s.score.home > s.score.away) {
    s.status = "FINAL";
  }
  return s;
}
function reduceGame(events, maxInnings = 9) {
  let s = initialState();
  for (const ev of events) {
    if (s.status === "FINAL") break;
    s = applyEvent(s, ev, maxInnings);
  }
  return s;
}
function emptyBatter(playerId) {
  return {
    playerId,
    pa: 0,
    ab: 0,
    r: 0,
    h: 0,
    rbi: 0,
    bb: 0,
    k: 0,
    hbp: 0,
    doubles: 0,
    triples: 0,
    hr: 0,
    sac: 0,
    sf: 0,
    sb: 0
  };
}
function emptyPitcher(playerId) {
  return { playerId, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0, pitches: 0 };
}
var PITCH_MID = /* @__PURE__ */ new Set(["B", "S", "F", "WP", "PB", "BK", "IPL", "EF"]);
var NO_RBI = ["E", "DP", "TP", "KWP", "KPB"];
var UNEARNED_REACH = /* @__PURE__ */ new Set(["E", "CI", "GR", "ADJ", "INT", "OBS", "KPB"]);
var ERROR_REACH = /* @__PURE__ */ new Set(["E", "CI", "INT", "OBS", "KPB"]);
function computeBoxscore(events, maxInnings = 9) {
  const box = {
    away: {},
    home: {},
    pitchers: {},
    linescore: { away: [], home: [] },
    lob: { away: 0, home: 0 }
  };
  const batterOf = (team, id) => {
    const t = box[team];
    if (!t[id]) t[id] = emptyBatter(id);
    return t[id];
  };
  const pitcherOf = (id) => {
    if (!box.pitchers[id]) box.pitchers[id] = emptyPitcher(id);
    return box.pitchers[id];
  };
  let st = initialState();
  const reach = /* @__PURE__ */ new Map();
  let reconOuts = 0, curHalf = null, curPitcher = null;
  for (const ev of events) {
    const prevSt = st;
    const team = ev.half === "TOP" ? "away" : "home";
    const ls = box.linescore[team];
    while (ls.length < ev.inning) ls.push(0);
    const cancelRuns = thirdOutIsForce(prevSt, ev);
    const runsOnPlay = cancelRuns ? [] : ev.advances.filter((a) => a.to === "HOME");
    const outsOnPlay = ev.advances.filter((a) => a.to === "OUT").length;
    const runnerOuts = ev.advances.filter((a) => a.to === "OUT" && a.playerId !== ev.batterId).length;
    ls[ev.inning - 1] += runsOnPlay.length;
    if (ev.half !== curHalf || !!ev.pitcherId && ev.pitcherId !== curPitcher) {
      reconOuts = 0;
      curHalf = ev.half;
      if (ev.pitcherId) curPitcher = ev.pitcherId;
    }
    const batterErrReach = !!ev.batterId && ev.advances.some((a) => a.playerId === ev.batterId && a.to !== "OUT" && a.to !== "HOME") && (ERROR_REACH.has(ev.result) || ev.result === "FC" && !!ev.errorOn?.length && outsOnPlay === 0);
    const deadInning = reconOuts + (batterErrReach ? 1 : 0) >= 3;
    for (const a of runsOnPlay) {
      if (a.playerId !== ev.batterId) {
        const scorer = batterOf(team, a.playerId);
        scorer.r += 1;
      }
    }
    if (ev.pitcherId) {
      const p = pitcherOf(ev.pitcherId);
      p.outs += outsOnPlay;
      if (HITS.includes(ev.result)) p.h += 1;
      if (ev.result === "HR" || ev.result === "HRIP") p.hr += 1;
      if (ev.result === "BB" || ev.result === "IBB") p.bb += 1;
      if (ev.result === "K" || ev.result === "KWP" || ev.result === "KPB") p.k += 1;
      if (PITCH_MID.has(ev.result) || !isMidResult(ev.result)) p.pitches += 1;
      if (ev.result === "EU") {
        p.er = Math.max(0, Math.min(p.r, p.er + (ev.notation?.startsWith("U") ? -1 : 1)));
      }
    }
    const playHadError = ev.result === "E" || !!ev.errorOn?.length || ev.result === "1BE" || ev.result === "2BE" || ev.result === "3BE" || ev.result === "PB" || ev.result === "BK" || ev.result === "IPL" || ev.result === "DE" || ev.result === "CI" || ev.result === "INT" || ev.result === "OBS" || /E-?\d/.test(ev.notation ?? "");
    for (const a of runsOnPlay) {
      const rec = reach.get(a.playerId);
      const chargeTo = rec?.pitcherId ?? ev.pitcherId;
      if (!chargeTo) continue;
      const p = pitcherOf(chargeTo);
      p.r += 1;
      const earned = !deadInning && !playHadError && !UNEARNED_REACH.has(rec?.res ?? "");
      if (earned) p.er += 1;
    }
    for (const a of ev.advances) {
      if (a.to !== "OUT") continue;
      const rec = a.playerId === ev.batterId ? null : reach.get(a.playerId);
      if (!rec || !UNEARNED_REACH.has(rec.res)) reconOuts += 1;
    }
    if (batterErrReach) reconOuts += 1;
    if (ev.batterId && ev.advances.some((a) => a.playerId === ev.batterId && a.to !== "OUT" && a.to !== "HOME")) {
      reach.set(ev.batterId, { res: batterErrReach ? "E" : ev.result, pitcherId: ev.pitcherId });
    }
    if (playHadError) {
      const midErr = isMidResult(ev.result);
      const defs = midErr || !ev.batterId ? null : defaultAdvances(prevSt, ev.batterId, ev.result);
      for (const a of ev.advances) {
        if (a.to === "OUT" || a.to === "HOME" || a.playerId === ev.batterId) continue;
        if (!midErr && typeof a.to === "number") {
          const nat = defs?.find((d) => d.playerId === a.playerId)?.to;
          if (typeof nat === "number" && a.to <= nat) continue;
        }
        const prev = reach.get(a.playerId);
        reach.set(a.playerId, { res: "E", pitcherId: prev?.pitcherId ?? ev.pitcherId });
      }
    }
    if (ev.result === "CR") {
      for (const a of ev.advances) {
        if (a.to === "OUT" || a.to === "HOME") continue;
        const oldPid = prevSt.bases[a.to];
        if (oldPid && reach.has(oldPid)) reach.set(a.playerId, reach.get(oldPid));
      }
    }
    if (ev.result === "ADJ") {
      for (const a of ev.advances) {
        if (a.to !== "OUT" && a.to !== "HOME") reach.set(a.playerId, { res: "ADJ", pitcherId: null });
      }
    }
    st = applyEvent(st, ev, maxInnings);
    if (ev.result === "GR") for (const a of ev.advances) reach.set(a.playerId, { res: "GR", pitcherId: ev.pitcherId });
    const onBase = new Set([st.bases[1], st.bases[2], st.bases[3]].filter(Boolean));
    for (const pid of [...reach.keys()]) if (!onBase.has(pid)) reach.delete(pid);
    const halfEnded = prevSt.half !== st.half || prevSt.status !== "FINAL" && st.status === "FINAL";
    if (halfEnded) {
      const occupied = [prevSt.bases[1], prevSt.bases[2], prevSt.bases[3]].filter(Boolean).length;
      const crossed = ev.advances.filter((a) => a.to === "HOME").length;
      const leftOn = occupied - crossed - runnerOuts;
      if (leftOn > 0) box.lob[team] += leftOn;
    }
    if (!ev.batterId) continue;
    const b = batterOf(team, ev.batterId);
    if (runsOnPlay.some((a) => a.playerId === ev.batterId)) b.r += 1;
    if (isMidResult(ev.result)) {
      if (ev.result === "SB") {
        for (const a of ev.advances) {
          if (a.to !== "OUT") batterOf(team, a.playerId).sb += 1;
        }
      }
      if (ev.result === "RBI") {
        b.rbi = Math.max(0, b.rbi + (ev.notation?.startsWith("-") ? -1 : 1));
      }
      continue;
    }
    const r10 = ev.result;
    b.pa += 1;
    if (HITS.includes(r10)) {
      b.h += 1;
      b.ab += 1;
      if (r10 === "2B" || r10 === "2BE") b.doubles += 1;
      if (r10 === "3B" || r10 === "3BE") b.triples += 1;
      if (r10 === "HR" || r10 === "HRIP") b.hr += 1;
    } else if (r10 === "BB" || r10 === "IBB") {
      b.bb += 1;
    } else if (r10 === "K" || r10 === "KWP" || r10 === "KPB") {
      b.k += 1;
      b.ab += 1;
    } else if (r10 === "HBP") {
      b.hbp += 1;
    } else if (r10 === "SAC") {
      b.sac += 1;
    } else if (r10 === "SF") {
      b.sf += 1;
    } else if (r10 === "CI" || r10 === "OOT") {
    } else {
      b.ab += 1;
    }
    if (!NO_RBI.includes(r10)) b.rbi += runsOnPlay.length;
  }
  return box;
}
function suggestDecisions(events, maxInnings = 9, sport = "baseball", wpMinOutsOverride) {
  const none = { wpId: null, lpId: null, wpKind: null, starterOuts: 0, minStarterOuts: 0 };
  let st = initialState();
  const diffs = [];
  const firstPid = { TOP: null, BOTTOM: null };
  for (const ev of events) {
    st = applyEvent(st, ev, maxInnings);
    diffs.push(st.score.away - st.score.home);
    if (ev.pitcherId && !firstPid[ev.half]) firstPid[ev.half] = ev.pitcherId;
  }
  const finalDiff = st.score.away - st.score.home;
  if (finalDiff === 0) return none;
  const winner = finalDiff > 0 ? "away" : "home";
  const winDiff = (i) => winner === "away" ? diffs[i] : -diffs[i];
  let boundary = -1;
  for (let i = 0; i < diffs.length; i++) if (winDiff(i) <= 0) boundary = i;
  const goAheadIdx = boundary + 1;
  const goAhead = events[goAheadIdx];
  const winnerFieldHalf = winner === "home" ? "TOP" : "BOTTOM";
  const reachP = /* @__PURE__ */ new Map();
  let recordPitcher = null;
  let lpId = null;
  let st2 = initialState();
  for (let i = 0; i <= goAheadIdx && i < events.length; i++) {
    const ev = events[i];
    const prevSt2 = st2;
    if (i === goAheadIdx) {
      let d = boundary >= 0 ? winDiff(boundary) : 0;
      for (const a of ev.advances) {
        if (a.to !== "HOME") continue;
        d += 1;
        if (d > 0) {
          lpId = reachP.get(a.playerId) ?? ev.pitcherId ?? null;
          break;
        }
      }
      lpId ??= ev.pitcherId ?? null;
    }
    if (ev.batterId && ev.advances.some((a) => a.playerId === ev.batterId && a.to !== "OUT" && a.to !== "HOME")) {
      reachP.set(ev.batterId, ev.pitcherId);
    }
    if (ev.result === "CR") {
      for (const a of ev.advances) {
        if (a.to === "OUT" || a.to === "HOME") continue;
        const oldPid = prevSt2.bases[a.to];
        if (oldPid && reachP.has(oldPid)) reachP.set(a.playerId, reachP.get(oldPid));
      }
    }
    if (ev.result === "ADJ" || ev.result === "GR") {
      for (const a of ev.advances) {
        if (a.to !== "OUT" && a.to !== "HOME") reachP.set(a.playerId, ev.result === "ADJ" ? null : ev.pitcherId);
      }
    }
    st2 = applyEvent(st2, ev, maxInnings);
    const onBase = new Set([st2.bases[1], st2.bases[2], st2.bases[3]].filter(Boolean));
    for (const pid of [...reachP.keys()]) if (!onBase.has(pid)) reachP.delete(pid);
    if (ev.half === winnerFieldHalf && ev.pitcherId) recordPitcher = ev.pitcherId;
  }
  const starter = firstPid[winnerFieldHalf];
  const defInns = events.length ? events[events.length - 1].inning : maxInnings;
  const minInn = sport === "softball" ? defInns >= 6 ? 4 : defInns === 5 ? 3 : 0 : defInns >= 6 ? 5 : defInns === 5 ? 4 : 0;
  const minStarterOuts = wpMinOutsOverride && wpMinOutsOverride > 0 ? wpMinOutsOverride : minInn * 3;
  const box = computeBoxscore(events, maxInnings);
  const starterOuts = starter ? box.pitchers[starter]?.outs ?? 0 : 0;
  const relOrder = [];
  for (const e of events) {
    if (e.half === winnerFieldHalf && e.pitcherId && e.pitcherId !== starter && !relOrder.includes(e.pitcherId)) {
      relOrder.push(e.pitcherId);
    }
  }
  const byEffective = (a, b) => {
    const A = box.pitchers[a], B = box.pitchers[b];
    return (B?.outs ?? 0) - (A?.outs ?? 0) || (A?.r ?? 0) - (B?.r ?? 0) || (A?.er ?? 0) - (B?.er ?? 0);
  };
  const rec = recordPitcher ?? starter;
  let wpId = rec ?? null;
  let wpKind = null;
  if (rec === starter) {
    if (rec && starterOuts >= minStarterOuts) wpKind = "starter";
    else if (rec) {
      const rels = [...relOrder].sort(byEffective);
      wpId = rels[0] ?? rec;
      wpKind = rels.length ? "effective" : "starter";
    }
  } else if (rec) {
    const rp = box.pitchers[rec];
    if (rp && rp.outs < 3 && rp.er >= 2) {
      const later = relOrder.slice(relOrder.indexOf(rec) + 1).sort(byEffective);
      if (later.length) {
        wpId = later[0];
        wpKind = "ineffective";
      } else wpKind = "record";
    } else wpKind = "record";
  }
  return { wpId, lpId, wpKind, starterOuts, minStarterOuts };
}
var emptySitu = () => ({
  risp: { ab: 0, h: 0 },
  loaded: { ab: 0, h: 0 },
  twoOut: { ab: 0, h: 0 },
  leadoff: { ab: 0, h: 0 }
});
function computeSituational(events, maxInnings = 9) {
  const out = { away: {}, home: {} };
  let st = initialState();
  let paInHalf = 0;
  for (const ev of events) {
    if (!isMidResult(ev.result) && ev.batterId) {
      const side = ev.half === "TOP" ? "away" : "home";
      const s = out[side][ev.batterId] ??= emptySitu();
      const r10 = ev.result;
      const isAB = !NON_AB.includes(r10);
      const isH = HITS.includes(r10);
      const bump = (l) => {
        if (isAB) l.ab += 1;
        if (isH) l.h += 1;
      };
      if (st.bases[2] || st.bases[3]) bump(s.risp);
      if (st.bases[1] && st.bases[2] && st.bases[3]) bump(s.loaded);
      if (st.outs === 2) bump(s.twoOut);
      if (paInHalf === 0) bump(s.leadoff);
      paInHalf += 1;
    }
    const prevHalf = st.half;
    st = applyEvent(st, ev, maxInnings);
    if (st.half !== prevHalf) paInHalf = 0;
  }
  return out;
}
function computeCgSho(events, maxInnings = 9, score) {
  const pitSide = /* @__PURE__ */ new Map();
  for (const e of events) if (e.pitcherId) pitSide.set(e.pitcherId, e.half === "TOP" ? "home" : "away");
  const box = computeBoxscore(events, maxInnings);
  const outsBySide = { away: 0, home: 0 };
  for (const [pid, s] of pitSide) outsBySide[s] += box.pitchers[pid]?.outs ?? 0;
  const runs = score ?? {
    away: box.linescore.away.reduce((a, n) => a + n, 0),
    home: box.linescore.home.reduce((a, n) => a + n, 0)
  };
  const cg = [], sho = [];
  for (const [pid, s] of pitSide) {
    const p = box.pitchers[pid];
    if (!p || outsBySide[s] === 0 || p.outs !== outsBySide[s]) continue;
    cg.push(pid);
    if (runs[s === "home" ? "away" : "home"] === 0) sho.push(pid);
  }
  return { cg, sho };
}
function computeFielding(events) {
  const map = {};
  const add = (pid, k) => {
    (map[pid] ??= { po: 0, a: 0, e: 0 })[k] += 1;
  };
  const ids = (v) => Array.isArray(v) ? v : typeof v === "string" ? JSON.parse(v) : [];
  for (const ev of events) {
    for (const pid of ids(ev.putouts)) add(pid, "po");
    for (const pid of ids(ev.assists)) add(pid, "a");
    for (const pid of ids(ev.errorOn)) add(pid, "e");
  }
  return map;
}

// src/statlines.ts
var SL_NUMS = [
  "g",
  "pa",
  "ab",
  "r",
  "h",
  "doubles",
  "triples",
  "hr",
  "rbi",
  "bb",
  "k",
  "hbp",
  "sac",
  "sf",
  "sb",
  "gp",
  "gs",
  "w",
  "l",
  "sv",
  "hld",
  "bs",
  "cg",
  "sho",
  "pOuts",
  "pH",
  "pR",
  "pER",
  "pBB",
  "pK",
  "pHR",
  "pPitches",
  "bf",
  "po",
  "a",
  "e"
];
function mergeLines(lines) {
  if (!lines.length) return void 0;
  if (lines.length === 1) return lines[0];
  const base = lines.reduce((a, b) => (b.pa ?? 0) + (b.pOuts ?? 0) > (a.pa ?? 0) + (a.pOuts ?? 0) ? b : a);
  const out = { playerId: base.playerId, teamId: base.teamId ?? lines.find((l) => l.teamId)?.teamId ?? null };
  for (const k of SL_NUMS) {
    out[k] = lines.reduce((s, l) => s + (l[k] ?? 0), 0);
  }
  return out;
}

// src/routes/games.ts
var SEASON_KEYS = SL_NUMS.filter((k) => !["po", "a", "bf"].includes(k));
var r2 = Router2();
function toEvent(e) {
  return {
    seq: e.seq,
    inning: e.inning,
    half: e.half,
    batterId: e.batterId,
    pitcherId: e.pitcherId,
    result: e.result,
    notation: e.notation ?? null,
    ...e.sprayDir != null && e.sprayDist != null ? { sprayDir: e.sprayDir, sprayDist: e.sprayDist } : {},
    errorOn: e.errorOn ? JSON.parse(e.errorOn) : void 0,
    putouts: e.putouts ? JSON.parse(e.putouts) : void 0,
    assists: e.assists ? JSON.parse(e.assists) : void 0,
    advances: e.advances,
    aiVoice: e.aiVoice ?? null,
    aiJson: e.aiJson ?? null,
    aiVideo: e.aiVideo ?? null,
    aiNarration: e.aiNarr ?? null
  };
}
async function loadEvents(gameId) {
  const rows = await prisma.gameEvent.findMany({
    where: { gameId },
    orderBy: { seq: "asc" }
  });
  return rows.map(toEvent);
}
function markDoubleheaders(games) {
  const sorted = [...games].sort((a, b) => {
    const sa = a.startedAt ? +new Date(a.startedAt) : 0;
    const sb = b.startedAt ? +new Date(b.startedAt) : 0;
    if (sa !== sb) return sa - sb;
    const da = +new Date(a.date), db = +new Date(b.date);
    return da !== db ? da - db : 0;
  });
  const seq = /* @__PURE__ */ new Map();
  for (const g of sorted) {
    const day = new Date(g.date).toISOString().slice(0, 10);
    for (const [side, tid] of [["dhAway", g.awayTeamId], ["dhHome", g.homeTeamId]]) {
      const k = `${tid}|${day}`;
      const n = (seq.get(k) ?? 0) + 1;
      seq.set(k, n);
      if (n > 1) g[side] = n;
    }
  }
  return games;
}
r2.get("/", async (_req, res) => {
  const games = await prisma.game.findMany({
    orderBy: { date: "desc" },
    include: { homeTeam: true, awayTeam: true, league: true, _count: { select: { events: true } } }
  });
  const live = games.filter((g) => g.status === "LIVE");
  const states = /* @__PURE__ */ new Map();
  for (const g of live) states.set(g.id, reduceGame(await loadEvents(g.id), g.innings));
  res.json(markDoubleheaders(games.map((g) => states.has(g.id) ? { ...g, state: states.get(g.id) } : g)));
});
r2.post("/", async (req, res) => {
  const { homeTeamId, awayTeamId, date, innings, note, lineups, sport, ghostRunner, leagueId, seriesId, seasonId } = req.body;
  if (!homeTeamId || !awayTeamId) return res.status(400).json({ error: "homeTeamId y awayTeamId requeridos" });
  let league = leagueId ?? null;
  if (!league) {
    const home = await prisma.team.findUnique({ where: { id: homeTeamId } });
    const away = await prisma.team.findUnique({ where: { id: awayTeamId } });
    if (home?.leagueId && home.leagueId === away?.leagueId) league = home.leagueId;
  }
  const lg = league ? await prisma.league.findUnique({ where: { id: league } }) : null;
  const gameSport = sport ?? lg?.sport ?? "baseball";
  let season = seasonId || null;
  if (league && !season) {
    season = (await prisma.season.findFirst({ where: { leagueId: league, status: "ACTIVE" } }))?.id ?? null;
  }
  const game = await prisma.game.create({
    data: {
      homeTeamId,
      awayTeamId,
      leagueId: league,
      seriesId: seriesId || null,
      seasonId: season,
      date: gameDate(date) ?? /* @__PURE__ */ new Date(),
      sport: gameSport,
      innings: innings ?? lg?.innings ?? (gameSport === "softball" ? 7 : 9),
      ghostRunner: !!ghostRunner,
      note,
      lineups: lineups ? {
        create: lineups.map((l) => ({ teamId: l.teamId, playerId: l.playerId, order: l.order, position: l.position, role: l.role ?? "STARTER", batsInOrder: l.batsInOrder !== false }))
      } : void 0
    },
    include: { homeTeam: true, awayTeam: true, lineups: { include: { player: true } } }
  });
  res.status(201).json(game);
});
r2.get("/:id", async (req, res) => {
  const game = await prisma.game.findUnique({
    where: { id: req.params.id },
    include: {
      // rosters alfabéticos — alimentan el pool del lineup y las sustituciones
      homeTeam: { include: { players: { orderBy: [{ lastName: "asc" }, { firstName: "asc" }] } } },
      awayTeam: { include: { players: { orderBy: [{ lastName: "asc" }, { firstName: "asc" }] } } },
      league: true,
      // trae sprayInput (flag del anotador) + nombre/año que consumen otras vistas
      lineups: { include: { player: true }, orderBy: { order: "asc" } },
      events: { orderBy: { seq: "asc" } }
    }
  });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  const events = game.events.map(toEvent);
  const state = reduceGame(events, game.innings);
  if (game.status === "FINAL" && state.status !== "FINAL") state.status = "FINAL";
  if ((!events.length || game.forfeitBy) && game.fScoreAway != null && game.fScoreHome != null) {
    state.score = { away: game.fScoreAway, home: game.fScoreHome };
  }
  const lines = game.statLines ?? [];
  const known = /* @__PURE__ */ new Set([
    ...game.lineups.map((l) => l.playerId),
    ...game.homeTeam.players.map((p) => p.id),
    ...game.awayTeam.players.map((p) => p.id)
  ]);
  const refs = events.flatMap((e) => [e.batterId, e.pitcherId]);
  const missing = [...new Set(
    [...lines.map((l) => l.playerId), ...refs].filter((p) => !!p && !known.has(p))
  )];
  const statPlayers = missing.length ? await prisma.player.findMany({ where: { id: { in: missing } }, select: { id: true, firstName: true, lastName: true } }) : [];
  res.json({ ...game, state, statPlayers });
});
r2.put("/:id", async (req, res) => {
  const { date, innings, note, status, leagueId, stadium, umpireHp, umpire1b, umpire2b, umpire3b, seriesId, sport, ghostRunner, seasonId, awayTeamId, homeTeamId, startedAt } = req.body;
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  if ((awayTeamId || homeTeamId) && game.status !== "SCHEDULED")
    return res.status(400).json({ error: "Los equipos solo se cambian en juegos programados" });
  const newAway = awayTeamId ?? game.awayTeamId, newHome = homeTeamId ?? game.homeTeamId;
  if (newAway === newHome) return res.status(400).json({ error: "Visitante y local no pueden ser el mismo equipo" });
  if (seriesId !== void 0 && (seriesId || null) !== game.seriesId) {
    if (seriesId) {
      const sr = await prisma.series.findUnique({ where: { id: seriesId } });
      if (!sr) return res.status(400).json({ error: "Serie no encontrada" });
      if (game.leagueId && sr.leagueId !== game.leagueId)
        return res.status(400).json({ error: "El juego y la serie son de ligas distintas" });
    }
    await assignGameSeries(req.params.id, seriesId || null);
  }
  let newInnings = innings;
  if (sport && sport !== game.sport && innings === void 0) {
    const oldDef = game.sport === "softball" ? 7 : 9;
    if (game.innings === oldDef) newInnings = sport === "softball" ? 7 : 9;
  }
  const updated = await prisma.game.update({
    where: { id: req.params.id },
    data: {
      date: gameDate(date),
      innings: newInnings,
      note,
      status,
      leagueId,
      startedAt: startedAt ? new Date(startedAt) : void 0,
      stadium,
      umpireHp,
      umpire1b,
      umpire2b,
      umpire3b,
      seasonId: seasonId !== void 0 ? seasonId || null : void 0,
      awayTeamId: awayTeamId ?? void 0,
      homeTeamId: homeTeamId ?? void 0,
      sport,
      ghostRunner
    }
  });
  if (updated.status === "FINAL") await accumulateSeason(req.params.id);
  res.json(updated);
});
r2.post("/:id/pause", async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  if (game.status !== "LIVE") return res.status(400).json({ error: "Solo en juegos en curso" });
  const { auto } = req.body;
  if (auto === true) {
    if (game.pausedAt) return res.json(game);
    return res.json(await prisma.game.update({ where: { id: game.id }, data: { pausedAt: /* @__PURE__ */ new Date(), pausedAuto: true } }));
  }
  if (auto === false) {
    if (!game.pausedAt || !game.pausedAuto) return res.json(game);
    return res.json(await prisma.game.update({
      where: { id: game.id },
      data: { pauseSecs: { increment: Math.max(0, Math.floor((Date.now() - new Date(game.pausedAt).getTime()) / 1e3)) }, pausedAt: null, pausedAuto: false }
    }));
  }
  const updated = game.pausedAt ? await prisma.game.update({
    where: { id: game.id },
    data: { pauseSecs: { increment: Math.max(0, Math.floor((Date.now() - new Date(game.pausedAt).getTime()) / 1e3)) }, pausedAt: null, pausedAuto: false }
  }) : await prisma.game.update({ where: { id: game.id }, data: { pausedAt: /* @__PURE__ */ new Date(), pausedAuto: false } });
  res.json(updated);
});
r2.post("/:id/start", async (req, res) => {
  const gameId = req.params.id;
  const lineups = await prisma.lineupEntry.findMany({ where: { gameId, active: true } });
  const game = await prisma.game.findUnique({ where: { id: gameId }, include: { homeTeam: true, awayTeam: true } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  for (const [teamId, name] of [[game.awayTeamId, game.awayTeam.name], [game.homeTeamId, game.homeTeam.name]]) {
    const mine = lineups.filter((l) => l.teamId === teamId);
    if (mine.length === 0) return res.status(400).json({ error: `${name}: falta la alineaci\xF3n` });
    if (!mine.some((l) => l.position === "P")) {
      return res.status(400).json({ error: `${name}: define el lanzador abridor (posici\xF3n P en la alineaci\xF3n)` });
    }
  }
  const { date, stadium, umpireHp, umpire1b, umpire2b, umpire3b } = req.body;
  const updated = await prisma.game.update({
    where: { id: gameId },
    data: {
      status: "LIVE",
      startedAt: /* @__PURE__ */ new Date(),
      date: gameDate(date),
      stadium: stadium ?? void 0,
      umpireHp: umpireHp ?? void 0,
      umpire1b: umpire1b ?? void 0,
      umpire2b: umpire2b ?? void 0,
      umpire3b: umpire3b ?? void 0
    }
  });
  res.json(updated);
});
r2.get("/:id/finish-data", async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id }, include: { league: true } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  const events = await loadEvents(req.params.id);
  const state = reduceGame(events, game.innings);
  const winner = state.score.away > state.score.home ? "away" : state.score.home > state.score.away ? "home" : "tie";
  const sug = winner === "tie" ? { wpId: null, lpId: null, wpKind: null, starterOuts: 0, minStarterOuts: 0 } : suggestDecisions(events, game.innings, game.sport, game.league?.wpMinOuts);
  const { cg, sho } = computeCgSho(events, game.innings);
  res.json({
    score: state.score,
    winner,
    tied: winner === "tie",
    suggestedWpId: sug.wpId,
    suggestedLpId: sug.lpId,
    wpKind: sug.wpKind,
    wpStarterOuts: sug.starterOuts,
    wpMinStarterOuts: sug.minStarterOuts,
    cgIds: cg,
    shoIds: sho
  });
});
async function gameContrib(game) {
  const events = await loadEvents(game.id);
  const box = computeBoxscore(events, game.innings);
  const out = /* @__PURE__ */ new Map();
  const participants = /* @__PURE__ */ new Set([
    ...game.lineups.map((l) => l.playerId),
    ...Object.keys(box.pitchers)
  ]);
  const starters = /* @__PURE__ */ new Set();
  const firstTop = events.find((e) => e.half === "TOP" && e.pitcherId)?.pitcherId;
  const firstBot = events.find((e) => e.half === "BOTTOM" && e.pitcherId)?.pitcherId;
  if (firstTop) starters.add(firstTop);
  if (firstBot) starters.add(firstBot);
  const errCount = /* @__PURE__ */ new Map();
  for (const e of events) {
    for (const pid of e.errorOn ?? []) errCount.set(pid, (errCount.get(pid) ?? 0) + 1);
  }
  const holds = game.hldIds ? JSON.parse(game.hldIds) : [];
  const blown = game.bsIds ? JSON.parse(game.bsIds) : [];
  const official = game.fScoreAway != null && game.fScoreHome != null ? { away: game.fScoreAway, home: game.fScoreHome } : void 0;
  const { cg, sho } = computeCgSho(events, game.innings, official);
  for (const pid of participants) {
    const bat = box.away[pid] ?? box.home[pid];
    const pit = box.pitchers[pid];
    out.set(pid, {
      g: 1,
      pa: bat?.pa ?? 0,
      ab: bat?.ab ?? 0,
      r: bat?.r ?? 0,
      h: bat?.h ?? 0,
      doubles: bat?.doubles ?? 0,
      triples: bat?.triples ?? 0,
      hr: bat?.hr ?? 0,
      rbi: bat?.rbi ?? 0,
      bb: bat?.bb ?? 0,
      k: bat?.k ?? 0,
      hbp: bat?.hbp ?? 0,
      sac: bat?.sac ?? 0,
      sf: bat?.sf ?? 0,
      sb: bat?.sb ?? 0,
      gp: pit ? 1 : 0,
      gs: starters.has(pid) ? 1 : 0,
      w: game.wpId === pid ? 1 : 0,
      l: game.lpId === pid ? 1 : 0,
      sv: game.svId === pid ? 1 : 0,
      hld: holds.includes(pid) ? 1 : 0,
      bs: blown.includes(pid) ? 1 : 0,
      cg: cg.includes(pid) ? 1 : 0,
      sho: sho.includes(pid) ? 1 : 0,
      pOuts: pit?.outs ?? 0,
      pH: pit?.h ?? 0,
      pR: pit?.r ?? 0,
      pER: pit?.er ?? 0,
      pBB: pit?.bb ?? 0,
      pK: pit?.k ?? 0,
      pHR: pit?.hr ?? 0,
      pPitches: pit?.pitches ?? 0,
      e: errCount.get(pid) ?? 0
    });
  }
  for (const ln of game.statLines ?? []) {
    const isPart = participants.has(ln.playerId);
    const data = out.get(ln.playerId) ?? {};
    const add = (k, v) => {
      if (v) data[k] = (data[k] ?? 0) + v;
    };
    add("g", isPart ? 0 : ln.g ?? 1);
    for (const k of [
      "pa",
      "ab",
      "r",
      "h",
      "doubles",
      "triples",
      "hr",
      "rbi",
      "bb",
      "k",
      "hbp",
      "sac",
      "sf",
      "sb",
      "pOuts",
      "pH",
      "pR",
      "pER",
      "pBB",
      "pK",
      "pHR",
      "pPitches",
      "e"
    ]) add(k, ln[k]);
    if (!box.pitchers[ln.playerId]) {
      add("gp", ln.gp ?? (ln.pOuts ? 1 : 0));
      add("gs", ln.gs);
    }
    if (game.wpId !== ln.playerId) add("w", ln.w);
    if (game.lpId !== ln.playerId) add("l", ln.l);
    if (game.svId !== ln.playerId) add("sv", ln.sv);
    if (!holds.includes(ln.playerId)) add("hld", ln.hld);
    if (!blown.includes(ln.playerId)) add("bs", ln.bs);
    if (!cg.includes(ln.playerId)) add("cg", ln.cg);
    if (!sho.includes(ln.playerId)) add("sho", ln.sho);
    if (Object.keys(data).length) out.set(ln.playerId, data);
  }
  return out;
}
async function applySeasonDelta(game, before, after) {
  const season = game.season?.year ?? new Date(game.date).getFullYear();
  const scope = game.seriesId ? "POST" : "REG";
  const pids = [.../* @__PURE__ */ new Set([...before.keys(), ...after.keys()])];
  const existing = new Set(
    (await prisma.playerSeasonStat.findMany({
      where: { playerId: { in: pids }, season, scope },
      select: { playerId: true }
    })).map((r10) => r10.playerId)
  );
  for (const pid of pids) {
    const keys = /* @__PURE__ */ new Set([...Object.keys(before.get(pid) ?? {}), ...Object.keys(after.get(pid) ?? {})]);
    const delta = {};
    for (const k of keys) {
      const d = (after.get(pid)?.[k] ?? 0) - (before.get(pid)?.[k] ?? 0);
      if (d) delta[k] = d;
    }
    if (!Object.keys(delta).length) continue;
    if (existing.has(pid)) {
      await prisma.playerSeasonStat.update({
        where: { playerId_season_scope: { playerId: pid, season, scope } },
        data: Object.fromEntries(Object.entries(delta).map(([k, v]) => [k, { increment: v }]))
      });
    } else if (after.has(pid)) {
      await prisma.playerSeasonStat.create({
        data: { playerId: pid, season, scope, ...after.get(pid) }
      });
    }
  }
}
async function accumulateSeason(gameId) {
  const game = await prisma.game.findUnique({ where: { id: gameId }, include: { lineups: true, season: true } });
  if (!game || game.seasonApplied) return;
  const season = game.season?.year ?? new Date(game.date).getFullYear();
  const scope = game.seriesId ? "POST" : "REG";
  for (const [pid, data] of await gameContrib(game)) {
    await prisma.playerSeasonStat.upsert({
      where: { playerId_season_scope: { playerId: pid, season, scope } },
      create: { playerId: pid, season, scope, ...data },
      update: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { increment: v }]))
    });
  }
  await prisma.game.update({ where: { id: gameId }, data: { seasonApplied: true } });
}
async function assignGameSeries(gameId, seriesId) {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: { lineups: true, season: true }
  });
  if (!game || game.seriesId === seriesId) return;
  const fromScope = game.seriesId ? "POST" : "REG";
  const toScope = seriesId ? "POST" : "REG";
  const contrib = game.seasonApplied && fromScope !== toScope ? await gameContrib(game) : null;
  const seriesSeason = seriesId ? (await prisma.series.findUnique({ where: { id: seriesId }, select: { seasonId: true } }))?.seasonId ?? null : null;
  await prisma.game.update({
    where: { id: gameId },
    data: { seriesId, ...seriesSeason && !game.seasonId ? { seasonId: seriesSeason } : {} }
  });
  if (!contrib) return;
  const season = game.season?.year ?? new Date(game.date).getFullYear();
  for (const [pid, data] of contrib) {
    const dec = Object.fromEntries(Object.entries(data).filter(([, v]) => v).map(([k, v]) => [k, { decrement: v }]));
    if (Object.keys(dec).length) {
      await prisma.playerSeasonStat.updateMany({ where: { playerId: pid, season, scope: fromScope }, data: dec });
    }
    await prisma.playerSeasonStat.upsert({
      where: { playerId_season_scope: { playerId: pid, season, scope: toScope } },
      create: { playerId: pid, season, scope: toScope, ...data },
      update: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { increment: v }]))
    });
  }
}
r2.post("/:id/finish", async (req, res) => {
  const gameId = req.params.id;
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  const { wpId, lpId, svId, hldIds, bsIds, tied } = req.body;
  const isTied = !!tied;
  const updated = await prisma.game.update({
    where: { id: gameId },
    data: {
      status: "FINAL",
      endedAt: game.endedAt ?? /* @__PURE__ */ new Date(),
      tied: isTied,
      wpId: isTied ? null : wpId ?? null,
      lpId: isTied ? null : lpId ?? null,
      svId: isTied ? null : svId ?? null,
      hldIds: isTied ? null : JSON.stringify(hldIds ?? []),
      bsIds: isTied ? null : JSON.stringify(bsIds ?? [])
    }
  });
  await accumulateSeason(gameId);
  autoBackup("juego cerrado");
  res.json(updated);
});
r2.post("/:id/suspend", async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  const updated = await prisma.game.update({
    where: { id: req.params.id },
    data: { status: "SUSPENDED" }
    // endedAt queda vacío: el reloj retoma al continuar
  });
  res.json(updated);
});
r2.post("/:id/forfeit", async (req, res) => {
  const gameId = req.params.id;
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  const { forfeitBy, scoreAway, scoreHome, wpId, lpId, svId, hldIds, bsIds } = req.body;
  if (!forfeitBy || scoreAway == null || scoreHome == null) {
    return res.status(400).json({ error: "forfeitBy, scoreAway y scoreHome requeridos" });
  }
  const winnerAhead = forfeitBy === game.awayTeamId && scoreHome > scoreAway || forfeitBy === game.homeTeamId && scoreAway > scoreHome;
  const updated = await prisma.game.update({
    where: { id: gameId },
    data: {
      status: "FINAL",
      endedAt: game.endedAt ?? /* @__PURE__ */ new Date(),
      forfeitBy,
      fScoreAway: scoreAway,
      fScoreHome: scoreHome,
      tied: scoreAway === scoreHome ? true : false,
      // por regla: solo hay decisiones si el ganador por forfeit ya iba arriba
      wpId: winnerAhead ? wpId ?? null : null,
      lpId: winnerAhead ? lpId ?? null : null,
      svId: winnerAhead ? svId ?? null : null,
      hldIds: winnerAhead ? JSON.stringify(hldIds ?? []) : null,
      bsIds: winnerAhead ? JSON.stringify(bsIds ?? []) : null
    }
  });
  await accumulateSeason(gameId);
  res.json(updated);
});
r2.post("/:id/swap-sides", async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  if (game.status === "FINAL") return res.status(409).json({ error: "El juego ya termin\xF3" });
  await prisma.$transaction([
    prisma.game.update({
      where: { id: game.id },
      data: {
        awayTeamId: game.homeTeamId,
        homeTeamId: game.awayTeamId,
        fScoreAway: game.fScoreHome,
        fScoreHome: game.fScoreAway
      }
    }),
    prisma.$executeRaw`UPDATE GameEvent SET half = IF(half = 'TOP', 'BOTTOM', 'TOP') WHERE gameId = ${game.id}`
  ]);
  res.json(await prisma.game.findUnique({ where: { id: game.id } }));
});
r2.get("/:id/card/:playerId", async (req, res) => {
  const { id, playerId } = req.params;
  const game = await prisma.game.findUnique({ where: { id }, include: { season: true } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: { team: true, seasons: { orderBy: { season: "asc" } } }
  });
  if (!player) return res.status(404).json({ error: "Jugador no encontrado" });
  const events = await loadEvents(id);
  const box = computeBoxscore(events, game.innings);
  const situ = computeSituational(events, game.innings);
  const fld = computeFielding(events);
  res.json({
    player,
    game: {
      batting: box.away[playerId] ?? box.home[playerId] ?? null,
      pitching: box.pitchers[playerId] ?? null,
      fielding: fld[playerId] ?? { po: 0, a: 0, e: 0 },
      situational: situ.away[playerId] ?? situ.home[playerId] ?? null
    },
    // PlayerSeasonStat.adj = corrección manual del admin (delta): las stats de
    // liga la aplican sobre lo derivado — la tarjeta también, o la consulta
    // muestra el récord sin corregir (ej. G-P editado a mano sale "afectado")
    seasons: player.seasons.map((s) => {
      const a = s.adj ?? null;
      if (!a) return s;
      const out = { ...s };
      for (const [k, v] of Object.entries(a)) {
        if (typeof v === "number" && typeof out[k] === "number") out[k] = out[k] + v;
      }
      return out;
    }),
    // fase y año del juego — el cliente elige la fila de temporada correcta
    // (un juego de playoff muestra el acumulado POST, nunca el REG)
    scope: game.seriesId ? "POST" : "REG",
    seasonYear: game.season?.year ?? new Date(game.date).getFullYear(),
    // entradas reglamentarias del juego → ERA = CL × innings×3 / outs
    // (la consulta usaba ×27 fijo y en ligas de 6-7 innings salía inflada)
    innings: game.innings
  });
});
var parseTpl = (raw) => {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return [{ id: "legacy", name: "Plantilla", at: 0, entries: j }];
    if (j && Array.isArray(j.items)) return j.items;
  } catch {
  }
  return [];
};
r2.post("/:id/lineup-template/:teamId", async (req, res) => {
  const { entries, name, tplId, deleteId, renameId } = req.body;
  const team = await prisma.team.findUnique({ where: { id: req.params.teamId }, select: { lineupTemplate: true } });
  if (!team) return res.status(404).json({ error: "Equipo no encontrado" });
  const items = parseTpl(team.lineupTemplate);
  if (deleteId) {
    const next2 = items.filter((t) => t.id !== deleteId);
    await prisma.team.update({ where: { id: req.params.teamId }, data: { lineupTemplate: JSON.stringify({ v: 2, items: next2 }) } });
    return res.json({ ok: true, templates: next2 });
  }
  if (renameId) {
    const it = items.find((t) => t.id === renameId);
    if (!it || !name?.trim()) return res.status(400).json({ error: "plantilla o nombre inv\xE1lido" });
    it.name = name.trim().slice(0, 60);
    await prisma.team.update({ where: { id: req.params.teamId }, data: { lineupTemplate: JSON.stringify({ v: 2, items }) } });
    return res.json({ ok: true, templates: items });
  }
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: "entries requerido" });
  const clean = entries.map((e) => ({ playerId: e.playerId, position: e.position, batsInOrder: e.batsInOrder !== false }));
  const id = tplId && items.some((t) => t.id === tplId) ? tplId : `tpl-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
  const item = items.find((t) => t.id === id);
  const entry = { id, name: (name?.trim() || item?.name || `Alineaci\xF3n ${items.length + 1}`).slice(0, 60), at: Date.now(), entries: clean };
  const next = item ? items.map((t) => t.id === id ? entry : t) : [...items, entry];
  await prisma.team.update({ where: { id: req.params.teamId }, data: { lineupTemplate: JSON.stringify({ v: 2, items: next }) } });
  res.json({ ok: true, templates: next, tplId: id });
});
r2.put("/:id/lineup/:teamId", async (req, res) => {
  const { id, teamId } = req.params;
  const entries = req.body.entries;
  if (!Array.isArray(entries)) return res.status(400).json({ error: "entries requerido" });
  const existing = await prisma.lineupEntry.findMany({ where: { gameId: id, teamId, active: true } });
  const byPlayer = new Map(existing.map((l) => [l.playerId, l]));
  const keepIds = [];
  const ops = entries.map((e) => {
    const cur = byPlayer.get(e.playerId);
    if (cur) {
      keepIds.push(cur.id);
      return prisma.lineupEntry.update({
        where: { id: cur.id },
        data: { order: e.order, position: e.position, batsInOrder: e.batsInOrder ?? true }
      });
    }
    return prisma.lineupEntry.create({
      data: {
        gameId: id,
        teamId,
        playerId: e.playerId,
        order: e.order,
        position: e.position,
        role: e.role ?? "STARTER",
        batsInOrder: e.batsInOrder ?? true
      }
    });
  });
  await prisma.$transaction([
    prisma.lineupEntry.deleteMany({ where: { gameId: id, teamId, active: true, id: { notIn: keepIds } } }),
    ...ops
  ]);
  const lineups = await prisma.lineupEntry.findMany({ where: { gameId: id }, include: { player: true }, orderBy: { order: "asc" } });
  res.json(lineups);
});
r2.post("/:id/lineup-add/:teamId", async (req, res) => {
  const { playerId, position } = req.body;
  if (!playerId) return res.status(400).json({ error: "playerId requerido" });
  const { id, teamId } = req.params;
  const existing = await prisma.lineupEntry.findFirst({
    where: { gameId: id, teamId, playerId, active: true }
  });
  if (existing) return res.json(existing);
  const last = await prisma.lineupEntry.findFirst({
    where: { gameId: id, teamId, order: { lt: 50 } },
    orderBy: { order: "desc" }
  });
  const entry = await prisma.lineupEntry.create({
    data: {
      gameId: id,
      teamId,
      playerId,
      order: (last?.order ?? 0) + 1,
      position: position ?? "EH",
      role: "STARTER",
      batsInOrder: true
    },
    include: { player: true }
  });
  res.status(201).json(entry);
});
r2.post("/:id/substitute", async (req, res) => {
  const { teamId, outPlayerId, inPlayerId, position, subInInning, subInHalf } = req.body;
  if (!teamId || !outPlayerId || !inPlayerId) {
    return res.status(400).json({ error: "teamId, outPlayerId, inPlayerId requeridos" });
  }
  const oldEntry = await prisma.lineupEntry.findFirst({
    where: { gameId: req.params.id, teamId, playerId: outPlayerId, active: true }
  });
  if (!oldEntry) return res.status(404).json({ error: "Jugador saliente no est\xE1 en la alineaci\xF3n activa" });
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  const state = reduceGame(await loadEvents(req.params.id), game?.innings ?? 9);
  const prevOut = await prisma.lineupEntry.findFirst({
    where: { gameId: req.params.id, teamId, playerId: inPlayerId, active: false }
  });
  if (prevOut) {
    const alreadyRein = await prisma.lineupEntry.findFirst({
      where: { gameId: req.params.id, teamId, playerId: inPlayerId, role: "REIN" }
    });
    if (alreadyRein) {
      return res.status(409).json({ error: "Este jugador ya reingres\xF3 una vez \u2014 la regla solo permite un reingreso por juego" });
    }
  }
  const role = prevOut ? "REIN" : "SUB";
  const [, sub] = await prisma.$transaction([
    prisma.lineupEntry.update({
      where: { id: oldEntry.id },
      data: { active: false, role: "OUT" }
    }),
    prisma.lineupEntry.create({
      data: {
        gameId: req.params.id,
        teamId,
        playerId: inPlayerId,
        order: oldEntry.order,
        position: position ?? oldEntry.position,
        batsInOrder: oldEntry.batsInOrder,
        role,
        replacesId: oldEntry.id,
        // en "anotación al vuelo" el cliente manda la entrada/mitad de la hoja que transcribe
        subInInning: Number.isInteger(subInInning) ? subInInning : state.inning,
        subInHalf: subInHalf === "TOP" || subInHalf === "BOTTOM" ? subInHalf : state.half
      },
      include: { player: true }
    })
  ]);
  res.status(201).json(sub);
});
r2.post("/:id/undo-sub", async (req, res) => {
  const { entryId } = req.body;
  if (!entryId) return res.status(400).json({ error: "entryId requerido" });
  const sub = await prisma.lineupEntry.findUnique({ where: { id: entryId } });
  if (!sub || sub.gameId !== req.params.id || sub.role !== "SUB" && sub.role !== "REIN" || !sub.replacesId) {
    return res.status(404).json({ error: "Esa entrada no es una sustituci\xF3n (o ya se deshizo)" });
  }
  const next = await prisma.lineupEntry.findFirst({ where: { replacesId: sub.id } });
  if (next) return res.status(409).json({ error: "Este jugador tambi\xE9n sali\xF3 sustituido \u2014 deshaz primero el \xFAltimo cambio" });
  const out = await prisma.lineupEntry.findUnique({ where: { id: sub.replacesId } });
  if (!out) return res.status(404).json({ error: "La entrada original ya no existe" });
  let prevRole = "STARTER";
  if (out.replacesId) {
    const pred = await prisma.lineupEntry.findUnique({ where: { id: out.replacesId } });
    prevRole = pred?.playerId === out.playerId ? "REIN" : "SUB";
  }
  await prisma.$transaction([
    prisma.lineupEntry.delete({ where: { id: sub.id } }),
    prisma.lineupEntry.update({ where: { id: out.id }, data: { active: true, role: prevRole } })
  ]);
  const lineups = await prisma.lineupEntry.findMany({
    where: { gameId: req.params.id },
    include: { player: true },
    orderBy: { order: "asc" }
  });
  res.json({ ok: true, restored: out.playerId, role: prevRole, lineups });
});
r2.put("/:id/positions/:teamId", async (req, res) => {
  const { id, teamId } = req.params;
  const entries = req.body.entries;
  if (!Array.isArray(entries)) return res.status(400).json({ error: "entries requerido" });
  const byPlayer = new Map(entries.map((e) => [e.playerId, e.position]));
  const actives = await prisma.lineupEntry.findMany({ where: { gameId: id, teamId, active: true } });
  await prisma.$transaction(
    actives.filter((l) => byPlayer.has(l.playerId) && byPlayer.get(l.playerId) !== l.position).map((l) => prisma.lineupEntry.update({ where: { id: l.id }, data: { position: byPlayer.get(l.playerId) } }))
  );
  const lineups = await prisma.lineupEntry.findMany({
    where: { gameId: id },
    include: { player: true },
    orderBy: { order: "asc" }
  });
  res.json(lineups);
});
r2.post("/:id/swap-player", async (req, res) => {
  const u = await reqUser(req);
  const open = !await authEnabled();
  if (!open && u?.role !== "admin") return res.status(403).json({ error: "Requiere rol admin" });
  const { teamId, aId, bId } = req.body;
  if (!teamId || !aId || !bId) return res.status(400).json({ error: "teamId, aId, bId requeridos" });
  if (aId === bId) return res.status(400).json({ error: "Es el mismo jugador" });
  return enqueue(req.params.id, async () => {
    const game = await prisma.game.findUnique({
      where: { id: req.params.id },
      include: { lineups: true, season: true }
    });
    if (!game) return res.status(404).json({ error: "Juego no encontrado" });
    const newP = await prisma.player.findUnique({ where: { id: bId } });
    if (!newP) return res.status(404).json({ error: "El jugador correcto no existe" });
    const aEntries = await prisma.lineupEntry.findMany({
      where: { gameId: req.params.id, teamId, playerId: aId }
    });
    const lines = game.statLines ?? [];
    const aInLines = lines.some((l) => l.playerId === aId && l.teamId === teamId);
    const aInEvents = !aEntries.length && !aInLines && !!await prisma.gameEvent.findFirst({
      where: {
        gameId: req.params.id,
        OR: [
          { pitcherId: aId, half: teamId === game.homeTeamId ? "TOP" : "BOTTOM" },
          { batterId: aId, half: teamId === game.awayTeamId ? "TOP" : "BOTTOM" }
        ]
      },
      select: { id: true }
    });
    if (!aEntries.length && !aInLines && !aInEvents) return res.status(404).json({ error: "Ese jugador no est\xE1 en la alineaci\xF3n de este equipo" });
    const bEntries = await prisma.lineupEntry.findMany({
      where: { gameId: req.params.id, teamId, playerId: bId }
    });
    const swapId = (x) => x === aId ? bId : x === bId ? aId : x ?? null;
    const swapJsonIds = (s) => {
      if (!s) return s;
      try {
        return JSON.stringify(JSON.parse(s).map((x) => swapId(x)));
      } catch {
        return s;
      }
    };
    const ops = [
      ...aEntries.map((e) => prisma.lineupEntry.update({ where: { id: e.id }, data: { playerId: bId } })),
      ...bEntries.map((e) => prisma.lineupEntry.update({ where: { id: e.id }, data: { playerId: aId } }))
    ];
    let evFixed = 0;
    const evs = await prisma.gameEvent.findMany({ where: { gameId: req.params.id } });
    for (const e of evs) {
      const nBatter = swapId(e.batterId);
      const nPitcher = swapId(e.pitcherId);
      const adv = e.advances ?? [];
      const nAdv = adv.map((a) => a?.playerId ? { ...a, playerId: swapId(a.playerId) } : a);
      const nErr = swapJsonIds(e.errorOn), nPut = swapJsonIds(e.putouts), nAst = swapJsonIds(e.assists);
      if (nBatter !== (e.batterId ?? null) || nPitcher !== (e.pitcherId ?? null) || JSON.stringify(nAdv) !== JSON.stringify(adv) || nErr !== e.errorOn || nPut !== e.putouts || nAst !== e.assists) {
        evFixed++;
        ops.push(prisma.gameEvent.update({
          where: { id: e.id },
          data: { batterId: nBatter, pitcherId: nPitcher, advances: nAdv, errorOn: nErr, putouts: nPut, assists: nAst }
        }));
      }
    }
    const gUpd = {};
    for (const k of ["wpId", "lpId", "svId"]) {
      if (game[k] === aId || game[k] === bId) gUpd[k] = swapId(game[k]);
    }
    for (const k of ["hldIds", "bsIds"]) {
      const n = swapJsonIds(game[k]);
      if (n !== game[k]) gUpd[k] = n;
    }
    const nLines = lines.map((l) => l.playerId ? { ...l, playerId: swapId(l.playerId) } : l);
    if (JSON.stringify(nLines) !== JSON.stringify(lines)) {
      gUpd.statLines = JSON.parse(JSON.stringify(nLines));
      evFixed += 1;
    }
    if (Object.keys(gUpd).length) ops.push(prisma.game.update({ where: { id: game.id }, data: gUpd }));
    const needResync = game.status === "FINAL" || game.seasonApplied;
    const before = needResync ? await gameContrib(game) : null;
    await prisma.$transaction(ops);
    if (before) {
      const fresh = await prisma.game.findUnique({
        where: { id: game.id },
        include: { lineups: true, season: true }
      });
      if (fresh) await applySeasonDelta(fresh, before, await gameContrib(fresh));
    }
    const lineups = await prisma.lineupEntry.findMany({
      where: { gameId: req.params.id },
      include: { player: true },
      orderBy: { order: "asc" }
    });
    res.json({ ok: true, swapped: bEntries.length > 0, eventsFixed: evFixed, lineups });
  });
});
r2.post("/:id/swap-order", async (req, res) => {
  const { teamId, aId, bId } = req.body;
  if (!teamId || !aId || !bId) return res.status(400).json({ error: "teamId, aId, bId requeridos" });
  if (aId === bId) return res.status(400).json({ error: "Es el mismo jugador" });
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  const aE = await prisma.lineupEntry.findFirst({ where: { gameId: game.id, teamId, playerId: aId, active: true } }) ?? await prisma.lineupEntry.findFirst({ where: { gameId: game.id, teamId, playerId: aId } });
  const bE = await prisma.lineupEntry.findFirst({ where: { gameId: game.id, teamId, playerId: bId, active: true } }) ?? await prisma.lineupEntry.findFirst({ where: { gameId: game.id, teamId, playerId: bId } });
  if (!aE || !bE) return res.status(404).json({ error: "Ambos jugadores deben estar en la alineaci\xF3n" });
  await prisma.$transaction([
    prisma.lineupEntry.update({ where: { id: aE.id }, data: { order: bE.order } }),
    prisma.lineupEntry.update({ where: { id: bE.id }, data: { order: aE.order } })
  ]);
  const lineups = await prisma.lineupEntry.findMany({
    where: { gameId: game.id },
    include: { player: true },
    orderBy: { order: "asc" }
  });
  res.json({ ok: true, pasMoved: 0, lineups });
});
r2.put("/:id/decisions", async (req, res) => {
  const u = await reqUser(req);
  const open = !await authEnabled();
  if (!open && u?.role !== "admin") return res.status(403).json({ error: "Requiere rol admin" });
  const { wpId, lpId, svId, hldIds, bsIds, tied, forfeitBy, fScoreAway, fScoreHome } = req.body;
  const gameId = req.params.id;
  return enqueue(gameId, async () => {
    const prev = await prisma.game.findUnique({ where: { id: gameId }, include: { lineups: true, season: true } });
    if (!prev) return res.status(404).json({ error: "Juego no encontrado" });
    const data = {
      wpId: wpId === void 0 ? void 0 : wpId,
      lpId: lpId === void 0 ? void 0 : lpId,
      svId: svId === void 0 ? void 0 : svId,
      hldIds: hldIds === void 0 ? void 0 : hldIds?.length ? JSON.stringify(hldIds) : null,
      bsIds: bsIds === void 0 ? void 0 : bsIds?.length ? JSON.stringify(bsIds) : null,
      tied: tied === void 0 ? void 0 : !!tied,
      forfeitBy: forfeitBy === void 0 ? void 0 : forfeitBy,
      fScoreAway: fScoreAway === void 0 ? void 0 : fScoreAway,
      fScoreHome: fScoreHome === void 0 ? void 0 : fScoreHome
    };
    const before = prev.status === "FINAL" || prev.seasonApplied ? await gameContrib(prev) : null;
    const game = await prisma.game.update({ where: { id: gameId }, data });
    if (before) {
      const after = await gameContrib({ ...prev, ...game });
      await applySeasonDelta(prev, before, after);
      if (!prev.seasonApplied) {
        await prisma.game.update({ where: { id: gameId }, data: { seasonApplied: true } });
      }
    }
    res.json(game);
  });
});
r2.put("/:id/stat-lines/:playerId", async (req, res) => {
  const u = await reqUser(req);
  const open = !await authEnabled();
  if (!open && u?.role !== "admin") return res.status(403).json({ error: "Requiere rol admin" });
  const gameId = req.params.id, playerId = req.params.playerId;
  const { teamId, stats, lineup } = req.body;
  return enqueue(gameId, async () => {
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: { lineups: true, season: true }
    });
    if (!game) return res.status(404).json({ error: "Juego no encontrado" });
    const player = await prisma.player.findUnique({ where: { id: playerId } });
    if (!player) return res.status(404).json({ error: "Jugador no existe" });
    const tid = teamId ?? game.lineups.find((l) => l.playerId === playerId)?.teamId ?? null;
    if (tid && tid !== game.awayTeamId && tid !== game.homeTeamId)
      return res.status(400).json({ error: "El equipo no es de este juego" });
    const clean = {};
    for (const k of SL_NUMS) {
      if (stats && k in stats) {
        const v = Number(stats[k]);
        if (!Number.isFinite(v) || v < 0)
          return res.status(400).json({ error: `${k}: n\xFAmero inv\xE1lido` });
        if (v) clean[k] = v;
      }
    }
    if (stats && "ip" in stats) {
      const ip = Number(stats.ip);
      if (!Number.isFinite(ip) || ip < 0) return res.status(400).json({ error: "ip: n\xFAmero inv\xE1lido" });
      if (ip) clean.pOuts = Math.floor(ip) * 3 + Math.round(ip % 1 * 10);
    }
    const lines = game.statLines ?? [];
    const prev = mergeLines(lines.filter((l) => l.playerId === playerId));
    const others = lines.filter((l) => l.playerId !== playerId);
    const evs = await prisma.gameEvent.findMany({
      where: { gameId },
      select: { batterId: true, pitcherId: true, advances: true, errorOn: true, putouts: true, assists: true }
    });
    const inLineup = game.lineups.some((l) => l.playerId === playerId);
    const inEvents = evs.some((e) => e.batterId === playerId || e.pitcherId === playerId || JSON.stringify(e.advances ?? "").includes(playerId) || (e.errorOn ?? "").includes(playerId) || (e.putouts ?? "").includes(playerId) || (e.assists ?? "").includes(playerId));
    const gFlag = inLineup || inEvents ? 0 : 1;
    const hasStats = Object.keys(clean).length > 0;
    const newline = hasStats || gFlag ? { playerId, teamId: tid, g: gFlag, ...clean } : void 0;
    const nextLines = newline ? [...others, newline] : others;
    await prisma.game.update({
      where: { id: gameId },
      data: { statLines: JSON.parse(JSON.stringify(nextLines)) }
    });
    let lineupAdded = false;
    if (lineup?.add && tid && !inLineup) {
      if (!lineup.position) return res.status(400).json({ error: "Falta la posici\xF3n para agregarlo al lineup" });
      const maxOrder = game.lineups.filter((l) => l.teamId === tid).reduce((m, l) => Math.max(m, l.order), 0);
      await prisma.lineupEntry.create({
        data: {
          gameId,
          teamId: tid,
          playerId,
          order: lineup.order && lineup.order > 0 ? lineup.order : maxOrder + 1,
          position: lineup.position,
          role: lineup.role ?? "SUB",
          active: true
        }
      });
      lineupAdded = true;
    }
    let seasonAdjusted = false;
    if (game.status === "FINAL" || game.seasonApplied) {
      const season = game.season?.year ?? new Date(game.date).getFullYear();
      const scope = game.seriesId ? "POST" : "REG";
      const delta = {};
      const merged = newline;
      for (const k of SEASON_KEYS) {
        const d = (merged?.[k] ?? 0) - (prev?.[k] ?? 0);
        if (d) delta[k] = d;
      }
      if (Object.keys(delta).length) {
        await prisma.playerSeasonStat.upsert({
          where: { playerId_season_scope: { playerId, season, scope } },
          create: { playerId, season, scope, ...delta },
          update: Object.fromEntries(Object.entries(delta).map(([k, v]) => [k, { increment: v }]))
        });
        seasonAdjusted = true;
      }
    }
    const lineups = await prisma.lineupEntry.findMany({
      where: { gameId },
      include: { player: true },
      orderBy: { order: "asc" }
    });
    res.json({ ok: true, line: newline, statLines: nextLines, lineupAdded, seasonAdjusted, lineups });
  });
});
r2.delete("/:id/stat-lines/:playerId", async (req, res) => {
  const u = await reqUser(req);
  const open = !await authEnabled();
  if (!open && u?.role !== "admin") return res.status(403).json({ error: "Requiere rol admin" });
  const gameId = req.params.id, playerId = req.params.playerId;
  return enqueue(gameId, async () => {
    const game = await prisma.game.findUnique({ where: { id: gameId }, include: { lineups: true, season: true } });
    if (!game) return res.status(404).json({ error: "Juego no encontrado" });
    const lines = game.statLines ?? [];
    const prev = mergeLines(lines.filter((l) => l.playerId === playerId));
    if (!prev) return res.status(404).json({ error: "El jugador no tiene l\xEDnea manual en este juego" });
    const nextLines = lines.filter((l) => l.playerId !== playerId);
    await prisma.game.update({
      where: { id: gameId },
      data: { statLines: nextLines.length ? JSON.parse(JSON.stringify(nextLines)) : Prisma.DbNull }
    });
    if (req.query.lineup === "1") {
      await prisma.lineupEntry.deleteMany({ where: { gameId, playerId } });
    }
    if (game.status === "FINAL" || game.seasonApplied) {
      const season = game.season?.year ?? new Date(game.date).getFullYear();
      const scope = game.seriesId ? "POST" : "REG";
      const delta = {};
      for (const k of SEASON_KEYS) {
        const v = prev[k];
        if (v) delta[k] = -v;
      }
      if (Object.keys(delta).length) {
        await prisma.playerSeasonStat.upsert({
          where: { playerId_season_scope: { playerId, season, scope } },
          create: { playerId, season, scope, ...delta },
          update: Object.fromEntries(Object.entries(delta).map(([k, v]) => [k, { increment: v }]))
        });
      }
    }
    res.json({ ok: true, statLines: nextLines });
  });
});
r2.delete("/:id", async (req, res) => {
  const auth = await adminOk(String(req.body?.password ?? ""));
  if (!auth.ok) return res.status(auth.code ?? 401).json({ error: auth.error });
  const game = await prisma.game.findUnique({
    where: { id: req.params.id },
    include: { lineups: true, season: true }
  });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  if (game.seasonApplied) {
    const scope = game.seriesId ? "POST" : "REG";
    const season = game.season?.year ?? new Date(game.date).getFullYear();
    for (const [pid, data] of await gameContrib(game)) {
      const dec = Object.fromEntries(Object.entries(data).filter(([, v]) => v).map(([k, v]) => [k, { decrement: v }]));
      if (Object.keys(dec).length) {
        await prisma.playerSeasonStat.updateMany({ where: { playerId: pid, season, scope }, data: dec });
      }
    }
  }
  await prisma.game.delete({ where: { id: req.params.id } });
  res.status(204).end();
});
var games_default = r2;

// src/routes/events.ts
import { Router as Router3 } from "express";
var r3 = Router3();
var asyncH = (f) => (req, res, next) => {
  Promise.resolve(f(req, res)).catch(next);
};
var NUM_TO_POS = Object.fromEntries(Object.entries(FIELD_NUM).map(([pos, n]) => [n, pos]));
var fielderAt = (lineup, n) => {
  const pos = NUM_TO_POS[n];
  return pos ? lineup.find((l) => l.position === pos)?.playerId ?? null : null;
};
function errorFielders(lineup, notation, result) {
  if (!notation) return [];
  const n2 = result && notation.startsWith(`${result}-`) ? notation.slice(result.length + 1) : notation;
  const nums = [...n2.matchAll(/E-?(\d+)/g)].map((m) => Number(m[1]));
  const ids = [];
  for (const n of nums) {
    const pid = fielderAt(lineup, n);
    if (pid) ids.push(pid);
  }
  return ids;
}
var normNotation = (s) => s.replace(/([EFLPXH]+\d+)-(\d+)(?=-|$)/g, (m, lt, d) => lt.endsWith(d) ? lt : m).replace(/([A-Z]+\d+)-\1(?=-|$)/g, "$1").replace(/(\d+)-E\1(?=-|$)/g, "E$1").replace(/([7-9])(?:-\1)+(?=-|$)/g, "$1");
var HIT_RESULTS = /* @__PURE__ */ new Set(["1B", "2B", "3B", "HR", "HRIP", "1BE", "2BE", "3BE", "RHB"]);
var NO_CONTENT_DEDUP = /* @__PURE__ */ new Set(["B", "S", "F", "IPL", "EF", "RBI", "EU", "ADJ", "EI", "LG", "SK"]);
var HIT_TYPE_MARK = { "1": "1B", "2": "2B", "3": "3B", "4": "HR" };
var hitZonePrefix = (notation, result) => {
  if (!notation || !HIT_RESULTS.has(result)) return notation;
  if (/^[GLFX]?\d{1,2}$/.test(notation)) return `${result}-${notation}`;
  const hm = /^H([GLFX]?)(\d{1,2})(?:-(\d{1,2}))?$/i.exec(notation);
  if (hm) {
    const [, traj, d, zone] = hm;
    if (HIT_TYPE_MARK[d] && (HIT_TYPE_MARK[d] === result || d === "4" && result === "HRIP")) {
      return zone ? `${result}-${zone}` : null;
    }
    return `${result}-${traj}${d}`.toUpperCase();
  }
  return notation;
};
function fieldingCredits(lineup, notation, result, outsOnPlay) {
  const po = [], a = [];
  let toks = normNotation(
    notation && notation.startsWith(`${result}-`) ? notation.slice(result.length + 1) : notation ?? ""
  ).split(/[-\s]+/).map((t) => t.trim()).filter((t) => !/^H/i.test(t)).map((t) => ({ e: /^E/i.test(t), n: Number(t.replace(/^[A-Z]+/i, "")) })).filter((t) => Number.isInteger(t.n) && t.n >= 1 && t.n <= 10);
  if (["1BE", "2BE", "3BE"].includes(result) && toks.length > 1 && !toks[0].e) toks = toks.slice(1);
  if (!toks.length) {
    if (result === "K" && outsOnPlay > 0) {
      const c = fielderAt(lineup, 2);
      if (c) po.push(c);
    }
    return { po, a };
  }
  if (outsOnPlay === 0) return { po, a };
  let outsCredited = 0;
  if (toks.length === 1) {
    const isHit = ["1B", "2B", "3B", "HR", "HRIP", "1BE", "2BE", "3BE", "RHB"].includes(result);
    if (!toks[0].e && !isHit && outsOnPlay > 0) {
      const pid = fielderAt(lineup, toks[0].n);
      if (pid) {
        po.push(pid);
        outsCredited++;
      }
    }
    return { po, a };
  }
  if (outsOnPlay <= 1) {
    const poTok = outsOnPlay === 1 && !toks[toks.length - 1].e ? toks[toks.length - 1] : null;
    for (const t of toks) {
      if (t.e) continue;
      const pid = fielderAt(lineup, t.n);
      if (!pid) continue;
      if (t === poTok) po.push(pid);
      else if (!a.includes(pid)) a.push(pid);
    }
    return { po, a };
  }
  for (let i = 0; i + 1 < toks.length; i++) {
    const cur = toks[i], nxt = toks[i + 1];
    if (!cur.e) {
      const pid = fielderAt(lineup, cur.n);
      if (pid && !a.includes(pid)) a.push(pid);
    }
    if (!nxt.e && outsCredited < outsOnPlay) {
      const pid = fielderAt(lineup, nxt.n);
      if (pid) {
        po.push(pid);
        outsCredited++;
      }
    }
  }
  return { po, a };
}
async function repairEventNotation() {
  const evs = await prisma.gameEvent.findMany({
    where: { notation: { not: null } },
    select: { id: true, gameId: true, notation: true, result: true, half: true, advances: true }
  });
  const games = /* @__PURE__ */ new Map();
  let fixed = 0;
  for (const ev of evs) {
    const clean = hitZonePrefix(normNotation(ev.notation), ev.result);
    if (clean === ev.notation) continue;
    const g = games.get(ev.gameId) ?? await prisma.game.findUnique({ where: { id: ev.gameId }, select: { homeTeamId: true, awayTeamId: true } });
    if (!g) continue;
    games.set(ev.gameId, g);
    const teamId = ev.half === "TOP" ? g.homeTeamId : g.awayTeamId;
    const lineup = await prisma.lineupEntry.findMany({ where: { gameId: ev.gameId, teamId, active: true } });
    const errorOn = errorFielders(lineup, clean, ev.result);
    const outsOnPlay = (ev.advances ?? []).filter((x) => x?.to === "OUT").length;
    const fld = fieldingCredits(lineup, clean, ev.result, outsOnPlay);
    await prisma.gameEvent.update({
      where: { id: ev.id },
      data: {
        notation: clean,
        errorOn: errorOn.length ? JSON.stringify(errorOn) : null,
        putouts: fld.po.length ? JSON.stringify(fld.po) : null,
        assists: fld.a.length ? JSON.stringify(fld.a) : null
      }
    });
    fixed++;
  }
  return fixed;
}
r3.get("/:id/events", asyncH(async (req, res) => {
  res.json(await loadEvents(req.params.id));
}));
r3.put("/:id/events/:seq", asyncH(async (req, res) => {
  const u = await reqUser(req);
  const gameId = req.params.id;
  const [game, ev] = await Promise.all([
    prisma.game.findUnique({ where: { id: gameId } }),
    prisma.gameEvent.findUnique({ where: { gameId_seq: { gameId, seq: Number(req.params.seq) } } })
  ]);
  if (!game || !ev) return res.status(404).json({ error: "Jugada no encontrada" });
  const open = !await authEnabled();
  const allowed = open || u?.role === "admin" || u?.role === "anotador" && game.status !== "FINAL";
  if (!allowed) return res.status(403).json({ error: "Juego finalizado \u2014 usa la Auditor\xEDa (admin)" });
  return enqueue(gameId, async () => {
    const { result, notation, batterId, pitcherId, advances, inning, half, sprayDir, sprayDist } = req.body;
    const str = (v, max) => v === void 0 || v === null || typeof v === "string" && v.length <= max;
    if (!str(result, 40) || !str(notation, 191) || !str(batterId, 191) || !str(pitcherId, 191)) {
      return res.status(400).json({ error: "campo inv\xE1lido o demasiado largo" });
    }
    const sprayNum = (v) => v == null || typeof v === "number" && Number.isFinite(v);
    if (!sprayNum(sprayDir) || !sprayNum(sprayDist)) return res.status(400).json({ error: "spray inv\xE1lido" });
    if (inning != null && (!Number.isFinite(Number(inning)) || Number(inning) < 1 || Number(inning) > 99)) {
      return res.status(400).json({ error: "Entrada inv\xE1lida" });
    }
    if (advances !== void 0 && !Array.isArray(advances)) {
      return res.status(400).json({ error: "advances debe ser una lista" });
    }
    const newHalf = half === "TOP" || half === "BOTTOM" ? half : ev.half;
    const newResult = result ?? ev.result;
    const clean = notation === void 0 ? ev.notation : notation ? normNotation(String(notation)) : null;
    const newNotation = hitZonePrefix(
      clean && HIT_RESULTS.has(newResult) ? clean.replace(/(\d)-\1(?=-|$)/g, "$1") : clean,
      newResult
    );
    const newAdv = advances === void 0 ? ev.advances : advances;
    const fieldingTeamId = newHalf === "TOP" ? game.homeTeamId : game.awayTeamId;
    const lineup = await prisma.lineupEntry.findMany({ where: { gameId, teamId: fieldingTeamId, active: true } });
    const err = errorFielders(lineup, newNotation, newResult);
    const outsOnPlay = newAdv?.filter((x) => x.to === "OUT").length ?? 0;
    const fld = fieldingCredits(lineup, newNotation, newResult, outsOnPlay);
    const updated = await prisma.gameEvent.update({
      where: { id: ev.id },
      data: {
        result: newResult,
        notation: newNotation,
        batterId: batterId === void 0 ? ev.batterId : batterId,
        pitcherId: pitcherId === void 0 ? ev.pitcherId : pitcherId,
        advances: newAdv ?? void 0,
        inning: inning != null ? Number(inning) : ev.inning,
        half: newHalf,
        // spray: solo se toca si viene en el body (null lo limpia a propósito)
        ...sprayDir !== void 0 || sprayDist !== void 0 ? { sprayDir: sprayDir ?? null, sprayDist: sprayDist ?? null } : {},
        errorOn: err.length ? JSON.stringify(err) : null,
        putouts: fld.po.length ? JSON.stringify(fld.po) : null,
        assists: fld.a.length ? JSON.stringify(fld.a) : null
      }
    });
    const events = await loadEvents(gameId);
    res.json({ event: toEvent(updated), state: reduceGame(events, game.innings) });
  });
}));
r3.post("/:id/events", asyncH(async (req, res) => {
  const gameId = req.params.id;
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  return enqueue(gameId, async () => {
    const events = await loadEvents(gameId);
    const state = reduceGame(events, game.innings);
    const { batterId, pitcherId, result, notation, advances, inning, half, aiVoice, aiJson, aiVideo, clientKey, sprayDir, sprayDist, beforeSeq } = req.body;
    if (!result || !Array.isArray(advances)) return res.status(400).json({ error: "result y advances requeridos" });
    if (beforeSeq != null && (!Number.isInteger(beforeSeq) || beforeSeq < 1)) {
      return res.status(400).json({ error: "beforeSeq inv\xE1lido" });
    }
    const num2 = (v, lo, hi) => v == null || typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
    if (!num2(sprayDir, -180, 180) || !num2(sprayDist, 0, 400)) return res.status(400).json({ error: "spray fuera de rango" });
    const str = (v, max) => v == null || typeof v === "string" && v.length <= max;
    if (typeof result !== "string" || result.length > 40 || !str(notation, 191) || !str(clientKey, 191) || !str(batterId, 191) || !str(pitcherId, 191) || !str(aiVoice, 65e3) || !str(aiJson, 16e6) || !str(aiVideo, 16e6)) {
      return res.status(400).json({ error: "campo inv\xE1lido o demasiado largo" });
    }
    if (clientKey) {
      try {
        const dup = await prisma.gameEvent.findFirst({ where: { gameId, clientKey: String(clientKey) } });
        if (dup) {
          const evs = await loadEvents(gameId);
          return res.json({ event: toEvent(dup), state: reduceGame(evs, game.innings), dup: true });
        }
      } catch {
      }
    }
    const fly = inning != null && (half === "TOP" || half === "BOTTOM");
    const cur = await prisma.game.findUnique({ where: { id: gameId }, select: { status: true } });
    if (cur?.status === "FINAL" || !fly && state.status === "FINAL") {
      return res.status(409).json({ error: "El juego ya termin\xF3" });
    }
    const evInning = fly ? Number(inning) : state.inning;
    const evHalf = fly ? half : state.half;
    const fieldingTeamId = evHalf === "TOP" ? game.homeTeamId : game.awayTeamId;
    const lineup = await prisma.lineupEntry.findMany({ where: { gameId, teamId: fieldingTeamId, active: true } });
    const cleanNotation = notation ? normNotation(String(notation)) : null;
    const hitNotation = hitZonePrefix(
      cleanNotation && HIT_RESULTS.has(result) ? cleanNotation.replace(/(\d)-\1(?=-|$)/g, "$1") : cleanNotation,
      result
    );
    const errorOn = errorFielders(lineup, hitNotation, result);
    const outsOnPlay = advances.filter((x) => x.to === "OUT").length;
    const fld = fieldingCredits(lineup, hitNotation, result, outsOnPlay);
    const last = events[events.length - 1];
    const sameAdv = (a, b) => {
      const sig = (x) => (x ?? []).map((v) => `${v?.playerId}:${v?.to}`).join(",");
      return sig(a) === sig(b);
    };
    if (beforeSeq == null && last && !NO_CONTENT_DEDUP.has(String(result)) && last.result === result && (last.batterId ?? null) === (batterId ?? null) && (last.pitcherId ?? null) === (pitcherId ?? null) && (last.notation ?? null) === (hitNotation ?? null) && sameAdv(last.advances, advances)) {
      const evs = await loadEvents(gameId);
      return res.json({ event: last, state: reduceGame(evs, game.innings), dup: true });
    }
    let seq = (events[events.length - 1]?.seq ?? 0) + 1;
    if (beforeSeq != null) {
      const bs = Number(beforeSeq);
      if (bs > seq) return res.status(400).json({ error: `No existe la jugada #${bs}` });
      if (bs < seq) {
        await prisma.$executeRaw`UPDATE GameEvent SET seq = seq + 1 WHERE gameId = ${gameId} AND seq >= ${bs} ORDER BY seq DESC`;
      }
      seq = bs;
    }
    const data = {
      gameId,
      inning: evInning,
      half: evHalf,
      batterId: batterId ?? null,
      pitcherId: pitcherId ?? null,
      result,
      notation: hitNotation,
      advances,
      ...sprayDir != null && sprayDist != null ? { sprayDir: Number(sprayDir), sprayDist: Number(sprayDist) } : {},
      errorOn: errorOn.length ? JSON.stringify(errorOn) : null,
      putouts: fld.po.length ? JSON.stringify(fld.po) : null,
      assists: fld.a.length ? JSON.stringify(fld.a) : null,
      ...clientKey ? { clientKey: String(clientKey) } : {},
      // los campos ai* solo se envían con valor — un cliente Prisma
      // desactualizado (actualización sin `prisma generate`) los rechaza
      // aunque vengan null, y eso tumba el server entero al anotar
      ...aiVoice ? { aiVoice } : {},
      ...aiJson ? { aiJson } : {},
      ...aiVideo ? { aiVideo } : {}
    };
    const droppedArgs = /* @__PURE__ */ new Set();
    let created;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      try {
        const d = droppedArgs.size ? Object.fromEntries(Object.entries(data).filter(([k]) => !droppedArgs.has(k))) : data;
        created = await prisma.gameEvent.create({ data: { ...d, seq } });
      } catch (e) {
        const code = e?.code;
        const msg = String(e?.message ?? "");
        const target = String(e?.meta?.target ?? "");
        const bad = /Unknown argument ['`"]?(\w+)['`"]?/.exec(msg)?.[1];
        if (bad && bad !== "seq" && bad !== "gameId" && !droppedArgs.has(bad)) {
          droppedArgs.add(bad);
          continue;
        }
        if (clientKey && code === "P2002" && target.includes("clientKey")) {
          const dup = await prisma.gameEvent.findFirst({ where: { gameId, clientKey: String(clientKey) } });
          if (dup) {
            const evs = await loadEvents(gameId);
            return res.json({ event: toEvent(dup), state: reduceGame(evs, game.innings), dup: true });
          }
          throw e;
        }
        if (code === "P2002") {
          const evs = await loadEvents(gameId);
          seq = (evs[evs.length - 1]?.seq ?? 0) + 1;
          continue;
        }
        throw e;
      }
    }
    if (!created) return res.status(500).json({ error: "No se pudo grabar la jugada \u2014 reintenta" });
    const newEvents = seq !== created.seq || beforeSeq != null ? await loadEvents(gameId) : [...events, toEvent(created)];
    const newState = reduceGame(newEvents, game.innings);
    if (newState.status !== game.status) {
      await prisma.game.update({
        where: { id: gameId },
        data: { status: newState.status, endedAt: newState.status === "FINAL" ? /* @__PURE__ */ new Date() : void 0 }
      });
    } else if (game.status === "SCHEDULED") {
      await prisma.game.update({ where: { id: gameId }, data: { status: "LIVE" } });
    }
    res.status(201).json({ event: toEvent(created), state: newState });
  });
}));
r3.delete("/:id/events/last", asyncH(async (req, res) => {
  const gameId = req.params.id;
  return enqueue(gameId, async () => {
    const last = await prisma.gameEvent.findFirst({ where: { gameId }, orderBy: { seq: "desc" } });
    if (!last) return res.status(404).json({ error: "No hay eventos" });
    await prisma.gameEvent.delete({ where: { id: last.id } });
    const game = await prisma.game.findUnique({ where: { id: gameId } });
    const state = reduceGame(await loadEvents(gameId), game?.innings ?? 9);
    if (game && game.status !== state.status && state.status === "LIVE") {
      await prisma.game.update({ where: { id: gameId }, data: { status: "LIVE" } });
    }
    res.json({ deleted: last, state });
  });
}));
r3.delete("/:id/events/:seq", asyncH(async (req, res) => {
  const u = await reqUser(req);
  const gameId = req.params.id;
  const [game, ev] = await Promise.all([
    prisma.game.findUnique({ where: { id: gameId } }),
    prisma.gameEvent.findUnique({ where: { gameId_seq: { gameId, seq: Number(req.params.seq) } } })
  ]);
  if (!game || !ev) return res.status(404).json({ error: "Jugada no encontrada" });
  const open = !await authEnabled();
  const allowed = open || u?.role === "admin" || u?.role === "anotador" && game.status !== "FINAL";
  if (!allowed) return res.status(403).json({ error: "Juego finalizado \u2014 usa la Auditor\xEDa (admin)" });
  return enqueue(gameId, async () => {
    await prisma.gameEvent.delete({ where: { id: ev.id } });
    const state = reduceGame(await loadEvents(gameId), game.innings);
    if (game.status !== state.status && state.status === "LIVE") {
      await prisma.game.update({ where: { id: gameId }, data: { status: "LIVE" } });
    }
    res.json({ deleted: Number(req.params.seq), state });
  });
}));
r3.delete("/:id/events", asyncH(async (req, res) => {
  const gameId = req.params.id;
  const fromSeq = Number(req.query.fromSeq);
  if (!Number.isInteger(fromSeq) || fromSeq < 1) {
    return res.status(400).json({ error: "fromSeq requerido (n\xFAmero de jugada)" });
  }
  return enqueue(gameId, async () => {
    const total = await prisma.gameEvent.count({ where: { gameId } });
    if (!total) return res.status(404).json({ error: "No hay eventos" });
    const { count } = await prisma.gameEvent.deleteMany({
      where: { gameId, seq: { gte: fromSeq } }
    });
    if (!count) return res.status(404).json({ error: `No hay jugada #${fromSeq}` });
    const game = await prisma.game.findUnique({ where: { id: gameId } });
    const state = reduceGame(await loadEvents(gameId), game?.innings ?? 9);
    if (game && game.status !== state.status && state.status === "LIVE") {
      await prisma.game.update({ where: { id: gameId }, data: { status: "LIVE" } });
    }
    res.json({ deleted: count, fromSeq, state });
  });
}));
r3.post("/:id/repair-pitchers", asyncH(async (req, res) => {
  const gameId = req.params.id;
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  const [evs, lineup] = await Promise.all([
    prisma.gameEvent.findMany({ where: { gameId }, orderBy: { seq: "asc" } }),
    prisma.lineupEntry.findMany({ where: { gameId } })
  ]);
  const teamOf = new Map(lineup.map((l) => [l.playerId, l.teamId]));
  const battingTeam = (half) => half === "TOP" ? game.awayTeamId : game.homeTeamId;
  const fieldingTeam = (half) => half === "TOP" ? game.homeTeamId : game.awayTeamId;
  const psOf = (tid) => lineup.filter((l) => l.teamId === tid && l.position === "P").map((l) => l.playerId);
  let fixed = 0;
  const updates = [];
  for (const ev of evs) {
    if (!ev.pitcherId) continue;
    const wrongSide = teamOf.get(ev.pitcherId) === battingTeam(ev.half);
    if (!wrongSide) continue;
    const fid = fieldingTeam(ev.half);
    const candidates = psOf(fid);
    const freq = /* @__PURE__ */ new Map();
    for (const e2 of evs) {
      if (e2.half === ev.half && e2.pitcherId && teamOf.get(e2.pitcherId) === fid) {
        freq.set(e2.pitcherId, (freq.get(e2.pitcherId) ?? 0) + 1);
      }
    }
    const target = candidates.sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0))[0] ?? [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!target || target === ev.pitcherId) continue;
    updates.push(prisma.gameEvent.update({ where: { id: ev.id }, data: { pitcherId: target } }));
    fixed++;
  }
  await Promise.all(updates);
  res.json({ ok: true, fixed, total: evs.length });
}));
r3.post("/:id/audit", asyncH(async (req, res) => {
  const u = await reqUser(req);
  const open = !await authEnabled();
  if (!open && u?.role !== "admin") return res.status(403).json({ error: "Requiere rol admin" });
  const gameId = req.params.id;
  return enqueue(gameId, async () => {
    const { ops, decisions, reason } = req.body;
    if (!Array.isArray(ops) || !ops.length) return res.status(400).json({ error: "ops requerido" });
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: { lineups: true, season: true }
    });
    if (!game) return res.status(404).json({ error: "Juego no encontrado" });
    const rows = await prisma.gameEvent.findMany({ where: { gameId }, orderBy: { seq: "asc" } });
    const scoreOf = (evs) => !evs.length && game.fScoreAway != null && game.fScoreHome != null ? { away: game.fScoreAway, home: game.fScoreHome } : reduceGame(evs, game.innings).score;
    const oldEvents = rows.map(toEvent);
    const oldScore = scoreOf(oldEvents);
    const winnerOf = (s) => s.away > s.home ? "away" : s.home > s.away ? "home" : "tie";
    const desired = oldEvents.map((ev, i) => ({ rowId: rows[i].id, ev }));
    const lineupOf = (half) => {
      const tid = half === "TOP" ? game.homeTeamId : game.awayTeamId;
      return game.lineups.filter((l) => l.teamId === tid && l.active);
    };
    const credits = (ev) => {
      const lu = lineupOf(ev.half);
      const err = errorFielders(lu, ev.notation);
      const outs = ev.advances.filter((a) => a.to === "OUT").length;
      const fld = fieldingCredits(lu, ev.notation, ev.result, outs);
      return {
        errorOn: err.length ? JSON.stringify(err) : null,
        putouts: fld.po.length ? JSON.stringify(fld.po) : null,
        assists: fld.a.length ? JSON.stringify(fld.a) : null
      };
    };
    for (const op of ops) {
      if (op.action === "edit") {
        const di = desired.findIndex((x) => x.ev.seq === op.seq);
        if (di < 0) return res.status(404).json({ error: `No hay jugada #${op.seq}` });
        const ev = desired[di].ev;
        const opRes = op.result ?? ev.result;
        let adv = op.advances ?? ev.advances;
        const newBatter = op.batterId === void 0 ? ev.batterId : op.batterId;
        if (op.advances === void 0 && op.result !== void 0 && op.result !== ev.result && newBatter) {
          const prev = reduceGame(desired.slice(0, di).map((x) => x.ev), game.innings);
          adv = defaultAdvances(prev, newBatter, opRes);
        }
        desired[di].ev = {
          ...ev,
          result: opRes,
          notation: op.notation === void 0 ? ev.notation : hitZonePrefix(op.notation ? normNotation(String(op.notation)) : null, opRes),
          batterId: op.batterId === void 0 ? ev.batterId : op.batterId,
          pitcherId: op.pitcherId === void 0 ? ev.pitcherId : op.pitcherId,
          advances: adv,
          inning: op.inning != null ? Number(op.inning) : ev.inning,
          half: op.half === "TOP" || op.half === "BOTTOM" ? op.half : ev.half
        };
      } else if (op.action === "delete") {
        const i = desired.findIndex((x) => x.ev.seq === op.seq);
        if (i < 0) return res.status(404).json({ error: `No hay jugada #${op.seq}` });
        desired.splice(i, 1);
      } else if (op.action === "deleteFrom") {
        const i = desired.findIndex((x) => x.ev.seq === op.seq);
        if (i < 0) return res.status(404).json({ error: `No hay jugada #${op.seq}` });
        desired.splice(i);
      } else if (op.action === "insert") {
        const e = op.event;
        if (!e?.result || !Array.isArray(e.advances) || !e.inning || e.half !== "TOP" && e.half !== "BOTTOM") {
          return res.status(400).json({ error: "insert: event requiere result, inning, half y advances" });
        }
        const at = op.beforeSeq == null ? desired.length : desired.findIndex((x) => x.ev.seq === op.beforeSeq);
        const idx = at < 0 ? desired.length : at;
        desired.splice(idx, 0, {
          rowId: null,
          ev: {
            seq: 0,
            inning: Number(e.inning),
            half: e.half,
            batterId: e.batterId ?? null,
            pitcherId: e.pitcherId ?? null,
            result: e.result,
            notation: e.notation ? normNotation(String(e.notation)) : null,
            advances: e.advances
          }
        });
      } else {
        return res.status(400).json({ error: `acci\xF3n inv\xE1lida: ${op.action}` });
      }
    }
    let trimmed = 0;
    if (game.status === "FINAL") {
      let st = initialState();
      for (let i = 0; i < desired.length; i++) {
        st = applyEvent(st, desired[i].ev, game.innings);
        if (st.status === "FINAL") {
          if (i + 1 < desired.length) {
            trimmed = desired.length - (i + 1);
            desired.splice(i + 1);
          }
          break;
        }
      }
    }
    const newEvents = desired.map((d) => d.ev);
    const newScore = scoreOf(newEvents);
    const oldWin = winnerOf(oldScore);
    const newWin = winnerOf(newScore);
    const outcomeChanged = oldWin !== newWin;
    const effWp = decisions?.wpId || game.wpId || null;
    const effLp = decisions?.lpId || game.lpId || null;
    if (outcomeChanged && game.status === "FINAL" && newWin !== "tie" && (!effWp || !effLp)) {
      return res.status(409).json({
        needDecisions: true,
        winner: newWin,
        scoreBefore: oldScore,
        scoreAfter: newScore,
        error: "El resultado cambi\xF3 \u2014 indica lanzador ganador y perdedor"
      });
    }
    const needResync = game.status === "FINAL" || game.seasonApplied;
    const before = needResync ? await gameContrib(game) : null;
    const keepIds = desired.filter((d) => d.rowId).map((d) => d.rowId);
    await prisma.gameEvent.deleteMany({
      where: { gameId, ...keepIds.length ? { id: { notIn: keepIds } } : {} }
    });
    await prisma.gameEvent.updateMany({ where: { gameId }, data: { seq: { increment: 1e5 } } });
    for (let i = 0; i < desired.length; i++) {
      const d = desired[i];
      const cred = credits(d.ev);
      const data = {
        seq: i + 1,
        inning: d.ev.inning,
        half: d.ev.half,
        batterId: d.ev.batterId ?? null,
        pitcherId: d.ev.pitcherId ?? null,
        result: d.ev.result,
        notation: d.ev.notation ?? null,
        advances: d.ev.advances ?? [],
        sprayDir: d.ev.sprayDir ?? null,
        sprayDist: d.ev.sprayDist ?? null,
        ...cred
      };
      if (d.rowId) {
        await prisma.gameEvent.update({ where: { id: d.rowId }, data });
      } else {
        await prisma.gameEvent.create({
          data: { ...data, gameId, clientKey: `audit-${Date.now().toString(36)}-${i}` }
        });
      }
    }
    let merged = game;
    const isTieNow = newWin === "tie";
    if (decisions || outcomeChanged || !!game.tied !== isTieNow) {
      const t = isTieNow ? true : decisions?.tied ?? false;
      const upd = await prisma.game.update({
        where: { id: gameId },
        data: {
          tied: t,
          wpId: t ? null : decisions?.wpId || game.wpId || null,
          lpId: t ? null : decisions?.lpId || game.lpId || null,
          svId: t ? null : decisions?.svId !== void 0 ? decisions.svId : game.svId ?? null,
          hldIds: t ? null : decisions?.hldIds !== void 0 ? JSON.stringify(decisions.hldIds) : game.hldIds,
          bsIds: t ? null : decisions?.bsIds !== void 0 ? JSON.stringify(decisions.bsIds) : game.bsIds
        }
      });
      merged = { ...game, ...upd };
    }
    if (!game.forfeitBy && game.fScoreAway != null && game.fScoreHome != null) {
      await prisma.game.update({
        where: { id: gameId },
        data: { fScoreAway: newScore.away, fScoreHome: newScore.home }
      });
    }
    if (before) {
      const after = await gameContrib({ ...merged, lineups: game.lineups, season: game.season });
      await applySeasonDelta(game, before, after);
    }
    const entry = {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      user: u?.username ?? "admin",
      reason: reason ?? null,
      ops: ops.map((o) => ({ a: o.action, seq: o.seq ?? o.beforeSeq, r: o.result ?? o.event?.result })),
      scoreBefore: oldScore,
      scoreAfter: newScore,
      decisions: decisions ?? null,
      ...trimmed ? { trimmed } : {}
    };
    const log = [...game.auditLog ?? [], entry];
    await prisma.game.update({ where: { id: gameId }, data: { auditLog: log } });
    const fresh = await loadEvents(gameId);
    res.json({
      ok: true,
      state: reduceGame(fresh, game.innings),
      score: newScore,
      outcomeChanged,
      trimmed,
      audit: entry
    });
  });
}));
var events_default = r3;

// src/routes/stats.ts
import { Router as Router5 } from "express";
import { Prisma as Prisma3 } from "@prisma/client";

// src/routes/leagues.ts
import { Router as Router4 } from "express";
import { Prisma as Prisma2 } from "@prisma/client";

// src/website.ts
var esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var BLKCELL = '<span class="blk">\u2588\u2588</span>';
var f3 = (n) => n == null || !isFinite(n) ? BLKCELL : n ? n.toFixed(3).replace(/^0/, "") : ".000";
var f2 = (n) => n == null || !isFinite(n) ? BLKCELL : n.toFixed(2);
var ipOf = (outs) => outs == null ? BLKCELL : `${Math.floor(outs / 3)}${outs % 3 ? `.${outs % 3}` : ""}`;
var fecha = (d) => new Date(d).toLocaleDateString("es");
async function websiteHtml(leagueId) {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    include: { teams: true, seasons: { orderBy: { year: "desc" } } }
  });
  if (!league) return null;
  const blockedT = new Set(league.teams.filter((t) => t.blocked).map((t) => t.id));
  const blockedNames = new Set(
    league.teams.filter((t) => t.blocked).flatMap((t) => [t.name, t.shortName].filter(Boolean))
  );
  const blockedP = new Set((await prisma.player.findMany({
    where: { teamId: { in: league.teams.map((t) => t.id) }, blocked: true },
    select: { id: true }
  })).map((p) => p.id));
  const PBLK = "\u{1F512} BLOQUEADO", TBLK = "\u{1F6AB} EQUIPO BLOQUEADO";
  for (const t of league.teams) if (t.blocked) {
    t.name = TBLK;
    t.shortName = "\u{1F6AB}";
  }
  const nullNums = (o) => {
    for (const k of Object.keys(o)) if (typeof o[k] === "number") o[k] = null;
  };
  const redactStats = (st) => {
    if (!blockedP.size && !blockedT.size) return st;
    for (const arr of [st.batting, st.pitching, st.fielding]) {
      for (const row of arr) {
        if (blockedP.has(row.playerId)) {
          row.name = PBLK;
          nullNums(row);
        }
        if (blockedT.has(row.teamId)) {
          row.teamName = TBLK;
          row.shortName = "\u{1F6AB}";
        }
      }
    }
    for (const [pid, m] of st.meta) {
      if (blockedP.has(pid)) {
        m.name = PBLK;
        m.photo = null;
      }
      if (blockedT.has(m.teamId)) {
        m.teamName = TBLK;
        m.shortName = "\u{1F6AB}";
      }
    }
    for (const tt of st.teamTotals) if (blockedT.has(tt.teamId)) {
      tt.name = TBLK;
      nullNums(tt);
    }
    for (const r10 of st.results) {
      if (blockedT.has(r10.awayId)) r10.away = TBLK;
      if (blockedT.has(r10.homeId)) r10.home = TBLK;
    }
    for (const box of st.boxes.values()) {
      for (const side of [box?.away, box?.home]) {
        if (!side) continue;
        for (const [pid, line] of Object.entries(side)) {
          if (blockedP.has(pid)) {
            const rec = line;
            rec.name = PBLK;
            nullNums(rec);
          }
        }
      }
    }
    for (const arr of st.playerLog.values()) {
      for (const e of arr) if (e.opp && blockedNames.has(e.opp)) e.opp = "\u{1F6AB}";
    }
    for (const l of st.teamGameLines) {
      if (l.opp && blockedNames.has(l.opp)) l.opp = "\u{1F6AB}";
    }
    return st;
  };
  const redactStr = (s) => {
    let r10 = s;
    for (const n of blockedNames) r10 = r10.split(n).join("\u{1F6AB} BLOQUEADO");
    return r10;
  };
  const redactStand = (rows) => rows.map((t) => blockedT.has(t.teamId) ? { ...t, name: TBLK, w: null, l: null, t: null, rf: null, ra: null, pct: null, diff: null, gb: null } : t);
  const finals = await prisma.game.findMany({ where: { leagueId, status: "FINAL" }, select: { date: true } });
  const dateYears = [...new Set(finals.map((g) => new Date(g.date).getFullYear()))].sort((a, b) => b - a);
  const seasonList = league.seasons.length ? league.seasons.map((s) => ({ id: s.id, year: s.year })) : (dateYears.length ? dateYears : [league.year]).map((y) => ({ id: null, year: y }));
  const multiYear = seasonList.length > 1;
  const photoPool = /* @__PURE__ */ new Map();
  const allSeries = await prisma.series.findMany({
    where: { leagueId },
    select: { id: true, round: true, name: true, homeTeamId: true, awayTeamId: true, winnerTeamId: true, winsNeeded: true, seasonId: true, games: { select: { id: true, date: true } } },
    orderBy: [{ round: "asc" }, { createdAt: "asc" }]
  });
  const mergeStats = (list) => {
    const regInn = list.find((s) => s.results[0]?.innings)?.results[0]?.innings ?? 9;
    const meta = /* @__PURE__ */ new Map();
    const bat = /* @__PURE__ */ new Map();
    const pit = /* @__PURE__ */ new Map();
    const fld = /* @__PURE__ */ new Map();
    const tt = /* @__PURE__ */ new Map();
    const results = [];
    const boxes = /* @__PURE__ */ new Map();
    const playerLog = /* @__PURE__ */ new Map();
    const teamGameLines = [];
    const matchups = /* @__PURE__ */ new Map();
    let games = 0;
    const addNum = (m, pid, src, keys) => {
      const d = m.get(pid) ?? { playerId: pid };
      for (const k of keys) d[k] = (d[k] ?? 0) + (typeof src[k] === "number" ? src[k] : 0);
      m.set(pid, d);
    };
    const addSitu = (d, s) => {
      if (!s) return;
      d.situ = d.situ ?? { risp: { ab: 0, h: 0 }, loaded: { ab: 0, h: 0 }, twoOut: { ab: 0, h: 0 }, leadoff: { ab: 0, h: 0 } };
      for (const k of ["risp", "loaded", "twoOut", "leadoff"]) {
        d.situ[k].ab += s[k].ab;
        d.situ[k].h += s[k].h;
      }
    };
    for (const st of [...list].reverse()) {
      games += st.games;
      for (const [k, v] of st.meta) meta.set(k, v);
      for (const [k, v] of st.boxes) boxes.set(k, v);
      results.push(...st.results);
      teamGameLines.push(...st.teamGameLines);
      for (const [pid, arr] of st.playerLog) playerLog.set(pid, [...playerLog.get(pid) ?? [], ...arr]);
      for (const [bid, mm] of st.matchups) {
        const dm = matchups.get(bid) ?? /* @__PURE__ */ new Map();
        for (const [oid, x] of mm) {
          const d = dm.get(oid) ?? { pa: 0, ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, k: 0 };
          for (const k of ["pa", "ab", "h", "hr", "rbi", "bb", "k"]) d[k] += x[k];
          dm.set(oid, d);
        }
        matchups.set(bid, dm);
      }
      for (const t of st.teamTotals) {
        const d = tt.get(t.teamId) ?? { teamId: t.teamId, name: t.name };
        for (const k of ["g", "ab", "r", "h", "doubles", "triples", "hr", "rbi", "bb", "k", "sb", "lob", "e", "pOuts", "pH", "pR", "pER", "pBB", "pK"]) d[k] = (d[k] ?? 0) + t[k];
        tt.set(t.teamId, d);
      }
      for (const b of st.batting) {
        addNum(bat, b.playerId, b, ["g", "pa", "ab", "r", "h", "doubles", "triples", "hr", "rbi", "bb", "k", "hbp", "sac", "sf", "sb"]);
        addSitu(bat.get(b.playerId), b.situ);
      }
      for (const p of st.pitching) addNum(pit, p.playerId, p, ["gp", "gs", "outs", "h", "r", "er", "bb", "k", "hr", "pitches", "bf", "abAg", "w", "l", "sv", "hld", "bs", "cg", "sho"]);
      for (const f of st.fielding) addNum(fld, f.playerId, f, ["po", "a", "e"]);
    }
    results.sort((x, y) => +new Date(x.date) - +new Date(y.date));
    for (const arr of playerLog.values()) arr.sort((x, y) => +new Date(x.date) - +new Date(y.date));
    const f3n = (n) => Number(n.toFixed(3));
    const f2n = (n) => Number(n.toFixed(2));
    const metaOf = (pid) => meta.get(pid) ?? { name: "?", teamId: "", teamName: "?", shortName: "?", number: null, bats: null, throws: null, positions: null, photo: null };
    const situZero = { risp: { ab: 0, h: 0 }, loaded: { ab: 0, h: 0 }, twoOut: { ab: 0, h: 0 }, leadoff: { ab: 0, h: 0 } };
    const W = { bb: 0.69, hbp: 0.72, s1: 0.88, d2: 1.25, t3: 1.58, hr: 2.08 };
    const wobaNum = (x) => W.bb * x.bb + W.hbp * x.hbp + W.s1 * (x.h - x.doubles - x.triples - x.hr) + W.d2 * x.doubles + W.t3 * x.triples + W.hr * x.hr;
    const wobaDen = (x) => x.ab + x.bb + x.hbp + x.sf;
    const lgBat = [...bat.values()].reduce((s, b) => ({ pa: s.pa + b.pa, ab: s.ab + b.ab, h: s.h + b.h, bb: s.bb + b.bb, hbp: s.hbp + b.hbp, sf: s.sf + b.sf, doubles: s.doubles + b.doubles, triples: s.triples + b.triples, hr: s.hr + b.hr }), { pa: 0, ab: 0, h: 0, bb: 0, hbp: 0, sf: 0, doubles: 0, triples: 0, hr: 0 });
    const lgWoba = wobaDen(lgBat) ? wobaNum(lgBat) / wobaDen(lgBat) : 0;
    const lgObp = wobaDen(lgBat) ? (lgBat.h + lgBat.bb + lgBat.hbp) / wobaDen(lgBat) : 0;
    const wobaScale = lgWoba > 0 && lgObp > 0 ? lgObp / lgWoba : 1.15;
    const totalRuns = [...tt.values()].reduce((s, t) => s + t.r, 0);
    const rpw = Math.max(4, totalRuns / Math.max(1, games));
    const lgPit = [...pit.values()].reduce((s, p) => ({ outs: s.outs + p.outs, er: s.er + p.er, hr: s.hr + p.hr, bb: s.bb + p.bb, k: s.k + p.k }), { outs: 0, er: 0, hr: 0, bb: 0, k: 0 });
    const lgIp = lgPit.outs / 3;
    const lgEra = lgIp ? lgPit.er * regInn / lgIp : 0;
    const lgFip = lgIp ? (13 * lgPit.hr + 3 * lgPit.bb - 2 * lgPit.k) / lgIp : 0;
    const cFip = lgEra - lgFip;
    const batting = [...bat.values()].map((b) => {
      const tb = b.h + b.doubles + 2 * b.triples + 3 * b.hr;
      const od = b.ab + b.bb + b.hbp + b.sf;
      const slg = b.ab ? tb / b.ab : 0, obp = od ? (b.h + b.bb + b.hbp) / od : 0;
      const woba = wobaDen(b) ? wobaNum(b) / wobaDen(b) : 0;
      const wraa = (woba - lgWoba) / wobaScale * b.pa;
      const rep = b.pa * (20 / 600);
      return {
        ...b,
        ...metaOf(b.playerId),
        situ: b.situ ?? situZero,
        avg: f3n(b.ab ? b.h / b.ab : 0),
        obp: f3n(obp),
        slg: f3n(slg),
        ops: f3n(obp + slg),
        iso: f3n(slg - (b.ab ? b.h / b.ab : 0)),
        babip: f3n(b.ab - b.k - b.hr + b.sf > 0 ? (b.h - b.hr) / (b.ab - b.k - b.hr + b.sf) : 0),
        woba: f3n(woba),
        wraa: f2n(wraa),
        war: f2n((wraa + rep) / rpw)
      };
    }).sort((x, y) => y.ops - x.ops);
    const pitching = [...pit.values()].map((p) => {
      const ip = p.outs / 3;
      const fip = ip ? (13 * p.hr + 3 * p.bb - 2 * p.k) / ip + cFip : 0;
      const war = ip ? ((lgEra - fip) / rpw + 0.08) * (ip / regInn) : 0;
      return {
        ...p,
        ...metaOf(p.playerId),
        ip: f2n(ip),
        era: f2n(ip ? p.er * regInn / ip : 0),
        whip: f2n(ip ? (p.bb + p.h) / ip : 0),
        k9: f2n(ip ? p.k * regInn / ip : 0),
        bb9: f2n(ip ? p.bb * regInn / ip : 0),
        kbb: f2n(p.bb ? p.k / p.bb : p.k),
        pIp: f2n(ip ? p.pitches / ip : 0),
        avgAgainst: f3n(p.abAg ? p.h / p.abAg : 0),
        fip: f2n(fip),
        war: f2n(war)
      };
    }).sort((x, y) => x.era - y.era);
    const fielding = [...fld.values()].map((f) => ({ ...f, ...metaOf(f.playerId), tc: f.po + f.a + f.e, fpct: f3n(f.po + f.a + f.e > 0 ? (f.po + f.a) / (f.po + f.a + f.e) : 1) })).sort((x, y) => y.tc - x.tc);
    return { batting, pitching, fielding, teamTotals: [...tt.values()], games, results, boxes, playerLog, meta, teamGameLines, matchups };
  };
  const careerStandings = (st) => {
    const tbl = /* @__PURE__ */ new Map();
    for (const t of league.teams) tbl.set(t.id, { teamId: t.id, name: t.name, w: 0, l: 0, t: 0, rf: 0, ra: 0 });
    for (const r10 of st.results) {
      const a = tbl.get(r10.awayId), h = tbl.get(r10.homeId);
      if (a) {
        a.rf += r10.aR;
        a.ra += r10.hR;
      }
      if (h) {
        h.rf += r10.hR;
        h.ra += r10.aR;
      }
      if (r10.tied) {
        if (a) a.t++;
        if (h) h.t++;
      } else if (r10.aR > r10.hR) {
        if (a) a.w++;
        if (h) h.l++;
      } else {
        if (h) h.w++;
        if (a) a.l++;
      }
    }
    const rows = [...tbl.values()].map((t) => ({ ...t, pct: t.w + t.l ? t.w / (t.w + t.l) : 0, diff: t.rf - t.ra, gb: 0, streak: null, last10: { w: 0, l: 0, t: 0 }, form: [], vs: {} })).sort((x, y) => y.pct - x.pct || y.w - x.w || y.diff - x.diff);
    const lead = rows[0];
    for (const t of rows) t.gb = lead ? (lead.w - t.w + (t.l - lead.l)) / 2 : 0;
    return rows;
  };
  const yearOfSeries = (sr) => {
    if (sr.seasonId) {
      const s = league.seasons.find((x) => x.id === sr.seasonId);
      if (s) return s.year;
    }
    const d = sr.games[0]?.date;
    return d ? new Date(d).getFullYear() : 0;
  };
  const yearData = [];
  const buildYear = (stats, standings, pfx, series, post, career = false) => {
    const reg = stats.results[0]?.innings ?? 9;
    const teamLink = (tid, name) => `<a href="#/equipo/${tid}">${esc(name)}</a>`;
    const playerLink = (pid, name) => `<a href="#/jugador/${pid}">${esc(name)}</a>`;
    const gameLink = (gid, label) => `<a href="#/juego/${gid}">${esc(label)}</a>`;
    const batName = (b) => `${playerLink(b.playerId, b.name)} <span class="m">(${esc(b.shortName)})</span>`;
    const extras = /* @__PURE__ */ new Map();
    const xOf = (tid) => {
      if (!extras.has(tid)) extras.set(tid, { hw: 0, hl: 0, aw: 0, al: 0, oW: 0, oL: 0, seq: [] });
      return extras.get(tid);
    };
    for (const r10 of stats.results) {
      const xa = xOf(r10.awayId), xh = xOf(r10.homeId);
      const diff = r10.aR - r10.hR;
      const aRes = r10.tied ? "T" : diff > 0 ? "W" : "L";
      const hRes = r10.tied ? "T" : diff > 0 ? "L" : "W";
      xa.seq.push(aRes);
      xh.seq.push(hRes);
      if (aRes === "W") xa.aw++;
      else if (aRes === "L") xa.al++;
      if (hRes === "W") xh.hw++;
      else if (hRes === "L") xh.hl++;
      if (!r10.tied && Math.abs(diff) === 1) {
        if (aRes === "W") xa.oW++;
        else xa.oL++;
        if (hRes === "W") xh.oW++;
        else xh.oL++;
      }
    }
    const strkOf = (seq) => {
      if (!seq.length) return "\u2014";
      const last = seq[seq.length - 1];
      let n = 0;
      for (let i = seq.length - 1; i >= 0 && seq[i] === last; i--) n++;
      return `${last === "W" ? "G" : last === "L" ? "P" : "E"}${n}`;
    };
    const l10Of = (seq) => {
      const last = seq.slice(-10);
      return `${last.filter((x) => x === "W").length}-${last.filter((x) => x === "L").length}`;
    };
    const ttOf = (tid) => stats.teamTotals.find((t) => t.teamId === tid);
    const teamBa = (tid) => {
      if (blockedT.has(tid)) return BLKCELL;
      const t = ttOf(tid);
      return t && t.ab ? f3(t.h / t.ab) : ".000";
    };
    const teamEra = (tid) => {
      if (blockedT.has(tid)) return BLKCELL;
      const t = ttOf(tid);
      return t && t.pOuts ? f2(t.pER * reg * 3 / t.pOuts) : "0.00";
    };
    const standRows = standings.map((t) => {
      const blkd = blockedT.has(t.teamId);
      const x = blkd ? null : extras.get(t.teamId);
      const xe = (v) => x ? v : blkd ? BLKCELL : "\u2014";
      return `<tr><td class="l">${teamLink(t.teamId, t.name)}</td><td>${t.w ?? BLKCELL}</td><td>${t.l ?? BLKCELL}</td><td>${t.t ?? BLKCELL}</td>
      <td><b>${f3(t.pct)}</b></td><td>${t.gb == null ? BLKCELL : t.gb || "\u2014"}</td><td>${xe(l10Of(x?.seq ?? []))}</td><td>${xe(strkOf(x?.seq ?? []))}</td>
      <td>${xe(`${x?.hw ?? 0}-${x?.hl ?? 0}`)}</td><td>${xe(`${x?.aw ?? 0}-${x?.al ?? 0}`)}</td><td>${xe(`${x?.oW ?? 0}-${x?.oL ?? 0}`)}</td>
      <td>${teamBa(t.teamId)}</td><td>${teamEra(t.teamId)}</td></tr>`;
    }).join("");
    const resultRows = [...stats.results].reverse().map((r10) => {
      const tag = r10.forfeit ? " (forfeit)" : r10.tied ? " (empate)" : "";
      return `<tr><td>${fecha(r10.date)}</td><td class="l">${teamLink(r10.awayId, r10.away)} <b>${r10.aR}</b></td>
      <td>@</td><td class="l">${teamLink(r10.homeId, r10.home)} <b>${r10.hR}</b></td>
      <td class="m">${esc(r10.stadium ?? "")}${tag}</td><td>${gameLink(r10.id, "boxscore")}</td></tr>`;
    }).join("");
    const teamBatRows = stats.teamTotals.map((t) => `<tr><td class="l">${teamLink(t.teamId, t.name)}</td>
    <td>${t.g}</td><td>${t.ab}</td><td>${t.h}</td><td>${t.r}</td><td>${t.rbi}</td><td>${t.doubles}</td><td>${t.triples}</td>
    <td>${t.hr}</td><td>${t.bb}</td><td>${t.k}</td><td>${t.sb}</td><td>${t.lob}</td>
    <td><b>${f3(t.ab ? t.h / t.ab : 0)}</b></td></tr>`).join("");
    const teamPitRows = stats.teamTotals.map((t) => `<tr><td class="l">${teamLink(t.teamId, t.name)}</td>
    <td>${ipOf(t.pOuts)}</td><td>${t.pH}</td><td>${t.pR}</td><td>${t.pER}</td><td>${t.pBB}</td><td>${t.pK}</td>
    <td><b>${t.pOuts ? f2(t.pER * reg * 3 / t.pOuts) : "0.00"}</b></td>
    <td>${t.pOuts ? f2((t.pBB + t.pH) * 3 / t.pOuts) : "0.00"}</td></tr>`).join("");
    const teamFldRows = stats.teamTotals.map((t) => `<tr><td class="l">${teamLink(t.teamId, t.name)}</td><td>${t.e}</td></tr>`).join("");
    const leaderCard = (title2, arr, by, fmt, link, opts = {}) => {
      const top = arr.filter(opts.min ?? ((x) => by(x) > 0)).sort((a, b) => opts.asc ? by(a) - by(b) : by(b) - by(a)).slice(0, 3);
      if (!top.length) return "";
      const ph = (x) => {
        const pid = x.playerId;
        const m = x;
        if (pid && m.photo) return `<span class="lph pph" data-ph="${pid}"></span>`;
        const ini = (m.name ?? "?").replace(/^#\d+\s*/, "").trim().charAt(0).toUpperCase() || "?";
        return `<span class="lph linit">${esc(ini)}</span>`;
      };
      return `<div class="leader"><h4>${title2}</h4><ol>${top.map((x) => `<li>${ph(x)}${link(x)} \u2014 <b>${fmt(x)}</b></li>`).join("")}</ol></div>`;
    };
    const qPa = league.qualPa ?? 3.1, qIp = league.qualIp ?? 1;
    const paNeed = (b) => Math.round((ttOf(b.teamId)?.g ?? 0) * qPa);
    const outsNeed = (p) => Math.round((ttOf(p.teamId)?.g ?? 0) * qIp * 3);
    const qualRate = (num2, den) => {
      const need = (b) => paNeed(b);
      const qual = stats.batting.filter((b) => qPa <= 0 || b.pa >= need(b));
      const best = qual.length ? Math.max(...qual.map((b) => den(b) ? num2(b) / den(b) : 0)) : -1;
      const extra = qPa <= 0 ? [] : stats.batting.filter((b) => !qual.includes(b) && best > 0 && num2(b) > 0 && num2(b) / (den(b) + (need(b) - b.pa)) >= best);
      return [...qual, ...extra];
    };
    const batQualAvg = qualRate((b) => b.h, (b) => b.ab);
    const batQualObp = qualRate((b) => b.h + b.bb + b.hbp, (b) => b.ab + b.bb + b.hbp + b.sf);
    const batQualSlg = qualRate((b) => b.h + b.doubles + 2 * b.triples + 3 * b.hr, (b) => b.ab);
    const batQualPa = stats.batting.filter((b) => qPa <= 0 || b.pa >= paNeed(b));
    const pitQual = stats.pitching.filter((p) => qIp <= 0 || p.outs >= outsNeed(p));
    const histTeamOf = (st, pid) => {
      const cnt = /* @__PURE__ */ new Map();
      const resByIdL = new Map(st.results.map((r10) => [r10.id, r10]));
      for (const e of st.playerLog.get(pid) ?? []) {
        const box = st.boxes.get(e.gameId);
        const res = resByIdL.get(e.gameId);
        if (!box || !res) continue;
        const tid = box.away[pid] ? res.awayId : box.home[pid] ? res.homeId : null;
        if (tid) cnt.set(tid, (cnt.get(tid) ?? 0) + 1);
      }
      return [...cnt.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    };
    const teamShort = (tid) => tid ? esc(league.teams.find((t) => t.id === tid)?.shortName ?? "") : "";
    const mainPage = `<div class="page" id="${pfx}/">
  <h2>${career ? "Posiciones hist\xF3ricas \u2014 todas las temporadas" : "Posiciones"}</h2>
  <div class="tw"><table><thead><tr><th class="l">Equipo</th><th>G</th><th>P</th><th>E</th><th>PCT</th><th>JB</th><th>L10</th><th>Racha</th><th>Casa</th><th>Fuera</th><th>1-Run</th><th>BA</th><th>ERA</th></tr></thead>
  <tbody>${standRows || '<tr><td colspan="13" class="m">Sin juegos finalizados</td></tr>'}</tbody></table></div>
  <h2>Resultados</h2>
  <div class="tw"><table><thead><tr><th>Fecha</th><th class="l">Visitante</th><th></th><th class="l">Local</th><th>Estadio</th><th></th></tr></thead>
  <tbody>${resultRows || '<tr><td colspan="6" class="m">Sin juegos</td></tr>'}</tbody></table></div>
  <h2>L\xEDderes del torneo</h2>
  ${leaderCard("AVG", batQualAvg, (b) => b.avg, (b) => f3(b.avg), batName)}
  ${leaderCard("Jonrones", stats.batting, (b) => b.hr, (b) => String(b.hr), batName)}
  ${leaderCard("Carreras impulsadas", stats.batting, (b) => b.rbi, (b) => String(b.rbi), batName)}
  ${leaderCard("Hits", stats.batting, (b) => b.h, (b) => String(b.h), batName)}
  ${leaderCard("Bases robadas", stats.batting, (b) => b.sb, (b) => String(b.sb), batName)}
  ${leaderCard("Carreras anotadas", stats.batting, (b) => b.r, (b) => String(b.r), batName)}
  ${leaderCard("Dobles", stats.batting, (b) => b.doubles, (b) => String(b.doubles), batName)}
  ${leaderCard("OPS", batQualPa, (b) => b.ops, (b) => f3(b.ops), batName)}
  ${leaderCard("WAR*", stats.batting, (b) => b.war, (b) => f2(b.war), batName)}
  ${leaderCard("BABIP", stats.batting, (b) => b.babip, (b) => f3(b.babip), batName)}
  ${leaderCard("ERA", pitQual, (p) => p.era, (p) => f2(p.era), (p) => batName(p), { asc: true, min: (p) => p.outs > 0 })}
  ${leaderCard("WHIP", pitQual, (p) => p.whip, (p) => f2(p.whip), (p) => batName(p), { asc: true, min: (p) => p.outs > 0 })}
  ${leaderCard("Ganados", stats.pitching, (p) => p.w, (p) => String(p.w), (p) => batName(p))}
  ${leaderCard("Ponches", stats.pitching, (p) => p.k, (p) => String(p.k), (p) => batName(p))}
  ${leaderCard("Salvados", stats.pitching, (p) => p.sv, (p) => String(p.sv), (p) => batName(p))}
  <p><a href="#/lideres">\u2192 Reporte completo de l\xEDderes</a></p>
  <h2>Bateo por equipo</h2>
  <div class="tw"><table><thead><tr><th class="l">Equipo</th><th>G</th><th>AB</th><th>H</th><th>C</th><th>CI</th><th>2B</th><th>3B</th><th>HR</th><th>BB</th><th>K</th><th>BR</th><th>LOB</th><th>BA</th></tr></thead>
  <tbody>${teamBatRows}</tbody></table></div>
  <h2>Pitcheo por equipo</h2>
  <div class="tw"><table><thead><tr><th class="l">Equipo</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>ERA</th><th>WHIP</th></tr></thead>
  <tbody>${teamPitRows}</tbody></table></div>
  <h2>Fildeo por equipo</h2>
  <div class="tw"><table><thead><tr><th class="l">Equipo</th><th>Errores</th></tr></thead><tbody>${teamFldRows}</tbody></table></div>
</div>`;
    const teamPages = league.teams.map((t) => {
      if (blockedT.has(t.id)) {
        return `<div class="page" id="${pfx}/equipo/${t.id}">
  <h2>\u{1F6AB} EQUIPO BLOQUEADO</h2>
  <p class="m">Este equipo fue excluido de la publicaci\xF3n. Sus datos siguen en el sistema.</p>
</div>`;
      }
      const st = standings.find((s) => s.teamId === t.id);
      const bat = stats.batting.filter((b) => b.teamId === t.id);
      const pit = stats.pitching.filter((p) => p.teamId === t.id);
      const fld = stats.fielding.filter((f) => f.teamId === t.id);
      const res = [...stats.results].reverse().filter((r10) => r10.awayId === t.id || r10.homeId === t.id);
      return `<div class="page" id="${pfx}/equipo/${t.id}">
  <h2>${esc(t.name)} ${st ? `<span class="m">\u2014 ${st.w}-${st.l}${st.t ? `-${st.t}` : ""} \xB7 PCT ${f3(st.pct)}</span>` : ""}</h2>
  <h3>Bateo</h3>
  <div class="tw"><table><thead><tr><th class="l">Jugador</th><th>G</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
  <tbody>${bat.map((b) => `<tr><td class="l">${playerLink(b.playerId, b.name)}</td><td>${b.g}</td><td>${b.pa}</td><td>${b.ab}</td><td>${b.r}</td><td>${b.h}</td><td>${b.doubles}</td><td>${b.triples}</td><td>${b.hr}</td><td>${b.rbi}</td><td>${b.bb}</td><td>${b.k}</td><td>${b.sb}</td><td><b>${f3(b.avg)}</b></td><td>${f3(b.obp)}</td><td>${f3(b.slg)}</td><td>${f3(b.ops)}</td></tr>`).join("") || '<tr><td colspan="17" class="m">Sin datos</td></tr>'}</tbody></table></div>
  <h3>Pitcheo</h3>
  <div class="tw"><table><thead><tr><th class="l">Lanzador</th><th>G</th><th>W-L</th><th>SV</th><th>HLD</th><th>BS</th><th>CG</th><th>SHO</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>ERA</th><th>WHIP</th></tr></thead>
  <tbody>${pit.map((p) => `<tr><td class="l">${playerLink(p.playerId, p.name)}</td><td>${p.gp}</td><td>${p.w}-${p.l}</td><td>${p.sv}</td><td>${p.hld}</td><td>${p.bs}</td><td>${p.cg}</td><td>${p.sho}</td><td>${ipOf(p.outs)}</td><td>${p.h}</td><td>${p.r}</td><td>${p.er}</td><td>${p.bb}</td><td>${p.k}</td><td>${p.hr}</td><td><b>${f2(p.era)}</b></td><td>${f2(p.whip)}</td></tr>`).join("") || '<tr><td colspan="17" class="m">Sin datos</td></tr>'}</tbody></table></div>
  <h3>Fildeo</h3>
  <div class="tw"><table><thead><tr><th class="l">Jugador</th><th>PO</th><th>A</th><th>E</th><th>TC</th><th>FPCT</th></tr></thead>
  <tbody>${fld.map((f) => `<tr><td class="l">${playerLink(f.playerId, f.name)}</td><td>${f.po}</td><td>${f.a}</td><td>${f.e}</td><td>${f.tc}</td><td><b>${f3(f.fpct)}</b></td></tr>`).join("") || '<tr><td colspan="6" class="m">Sin datos</td></tr>'}</tbody></table></div>
  <h3>Resultados</h3>
  <div class="tw"><table><thead><tr><th>Fecha</th><th class="l">Rival</th><th>Marcador</th><th></th></tr></thead>
  <tbody>${res.map((r10) => {
        const mine = r10.awayId === t.id ? "away" : "home";
        const me = mine === "away" ? r10.aR : r10.hR;
        const opp = mine === "away" ? r10.hR : r10.aR;
        const wl = r10.tied ? "E" : me > opp ? "G" : "P";
        return `<tr><td>${fecha(r10.date)}</td><td class="l">${mine === "away" ? "@ " + teamLink(r10.homeId, r10.home) : teamLink(r10.awayId, r10.away)}</td>
        <td><b>${wl} ${me}-${opp}</b></td><td>${gameLink(r10.id, "boxscore")}</td></tr>`;
      }).join("") || '<tr><td colspan="4" class="m">Sin juegos</td></tr>'}</tbody></table></div>
</div>`;
    }).join("\n");
    const playerIds = /* @__PURE__ */ new Set([
      ...stats.playerLog.keys(),
      ...stats.batting.map((b) => b.playerId),
      ...stats.pitching.map((p) => p.playerId),
      ...post.playerLog.keys(),
      ...post.batting.map((b) => b.playerId),
      ...post.pitching.map((p) => p.playerId)
    ]);
    const batSeasonTable = (b) => `
  <div class="tw"><table><thead><tr><th>G</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>GP</th><th>SAC</th><th>SF</th><th>BR</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th><th>wOBA</th><th>WAR*</th></tr></thead>
  <tbody><tr><td>${b.g}</td><td>${b.pa}</td><td>${b.ab}</td><td>${b.r}</td><td>${b.h}</td><td>${b.doubles}</td><td>${b.triples}</td><td>${b.hr}</td><td>${b.rbi}</td><td>${b.bb}</td><td>${b.k}</td><td>${b.hbp}</td><td>${b.sac}</td><td>${b.sf}</td><td>${b.sb}</td><td><b>${f3(b.avg)}</b></td><td>${f3(b.obp)}</td><td>${f3(b.slg)}</td><td><b>${f3(b.ops)}</b></td><td>${f3(b.woba)}</td><td><b>${f2(b.war)}</b></td></tr></tbody></table></div>`;
    const pitSeasonTable = (p) => `
  <div class="tw"><table><thead><tr><th>G</th><th>W-L</th><th>SV</th><th>HLD</th><th>BS</th><th>CG</th><th>SHO</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th><th>ERA</th><th>WHIP</th><th>FIP</th><th>WAR*</th></tr></thead>
  <tbody><tr><td>${p.gp}</td><td>${p.w}-${p.l}</td><td>${p.sv}</td><td>${p.hld}</td><td>${p.bs}</td><td>${p.cg}</td><td>${p.sho}</td><td>${ipOf(p.outs)}</td><td>${p.h}</td><td>${p.r}</td><td>${p.er}</td><td>${p.bb}</td><td>${p.k}</td><td>${p.hr}</td><td>${p.pitches}</td><td><b>${f2(p.era)}</b></td><td>${f2(p.whip)}</td><td>${f2(p.fip)}</td><td><b>${f2(p.war)}</b></td></tr></tbody></table></div>`;
    const playerPages = [...playerIds].map((pid) => {
      if (blockedP.has(pid)) {
        return `<div class="page" id="${pfx}/jugador/${pid}">
  <div class="player-head"><div class="pphoto pph"></div><div><h2>\u{1F512} BLOQUEADO</h2>
  <p class="m">Este jugador fue excluido de la publicaci\xF3n. Sus datos siguen en el sistema.</p></div></div>
</div>`;
      }
      const m = stats.meta.get(pid) ?? post.meta.get(pid);
      if (!m) return "";
      const b = stats.batting.find((x) => x.playerId === pid);
      const p = stats.pitching.find((x) => x.playerId === pid);
      const f = stats.fielding.find((x) => x.playerId === pid);
      const pb = post.batting.find((x) => x.playerId === pid);
      const pp = post.pitching.find((x) => x.playerId === pid);
      const pf = post.fielding.find((x) => x.playerId === pid);
      const log = (stats.playerLog.get(pid) ?? []).slice().sort((x, y) => +new Date(x.date) - +new Date(y.date));
      const postLog = (post.playerLog.get(pid) ?? []).slice().sort((x, y) => +new Date(x.date) - +new Date(y.date));
      const batLogRows = (entries) => {
        let cumAb = 0, cumH = 0;
        return entries.filter((e) => e.bat && e.bat.pa > 0).map((e) => {
          const l = e.bat;
          cumAb += l.ab;
          cumH += l.h;
          return `<tr><td>${fecha(e.date)}</td><td class="l">${gameLink(e.gameId, "vs " + e.opp)}</td>
          <td>${l.ab}</td><td>${l.r}</td><td>${l.h}</td><td>${l.doubles}</td><td>${l.triples}</td><td>${l.hr}</td>
          <td>${l.rbi}</td><td>${l.bb}</td><td>${l.k}</td><td>${l.sb}</td><td class="m">${f3(cumAb ? cumH / cumAb : 0)}</td></tr>`;
        }).join("");
      };
      const pitLogRowsOf = (entries) => entries.filter((e) => e.pit && e.pit.outs > 0).map((e) => {
        const l = e.pit;
        return `<tr><td>${fecha(e.date)}</td><td class="l">${gameLink(e.gameId, "vs " + e.opp)}</td>
        <td>${ipOf(l.outs)}</td><td>${l.h}</td><td>${l.r}</td><td>${l.er}</td><td>${l.bb}</td><td>${l.k}</td><td>${l.hr}</td><td>${l.pitches}</td></tr>`;
      }).join("");
      const logRows = batLogRows(log);
      const pitLogRows = pitLogRowsOf(log);
      const postBatRows = batLogRows(postLog);
      const postPitRows = pitLogRowsOf(postLog);
      const batSplitRow = (label, sn, x, tot = false) => `<tr${tot ? ' style="font-weight:700;background:#eef4fb"' : ""}><td>${label}</td><td>${sn}</td><td>${x.g}</td><td>${x.pa}</td><td>${x.ab}</td><td>${x.r}</td><td>${x.h}</td><td>${x.doubles}</td><td>${x.triples}</td><td>${x.hr}</td><td>${x.rbi}</td><td>${x.bb}</td><td>${x.k}</td><td>${x.sb}</td><td>${f3(x.avg)}</td><td>${f3(x.obp)}</td><td>${f3(x.slg)}</td><td><b>${f3(x.ops)}</b></td></tr>`;
      const pitSplitRow = (label, sn, x, tot = false) => `<tr${tot ? ' style="font-weight:700;background:#eef4fb"' : ""}><td>${label}</td><td>${sn}</td><td>${x.gp}</td><td>${x.w}-${x.l}</td><td>${x.sv}</td><td>${ipOf(x.outs)}</td><td>${x.h}</td><td>${x.r}</td><td>${x.er}</td><td>${x.bb}</td><td>${x.k}</td><td>${x.hr}</td><td><b>${f2(x.era)}</b></td><td>${f2(x.whip)}</td></tr>`;
      const fldSplitRow = (label, sn, x, tot = false) => `<tr${tot ? ' style="font-weight:700;background:#eef4fb"' : ""}><td>${label}</td><td>${sn}</td><td>${x.po}</td><td>${x.a}</td><td>${x.e}</td><td>${x.tc}</td><td>${f3(x.fpct)}</td></tr>`;
      let carBatRows = "", carPitRows = "", carFldRows = "";
      if (career) {
        for (const yd of [...yearData].reverse()) {
          const sn = teamShort(histTeamOf(yd.stats, pid) ?? histTeamOf(yd.post, pid) ?? b?.teamId ?? null);
          const bl = yd.stats.batting.find((x) => x.playerId === pid);
          const pl = yd.post.batting.find((x) => x.playerId === pid);
          const pi = yd.stats.pitching.find((x) => x.playerId === pid);
          const ppi = yd.post.pitching.find((x) => x.playerId === pid);
          const fl = yd.stats.fielding.find((x) => x.playerId === pid);
          const pfl = yd.post.fielding.find((x) => x.playerId === pid);
          if (bl) carBatRows += batSplitRow(String(yd.year), sn, bl);
          if (pl) carBatRows += batSplitRow(`${yd.year} <span class="m">PO</span>`, sn, pl);
          if (pi) carPitRows += pitSplitRow(String(yd.year), sn, pi);
          if (ppi) carPitRows += pitSplitRow(`${yd.year} <span class="m">PO</span>`, sn, ppi);
          if (fl) carFldRows += fldSplitRow(String(yd.year), sn, fl);
          if (pfl) carFldRows += fldSplitRow(`${yd.year} <span class="m">PO</span>`, sn, pfl);
        }
        if (b) carBatRows += batSplitRow("Carrera", "", b, true);
        if (pb) carBatRows += batSplitRow("Carrera \u{1F3C6}", "", pb, true);
        if (p) carPitRows += pitSplitRow("Carrera", "", p, true);
        if (pp) carPitRows += pitSplitRow("Carrera \u{1F3C6}", "", pp, true);
        if (f) carFldRows += fldSplitRow("Carrera", "", f, true);
        if (pf) carFldRows += fldSplitRow("Carrera \u{1F3C6}", "", pf, true);
      }
      if (m.photo) photoPool.set(pid, m.photo);
      return `<div class="page" id="${pfx}/jugador/${pid}">
  <div class="player-head">
    ${m.photo ? `<div class="pphoto pph" data-ph="${pid}"></div>` : '<div class="pphoto pph"></div>'}
    <div><h2>${esc(m.name)}</h2>
    <div class="m">${m.teamId ? teamLink(m.teamId, m.teamName) : esc(m.teamName)} \xB7 Batea: ${esc(m.bats ?? "\u2014")} \xB7 Tira: ${esc(m.throws ?? "\u2014")} \xB7 Pos: ${esc(m.positions ?? "\u2014")}</div>
    <button class="cdl" onclick="makeCard('${pid}')" title="Card estilo MLB en PNG \u2014 formato vertical para compartir">\u{1F0CF} Descargar card PNG</button></div>
  </div>
  ${career && carBatRows ? `<h3>Bateo \u2014 carrera por temporada</h3>
  <div class="tw"><table><thead><tr><th>A\xF1o</th><th>Eq</th><th>G</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
  <tbody>${carBatRows}</tbody></table></div>` : ""}
  ${career && carPitRows ? `<h3>Pitcheo \u2014 carrera por temporada</h3>
  <div class="tw"><table><thead><tr><th>A\xF1o</th><th>Eq</th><th>G</th><th>W-L</th><th>SV</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>ERA</th><th>WHIP</th></tr></thead>
  <tbody>${carPitRows}</tbody></table></div>` : ""}
  ${career && carFldRows ? `<h3>Fildeo \u2014 carrera por temporada</h3>
  <div class="tw"><table><thead><tr><th>A\xF1o</th><th>Eq</th><th>PO</th><th>A</th><th>E</th><th>TC</th><th>FPCT</th></tr></thead>
  <tbody>${carFldRows}</tbody></table></div>` : ""}
  ${!career && b ? `<h3>Bateo \u2014 temporada</h3>${batSeasonTable(b)}` : ""}
  ${b && b.situ.risp.ab + b.situ.loaded.ab + b.situ.twoOut.ab + b.situ.leadoff.ab > 0 ? `<p class="m">Situacional${career ? " carrera" : ""} \u2014 RISP: ${b.situ.risp.h}-${b.situ.risp.ab} \xB7 Llenas: ${b.situ.loaded.h}-${b.situ.loaded.ab} \xB7 2 outs: ${b.situ.twoOut.h}-${b.situ.twoOut.ab} \xB7 Leadoff: ${b.situ.leadoff.h}-${b.situ.leadoff.ab}</p>` : ""}
  ${!career && p ? `<h3>Pitcheo \u2014 temporada</h3>${pitSeasonTable(p)}` : ""}
  ${!career && f ? `<p class="m">Fildeo: ${f.po} PO \xB7 ${f.a} A \xB7 ${f.e} E \xB7 TC ${f.tc} \xB7 FPCT ${f3(f.fpct)}</p>` : ""}
  ${!career && (pb || pp || pf) ? `<h2 class="sec">\u{1F3C6} Postemporada</h2>` : ""}
  ${!career && pb ? `<h3>Bateo \u2014 playoff</h3>${batSeasonTable(pb)}` : ""}
  ${!career && pp ? `<h3>Pitcheo \u2014 playoff</h3>${pitSeasonTable(pp)}` : ""}
  ${!career && pf ? `<p class="m">Fildeo playoff: ${pf.po} PO \xB7 ${pf.a} A \xB7 ${pf.e} E \xB7 TC ${pf.tc} \xB7 FPCT ${f3(pf.fpct)}</p>` : ""}
  ${postBatRows ? `<h3>Bateo juego a juego \u2014 playoff</h3>
  <div class="tw"><table><thead><tr><th>Fecha</th><th class="l">Opp</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th></tr></thead>
  <tbody>${postBatRows}</tbody></table></div>` : ""}
  ${postPitRows ? `<h3>Pitcheo juego a juego \u2014 playoff</h3>
  <div class="tw"><table><thead><tr><th>Fecha</th><th class="l">Opp</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th></tr></thead>
  <tbody>${postPitRows}</tbody></table></div>` : ""}
  ${(() => {
        const vs = stats.matchups.get(pid);
        if (!vs || !vs.size) return "";
        const rows = [...vs.entries()].map(([pitId, m2]) => ({ pitId, m: m2 })).sort((a, b2) => b2.m.pa - a.m.pa);
        return `<h3>vs Lanzadores</h3>
  <div class="tw"><table><thead><tr><th class="l">Lanzador</th><th>PA</th><th>AB</th><th>H</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>AVG</th></tr></thead>
  <tbody>${rows.map(({ pitId, m: m2 }) => `<tr><td class="l">${playerLink(pitId, stats.meta.get(pitId)?.name ?? pitId)}</td><td>${m2.pa}</td><td>${m2.ab}</td><td>${m2.h}</td><td>${m2.hr}</td><td>${m2.rbi}</td><td>${m2.bb}</td><td>${m2.k}</td><td><b>${f3(m2.ab ? m2.h / m2.ab : 0)}</b></td></tr>`).join("")}</tbody></table></div>`;
      })()}
  ${(() => {
        const rows = [];
        for (const [bid, mmap] of stats.matchups) {
          const m2 = mmap.get(pid);
          if (m2) rows.push({ bid, m: m2 });
        }
        if (!rows.length) return "";
        rows.sort((a, b2) => b2.m.pa - a.m.pa);
        return `<h3>vs Bateadores (lanzando)</h3>
  <div class="tw"><table><thead><tr><th class="l">Bateador</th><th>PA</th><th>AB</th><th>H</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>AVG</th></tr></thead>
  <tbody>${rows.map(({ bid, m: m2 }) => `<tr><td class="l">${playerLink(bid, stats.meta.get(bid)?.name ?? bid)}</td><td>${m2.pa}</td><td>${m2.ab}</td><td>${m2.h}</td><td>${m2.hr}</td><td>${m2.rbi}</td><td>${m2.bb}</td><td>${m2.k}</td><td><b>${f3(m2.ab ? m2.h / m2.ab : 0)}</b></td></tr>`).join("")}</tbody></table></div>`;
      })()}
  ${logRows ? `<h3>Bateo juego a juego</h3>
  <div class="tw"><table><thead><tr><th>Fecha</th><th class="l">Opp</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th></tr></thead>
  <tbody>${logRows}</tbody></table></div>` : ""}
  ${pitLogRows ? `<h3>Pitcheo juego a juego</h3>
  <div class="tw"><table><thead><tr><th>Fecha</th><th class="l">Opp</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th></tr></thead>
  <tbody>${pitLogRows}</tbody></table></div>` : ""}
  ${!b && !p && !pb && !pp ? '<p class="m">Sin actividad registrada en el torneo.</p>' : ""}
</div>`;
    }).join("\n");
    const postIds = new Set(post.results.map((r10) => r10.id));
    const allResults = [...stats.results, ...post.results];
    const metaName = (pid) => stats.meta.get(pid)?.name ?? post.meta.get(pid)?.name ?? pid;
    const gamePages = career ? "" : allResults.map((r10) => {
      const box = stats.boxes.get(r10.id) ?? post.boxes.get(r10.id);
      if (!box) return "";
      const tag = (postIds.has(r10.id) ? " \u{1F3C6} playoff" : "") + (r10.forfeit ? " (forfeit)" : r10.tied ? " (empate)" : "");
      const inn = Math.max(box.linescore.away.length, box.linescore.home.length);
      const batRows = (side) => Object.values(box[side]).sort((a, b2) => b2.ab - a.ab).map((l) => `<tr><td class="l">${playerLink(l.playerId, metaName(l.playerId))}</td><td>${l.ab}</td><td>${l.r}</td><td>${l.h}</td><td>${l.rbi}</td><td>${l.doubles}</td><td>${l.triples}</td><td>${l.hr}</td><td>${l.bb}</td><td>${l.k}</td><td>${l.sb}</td><td>${f3(l.ab ? l.h / l.ab : 0)}</td></tr>`).join("");
      const sideOfPit = (pid) => r10.pitSide[pid] ?? (stats.meta.get(pid)?.teamId === r10.awayId ? "away" : "home");
      const decTags = (pid) => {
        const d = r10.dec;
        return [
          d.w.includes(pid) ? "G" : "",
          d.l.includes(pid) ? "P" : "",
          d.sv.includes(pid) ? "SV" : "",
          d.hld.includes(pid) ? "H" : "",
          d.bs.includes(pid) ? "BS" : "",
          d.cg.includes(pid) ? "JC" : "",
          d.sho.includes(pid) ? "SHO" : ""
        ].filter(Boolean).join(",");
      };
      const pitRows = (side) => Object.values(box.pitchers).filter((pl) => sideOfPit(pl.playerId) === side).map((pl) => `<tr><td class="l">${playerLink(pl.playerId, metaName(pl.playerId))}</td><td>${ipOf(pl.outs)}</td><td>${pl.h}</td><td>${pl.r}</td><td>${pl.er}</td><td>${pl.bb}</td><td>${pl.k}</td><td>${pl.hr}</td><td>${pl.pitches}</td><td><b>${decTags(pl.playerId)}</b></td></tr>`).join("");
      const pitTable = (side, name) => `
    <div><h3>${esc(name)} \u2014 Pitcheo</h3><div class="tw"><table><thead><tr><th class="l">Lanzador</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th><th>Dec</th></tr></thead><tbody>${pitRows(side) || '<tr><td colspan="10" class="m">\u2014</td></tr>'}</tbody></table></div></div>`;
      const recapName = (pid) => esc(metaName(pid).replace(/^#\d+\s*/, ""));
      const pitPool = postIds.has(r10.id) ? post.pitching : stats.pitching;
      const seasonPit = (pid) => pitPool.find((p) => p.playerId === pid) ?? stats.pitching.find((p) => p.playerId === pid) ?? post.pitching.find((p) => p.playerId === pid);
      const decParts = [
        ...r10.dec.w.map((pid) => `G: ${recapName(pid)} (${seasonPit(pid)?.w ?? 0}-${seasonPit(pid)?.l ?? 0})`),
        ...r10.dec.l.map((pid) => `P: ${recapName(pid)} (${seasonPit(pid)?.w ?? 0}-${seasonPit(pid)?.l ?? 0})`),
        ...r10.dec.sv.map((pid) => `SV: ${recapName(pid)} (${seasonPit(pid)?.sv ?? 0})`),
        ...r10.dec.hld.map((pid) => `H: ${recapName(pid)} (${seasonPit(pid)?.hld ?? 0})`),
        ...r10.dec.bs.map((pid) => `BS: ${recapName(pid)}`),
        ...r10.dec.cg.map((pid) => `JC: ${recapName(pid)}`),
        ...r10.dec.sho.map((pid) => `SHO: ${recapName(pid)}`)
      ];
      const recapSide = (side) => {
        const lines = Object.values(box[side]);
        const seg = (label, key) => {
          const xs = lines.filter((l) => key(l) > 0).sort((a, b) => key(b) - key(a)).map((l) => `${recapName(l.playerId)}${key(l) > 1 ? ` (${key(l)})` : ""}`);
          return xs.length ? `${label}: ${xs.join(", ")}` : "";
        };
        const parts2 = [
          seg("2B", (l) => l.doubles),
          seg("3B", (l) => l.triples),
          seg("HR", (l) => l.hr),
          seg("CI", (l) => l.rbi),
          seg("BR", (l) => l.sb),
          seg("SAC", (l) => l.sac + l.sf)
        ].filter(Boolean);
        parts2.push(`Dejados en base: ${box.lob[side]}`);
        return `<p><b>${esc(side === "away" ? r10.awayShort : r10.homeShort)}</b> \u2014 ${parts2.join(" \xB7 ")}</p>`;
      };
      return `<div class="page" id="pg/juego/${r10.id}">
  <h2>${teamLink(r10.awayId, r10.away)} ${r10.aR} @ ${teamLink(r10.homeId, r10.home)} ${r10.hR} <span class="m">\u2014 ${fecha(r10.date)}${r10.stadium ? ` \xB7 ${esc(r10.stadium)}` : ""}${tag}</span></h2>
  <div class="tw"><table><thead><tr><th></th>${Array.from({ length: inn }, (_, i) => `<th>${i + 1}</th>`).join("")}<th>R</th><th>H</th><th>DB</th></tr></thead>
  <tbody>
  <tr><td class="l">${esc(r10.awayShort)}</td>${Array.from({ length: inn }, (_, i) => `<td>${box.linescore.away[i] ?? "\u2014"}</td>`).join("")}<td><b>${r10.aR}</b></td><td>${Object.values(box.away).reduce((s, l) => s + l.h, 0)}</td><td>${box.lob.away}</td></tr>
  <tr><td class="l">${esc(r10.homeShort)}</td>${Array.from({ length: inn }, (_, i) => `<td>${box.linescore.home[i] ?? "\u2014"}</td>`).join("")}<td><b>${r10.hR}</b></td><td>${Object.values(box.home).reduce((s, l) => s + l.h, 0)}</td><td>${box.lob.home}</td></tr>
  </tbody></table></div>
  <div class="two">
    <div><h3>${esc(r10.away)} \u2014 Bateo</h3><div class="tw"><table><thead><tr><th class="l">Bateador</th><th>AB</th><th>R</th><th>H</th><th>CI</th><th>2B</th><th>3B</th><th>HR</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th></tr></thead><tbody>${batRows("away")}</tbody></table></div></div>
    <div><h3>${esc(r10.home)} \u2014 Bateo</h3><div class="tw"><table><thead><tr><th class="l">Bateador</th><th>AB</th><th>R</th><th>H</th><th>CI</th><th>2B</th><th>3B</th><th>HR</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th></tr></thead><tbody>${batRows("home")}</tbody></table></div></div>
  </div>
  <div class="two">
    ${pitTable("away", r10.away)}
    ${pitTable("home", r10.home)}
  </div>
  <h3>Recap</h3>
  ${decParts.length ? `<p><b>Decisiones:</b> ${decParts.join(" \xB7 ")}</p>` : ""}
  ${recapSide("away")}
  ${recapSide("home")}
</div>`;
    }).join("\n");
    const singlesOf = (b) => b.h - b.doubles - b.triples - b.hr;
    const leadersTable = (title2, rows, cols) => `<h3>${title2}</h3><div class="tw"><table><thead><tr>${cols}</tr></thead><tbody>${rows || '<tr><td colspan="8" class="m">Sin datos</td></tr>'}</tbody></table></div>`;
    const top15 = (arr, by, min, asc = false) => arr.filter(min).sort((a, b) => asc ? by(a) - by(b) : by(b) - by(a)).slice(0, 15);
    const tbOf = (b) => b.h + b.doubles + 2 * b.triples + 3 * b.hr;
    const xbhOf = (b) => b.doubles + b.triples + b.hr;
    const allLog = [...stats.playerLog.entries()].flatMap(([pid, arr]) => arr.map((e) => ({ pid, ...e })));
    const pNameOf = (pid) => stats.meta.get(pid)?.name ?? pid;
    const indRows = (pick, line, min = 1) => {
      const top = allLog.filter((e) => pick(e) >= min).sort((a, b) => pick(b) - pick(a)).slice(0, 3);
      return top.map((e) => `<tr><td>${playerLink(e.pid, pNameOf(e.pid))}</td><td><b>${line(e)}</b></td>
      <td class="m">vs ${esc(e.opp)}</td><td>${gameLink(e.gameId, fecha(e.date))}</td></tr>`).join("");
    };
    const indTable = (title2, pick, line, min) => leadersTable(title2, indRows(pick, line, min), '<th class="l">Jugador</th><th>Marca</th><th>Rival</th><th>Fecha</th>');
    const gOf = (pid) => stats.batting.find((b) => b.playerId === pid)?.g ?? stats.playerLog.get(pid)?.length ?? 0;
    const leadersPage = `<div class="page" id="${pfx}/lideres">
  <h2>L\xEDderes del torneo</h2>
  <p class="m">Clasifican a estad\xEDsticas de promedio: <b>\u2265 PA por juego \xD7 ${qPa}</b> (bateo) y <b>\u2265 IP por juego \xD7 ${qIp}</b> (pitcheo) \u2014 configurable en la liga (regla tipo MLB 9.22, con excepci\xF3n de relleno para AVG/OBP/SLG).</p>
  <div class="lbar"><label><b>Ver l\xEDderes de:</b> <select onchange="lseg(this)">
    <option value="bat">\u26BE Bateo</option>
    <option value="sab">\u{1F4CA} Sabermetr\xEDa \u2014 bateo</option>
    <option value="pit">\u{1F94E} Pitcheo</option>
    <option value="fld">\u{1F9E4} Defensa</option>
    <option value="_records">\u{1F3C5} Marcas del torneo (Highs &amp; Lows)</option>
  </select></label></div>
  <div class="lsec" data-ls="bat">
  <h2 class="sec">Bateo</h2>
  ${leadersTable("Promedio (AVG)", top15(batQualAvg, (b) => b.avg, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f3(b.avg)}</b></td><td>${b.ab}</td><td>${b.h}</td></tr>`).join(""), '<th class="l">Jugador</th><th>AVG</th><th>AB</th><th>H</th>')}
  ${leadersTable("Hits", top15(stats.batting, (b) => b.h, (b) => b.h > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.h}</b></td><td>${b.ab}</td></tr>`).join(""), '<th class="l">Jugador</th><th>H</th><th>AB</th>')}
  ${leadersTable("Sencillos", top15(stats.batting, singlesOf, (b) => singlesOf(b) > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${singlesOf(b)}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>1B</th>')}
  ${leadersTable("Carreras anotadas", top15(stats.batting, (b) => b.r, (b) => b.r > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.r}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>C</th>')}
  ${leadersTable("Carreras impulsadas", top15(stats.batting, (b) => b.rbi, (b) => b.rbi > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.rbi}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>CI</th>')}
  ${leadersTable("Jonrones", top15(stats.batting, (b) => b.hr, (b) => b.hr > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.hr}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>HR</th>')}
  ${leadersTable("Dobles", top15(stats.batting, (b) => b.doubles, (b) => b.doubles > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.doubles}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>2B</th>')}
  ${leadersTable("Triples", top15(stats.batting, (b) => b.triples, (b) => b.triples > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.triples}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>3B</th>')}
  ${leadersTable("Total de bases (TB)", top15(stats.batting, tbOf, (b) => tbOf(b) > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${tbOf(b)}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>TB</th>')}
  ${leadersTable("Extrabases (XBH)", top15(stats.batting, xbhOf, (b) => xbhOf(b) > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${xbhOf(b)}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>XBH</th>')}
  ${leadersTable("Bases robadas", top15(stats.batting, (b) => b.sb, (b) => b.sb > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.sb}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>BR</th>')}
  ${leadersTable("Bases por bolas", top15(stats.batting, (b) => b.bb, (b) => b.bb > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.bb}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>BB</th>')}
  ${leadersTable("Golpeados", top15(stats.batting, (b) => b.hbp, (b) => b.hbp > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.hbp}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>GP</th>')}
  ${leadersTable("Sacrificios", top15(stats.batting, (b) => b.sac + b.sf, (b) => b.sac + b.sf > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.sac + b.sf}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>SAC+SF</th>')}
  </div>
  <div class="lsec" data-ls="sab" style="display:none">
  <h2 class="sec">Sabermetr\xEDa</h2>
  ${leadersTable("OPS (OBP+SLG)", top15(batQualPa, (b) => b.ops, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f3(b.ops)}</b></td><td>${f3(b.obp)}</td><td>${f3(b.slg)}</td></tr>`).join(""), '<th class="l">Jugador</th><th>OPS</th><th>OBP</th><th>SLG</th>')}
  ${leadersTable("OBP (% embasado)", top15(batQualObp, (b) => b.obp, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f3(b.obp)}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>OBP</th>')}
  ${leadersTable("SLG (slugging)", top15(batQualSlg, (b) => b.slg, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f3(b.slg)}</b></td><td>${tbOf(b)}</td></tr>`).join(""), '<th class="l">Jugador</th><th>SLG</th><th>TB</th>')}
  ${leadersTable("ISO (poder aislado)", top15(batQualPa, (b) => b.iso, (b) => b.iso > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f3(b.iso)}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>ISO</th>')}
  ${leadersTable("BABIP", top15(batQualPa, (b) => b.babip, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f3(b.babip)}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>BABIP</th>')}
  ${leadersTable("wOBA", top15(batQualPa, (b) => b.woba, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f3(b.woba)}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>wOBA</th>')}
  ${leadersTable("wRAA (carreras sobre promedio)", top15(batQualPa, (b) => b.wraa, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f2(b.wraa)}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>wRAA</th>')}
  ${leadersTable("WAR* (estimado)", top15(batQualPa, (b) => b.war, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f2(b.war)}</b></td><td>${f3(b.woba)}</td></tr>`).join(""), '<th class="l">Jugador</th><th>WAR*</th><th>wOBA</th>')}
  </div>
  <div class="lsec" data-ls="pit" style="display:none">
  <h2 class="sec">Pitcheo</h2>
  <p class="m">*WAR = estimaci\xF3n saberm\xE9trica de la liga: wRAA del bateo (pesos wOBA, escala derivada de la liga) y FIP del pitcheo, contra nivel de reemplazo. Sin ajuste defensivo, posicional ni de parque \u2014 no es el WAR oficial de MLB.</p>
  ${leadersTable("Efectividad (ERA)", top15(pitQual, (p) => p.era, () => true, true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.era)}</b></td><td>${ipOf(p.outs)}</td><td>${p.w}-${p.l}</td></tr>`).join(""), '<th class="l">Lanzador</th><th>ERA</th><th>IP</th><th>W-L</th>')}
  ${leadersTable("Ganados", top15(stats.pitching, (p) => p.w, (p) => p.w > 0).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${p.w}</b></td><td>${f2(p.era)}</td></tr>`).join(""), '<th class="l">Lanzador</th><th>W</th><th>ERA</th>')}
  ${leadersTable("Ponches", top15(stats.pitching, (p) => p.k, (p) => p.k > 0).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${p.k}</b></td><td>${ipOf(p.outs)}</td></tr>`).join(""), '<th class="l">Lanzador</th><th>K</th><th>IP</th>')}
  ${leadersTable("WHIP", top15(pitQual, (p) => p.whip, () => true, true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.whip)}</b></td><td>${ipOf(p.outs)}</td></tr>`).join(""), '<th class="l">Lanzador</th><th>WHIP</th><th>IP</th>')}
  ${leadersTable("Salvados", top15(stats.pitching, (p) => p.sv, (p) => p.sv > 0).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${p.sv}</b></td></tr>`).join(""), '<th class="l">Lanzador</th><th>SV</th>')}
  ${leadersTable("Holds (HLD)", top15(stats.pitching, (p) => p.hld, (p) => p.hld > 0).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${p.hld}</b></td></tr>`).join(""), '<th class="l">Lanzador</th><th>HLD</th>')}
  ${leadersTable("Innings lanzados", top15(stats.pitching, (p) => p.outs, (p) => p.outs > 0).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${ipOf(p.outs)}</b></td><td>${p.gp}G</td></tr>`).join(""), '<th class="l">Lanzador</th><th>IP</th><th>G</th>')}
  ${leadersTable("Juegos completos", top15(stats.pitching, (p) => p.cg, (p) => p.cg > 0).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${p.cg}</b></td></tr>`).join(""), '<th class="l">Lanzador</th><th>CG</th>')}
  ${leadersTable("Blanqueadas", top15(stats.pitching, (p) => p.sho, (p) => p.sho > 0).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${p.sho}</b></td></tr>`).join(""), '<th class="l">Lanzador</th><th>SHO</th>')}
  <h2 class="sec">Pitcheo avanzado</h2>
  ${leadersTable("K/9", top15(pitQual, (p) => p.k9, () => true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.k9)}</b></td></tr>`).join(""), '<th class="l">Lanzador</th><th>K/9</th>')}
  ${leadersTable("BB/9 (control)", top15(pitQual, (p) => p.bb9, () => true, true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.bb9)}</b></td></tr>`).join(""), '<th class="l">Lanzador</th><th>BB/9</th>')}
  ${leadersTable("K/BB", top15(pitQual, (p) => p.kbb, () => true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.kbb)}</b></td></tr>`).join(""), '<th class="l">Lanzador</th><th>K/BB</th>')}
  ${leadersTable("P/IP (eficiencia)", top15(pitQual, (p) => p.pIp, () => true, true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.pIp)}</b></td></tr>`).join(""), '<th class="l">Lanzador</th><th>P/IP</th>')}
  ${leadersTable("AVG contra", top15(pitQual, (p) => p.avgAgainst, (p) => p.bf > 0, true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f3(p.avgAgainst)}</b></td><td>${p.abAg} AB</td></tr>`).join(""), '<th class="l">Lanzador</th><th>AVG</th><th>AB contra</th>')}
  ${leadersTable("FIP", top15(pitQual, (p) => p.fip, () => true, true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.fip)}</b></td><td>${f2(p.era)}</td></tr>`).join(""), '<th class="l">Lanzador</th><th>FIP</th><th>ERA</th>')}
  ${leadersTable("WAR* pitcheo (estimado)", top15(pitQual, (p) => p.war, () => true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.war)}</b></td><td>${f2(p.fip)}</td></tr>`).join(""), '<th class="l">Lanzador</th><th>WAR*</th><th>FIP</th>')}
  <h2 class="sec">Marcas individuales de pitcheo (highs &amp; lows en un juego)</h2>
  ${indTable("M\xE1s innings", (e) => e.pit?.outs ?? 0, (e) => `${ipOf(e.pit.outs)} IP`)}
  ${indTable("M\xE1s ponches", (e) => e.pit?.k ?? 0, (e) => `${e.pit.k} K`, 2)}
  ${indTable("M\xE1s lanzamientos", (e) => e.pit?.pitches ?? 0, (e) => `${e.pit.pitches} Pit`, 5)}
  ${indTable("Menos hits permitidos (5+ outs)", (e) => e.pit && e.pit.outs >= 5 ? -e.pit.h : 0, (e) => `${e.pit.h} H en ${ipOf(e.pit.outs)} IP`)}
  ${indTable("M\xE1s bases por bolas", (e) => e.pit?.bb ?? 0, (e) => `${e.pit.bb} BB`, 2)}
  </div>
  <div class="lsec" data-ls="fld" style="display:none">
  <h2 class="sec">Defensa</h2>
  ${leadersTable("Promedio de fildeo", top15(stats.fielding, (f) => f.fpct, (f) => f.tc >= 3).map((f) => `<tr><td class="l">${playerLink(f.playerId, f.name)} <span class="m">(${esc(f.shortName)})</span></td><td><b>${f3(f.fpct)}</b></td><td>${f.tc} TC</td></tr>`).join(""), '<th class="l">Jugador</th><th>FPCT</th><th>TC</th>')}
  ${leadersTable("Range Factor (PO+A)/J", top15(stats.fielding, (f) => (f.po + f.a) / Math.max(1, gOf(f.playerId)), (f) => gOf(f.playerId) >= 2 && f.po + f.a > 0).map((f) => `<tr><td class="l">${playerLink(f.playerId, f.name)} <span class="m">(${esc(f.shortName)})</span></td><td><b>${f2((f.po + f.a) / Math.max(1, gOf(f.playerId)))}</b></td><td>${gOf(f.playerId)} JJ</td><td>${f.po}+${f.a}</td></tr>`).join(""), '<th class="l">Jugador</th><th>RF/G</th><th>JJ</th><th>PO+A</th>')}
  ${leadersTable("Menos errores (min. 5 TC)", top15(stats.fielding, (f) => f.e, (f) => f.tc >= 5, true).map((f) => `<tr><td class="l">${playerLink(f.playerId, f.name)} <span class="m">(${esc(f.shortName)})</span></td><td><b>${f.e}</b></td><td>${f3(f.fpct)}</td></tr>`).join(""), '<th class="l">Jugador</th><th>E</th><th>FPCT</th>')}
  ${leadersTable("Putouts", top15(stats.fielding, (f) => f.po, (f) => f.po > 0).map((f) => `<tr><td class="l">${playerLink(f.playerId, f.name)} <span class="m">(${esc(f.shortName)})</span></td><td><b>${f.po}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>PO</th>')}
  ${leadersTable("Asistencias", top15(stats.fielding, (f) => f.a, (f) => f.a > 0).map((f) => `<tr><td class="l">${playerLink(f.playerId, f.name)} <span class="m">(${esc(f.shortName)})</span></td><td><b>${f.a}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>A</th>')}
  ${leadersTable("Oportunidades (TC)", top15(stats.fielding, (f) => f.tc, (f) => f.tc > 0).map((f) => `<tr><td class="l">${playerLink(f.playerId, f.name)} <span class="m">(${esc(f.shortName)})</span></td><td><b>${f.tc}</b></td></tr>`).join(""), '<th class="l">Jugador</th><th>TC</th>')}
  </div>
</div>`;
    const tgl = stats.teamGameLines;
    const tName = (tid) => league.teams.find((t) => t.id === tid);
    const bestOf = (arr, by, high = true) => arr.length ? arr.reduce((a, b) => (high ? by(b) > by(a) : by(b) < by(a)) ? b : a) : null;
    const tglRow = (label, by, high, fmt) => {
      const l = bestOf(tgl, by, high);
      if (!l) return "";
      const t = tName(l.teamId);
      return `<tr><td class="l">${label}</td><td><b>${fmt(l)}</b></td>
      <td class="l">${t ? teamLink(l.teamId, t.name) : esc(l.teamId)} vs ${esc(l.opp)}</td>
      <td>${gameLink(l.gameId, fecha(l.date))}</td></tr>`;
    };
    const margin = (w) => {
      const f = w ? (l) => l.rf - l.ra : (l) => l.ra - l.rf;
      return f;
    };
    const recordsPage = `<div class="page" id="${pfx}/records">
  <h2>Marcas del torneo (Highs &amp; Lows)</h2>
  <h3>Equipo \u2014 mejor juego</h3>
  <div class="tw"><table><thead><tr><th class="l">Marca</th><th>Valor</th><th class="l">Equipo</th><th>Fecha</th></tr></thead>
  <tbody>
  ${tglRow("M\xE1s carreras anotadas", (l) => l.rf, true, (l) => `${l.rf}`)}
  ${tglRow("M\xE1s hits", (l) => l.h, true, (l) => `${l.h}`)}
  ${tglRow("M\xE1s carreras impulsadas", (l) => l.rbi, true, (l) => `${l.rbi}`)}
  ${tglRow("M\xE1s bases por bolas", (l) => l.bb, true, (l) => `${l.bb}`)}
  ${tglRow("M\xE1s bases robadas", (l) => l.sb, true, (l) => `${l.sb}`)}
  ${tglRow("M\xE1s dejados en base", (l) => l.lob, true, (l) => `${l.lob}`)}
  ${tglRow("Mayor margen de victoria", margin(true), true, (l) => `+${l.rf - l.ra} (${l.rf}-${l.ra})`)}
  ${tglRow("Juego m\xE1s largo", (l) => l.inn, true, (l) => `${l.inn} entradas`)}
  ${tglRow("M\xE1s ponches lanzados", (l) => l.pK, true, (l) => `${l.pK}`)}
  ${tglRow("Menos hits permitidos", (l) => l.pH, false, (l) => `${l.pH}`)}
  </tbody></table></div>
  <h3>Equipo \u2014 peor juego</h3>
  <div class="tw"><table><thead><tr><th class="l">Marca</th><th>Valor</th><th class="l">Equipo</th><th>Fecha</th></tr></thead>
  <tbody>
  ${tglRow("Menos carreras anotadas", (l) => l.rf, false, (l) => `${l.rf}`)}
  ${tglRow("Menos hits", (l) => l.h, false, (l) => `${l.h}`)}
  ${tglRow("M\xE1s carreras permitidas", (l) => l.ra, true, (l) => `${l.ra}`)}
  ${tglRow("M\xE1s hits permitidos", (l) => l.pH, true, (l) => `${l.pH}`)}
  ${tglRow("M\xE1s errores", (l) => l.e, true, (l) => `${l.e}`)}
  ${tglRow("M\xE1s ponches al bate", (l) => l.k, true, (l) => `${l.k}`)}
  ${tglRow("Mayor margen de derrota", margin(false), true, (l) => `-${l.ra - l.rf} (${l.rf}-${l.ra})`)}
  </tbody></table></div>
  <h2 class="sec">Marcas individuales en un juego \u2014 Bateo</h2>
  ${indTable("M\xE1s hits", (e) => e.bat?.h ?? 0, (e) => `${e.bat.h} H`, 2)}
  ${indTable("M\xE1s jonrones", (e) => e.bat?.hr ?? 0, (e) => `${e.bat.hr} HR`)}
  ${indTable("M\xE1s carreras impulsadas", (e) => e.bat?.rbi ?? 0, (e) => `${e.bat.rbi} CI`, 2)}
  ${indTable("M\xE1s carreras anotadas", (e) => e.bat?.r ?? 0, (e) => `${e.bat.r} C`, 2)}
  ${indTable("M\xE1s bases robadas", (e) => e.bat?.sb ?? 0, (e) => `${e.bat.sb} BR`)}
  ${indTable("M\xE1s bases por bolas", (e) => e.bat?.bb ?? 0, (e) => `${e.bat.bb} BB`, 2)}
  <h2 class="sec">Marcas individuales en un juego \u2014 Pitcheo</h2>
  ${indTable("M\xE1s innings", (e) => e.pit?.outs ?? 0, (e) => `${ipOf(e.pit.outs)} IP`)}
  ${indTable("M\xE1s ponches", (e) => e.pit?.k ?? 0, (e) => `${e.pit.k} K`, 2)}
  ${indTable("M\xE1s lanzamientos", (e) => e.pit?.pitches ?? 0, (e) => `${e.pit.pitches} Pit`, 5)}
  ${indTable("Menos hits permitidos (5+ outs)", (e) => e.pit && e.pit.outs >= 5 ? -e.pit.h : 0, (e) => `${e.pit.h} H en ${ipOf(e.pit.outs)} IP`)}
  ${indTable("M\xE1s bases por bolas", (e) => e.pit?.bb ?? 0, (e) => `${e.pit.bb} BB`, 2)}
</div>`;
    const resById = new Map(post.results.map((r10) => [r10.id, r10]));
    const poRounds = [...new Set(series.map((x) => x.round))].sort((a, b) => a - b);
    const seriesBlock = (sr) => {
      const wins = /* @__PURE__ */ new Map();
      const rows = [...sr.games].sort((a, b) => +new Date(a.date) - +new Date(b.date)).map((g, i) => {
        const r10 = resById.get(g.id);
        if (!r10) return `<tr><td>J${i + 1}</td><td colspan="4" class="m">Programado</td></tr>`;
        const gw = r10.tied ? null : r10.aR > r10.hR ? r10.awayId : r10.homeId;
        if (gw) wins.set(gw, (wins.get(gw) ?? 0) + 1);
        return `<tr><td>J${i + 1} \xB7 ${fecha(r10.date)}</td><td class="l">${teamLink(r10.awayId, r10.away)} <b>${r10.aR}</b></td><td>@</td><td class="l">${teamLink(r10.homeId, r10.home)} <b>${r10.hR}</b></td><td>${gameLink(r10.id, "boxscore")}</td></tr>`;
      }).join("");
      const winName = sr.winnerTeamId ? tName(sr.winnerTeamId)?.name : null;
      return `<h4>${esc(redactStr(sr.name))} <span class="m">\u2014 al mejor de ${sr.winsNeeded * 2 - 1}${winName ? ` \xB7 \u2714 gana <b>${esc(winName)}</b>` : ""}</span></h4>
      <div class="tw"><table><tbody>${rows || '<tr><td class="m">Sin juegos todav\xEDa</td></tr>'}</tbody></table></div>
      <p class="m">Serie: ${tName(sr.homeTeamId)?.shortName ?? "?"} <b>${wins.get(sr.homeTeamId) ?? 0}</b> \u2014 <b>${wins.get(sr.awayTeamId) ?? 0}</b> ${tName(sr.awayTeamId)?.shortName ?? "?"}</p>`;
    };
    const champ = poRounds.length ? series.find((x) => x.round === poRounds[poRounds.length - 1] && x.winnerTeamId) : null;
    const seriesWins = (sr) => {
      const w = /* @__PURE__ */ new Map();
      for (const g of sr.games) {
        const r10 = resById.get(g.id);
        if (!r10 || r10.tied) continue;
        const gw = r10.aR > r10.hR ? r10.awayId : r10.homeId;
        w.set(gw, (w.get(gw) ?? 0) + 1);
      }
      return w;
    };
    const bracket = !career && poRounds.length ? `<div class="brk">${poRounds.map((rd) => {
      const label = rd === poRounds[poRounds.length - 1] && poRounds.length > 1 ? "Final" : `Ronda ${rd}`;
      const cells = series.filter((x) => x.round === rd).map((sr) => {
        const w = seriesWins(sr);
        const aw = w.get(sr.awayTeamId ?? "") ?? 0, hw = w.get(sr.homeTeamId ?? "") ?? 0;
        const aWin = sr.winnerTeamId && sr.winnerTeamId === sr.awayTeamId;
        const hWin = sr.winnerTeamId && sr.winnerTeamId === sr.homeTeamId;
        return `<div class="brk-s">
        <div class="brk-t${aWin ? " win" : ""}"><span>${esc(tName(sr.awayTeamId)?.shortName ?? tName(sr.awayTeamId)?.name ?? "\u2014")}</span><b>${aw}</b></div>
        <div class="brk-t${hWin ? " win" : ""}"><span>${esc(tName(sr.homeTeamId)?.shortName ?? tName(sr.homeTeamId)?.name ?? "\u2014")}</span><b>${hw}</b></div>
        <div class="brk-m">${esc(redactStr(sr.name))} \xB7 mejor de ${sr.winsNeeded * 2 - 1}</div>
      </div>`;
      }).join("");
      return `<div class="brk-r"><h4>${label}</h4>${cells}</div>`;
    }).join("")}</div>` : "";
    const poGroups = career ? [...new Set(series.map((x) => x._year ?? 0))].sort((a, b) => a - b).map((y) => ({ label: `Temporada ${y}`, rows: series.filter((x) => (x._year ?? 0) === y) })) : poRounds.map((rd) => ({ label: rd === poRounds[poRounds.length - 1] && poRounds.length > 1 ? "Final" : `Ronda ${rd}`, rows: series.filter((x) => x.round === rd) }));
    const champLine = career ? poGroups.map((g) => {
      const yr = g.rows;
      const fin = yr.filter((x) => x.round === Math.max(...yr.map((r10) => r10.round)));
      const w = fin.find((x) => x.winnerTeamId)?.winnerTeamId;
      return w ? `<b>${g.label.replace("Temporada ", "")}</b>: ${esc(tName(w)?.name ?? "")}` : null;
    }).filter(Boolean).join(" \xB7 ") : "";
    const poLead = (title2, arr, fmt, min) => leaderCard(title2, arr, (b) => b.avg, fmt, batName, { min: min ?? ((b) => b.pa >= 6) });
    const playoffsPage = `<div class="page" id="${pfx}/playoffs">
  <h2>\u{1F3C6} Postemporada${career ? " \u2014 hist\xF3rico" : ""}</h2>
  ${career && champLine ? `<div class="champ">\u{1F3C6} Campeones: ${champLine}</div>` : ""}
  ${!career && champ?.winnerTeamId ? `<div class="champ">\u{1F3C6} Campe\xF3n de la temporada: <b>${esc(tName(champ.winnerTeamId)?.name ?? "")}</b></div>` : ""}
  ${bracket}
  ${poGroups.length ? poGroups.map((g) => `<h3>${g.label}</h3>` + g.rows.map(seriesBlock).join("")).join("") : '<p class="m">Esta temporada a\xFAn no tiene postemporada.</p>'}
  ${post.games ? `<h2 class="sec">L\xEDderes de playoff</h2>
    ${poLead("AVG", post.batting, (b) => f3(b.avg))}
    ${leaderCard("Jonrones", post.batting, (b) => b.hr, (b) => String(b.hr), batName)}
    ${leaderCard("Carreras impulsadas", post.batting, (b) => b.rbi, (b) => String(b.rbi), batName)}
    ${leaderCard("Hits", post.batting, (b) => b.h, (b) => String(b.h), batName)}
    ${leaderCard("Ganados", post.pitching, (p) => p.w, (p) => String(p.w), (p) => batName(p))}
    ${leaderCard("Salvados", post.pitching, (p) => p.sv, (p) => String(p.sv), (p) => batName(p))}
    ${leaderCard("ERA", post.pitching, (p) => p.era, (p) => f2(p.era), (p) => batName(p), { asc: true, min: (p) => p.outs >= 6 })}
    ${leaderCard("Ponches", post.pitching, (p) => p.k, (p) => String(p.k), (p) => batName(p))}` : ""}
</div>`;
    return [mainPage, teamPages, playerPages, gamePages, playoffsPage, leadersPage, recordsPage].join("\n");
  };
  const parts = [];
  for (const s of seasonList) {
    const filter = s.id ? { seasonId: s.id } : { year: s.year };
    const [stats, standings, post] = await Promise.all([
      leagueStats(league.id, "reg", filter),
      leagueStandings(league.id, filter),
      leagueStats(league.id, "post", filter)
    ]);
    const seasonSeries = allSeries.filter((sr) => s.id ? sr.seasonId === s.id : !sr.seasonId && sr.games.some((g) => new Date(g.date).getFullYear() === s.year));
    yearData.push({ year: s.year, stats: redactStats(stats), post: redactStats(post) });
    const yd = yearData[yearData.length - 1];
    parts.push(buildYear(yd.stats, redactStand(standings), `pg@${s.year}`, seasonSeries, yd.post));
  }
  if (multiYear) {
    const regC = redactStats(mergeStats(yearData.map((y) => y.stats)));
    const postC = redactStats(mergeStats(yearData.map((y) => y.post)));
    const seriesC = allSeries.map((sr) => ({ ...sr, _year: yearOfSeries(sr) }));
    parts.push(buildYear(regC, redactStand(careerStandings(regC)), "pg@car", seriesC, postC, true));
  }
  const photoImgs = [...photoPool.entries()].map(([pid, src]) => `<img id="ph-${pid}" src="${src}" alt="">`).join("");
  const yearSel = multiYear ? `<select id="ysel" class="ysel" title="Temporada">${seasonList.map((s) => `<option value="${s.year}">Temporada ${s.year}</option>`).join("")}<option value="car">Carrera</option></select>` : "";
  const playersJson = JSON.stringify(
    [...new Map(yearData.flatMap((y) => [...y.stats.meta, ...y.post.meta])).entries()].map(([id, m]) => ({ id, n: m.name, t: m.teamName }))
  ).replace(/</g, "\\u003c");
  const pstats = {};
  const BKEYS = ["g", "pa", "ab", "r", "h", "doubles", "triples", "hr", "rbi", "bb", "k", "sb", "hbp", "sf"];
  const PKEYS = { gp: "pGP", outs: "pOuts", er: "pER", r: "pR", bb: "pBB", k: "pK", h: "pH", w: "pW", l: "pL", sv: "pSV", gs: "pGS" };
  const teamCol = (tid) => league.teams.find((t) => t.id === tid)?.color ?? null;
  const fillMeta = (d, m) => {
    d.no = m.number ?? null;
    d.pos = m.positions ?? null;
    d.bt = `${m.bats ?? "?"}/${m.throws ?? "?"}`;
    d.col = m.teamId ? teamCol(m.teamId) : null;
  };
  for (const yd of yearData) for (const src of [yd.stats, yd.post]) {
    for (const b of src.batting) {
      const d = pstats[b.playerId] ??= { n: b.name, t: b.teamName, y: {} };
      fillMeta(d, b);
      const yy = d.y[yd.year] ??= {};
      for (const k of BKEYS) yy[k] = (yy[k] ?? 0) + (b[k] ?? 0);
    }
    for (const p of src.pitching) {
      const d = pstats[p.playerId] ??= { n: p.name, t: p.teamName, y: {} };
      fillMeta(d, p);
      const yy = d.y[yd.year] ??= {};
      for (const [k, kk] of Object.entries(PKEYS)) yy[kk] = (yy[kk] ?? 0) + (p[k] ?? 0);
    }
  }
  const pstatsJson = JSON.stringify(pstats).replace(/</g, "\\u003c");
  parts.push(`<div class="page" id="pg/comparar">
  <h2>\u2696\uFE0F Comparar jugadores</h2>
  <div class="cmpslots">
    <div class="cmpslot"><input id="cmpqa" type="search" placeholder="Jugador A\u2026" autocomplete="off"><div id="cmpda" class="cmpd"></div></div>
    <div class="cmpslot"><input id="cmpqb" type="search" placeholder="Jugador B\u2026" autocomplete="off"><div id="cmpdb" class="cmpd"></div></div>
  </div>
  <div id="cmpout"><p class="m">Elige los dos jugadores para compararlos \u2014 por carrera o por a\xF1o.</p></div>
</div>`);
  const nav = `<nav class="topnav"><a class="brand" href="#/">\u26BE ${esc(league.name)} ${multiYear ? '<b id="yrLbl"></b>' : league.year}</a>${yearSel}${league.teams.map((t) => `<a href="#/equipo/${t.id}">${esc(t.blocked ? "\u{1F6AB} BLOQUEADO" : t.shortName ?? t.name)}</a>`).join("")}<a href="#/lideres">L\xEDderes</a><a href="#/playoffs">Playoffs</a><a href="#/records">Records</a><a href="#/comparar">Comparar</a><span class="srch"><input id="psq" type="search" placeholder="\u{1F50E} Buscar jugador\u2026" autocomplete="off"><div id="psd"></div></span></nav>`;
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(league.name)} ${league.year} \u2014 PoxScore</title>
<style>
.blk{background:#b91c1c;color:#b91c1c;border-radius:3px;padding:0 1px;white-space:nowrap}
  :root { --navy:#1e3a5f; --line:#d7dee8; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; margin: 0; color:#1f2937; background:#f1f5f9; }
  .topnav { position:sticky; top:0; z-index:5; background:var(--navy); display:flex; flex-wrap:wrap; gap:2px; align-items:stretch; overflow-x:auto; }
  .topnav a { color:#eef3f8; text-decoration:none; padding:.55rem .8rem; font-size:.95rem; font-weight:600; white-space:nowrap; }
  .topnav a:hover { background:rgba(255,255,255,.15); }
  .topnav .brand { color:#fff; font-weight:800; }
  .srch { margin-left:auto; display:flex; align-items:center; position:relative; padding:0 .4rem; }
  .srch input { background:rgba(255,255,255,.15); border:1px solid rgba(255,255,255,.3); color:#fff; border-radius:6px; padding:.32rem .6rem; font-size:.8rem; width:170px; transition:width .2s; }
  .srch input::placeholder { color:#b8c4d8; }
  .srch input:focus { outline:none; background:rgba(255,255,255,.25); width:230px; border-color:rgba(255,255,255,.55); }
  #psd { position:fixed; min-width:270px; background:#fff; border-radius:8px; box-shadow:0 8px 28px rgba(0,0,0,.32); display:none; overflow:hidden; z-index:30; }
  #psd.on { display:block; }
  #psd a { display:flex; flex-direction:column; gap:1px; padding:.45rem .8rem; color:#1f2937; text-decoration:none; border-bottom:1px solid #eef1f5; font-size:.9rem; white-space:normal; }
  #psd a:hover { background:#f1f5f9; }
  #psd a span { color:#64748b; font-size:.74rem; text-transform:none; font-weight:400; }
  #psd .none { padding:.55rem .8rem; color:#64748b; font-size:.85rem; }
  .wrap { max-width:1100px; margin:0 auto; padding:1rem; }
  .banner { background:linear-gradient(90deg,var(--navy),#2f5b8f); color:#fff; padding:1rem 1.5rem; border-radius:10px; margin-bottom:1rem; }
  .banner h1 { margin:0; font-size:1.5rem; } .banner .m { color:#bcd; }
  h2 { color:var(--navy); border-bottom:2px solid var(--navy); padding-bottom:.2rem; margin-top:1.4rem; }
  h3 { color:var(--navy); margin:.9rem 0 .35rem; }
  h2.sec { background:var(--navy); color:#fff; padding:.3rem .7rem; border-radius:6px; }
  .tw { overflow-x:auto; }
  .page { display:none; }
  table { border-collapse:collapse; width:100%; font-size:.82rem; background:#fff; margin-bottom:.8rem; min-width:520px; }
  th,td { border:1px solid var(--line); padding:.3rem .45rem; text-align:center; white-space:nowrap; }
  th { background:var(--navy); color:#fff; font-weight:600; }
  td.l, th.l { text-align:left; } .m { color:#64748b; }
  a { color:#1668b4; }
  a[href^="#/jugador/"] { text-transform:uppercase; font-weight:700; font-size:1.06em; }
  a[href^="#/equipo/"] { font-weight:700; font-size:1.06em; }
  .player-head h2 { font-size:1.75rem; text-transform:uppercase; margin:.1rem 0 .15rem; }
  .player-head .pphoto { width:104px; height:104px; }
  h2 { font-size:1.35rem; }
  tr:nth-child(even) td { background:#f8fafc; }
  .leader { display:inline-block; vertical-align:top; min-width:210px; margin:0 1rem .8rem 0; background:#fff; border:1px solid var(--line); border-radius:8px; padding:.5rem .9rem; }
  .champ { background:linear-gradient(90deg,#fef3c7,#fde68a); border:1px solid #d97706; border-radius:8px; padding:.7rem 1rem; font-size:1.15rem; margin-bottom:1rem; }
  .leader h4 { margin:.2rem 0 .3rem; color:var(--navy); } .leader ol { margin:0; padding-left:1.2rem; }
  .leader li { display:flex; align-items:center; gap:.45rem; margin:.22rem 0; }
  .leader .lph { width:30px; height:30px; border-radius:50%; flex:none; display:inline-flex; align-items:center; justify-content:center; overflow:hidden; background:#cbd5e1; }
  .leader .lph .pphoto { width:30px; height:30px; border-radius:50%; }
  .leader .lph.pph::after { content:''; }
  .leader .linit { color:#475569; font-weight:700; font-size:.85rem; }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
  .player-head { display:flex; gap:1rem; align-items:center; margin-bottom:.4rem; }
  .pphoto { width:84px; height:84px; border-radius:10px; object-fit:cover; background:#cbd5e1; }
  .pph { display:flex; align-items:center; justify-content:center; color:#64748b; font-size:.62rem; }
  .pph::after { content:'SIN FOTO'; }
  .ysel { align-self:center; margin:.3rem .5rem .3rem .2rem; background:#fff; color:var(--navy); border:0; border-radius:6px; padding:.28rem .45rem; font-weight:700; font-size:.82rem; cursor:pointer; }
  /* bracket visual de playoffs */
  .brk { display:flex; gap:1.1rem; overflow-x:auto; margin:.6rem 0 1rem; padding-bottom:.3rem; }
  .brk-r { min-width:180px; flex:none; }
  .brk-r h4 { margin:.15rem 0 .5rem; color:var(--navy); text-transform:uppercase; font-size:.75rem; letter-spacing:.5px; }
  .brk-s { border:1.5px solid var(--line); border-radius:8px; margin-bottom:.9rem; background:#fff; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.07); }
  .brk-t { display:flex; justify-content:space-between; gap:.6rem; padding:.35rem .65rem; font-size:.84rem; }
  .brk-t+.brk-t { border-top:1px solid #eef1f5; }
  .brk-t.win { background:#dcfce7; font-weight:700; }
  .brk-m { font-size:.66rem; color:#64748b; padding:.28rem .65rem; background:#f8fafc; }
  /* comparador de jugadores */
  .cmpslots { display:grid; grid-template-columns:1fr 1fr; gap:1rem; margin-bottom:1rem; max-width:640px; }
  .cmpslot { position:relative; }
  .cmpslot input { width:100%; }
  .cmpd { position:absolute; left:0; right:0; top:calc(100% + 4px); background:#fff; border-radius:8px; box-shadow:0 8px 28px rgba(0,0,0,.28); display:none; overflow:hidden; z-index:20; }
  .cmpd.on { display:block; }
  .cmpd a { display:flex; flex-direction:column; gap:1px; padding:.45rem .8rem; color:#1f2937; cursor:pointer; border-bottom:1px solid #eef1f5; font-size:.9rem; }
  .cmpd a:hover { background:#f1f5f9; }
  .cmpd a span { color:#64748b; font-size:.74rem; }
  .cmpper { text-align:center; margin-bottom:.7rem; }
  .cmpt { max-width:600px; margin:0 auto; }
  .cmpt table { min-width:0; }
  .cmpt td { vertical-align:middle; }
  .cnum { display:block; font-weight:700; font-size:1.02rem; }
  .cbar { display:block; height:7px; border-radius:4px; background:#e2e8f0; margin-top:3px; }
  td.cvl .cbar { margin-left:auto; }
  td.cvl { text-align:right; width:44%; }
  td.cvr { text-align:left; width:44%; }
  td.clb { text-align:center; color:#6b7280; font-size:.78rem; letter-spacing:1px; width:12%; }
  td.w .cbar { background:linear-gradient(90deg,#16a34a,#4ade80); }
  td.w .cnum { color:#15803d; }
  .lbar { background:#fff; border:1px solid var(--line); border-radius:8px; padding:.5rem .9rem; margin:.6rem 0 1rem; display:inline-block; }
  .lbar select { font-size:.95rem; font-weight:600; padding:.3rem .5rem; border-radius:6px; border:1px solid var(--line); }
  .cdl { margin-top:.5rem; background:linear-gradient(135deg,#1e3a5f,#2f5b8f); color:#fff; border:0; border-radius:8px; padding:.45rem .9rem; font-size:.85rem; font-weight:700; cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,.2); }
  .cdl:hover { filter:brightness(1.15); }
  footer { color:#94a3b8; font-size:.8rem; margin:2rem 0; text-align:center; }
  @media (max-width:700px) { .two { grid-template-columns:1fr; } table { font-size:.75rem; } .wrap { padding:.6rem; } }
  @media print { .topnav { display:none } }
</style></head><body>
${nav}
<div class="wrap">
<header class="banner"><h1>\u26BE ${esc(league.name)}</h1><div class="m">${multiYear ? `${seasonList[seasonList.length - 1].year}\u2013${seasonList[0].year}` : league.year} \xB7 ${league.sport === "softball" ? "Softball" : "Baseball"} \xB7 ${finals.length} juegos finalizados${multiYear ? " \xB7 elige la temporada en el selector de arriba" : ""}</div></header>
${parts.join("\n").replace(/>(?:[^<>]*\b(?:null|NaN|undefined)\b[^<>]*)</g, '><span class="blk">\u2588\u2588</span><')}
<div id="phpool" hidden>${photoImgs}</div>
<footer>Generado por PoxScore \xB7 ${(/* @__PURE__ */ new Date()).toLocaleString("es")}<br>Desarrollado por Alexis Lara \xB7 2026</footer>
</div>
<script>
var YEARS=[${seasonList.map((s) => s.year).join(",")}];
var PLAYERS=${playersJson};
var curYear=YEARS[0];
var pages=document.querySelectorAll('.page');
var sel=document.getElementById('ysel');
function findpg(path){
  var e=document.getElementById('pg@'+curYear+path); if(e)return e;
  e=document.getElementById('pg'+path); if(e)return e;
  for(var i=0;i<YEARS.length;i++){e=document.getElementById('pg@'+YEARS[i]+path); if(e)return e;}
  return document.getElementById('pg@'+curYear+'/')||document.getElementById('pg/');
}
function showpg(el){
  for(var i=0;i<pages.length;i++) pages[i].style.display='none';
  if(!el)return;
  el.style.display='block';
  var ph=el.querySelectorAll('[data-ph]');
  for(var j=0;j<ph.length;j++){var s=document.getElementById('ph-'+ph[j].getAttribute('data-ph'));
    if(s&&!ph[j].firstChild){var img=document.createElement('img');img.className='pphoto';img.src=s.src;ph[j].appendChild(img);ph[j].classList.remove('pph');}}
}
function yearSeg(h){
  var seg=h.split('/');
  if(seg.length>1&&seg[1]==='car')return 'car';
  return seg.length>1&&seg[1].length===4&&YEARS.indexOf(+seg[1])>=0?seg[1]:null;
}
function route(){
  var h=location.hash.charAt(0)==='#'?location.hash.slice(1):location.hash;
  h=h||'/';
  var y=yearSeg(h);
  if(y){curYear=(y==='car')?'car':+y;h='/'+h.split('/').slice(2).join('/');}
  if(sel)sel.value=String(curYear);
  var yl=document.getElementById('yrLbl');if(yl)yl.textContent=(curYear==='car'?'Carrera':curYear);
  showpg(findpg(h));
  window.scrollTo(0,0);
}
if(sel)sel.onchange=function(){
  var h=location.hash.slice(1)||'/';
  if(yearSeg(h))h='/'+h.split('/').slice(2).join('/');
  if(h.charAt(0)!=='/')h='/'+h;
  location.hash='/'+sel.value+h;
};
var PSQ=document.getElementById('psq'),PSD=document.getElementById('psd');
function normTxt(s){return (s||'').toUpperCase().normalize('NFD').replace(/[\u0300-\u036F]/g,'');}
function posPSD(){var r=PSQ.getBoundingClientRect();PSD.style.top=(r.bottom+4)+'px';PSD.style.right=(innerWidth-r.right)+'px';}
if(PSQ){
  PSQ.addEventListener('focus',posPSD);
  addEventListener('resize',function(){if(PSD.classList.contains('on'))posPSD();});
  PSQ.addEventListener('input',function(){
    posPSD();
    var q=normTxt(PSQ.value);
    PSD.innerHTML='';
    if(q.length<2){PSD.classList.remove('on');return;}
    var n=0;
    for(var i=0;i<PLAYERS.length;i++){
      var p=PLAYERS[i];
      if(normTxt(p.n).indexOf(q)<0)continue;
      var a=document.createElement('a');
      a.href='#/jugador/'+p.id;
      a.innerHTML='<b>'+p.n+'</b>'+(p.t?'<span>'+p.t+'</span>':'');
      a.onclick=function(){PSD.classList.remove('on');PSQ.value='';};
      PSD.appendChild(a);
      if(++n>=12)break;
    }
    if(!n){var d=document.createElement('div');d.className='none';d.textContent='Sin resultados';PSD.appendChild(d);}
    PSD.classList.add('on');
  });
  PSQ.addEventListener('keydown',function(e){
    if(e.key==='Enter'){var a=PSD.querySelector('a');if(a){location.hash=a.getAttribute('href');PSD.classList.remove('on');PSQ.value='';}}
    if(e.key==='Escape'){PSD.classList.remove('on');PSQ.blur();}
  });
  document.addEventListener('click',function(e){if(!PSQ.parentNode.contains(e.target))PSD.classList.remove('on');});
}
/* ---- comparador de jugadores (#/comparar) ---- */
var PSTATS=${pstatsJson};
var CMP={a:null,b:null,per:'car'};
function cmpWire(qid,did,slot){
  var q=document.getElementById(qid),d=document.getElementById(did);
  if(!q||!d)return;
  q.addEventListener('input',function(){
    var qq=normTxt(q.value);d.innerHTML='';
    if(qq.length<2){d.classList.remove('on');return;}
    var n=0;
    for(var i=0;i<PLAYERS.length;i++){var p=PLAYERS[i];
      if(!PSTATS[p.id]||normTxt(p.n).indexOf(qq)<0)continue;
      var a=document.createElement('a');
      a.innerHTML='<b>'+p.n+'</b>'+(p.t?'<span>'+p.t+'</span>':'');
      a.onclick=function(pid,nn){return function(){CMP[slot]=pid;q.value=nn;d.classList.remove('on');renderCmp();};}(p.id,p.n);
      d.appendChild(a);if(++n>=10)break;
    }
    if(!n){var e=document.createElement('a');e.innerHTML='<span>Sin resultados</span>';d.appendChild(e);}
    d.classList.add('on');
  });
  document.addEventListener('click',function(e){if(!q.parentNode.contains(e.target))d.classList.remove('on');});
}
function cmpSum(pid){
  var y=PSTATS[pid]?PSTATS[pid].y:{};var z={};
  for(var yr in y){if(CMP.per!=='car'&&+yr!==CMP.per)continue;var s=y[yr];for(var k in s)z[k]=(z[k]||0)+s[k];}
  var od=(z.ab||0)+(z.bb||0)+(z.hbp||0)+(z.sf||0);
  z.avg=z.ab?(z.h||0)/z.ab:0;
  z.obp=od?((z.h||0)+(z.bb||0)+(z.hbp||0))/od:0;
  z.slg=z.ab?((z.h||0)+(z.doubles||0)+2*(z.triples||0)+3*(z.hr||0))/z.ab:0;
  z.ops=z.obp+z.slg;
  return z;
}
function cmpF(n,rate){return rate?n.toFixed(3).replace(/^0/,''):String(n||0);}
function renderCmp(){
  var out=document.getElementById('cmpout');if(!out)return;
  if(!CMP.a||!CMP.b){out.innerHTML='<p class="m">Elige los dos jugadores para compararlos \u2014 por carrera o por a\xF1o.</p>';return;}
  var yrs={},yr;
  for(yr in PSTATS[CMP.a].y)yrs[yr]=1;
  for(yr in PSTATS[CMP.b].y)yrs[yr]=1;
  yrs=Object.keys(yrs).sort(function(x,y){return +y-+x;});
  if(CMP.per!=='car'&&yrs.indexOf(String(CMP.per))<0)CMP.per='car';
  var sa=cmpSum(CMP.a),sb=cmpSum(CMP.b);
  var cats=[['JJ','g'],['VB','ab'],['CA','r'],['H','h'],['2B','doubles'],['3B','triples'],['HR','hr'],['CI','rbi'],['BB','bb'],['SO','k'],['BR','sb'],['AVG','avg'],['OBP','obp'],['SLG','slg'],['OPS','ops']];
  var rows=cats.map(function(c){
    var rate=c[1].length>2;
    var va=sa[c[1]]||0,vb=sb[c[1]]||0,hi=Math.max(va,vb);
    var pa=hi?Math.max(6,Math.round(va/hi*100)):0,pb=hi?Math.max(6,Math.round(vb/hi*100)):0;
    return '<tr><td class="cvl'+(va>vb?' w':'')+'"><span class="cnum">'+cmpF(va,rate)+'</span><span class="cbar" style="width:'+pa+'%"></span></td>'
      +'<td class="clb">'+c[0]+'</td>'
      +'<td class="cvr'+(vb>va?' w':'')+'"><span class="cnum">'+cmpF(vb,rate)+'</span><span class="cbar" style="width:'+pb+'%"></span></td></tr>';
  }).join('');
  var sel='<select id="cmper"><option value="car"'+(CMP.per==='car'?' selected':'')+'>Carrera</option>'
    +yrs.map(function(y){return '<option value="'+y+'"'+(String(CMP.per)===y?' selected':'')+'>'+y+'</option>';}).join('')+'</select>';
  out.innerHTML='<div class="cmpper">Per\xEDodo: '+sel+'</div><div class="tw cmpt"><table><thead><tr><th>'+PSTATS[CMP.a].n+'</th><th></th><th class="l" style="text-align:left">'+PSTATS[CMP.b].n+'</th></tr></thead><tbody>'+rows+'</tbody></table></div><p class="m">La barra verde marca qui\xE9n gana cada categor\xEDa'+(CMP.per!=='car'?' en '+CMP.per:' en su carrera')+'.</p>';
  var pe=document.getElementById('cmper');
  if(pe)pe.onchange=function(){CMP.per=this.value==='car'?'car':+this.value;renderCmp();};
}
cmpWire('cmpqa','cmpda','a');cmpWire('cmpqb','cmpdb','b');
/* ---- selector de secciones en L\xEDderes (bateo/saber/pitcheo/defensa/marcas) ---- */
function lseg(s){
  var v=s.value;
  if(v==='_records'){location.hash='#/records';return;}
  var pg=s.parentNode;
  while(pg&&(!pg.className||(' '+pg.className+' ').indexOf(' page ')<0))pg=pg.parentNode;
  if(!pg)return;
  var secs=pg.querySelectorAll('[data-ls]');
  for(var i=0;i<secs.length;i++)secs[i].style.display=secs[i].getAttribute('data-ls')===v?'':'none';
}
/* ---- card PNG estilo MLB (vertical, para WhatsApp/redes) ---- */
var LEAGUE=${JSON.stringify(league.name)};var REGINN=${league.innings ?? (league.sport === "softball" ? 7 : 9)};
function cardSum(pid,per){
  var d=PSTATS[pid];if(!d)return null;
  var y=d.y,z={};
  for(var yr in y){if(per!=='car'&&+yr!==+per)continue;var s=y[yr];for(var k in s)z[k]=(z[k]||0)+s[k];}
  var od=(z.ab||0)+(z.bb||0)+(z.hbp||0)+(z.sf||0);
  z.avg=z.ab?(z.h||0)/z.ab:0;
  z.obp=od?((z.h||0)+(z.bb||0)+(z.hbp||0))/od:0;
  z.slg=z.ab?((z.h||0)+(z.doubles||0)+2*(z.triples||0)+3*(z.hr||0))/z.ab:0;
  z.ops=z.obp+z.slg;
  z.ip=(z.pOuts||0)/3;
  z.era=z.ip?(z.pER||0)*REGINN/z.ip:0;
  z.whip=z.ip?((z.pBB||0)+(z.pH||0))/z.ip:0;
  return z;
}
function rrect(x,X,Y,W,H,R){x.beginPath();x.moveTo(X+R,Y);x.arcTo(X+W,Y,X+W,Y+H,R);x.arcTo(X+W,Y+H,X,Y+H,R);x.arcTo(X,Y+H,X,Y,R);x.arcTo(X,Y,X+W,Y,R);x.closePath();}
function cf3(n){return n?(''+n.toFixed(3)).replace(/^0/,''):'.000';}
function makeCard(pid){
  var d=PSTATS[pid];if(!d)return;
  var per=curYear==='car'?'car':curYear;
  var s=cardSum(pid,per)||{};
  var cv=document.createElement('canvas');cv.width=800;cv.height=1120;
  var x=cv.getContext('2d');
  var col=d.col||'#1e3a5f';
  // fondo: degradado del color del equipo a oscuro
  var g=x.createLinearGradient(0,0,0,1120);
  g.addColorStop(0,col);g.addColorStop(0.62,'#101c30');g.addColorStop(1,'#0a1120');
  x.fillStyle=g;x.fillRect(0,0,800,1120);
  // franjas sutiles
  x.fillStyle='rgba(255,255,255,.05)';
  for(var i=0;i<8;i++){x.save();x.translate(i*140-140,0);x.transform(1,0,-0.35,1,0,0);x.fillRect(0,0,46,1120);x.restore();}
  // banda superior
  x.fillStyle='rgba(0,0,0,.4)';x.fillRect(0,0,800,88);
  x.fillStyle='#fff';x.font='800 34px system-ui,sans-serif';x.textAlign='center';
  x.fillText(LEAGUE.toUpperCase(),400,56);
  x.fillStyle='rgba(255,255,255,.8)';x.font='600 22px system-ui';
  x.fillText(per==='car'?'CARRERA':'TEMPORADA '+per,400,84);
  // marco y foto (o iniciales)
  x.fillStyle='#fff';rrect(x,140,120,520,500,20);x.fill();
  var img=document.getElementById('ph-'+pid);
  x.save();rrect(x,160,140,480,460,14);x.clip();
  if(img&&img.naturalWidth){
    var iw=img.naturalWidth,ih=img.naturalHeight,sc=Math.max(480/iw,460/ih);
    var dw=iw*sc,dh=ih*sc;
    x.drawImage(img,160+(480-dw)/2,140+(460-dh)/2,dw,dh);
  }else{
    x.fillStyle='#94a3b8';x.fillRect(160,140,480,460);
    var ini=(d.n||'?').replace(/[^A-Za-z\xC1\xC9\xCD\xD3\xDA\xD1\xE1\xE9\xED\xF3\xFA\xF1 ]/g,'').trim().split(/s+/);
    var ii=((ini[0]||'?').charAt(0)+(ini.length>1?ini[ini.length-1].charAt(0):'')).toUpperCase();
    x.fillStyle='#1e3a5f';x.font='800 200px system-ui';
    x.fillText(ii,400,430);
    x.fillStyle='rgba(30,58,95,.55)';x.font='700 26px system-ui';x.fillText('SIN FOTO',400,575);
  }
  x.restore();
  // nombre (auto-encoge si es largo)
  var nm=(d.n||'').toUpperCase(),fs=54;
  x.font='800 '+fs+'px system-ui';
  while(x.measureText(nm).width>740&&fs>30){fs-=3;x.font='800 '+fs+'px system-ui';}
  x.fillStyle='#fff';x.fillText(nm,400,686);
  // equipo \xB7 n\xFAmero \xB7 posici\xF3n \xB7 B/T
  x.fillStyle='#ffd54d';x.font='700 28px system-ui';
  var sub=(d.t||'')+(d.no?'  \xB7  #'+d.no:'')+(d.pos?'  \xB7  '+d.pos:'')+(d.bt?'  \xB7  B/T '+d.bt:'');
  x.fillText(sub,400,730);
  // cajas de n\xFAmeros: bateo (y pitcheo si lanz\xF3)
  function statBoxes(list,y0){
    var n=list.length,w=Math.min(150,(740-(n-1)*14)/n),x0=(800-(w*n+(n-1)*14))/2;
    for(var i=0;i<n;i++){
      var bx=x0+i*(w+14);
      x.fillStyle='rgba(255,255,255,.09)';rrect(x,bx,y0,w,120,14);x.fill();
      x.strokeStyle='rgba(255,255,255,.25)';x.lineWidth=1.5;rrect(x,bx,y0,w,120,14);x.stroke();
      x.fillStyle='#9fb4d0';x.font='700 22px system-ui';x.fillText(list[i][0],bx+w/2,y0+40);
      x.fillStyle='#fff';x.font='800 40px system-ui';x.fillText(list[i][1],bx+w/2,y0+92);
    }
  }
  var batBoxes=[['AVG',cf3(s.avg)],['OPS',cf3(s.ops)],['HR',String(s.hr||0)],['CI',String(s.rbi||0)],['BR',String(s.sb||0)]];
  statBoxes(batBoxes,780);
  if((s.pOuts||0)>0){
    var pitBoxes=[['G-P',(s.pW||0)+'-'+(s.pL||0)],['ERA',(s.era||0).toFixed(2)],['WHIP',(s.whip||0).toFixed(2)],['K',String(s.pK||0)],['JS',String(s.pSV||0)]];
    statBoxes(pitBoxes,920);
    x.fillStyle='#9fb4d0';x.font='700 22px system-ui';x.fillText('PITCHEO',400,910);
  }
  // pie
  x.fillStyle='rgba(0,0,0,.4)';x.fillRect(0,1060,800,60);
  x.fillStyle='rgba(255,255,255,.75)';x.font='600 22px system-ui';
  x.fillText('Generado en PoxScore \xB7 Alexis Lara \xB7 2026',400,1098);
  // descargar
  var a=document.createElement('a');
  a.download='card-'+(d.n||'jugador').toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.png';
  a.href=cv.toDataURL('image/png');a.click();
}
addEventListener('hashchange',route); route();
</script>
</body></html>`;
  return html;
}

// src/routes/leagues.ts
var r4 = Router4();
r4.get("/", async (_req, res) => {
  const leagues = await prisma.league.findMany({
    orderBy: [{ year: "desc" }, { name: "asc" }],
    include: {
      seasons: { orderBy: { year: "desc" } },
      _count: { select: { teams: true, games: true } }
    }
  });
  res.json(leagues);
});
r4.post("/", async (req, res) => {
  const { name, year, sport } = req.body;
  if (!name) return res.status(400).json({ error: "name requerido" });
  const y = year ? Number(year) : null;
  const league = await prisma.league.create({
    data: { name, year: y ?? (/* @__PURE__ */ new Date()).getFullYear(), sport: sport ?? "baseball" }
  });
  if (y) await prisma.season.create({ data: { leagueId: league.id, year: y } }).catch(() => {
  });
  res.status(201).json(league);
});
r4.get("/:id", async (req, res) => {
  const league = await prisma.league.findUnique({
    where: { id: req.params.id },
    include: {
      teams: { orderBy: { name: "asc" }, include: { _count: { select: { players: true } } } },
      seasons: { orderBy: { year: "desc" } },
      games: {
        orderBy: { date: "asc" },
        include: {
          homeTeam: true,
          awayTeam: true,
          events: { orderBy: { seq: "asc" } }
        }
      }
    }
  });
  if (!league) return res.status(404).json({ error: "Liga no encontrada" });
  const games = league.games.map((g) => {
    const evs = g.events.map((e) => ({
      seq: e.seq,
      inning: e.inning,
      half: e.half,
      batterId: e.batterId,
      pitcherId: e.pitcherId,
      result: e.result,
      notation: e.notation,
      errorOn: e.errorOn ? JSON.parse(e.errorOn) : void 0,
      advances: e.advances
    }));
    const state = reduceGame(evs, g.innings);
    if ((!evs.length || g.forfeitBy) && g.fScoreAway != null && g.fScoreHome != null) state.score = { away: g.fScoreAway, home: g.fScoreHome };
    const { events: _e, ...rest } = g;
    return { ...rest, state };
  });
  res.json({ ...league, games: markDoubleheaders(games) });
});
r4.put("/:id", async (req, res) => {
  const { name, year, sport, qualPa, qualIp, playoffTeams, playoffRounds, innings, tb, sprayInput, wpMinOuts } = req.body;
  const league = await prisma.league.update({
    where: { id: req.params.id },
    data: {
      name,
      year: year != null ? Number(year) : void 0,
      sport,
      innings: innings !== void 0 ? innings === null || innings === "" || Number(innings) <= 0 ? null : Number(innings) : void 0,
      qualPa: qualPa != null ? Number(qualPa) : void 0,
      qualIp: qualIp != null ? Number(qualIp) : void 0,
      playoffTeams: playoffTeams !== void 0 ? playoffTeams === null ? null : Number(playoffTeams) : void 0,
      playoffRounds: playoffRounds !== void 0 ? playoffRounds === null ? null : Number(playoffRounds) : void 0,
      tb: tb === "pct" || tb === "h2h" || tb === "diff" ? tb : void 0,
      sprayInput: typeof sprayInput === "boolean" ? sprayInput : void 0,
      wpMinOuts: wpMinOuts !== void 0 ? wpMinOuts === null || wpMinOuts === "" || Number(wpMinOuts) <= 0 ? null : Number(wpMinOuts) : void 0
    }
  });
  res.json(league);
});
var deleteLeagueHandler = async (req, res) => {
  const auth = await adminOk(String(req.body?.password ?? ""));
  if (!auth.ok) return res.status(auth.code ?? 401).json({ error: auth.error });
  const leagueId = req.params.id;
  await autoBackup("antes de borrar liga");
  const gids = (await prisma.game.findMany({ where: { leagueId }, select: { id: true } })).map((g) => g.id);
  const tids = (await prisma.team.findMany({ where: { leagueId }, select: { id: true } })).map((t) => t.id);
  const pids = (await prisma.player.findMany({ where: { teamId: { in: tids } }, select: { id: true } })).map((p) => p.id);
  await prisma.gameEvent.deleteMany({ where: { gameId: { in: gids } } });
  await prisma.lineupEntry.deleteMany({ where: { OR: [{ gameId: { in: gids } }, { playerId: { in: pids } }] } });
  await prisma.playerSeasonStat.deleteMany({ where: { playerId: { in: pids } } });
  await prisma.game.deleteMany({ where: { leagueId } });
  await prisma.series.deleteMany({ where: { leagueId } });
  await prisma.player.deleteMany({ where: { id: { in: pids } } });
  await prisma.team.deleteMany({ where: { leagueId } });
  await prisma.league.delete({ where: { id: leagueId } });
  res.status(204).end();
};
r4.post("/:id/delete", deleteLeagueHandler);
r4.delete("/:id", deleteLeagueHandler);
r4.post("/:id/schedule", async (req, res) => {
  const league = await prisma.league.findUnique({
    where: { id: req.params.id },
    include: { teams: { orderBy: { createdAt: "asc" } } }
  });
  if (!league) return res.status(404).json({ error: "Liga no encontrada" });
  const body = req.body;
  const teams = league.teams;
  if (teams.length < 2) return res.status(400).json({ error: "Se necesitan al menos 2 equipos" });
  const sport = league.sport;
  const innings = league.innings ?? (sport === "softball" ? 7 : 9);
  const activeSeason = await prisma.season.findFirst({ where: { leagueId: league.id, status: "ACTIVE" } });
  const playDays = (body.playDays ?? []).filter((d) => d >= 0 && d <= 6);
  const daysBetween = Math.max(1, Number(body.daysBetween) || 7);
  let cursor = body.startDate ? /* @__PURE__ */ new Date(`${body.startDate}T18:00:00`) : /* @__PURE__ */ new Date();
  if (playDays.length) while (!playDays.includes(cursor.getDay())) cursor = new Date(cursor.getTime() + 864e5);
  const nextDate = () => {
    const d = cursor;
    do {
      cursor = new Date(cursor.getTime() + 864e5);
    } while (playDays.length ? !playDays.includes(cursor.getDay()) : false);
    if (!playDays.length) cursor = new Date(d.getTime() + daysBetween * 864e5);
    return d;
  };
  const data = [];
  const gameAt = (date, slot, away, home, note) => data.push({
    leagueId: league.id,
    sport,
    innings,
    status: "SCHEDULED",
    seasonId: activeSeason?.id ?? null,
    awayTeamId: away,
    homeTeamId: home,
    date: new Date(date.getTime() + slot * 2 * 36e5),
    ...note ? { note } : {}
  });
  const firstHomeId = body.firstHomeId && teams.some((t) => t.id === body.firstHomeId) ? body.firstHomeId : void 0;
  const firstAwayId = body.firstAwayId && teams.some((t) => t.id === body.firstAwayId) && body.firstAwayId !== firstHomeId ? body.firstAwayId : void 0;
  const end = body.endDate ? /* @__PURE__ */ new Date(`${body.endDate}T23:59:59`) : null;
  const rounds = Math.max(1, Math.round(body.rounds ?? (end ? 99 : 2)));
  const dh = !!body.doubleheader;
  const mode = body.mode ?? "normal";
  const MAX_JORNADAS = 400;
  if (mode === "triangular") {
    const rawGpd = Math.round(body.gamesPerDay ?? 2);
    const winnerStays = rawGpd === 3 && teams.length >= 3;
    const perDay = winnerStays ? 3 : Math.min(Math.max(1, rawGpd), teams.length - 1);
    const ids = teams.map((t) => t.id);
    const order = [
      ...firstHomeId ? [firstHomeId] : [],
      ...firstAwayId ? [firstAwayId] : [],
      ...ids.filter((x) => x !== firstHomeId && x !== firstAwayId)
    ];
    const meets = /* @__PURE__ */ new Map();
    const key = (a, b) => [a, b].sort().join("|");
    if (winnerStays) {
      const played = new Map(ids.map((x) => [x, 0]));
      const jornadas3 = Math.min(rounds * Math.ceil(ids.length / 3), MAX_JORNADAS);
      let jornadasHechas2 = 0;
      for (let j = 0; j < jornadas3; j++) {
        const date = nextDate();
        if (end && date > end) break;
        jornadasHechas2++;
        const trio = [...ids].sort((a, b) => played.get(a) - played.get(b) || order.indexOf(a) - order.indexOf(b)).slice(0, 3);
        const H = trio[j % 3], V = trio[(j + 1) % 3], W = trio[(j + 2) % 3];
        gameAt(date, 0, V, H, "Triangular QG \xB7 J1 \u2014 el ganador invierte rol en el J2");
        gameAt(date, 1, H, W, "Triangular QG \xB7 J2 \u2014 el GANADOR del J1 vs el que esper\xF3, INVIRTIENDO su rol: si gan\xF3 el visitante del J1 \xE9l va de home y el que esper\xF3 de visita (ajusta los equipos al iniciar)");
        gameAt(date, 2, W, V, "Triangular QG \xB7 J3 \u2014 el PERDEDOR del J1 vs el que esper\xF3, tambi\xE9n invirtiendo rol: si el perdedor era visitante va de home, si era local va de visita (ajusta al iniciar)");
        played.set(H, played.get(H) + 2);
        played.set(V, played.get(V) + 2);
        played.set(W, played.get(W) + 2);
      }
      const created3 = await prisma.game.createMany({ data });
      return res.status(201).json({ created: created3.count, jornadas: jornadasHechas2, mode: "triangular", style: "ganador-queda" });
    }
    const jornadas2 = Math.min(rounds * Math.ceil(ids.length * (ids.length - 1) / 2 / perDay), MAX_JORNADAS);
    let jornadasHechas = 0;
    for (let j = 0; j < jornadas2; j++) {
      const date = nextDate();
      if (end && date > end) break;
      jornadasHechas++;
      const home = order[j % order.length];
      const visitors = ids.filter((x) => x !== home).sort((a, b) => (meets.get(key(a, home)) ?? 0) - (meets.get(key(b, home)) ?? 0) || order.indexOf(a) - order.indexOf(b)).slice(0, perDay);
      visitors.forEach((v, i) => {
        meets.set(key(home, v), (meets.get(key(home, v)) ?? 0) + 1);
        gameAt(date, i, v, home);
      });
    }
    const created2 = await prisma.game.createMany({ data });
    return res.status(201).json({ created: created2.count, jornadas: jornadasHechas, mode: "triangular" });
  }
  const seriesLen = Math.max(1, Math.round(body.seriesLen ?? 1));
  const style = body.seriesStyle ?? "ida-vuelta";
  const divRounds = Math.max(0, Math.round(body.divRounds ?? 0));
  const divOf = new Map(teams.map((t) => [t.id, t.division ?? ""]));
  const hasDiv = teams.some((t) => t.division);
  const circleRounds = (ids) => {
    const n = ids.length;
    if (n % 2) ids = [...ids, null];
    const m = ids.length;
    const roundsList = [];
    const ring = ids.slice(1);
    for (let r10 = 0; r10 < m - 1; r10++) {
      const pairs = [ids[0], ...ring];
      const day = [];
      for (let i = 0; i < m / 2; i++) {
        const a = pairs[i], b = pairs[m - 1 - i];
        if (a && b) day.push([a, b]);
      }
      roundsList.push(day);
      ring.unshift(ring.pop());
    }
    return roundsList;
  };
  const homeCount = /* @__PURE__ */ new Map();
  const pickHome = (a, b) => (homeCount.get(a) ?? 0) <= (homeCount.get(b) ?? 0) ? a : b;
  const jornadas = [];
  const allIds = teams.map((t) => t.id);
  const baseRounds = circleRounds(allIds);
  for (let v = 0; v < rounds; v++) {
    baseRounds.forEach((day) => jornadas.push({ pairs: day.map(([a, b], i) => {
      const home = style === "random" ? pickHome(a, b) : (v + i) % 2 === 0 ? a : b;
      return home === a ? [b, a] : [a, b];
    }), vuelta: v }));
  }
  if (hasDiv && divRounds) {
    const byDiv = /* @__PURE__ */ new Map();
    for (const t of teams) {
      const d = t.division ?? "";
      if (!byDiv.has(d)) byDiv.set(d, []);
      byDiv.get(d).push(t.id);
    }
    const divLists = [...byDiv.values()].filter((m) => m.length >= 2).map((m) => circleRounds(m.slice()));
    const maxLen = Math.max(0, ...divLists.map((l) => l.length));
    for (let v = 0; v < divRounds; v++) {
      for (let r10 = 0; r10 < maxLen; r10++) {
        const pairs = [];
        for (const list of divLists) {
          for (const [a, b] of list[r10 % list.length]) {
            const home = (v + pairs.length) % 2 === 0 ? a : b;
            pairs.push(home === a ? [b, a] : [a, b]);
          }
        }
        if (pairs.length) jornadas.push({ pairs, vuelta: rounds + v });
      }
    }
  }
  if ((firstHomeId || firstAwayId) && jornadas.length) {
    const plays = (id) => !id || jornadas[0].pairs.some(([a, b]) => a === id || b === id);
    for (let k = 0; k < jornadas.length && !(plays(firstHomeId) && plays(firstAwayId)); k++) {
      jornadas.push(jornadas.shift());
    }
    const j0 = jornadas[0].pairs;
    const hI = j0.findIndex(([a, b]) => a === firstHomeId || b === firstHomeId);
    const aI = j0.findIndex(([a, b]) => a === firstAwayId || b === firstAwayId);
    if (hI >= 0 && aI >= 0 && hI !== aI) {
      const oppHome = j0[hI][0] === firstHomeId ? j0[hI][1] : j0[hI][0];
      j0[aI] = j0[aI][0] === firstAwayId ? [oppHome, j0[aI][1]] : [j0[aI][0], oppHome];
      j0[hI] = [firstAwayId, firstHomeId];
    } else if (hI >= 0) {
      const j = j0[hI];
      j0[hI] = j[1] === firstHomeId ? j : [j[1], j[0]];
    } else if (aI >= 0) {
      const j = j0[aI];
      j0[aI] = j[0] === firstAwayId ? j : [j[1], j[0]];
    }
  }
  let diasUsados = 0;
  outer: for (const j of jornadas) {
    for (let s = 0; s < seriesLen; s++) {
      const date = nextDate();
      if (end && date > end) break outer;
      diasUsados++;
      j.pairs.forEach(([away, home], i) => {
        homeCount.set(home, (homeCount.get(home) ?? 0) + 1);
        gameAt(date, i, away, home);
        if (dh) gameAt(date, i + j.pairs.length, away, home);
      });
    }
  }
  const created = await prisma.game.createMany({ data });
  res.status(201).json({ created: created.count, jornadas: diasUsados, mode: "normal" });
});
r4.delete("/:id/schedule", async (req, res) => {
  const del = await prisma.game.deleteMany({
    where: { leagueId: req.params.id, status: "SCHEDULED", seriesId: null, events: { none: {} } }
  });
  res.json({ deleted: del.count });
});
async function openSeason(leagueId, year) {
  const [season] = await prisma.$transaction([
    prisma.season.create({ data: { leagueId, year } }),
    prisma.season.updateMany({ where: { leagueId, year: { not: year } }, data: { status: "ENDED" } }),
    prisma.league.update({ where: { id: leagueId }, data: { year } })
  ]);
  return season;
}
r4.post("/:id/seasons", async (req, res) => {
  const y = Number(req.body.year);
  if (!y || y < 1900 || y > 2200) return res.status(400).json({ error: "A\xF1o inv\xE1lido" });
  const league = await prisma.league.findUnique({ where: { id: req.params.id } });
  if (!league) return res.status(404).json({ error: "Liga no encontrada" });
  const dupe = await prisma.season.findUnique({ where: { leagueId_year: { leagueId: league.id, year: y } } });
  if (dupe) return res.status(409).json({ error: `Ya existe la temporada ${y} en esta liga` });
  const season = await openSeason(league.id, y);
  res.status(201).json({ season });
});
r4.put("/:id/seasons/:sid", async (req, res) => {
  const s = await prisma.season.findFirst({ where: { id: req.params.sid, leagueId: req.params.id } });
  if (!s) return res.status(404).json({ error: "Temporada no encontrada" });
  const { status } = req.body;
  if (status === "ACTIVE") {
    await prisma.$transaction([
      prisma.season.updateMany({ where: { leagueId: s.leagueId, id: { not: s.id } }, data: { status: "ENDED" } }),
      prisma.season.update({ where: { id: s.id }, data: { status: "ACTIVE" } }),
      prisma.league.update({ where: { id: s.leagueId }, data: { year: s.year } })
    ]);
  } else if (status === "ENDED") {
    await prisma.season.update({ where: { id: s.id }, data: { status: "ENDED" } });
  }
  res.json({ season: await prisma.season.findUnique({ where: { id: s.id } }) });
});
r4.delete("/:id/seasons/:sid", async (req, res) => {
  const s = await prisma.season.findFirst({ where: { id: req.params.sid, leagueId: req.params.id } });
  if (!s) return res.status(404).json({ error: "Temporada no encontrada" });
  const g = await prisma.game.count({ where: { seasonId: s.id } });
  if (g) return res.status(409).json({ error: `La temporada ${s.year} tiene ${g} juegos \u2014 no se puede borrar` });
  await prisma.season.delete({ where: { id: s.id } });
  res.status(204).end();
});
r4.post("/:id/rollover", async (req, res) => {
  const y = Number(req.body.year);
  if (!y || y < 1900 || y > 2200) return res.status(400).json({ error: "A\xF1o inv\xE1lido" });
  const league = await prisma.league.findUnique({ where: { id: req.params.id } });
  if (!league) return res.status(404).json({ error: "Liga no encontrada" });
  const dupe = await prisma.season.findUnique({ where: { leagueId_year: { leagueId: league.id, year: y } } });
  if (dupe) return res.status(409).json({ error: `Ya existe la temporada ${y} en esta liga` });
  const season = await openSeason(league.id, y);
  res.json({ season, league: await prisma.league.findUnique({ where: { id: league.id } }) });
});
async function gameScore(g) {
  const state = reduceGame(await loadEvents(g.id), g.innings);
  if (g.fScoreAway != null && g.fScoreHome != null) return { away: g.fScoreAway, home: g.fScoreHome };
  return state.score;
}
async function seriesDetail(s) {
  const games = await prisma.game.findMany({
    where: { seriesId: s.id },
    orderBy: { date: "asc" },
    include: { events: { orderBy: { seq: "asc" } } }
  });
  let hw = 0, aw = 0;
  const list = [];
  for (const g of games) {
    const score = await gameScore(g);
    if (g.status === "FINAL" && !g.tied) {
      const winner = score.home > score.away ? g.homeTeamId : g.awayTeamId;
      if (winner === s.homeTeamId) hw++;
      else if (winner === s.awayTeamId) aw++;
    }
    list.push({ id: g.id, date: g.date, status: g.status, away: score.away, home: score.home, stadium: g.stadium, awayTeamId: g.awayTeamId, homeTeamId: g.homeTeamId, innings: g.innings });
  }
  const winnerTeamId = hw >= s.winsNeeded ? s.homeTeamId : aw >= s.winsNeeded ? s.awayTeamId : null;
  const status = winnerTeamId ? "DONE" : list.some((g) => g.status === "LIVE") ? "LIVE" : list.length ? "LIVE" : "PENDING";
  return { games: list, wins: { home: hw, away: aw }, winnerTeamId, status };
}
r4.get("/:id/series", async (req, res) => {
  const seasonFilter = req.query.season ? { seasonId: String(req.query.season) } : {};
  const rows = await prisma.series.findMany({ where: { leagueId: req.params.id, ...seasonFilter }, orderBy: [{ round: "asc" }, { createdAt: "asc" }] });
  const teamIds = [...new Set(rows.flatMap((s) => [s.homeTeamId, s.awayTeamId]))];
  const teams = await prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true, shortName: true } });
  const tmap = new Map(teams.map((t) => [t.id, t]));
  const out = [];
  for (const s of rows) {
    const d = await seriesDetail(s);
    if (d.winnerTeamId && (!s.winnerTeamId || s.status !== "DONE")) {
      await prisma.series.update({ where: { id: s.id }, data: { winnerTeamId: d.winnerTeamId, status: "DONE" } });
    }
    out.push({
      ...s,
      ...d,
      homeTeam: tmap.get(s.homeTeamId) ?? { id: s.homeTeamId, name: "?", shortName: null },
      awayTeam: tmap.get(s.awayTeamId) ?? { id: s.awayTeamId, name: "?", shortName: null },
      winner: d.winnerTeamId ? tmap.get(d.winnerTeamId) ?? null : null
    });
  }
  res.json(out);
});
r4.post("/:id/series", async (req, res) => {
  const { round, name, homeTeamId, awayTeamId, winsNeeded, seasonId } = req.body;
  if (!homeTeamId || !awayTeamId || homeTeamId === awayTeamId)
    return res.status(400).json({ error: "homeTeamId y awayTeamId distintos requeridos" });
  const season = seasonId ?? (await prisma.season.findFirst({ where: { leagueId: req.params.id, status: "ACTIVE" } }))?.id ?? null;
  const s = await prisma.series.create({
    data: {
      leagueId: req.params.id,
      seasonId: season,
      round: Number(round) || 1,
      name: name || `Serie`,
      homeTeamId,
      awayTeamId,
      winsNeeded: Math.max(1, Number(winsNeeded) || 3)
    }
  });
  res.status(201).json(s);
});
r4.put("/:id/series/:sid", async (req, res) => {
  const { name, winsNeeded, winnerTeamId, status } = req.body;
  const s = await prisma.series.update({
    where: { id: req.params.sid },
    data: {
      name,
      winsNeeded: winsNeeded != null ? Math.max(1, Number(winsNeeded)) : void 0,
      winnerTeamId: winnerTeamId === null ? null : winnerTeamId,
      status
    }
  });
  res.json(s);
});
r4.delete("/:id/series/:sid", async (req, res) => {
  const linked = await prisma.game.findMany({ where: { seriesId: req.params.sid }, select: { id: true } });
  for (const g of linked) await assignGameSeries(g.id, null);
  await prisma.series.deleteMany({ where: { id: req.params.sid } });
  res.status(204).end();
});
r4.put("/:id/byes", async (req, res) => {
  const { round, teamIds } = req.body;
  const league = await prisma.league.findUnique({ where: { id: req.params.id } });
  if (!league) return res.status(404).json({ error: "Liga no encontrada" });
  const byes = league.byes ?? {};
  if (Array.isArray(teamIds) && teamIds.length) byes[String(round)] = teamIds;
  else delete byes[String(round)];
  const saved = await prisma.league.update({ where: { id: league.id }, data: { byes } });
  res.json(saved.byes ?? {});
});
var seasonGameWhere = (f) => f?.seasonId ? { seasonId: f.seasonId } : f?.year ? { date: { gte: new Date(f.year, 0, 1), lt: new Date(f.year + 1, 0, 1) } } : {};
async function leagueStandings(leagueId, filter = {}) {
  const leagueTb = (await prisma.league.findUnique({ where: { id: leagueId }, select: { tb: true } }))?.tb;
  const tb = leagueTb ?? "pct";
  const games = await prisma.game.findMany({
    where: {
      leagueId,
      status: "FINAL",
      seriesId: null,
      // posiciones = solo temporada regular
      ...seasonGameWhere(filter)
    },
    orderBy: { date: "asc" },
    include: { events: { orderBy: { seq: "asc" } } }
  });
  const teams = await prisma.team.findMany({ where: { leagueId } });
  const table = /* @__PURE__ */ new Map();
  for (const t of teams) table.set(t.id, { teamId: t.id, name: t.name, division: t.division ?? null, w: 0, l: 0, t: 0, rf: 0, ra: 0 });
  const hist = /* @__PURE__ */ new Map();
  const h2h = /* @__PURE__ */ new Map();
  const recH2h = (me, opp, r10) => {
    hist.set(me, [...hist.get(me) ?? [], r10]);
    const m = h2h.get(me) ?? /* @__PURE__ */ new Map();
    const v = m.get(opp) ?? { w: 0, l: 0, t: 0 };
    if (r10 === "W") v.w++;
    else if (r10 === "L") v.l++;
    else v.t++;
    m.set(opp, v);
    h2h.set(me, m);
  };
  for (const g of games) {
    let score;
    if ((!g.events.length || g.forfeitBy) && g.fScoreAway != null && g.fScoreHome != null) {
      score = { away: g.fScoreAway, home: g.fScoreHome };
    } else {
      score = reduceGame(g.events.map((e) => ({
        seq: e.seq,
        inning: e.inning,
        half: e.half,
        batterId: e.batterId,
        pitcherId: e.pitcherId,
        result: e.result,
        notation: e.notation,
        errorOn: e.errorOn ? JSON.parse(e.errorOn) : void 0,
        advances: e.advances
      })), g.innings).score;
    }
    const a = table.get(g.awayTeamId), h = table.get(g.homeTeamId);
    if (a) {
      a.rf += score.away;
      a.ra += score.home;
    }
    if (h) {
      h.rf += score.home;
      h.ra += score.away;
    }
    if (score.away === score.home || g.tied) {
      if (a) a.t++;
      if (h) h.t++;
      recH2h(g.awayTeamId, g.homeTeamId, "T");
      recH2h(g.homeTeamId, g.awayTeamId, "T");
    } else if (score.away > score.home) {
      if (a) a.w++;
      if (h) h.l++;
      recH2h(g.awayTeamId, g.homeTeamId, "W");
      recH2h(g.homeTeamId, g.awayTeamId, "L");
    } else {
      if (h) h.w++;
      if (a) a.l++;
      recH2h(g.homeTeamId, g.awayTeamId, "W");
      recH2h(g.awayTeamId, g.homeTeamId, "L");
    }
  }
  const rows = [...table.values()].map((t) => {
    const h = hist.get(t.teamId) ?? [];
    let streak = null;
    if (h.length) {
      const last = h[h.length - 1];
      let n = 0;
      for (let i = h.length - 1; i >= 0 && h[i] === last; i--) n++;
      streak = `${last === "W" ? "G" : last === "L" ? "P" : "E"}${n}`;
    }
    const l10 = h.slice(-10).reduce((s, r10) => ({ w: s.w + (r10 === "W" ? 1 : 0), l: s.l + (r10 === "L" ? 1 : 0), t: s.t + (r10 === "T" ? 1 : 0) }), { w: 0, l: 0, t: 0 });
    return {
      ...t,
      pct: t.w + t.l ? t.w / (t.w + t.l) : 0,
      diff: t.rf - t.ra,
      gb: 0,
      streak,
      last10: l10,
      form: h.slice(-5),
      vs: Object.fromEntries(h2h.get(t.teamId) ?? [])
    };
  }).sort((x, y) => {
    const h2hCmp = () => {
      const a = x.vs?.[y.teamId];
      const av = (a?.w ?? 0) - (a?.l ?? 0);
      return -av;
    };
    if (tb === "h2h") return y.pct - x.pct || h2hCmp() || y.diff - x.diff;
    if (tb === "diff") return y.pct - x.pct || y.diff - x.diff || y.w - x.w;
    return y.pct - x.pct || y.w - x.w || y.diff - x.diff;
  });
  const lead = rows[0];
  for (const t of rows) t.gb = lead ? (lead.w - t.w + (t.l - lead.l)) / 2 : 0;
  return rows;
}
r4.get("/:id/standings", async (req, res) => {
  const year = Number(req.query.year) || void 0;
  const seasonId = req.query.season ? String(req.query.season) : void 0;
  res.json(await leagueStandings(req.params.id, { year, seasonId }));
});
var GAME_STATS_INCLUDE = {
  lineups: true,
  homeTeam: { select: { id: true, name: true, shortName: true } },
  awayTeam: { select: { id: true, name: true, shortName: true } }
};
async function aggregateGames(games, leagueTeams, adjRows) {
  const playerIds = /* @__PURE__ */ new Set();
  for (const g of games) for (const l of g.lineups) playerIds.add(l.playerId);
  const bat = /* @__PURE__ */ new Map();
  const pit = /* @__PURE__ */ new Map();
  const fld = /* @__PURE__ */ new Map();
  const situ = /* @__PURE__ */ new Map();
  const played = /* @__PURE__ */ new Map();
  const results = [];
  const boxes = /* @__PURE__ */ new Map();
  const playerLog = /* @__PURE__ */ new Map();
  const teamTotals = /* @__PURE__ */ new Map();
  for (const t of leagueTeams) teamTotals.set(t.id, {
    teamId: t.id,
    name: t.shortName ?? t.name,
    g: 0,
    ab: 0,
    r: 0,
    h: 0,
    doubles: 0,
    triples: 0,
    hr: 0,
    rbi: 0,
    bb: 0,
    k: 0,
    sb: 0,
    e: 0,
    lob: 0,
    pOuts: 0,
    pH: 0,
    pR: 0,
    pER: 0,
    pBB: 0,
    pK: 0
  });
  const dec = { w: /* @__PURE__ */ new Map(), l: /* @__PURE__ */ new Map(), sv: /* @__PURE__ */ new Map(), hld: /* @__PURE__ */ new Map(), bs: /* @__PURE__ */ new Map(), cg: /* @__PURE__ */ new Map(), sho: /* @__PURE__ */ new Map() };
  const bump = (m, id) => m.set(id, (m.get(id) ?? 0) + 1);
  const teamGameLines = [];
  const matchups = /* @__PURE__ */ new Map();
  const matchupOf = (bid, pid) => {
    if (!matchups.has(bid)) matchups.set(bid, /* @__PURE__ */ new Map());
    const m = matchups.get(bid);
    if (!m.has(pid)) m.set(pid, { pa: 0, ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, k: 0 });
    return m.get(pid);
  };
  const NO_RBI_RES = /* @__PURE__ */ new Set(["E", "DP", "TP", "KWP", "KPB"]);
  const batOf = (pid) => {
    if (!bat.has(pid)) bat.set(pid, { playerId: pid, g: 0, pa: 0, ab: 0, r: 0, h: 0, doubles: 0, triples: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sac: 0, sf: 0, sb: 0 });
    return bat.get(pid);
  };
  const pitOf = (pid) => {
    if (!pit.has(pid)) pit.set(pid, { playerId: pid, gp: 0, gs: 0, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0, pitches: 0, bf: 0, abAg: 0 });
    return pit.get(pid);
  };
  const fldOf = (pid) => {
    if (!fld.has(pid)) fld.set(pid, { playerId: pid, po: 0, a: 0, e: 0 });
    return fld.get(pid);
  };
  const situOf = (pid) => {
    if (!situ.has(pid)) situ.set(pid, { playerId: pid, risp: { ab: 0, h: 0 }, loaded: { ab: 0, h: 0 }, twoOut: { ab: 0, h: 0 }, leadoff: { ab: 0, h: 0 } });
    return situ.get(pid);
  };
  for (const g of games) {
    const events = await loadEvents(g.id);
    const box = computeBoxscore(events, g.innings);
    for (const l of g.lineups) bump(played, l.playerId);
    for (const l of g.lineups) if (l.role === "STARTER" && l.position === "P") pitOf(l.playerId).gs += 1;
    if (g.wpId) bump(dec.w, g.wpId);
    if (g.lpId) bump(dec.l, g.lpId);
    if (g.svId) bump(dec.sv, g.svId);
    for (const pid of g.hldIds ? JSON.parse(g.hldIds) : []) bump(dec.hld, pid);
    for (const pid of g.bsIds ? JSON.parse(g.bsIds) : []) bump(dec.bs, pid);
    const official = g.fScoreAway != null && g.fScoreHome != null ? { away: g.fScoreAway, home: g.fScoreHome } : void 0;
    const { cg, sho } = computeCgSho(events, g.innings, official);
    for (const pid of cg) bump(dec.cg, pid);
    for (const pid of sho) bump(dec.sho, pid);
    const score = g.fScoreAway != null && g.fScoreHome != null ? { away: g.fScoreAway, home: g.fScoreHome } : { away: box.linescore.away.reduce((s, n) => s + n, 0), home: box.linescore.home.reduce((s, n) => s + n, 0) };
    const ttAway = teamTotals.get(g.awayTeamId), ttHome = teamTotals.get(g.homeTeamId);
    const pitSide = /* @__PURE__ */ new Map();
    const pitSideRec = {};
    for (const e of events) if (e.pitcherId) {
      const side = e.half === "TOP" ? "home" : "away";
      pitSide.set(e.pitcherId, side);
      pitSideRec[e.pitcherId] = side;
    }
    const gDec = { w: [], l: [], sv: [], hld: [], bs: [], cg: [...cg], sho: [...sho] };
    const addDec = (arr, pid) => {
      if (!arr.includes(pid)) arr.push(pid);
    };
    if (g.wpId) addDec(gDec.w, g.wpId);
    if (g.lpId) addDec(gDec.l, g.lpId);
    if (g.svId) addDec(gDec.sv, g.svId);
    for (const pid of g.hldIds ? JSON.parse(g.hldIds) : []) addDec(gDec.hld, pid);
    for (const pid of g.bsIds ? JSON.parse(g.bsIds) : []) addDec(gDec.bs, pid);
    const addTeamBat = (tt, side) => {
      if (!tt) return;
      tt.g += 1;
      tt.r += score[side];
      tt.lob += box.lob[side];
      for (const l of Object.values(box[side])) {
        tt.ab += l.ab;
        tt.h += l.h;
        tt.doubles += l.doubles;
        tt.triples += l.triples;
        tt.hr += l.hr;
        tt.rbi += l.rbi;
        tt.bb += l.bb;
        tt.k += l.k;
        tt.sb += l.sb;
      }
    };
    addTeamBat(ttAway, "away");
    addTeamBat(ttHome, "home");
    results.push({
      id: g.id,
      date: g.date,
      innings: g.innings,
      awayId: g.awayTeamId,
      homeId: g.homeTeamId,
      away: g.awayTeam.name,
      home: g.homeTeam.name,
      awayShort: g.awayTeam.shortName ?? g.awayTeam.name,
      homeShort: g.homeTeam.shortName ?? g.homeTeam.name,
      aR: score.away,
      hR: score.home,
      tied: !!g.tied,
      forfeit: !!g.forfeitBy,
      stadium: g.stadium,
      pitSide: pitSideRec,
      dec: gDec
    });
    boxes.set(g.id, box);
    const logOf = (pid) => {
      if (!playerLog.has(pid)) playerLog.set(pid, []);
      return playerLog.get(pid);
    };
    const logEntry = (pid, side) => {
      const opp = side === "away" ? g.homeTeam.shortName ?? g.homeTeam.name : g.awayTeam.shortName ?? g.awayTeam.name;
      let row = logOf(pid).find((e) => e.gameId === g.id);
      if (!row) {
        row = { gameId: g.id, date: g.date, opp, bat: null, pit: null };
        logOf(pid).push(row);
      }
      return row;
    };
    for (const line of Object.values(box.away)) logEntry(line.playerId, "away").bat = line;
    for (const line of Object.values(box.home)) logEntry(line.playerId, "home").bat = line;
    for (const line of Object.values(box.pitchers)) {
      const side = pitSide.get(line.playerId);
      if (side) logEntry(line.playerId, side).pit = line;
    }
    const statLines = g.statLines ?? [];
    const sideOf = (tid) => tid === g.awayTeamId ? "away" : "home";
    if (statLines.length) {
      const inGame = new Set(g.lineups.map((l) => l.playerId));
      const outsBySide = { away: 0, home: 0 };
      for (const ln of statLines) outsBySide[sideOf(ln.teamId)] += ln.pOuts ?? 0;
      const pseudo = {
        away: {},
        home: {},
        pitchers: {},
        linescore: { away: [], home: [] },
        lob: { away: 0, home: 0 }
      };
      for (const ln of statLines) {
        const pid = ln.playerId, side = sideOf(ln.teamId);
        const tt = side === "away" ? ttAway : ttHome;
        if (!inGame.has(pid)) bump(played, pid);
        const b = batOf(pid);
        b.pa += ln.pa ?? 0;
        b.ab += ln.ab ?? 0;
        b.r += ln.r ?? 0;
        b.h += ln.h ?? 0;
        b.doubles += ln.doubles ?? 0;
        b.triples += ln.triples ?? 0;
        b.hr += ln.hr ?? 0;
        b.rbi += ln.rbi ?? 0;
        b.bb += ln.bb ?? 0;
        b.k += ln.k ?? 0;
        b.hbp += ln.hbp ?? 0;
        b.sac += ln.sac ?? 0;
        b.sf += ln.sf ?? 0;
        b.sb += ln.sb ?? 0;
        if (tt) {
          tt.ab += ln.ab ?? 0;
          tt.h += ln.h ?? 0;
          tt.doubles += ln.doubles ?? 0;
          tt.triples += ln.triples ?? 0;
          tt.hr += ln.hr ?? 0;
          tt.rbi += ln.rbi ?? 0;
          tt.bb += ln.bb ?? 0;
          tt.k += ln.k ?? 0;
          tt.sb += ln.sb ?? 0;
        }
        const batLine = {
          playerId: pid,
          pa: ln.pa ?? 0,
          ab: ln.ab ?? 0,
          r: ln.r ?? 0,
          h: ln.h ?? 0,
          rbi: ln.rbi ?? 0,
          bb: ln.bb ?? 0,
          k: ln.k ?? 0,
          hbp: ln.hbp ?? 0,
          doubles: ln.doubles ?? 0,
          triples: ln.triples ?? 0,
          hr: ln.hr ?? 0,
          sac: ln.sac ?? 0,
          sf: ln.sf ?? 0,
          sb: ln.sb ?? 0
        };
        const prevBat = pseudo[side][pid];
        if (prevBat) {
          prevBat.pa += batLine.pa;
          prevBat.ab += batLine.ab;
          prevBat.r += batLine.r;
          prevBat.h += batLine.h;
          prevBat.rbi += batLine.rbi;
          prevBat.bb += batLine.bb;
          prevBat.k += batLine.k;
          prevBat.hbp += batLine.hbp;
          prevBat.doubles += batLine.doubles;
          prevBat.triples += batLine.triples;
          prevBat.hr += batLine.hr;
          prevBat.sac += batLine.sac;
          prevBat.sf += batLine.sf;
          prevBat.sb += batLine.sb;
        } else pseudo[side][pid] = batLine;
        logEntry(pid, side).bat = pseudo[side][pid];
        if ((ln.gp ?? 0) || (ln.pOuts ?? 0)) {
          pitSide.set(pid, side);
          pitSideRec[pid] = side;
          const p = pitOf(pid);
          p.gp += 1;
          p.gs += ln.gs ?? 0;
          p.outs += ln.pOuts ?? 0;
          p.h += ln.pH ?? 0;
          p.r += ln.pR ?? 0;
          p.er += ln.pER ?? 0;
          p.bb += ln.pBB ?? 0;
          p.k += ln.pK ?? 0;
          p.hr += ln.pHR ?? 0;
          p.pitches += ln.pPitches ?? 0;
          p.bf += ln.bf ?? 0;
          p.abAg += (ln.pOuts ?? 0) + (ln.pH ?? 0);
          if (tt) {
            tt.pOuts += ln.pOuts ?? 0;
            tt.pH += ln.pH ?? 0;
            tt.pR += ln.pR ?? 0;
            tt.pER += ln.pER ?? 0;
            tt.pBB += ln.pBB ?? 0;
            tt.pK += ln.pK ?? 0;
          }
          if ((ln.pOuts ?? 0) > 0 && ln.pOuts === outsBySide[side]) {
            bump(dec.cg, pid);
            addDec(gDec.cg, pid);
            if ((side === "away" ? score.home : score.away) === 0) {
              bump(dec.sho, pid);
              addDec(gDec.sho, pid);
            }
          }
          const pitLine = {
            playerId: pid,
            outs: ln.pOuts ?? 0,
            h: ln.pH ?? 0,
            r: ln.pR ?? 0,
            er: ln.pER ?? 0,
            bb: ln.pBB ?? 0,
            k: ln.pK ?? 0,
            hr: ln.pHR ?? 0,
            pitches: ln.pPitches ?? 0
          };
          const prevPit = pseudo.pitchers[pid];
          if (prevPit) {
            prevPit.outs += pitLine.outs;
            prevPit.h += pitLine.h;
            prevPit.r += pitLine.r;
            prevPit.er += pitLine.er;
            prevPit.bb += pitLine.bb;
            prevPit.k += pitLine.k;
            prevPit.hr += pitLine.hr;
            prevPit.pitches += pitLine.pitches;
          } else pseudo.pitchers[pid] = pitLine;
          logEntry(pid, side).pit = pseudo.pitchers[pid];
        }
        if (ln.w && !g.wpId) {
          bump(dec.w, pid);
          addDec(gDec.w, pid);
        }
        if (ln.l && !g.lpId) {
          bump(dec.l, pid);
          addDec(gDec.l, pid);
        }
        if (ln.sv && !g.svId) {
          bump(dec.sv, pid);
          addDec(gDec.sv, pid);
        }
        if (ln.hld) {
          bump(dec.hld, pid);
          addDec(gDec.hld, pid);
        }
        if (ln.bs) {
          bump(dec.bs, pid);
          addDec(gDec.bs, pid);
        }
        const f = fldOf(pid);
        f.po += ln.po ?? 0;
        f.a += ln.a ?? 0;
        f.e += ln.e ?? 0;
        if (tt) tt.e += ln.e ?? 0;
      }
      boxes.set(g.id, pseudo);
    }
    for (const line of Object.values(box.pitchers)) {
      const tt = pitSide.get(line.playerId) === "away" ? ttAway : ttHome;
      if (!tt) continue;
      tt.pOuts += line.outs;
      tt.pH += line.h;
      tt.pR += line.r;
      tt.pER += line.er;
      tt.pBB += line.bb;
      tt.pK += line.k;
    }
    for (const line of [...Object.values(box.away), ...Object.values(box.home)]) {
      const b = batOf(line.playerId);
      b.pa += line.pa;
      b.ab += line.ab;
      b.r += line.r;
      b.h += line.h;
      b.doubles += line.doubles;
      b.triples += line.triples;
      b.hr += line.hr;
      b.rbi += line.rbi;
      b.bb += line.bb;
      b.k += line.k;
      b.hbp += line.hbp;
      b.sac += line.sac;
      b.sf += line.sf;
      b.sb += line.sb;
    }
    for (const line of Object.values(box.pitchers)) {
      const p = pitOf(line.playerId);
      p.gp += 1;
      p.outs += line.outs;
      p.h += line.h;
      p.r += line.r;
      p.er += line.er;
      p.bb += line.bb;
      p.k += line.k;
      p.hr += line.hr;
      p.pitches += line.pitches;
    }
    let st = initialState();
    let firstPaOfHalf = true;
    const eCnt = { away: 0, home: 0 };
    for (const ev of events) {
      for (const pid of ev.errorOn ?? []) {
        fldOf(pid).e += 1;
        eCnt[ev.half === "TOP" ? "home" : "away"] += 1;
      }
      const poArr = ev.putouts ?? [];
      const aArr = ev.assists ?? [];
      for (const pid of poArr) fldOf(pid).po += 1;
      for (const pid of aArr) fldOf(pid).a += 1;
      if (!isMidResult(ev.result) && ev.pitcherId) {
        const pp = pitOf(ev.pitcherId);
        pp.bf += 1;
        if (!NON_AB.includes(ev.result)) pp.abAg += 1;
      }
      if (!isMidResult(ev.result) && ev.batterId && ev.pitcherId) {
        const mm = matchupOf(ev.batterId, ev.pitcherId);
        mm.pa += 1;
        if (!NON_AB.includes(ev.result)) mm.ab += 1;
        if (HITS.includes(ev.result)) {
          mm.h += 1;
          if (ev.result === "HR" || ev.result === "HRIP") mm.hr += 1;
        }
        if (ev.result === "BB" || ev.result === "IBB") mm.bb += 1;
        if (ev.result === "K" || ev.result === "KWP" || ev.result === "KPB") mm.k += 1;
        if (!NO_RBI_RES.has(ev.result)) mm.rbi += ev.advances.filter((a) => a.to === "HOME").length;
      }
      if (!isMidResult(ev.result) && ev.batterId) {
        const s = situOf(ev.batterId);
        const isHit = ["1B", "2B", "3B", "HR", "RHB", "1BE", "2BE", "3BE", "HRIP"].includes(ev.result);
        if (st.bases[2] || st.bases[3]) {
          s.risp.ab += 1;
          if (isHit) s.risp.h += 1;
        }
        if (st.bases[1] && st.bases[2] && st.bases[3]) {
          s.loaded.ab += 1;
          if (isHit) s.loaded.h += 1;
        }
        if (st.outs === 2) {
          s.twoOut.ab += 1;
          if (isHit) s.twoOut.h += 1;
        }
        if (firstPaOfHalf) {
          s.leadoff.ab += 1;
          if (isHit) s.leadoff.h += 1;
        }
        firstPaOfHalf = false;
      }
      const prevHalf = st.half;
      st = applyEvent(st, ev, g.innings);
      if (st.half !== prevHalf) firstPaOfHalf = true;
    }
    const pushTgl = (side, teamId, opp) => {
      const ls = statLines.filter((ln) => sideOf(ln.teamId) === side);
      const bl = ls.length ? ls : Object.values(box[side]);
      const pl = ls.length ? ls.filter((l) => (l.gp ?? 0) || (l.pOuts ?? 0)).map((l) => ({ outs: l.pOuts ?? 0, h: l.pH ?? 0, r: l.pR ?? 0, bb: l.pBB ?? 0, k: l.pK ?? 0 })) : Object.values(box.pitchers).filter((l) => pitSide.get(l.playerId) === side);
      const rf = score[side], ra = side === "away" ? score.home : score.away;
      teamGameLines.push({
        gameId: g.id,
        date: g.date,
        teamId,
        opp,
        res: g.tied || rf === ra ? "T" : rf > ra ? "W" : "L",
        rf,
        ra,
        inn: g.innings,
        ab: bl.reduce((s, l) => s + (l.ab ?? 0), 0),
        h: bl.reduce((s, l) => s + (l.h ?? 0), 0),
        rbi: bl.reduce((s, l) => s + (l.rbi ?? 0), 0),
        bb: bl.reduce((s, l) => s + (l.bb ?? 0), 0),
        k: bl.reduce((s, l) => s + (l.k ?? 0), 0),
        sb: bl.reduce((s, l) => s + (l.sb ?? 0), 0),
        lob: box.lob[side],
        e: ls.length ? ls.reduce((s, l) => s + (l.e ?? 0), 0) : eCnt[side],
        pOuts: pl.reduce((s, l) => s + l.outs, 0),
        pH: pl.reduce((s, l) => s + l.h, 0),
        pR: pl.reduce((s, l) => s + l.r, 0),
        pBB: pl.reduce((s, l) => s + l.bb, 0),
        pK: pl.reduce((s, l) => s + l.k, 0)
      });
    };
    pushTgl("away", g.awayTeamId, g.homeTeam.shortName ?? g.homeTeam.name);
    pushTgl("home", g.homeTeamId, g.awayTeam.shortName ?? g.awayTeam.name);
  }
  for (const row of adjRows ?? []) {
    const a = row.adj ?? null;
    if (!a) continue;
    const pid = row.playerId;
    const b = batOf(pid);
    b.pa += a.pa ?? 0;
    b.ab += a.ab ?? 0;
    b.r += a.r ?? 0;
    b.h += a.h ?? 0;
    b.doubles += a.doubles ?? 0;
    b.triples += a.triples ?? 0;
    b.hr += a.hr ?? 0;
    b.rbi += a.rbi ?? 0;
    b.bb += a.bb ?? 0;
    b.k += a.k ?? 0;
    b.hbp += a.hbp ?? 0;
    b.sac += a.sac ?? 0;
    b.sf += a.sf ?? 0;
    b.sb += a.sb ?? 0;
    if (a.g) played.set(pid, (played.get(pid) ?? 0) + a.g);
    const p = pitOf(pid);
    p.gp += a.gp ?? 0;
    p.gs += a.gs ?? 0;
    p.outs += a.pOuts ?? 0;
    p.h += a.pH ?? 0;
    p.r += a.pR ?? 0;
    p.er += a.pER ?? 0;
    p.bb += a.pBB ?? 0;
    p.k += a.pK ?? 0;
    p.hr += a.pHR ?? 0;
    p.pitches += a.pPitches ?? 0;
    for (const [k, m] of [["w", dec.w], ["l", dec.l], ["sv", dec.sv], ["hld", dec.hld], ["bs", dec.bs], ["cg", dec.cg], ["sho", dec.sho]]) {
      if (a[k]) m.set(pid, (m.get(pid) ?? 0) + a[k]);
    }
    if (a.e) fldOf(pid).e += a.e;
  }
  const players = await prisma.player.findMany({
    where: { id: { in: [...playerIds, ...bat.keys(), ...pit.keys(), ...fld.keys()] } },
    include: { team: true }
  });
  const meta = new Map(players.map((p) => [p.id, {
    name: `${p.number ? `#${p.number} ` : ""}${p.firstName} ${p.lastName}`,
    teamId: p.teamId,
    teamName: p.team.name,
    shortName: p.team.shortName ?? p.team.name,
    number: p.number,
    bats: p.bats,
    throws: p.throws,
    positions: p.positions,
    photo: p.photo
  }]));
  const metaOf = (pid) => meta.get(pid) ?? {
    name: "?",
    teamId: "",
    teamName: "?",
    shortName: "?",
    number: null,
    bats: null,
    throws: null,
    positions: null,
    photo: null
  };
  const f33 = (n) => Number(n.toFixed(3));
  const f22 = (n) => Number(n.toFixed(2));
  const batting = [...bat.values()].map((b) => {
    const tb = b.h + b.doubles + 2 * b.triples + 3 * b.hr;
    const obpDen = b.ab + b.bb + b.hbp + b.sf;
    const slg = b.ab ? tb / b.ab : 0;
    const obp = obpDen ? (b.h + b.bb + b.hbp) / obpDen : 0;
    const s = situ.get(b.playerId);
    return {
      ...b,
      g: played.get(b.playerId) ?? 0,
      ...metaOf(b.playerId),
      avg: f33(b.ab ? b.h / b.ab : 0),
      obp: f33(obp),
      slg: f33(slg),
      ops: f33(obp + slg),
      iso: f33(slg - (b.ab ? b.h / b.ab : 0)),
      babip: f33(b.ab - b.k - b.hr + b.sf > 0 ? (b.h - b.hr) / (b.ab - b.k - b.hr + b.sf) : 0),
      situ: s ?? { risp: { ab: 0, h: 0 }, loaded: { ab: 0, h: 0 }, twoOut: { ab: 0, h: 0 }, leadoff: { ab: 0, h: 0 } }
    };
  }).sort((x, y) => y.ops - x.ops);
  const regInnings = games[0]?.innings ?? 9;
  const pitching = [...pit.values()].map((p) => {
    const ip = p.outs / 3;
    return {
      ...p,
      ip: f22(ip),
      ...metaOf(p.playerId),
      w: dec.w.get(p.playerId) ?? 0,
      l: dec.l.get(p.playerId) ?? 0,
      sv: dec.sv.get(p.playerId) ?? 0,
      hld: dec.hld.get(p.playerId) ?? 0,
      bs: dec.bs.get(p.playerId) ?? 0,
      cg: dec.cg.get(p.playerId) ?? 0,
      sho: dec.sho.get(p.playerId) ?? 0,
      era: f22(ip ? p.er * regInnings / ip : 0),
      whip: f22(ip ? (p.bb + p.h) / ip : 0),
      k9: f22(ip ? p.k * regInnings / ip : 0),
      bb9: f22(ip ? p.bb * regInnings / ip : 0),
      kbb: f22(p.bb ? p.k / p.bb : p.k),
      pIp: f22(ip ? p.pitches / ip : 0),
      avgAgainst: f33(p.abAg ? p.h / p.abAg : 0)
    };
  }).sort((x, y) => x.era - y.era);
  const W = { bb: 0.69, hbp: 0.72, s1: 0.88, d2: 1.25, t3: 1.58, hr: 2.08 };
  const lgBat = batting.reduce((s, b) => ({
    pa: s.pa + b.pa,
    ab: s.ab + b.ab,
    h: s.h + b.h,
    bb: s.bb + b.bb,
    hbp: s.hbp + b.hbp,
    sf: s.sf + b.sf,
    doubles: s.doubles + b.doubles,
    triples: s.triples + b.triples,
    hr: s.hr + b.hr
  }), { pa: 0, ab: 0, h: 0, bb: 0, hbp: 0, sf: 0, doubles: 0, triples: 0, hr: 0 });
  const wobaNum = (x) => W.bb * x.bb + W.hbp * x.hbp + W.s1 * (x.h - x.doubles - x.triples - x.hr) + W.d2 * x.doubles + W.t3 * x.triples + W.hr * x.hr;
  const wobaDen = (x) => x.ab + x.bb + x.hbp + x.sf;
  const lgWoba = wobaDen(lgBat) ? wobaNum(lgBat) / wobaDen(lgBat) : 0;
  const lgObp = wobaDen(lgBat) ? (lgBat.h + lgBat.bb + lgBat.hbp) / wobaDen(lgBat) : 0;
  const wobaScale = lgWoba > 0 && lgObp > 0 ? lgObp / lgWoba : 1.15;
  const totalRuns = teamTotals.size ? [...teamTotals.values()].reduce((s, t) => s + t.r, 0) : 0;
  const rpw = Math.max(4, totalRuns / Math.max(1, games.length));
  const lgPit = pitching.reduce(
    (s, p) => ({ outs: s.outs + p.outs, er: s.er + p.er, hr: s.hr + p.hr, bb: s.bb + p.bb, k: s.k + p.k }),
    { outs: 0, er: 0, hr: 0, bb: 0, k: 0 }
  );
  const lgIp = lgPit.outs / 3;
  const lgEra = lgIp ? lgPit.er * regInnings / lgIp : 0;
  const lgFip = lgIp ? (13 * lgPit.hr + 3 * lgPit.bb - 2 * lgPit.k) / lgIp : 0;
  const cFip = lgEra - lgFip;
  const battingSab = batting.map((b) => {
    const woba = wobaDen(b) ? wobaNum(b) / wobaDen(b) : 0;
    const wraa = wobaScale ? (woba - lgWoba) / wobaScale * b.pa : 0;
    const repRuns = b.pa * (20 / 600);
    return { playerId: b.playerId, woba: f33(woba), wraa: f22(wraa), war: f22((wraa + repRuns) / rpw) };
  });
  const warBat = new Map(battingSab.map((x) => [x.playerId, x]));
  const battingOut = batting.map((b) => ({ ...b, ...warBat.get(b.playerId) ?? { woba: 0, wraa: 0, war: 0 } }));
  const pitchingOut = pitching.map((p) => {
    const ip = p.outs / 3;
    const fip = ip ? (13 * p.hr + 3 * p.bb - 2 * p.k) / ip + cFip : 0;
    const war = ip ? ((lgEra - fip) / rpw + 0.08) * (ip / regInnings) : 0;
    return { ...p, fip: f22(fip), war: f22(war) };
  });
  const fielding = [...fld.values()].map((f) => ({
    ...f,
    ...metaOf(f.playerId),
    tc: f.po + f.a + f.e,
    fpct: f33(f.po + f.a + f.e > 0 ? (f.po + f.a) / (f.po + f.a + f.e) : 1)
  })).sort((x, y) => y.tc - x.tc);
  for (const f of fielding) {
    const tt = teamTotals.get(f.teamId);
    if (tt) tt.e += f.e;
  }
  return {
    batting: battingOut,
    pitching: pitchingOut,
    fielding,
    teamTotals: [...teamTotals.values()],
    games: games.length,
    results,
    boxes,
    playerLog,
    meta,
    teamGameLines,
    matchups
  };
}
async function leagueStats(leagueId, phase = "reg", filter = {}, round) {
  const games = await prisma.game.findMany({
    where: {
      leagueId,
      status: "FINAL",
      // regular excluye playoffs; post solo series (con round = solo una
      // fase: eliminación/semifinal/final, estilo MLB por ronda); all todo
      ...phase === "reg" ? { seriesId: null } : phase === "post" ? { seriesId: { not: null }, ...round ? { series: { is: { round } } } : {} } : {},
      ...seasonGameWhere(filter)
      // temporada: Season explícita o año de fecha
    },
    orderBy: { date: "asc" },
    include: GAME_STATS_INCLUDE
  });
  const leagueTeams = await prisma.team.findMany({ where: { leagueId } });
  const scopes = phase === "post" ? ["POST"] : phase === "reg" ? ["REG"] : ["REG", "POST"];
  let years;
  if (filter.seasonId) {
    const s = await prisma.season.findUnique({ where: { id: filter.seasonId }, select: { year: true } });
    years = s ? [s.year] : [];
  } else if (filter.year) years = [filter.year];
  const adjRows = await prisma.playerSeasonStat.findMany({
    where: {
      scope: { in: scopes },
      ...years ? { season: { in: years } } : {},
      player: { teamId: { in: leagueTeams.map((t) => t.id) } },
      adj: { not: Prisma2.DbNull }
    },
    select: { playerId: true, adj: true }
  });
  return aggregateGames(games, leagueTeams, adjRows);
}
r4.get("/:id/stats", async (req, res) => {
  const phase = req.query.phase === "post" ? "post" : req.query.phase === "all" ? "all" : "reg";
  const year = Number(req.query.year) || void 0;
  const seasonId = req.query.season ? String(req.query.season) : void 0;
  const round = Number(req.query.round) || void 0;
  res.json(await leagueStats(req.params.id, phase, { year, seasonId }, round));
});
r4.get("/:id/splits", async (req, res) => {
  const splitSeason = req.query.season ? String(req.query.season) : void 0;
  const games = await prisma.game.findMany({
    where: {
      leagueId: req.params.id,
      status: "FINAL",
      seriesId: null,
      // splits = temporada regular
      ...splitSeason ? { seasonId: splitSeason } : {}
    },
    orderBy: { date: "asc" },
    include: GAME_STATS_INCLUDE
  });
  const leagueTeams = await prisma.team.findMany({ where: { leagueId: req.params.id } });
  const byMonthGames = /* @__PURE__ */ new Map();
  for (const g of games) {
    const key = new Date(g.date).toISOString().slice(0, 7);
    if (!byMonthGames.has(key)) byMonthGames.set(key, []);
    byMonthGames.get(key).push(g);
  }
  const byMonth = await Promise.all([...byMonthGames.entries()].map(async ([month, gs]) => ({
    month,
    ...await aggregateGames(gs, leagueTeams)
  })));
  const lastN = await Promise.all([4, 6, 10].map(async (n) => ({
    n,
    ...await aggregateGames(games.slice(-n), leagueTeams)
  })));
  const streaks = /* @__PURE__ */ new Map();
  const sOf = (pid) => {
    if (!streaks.has(pid)) streaks.set(pid, {
      playerId: pid,
      hitCur: 0,
      hitBest: 0,
      obCur: 0,
      obBest: 0,
      kCur: 0,
      kBest: 0,
      droughtCur: 0,
      droughtBest: 0
    });
    return streaks.get(pid);
  };
  for (const g of games) {
    const box = computeBoxscore(await loadEvents(g.id), g.innings);
    for (const line of [...Object.values(box.away), ...Object.values(box.home)]) {
      const s = sOf(line.playerId);
      const hit = line.h > 0, onBase = line.h + line.bb + line.hbp > 0, whiffed = line.k > 0, dry = line.ab > 0 && line.h === 0;
      s.hitCur = hit ? s.hitCur + 1 : 0;
      s.hitBest = Math.max(s.hitBest, s.hitCur);
      s.obCur = onBase ? s.obCur + 1 : 0;
      s.obBest = Math.max(s.obBest, s.obCur);
      s.kCur = whiffed ? s.kCur + 1 : 0;
      s.kBest = Math.max(s.kBest, s.kCur);
      s.droughtCur = dry ? s.droughtCur + 1 : 0;
      s.droughtBest = Math.max(s.droughtBest, s.droughtCur);
    }
  }
  const streakPlayers = await prisma.player.findMany({
    where: { id: { in: [...streaks.keys()] } },
    include: { team: true }
  });
  const meta = new Map(streakPlayers.map((p) => [p.id, {
    name: `${p.number ? `#${p.number} ` : ""}${p.firstName} ${p.lastName}`,
    shortName: p.team.shortName ?? p.team.name
  }]));
  res.json({
    byMonth,
    lastN,
    streaks: [...streaks.values()].map((s) => ({ ...s, ...meta.get(s.playerId) ?? { name: "?", shortName: "?" } })).sort((a, b) => b.hitCur - a.hitCur || b.hitBest - a.hitBest)
  });
});
r4.get("/:id/website", async (req, res) => {
  const html = await websiteHtml(req.params.id);
  if (!html) return res.status(404).send("Liga no encontrada");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.query.dl) {
    const league = await prisma.league.findUnique({ where: { id: req.params.id } });
    const slug = (league?.name ?? "liga").replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}_${league?.year ?? ""}.html"`);
  }
  res.send(html);
});
var leagues_default = r4;

// src/routes/stats.ts
var r5 = Router5();
var rowToEvent = (e) => ({
  seq: e.seq,
  inning: e.inning,
  half: e.half,
  batterId: e.batterId,
  pitcherId: e.pitcherId,
  result: e.result,
  notation: e.notation ?? null,
  errorOn: e.errorOn ? JSON.parse(e.errorOn) : void 0,
  putouts: e.putouts ? JSON.parse(e.putouts) : void 0,
  assists: e.assists ? JSON.parse(e.assists) : void 0,
  advances: e.advances
});
var f32 = (n) => Number(n.toFixed(3));
var avgOf = (h, ab) => f32(ab ? h / ab : 0);
var obpOf = (h, bb, hbp, ab, sf) => {
  const den = ab + bb + hbp + sf;
  return f32(den ? (h + bb + hbp) / den : 0);
};
var emptyMini = () => ({ pa: 0, ab: 0, h: 0, doubles: 0, triples: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sf: 0 });
async function consolidateStatLineDupes(gameIds) {
  const games = await prisma.game.findMany({
    where: gameIds ? { id: { in: gameIds } } : {},
    select: { id: true, statLines: true }
  });
  let fixed = 0;
  for (const g of games) {
    const lines = g.statLines ?? [];
    if (!lines.length) continue;
    const seen = /* @__PURE__ */ new Map();
    lines.forEach((l) => seen.set(l.playerId, (seen.get(l.playerId) ?? 0) + 1));
    if (![...seen.values()].some((n) => n > 1)) continue;
    const byPlayer = /* @__PURE__ */ new Map();
    for (const l of lines) {
      const arr = byPlayer.get(l.playerId) ?? [];
      arr.push(l);
      byPlayer.set(l.playerId, arr);
    }
    const merged = [...byPlayer.values()].map((arr) => mergeLines(arr));
    await prisma.game.update({ where: { id: g.id }, data: { statLines: JSON.parse(JSON.stringify(merged)) } });
    fixed++;
  }
  return fixed;
}
var HIT_SET = /* @__PURE__ */ new Set(["1B", "2B", "3B", "HR", "RHB", "1BE", "2BE", "3BE", "HRIP"]);
function miniLine(evs) {
  const m = emptyMini();
  for (const ev of evs) {
    const r10 = ev.result;
    m.pa += 1;
    if (HIT_SET.has(r10)) {
      m.h += 1;
      m.ab += 1;
      if (r10 === "2B" || r10 === "2BE") m.doubles += 1;
      if (r10 === "3B" || r10 === "3BE") m.triples += 1;
      if (r10 === "HR" || r10 === "HRIP") m.hr += 1;
    } else if (r10 === "BB" || r10 === "IBB") m.bb += 1;
    else if (r10 === "HBP") m.hbp += 1;
    else if (r10 === "SF") m.sf += 1;
    else if (r10 === "SAC" || r10 === "CI" || r10 === "OOT") {
    } else {
      m.ab += 1;
      if (r10 === "K" || r10 === "KWP" || r10 === "KPB") m.k += 1;
    }
    const runs = ev.advances.filter((a) => a.to === "HOME").length;
    if (!["E", "DP", "TP", "KWP", "KPB"].includes(r10)) m.rbi += runs;
  }
  return m;
}
r5.get("/games/:id/boxscore", async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  const evs = await loadEvents(req.params.id);
  const lines = game?.statLines ?? [];
  if (evs.length || !lines.length) return res.json(computeBoxscore(evs, game?.innings ?? 9));
  const box = {
    away: {},
    home: {},
    pitchers: {},
    linescore: { away: [], home: [] },
    lob: { away: 0, home: 0 }
  };
  for (const ln of lines) {
    const side = ln.teamId === game.awayTeamId ? "away" : "home";
    box[side][ln.playerId] = {
      playerId: ln.playerId,
      pa: ln.pa ?? 0,
      ab: ln.ab ?? 0,
      r: ln.r ?? 0,
      h: ln.h ?? 0,
      rbi: ln.rbi ?? 0,
      bb: ln.bb ?? 0,
      k: ln.k ?? 0,
      hbp: ln.hbp ?? 0,
      doubles: ln.doubles ?? 0,
      triples: ln.triples ?? 0,
      hr: ln.hr ?? 0,
      sac: ln.sac ?? 0,
      sf: ln.sf ?? 0,
      sb: ln.sb ?? 0
    };
    if ((ln.gp ?? 0) || (ln.pOuts ?? 0)) {
      box.pitchers[ln.playerId] = {
        playerId: ln.playerId,
        outs: ln.pOuts ?? 0,
        h: ln.pH ?? 0,
        r: ln.pR ?? 0,
        er: ln.pER ?? 0,
        bb: ln.pBB ?? 0,
        k: ln.pK ?? 0,
        hr: ln.pHR ?? 0,
        pitches: ln.pPitches ?? 0
      };
    }
  }
  res.json(box);
});
r5.get("/search-players", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) return res.json([]);
  const players = await prisma.player.findMany({
    where: { OR: [{ firstName: { contains: q } }, { lastName: { contains: q } }] },
    include: { team: { select: { name: true, shortName: true, league: { select: { name: true, year: true } } } } },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: 12
  });
  res.json(players.map((p) => ({
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    number: p.number,
    positions: p.positions,
    active: p.active,
    team: p.team?.name ?? null,
    league: p.team?.league ? `${p.team.league.name} ${p.team.league.year}` : null
  })));
});
r5.get("/players/:id", async (req, res) => {
  const playerId = req.params.id;
  const events = await prisma.gameEvent.findMany({
    where: { OR: [{ batterId: playerId }, { pitcherId: playerId }, { advances: { string_contains: playerId } }] },
    orderBy: [{ gameId: "asc" }, { seq: "asc" }]
  });
  const byGame = /* @__PURE__ */ new Map();
  const grouped = /* @__PURE__ */ new Map();
  const gameMeta = /* @__PURE__ */ new Map();
  for (const g of await prisma.game.findMany({
    where: { id: { in: [...new Set(events.map((x) => x.gameId))] } },
    include: {
      homeTeam: { select: { id: true, name: true, shortName: true } },
      awayTeam: { select: { id: true, name: true, shortName: true } },
      league: { select: { name: true, year: true } },
      lineups: { where: { playerId }, select: { teamId: true } }
    }
  })) {
    const myTeam = g.lineups[0]?.teamId;
    const opp = myTeam === g.awayTeamId ? g.homeTeam : myTeam === g.homeTeamId ? g.awayTeam : g.awayTeam;
    gameMeta.set(g.id, {
      innings: g.innings,
      date: g.date,
      opponent: opp?.shortName ?? opp?.name ?? "?",
      league: g.league ? `${g.league.name} ${g.league.year}` : null
    });
  }
  for (const e of await prisma.gameEvent.findMany({
    where: { gameId: { in: [...new Set(events.map((x) => x.gameId))] } },
    orderBy: { seq: "asc" }
  })) {
    const arr = grouped.get(e.gameId) ?? [];
    arr.push(e);
    grouped.set(e.gameId, arr);
  }
  for (const [gid, evs] of grouped) {
    const meta = gameMeta.get(gid);
    byGame.set(gid, computeBoxscore(evs.map((e) => ({
      seq: e.seq,
      inning: e.inning,
      half: e.half,
      batterId: e.batterId,
      pitcherId: e.pitcherId,
      result: e.result,
      errorOn: e.errorOn ? JSON.parse(e.errorOn) : void 0,
      advances: e.advances
    })), meta?.innings ?? 9));
  }
  const total = { pa: 0, ab: 0, r: 0, h: 0, rbi: 0, bb: 0, k: 0, doubles: 0, triples: 0, hr: 0, sb: 0 };
  const pitch = { outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0 };
  const fielding = {
    e: await prisma.gameEvent.count({ where: { errorOn: { contains: playerId } } })
  };
  const games = [];
  for (const [gid, box] of byGame) {
    const line = { ...box.away[playerId], ...box.home[playerId] };
    const pline = box.pitchers[playerId];
    if (line.playerId) {
      for (const k of Object.keys(total)) total[k] += line[k] ?? 0;
    }
    if (pline) for (const k of Object.keys(pitch)) pitch[k] += pline[k];
    const meta = gameMeta.get(gid);
    games.push({
      gameId: gid,
      date: meta?.date,
      opponent: meta?.opponent,
      league: meta?.league,
      batting: line.playerId ? line : null,
      pitching: pline ?? null
    });
  }
  const seasons = await prisma.playerSeasonStat.findMany({
    where: { playerId },
    orderBy: { season: "desc" }
  });
  const avg = total.ab ? total.h / total.ab : 0;
  const era = pitch.outs ? pitch.er * 27 / pitch.outs : 0;
  res.json({ playerId, games, batting: { ...total, avg }, pitching: { ...pitch, era }, fielding, seasons });
});
var BIP = /* @__PURE__ */ new Set(["1B", "2B", "3B", "HR", "GO", "FO", "LO", "PO", "DP", "TP", "SAC", "SF", "E", "FC", "IF", "XF", "1BE", "2BE", "3BE", "RHB"]);
var TRAJ_OF = {
  GO: "G",
  LO: "L",
  FO: "F",
  PO: "F",
  IF: "F",
  SF: "F",
  XF: "F",
  SAC: "G"
};
var SEASON_EDITABLE = [
  "g",
  "pa",
  "ab",
  "r",
  "h",
  "doubles",
  "triples",
  "hr",
  "rbi",
  "bb",
  "k",
  "hbp",
  "sac",
  "sf",
  "sb",
  "gp",
  "gs",
  "w",
  "l",
  "sv",
  "hld",
  "bs",
  "cg",
  "sho",
  "pOuts",
  "pH",
  "pR",
  "pER",
  "pBB",
  "pK",
  "pHR",
  "pPitches",
  "e"
];
r5.put("/players/:id/season", async (req, res) => {
  try {
    const playerId = req.params.id;
    const { season, scope, ip, ...rest } = req.body;
    if (!season || !Number.isFinite(season)) {
      res.status(400).json({ error: "falta season" });
      return;
    }
    const p = await prisma.player.findUnique({ where: { id: playerId } });
    if (!p) {
      res.status(404).json({ error: "jugador no encontrado" });
      return;
    }
    const data = {};
    for (const k of SEASON_EDITABLE) {
      const v = rest[k];
      if (typeof v === "number" && Number.isFinite(v)) data[k] = Math.max(0, Math.round(v));
    }
    if (typeof ip === "number" && Number.isFinite(ip) && ip >= 0) {
      const inn = Math.floor(ip);
      data.pOuts = inn * 3 + Math.min(2, Math.round((ip - inn) * 10));
    }
    const sc = scope === "POST" ? "POST" : "REG";
    const prev = await prisma.playerSeasonStat.findUnique({
      where: { playerId_season_scope: { playerId, season, scope: sc } }
    });
    const prevAdj = prev?.adj ?? {};
    const adj = { ...prevAdj };
    for (const k of Object.keys(data)) {
      const stored = Number(prev?.[k]) || 0;
      const d = data[k] - (stored - (prevAdj[k] ?? 0));
      if (d) adj[k] = d;
      else delete adj[k];
    }
    const row = await prisma.playerSeasonStat.upsert({
      where: { playerId_season_scope: { playerId, season, scope: sc } },
      create: { playerId, season, scope: sc, ...data, adj: Object.keys(adj).length ? adj : Prisma3.DbNull },
      update: { ...data, adj: Object.keys(adj).length ? adj : Prisma3.DbNull }
    });
    res.json({ ok: true, stat: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
r5.get("/players/:id/spray", async (req, res) => {
  const playerId = req.params.id;
  const games = await prisma.game.findMany({
    where: { status: "FINAL", events: { some: { batterId: playerId } } },
    select: { id: true, seriesId: true, league: { select: { year: true, name: true } } },
    orderBy: { date: "asc" }
  });
  const points = [];
  for (const g of games) {
    const evs = await loadEvents(g.id);
    for (const ev of evs) {
      if (ev.batterId !== playerId || !BIP.has(ev.result)) continue;
      const m = ev.notation?.match(/10|[1-9]/);
      if (ev.sprayDir == null && !m) continue;
      const tm = ev.notation?.match(/^[GLF]/);
      const traj = tm ? tm[0] : TRAJ_OF[ev.result] ?? null;
      points.push({
        result: ev.result,
        loc: m ? Number(m[0]) : 0,
        traj,
        season: g.league?.year ?? 0,
        post: !!g.seriesId,
        ...ev.sprayDir != null && ev.sprayDist != null ? { dir: ev.sprayDir, dist: ev.sprayDist } : {}
      });
    }
  }
  res.json({ points });
});
r5.get("/players/:id/pitchloc", async (req, res) => {
  const playerId = req.params.id;
  const games = await prisma.game.findMany({
    where: { status: "FINAL", events: { some: { pitcherId: playerId } } },
    select: { id: true, seriesId: true, league: { select: { year: true } } }
  });
  const points = [];
  for (const g of games) {
    const evs = await loadEvents(g.id);
    for (const ev of evs) {
      if (ev.pitcherId !== playerId || !ev.notation) continue;
      const m = /^Z(\d)(\d)$/.exec(ev.notation);
      if (m) points.push({ r: Number(m[1]), c: Number(m[2]), result: ev.result, season: g.league?.year ?? 0, post: !!g.seriesId });
    }
  }
  res.json({ points });
});
r5.get("/players/:id/full", async (req, res) => {
  const playerId = req.params.id;
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: { team: true }
  });
  if (!player) return res.status(404).json({ error: "Jugador no encontrado" });
  if (player.blocked) {
    return res.json({
      blocked: true,
      name: `${player.firstName} ${player.lastName}`,
      teamName: player.team?.name ?? null
    });
  }
  const leagues = await prisma.league.findMany({ orderBy: [{ year: "desc" }, { name: "asc" }] });
  const seasons = await prisma.playerSeasonStat.findMany({ where: { playerId }, orderBy: { season: "desc" } });
  const adjLeagueId = leagues.some((l) => l.id === player.team?.leagueId) ? player.team?.leagueId : leagues[0]?.id;
  const tournaments = [];
  const importedGameIds = new Set((await prisma.$queryRaw`
    SELECT id FROM Game WHERE status = 'FINAL'
    AND JSON_SEARCH(statLines, 'one', ${playerId}) IS NOT NULL
  `).map((r10) => r10.id));
  for (const league of leagues) {
    const games = await prisma.game.findMany({
      where: {
        leagueId: league.id,
        status: "FINAL",
        OR: [
          { lineups: { some: { playerId } } },
          { events: { some: { batterId: playerId } } },
          { events: { some: { pitcherId: playerId } } },
          { id: { in: [...importedGameIds] } }
          // juegos importados (sin eventos/lineup)
        ]
      },
      orderBy: { date: "asc" },
      include: {
        homeTeam: { select: { id: true, name: true, shortName: true } },
        awayTeam: { select: { id: true, name: true, shortName: true } },
        lineups: { where: { playerId }, select: { teamId: true, role: true, position: true } }
      }
    });
    if (!games.length) continue;
    const mkAcc = () => ({
      bat: { g: 0, pa: 0, ab: 0, r: 0, h: 0, doubles: 0, triples: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sac: 0, sf: 0, sb: 0 },
      pit: { gp: 0, gs: 0, w: 0, l: 0, sv: 0, hld: 0, bs: 0, cg: 0, sho: 0, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0, pitches: 0 },
      fld: { po: 0, a: 0, e: 0 },
      log: [],
      teamsMap: /* @__PURE__ */ new Map(),
      stints: /* @__PURE__ */ new Map()
    });
    const regAcc = mkAcc();
    const postAcc = mkAcc();
    const stintOf = (acc, teamId, teamName, year) => {
      let s = acc.stints.get(`${teamId}:${year}`);
      if (!s) {
        s = {
          teamId,
          team: teamName,
          year,
          g: 0,
          bat: { g: 0, pa: 0, ab: 0, r: 0, h: 0, doubles: 0, triples: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sac: 0, sf: 0, sb: 0 },
          pit: { gp: 0, gs: 0, w: 0, l: 0, sv: 0, hld: 0, bs: 0, cg: 0, sho: 0, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0, pitches: 0 },
          fld: { po: 0, a: 0, e: 0 }
        };
        acc.stints.set(`${teamId}:${year}`, s);
      }
      return s;
    };
    const yearAccs = /* @__PURE__ */ new Map();
    for (const g of games) {
      const evs = await loadEvents(g.id);
      const box = computeBoxscore(evs, g.innings);
      const ln = mergeLines(
        (g.statLines ?? []).filter((x) => x.playerId === playerId)
      );
      const bat = box.away[playerId] ?? box.home[playerId] ?? (ln && (ln.pa ?? 0) + (ln.sb ?? 0) > 0 ? {
        playerId,
        pa: ln.pa ?? 0,
        ab: ln.ab ?? 0,
        r: ln.r ?? 0,
        h: ln.h ?? 0,
        rbi: ln.rbi ?? 0,
        bb: ln.bb ?? 0,
        k: ln.k ?? 0,
        hbp: ln.hbp ?? 0,
        doubles: ln.doubles ?? 0,
        triples: ln.triples ?? 0,
        hr: ln.hr ?? 0,
        sac: ln.sac ?? 0,
        sf: ln.sf ?? 0,
        sb: ln.sb ?? 0
      } : void 0);
      const pit = box.pitchers[playerId] ?? (ln && ((ln.gp ?? 0) || (ln.pOuts ?? 0)) ? {
        playerId,
        outs: ln.pOuts ?? 0,
        h: ln.pH ?? 0,
        r: ln.pR ?? 0,
        er: ln.pER ?? 0,
        bb: ln.pBB ?? 0,
        k: ln.pK ?? 0,
        hr: ln.pHR ?? 0,
        pitches: ln.pPitches ?? 0
      } : void 0);
      const hlds = g.hldIds ? JSON.parse(g.hldIds) : [];
      const bss = g.bsIds ? JSON.parse(g.bsIds) : [];
      const { cg: cgs, sho: shos } = evs.length ? computeCgSho(evs, g.innings) : { cg: [], sho: [] };
      const dec = {
        gs: g.lineups.length ? g.lineups.some((l) => l.role === "STARTER" && l.position === "P") ? 1 : 0 : ln?.gs ?? 0,
        w: g.wpId ? g.wpId === playerId ? 1 : 0 : ln?.w ?? 0,
        l: g.lpId ? g.lpId === playerId ? 1 : 0 : ln?.l ?? 0,
        sv: g.svId ? g.svId === playerId ? 1 : 0 : ln?.sv ?? 0,
        hld: g.hldIds ? hlds.includes(playerId) ? 1 : 0 : ln?.hld ?? 0,
        bs: g.bsIds ? bss.includes(playerId) ? 1 : 0 : ln?.bs ?? 0,
        cg: evs.length ? cgs.includes(playerId) ? 1 : 0 : ln?.cg ?? 0,
        sho: evs.length ? shos.includes(playerId) ? 1 : 0 : ln?.sho ?? 0
      };
      const decAny = dec.gs + dec.w + dec.l + dec.sv + dec.hld + dec.bs + dec.cg + dec.sho > 0;
      const pitFull = pit || decAny ? { ...pit ?? { playerId, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0, pitches: 0 }, ...dec } : void 0;
      const myTeamId = g.lineups[0]?.teamId ?? ln?.teamId ?? player.teamId;
      const myTeam = myTeamId === g.awayTeamId ? g.awayTeam : myTeamId === g.homeTeamId ? g.homeTeam : null;
      const opp = myTeamId === g.awayTeamId ? g.homeTeam : g.awayTeam;
      const gYear = new Date(g.date).getFullYear();
      const feed = (acc) => {
        if (g.lineups.length || bat || pitFull || ln) acc.bat.g += 1;
        if (bat) {
          acc.bat.pa += bat.pa;
          acc.bat.ab += bat.ab;
          acc.bat.r += bat.r;
          acc.bat.h += bat.h;
          acc.bat.doubles += bat.doubles;
          acc.bat.triples += bat.triples;
          acc.bat.hr += bat.hr;
          acc.bat.rbi += bat.rbi;
          acc.bat.bb += bat.bb;
          acc.bat.k += bat.k;
          acc.bat.hbp += bat.hbp;
          acc.bat.sac += bat.sac;
          acc.bat.sf += bat.sf;
          acc.bat.sb += bat.sb;
        }
        if (pitFull) {
          acc.pit.gp += 1;
          acc.pit.gs += pitFull.gs;
          acc.pit.w += pitFull.w;
          acc.pit.l += pitFull.l;
          acc.pit.sv += pitFull.sv;
          acc.pit.hld += pitFull.hld;
          acc.pit.bs += pitFull.bs;
          acc.pit.cg += pitFull.cg;
          acc.pit.sho += pitFull.sho;
          acc.pit.outs += pitFull.outs;
          acc.pit.h += pitFull.h;
          acc.pit.r += pitFull.r;
          acc.pit.er += pitFull.er;
          acc.pit.bb += pitFull.bb;
          acc.pit.k += pitFull.k;
          acc.pit.hr += pitFull.hr;
          acc.pit.pitches += pitFull.pitches;
        }
        for (const ev of evs) {
          for (const p of ev.putouts ?? []) if (p === playerId) acc.fld.po += 1;
          for (const p of ev.assists ?? []) if (p === playerId) acc.fld.a += 1;
          for (const p of ev.errorOn ?? []) if (p === playerId) acc.fld.e += 1;
        }
        if (ln) {
          acc.fld.po += ln.po ?? 0;
          acc.fld.a += ln.a ?? 0;
          acc.fld.e += ln.e ?? 0;
        }
        if (myTeam && !acc.teamsMap.has(myTeam.id)) acc.teamsMap.set(myTeam.id, myTeam);
        if (g.lineups.length || bat || pitFull || ln) {
          const st = stintOf(acc, myTeamId, myTeam?.shortName ?? myTeam?.name ?? "?", gYear);
          st.g += 1;
          if (bat) {
            st.bat.pa += bat.pa;
            st.bat.ab += bat.ab;
            st.bat.r += bat.r;
            st.bat.h += bat.h;
            st.bat.doubles += bat.doubles;
            st.bat.triples += bat.triples;
            st.bat.hr += bat.hr;
            st.bat.rbi += bat.rbi;
            st.bat.bb += bat.bb;
            st.bat.k += bat.k;
            st.bat.hbp += bat.hbp;
          }
          if (pitFull) {
            st.pit.gp += 1;
            st.pit.gs += pitFull.gs;
            st.pit.w += pitFull.w;
            st.pit.l += pitFull.l;
            st.pit.sv += pitFull.sv;
            st.pit.hld += pitFull.hld;
            st.pit.bs += pitFull.bs;
            st.pit.cg += pitFull.cg;
            st.pit.sho += pitFull.sho;
            st.pit.outs += pitFull.outs;
            st.pit.h += pitFull.h;
            st.pit.r += pitFull.r;
            st.pit.er += pitFull.er;
            st.pit.bb += pitFull.bb;
            st.pit.k += pitFull.k;
            st.pit.hr += pitFull.hr;
            st.pit.pitches += pitFull.pitches;
          }
          for (const ev of evs) {
            for (const p of ev.putouts ?? []) if (p === playerId) st.fld.po += 1;
            for (const p of ev.assists ?? []) if (p === playerId) st.fld.a += 1;
            for (const p of ev.errorOn ?? []) if (p === playerId) st.fld.e += 1;
          }
          if (ln) {
            st.fld.po += ln.po ?? 0;
            st.fld.a += ln.a ?? 0;
            st.fld.e += ln.e ?? 0;
          }
        }
        acc.log.push({
          gameId: g.id,
          date: g.date,
          team: myTeam?.shortName ?? myTeam?.name ?? null,
          vs: opp?.shortName ?? opp?.name ?? "?",
          batting: bat ?? null,
          pitching: pitFull ?? null
        });
      };
      feed(g.seriesId ? postAcc : regAcc);
      if (!g.seriesId) {
        const y = new Date(g.date).getFullYear();
        let ya = yearAccs.get(y);
        if (!ya) {
          ya = mkAcc();
          yearAccs.set(y, ya);
        }
        feed(ya);
      }
    }
    const addSeasonAdj = (acc, a) => {
      acc.bat.g += a.g ?? 0;
      acc.bat.pa += a.pa ?? 0;
      acc.bat.ab += a.ab ?? 0;
      acc.bat.r += a.r ?? 0;
      acc.bat.h += a.h ?? 0;
      acc.bat.doubles += a.doubles ?? 0;
      acc.bat.triples += a.triples ?? 0;
      acc.bat.hr += a.hr ?? 0;
      acc.bat.rbi += a.rbi ?? 0;
      acc.bat.bb += a.bb ?? 0;
      acc.bat.k += a.k ?? 0;
      acc.bat.hbp += a.hbp ?? 0;
      acc.bat.sac += a.sac ?? 0;
      acc.bat.sf += a.sf ?? 0;
      acc.bat.sb += a.sb ?? 0;
      acc.pit.gp += a.gp ?? 0;
      acc.pit.gs += a.gs ?? 0;
      acc.pit.w += a.w ?? 0;
      acc.pit.l += a.l ?? 0;
      acc.pit.sv += a.sv ?? 0;
      acc.pit.hld += a.hld ?? 0;
      acc.pit.bs += a.bs ?? 0;
      acc.pit.cg += a.cg ?? 0;
      acc.pit.sho += a.sho ?? 0;
      acc.pit.outs += a.pOuts ?? 0;
      acc.pit.h += a.pH ?? 0;
      acc.pit.r += a.pR ?? 0;
      acc.pit.er += a.pER ?? 0;
      acc.pit.bb += a.pBB ?? 0;
      acc.pit.k += a.pK ?? 0;
      acc.pit.hr += a.pHR ?? 0;
      acc.pit.pitches += a.pPitches ?? 0;
      acc.fld.e += a.e ?? 0;
    };
    let postAdj = false;
    if (league.id === adjLeagueId) {
      for (const s of seasons) {
        const a = s.adj ?? null;
        if (!a || !Object.keys(a).length) continue;
        if (s.scope === "POST") {
          addSeasonAdj(postAcc, a);
          postAdj = true;
        } else {
          addSeasonAdj(regAcc, a);
          const ya = yearAccs.get(s.season);
          if (ya) addSeasonAdj(ya, a);
        }
      }
    }
    const regInn = games[0]?.innings ?? 9;
    const finalize = (acc) => {
      const tb = acc.bat.h + acc.bat.doubles + 2 * acc.bat.triples + 3 * acc.bat.hr;
      const slg = acc.bat.ab ? tb / acc.bat.ab : 0;
      const obp = obpOf(acc.bat.h, acc.bat.bb, acc.bat.hbp, acc.bat.ab, acc.bat.sf);
      const ip = acc.pit.outs / 3;
      return {
        batting: { ...acc.bat, avg: avgOf(acc.bat.h, acc.bat.ab), obp, slg: f32(slg), ops: f32(obp + slg) },
        pitching: { ...acc.pit, era: Number((ip ? acc.pit.er * regInn / ip : 0).toFixed(2)), whip: Number((ip ? (acc.pit.bb + acc.pit.h) / ip : 0).toFixed(2)) },
        fielding: { ...acc.fld, tc: acc.fld.po + acc.fld.a + acc.fld.e, fpct: f32(acc.fld.po + acc.fld.a + acc.fld.e > 0 ? (acc.fld.po + acc.fld.a) / (acc.fld.po + acc.fld.a + acc.fld.e) : 1) },
        teams: [...acc.teamsMap.values()],
        stints: [...acc.stints.values()].map((st) => ({
          teamId: st.teamId,
          team: st.team,
          year: st.year,
          g: st.g,
          batting: { ...st.bat, avg: avgOf(st.bat.h, st.bat.ab), obp: obpOf(st.bat.h, st.bat.bb, st.bat.hbp, st.bat.ab, st.bat.sf) },
          pitching: { ...st.pit, era: Number((st.pit.outs ? st.pit.er * regInn / (st.pit.outs / 3) : 0).toFixed(2)) },
          fielding: { ...st.fld, tc: st.fld.po + st.fld.a + st.fld.e }
        })),
        log: acc.log
      };
    };
    const regBlock = finalize(regAcc);
    tournaments.push({
      leagueId: league.id,
      league: league.name,
      year: league.year,
      sport: league.sport,
      ...regBlock,
      // desglose por año de fecha: la liga puede abarcar varias temporadas
      byYear: [...yearAccs.entries()].sort((a, b) => b[0] - a[0]).map(([y, a]) => ({ year: y, ...finalize(a) })),
      playoff: postAcc.log.length || postAdj ? finalize(postAcc) : null
    });
  }
  const seasonsOut = seasons.map((s) => ({
    ...s,
    teams: [...new Set(
      tournaments.flatMap((t) => {
        const tt = t;
        if (s.scope === "POST") {
          return (tt.playoff?.log ?? []).filter((l) => new Date(l.date).getFullYear() === s.season).map((l) => l.team).filter((x) => !!x);
        }
        return (tt.byYear ?? []).filter((y) => y.year === s.season).flatMap((y) => y.teams.map((x) => x.name));
      })
    )]
  }));
  res.json({ player, tournaments, seasons: seasonsOut });
});
r5.get("/players/:id/matchups", async (req, res) => {
  const playerId = req.params.id;
  const year = req.query.year ? Number(req.query.year) : null;
  const games = await prisma.game.findMany({
    where: {
      OR: [{ events: { some: { batterId: playerId } } }, { events: { some: { pitcherId: playerId } } }]
    },
    include: {
      homeTeam: { select: { id: true, name: true, shortName: true } },
      awayTeam: { select: { id: true, name: true, shortName: true } },
      events: { orderBy: { seq: "asc" } }
    }
  });
  const vsPitcher = /* @__PURE__ */ new Map();
  const vsTeam = /* @__PURE__ */ new Map();
  const pitchVsBatter = /* @__PURE__ */ new Map();
  const pitchVsTeam = /* @__PURE__ */ new Map();
  const teamMeta = /* @__PURE__ */ new Map();
  for (const g of games) {
    if (year && new Date(g.date).getFullYear() !== year) continue;
    teamMeta.set(g.homeTeamId, g.homeTeam);
    teamMeta.set(g.awayTeamId, g.awayTeam);
    const evs = g.events.map(rowToEvent);
    for (const ev of evs) {
      if (isMidResult(ev.result)) continue;
      const fieldTeamId = ev.half === "TOP" ? g.homeTeamId : g.awayTeamId;
      const batTeamId = ev.half === "TOP" ? g.awayTeamId : g.homeTeamId;
      if (ev.batterId === playerId) {
        if (ev.pitcherId) {
          const arr = vsPitcher.get(ev.pitcherId) ?? [];
          arr.push(ev);
          vsPitcher.set(ev.pitcherId, arr);
        }
        const tarr = vsTeam.get(fieldTeamId) ?? [];
        tarr.push(ev);
        vsTeam.set(fieldTeamId, tarr);
      }
      if (ev.pitcherId === playerId && ev.batterId) {
        const barr = pitchVsBatter.get(ev.batterId) ?? [];
        barr.push(ev);
        pitchVsBatter.set(ev.batterId, barr);
        const tarr = pitchVsTeam.get(batTeamId) ?? [];
        tarr.push(ev);
        pitchVsTeam.set(batTeamId, tarr);
      }
    }
  }
  const players = await prisma.player.findMany({
    where: { id: { in: [...vsPitcher.keys(), ...pitchVsBatter.keys()] } }
  });
  const pName = new Map(players.map((p) => [p.id, `${p.number ? `#${p.number} ` : ""}${p.firstName} ${p.lastName}`]));
  const tName = (id) => teamMeta.get(id)?.shortName ?? teamMeta.get(id)?.name ?? "?";
  const fmtBat = (id, label, evs) => {
    const m = miniLine(evs);
    const tb = m.h + m.doubles + 2 * m.triples + 3 * m.hr;
    const slg = m.ab ? tb / m.ab : 0;
    return {
      id,
      name: label,
      ...m,
      avg: avgOf(m.h, m.ab),
      obp: obpOf(m.h, m.bb, m.hbp, m.ab, m.sf),
      slg: f32(slg),
      ops: f32(obpOf(m.h, m.bb, m.hbp, m.ab, m.sf) + slg)
    };
  };
  res.json({
    vsPitchers: [...vsPitcher.entries()].map(([pid, evs]) => fmtBat(pid, pName.get(pid) ?? "?", evs)).sort((a, b) => b.pa - a.pa),
    vsTeams: [...vsTeam.entries()].map(([tid, evs]) => fmtBat(tid, tName(tid), evs)).sort((a, b) => b.pa - a.pa),
    pitchingVsBatters: [...pitchVsBatter.entries()].map(([pid, evs]) => fmtBat(pid, pName.get(pid) ?? "?", evs)).sort((a, b) => b.pa - a.pa),
    pitchingVsTeams: [...pitchVsTeam.entries()].map(([tid, evs]) => fmtBat(tid, tName(tid), evs)).sort((a, b) => b.pa - a.pa)
  });
});
r5.get("/head2head", async (req, res) => {
  const a = String(req.query.a ?? "");
  const b = String(req.query.b ?? "");
  if (!a || !b || a === b) return res.status(400).json({ error: "a y b requeridos (distintos)" });
  const games = await prisma.game.findMany({
    where: {
      status: "FINAL",
      OR: [{ awayTeamId: a, homeTeamId: b }, { awayTeamId: b, homeTeamId: a }]
    },
    include: { events: { orderBy: { seq: "asc" } } },
    orderBy: { date: "asc" }
  });
  let w = 0, l = 0, t = 0;
  const gameRows = [];
  const evsA = /* @__PURE__ */ new Map();
  const evsB = /* @__PURE__ */ new Map();
  const push = (m, pid, ev) => {
    const arr = m.get(pid) ?? [];
    arr.push(ev);
    m.set(pid, arr);
  };
  const pitA = /* @__PURE__ */ new Map();
  const pitB = /* @__PURE__ */ new Map();
  const accPit = (m, pid, p) => {
    const cur = m.get(pid) ?? { outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0, pitches: 0 };
    for (const k of Object.keys(cur)) cur[k] += p[k];
    m.set(pid, cur);
  };
  for (const g of games) {
    const evs = g.events.map(rowToEvent);
    const st = reduceGame(evs, g.innings);
    const sa = g.fScoreAway ?? st.score.away;
    const sh = g.fScoreHome ?? st.score.home;
    const aScore = g.awayTeamId === a ? sa : sh;
    const bScore = g.awayTeamId === a ? sh : sa;
    if (aScore > bScore) w += 1;
    else if (aScore < bScore) l += 1;
    else t += 1;
    gameRows.push({ id: g.id, date: g.date, aScore, bScore });
    const box = computeBoxscore(evs, g.innings);
    const pitBucket = /* @__PURE__ */ new Map();
    for (const ev of evs) {
      if (isMidResult(ev.result)) continue;
      const batTeam = ev.half === "TOP" ? g.awayTeamId : g.homeTeamId;
      const fldTeam = ev.half === "TOP" ? g.homeTeamId : g.awayTeamId;
      if (ev.batterId) push(batTeam === a ? evsA : evsB, ev.batterId, ev);
      if (ev.pitcherId && !pitBucket.has(ev.pitcherId)) {
        pitBucket.set(ev.pitcherId, fldTeam === a ? "a" : "b");
      }
    }
    for (const p of Object.values(box.pitchers)) {
      accPit(pitBucket.get(p.playerId) === "a" ? pitA : pitB, p.playerId, p);
    }
  }
  const ids = [.../* @__PURE__ */ new Set([...evsA.keys(), ...evsB.keys(), ...pitA.keys(), ...pitB.keys()])];
  const players = await prisma.player.findMany({ where: { id: { in: ids } } });
  const pName = new Map(players.map((p) => [p.id, `${p.number ? `#${p.number} ` : ""}${p.firstName} ${p.lastName}`]));
  const fmtBat = (id, evs) => {
    const m = miniLine(evs);
    const tb = m.h + m.doubles + 2 * m.triples + 3 * m.hr;
    const slg = m.ab ? tb / m.ab : 0;
    return {
      id,
      name: pName.get(id) ?? "?",
      ...m,
      avg: avgOf(m.h, m.ab),
      obp: obpOf(m.h, m.bb, m.hbp, m.ab, m.sf),
      slg: f32(slg),
      ops: f32(obpOf(m.h, m.bb, m.hbp, m.ab, m.sf) + slg)
    };
  };
  const fmtPit = ([id, p]) => ({ playerId: id, name: pName.get(id) ?? "?", ...p });
  res.json({
    record: { w, l, t },
    games: gameRows,
    battingA: [...evsA.entries()].map(([id, e]) => fmtBat(id, e)).sort((x, y) => y.pa - x.pa),
    battingB: [...evsB.entries()].map(([id, e]) => fmtBat(id, e)).sort((x, y) => y.pa - x.pa),
    pitchingA: [...pitA.entries()].map(fmtPit).sort((x, y) => y.outs - x.outs),
    pitchingB: [...pitB.entries()].map(fmtPit).sort((x, y) => y.outs - x.outs)
  });
});
r5.get("/players/:id/splits", async (req, res) => {
  const pid = req.params.id;
  const year = req.query.year ? Number(req.query.year) : null;
  const all = await prisma.game.findMany({
    where: { status: "FINAL", seriesId: null, lineups: { some: { playerId: pid } } },
    orderBy: { date: "asc" },
    include: GAME_STATS_INCLUDE
  });
  const games = year ? all.filter((g) => new Date(g.date).getFullYear() === year) : all;
  const pick = (s) => ({
    games: s.games,
    batting: s.batting.find((b) => b.playerId === pid) ?? null,
    pitching: s.pitching.find((p) => p.playerId === pid) ?? null,
    fielding: s.fielding.find((f) => f.playerId === pid) ?? null
  });
  const byMonthGames = /* @__PURE__ */ new Map();
  for (const g of games) {
    const key = new Date(g.date).toISOString().slice(0, 7);
    if (!byMonthGames.has(key)) byMonthGames.set(key, []);
    byMonthGames.get(key).push(g);
  }
  const byMonth = await Promise.all([...byMonthGames.entries()].map(async ([month, gs]) => ({
    month,
    ...pick(await aggregateGames(gs, []))
  })));
  const lastN = await Promise.all([4, 6, 10].map(async (n) => ({
    n,
    ...pick(await aggregateGames(games.slice(-n), []))
  })));
  const streaks = { hitCur: 0, hitBest: 0, obCur: 0, obBest: 0, kCur: 0, kBest: 0, droughtCur: 0, droughtBest: 0 };
  for (const g of games) {
    const box = computeBoxscore(await loadEvents(g.id), g.innings);
    const line = box.away[pid] ?? box.home[pid];
    if (!line || line.pa === 0) continue;
    const hit = line.h > 0, onBase = line.h + line.bb + line.hbp > 0, whiffed = line.k > 0, dry = line.ab > 0 && line.h === 0;
    streaks.hitCur = hit ? streaks.hitCur + 1 : 0;
    streaks.hitBest = Math.max(streaks.hitBest, streaks.hitCur);
    streaks.obCur = onBase ? streaks.obCur + 1 : 0;
    streaks.obBest = Math.max(streaks.obBest, streaks.obCur);
    streaks.kCur = whiffed ? streaks.kCur + 1 : 0;
    streaks.kBest = Math.max(streaks.kBest, streaks.kCur);
    streaks.droughtCur = dry ? streaks.droughtCur + 1 : 0;
    streaks.droughtBest = Math.max(streaks.droughtBest, streaks.droughtCur);
  }
  res.json({ byMonth, lastN, streaks });
});
r5.get("/matchup", async (req, res) => {
  const a = String(req.query.a ?? "");
  const b = String(req.query.b ?? "");
  if (!a || !b) return res.status(400).json({ error: "a (bateador) y b (lanzador) requeridos" });
  const games = await prisma.game.findMany({
    where: { status: "FINAL", events: { some: { batterId: a, pitcherId: b } } },
    orderBy: { date: "asc" },
    include: { events: { orderBy: { seq: "asc" } } }
  });
  const evs = [];
  for (const g of games) for (const row of g.events) {
    const ev = rowToEvent(row);
    if (!isMidResult(ev.result) && ev.batterId === a && ev.pitcherId === b)
      evs.push({ ...ev, gameId: g.id, date: g.date });
  }
  const m = miniLine(evs);
  const tb = m.h + m.doubles + 2 * m.triples + 3 * m.hr;
  const slg = m.ab ? tb / m.ab : 0;
  const obp = obpOf(m.h, m.bb, m.hbp, m.ab, m.sf);
  res.json({
    ...m,
    avg: avgOf(m.h, m.ab),
    obp,
    slg: f32(slg),
    ops: f32(obp + slg),
    games: games.length,
    last3: evs.slice(-3).reverse().map((e) => ({
      gameId: e.gameId,
      date: e.date,
      inning: e.inning,
      result: e.result,
      notation: e.notation,
      runs: e.advances.filter((x) => x.to === "HOME").length
    }))
  });
});
r5.get("/players/:id/situational", async (req, res) => {
  const pid = req.params.id;
  const year = Number(req.query.year) || void 0;
  const scope = req.query.scope === "POST" ? "POST" : "REG";
  const touched = await prisma.gameEvent.findMany({
    where: { OR: [{ batterId: pid }, { pitcherId: pid }] },
    select: { gameId: true },
    distinct: ["gameId"]
  });
  const games = await prisma.game.findMany({
    where: {
      id: { in: touched.map((t) => t.gameId) },
      status: "FINAL",
      ...scope === "POST" ? { seriesId: { not: null } } : { seriesId: null }
    },
    include: {
      season: true,
      lineups: { include: { player: { select: { bats: true, throws: true } } } }
    },
    orderBy: { date: "asc" }
  });
  const ofYear = year ? games.filter((g) => (g.season?.year ?? new Date(g.date).getFullYear()) === year) : games;
  const ids = /* @__PURE__ */ new Set();
  for (const g of ofYear) for (const l of g.lineups) ids.add(l.playerId);
  const hands = /* @__PURE__ */ new Map();
  const players = await prisma.player.findMany({
    select: { id: true, bats: true, throws: true }
  });
  for (const p of players) hands.set(p.id, { bats: p.bats, throws: p.throws });
  const bat = {};
  const pit = {};
  const sb = () => ({ pa: 0, ab: 0, r: 0, h: 0, d2: 0, d3: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sf: 0 });
  const sp = () => ({ bf: 0, outs: 0, ab: 0, h: 0, hr: 0, bb: 0, k: 0, r: 0, er: 0, erW: 0, dp: 0 });
  const B = (k) => bat[k] ??= sb();
  const P = (k) => pit[k] ??= sp();
  const UNER = /* @__PURE__ */ new Set(["E", "CI", "GR", "ADJ", "INT", "OBS", "KPB"]);
  for (const g of ofYear) {
    const evs = await loadEvents(g.id);
    const orderOf = new Map(
      g.lineups.filter((l) => l.batsInOrder !== false && l.order < 50).map((l) => [l.playerId, l.order])
    );
    let st = initialState();
    let paInHalf = 0, curHalf = null;
    const reach = /* @__PURE__ */ new Map();
    for (const ev of evs) {
      if (ev.half !== curHalf) {
        curHalf = ev.half;
        paInHalf = 0;
      }
      const mid = isMidResult(ev.result) && ev.result !== "SK";
      if (!mid && ev.batterId) {
        const r1 = !!st.bases[1], r22 = !!st.bases[2], r32 = !!st.bases[3];
        const anyOn = r1 || r22 || r32, risp = r22 || r32, loaded = r1 && r22 && r32;
        const keys = [anyOn ? "menOn" : "empty"];
        if (risp) keys.push("risp");
        if (loaded) keys.push("loaded");
        if (r32) keys.push("r3");
        keys.push(`outs${st.outs}`);
        if (risp && st.outs === 2) keys.push("risp2out");
        if (paInHalf === 0) keys.push("leadoff");
        const ord = orderOf.get(ev.batterId);
        if (ord) keys.push(`order${ord}`);
        const pThrows = ev.pitcherId ? hands.get(ev.pitcherId)?.throws : void 0;
        const bBats = hands.get(ev.batterId)?.bats;
        if (pThrows === "L") keys.push("vsLHP");
        else if (pThrows) keys.push("vsRHP");
        const effSide = bBats === "S" ? pThrows === "L" ? "R" : pThrows ? "L" : null : bBats;
        if (effSide === "L") keys.push("vsLHB");
        else if (effSide === "R") keys.push("vsRHB");
        keys.push(ev.half === "TOP" ? "away" : "home");
        keys.push("all");
        const isB = ev.batterId === pid, isP = ev.pitcherId === pid;
        if (isB || isP) {
          const runs = ev.advances.filter((a) => a.to === "HOME").length;
          const rr = ev.result;
          const outs = ev.advances.filter((a) => a.to === "OUT").length;
          for (const k of keys) {
            if (isB) {
              const l = B(k);
              l.pa += 1;
              if (HIT_SET.has(rr)) {
                l.h += 1;
                l.ab += 1;
                if (rr === "2B" || rr === "2BE") l.d2 += 1;
                if (rr === "3B" || rr === "3BE") l.d3 += 1;
                if (rr === "HR" || rr === "HRIP") l.hr += 1;
              } else if (rr === "BB" || rr === "IBB") l.bb += 1;
              else if (rr === "HBP") l.hbp += 1;
              else if (rr === "SF") l.sf += 1;
              else if (rr === "SAC" || rr === "CI" || rr === "OOT") {
              } else {
                l.ab += 1;
                if (rr === "K" || rr === "KWP" || rr === "KPB") l.k += 1;
              }
              if (ev.advances.some((a) => a.playerId === ev.batterId && a.to === "HOME")) l.r += 1;
              if (!["E", "DP", "TP", "KWP", "KPB"].includes(rr)) l.rbi += runs;
            }
            if (isP) {
              const l = P(k);
              if (!["CI", "OOT"].includes(rr)) {
                l.bf += 1;
                if (!["BB", "IBB", "HBP", "SAC", "SF"].includes(rr)) l.ab += 1;
              }
              l.outs += outs;
              if (HIT_SET.has(rr)) l.h += 1;
              if (rr === "HR" || rr === "HRIP") l.hr += 1;
              if (rr === "DP" || rr === "TP") l.dp += 1;
              if (rr === "BB" || rr === "IBB") l.bb += 1;
              if (rr === "K" || rr === "KWP" || rr === "KPB") l.k += 1;
              const playHadError = ev.result === "E" || !!ev.errorOn?.length || ["1BE", "2BE", "3BE", "PB", "BK", "IPL", "DE"].includes(rr) || /E-?\d/.test(ev.notation ?? "");
              for (const a of ev.advances) {
                if (a.to !== "HOME") continue;
                const chargeTo = reach.get(a.playerId)?.pitcherId ?? ev.pitcherId;
                if (chargeTo !== pid) continue;
                l.r += 1;
                if (!playHadError && !UNER.has(reach.get(a.playerId)?.res ?? "")) {
                  l.er += 1;
                  l.erW += g.innings;
                }
              }
            }
          }
        }
        paInHalf += 1;
      }
      if (ev.batterId && ev.advances.some((a) => a.playerId === ev.batterId && a.to !== "OUT" && a.to !== "HOME")) {
        const errReach = !!ev.errorOn?.length || ["E", "CI", "INT", "OBS", "KPB"].includes(ev.result) || ev.result === "FC" && !!ev.errorOn?.length;
        reach.set(ev.batterId, { res: errReach ? "E" : ev.result, pitcherId: ev.pitcherId });
      }
      const hadErr = ev.result === "E" || !!ev.errorOn?.length || ["1BE", "2BE", "3BE", "PB", "BK", "IPL", "DE", "CI", "INT", "OBS"].includes(ev.result) || /E-?\d/.test(ev.notation ?? "");
      if (hadErr) {
        const midErr = isMidResult(ev.result);
        const defs = midErr || !ev.batterId ? null : defaultAdvances(st, ev.batterId, ev.result);
        for (const a of ev.advances) {
          if (a.to === "OUT" || a.to === "HOME" || a.playerId === ev.batterId) continue;
          if (!midErr && typeof a.to === "number") {
            const nat = defs?.find((d) => d.playerId === a.playerId)?.to;
            if (typeof nat === "number" && a.to <= nat) continue;
          }
          const prev = reach.get(a.playerId);
          reach.set(a.playerId, { res: "E", pitcherId: prev?.pitcherId ?? ev.pitcherId });
        }
      }
      if (ev.result === "GR" || ev.result === "ADJ") {
        for (const a of ev.advances) {
          if (a.to !== "OUT" && a.to !== "HOME") reach.set(a.playerId, { res: ev.result, pitcherId: ev.result === "GR" ? ev.pitcherId : null });
        }
      }
      st = applyEvent(st, ev, g.innings);
      const onBase = new Set([st.bases[1], st.bases[2], st.bases[3]].filter(Boolean));
      for (const p of [...reach.keys()]) if (!onBase.has(p)) reach.delete(p);
    }
  }
  const fin = (l) => {
    const tb = l.h + l.d2 + 2 * l.d3 + 3 * l.hr;
    const obpD = l.ab + l.bb + l.hbp + l.sf;
    return {
      ...l,
      avg: l.ab ? l.h / l.ab : 0,
      obp: obpD ? (l.h + l.bb + l.hbp) / obpD : 0,
      slg: l.ab ? tb / l.ab : 0,
      ops: 0
    };
  };
  const finB = (l) => {
    const o = fin(l);
    o.ops = o.obp + o.slg;
    return o;
  };
  const finP = (l) => ({
    ...l,
    baa: l.ab ? l.h / l.ab : 0,
    // erW = CL ponderada por las entradas del juego → ERA correcta en softball
    era: l.outs ? l.erW * 3 / l.outs : 0,
    whip: l.outs ? (l.bb + l.h) * 3 / l.outs : 0
  });
  res.json({
    season: year ?? null,
    scope,
    games: ofYear.length,
    batting: Object.fromEntries(Object.entries(bat).map(([k, v]) => [k, finB(v)])),
    pitching: Object.fromEntries(Object.entries(pit).map(([k, v]) => [k, finP(v)]))
  });
});
r5.get("/player-list", async (_req, res) => {
  const players = await prisma.player.findMany({
    select: { id: true, firstName: true, lastName: true, number: true, active: true, teamId: true, team: { select: { name: true, shortName: true, leagueId: true, league: { select: { name: true } } } } },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }]
  });
  res.json(players.map((p) => ({
    id: p.id,
    label: `${p.number ? `#${p.number} ` : ""}${p.lastName}${p.firstName && p.firstName !== "\xB7" && p.firstName !== "\u2014" ? `, ${p.firstName}` : ""}`,
    active: p.active,
    team: p.team?.shortName ?? p.team?.name ?? "",
    teamId: p.teamId ?? "",
    leagueId: p.team?.leagueId ?? "",
    league: p.team?.league?.name ?? ""
  })));
});
var newBat = () => ({ pa: 0, ab: 0, r: 0, h: 0, d2: 0, d3: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sac: 0, sf: 0, sb: 0 });
var newPit = () => ({ outs: 0, h: 0, r: 0, er: 0, erW: 0, bb: 0, k: 0, hr: 0, pitches: 0, bf: 0, aba: 0 });
var newFld = () => ({ po: 0, a: 0, e: 0 });
var NO_RBI_R = /* @__PURE__ */ new Set(["E", "DP", "TP", "KWP", "KPB"]);
var UNER_REACH = /* @__PURE__ */ new Set(["E", "CI", "GR", "ADJ"]);
r5.post("/report", async (req, res) => {
  const dataset = req.body.dataset ?? "batting";
  const f = req.body.filters ?? {};
  const groupBy = req.body.groupBy ?? "player";
  const expandTeam = async (tid) => {
    if (!tid) return null;
    const t = await prisma.team.findUnique({ where: { id: tid }, select: { name: true } });
    if (!t) return [tid];
    const same = await prisma.team.findMany({ where: { name: t.name }, select: { id: true } });
    return same.map((x) => x.id);
  };
  const teamSet = await expandTeam(f.teamId);
  const vsSet = await expandTeam(f.vsTeamId);
  const games = await prisma.game.findMany({
    where: {
      status: "FINAL",
      ...f.leagueId ? { leagueId: f.leagueId } : {},
      ...teamSet ? { OR: [{ awayTeamId: { in: teamSet } }, { homeTeamId: { in: teamSet } }] } : {},
      ...vsSet ? { AND: [{ OR: [{ awayTeamId: { in: vsSet } }, { homeTeamId: { in: vsSet } }] }] } : {},
      ...f.post === true ? { seriesId: { not: null } } : f.post === false ? { seriesId: null } : {},
      ...f.dateFrom || f.dateTo ? { date: { ...f.dateFrom ? { gte: /* @__PURE__ */ new Date(`${f.dateFrom}T00:00:00`) } : {}, ...f.dateTo ? { lte: /* @__PURE__ */ new Date(`${f.dateTo}T23:59:59`) } : {} } } : {}
    },
    select: {
      id: true,
      date: true,
      innings: true,
      awayTeamId: true,
      homeTeamId: true,
      fScoreAway: true,
      fScoreHome: true,
      statLines: true,
      awayTeam: { select: { name: true, shortName: true } },
      homeTeam: { select: { name: true, shortName: true } },
      league: { select: { name: true, year: true } }
    },
    orderBy: { date: "asc" }
  });
  if (dataset === "games") {
    const rows2 = [];
    for (const g of games) {
      const evs = await loadEvents(g.id);
      let ra = 0, rh = 0;
      for (const ev of evs) {
        const runs = ev.advances.filter((a) => a.to === "HOME").length;
        if (ev.half === "TOP") ra += runs;
        else rh += runs;
      }
      const score = g.fScoreAway != null && g.fScoreHome != null ? `${g.fScoreAway}-${g.fScoreHome}` : `${ra}-${rh}`;
      rows2.push({
        gameId: g.id,
        date: g.date,
        league: g.league ? String(g.league.year) && g.league.name.includes(String(g.league.year)) ? g.league.name : `${g.league.name} ${g.league.year}` : "",
        away: g.awayTeam.shortName ?? g.awayTeam.name,
        home: g.homeTeam.shortName ?? g.homeTeam.name,
        awayTeamId: g.awayTeamId,
        homeTeamId: g.homeTeamId,
        score
      });
    }
    return res.json({ dataset, games: rows2 });
  }
  if (dataset === "innings") {
    const innMap = /* @__PURE__ */ new Map();
    let maxInn = 0;
    for (const g of games) {
      const evs = await loadEvents(g.id);
      if (!evs.length) continue;
      const per = { away: /* @__PURE__ */ new Map(), home: /* @__PURE__ */ new Map() };
      for (const ev of evs) {
        const runs = ev.advances.filter((a) => a.to === "HOME").length;
        if (!runs) continue;
        const m = per[ev.half === "TOP" ? "away" : "home"];
        m.set(ev.inning, (m.get(ev.inning) ?? 0) + runs);
        if (ev.inning > maxInn) maxInn = ev.inning;
      }
      for (const side of ["away", "home"]) {
        const tid = side === "away" ? g.awayTeamId : g.homeTeamId;
        if (teamSet && !teamSet.includes(tid)) continue;
        const tname = side === "away" ? g.awayTeam.shortName ?? g.awayTeam.name : g.homeTeam.shortName ?? g.homeTeam.name;
        if (!innMap.has(tname)) innMap.set(tname, { teamId: tid, team: tname, byInning: /* @__PURE__ */ new Map() });
        const acc = innMap.get(tname);
        for (const [inn, r10] of per[side]) acc.byInning.set(inn, (acc.byInning.get(inn) ?? 0) + r10);
      }
    }
    const rows2 = [...innMap.values()].map((t) => ({
      ...t,
      innings: Array.from({ length: maxInn }, (_, i) => t.byInning.get(i + 1) ?? 0),
      total: [...t.byInning.values()].reduce((a, b) => a + b, 0)
    })).sort((a, b) => b.total - a.total);
    return res.json({ dataset, innings: { maxInn, rows: rows2 }, gamesCount: games.length });
  }
  const buckets = /* @__PURE__ */ new Map();
  const bucketOf = (key, label) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, b = { label, bat: /* @__PURE__ */ new Map(), pit: /* @__PURE__ */ new Map(), fld: /* @__PURE__ */ new Map() });
    return b;
  };
  const batAccOf = (b, pid) => {
    let l = b.bat.get(pid);
    if (!l) b.bat.set(pid, l = newBat());
    return l;
  };
  const pitAccOf = (b, pid) => {
    let l = b.pit.get(pid);
    if (!l) b.pit.set(pid, l = newPit());
    return l;
  };
  const fldAccOf = (b, pid) => {
    let l = b.fld.get(pid);
    if (!l) b.fld.set(pid, l = newFld());
    return l;
  };
  const plays = [];
  const PLAYS_CAP = 800;
  for (const g of games) {
    const evs = await loadEvents(g.id);
    const lus = await prisma.lineupEntry.findMany({
      where: { gameId: g.id, order: { lt: 50 } },
      select: { playerId: true, order: true }
    });
    const orderOf = new Map(lus.map((l) => [l.playerId, l.order]));
    const batTeam = (half) => half === "TOP" ? g.awayTeamId : g.homeTeamId;
    const fieldTeam = (half) => half === "TOP" ? g.homeTeamId : g.awayTeamId;
    const tName = (tid) => tid === g.awayTeamId ? g.awayTeam.shortName ?? g.awayTeam.name : g.homeTeam.shortName ?? g.homeTeam.name;
    const gameLabel = `${tName(g.awayTeamId)} @ ${tName(g.homeTeamId)} ${String(g.date).slice(0, 10)}`;
    let st = initialState();
    const reach = /* @__PURE__ */ new Map();
    const keyOf = (ev, role, pid) => {
      switch (groupBy) {
        case "inning":
          return { key: `I${ev.inning}`, label: `Entrada ${ev.inning}` };
        case "month":
          return { key: `M${String(g.date).slice(0, 7)}`, label: String(g.date).slice(0, 7) };
        case "game":
          return { key: `G${g.id}`, label: gameLabel };
        case "order": {
          const o = orderOf.get(pid ?? ev.batterId ?? "") ?? 0;
          return { key: `O${o}`, label: `Turno ${o || "?"}` };
        }
        case "season": {
          const y = g.league?.year ?? String(g.date).slice(0, 4);
          return { key: `Y${y}`, label: `Temporada ${y}` };
        }
        case "venue": {
          const mine = role === "bat" ? batTeam(ev.half) : fieldTeam(ev.half);
          return mine === g.homeTeamId ? { key: "H", label: "En casa" } : { key: "A", label: "De visita" };
        }
        case "vs": {
          const n = role === "bat" ? tName(fieldTeam(ev.half)) : tName(batTeam(ev.half));
          return { key: `V${n}`, label: `vs ${n}` };
        }
        case "counterpart": {
          const p = role === "bat" ? ev.pitcherId : ev.batterId;
          return { key: `P${p}`, label: `P:${p}` };
        }
        default:
          return { key: `P${pid ?? (role === "pit" ? ev.pitcherId : ev.batterId)}`, label: `P:${pid ?? ev.batterId}` };
      }
    };
    const pass = (ev, before) => {
      if (f.half && ev.half !== f.half) return false;
      if (f.inningFrom && ev.inning < f.inningFrom) return false;
      if (f.inningTo && ev.inning > f.inningTo) return false;
      if (f.results?.length && !f.results.includes(ev.result)) return false;
      if (f.order && orderOf.get(ev.batterId ?? "") !== f.order) return false;
      if (f.homeAway && (ev.half === "TOP" ? "away" : "home") !== f.homeAway) return false;
      if (vsSet) {
        const opp = dataset === "pitching" ? batTeam(ev.half) : fieldTeam(ev.half);
        if (!vsSet.includes(opp)) return false;
      }
      if (f.bases || f.twoOuts) {
        const r1 = !!before.bases[1], r22 = !!before.bases[2], r32 = !!before.bases[3];
        if (f.twoOuts && before.outs !== 2) return false;
        if (f.bases === "empty" && (r1 || r22 || r32)) return false;
        if (f.bases === "any" && !(r1 || r22 || r32)) return false;
        if (f.bases === "risp" && !(r22 || r32)) return false;
        if (f.bases === "loaded" && !(r1 && r22 && r32)) return false;
      }
      return true;
    };
    for (const ev of evs) {
      const before = st;
      const battersInvolved = /* @__PURE__ */ new Set();
      if (ev.batterId) battersInvolved.add(ev.batterId);
      for (const a of ev.advances) battersInvolved.add(a.playerId);
      const fielders = dataset === "fielding" ? /* @__PURE__ */ new Set([...ev.putouts ?? [], ...ev.assists ?? [], ...ev.errorOn ?? []]) : null;
      const subjectOk = dataset === "pitching" ? (!f.playerId || ev.pitcherId === f.playerId) && (!f.pitcherId || ev.batterId === f.pitcherId) : dataset === "fielding" ? !f.playerId || fielders.has(f.playerId) : (!f.playerId || battersInvolved.has(f.playerId)) && (!f.pitcherId || ev.pitcherId === f.pitcherId);
      const teamOk = !teamSet || (dataset === "pitching" || dataset === "fielding" ? teamSet.includes(fieldTeam(ev.half)) : teamSet.includes(batTeam(ev.half)));
      if (subjectOk && teamOk && pass(ev, before)) {
        if (dataset === "plays") {
          if (plays.length < PLAYS_CAP) {
            const occ = [before.bases[1], before.bases[2], before.bases[3]].map((x) => x ? "\u25C6" : "\u25C7").join("");
            plays.push({
              gameId: g.id,
              game: gameLabel,
              date: g.date,
              seq: ev.seq,
              inning: ev.inning,
              half: ev.half,
              outs0: before.outs,
              bases0: occ,
              batterId: ev.batterId,
              pitcherId: ev.pitcherId,
              order: orderOf.get(ev.batterId ?? "") ?? null,
              result: ev.result,
              notation: ev.notation,
              runs: ev.advances.filter((a) => a.to === "HOME").length,
              outs: ev.advances.filter((a) => a.to === "OUT").length
            });
          }
        } else if (dataset === "batting") {
          if (!isMidResult(ev.result) && ev.batterId && (!f.playerId || ev.batterId === f.playerId)) {
            const { key, label } = keyOf(ev, "bat");
            const l = batAccOf(bucketOf(key, label), ev.batterId);
            const rr = ev.result;
            l.pa += 1;
            if (HIT_SET.has(rr)) {
              l.h += 1;
              l.ab += 1;
              if (rr === "2B" || rr === "2BE") l.d2 += 1;
              if (rr === "3B" || rr === "3BE") l.d3 += 1;
              if (rr === "HR" || rr === "HRIP") l.hr += 1;
            } else if (rr === "BB" || rr === "IBB") l.bb += 1;
            else if (rr === "HBP") l.hbp += 1;
            else if (rr === "SF") l.sf += 1;
            else if (rr === "SAC") l.sac += 1;
            else if (rr === "CI" || rr === "OOT") l.pa -= 1;
            else {
              l.ab += 1;
              if (rr === "K" || rr === "KWP" || rr === "KPB") l.k += 1;
            }
            for (const a of ev.advances) {
              if (a.to !== "HOME") continue;
              if (a.playerId === ev.batterId) l.r += 1;
              else {
                const rk = groupBy === "player" ? keyOf(ev, "bat", a.playerId) : { key, label };
                batAccOf(bucketOf(rk.key, rk.label), a.playerId).r += 1;
              }
              if (!NO_RBI_R.has(rr)) l.rbi += 1;
            }
          } else {
            if (ev.result === "SB") {
              for (const a of ev.advances) {
                if (a.to === "OUT" || f.playerId && a.playerId !== f.playerId) continue;
                const { key, label } = keyOf(ev, "bat", groupBy === "player" ? a.playerId : ev.batterId);
                batAccOf(bucketOf(key, label), a.playerId).sb += 1;
              }
            }
            if (ev.result === "RBI" && ev.batterId && (!f.playerId || ev.batterId === f.playerId)) {
              const { key, label } = keyOf(ev, "bat");
              const l = batAccOf(bucketOf(key, label), ev.batterId);
              l.rbi = Math.max(0, l.rbi + (ev.notation === "-" ? -1 : 1));
            }
          }
        } else if (dataset === "fielding") {
          for (const [arr, fl] of [[ev.putouts, "po"], [ev.assists, "a"], [ev.errorOn, "e"]]) {
            for (const pid of arr ?? []) {
              if (f.playerId && pid !== f.playerId) continue;
              const { key, label } = keyOf(ev, "bat", pid);
              fldAccOf(bucketOf(key, label), pid)[fl] += 1;
            }
          }
        } else if (dataset === "pitching" && ev.pitcherId) {
          const { key, label } = keyOf(ev, "pit");
          const l = pitAccOf(bucketOf(key, label), ev.pitcherId);
          const outsOnPlay = ev.advances.filter((a) => a.to === "OUT").length;
          if (!isMidResult(ev.result) && !["CI", "OOT"].includes(ev.result)) {
            l.bf += 1;
            if (!["BB", "IBB", "HBP", "SAC", "SF"].includes(ev.result)) l.aba += 1;
          }
          l.outs += outsOnPlay;
          if (HIT_SET.has(ev.result)) l.h += 1;
          if (ev.result === "HR" || ev.result === "HRIP") l.hr += 1;
          if (ev.result === "BB" || ev.result === "IBB") l.bb += 1;
          if (ev.result === "K" || ev.result === "KWP" || ev.result === "KPB") l.k += 1;
          if (["B", "S", "F", "WP", "PB", "BK", "IPL", "EF"].includes(ev.result) || !isMidResult(ev.result)) l.pitches += 1;
          const playHadError = ev.result === "E" || !!ev.errorOn?.length || ["1BE", "2BE", "3BE"].includes(ev.result);
          for (const a of ev.advances) {
            if (a.to !== "HOME") continue;
            const rec = reach.get(a.playerId);
            const chargeTo = rec?.pitcherId ?? ev.pitcherId;
            if (!chargeTo) continue;
            const cb = groupBy === "player" ? keyOf(ev, "pit", chargeTo) : { key, label };
            const cl = pitAccOf(bucketOf(cb.key, cb.label), chargeTo);
            cl.r += 1;
            if (!playHadError && !UNER_REACH.has(rec?.res ?? "")) {
              cl.er += 1;
              cl.erW += g.innings;
            }
          }
        }
      }
      if (ev.batterId && ev.advances.some((a) => a.playerId === ev.batterId && a.to !== "OUT" && a.to !== "HOME")) {
        reach.set(ev.batterId, { res: ev.result, pitcherId: ev.pitcherId });
      }
      const advHadErr = ev.result === "E" || !!ev.errorOn?.length || ["1BE", "2BE", "3BE", "PB", "BK", "IPL", "DE", "CI", "INT", "OBS"].includes(ev.result) || /E-?\d/.test(ev.notation ?? "");
      if (advHadErr) {
        const midErr = isMidResult(ev.result);
        const defs = midErr || !ev.batterId ? null : defaultAdvances(st, ev.batterId, ev.result);
        for (const a of ev.advances) {
          if (a.to === "OUT" || a.to === "HOME" || a.playerId === ev.batterId) continue;
          if (!midErr && typeof a.to === "number") {
            const nat = defs?.find((d) => d.playerId === a.playerId)?.to;
            if (typeof nat === "number" && a.to <= nat) continue;
          }
          const prev = reach.get(a.playerId);
          reach.set(a.playerId, { res: "E", pitcherId: prev?.pitcherId ?? ev.pitcherId });
        }
      }
      if (ev.result === "GR" || ev.result === "ADJ") {
        for (const a of ev.advances) {
          if (a.to !== "OUT" && a.to !== "HOME") reach.set(a.playerId, { res: ev.result, pitcherId: ev.result === "GR" ? ev.pitcherId : null });
        }
      }
      st = applyEvent(st, ev, g.innings);
      const onBase = new Set([st.bases[1], st.bases[2], st.bases[3]].filter(Boolean));
      for (const pid of [...reach.keys()]) if (!onBase.has(pid)) reach.delete(pid);
    }
    const statLines = g.statLines ?? [];
    const lineOnlyFilters = f.half || f.inningFrom || f.inningTo || f.results?.length || f.bases || f.twoOuts || f.pitcherId;
    if (!evs.length && statLines.length && !lineOnlyFilters && dataset !== "plays") {
      const keyOfLine = (pid, tid) => {
        switch (groupBy) {
          case "inning":
          case "counterpart":
            return null;
          // sin ese detalle en líneas importadas
          case "month":
            return { key: `M${String(g.date).slice(0, 7)}`, label: String(g.date).slice(0, 7) };
          case "game":
            return { key: `G${g.id}`, label: gameLabel };
          case "order": {
            const o = orderOf.get(pid) ?? 0;
            return { key: `O${o}`, label: `Turno ${o || "?"}` };
          }
          case "season": {
            const y = g.league?.year ?? String(g.date).slice(0, 4);
            return { key: `Y${y}`, label: `Temporada ${y}` };
          }
          case "venue":
            return tid === g.homeTeamId ? { key: "H", label: "En casa" } : { key: "A", label: "De visita" };
          case "vs": {
            const n = tid === g.awayTeamId ? g.homeTeam.shortName ?? g.homeTeam.name : g.awayTeam.shortName ?? g.awayTeam.name;
            return { key: `V${n}`, label: `vs ${n}` };
          }
          default:
            return { key: `P${pid}`, label: `P:${pid}` };
        }
      };
      for (const ln of statLines) {
        if (f.playerId && ln.playerId !== f.playerId) continue;
        if (f.order && orderOf.get(ln.playerId) !== f.order) continue;
        if (f.homeAway && (ln.teamId === g.homeTeamId ? "home" : "away") !== f.homeAway) continue;
        if (teamSet && !teamSet.includes(ln.teamId ?? "")) continue;
        if (vsSet && !vsSet.includes(ln.teamId === g.awayTeamId ? g.homeTeamId : g.awayTeamId)) continue;
        const k = keyOfLine(ln.playerId, ln.teamId);
        if (!k) continue;
        const bk = bucketOf(k.key, k.label);
        if (dataset === "batting") {
          const l = batAccOf(bk, ln.playerId);
          l.pa += ln.pa ?? 0;
          l.ab += ln.ab ?? 0;
          l.r += ln.r ?? 0;
          l.h += ln.h ?? 0;
          l.d2 += ln.doubles ?? 0;
          l.d3 += ln.triples ?? 0;
          l.hr += ln.hr ?? 0;
          l.rbi += ln.rbi ?? 0;
          l.bb += ln.bb ?? 0;
          l.k += ln.k ?? 0;
          l.hbp += ln.hbp ?? 0;
          l.sac += ln.sac ?? 0;
          l.sf += ln.sf ?? 0;
          l.sb += ln.sb ?? 0;
        } else if (dataset === "pitching") {
          if ((ln.gp ?? 0) || (ln.pOuts ?? 0)) {
            const l = pitAccOf(bk, ln.playerId);
            l.outs += ln.pOuts ?? 0;
            l.h += ln.pH ?? 0;
            l.r += ln.pR ?? 0;
            l.er += ln.pER ?? 0;
            l.bb += ln.pBB ?? 0;
            l.k += ln.pK ?? 0;
            l.hr += ln.pHR ?? 0;
            l.pitches += ln.pPitches ?? 0;
            l.bf += ln.bf ?? 0;
            l.aba += (ln.pOuts ?? 0) + (ln.pH ?? 0);
            l.erW += (ln.pER ?? 0) * g.innings;
          }
        } else if (dataset === "fielding") {
          const l = fldAccOf(bk, ln.playerId);
          l.po += ln.po ?? 0;
          l.a += ln.a ?? 0;
          l.e += ln.e ?? 0;
        }
      }
    }
  }
  if (dataset === "plays") {
    const ids = /* @__PURE__ */ new Set();
    for (const p of plays) {
      if (p.batterId) ids.add(p.batterId);
      if (p.pitcherId) ids.add(p.pitcherId);
    }
    const ps = await prisma.player.findMany({ where: { id: { in: [...ids] } }, select: { id: true, firstName: true, lastName: true, number: true } });
    const names = Object.fromEntries(ps.map((p) => [p.id, `${p.number ? `#${p.number} ` : ""}${p.lastName}`]));
    return res.json({ dataset, plays, names, truncated: plays.length >= PLAYS_CAP });
  }
  const idRows = [...buckets.keys()].filter((k) => k.startsWith("P")).map((k) => k.slice(1));
  const pids = new Set(idRows);
  for (const b of buckets.values()) {
    for (const pid of b.bat.keys()) pids.add(pid);
    for (const pid of b.pit.keys()) pids.add(pid);
    for (const pid of b.fld.keys()) pids.add(pid);
  }
  const pnames = new Map(
    (await prisma.player.findMany({ where: { id: { in: [...pids] } }, select: { id: true, firstName: true, lastName: true, number: true } })).map((p) => [p.id, `${p.number ? `#${p.number} ` : ""}${p.firstName[0]}. ${p.lastName}`])
  );
  const nameOf = (pid) => pnames.get(pid) ?? pid;
  const rows = [];
  for (const [key, b] of buckets) {
    const glabel = key.startsWith("P") ? nameOf(key.slice(1)) : b.label;
    if (dataset === "batting") {
      for (const [pid, l] of b.bat) {
        if (l.pa === 0 && l.sb === 0) continue;
        const singles = l.h - l.d2 - l.d3 - l.hr;
        const tb = singles + l.d2 * 2 + l.d3 * 3 + l.hr * 4;
        const slg = l.ab ? tb / l.ab : 0;
        const obp = obpOf(l.h, l.bb, l.hbp, l.ab, l.sf);
        const avg = l.ab ? l.h / l.ab : 0;
        const wobaDen = l.ab + l.bb + l.sf + l.hbp;
        rows.push({
          key,
          group: glabel,
          playerId: pid,
          player: nameOf(pid),
          ...l,
          singles,
          avg: f32(avg),
          obp,
          slg: f32(slg),
          ops: f32(obp + slg),
          iso: f32(slg - avg),
          babip: f32(l.ab - l.k - l.hr + l.sf ? (l.h - l.hr) / (l.ab - l.k - l.hr + l.sf) : 0),
          woba: f32(wobaDen ? (0.69 * l.bb + 0.72 * l.hbp + 0.88 * singles + 1.25 * l.d2 + 1.59 * l.d3 + 2.08 * l.hr) / wobaDen : 0),
          bbPct: f32(l.pa ? l.bb / l.pa : 0),
          kPct: f32(l.pa ? l.k / l.pa : 0),
          rc: f32(l.ab + l.bb + l.hbp ? (l.h + l.bb + l.hbp) * tb / (l.ab + l.bb + l.hbp) : 0)
        });
      }
    } else if (dataset === "fielding") {
      for (const [pid, l] of b.fld) {
        const tc = l.po + l.a + l.e;
        rows.push({
          key,
          group: glabel,
          playerId: pid,
          player: nameOf(pid),
          ...l,
          tc,
          fpct: tc ? f32((l.po + l.a) / tc) : 0
        });
      }
    } else {
      for (const [pid, l] of b.pit) {
        const ip = l.outs / 3;
        rows.push({
          key,
          group: glabel,
          playerId: pid,
          player: nameOf(pid),
          ...l,
          ip: f32(ip),
          era: f32(ip ? l.erW * 3 / l.outs : 0),
          whip: f32(ip ? (l.bb + l.h) / ip : 0),
          k9: f32(ip ? l.k * 9 / ip : 0),
          // sabermetría de pitcheo
          bb9: f32(ip ? l.bb * 9 / ip : 0),
          h9: f32(ip ? l.h * 9 / ip : 0),
          hr9: f32(ip ? l.hr * 9 / ip : 0),
          kbb: f32(l.bb ? l.k / l.bb : l.k),
          fip: f32(ip ? (13 * l.hr + 3 * l.bb - 2 * l.k) / ip + 3.2 : 0),
          baa: f32(l.aba ? l.h / l.aba : 0),
          pip: f32(ip ? l.pitches / ip : 0)
        });
      }
    }
  }
  rows.sort((a, b2) => String(a.group).localeCompare(String(b2.group)) || String(a.player).localeCompare(String(b2.player)));
  res.json({ dataset, rows, gamesCount: games.length });
});
var SQL_BANNED = /\b(insert|update|delete|drop|create|alter|truncate|replace|grant|revoke|call|handler|lock|unlock|rename|load_file|outfile|dumpfile|shutdown|kill|install|uninstall|prepare|execute\s+immediate|deallocate|set\s+(?!local)|use\s|begin|commit|rollback|xa\s|savepoint)\b/i;
var stripSql = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/#[^\n]*/g, " ").replace(/'([^'\\]|\\.|'')*'/g, "''").replace(/"([^"\\]|\\.)*"/g, '""').replace(/`([^`]|``)*`/g, "``");
var sqlScalar = (v) => {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString("hex").slice(0, 24)}\u2026`;
  return v;
};
r5.post("/sql", async (req, res) => {
  const sql = String(req.body?.sql ?? "").trim();
  if (!sql) return res.status(400).json({ error: "Consulta vac\xEDa" });
  const orig = sql.replace(/;+\s*$/, "");
  const clean = stripSql(sql).trim().replace(/;+\s*$/, "");
  if (!/^(select|with|show|describe|desc|explain)\b/i.test(clean))
    return res.status(400).json({ error: "Solo lectura: la consulta debe empezar con SELECT, WITH, SHOW, DESCRIBE o EXPLAIN" });
  if (clean.includes(";")) return res.status(400).json({ error: "Una sola sentencia por consulta" });
  if (SQL_BANNED.test(clean))
    return res.status(400).json({ error: "Solo lectura \u2014 esa instrucci\xF3n no est\xE1 permitida" });
  const t0 = Date.now();
  try {
    const rows = await prisma.$transaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe("SET SESSION MAX_EXECUTION_TIME=15000");
      } catch {
      }
      return await tx.$queryRawUnsafe(orig);
    }, { timeout: 2e4 });
    const list = Array.isArray(rows) ? rows : [rows];
    const truncated = list.length > 1e3;
    const data = (truncated ? list.slice(0, 1e3) : list).map((row) => Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, sqlScalar(v)])));
    res.json({ columns: data.length ? Object.keys(data[0]) : [], rows: data, truncated, ms: Date.now() - t0 });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message.split("\n").pop() : "Error de SQL" });
  }
});
var STAT_NUMS = [
  "g",
  "pa",
  "ab",
  "r",
  "h",
  "doubles",
  "triples",
  "hr",
  "rbi",
  "bb",
  "k",
  "hbp",
  "sac",
  "sf",
  "sb",
  "gp",
  "gs",
  "w",
  "l",
  "sv",
  "hld",
  "bs",
  "cg",
  "sho",
  "pOuts",
  "pH",
  "pR",
  "pER",
  "pBB",
  "pK",
  "pHR",
  "pPitches",
  "e"
];
r5.post("/merge-player", async (req, res) => {
  try {
    const { removeId, keepId } = req.body;
    if (!removeId || !keepId) return res.status(400).json({ error: "faltan removeId/keepId" });
    if (removeId === keepId) return res.status(400).json({ error: "son el mismo jugador" });
    const [bye, stay] = await Promise.all([
      prisma.player.findUnique({ where: { id: removeId }, include: { team: true } }),
      prisma.player.findUnique({ where: { id: keepId }, include: { team: true } })
    ]);
    if (!bye || !stay) return res.status(404).json({ error: "jugador no encontrado" });
    await autoBackup("antes de fusionar jugador");
    const moved = {};
    const statRows = await prisma.playerSeasonStat.findMany({ where: { playerId: removeId } });
    for (const row of statRows) {
      const data = {};
      for (const k of STAT_NUMS) data[k] = row[k] ?? 0;
      await prisma.playerSeasonStat.upsert({
        where: { playerId_season_scope: { playerId: keepId, season: row.season, scope: row.scope } },
        create: { playerId: keepId, season: row.season, scope: row.scope, ...data },
        update: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { increment: v }]))
      });
      await prisma.playerSeasonStat.delete({ where: { id: row.id } });
    }
    moved.stats = statRows.length;
    moved.lineups = (await prisma.lineupEntry.updateMany({ where: { playerId: removeId }, data: { playerId: keepId } })).count;
    moved.comoBate = (await prisma.gameEvent.updateMany({ where: { batterId: removeId }, data: { batterId: keepId } })).count;
    moved.comoLanza = (await prisma.gameEvent.updateMany({ where: { pitcherId: removeId }, data: { pitcherId: keepId } })).count;
    for (const col of ["errorOn", "putouts", "assists"]) {
      const evs = await prisma.gameEvent.findMany({
        where: { [col]: { contains: removeId } },
        select: { id: true, errorOn: true, putouts: true, assists: true }
      });
      for (const ev of evs) {
        const arr = JSON.parse(ev[col]).map((x) => x === removeId ? keepId : x);
        await prisma.gameEvent.update({
          where: { id: ev.id },
          data: { [col]: JSON.stringify([...new Set(arr)]) }
        });
      }
      moved[col] = evs.length;
    }
    const advRows = await prisma.$queryRaw`
      SELECT id FROM gameevent
      WHERE JSON_SEARCH(advances, 'one', ${removeId}, NULL, '$[*].playerId') IS NOT NULL`;
    for (const { id } of advRows) {
      const ev = await prisma.gameEvent.findUniqueOrThrow({ where: { id }, select: { advances: true } });
      const adv = ev.advances.map((a) => ({ playerId: a.playerId === removeId ? keepId : a.playerId, to: a.to }));
      await prisma.gameEvent.update({ where: { id }, data: { advances: JSON.parse(JSON.stringify(adv)) } });
    }
    moved.advances = advRows.length;
    for (const col of ["wpId", "lpId", "svId"]) {
      moved[col] = (await prisma.game.updateMany({ where: { [col]: removeId }, data: { [col]: keepId } })).count;
    }
    for (const col of ["hldIds", "bsIds"]) {
      const gs = await prisma.game.findMany({
        where: { [col]: { contains: removeId } },
        select: { id: true, hldIds: true, bsIds: true }
      });
      for (const g of gs) {
        const arr = JSON.parse(g[col]).map((x) => x === removeId ? keepId : x);
        await prisma.game.update({ where: { id: g.id }, data: { [col]: JSON.stringify([...new Set(arr)]) } });
      }
      moved[col] = gs.length;
    }
    const slGames = await prisma.$queryRaw`
      SELECT id FROM Game
      WHERE JSON_SEARCH(statLines, 'one', ${removeId}, NULL, '$[*].playerId') IS NOT NULL`;
    for (const { id } of slGames) {
      const g = await prisma.game.findUniqueOrThrow({ where: { id }, select: { statLines: true } });
      const lines = g.statLines.map((l) => l.playerId === removeId ? { ...l, playerId: keepId } : l);
      await prisma.game.update({ where: { id }, data: { statLines: JSON.parse(JSON.stringify(lines)) } });
    }
    moved.statLines = slGames.length;
    const allIds = (await prisma.$queryRaw`
      SELECT id FROM Game
      WHERE JSON_SEARCH(statLines, 'one', ${keepId}, NULL, '$[*].playerId') IS NOT NULL`).map((x) => x.id);
    await consolidateStatLineDupes(allIds);
    const tplTeams = await prisma.team.findMany({ where: { lineupTemplate: { contains: removeId } }, select: { id: true, lineupTemplate: true } });
    for (const t of tplTeams) {
      const tpl = JSON.parse(t.lineupTemplate).map((x) => x.playerId === removeId ? { ...x, playerId: keepId } : x);
      await prisma.team.update({ where: { id: t.id }, data: { lineupTemplate: JSON.stringify(tpl) } });
    }
    moved.plantillas = tplTeams.length;
    await prisma.player.delete({ where: { id: removeId } });
    res.json({
      ok: true,
      moved,
      eliminado: `${bye.firstName} ${bye.lastName}`,
      queda: `${stay.firstName} ${stay.lastName}`
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Error al fusionar" });
  }
});
r5.post("/recalc", async (req, res) => {
  const year = Number(req.body?.year);
  if (!year || !Number.isFinite(year)) return res.status(400).json({ error: "year requerido" });
  const PSS_KEYS = SL_NUMS.filter((k) => !["po", "a", "bf"].includes(k));
  const games = await prisma.game.findMany({
    where: { status: "FINAL" },
    include: { lineups: true, season: true }
  });
  const ofYear = games.filter((g) => (g.season?.year ?? new Date(g.date).getFullYear()) === year);
  const totals = /* @__PURE__ */ new Map();
  for (const g of ofYear) {
    const scope = g.seriesId ? "POST" : "REG";
    for (const [pid, c] of await gameContrib(g)) {
      const key = `${pid}|${scope}`;
      const acc = totals.get(key) ?? {};
      for (const [k, v] of Object.entries(c)) acc[k] = (acc[k] ?? 0) + v;
      totals.set(key, acc);
    }
  }
  const existing = await prisma.playerSeasonStat.findMany({ where: { season: year } });
  const seen = /* @__PURE__ */ new Set();
  let updated = 0, cleared = 0;
  for (const row of existing) {
    const acc = totals.get(`${row.playerId}|${row.scope}`);
    if (acc) {
      seen.add(`${row.playerId}|${row.scope}`);
      await prisma.playerSeasonStat.update({
        where: { id: row.id },
        data: Object.fromEntries(PSS_KEYS.map((k) => [k, acc[k] ?? 0]))
      });
      updated++;
    } else if (row.adj && Object.keys(row.adj).length) {
      await prisma.playerSeasonStat.update({
        where: { id: row.id },
        data: Object.fromEntries(PSS_KEYS.map((k) => [k, 0]))
      });
      cleared++;
    } else {
      await prisma.playerSeasonStat.delete({ where: { id: row.id } });
      cleared++;
    }
  }
  let created = 0;
  for (const [key, acc] of totals) {
    if (seen.has(key)) continue;
    const [playerId, scope] = key.split("|");
    await prisma.playerSeasonStat.create({
      data: { playerId, season: year, scope, ...Object.fromEntries(PSS_KEYS.map((k) => [k, acc[k] ?? 0])) }
    });
    created++;
  }
  const unapplied = ofYear.filter((g) => !g.seasonApplied).map((g) => g.id);
  if (unapplied.length) {
    await prisma.game.updateMany({ where: { id: { in: unapplied } }, data: { seasonApplied: true } });
  }
  res.json({ ok: true, year, games: ofYear.length, updated, created, cleared, markedApplied: unapplied.length });
});
var stats_default = r5;

// src/routes/backup.ts
import { Router as Router6 } from "express";
import fs2 from "node:fs";
import path2 from "node:path";
var r6 = Router6();
r6.get("/export", async (req, res) => {
  const leagueId = req.query.league ? String(req.query.league) : null;
  const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  if (!leagueId) {
    res.setHeader("Content-Disposition", `attachment; filename="poxscore-backup-${stamp}.json"`);
    return res.json(await exportAll());
  }
  const data = await exportLeague(leagueId);
  if (!data) return res.status(404).json({ error: "Liga no encontrada" });
  const safe = data.leagues[0].name.replace(/[^\wáéíóúñü -]+/gi, "").trim().replace(/\s+/g, "-");
  res.setHeader("Content-Disposition", `attachment; filename="poxscore-${safe}-${stamp}.json"`);
  res.json(data);
});
r6.post("/import", async (req, res) => {
  const { imported } = await importBackup(req.body);
  res.json({ ok: true, imported });
});
r6.get("/auto", (_req, res) => {
  const dir = backupDir();
  const files = fs2.existsSync(dir) ? fs2.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse() : [];
  res.json({ dir, files: files.slice(0, 30) });
});
r6.post("/auto", async (_req, res) => {
  await autoBackup("manual");
  const dir = backupDir();
  res.json({ ok: true, dir, files: fs2.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse() });
});
var backupFile = (name) => {
  const safe = path2.basename(String(name ?? ""));
  if (!safe.endsWith(".json") || safe !== String(name ?? "").trim()) return null;
  const fp = path2.join(backupDir(), safe);
  return fs2.existsSync(fp) ? fp : null;
};
r6.post("/restore-preview", async (req, res) => {
  const fp = backupFile(req.body?.file);
  if (!fp) return res.status(404).json({ error: "Respaldo no encontrado en la carpeta de respaldos" });
  const b = JSON.parse(fs2.readFileSync(fp, "utf8"));
  res.json({ file: path2.basename(fp), leagues: previewBackupLeagues(b) });
});
r6.post("/restore-scan", async (req, res) => {
  const name = String(req.body?.league ?? "").trim();
  if (!name) return res.status(400).json({ error: "falta league" });
  const normL = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const dir = backupDir();
  const files = fs2.existsSync(dir) ? fs2.readdirSync(dir).filter((f) => f.startsWith("auto-") && f.endsWith(".json")).sort().reverse() : [];
  const out = [];
  for (const f of files) {
    const fp = path2.join(dir, f);
    try {
      const b = JSON.parse(fs2.readFileSync(fp, "utf8"));
      const info = previewBackupLeagues(b).find((l) => normL(l.name) === normL(name));
      out.push({ file: f, mtime: fs2.statSync(fp).mtime, found: !!info, ...info ?? {} });
    } catch {
      out.push({ file: f, found: false });
    }
  }
  res.json({ league: name, files: out });
});
r6.post("/restore-league", async (req, res) => {
  const auth = await adminOk(String(req.body?.password ?? ""));
  if (!auth.ok) return res.status(auth.code ?? 401).json({ error: auth.error });
  const fp = backupFile(req.body?.file);
  if (!fp) return res.status(404).json({ error: "Respaldo no encontrado en la carpeta de respaldos" });
  const b = JSON.parse(fs2.readFileSync(fp, "utf8"));
  const out = await restoreLeagueFromBackup(b, String(req.body?.league ?? ""));
  res.json({ ok: true, ...out });
});
var backup_default = r6;

// src/routes/publish.ts
import { Router as Router7 } from "express";
import { promises as fs3 } from "fs";
import path3 from "path";
import { Readable } from "stream";
import { Client as FtpClient } from "basic-ftp";
import SftpClient from "ssh2-sftp-client";
var r7 = Router7();
var DATA_DIR = path3.join(process.cwd(), "data");
var PROFILES_FILE = path3.join(DATA_DIR, "ftp-profiles.json");
async function loadProfiles() {
  try {
    return JSON.parse(await fs3.readFile(PROFILES_FILE, "utf8"));
  } catch {
    return [];
  }
}
async function saveProfiles(list) {
  await fs3.mkdir(DATA_DIR, { recursive: true });
  await fs3.writeFile(PROFILES_FILE, JSON.stringify(list, null, 2));
}
var publicProfile = (p) => ({ ...p, pass: p.pass ? "\u2022\u2022\u2022\u2022\u2022\u2022" : "" });
async function withConn(p, log, fn) {
  const say = (m) => {
    log?.push(m);
  };
  const port2 = p.port ?? (p.protocol === "sftp" ? 22 : 21);
  say(`Conectando a ${p.host}:${port2} (${p.protocol.toUpperCase()})\u2026`);
  if (p.protocol === "sftp") {
    const s = new SftpClient();
    s.on("debug", (m) => {
      const x = String(m).trim();
      if (x) say(`SFTP: ${x.slice(0, 200)}`);
    });
    await s.connect({
      host: p.host,
      port: port2,
      username: p.user,
      password: p.pass,
      readyTimeout: 15e3,
      debug: (m) => {
        const x = String(m).trim();
        if (x) say(`SSH: ${x.slice(0, 200)}`);
      }
    });
    say("Conexi\xF3n SSH establecida \u2014 sesi\xF3n SFTP iniciada");
    try {
      const norm4 = (dir, l) => l.map((f) => ({ name: f.name, size: f.size, isDir: f.type === "d", modifiedAt: f.modifyTime ? new Date(f.modifyTime).toISOString() : void 0 }));
      return await fn(
        async (name, buf) => {
          const remote = `${p.remotePath.replace(/\/$/, "")}/${name}`;
          const dir = path3.posix.dirname(remote);
          if (!await s.exists(dir)) {
            say(`MKD ${dir}`);
            await s.mkdir(dir, true);
          }
          say(`PUT ${name} (${buf.length} bytes)`);
          await s.put(buf, remote);
        },
        async (dir) => norm4(dir ?? (p.remotePath || "."), await s.list(dir ?? (p.remotePath || ".")))
      );
    } finally {
      say("Cerrando conexi\xF3n");
      await s.end();
    }
  }
  const ftp = new FtpClient(12e3);
  ftp.ftp.log = (m) => {
    const x = m.trim();
    if (x && !/^PASS /i.test(x)) say(x);
    else if (x) say("PASS ******");
  };
  await ftp.access({
    host: p.host,
    port: port2,
    user: p.user,
    password: p.pass,
    secure: p.protocol === "ftps"
  });
  say(`Sesi\xF3n iniciada \u2014 usuario ${p.user}`);
  try {
    return await fn(
      async (name, buf) => {
        const dir = p.remotePath.replace(/\/$/, "");
        if (dir) {
          say(`CWD ${dir}`);
          await ftp.ensureDir(dir);
        } else {
          say("CWD /");
          await ftp.cd("/");
        }
        say(`STOR ${name} (${buf.length} bytes)`);
        await ftp.uploadFrom(Readable.from(buf), name);
      },
      async (dir) => {
        const l = await ftp.list(dir ?? (p.remotePath || void 0));
        return l.map((f) => ({ name: f.name, size: f.size, isDir: f.isDirectory, modifiedAt: f.modifiedAt?.toISOString() }));
      }
    );
  } finally {
    say("QUIT \u2014 conexi\xF3n cerrada");
    ftp.close();
  }
}
r7.get("/profiles", async (_req, res) => {
  res.json((await loadProfiles()).map(publicProfile));
});
r7.post("/profiles", async (req, res) => {
  const b = req.body;
  if (!b.name || !b.host || !b.user) return res.status(400).json({ error: "name, host y user requeridos" });
  const list = await loadProfiles();
  if (b.id) {
    const i = list.findIndex((p2) => p2.id === b.id);
    if (i < 0) return res.status(404).json({ error: "Perfil no existe" });
    list[i] = {
      ...list[i],
      name: b.name,
      host: b.host,
      user: b.user,
      protocol: b.protocol ?? "ftp",
      port: b.port,
      remotePath: b.remotePath ?? "/",
      pass: b.pass && b.pass !== "\u2022\u2022\u2022\u2022\u2022\u2022" ? b.pass : list[i].pass
      // no enviar pass = conservar
    };
    await saveProfiles(list);
    return res.json(publicProfile(list[i]));
  }
  const p = {
    id: `ftp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: b.name,
    host: b.host,
    user: b.user,
    pass: b.pass ?? "",
    protocol: b.protocol ?? "ftp",
    port: b.port,
    remotePath: b.remotePath ?? "/"
  };
  list.push(p);
  await saveProfiles(list);
  res.json(publicProfile(p));
});
r7.delete("/profiles/:id", async (req, res) => {
  const list = await loadProfiles();
  await saveProfiles(list.filter((p) => p.id !== req.params.id));
  res.json({ ok: true });
});
r7.post("/test", async (req, res) => {
  const p = await resolveProfile(req.body);
  if (!p) return res.status(400).json({ error: "Perfil o datos de conexi\xF3n requeridos" });
  const log = [];
  try {
    const files = await withConn(p, log, (_up, list) => list());
    res.json({ ok: true, files: files.length, log });
  } catch (e) {
    res.status(502).json({ ok: false, error: e instanceof Error ? e.message : "No conect\xF3", log });
  }
});
r7.post("/connect", async (req, res) => {
  const p = await resolveProfile(req.body);
  if (!p) return res.status(400).json({ error: "Perfil o datos de conexi\xF3n requeridos" });
  const log = [];
  try {
    const files = await withConn(p, log, (_up, list) => list());
    res.json({ ok: true, path: p.remotePath || "/", files, log });
  } catch (e) {
    res.status(502).json({ ok: false, error: e instanceof Error ? e.message : "No conect\xF3", log });
  }
});
r7.post("/upload", async (req, res) => {
  const { profileId, files } = req.body;
  const p = await resolveProfile(req.body);
  if (!p) return res.status(400).json({ error: "Perfil requerido" });
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: "files[] requerido" });
  const log = [];
  try {
    const uploaded = await withConn(p, log, async (up) => {
      const names = [];
      for (const f of files) {
        const buf = f.base64 ? Buffer.from(f.content, "base64") : Buffer.from(f.content, "utf8");
        await up(f.name, buf);
        names.push(f.name);
      }
      return names;
    });
    res.json({ ok: true, uploaded, log });
  } catch (e) {
    res.status(502).json({ ok: false, error: e instanceof Error ? e.message : "Fall\xF3 la subida", log });
  }
});
r7.post("/publish-league", async (req, res) => {
  const { profileId, leagueId } = req.body;
  if (!leagueId) return res.status(400).json({ error: "leagueId requerido" });
  const p = await resolveProfile({ profileId });
  if (!p) return res.status(400).json({ error: "profileId requerido" });
  const html = await websiteHtml(leagueId);
  if (!html) return res.status(404).json({ error: "Liga no encontrada" });
  const log = [];
  try {
    await withConn(p, log, async (up) => {
      await up("index.html", Buffer.from(html, "utf8"));
    });
    res.json({ ok: true, file: "index.html", bytes: html.length, log });
  } catch (e) {
    res.status(502).json({ ok: false, error: e instanceof Error ? e.message : "Fall\xF3 la subida", log });
  }
});
async function resolveProfile(b) {
  if (b.profileId) {
    const p = (await loadProfiles()).find((x) => x.id === b.profileId);
    return p ?? null;
  }
  if (b.host && b.user) {
    return {
      id: "",
      name: "",
      protocol: b.protocol ?? "ftp",
      host: b.host,
      port: b.port,
      user: b.user,
      pass: b.pass ?? "",
      remotePath: b.remotePath ?? "/"
    };
  }
  return null;
}
var publish_default = r7;

// src/routes/import.ts
import { Router as Router8 } from "express";
import AdmZip2 from "adm-zip";

// src/import/boxfile.ts
var expandTabs = (line, stop = 8) => {
  let out = "";
  for (const ch of line) {
    if (ch === "	") out += " ".repeat(stop - out.length % stop);
    else out += ch.charCodeAt(0) === 160 ? " " : ch;
  }
  return out;
};
function toLines(txt) {
  return txt.split(/\r?\n/).map((l) => expandTabs(l).trimEnd()).filter((l) => l.trim().length);
}
function rtfLogicalLines(raw) {
  let s = raw.replace(/\\'([0-9a-fA-F]{2})/g, (_m, h) => Buffer.from([parseInt(h, 16)]).toString("latin1"));
  s = s.replace(/\{\\fonttbl[^}]*\}?/g, "");
  return s.split(/\\par[d]?\s?/).map((seg) => {
    const t = seg.replace(/\\[a-zA-Z]+-?\d* ?/g, "").replace(/[{}\\]/g, "").replace(/\r?\n/g, "");
    return t.replace(/\s+$/g, "");
  }).filter((l) => l.trim().length);
}
var boxLines = (txt) => txt.includes("{\\rtf") ? rtfLogicalLines(txt) : toLines(txt);
var MESES = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  augosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11
};
var NAME_CHARS = "A-Za-z\xC1\xC9\xCD\xD3\xDA\xD1\xDC\xE1\xE9\xED\xF3\xFA\xF1\xFC' .\\-,";
var NAME_CHARS_ROW = NAME_CHARS + "()0-9";
var POS_RE = /^(P|C|1B|2B|3B|SS|LF|CF|RF|DH|EH|PH|PR|OF|IF|JC|BC|BD)(-(P|C|1B|2B|3B|SS|LF|CF|RF|DH|EH|OF|IF|JC))*$/i;
var DEC_RE = /\((W|L|S|H|BS)(?:\s*,?\s*[\d.-]+)?\)\s*$/i;
var COL_ALIASES = {
  ab: "ab",
  pa: "pa",
  r: "r",
  h: "h",
  bi: "rbi",
  rbi: "rbi",
  ci: "rbi",
  "2b": "doubles",
  "3b": "triples",
  hr: "hr",
  bb: "bb",
  ibb: "_skip",
  so: "k",
  k: "k",
  sb: "sb",
  cs: "_skip",
  sh: "sac",
  sac: "sac",
  sf: "sf",
  hbp: "hbp",
  hp: "hbp",
  gdp: "_skip",
  dp: "_skip",
  lob: "_skip",
  e: "e",
  po: "po",
  a: "a",
  tc: "_skip",
  pb: "_skip",
  // pitcheo (las genéricas h/r/bb/so se renombran según sección abajo)
  ip: "pOuts",
  outs: "pOuts",
  er: "pER",
  wp: "_skip",
  bk: "_skip",
  bf: "bf",
  tbf: "bf",
  np: "_skip",
  hb: "_skip",
  hbp2: "_skip",
  cg: "cg",
  sho: "sho"
};
var PIT_REMAP = {
  h: "pH",
  r: "pR",
  er: "pER",
  bb: "pBB",
  k: "pK",
  so: "pK",
  hr: "pHR",
  ab: "_skip",
  rbi: "_skip",
  doubles: "_skip",
  triples: "_skip",
  sb: "_skip",
  sac: "_skip",
  sf: "_skip",
  hbp: "_skip",
  e: "_skip",
  po: "_skip",
  a: "_skip"
};
var SEC_RES = [
  [/batting|bateo|bateador/i, "bat"],
  [/pitching|pitcheo|lanzador/i, "pit"],
  [/fielding|fildeo|defens/i, "fld"]
];
var DEC_LINE = /^(WP|LP|SV|SAVE|GANADOR|PERDEDOR|SALVADO|WINNING\s+PITCHER|LOSING\s+PITCHER|HOLD|HLD)\s*[:.]?\s*(.+)$/i;
var DEC_LINE2 = /^(W|L|S|H|BS)\s*:\s*(.+)$/i;
var outsOf = (ip) => Math.floor(ip) * 3 + Math.round((ip - Math.floor(ip)) * 10);
function colKey(tok, section) {
  const t = tok.toLowerCase();
  if (t === "pos" || t === "player" || t === "jugador" || t === "nombre") return null;
  const base = COL_ALIASES[t] ?? null;
  if (base === null) return "_unknown";
  if (section === "pit" && PIT_REMAP[t] !== void 0) return PIT_REMAP[t];
  return base;
}
var POS_TAIL = /^(p|c|ss|lf|cf|rf|sf|if|of|dh|eh|ph|pr|bc|jc|ud|[1-3]b|s[1-9])$/i;
var isNoName = (name) => POS_TAIL.test(name.replace(/\s+/g, ""));
var BAT_COLS = ["ab", "r", "h", "rbi", "bb", "k", "po", "a", "e", "_lob", "_ave"];
var PIT_COLS = ["pOuts", "pH", "pR", "pER", "pBB", "pK", "_era"];
function parseColPlayer(part) {
  const toks = part.trim().split(/\s+/);
  const ni = toks.findIndex((t) => /^\d[\d.]*$|^\.\d+$/.test(t));
  if (ni <= 0) return null;
  const nums = toks.slice(ni).map((v) => Number(v) || 0);
  if (nums.some((n) => Number.isNaN(n))) return null;
  const nameToks = toks.slice(0, ni);
  const posArr = [];
  while (nameToks.length > 1 && POS_TAIL.test(nameToks[nameToks.length - 1])) posArr.unshift(nameToks.pop());
  const name = nameToks.join(" ").replace(/\s+/g, " ").trim();
  if (!name || !/[A-Za-zÁÉÍÓÚÑÜáéíóúñü]/.test(name)) return null;
  return { name, pos: posArr.length ? posArr.join("-").toUpperCase() : void 0, nums };
}
var isNumTok = (t) => /^\d[\d.]*$|^\.\d+$/.test(t);
function parseRecs(part) {
  const toks = part.trim().split(/\s+/).filter(Boolean);
  const recs = [];
  let i = 0;
  while (i < toks.length && recs.length < 2) {
    const nameT = [];
    while (i < toks.length && !isNumTok(toks[i])) nameT.push(toks[i++]);
    const numToks = [];
    while (i < toks.length && isNumTok(toks[i])) numToks.push(toks[i++]);
    if (!nameT.length || !numToks.length) {
      recs.push(null);
      break;
    }
    const posArr = [];
    while (nameT.length > 1 && POS_TAIL.test(nameT[nameT.length - 1])) posArr.unshift(nameT.pop());
    const name = nameT.join(" ").replace(/\s+/g, " ").trim();
    if (!name || !/[A-Za-zÁÉÍÓÚÑÜáéíóúñü]/.test(name)) {
      recs.push(null);
      break;
    }
    recs.push({
      name,
      pos: posArr.length ? posArr.join("-").toUpperCase() : void 0,
      nums: numToks.map((t) => Number(t) || 0),
      numToks
    });
  }
  return recs;
}
function supEntries(seg) {
  const out = [];
  for (const item of seg.split(",")) {
    const m = item.trim().match(/^([A-Za-zÁÉÍÓÚÑÜáéíóúñü' .0-9-]+?)\s*(?:(\d+)\s*)?(?:\(\d+\))?;?$/);
    if (m) out.push([m[1].replace(/\s*\([A-Za-z]+\)\s*/g, " ").trim(), m[2] ? Number(m[2]) : 1]);
  }
  return out;
}
function parseClassic(lines, warnings) {
  const hi = lines.findIndex((l) => (l.match(/\bPlayer\b/g) ?? []).length >= 2);
  if (hi < 0) return null;
  const col2 = lines[hi].indexOf("Player", 8);
  let away = "", home = "";
  let recAway, recHome;
  const mkRec = (s) => {
    const m = s.match(/\((\d+)-(\d+)\)/);
    return m ? { w: +m[1], l: +m[2] } : void 0;
  };
  for (let i = hi - 1; i >= 0; i--) {
    const recs = [...lines[i].matchAll(/\(\d+-\d+\)/g)];
    if (recs.length >= 2) {
      away = lines[i].slice(0, recs[0].index).trim();
      home = lines[i].slice(recs[0].index + recs[0][0].length, recs[1].index).trim();
      recAway = mkRec(recs[0][0]);
      recHome = mkRec(recs[1][0]);
      break;
    }
    if (recs.length === 1 && !away) {
      away = lines[i].slice(0, col2).replace(/\(\d+-\d+\)/g, "").trim();
      home = lines[i].slice(col2).replace(/\(\d+-\d+\)/g, "").trim();
      recAway = recHome = mkRec(recs[0][0]);
      break;
    }
  }
  if (!away || !home) {
    warnings.push("No se leyeron los equipos del encabezado.");
  }
  const rows = [];
  const batByTeam = /* @__PURE__ */ new Map();
  const sideTeam = (side) => side === 0 ? away : home;
  const addRow = (r10) => {
    rows.push(r10);
    if (r10.section === "bat") {
      const m = batByTeam.get(r10.team) ?? /* @__PURE__ */ new Map();
      m.set(normName(r10.name), r10);
      batByTeam.set(r10.team, m);
    }
  };
  let li = hi + 1;
  const block = [];
  for (; li < lines.length; li++) {
    const line = lines[li];
    if (/^\s*Totals\b/i.test(line)) break;
    if (line.trim() && /[\dA-Za-zÁÉÍÓÚ]/i.test(line)) block.push(line);
  }
  const logical = [];
  let buf = "", bufRight = false;
  const flush = () => {
    if (buf.trim()) logical.push({ text: buf, right: bufRight });
    buf = "";
    bufRight = false;
  };
  for (const line of block) {
    const col = line.length - line.trimStart().length;
    const startsName = /^[A-Za-zÁÉÍÓÚÑÜ'(]/i.test(line.trim());
    if (!buf) {
      buf = line;
      bufRight = col >= col2 - 8;
      continue;
    }
    const btoks = buf.trim().split(/\s+/);
    const trailingName = !isNumTok(btoks[btoks.length - 1]);
    if (startsName && (col <= 3 || col >= col2 - 8) && !trailingName && (parseRecs(buf)[0]?.nums.length ?? 0) > 0) {
      flush();
      buf = line;
      bufRight = col >= col2 - 8;
      continue;
    }
    buf += " " + line.trim();
  }
  flush();
  for (const lg of logical) {
    const recs = parseRecs(lg.text).filter((r10) => !!r10);
    const off = lg.right ? 1 : 0;
    recs.forEach((r10, idx) => {
      const side = Math.min(off + idx, 1);
      const stats = {};
      for (let i = 0; i < r10.nums.length && i < 9; i++) {
        const k = BAT_COLS[i];
        if (!k.startsWith("_")) stats[k] = (stats[k] ?? 0) + r10.nums[i];
      }
      const nm = r10.name.replace(/\s*\([A-Za-z]+\)\s*/g, " ").replace(/\s+/g, " ").trim();
      if (nm) addRow({ team: sideTeam(side), section: "bat", name: nm, pos: r10.pos, stats, noName: isNoName(nm) || void 0 });
    });
  }
  let scoreAway = 0, scoreHome = 0, innings = 0;
  const lsi = lines.findIndex((l) => {
    const t = l.trim().split(/\s+/);
    const ri = t.findIndex((x) => x === "R");
    return ri >= 3 && t.slice(0, ri).every((x) => /^\d+$/.test(x)) && t[ri + 1] === "H";
  });
  if (lsi >= 0) {
    const toks = lines[lsi].trim().split(/\s+/);
    innings = toks.findIndex((x) => x === "R");
    for (let i = lsi + 1; i < Math.min(lsi + 4, lines.length); i++) {
      const m = lines[i].match(/^\s*([A-ZÁÉÍÓÚÑ' .0-9-]+?)\s+((?:[\dXx-]+\s+)+)(\d+)\s+(\d+)\s+(\d+)\s*$/);
      if (!m) continue;
      const team = m[1].trim();
      const r10 = Number(m[3]);
      if (normName(team) === normName(away)) scoreAway = r10;
      else if (normName(team) === normName(home)) scoreHome = r10;
    }
  }
  const sup = lines.slice(li).join(" ").replace(/\s+/g, " ");
  const findBat = (nm) => {
    const n = normName(nm);
    for (const t of [away, home, ""]) {
      const m = batByTeam.get(t);
      if (!m) continue;
      if (m.has(n)) return m.get(n);
      for (const [k, r10] of m) if (k.length > 2 && n.length > 2 && (k.startsWith(n) || n.startsWith(k))) return r10;
    }
    return void 0;
  };
  for (const m of sup.matchAll(/(2B|3B|HR|SB|SF|CS)-\s*([^;]+);/g)) {
    const key = { "2B": "doubles", "3B": "triples", HR: "hr", SB: "sb", SF: "sf", CS: "_skip" }[m[1]];
    if (key === "_skip") continue;
    for (const [nm, n] of supEntries(m[2])) {
      const row = findBat(nm);
      if (row) {
        row.stats[key] = (row.stats[key] ?? 0) + n;
        if (key === "sf") row.stats.sf = n;
      } else {
        warnings.push(`${m[1]}: \xAB${nm}\xBB solo aparece en las notas \u2014 fila parcial agregada, as\xEDgnale jugador.`);
        addRow({ team: "", section: "bat", name: nm, stats: { [key]: n }, partial: true });
      }
    }
  }
  const pitRows = /* @__PURE__ */ new Map();
  for (let i = li; i < lines.length; i++) {
    const hm = lines[i].match(/^\s*([A-ZÁÉÍÓÚÑ' .0-9-]+?)\s{2,}IP\s+H\s+R\s+ER\s+BB\s+SO/i);
    if (!hm) continue;
    const team = normName(hm[1]) === normName(away) ? away : normName(hm[1]) === normName(home) ? home : hm[1].trim();
    const seenPit = /* @__PURE__ */ new Set();
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*Totals\b/i.test(lines[j]) || /IP\s+H\s+R\s+ER/i.test(lines[j])) break;
      let merged = lines[j];
      while (j + 1 < lines.length && !parseColPlayer(merged) && /[A-Za-zÁÉÍÓÚ]/i.test(merged)) {
        merged += " " + lines[++j].trim();
      }
      const p = parseColPlayer(merged);
      if (!p) break;
      let dec;
      const dm = p.name.match(/\((W|L|S|SV|H|BS)\s*[\d-]*\)/i);
      if (dm) {
        dec = dm[1].toUpperCase() === "SV" ? "S" : dm[1].toUpperCase();
        p.name = p.name.replace(dm[0], "").trim();
      }
      const stats = {};
      for (let k = 0; k < p.nums.length && k < PIT_COLS.length - 1; k++) {
        const key = PIT_COLS[k];
        if (!key.startsWith("_")) stats[key] = (stats[key] ?? 0) + p.nums[k];
      }
      if (stats.pOuts != null) stats.pOuts = outsOf(stats.pOuts);
      const dupKey = `${team}|${normName(p.name)}|${p.nums.join(",")}`;
      if (seenPit.has(dupKey)) continue;
      seenPit.add(dupKey);
      const row = { team, section: "pit", name: p.name, pos: "P", dec, stats };
      rows.push(row);
      pitRows.set(`${team}|${normName(p.name)}`, row);
    }
  }
  for (const m of sup.matchAll(/Pitches-strikes-\s*([^;]+);/gi)) {
    for (const im of m[1].matchAll(/([A-Za-zÁÉÍÓÚÑÜáéíóúñü' .0-9-]+?)\s+(\d+)-\d+/g)) {
      const row = pitRows.get(`${away}|${normName(im[1])}`) ?? pitRows.get(`${home}|${normName(im[1])}`);
      if (row) row.stats.pPitches = Number(im[2]);
    }
  }
  for (const m of sup.matchAll(/Batters faced-\s*([^;]+);/gi)) {
    for (const im of m[1].matchAll(/([A-Za-zÁÉÍÓÚÑÜáéíóúñü' .0-9-]+?)\s+(\d+)/g)) {
      const row = pitRows.get(`${away}|${normName(im[1])}`) ?? pitRows.get(`${home}|${normName(im[1])}`);
      if (row) row.stats.bf = Number(im[2]);
    }
  }
  let wp, lp, sv;
  for (const r10 of rows) {
    if (r10.section !== "pit" || !r10.dec) continue;
    if (r10.dec === "W" && !wp) wp = r10.name;
    if (r10.dec === "L" && !lp) lp = r10.name;
    if (r10.dec === "S" && !sv) sv = r10.name;
  }
  return { dateIso: "", away, home, scoreAway, scoreHome, innings, rows, wp, lp, sv, recAway, recHome, warnings };
}
function parseBoxFile(txt, filename) {
  const lines = boxLines(txt);
  const warnings = [];
  const classic = parseClassic(lines, warnings);
  if (classic) {
    const g = parseBoxFileGeneric(txt, filename, warnings);
    if (g) {
      classic.dateIso = g.dateIso;
      if (!classic.away) classic.away = g.away;
      if (!classic.home) classic.home = g.home;
      if (!classic.scoreAway && !classic.scoreHome) {
        classic.scoreAway = g.scoreAway;
        classic.scoreHome = g.scoreHome;
      }
      if (!classic.innings) classic.innings = g.innings;
      if (!classic.wp) classic.wp = g.wp;
      if (!classic.lp) classic.lp = g.lp;
      if (!classic.sv) classic.sv = g.sv;
      classic.warnings = warnings.filter((w) => !w.includes("l\xEDneas de jugadores"));
    }
    return classic;
  }
  return parseBoxFileGeneric(txt, filename, warnings);
}
function parseBoxFileGeneric(txt, filename, warnings) {
  const lines = boxLines(txt);
  let dateIso = "";
  const dateLine = lines.find((l) => /\d{1,2},\s*\d{4}/.test(l));
  if (dateLine) {
    const m = dateLine.match(/([A-Za-zÁÉÍÓÚñ]+)\s+(\d{1,2}),\s*(\d{4})/i);
    if (m) {
      const mo = MESES[m[1].toLowerCase()];
      if (mo != null) dateIso = `${m[3]}-${String(mo + 1).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
    }
  }
  const FN_RE = /(\d{2})-(\d{2})-(\d{2})\s+(.+?)\s+at\s+(.+?)\.box\.txt$/i;
  const fm = filename?.match(FN_RE);
  let fnAway = "", fnHome = "";
  if (fm) {
    if (!dateIso) dateIso = `20${fm[3]}-${fm[1]}-${fm[2]}`;
    fnAway = fm[4].trim();
    fnHome = fm[5].trim();
  }
  let away = fnAway, home = fnHome, scoreAway = 0, scoreHome = 0, innings = 0;
  const lsIdx = lines.findIndex((l) => {
    const toks = l.trim().split(/\s+/);
    const ri = toks.findIndex((t) => t === "R");
    return ri >= 4 && toks.slice(0, ri).every((t) => /^\d+$|^-$/.test(t));
  });
  if (lsIdx >= 0) {
    const headToks = lines[lsIdx].trim().split(/\s+/);
    const rCol = headToks.findIndex((t) => t === "R");
    innings = headToks.slice(0, rCol).filter((t) => /^\d+$/.test(t)).length;
    const up = (s) => s.trim().toUpperCase();
    for (let i = lsIdx + 1; i < Math.min(lsIdx + 4, lines.length); i++) {
      const m = lines[i].match(new RegExp(`^\\s*([${NAME_CHARS}][${NAME_CHARS}0-9]*?)\\s+((?:[\\dXx-]+\\s+)+)(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*$`, "i"));
      if (!m) continue;
      const team = m[1].trim();
      const r10 = Number(m[3]);
      if (away && up(team) === up(away)) {
        scoreAway = r10;
        continue;
      }
      if (home && up(team) === up(home)) {
        scoreHome = r10;
        continue;
      }
      if (!away) {
        away = team;
        scoreAway = r10;
      } else if (!home) {
        home = team;
        scoreHome = r10;
      } else break;
    }
  }
  if (!away || !home) warnings.push("No se reconoci\xF3 el linescore \u2014 elige los equipos manualmente.");
  let recAway, recHome;
  for (const l of lines) {
    const recs = [...l.matchAll(/\((\d+)-(\d+)\)/g)];
    if (recs.length >= 2) {
      recAway = { w: +recs[0][1], l: +recs[0][2] };
      recHome = { w: +recs[1][1], l: +recs[1][2] };
      break;
    }
  }
  const rows = [];
  let section = null;
  let secTeam = "";
  let cols = [];
  const secCount = { bat: 0, pit: 0, fld: 0 };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    const sm = SEC_RES.map(([re, s]) => line.match(re) ? s : null).find(Boolean);
    if (sm && !/^\d/.test(line)) {
      const headMatch = line.match(new RegExp(`^([${NAME_CHARS}]+?)\\s*(batting|pitching|fielding|bateo|pitcheo|fildeo)`, "i"));
      const tm = headMatch ? headMatch[1].trim() : "";
      const selfName = /^(batting|pitching|fielding|bateo|pitcheo|fildeo|player|jugador)/i.test(tm);
      section = sm;
      secTeam = selfName ? "" : tm;
      secCount[sm]++;
      cols = [];
      const rest = headMatch ? line.slice(headMatch[0].length).trim() : "";
      if (rest) {
        const rtoks = rest.split(/\s+/);
        const firstStat = rtoks.findIndex((t) => COL_ALIASES[t.toLowerCase()] !== void 0 || /^(pos|player|jugador|nombre)$/i.test(t));
        if (firstStat >= 0 && rtoks.some((t) => /^(AB|IP|PO|TB)$/i.test(t))) {
          if (!secTeam && firstStat > 0) secTeam = rtoks.slice(0, firstStat).join(" ");
          cols = rtoks.slice(firstStat).map((t) => colKey(t, section));
        }
      }
      continue;
    }
    if (!section) continue;
    const toks = line.split(/\s+/);
    if (!cols.length && toks.some((t) => /^(AB|IP|PO|TB)$/i.test(t))) {
      const firstStat = toks.findIndex((t) => COL_ALIASES[t.toLowerCase()] !== void 0 || /^(pos|player|jugador|nombre)$/i.test(t));
      if (!secTeam && firstStat > 0) secTeam = toks.slice(0, firstStat).join(" ");
      cols = toks.slice(Math.max(0, firstStat)).map((t) => colKey(t, section));
      continue;
    }
    if (/^totals?\b|^total\b/i.test(line)) continue;
    const rm = line.match(new RegExp(`^([${NAME_CHARS_ROW}]+?)\\s+((?:\\d+\\.?\\d*|x|X)(?:\\s+\\d+\\.?\\d*)*)\\s*$`));
    if (rm && cols.length) {
      let nm = rm[1].trim();
      const dm2 = nm.match(DEC_RE);
      let dec;
      if (dm2) {
        dec = dm2[1].toUpperCase();
        nm = nm.slice(0, dm2.index).trim();
      }
      const ntoks = nm.split(/\s+/);
      let pos;
      if (ntoks.length > 1 && POS_RE.test(ntoks[ntoks.length - 1])) {
        pos = ntoks.pop().toUpperCase();
        nm = ntoks.join(" ");
      }
      const nums = rm[2].split(/\s+/).map((v) => v.toLowerCase() === "x" ? 0 : Number(v) || 0);
      const stats = {};
      const statCols = cols.filter((c) => c !== null);
      for (let i = 0; i < nums.length && i < statCols.length; i++) {
        const k = statCols[i];
        if (!k || k === "_skip" || k === "_unknown") continue;
        stats[k] = (stats[k] ?? 0) + nums[i];
      }
      if (section === "pit" && stats.pOuts != null) stats.pOuts = outsOf(stats.pOuts);
      const team = secTeam || (secCount[section] === 1 ? away : secCount[section] === 2 ? home : "");
      rows.push({ team, section, name: nm, pos, dec, stats, noName: isNoName(nm) || void 0 });
    }
  }
  let wp, lp, sv;
  for (const line of lines) {
    const dm = line.match(DEC_LINE) ?? line.match(DEC_LINE2);
    if (!dm) continue;
    const k = dm[1].toUpperCase().replace(/\s+/g, " ");
    const who = dm[2].trim();
    if (/^(WP|W|GANADOR|WINNING PITCHER)$/.test(k)) wp = who;
    else if (/^(LP|L|PERDEDOR|LOSING PITCHER)$/.test(k)) lp = who;
    else if (/^(SV|S|SAVE|SALVADO)$/.test(k)) sv = who;
  }
  for (const r10 of rows) {
    if (r10.section !== "pit" || !r10.dec) continue;
    if (r10.dec === "W" && !wp) wp = r10.name;
    if (r10.dec === "L" && !lp) lp = r10.name;
    if (r10.dec === "S" && !sv) sv = r10.name;
  }
  if (!rows.length && !away) return null;
  if (!rows.length) warnings.push("El box no trae l\xEDneas de jugadores \u2014 solo se importar\xE1 el marcador.");
  return { dateIso, away, home, scoreAway, scoreHome, innings, rows, wp, lp, sv, recAway, recHome, warnings };
}
var normName = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 9;
  const dp = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return dp[b.length];
}
function fileNameParts(raw) {
  const s = raw.replace(/\s+/g, " ").trim();
  if (s.includes(",")) {
    const [last, first] = s.split(",").map((x) => x.trim());
    return { first: first ?? "", last: last ?? "" };
  }
  const toks = s.split(" ");
  if (toks.length === 1) return { first: "", last: toks[0] };
  if (toks[0].replace(/\./g, "").length === 1) return { first: toks[0].replace(/\./g, ""), last: toks.slice(1).join(" ") };
  return { first: toks.slice(0, -1).join(" "), last: toks[toks.length - 1] };
}
function matchScore(raw, p) {
  const f = fileNameParts(raw);
  const sys = { first: normName(p.firstName), last: normName(p.lastName) };
  const fN = { first: normName(f.first), last: normName(f.last) };
  const sysFull = `${sys.first} ${sys.last}`.trim();
  const fFull = `${fN.first} ${fN.last}`.trim();
  const fFullRev = `${fN.last} ${fN.first}`.trim();
  if (fFull && fFull === sysFull) return 100;
  if (fFullRev && fFullRev === sysFull) return 95;
  const fSet = new Set(fFull.split(" ").filter(Boolean));
  const sSet = new Set(sysFull.split(" ").filter(Boolean));
  if (fSet.size && fSet.size === sSet.size && [...fSet].every((t) => sSet.has(t))) return 90;
  if (fN.last && fN.last === sys.last && fN.first && sys.first.startsWith(fN.first[0])) return 85;
  if (fN.first && fN.first === sys.last && fN.last && sys.first.startsWith(fN.last[0])) return 80;
  if (fN.last && fN.last === sys.last && !fN.first) return 70;
  const lastContained = fN.last && (sys.last === fN.last.split(" ")[0] || fN.last.split(" ").includes(sys.last) || sys.last.split(" ").includes(fN.last));
  if (lastContained && fN.first && sys.first.startsWith(fN.first[0])) return 78;
  if (lastContained) return 68;
  if (fFull && lev(fFull, sysFull) <= 2) return 60;
  if (fFullRev && lev(fFullRev, sysFull) <= 2) return 58;
  return 0;
}
function bestMatches(raw, roster, top = 4) {
  return roster.map((p) => ({ playerId: p.id, name: `${p.firstName} ${p.lastName}`, score: matchScore(raw, p) })).filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, top);
}
function bestTeam(raw, teams) {
  const n = normName(raw);
  if (!n) return null;
  const norm4 = teams.map((t) => ({ t, n1: normName(t.name), n2: normName(t.shortName ?? "") }));
  return norm4.find((x) => x.n1 === n || x.n2 === n)?.t ?? norm4.find((x) => x.n1.includes(n) || n.includes(x.n1) || x.n2 && (x.n2.includes(n) || n.includes(x.n2)))?.t ?? norm4.map((x) => ({ t: x.t, d: Math.min(lev(n, x.n1), x.n2 ? lev(n, x.n2) : 9) })).sort((a, b) => a.d - b.d)[0]?.t ?? null;
}

// src/import/pox.ts
var norm2 = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
var normP = (s) => norm2(s).split(" ").filter((t) => t !== "cmb").join(" ");
var stripYear = (s) => normP(s).replace(/\s*(?:19|20)\d{2}$/, "").trim();
function splitName(full) {
  const t = full.trim();
  const i = t.indexOf(",");
  if (i > 0) return { lastName: t.slice(0, i).trim(), firstName: t.slice(i + 1).trim() };
  const sp = t.indexOf(" ");
  return sp < 0 ? { firstName: t, lastName: "" } : { firstName: t.slice(0, sp), lastName: t.slice(sp + 1) };
}
function validatePox(raw) {
  const errors = [];
  const warnings = [];
  if (typeof raw !== "object" || raw === null) return { errors: ["El archivo no es un JSON v\xE1lido"], warnings };
  const f = raw;
  if (f.format && f.format !== "pox-import/1") warnings.push(`formato "${f.format}" \u2014 se intenta leer como pox-import/1`);
  if (!f.league || typeof f.league !== "string") errors.push('falta "league" (nombre de la liga)');
  if (!Array.isArray(f.seasons) || f.seasons.length === 0) errors.push('falta "seasons" (al menos una temporada)');
  for (const [i, s] of (f.seasons ?? []).entries()) {
    if (!Number.isInteger(s.year)) errors.push(`seasons[${i}]: falta "year"`);
    for (const [j, g] of (s.games ?? []).entries()) {
      if (!g.away || !g.home) errors.push(`seasons[${i}].games[${j}]: falta "away"/"home"`);
      const final = g.status !== "SCHEDULED";
      if (final && !g.events?.length && g.scoreAway == null && g.scoreHome == null)
        warnings.push(`${s.year} juego ${j + 1} (${g.away} @ ${g.home}): FINAL sin marcador ni eventos \u2192 0-0`);
    }
  }
  return errors.length ? { errors, warnings } : { file: f, errors, warnings };
}
function previewPox(file, warnings) {
  const teams = /* @__PURE__ */ new Set();
  const players = /* @__PURE__ */ new Set();
  let games = 0;
  let withEvents = 0;
  for (const s of file.seasons) {
    for (const t of s.teams ?? []) teams.add(norm2(t.name));
    for (const p of s.players ?? []) {
      players.add(normP(p.name));
      teams.add(norm2(p.team));
    }
    for (const g of s.games ?? []) {
      games++;
      teams.add(norm2(g.away));
      teams.add(norm2(g.home));
      if (g.events?.length) withEvents++;
      for (const l of g.lineups ?? []) {
        players.add(normP(l.player));
        teams.add(norm2(l.team));
      }
      for (const st of g.stats ?? []) players.add(normP(st.player));
      for (const e of g.events ?? []) {
        if (e.batter) players.add(normP(e.batter));
        if (e.pitcher) players.add(normP(e.pitcher));
      }
    }
    for (const st of s.playerStats ?? []) players.add(normP(st.player));
  }
  return {
    league: file.league,
    sport: file.sport ?? "baseball",
    seasons: file.seasons.length,
    teams: teams.size,
    players: players.size,
    games,
    gamesWithEvents: withEvents,
    warnings,
    years: file.seasons.map((s) => s.year)
  };
}
var STAT_ALIASES = {
  "2b": "doubles",
  "3b": "triples",
  "ci": "rbi",
  "so": "k",
  outs: "pOuts",
  ip: "pOuts",
  ph: "pH",
  pr: "pR",
  per: "pER",
  pbb: "pBB",
  pk: "pK",
  phr: "pHR",
  ppitches: "pPitches",
  pitches: "pPitches"
};
var STAT_COLS = /* @__PURE__ */ new Set([
  "g",
  "pa",
  "ab",
  "r",
  "h",
  "doubles",
  "triples",
  "hr",
  "rbi",
  "bb",
  "k",
  "hbp",
  "sac",
  "sf",
  "sb",
  "gp",
  "gs",
  "w",
  "l",
  "sv",
  "hld",
  "bs",
  "cg",
  "sho",
  "pOuts",
  "pH",
  "pR",
  "pER",
  "pBB",
  "pK",
  "pHR",
  "pPitches",
  "e"
]);
function statData(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v == null || typeof v !== "number") continue;
    let col = STAT_ALIASES[k.toLowerCase()] ?? (STAT_COLS.has(k) ? k : null);
    if (!col) continue;
    if (col === "pOuts" && (k === "ip" || k === "IP")) {
      const inn = Math.floor(v);
      out[col] = (out[col] ?? 0) + inn * 3 + Math.round((v - inn) * 10);
    } else {
      out[col] = (out[col] ?? 0) + v;
    }
  }
  return out;
}
async function importPox(file, warnings, opts = {}) {
  const sport = file.sport === "softball" ? "softball" : "baseball";
  const innings = file.innings ?? (sport === "softball" ? 7 : 9);
  const lastYear = Math.max(...file.seasons.map((s) => s.year));
  const appending = !!opts.appendToLeagueId;
  let league;
  if (appending) {
    const found = await prisma.league.findUnique({ where: { id: opts.appendToLeagueId } });
    if (!found) throw Object.assign(new Error("la liga destino no existe"), { status: 404 });
    league = found;
  } else {
    const dup = await prisma.league.findFirst({ where: { name: file.league.trim() } });
    if (dup) throw Object.assign(new Error(`ya existe una liga llamada "${file.league.trim()}" \u2014 puedes agregar el archivo como temporada`), { status: 409, leagueId: dup.id });
    league = await prisma.league.create({
      data: { name: file.league.trim(), year: lastYear, sport, innings }
    });
  }
  const created = { teams: /* @__PURE__ */ new Set(), players: /* @__PURE__ */ new Set(), seasons: /* @__PURE__ */ new Set(), games: /* @__PURE__ */ new Set(), series: /* @__PURE__ */ new Set() };
  const touchedYears = /* @__PURE__ */ new Set();
  const reusedPids = /* @__PURE__ */ new Set();
  let curYear = 0;
  const maxYearOf = /* @__PURE__ */ new Map();
  const toReactivate = /* @__PURE__ */ new Set();
  const existYears = (await prisma.season.findMany({ where: { leagueId: league.id }, select: { year: true } })).map((s) => s.year);
  const latestYear = Math.max(0, ...existYears, ...file.seasons.map((s) => s.year));
  const preStats = /* @__PURE__ */ new Map();
  const lastGameTeam = /* @__PURE__ */ new Map();
  const warned = /* @__PURE__ */ new Set();
  const warn = (m) => {
    if (!warned.has(m)) {
      warned.add(m);
      warnings.push(m);
    }
  };
  const teamIds = /* @__PURE__ */ new Map();
  const playerIds = /* @__PURE__ */ new Map();
  const playerByName = /* @__PURE__ */ new Map();
  const nameKeys = /* @__PURE__ */ new Map();
  const playerTeam = /* @__PURE__ */ new Map();
  const mergeTeam = /* @__PURE__ */ new Map();
  for (const m of file.merges ?? []) mergeTeam.set(normP(m.name), m.team);
  if (appending) {
    for (const t of await prisma.team.findMany({ where: { leagueId: league.id } })) teamIds.set(norm2(t.name), t.id);
    for (const p of await prisma.player.findMany({ where: { team: { leagueId: league.id } }, include: { team: true } })) {
      const fn = `${p.firstName} ${p.lastName}`.trim();
      const k = `${norm2(p.team.name)}|${normP(fn)}`;
      playerIds.set(k, p.id);
      const ky = `${norm2(p.team.name)}|${stripYear(fn)}`;
      if (ky !== k && !playerIds.has(ky)) playerIds.set(ky, p.id);
      nameKeys.set(normP(fn), [...nameKeys.get(normP(fn)) ?? [], k]);
      playerTeam.set(p.id, p.teamId);
      if (!playerByName.has(normP(fn))) playerByName.set(normP(fn), p.id);
      else warn(`hom\xF3nimo "${fn}" en varios equipos de la liga \u2014 las stats ir\xE1n a la primera ficha`);
    }
  }
  const pKey = (name, teamName) => opts.mergeSameName ? `*|${normP(name)}` : `${norm2(mergeTeam.get(normP(name)) ?? teamName ?? "")}|${normP(name)}`;
  const aliasMap = /* @__PURE__ */ new Map();
  const aliasMapTeam = /* @__PURE__ */ new Map();
  for (const a of opts.playerAliases ?? []) {
    if (a.fromTeam) aliasMapTeam.set(`${norm2(a.fromTeam)}|${normP(a.from)}`, a.to.trim());
    else aliasMap.set(normP(a.from), a.to.trim());
  }
  const aliasFor = (name, teamName) => {
    if (teamName) {
      const t = aliasMapTeam.get(`${norm2(teamName)}|${normP(name)}`);
      if (t) return t;
    }
    return aliasMap.get(normP(name)) ?? name;
  };
  const getTeam = async (name) => {
    const k = norm2(name);
    const hit = teamIds.get(k);
    if (hit) return hit;
    const t = await prisma.team.create({ data: { name: name.trim(), leagueId: league.id } });
    teamIds.set(k, t.id);
    created.teams.add(t.id);
    warn(`equipo "${name.trim()}" no estaba declarado \u2192 creado`);
    return t.id;
  };
  const regPlayer = (key, name, pid) => {
    playerIds.set(key, pid);
    nameKeys.set(normP(name), [...nameKeys.get(normP(name)) ?? [], key]);
    if (!playerByName.has(normP(name))) playerByName.set(normP(name), pid);
  };
  const getPlayer = async (name, teamName) => {
    const aliased = aliasFor(name, teamName);
    const wasAliased = aliased !== name;
    name = aliased;
    const merged = mergeTeam.has(normP(name));
    let k = pKey(name, teamName);
    let hit = playerIds.get(k);
    if (!hit && teamName) hit = playerIds.get(`${norm2(mergeTeam.get(normP(name)) ?? teamName)}|${stripYear(name)}`);
    if (!hit && (opts.mergeSameName || wasAliased)) hit = playerByName.get(normP(name)) ?? playerByName.get(stripYear(name));
    if (!hit && !teamName) {
      const ks = nameKeys.get(normP(name)) ?? [];
      if (ks.length === 1) {
        k = ks[0];
        hit = playerIds.get(k);
      } else if (ks.length > 1) {
        k = ks[0];
        hit = playerIds.get(k);
        warn(`jugador "${name.trim()}" existe en varios equipos \u2192 se us\xF3 la primera ficha`);
      }
    }
    if (hit) {
      if (!created.players.has(hit)) reusedPids.add(hit);
      if (teamName) {
        maxYearOf.set(hit, Math.max(maxYearOf.get(hit) ?? 0, curYear));
        if (curYear >= latestYear) toReactivate.add(hit);
        if (!merged) playerTeam.set(hit, await getTeam(teamName));
      }
      return hit;
    }
    const { firstName, lastName } = splitName(name);
    const tid = await getTeam(mergeTeam.get(normP(name)) ?? teamName ?? "Sin equipo");
    const p = await prisma.player.create({ data: { firstName, lastName, teamId: tid, active: curYear >= latestYear } });
    maxYearOf.set(p.id, curYear);
    created.players.add(p.id);
    regPlayer(k, name, p.id);
    playerTeam.set(p.id, tid);
    if (!teamName && !merged) warn(`jugador "${name.trim()}" sin equipo \u2192 "Sin equipo"`);
    return p.id;
  };
  const optPlayer = async (name) => name ? getPlayer(name) : null;
  try {
    for (const s of file.seasons) {
      curYear = s.year;
      const exist = await prisma.season.findFirst({ where: { leagueId: league.id, year: s.year } });
      if (exist && opts.mergeSeason && !preStats.has(s.year)) {
        await autoBackup(`antes de fusionar temporada ${s.year}`);
        const lp = await prisma.player.findMany({ where: { team: { leagueId: league.id } }, select: { id: true } });
        preStats.set(s.year, await prisma.playerSeasonStat.findMany({ where: { playerId: { in: lp.map((p) => p.id) }, season: s.year } }));
      }
      if (exist && !opts.mergeSeason) {
        if (!opts.replaceSeason) {
          throw Object.assign(new Error(`la temporada ${s.year} ya existe en esta liga \u2014 marca "fusionar" para AGREGAR los juegos sin borrar, o "reemplazar" para sobreescribirla`), { status: 409 });
        }
        await autoBackup(`antes de reemplazar temporada ${s.year}`);
        const og = (await prisma.game.findMany({ where: { seasonId: exist.id }, select: { id: true } })).map((g) => g.id);
        await prisma.gameEvent.deleteMany({ where: { gameId: { in: og } } });
        await prisma.lineupEntry.deleteMany({ where: { gameId: { in: og } } });
        await prisma.game.deleteMany({ where: { id: { in: og } } });
        await prisma.series.deleteMany({ where: { seasonId: exist.id } });
        const lp = await prisma.player.findMany({ where: { team: { leagueId: league.id } }, select: { id: true } });
        await prisma.playerSeasonStat.deleteMany({ where: { playerId: { in: lp.map((p) => p.id) }, season: s.year } });
        await prisma.season.delete({ where: { id: exist.id } });
      }
      const season = exist && opts.mergeSeason ? exist : await prisma.season.create({
        data: { leagueId: league.id, year: s.year, status: s.status === "ENDED" ? "ENDED" : "ACTIVE" }
      });
      if (!(exist && opts.mergeSeason)) created.seasons.add(season.id);
      touchedYears.add(s.year);
      const existGameKeys = exist && opts.mergeSeason ? new Set((await prisma.game.findMany({ where: { seasonId: exist.id }, select: { date: true, awayTeamId: true, homeTeamId: true } })).map((g) => `${g.date.toISOString().slice(0, 10)}|${g.awayTeamId}|${g.homeTeamId}`)) : null;
      let skippedDup = 0;
      for (const t of s.teams ?? []) {
        const k = norm2(t.name);
        if (!teamIds.has(k)) {
          const row = await prisma.team.create({
            data: { name: t.name.trim(), shortName: t.short?.trim() || null, color: t.color?.trim() || null, leagueId: league.id }
          });
          teamIds.set(k, row.id);
          created.teams.add(row.id);
        } else if (t.short || t.color) {
          await prisma.team.update({ where: { id: teamIds.get(k) }, data: { shortName: t.short ?? void 0, color: t.color ?? void 0 } });
        }
      }
      for (const p of s.players ?? []) {
        const pname = aliasFor(p.name, p.team);
        const merged = mergeTeam.has(normP(pname));
        const k = pKey(pname, p.team);
        const tid = await getTeam(mergeTeam.get(normP(pname)) ?? p.team);
        const prev = playerIds.get(k) ?? playerIds.get(pKey(stripYear(pname), p.team)) ?? (opts.mergeSameName ? playerByName.get(normP(pname)) ?? playerByName.get(stripYear(pname)) : void 0);
        if (!prev) {
          const { firstName, lastName } = splitName(pname);
          const row = await prisma.player.create({
            data: {
              firstName,
              lastName,
              teamId: tid,
              number: p.number ?? null,
              bats: p.bats ?? null,
              throws: p.throws ?? null,
              // temporada atrasada → nace pasivo (su roster es el del año importado)
              positions: p.pos ?? null,
              active: p.active !== false && s.year >= latestYear
            }
          });
          created.players.add(row.id);
          regPlayer(k, pname, row.id);
          playerTeam.set(row.id, tid);
          maxYearOf.set(row.id, s.year);
        } else {
          maxYearOf.set(prev, Math.max(maxYearOf.get(prev) ?? 0, s.year));
          if (s.year >= latestYear) toReactivate.add(prev);
          if (!merged) playerTeam.set(prev, tid);
        }
      }
      const seriesIds = /* @__PURE__ */ new Map();
      for (const sr of s.series ?? []) {
        const row = await prisma.series.create({
          data: {
            leagueId: league.id,
            seasonId: season.id,
            round: sr.round ?? 1,
            name: sr.name,
            homeTeamId: await getTeam(sr.home),
            awayTeamId: await getTeam(sr.away),
            winsNeeded: sr.winsNeeded ?? 3,
            status: sr.status === "DONE" ? "DONE" : sr.status === "LIVE" ? "LIVE" : "PENDING",
            winnerTeamId: sr.winner ? await getTeam(sr.winner) : null
          }
        });
        created.series.add(row.id);
        seriesIds.set(norm2(sr.name), row.id);
      }
      for (const [gi, g] of (s.games ?? []).entries()) {
        const final = g.status !== "SCHEDULED";
        const hasEvents = !!g.events?.length;
        const date = gameDate(g.date) ?? /* @__PURE__ */ new Date();
        if (existGameKeys) {
          const aId = teamIds.get(norm2(g.away)), hId = teamIds.get(norm2(g.home));
          if (aId && hId && existGameKeys.has(`${date.toISOString().slice(0, 10)}|${aId}|${hId}`)) {
            skippedDup++;
            continue;
          }
        }
        const game = await prisma.game.create({
          data: {
            date,
            status: final ? "FINAL" : "SCHEDULED",
            sport,
            innings,
            leagueId: league.id,
            seasonId: season.id,
            awayTeamId: await getTeam(g.away),
            homeTeamId: await getTeam(g.home),
            stadium: g.stadium ?? null,
            note: g.note ?? null,
            tied: !!g.tied,
            forfeitBy: g.forfeitBy ? await getTeam(g.forfeitBy) : null,
            seriesId: g.series ? seriesIds.get(norm2(g.series)) ?? null : null,
            // marcador oficial para juegos sin eventos (el fScore manda en toda la app)
            fScoreAway: final && !hasEvents ? g.scoreAway ?? 0 : g.scoreAway ?? null,
            fScoreHome: final && !hasEvents ? g.scoreHome ?? 0 : g.scoreHome ?? null,
            wpId: await optPlayer(g.wp),
            lpId: await optPlayer(g.lp),
            svId: await optPlayer(g.sv),
            startedAt: final ? date : null,
            endedAt: final ? date : null
          }
        });
        created.games.add(game.id);
        const markSeen = async (pid, teamName) => {
          const tid = teamName ? await getTeam(teamName) : playerTeam.get(pid);
          if (!tid) return;
          const cur = lastGameTeam.get(pid);
          if (!cur || date.getTime() >= cur.t) lastGameTeam.set(pid, { t: date.getTime(), tid });
        };
        const seenLineup = /* @__PURE__ */ new Set();
        for (const l of g.lineups ?? []) {
          const tid = await getTeam(l.team);
          const pid = await getPlayer(l.player, l.team);
          await markSeen(pid, l.team);
          seenLineup.add(pid);
          await prisma.lineupEntry.create({
            data: {
              gameId: game.id,
              teamId: tid,
              playerId: pid,
              order: l.order ?? 0,
              position: l.position ?? "DH",
              batsInOrder: l.bats !== false
            }
          });
        }
        if (hasEvents) {
          const perTeam = /* @__PURE__ */ new Map();
          let st = initialState();
          for (const [ei, e] of g.events.entries()) {
            const bid = e.batter ? await getPlayer(e.batter) : null;
            const pid2 = e.pitcher ? await getPlayer(e.pitcher) : null;
            const half = e.half === "BOTTOM" ? "BOTTOM" : e.half === "TOP" ? "TOP" : st.half;
            const inning = e.inning ?? st.inning;
            for (const [pid, side] of [[bid, half === "TOP" ? "away" : "home"], [pid2, half === "TOP" ? "home" : "away"]]) {
              if (pid && !seenLineup.has(pid)) {
                seenLineup.add(pid);
                const tid = await getTeam(side === "away" ? g.away : g.home);
                perTeam.set(tid, (perTeam.get(tid) ?? 0) + 1);
                await prisma.lineupEntry.create({
                  data: { gameId: game.id, teamId: tid, playerId: pid, order: perTeam.get(tid), position: "DH" }
                });
              }
            }
            let adv = [];
            if (e.advances?.length) {
              for (const a of e.advances) adv.push({ playerId: await getPlayer(a.player), to: a.to });
            } else if (bid) {
              adv = defaultAdvances(st, bid, e.result);
            }
            const seq = ei + 1;
            await prisma.gameEvent.create({
              data: {
                gameId: game.id,
                seq,
                inning,
                half,
                batterId: bid,
                pitcherId: pid2,
                result: e.result,
                notation: e.notation ?? null,
                errorOn: e.errors?.length ? JSON.stringify(e.errors.map((n) => playerIds.get(normP(n)) ?? n)) : null,
                putouts: e.po?.length ? JSON.stringify(e.po.map((n) => playerIds.get(normP(n)) ?? n)) : null,
                assists: e.a?.length ? JSON.stringify(e.a.map((n) => playerIds.get(normP(n)) ?? n)) : null,
                advances: JSON.parse(JSON.stringify(adv))
              }
            });
            st = applyEvent(st, {
              seq,
              inning,
              half,
              batterId: bid,
              pitcherId: pid2,
              result: e.result,
              notation: e.notation ?? null,
              errorOn: e.errors?.map((n) => playerIds.get(normP(n)) ?? n),
              putouts: e.po?.map((n) => playerIds.get(normP(n)) ?? n),
              assists: e.a?.map((n) => playerIds.get(normP(n)) ?? n),
              advances: adv
            }, innings);
          }
          if (final) await accumulateSeason(game.id);
        }
        const statLines = [];
        for (const row of g.stats ?? []) {
          const pid = await getPlayer(row.player, row.team);
          await markSeen(pid, row.team);
          const data = { g: 1, ...statData(row) };
          const scope = g.series ? "POST" : "REG";
          await prisma.playerSeasonStat.upsert({
            where: { playerId_season_scope: { playerId: pid, season: s.year, scope } },
            create: { playerId: pid, season: s.year, scope, ...data },
            update: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { increment: v }]))
          });
          statLines.push({
            playerId: pid,
            teamId: row.team ? await getTeam(row.team) : playerTeam.get(pid) ?? null,
            ...data,
            ...typeof row.po === "number" ? { po: row.po } : {},
            ...typeof row.a === "number" ? { a: row.a } : {},
            ...typeof row.bf === "number" ? { bf: row.bf } : {}
          });
        }
        if (statLines.length) {
          const upd = { statLines: JSON.parse(JSON.stringify(statLines)), seasonApplied: true };
          if (!game.wpId) {
            const w = statLines.find((l) => l.w);
            if (w) upd.wpId = w.playerId;
          }
          if (!game.lpId) {
            const l = statLines.find((l2) => l2.l);
            if (l) upd.lpId = l.playerId;
          }
          if (!game.svId) {
            const sv = statLines.find((l) => l.sv);
            if (sv) upd.svId = sv.playerId;
          }
          await prisma.game.update({ where: { id: game.id }, data: upd });
        }
        void gi;
      }
      if (skippedDup) warn(`${skippedDup} juegos ya estaban en la temporada ${s.year} (misma fecha/equipos) \u2014 se omitieron`);
      for (const row of s.playerStats ?? []) {
        const pid = await getPlayer(row.player, row.team);
        const data = statData(row);
        const scope = row.scope === "POST" ? "POST" : "REG";
        await prisma.playerSeasonStat.upsert({
          where: { playerId_season_scope: { playerId: pid, season: s.year, scope } },
          create: { playerId: pid, season: s.year, scope, ...data },
          update: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { increment: v }]))
        });
      }
    }
    for (const [pid, info] of lastGameTeam) playerTeam.set(pid, info.tid);
    for (const [pid, tid] of playerTeam) {
      if (!created.players.has(pid) && (maxYearOf.get(pid) ?? 0) < latestYear) continue;
      await prisma.player.update({ where: { id: pid }, data: { teamId: tid } });
    }
    if (toReactivate.size)
      await prisma.player.updateMany({ where: { id: { in: [...toReactivate] } }, data: { active: true } });
  } catch (err) {
    const gids = [...created.games];
    const pids = [...created.players];
    await prisma.gameEvent.deleteMany({ where: { gameId: { in: gids } } });
    await prisma.lineupEntry.deleteMany({ where: { OR: [{ gameId: { in: gids } }, { playerId: { in: pids } }] } });
    await prisma.game.deleteMany({ where: { id: { in: gids } } });
    await prisma.series.deleteMany({ where: { id: { in: [...created.series] } } });
    const leaguePids = appending ? (await prisma.player.findMany({ where: { team: { leagueId: league.id } }, select: { id: true } })).map((p) => p.id) : [...playerIds.values()];
    await prisma.playerSeasonStat.deleteMany({ where: { playerId: { in: leaguePids }, season: { in: [...touchedYears] } } });
    for (const rows of preStats.values()) {
      if (rows.length) await prisma.playerSeasonStat.createMany({ data: rows, skipDuplicates: true });
    }
    await prisma.player.deleteMany({ where: { id: { in: pids } } });
    await prisma.team.deleteMany({ where: { id: { in: [...created.teams] } } });
    await prisma.season.deleteMany({ where: { id: { in: [...created.seasons] } } });
    if (!appending) await prisma.league.delete({ where: { id: league.id } });
    throw err;
  }
  return {
    leagueId: league.id,
    appended: appending,
    summary: previewPox(file, warnings),
    created: {
      teams: created.teams.size,
      players: created.players.size,
      playersReused: reusedPids.size,
      games: created.games.size
    }
  };
}
async function appendPreview(file, leagueId) {
  const league = await prisma.league.findUnique({ where: { id: leagueId } });
  if (!league) return null;
  const lp = await prisma.player.findMany({ where: { team: { leagueId } }, include: { team: true } });
  const roster = lp.map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}`.trim(), team: p.team.name }));
  const byNorm = /* @__PURE__ */ new Map();
  for (const p of roster) {
    if (!byNorm.has(normP(p.name))) byNorm.set(normP(p.name), p);
  }
  const fileNames = /* @__PURE__ */ new Map();
  const addN = (n, t) => {
    if (!n?.trim()) return;
    const k = n.trim();
    fileNames.set(k, /* @__PURE__ */ new Set([...fileNames.get(k) ?? [], ...t ? [t] : []]));
  };
  for (const s of file.seasons) {
    for (const p of s.players ?? []) addN(p.name, p.team);
    for (const g of s.games ?? []) {
      addN(g.wp);
      addN(g.lp);
      addN(g.sv);
      for (const l of g.lineups ?? []) addN(l.player, l.team);
      for (const st of g.stats ?? []) addN(st.player, st.team);
      for (const e of g.events ?? []) {
        addN(e.batter);
        addN(e.pitcher);
        for (const x of e.errors ?? []) addN(x);
        for (const x of e.po ?? []) addN(x);
        for (const x of e.a ?? []) addN(x);
        for (const adv of e.advances ?? []) addN(adv.player);
      }
    }
  }
  const firstTok = (s) => normP(s).split(" ")[0] ?? "";
  const lastTok = (s) => normP(s).split(" ").slice(-1)[0] ?? "";
  const stripYear2 = (s) => normP(s).replace(/\s*(19|20)\d{2}$/, "").trim();
  const baseName = (s) => normP(s).replace(/\s*\(?\d+\)?\s*$/, "").replace(/\s*(19|20)\d{2}$/, "").trim();
  let matched = 0;
  const unmatched = [];
  const multiTeam = [];
  for (const [name, teams] of fileNames) {
    if (teams.size > 1) multiTeam.push({ name, teams: [...teams] });
    if (byNorm.has(normP(name)) || byNorm.has(stripYear2(name))) {
      matched++;
      continue;
    }
    const fn = firstTok(name), ln = lastTok(name), bn = baseName(name);
    const cands = /* @__PURE__ */ new Map();
    for (const p of roster) {
      if (bn !== normP(name) && baseName(p.name) === bn)
        cands.set(p.id, { ...p, why: 'mismo nombre sin el a\xF1o/"(n)" del archivo' });
      else if (firstTok(p.name) === fn && fn.length > 2)
        cands.set(p.id, { ...p, why: `mismo nombre de pila "${firstTok(p.name)}" \u2014 apellido distinto` });
      else if (lastTok(p.name) === ln && ln.length > 2)
        cands.set(p.id, { ...p, why: `mismo apellido` });
      else if (lev(normP(name), normP(p.name)) <= 2 || lev(bn, baseName(p.name)) <= 2)
        cands.set(p.id, { ...p, why: "nombre muy parecido (typo?)" });
    }
    unmatched.push({
      name,
      teams: [...teams],
      candidates: [...cands.values()].slice(0, 6)
    });
  }
  const existing = await prisma.season.findMany({ where: { leagueId }, select: { year: true, _count: { select: { games: true } } } });
  const existingYears = existing.map((s) => s.year);
  const existingYearGames = Object.fromEntries(existing.map((s) => [s.year, s._count.games]));
  const rosterOut = roster.slice().sort((a, b) => a.name.localeCompare(b.name));
  return { leagueId, league: league.name, unmatched, matched, multiTeam, existingYears, existingYearGames, roster: rosterOut };
}

// src/import/ballstat.ts
import fs5 from "node:fs";
import os from "node:os";
import path5 from "node:path";
import AdmZip from "adm-zip";
import { createExtractorFromData } from "node-unrar-js";

// src/conv-ballstat.ts
import fs4 from "node:fs";
import path4 from "node:path";
var MESES2 = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  augosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11
};
function rtfToLines(txt) {
  let s = txt.replace(/^\{\\rtf1[^\n]*\n?/, "").replace(/\{\\fonttbl[^}]*\}?/, "");
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_m, h) => Buffer.from([parseInt(h, 16)]).toString("latin1"));
  s = s.replace(/\\par[d]?/g, "\n").replace(/\\[a-zA-Z]+-?\d* ?/g, "").replace(/[{}]/g, "");
  return s.split("\n").map((l) => l.replace(/\s+$/g, "")).filter((l) => l.trim().length);
}
var title = (s) => s.toLowerCase().replace(/(^|\s|[,\-'])\S/g, (c) => c.toUpperCase());
function parseBox(txt) {
  const lines = rtfToLines(txt);
  const dateLine = lines.find((l) => /\d{1,2},\s*\d{4}/.test(l));
  let dateIso = "";
  let dateShort = "";
  if (dateLine) {
    const m = dateLine.match(/(\w+)\s+(\d{1,2}),\s*(\d{4})/);
    if (m) {
      const mo = MESES2[m[1].toLowerCase()];
      if (mo != null) {
        const y = Number(m[3]), d = Number(m[2]);
        dateIso = `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        dateShort = `${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}-${String(y).slice(2)}`;
      }
    }
  }
  const lsIdx = lines.findIndex((l) => /^\s*1\s+2\s+3.*\bR\b/.test(l) || /-\s+-\s+-.*\b-\s+-\s+-/.test(l));
  const scoreRows = [];
  if (lsIdx >= 0) {
    for (let i = lsIdx + 1; i < Math.min(lsIdx + 4, lines.length); i++) {
      const m = lines[i].match(/^\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .]+?)\s+([\d\s]+?)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/i);
      if (m) scoreRows.push({ team: m[1].trim(), r: Number(m[3]) });
    }
  }
  let recAway, recHome;
  for (const l of lines) {
    const recs = [...l.matchAll(/\((\d+)-(\d+)\)/g)];
    if (recs.length >= 2) {
      recAway = { w: +recs[0][1], l: +recs[0][2] };
      recHome = { w: +recs[1][1], l: +recs[1][2] };
      break;
    }
  }
  return { date: dateShort, dateIso, away: "", home: "", scoreAway: 0, scoreHome: 0, innings: 0, recAway, recHome, _rows: scoreRows };
}
function cellsOf(html) {
  const out = [];
  for (const m of html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)) {
    out.push(m[1].replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim());
  }
  return out;
}
var isDate = (s) => /^\d{2}-\d{2}-\d{2}$/.test(s);
var num = (s) => s === "" || s === "--" ? 0 : Number(s.replace(",", ".")) || 0;
var BAT_COLS2 = ["ab", "r", "h", "rbi", "doubles", "triples", "hr", "bb", "k", "sb", "ar", "hbp", "sac", "sf", "ibb", "gdp", "rlsp", "lob", "rc", "ba", "slg", "obp"];
var PIT_COLS2 = ["dec", "ip", "r", "er", "h", "doubles", "triples", "hr", "bb", "k", "hb", "wp", "bk", "sh", "sf", "dpi", "br6", "tbf", "oba", "oslg", "oobp", "era"];
var FLD_COLS = ["po", "a", "eft", "tc", "dp", "pb", "rto", "osb", "gp", "gc", "g1b", "g2b"];
function parseLogSection(cells, start, end, cols) {
  const rows = /* @__PURE__ */ new Map();
  const dec = /* @__PURE__ */ new Map();
  let i = start;
  while (i < end) {
    if (!isDate(cells[i])) {
      i++;
      continue;
    }
    const date = cells[i];
    const opp = cells[i + 1] ?? "";
    const rec = { _opp: 0 };
    rec.__opp = 0;
    rec.__oppName = opp;
    let j = i + 2;
    for (let c = 0; c < cols.length && j < cells.length && !isDate(cells[j]); c++, j++) {
      const col = cols[c], v = cells[j];
      if (col === "dec") {
        if (v) dec.set(date + "|" + opp, v);
        rec.__dec = v;
        continue;
      }
      if (col === "pos") {
        rec.__pos = v;
        continue;
      }
      if (col === "eft") {
        const parts = v.split("/");
        rec.e = num(parts[parts.length - 1] ?? "0");
        continue;
      }
      if (/^[-\d.]+$/.test(v) || v === "") rec[col] = num(v);
      else if (col !== "dec" && col !== "pos") break;
    }
    rows.set(date + "|" + opp, rec);
    i = j;
  }
  return { rows, dec };
}
function parsePlayerPage(html) {
  const mHead = html.match(/<font[^>]*>\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ '.\-]+)\s*,\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑ '.\-]+)\s*<\/font>/i) ?? html.match(/>\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ '.\-]+)\s*,\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑ '.\-]+)\s*</i);
  const mTeam = html.match(/>([A-ZÁÉÍÓÚÑ ]{3,})<BR>\s*Bats/i);
  const mB = html.match(/Bats:\s*([LRS])/i), mT = html.match(/Throws:\s*([LR])/i), mP = html.match(/Pos:\s*([^<]+)</i);
  if (!mHead) return null;
  const lastName = title(mHead[1].trim()), firstName = title(mHead[2].trim());
  const pl = {
    team: mTeam ? mTeam[1].trim() : "",
    name: `${firstName} ${lastName}`.replace(/\s+/g, " ").trim(),
    firstName,
    lastName,
    bats: mB?.[1],
    throws: mT?.[1],
    pos: mP ? mP[1].trim().split(/\s+/).filter(Boolean) : [],
    bat: /* @__PURE__ */ new Map(),
    pit: /* @__PURE__ */ new Map(),
    fld: /* @__PURE__ */ new Map(),
    dec: /* @__PURE__ */ new Map()
  };
  const cells = cellsOf(html);
  const batAt = cells.findIndex((c) => /Batting by Game/i.test(c));
  const pitAt = cells.findIndex((c) => /Pitching by Game/i.test(c));
  const fldAt = cells.findIndex((c) => /Fielding by Game/i.test(c));
  const bound = (at) => [pitAt, fldAt].filter((x) => x > at).concat(cells.length).sort((a, b) => a - b)[0];
  if (batAt >= 0) {
    const r10 = parseLogSection(cells, batAt, bound(batAt), BAT_COLS2);
    pl.bat = r10.rows;
  }
  if (pitAt >= 0) {
    const r10 = parseLogSection(cells, pitAt, bound(pitAt), PIT_COLS2);
    pl.pit = r10.rows;
    for (const [k, v] of r10.dec) pl.dec.set(k, v);
  }
  if (fldAt >= 0) {
    const r10 = parseLogSection(cells, fldAt, bound(fldAt), FLD_COLS);
    pl.fld = r10.rows;
  }
  return pl;
}
var surKey = (s) => s.trim().toUpperCase().replace(/\s+/g, " ");
function parseCmp(txt) {
  const data = { bat: /* @__PURE__ */ new Map(), pit: /* @__PURE__ */ new Map(), fld: /* @__PURE__ */ new Map() };
  const lines = rtfToLines(txt);
  let team = "", sec = "";
  let pendingName = null;
  for (const raw of lines) {
    const l = raw.replace(/\\/g, "");
    const secM = l.match(/^\s*([A-ZÁÉÍÓÚÑ .]{3,}?)\s+(Batting|Pitching|Fielding)\s*$/);
    if (secM) {
      team = secM[1].trim();
      sec = secM[2] === "Batting" ? "bat" : secM[2] === "Pitching" ? "pit" : "fld";
      pendingName = null;
      continue;
    }
    if (/^\s*Totals/i.test(l)) {
      sec = "";
      pendingName = null;
      continue;
    }
    if (!sec) continue;
    if (/^\s*Player|--/.test(l)) continue;
    const solo = l.match(/^\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .]{2,})\s*$/);
    if (solo) {
      pendingName = solo[1].trim();
      continue;
    }
    const both = l.match(/^\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .]{2,}?)\s+([\d.][\d .]*)\s*$/);
    let name = null;
    let numsStr = "";
    if (both) {
      name = both[1].trim();
      numsStr = both[2];
    } else if (pendingName && /^\s*[\d.]/.test(l)) {
      name = pendingName;
      numsStr = l;
    }
    if (name && numsStr) {
      const nums = numsStr.trim().split(/\s+/).map((v) => Number(v) || 0);
      const rows = data[sec].get(team) ?? [];
      rows.push({ surname: name, nums });
      data[sec].set(team, rows);
      pendingName = null;
    }
  }
  return data;
}
var normUpper = (s) => s.toUpperCase().replace(/\s+/g, " ").trim();
var CMP_BAT = [
  [0, "pa"],
  [1, "ab"],
  [2, "r"],
  [3, "h"],
  [4, "rbi"],
  [5, "bb"],
  [6, "k"],
  [8, "doubles"],
  [9, "triples"],
  [10, "hr"],
  [15, "sb"],
  [17, "sac"],
  [18, "sf"],
  [19, "hbp"]
];
var CMP_PIT = [
  [1, "pH"],
  [2, "pR"],
  [3, "pER"],
  [4, "pBB"],
  [6, "pK"],
  [9, "pHR"],
  [10, "hbp"],
  [21, "bf"]
];
var batIsZero = (r10) => !(Number(r10.ab) || Number(r10.h) || Number(r10.r) || Number(r10.rbi) || Number(r10.bb) || Number(r10.k) || Number(r10.hbp));
var pitIsZero = (r10) => !(Number(r10.pOuts) || Number(r10.pH) || Number(r10.bf));
var fldIsZero = (r10) => !(Number(r10.po) || Number(r10.a) || Number(r10.e));
var outsOf2 = (ip) => Math.floor(ip) * 3 + Math.round((ip - Math.floor(ip)) * 10);
function recoverSection(cmpRows, playersOfTeam, statsRows, apply, matches, isZero, field, ctx, warn) {
  const bySur = /* @__PURE__ */ new Map();
  for (const r10 of cmpRows) {
    const k = surKey(r10.surname);
    bySur.set(k, [...bySur.get(k) ?? [], r10]);
  }
  for (const [sur, rows] of bySur) {
    const cands = playersOfTeam.filter((pl) => surKey(pl.lastName) === sur);
    if (!cands.length) {
      warn.push(`${ctx}: "${sur}" sin jugador en plantilla \u2192 ${field} omitido`);
      continue;
    }
    const used = /* @__PURE__ */ new Set();
    const filled = /* @__PURE__ */ new Set();
    for (const r10 of rows) {
      const hit = cands.find((pl) => {
        const s = statsRows.get(pl);
        return s && !filled.has(pl) && !isZero(s) && matches(s, r10.nums);
      });
      if (hit) {
        used.add(r10);
        filled.add(hit);
      }
    }
    for (const r10 of rows) {
      if (used.has(r10)) continue;
      const zero = cands.find((pl2) => !filled.has(pl2) && statsRows.has(pl2) && isZero(statsRows.get(pl2)));
      const absent = cands.find((pl2) => !filled.has(pl2) && !statsRows.has(pl2));
      const pl = zero ?? absent;
      if (!pl) {
        warn.push(`${ctx}: l\xEDnea ${field} de ${sur} sin jugador a quien asignar`);
        continue;
      }
      let s = statsRows.get(pl);
      if (!s) {
        s = { player: pl.name, team: pl.team, g: 1, pa: 0, ab: 0, r: 0, h: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sac: 0, sf: 0, sb: 0, doubles: 0, triples: 0, hr: 0, gp: 0, pOuts: 0, pH: 0, pR: 0, pER: 0, pBB: 0, pK: 0, pHR: 0, pPitches: 0, bf: 0, po: 0, a: 0, e: 0 };
        statsRows.set(pl, s);
      }
      apply(s, r10.nums);
      used.add(r10);
      filled.add(pl);
    }
    if (cands.length > 1 && rows.length > 1 && rows.some((r10) => !used.has(r10)))
      warn.push(`${ctx}: ${sur} tiene ${cands.length} jugadores hom\xF3nimos \u2014 revisar asignaci\xF3n ${field}`);
  }
}
function convertBallstatFolder(dir, opts) {
  const leagueName = path4.basename(dir).replace(/_/g, " ");
  const boxDir = path4.join(dir, "BallScore Reports");
  const games = [];
  const FN_RE = /^(\d{2}-\d{2}-\d{2})[a-z]?\s+(.+?)\s+at\s+(.+?)\.box\.txt$/i;
  for (const f of fs4.readdirSync(boxDir).filter((f4) => f4.endsWith(".box.txt"))) {
    const m = f.match(FN_RE);
    const txt = fs4.readFileSync(path4.join(boxDir, f), "utf8");
    const parsed = parseBox(txt);
    if (!parsed || !m) continue;
    const g = parsed;
    const joined = rtfToLines(txt).join(" ");
    const grabDec = (tag) => {
      const m2 = joined.match(new RegExp(`\\b${tag}-\\s*([^;]{1,80})`));
      if (!m2) return [];
      return m2[1].split(/[\d,()\/]+/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => /^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .]{1,}$/.test(s));
    };
    g.wpSurs = grabDec("WP");
    g.svSurs = grabDec("S");
    g.decW = [];
    g.decL = [];
    g.decS = [];
    for (const dm of joined.matchAll(/\b([A-ZÁÉÍÓÚÑ]{2,}(?: +[A-ZÁÉÍÓÚÑ]{2,}){0,2})\((W|L|S|SV)\s*\d+-\d+\)/g)) {
      const sur = dm[1].replace(/\s+/g, " ").trim();
      if (dm[2] === "W") g.decW.push(sur);
      else if (dm[2] === "L") g.decL.push(sur);
      else g.decS.push(sur);
    }
    if (!g.date) {
      g.date = m[1];
      g.dateIso = `20${m[1].slice(6)}-${m[1].slice(0, 2)}-${m[1].slice(3, 5)}`;
    }
    g.away = title(m[2].trim());
    g.home = title(m[3].trim());
    if (g._rows?.length === 2) {
      const up = (s) => s.toUpperCase();
      if (up(g._rows[0].team).includes(up(g.away)) || up(g.away).includes(up(g._rows[0].team))) {
        g.scoreAway = g._rows[0].r;
        g.scoreHome = g._rows[1].r;
      } else {
        g.scoreAway = g._rows[1].r;
        g.scoreHome = g._rows[0].r;
      }
    }
    games.push(g);
  }
  console.log(`juegos .box.txt: ${games.length}`);
  const wbDir = path4.join(dir, "WebBuilder");
  const players = [];
  const warn = [];
  if (fs4.existsSync(wbDir)) {
    for (const f of fs4.readdirSync(wbDir).filter((f4) => f4.endsWith(".htm") && !f4.includes("_opp") && !f4.includes("_pit") && !f4.includes("month") && !f4.includes("cap") && !f4.includes("leader") && !f4.startsWith("index") && !f4.startsWith("standings"))) {
      const pl = parsePlayerPage(fs4.readFileSync(path4.join(wbDir, f), "utf8"));
      if (pl && pl.team && (pl.bat.size || pl.pit.size)) players.push(pl);
    }
    console.log(`jugadores WebBuilder: ${players.length}`);
  } else {
    const maxPer = /* @__PURE__ */ new Map();
    for (const f of fs4.readdirSync(boxDir).filter((f4) => f4.endsWith(".cmp.txt"))) {
      const cmp = parseCmp(fs4.readFileSync(path4.join(boxDir, f), "utf8"));
      for (const sec of [cmp.bat, cmp.pit, cmp.fld]) {
        for (const [team, rows] of sec) {
          const t = normUpper(team);
          let tm = maxPer.get(t);
          if (!tm) {
            tm = /* @__PURE__ */ new Map();
            maxPer.set(t, tm);
          }
          const perSur = /* @__PURE__ */ new Map();
          for (const r10 of rows) perSur.set(surKey(r10.surname), (perSur.get(surKey(r10.surname)) ?? 0) + 1);
          for (const [sur, n] of perSur) tm.set(sur, Math.max(tm.get(sur) ?? 0, n));
        }
      }
    }
    for (const [team, surs] of maxPer) {
      for (const [sur, n] of [...surs.entries()].sort()) {
        for (let i = 1; i <= n; i++) {
          players.push({
            team,
            name: title(sur) + (i > 1 ? ` (${i})` : ""),
            firstName: title(sur),
            lastName: sur,
            pos: [],
            bat: /* @__PURE__ */ new Map(),
            pit: /* @__PURE__ */ new Map(),
            fld: /* @__PURE__ */ new Map(),
            dec: /* @__PURE__ */ new Map()
          });
        }
      }
    }
    console.log(`jugadores por apellido (.cmp): ${players.length}`);
    warn.push('paquete sin WebBuilder \u2192 jugadores por APELLIDO; los "(n)" son hom\xF3nimos del mismo equipo \u2014 revisar asignaci\xF3n al importar');
  }
  const ROS_REC = 115, ROS_FN = 30, ROS_LN = 30;
  const rosDir = path4.join(dir, "Rosters");
  if (fs4.existsSync(rosDir)) {
    const seen = new Set(players.map((p) => normUpper(`${p.team}|${p.name}`)));
    let added = 0;
    const cleanName = (s) => s.replace(/^r(?=[A-ZÁÉÍÓÚÑ])/, "").replace(/\s+/g, " ").trim();
    const NAME_RE = /^[A-ZÁÉÍÓÚÑa-záéíóúñ][A-ZÁÉÍÓÚÑa-záéíóúñ'.\s\-]*$/;
    const field = (buf, off, len) => {
      const end = buf.indexOf(0, off);
      return buf.toString("latin1", off, end < 0 || end > off + len ? off + len : end).trim();
    };
    const firstStr = (buf) => {
      const m = buf.toString("latin1", 0, Math.min(buf.length, 400)).match(/[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ .]{2,}/);
      return m ? m[0].trim() : "";
    };
    for (const f of fs4.readdirSync(rosDir).filter((f4) => /\.ros$/i.test(f4))) {
      const buf = fs4.readFileSync(path4.join(rosDir, f));
      const team = firstStr(buf);
      let start = -1;
      for (let s = 200; s < 400 && start < 0; s++) {
        let n = 0;
        for (let off = s; off + ROS_FN + ROS_LN <= buf.length && n < 40; off += ROS_REC) {
          const fn = cleanName(field(buf, off, ROS_FN));
          const ln = cleanName(field(buf, off + ROS_FN, ROS_LN));
          if (fn && ln && NAME_RE.test(fn) && NAME_RE.test(ln)) n++;
          else break;
        }
        if (n >= 3) start = s;
      }
      if (start < 0) {
        warn.push(`Rosters/${f}: no se pudo leer el roster`);
        continue;
      }
      for (let off = start; off + ROS_FN + ROS_LN <= buf.length; off += ROS_REC) {
        const fn = cleanName(field(buf, off, ROS_FN));
        const ln = cleanName(field(buf, off + ROS_FN, ROS_LN));
        if (!(fn && ln && NAME_RE.test(fn) && NAME_RE.test(ln))) break;
        const name = title(`${fn} ${ln}`);
        const key = normUpper(`${team}|${name}`);
        if (seen.has(key)) continue;
        seen.add(key);
        players.push({
          team,
          name,
          firstName: title(fn),
          lastName: title(ln),
          pos: [],
          bat: /* @__PURE__ */ new Map(),
          pit: /* @__PURE__ */ new Map(),
          fld: /* @__PURE__ */ new Map(),
          dec: /* @__PURE__ */ new Map()
        });
        added++;
      }
    }
    if (added) console.log(`jugadores solo en roster (.ros): ${added}`);
  }
  const teamNames = [...new Set(games.flatMap((g) => [g.home, g.away]))];
  const normTeam = (t) => teamNames.find((n) => n.toUpperCase() === t.trim().toUpperCase()) ?? title(t.trim());
  const slugToTeam = /* @__PURE__ */ new Map();
  for (const t of teamNames) {
    slugToTeam.set(t.replace(/\s+/g, "_").toLowerCase(), t);
    const noArt = t.replace(/^(el|la|los|las)\s+/i, "");
    const abbr = noArt.slice(0, 3).toUpperCase();
    slugToTeam.set("@" + abbr, t);
    slugToTeam.set(abbr, t);
  }
  {
    const aliasOwner = /* @__PURE__ */ new Map();
    const tryAlias = (alias, team) => {
      if (!alias || alias.length < 2) return;
      const cur = aliasOwner.get(alias);
      if (cur === void 0) {
        aliasOwner.set(alias, team);
        return;
      }
      if (cur !== team) aliasOwner.set(alias, "");
    };
    for (const t of teamNames) {
      const words = t.split(/\s+/);
      const noArtWords = words.filter((w) => !/^(el|la|los|las|de|del)$/i.test(w));
      for (const w of noArtWords) tryAlias(w.slice(0, 3).toUpperCase(), t);
      if (words.length > 1) {
        tryAlias(words.map((w) => w[0]).join("").toUpperCase(), t);
        tryAlias(noArtWords[0].slice(0, 2).toUpperCase() + noArtWords.slice(1).map((w) => w[0].toUpperCase()).join(""), t);
        tryAlias(words[0].slice(0, 2).toUpperCase() + words.slice(1).map((w) => w[0].toUpperCase()).join(""), t);
      }
      if (noArtWords.length > 1) {
        const last = noArtWords[noArtWords.length - 1].toUpperCase();
        const cons = last.replace(/[AEIOU]/g, "").slice(0, 2);
        tryAlias(t.trim()[0].toUpperCase() + cons, t);
      }
      if (/^(el|la|los|las)\s+/i.test(t) && noArtWords.length === 1) {
        const cons = noArtWords[0].toUpperCase().replace(/[AEIOU]/g, "").slice(0, 2);
        tryAlias(t.trim()[0].toUpperCase() + cons, t);
      }
    }
    for (const [alias, team] of aliasOwner) {
      if (!team) continue;
      slugToTeam.set("@" + alias, team);
      slugToTeam.set(alias, team);
    }
  }
  console.log("equipos:", teamNames.join(" | "));
  for (const pl of players) pl.team = normTeam(pl.team);
  const gameKey = (date, home, away) => `${date}|${home}|${away}`;
  const gameMap = /* @__PURE__ */ new Map();
  for (const g of games) {
    gameMap.set(gameKey(g.date, g.home, g.away), Object.assign(g, { stats: [] }));
  }
  for (const pl of players) {
    const keys = /* @__PURE__ */ new Set([...pl.bat.keys(), ...pl.pit.keys()]);
    for (const k of keys) {
      const [date, oppCell] = k.split("|");
      const oppName = oppCell.replace(/^@/, "");
      const opp = slugToTeam.get(oppName) ?? slugToTeam.get(oppCell.replace(/^@/, "").toLowerCase()) ?? slugToTeam.get(oppName.trim().toLowerCase().replace(/[\s-]+/g, "_"));
      if (!opp) {
        warn.push(`${pl.name}: rival "${oppCell}" no mapea a equipo`);
        continue;
      }
      const away = oppCell.startsWith("@") ? pl.team : opp;
      const home = oppCell.startsWith("@") ? opp : pl.team;
      const key = gameKey(date, home, away);
      let g = gameMap.get(key);
      if (!g) {
        const [mo, dy, yy] = date.split("-");
        g = { date, dateIso: `20${yy}-${mo}-${dy}`, away, home, scoreAway: 0, scoreHome: 0, innings: 0, stats: [], synth: true };
        gameMap.set(key, g);
        games.push(g);
      }
      const b = pl.bat.get(k);
      const p = pl.pit.get(k);
      const f = pl.fld.get(k);
      const dec = pl.dec.get(k) ?? "";
      const ab = b?.ab ?? 0, bb = b?.bb ?? 0, hbp = b?.hbp ?? 0, sac = b?.sac ?? 0, sf = b?.sf ?? 0;
      const ip = p?.ip ?? 0;
      const pOuts = Math.floor(ip) * 3 + Math.round((ip - Math.floor(ip)) * 10);
      const row = {
        player: pl.name,
        team: pl.team,
        g: 1,
        pa: ab + bb + hbp + sac + sf,
        ab,
        r: b?.r ?? 0,
        h: b?.h ?? 0,
        doubles: b?.doubles ?? 0,
        triples: b?.triples ?? 0,
        hr: b?.hr ?? 0,
        rbi: b?.rbi ?? 0,
        bb,
        k: b?.k ?? 0,
        hbp,
        sac,
        sf,
        sb: b?.sb ?? 0,
        gp: p ? 1 : 0,
        pOuts,
        pH: p?.h ?? 0,
        pR: p?.r ?? 0,
        pER: p?.er ?? 0,
        pBB: p?.bb ?? 0,
        pK: p?.k ?? 0,
        pHR: p?.hr ?? 0,
        pPitches: 0,
        bf: p?.tbf ?? 0,
        po: f?.po ?? 0,
        a: f?.a ?? 0,
        e: f?.e ?? 0
      };
      if (/^w/i.test(dec) || /^G$/.test(dec)) row.w = 1;
      else if (/^l/i.test(dec) || /^P$/.test(dec)) row.l = 1;
      if (/^s/i.test(dec) || /^J$/.test(dec)) row.sv = 1;
      g.stats.push(row);
    }
  }
  const statsRowByPlayer = /* @__PURE__ */ new Map();
  for (const g of games) {
    const m = /* @__PURE__ */ new Map();
    for (const s of g.stats) {
      const pl = players.find((p) => p.name === s.player && p.team === s.team);
      if (pl) m.set(pl, s);
    }
    statsRowByPlayer.set(g, m);
  }
  const cmpDir = path4.join(dir, "BallScore Reports");
  for (const f of fs4.readdirSync(cmpDir).filter((f4) => f4.endsWith(".cmp.txt"))) {
    const m = f.match(/^(\d{2}-\d{2}-\d{2})[a-z]?\s+(.+?)\s+at\s+(.+?)\.cmp\.txt$/i);
    if (!m) continue;
    const g = gameMap.get(gameKey(m[1], title(m[3].trim()), title(m[2].trim())));
    if (!g) continue;
    const cmp = parseCmp(fs4.readFileSync(path4.join(cmpDir, f), "utf8"));
    const sRows = statsRowByPlayer.get(g);
    for (const side of [g.away, g.home]) {
      const teamPlayers = players.filter((pl) => pl.team === side);
      const ctx = `${g.date} ${side}`;
      const bat = [...cmp.bat.entries()].find(([t]) => normUpper(t) === normUpper(side))?.[1];
      const pit = [...cmp.pit.entries()].find(([t]) => normUpper(t) === normUpper(side))?.[1];
      const fld = [...cmp.fld.entries()].find(([t]) => normUpper(t) === normUpper(side))?.[1];
      if (bat) recoverSection(
        bat,
        teamPlayers,
        sRows,
        (s, n) => {
          for (const [i, f22] of CMP_BAT) s[f22] = n[i] ?? 0;
        },
        (s, n) => n[1] === Number(s.ab) && n[3] === Number(s.h) && n[4] === Number(s.rbi),
        batIsZero,
        "bateo",
        ctx,
        warn
      );
      if (pit) recoverSection(
        pit,
        teamPlayers,
        sRows,
        (s, n) => {
          s.pOuts = outsOf2(n[0] ?? 0);
          s.gp = 1;
          for (const [i, f22] of CMP_PIT) if (f22 !== "hbp") s[f22] = n[i] ?? 0;
        },
        (s, n) => outsOf2(n[0] ?? 0) === Number(s.pOuts) && n[1] === Number(s.pH),
        pitIsZero,
        "pitcheo",
        ctx,
        warn
      );
      if (fld) recoverSection(
        fld,
        teamPlayers,
        sRows,
        (s, n) => {
          s.po = n[1] ?? 0;
          s.a = n[2] ?? 0;
          s.e = (n[3] ?? 0) + (n[4] ?? 0);
        },
        (s, n) => n[1] === Number(s.po) && n[2] === Number(s.a),
        fldIsZero,
        "fildeo",
        ctx,
        warn
      );
    }
  }
  for (const g of games) {
    const have = new Set(g.stats);
    for (const s of statsRowByPlayer.get(g).values()) if (!have.has(s)) g.stats.push(s);
  }
  for (const g of games) {
    const sRows = statsRowByPlayer.get(g);
    if (!sRows || !g.decW?.length && !g.decL?.length && !g.decS?.length && !g.wpSurs?.length && !g.svSurs?.length) continue;
    const winSide = g.scoreHome > g.scoreAway ? g.home : g.scoreAway > g.scoreHome ? g.away : null;
    const loseSide = g.scoreHome > g.scoreAway ? g.away : g.scoreAway > g.scoreHome ? g.home : null;
    const applyDec = (surs, field, side) => {
      if (!surs?.length || !side) return;
      if ([...sRows.values()].some((s) => Number(s[field]))) return;
      for (const sur of surs) {
        const cands = [...sRows.entries()].filter(([pl]) => pl.team === side && (surKey(pl.lastName) === surKey(sur) || surKey(sur).endsWith(" " + surKey(pl.lastName))));
        const pick = cands.find(([, s]) => Number(s.pOuts) > 0 || Number(s.gp) > 0) ?? cands[0];
        if (pick) {
          pick[1][field] = 1;
          return;
        }
      }
      const pitchers = [...sRows.entries()].filter(([pl, s]) => pl.team === side && Number(s.pOuts) > 0);
      pitchers.sort((a, b) => Number(b[1].pOuts) - Number(a[1].pOuts));
      if (pitchers[0]) {
        pitchers[0][1][field] = 1;
        warn.push(`${g.date}: ${field.toUpperCase()} "${surs.join("/")}" no aparece \u2192 se asign\xF3 a ${pitchers[0][0].name} (${side}, m\xE1s outs)`);
      } else {
        warn.push(`${g.date}: ${field.toUpperCase()} "${surs.join(", ")}" sin ficha ni pitcher en ${side}`);
      }
    };
    applyDec(g.decW, "w", winSide);
    applyDec(g.decL, "l", loseSide);
    applyDec(g.decS, "sv", winSide);
    applyDec(g.wpSurs, "w", winSide);
    applyDec(g.svSurs, "sv", winSide);
  }
  for (const g of games) {
    if (!g.synth) continue;
    for (const s of g.stats) {
      if (s.team === g.away) g.scoreAway += Number(s.r ?? 0);
      else if (s.team === g.home) g.scoreHome += Number(s.r ?? 0);
    }
    warn.push(`juego sin boxscore: ${g.date} ${g.away} @ ${g.home} \u2192 marcador sintetizado ${g.scoreAway}-${g.scoreHome} desde logs`);
  }
  games.sort((a, b) => a.dateIso.localeCompare(b.dateIso));
  const teamCount = teamNames.length;
  const byDate = /* @__PURE__ */ new Map();
  for (const g of games) {
    const ds = byDate.get(g.dateIso) ?? /* @__PURE__ */ new Set();
    ds.add(g.away);
    ds.add(g.home);
    byDate.set(g.dateIso, ds);
  }
  const dates = [...byDate.keys()].sort();
  let postFrom = null;
  for (let i = dates.length - 1; i >= 0; i--) {
    if ((byDate.get(dates[i])?.size ?? 0) < teamCount) postFrom = dates[i];
    else break;
  }
  const maxSum = /* @__PURE__ */ new Map();
  const phaseOf = /* @__PURE__ */ new Map();
  const updSum = (t, s) => {
    if (s == null) return false;
    const mx = maxSum.get(t) ?? 0;
    if (mx - s >= 3) {
      maxSum.set(t, s);
      return true;
    }
    if (s > mx) maxSum.set(t, s);
    return false;
  };
  let postPhase = 0;
  let sawPost = false;
  for (const g of games) {
    const sumA = g.recAway ? g.recAway.w + g.recAway.l : null;
    const sumH = g.recHome ? g.recHome.w + g.recHome.l : null;
    if (postFrom && g.dateIso >= postFrom) {
      const dA = updSum(g.away, sumA);
      const dH = updSum(g.home, sumH);
      if (!sawPost) {
        sawPost = true;
        postPhase = 1;
      } else if (dA || dH) postPhase++;
      phaseOf.set(g, postPhase);
    } else {
      updSum(g.away, sumA);
      updSum(g.home, sumH);
    }
  }
  const dirHint = /semifinal|semi/i.test(leagueName) ? "Semifinal" : /final/i.test(leagueName) ? "Final" : /playoff|post|serie/i.test(leagueName) ? "Postemporada" : null;
  const byPair = /* @__PURE__ */ new Map();
  for (const g of games) {
    const ph = dirHint ? 1 : phaseOf.get(g) ?? 0;
    if (!ph) continue;
    const pair = `${ph}|${[g.away, g.home].sort().join("|")}`;
    let sr = byPair.get(pair);
    if (!sr) {
      sr = { home: g.home, away: g.away, games: [], wins: /* @__PURE__ */ new Map() };
      byPair.set(pair, sr);
    }
    sr.games.push(g);
    const winT = g.scoreHome > g.scoreAway ? g.home : g.scoreAway > g.scoreHome ? g.away : "";
    if (winT) sr.wins.set(winT, (sr.wins.get(winT) ?? 0) + 1);
  }
  if (dirHint) for (const sr of byPair.values()) for (const g of sr.games) g.series = dirHint;
  const seriesRuns = [...byPair.values()].sort((a, b) => (a.games.at(-1)?.dateIso ?? "").localeCompare(b.games.at(-1)?.dateIso ?? ""));
  const seriesName = (i) => i === seriesRuns.length - 1 ? "Final" : seriesRuns.length <= 3 ? seriesRuns.length === 3 ? `Semifinal ${i + 1}` : "Semifinal" : i === seriesRuns.length - 2 ? "Semifinal" : `Serie ${i + 1}`;
  for (const [i, sr] of seriesRuns.entries()) {
    const name = dirHint ?? seriesName(i);
    for (const g of sr.games) g.series = name;
    const sorted = [...sr.wins.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length) warn.push(`postemporada: serie "${name}" ${sr.away} @ ${sr.home} \u2192 ${sorted.map(([t, w]) => `${t} ${w}`).join(" / ")}`);
  }
  const merges = opts?.merges ?? [];
  const mergedOut = new Set(
    players.filter((pl) => merges.some((mm) => mm.name.trim().toLowerCase() === pl.name.toLowerCase() && mm.team !== pl.team)).map((pl) => `${pl.name}|${pl.team}`)
  );
  for (const mm of merges) {
    if (!players.some((pl) => pl.name.toLowerCase() === mm.name.toLowerCase() && pl.team === mm.team))
      warn.push(`merge "${mm.name}" \u2192 ${mm.team}: no existe ficha en ese equipo`);
  }
  const yearCount = /* @__PURE__ */ new Map();
  for (const g of games) yearCount.set(Number(g.dateIso.slice(0, 4)), (yearCount.get(Number(g.dateIso.slice(0, 4))) ?? 0) + 1);
  const seasonYear = yearCount.size ? [...yearCount.entries()].sort((a, b) => b[1] - a[1])[0][0] : (/* @__PURE__ */ new Date()).getFullYear();
  const pox = {
    format: "pox-import/1",
    league: title(leagueName),
    sport: "softball",
    innings: 6,
    merges: merges.length ? merges : void 0,
    seasons: [{
      year: seasonYear,
      status: "ACTIVE",
      teams: teamNames.map((t) => ({ name: t })),
      players: players.filter((pl) => !mergedOut.has(`${pl.name}|${pl.team}`)).map((pl) => ({
        name: pl.name,
        team: pl.team,
        bats: pl.bats,
        throws: pl.throws,
        pos: pl.pos.join(",")
      })),
      series: seriesRuns.map((sr, i) => {
        const sorted = [...sr.wins.entries()].sort((a, b) => b[1] - a[1]);
        return {
          name: seriesName(i),
          round: i + 1,
          home: sr.games[0].home,
          away: sr.games[0].away,
          winner: sorted.length && sorted[0][1] > (sorted[1]?.[1] ?? -1) ? sorted[0][0] : void 0,
          status: "ENDED"
        };
      }),
      games: games.map((g) => ({
        date: g.dateIso,
        away: g.away,
        home: g.home,
        scoreAway: g.scoreAway,
        scoreHome: g.scoreHome,
        series: g.series,
        stats: g.stats
      }))
    }]
  };
  return { pox, warnings: warn, games: games.length, players: players.length, teams: teamNames };
}
var isCli = !!process.argv[1] && /conv-ballstat/.test(process.argv[1]);
var cliDir = isCli ? process.argv[2] : void 0;
if (cliDir && fs4.existsSync(cliDir)) {
  const outIdx = process.argv.indexOf("-o");
  const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
  const merges = [];
  process.argv.forEach((a, i) => {
    if (a === "--merge" && process.argv[i + 1]) {
      const [name, team] = process.argv[i + 1].split("|").map((s) => s.trim());
      if (name && team) merges.push({ name, team });
    }
  });
  const r10 = convertBallstatFolder(cliDir, { merges });
  console.log(`juegos: ${r10.games} \xB7 jugadores: ${r10.players} \xB7 equipos: ${r10.teams.join(" | ")}`);
  const json = JSON.stringify(r10.pox, null, 1);
  if (outFile) {
    fs4.writeFileSync(outFile, json);
    console.log(`escrito ${outFile} (${(json.length / 1024).toFixed(0)} KB)`);
  } else console.log(json.slice(0, 3e3));
  console.log(`avisos: ${r10.warnings.length}`);
  r10.warnings.slice(0, 15).forEach((w) => console.log("  \u26A0 " + w));
} else if (isCli) {
  console.error("uso: npx tsx src/conv-ballstat.ts <carpeta BallStat> [-o salida.json]");
}

// src/import/ballstat.ts
function detectBallstat(fileName, text) {
  const n = fileName.toLowerCase();
  if (isBallstatPackage(n) || n.endsWith(".sbk") || n.endsWith(".ros")) return true;
  const head = text.slice(0, 2e3).toLowerCase();
  return head.includes("ballscore") || head.includes("ballstat");
}
function isBallstatPackage(fileName) {
  return /\.(rar|zip)$/i.test(fileName);
}
function findLeagueRoot(dir, depth = 0) {
  if (depth > 4) return null;
  try {
    if (fs5.existsSync(path5.join(dir, "BallScore Reports"))) return dir;
    for (const e of fs5.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const r10 = findLeagueRoot(path5.join(dir, e.name), depth + 1);
        if (r10) return r10;
      }
    }
  } catch {
  }
  return null;
}
async function extractRar(buf, dest) {
  const extractor = await createExtractorFromData({ data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
  const list = extractor.getFileList();
  const names = [...list.fileHeaders].filter((h) => !h.flags.directory).map((h) => h.name);
  const { files } = extractor.extract({ files: names });
  for (const f of files) {
    if (!f.extraction) continue;
    const out = path5.join(dest, f.fileHeader.name.replace(/\\/g, "/"));
    fs5.mkdirSync(path5.dirname(out), { recursive: true });
    fs5.writeFileSync(out, Buffer.from(f.extraction));
  }
}
async function convertBallstatPackage(fileName, buf) {
  const tmp = fs5.mkdtempSync(path5.join(os.tmpdir(), "pox-bs-"));
  try {
    if (/\.rar$/i.test(fileName)) await extractRar(buf, tmp);
    else new AdmZip(buf).extractAllTo(tmp, true);
    const root = findLeagueRoot(tmp);
    if (!root) {
      throw Object.assign(new Error(
        'paquete BallStat sin datos reconocibles: debe contener la carpeta "BallScore Reports" (en BallStat: League \u2192 Generate \u2192 Web Pages / Text Reports). Los .sbk sueltos no se pueden leer todav\xEDa.'
      ), { status: 422 });
    }
    const r10 = convertBallstatFolder(root);
    return { file: r10.pox, warnings: r10.warnings };
  } finally {
    fs5.rmSync(tmp, { recursive: true, force: true });
  }
}
function convertBallstat(fileName, _text) {
  if (fileName.toLowerCase().endsWith(".sbk")) {
    throw Object.assign(
      new Error(".sbk es un scorebook binario propietario \u2014 sube el paquete de liga completo (.rar/.zip con BallScore Reports + WebBuilder)"),
      { status: 501 }
    );
  }
  throw Object.assign(
    new Error("formato BallStat no soportado a\xFAn \u2014 usa el .rar/.zip de la carpeta de liga completa"),
    { status: 501 }
  );
}

// src/routes/import.ts
var router = Router8();
router.post("/", async (req, res) => {
  try {
    const dry = req.query.dry === "1";
    const { name, data, encoding, appendToLeagueId, mergeSameName, replaceSeason, mergeSeason, playerAliases } = req.body;
    if (data == null) {
      res.status(400).json({ error: 'falta "data" (contenido del archivo)' });
      return;
    }
    let raw = data;
    let convWarnings = [];
    if (encoding === "base64" && isBallstatPackage(name ?? "")) {
      const r10 = await convertBallstatPackage(name ?? "liga.zip", Buffer.from(String(data), "base64"));
      raw = r10.file;
      convWarnings = r10.warnings;
    } else if (typeof data === "string") {
      try {
        raw = JSON.parse(data);
      } catch {
        if (detectBallstat(name ?? "", data)) {
          raw = convertBallstat(name ?? "", data);
        } else {
          res.status(400).json({ error: "el archivo no es JSON ni un formato reconocido (.pox.json / .rar / .zip)" });
          return;
        }
      }
    }
    if (isBackupFile(raw)) {
      if (dry) {
        const b = raw;
        res.json({
          ok: true,
          preview: {
            league: "Respaldo PoxScore",
            sport: "baseball",
            seasons: (b.seasons ?? []).length,
            teams: (b.teams ?? []).length,
            players: (b.players ?? []).length,
            games: (b.games ?? []).length,
            gamesWithEvents: 0,
            warnings: ["Es un respaldo completo \u2014 restaura todas las tablas sin duplicar."]
          },
          backup: true
        });
        return;
      }
      const { imported } = await importBackup(raw);
      res.json({ ok: true, backup: true, imported });
      return;
    }
    const { file, errors, warnings } = validatePox(raw);
    warnings.push(...convWarnings);
    if (!file) {
      const keys = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw).slice(0, 14).join(", ") : typeof raw;
      res.status(422).json({ error: `${errors.join(" \xB7 ")} \u2014 claves del archivo: ${keys}`, errors, warnings });
      return;
    }
    if (dry) {
      const fileYear = /(?:19|20)\d{2}/.exec(name ?? "")?.[0];
      const seasonYears = [...new Set(file.seasons.map((s) => s.year))];
      if (fileYear && !seasonYears.includes(Number(fileYear))) {
        warnings.unshift(`el archivo se llama "${name}" pero sus juegos se detectaron como temporada ${seasonYears.join("/")} \u2014 verifica el a\xF1o antes de anexar o reemplazar`);
      }
      const append = appendToLeagueId ? await appendPreview(file, appendToLeagueId) : void 0;
      res.json({ ok: true, preview: previewPox(file, warnings), append });
      return;
    }
    const result = await importPox(file, warnings, { appendToLeagueId, mergeSameName, replaceSeason, mergeSeason, playerAliases });
    res.json({ ok: true, ...result });
  } catch (e) {
    const err = e;
    res.status(err.status ?? 500).json({ error: err.message, leagueId: err.leagueId });
  }
});
router.post("/boxscore", async (req, res) => {
  try {
    const { leagueId, seasonId, name, data, dry, awayTeamId, homeTeamId, overrides, newNames } = req.body;
    if (!leagueId || !data) return res.status(400).json({ error: "leagueId y data requeridos" });
    const league = await prisma.league.findUnique({ where: { id: leagueId }, include: { teams: { include: { players: true } } } });
    if (!league) return res.status(404).json({ error: "Liga no encontrada" });
    const txt = /^[A-Za-z0-9+/=\r\n]+$/.test(data.slice(0, 400)) && data.length > 200 && !data.includes("{\\rtf") && !data.trimStart().startsWith("{") ? Buffer.from(data, "base64").toString("utf8") : data;
    const box = parseBoxFile(txt, name);
    if (!box) return res.status(422).json({ error: "No se reconoci\xF3 el archivo \u2014 no parece un box score de BallScore (.box.txt)" });
    const teamNames = [...new Set([box.away, box.home, ...box.rows.map((r10) => r10.team)].filter(Boolean))];
    const teamMatch = /* @__PURE__ */ new Map();
    for (const tn of teamNames) {
      const t = awayTeamId && tn === box.away ? league.teams.find((x) => x.id === awayTeamId) : homeTeamId && tn === box.home ? league.teams.find((x) => x.id === homeTeamId) : bestTeam(tn, league.teams);
      teamMatch.set(tn, t ? { id: t.id, name: t.name } : null);
    }
    const awayT = awayTeamId ? league.teams.find((t) => t.id === awayTeamId) : bestTeam(box.away, league.teams);
    const homeT = homeTeamId ? league.teams.find((t) => t.id === homeTeamId) : bestTeam(box.home, league.teams);
    const allPlayers = league.teams.flatMap((t) => t.players.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName, teamId: t.id, teamName: t.name })));
    const teamOf = new Map(allPlayers.map((p) => [p.id, p.teamName]));
    const ov = overrides ?? {};
    const preview = box.rows.map((r10) => {
      const tm = teamMatch.get(r10.team);
      const roster = r10.team ? league.teams.find((t) => t.id === tm?.id)?.players ?? [] : allPlayers;
      const inTeam = new Set(roster.map((p) => p.id));
      let cands = [
        ...bestMatches(r10.name, roster).map((c) => ({ ...c, team: tm?.name ?? "", sameTeam: true })),
        ...bestMatches(r10.name, allPlayers).filter((c) => !inTeam.has(c.playerId)).map((c) => ({ ...c, team: teamOf.get(c.playerId) ?? "", sameTeam: false }))
      ].sort((a, b) => b.score - a.score || Number(b.sameTeam) - Number(a.sameTeam)).slice(0, 5).map((c) => ({ ...c, name: c.name.replace(/^·\s*/, "") }));
      if (r10.noName && r10.team) {
        const pits = box.rows.filter((x) => x !== r10 && x.section === "pit" && x.team === r10.team);
        const solo = /^p$/i.test(r10.name.trim()) && pits.length === 1 ? 80 : 0;
        const sug = pits.flatMap((x) => bestMatches(x.name, allPlayers)).filter((c) => c.score >= 60 || solo).map((c) => ({ ...c, score: Math.max(c.score, solo || 50), team: teamOf.get(c.playerId) ?? "", sameTeam: true }));
        cands = [...sug, ...cands].sort((a, b) => b.score - a.score).slice(0, 5);
      }
      const best = cands[0];
      const key = `${normName(r10.team)}|${r10.name}`;
      const o = ov[key];
      const surnameOnly = !fileNameParts(r10.name).first;
      const ambiguous = !!best && surnameOnly && cands.filter((c) => c.score === best.score).length > 1;
      const autoOk = best && !ambiguous && best.score >= (r10.partial || r10.noName ? 78 : 60);
      return {
        key,
        file: r10.name,
        teamFile: r10.team,
        section: r10.section,
        pos: r10.pos,
        dec: r10.dec,
        stats: r10.stats,
        partial: r10.partial,
        noName: r10.noName,
        ambiguous,
        matchId: o && o !== "NEW" && o !== "SKIP" ? o : autoOk ? best.playerId : null,
        matchName: autoOk ? best.name : null,
        matchScore: best?.score ?? 0,
        matchTeam: autoOk ? best.team : null,
        moved: !!(autoOk && !best.sameTeam),
        // matcheó pero hoy juega en OTRO equipo (traspasado)
        candidates: cands,
        action: o === "SKIP" ? "skip" : o === "NEW" ? "new" : o ? "picked" : autoOk ? "auto" : r10.noName || r10.partial ? "skip" : "new"
      };
    });
    if (dry) {
      const dup = awayT && homeT ? await prisma.game.findFirst({
        where: {
          leagueId,
          awayTeamId: awayT.id,
          homeTeamId: homeT.id,
          status: "FINAL",
          OR: [{ fScoreAway: box.scoreAway, fScoreHome: box.scoreHome }],
          ...box.dateIso ? { date: { gte: /* @__PURE__ */ new Date(box.dateIso + "T00:00:00"), lt: /* @__PURE__ */ new Date(box.dateIso + "T23:59:59") } } : {}
        }
      }) : null;
      return res.json({
        ok: true,
        dry: true,
        box: { dateIso: box.dateIso, away: box.away, home: box.home, scoreAway: box.scoreAway, scoreHome: box.scoreHome, innings: box.innings, wp: box.wp, lp: box.lp, sv: box.sv },
        awayTeam: { file: box.away, teamId: awayT?.id ?? null, name: awayT?.name ?? null },
        homeTeam: { file: box.home, teamId: homeT?.id ?? null, name: homeT?.name ?? null },
        teams: [...teamMatch.entries()].map(([file, m]) => ({ file, teamId: m?.id ?? null, name: m?.name ?? null })),
        players: preview,
        // roster completo de la liga para la búsqueda manual del admin
        roster: allPlayers.map((p) => ({
          id: p.id,
          team: p.teamName,
          name: `${p.firstName === "\xB7" ? "" : p.firstName + " "}${p.lastName}`.trim()
        })),
        dupGameId: dup?.id ?? null,
        warnings: box.warnings
      });
    }
    if (!awayT || !homeT) return res.status(400).json({ error: "Asigna los dos equipos de la liga antes de importar" });
    const season = seasonId ? await prisma.season.findUnique({ where: { id: seasonId } }) : await prisma.season.findFirst({ where: { leagueId, status: "ACTIVE" } });
    const seasonYear = season?.year ?? league.year;
    let created = 0;
    const resolvePlayer = async (r10, teamId) => {
      const roster = league.teams.find((t) => t.id === teamId)?.players ?? [];
      const o = ov[`${normName(r10.team)}|${r10.name}`];
      if (o === "SKIP") return null;
      if (o && o !== "NEW") return o;
      if (r10.noName) return null;
      const best = bestMatches(r10.name, roster)[0];
      if (best && best.score >= 60) return best.playerId;
      const wide = bestMatches(r10.name, allPlayers)[0];
      if (wide && wide.score >= 60) return wide.playerId;
      const nn = newNames?.[`${normName(r10.team)}|${r10.name}`]?.trim();
      const parts = fileNameParts(nn || r10.name);
      const title2 = (s) => s.toLowerCase().replace(/(^|\s|[,'-])\S/g, (c) => c.toUpperCase());
      const p = await prisma.player.create({
        data: {
          teamId,
          firstName: parts.first ? title2(parts.first) : "\u2014",
          lastName: parts.last ? title2(parts.last) : title2(parts.first) || r10.name,
          active: true
        }
      });
      created++;
      (league.teams.find((t) => t.id === teamId)?.players).push({ id: p.id, firstName: p.firstName, lastName: p.lastName });
      return p.id;
    };
    const merged = /* @__PURE__ */ new Map();
    const skipped = [];
    for (const r10 of box.rows) {
      const tm = teamMatch.get(r10.team);
      let teamId = r10.team === box.away ? awayT.id : r10.team === box.home ? homeT.id : tm?.id;
      const oRow = ov[`${normName(r10.team)}|${r10.name}`];
      if (!teamId && oRow && oRow !== "NEW" && oRow !== "SKIP") {
        teamId = allPlayers.find((p) => p.id === oRow)?.teamId;
      }
      if (!teamId) {
        skipped.push(`${r10.name} (${r10.team || "solo en notas"})`);
        continue;
      }
      const pid = await resolvePlayer(r10, teamId);
      if (!pid) {
        skipped.push(r10.name);
        continue;
      }
      const k = `${pid}|${teamId}`;
      const line = merged.get(k) ?? { playerId: pid, teamId, g: 1 };
      for (const [sk, sv2] of Object.entries(r10.stats)) {
        if (sk === "pOuts") line[sk] = (Number(line[sk]) || 0) + sv2;
        else line[sk] = (Number(line[sk]) || 0) + sv2;
      }
      if (r10.pos && !line.pos) line.pos = r10.pos;
      if (r10.dec === "W") line.w = 1;
      if (r10.dec === "L") line.l = 1;
      if (r10.dec === "S") line.sv = 1;
      if (r10.dec === "H") line.hld = 1;
      if (r10.dec === "BS") line.bs = 1;
      merged.set(k, line);
    }
    for (const line of merged.values()) {
      if (line.pa == null) {
        line.pa = Number(line.ab ?? 0) + Number(line.bb ?? 0) + Number(line.hbp ?? 0) + Number(line.sac ?? 0) + Number(line.sf ?? 0);
      }
    }
    const statLines = [...merged.values()];
    const inGame = (nm) => {
      if (!nm) return null;
      const roster = [...awayT.players ?? [], ...homeT.players ?? [], ...allPlayers];
      const b = bestMatches(nm, roster)[0];
      return b && b.score >= 60 ? b.playerId : null;
    };
    const wpId = inGame(box.wp) ?? statLines.find((l) => l.w)?.playerId ?? null;
    const lpId = inGame(box.lp) ?? statLines.find((l) => l.l)?.playerId ?? null;
    const svId = inGame(box.sv) ?? statLines.find((l) => l.sv)?.playerId ?? null;
    const date = box.dateIso ? /* @__PURE__ */ new Date(box.dateIso + "T12:00:00") : /* @__PURE__ */ new Date();
    const game = await prisma.game.create({
      data: {
        date,
        status: "FINAL",
        sport: league.sport,
        innings: box.innings || league.innings || 9,
        leagueId,
        seasonId: season?.id ?? null,
        awayTeamId: awayT.id,
        homeTeamId: homeT.id,
        fScoreAway: box.scoreAway,
        fScoreHome: box.scoreHome,
        endedAt: date,
        wpId,
        lpId,
        svId,
        statLines: JSON.parse(JSON.stringify(statLines)),
        seasonApplied: true,
        // el acumulado se hace abajo línea por línea
        note: `Importado de box score BallScore${name ? ` (${name})` : ""}`
      }
    });
    for (const line of statLines) {
      const data2 = {};
      for (const [k, v] of Object.entries(line)) {
        if (typeof v !== "number" || ["playerId", "teamId", "pos", "po", "a", "bf"].includes(k)) continue;
        data2[k] = v;
      }
      await prisma.playerSeasonStat.upsert({
        where: { playerId_season_scope: { playerId: line.playerId, season: seasonYear, scope: "REG" } },
        create: { playerId: line.playerId, season: seasonYear, scope: "REG", ...data2 },
        update: Object.fromEntries(Object.entries(data2).map(([k, v]) => [k, { increment: v }]))
      });
    }
    res.json({
      ok: true,
      gameId: game.id,
      players: statLines.length,
      created,
      skipped,
      warnings: box.warnings
    });
  } catch (e) {
    const err = e;
    res.status(err.status ?? 500).json({ error: err.message });
  }
});
router.post("/boxscore/zip-totals", async (req, res) => {
  try {
    const { leagueId, playerId, data } = req.body;
    if (!data || typeof data !== "string") return res.status(400).json({ error: "falta data (base64 del .zip)" });
    let zip;
    try {
      zip = new AdmZip2(Buffer.from(data, "base64"));
    } catch {
      return res.status(400).json({ error: "el archivo no es un .zip v\xE1lido" });
    }
    const entries = zip.getEntries().filter((e) => !e.isDirectory && /\.box\.txt$/i.test(e.entryName));
    if (!entries.length) return res.status(422).json({ error: "el .zip no trae archivos .box.txt" });
    const DEC_STAT = { W: "w", L: "l", S: "sv", H: "hld", BS: "bs" };
    const groups = /* @__PURE__ */ new Map();
    const years = /* @__PURE__ */ new Map();
    const skipped = [];
    let files = 0;
    entries.forEach((en, fi) => {
      const buf = en.getData();
      let txt;
      try {
        txt = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        txt = new TextDecoder("windows-1252").decode(buf);
      }
      const box = parseBoxFile(txt, en.entryName.split(/[\\/]/).pop());
      if (!box) {
        skipped.push(en.entryName);
        return;
      }
      files++;
      if (box.dateIso) {
        const y = Number(box.dateIso.slice(0, 4));
        if (y > 1900 && y < 2200) years.set(y, (years.get(y) ?? 0) + 1);
      }
      const ord = /* @__PURE__ */ new Map();
      const rowKey = /* @__PURE__ */ new Map();
      const batPos = /* @__PURE__ */ new Map();
      for (const r10 of box.rows) {
        if (r10.section !== "bat") continue;
        const baseKey = `${normName(r10.team)}|${normName(r10.name)}`;
        const n = (ord.get(baseKey) ?? 0) + 1;
        ord.set(baseKey, n);
        const key = n > 1 ? `${baseKey}|#${n}` : baseKey;
        rowKey.set(r10, key);
        const arr = batPos.get(baseKey) ?? [];
        arr.push({ key, pos: r10.pos ?? "" });
        batPos.set(baseKey, arr);
      }
      for (const r10 of box.rows) {
        const baseKey = `${normName(r10.team)}|${normName(r10.name)}`;
        let key = rowKey.get(r10) ?? baseKey;
        if (r10.section === "pit" && !rowKey.has(r10)) {
          const bats = batPos.get(baseKey) ?? [];
          if (bats.length > 1) key = (bats.find((b) => /(^|-)P(-|$)/i.test(b.pos)) ?? bats[0]).key;
        }
        const g = groups.get(key) ?? { name: r10.name + (key !== baseKey ? ` (${key.split("|#")[1]})` : ""), team: r10.team, baseKey, dup: key !== baseKey, files: /* @__PURE__ */ new Set(), pitFiles: /* @__PURE__ */ new Set(), stats: {} };
        g.files.add(fi);
        if (r10.section === "pit") g.pitFiles.add(fi);
        const rs = r10.section === "bat" && r10.stats.pa == null ? { ...r10.stats, pa: (r10.stats.ab ?? 0) + (r10.stats.bb ?? 0) + (r10.stats.hbp ?? 0) + (r10.stats.sac ?? 0) + (r10.stats.sf ?? 0) } : r10.stats;
        for (const [k, v] of Object.entries(rs)) {
          if (typeof v === "number" && Number.isFinite(v)) g.stats[k] = (g.stats[k] ?? 0) + v;
        }
        const dk = r10.dec ? DEC_STAT[r10.dec] : void 0;
        if (dk) g.stats[dk] = (g.stats[dk] ?? 0) + 1;
        groups.set(key, g);
      }
    });
    if (!files) return res.status(422).json({ error: `ning\xFAn archivo se reconoci\xF3 como box score (${skipped.length} omitidos)` });
    const year = [...years.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? (leagueId ? (await prisma.league.findUnique({ where: { id: leagueId }, select: { year: true } }))?.year : void 0) ?? (/* @__PURE__ */ new Date()).getFullYear();
    let current = null;
    const suggested = /* @__PURE__ */ new Set();
    if (playerId) {
      const p = await prisma.player.findUnique({ where: { id: playerId } });
      if (p) {
        const row = await prisma.playerSeasonStat.findUnique({
          where: { playerId_season_scope: { playerId, season: year, scope: "REG" } }
        });
        if (row) {
          const { id: _i, playerId: _p, season: _s, scope: _sc, adj: _a, ...rest } = row;
          current = rest;
        }
        const lite = { id: p.id, firstName: p.firstName, lastName: p.lastName };
        for (const [key, g] of groups) if (matchScore(g.name, lite) >= 60) suggested.add(key);
      }
    }
    for (const [key, g] of groups) {
      if (key.includes("|#")) {
        const base = groups.get(g.baseKey);
        if (base) base.dup = true;
      }
    }
    const players = [...groups.entries()].map(([key, g]) => ({
      key,
      name: g.name,
      team: g.team,
      suggested: suggested.has(key),
      dup: g.dup,
      stats: { g: g.files.size, gp: g.pitFiles.size, ...g.stats }
    })).sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.team.localeCompare(b.team) || a.name.localeCompare(b.name));
    res.json({ ok: true, files, skipped, year, players, current });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
var import_default = router;

// src/routes/auth.ts
import { Router as Router9 } from "express";
var r8 = Router9();
var pub = (u) => ({ id: u.id, username: u.username, role: u.role, active: u.active });
r8.get("/status", async (req, res) => {
  const enabled = await authEnabled();
  const tok = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  let user = null;
  if (tok) {
    const t = await prisma.authToken.findUnique({ where: { token: tok }, include: { user: true } });
    if (t && t.expiresAt > /* @__PURE__ */ new Date() && t.user.active) user = pub(t.user);
  }
  res.json({ enabled, user });
});
r8.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Usuario y contrase\xF1a requeridos" });
  const u = await prisma.user.findUnique({ where: { username } });
  if (!u || !u.active || !checkPassword(password, u.passHash)) return res.status(401).json({ error: "Usuario o contrase\xF1a incorrectos" });
  await prisma.authToken.deleteMany({ where: { expiresAt: { lt: /* @__PURE__ */ new Date() } } });
  const t = await issueToken(u.id);
  res.json({ token: t.token, user: pub(u) });
});
r8.post("/verify", async (req, res) => {
  const auth = await adminOk(String(req.body?.password ?? ""));
  if (!auth.ok) return res.status(auth.code ?? 401).json({ error: auth.error ?? "Contrase\xF1a incorrecta" });
  res.json({ ok: true });
});
r8.post("/logout", async (req, res) => {
  const tok = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (tok) await prisma.authToken.deleteMany({ where: { token: tok } });
  res.json({ ok: true });
});
r8.get("/users", async (req, res) => {
  if (!await authEnabled()) return res.json([]);
  const u = await reqUser(req);
  if (u?.role !== "admin") return res.status(403).json({ error: "Requiere rol admin" });
  res.json((await prisma.user.findMany({ orderBy: { username: "asc" } })).map(pub));
});
r8.post("/users", async (req, res) => {
  const { username, password, role } = req.body;
  if (!username?.trim() || !password) return res.status(400).json({ error: "Usuario y contrase\xF1a requeridos" });
  const bootstrap = !await authEnabled();
  const roleOk = bootstrap ? "admin" : role === "admin" || role === "visita" ? role : "anotador";
  if (!bootstrap) {
    const u2 = await reqUser(req);
    if (u2?.role !== "admin") return res.status(403).json({ error: "Requiere rol admin" });
  }
  const u = await prisma.user.create({ data: { username: username.trim(), passHash: hashPassword(password), role: roleOk } });
  invalidateAuthCache();
  res.json({ ...pub(u), ...bootstrap ? { token: (await issueToken(u.id)).token } : {} });
});
r8.put("/users/:id", guard("admin"), async (req, res) => {
  const { password, role, active } = req.body;
  const u = await prisma.user.update({
    where: { id: req.params.id },
    data: {
      ...password ? { passHash: hashPassword(password) } : {},
      ...role === "admin" || role === "anotador" || role === "visita" ? { role } : {},
      ...active !== void 0 ? { active: !!active } : {}
    }
  });
  res.json(pub(u));
});
r8.delete("/users/:id", guard("admin"), async (req, res) => {
  await prisma.user.delete({ where: { id: req.params.id } });
  invalidateAuthCache();
  res.json({ ok: true });
});
var auth_default = r8;

// src/routes/ai.ts
import { Router as Router10 } from "express";
import fs6 from "node:fs";
import path6 from "node:path";
import { fileURLToPath } from "node:url";

// src/services/ai.ts
async function aiChat(system, user) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const r10 = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }]
      })
    });
    if (!r10.ok) {
      console.error(`OpenAI chat ${r10.status}:`, (await r10.text()).slice(0, 300));
      return null;
    }
    const j = await r10.json();
    const txt = j.choices?.[0]?.message?.content ?? "";
    return JSON.parse(txt);
  } catch {
    return null;
  }
}
var aiEnabled = () => !!process.env.OPENAI_API_KEY;
async function aiCheck() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, error: "sin clave" };
  try {
    const r10 = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    if (r10.ok) return { ok: true };
    const j = await r10.json().catch(() => ({}));
    return { ok: false, error: `OpenAI ${r10.status}: ${j.error?.message ?? r10.statusText}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
async function aiTranscribe(audioB64, mime) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { error: "sin clave OpenAI \u2014 config\xFArala en \u{1F3A4} \u2192 \u2699\uFE0F" };
  try {
    const buf = Buffer.from(audioB64, "base64");
    const ext = mime.includes("webm") ? "webm" : mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "wav";
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: mime }), `audio.${ext}`);
    fd.append("model", "whisper-1");
    fd.append("language", "es");
    const r10 = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: fd
    });
    if (!r10.ok) {
      const j = await r10.json().catch(() => ({}));
      return { error: `OpenAI ${r10.status}: ${j.error?.message ?? r10.statusText}` };
    }
    return { text: (await r10.json()).text ?? "" };
  } catch (e) {
    return { error: e.message };
  }
}
var DOMINICAN_GLOSSARY = `
Diccionario dominicano de pelota:
- "rolling"/"roling"/"rol\xEDn" = rodado (ground out, ej. "rolling por segunda" = 4-3)
- "tablazo"/"batazo"/"bombazo" = hit / jonr\xF3n seg\xFAn contexto ("se fue" = HR)
- "l\xEDnea"/"li\xF1a" = line drive (L7/L8/L9)
- "elevado"/"fly"/"flai" = fly out (F7/F8/F9)
- "ponche"/"chocolate"/"se lo cantaron"/"tir\xE1ndole" = K (strikeout)
- "base por bola"/"boleto"/"pasaporte"/"cuatro malas" = BB
- "pelotazo"/"bolazo"/"lo golpearon" = HBP
- "se la tir\xF3 el derecho/left/center" = hit a RF/LF/CF
- "se embas\xF3 por error"/"el antesalista la bot\xF3" = E5 etc.
- "doble play"/"dobleplei"/"dos por uno" = DP
- "anot\xF3 una"/"pis\xF3 el plato"/"entr\xF3 en carrera" = carrera
- "robo"/"se estaf\xF3"/"lleg\xF3 callao" = SB
- "wild pitch"/"descontrol" = WP ; "pasbola" = PB
- "sacrificio"/"toque"/"toquito" = SAC/SH ; "fly de sacrificio" = SF
- "hit por el right/left/center" = hit al jard\xEDn derecho/izquierdo/central
- "abierto por ..." = hit a la banda contraria
`;

// src/routes/ai.ts
var r9 = Router10();
var loadEvents2 = async (gameId) => (await prisma.gameEvent.findMany({ where: { gameId }, orderBy: { seq: "asc" } })).map(toEvent);
var envPath = () => {
  const dir = path6.dirname(fileURLToPath(import.meta.url));
  const cands = [
    path6.resolve(dir, "../.env"),
    // dist bundle (server/dist) → server/.env
    path6.resolve(dir, "../../.env"),
    // src/routes → server/.env
    path6.resolve(process.cwd(), ".env"),
    // cwd = server (launcher)
    path6.resolve(process.cwd(), "server", ".env")
    // cwd = raíz del repo
  ];
  return cands.find((p) => fs6.existsSync(p)) ?? cands[0];
};
r9.get("/ai/config", (_req, res) => {
  res.json({ openai: aiEnabled() });
});
r9.post("/ai/config", async (req, res) => {
  const key = String(req.body?.openaiKey ?? "").trim();
  const fp = envPath();
  const lines = fs6.existsSync(fp) ? fs6.readFileSync(fp, "utf8").split(/\r?\n/) : [];
  let found = false;
  const out = lines.map((l) => /^OPENAI_API_KEY\s*=/.test(l) ? (found = true, key ? `OPENAI_API_KEY=${key}` : null) : l).filter((l) => l !== null);
  if (!found && key) out.push(`OPENAI_API_KEY=${key}`);
  fs6.writeFileSync(fp, out.join("\n"));
  if (key) process.env.OPENAI_API_KEY = key;
  else delete process.env.OPENAI_API_KEY;
  const check = key ? await aiCheck() : null;
  res.json({ ok: true, openai: !!key, valid: check?.ok ?? null, error: check?.error });
});
var playerName = (p) => p ? `${p.number ? `#${p.number} ` : ""}${p.firstName} ${p.lastName}` : "";
var CODE_MAP = {
  K: { result: "K" },
  BB: { result: "BB" },
  IBB: { result: "IBB" },
  HBP: { result: "HBP" },
  "2B": { result: "2B" },
  "3B": { result: "3B" },
  HR: { result: "HR" },
  HRIP: { result: "HRIP" },
  FC: { result: "FC" },
  SF: { result: "SF" },
  SH: { result: "SAC" },
  SAC: { result: "SAC" },
  SB: { result: "SB" },
  CS: { result: "CS" },
  WP: { result: "WP" },
  PB: { result: "PB" },
  BK: { result: "BK" }
};
function codeToEngine(code) {
  const c = code.trim().toUpperCase();
  if (CODE_MAP[c]) return CODE_MAP[c];
  if (/^H[1-4]$/.test(c)) return { result: { H1: "1B", H2: "2B", H3: "3B", H4: "HR" }[c], notation: c };
  if (/^H[789]$/.test(c)) return { result: "1B", notation: c };
  if (/^[1-9]?E?[1-9]$/.test(c.replace("E", "")) && c.startsWith("E")) return { result: "E", notation: c };
  if (/^[1-9]-[1-9]-[1-9]$/.test(c)) return { result: "DP", notation: c };
  if (/^[1-9]-[1-9]$/.test(c)) return { result: "GO", notation: c };
  if (/^U?[1-9]$/.test(c) || /^[FL][1-9]$/.test(c)) return { result: "FO", notation: c };
  if (/^[1-9]$/.test(c)) return { result: "FO", notation: c };
  return null;
}
var FALLBACK_PHRASES = [
  /* ---- multi-out ---- */
  [/triple ?play|tripleplay|triple ?plei|triple matanza|\btp\b/i, { result: "TP" }, "triple play"],
  [/dobl?e ?pl?a?y|doble ?plei|double ?play|dos por uno|6-4-3|cuatro seis tres|doble matanza|\bmatanza\b|\bdp\b/i, { result: "DP", notation: "6-4-3" }, "doble play"],
  /* ---- ponche y pasaportes ---- */
  // tercer strike suelto: K + wild pitch o K + pasbola (el bateador corre a 1ra)
  [/ponche\w*.{0,30}(pasbola|pasbol|se le (fue|escap[óo])( la bola)? al (receptor|catcher|mascota)|dej[óo] caer)|tercer strike.{0,25}(pas[óo]|suelto|malo|se le fue|escap[óo])/i, { result: "KPB" }, "ponche + pasbola"],
  [/ponche\w*.{0,30}(wild|descontrol|pitcheo malo|lanzamiento malo|bola loca)|tercer strike.{0,25}wild/i, { result: "KWP" }, "ponche + wild pitch"],
  [/foul tip|toque.{0,15}foul|foul.{0,15}toque/i, { result: "K" }, "foul tip al tercer strike"],
  [/ponche|chocolate|tir[áa]ndole|cantaron|cant[óo] el|abanic[óo]|se lo comi[óo]|puls[oó]|pulso|mirando|tres strikes|strike tres|lo sent[óo]|lo domin[óo] tirando|se fue en blanco|lo dej[óo] mirando/i, { result: "K" }, "ponche"],
  [/base intencional|boleto intencional|pasaporte intencional|base autom[aá]tica|pasaporte autom[aá]tico|la pasaron|lo pasaron|le dieron (la )?base intencional/i, { result: "IBB" }, "base intencional"],
  [/indiferencia|defensive indifference|le regalaron la base|le regal[oó] la base|nadie le tir|la dejaron tomar/i, { result: "DI" }, "indiferencia defensiva"],
  [/base por bola|boleto|pasaporte|cuatro malas|cuatro bolas|(?<!el |la |un |del |su |mismo )camin[oó]|lo caminaron|le caminaron|le di[oó] la base|le regal[oó] la primera|free pass|regal[óo] de base/i, { result: "BB" }, "base por bolas"],
  [/pelota[sz]a?o|bola[sz]a?o|golpead|hit by pitch|lo tocaron|lo golpe[oó]|lo golpearon|le peg[oó] (la|una|el)? ?bola|le dio (un )?pelota[sz]a?o|pelota[sz]a?o en/i, { result: "HBP" }, "pelotazo (HBP)"],
  /* ---- extra bases ---- */
  // hit + error va ANTES que el hit pelado ("sencillo y error del right" → 1BE)
  [/triple.{0,20}error/i, { result: "3BE" }, "triple con error"],
  [/doble.{0,20}error|doblete.{0,20}error|hit de dos.{0,15}error/i, { result: "2BE" }, "doble con error"],
  [/sencillo.{0,20}error|hit.{0,20}error|j[ií]t.{0,20}error|imparable.{0,20}error/i, { result: "1BE" }, "sencillo con error"],
  [/bate[óo] fuera de turno|bateador fuera de turno|turno robado|bateador equivocado|bate[óo] por otro/i, { result: "OOT" }, "bate\xF3 fuera de turno"],
  [/dentro del parque|inside the park|corri[óo] las cuatro bases|se dio la vuelta completa|cuadrangular dentro/i, { result: "HRIP" }, "jonr\xF3n dentro del parque"],
  [/jonr[óo]n|cuadrangular|se fue(?! ?(antes|temprano|para|corriendo|de la base|a segunda|a tercera))|bot[óo] la bola|homerun|home run|tabla[sz]o|desapareci[óo]|la sac[oó] del|cuatro esquinas|chinela|se la vol[oó]|por el muro|la mand[oó] pa fuera|grand slam|bases llenas|casa llena/i, { result: "HR" }, "jonr\xF3n"],
  [/triple(?! ?play)|tres bases|tres almohadillas/i, { result: "3B" }, "triple"],
  [/doble(?! ?play| ?matanza| ?robo)|doblete|dos bases|dos almohadillas|tubey|doble por regla|ground rule|bot[óo] y sali[óo]|bot[óo] pa fuera|se meti[óo] debajo|salt[óo] la verja|por debajo de la verja|doble de regla|rebote por encima/i, { result: "2B" }, "doble"],
  /* ---- corrido de bases — mid-play (NO terminan el turno del bateador) ---- */
  // OJO: "atrapa" suelto NO es CS — "la atrapa el center" es un elevado atrapado.
  // CS exige atrapado/atrapó (pasado) o contexto de robo/corrido.
  [/caught stealing|atrapad\w*|lo atrap[óo]|lo atraparon|lo pescaron|lo esperaron|pillor|pillado|lo cogieron|out robando|retirad\w* robando|retirado en el robo|no pudo robar|lo pararon|lo quemaron|fuzil|lo mataron|fuera robando|no lleg[oó]|lo fusilaron|intento de robo|rundown|entre (las |dos )?bases|en el corrido|en la calle|lo agarraron entre|fuera de (la )?l[íi]nea|se sali[óo] de la l[íi]nea|abandon[óo] (la|su) base|fuera de la raya/i, { result: "CS" }, "atrapado robando"],
  [/pick ?off|sorprend|enganchad|dormido en la base|lo agarraron|revire|tir[oó] atr[áa]s|pill[oó] fuera|lo pillaron|descuidado en la base/i, { result: "PK" }, "pickoff"],
  [/lanzamiento ilegal|illegal pitch|pitcheo ilegal|pitch ilegal|lanzamiento prohibido/i, { result: "IPL" }, "lanzamiento ilegal"],
  [/sale temprano|sali[óo] temprano|anticipado|se fue antes|arranc[óo] temprano|se adelant[óo]|salieron antes|left early|dej[óo] la base antes/i, { result: "LE" }, "sale temprano"],
  [/avanza? por (un )?error|avance por (un )?error|por (el|un) error del|error en el tiro|tiro malo|la tiraron mal|tir[oó] mal|levant[óo] el tiro|pas[óo] el tiro|tiro desviado|tir[oó] para cualquier lado/i, { result: "ADJ" }, "avance por error"],
  [/robo|rob[óo]|se estaf[óo]|estaf[oó]|estafa|se la rob[óo]|lleg[óo] callao|stolen|se meti[óo]|vino robando|robadita|arranc[óo] (para|pa'?l?)|corri[óo] (para|pa'?l?)|le peg[óo] el robo|se fue para|se lanz[óo] (para|pa'?l?)|doble robo|se robaron|robaron dos/i, { result: "SB" }, "robo"],
  [/wild|descontrol|bola loca|pitcheo malo|se le fue al pitcher|se le escap[óo] al pitcher|env[ií]o malo|env[ií]o descontrolado|pitch descontrolado|bola salvaje|pic[óo] el lanzamiento/i, { result: "WP" }, "wild pitch"],
  [/pasbola|pasbol|passed ball|se le fue al receptor|se le escap[óo] al (catcher|receptor|mascota)|pas[óo] entre las piernas|se le fue la bola|no la aguant[óo]|bola pasada|la dej[óo] pasar|dej[óo] pasar la bola/i, { result: "PB" }, "pasbola"],
  [/balk|balc|desm[áa]n|movimiento ilegal|enga[ñn][óo] al corredor|se vir[oó] el pitcher|se vir[oó] en la loma/i, { result: "BK" }, "balk"],
  /* ---- sacrificios, selección, reglas especiales ---- */
  [/elevado de sacrificio|fly de sacrificio|sacrifice fly|sacro de fly|sacro fly|sacrificio de fly|fly de sacro|elevado productor|fly productor/i, { result: "SF" }, "fly de sacrificio"],
  [/sacrificio|toque|toquito|toc[óo] la bola|deposit[óo]|de posit|jug[óo] al toque|toquecito|tocadita|muertito|squeeze|toque suicida|suicida|arrastr[óe]|arrastre|toc[óo] por|por la banda/i, { result: "SAC" }, "toque de sacrificio"],
  [/selecci[óo]n|choice|decidi[óo]|forzad|force|eligieron|fueron por el corredor|prioriz[oó] el corredor|jugaron al plato/i, { result: "FC" }, "jugada de selecci\xF3n"],
  [/infield fly|regla infield|fly corto|in fil flai/i, { result: "IF" }, "infield fly"],
  [/interferencia del catcher|catcher interfer|obstrucci[óo]n del (catcher|receptor|mascota)/i, { result: "CI" }, "interferencia del catcher"],
  [/obstrucci[óo]n|obstruy[óo]|le tap[óo] la base|le cerr[óo] el camino/i, { result: "OBS" }, "obstrucci\xF3n"],
  [/interferencia (del? |de un )?fan[aá]tico|fan[aá]tico.{0,20}(toc[óo]|agarr[óo]|interfiri)|un fan[aá]tico la (toc[óo]|agarr[óo])/i, { result: "FI" }, "interferencia de fan\xE1tico"],
  [/interferencia|interfiri[óo]/i, { result: "INT" }, "interferencia"],
  [/error en foul|error de foul/i, { result: "EF" }, "error en foul"],
  /* ---- error, contacto y outs genéricos ---- */
  [/error|bot[óo]|se le cay[óo]|pelli[sz]c|le rebot[óo]|la perdió|la pate[oó]|muff|entre las piernas|la dej[óo] caer|se le sali[óo]|bambalazo|lindon|metida de manos?/i, { result: "E" }, "error"],
  [/l[íi]nea|li[ñn]a|line drive|l[íi]nea[sz]o|li[ñn]a[sz]o|flechazo|ca[ñn]onazo|ca[ñn][óo]n|una flecha/i, { result: "LO" }, "l\xEDnea"],
  [/de foul|en foul|foul/i, { result: "FO" }, "out de foul"],
  [/fly|flai|elevado|alto|la cogió de aire|de aire|palo(?!zo)|capit|palomita|volandera|lo caz[óo]|la caz[óo]|en los aires|la atrapa|lo atrapa|la agarr[óo]|lo agarr[óo]|se la qued[óo]/i, { result: "FO" }, "elevado"],
  [/poblado|\bpop\b|pup[úu]|pepita|chocolatito/i, { result: "PO" }, "poblado"],
  [/hit|sencillo|imparable|bata[sz]o|single|tubey sencillo|j[ií]t|se embasó limpio|jit limpio|bata[sz]o limpio|la sac[óo] del cuadro|conect[óo] (un )?(jit|hit|sencillo|imparable)|le dio jit|rollazo|hit limpio/i, { result: "1B" }, "sencillo"],
  [/rolling|roling|rol[íi]n|rodado|ground|r[óo]ling|roletazo|rodadito|roledito|chop|chopito|pico|piquito/i, { result: "GO" }, "rolling"],
  [/agarra|fildea|recoge|guante|filde[oó]|jugada de rutina/i, { result: "GO" }, "jugada de fildeo"],
  [/v[íi]a|por la v[íi]a|relev[oó]|relay|en cadena|combinaci[óo]n de|jugada combinada/i, { result: "GO" }, "jugada en relevo"],
  [/out en primera|out por primera|quieto en primera|tiro a primera/i, { result: "GO", notation: "4-3" }, "out en primera"],
  [/quieto|out|lo dominaron|fuera|lo retiraron|lo sentaron/i, { result: "GO" }, "out"]
];
var ZONE = [
  [/segunda|segund/i, "4"],
  [/short|torpedero|paradas? cortas?|campo ?corto/i, "6"],
  [/tercera|tercer/i, "5"],
  [/primera|primer/i, "3"],
  [/left|izquierd/i, "7"],
  [/center|centro|central/i, "8"],
  [/right|derech/i, "9"],
  [/pitcher|p[ií]tcher|lanzador|box|lomita|serpentinero/i, "1"],
  [/catcher|receptor|mascota|home/i, "2"]
];
var FIELDER_TOKEN = /p[ií]tcher|pitcher|lanzador|lomita|serpentinero|catcher|receptor|mascota|primera|primer|segunda|segundo|tercera|tercer|campo ?corto|campocorto|short|torpedero|left|izquierd\w*|center|centro|central|right|derech\w*|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|[1-9]/gi;
var TOKEN_POS = [
  [/^p[ií]tcher$|^pitcher$|^lanzador$|^lomita$|^serpentinero$|^uno$|^1$/, "1"],
  [/^catcher$|^receptor$|^mascota$|^dos$|^2$/, "2"],
  [/^primera$|^primer$|^tres$|^3$/, "3"],
  [/^segunda$|^segundo$|^cuatro$|^4$/, "4"],
  [/^tercera$|^tercer$|^cinco$|^5$/, "5"],
  [/^short$|^torpedero$|^campo ?corto$|^campocorto$|^seis$|^6$/, "6"],
  [/^left$|^izquierd\w*$|^siete$|^7$/, "7"],
  [/^center$|^centro$|^central$|^ocho$|^8$/, "8"],
  [/^right$|^derech\w*$|^nueve$|^9$/, "9"]
];
function fieldersOf(t) {
  const out = [];
  for (const m of t.matchAll(FIELDER_TOKEN)) {
    const pos = TOKEN_POS.find(([re]) => re.test(m[0].toLowerCase()))?.[1];
    if (pos) out.push(pos);
  }
  return out;
}
var ERR_WORD = /error|bambalazo|lindon|metida de manos?/i;
function errorFielder(t) {
  const m = t.match(/(?:error|bambalazo|lindon|metida de manos?)\w*\s+(?:del?|por|al)\s+(?:el|la|los|un|una)?\s*([a-záéíóúñ]+|\d)/i);
  if (!m) return null;
  return TOKEN_POS.find(([re]) => re.test(m[1].toLowerCase()))?.[1] ?? null;
}
var normName2 = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
var BASE_WORD = [
  [/primer[ao]|1ra|1a\b|la inicial|primera almohadilla|la primera base/, 1],
  [/segund[ao]|2da|2a\b|la intermedia|segunda almohadilla|la segunda base|almohadilla del medio/, 2],
  [/tercer[ao]|3ra|3a\b|la antesala|esquina caliente|tercera almohadilla|la tercera base/, 3],
  [/home|plato|goma|registradora|el pentágono|el pentagono|el home|la registradora/, "HOME"]
];
var OUT_WORD = /out|retirad|quieto|dominad|fuera|lo sacaron|lo pusieron|pescaron|cogieron|quemaron|fuzilaron|agarraron|lo pararon|atrapad/i;
var SCORE_WORD = /anot[óao]|pis[óo]|entr[óo] en carrera|viene pa'?l plato|lleg[óo] a la goma|empuj[óo]|remolc[óo]|entr[óo] a la goma|pas[óo] por el plato|pisa el home|flete[óo]|embols[óo]|trajo (la|una) carrera|a la registradora/i;
var ADV_VERB = /avanz|avanza|sigue|corre|se fue|se meti|llega|lleg[oó]|gan[oó]|se mueve|corri[óo]|sigui[óo]|se lanz[óo]|se embarc[óo]|se adelant[óo]|trep[óo]/i;
function findMentions(t, ctx) {
  const nt = " " + normName2(t) + " ";
  const out = [];
  const firstCount = /* @__PURE__ */ new Map();
  for (const [, p] of ctx.players) {
    const f = normName2(p.firstName).split(" ")[0];
    firstCount.set(f, (firstCount.get(f) ?? 0) + 1);
  }
  for (const [pid, p] of ctx.players) {
    const last = normName2(p.lastName).split(" ")[0];
    const lastFull = normName2(p.lastName);
    const first = normName2(p.firstName).split(" ")[0];
    const full = `${first} ${last}`;
    const fullLong = `${first} ${lastFull}`;
    const cands = (firstCount.get(first) ?? 0) === 1 ? [fullLong, full, lastFull, last, first] : [fullLong, full, lastFull, last];
    for (const cand of cands) {
      if (!cand || cand.length < 3) continue;
      const idx = nt.indexOf(" " + cand);
      if (idx >= 0 && !/[a-zñ]/.test(nt[idx + 1 + cand.length] ?? " ")) {
        out.push({ playerId: pid, label: `${p.firstName} ${p.lastName}`, index: idx, nameText: cand });
        break;
      }
      const idx2 = nt.indexOf(cand);
      if (idx2 >= 0 && last === cand) {
        out.push({ playerId: pid, label: `${p.firstName} ${p.lastName}`, index: idx2, nameText: cand });
        break;
      }
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const sorted = out.filter((m) => seen.has(m.playerId) ? false : (seen.add(m.playerId), true)).sort((a, b) => a.index - b.index || b.nameText.length - a.nameText.length);
  const lastCount = /* @__PURE__ */ new Map();
  for (const [, p] of ctx.players) {
    const l = normName2(p.lastName).split(" ")[0];
    lastCount.set(l, (lastCount.get(l) ?? 0) + 1);
  }
  const kept = [];
  for (const m of sorted) {
    const inside = kept.find((k) => m.index >= k.index && m.index < k.index + k.nameText.length + 1);
    if (inside) continue;
    const dup = kept.find((k) => k.index === m.index && k.nameText === m.nameText);
    if (dup) {
      dup.ambig = true;
      continue;
    }
    if ((lastCount.get(m.nameText) ?? 0) > 1) m.ambig = true;
    kept.push(m);
  }
  return kept;
}
var PITCHER_CHANGE_RE = /cambio|cambian|nuevo|entra|viene|sale|sacan|levantan|relev|traen?|llama|manda|meten?|abren?|sube|ponen/i;
var PITCHER_WORD_RE = /lanzador|pitcher|p[ií]tcher|serpentinero|lomita|box|pitcheo|lanza|mont[ií]culo|abridor|relevista|lanzante|el que lanza|quien est[aá] lanzando/i;
var REENTRY_RE = /reingres|reingreso|vuelve|regresa|de nuevo a lanzar|otra vez a lanzar/i;
var CR_CMD_RE = /corredor emergente|pinch ?run|entra a correr|viene a correr|a correr por|corredor por/i;
var SUB_CMD_RE = /bateador emergente|bateador sustituto|bateador de reemplazo|emergente (?:por|en|al bate|a batear)|sustituto (?:por|en|al bate)|\bpinch ?hitter|cambio de bateador|entra a batear|viene a batear|manda a batear|mete a batear|quita al bateador|saca al bateador/i;
function parseSubCmd(t, ctx) {
  const nt = normName2(t);
  const action = CR_CMD_RE.test(nt) ? "CR" : SUB_CMD_RE.test(nt) ? "SUB" : null;
  if (!action) return null;
  const nameCtx = { ...ctx, players: ctx.batRoster.size ? ctx.batRoster : ctx.players };
  const m = findMentions(t, nameCtx)[0];
  return { action, playerId: m?.playerId ?? null, playerName: m?.label ?? null, ambig: m?.ambig ?? false };
}
function parsePitcherCmd(t, ctx) {
  const nt = normName2(t);
  const isReentry = REENTRY_RE.test(nt);
  const isChange = PITCHER_CHANGE_RE.test(nt) && PITCHER_WORD_RE.test(nt);
  if (!isChange && !isReentry) return null;
  if (!isReentry && !isChange) return null;
  const nameCtx = { ...ctx, players: ctx.roster.size ? ctx.roster : ctx.players };
  const mentions = findMentions(t, nameCtx).filter((m2) => m2.playerId !== ctx.currentPitcherId);
  const m = mentions[0];
  return {
    action: isReentry ? "RL" : "PC",
    pitcherId: m?.playerId ?? null,
    pitcherName: m?.label ?? null,
    ambig: m?.ambig ?? false
  };
}
function parseAdvances(t, ctx, mentions) {
  const adv = [];
  const nt = normName2(t);
  const baseOf = (frag) => {
    if (OUT_WORD.test(frag)) return "OUT";
    if (SCORE_WORD.test(frag)) return "HOME";
    for (const [re, b] of BASE_WORD) if (re.test(frag)) return b;
    return null;
  };
  const nextOf = (pid) => {
    for (const b of [1, 2, 3]) if (ctx.bases[b] === pid) return b === 3 ? "HOME" : b + 1;
    return null;
  };
  for (let i = 0; i < mentions.length; i++) {
    const m = mentions[i];
    const rest = nt.slice(m.index);
    const next = mentions[i + 1]?.index ?? rest.length;
    const frag = rest.slice(0, next);
    const to = baseOf(frag) ?? (ADV_VERB.test(frag) ? nextOf(m.playerId) : null);
    if (to != null) adv.push({ playerId: m.playerId, to, via: m.label });
  }
  for (const m of nt.matchAll(/(?:corredor(?:es)? (?:de|en|que est[aá](?:ba)? en)|el corredor en|el de|el que est[aá](?:ba)? en|(?:el |un )?hombre (?:de|en|que est[aá](?:ba)? en)|ocupando|avance (?:en|de)|en|de) (primera|segunda|tercera|primero|segundo|tercero|la inicial|la intermedia|la antesala)/g)) {
    const w = m[1].replace("primero", "primera").replace("segundo", "segunda").replace("tercero", "tercera");
    const b = BASE_WORD.find(([re]) => re.test(w))?.[1];
    if (typeof b !== "number") continue;
    const pid = ctx.bases[b];
    if (!pid || adv.some((a) => a.playerId === pid)) continue;
    const frag = nt.slice(m.index + m[0].length, m.index + m[0].length + 60);
    const to = baseOf(frag) ?? (ADV_VERB.test(frag) ? b === 3 ? "HOME" : b + 1 : null);
    if (to == null) continue;
    const ePos = frag.match(/(?:error|bambalazo|lindon|metida de manos?)\w* (?:del?|de la?) ([1-9]|pitcher|receptor|c[aá]tcher|primera|segunda|short|torpedero|campo ?corto|tercera|izquierdo|left|central|center|derecho|right)/i);
    const errVia = frag.match(/por error|por bambalazo|por lindon|por (?:una )?metida de manos?/i);
    let via = `corredor de ${b}`;
    if (ePos) via = `error del ${ePos[1]}`;
    else if (errVia) via = "por error";
    adv.push({ playerId: pid, to, via });
  }
  return adv;
}
var CORREDOR_RE = /corredor(?:es)? (?:de|en|que est[aá](?:ba)? en) (primera|segunda|tercera|primero|segundo|tercero)|el corredor en (primera|segunda|tercera)|el de (primera|segunda|tercera)|el que est[aá](?:ba)? en (primera|segunda|tercera)|(?:el |un )?hombre (?:de|en|que est[aá](?:ba)? en) (primera|segunda|tercera|primero|segundo|tercero|la inicial|la intermedia|la antesala)|ocupando (primera|segunda|tercera)/g;
var A_BASE_RE = /a(?:l)? (?:la )?(primera|segunda|tercera|inicial|intermedia|antesala|plato|goma|home|registradora|pent[aá]gono)/g;
var EN_BASE_RE = /\b(?:en|de) (?:la )?(primera|segunda|tercera|inicial|intermedia|antesala)/g;
function playTextOf(transcript, mentions, hasAdvances) {
  let s = normName2(transcript);
  for (const m of mentions) {
    const esc2 = m.nameText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp("\\b" + esc2, "g"), " ");
  }
  s = s.replace(CORREDOR_RE, " ");
  s = s.replace(/avanz\w*\s+(?:a|al|hasta|para|pa'?l?)\s+(?:la\s+)?(?:primera|segunda|tercera|inicial|intermedia|antesala|home|plato|goma|registradora|pent[aá]gono)/gi, " avanza ");
  if (hasAdvances) s = s.replace(A_BASE_RE, " ").replace(EN_BASE_RE, " ");
  return s;
}
var POS_NAME = {
  "1": "el pitcher",
  "2": "el catcher",
  "3": "primera",
  "4": "segunda",
  "5": "tercera",
  "6": "el short",
  "7": "el left",
  "8": "el center",
  "9": "el right"
};
var RESULT_DESC = {
  GO: "Roletazo",
  DP: "Doble play",
  TP: "Triple play",
  FO: "Elevado",
  LO: "L\xEDnea",
  K: "Ponche",
  KWP: "Ponche con tercer strike suelto",
  KPB: "Ponche con pasbola",
  CS: "Atrapado robando",
  E: "Error",
  FC: "Jugada de selecci\xF3n",
  SAC: "Toque de sacrificio",
  SF: "Fly de sacrificio",
  "1B": "Sencillo",
  "2B": "Doble",
  "3B": "Triple",
  HR: "Jonr\xF3n",
  BB: "Base por bolas",
  IBB: "Base intencional",
  HBP: "Pelotazo",
  SB: "Robo de base",
  PK: "Pickoff",
  DI: "Indiferencia defensiva",
  IPL: "Lanzamiento ilegal",
  LE: "Sale temprano",
  OBS: "Obstrucci\xF3n",
  INT: "Interferencia",
  ADJ: "Avance por error",
  WP: "Wild pitch",
  PB: "Pasbola",
  BK: "Balk",
  IF: "Infield fly",
  PO: "Out de foul"
};
function explainNotation(result, notation) {
  const head = RESULT_DESC[result] ?? result;
  if (!notation) return head;
  const hm = notation.match(/^H[1-9](?:-([1-9]))?$/);
  if (hm) return hm[1] ? `${head} por ${POS_NAME[hm[1]]} (${notation})` : `${head} (${notation})`;
  const seq = notation.replace(/^[A-Z]+/, "").split("-").filter((s) => POS_NAME[s]);
  if (!seq.length) {
    const z = notation.match(/^[A-Z]([1-9])/)?.[1];
    return z ? `${head} por ${POS_NAME[z]}` : `${head} (${notation})`;
  }
  const DEST_NAME = {
    "1": "al pitcher",
    "2": "al catcher",
    "3": "a primera",
    "4": "a segunda",
    "5": "a tercera",
    "6": "al short",
    "7": "al left",
    "8": "al center",
    "9": "al right"
  };
  const [a, ...rest] = seq;
  if (["CS", "KWP", "KPB"].includes(result) && rest.length) {
    return `${head}; ${POS_NAME[a]} tira ${rest.map((p) => DEST_NAME[p]).join(" y ")} (${notation})`;
  }
  const trail = rest.length ? `; tira ${rest.map((p) => DEST_NAME[p]).join(" y ")}` : "";
  return `${head} por ${POS_NAME[a]}${trail} (${notation})`;
}
function fallbackTranscribe(t) {
  for (const [re, code, desc] of FALLBACK_PHRASES) {
    if (!re.test(t)) continue;
    const zone = ZONE.find(([z]) => z.test(t))?.[1];
    const out = { ...code };
    let d = desc;
    if (out.result === "1B" && /out|quieto|domin|retir|fuera|a primera|tir[aóo]|v[íi]a/i.test(t)) {
      const fs8 = fieldersOf(t);
      if (fs8.length >= 2) {
        out.result = "GO";
        out.notation = void 0;
        d = "jugada de fildeo";
      }
    }
    const isHitSaid = /\b(?:hits?|j[ií]t|sencillo|imparable|doble|triple|jonr[oó]n|cuadrangular|home ?run|homerun|tubey|batazo)\b/i.test(t);
    const outIntent = /out|quieto|domin|retir|fuera|atrapad|pescad|la caz[óo]|lo caz[óo]|se la qued|fuzil/i.test(t);
    if (isHitSaid && !outIntent && ["GO", "FO", "LO", "PO"].includes(out.result)) {
      out.result = /jonr[oó]n|cuadrangular|home ?run|homerun|vuelacerca|se fue/i.test(t) ? "HR" : /triple/i.test(t) ? "3B" : /doble|tubey|dos bases/i.test(t) ? "2B" : "1B";
      out.notation = void 0;
      d = "hit con trayectoria";
    }
    if (["GO", "DP", "TP"].includes(out.result)) {
      const fs8 = fieldersOf(t);
      if (fs8.length >= 2) out.notation = fs8.join("-");
      else if (fs8.length === 1 && !out.notation) out.notation = `${fs8[0]}-3`;
      else if (!out.notation) out.notation = out.result === "DP" ? "6-4-3" : out.result === "TP" ? "5-4-3" : void 0;
    } else if (["FO", "LO", "PO", "E", "1B", "2B", "3B", "HR", "SF"].includes(out.result)) {
      const z = out.result === "E" ? ERR_WORD.test(t) ? errorFielder(t) : fieldersOf(t)[0] ?? zone : fieldersOf(t)[0] ?? zone;
      const hitTraj = ["1B", "2B", "3B", "HR"].includes(out.result) ? /rol|rod|ground|chop|pic|roletazo|roledito|piso|tierra|por el suelo/i.test(t) ? "G" : /l[ií]nea|flecha|flechazo|cañonazo|trazo|lineazo|lindorazo|escopetazo|rifle/i.test(t) ? "L" : /elevad|fly|flai|alto|de aire|paloma|palomazo|palomita|pompia|volandera|aires|al cielo|al espacio/i.test(t) ? "F" : null : null;
      if (z) out.notation = out.result === "E" ? `E${z}` : out.result === "FO" || out.result === "SF" ? `F${z}` : out.result === "LO" ? `L${z}` : out.result === "PO" ? `P${z}` : hitTraj ? `${hitTraj}${z}` : z;
    } else if (out.result === "ADJ") {
      const z = errorFielder(t);
      if (z) out.notation = `E${z}`;
    } else if (["CS", "PK"].includes(out.result)) {
      const fs8 = fieldersOf(t);
      if (fs8.length >= 2) out.notation = fs8.join("-");
    }
    return { ...out, desc: d };
  }
  return null;
}
r9.post("/ai/notation", async (req, res) => {
  const { transcript, gameId } = req.body;
  if (!transcript?.trim()) return res.status(400).json({ error: "transcript requerido" });
  let ctx = null;
  if (gameId) {
    const game = await prisma.game.findUnique({ where: { id: gameId } });
    if (game) {
      const entries = await prisma.lineupEntry.findMany({
        where: { gameId },
        include: { player: true }
      });
      const events = await loadEvents2(gameId);
      const st = reduceGame(events, game.innings);
      const batTid = st.half === "TOP" ? game.awayTeamId : game.homeTeamId;
      const fldTid = st.half === "TOP" ? game.homeTeamId : game.awayTeamId;
      const fldTeam = await prisma.team.findUnique({ where: { id: fldTid }, include: { players: true } });
      const roster = /* @__PURE__ */ new Map();
      for (const p of fldTeam?.players ?? []) roster.set(p.id, { firstName: p.firstName, lastName: p.lastName });
      for (const e of entries) if (e.teamId === fldTid) roster.set(e.playerId, { firstName: e.player.firstName, lastName: e.player.lastName });
      const batTeam = await prisma.team.findUnique({ where: { id: batTid }, include: { players: true } });
      const batRoster = /* @__PURE__ */ new Map();
      for (const p of batTeam?.players ?? []) batRoster.set(p.id, { firstName: p.firstName, lastName: p.lastName });
      for (const e of entries) if (e.teamId === batTid) batRoster.set(e.playerId, { firstName: e.player.firstName, lastName: e.player.lastName });
      const fieldHalf = st.half;
      const lastP = [...events].reverse().find((e) => e.half === fieldHalf && e.pitcherId)?.pitcherId ?? entries.find((e) => e.teamId === fldTid && e.position === "P" && e.active)?.playerId ?? null;
      ctx = {
        batterId: null,
        bases: { 1: st.bases[1], 2: st.bases[2], 3: st.bases[3] },
        players: new Map(entries.map((e) => [e.playerId, { firstName: e.player.firstName, lastName: e.player.lastName }])),
        fieldTeamId: fldTid,
        roster,
        batRoster,
        currentPitcherId: lastP
      };
      const ord = entries.filter((e) => e.teamId === batTid && e.active && e.batsInOrder !== false).sort((a, b) => a.order - b.order);
      const bi = st.half === "TOP" ? st.awayBatterIndex : st.homeBatterIndex;
      if (ord.length) ctx.batterId = ord[bi % ord.length].playerId;
    }
  }
  if (ctx) {
    const cmd = parsePitcherCmd(transcript, ctx);
    if (cmd) {
      return res.json({
        ok: true,
        source: "local",
        transcript,
        action: cmd.action,
        pitcherId: cmd.pitcherId,
        pitcherName: cmd.pitcherName,
        note: cmd.ambig ? `\xAB${cmd.pitcherName}\xBB \u2014 apellido compartido, verifica` : cmd.pitcherId ? "" : "No reconoc\xED el nombre del lanzador \u2014 el\xEDgelo",
        ai: { play_code: cmd.action, runs_scored: 0, outs_made: null, description_spanish: cmd.pitcherName ? `${cmd.action === "RL" ? "Reingresa" : "Entra a lanzar"} ${cmd.pitcherName}` : "Cambio de lanzador" }
      });
    }
    const sub = parseSubCmd(transcript, ctx);
    if (sub) {
      return res.json({
        ok: true,
        source: "local",
        transcript,
        action: sub.action,
        playerId: sub.playerId,
        playerName: sub.playerName,
        note: sub.ambig ? `\xAB${sub.playerName}\xBB \u2014 apellido compartido, verifica` : sub.playerName ? "" : "Elige qui\xE9n entra y qui\xE9n sale",
        ai: { play_code: sub.action, runs_scored: 0, outs_made: null, description_spanish: `${sub.action === "CR" ? "Corredor emergente" : "Bateador emergente"}${sub.playerName ? `: ${sub.playerName}` : ""}` }
      });
    }
  }
  const mentions = ctx ? findMentions(transcript, ctx) : [];
  const advances = ctx ? parseAdvances(transcript, ctx, mentions) : [];
  const ntSp = normName2(transcript);
  const HIT_WORD = /\bhit\b|sencillo|imparable|j[ií]t|tubey|doble|triple|jonr[óo]n|cuadrangular|homerun|home ?run|batazo/i;
  const RUNNER_SUBJ = /corredor|el de|(?:en|de|ocupando) (?:la )?(?:primera|segunda|tercera|inicial|intermedia|antesala)/i;
  const DEST_RE = /(?:avanz\w*|a|al|hasta|para|pa'?l?|corre|llega)\s+(?:la\s+)?(primera|segunda|tercera|inicial|intermedia|antesala|home|plato|goma|registradora|pent[aá]gono)/i;
  const destOf = (s) => {
    const m = s.match(DEST_RE);
    return m ? BASE_WORD.find(([re]) => re.test(m[1]) || re.test(`la ${m[1]}`))?.[1] ?? null : null;
  };
  if (ctx?.batterId && HIT_WORD.test(ntSp) && !RUNNER_SUBJ.test(ntSp)) {
    const db = destOf(ntSp);
    if (db && db !== 1 && !advances.some((a) => a.playerId === ctx.batterId)) {
      advances.push({ playerId: ctx.batterId, to: db, via: "bateador" });
    }
  }
  if (ctx && /avanz|avanza|se mueve|se embarca|trep[oó]/i.test(ntSp) && !HIT_WORD.test(ntSp) && !advances.length) {
    const only = [1, 2, 3].filter((b) => ctx.bases[b]);
    if (only.length === 1) {
      const db = destOf(ntSp);
      const b = only[0];
      advances.push({ playerId: ctx.bases[b], to: db ?? (b === 3 ? "HOME" : b + 1), via: `corredor de ${b}\xAA` });
    }
  }
  const playText = ctx ? playTextOf(transcript, mentions, advances.length > 0) : transcript;
  const system = `Eres anotador oficial de baseball/softball MLB. Convierte narraci\xF3n dominicana a notaci\xF3n oficial.
${DOMINICAN_GLOSSARY}
Posiciones: 1=P 2=C 3=1B 4=2B 5=3B 6=SS 7=LF 8=CF 9=RF.
Regla A-B-C: la bola va a A, A tira a B, B a C. 4-3-2 = out en 1ra + tiro a home. CS 2-4/2-6 = atrapado robando. K con tercer strike suelto = KWP/KPB + tiro (2-3). SH = toque sacrificio. SF = fly de sacrificio.
Responde SOLO JSON: {"play_code":"4-3"|"K"|"BB"|"H7"|"E5"|"6-4-3"|"HR"|"2B"|"3B"|"FC"|"SF"|"HBP", "runs_scored":0, "outs_made":1, "description_spanish":"..."}.
Ejemplos: "rolling por segunda out en primera"\u2192{"play_code":"4-3"} \xB7 "hit por el right"\u2192{"play_code":"H9"} \xB7
"ponche tirandole"\u2192{"play_code":"K"} \xB7 "doble play seis cuatro tres"\u2192{"play_code":"6-4-3"} \xB7
"elevado al center"\u2192{"play_code":"F8"} \xB7 "se fue por el left"\u2192{"play_code":"HR"} \xB7
"el tercera la bot\xF3"\u2192{"play_code":"E5"} \xB7 "base por bola"\u2192{"play_code":"BB"} \xB7 "tablazo por el centro dos carreras"\u2192{"play_code":"H8","runs_scored":2}`;
  const fb = fallbackTranscribe(playText);
  let mapped = fb ? { result: fb.result, notation: fb.notation } : null;
  let source = aiEnabled() ? "fallback" : "local";
  const ai = mapped ? null : await aiChat(system, playText);
  if (!mapped && ai?.play_code) {
    mapped = codeToEngine(ai.play_code);
    source = "ai";
  }
  if (!mapped) {
    const NUMW = {
      uno: "1",
      dos: "2",
      tres: "3",
      cuatro: "4",
      cinco: "5",
      seis: "6",
      siete: "7",
      ocho: "8",
      nueve: "9"
    };
    const LNAME = { e: "E", error: "E", efe: "F", ele: "L", pe: "P", poblado: "P", ache: "H", h: "H", ge: "G" };
    const nm = playText.trim().match(/^([a-záéíóúñ]+|[1-9])\s+([1-9]|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)$/i);
    const letter = nm ? LNAME[normName2(nm[1])] : null;
    if (letter && nm) {
      const num2 = NUMW[normName2(nm[2])] ?? nm[2];
      const res2 = letter === "E" ? "E" : letter === "F" ? "FO" : letter === "L" ? "LO" : letter === "P" ? "PO" : letter === "H" ? num2 === "4" ? "HR" : num2 === "3" ? "3B" : num2 === "2" ? "2B" : "1B" : "GO";
      mapped = { result: res2, notation: `${letter}${num2}` };
      source = "local";
    }
  }
  if (!mapped) {
    const fs8 = fieldersOf(playText);
    if (fs8.length >= 2) {
      const isCS = /\bcs\b|atrapad|out robando|robando|lo pescaron/i.test(playText);
      const isK = /\bk\b|ponche|chocolate|strike/i.test(playText);
      if (isCS) mapped = { result: "CS", notation: fs8.join("-") };
      else if (isK) mapped = { result: "KWP", notation: fs8.join("-") };
      else mapped = fs8.length >= 3 ? { result: "DP", notation: fs8.join("-") } : { result: "GO", notation: fs8.join("-") };
      source = "local";
    }
  }
  if (mapped?.result === "E" && /avanz|avanza|avance|anota|roba|corre a|se meti/i.test(playText) && (advances.length || /corredor|el de|anota/.test(playText))) {
    mapped = { result: "ADJ", notation: mapped.notation };
  }
  const pureHit = (r10) => r10 && ["1B", "2B", "3B", "HR", "HRIP", "1BE", "2BE", "3BE"].includes(r10) ? { "1B": "1B", "2B": "2B", "3B": "3B", "1BE": "1B", "2BE": "2B", "3BE": "3B", "HR": "HR", "HRIP": "HRIP" }[r10] : null;
  if (ctx && (pureHit(mapped?.result) || HIT_WORD.test(ntSp) && ["E", "ADJ", "FC"].includes(mapped?.result ?? ""))) {
    const baseHit = pureHit(mapped?.result) ?? (/doble|tubey|\b2b\b|dos bases/i.test(ntSp) ? "2B" : /triple|\b3b\b|tres bases/i.test(ntSp) ? "3B" : /jonr[óo]n|cuadrangular|homerun|home ?run|\bh4\b/i.test(ntSp) ? "HR" : "1B");
    if (!pureHit(mapped?.result)) mapped = { result: baseHit };
    const runnerSubj = RUNNER_SUBJ.test(ntSp);
    const destBase = destOf(ntSp);
    const anota = !destBase && SCORE_WORD.test(ntSp);
    const err = ERR_WORD.test(ntSp);
    const only = [1, 2, 3].map((b) => ctx.bases[b]).filter(Boolean);
    if (["1BE", "2BE", "3BE"].includes(mapped.result) && (anota || runnerSubj && destBase != null)) {
      mapped = { result: baseHit, notation: mapped.notation };
    }
    if (!runnerSubj && destBase && destBase !== 1) {
      const hitBase = { "1B": 1, "2B": 2, "3B": 3 }[baseHit] ?? 0;
      const destN = destBase === "HOME" ? 4 : destBase;
      if (err && hitBase && destN > hitBase) {
        mapped = { result: { 2: "1BE", 3: "2BE", 4: "3BE" }[destN] };
      }
      const bAdv = advances.find((a) => a.playerId === ctx.batterId);
      if (bAdv && err && bAdv.via === "bateador") bAdv.via = "bateador por error";
    } else if (anota && !runnerSubj && !only.length && ctx.batterId) {
      if (!advances.some((a) => a.playerId === ctx.batterId)) {
        advances.push({ playerId: ctx.batterId, to: "HOME", via: err ? "bateador por error" : "bateador" });
      }
      if (err && baseHit !== "HR" && baseHit !== "HRIP") mapped = { result: "3BE" };
    } else {
      if (only.length === 1 && !advances.some((a) => a.playerId === only[0])) {
        const to = destBase ?? (anota ? "HOME" : null);
        if (to) advances.push({ playerId: only[0], to, via: err ? "corredor por error" : "corredor" });
      }
    }
    const ef = err ? errorFielder(ntSp) : null;
    if (ef && !mapped.notation) mapped = { ...mapped, notation: `E${ef}` };
  }
  const efAny = ERR_WORD.test(ntSp) ? errorFielder(ntSp) : null;
  if (efAny && mapped && !mapped.notation && !["E", "ADJ", "1BE", "2BE", "3BE"].includes(mapped.result)) {
    mapped = { ...mapped, notation: `E${efAny}` };
  }
  if (!mapped && /la (bola|pelota).{0,25}(peg[oó]|toc[oó]|dio).{0,15}corredor|corredor.{0,20}interfiri|interferencia.{0,10}corredor/i.test(normName2(transcript))) {
    mapped = { result: "INT" };
    source = "local";
  }
  if (ctx && ["SB", "CS", "PK", "WP", "PB", "DI", "INT"].includes(mapped?.result ?? "")) {
    const fail = ["CS", "PK", "INT"].includes(mapped.result);
    const ntFull = normName2(transcript);
    const baseFor = (w) => BASE_WORD.find(([re]) => re.test(w) || re.test(`la ${w}`))?.[1];
    const mentioned = [...ntFull.matchAll(/primera|segunda|tercera|inicial|intermedia|antesala|1ra|2da|3ra|home|plato|goma|registradora|pent[aá]gono/g)].map((m) => baseFor(m[0])).filter((b) => b != null);
    const pushAdv = (fromBase, to) => {
      const pid = ctx.bases[fromBase];
      if (pid && !advances.some((a) => a.playerId === pid)) {
        advances.push({ playerId: pid, to, via: `corredor de ${fromBase}\xAA` });
      }
    };
    const enBase = [...ntFull.matchAll(/\ben (?:la )?(primera|segunda|tercera|inicial|intermedia|antesala)/g)].map((m) => baseFor(m[1])).filter((b) => typeof b === "number").pop();
    if (!fail && /doble robo|se robaron|robaron dos/i.test(ntFull) && mentioned.length > 1) {
      for (const d of mentioned) {
        if (d === "HOME") pushAdv(3, "HOME");
        else if (d > 1) pushAdv(d - 1, d);
      }
    } else if (fail) {
      if (enBase != null) pushAdv(enBase, "OUT");
      else {
        const dest = mentioned[mentioned.length - 1];
        if (dest === "HOME") pushAdv(3, "OUT");
        else if (typeof dest === "number") pushAdv(dest === 1 ? 1 : dest - 1, "OUT");
        else {
          const pid = ctx.bases[1] ?? ctx.bases[2] ?? ctx.bases[3];
          if (pid && !advances.some((a) => a.playerId === pid)) {
            advances.push({ playerId: pid, to: "OUT", via: "corredor" });
          }
        }
      }
    } else {
      const dest = mentioned[mentioned.length - 1];
      if (dest === "HOME") pushAdv(3, "HOME");
      else if (typeof dest === "number" && dest > 1) pushAdv(dest - 1, dest);
    }
  }
  let advOnlyDesc = null;
  let advOnlyWarn = "";
  if (!mapped && advances.length) {
    mapped = { result: "ADJ" };
    source = "local";
    advOnlyDesc = `Avance: ${advances.map((a) => `${a.via} \u2192 ${a.to === "HOME" ? "anota" : a.to === "OUT" ? "out" : `${a.to}\xAA`}`).join(" \xB7 ")}`;
    if (ctx) {
      const onBase = new Set([ctx.bases[1], ctx.bases[2], ctx.bases[3]].filter(Boolean));
      const off = advances.filter((a) => !onBase.has(a.playerId));
      if (off.length) advOnlyWarn = `\u26A0 ${off.map((a) => a.via).join(", ")} no aparece en base \u2014 verifica`;
    }
  }
  if (!mapped) {
    try {
      const dir = path6.dirname(envPath());
      fs6.appendFileSync(
        path6.join(dir, "missed-voice.log"),
        `${(/* @__PURE__ */ new Date()).toISOString()}	${gameId ?? "-"}	${transcript.trim()}
`
      );
    } catch {
    }
    return res.status(422).json({ error: "No entend\xED la jugada \u2014 intenta de nuevo o an\xF3tala manual", transcript });
  }
  let saidBatterId = null;
  let note = "";
  if (ctx) {
    const sinAdv = mentions.filter((m) => !advances.some((a) => a.playerId === m.playerId));
    if (sinAdv.length && sinAdv[0].playerId !== ctx.batterId) {
      const cand = sinAdv[0];
      saidBatterId = cand.playerId;
      const onBase = Object.values(ctx.bases).includes(cand.playerId);
      note = onBase ? `${cand.label} est\xE1 en base \u2014 lo tom\xE9 como corredor` : `${cand.label} no es el bateador del turno \u2014 verifica`;
    }
    const ambig = mentions.filter((m) => m.ambig);
    if (ambig.length) {
      const extra = `\xAB${ambig.map((m) => m.nameText).join("\xBB/\xAB")}\xBB es un apellido compartido \u2014 verifica el jugador`;
      note = note ? `${note} \xB7 ${extra}` : extra;
    }
  }
  const outNotation = mapped.notation ? normNotation(mapped.notation) : null;
  res.json({
    ok: true,
    source,
    transcript,
    result: mapped.result,
    notation: outNotation,
    advances,
    batterId: saidBatterId,
    playerNames: mentions.map((m) => m.label),
    note: [note, advOnlyWarn].filter(Boolean).join(" \xB7 "),
    ai: { play_code: ai?.play_code ?? mapped.result, runs_scored: ai?.runs_scored ?? 0, outs_made: ai?.outs_made ?? null, description_spanish: advOnlyDesc ?? (ai?.description_spanish || explainNotation(mapped.result, outNotation)) }
  });
});
r9.post("/ai/transcribe", async (req, res) => {
  const { audio, mime } = req.body;
  if (!audio) return res.status(400).json({ error: "audio requerido" });
  const t = await aiTranscribe(audio, mime ?? "audio/webm");
  if (t.error || !t.text) return res.status(503).json({ error: t.error ?? "Whisper no devolvi\xF3 texto" });
  res.json({ ok: true, transcript: t.text });
});
r9.post("/games/:id/validate-play", async (req, res) => {
  const { result, advances = [] } = req.body;
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  const st = reduceGame(await loadEvents2(game.id), game.innings);
  const onBase = [st.bases[1], st.bases[2], st.bases[3]].filter(Boolean).length;
  const outs = st.outs;
  const runs = advances.filter((a) => a.to === "HOME").length;
  const outsInPlay = advances.filter((a) => a.to === "OUT").length;
  const fails = [];
  if ((result === "DP" || result === "TP") && onBase === 0)
    fails.push({ error: "Doble play sin corredores en base", suggestion: "\xBFFue un out normal (6-3) o un force en una base?" });
  if (result === "DP" && outs === 2)
    fails.push({ error: "Doble play con 2 outs: el inning debi\xF3 terminar", suggestion: "El primer out del DP cierra la entrada \u2014 verifica el orden de los outs" });
  if (runs > 0 && onBase === 0 && !["HR", "HRIP"].includes(result ?? ""))
    fails.push({ error: "Carrera anotada sin corredores y sin jonr\xF3n", suggestion: "\xBFOlvidaste embasar al corredor que anot\xF3?" });
  if (runs > onBase + 1)
    fails.push({ error: `${runs} carreras pero solo ${onBase} corredor(es) + el bateador`, suggestion: "Revisa los avances: \xBFqui\xE9n anot\xF3?" });
  if (outs + outsInPlay > 3)
    fails.push({ error: `La jugada hace ${outs + outsInPlay} outs \u2014 la entrada ya debi\xF3 cerrar`, suggestion: 'Toca "Finalizar entrada" o corrige el out extra' });
  if (result === "SF" && (onBase === 0 || !st.bases[3]))
    fails.push({ error: "Fly de sacrificio sin corredor en 3ra", suggestion: "El SF necesita corredor en 3ra anotando \u2014 \xBFfue un fly out normal?" });
  if (result === "SAC" && onBase === 0)
    fails.push({ error: "Sacrificio sin corredores en base", suggestion: "El toque de sacrificio necesita corredor que avance" });
  res.json({ is_valid: fails.length === 0, errors: fails });
});
var RESULT_TXT = {
  "1B": "sencillo",
  "2B": "doble",
  "3B": "triple",
  HR: "jonr\xF3n",
  HRIP: "jonr\xF3n dentro del parque",
  BB: "base por bolas",
  IBB: "base intencional",
  K: "ponche",
  KWP: "K+wild",
  KPB: "K+pasbola",
  HBP: "pelotazo",
  E: "error",
  FC: "jugada de selecci\xF3n",
  DP: "doble play",
  TP: "triple play",
  GO: "rolling out",
  FO: "elevado",
  LO: "l\xEDnea",
  PO: "batazo al pitcher",
  SAC: "toque de sacrificio",
  SF: "fly de sacrificio"
};
r9.get("/games/:id/boxscore-ai", async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id }, include: { homeTeam: true, awayTeam: true, lineups: { include: { player: true } } } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  const evs = await loadEvents2(game.id);
  const box = computeBoxscore(evs, game.innings);
  const nameOf = (pid) => {
    const l = game.lineups.find((x) => x.playerId === pid);
    return l ? `${l.player.firstName[0]}. ${l.player.lastName}` : "";
  };
  const lines = [];
  let curHalf = "";
  for (const e of evs) {
    const half = `${e.inning === 1 ? "1ra" : e.inning === 2 ? "2da" : e.inning === 3 ? "3ra" : `${e.inning}ta`} ${e.half === "TOP" ? "\u2191" : "\u2193"}`;
    if (half !== curHalf) {
      curHalf = half;
      lines.push(`
${half}:`);
    }
    const res2 = RESULT_TXT[e.result] ?? e.result;
    if (e.batterId) lines.push(`${nameOf(e.batterId)}: ${res2}${e.notation ? ` (${e.notation})` : ""}${e.advances.some((a) => a.to === "HOME") ? " \u2014 ANOTA" : ""}`);
  }
  const pbp = lines.join("\n").trim();
  try {
    await prisma.game.update({ where: { id: game.id }, data: { boxscoreJson: JSON.stringify(box), playByPlay: pbp } });
  } catch (e) {
    console.error("boxscore save:", e);
  }
  res.json({ boxscore: box, playByPlay: pbp, teams: { away: game.awayTeam.name, home: game.homeTeam.name }, status: game.status });
});
r9.post("/games/:id/narrate", async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id }, include: { lineups: { include: { player: true } } } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  const evs = await loadEvents2(game.id);
  const ev = evs[evs.length - 1];
  if (!ev) return res.status(400).json({ error: "Sin jugadas a\xFAn" });
  const nameOf = (pid) => playerName(game.lineups.find((x) => x.playerId === pid)?.player);
  const runs = ev.advances.filter((a) => a.to === "HOME").length;
  const ctx = `Jugada: ${RESULT_TXT[ev.result] ?? ev.result}${ev.notation ? " " + ev.notation : ""}. Bateador: ${nameOf(ev.batterId)}. Pitcher: ${nameOf(ev.pitcherId)}. Carreras en la jugada: ${runs}. Entrada ${ev.inning} ${ev.half === "TOP" ? "alto" : "bajo"}.`;
  const ai = await aiChat(
    `Eres narrador dominicano de pelota (estilo Mendy L\xF3pez). Genera narraci\xF3n emocionante de 1-2 frases en slang dominicano con los nombres. JSON {"narration_text":"...","narration_type":"exciting"|"normal"}.`,
    ctx
  );
  let text = ai?.narration_text;
  if (!text) {
    const bn = nameOf(ev.batterId) || "el bateador";
    const lib = {
      HR: `\xA1Tablazooo de ${bn}! \xA1La bola se fue del parque!${runs > 1 ? ` \xA1${runs} carreras al plato!` : ""}`,
      "3B": `\xA1Triple de ${bn}! \xA1Se par\xF3 en tercera como un avi\xF3n!`,
      "2B": `\xA1Doblete de ${bn} por los lados!${runs ? ` \xA1${runs} anota${runs > 1 ? "n" : ""}!` : ""}`,
      "1B": `\xA1Hit de ${bn}!${runs ? ` \xA1Empuja ${runs}!` : ""}`,
      K: `\xA1Ponche! \xA1El pitcher ${nameOf(ev.pitcherId)} se lo cant\xF3 a ${bn}!`,
      BB: `Base por bolas para ${bn}, cuatro malas.`,
      DP: `\xA1Doble play! \xA1${ev.notation ?? ""} de lujo!`,
      E: `\xA1Error! ${bn} se embasa gratis.`
    };
    text = lib[ev.result] ?? `${bn}: ${RESULT_TXT[ev.result] ?? ev.result}.`;
  }
  try {
    await prisma.gameEvent.update({ where: { gameId_seq: { gameId: game.id, seq: ev.seq } }, data: { aiNarr: text } });
  } catch (e) {
    console.error("narration save:", e);
  }
  res.json({ narration: text, seq: ev.seq });
});
r9.get("/games/:id/insights", async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id }, include: { homeTeam: true, awayTeam: true, lineups: { include: { player: true } } } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  const evs = await loadEvents2(game.id);
  const st = reduceGame(evs, game.innings);
  const box = computeBoxscore(evs, game.innings);
  const diff = st.score.away - st.score.home;
  const baseProb = 0.5 + diff * 0.085;
  const innFactor = Math.min(1, st.inning / game.innings);
  const halfAdj = st.half === "TOP" ? 0 : -0.01;
  let pHome = 1 - (baseProb * (1 - innFactor * 0) + halfAdj);
  pHome = Math.max(0.02, Math.min(0.98, 0.5 - diff * 0.085 - (st.half === "BOTTOM" && diff < 0 ? 0.04 : 0)));
  const battingTeam = st.half === "TOP" ? game.awayTeamId : game.homeTeamId;
  const lineup = game.lineups.filter((l) => l.teamId === battingTeam && l.active && l.batsInOrder !== false).sort((a, b) => a.order - b.order);
  const batterIdx = (st.half === "TOP" ? st.awayBatterIndex : st.homeBatterIndex) % Math.max(lineup.length, 1);
  const batter = lineup[batterIdx];
  const curPitcherId = evs.filter((e) => e.pitcherId).at(-1)?.pitcherId ?? null;
  let rispLine = null;
  let vsPitcher = null;
  if (batter) {
    let rispAb = 0, rispH = 0, vsAb = 0, vsH = 0;
    let rs = initialState();
    for (const e of evs) {
      if (e.batterId === batter.playerId && !["SB", "CS", "WP", "PB", "BK", "PK", "DI", "CR", "PC", "INT", "OBS", "GR", "B", "S", "F", "IPL", "LE", "EF", "EI", "ADJ", "RBI", "EU", "LG", "SK", "DE", "LIB"].includes(e.result)) {
        const isAB = !["BB", "IBB", "HBP", "SAC", "SF", "CI", "OOT"].includes(e.result);
        const isH = ["1B", "2B", "3B", "HR", "HRIP", "1BE", "2BE", "3BE"].includes(e.result);
        if (rs.bases[2] || rs.bases[3]) {
          if (isAB) rispAb++;
          if (isH) rispH++;
        }
        if (e.pitcherId === curPitcherId) {
          if (isAB) vsAb++;
          if (isH) vsH++;
        }
      }
      rs = applyEvent(rs, e, game.innings);
    }
    rispLine = { ab: rispAb, h: rispH };
    vsPitcher = { ab: vsAb, h: vsH };
  }
  const pitcherLine = curPitcherId ? box.pitchers[curPitcherId] : null;
  const batterName = batter ? playerName(batter.player) : "";
  const statsCtx = `Bateador ${batterName}: ${batter ? JSON.stringify(box[st.half === "TOP" ? "away" : "home"][batter.playerId] ?? {}) : "{}"} \xB7 RISP ${rispLine?.h}/${rispLine?.ab} \xB7 vs pitcher ${vsPitcher?.h}/${vsPitcher?.ab} \xB7 Pitcher ${curPitcherId ? playerName(game.lineups.find((l) => l.playerId === curPitcherId)?.player) : ""} lanzamientos ${pitcherLine?.pitches ?? 0} \xB7 Marcador ${st.score.away}-${st.score.home}, entrada ${st.inning}, outs ${st.outs}`;
  const ai = await aiChat('Eres coach de pelota. Da 1 consejo t\xE1ctico corto para el dirigente en espa\xF1ol dominicano, m\xE1x 15 palabras. JSON {"insight":"..."}', statsCtx);
  let insight = ai?.insight ?? null;
  if (!insight && pitcherLine && pitcherLine.pitches >= 80) insight = `${pitcherLine.pitches} lanzamientos \u2014 considera el relevo`;
  else if (!insight && rispLine && rispLine.ab >= 2 && rispLine.h / rispLine.ab >= 0.4) insight = `${batterName} batea de ${rispLine.ab}-${rispLine.h} con corredores en posici\xF3n`;
  else if (!insight && vsPitcher && vsPitcher.ab >= 2 && vsPitcher.h === 0) insight = `${batterName} no le ha dado a este pitcher (${vsPitcher.ab} turnos)`;
  res.json({
    winProb: { away: +(1 - pHome).toFixed(2), home: +pHome.toFixed(2) },
    batter: batter ? { playerId: batter.playerId, name: batterName, risp: rispLine, vsPitcher } : null,
    pitcher: curPitcherId ? { playerId: curPitcherId, name: playerName(game.lineups.find((l) => l.playerId === curPitcherId)?.player), pitches: pitcherLine?.pitches ?? 0 } : null,
    insight,
    ai: aiEnabled()
  });
});
r9.get("/games/:id/share", async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id }, include: { homeTeam: true, awayTeam: true, lineups: { include: { player: true } } } });
  if (!game) return res.status(404).json({ error: "Juego no encontrado" });
  const evs = await loadEvents2(game.id);
  const box = computeBoxscore(evs, game.innings);
  const st = reduceGame(evs, game.innings);
  const score = { away: st.score.away, home: st.score.home };
  const nameOf = (pid) => playerName(game.lineups.find((x) => x.playerId === pid)?.player);
  let mvp = null;
  let best = -1;
  for (const side of ["away", "home"]) {
    for (const [pid, b] of Object.entries(box[side])) {
      const val = b.h + b.hr * 2 + b.rbi;
      if (val > best) {
        best = val;
        mvp = { id: pid, name: nameOf(pid) ?? pid, line: `${b.ab}-${b.h}${b.hr ? `, ${b.hr} HR` : ""}${b.rbi ? `, ${b.rbi} CI` : ""}${b.r ? `, ${b.r} C` : ""}` };
      }
    }
  }
  const ai = await aiChat(
    'Genera resumen de juego de liga amateur en espa\xF1ol dominicano, 2-3 p\xE1rrafos cortos + 3 titulares. JSON {"summary_text":"...","headlines":["...","...","..."]}.',
    `Final: ${game.awayTeam.name} ${score.away} - ${score.home} ${game.homeTeam.name}. MVP: ${mvp?.name} (${mvp?.line}). Jugadas: ${game.playByPlay ?? ""}`
  );
  const winner = score.away > score.home ? game.awayTeam.name : score.home > score.away ? game.homeTeam.name : null;
  const whatsapp = `\u{1F3C1} RESULTADO FINAL
${game.awayTeam.name} ${score.away} \u2014 ${score.home} ${game.homeTeam.name}` + (mvp ? `
\u2B50 MVP: ${mvp.name} (${mvp.line})` : "") + (ai?.headlines?.[0] ? `

${ai.headlines[0]}` : "") + `

\u2014 PoxScore \xB7 Alexis Lara 2026`;
  res.json({
    score,
    winner,
    mvp,
    summary: ai?.summary_text ?? `${winner ? `Victoria de ${winner}` : "Empate"} ${Math.max(score.away, score.home)}-${Math.min(score.away, score.home)}. ${mvp ? `${mvp.name} la figura: ${mvp.line}.` : ""}`,
    headlines: ai?.headlines ?? [],
    whatsapp,
    facebook: ai?.summary_text ?? whatsapp,
    ai: aiEnabled()
  });
});
var norm3 = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
var STAT_KEYS = [
  { re: /dobles?|2b|dos bases/, key: "doubles", label: "dobles" },
  { re: /triples?|3b|tres bases/, key: "triples", label: "triples" },
  { re: /jonr|cuadrangular|hr(?!a)|tablazo/, key: "hr", label: "jonrones" },
  { re: /empujad|impulsad|remolc|\bci\b|rbi/, key: "rbi", label: "carreras empujadas" },
  { re: /anotad|\bcarreras?\b|\brun/, key: "r", label: "carreras anotadas" },
  { re: /hits?|imparable|sencillos?|batazos?/, key: "h", label: "hits" },
  { re: /bases? por bola|boletos?|pasaportes?|\bbb\b/, key: "bb", label: "bases por bolas" },
  { re: /robad|robo|\bsb\b/, key: "sb", label: "bases robadas" },
  { re: /ponches?|chocolates?|\bk\b/, key: "k", label: "ponches (al bate)" },
  { re: /batea|promedio|avg|average/, key: "avg", label: "promedio de bateo", compute: (s) => s.ab ? s.h / s.ab : 0 },
  { re: /obp|embasamiento/, key: "obp", label: "OBP", compute: (s) => s.ab + s.bb + s.hbp + s.sf ? (s.h + s.bb + s.hbp) / (s.ab + s.bb + s.hbp + s.sf) : 0 },
  { re: /slug|slg/, key: "slg", label: "slugging", compute: (s) => s.ab ? (s.h + s.doubles + s.triples * 2 + s.hr * 3) / s.ab : 0 },
  { re: /ops/, key: "ops", label: "OPS", compute: (s) => (s.ab + s.bb + s.hbp + s.sf ? (s.h + s.bb + s.hbp) / (s.ab + s.bb + s.hbp + s.sf) : 0) + (s.ab ? (s.h + s.doubles + s.triples * 2 + s.hr * 3) / s.ab : 0) },
  { re: /ganad|victoria|\bwin/, key: "w", label: "juegos ganados (pitcheo)" },
  { re: /perdid|derrota|\bloss/, key: "l", label: "juegos perdidos" },
  { re: /salvad|\bsv\b/, key: "sv", label: "juegos salvados" },
  { re: /era|efectividad|limpia/, key: "era", label: "ERA", compute: (s) => s.pOuts ? s.pER * 27 / s.pOuts : 0 },
  { re: /ponches? de lanzador|k.*pitcher|poncho.*bateador/, key: "pK", label: "ponches lanzados" },
  { re: /errores?/, key: "e", label: "errores" },
  { re: /juegos?\b|partidos?/, key: "g", label: "juegos" }
];
var ORD_WORD = { primer: 1, primero: 1, segundo: 2, tercer: 3, tercero: 3, cuarto: 4, quinto: 5, sexto: 6, septimo: 7, "s\xE9ptimo": 7, octavo: 8, noveno: 9 };
function parseFilters(q) {
  const f = { desc: [] };
  if (/posici[óo]n de anotar|posici[óo]n anotadora|risp|scoring|segunda o tercera|2da o 3era/.test(q)) {
    f.bases = "risp";
    f.desc.push("con corredores en posici\xF3n de anotar");
  }
  if (/bases? llenas?|casa llena|lleno de corredores/.test(q)) {
    f.bases = "loaded";
    f.desc.push("con bases llenas");
  } else if (/bases? vac[íi]as?|sin corredores|sin nadie en base/.test(q)) {
    f.bases = "empty";
    f.desc.push("con bases vac\xEDas");
  } else if (/(?:hombre|corredor|con uno) en (?:segunda|2da|2a)/.test(q)) {
    f.bases = [2];
    f.desc.push("con corredor en 2da");
  } else if (/(?:hombre|corredor|con uno) en (?:tercera|3ra|3a)/.test(q)) {
    f.bases = [3];
    f.desc.push("con corredor en 3ra");
  } else if (/(?:hombre|corredor|con uno) en (?:primera|1ra|1a)/.test(q)) {
    f.bases = [1];
    f.desc.push("con corredor en 1ra");
  }
  const mOut = q.match(/(?:con|y)\s+(\d+|un|uno|dos|tres)\s+outs?/);
  if (mOut) {
    const w = { un: 1, uno: 1, dos: 2, tres: 3 };
    f.outs = w[mOut[1]] ?? +mOut[1];
    f.desc.push(`con ${f.outs} out${f.outs === 1 ? "" : "s"}`);
  }
  const mLast = q.match(/[úu]ltimos?\s+(\d+)\s+juegos?/);
  if (mLast) {
    f.lastGames = +mLast[1];
    f.desc.push(`\xFAltimos ${f.lastGames} juegos`);
  } else if (/[úu]ltimos?\s+juegos?|recentemente|forma reciente/.test(q)) {
    f.lastGames = 5;
    f.desc.push("\xFAltimos 5 juegos");
  }
  const mOrd = q.match(/(\d+)\s*(?:º|to|do|ro|mo|vo|no|ero|era)?\s*bate\b|bateando\s+(?:de\s+)?(\w+)|(?:de|siendo|como)\s+(\w+)\s+bate\b|(\w+)\s+bate\b/);
  if (mOrd) {
    const w = mOrd[1] ?? mOrd[2] ?? mOrd[3] ?? mOrd[4] ?? "";
    const n = +w || +((w.match(/\d+/) ?? [])[0] ?? 0) || ORD_WORD[w] || ORD_WORD[norm3(w)];
    if (n && n >= 1 && n <= 9) {
      f.order = n;
      f.desc.push(`bateando ${n}\xBA`);
    }
  }
  const mInn = q.match(/(?:entrada|inning)s?\s+(\d+)(?:\s*[-a]\s*(\d+))?/);
  if (mInn) {
    f.innFrom = +mInn[1];
    f.innTo = +(mInn[2] ?? mInn[1]);
    f.desc.push(f.innFrom === f.innTo ? `entrada ${f.innFrom}` : `entradas ${f.innFrom}-${f.innTo}`);
  } else if (/entradas? tard[íi]as?|late innings?/.test(q)) {
    f.innFrom = 7;
    f.desc.push("entradas tard\xEDas (7+)");
  }
  return f;
}
async function situationalLine(playerId, flt) {
  const evRows = await prisma.gameEvent.findMany({
    where: { batterId: playerId },
    select: { gameId: true },
    distinct: ["gameId"]
  });
  if (!evRows.length) return null;
  let gameIds = evRows.map((e) => e.gameId);
  const games = await prisma.game.findMany({
    where: { id: { in: gameIds } },
    select: { id: true, date: true, innings: true },
    orderBy: { date: "asc" }
  });
  if (flt.lastGames && games.length > flt.lastGames) {
    const keep = new Set(games.slice(-flt.lastGames).map((g) => g.id));
    gameIds = gameIds.filter((id) => keep.has(id));
  }
  const orderByGame = /* @__PURE__ */ new Map();
  if (flt.order) {
    for (const l of await prisma.lineupEntry.findMany({ where: { gameId: { in: gameIds }, playerId, order: { gte: 1, lte: 9 } } }))
      orderByGame.set(l.gameId, l.order);
  }
  const line = { pa: 0, ab: 0, h: 0, d2: 0, d3: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sf: 0, sac: 0, sb: 0, g: /* @__PURE__ */ new Set() };
  const NO_AB = /* @__PURE__ */ new Set(["BB", "IBB", "HBP", "SAC", "SF", "CI", "OOT", "SK", "LG", "AO"]);
  const IS_H = /* @__PURE__ */ new Set(["1B", "2B", "3B", "HR", "HRIP", "1BE", "2BE", "3BE"]);
  const MID = /* @__PURE__ */ new Set(["SB", "CS", "WP", "PB", "BK", "PK", "DI", "CR", "PC", "INT", "OBS", "GR", "B", "S", "F", "IPL", "LE", "EF", "EI", "ADJ", "RBI", "EU", "LG", "SK", "DE", "LIB"]);
  const NO_RBI2 = /* @__PURE__ */ new Set(["E", "DP", "TP", "KWP", "KPB"]);
  for (const gid of gameIds) {
    const g = games.find((x) => x.id === gid);
    const evs = await prisma.gameEvent.findMany({ where: { gameId: gid }, orderBy: { seq: "asc" } });
    let st = initialState();
    for (const raw of evs) {
      const e = toEvent(raw);
      if (e.batterId === playerId && !MID.has(e.result)) {
        const b = st.bases;
        const pass = (!flt.bases || flt.bases === "risp" && (b[2] || b[3]) || flt.bases === "loaded" && (b[1] && b[2] && b[3]) || flt.bases === "empty" && !(b[1] || b[2] || b[3]) || flt.bases === "any" && (b[1] || b[2] || b[3]) || Array.isArray(flt.bases) && flt.bases.every((bb) => !!b[bb])) && (flt.outs == null || st.outs === flt.outs) && (!flt.pitcherId || e.pitcherId === flt.pitcherId) && (!flt.order || orderByGame.get(gid) === flt.order) && (!flt.innFrom || e.inning >= flt.innFrom && e.inning <= (flt.innTo ?? flt.innFrom));
        if (pass) {
          line.pa++;
          line.g.add(gid);
          if (!NO_AB.has(e.result)) line.ab++;
          if (IS_H.has(e.result)) {
            line.h++;
            if (e.result.startsWith("2B")) line.d2++;
            if (e.result.startsWith("3B")) line.d3++;
            if (e.result.startsWith("HR")) line.hr++;
          }
          if (["BB", "IBB"].includes(e.result)) line.bb++;
          if (["K", "KWP", "KPB"].includes(e.result)) line.k++;
          if (e.result === "HBP") line.hbp++;
          if (e.result === "SF") line.sf++;
          if (e.result === "SAC") line.sac++;
          if (!NO_RBI2.has(e.result)) line.rbi += e.advances.filter((a) => a.to === "HOME" && a.playerId !== playerId).length;
          if (["HR", "HRIP"].includes(e.result)) line.rbi++;
        }
      }
      st = applyEvent(st, e, g.innings);
    }
  }
  return line;
}
var lineValue = (l, key) => {
  const obp = l.ab + l.bb + l.hbp + l.sf ? (l.h + l.bb + l.hbp) / (l.ab + l.bb + l.hbp + l.sf) : 0;
  const slg = l.ab ? (l.h + l.d2 + l.d3 * 2 + l.hr * 3) / l.ab : 0;
  switch (key) {
    case "avg":
      return l.ab ? l.h / l.ab : 0;
    case "obp":
      return obp;
    case "slg":
      return slg;
    case "ops":
      return obp + slg;
    case "iso":
      return slg - (l.ab ? l.h / l.ab : 0);
    case "babip":
      return l.ab - l.k - l.hr + l.sf ? (l.h - l.hr) / (l.ab - l.k - l.hr + l.sf) : 0;
    case "woba":
      return l.ab + l.bb + l.hbp + l.sf ? (0.69 * (l.bb + l.hbp) + 0.89 * (l.h - l.d2 - l.d3 - l.hr) + 1.28 * l.d2 + 1.6 * l.d3 + 2.08 * l.hr) / (l.ab + l.bb + l.hbp + l.sf) : 0;
    case "whip":
      return 0;
    // WHIP es de pitcheo — no aplica a la línea de bateo
    case "bbp":
      return l.pa ? l.bb / l.pa : 0;
    case "kp":
      return l.pa ? l.k / l.pa : 0;
    case "doubles":
      return l.d2;
    case "triples":
      return l.d3;
    case "hr":
      return l.hr;
    case "rbi":
      return l.rbi;
    case "r":
      return 0;
    case "h":
      return l.h;
    case "bb":
      return l.bb;
    case "k":
      return l.k;
    case "sb":
      return l.sb;
    case "g":
      return l.g.size;
    default:
      return l.ab ? l.h / l.ab : 0;
  }
};
var SABER_KEYS = [
  { re: /\biso\b|poder aislado/, key: "iso", label: "ISO (poder aislado)" },
  { re: /babip/, key: "babip", label: "BABIP" },
  { re: /woba/, key: "woba", label: "wOBA aprox" },
  { re: /whip/, key: "whip", label: "WHIP" },
  { re: /bb%|porcentaje de bases/, key: "bbp", label: "BB%" },
  { re: /k%|porcentaje de ponches/, key: "kp", label: "K%" }
];
r9.post("/ai/ask", async (req, res) => {
  const { question } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: "question requerido" });
  const q = norm3(question);
  const players = await prisma.player.findMany({ include: { team: { select: { name: true } }, seasons: true } });
  const found = /* @__PURE__ */ new Map();
  for (const p of players) {
    const fn = normName2(p.firstName), ln = normName2(p.lastName);
    let hits = 0;
    if (fn.length > 2 && new RegExp(`\\b${fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(q)) hits++;
    for (const part of ln.split(/\s+/)) if (part.length > 3 && new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(q)) hits++;
    if (hits) found.set(p.id, { p, hits });
  }
  const full = [...found.values()].filter((f) => f.hits >= 2).map((f) => f.p);
  let unique = (full.length ? full : [...found.values()].map((f) => f.p)).slice(0, 6);
  const flt = parseFilters(q);
  const mVs = q.match(/(?:\bvs\.?|\bcontra|\bante|\bfrenta?\s+al?|\benfrenta(?:ndo)?\s+al?|\b(?:al|del|de)\s+(?:pitcher|lanzador|serpentinero))\s+(?:el\s+|al\s+|los?\s+)?([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)?)/);
  if (mVs && unique.length >= 2) {
    const vsParts = (mVs[1] ?? "").split(/\s+/).filter((w) => w.length > 2 && !["pitcher", "lanzador", "serpentinero"].includes(w));
    const pitcher = vsParts.length ? unique.find((p) => vsParts.every((w) => norm3(`${p.firstName} ${p.lastName}`).includes(w))) ?? unique.find((p) => vsParts.some((w) => w.length > 3 && normName2(p.lastName).includes(w))) : void 0;
    if (pitcher) {
      flt.pitcherId = pitcher.id;
      flt.pitcherName = `${pitcher.firstName} ${pitcher.lastName}`;
      flt.desc.push(`vs ${flt.pitcherName}`);
      unique = unique.filter((p) => p.id !== pitcher.id);
    }
  }
  let stat = STAT_KEYS.find((s) => s.re.test(q)) ?? SABER_KEYS.find((s) => s.re.test(q)) ?? null;
  if (stat?.key === "g" && flt.lastGames) stat = null;
  const hasFilter = flt.desc.length > 0;
  const aggOf = (p) => {
    const a = {};
    for (const s of p.seasons) for (const [k, v] of Object.entries(s))
      if (typeof v === "number" && !["season"].includes(k)) a[k] = (a[k] ?? 0) + v;
    return a;
  };
  const RATE = ["avg", "obp", "slg", "ops", "iso", "babip", "bbp", "kp", "era", "whip", "woba"];
  const fmt = (v) => stat && RATE.includes(stat.key) ? ["era", "whip"].includes(stat.key) ? v.toFixed(2) : v.toFixed(3).replace(/^0/, "") : String(Math.round(v));
  const rows = [];
  for (const p of unique) {
    const base = { id: p.id, name: `${p.firstName} ${p.lastName}`, team: p.team?.name ?? "" };
    if (hasFilter) {
      const l = await situationalLine(p.id, flt);
      const v = stat ? lineValue(l ?? { pa: 0, ab: 0, h: 0, d2: 0, d3: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sf: 0, sb: 0, g: /* @__PURE__ */ new Set() }, stat.key) : l?.ab ? l.h / l.ab : 0;
      rows.push({
        ...base,
        value: v,
        g: l?.g.size ?? 0,
        ab: l?.ab ?? 0,
        h: l?.h ?? 0,
        hr: l?.hr ?? 0,
        rbi: l?.rbi ?? 0,
        line: l && l.pa ? `${l.ab}-${l.h}${l.hr ? `, ${l.hr} HR` : ""}${l.rbi ? `, ${l.rbi} CI` : ""}${l.bb ? `, ${l.bb} BB` : ""}${l.k ? `, ${l.k} K` : ""}` : "sin turnos en esa situaci\xF3n"
      });
    } else {
      const s = aggOf(p);
      const whip = s.pOuts ? (s.pH + s.pBB) * 3 / s.pOuts : 0;
      const woba = s.ab ? (0.69 * (s.bb + s.hbp) + 0.89 * (s.h - s.doubles - s.triples - s.hr) + 1.28 * s.doubles + 1.6 * s.triples + 2.08 * s.hr) / (s.ab + s.bb + s.hbp + s.sf) : 0;
      const ext = { ...s, iso: (s.ab ? (s.h + s.doubles + s.triples * 2 + s.hr * 3) / s.ab : 0) - (s.ab ? s.h / s.ab : 0), babip: s.ab - s.k - s.hr + s.sf ? (s.h - s.hr) / (s.ab - s.k - s.hr + s.sf) : 0, whip, woba, bbp: s.pa ? s.bb / s.pa : 0, kp: s.pa ? s.k / s.pa : 0 };
      const vv = stat ? stat.compute ? stat.compute(s) : ext[stat.key] ?? 0 : null;
      rows.push({ ...base, value: vv, g: s.g ?? 0, ab: s.ab ?? 0, h: s.h ?? 0, hr: s.hr ?? 0, rbi: s.rbi ?? 0 });
    }
  }
  rows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const filterDesc = flt.desc.length ? ` (${flt.desc.join(", ")})` : "";
  let answer = "";
  if (!rows.length && !flt.pitcherId) answer = 'No reconoc\xED jugadores en la pregunta \u2014 escribe el nombre completo (ej. "\xBFcu\xE1nto batea Juan Col\xF3n con 2 outs?").';
  else if (!rows.length) answer = `No reconoc\xED al bateador \u2014 solo vi al pitcher ${flt.pitcherName}.`;
  else if (!stat) {
    const r0 = rows[0];
    answer = `${r0.name} (${r0.team})${filterDesc}: ${r0.line ?? `${r0.g} juegos, ${r0.ab}-${r0.h} (${r0.ab ? (r0.h / r0.ab).toFixed(3).replace(/^0/, "") : ".000"}), ${r0.hr} HR, ${r0.rbi} CI`}.`;
  } else {
    const top = rows[0];
    if (rows.length === 1) answer = `${top.name} (${top.team})${filterDesc}: ${fmt(top.value)} ${stat.label}${top.line ? ` \u2014 ${top.line}` : ""}.`;
    else {
      const cmp = rows.slice(0, 4).map((r10) => `${r10.name} ${fmt(r10.value)}${r10.line ? ` (${r10.line})` : ""}`).join(" \xB7 ");
      answer = `${top.name} tiene m\xE1s ${stat.label}${filterDesc}: ${cmp}.`;
    }
  }
  const ai = await aiChat(
    'Eres comentarista dominicano de pelota. Responde la pregunta del usuario en espa\xF1ol dominicano, 1-3 frases, usando SOLO los datos JSON dados (no inventes n\xFAmeros). Si el filtro dice "vs X" ese es el pitcher. Si falta el dato dilo.',
    `Pregunta: "${question}". Datos: ${JSON.stringify({ jugadores: rows.map((r10) => ({ nombre: r10.name, equipo: r10.team, valor: r10.value, linea: r10.line, g: r10.g, ab: r10.ab, h: r10.h, hr: r10.hr, rbi: r10.rbi })), stat: stat?.label ?? null, filtro: flt.desc.join(", ") || null, respuesta_base: answer })}`
  );
  const aiText = typeof ai === "string" ? ai : ai?.answer;
  if (aiText) answer = aiText;
  res.json({ ok: true, answer, stat: stat?.key ?? null, filter: flt.desc.join(", ") || null, players: rows, ai: aiEnabled() });
});
r9.post("/ai/video-analyze", async (_req, res) => {
  const opts = [
    { detected_play: "hit", direction: "CF", suggested_code: "H8", confidence: 0.85, result: "1B", notation: "H8" },
    { detected_play: "out", direction: "INF", suggested_code: "6-3", confidence: 0.9, result: "GO", notation: "6-3" },
    { detected_play: "out", direction: "RF", suggested_code: "F9", confidence: 0.78, result: "FO", notation: "F9" },
    { detected_play: "error", direction: "INF", suggested_code: "E6", confidence: 0.74, result: "E", notation: "E6" },
    { detected_play: "hit", direction: "LF", suggested_code: "2B", confidence: 0.81, result: "2B", notation: null }
  ];
  const pick = opts[Math.floor(Math.random() * opts.length)];
  res.json({ ok: true, ...pick, mock: true });
});
var ai_default = r9;

// src/index.ts
var app = express();
app.use(cors());
app.use("/api/import", guard("admin"), express.json({ limit: "60mb" }), import_default);
app.use(express.json({ limit: "10mb" }));
var APP_VERSION = "2026-11-03.31";
var webDist = [
  path7.resolve(path7.dirname(fileURLToPath2(import.meta.url)), "../../web/dist"),
  // tsx/src
  path7.resolve(path7.dirname(fileURLToPath2(import.meta.url)), "../../../web/dist"),
  // dist compilado
  path7.resolve(process.cwd(), "../web/dist")
].find((p) => fs7.existsSync(path7.join(p, "index.html")));
var webBuildId = () => {
  try {
    return fs7.readFileSync(path7.join(webDist, "index.html"), "utf8").match(/\/assets\/(index-[^"']+\.js)/)?.[1] ?? "";
  } catch {
    return "";
  }
};
var staleClient = false;
app.get("/api/health", (_req, res) => {
  const lan = Object.values(os2.networkInterfaces()).flat().filter((i) => !!i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  res.json({ ok: true, name: "PoxScore API", v: APP_VERSION, lan, build: webBuildId(), staleClient });
});
app.use("/api/auth", auth_default);
app.use("/api/teams", guard("admin"), teams_default);
app.use("/api/games", guard("anotador"), games_default);
app.use("/api/games", guard("anotador"), events_default);
app.use("/api/stats", guard("admin"), stats_default);
app.use("/api/leagues", guard("admin"), leagues_default);
app.use("/api/backup", guard("admin"), backup_default);
app.use("/api/publish", guard("admin"), publish_default);
app.use("/api", guard("anotador"), ai_default);
if (webDist) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path7.join(webDist, "index.html")));
  console.log(`Sirviendo app web desde ${webDist}`);
}
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));
var port = Number(process.env.PORT ?? 4e3);
app.listen(port, () => console.log(`PoxScore API en http://localhost:${port}`));
setTimeout(async () => {
  try {
    await prisma.gameEvent.findFirst({ where: { clientKey: "__sondeo__" }, select: { aiVoice: true } });
  } catch (e) {
    if (/Unknown argument/.test(String(e))) {
      staleClient = true;
      console.error('\u26A0 CLIENTE PRISMA DESACTUALIZADO \u2014 el c\xF3digo es m\xE1s nuevo que node_modules/.prisma. Corre "npx prisma generate" dentro de server/ y reinicia.');
    }
  }
}, 3e3);
startAutoBackup();
consolidateStatLineDupes().then((n) => {
  if (n) console.log(`statLines consolidadas en ${n} juego(s)`);
}).catch((e) => console.error("consolidateStatLineDupes:", e));
prisma.$executeRaw`UPDATE Game SET date = DATE_ADD(date, INTERVAL 12 HOUR)
  WHERE HOUR(date) = 0 AND MINUTE(date) = 0 AND SECOND(date) = 0`.then((n) => {
  if (n) console.log(`fechas de juego normalizadas: ${n}`);
}).catch((e) => console.error("fix fechas medianoche:", e));
repairEventNotation().then((n) => {
  if (n) console.log(`notaciones de eventos reparadas: ${n}`);
}).catch((e) => console.error("repairEventNotation:", e));
