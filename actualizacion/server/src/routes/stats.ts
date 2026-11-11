import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { applyEvent, computeBoxscore, computeCgSho, defaultAdvances, initialState, isMidResult, reduceGame } from '@poxscore/shared';
import type { GameEvent, PAResult } from '@poxscore/shared';
import { loadEvents, gameContrib } from './games.js';
import { aggregateGames, GAME_STATS_INCLUDE } from './leagues.js';
import { autoBackup } from '../backup-lib.js';
import { mergeLines, SL_NUMS, type StatLine } from '../statlines.js';

const r = Router();

const rowToEvent = (e: {
  seq: number; inning: number; half: string; batterId: string | null; pitcherId: string | null;
  result: string; notation?: string | null; advances: unknown;
  errorOn?: string | null; putouts?: string | null; assists?: string | null;
}): GameEvent => ({
  seq: e.seq, inning: e.inning, half: e.half as 'TOP' | 'BOTTOM',
  batterId: e.batterId, pitcherId: e.pitcherId,
  result: e.result as GameEvent['result'], notation: e.notation ?? null,
  errorOn: e.errorOn ? JSON.parse(e.errorOn) : undefined,
  putouts: e.putouts ? JSON.parse(e.putouts) : undefined,
  assists: e.assists ? JSON.parse(e.assists) : undefined,
  advances: e.advances as GameEvent['advances'],
});

const f3 = (n: number) => Number(n.toFixed(3));
const avgOf = (h: number, ab: number) => f3(ab ? h / ab : 0);
const obpOf = (h: number, bb: number, hbp: number, ab: number, sf: number) => {
  const den = ab + bb + hbp + sf;
  return f3(den ? (h + bb + hbp) / den : 0);
};

interface MiniLine { pa: number; ab: number; h: number; doubles: number; triples: number; hr: number; rbi: number; bb: number; k: number; hbp: number; sf: number; }
const emptyMini = (): MiniLine => ({ pa: 0, ab: 0, h: 0, doubles: 0, triples: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sf: 0 });

// StatLine/SL_NUMS/mergeLines viven en ../statlines.js (módulo neutro —
// games.ts también los usa para las líneas manuales del editor admin)
export { mergeLines };
export type { StatLine };

/**
 * Limpieza de Game.statLines: en juegos donde un playerId aparece 2+ veces
 * (duplicados pre-fusión o respaldos viejos) consolida en una línea.
 * Se corre al arrancar el server (idempotente — solo escribe si hay duplicados)
 * y tras cada merge-player. `gameIds` limita el alcance; sin él revisa todo.
 */
export async function consolidateStatLineDupes(gameIds?: string[]) {
  const games = await prisma.game.findMany({
    where: gameIds ? { id: { in: gameIds } } : {},
    select: { id: true, statLines: true },
  });
  let fixed = 0;
  for (const g of games) {
    const lines = (g.statLines ?? []) as unknown as StatLine[];
    if (!lines.length) continue;
    const seen = new Map<string, number>();
    lines.forEach((l) => seen.set(l.playerId, (seen.get(l.playerId) ?? 0) + 1));
    if (![...seen.values()].some((n) => n > 1)) continue;
    const byPlayer = new Map<string, StatLine[]>();
    for (const l of lines) {
      const arr = byPlayer.get(l.playerId) ?? [];
      arr.push(l);
      byPlayer.set(l.playerId, arr);
    }
    const merged = [...byPlayer.values()].map((arr) => mergeLines(arr)!);
    await prisma.game.update({ where: { id: g.id }, data: { statLines: JSON.parse(JSON.stringify(merged)) } });
    fixed++;
  }
  return fixed;
}
const HIT_SET = new Set(['1B', '2B', '3B', 'HR', 'RHB', '1BE', '2BE', '3BE', 'HRIP']);

/** Mini-línea de un bateador sobre un subconjunto de eventos de SU turno */
function miniLine(evs: GameEvent[]): MiniLine {
  const m = emptyMini();
  for (const ev of evs) {
    const r = ev.result;
    m.pa += 1;
    if (HIT_SET.has(r)) {
      m.h += 1; m.ab += 1;
      if (r === '2B' || r === '2BE') m.doubles += 1;
      if (r === '3B' || r === '3BE') m.triples += 1;
      if (r === 'HR' || r === 'HRIP') m.hr += 1;
    } else if (r === 'BB' || r === 'IBB') m.bb += 1;
    else if (r === 'HBP') m.hbp += 1;
    else if (r === 'SF') m.sf += 1;
    else if (r === 'SAC' || r === 'CI' || r === 'OOT') { /* sin AB */ }
    else { m.ab += 1; if (r === 'K' || r === 'KWP' || r === 'KPB') m.k += 1; }
    const runs = ev.advances.filter((a) => a.to === 'HOME').length;
    if (!['E', 'DP', 'TP', 'KWP', 'KPB'].includes(r)) m.rbi += runs;
  }
  return m;
}

/** Boxscore de un juego (del stream de eventos; importados sin eventos se reconstruyen de statLines) */
r.get('/games/:id/boxscore', async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  const evs = await loadEvents(req.params.id);
  const lines = (game?.statLines ?? []) as {
    playerId: string; teamId: string | null; pa?: number; ab?: number; r?: number;
    h?: number; doubles?: number; triples?: number; hr?: number; rbi?: number; bb?: number;
    k?: number; hbp?: number; sac?: number; sf?: number; sb?: number;
    gp?: number; pOuts?: number; pH?: number; pR?: number; pER?: number;
    pBB?: number; pK?: number; pHR?: number; pPitches?: number;
  }[];
  if (evs.length || !lines.length) return res.json(computeBoxscore(evs, game?.innings ?? 9));
  const box = {
    away: {} as Record<string, unknown>, home: {} as Record<string, unknown>,
    pitchers: {} as Record<string, unknown>,
    linescore: { away: [] as number[], home: [] as number[] }, lob: { away: 0, home: 0 },
  };
  for (const ln of lines) {
    const side = ln.teamId === game!.awayTeamId ? 'away' : 'home';
    box[side][ln.playerId] = {
      playerId: ln.playerId, pa: ln.pa ?? 0, ab: ln.ab ?? 0, r: ln.r ?? 0, h: ln.h ?? 0,
      rbi: ln.rbi ?? 0, bb: ln.bb ?? 0, k: ln.k ?? 0, hbp: ln.hbp ?? 0,
      doubles: ln.doubles ?? 0, triples: ln.triples ?? 0, hr: ln.hr ?? 0,
      sac: ln.sac ?? 0, sf: ln.sf ?? 0, sb: ln.sb ?? 0,
    };
    if ((ln.gp ?? 0) || (ln.pOuts ?? 0)) {
      box.pitchers[ln.playerId] = {
        playerId: ln.playerId, outs: ln.pOuts ?? 0, h: ln.pH ?? 0, r: ln.pR ?? 0,
        er: ln.pER ?? 0, bb: ln.pBB ?? 0, k: ln.pK ?? 0, hr: ln.pHR ?? 0, pitches: ln.pPitches ?? 0,
      };
    }
  }
  res.json(box);
});

/** GET /stats/search-players?q= — buscador global de jugadores (topbar) */
r.get('/search-players', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.json([]);
  const players = await prisma.player.findMany({
    where: { OR: [{ firstName: { contains: q } }, { lastName: { contains: q } }] },
    include: { team: { select: { name: true, shortName: true, league: { select: { name: true, year: true } } } } },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    take: 12,
  });
  res.json(players.map((p) => ({
    id: p.id, firstName: p.firstName, lastName: p.lastName, number: p.number,
    positions: p.positions, active: p.active,
    team: p.team?.name ?? null,
    league: p.team?.league ? `${p.team.league.name} ${p.team.league.year}` : null,
  })));
});

/** Estadísticas acumuladas de un jugador en todos sus juegos */
r.get('/players/:id', async (req, res) => {
  const playerId = req.params.id;
  const events = await prisma.gameEvent.findMany({
    where: { OR: [{ batterId: playerId }, { pitcherId: playerId }, { advances: { string_contains: playerId } }] },
    orderBy: [{ gameId: 'asc' }, { seq: 'asc' }],
  });

  // agregado simple por juego y total
  const byGame = new Map<string, ReturnType<typeof computeBoxscore>>();
  const grouped = new Map<string, typeof events>();
  const gameMeta = new Map<string, { innings: number; date: Date; opponent: string; league: string | null }>();
  for (const g of await prisma.game.findMany({
    where: { id: { in: [...new Set(events.map((x) => x.gameId))] } },
    include: {
      homeTeam: { select: { id: true, name: true, shortName: true } },
      awayTeam: { select: { id: true, name: true, shortName: true } },
      league: { select: { name: true, year: true } },
      lineups: { where: { playerId }, select: { teamId: true } },
    },
  })) {
    const myTeam = g.lineups[0]?.teamId;
    const opp = myTeam === g.awayTeamId ? g.homeTeam : myTeam === g.homeTeamId ? g.awayTeam : g.awayTeam;
    gameMeta.set(g.id, {
      innings: g.innings, date: g.date,
      opponent: opp?.shortName ?? opp?.name ?? '?',
      league: g.league ? `${g.league.name} ${g.league.year}` : null,
    });
  }
  for (const e of await prisma.gameEvent.findMany({
    where: { gameId: { in: [...new Set(events.map((x) => x.gameId))] } },
    orderBy: { seq: 'asc' },
  })) {
    const arr = grouped.get(e.gameId) ?? [];
    arr.push(e);
    grouped.set(e.gameId, arr);
  }
  for (const [gid, evs] of grouped) {
    const meta = gameMeta.get(gid);
    byGame.set(gid, computeBoxscore(evs.map((e) => ({
      seq: e.seq, inning: e.inning, half: e.half as 'TOP' | 'BOTTOM',
      batterId: e.batterId, pitcherId: e.pitcherId,
      result: e.result as never,
      errorOn: e.errorOn ? (JSON.parse(e.errorOn) as string[]) : undefined,
      advances: e.advances as never,
    })), meta?.innings ?? 9));
  }

  const total = { pa: 0, ab: 0, r: 0, h: 0, rbi: 0, bb: 0, k: 0, doubles: 0, triples: 0, hr: 0, sb: 0 };
  const pitch = { outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0 };
  // errores cometidos como fildeador (de errorOn derivado de la notación "E5"…)
  const fielding = {
    e: await prisma.gameEvent.count({ where: { errorOn: { contains: playerId } } }),
  };
  const games: unknown[] = [];
  for (const [gid, box] of byGame) {
    const line = { ...box.away[playerId], ...box.home[playerId] };
    const pline = box.pitchers[playerId];
    if (line.playerId) {
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += (line as never)[k] ?? 0;
    }
    if (pline) for (const k of Object.keys(pitch) as (keyof typeof pitch)[]) pitch[k] += pline[k];
    const meta = gameMeta.get(gid);
    games.push({
      gameId: gid, date: meta?.date, opponent: meta?.opponent, league: meta?.league,
      batting: line.playerId ? line : null, pitching: pline ?? null,
    });
  }

  // acumulado oficial de temporada (se suma al finalizar cada juego)
  const seasons = await prisma.playerSeasonStat.findMany({
    where: { playerId },
    orderBy: { season: 'desc' },
  });

  const avg = total.ab ? total.h / total.ab : 0;
  const era = pitch.outs ? (pitch.er * 27) / pitch.outs : 0; // ERA = carreras limpias (9 inn)
  res.json({ playerId, games, batting: { ...total, avg }, pitching: { ...pitch, era }, fielding, seasons });
});

/**
 * Tarjeta completa del jugador (estilo MLB): datos personales, temporadas oficiales,
 * y línea por cada liga/torneo+año donde participó — los stats lo siguen por playerId
 * aunque haya cambiado de equipo.
 */
// resultados que son batazo en juego (excluye K/BB/HBP/CI — no hay dirección)
const BIP = new Set(['1B', '2B', '3B', 'HR', 'GO', 'FO', 'LO', 'PO', 'DP', 'TP', 'SAC', 'SF', 'E', 'FC', 'IF', 'XF', '1BE', '2BE', '3BE', 'RHB']);

// trayectoria del batazo: prefijo G/L/F en la notación ("G9"=rola al RF); si no, se deriva del resultado
const TRAJ_OF: Record<string, 'G' | 'L' | 'F'> = {
  GO: 'G', LO: 'L', FO: 'F', PO: 'F', IF: 'F', SF: 'F', XF: 'F', SAC: 'G',
};

/** GET /players/:id/spray — ubicación de cada batazo (1er fildeador de la notación) para el spray chart */
/**
 * PUT /players/:id/season — edición manual del acumulado de temporada
 * body: { season, scope?, ...stats } — SOBRESCRIBE los valores (corrección manual).
 * `ip` llega en entradas decimales (7.2 = 7 IP + 2 outs) → pOuts.
 * Útil tras importar de BallStat: ajustar números sin rehacer el juego.
 */
const SEASON_EDITABLE = [
  'g', 'pa', 'ab', 'r', 'h', 'doubles', 'triples', 'hr', 'rbi', 'bb', 'k', 'hbp', 'sac', 'sf', 'sb',
  'gp', 'gs', 'w', 'l', 'sv', 'hld', 'bs', 'cg', 'sho',
  'pOuts', 'pH', 'pR', 'pER', 'pBB', 'pK', 'pHR', 'pPitches', 'e',
] as const;

r.put('/players/:id/season', async (req, res) => {
  try {
    const playerId = req.params.id;
    const { season, scope, ip, ...rest } = req.body as Record<string, unknown> & { season?: number; scope?: string; ip?: number };
    if (!season || !Number.isFinite(season)) { res.status(400).json({ error: 'falta season' }); return; }
    const p = await prisma.player.findUnique({ where: { id: playerId } });
    if (!p) { res.status(404).json({ error: 'jugador no encontrado' }); return; }

    const data: Record<string, number> = {};
    for (const k of SEASON_EDITABLE) {
      const v = rest[k];
      if (typeof v === 'number' && Number.isFinite(v)) data[k] = Math.max(0, Math.round(v));
    }
    if (typeof ip === 'number' && Number.isFinite(ip) && ip >= 0) {
      const inn = Math.floor(ip);
      data.pOuts = inn * 3 + Math.min(2, Math.round((ip - inn) * 10)); // outs extra van 0–2
    }
    const sc = scope === 'POST' ? 'POST' : 'REG';
    // Delta manual (`adj`): lo escrito MENOS lo que los juegos derivan.
    // Invariante: fila = derivado + adj — accumulateSeason/auditoría solo
    // incrementan la fila, así el ajuste sobrevive a juegos posteriores.
    const prev = await prisma.playerSeasonStat.findUnique({
      where: { playerId_season_scope: { playerId, season, scope: sc } },
    });
    const prevAdj = ((prev?.adj ?? {}) as Record<string, number>);
    const adj: Record<string, number> = { ...prevAdj };
    for (const k of Object.keys(data)) {
      const stored = Number((prev as unknown as Record<string, number> | null)?.[k]) || 0;
      const d = data[k] - (stored - (prevAdj[k] ?? 0));
      if (d) adj[k] = d; else delete adj[k];
    }
    const row = await prisma.playerSeasonStat.upsert({
      where: { playerId_season_scope: { playerId, season, scope: sc } },
      create: { playerId, season, scope: sc, ...data, adj: Object.keys(adj).length ? adj : Prisma.DbNull },
      update: { ...data, adj: Object.keys(adj).length ? adj : Prisma.DbNull },
    });
    res.json({ ok: true, stat: row });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

r.get('/players/:id/spray', async (req, res) => {
  const playerId = req.params.id;
  const games = await prisma.game.findMany({
    where: { status: 'FINAL', events: { some: { batterId: playerId } } },
    select: { id: true, seriesId: true, league: { select: { year: true, name: true } } },
    orderBy: { date: 'asc' },
  });
  const points: { result: string; loc: number; traj: 'G' | 'L' | 'F' | null; season: number; post: boolean; dir?: number; dist?: number }[] = [];
  for (const g of games) {
    const evs = await loadEvents(g.id);
    for (const ev of evs) {
      if (ev.batterId !== playerId || !BIP.has(ev.result)) continue;
      // ubicación fina del spray sheet tiene prioridad; si no, 1er dígito de
      // la notación = a quién le pegó el batazo (6-3→SS, F9→RF, E5→3B, 10=JC)
      const m = ev.notation?.match(/10|[1-9]/);
      if (ev.sprayDir == null && !m) continue;
      const tm = ev.notation?.match(/^[GLF]/);
      const traj = (tm ? tm[0] : TRAJ_OF[ev.result] ?? null) as 'G' | 'L' | 'F' | null;
      points.push({
        result: ev.result, loc: m ? Number(m[0]) : 0, traj, season: g.league?.year ?? 0, post: !!g.seriesId,
        ...(ev.sprayDir != null && ev.sprayDist != null ? { dir: ev.sprayDir, dist: ev.sprayDist } : {}),
      });
    }
  }
  res.json({ points });
});

/** GET /players/:id/pitchloc — ubicación de pitcheos (notation "Zrc": r=0..4 fila, c=0..4 col; zona = 1-3) */
r.get('/players/:id/pitchloc', async (req, res) => {
  const playerId = req.params.id;
  const games = await prisma.game.findMany({
    where: { status: 'FINAL', events: { some: { pitcherId: playerId } } },
    select: { id: true, seriesId: true, league: { select: { year: true } } },
  });
  const points: { r: number; c: number; result: string; season: number; post: boolean }[] = [];
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

r.get('/players/:id/full', async (req, res) => {
  const playerId = req.params.id;
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: { team: true },
  });
  if (!player) return res.status(404).json({ error: 'Jugador no encontrado' });

  // excluido de publicación: la ficha existe pero sale "BLOQUEADO" sin números
  if (player.blocked) {
    return res.json({
      blocked: true,
      name: `${player.firstName} ${player.lastName}`,
      teamName: player.team?.name ?? null,
    });
  }

  // torneos donde participó: ligas con juegos FINAL que lo incluyeron en lineup o eventos
  const leagues = await prisma.league.findMany({ orderBy: [{ year: 'desc' }, { name: 'asc' }] });
  const seasons = await prisma.playerSeasonStat.findMany({ where: { playerId }, orderBy: { season: 'desc' } });
  // correcciones manuales del acumulado (adj = delta del edit manual): la fila
  // no lleva leagueId → se aplican al torneo de la liga de su equipo actual
  // (o al primero si su equipo no está entre sus torneos)
  const adjLeagueId = leagues.some((l) => l.id === player.team?.leagueId)
    ? player.team?.leagueId : leagues[0]?.id;
  const tournaments: unknown[] = [];

  // juegos importados sin eventos/lineup: el jugador está dentro del JSON statLines
  // (columna Json real — string_contains no aplica; JSON_SEARCH busca valores string)
  const importedGameIds = new Set((await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM Game WHERE status = 'FINAL'
    AND JSON_SEARCH(statLines, 'one', ${playerId}) IS NOT NULL
  `).map((r) => r.id));

  for (const league of leagues) {
    const games = await prisma.game.findMany({
      where: {
        leagueId: league.id, status: 'FINAL',
        OR: [
          { lineups: { some: { playerId } } },
          { events: { some: { batterId: playerId } } },
          { events: { some: { pitcherId: playerId } } },
          { id: { in: [...importedGameIds] } }, // juegos importados (sin eventos/lineup)
        ],
      },
      orderBy: { date: 'asc' },
      include: {
        homeTeam: { select: { id: true, name: true, shortName: true } },
        awayTeam: { select: { id: true, name: true, shortName: true } },
        lineups: { where: { playerId }, select: { teamId: true, role: true, position: true } },
      },
    });
    if (!games.length) continue;

    // acumuladores separados: temporada regular vs playoffs (series)
    const mkAcc = () => ({
      bat: { g: 0, pa: 0, ab: 0, r: 0, h: 0, doubles: 0, triples: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sac: 0, sf: 0, sb: 0 },
      pit: { gp: 0, gs: 0, w: 0, l: 0, sv: 0, hld: 0, bs: 0, cg: 0, sho: 0, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0, pitches: 0 },
      fld: { po: 0, a: 0, e: 0 },
      log: [] as unknown[],
      teamsMap: new Map<string, { id: string; name: string; shortName: string | null }>(),
      stints: new Map<string, {
        teamId: string; team: string; year: number; g: number;
        bat: Record<string, number>; pit: Record<string, number>; fld: { po: number; a: number; e: number };
      }>(),
    });
    type Acc = ReturnType<typeof mkAcc>;
    const regAcc = mkAcc();
    const postAcc = mkAcc();
    // stint = etapa en un equipo DENTRO de una temporada — 2022 con Tigres y
    // 2026 con Tigres son etapas distintas, no una continua (clave teamId:año)
    const stintOf = (acc: Acc, teamId: string, teamName: string, year: number) => {
      let s = acc.stints.get(`${teamId}:${year}`);
      if (!s) {
        s = {
          teamId, team: teamName, year, g: 0,
          bat: { g: 0, pa: 0, ab: 0, r: 0, h: 0, doubles: 0, triples: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sac: 0, sf: 0, sb: 0 },
          pit: { gp: 0, gs: 0, w: 0, l: 0, sv: 0, hld: 0, bs: 0, cg: 0, sho: 0, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0, pitches: 0 },
          fld: { po: 0, a: 0, e: 0 },
        };
        acc.stints.set(`${teamId}:${year}`, s);
      }
      return s;
    };

    // acumuladores por año de fecha de juego — una liga que abarca varias
    // temporadas (ej. Liga Test 2022-2026) se despliega año por año en la tarjeta
    const yearAccs = new Map<number, Acc>();

    for (const g of games) {
      const evs = await loadEvents(g.id);
      const box = computeBoxscore(evs, g.innings);
      // juego importado sin eventos: la línea del jugador viene de Game.statLines.
      // puede haber >1 línea suya (post-fusión: las dos fichas aparecían en el
      // mismo juego) → se COMBINAN en una, igual que hace el agregador del website
      const ln = mergeLines(
        ((g.statLines ?? []) as unknown as StatLine[]).filter((x) => x.playerId === playerId),
      );
      const bat = box.away[playerId] ?? box.home[playerId] ?? (ln && (ln.pa ?? 0) + (ln.sb ?? 0) > 0 ? {
        playerId, pa: ln.pa ?? 0, ab: ln.ab ?? 0, r: ln.r ?? 0, h: ln.h ?? 0,
        rbi: ln.rbi ?? 0, bb: ln.bb ?? 0, k: ln.k ?? 0, hbp: ln.hbp ?? 0,
        doubles: ln.doubles ?? 0, triples: ln.triples ?? 0, hr: ln.hr ?? 0,
        sac: ln.sac ?? 0, sf: ln.sf ?? 0, sb: ln.sb ?? 0,
      } : undefined);
      const pit = box.pitchers[playerId] ?? (ln && ((ln.gp ?? 0) || (ln.pOuts ?? 0)) ? {
        playerId, outs: ln.pOuts ?? 0, h: ln.pH ?? 0, r: ln.pR ?? 0, er: ln.pER ?? 0,
        bb: ln.pBB ?? 0, k: ln.pK ?? 0, hr: ln.pHR ?? 0, pitches: ln.pPitches ?? 0,
      } : undefined);
      // decisiones W/L/SV/HLD/BS + GS/CG/SHO: del registro del juego si fue
      // anotado en vivo, de la statLine si fue importado (no doble-contar)
      const hlds: string[] = g.hldIds ? JSON.parse(g.hldIds) : [];
      const bss: string[] = g.bsIds ? JSON.parse(g.bsIds) : [];
      const { cg: cgs, sho: shos } = evs.length ? computeCgSho(evs, g.innings) : { cg: [] as string[], sho: [] as string[] };
      const dec = {
        gs: (g.lineups.length ? (g.lineups.some((l) => l.role === 'STARTER' && l.position === 'P') ? 1 : 0) : (ln?.gs ?? 0)),
        w: (g.wpId ? (g.wpId === playerId ? 1 : 0) : (ln?.w ?? 0)),
        l: (g.lpId ? (g.lpId === playerId ? 1 : 0) : (ln?.l ?? 0)),
        sv: (g.svId ? (g.svId === playerId ? 1 : 0) : (ln?.sv ?? 0)),
        hld: (g.hldIds ? (hlds.includes(playerId) ? 1 : 0) : (ln?.hld ?? 0)),
        bs: (g.bsIds ? (bss.includes(playerId) ? 1 : 0) : (ln?.bs ?? 0)),
        cg: (evs.length ? (cgs.includes(playerId) ? 1 : 0) : (ln?.cg ?? 0)),
        sho: (evs.length ? (shos.includes(playerId) ? 1 : 0) : (ln?.sho ?? 0)),
      };
      const decAny = dec.gs + dec.w + dec.l + dec.sv + dec.hld + dec.bs + dec.cg + dec.sho > 0;
      const pitFull = (pit || decAny)
        ? { ...(pit ?? { playerId, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0, pitches: 0 }), ...dec }
        : undefined;
      const myTeamId = g.lineups[0]?.teamId ?? ln?.teamId ?? player.teamId;
      const myTeam = myTeamId === g.awayTeamId ? g.awayTeam : myTeamId === g.homeTeamId ? g.homeTeam : null;
      const opp = myTeamId === g.awayTeamId ? g.homeTeam : g.awayTeam;

      const gYear = new Date(g.date).getFullYear();
      const feed = (acc: Acc) => {
        if (g.lineups.length || bat || pitFull || ln) acc.bat.g += 1;
        if (bat) {
          acc.bat.pa += bat.pa; acc.bat.ab += bat.ab; acc.bat.r += bat.r; acc.bat.h += bat.h;
          acc.bat.doubles += bat.doubles; acc.bat.triples += bat.triples; acc.bat.hr += bat.hr;
          acc.bat.rbi += bat.rbi; acc.bat.bb += bat.bb; acc.bat.k += bat.k; acc.bat.hbp += bat.hbp;
          acc.bat.sac += bat.sac; acc.bat.sf += bat.sf; acc.bat.sb += bat.sb;
        }
        if (pitFull) {
          acc.pit.gp += 1; acc.pit.gs += pitFull.gs; acc.pit.w += pitFull.w; acc.pit.l += pitFull.l;
          acc.pit.sv += pitFull.sv; acc.pit.hld += pitFull.hld; acc.pit.bs += pitFull.bs;
          acc.pit.cg += pitFull.cg; acc.pit.sho += pitFull.sho;
          acc.pit.outs += pitFull.outs; acc.pit.h += pitFull.h; acc.pit.r += pitFull.r;
          acc.pit.er += pitFull.er; acc.pit.bb += pitFull.bb; acc.pit.k += pitFull.k; acc.pit.hr += pitFull.hr; acc.pit.pitches += pitFull.pitches;
        }
        for (const ev of evs) {
          for (const p of ev.putouts ?? []) if (p === playerId) acc.fld.po += 1;
          for (const p of ev.assists ?? []) if (p === playerId) acc.fld.a += 1;
          for (const p of ev.errorOn ?? []) if (p === playerId) acc.fld.e += 1;
        }
        if (ln) { acc.fld.po += ln.po ?? 0; acc.fld.a += ln.a ?? 0; acc.fld.e += ln.e ?? 0; }
        if (myTeam && !acc.teamsMap.has(myTeam.id)) acc.teamsMap.set(myTeam.id, myTeam); // orden cronológico A→B→C
        // acumular en el stint de su equipo (si jugó en el juego)
        if (g.lineups.length || bat || pitFull || ln) {
          const st = stintOf(acc, myTeamId, myTeam?.shortName ?? myTeam?.name ?? '?', gYear);
          st.g += 1;
          if (bat) {
            st.bat.pa += bat.pa; st.bat.ab += bat.ab; st.bat.r += bat.r; st.bat.h += bat.h;
            st.bat.doubles += bat.doubles; st.bat.triples += bat.triples; st.bat.hr += bat.hr;
            st.bat.rbi += bat.rbi; st.bat.bb += bat.bb; st.bat.k += bat.k; st.bat.hbp += bat.hbp;
          }
          if (pitFull) {
            st.pit.gp += 1; st.pit.gs += pitFull.gs; st.pit.w += pitFull.w; st.pit.l += pitFull.l;
            st.pit.sv += pitFull.sv; st.pit.hld += pitFull.hld; st.pit.bs += pitFull.bs;
            st.pit.cg += pitFull.cg; st.pit.sho += pitFull.sho;
            st.pit.outs += pitFull.outs; st.pit.h += pitFull.h; st.pit.r += pitFull.r;
            st.pit.er += pitFull.er; st.pit.bb += pitFull.bb; st.pit.k += pitFull.k; st.pit.hr += pitFull.hr; st.pit.pitches += pitFull.pitches;
          }
          for (const ev of evs) {
            for (const p of ev.putouts ?? []) if (p === playerId) st.fld.po += 1;
            for (const p of ev.assists ?? []) if (p === playerId) st.fld.a += 1;
            for (const p of ev.errorOn ?? []) if (p === playerId) st.fld.e += 1;
          }
          if (ln) { st.fld.po += ln.po ?? 0; st.fld.a += ln.a ?? 0; st.fld.e += ln.e ?? 0; }
        }
        acc.log.push({
          gameId: g.id, date: g.date,
          team: myTeam?.shortName ?? myTeam?.name ?? null,
          vs: opp?.shortName ?? opp?.name ?? '?',
          batting: bat ?? null, pitching: pitFull ?? null,
        });
      };

      feed(g.seriesId ? postAcc : regAcc); // playoff separado
      if (!g.seriesId) {
        const y = new Date(g.date).getFullYear();
        let ya = yearAccs.get(y);
        if (!ya) { ya = mkAcc(); yearAccs.set(y, ya); }
        feed(ya);
      }
    }

    // Delta manual del acumulado (adj): se suma a los totales derivados de
    // juegos — REG va al acumulado del torneo y a su año en `byYear`; POST al
    // bloque de postemporada (que no se desglosa por año).
    const addSeasonAdj = (acc: Acc, a: Record<string, number>) => {
      acc.bat.g += a.g ?? 0; acc.bat.pa += a.pa ?? 0; acc.bat.ab += a.ab ?? 0; acc.bat.r += a.r ?? 0;
      acc.bat.h += a.h ?? 0; acc.bat.doubles += a.doubles ?? 0; acc.bat.triples += a.triples ?? 0;
      acc.bat.hr += a.hr ?? 0; acc.bat.rbi += a.rbi ?? 0; acc.bat.bb += a.bb ?? 0; acc.bat.k += a.k ?? 0;
      acc.bat.hbp += a.hbp ?? 0; acc.bat.sac += a.sac ?? 0; acc.bat.sf += a.sf ?? 0; acc.bat.sb += a.sb ?? 0;
      acc.pit.gp += a.gp ?? 0; acc.pit.gs += a.gs ?? 0; acc.pit.w += a.w ?? 0; acc.pit.l += a.l ?? 0;
      acc.pit.sv += a.sv ?? 0; acc.pit.hld += a.hld ?? 0; acc.pit.bs += a.bs ?? 0;
      acc.pit.cg += a.cg ?? 0; acc.pit.sho += a.sho ?? 0;
      acc.pit.outs += a.pOuts ?? 0; acc.pit.h += a.pH ?? 0; acc.pit.r += a.pR ?? 0;
      acc.pit.er += a.pER ?? 0; acc.pit.bb += a.pBB ?? 0; acc.pit.k += a.pK ?? 0;
      acc.pit.hr += a.pHR ?? 0; acc.pit.pitches += a.pPitches ?? 0;
      acc.fld.e += a.e ?? 0;
    };
    let postAdj = false;
    if (league.id === adjLeagueId) {
      for (const s of seasons) {
        const a = (s.adj ?? null) as Record<string, number> | null;
        if (!a || !Object.keys(a).length) continue;
        if (s.scope === 'POST') { addSeasonAdj(postAcc, a); postAdj = true; }
        else {
          addSeasonAdj(regAcc, a);
          const ya = yearAccs.get(s.season);
          if (ya) addSeasonAdj(ya, a);
        }
      }
    }

    const regInn = games[0]?.innings ?? 9;
    const finalize = (acc: Acc) => {
      const tb = acc.bat.h + acc.bat.doubles + 2 * acc.bat.triples + 3 * acc.bat.hr;
      const slg = acc.bat.ab ? tb / acc.bat.ab : 0;
      const obp = obpOf(acc.bat.h, acc.bat.bb, acc.bat.hbp, acc.bat.ab, acc.bat.sf);
      const ip = acc.pit.outs / 3;
      return {
        batting: { ...acc.bat, avg: avgOf(acc.bat.h, acc.bat.ab), obp, slg: f3(slg), ops: f3(obp + slg) },
        pitching: { ...acc.pit, era: Number((ip ? (acc.pit.er * regInn) / ip : 0).toFixed(2)), whip: Number((ip ? (acc.pit.bb + acc.pit.h) / ip : 0).toFixed(2)) },
        fielding: { ...acc.fld, tc: acc.fld.po + acc.fld.a + acc.fld.e, fpct: f3(acc.fld.po + acc.fld.a + acc.fld.e > 0 ? (acc.fld.po + acc.fld.a) / (acc.fld.po + acc.fld.a + acc.fld.e) : 1) },
        teams: [...acc.teamsMap.values()],
        stints: [...acc.stints.values()].map((st) => ({
          teamId: st.teamId, team: st.team, year: st.year, g: st.g,
          batting: { ...st.bat, avg: avgOf(st.bat.h, st.bat.ab), obp: obpOf(st.bat.h, st.bat.bb, st.bat.hbp, st.bat.ab, st.bat.sf) },
          pitching: { ...st.pit, era: Number((st.pit.outs ? (st.pit.er * regInn) / (st.pit.outs / 3) : 0).toFixed(2)) },
          fielding: { ...st.fld, tc: st.fld.po + st.fld.a + st.fld.e },
        })),
        log: acc.log,
      };
    };
    const regBlock = finalize(regAcc);
    tournaments.push({
      leagueId: league.id, league: league.name, year: league.year, sport: league.sport,
      ...regBlock,
      // desglose por año de fecha: la liga puede abarcar varias temporadas
      byYear: [...yearAccs.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([y, a]) => ({ year: y, ...finalize(a) })),
      playoff: (postAcc.log.length || postAdj) ? finalize(postAcc) : null,
    });
  }

  // equipos de cada año — derivados del desglose por año (byYear) y del log de playoffs
  const seasonsOut = seasons.map((s) => ({
    ...s,
    teams: [...new Set(
      tournaments.flatMap((t) => {
        const tt = t as {
          byYear?: { year: number; teams: { name: string }[] }[];
          playoff?: { log: { date: string; team: string | null }[] } | null;
        };
        if (s.scope === 'POST') {
          return (tt.playoff?.log ?? [])
            .filter((l) => new Date(l.date).getFullYear() === s.season)
            .map((l) => l.team).filter((x): x is string => !!x);
        }
        return (tt.byYear ?? []).filter((y) => y.year === s.season)
          .flatMap((y) => y.teams.map((x) => x.name));
      }),
    )],
  }));
  res.json({ player, tournaments, seasons: seasonsOut });
});

/**
 * Matchups del jugador (estilo BallStat):
 *  - vsPitchers: cómo batea contra cada lanzador que enfrentó
 *  - vsTeams: cómo batea contra cada equipo
 *  - pitchingVsBatters / pitchingVsTeams: cómo le va lanzando
 */
r.get('/players/:id/matchups', async (req, res) => {
  const playerId = req.params.id;
  const year = req.query.year ? Number(req.query.year) : null; // ?year=2025 → solo esa temporada

  const games = await prisma.game.findMany({
    where: {
      OR: [{ events: { some: { batterId: playerId } } }, { events: { some: { pitcherId: playerId } } }],
    },
    include: {
      homeTeam: { select: { id: true, name: true, shortName: true } },
      awayTeam: { select: { id: true, name: true, shortName: true } },
      events: { orderBy: { seq: 'asc' } },
    },
  });

  const vsPitcher = new Map<string, GameEvent[]>();
  const vsTeam = new Map<string, GameEvent[]>();
  const pitchVsBatter = new Map<string, GameEvent[]>();
  const pitchVsTeam = new Map<string, GameEvent[]>();
  const teamMeta = new Map<string, { name: string; shortName: string | null }>();

  for (const g of games) {
    if (year && new Date(g.date).getFullYear() !== year) continue;
    teamMeta.set(g.homeTeamId, g.homeTeam);
    teamMeta.set(g.awayTeamId, g.awayTeam);
    const evs = g.events.map(rowToEvent);
    for (const ev of evs) {
      if (isMidResult(ev.result)) continue;
      const fieldTeamId = ev.half === 'TOP' ? g.homeTeamId : g.awayTeamId;
      const batTeamId = ev.half === 'TOP' ? g.awayTeamId : g.homeTeamId;
      if (ev.batterId === playerId) {
        if (ev.pitcherId) {
          const arr = vsPitcher.get(ev.pitcherId) ?? [];
          arr.push(ev); vsPitcher.set(ev.pitcherId, arr);
        }
        const tarr = vsTeam.get(fieldTeamId) ?? [];
        tarr.push(ev); vsTeam.set(fieldTeamId, tarr);
      }
      if (ev.pitcherId === playerId && ev.batterId) {
        const barr = pitchVsBatter.get(ev.batterId) ?? [];
        barr.push(ev); pitchVsBatter.set(ev.batterId, barr);
        const tarr = pitchVsTeam.get(batTeamId) ?? [];
        tarr.push(ev); pitchVsTeam.set(batTeamId, tarr);
      }
    }
  }

  const players = await prisma.player.findMany({
    where: { id: { in: [...vsPitcher.keys(), ...pitchVsBatter.keys()] } },
  });
  const pName = new Map(players.map((p) => [p.id, `${p.number ? `#${p.number} ` : ''}${p.firstName} ${p.lastName}`]));
  const tName = (id: string) => teamMeta.get(id)?.shortName ?? teamMeta.get(id)?.name ?? '?';

  const fmtBat = (id: string, label: string, evs: GameEvent[]) => {
    const m = miniLine(evs);
    const tb = m.h + m.doubles + 2 * m.triples + 3 * m.hr;
    const slg = m.ab ? tb / m.ab : 0;
    return {
      id, name: label, ...m,
      avg: avgOf(m.h, m.ab), obp: obpOf(m.h, m.bb, m.hbp, m.ab, m.sf),
      slg: f3(slg), ops: f3(obpOf(m.h, m.bb, m.hbp, m.ab, m.sf) + slg),
    };
  };

  res.json({
    vsPitchers: [...vsPitcher.entries()].map(([pid, evs]) => fmtBat(pid, pName.get(pid) ?? '?', evs)).sort((a, b) => b.pa - a.pa),
    vsTeams: [...vsTeam.entries()].map(([tid, evs]) => fmtBat(tid, tName(tid), evs)).sort((a, b) => b.pa - a.pa),
    pitchingVsBatters: [...pitchVsBatter.entries()].map(([pid, evs]) => fmtBat(pid, pName.get(pid) ?? '?', evs)).sort((a, b) => b.pa - a.pa),
    pitchingVsTeams: [...pitchVsTeam.entries()].map(([tid, evs]) => fmtBat(tid, tName(tid), evs)).sort((a, b) => b.pa - a.pa),
  });
});

/**
 * Histórico entre dos equipos — estilo BallScore "Estadísticas históricas vs
 * oponente actual". Juegos FINAL entre a y b (en cualquier lado): serie W/L/E,
 * resultados y líneas individuales de bateo y pitcheo de cada equipo.
 */
r.get('/head2head', async (req, res) => {
  const a = String(req.query.a ?? '');
  const b = String(req.query.b ?? '');
  if (!a || !b || a === b) return res.status(400).json({ error: 'a y b requeridos (distintos)' });

  const games = await prisma.game.findMany({
    where: {
      status: 'FINAL',
      OR: [{ awayTeamId: a, homeTeamId: b }, { awayTeamId: b, homeTeamId: a }],
    },
    include: { events: { orderBy: { seq: 'asc' } } },
    orderBy: { date: 'asc' },
  });

  let w = 0, l = 0, t = 0;
  const gameRows: { id: string; date: Date; aScore: number; bScore: number }[] = [];
  const evsA = new Map<string, GameEvent[]>();
  const evsB = new Map<string, GameEvent[]>();
  const push = (m: Map<string, GameEvent[]>, pid: string, ev: GameEvent) => {
    const arr = m.get(pid) ?? []; arr.push(ev); m.set(pid, arr);
  };
  type PitAcc = { outs: number; h: number; r: number; er: number; bb: number; k: number; hr: number; pitches: number };
  const pitA = new Map<string, PitAcc>();
  const pitB = new Map<string, PitAcc>();
  const accPit = (m: Map<string, PitAcc>, pid: string, p: PitAcc) => {
    const cur = m.get(pid) ?? { outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0, pitches: 0 };
    for (const k of Object.keys(cur) as (keyof PitAcc)[]) cur[k] += p[k];
    m.set(pid, cur);
  };

  for (const g of games) {
    const evs = g.events.map(rowToEvent);
    const st = reduceGame(evs, g.innings);
    const sa = g.fScoreAway ?? st.score.away;
    const sh = g.fScoreHome ?? st.score.home;
    const aScore = g.awayTeamId === a ? sa : sh;
    const bScore = g.awayTeamId === a ? sh : sa;
    if (aScore > bScore) w += 1; else if (aScore < bScore) l += 1; else t += 1;
    gameRows.push({ id: g.id, date: g.date, aScore, bScore });

    // boxscore del juego: pitcheo por pitcher (se agrupa según a qué equipo defendía)
    const box = computeBoxscore(evs, g.innings);
    const pitBucket = new Map<string, 'a' | 'b'>();
    for (const ev of evs) {
      if (isMidResult(ev.result)) continue;
      const batTeam = ev.half === 'TOP' ? g.awayTeamId : g.homeTeamId;
      const fldTeam = ev.half === 'TOP' ? g.homeTeamId : g.awayTeamId;
      if (ev.batterId) push(batTeam === a ? evsA : evsB, ev.batterId, ev);
      if (ev.pitcherId && !pitBucket.has(ev.pitcherId)) {
        pitBucket.set(ev.pitcherId, fldTeam === a ? 'a' : 'b');
      }
    }
    for (const p of Object.values(box.pitchers)) {
      accPit(pitBucket.get(p.playerId) === 'a' ? pitA : pitB, p.playerId, p);
    }
  }

  const ids = [...new Set([...evsA.keys(), ...evsB.keys(), ...pitA.keys(), ...pitB.keys()])];
  const players = await prisma.player.findMany({ where: { id: { in: ids } } });
  const pName = new Map(players.map((p) => [p.id, `${p.number ? `#${p.number} ` : ''}${p.firstName} ${p.lastName}`]));
  const fmtBat = (id: string, evs: GameEvent[]) => {
    const m = miniLine(evs);
    const tb = m.h + m.doubles + 2 * m.triples + 3 * m.hr;
    const slg = m.ab ? tb / m.ab : 0;
    return {
      id, name: pName.get(id) ?? '?', ...m,
      avg: avgOf(m.h, m.ab), obp: obpOf(m.h, m.bb, m.hbp, m.ab, m.sf),
      slg: f3(slg), ops: f3(obpOf(m.h, m.bb, m.hbp, m.ab, m.sf) + slg),
    };
  };
  const fmtPit = ([id, p]: [string, PitAcc]) => ({ playerId: id, name: pName.get(id) ?? '?', ...p });

  res.json({
    record: { w, l, t },
    games: gameRows,
    battingA: [...evsA.entries()].map(([id, e]) => fmtBat(id, e)).sort((x, y) => y.pa - x.pa),
    battingB: [...evsB.entries()].map(([id, e]) => fmtBat(id, e)).sort((x, y) => y.pa - x.pa),
    pitchingA: [...pitA.entries()].map(fmtPit).sort((x, y) => y.outs - x.outs),
    pitchingB: [...pitB.entries()].map(fmtPit).sort((x, y) => y.outs - x.outs),
  });
});

/**
 * Splits individuales: línea por mes, últimos 4/6/10 juegos y rachas
 * (juegos con hit / embasándose / ponchándose / sequía) — estilo BallStat.
 */
r.get('/players/:id/splits', async (req, res) => {
  const pid = req.params.id;
  const year = req.query.year ? Number(req.query.year) : null; // ?year=2025 → períodos dentro de esa temporada
  const all = await prisma.game.findMany({
    where: { status: 'FINAL', seriesId: null, lineups: { some: { playerId: pid } } },
    orderBy: { date: 'asc' },
    include: GAME_STATS_INCLUDE,
  });
  const games = year ? all.filter((g) => new Date(g.date).getFullYear() === year) : all;
  type Stats = Awaited<ReturnType<typeof aggregateGames>>;
  const pick = (s: Stats) => ({
    games: s.games,
    batting: s.batting.find((b) => b.playerId === pid) ?? null,
    pitching: s.pitching.find((p) => p.playerId === pid) ?? null,
    fielding: s.fielding.find((f) => f.playerId === pid) ?? null,
  });

  const byMonthGames = new Map<string, typeof games>();
  for (const g of games) {
    const key = new Date(g.date).toISOString().slice(0, 7);
    if (!byMonthGames.has(key)) byMonthGames.set(key, []);
    byMonthGames.get(key)!.push(g);
  }
  const byMonth = await Promise.all([...byMonthGames.entries()].map(async ([month, gs]) => ({
    month, ...pick(await aggregateGames(gs, [])),
  })));
  const lastN = await Promise.all([4, 6, 10].map(async (n) => ({
    n, ...pick(await aggregateGames(games.slice(-n), [])),
  })));

  // rachas del jugador (replay por juego en orden de fecha)
  const streaks = { hitCur: 0, hitBest: 0, obCur: 0, obBest: 0, kCur: 0, kBest: 0, droughtCur: 0, droughtBest: 0 };
  for (const g of games) {
    const box = computeBoxscore(await loadEvents(g.id), g.innings);
    const line = box.away[pid] ?? box.home[pid];
    if (!line || line.pa === 0) continue;
    const hit = line.h > 0, onBase = line.h + line.bb + line.hbp > 0, whiffed = line.k > 0, dry = line.ab > 0 && line.h === 0;
    streaks.hitCur = hit ? streaks.hitCur + 1 : 0; streaks.hitBest = Math.max(streaks.hitBest, streaks.hitCur);
    streaks.obCur = onBase ? streaks.obCur + 1 : 0; streaks.obBest = Math.max(streaks.obBest, streaks.obCur);
    streaks.kCur = whiffed ? streaks.kCur + 1 : 0; streaks.kBest = Math.max(streaks.kBest, streaks.kCur);
    streaks.droughtCur = dry ? streaks.droughtCur + 1 : 0; streaks.droughtBest = Math.max(streaks.droughtBest, streaks.droughtCur);
  }

  res.json({ byMonth, lastN, streaks });
});

/**
 * Enfrentamiento bateador-vs-lanzador (consulta rápida en la anotación):
 * línea agregada histórica de `a` bateando contra `b` + últimos 3 turnos
 * entre ellos (resultado y fecha), en juegos FINAL.
 */
r.get('/matchup', async (req, res) => {
  const a = String(req.query.a ?? ''); // bateador
  const b = String(req.query.b ?? ''); // lanzador
  if (!a || !b) return res.status(400).json({ error: 'a (bateador) y b (lanzador) requeridos' });

  const games = await prisma.game.findMany({
    where: { status: 'FINAL', events: { some: { batterId: a, pitcherId: b } } },
    orderBy: { date: 'asc' },
    include: { events: { orderBy: { seq: 'asc' } } },
  });
  const evs: (GameEvent & { gameId: string; date: Date })[] = [];
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
    avg: avgOf(m.h, m.ab), obp, slg: f3(slg), ops: f3(obp + slg),
    games: games.length,
    last3: evs.slice(-3).reverse().map((e) => ({
      gameId: e.gameId, date: e.date, inning: e.inning,
      result: e.result, notation: e.notation,
      runs: e.advances.filter((x) => x.to === 'HOME').length,
    })),
  });
});

/**
 * GET /players/:id/situational?year=&scope=REG|POST — splits situacionales
 * estilo MLB de UNA temporada: bases vacías/corredores/RISP/llenas/3ª ocupada,
 * por outs (0/1/2 + RISP-2outs), abriendo la entrada, por puesto del orden,
 * vs LHP/RHP (mano del lanzador) y casa/visita — para bateo Y pitcheo (lo que
 * el lanzador permite en esas mismas situaciones). Alimenta la Consulta de
 * ScorePage: el front resalta las filas que aplican a la situación en curso.
 */
r.get('/players/:id/situational', async (req, res) => {
  const pid = req.params.id;
  const year = Number(req.query.year) || undefined;
  const scope = req.query.scope === 'POST' ? 'POST' : 'REG';

  const touched = await prisma.gameEvent.findMany({
    where: { OR: [{ batterId: pid }, { pitcherId: pid }] },
    select: { gameId: true }, distinct: ['gameId'],
  });
  const games = await prisma.game.findMany({
    where: {
      id: { in: touched.map((t) => t.gameId) },
      status: 'FINAL',
      ...(scope === 'POST' ? { seriesId: { not: null } } : { seriesId: null }),
    },
    include: {
      season: true,
      lineups: { include: { player: { select: { bats: true, throws: true } } } },
    },
    orderBy: { date: 'asc' },
  });
  const ofYear = year
    ? games.filter((g) => (g.season?.year ?? new Date(g.date).getFullYear()) === year)
    : games;

  // manos de bate/lanzamiento de TODOS los jugadores (un pitcher entrado por PC
  // sin fila de lineup no está en `lineups` — consulta directa al roster)
  const ids = new Set<string>();
  for (const g of ofYear) for (const l of g.lineups) ids.add(l.playerId);
  const hands = new Map<string, { bats: string | null; throws: string | null }>();
  const players = await prisma.player.findMany({
    select: { id: true, bats: true, throws: true },
  });
  for (const p of players) hands.set(p.id, { bats: p.bats, throws: p.throws });

  interface SL { pa: number; ab: number; r: number; h: number; d2: number; d3: number; hr: number; rbi: number; bb: number; k: number; hbp: number; sf: number; }
  interface PL { bf: number; outs: number; ab: number; h: number; hr: number; bb: number; k: number; r: number; er: number; erW: number; dp: number; }
  const bat: Record<string, SL> = {};
  const pit: Record<string, PL> = {};
  const sb = (): SL => ({ pa: 0, ab: 0, r: 0, h: 0, d2: 0, d3: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sf: 0 });
  const sp = (): PL => ({ bf: 0, outs: 0, ab: 0, h: 0, hr: 0, bb: 0, k: 0, r: 0, er: 0, erW: 0, dp: 0 });
  const B = (k: string) => (bat[k] ??= sb());
  const P = (k: string) => (pit[k] ??= sp());
  const UNER = new Set(['E', 'CI', 'GR', 'ADJ', 'INT', 'OBS', 'KPB']);

  for (const g of ofYear) {
    const evs = await loadEvents(g.id);
    const orderOf = new Map(
      g.lineups.filter((l) => l.batsInOrder !== false && l.order < 50).map((l) => [l.playerId, l.order]),
    );
    let st = initialState();
    let paInHalf = 0, curHalf: string | null = null;
    const reach = new Map<string, { res: string; pitcherId: string | null }>();

    for (const ev of evs) {
      if (ev.half !== curHalf) { curHalf = ev.half; paInHalf = 0; }
      const mid = isMidResult(ev.result) && ev.result !== 'SK';
      if (!mid && ev.batterId) {
        const r1 = !!st.bases[1], r2 = !!st.bases[2], r3 = !!st.bases[3];
        const anyOn = r1 || r2 || r3, risp = r2 || r3, loaded = r1 && r2 && r3;
        const keys: string[] = [anyOn ? 'menOn' : 'empty'];
        if (risp) keys.push('risp');
        if (loaded) keys.push('loaded');
        if (r3) keys.push('r3');
        keys.push(`outs${st.outs}`);
        if (risp && st.outs === 2) keys.push('risp2out');
        if (paInHalf === 0) keys.push('leadoff');
        const ord = orderOf.get(ev.batterId);
        if (ord) keys.push(`order${ord}`);
        // bateo: mano del lanzador. Pitcheo: lado efectivo del bateador
        // (switch = contrario a la mano del pitcher cuando se conoce)
        const pThrows = ev.pitcherId ? hands.get(ev.pitcherId)?.throws : undefined;
        const bBats = hands.get(ev.batterId)?.bats;
        if (pThrows === 'L') keys.push('vsLHP'); else if (pThrows) keys.push('vsRHP');
        const effSide = bBats === 'S'
          ? (pThrows === 'L' ? 'R' : pThrows ? 'L' : null)
          : bBats;
        if (effSide === 'L') keys.push('vsLHB'); else if (effSide === 'R') keys.push('vsRHB');
        keys.push(ev.half === 'TOP' ? 'away' : 'home');
        keys.push('all');

        const isB = ev.batterId === pid, isP = ev.pitcherId === pid;
        if (isB || isP) {
          const runs = ev.advances.filter((a) => a.to === 'HOME').length;
          const rr = ev.result;
          const outs = ev.advances.filter((a) => a.to === 'OUT').length;
          for (const k of keys) {
            if (isB) {
              const l = B(k);
              l.pa += 1;
              if (HIT_SET.has(rr)) {
                l.h += 1; l.ab += 1;
                if (rr === '2B' || rr === '2BE') l.d2 += 1;
                if (rr === '3B' || rr === '3BE') l.d3 += 1;
                if (rr === 'HR' || rr === 'HRIP') l.hr += 1;
              } else if (rr === 'BB' || rr === 'IBB') l.bb += 1;
              else if (rr === 'HBP') l.hbp += 1;
              else if (rr === 'SF') l.sf += 1;
              else if (rr === 'SAC' || rr === 'CI' || rr === 'OOT') { /* sin AB ni PA */ }
              else { l.ab += 1; if (rr === 'K' || rr === 'KWP' || rr === 'KPB') l.k += 1; }
              if (ev.advances.some((a) => a.playerId === ev.batterId && a.to === 'HOME')) l.r += 1;
              if (!['E', 'DP', 'TP', 'KWP', 'KPB'].includes(rr)) l.rbi += runs;
            }
            if (isP) {
              const l = P(k);
              if (!['CI', 'OOT'].includes(rr)) {
                l.bf += 1;
                if (!['BB', 'IBB', 'HBP', 'SAC', 'SF'].includes(rr)) l.ab += 1;
              }
              l.outs += outs;
              if (HIT_SET.has(rr)) l.h += 1;
              if (rr === 'HR' || rr === 'HRIP') l.hr += 1;
              if (rr === 'DP' || rr === 'TP') l.dp += 1;
              if (rr === 'BB' || rr === 'IBB') l.bb += 1;
              if (rr === 'K' || rr === 'KWP' || rr === 'KPB') l.k += 1;
              const playHadError = ev.result === 'E' || !!ev.errorOn?.length
                || ['1BE', '2BE', '3BE', 'PB', 'BK', 'IPL', 'DE'].includes(rr)
                || /E-?\d/.test(ev.notation ?? '');
              for (const a of ev.advances) {
                if (a.to !== 'HOME') continue;
                const chargeTo = reach.get(a.playerId)?.pitcherId ?? ev.pitcherId;
                if (chargeTo !== pid) continue;
                l.r += 1;
                if (!playHadError && !UNER.has(reach.get(a.playerId)?.res ?? '')) { l.er += 1; l.erW += g.innings; }
              }
            }
          }
        }
        paInHalf += 1;
      }
      // reach + estado (mismo esquema que computeBoxscore)
      if (ev.batterId && ev.advances.some((a) => a.playerId === ev.batterId && a.to !== 'OUT' && a.to !== 'HOME')) {
        const errReach = !!ev.errorOn?.length || ['E', 'CI', 'INT', 'OBS', 'KPB'].includes(ev.result)
          || (ev.result === 'FC' && !!ev.errorOn?.length);
        reach.set(ev.batterId, { res: errReach ? 'E' : ev.result, pitcherId: ev.pitcherId });
      }
      // corredor que avanza POR ERROR → res='E' (inmerecida si anota). Mid de
      // error → todo avance cuenta; jugada de turno → solo el que fue más allá
      // de lo natural (defaultAdvances) — el forzado/normal queda limpio
      const hadErr = ev.result === 'E' || !!ev.errorOn?.length
        || ['1BE', '2BE', '3BE', 'PB', 'BK', 'IPL', 'DE', 'CI', 'INT', 'OBS'].includes(ev.result)
        || /E-?\d/.test(ev.notation ?? '');
      if (hadErr) {
        const midErr = isMidResult(ev.result);
        const defs = midErr || !ev.batterId ? null : defaultAdvances(st, ev.batterId, ev.result as PAResult);
        for (const a of ev.advances) {
          if (a.to === 'OUT' || a.to === 'HOME' || a.playerId === ev.batterId) continue;
          if (!midErr && typeof a.to === 'number') {
            const nat = defs?.find((d) => d.playerId === a.playerId)?.to;
            if (typeof nat === 'number' && a.to <= nat) continue;
          }
          const prev = reach.get(a.playerId);
          reach.set(a.playerId, { res: 'E', pitcherId: prev?.pitcherId ?? ev.pitcherId });
        }
      }
      if (ev.result === 'GR' || ev.result === 'ADJ') {
        for (const a of ev.advances) {
          if (a.to !== 'OUT' && a.to !== 'HOME') reach.set(a.playerId, { res: ev.result, pitcherId: ev.result === 'GR' ? ev.pitcherId : null });
        }
      }
      st = applyEvent(st, ev, g.innings);
      const onBase = new Set([st.bases[1], st.bases[2], st.bases[3]].filter(Boolean) as string[]);
      for (const p of [...reach.keys()]) if (!onBase.has(p)) reach.delete(p);
    }
  }

  const fin = (l: SL) => {
    const tb = l.h + l.d2 + 2 * l.d3 + 3 * l.hr;
    const obpD = l.ab + l.bb + l.hbp + l.sf;
    return {
      ...l,
      avg: l.ab ? l.h / l.ab : 0,
      obp: obpD ? (l.h + l.bb + l.hbp) / obpD : 0,
      slg: l.ab ? tb / l.ab : 0,
      ops: 0,
    };
  };
  const finB = (l: SL) => { const o = fin(l); o.ops = o.obp + o.slg; return o; };
  const finP = (l: PL) => ({
    ...l,
    baa: l.ab ? l.h / l.ab : 0,
    // erW = CL ponderada por las entradas del juego → ERA correcta en softball
    era: l.outs ? (l.erW * 3) / l.outs : 0,
    whip: l.outs ? ((l.bb + l.h) * 3) / l.outs : 0,
  });
  res.json({
    season: year ?? null, scope,
    games: ofYear.length,
    batting: Object.fromEntries(Object.entries(bat).map(([k, v]) => [k, finB(v)])),
    pitching: Object.fromEntries(Object.entries(pit).map(([k, v]) => [k, finP(v)])),
  });
});

/** GET /player-list — lista ligera de jugadores para selectores del generador de reportes */
r.get('/player-list', async (_req, res) => {
  const players = await prisma.player.findMany({
    select: { id: true, firstName: true, lastName: true, number: true, active: true, teamId: true, team: { select: { name: true, shortName: true, leagueId: true, league: { select: { name: true } } } } },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
  });
  res.json(players.map((p) => ({
    id: p.id,
    label: `${p.number ? `#${p.number} ` : ''}${p.lastName}${p.firstName && p.firstName !== '·' && p.firstName !== '—' ? `, ${p.firstName}` : ''}`,
    active: p.active,
    team: p.team?.shortName ?? p.team?.name ?? '',
    teamId: p.teamId ?? '',
    leagueId: p.team?.leagueId ?? '',
    league: p.team?.league?.name ?? '',
  })));
});

// ----------------- Generador de reportes -----------------

interface ReportFilters {
  leagueId?: string; teamId?: string; vsTeamId?: string;
  playerId?: string; pitcherId?: string; order?: number;
  results?: string[]; half?: 'TOP' | 'BOTTOM';
  inningFrom?: number; inningTo?: number;
  dateFrom?: string; dateTo?: string;
  post?: boolean; // true = solo playoffs, false = solo regular
  bases?: 'empty' | 'any' | 'risp' | 'loaded';
  twoOuts?: boolean;
  homeAway?: 'home' | 'away'; // equipo del bateador: local/visitante
}
type GroupBy = 'player' | 'order' | 'inning' | 'month' | 'game' | 'vs' | 'counterpart' | 'season' | 'venue';

interface BatAcc { pa: number; ab: number; r: number; h: number; d2: number; d3: number; hr: number; rbi: number; bb: number; k: number; hbp: number; sac: number; sf: number; sb: number; }
interface PitAcc { outs: number; h: number; r: number; er: number; erW: number; bb: number; k: number; hr: number; pitches: number; bf: number; aba: number; }
interface FldAcc { po: number; a: number; e: number; }
const newBat = (): BatAcc => ({ pa: 0, ab: 0, r: 0, h: 0, d2: 0, d3: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sac: 0, sf: 0, sb: 0 });
// erW = CL ponderada por las entradas del juego → ERA correcta en softball (6-7 inn), idéntica en baseball
const newPit = (): PitAcc => ({ outs: 0, h: 0, r: 0, er: 0, erW: 0, bb: 0, k: 0, hr: 0, pitches: 0, bf: 0, aba: 0 });
const newFld = (): FldAcc => ({ po: 0, a: 0, e: 0 });
const NO_RBI_R = new Set(['E', 'DP', 'TP', 'KWP', 'KPB']);
const UNER_REACH = new Set(['E', 'CI', 'GR', 'ADJ']);

/**
 * POST /report — reporte libre sobre el stream de eventos.
 * dataset: batting|pitching|plays|games; filters; groupBy.
 * "Manuel bateando 4to" = { dataset:'batting', filters:{playerId, order:4} }
 */
r.post('/report', async (req, res) => {
  const dataset: string = req.body.dataset ?? 'batting';
  const f: ReportFilters = req.body.filters ?? {};
  const groupBy: GroupBy = req.body.groupBy ?? 'player';

  // equipos se clonan por temporada (mismo nombre, otro id) → el filtro por equipo
  // expande a todos los clones con el mismo nombre para que el historial sea completo
  const expandTeam = async (tid?: string) => {
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
      status: 'FINAL',
      ...(f.leagueId ? { leagueId: f.leagueId } : {}),
      ...(teamSet ? { OR: [{ awayTeamId: { in: teamSet } }, { homeTeamId: { in: teamSet } }] } : {}),
      ...(vsSet ? { AND: [{ OR: [{ awayTeamId: { in: vsSet } }, { homeTeamId: { in: vsSet } }] }] } : {}),
      ...(f.post === true ? { seriesId: { not: null } } : f.post === false ? { seriesId: null } : {}),
      ...(f.dateFrom || f.dateTo ? { date: { ...(f.dateFrom ? { gte: new Date(`${f.dateFrom}T00:00:00`) } : {}), ...(f.dateTo ? { lte: new Date(`${f.dateTo}T23:59:59`) } : {}) } } : {}),
    },
    select: {
      id: true, date: true, innings: true, awayTeamId: true, homeTeamId: true,
      fScoreAway: true, fScoreHome: true, statLines: true,
      awayTeam: { select: { name: true, shortName: true } }, homeTeam: { select: { name: true, shortName: true } },
      league: { select: { name: true, year: true } },
    },
    orderBy: { date: 'asc' },
  });

  if (dataset === 'games') {
    // marcador final por juego (replay rápido solo del score: suma de carreras por evento)
    const rows = [];
    for (const g of games) {
      const evs = await loadEvents(g.id);
      let ra = 0, rh = 0;
      for (const ev of evs) {
        const runs = ev.advances.filter((a) => a.to === 'HOME').length;
        if (ev.half === 'TOP') ra += runs; else rh += runs;
      }
      // juegos importados sin eventos: el marcador oficial viene de fScore
      const score = g.fScoreAway != null && g.fScoreHome != null ? `${g.fScoreAway}-${g.fScoreHome}` : `${ra}-${rh}`;
      rows.push({
        gameId: g.id, date: g.date, league: g.league ? (String(g.league.year) && g.league.name.includes(String(g.league.year)) ? g.league.name : `${g.league.name} ${g.league.year}`) : '',
        away: g.awayTeam.shortName ?? g.awayTeam.name, home: g.homeTeam.shortName ?? g.homeTeam.name,
        awayTeamId: g.awayTeamId, homeTeamId: g.homeTeamId,
        score,
      });
    }
    return res.json({ dataset, games: rows });
  }

  if (dataset === 'innings') {
    // carreras por entrada por equipo — matriz equipo × entrada (los errores no cuentan)
    const innMap = new Map<string, { teamId: string; team: string; byInning: Map<number, number> }>();
    let maxInn = 0;
    for (const g of games) {
      const evs = await loadEvents(g.id);
      if (!evs.length) continue; // importados sin eventos: no hay carreras por entrada
      const per: Record<'away' | 'home', Map<number, number>> = { away: new Map(), home: new Map() };
      for (const ev of evs) {
        const runs = ev.advances.filter((a) => a.to === 'HOME').length;
        if (!runs) continue;
        const m = per[ev.half === 'TOP' ? 'away' : 'home'];
        m.set(ev.inning, (m.get(ev.inning) ?? 0) + runs);
        if (ev.inning > maxInn) maxInn = ev.inning;
      }
      for (const side of ['away', 'home'] as const) {
        const tid = side === 'away' ? g.awayTeamId : g.homeTeamId;
        if (teamSet && !teamSet.includes(tid)) continue;
        const tname = side === 'away' ? (g.awayTeam.shortName ?? g.awayTeam.name) : (g.homeTeam.shortName ?? g.homeTeam.name);
        // clave por NOMBRE: fusiona los clones del mismo equipo entre temporadas
        if (!innMap.has(tname)) innMap.set(tname, { teamId: tid, team: tname, byInning: new Map() });
        const acc = innMap.get(tname)!;
        for (const [inn, r] of per[side]) acc.byInning.set(inn, (acc.byInning.get(inn) ?? 0) + r);
      }
    }
    const rows = [...innMap.values()].map((t) => ({
      ...t,
      innings: Array.from({ length: maxInn }, (_, i) => t.byInning.get(i + 1) ?? 0),
      total: [...t.byInning.values()].reduce((a, b) => a + b, 0),
    })).sort((a, b) => b.total - a.total);
    return res.json({ dataset, innings: { maxInn, rows }, gamesCount: games.length });
  }

  interface Bucket { label: string; bat: Map<string, BatAcc>; pit: Map<string, PitAcc>; fld: Map<string, FldAcc>; }
  const buckets = new Map<string, Bucket>();
  const bucketOf = (key: string, label: string) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { label, bat: new Map(), pit: new Map(), fld: new Map() }));
    return b;
  };
  const batAccOf = (b: Bucket, pid: string) => { let l = b.bat.get(pid); if (!l) b.bat.set(pid, (l = newBat())); return l; };
  const pitAccOf = (b: Bucket, pid: string) => { let l = b.pit.get(pid); if (!l) b.pit.set(pid, (l = newPit())); return l; };
  const fldAccOf = (b: Bucket, pid: string) => { let l = b.fld.get(pid); if (!l) b.fld.set(pid, (l = newFld())); return l; };

  const plays: Record<string, unknown>[] = [];
  const PLAYS_CAP = 800;

  for (const g of games) {
    const evs = await loadEvents(g.id);
    const lus = await prisma.lineupEntry.findMany({
      where: { gameId: g.id, order: { lt: 50 } }, select: { playerId: true, order: true },
    });
    const orderOf = new Map(lus.map((l) => [l.playerId, l.order]));
    const batTeam = (half: string) => (half === 'TOP' ? g.awayTeamId : g.homeTeamId);
    const fieldTeam = (half: string) => (half === 'TOP' ? g.homeTeamId : g.awayTeamId);
    const tName = (tid: string) => (tid === g.awayTeamId ? g.awayTeam.shortName ?? g.awayTeam.name : g.homeTeam.shortName ?? g.homeTeam.name);
    const gameLabel = `${tName(g.awayTeamId)} @ ${tName(g.homeTeamId)} ${String(g.date).slice(0, 10)}`;

    let st = initialState();
    const reach = new Map<string, { res: string; pitcherId: string | null }>();

    const keyOf = (ev: GameEvent, role: 'bat' | 'pit', pid?: string | null): { key: string; label: string } => {
      switch (groupBy) {
        case 'inning': return { key: `I${ev.inning}`, label: `Entrada ${ev.inning}` };
        case 'month': return { key: `M${String(g.date).slice(0, 7)}`, label: String(g.date).slice(0, 7) };
        case 'game': return { key: `G${g.id}`, label: gameLabel };
        case 'order': { const o = orderOf.get(pid ?? ev.batterId ?? '') ?? 0; return { key: `O${o}`, label: `Turno ${o || '?'}` }; }
        case 'season': { const y = g.league?.year ?? String(g.date).slice(0, 4); return { key: `Y${y}`, label: `Temporada ${y}` }; }
        case 'venue': { const mine = (role === 'bat' ? batTeam(ev.half) : fieldTeam(ev.half)); return mine === g.homeTeamId ? { key: 'H', label: 'En casa' } : { key: 'A', label: 'De visita' }; }
        case 'vs': { const n = role === 'bat' ? tName(fieldTeam(ev.half)) : tName(batTeam(ev.half)); return { key: `V${n}`, label: `vs ${n}` }; }
        case 'counterpart': { const p = role === 'bat' ? ev.pitcherId : ev.batterId; return { key: `P${p}`, label: `P:${p}` }; }
        default: return { key: `P${pid ?? (role === 'pit' ? ev.pitcherId : ev.batterId)}`, label: `P:${pid ?? ev.batterId}` };
      }
    };

    const pass = (ev: GameEvent, before: typeof st): boolean => {
      if (f.half && ev.half !== f.half) return false;
      if (f.inningFrom && ev.inning < f.inningFrom) return false;
      if (f.inningTo && ev.inning > f.inningTo) return false;
      if (f.results?.length && !f.results.includes(ev.result)) return false;
      if (f.order && orderOf.get(ev.batterId ?? '') !== f.order) return false;
      if (f.homeAway && (ev.half === 'TOP' ? 'away' : 'home') !== f.homeAway) return false;
      if (vsSet) {
        // para bateo el rival es quien defiende; para pitcheo/fildeo quien batea
        const opp = dataset === 'pitching' ? batTeam(ev.half) : fieldTeam(ev.half);
        if (!vsSet.includes(opp)) return false;
      }
      if (f.bases || f.twoOuts) {
        const r1 = !!before.bases[1], r2 = !!before.bases[2], r3 = !!before.bases[3];
        if (f.twoOuts && before.outs !== 2) return false;
        if (f.bases === 'empty' && (r1 || r2 || r3)) return false;
        if (f.bases === 'any' && !(r1 || r2 || r3)) return false;
        if (f.bases === 'risp' && !(r2 || r3)) return false;
        if (f.bases === 'loaded' && !(r1 && r2 && r3)) return false;
      }
      return true;
    };

    for (const ev of evs) {
      const before = st;
      const battersInvolved = new Set<string>();
      if (ev.batterId) battersInvolved.add(ev.batterId);
      for (const a of ev.advances) battersInvolved.add(a.playerId);

      // ---- filtros de actor principal ----
      const fielders = dataset === 'fielding'
        ? new Set([...(ev.putouts ?? []), ...(ev.assists ?? []), ...(ev.errorOn ?? [])])
        : null;
      const subjectOk = dataset === 'pitching'
        ? (!f.playerId || ev.pitcherId === f.playerId) && (!f.pitcherId || ev.batterId === f.pitcherId)
        : dataset === 'fielding'
          ? !f.playerId || fielders!.has(f.playerId)
          : (!f.playerId || battersInvolved.has(f.playerId)) && (!f.pitcherId || ev.pitcherId === f.pitcherId);

      // equipo del SUJETO: bateo/plays = el que batea esa mitad; pitcheo/fildeo = el que defiende
      const teamOk = !teamSet || (dataset === 'pitching' || dataset === 'fielding'
        ? teamSet.includes(fieldTeam(ev.half))
        : teamSet.includes(batTeam(ev.half)));

      if (subjectOk && teamOk && pass(ev, before)) {
        if (dataset === 'plays') {
          if (plays.length < PLAYS_CAP) {
            const occ = [before.bases[1], before.bases[2], before.bases[3]].map((x) => (x ? '◆' : '◇')).join('');
            plays.push({
              gameId: g.id, game: gameLabel, date: g.date, seq: ev.seq,
              inning: ev.inning, half: ev.half, outs0: before.outs, bases0: occ,
              batterId: ev.batterId, pitcherId: ev.pitcherId, order: orderOf.get(ev.batterId ?? '') ?? null,
              result: ev.result, notation: ev.notation,
              runs: ev.advances.filter((a) => a.to === 'HOME').length,
              outs: ev.advances.filter((a) => a.to === 'OUT').length,
            });
          }
        } else if (dataset === 'batting') {
          // con playerId solo se acredita la PA si ES el bateador (los eventos donde era
          // corredor pasan el filtro pero solo alimentan sus robos/carreras)
          if (!isMidResult(ev.result) && ev.batterId && (!f.playerId || ev.batterId === f.playerId)) {
            const { key, label } = keyOf(ev, 'bat');
            const l = batAccOf(bucketOf(key, label), ev.batterId);
            const rr = ev.result;
            l.pa += 1;
            if (HIT_SET.has(rr)) {
              l.h += 1; l.ab += 1;
              if (rr === '2B' || rr === '2BE') l.d2 += 1;
              if (rr === '3B' || rr === '3BE') l.d3 += 1;
              if (rr === 'HR' || rr === 'HRIP') l.hr += 1;
            } else if (rr === 'BB' || rr === 'IBB') l.bb += 1;
            else if (rr === 'HBP') l.hbp += 1;
            else if (rr === 'SF') l.sf += 1;
            else if (rr === 'SAC') l.sac += 1;
            else if (rr === 'CI' || rr === 'OOT') l.pa -= 1; // sin turno oficial
            else { l.ab += 1; if (rr === 'K' || rr === 'KWP' || rr === 'KPB') l.k += 1; }
            for (const a of ev.advances) {
              if (a.to !== 'HOME') continue;
              if (a.playerId === ev.batterId) l.r += 1;
              else {
                // carrera del corredor: a SU línea en el bucket de su grupo
                const rk = groupBy === 'player' ? keyOf(ev, 'bat', a.playerId) : { key, label };
                batAccOf(bucketOf(rk.key, rk.label), a.playerId).r += 1;
              }
              if (!NO_RBI_R.has(rr)) l.rbi += 1;
            }
          } else {
            // mids: robos se acreditan al corredor; RBI +/- ajusta al bateador del turno
            if (ev.result === 'SB') {
              for (const a of ev.advances) {
                if (a.to === 'OUT' || (f.playerId && a.playerId !== f.playerId)) continue;
                const { key, label } = keyOf(ev, 'bat', groupBy === 'player' ? a.playerId : ev.batterId);
                batAccOf(bucketOf(key, label), a.playerId).sb += 1;
              }
            }
            if (ev.result === 'RBI' && ev.batterId && (!f.playerId || ev.batterId === f.playerId)) {
              const { key, label } = keyOf(ev, 'bat');
              const l = batAccOf(bucketOf(key, label), ev.batterId);
              l.rbi = Math.max(0, l.rbi + (ev.notation === '-' ? -1 : 1));
            }
          }
        } else if (dataset === 'fielding') {
          // PO/A/E por jugador desde los créditos sellados en el evento
          for (const [arr, fl] of [[ev.putouts, 'po'], [ev.assists, 'a'], [ev.errorOn, 'e']] as const) {
            for (const pid of arr ?? []) {
              if (f.playerId && pid !== f.playerId) continue;
              const { key, label } = keyOf(ev, 'bat', pid);
              fldAccOf(bucketOf(key, label), pid)[fl] += 1;
            }
          }
        } else if (dataset === 'pitching' && ev.pitcherId) {
          // stats por lanzador: outs/h/bb/k/hr/pitcheos de la jugada; carreras al que embasó al corredor
          const { key, label } = keyOf(ev, 'pit');
          const l = pitAccOf(bucketOf(key, label), ev.pitcherId);
          const outsOnPlay = ev.advances.filter((a) => a.to === 'OUT').length;
          // bateadores enfrentados + AB del rival (para BAA)
          if (!isMidResult(ev.result) && !['CI', 'OOT'].includes(ev.result)) {
            l.bf += 1;
            if (!['BB', 'IBB', 'HBP', 'SAC', 'SF'].includes(ev.result)) l.aba += 1;
          }
          l.outs += outsOnPlay;
          if (HIT_SET.has(ev.result)) l.h += 1;
          if (ev.result === 'HR' || ev.result === 'HRIP') l.hr += 1;
          if (ev.result === 'BB' || ev.result === 'IBB') l.bb += 1;
          if (ev.result === 'K' || ev.result === 'KWP' || ev.result === 'KPB') l.k += 1;
          if (['B', 'S', 'F', 'WP', 'PB', 'BK', 'IPL', 'EF'].includes(ev.result) || !isMidResult(ev.result)) l.pitches += 1;
          const playHadError = ev.result === 'E' || !!ev.errorOn?.length || ['1BE', '2BE', '3BE'].includes(ev.result);
          for (const a of ev.advances) {
            if (a.to !== 'HOME') continue;
            const rec = reach.get(a.playerId);
            const chargeTo = rec?.pitcherId ?? ev.pitcherId;
            if (!chargeTo) continue;
            const cb = groupBy === 'player' ? keyOf(ev, 'pit', chargeTo) : { key, label };
            const cl = pitAccOf(bucketOf(cb.key, cb.label), chargeTo);
            cl.r += 1;
            if (!playHadError && !UNER_REACH.has(rec?.res ?? '')) { cl.er += 1; cl.erW += g.innings; }
          }
        }
      }

      // replay universal: reach de corredores (para cargar carreras al pitcher correcto) + estado
      if (ev.batterId && ev.advances.some((a) => a.playerId === ev.batterId && a.to !== 'OUT' && a.to !== 'HOME')) {
        reach.set(ev.batterId, { res: ev.result, pitcherId: ev.pitcherId });
      }
      // corredor que avanza POR ERROR → res='E' — mismo criterio que el motor:
      // mid de error = todo avance; jugada de turno = solo más allá de lo natural
      const advHadErr = ev.result === 'E' || !!ev.errorOn?.length
        || ['1BE', '2BE', '3BE', 'PB', 'BK', 'IPL', 'DE', 'CI', 'INT', 'OBS'].includes(ev.result)
        || /E-?\d/.test(ev.notation ?? '');
      if (advHadErr) {
        const midErr = isMidResult(ev.result);
        const defs = midErr || !ev.batterId ? null : defaultAdvances(st, ev.batterId, ev.result as PAResult);
        for (const a of ev.advances) {
          if (a.to === 'OUT' || a.to === 'HOME' || a.playerId === ev.batterId) continue;
          if (!midErr && typeof a.to === 'number') {
            const nat = defs?.find((d) => d.playerId === a.playerId)?.to;
            if (typeof nat === 'number' && a.to <= nat) continue;
          }
          const prev = reach.get(a.playerId);
          reach.set(a.playerId, { res: 'E', pitcherId: prev?.pitcherId ?? ev.pitcherId });
        }
      }
      if (ev.result === 'GR' || ev.result === 'ADJ') {
        for (const a of ev.advances) {
          if (a.to !== 'OUT' && a.to !== 'HOME') reach.set(a.playerId, { res: ev.result, pitcherId: ev.result === 'GR' ? ev.pitcherId : null });
        }
      }
      st = applyEvent(st, ev, g.innings);
      const onBase = new Set([st.bases[1], st.bases[2], st.bases[3]].filter(Boolean) as string[]);
      for (const pid of [...reach.keys()]) if (!onBase.has(pid)) reach.delete(pid);
    }

    // ---- juegos importados sin eventos (BallStat): los buckets se alimentan de statLines ----
    // No se puede evaluar granularidad inexistente (mitad, entrada, bases, resultado,
    // pitcher rival) — con esos filtros las líneas se omiten en vez de inventar datos.
    const statLines = (g.statLines ?? []) as {
      playerId: string; teamId: string | null; pa?: number; ab?: number; r?: number;
      h?: number; doubles?: number; triples?: number; hr?: number; rbi?: number; bb?: number;
      k?: number; hbp?: number; sac?: number; sf?: number; sb?: number;
      gp?: number; pOuts?: number; pH?: number; pR?: number; pER?: number;
      pBB?: number; pK?: number; pHR?: number; pPitches?: number; bf?: number;
      po?: number; a?: number; e?: number;
    }[];
    const lineOnlyFilters = f.half || f.inningFrom || f.inningTo || f.results?.length || f.bases || f.twoOuts || f.pitcherId;
    if (!evs.length && statLines.length && !lineOnlyFilters && dataset !== 'plays') {
      const keyOfLine = (pid: string, tid: string | null): { key: string; label: string } | null => {
        switch (groupBy) {
          case 'inning': case 'counterpart': return null; // sin ese detalle en líneas importadas
          case 'month': return { key: `M${String(g.date).slice(0, 7)}`, label: String(g.date).slice(0, 7) };
          case 'game': return { key: `G${g.id}`, label: gameLabel };
          case 'order': { const o = orderOf.get(pid) ?? 0; return { key: `O${o}`, label: `Turno ${o || '?'}` }; }
          case 'season': { const y = g.league?.year ?? String(g.date).slice(0, 4); return { key: `Y${y}`, label: `Temporada ${y}` }; }
          case 'venue': return tid === g.homeTeamId ? { key: 'H', label: 'En casa' } : { key: 'A', label: 'De visita' };
          case 'vs': { const n = tid === g.awayTeamId ? (g.homeTeam.shortName ?? g.homeTeam.name) : (g.awayTeam.shortName ?? g.awayTeam.name); return { key: `V${n}`, label: `vs ${n}` }; }
          default: return { key: `P${pid}`, label: `P:${pid}` };
        }
      };
      for (const ln of statLines) {
        if (f.playerId && ln.playerId !== f.playerId) continue;
        if (f.order && orderOf.get(ln.playerId) !== f.order) continue;
        if (f.homeAway && (ln.teamId === g.homeTeamId ? 'home' : 'away') !== f.homeAway) continue;
        if (teamSet && !teamSet.includes(ln.teamId ?? '')) continue;
        if (vsSet && !vsSet.includes(ln.teamId === g.awayTeamId ? g.homeTeamId : g.awayTeamId)) continue;
        const k = keyOfLine(ln.playerId, ln.teamId);
        if (!k) continue;
        const bk = bucketOf(k.key, k.label);
        if (dataset === 'batting') {
          const l = batAccOf(bk, ln.playerId);
          l.pa += ln.pa ?? 0; l.ab += ln.ab ?? 0; l.r += ln.r ?? 0; l.h += ln.h ?? 0;
          l.d2 += ln.doubles ?? 0; l.d3 += ln.triples ?? 0; l.hr += ln.hr ?? 0; l.rbi += ln.rbi ?? 0;
          l.bb += ln.bb ?? 0; l.k += ln.k ?? 0; l.hbp += ln.hbp ?? 0; l.sac += ln.sac ?? 0;
          l.sf += ln.sf ?? 0; l.sb += ln.sb ?? 0;
        } else if (dataset === 'pitching') {
          if ((ln.gp ?? 0) || (ln.pOuts ?? 0)) {
            const l = pitAccOf(bk, ln.playerId);
            l.outs += ln.pOuts ?? 0; l.h += ln.pH ?? 0; l.r += ln.pR ?? 0; l.er += ln.pER ?? 0;
            l.bb += ln.pBB ?? 0; l.k += ln.pK ?? 0; l.hr += ln.pHR ?? 0; l.pitches += ln.pPitches ?? 0;
            l.bf += ln.bf ?? 0; l.aba += (ln.pOuts ?? 0) + (ln.pH ?? 0); // AB contra aproximado
            l.erW += (ln.pER ?? 0) * g.innings;
          }
        } else if (dataset === 'fielding') {
          const l = fldAccOf(bk, ln.playerId);
          l.po += ln.po ?? 0; l.a += ln.a ?? 0; l.e += ln.e ?? 0;
        }
      }
    }
  }

  if (dataset === 'plays') {
    // nombres para el detalle
    const ids = new Set<string>();
    for (const p of plays) { if (p.batterId) ids.add(p.batterId as string); if (p.pitcherId) ids.add(p.pitcherId as string); }
    const ps = await prisma.player.findMany({ where: { id: { in: [...ids] } }, select: { id: true, firstName: true, lastName: true, number: true } });
    const names = Object.fromEntries(ps.map((p) => [p.id, `${p.number ? `#${p.number} ` : ''}${p.lastName}`]));
    return res.json({ dataset, plays, names, truncated: plays.length >= PLAYS_CAP });
  }

  // resolver nombres de jugadores en etiquetas "P:id" de groupBy player/counterpart
  const idRows = [...buckets.keys()].filter((k) => k.startsWith('P')).map((k) => k.slice(1));
  const pids = new Set<string>(idRows);
  for (const b of buckets.values()) {
    for (const pid of b.bat.keys()) pids.add(pid);
    for (const pid of b.pit.keys()) pids.add(pid);
    for (const pid of b.fld.keys()) pids.add(pid);
  }
  const pnames = new Map(
    (await prisma.player.findMany({ where: { id: { in: [...pids] } }, select: { id: true, firstName: true, lastName: true, number: true } }))
      .map((p) => [p.id, `${p.number ? `#${p.number} ` : ''}${p.firstName[0]}. ${p.lastName}`]),
  );
  const nameOf = (pid: string) => pnames.get(pid) ?? pid;

  const rows: Record<string, unknown>[] = [];
  for (const [key, b] of buckets) {
    const glabel = key.startsWith('P') ? nameOf(key.slice(1)) : b.label;
    if (dataset === 'batting') {
      for (const [pid, l] of b.bat) {
        if (l.pa === 0 && l.sb === 0) continue; // corredor que solo anotó — no es línea de bateo
        const singles = l.h - l.d2 - l.d3 - l.hr;
        const tb = singles + l.d2 * 2 + l.d3 * 3 + l.hr * 4;
        const slg = l.ab ? tb / l.ab : 0;
        const obp = obpOf(l.h, l.bb, l.hbp, l.ab, l.sf);
        const avg = l.ab ? l.h / l.ab : 0;
        // sabermetría: wOBA (pesos estándar), BABIP, ISO, BB%, K%, carreras creadas
        const wobaDen = l.ab + l.bb + l.sf + l.hbp;
        rows.push({
          key, group: glabel, playerId: pid, player: nameOf(pid), ...l, singles,
          avg: f3(avg), obp, slg: f3(slg), ops: f3(obp + slg),
          iso: f3(slg - avg),
          babip: f3((l.ab - l.k - l.hr + l.sf) ? (l.h - l.hr) / (l.ab - l.k - l.hr + l.sf) : 0),
          woba: f3(wobaDen ? (0.69 * l.bb + 0.72 * l.hbp + 0.88 * singles + 1.25 * l.d2 + 1.59 * l.d3 + 2.08 * l.hr) / wobaDen : 0),
          bbPct: f3(l.pa ? l.bb / l.pa : 0), kPct: f3(l.pa ? l.k / l.pa : 0),
          rc: f3((l.ab + l.bb + l.hbp) ? ((l.h + l.bb + l.hbp) * tb) / (l.ab + l.bb + l.hbp) : 0),
        });
      }
    } else if (dataset === 'fielding') {
      for (const [pid, l] of b.fld) {
        const tc = l.po + l.a + l.e;
        rows.push({
          key, group: glabel, playerId: pid, player: nameOf(pid), ...l, tc,
          fpct: tc ? f3((l.po + l.a) / tc) : 0,
        });
      }
    } else {
      for (const [pid, l] of b.pit) {
        const ip = l.outs / 3;
        rows.push({
          key, group: glabel, playerId: pid, player: nameOf(pid), ...l,
          ip: f3(ip), era: f3(ip ? (l.erW * 3) / l.outs : 0), whip: f3(ip ? (l.bb + l.h) / ip : 0), k9: f3(ip ? (l.k * 9) / ip : 0),
          // sabermetría de pitcheo
          bb9: f3(ip ? (l.bb * 9) / ip : 0), h9: f3(ip ? (l.h * 9) / ip : 0), hr9: f3(ip ? (l.hr * 9) / ip : 0),
          kbb: f3(l.bb ? l.k / l.bb : l.k),
          fip: f3(ip ? ((13 * l.hr + 3 * l.bb - 2 * l.k) / ip) + 3.2 : 0),
          baa: f3(l.aba ? l.h / l.aba : 0),
          pip: f3(ip ? l.pitches / ip : 0),
        });
      }
    }
  }
  rows.sort((a, b2) => String(a.group).localeCompare(String(b2.group)) || String(a.player).localeCompare(String(b2.player)));
  res.json({ dataset, rows, gamesCount: games.length });
});

/**
 * POST /sql — consulta SQL libre SOLO LECTURA (reporte definido por el usuario).
 * Acepta SELECT/WITH/SHOW/DESCRIBE/EXPLAIN, una sola sentencia, sin DML/DDL;
 * límite 15s (MAX_EXECUTION_TIME) y 1000 filas devueltas.
 */
const SQL_BANNED = /\b(insert|update|delete|drop|create|alter|truncate|replace|grant|revoke|call|handler|lock|unlock|rename|load_file|outfile|dumpfile|shutdown|kill|install|uninstall|prepare|execute\s+immediate|deallocate|set\s+(?!local)|use\s|begin|commit|rollback|xa\s|savepoint)\b/i;
/** Quita comentarios y literales (comillas/backticks) para validar sobre el SQL "desnudo". */
const stripSql = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ')
  .replace(/#[^\n]*/g, ' ')
  .replace(/'([^'\\]|\\.|'')*'/g, "''")
  .replace(/"([^"\\]|\\.)*"/g, '""')
  .replace(/`([^`]|``)*`/g, '``');
const sqlScalar = (v: unknown): unknown => {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString('hex').slice(0, 24)}…`;
  return v;
};
r.post('/sql', async (req, res) => {
  const sql = String(req.body?.sql ?? '').trim();
  if (!sql) return res.status(400).json({ error: 'Consulta vacía' });
  const orig = sql.replace(/;+\s*$/, '');                       // ejecuta el original (conserva literales)
  const clean = stripSql(sql).trim().replace(/;+\s*$/, '');    // valida sin literales ni comentarios
  if (!/^(select|with|show|describe|desc|explain)\b/i.test(clean))
    return res.status(400).json({ error: 'Solo lectura: la consulta debe empezar con SELECT, WITH, SHOW, DESCRIBE o EXPLAIN' });
  if (clean.includes(';')) return res.status(400).json({ error: 'Una sola sentencia por consulta' });
  if (SQL_BANNED.test(clean))
    return res.status(400).json({ error: 'Solo lectura — esa instrucción no está permitida' });
  const t0 = Date.now();
  try {
    const rows = await prisma.$transaction(async (tx) => {
      try { await tx.$executeRawUnsafe('SET SESSION MAX_EXECUTION_TIME=15000'); } catch { /* MySQL lo soporta; si no, seguimos */ }
      return await tx.$queryRawUnsafe<Record<string, unknown>[]>(orig);
    }, { timeout: 20000 });
    const list = Array.isArray(rows) ? rows : [rows];
    const truncated = list.length > 1000;
    const data = (truncated ? list.slice(0, 1000) : list).map((row) =>
      Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, sqlScalar(v)])));
    res.json({ columns: data.length ? Object.keys(data[0]) : [], rows: data, truncated, ms: Date.now() - t0 });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message.split('\n').pop() : 'Error de SQL' });
  }
});

/**
 * POST /stats/merge-player {removeId, keepId}
 * Fusiona un jugador duplicado (típico de importaciones sin refuerzos):
 * todo el historial del eliminado pasa al que se queda y sus stats se SUMAN.
 * Reasigna: alineaciones, eventos (bate/lanza), avances de corredores,
 * créditos de fildeo (po/a/e), decisiones W/L/SV/HLD/BS, plantillas de equipo,
 * acumulados de temporada (misma temporada+scope → suma columna por columna).
 */
const STAT_NUMS = [
  'g', 'pa', 'ab', 'r', 'h', 'doubles', 'triples', 'hr', 'rbi', 'bb', 'k', 'hbp',
  'sac', 'sf', 'sb', 'gp', 'gs', 'w', 'l', 'sv', 'hld', 'bs', 'cg', 'sho',
  'pOuts', 'pH', 'pR', 'pER', 'pBB', 'pK', 'pHR', 'pPitches', 'e',
] as const;

r.post('/merge-player', async (req, res) => {
  try {
    const { removeId, keepId } = req.body as { removeId?: string; keepId?: string };
    if (!removeId || !keepId) return res.status(400).json({ error: 'faltan removeId/keepId' });
    if (removeId === keepId) return res.status(400).json({ error: 'son el mismo jugador' });
    const [bye, stay] = await Promise.all([
      prisma.player.findUnique({ where: { id: removeId }, include: { team: true } }),
      prisma.player.findUnique({ where: { id: keepId }, include: { team: true } }),
    ]);
    if (!bye || !stay) return res.status(404).json({ error: 'jugador no encontrado' });
    await autoBackup('antes de fusionar jugador');
    const moved: Record<string, number> = {};

    // 1 · acumulados de temporada — misma (season, scope) → suma
    const statRows = await prisma.playerSeasonStat.findMany({ where: { playerId: removeId } });
    for (const row of statRows) {
      const data: Record<string, number> = {};
      for (const k of STAT_NUMS) data[k] = (row as Record<string, unknown>)[k] as number ?? 0;
      await prisma.playerSeasonStat.upsert({
        where: { playerId_season_scope: { playerId: keepId, season: row.season, scope: row.scope } },
        create: { playerId: keepId, season: row.season, scope: row.scope, ...data },
        update: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { increment: v }])),
      });
      await prisma.playerSeasonStat.delete({ where: { id: row.id } });
    }
    moved.stats = statRows.length;

    // 2 · alineaciones + eventos (bateador/lanzador)
    moved.lineups = (await prisma.lineupEntry.updateMany({ where: { playerId: removeId }, data: { playerId: keepId } })).count;
    moved.comoBate = (await prisma.gameEvent.updateMany({ where: { batterId: removeId }, data: { batterId: keepId } })).count;
    moved.comoLanza = (await prisma.gameEvent.updateMany({ where: { pitcherId: removeId }, data: { pitcherId: keepId } })).count;

    // 3 · créditos de fildeo — columnas String con JSON [playerId]
    for (const col of ['errorOn', 'putouts', 'assists'] as const) {
      const evs = await prisma.gameEvent.findMany({
        where: { [col]: { contains: removeId } },
        select: { id: true, errorOn: true, putouts: true, assists: true },
      });
      for (const ev of evs) {
        const arr = (JSON.parse(ev[col] as string) as string[]).map((x) => (x === removeId ? keepId : x));
        await prisma.gameEvent.update({
          where: { id: ev.id }, data: { [col]: JSON.stringify([...new Set(arr)]) },
        });
      }
      moved[col] = evs.length;
    }

    // 4 · avances de corredores — columna JSON [{playerId,to}]
    const advRows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM gameevent
      WHERE JSON_SEARCH(advances, 'one', ${removeId}, NULL, '$[*].playerId') IS NOT NULL`;
    for (const { id } of advRows) {
      const ev = await prisma.gameEvent.findUniqueOrThrow({ where: { id }, select: { advances: true } });
      const adv = (ev.advances as { playerId: string; to: unknown }[])
        .map((a) => ({ playerId: a.playerId === removeId ? keepId : a.playerId, to: a.to }));
      await prisma.gameEvent.update({ where: { id }, data: { advances: JSON.parse(JSON.stringify(adv)) } });
    }
    moved.advances = advRows.length;

    // 5 · decisiones del juego
    for (const col of ['wpId', 'lpId', 'svId'] as const) {
      moved[col] = (await prisma.game.updateMany({ where: { [col]: removeId }, data: { [col]: keepId } })).count;
    }
    for (const col of ['hldIds', 'bsIds'] as const) {
      const gs = await prisma.game.findMany({
        where: { [col]: { contains: removeId } },
        select: { id: true, hldIds: true, bsIds: true },
      });
      for (const g of gs) {
        const arr = (JSON.parse(g[col] as string) as string[]).map((x) => (x === removeId ? keepId : x));
        await prisma.game.update({ where: { id: g.id }, data: { [col]: JSON.stringify([...new Set(arr)]) } });
      }
      moved[col] = gs.length;
    }

    // 5b · líneas por juego importadas — Game.statLines (JSON) con playerId
    const slGames = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM Game
      WHERE JSON_SEARCH(statLines, 'one', ${removeId}, NULL, '$[*].playerId') IS NOT NULL`;
    for (const { id } of slGames) {
      const g = await prisma.game.findUniqueOrThrow({ where: { id }, select: { statLines: true } });
      const lines = (g.statLines as { playerId: string }[]).map((l) =>
        l.playerId === removeId ? { ...l, playerId: keepId } : l);
      await prisma.game.update({ where: { id }, data: { statLines: JSON.parse(JSON.stringify(lines)) } });
    }
    moved.statLines = slGames.length;
    // las dos fichas podían tener línea en el mismo juego → consolida duplicados
    // en una sola línea por jugador (suma los números; antes la tarjeta solo
    // veía la primera y quedaban "fantasmas" en los boxscores)
    const allIds = (await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM Game
      WHERE JSON_SEARCH(statLines, 'one', ${keepId}, NULL, '$[*].playerId') IS NOT NULL`).map((x) => x.id);
    await consolidateStatLineDupes(allIds);

    // 6 · plantillas de alineación de equipos (JSON con playerId)
    const tplTeams = await prisma.team.findMany({ where: { lineupTemplate: { contains: removeId } }, select: { id: true, lineupTemplate: true } });
    for (const t of tplTeams) {
      const tpl = (JSON.parse(t.lineupTemplate as string) as { playerId: string }[])
        .map((x) => (x.playerId === removeId ? { ...x, playerId: keepId } : x));
      await prisma.team.update({ where: { id: t.id }, data: { lineupTemplate: JSON.stringify(tpl) } });
    }
    moved.plantillas = tplTeams.length;

    await prisma.player.delete({ where: { id: removeId } });
    res.json({
      ok: true, moved,
      eliminado: `${bye.firstName} ${bye.lastName}`,
      queda: `${stay.firstName} ${stay.lastName}`,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Error al fusionar' });
  }
});

/**
 * POST /recalc {year} — RECONSTRUYE PlayerSeasonStat del año desde los juegos.
 * El acumulado es una foto: auditorías viejas, swaps o correcciones previas a
 * la resincronización por delta pudieron dejarlo desfasado (ej. lanzador que
 * seguía con los números tras corregir identidad). Aquí se recalcula todo
 * desde el stream: columnas = contribución real del año; `adj` (correcciones
 * manuales del admin) se conserva. Filas sin contribución se limpian: si
 * tienen adj quedan en cero, si no se borran. Juegos FINAL aún no aplicados
 * se marcan seasonApplied — su contribución ya quedó dentro.
 */
r.post('/recalc', async (req, res) => {
  const year = Number(req.body?.year);
  if (!year || !Number.isFinite(year)) return res.status(400).json({ error: 'year requerido' });
  const PSS_KEYS = SL_NUMS.filter((k) => !['po', 'a', 'bf'].includes(k));
  const games = await prisma.game.findMany({
    where: { status: 'FINAL' }, include: { lineups: true, season: true },
  });
  const ofYear = games.filter((g) => (g.season?.year ?? new Date(g.date).getFullYear()) === year);
  const totals = new Map<string, Record<string, number>>();
  for (const g of ofYear) {
    const scope = g.seriesId ? 'POST' : 'REG';
    for (const [pid, c] of await gameContrib(g)) {
      const key = `${pid}|${scope}`;
      const acc = totals.get(key) ?? {};
      for (const [k, v] of Object.entries(c)) acc[k] = (acc[k] ?? 0) + v;
      totals.set(key, acc);
    }
  }
  const existing = await prisma.playerSeasonStat.findMany({ where: { season: year } });
  const seen = new Set<string>();
  let updated = 0, cleared = 0;
  for (const row of existing) {
    const acc = totals.get(`${row.playerId}|${row.scope}`);
    if (acc) {
      seen.add(`${row.playerId}|${row.scope}`);
      await prisma.playerSeasonStat.update({
        where: { id: row.id },
        data: Object.fromEntries(PSS_KEYS.map((k) => [k, acc[k] ?? 0])),
      });
      updated++;
    } else if (row.adj && Object.keys(row.adj as object).length) {
      await prisma.playerSeasonStat.update({
        where: { id: row.id },
        data: Object.fromEntries(PSS_KEYS.map((k) => [k, 0])),
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
    const [playerId, scope] = key.split('|');
    await prisma.playerSeasonStat.create({
      data: { playerId, season: year, scope, ...Object.fromEntries(PSS_KEYS.map((k) => [k, acc[k] ?? 0])) },
    });
    created++;
  }
  const unapplied = ofYear.filter((g) => !g.seasonApplied).map((g) => g.id);
  if (unapplied.length) {
    await prisma.game.updateMany({ where: { id: { in: unapplied } }, data: { seasonApplied: true } });
  }
  res.json({ ok: true, year, games: ofYear.length, updated, created, cleared, markedApplied: unapplied.length });
});

export default r;
