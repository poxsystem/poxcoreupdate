import fs from 'node:fs';
import path from 'node:path';
import { prisma } from './prisma.js';

/** Tablas en orden de dependencia (padres primero — MySQL valida FK al insertar) */
export const ALL_TABLES = ['leagues', 'seasons', 'teams', 'series', 'players', 'games', 'lineups', 'events', 'seasonStats', 'users'] as const;
export type TableName = typeof ALL_TABLES[number];

/** Respaldo completo de la base — todas las ligas. */
export async function exportAll() {
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
    prisma.user.findMany(), // cuentas con su passHash — restaurar sin ellas borraba el admin
  ]);
  return { version: 2, exportedAt: new Date().toISOString(), leagues, seasons, teams, series, players, games, lineups, events, seasonStats, users };
}

/** Respaldo de una sola liga — solo lo que cuelga de ella. null si no existe. */
export async function exportLeague(leagueId: string) {
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
    prisma.playerSeasonStat.findMany({ where: { playerId: { in: pids } } }),
  ]);
  return {
    version: 2, exportedAt: new Date().toISOString(), leagueOnly: leagueId,
    leagues: [league], seasons, teams, series, players, games, lineups, events, seasonStats,
  };
}

/** ¿Un JSON de respaldo PoxScore? Cualquier objeto con tablas de respaldo
 *  (v1: teams/players/games sueltos · v2: version+leagues…). Un .pox.json de
 *  liga lleva `league` (string) y sus seasons traen teams/games anidados —
 *  las filas Season de un respaldo traen leagueId. */
export function isBackupFile(raw: unknown): raw is Record<string, unknown> {
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.league === 'string') return false;
  // descarta .pox.json: sus seasons traen equipos/juegos/jugadores anidados
  const s0 = Array.isArray(o.seasons) ? (o.seasons[0] as Record<string, unknown> | undefined) : undefined;
  if (s0 && (Array.isArray(s0.teams) || Array.isArray(s0.games) || Array.isArray(s0.players))) return false;
  return Array.isArray(o.leagues) || Array.isArray(o.seasons) || Array.isArray(o.teams)
    || Array.isArray(o.players) || Array.isArray(o.games) || Array.isArray(o.lineups)
    || Array.isArray(o.events) || Array.isArray(o.seasonStats);
}

/** Restaura un respaldo — createMany por tabla en orden FK, omite ids existentes. */
export async function importBackup(b: Record<string, unknown>) {
  await autoBackup('antes de restaurar respaldo');
  const rows = (t: TableName) => ((b[t] ?? []) as never[]);
  await prisma.league.createMany({ data: rows('leagues'), skipDuplicates: true });
  await prisma.season.createMany({ data: rows('seasons'), skipDuplicates: true });
  await prisma.team.createMany({ data: rows('teams'), skipDuplicates: true });
  await prisma.series.createMany({ data: rows('series'), skipDuplicates: true });
  await prisma.player.createMany({ data: rows('players'), skipDuplicates: true });
  await prisma.game.createMany({ data: rows('games'), skipDuplicates: true });
  await prisma.lineupEntry.createMany({ data: rows('lineups'), skipDuplicates: true });
  await prisma.gameEvent.createMany({ data: rows('events'), skipDuplicates: true });
  await prisma.playerSeasonStat.createMany({ data: rows('seasonStats'), skipDuplicates: true });
  await prisma.user.createMany({ data: rows('users'), skipDuplicates: true });
  return { imported: Object.fromEntries(ALL_TABLES.map((t) => [t, (b[t] as unknown[] | undefined)?.length ?? 0])) };
}

// ─── Restaurar UNA liga al estado de un respaldo ─────────────────────────────
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const bkRows = (b: Record<string, unknown>, k: TableName): any[] =>
  (Array.isArray(b[k]) ? (b[k] as any[]) : []);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function leagueRows(b: Record<string, unknown>, lg: any) {
  const seasons = bkRows(b, 'seasons').filter((s) => s.leagueId === lg.id);
  const teams = bkRows(b, 'teams').filter((t) => t.leagueId === lg.id);
  const tids = new Set(teams.map((t) => t.id));
  const series = bkRows(b, 'series').filter((s) => s.leagueId === lg.id);
  const players = bkRows(b, 'players').filter((p) => tids.has(p.teamId));
  const pids = new Set(players.map((p) => p.id));
  const games = bkRows(b, 'games').filter((g) => g.leagueId === lg.id);
  const gids = new Set(games.map((g) => g.id));
  const lineups = bkRows(b, 'lineups').filter((l) => gids.has(l.gameId));
  const events = bkRows(b, 'events').filter((e) => gids.has(e.gameId));
  const seasonStats = bkRows(b, 'seasonStats').filter((s) => pids.has(s.playerId));
  return { seasons, teams, series, players, games, lineups, events, seasonStats };
}

/** Resumen por liga dentro de un respaldo — para el selector del modal. */
export function previewBackupLeagues(b: Record<string, unknown>) {
  return bkRows(b, 'leagues').map((lg) => {
    const r = leagueRows(b, lg);
    const years = [...new Set(r.seasons.map((s) => s.year))].sort() as number[];
    const dates = r.games.map((g) => String(g.date ?? '').slice(0, 10)).sort();
    return {
      name: lg.name as string, years,
      teams: r.teams.length, players: r.players.length,
      games: r.games.length, events: r.events.length,
      from: dates[0] ?? null, to: dates[dates.length - 1] ?? null,
    };
  });
}

/** Borra la liga actual y la reinserta EXACTAMENTE como está en el respaldo
 *  (como si el import dañado nunca hubiera pasado). Hace respaldo antes. */
export async function restoreLeagueFromBackup(b: Record<string, unknown>, leagueName: string) {
  const lgB = bkRows(b, 'leagues').find((l) => norm(l.name) === norm(leagueName));
  if (!lgB) {
    throw new Error(`"${leagueName}" no está en el respaldo — hay: ${bkRows(b, 'leagues').map((l) => l.name).join(', ')}`);
  }
  const R = leagueRows(b, lgB);
  await autoBackup('antes de restaurar liga');
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
    league: lgB.name, replaced: !!lgDb,
    years: R.seasons.map((s) => s.year).sort(),
    teams: R.teams.length, players: R.players.length, games: R.games.length,
  };
}

// ─── Respaldo automático a disco ─────────────────────────────────────────────
// Escribe backups/auto-YYYY-MM-DD_HHmm.json junto al server (o BACKUP_DIR).
// Conserva los últimos KEEP archivos. Se invoca al arrancar, cada 6 h y al
// cerrar cada juego (desde la ruta finish).
const KEEP = 30;
let lastAutoAt = 0;

export function backupDir() {
  return process.env.BACKUP_DIR || path.resolve(process.cwd(), 'backups');
}

export async function autoBackup(reason = 'auto') {
  // anti-rafaga: varias operaciones seguidas (fusión por lotes, borrados)
  // comparten un solo respaldo si cayó uno hace <90 s
  if (Date.now() - lastAutoAt < 90_000) return;
  lastAutoAt = Date.now();
  try {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const data = await exportAll();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const file = path.join(dir, `auto-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(data));
    // rotación: borra los más viejos
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('auto-') && f.endsWith('.json')).sort();
    while (files.length > KEEP) {
      fs.unlinkSync(path.join(dir, files.shift()!));
    }
    console.log(`Respaldo automático (${reason}) → ${file} (${files.length} conservados)`);
  } catch (e) {
    console.error('Respaldo automático falló:', e);
  }
}

let timer: NodeJS.Timeout | null = null;
/** Arranca el ciclo: respaldo al iniciar + cada 6 horas. */
export function startAutoBackup() {
  if (timer) return;
  setTimeout(() => autoBackup('arranque'), 30_000); // tras el arranque
  timer = setInterval(() => autoBackup('programado'), 6 * 3600_000);
  timer.unref();
}
