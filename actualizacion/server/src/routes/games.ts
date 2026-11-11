import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { autoBackup } from '../backup-lib.js';
import { adminOk, authEnabled, reqUser } from '../auth.js';
import { enqueue } from './game-queue.js';
import { gameDate } from '../dates.js';
import { computeBoxscore, computeCgSho, computeFielding, computeSituational, isMidResult, reduceGame, suggestDecisions } from '@poxscore/shared';
import type { GameEvent, PlayResult } from '@poxscore/shared';
import { mergeLines, SL_NUMS, type StatLine } from '../statlines.js';
// columnas reales de PlayerSeasonStat (la línea lleva po/a/bf pero la
// temporada no los tiene — solo `e` de fildeo)
const SEASON_KEYS = SL_NUMS.filter((k) => !['po', 'a', 'bf'].includes(k));

const r = Router();

export function toEvent(e: {
  seq: number; inning: number; half: string;
  batterId: string | null; pitcherId: string | null;
  result: string; notation?: string | null; advances: unknown;
  sprayDir?: number | null; sprayDist?: number | null;
  errorOn?: string | null; putouts?: string | null; assists?: string | null;
  aiVoice?: string | null; aiJson?: string | null; aiVideo?: string | null; aiNarr?: string | null;
}): GameEvent {
  return {
    seq: e.seq, inning: e.inning, half: e.half as GameEvent['half'],
    batterId: e.batterId, pitcherId: e.pitcherId,
    result: e.result as GameEvent['result'],
    notation: e.notation ?? null,
    ...(e.sprayDir != null && e.sprayDist != null ? { sprayDir: e.sprayDir, sprayDist: e.sprayDist } : {}),
    errorOn: e.errorOn ? (JSON.parse(e.errorOn) as string[]) : undefined,
    putouts: e.putouts ? (JSON.parse(e.putouts) as string[]) : undefined,
    assists: e.assists ? (JSON.parse(e.assists) as string[]) : undefined,
    advances: e.advances as GameEvent['advances'],
    aiVoice: e.aiVoice ?? null, aiJson: e.aiJson ?? null,
    aiVideo: e.aiVideo ?? null, aiNarration: e.aiNarr ?? null,
  };
}

export async function loadEvents(gameId: string): Promise<GameEvent[]> {
  const rows = await prisma.gameEvent.findMany({
    where: { gameId },
    orderBy: { seq: 'asc' },
  });
  return rows.map(toEvent);
}

/**
 * Marca dobles jornadas: agrega `dhAway`/`dhHome` = n-ésimo juego del equipo ese día
 * (solo cuando >1). El orden dentro del día se resuelve por startedAt → date → orden de lista.
 */
export function markDoubleheaders<T extends { date: Date | string; homeTeamId: string; awayTeamId: string; startedAt?: Date | string | null }>(games: T[]): T[] {
  const sorted = [...games].sort((a, b) => {
    const sa = a.startedAt ? +new Date(a.startedAt) : 0;
    const sb = b.startedAt ? +new Date(b.startedAt) : 0;
    if (sa !== sb) return sa - sb;
    const da = +new Date(a.date), db = +new Date(b.date);
    return da !== db ? da - db : 0;
  });
  const seq = new Map<string, number>();
  for (const g of sorted) {
    const day = new Date(g.date).toISOString().slice(0, 10);
    for (const [side, tid] of [['dhAway', g.awayTeamId], ['dhHome', g.homeTeamId]] as const) {
      const k = `${tid}|${day}`;
      const n = (seq.get(k) ?? 0) + 1;
      seq.set(k, n);
      if (n > 1) (g as Record<string, unknown>)[side] = n;
    }
  }
  return games;
}

// ---- Juegos ----
r.get('/', async (_req, res) => {
  const games = await prisma.game.findMany({
    orderBy: { date: 'desc' },
    include: { homeTeam: true, awayTeam: true, league: true, _count: { select: { events: true } } },
  });
  // estado calculado solo para juegos LIVE (marcador/entrada para "En Acción")
  const live = games.filter((g) => g.status === 'LIVE');
  const states = new Map<string, ReturnType<typeof reduceGame>>();
  for (const g of live) states.set(g.id, reduceGame(await loadEvents(g.id), g.innings));
  res.json(markDoubleheaders(games.map((g) => (states.has(g.id) ? { ...g, state: states.get(g.id) } : g))));
});

r.post('/', async (req, res) => {
  const { homeTeamId, awayTeamId, date, innings, note, lineups, sport, ghostRunner, leagueId, seriesId, seasonId } = req.body;
  if (!homeTeamId || !awayTeamId) return res.status(400).json({ error: 'homeTeamId y awayTeamId requeridos' });
  // liga del juego: explícita o la del equipo local (si ambos comparten liga)
  let league = leagueId ?? null;
  if (!league) {
    const home = await prisma.team.findUnique({ where: { id: homeTeamId } });
    const away = await prisma.team.findUnique({ where: { id: awayTeamId } });
    if (home?.leagueId && home.leagueId === away?.leagueId) league = home.leagueId;
  }
  // deporte y entradas por defecto desde la liga (League.innings puede ajustar 6/8/etc.)
  const lg = league ? await prisma.league.findUnique({ where: { id: league } }) : null;
  const gameSport = sport ?? lg?.sport ?? 'baseball';
  // temporada: explícita o la ACTIVA de la liga
  let season = seasonId || null;
  if (league && !season) {
    season = (await prisma.season.findFirst({ where: { leagueId: league, status: 'ACTIVE' } }))?.id ?? null;
  }
  const game = await prisma.game.create({
    data: {
      homeTeamId, awayTeamId, leagueId: league, seriesId: seriesId || null, seasonId: season,
      date: gameDate(date) ?? new Date(),
      sport: gameSport,
      innings: innings ?? lg?.innings ?? (gameSport === 'softball' ? 7 : 9),
      ghostRunner: !!ghostRunner,
      note,
      lineups: lineups ? {
        create: (lineups as { teamId: string; playerId: string; order: number; position: string; role?: string; batsInOrder?: boolean }[])
          .map((l) => ({ teamId: l.teamId, playerId: l.playerId, order: l.order, position: l.position, role: l.role ?? 'STARTER', batsInOrder: l.batsInOrder !== false })),
      } : undefined,
    },
    include: { homeTeam: true, awayTeam: true, lineups: { include: { player: true } } },
  });
  res.status(201).json(game);
});

r.get('/:id', async (req, res) => {
  const game = await prisma.game.findUnique({
    where: { id: req.params.id },
    include: {
      // rosters alfabéticos — alimentan el pool del lineup y las sustituciones
      homeTeam: { include: { players: { orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }] } } },
      awayTeam: { include: { players: { orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }] } } },
      league: true, // trae sprayInput (flag del anotador) + nombre/año que consumen otras vistas
      lineups: { include: { player: true }, orderBy: { order: 'asc' } },
      events: { orderBy: { seq: 'asc' } },
    },
  });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  const events = game.events.map(toEvent);
  const state = reduceGame(events, game.innings);
  // fin manual/forfeit: el motor puede seguir en LIVE — la fuente de verdad del fin es game.status
  if (game.status === 'FINAL' && state.status !== 'FINAL') state.status = 'FINAL';
  // marcador forfeit o juego importado sin eventos sustituye al derivado del stream
  if ((!events.length || game.forfeitBy) && game.fScoreAway != null && game.fScoreHome != null) {
    state.score = { away: game.fScoreAway, home: game.fScoreHome };
  }
  // statLines (juegos importados): jugadores pueden haber cambiado de equipo →
  // incluir nombres de los que no salgan en rosters/lineups para que el boxscore los nombre
  const lines = (game.statLines ?? []) as { playerId?: string }[];
  const known = new Set<string>([
    ...game.lineups.map((l) => l.playerId),
    ...game.homeTeam.players.map((p) => p.id),
    ...game.awayTeam.players.map((p) => p.id),
  ]);
  // jugadores que solo aparecen en el stream (pitcher entrado por PC sin fila
  // de lineup, o transferido después del juego): también necesitan nombre en la UI
  const refs = events.flatMap((e) => [e.batterId, e.pitcherId]);
  const missing = [...new Set(
    [...lines.map((l) => l.playerId), ...refs].filter((p): p is string => !!p && !known.has(p)),
  )];
  const statPlayers = missing.length
    ? await prisma.player.findMany({ where: { id: { in: missing } }, select: { id: true, firstName: true, lastName: true } })
    : [];
  res.json({ ...game, state, statPlayers });
});

r.put('/:id', async (req, res) => {
  const { date, innings, note, status, leagueId, stadium, umpireHp, umpire1b, umpire2b, umpire3b, seriesId, sport, ghostRunner, seasonId, awayTeamId, homeTeamId, startedAt } = req.body;
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  // cambio de equipos solo permitido antes de iniciar (triangular "ganador se queda"
  // programa J2/J3 con equipos provisionales que se corrigen tras el J1)
  if ((awayTeamId || homeTeamId) && game.status !== 'SCHEDULED')
    return res.status(400).json({ error: 'Los equipos solo se cambian en juegos programados' });
  const newAway = awayTeamId ?? game.awayTeamId, newHome = homeTeamId ?? game.homeTeamId;
  if (newAway === newHome) return res.status(400).json({ error: 'Visitante y local no pueden ser el mismo equipo' });
  // vínculo a serie de playoff: se resuelve aparte porque si el juego ya
  // acumuló temporada su contribución migra entre scopes REG ↔ POST
  if (seriesId !== undefined && (seriesId || null) !== game.seriesId) {
    if (seriesId) {
      const sr = await prisma.series.findUnique({ where: { id: seriesId } });
      if (!sr) return res.status(400).json({ error: 'Serie no encontrada' });
      if (game.leagueId && sr.leagueId !== game.leagueId)
        return res.status(400).json({ error: 'El juego y la serie son de ligas distintas' });
    }
    await assignGameSeries(req.params.id, seriesId || null);
  }
  // cambio de deporte con el juego en curso: si las entradas seguían en el default
  // del deporte anterior (7↔9), pasan al default del nuevo; custom se respeta
  let newInnings = innings;
  if (sport && sport !== game.sport && innings === undefined) {
    const oldDef = game.sport === 'softball' ? 7 : 9;
    if (game.innings === oldDef) newInnings = sport === 'softball' ? 7 : 9;
  }
  const updated = await prisma.game.update({
    where: { id: req.params.id },
    data: {
      date: gameDate(date), innings: newInnings, note, status, leagueId,
      startedAt: startedAt ? new Date(startedAt) : undefined,
      stadium, umpireHp, umpire1b, umpire2b, umpire3b,
      seasonId: seasonId !== undefined ? (seasonId || null) : undefined,
      awayTeamId: awayTeamId ?? undefined, homeTeamId: homeTeamId ?? undefined,
      sport, ghostRunner,
    },
  });
  // cerrar por vía admin (status → FINAL sin pasar por /finish): el acumulado
  // de temporada no se puede saltar — sin esto la fila queda vieja y el
  // récord del jugador muestra números parciales en la consulta
  if (updated.status === 'FINAL') await accumulateSeason(req.params.id);
  res.json(updated);
});

/**
 * Pausa / reanuda el reloj del juego (lluvia, luz, reunión en el campo):
 * pausar → guarda pausedAt · reanudar → acumula el tramo en pauseSecs.
 * El tiempo de juego = (endedAt ?? pausedAt ?? ahora) − startedAt − pauseSecs.
 */
r.post('/:id/pause', async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  if (game.status !== 'LIVE') return res.status(400).json({ error: 'Solo en juegos en curso' });
  const { auto } = req.body as { auto?: boolean };
  // reloj automático: la app se pausa al cerrarse/ocultarse y se reanuda al
  // volver — NO toca una pausa manual del anotador (pausedAuto lo distingue)
  if (auto === true) {
    if (game.pausedAt) return res.json(game); // ya pausado (manual o auto)
    return res.json(await prisma.game.update({ where: { id: game.id }, data: { pausedAt: new Date(), pausedAuto: true } }));
  }
  if (auto === false) {
    if (!game.pausedAt || !game.pausedAuto) return res.json(game); // pausa manual → no reanudar sola
    return res.json(await prisma.game.update({
      where: { id: game.id },
      data: { pauseSecs: { increment: Math.max(0, Math.floor((Date.now() - new Date(game.pausedAt).getTime()) / 1000)) }, pausedAt: null, pausedAuto: false },
    }));
  }
  const updated = game.pausedAt
    ? await prisma.game.update({
      where: { id: game.id },
      data: { pauseSecs: { increment: Math.max(0, Math.floor((Date.now() - new Date(game.pausedAt).getTime()) / 1000)) }, pausedAt: null, pausedAuto: false },
    })
    : await prisma.game.update({ where: { id: game.id }, data: { pausedAt: new Date(), pausedAuto: false } });
  res.json(updated);
});

r.post('/:id/start', async (req, res) => {
  const gameId = req.params.id;
  // regla: cada equipo debe definir lanzador abridor (posición P en la alineación activa)
  const lineups = await prisma.lineupEntry.findMany({ where: { gameId, active: true } });
  const game = await prisma.game.findUnique({ where: { id: gameId }, include: { homeTeam: true, awayTeam: true } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  for (const [teamId, name] of [[game.awayTeamId, game.awayTeam.name], [game.homeTeamId, game.homeTeam.name]] as const) {
    const mine = lineups.filter((l) => l.teamId === teamId);
    if (mine.length === 0) return res.status(400).json({ error: `${name}: falta la alineación` });
    if (!mine.some((l) => l.position === 'P')) {
      return res.status(400).json({ error: `${name}: define el lanzador abridor (posición P en la alineación)` });
    }
  }
  const { date, stadium, umpireHp, umpire1b, umpire2b, umpire3b } = req.body;
  const updated = await prisma.game.update({
    where: { id: gameId },
    data: {
      status: 'LIVE',
      startedAt: new Date(),
      date: gameDate(date),
      stadium: stadium ?? undefined,
      umpireHp: umpireHp ?? undefined,
      umpire1b: umpire1b ?? undefined,
      umpire2b: umpire2b ?? undefined,
      umpire3b: umpire3b ?? undefined,
    },
  });
  res.json(updated);
});

/**
 * Datos para la pantalla de decisiones (final del juego):
 * ganador del marcador + sugerencia automática de pitcher ganador/derrotado.
 * WP = pitcher del equipo ganador que lanzaba cuando su equipo tomó la
 * delantera definitiva; LP = pitcher que permitió la carrera de la ventaja.
 * Empate → sin ganador ni derrotado (en standings no suma W ni L).
 */
r.get('/:id/finish-data', async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id }, include: { league: true } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  const events = await loadEvents(req.params.id);
  const state = reduceGame(events, game.innings);
  const winner =
    state.score.away > state.score.home ? 'away'
    : state.score.home > state.score.away ? 'home'
    : 'tie';

  // Sugerencia de decisiones (regla 9.17 completa en el motor): LP = responsable
  // real de la carrera de la delantera (heredado → quien lo embasó); WP = pitcher
  // de registro, con mínimo de entradas del abridor y fallback al relevista
  // más efectivo. El anotador confirma/corrige en el modal.
  const sug = winner === 'tie'
    ? { wpId: null, lpId: null, wpKind: null, starterOuts: 0, minStarterOuts: 0 }
    : suggestDecisions(events, game.innings, game.sport, game.league?.wpMinOuts);
  // CG y SHO automáticos (BallScore: "exported automatically")
  const { cg, sho } = computeCgSho(events, game.innings);
  res.json({
    score: state.score, winner, tied: winner === 'tie',
    suggestedWpId: sug.wpId, suggestedLpId: sug.lpId,
    wpKind: sug.wpKind, wpStarterOuts: sug.starterOuts, wpMinStarterOuts: sug.minStarterOuts,
    cgIds: cg, shoIds: sho,
  });
});

type GameWithLineups = Prisma.GameGetPayload<{ include: { lineups: true; season: true } }>;

/**
 * Contribución TOTAL del juego a PlayerSeasonStat por jugador — eventos +
 * líneas manuales + decisiones. Es una función pura del estado del juego:
 * la auditoría la llama ANTES y DESPUÉS de tocar el stream para aplicar
 * solo la delta a los acumulados de temporada (nada queda viejo).
 */
export async function gameContrib(game: GameWithLineups): Promise<Map<string, Record<string, number>>> {
  const events = await loadEvents(game.id);
  const box = computeBoxscore(events, game.innings);
  const out = new Map<string, Record<string, number>>();

  // participantes: todos los del lineup (incluye los que salieron) + quien lanzó
  const participants = new Set<string>([
    ...game.lineups.map((l) => l.playerId),
    ...Object.keys(box.pitchers),
  ]);
  // abridores: primer pitcher de cada equipo (defiende en la mitad contraria a la que batea)
  const starters = new Set<string>();
  const firstTop = events.find((e) => e.half === 'TOP' && e.pitcherId)?.pitcherId;   // home lanza en TOP
  const firstBot = events.find((e) => e.half === 'BOTTOM' && e.pitcherId)?.pitcherId; // away lanza en BOTTOM
  if (firstTop) starters.add(firstTop);
  if (firstBot) starters.add(firstBot);
  // errores por fildeador (errorOn JSON con playerId)
  const errCount = new Map<string, number>();
  for (const e of events) {
    for (const pid of e.errorOn ?? []) errCount.set(pid, (errCount.get(pid) ?? 0) + 1);
  }
  const holds = game.hldIds ? (JSON.parse(game.hldIds) as string[]) : [];
  const blown = game.bsIds ? (JSON.parse(game.bsIds) as string[]) : [];
  // CG/SHO automáticos — con marcador oficial (forfeit usa fScore)
  const official = game.fScoreAway != null && game.fScoreHome != null
    ? { away: game.fScoreAway, home: game.fScoreHome }
    : undefined;
  const { cg, sho } = computeCgSho(events, game.innings, official);

  for (const pid of participants) {
    const bat = box.away[pid] ?? box.home[pid];
    const pit = box.pitchers[pid];
    out.set(pid, {
      g: 1,
      pa: bat?.pa ?? 0, ab: bat?.ab ?? 0, r: bat?.r ?? 0, h: bat?.h ?? 0,
      doubles: bat?.doubles ?? 0, triples: bat?.triples ?? 0, hr: bat?.hr ?? 0,
      rbi: bat?.rbi ?? 0, bb: bat?.bb ?? 0, k: bat?.k ?? 0, hbp: bat?.hbp ?? 0,
      sac: bat?.sac ?? 0, sf: bat?.sf ?? 0, sb: bat?.sb ?? 0,
      gp: pit ? 1 : 0, gs: starters.has(pid) ? 1 : 0,
      w: game.wpId === pid ? 1 : 0, l: game.lpId === pid ? 1 : 0,
      sv: game.svId === pid ? 1 : 0, hld: holds.includes(pid) ? 1 : 0,
      bs: blown.includes(pid) ? 1 : 0, cg: cg.includes(pid) ? 1 : 0, sho: sho.includes(pid) ? 1 : 0,
      pOuts: pit?.outs ?? 0, pH: pit?.h ?? 0, pR: pit?.r ?? 0, pER: pit?.er ?? 0,
      pBB: pit?.bb ?? 0, pK: pit?.k ?? 0, pHR: pit?.hr ?? 0, pPitches: pit?.pitches ?? 0,
      e: errCount.get(pid) ?? 0,
    });
  }

  // líneas manuales/importadas (Game.statLines): números que el stream no cubre.
  // Anti-doble: `g`/`gp`/`gs` solo si el jugador no participó vía eventos/lineup;
  // decisiones solo si las columnas del juego no se las acreditaron ya.
  for (const ln of (game.statLines ?? []) as unknown as StatLine[]) {
    const isPart = participants.has(ln.playerId);
    const data = out.get(ln.playerId) ?? {};
    const add = (k: string, v?: number) => { if (v) data[k] = (data[k] ?? 0) + v; };
    add('g', isPart ? 0 : (ln.g ?? 1));
    for (const k of ['pa', 'ab', 'r', 'h', 'doubles', 'triples', 'hr', 'rbi', 'bb', 'k',
      'hbp', 'sac', 'sf', 'sb', 'pOuts', 'pH', 'pR', 'pER', 'pBB', 'pK', 'pHR',
      'pPitches', 'e'] as const) add(k, ln[k]); // po/a/bf no existen en PlayerSeasonStat
    if (!box.pitchers[ln.playerId]) { add('gp', ln.gp ?? (ln.pOuts ? 1 : 0)); add('gs', ln.gs); }
    if (game.wpId !== ln.playerId) add('w', ln.w);
    if (game.lpId !== ln.playerId) add('l', ln.l);
    if (game.svId !== ln.playerId) add('sv', ln.sv);
    if (!holds.includes(ln.playerId)) add('hld', ln.hld);
    if (!blown.includes(ln.playerId)) add('bs', ln.bs);
    if (!cg.includes(ln.playerId)) add('cg', ln.cg);
    if (!sho.includes(ln.playerId)) add('sho', ln.sho);
    if (Object.keys(data).length) out.set(ln.playerId, data);
  }
  return out;
}

/**
 * Aplica la delta (después − antes) de contribución del juego a los acumulados
 * de temporada — auditoría post-final y corrección de decisiones. Crea la fila
 * solo para jugadores con contribución nueva; para los existentes incrementa
 * la diferencia (positiva o negativa).
 */
export async function applySeasonDelta(
  game: { season?: { year: number } | null; date: Date; seriesId: string | null },
  before: Map<string, Record<string, number>>,
  after: Map<string, Record<string, number>>,
): Promise<void> {
  const season = game.season?.year ?? new Date(game.date).getFullYear();
  const scope = game.seriesId ? 'POST' : 'REG';
  const pids = [...new Set([...before.keys(), ...after.keys()])];
  const existing = new Set(
    (await prisma.playerSeasonStat.findMany({
      where: { playerId: { in: pids }, season, scope },
      select: { playerId: true },
    })).map((r) => r.playerId),
  );
  for (const pid of pids) {
    const keys = new Set([...Object.keys(before.get(pid) ?? {}), ...Object.keys(after.get(pid) ?? {})]);
    const delta: Record<string, number> = {};
    for (const k of keys) {
      const d = (after.get(pid)?.[k] ?? 0) - (before.get(pid)?.[k] ?? 0);
      if (d) delta[k] = d;
    }
    if (!Object.keys(delta).length) continue;
    if (existing.has(pid)) {
      await prisma.playerSeasonStat.update({
        where: { playerId_season_scope: { playerId: pid, season, scope } },
        data: Object.fromEntries(Object.entries(delta).map(([k, v]) => [k, { increment: v }])),
      });
    } else if (after.has(pid)) {
      await prisma.playerSeasonStat.create({
        data: { playerId: pid, season, scope, ...after.get(pid)! },
      });
    }
  }
}

/**
 * Acumula las estadísticas del juego en la temporada de cada jugador (por playerId).
 * Idempotente vía `seasonApplied`: solo se suma una vez por juego.
 * Exportada para el importador (.pox.json) — juegos con eventos pasan por aquí.
 */
export async function accumulateSeason(gameId: string): Promise<void> {
  const game = await prisma.game.findUnique({ where: { id: gameId }, include: { lineups: true, season: true } });
  if (!game || game.seasonApplied) return;
  const season = game.season?.year ?? new Date(game.date).getFullYear(); // año de la Season; fecha como respaldo
  const scope = game.seriesId ? 'POST' : 'REG'; // playoff no suma a la temporada regular
  for (const [pid, data] of await gameContrib(game)) {
    await prisma.playerSeasonStat.upsert({
      where: { playerId_season_scope: { playerId: pid, season, scope } },
      create: { playerId: pid, season, scope, ...data },
      update: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { increment: v }])),
    });
  }
  await prisma.game.update({ where: { id: gameId }, data: { seasonApplied: true } });
}

/**
 * (Des)vincula el juego a una serie de playoff. Si el juego ya acumuló
 * temporada (`seasonApplied`) MUEVE su contribución entre los scopes
 * REG ↔ POST de PlayerSeasonStat — la regular y la postemporada son
 * acumulados independientes (estilo MLB: los playoffs no suman a la
 * campaña regular). Un juego aún no aplicado solo cambia seriesId: al
 * cerrarse, accumulateSeason ya usa el scope correcto.
 * Además adopta el seasonId de la serie cuando el juego no tiene.
 */
export async function assignGameSeries(gameId: string, seriesId: string | null): Promise<void> {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: { lineups: true, season: true },
  });
  if (!game || game.seriesId === seriesId) return;
  const fromScope = game.seriesId ? 'POST' : 'REG';
  const toScope = seriesId ? 'POST' : 'REG';
  // solo hay que migrar si el juego ya sumó Y el scope realmente cambia
  const contrib = game.seasonApplied && fromScope !== toScope ? await gameContrib(game) : null;
  const seriesSeason = seriesId
    ? (await prisma.series.findUnique({ where: { id: seriesId }, select: { seasonId: true } }))?.seasonId ?? null
    : null;
  await prisma.game.update({
    where: { id: gameId },
    data: { seriesId, ...(seriesSeason && !game.seasonId ? { seasonId: seriesSeason } : {}) },
  });
  if (!contrib) return;
  const season = game.season?.year ?? new Date(game.date).getFullYear();
  for (const [pid, data] of contrib) {
    // resta del acumulado viejo (si la fila no existe, updateMany = no-op)
    const dec = Object.fromEntries(Object.entries(data).filter(([, v]) => v).map(([k, v]) => [k, { decrement: v }]));
    if (Object.keys(dec).length) {
      await prisma.playerSeasonStat.updateMany({ where: { playerId: pid, season, scope: fromScope }, data: dec });
    }
    // suma al acumulado nuevo (misma forma que accumulateSeason)
    await prisma.playerSeasonStat.upsert({
      where: { playerId_season_scope: { playerId: pid, season, scope: toScope } },
      create: { playerId: pid, season, scope: toScope, ...data },
      update: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { increment: v }])),
    });
  }
}

/**
 * Finaliza el juego: guarda decisiones (WP/LP/SV/HLD/empate) y
 * acumula las estadísticas de cada jugador en su temporada.
 */
r.post('/:id/finish', async (req, res) => {
  const gameId = req.params.id;
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  const { wpId, lpId, svId, hldIds, bsIds, tied } = req.body as {
    wpId?: string; lpId?: string; svId?: string; hldIds?: string[]; bsIds?: string[]; tied?: boolean;
  };
  const isTied = !!tied;
  const updated = await prisma.game.update({
    where: { id: gameId },
    data: {
      status: 'FINAL',
      endedAt: game.endedAt ?? new Date(),
      tied: isTied,
      wpId: isTied ? null : (wpId ?? null),
      lpId: isTied ? null : (lpId ?? null),
      svId: isTied ? null : (svId ?? null),
      hldIds: isTied ? null : JSON.stringify(hldIds ?? []),
      bsIds: isTied ? null : JSON.stringify(bsIds ?? []),
    },
  });
  await accumulateSeason(gameId);
  autoBackup('juego cerrado'); // respaldo a disco — no bloquea la respuesta
  res.json(updated);
});

/** Suspende el juego: se guarda tal cual para continuarlo después (lluvia, luz, etc.) */
r.post('/:id/suspend', async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  const updated = await prisma.game.update({
    where: { id: req.params.id },
    data: { status: 'SUSPENDED' }, // endedAt queda vacío: el reloj retoma al continuar
  });
  res.json(updated);
});

/**
 * Forfeit. Regla oficial: marcador = 1 carrera por entrada reglamentaria
 * (9-0 baseball, 7-0 softball) a favor del equipo perjudicado — salvo que ya
 * fuera ganando, en cuyo caso se conserva el marcador real. WP/LP solo si el
 * ganador por forfeit ya estaba arriba (sugerencia desde finish-data).
 * El score viene calculado/prefill por el cliente pero es editable manualmente.
 */
r.post('/:id/forfeit', async (req, res) => {
  const gameId = req.params.id;
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  const { forfeitBy, scoreAway, scoreHome, wpId, lpId, svId, hldIds, bsIds } = req.body as {
    forfeitBy?: string; scoreAway?: number; scoreHome?: number;
    wpId?: string; lpId?: string; svId?: string; hldIds?: string[]; bsIds?: string[];
  };
  if (!forfeitBy || scoreAway == null || scoreHome == null) {
    return res.status(400).json({ error: 'forfeitBy, scoreAway y scoreHome requeridos' });
  }
  const winnerAhead = (forfeitBy === game.awayTeamId && scoreHome > scoreAway)
    || (forfeitBy === game.homeTeamId && scoreAway > scoreHome);
  const updated = await prisma.game.update({
    where: { id: gameId },
    data: {
      status: 'FINAL',
      endedAt: game.endedAt ?? new Date(),
      forfeitBy,
      fScoreAway: scoreAway,
      fScoreHome: scoreHome,
      tied: scoreAway === scoreHome ? true : false,
      // por regla: solo hay decisiones si el ganador por forfeit ya iba arriba
      wpId: winnerAhead ? (wpId ?? null) : null,
      lpId: winnerAhead ? (lpId ?? null) : null,
      svId: winnerAhead ? (svId ?? null) : null,
      hldIds: winnerAhead ? JSON.stringify(hldIds ?? []) : null,
      bsIds: winnerAhead ? JSON.stringify(bsIds ?? []) : null,
    },
  });
  await accumulateSeason(gameId);
  res.json(updated);
});

/**
 * Cambia los lados home/away (menú Especial de BallScore). Las jugadas ya
 * anotadas se quedan con su equipo: se intercambian los teamId del juego y se
 * invierte la mitad (TOP↔BOTTOM) de todos los eventos → el replay reasigna
 * marcador, planillas y boxscore correctamente.
 */
r.post('/:id/swap-sides', async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  if (game.status === 'FINAL') return res.status(409).json({ error: 'El juego ya terminó' });
  await prisma.$transaction([
    prisma.game.update({
      where: { id: game.id },
      data: {
        awayTeamId: game.homeTeamId,
        homeTeamId: game.awayTeamId,
        fScoreAway: game.fScoreHome,
        fScoreHome: game.fScoreAway,
      },
    }),
    prisma.$executeRaw`UPDATE GameEvent SET half = IF(half = 'TOP', 'BOTTOM', 'TOP') WHERE gameId = ${game.id}`,
  ]);
  res.json(await prisma.game.findUnique({ where: { id: game.id } }));
});

/**
 * Tarjeta del jugador dentro del juego — estilo BallScore "Batting totals":
 * línea del juego actual + fildeo + splits situacionales + temporadas por año.
 */
r.get('/:id/card/:playerId', async (req, res) => {
  const { id, playerId } = req.params;
  const game = await prisma.game.findUnique({ where: { id }, include: { season: true } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: { team: true, seasons: { orderBy: { season: 'asc' } } },
  });
  if (!player) return res.status(404).json({ error: 'Jugador no encontrado' });
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
      situational: situ.away[playerId] ?? situ.home[playerId] ?? null,
    },
    // PlayerSeasonStat.adj = corrección manual del admin (delta): las stats de
    // liga la aplican sobre lo derivado — la tarjeta también, o la consulta
    // muestra el récord sin corregir (ej. G-P editado a mano sale "afectado")
    seasons: player.seasons.map((s) => {
      const a = (s.adj ?? null) as Record<string, number> | null;
      if (!a) return s;
      const out = { ...s } as Record<string, unknown>;
      for (const [k, v] of Object.entries(a)) {
        if (typeof v === 'number' && typeof out[k] === 'number') out[k] = (out[k] as number) + v;
      }
      return out;
    }),
    // fase y año del juego — el cliente elige la fila de temporada correcta
    // (un juego de playoff muestra el acumulado POST, nunca el REG)
    scope: game.seriesId ? 'POST' : 'REG',
    seasonYear: game.season?.year ?? new Date(game.date).getFullYear(),
    // entradas reglamentarias del juego → ERA = CL × innings×3 / outs
    // (la consulta usaba ×27 fijo y en ligas de 6-7 innings salía inflada)
    innings: game.innings,
  });
});

/**
 * Guarda la plantilla de alineación del equipo (Save Lineup de BallScore).
 * Vive bajo /games (rol anotador) — PUT /teams/:id exige admin y la plantilla
 * fallaba en silencio para anotadores con usuarios activados.
 */
/**
 * Plantillas de alineación del equipo ("Mis Alineaciones" — Save/Load Lineup).
 * El equipo puede tener VARIAS plantillas nombradas (una por pitcher, local/
 * visita, etc.) — cada una con su propio id; ya no se pisan entre sí.
 * En `Team.lineupTemplate` se guarda {v:2, items:[{id,name,at,entries}]};
 * el formato viejo (array de slots) se migra solo al leer.
 * body: {entries, name?, tplId?} → upsert · {deleteId} → borra · {renameId, name} → renombra
 */
interface TplSlot { playerId: string; position: string; batsInOrder?: boolean }
interface TplItem { id: string; name: string; at: number; entries: TplSlot[] }
const parseTpl = (raw: string | null | undefined): TplItem[] => {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return [{ id: 'legacy', name: 'Plantilla', at: 0, entries: j as TplSlot[] }];
    if (j && Array.isArray(j.items)) return j.items as TplItem[];
  } catch { /* formato corrupto → vacío */ }
  return [];
};
r.post('/:id/lineup-template/:teamId', async (req, res) => {
  const { entries, name, tplId, deleteId, renameId } = req.body as {
    entries?: TplSlot[]; name?: string; tplId?: string; deleteId?: string; renameId?: string;
  };
  const team = await prisma.team.findUnique({ where: { id: req.params.teamId }, select: { lineupTemplate: true } });
  if (!team) return res.status(404).json({ error: 'Equipo no encontrado' });
  const items = parseTpl(team.lineupTemplate);
  if (deleteId) {
    const next = items.filter((t) => t.id !== deleteId);
    await prisma.team.update({ where: { id: req.params.teamId }, data: { lineupTemplate: JSON.stringify({ v: 2, items: next }) } });
    return res.json({ ok: true, templates: next });
  }
  if (renameId) {
    const it = items.find((t) => t.id === renameId);
    if (!it || !name?.trim()) return res.status(400).json({ error: 'plantilla o nombre inválido' });
    it.name = name.trim().slice(0, 60);
    await prisma.team.update({ where: { id: req.params.teamId }, data: { lineupTemplate: JSON.stringify({ v: 2, items }) } });
    return res.json({ ok: true, templates: items });
  }
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'entries requerido' });
  const clean = entries.map((e) => ({ playerId: e.playerId, position: e.position, batsInOrder: e.batsInOrder !== false }));
  const id = tplId && items.some((t) => t.id === tplId) ? tplId : `tpl-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
  const item = items.find((t) => t.id === id);
  const entry = { id, name: (name?.trim() || item?.name || `Alineación ${items.length + 1}`).slice(0, 60), at: Date.now(), entries: clean };
  const next = item ? items.map((t) => (t.id === id ? entry : t)) : [...items, entry];
  await prisma.team.update({ where: { id: req.params.teamId }, data: { lineupTemplate: JSON.stringify({ v: 2, items: next }) } });
  res.json({ ok: true, templates: next, tplId: id });
});

/**
 * Reemplaza el lineup completo de un equipo en el juego.
 * Upsert por jugador sobre las filas ACTIVAS: un re-guardado a mitad de juego
 * conserva role/replacesId/subInInning de los suplentes que ya entraron y jamás
 * toca las filas OUT (historial de sustituciones) — antes el deleteMany las
 * borraba todas y la planilla perdía quién entró por quién.
 */
r.put('/:id/lineup/:teamId', async (req, res) => {
  const { id, teamId } = req.params;
  const entries = req.body.entries as { playerId: string; order: number; position: string; role?: string; batsInOrder?: boolean }[] | undefined;
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries requerido' });
  const existing = await prisma.lineupEntry.findMany({ where: { gameId: id, teamId, active: true } });
  const byPlayer = new Map(existing.map((l) => [l.playerId, l]));
  const keepIds: string[] = [];
  const ops = entries.map((e) => {
    const cur = byPlayer.get(e.playerId);
    if (cur) {
      keepIds.push(cur.id);
      return prisma.lineupEntry.update({
        where: { id: cur.id },
        data: { order: e.order, position: e.position, batsInOrder: e.batsInOrder ?? true },
      });
    }
    return prisma.lineupEntry.create({
      data: {
        gameId: id, teamId, playerId: e.playerId, order: e.order,
        position: e.position, role: e.role ?? 'STARTER',
        batsInOrder: e.batsInOrder ?? true,
      },
    });
  });
  await prisma.$transaction([
    prisma.lineupEntry.deleteMany({ where: { gameId: id, teamId, active: true, id: { notIn: keepIds } } }),
    ...ops,
  ]);
  const lineups = await prisma.lineupEntry.findMany({ where: { gameId: id }, include: { player: true }, orderBy: { order: 'asc' } });
  res.json(lineups);
});

/**
 * Agrega UN jugador al final del orden de bateo sin tocar el resto de la
 * alineación — modo "anotar sin lineup" (armar el orden bateador a bateador).
 * body: { playerId, position? } — order = siguiente turno libre (<50).
 * Si ya está activo devuelve su entrada (idempotente: el anotador puede tocar
 * dos veces el mismo nombre sin crear duplicados).
 */
r.post('/:id/lineup-add/:teamId', async (req, res) => {
  const { playerId, position } = req.body as { playerId?: string; position?: string };
  if (!playerId) return res.status(400).json({ error: 'playerId requerido' });
  const { id, teamId } = req.params;
  const existing = await prisma.lineupEntry.findFirst({
    where: { gameId: id, teamId, playerId, active: true },
  });
  if (existing) return res.json(existing);
  const last = await prisma.lineupEntry.findFirst({
    where: { gameId: id, teamId, order: { lt: 50 } },
    orderBy: { order: 'desc' },
  });
  const entry = await prisma.lineupEntry.create({
    data: {
      gameId: id, teamId, playerId,
      order: (last?.order ?? 0) + 1,
      position: position ?? 'EH',
      role: 'STARTER', batsInOrder: true,
    },
    include: { player: true },
  });
  res.status(201).json(entry);
});

/**
 * Sustitución en juego: el jugador saliente queda OUT/inactivo y el entrante
 * toma su mismo lugar en el orden de bateo (con su propio id y stats).
 */
r.post('/:id/substitute', async (req, res) => {
  const { teamId, outPlayerId, inPlayerId, position, subInInning, subInHalf } = req.body;
  if (!teamId || !outPlayerId || !inPlayerId) {
    return res.status(400).json({ error: 'teamId, outPlayerId, inPlayerId requeridos' });
  }
  const oldEntry = await prisma.lineupEntry.findFirst({
    where: { gameId: req.params.id, teamId, playerId: outPlayerId, active: true },
  });
  if (!oldEntry) return res.status(404).json({ error: 'Jugador saliente no está en la alineación activa' });

  // marca estilo hoja manual: en qué entrada/mitad entró el sustituto
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  const state = reduceGame(await loadEvents(req.params.id), game?.innings ?? 9);

  // reingreso (softball): el entrante ya estuvo en el juego y salió
  const prevOut = await prisma.lineupEntry.findFirst({
    where: { gameId: req.params.id, teamId, playerId: inPlayerId, active: false },
  });
  // regla: solo se reingresa UNA vez por juego — si ya tuvo una entrada REIN
  // (salió, volvió y salió otra vez) no puede entrar de nuevo
  if (prevOut) {
    const alreadyRein = await prisma.lineupEntry.findFirst({
      where: { gameId: req.params.id, teamId, playerId: inPlayerId, role: 'REIN' },
    });
    if (alreadyRein) {
      return res.status(409).json({ error: 'Este jugador ya reingresó una vez — la regla solo permite un reingreso por juego' });
    }
  }
  const role = prevOut ? 'REIN' : 'SUB';

  const [, sub] = await prisma.$transaction([
    prisma.lineupEntry.update({
      where: { id: oldEntry.id },
      data: { active: false, role: 'OUT' },
    }),
    prisma.lineupEntry.create({
      data: {
        gameId: req.params.id, teamId, playerId: inPlayerId,
        order: oldEntry.order,
        position: position ?? oldEntry.position,
        batsInOrder: oldEntry.batsInOrder,
        role, replacesId: oldEntry.id,
        // en "anotación al vuelo" el cliente manda la entrada/mitad de la hoja que transcribe
        subInInning: Number.isInteger(subInInning) ? subInInning : state.inning,
        subInHalf: (subInHalf === 'TOP' || subInHalf === 'BOTTOM') ? subInHalf : state.half,
      },
      include: { player: true },
    }),
  ]);
  res.status(201).json(sub);
});

/**
 * Deshacer sustitución: borra la entrada del entrante (SUB/REIN) y reactiva
 * la del saliente restaurando su rol anterior (STARTER si era titular; REIN
 * si era un reingreso del mismo jugador; SUB si había entrado por otro).
 * Las jugadas ya grabadas quedan con el jugador que las hizo (historia real);
 * solo se revierte el cambio de lineup — por si fue un error de dedo.
 * body: { entryId } — el id del LineupEntry del que ENTRÓ (el que se borra).
 */
r.post('/:id/undo-sub', async (req, res) => {
  const { entryId } = req.body as { entryId?: string };
  if (!entryId) return res.status(400).json({ error: 'entryId requerido' });
  const sub = await prisma.lineupEntry.findUnique({ where: { id: entryId } });
  if (!sub || sub.gameId !== req.params.id || (sub.role !== 'SUB' && sub.role !== 'REIN') || !sub.replacesId) {
    return res.status(404).json({ error: 'Esa entrada no es una sustitución (o ya se deshizo)' });
  }
  // no se puede deshacer un eslabón del medio: si el entrante también salió
  // reemplazado, hay que deshacer primero el último cambio
  const next = await prisma.lineupEntry.findFirst({ where: { replacesId: sub.id } });
  if (next) return res.status(409).json({ error: 'Este jugador también salió sustituido — deshaz primero el último cambio' });
  const out = await prisma.lineupEntry.findUnique({ where: { id: sub.replacesId } });
  if (!out) return res.status(404).json({ error: 'La entrada original ya no existe' });

  // rol anterior del saliente: sin replacesId era titular; si el suyo era del
  // mismo jugador era REIN (reingreso); si era de otro jugador era SUB
  let prevRole: 'STARTER' | 'SUB' | 'REIN' = 'STARTER';
  if (out.replacesId) {
    const pred = await prisma.lineupEntry.findUnique({ where: { id: out.replacesId } });
    prevRole = pred?.playerId === out.playerId ? 'REIN' : 'SUB';
  }
  await prisma.$transaction([
    prisma.lineupEntry.delete({ where: { id: sub.id } }),
    prisma.lineupEntry.update({ where: { id: out.id }, data: { active: true, role: prevRole } }),
  ]);
  const lineups = await prisma.lineupEntry.findMany({
    where: { gameId: req.params.id }, include: { player: true }, orderBy: { order: 'asc' },
  });
  res.json({ ok: true, restored: out.playerId, role: prevRole, lineups });
});

/**
 * Cambio de posiciones defensivas en juego (el "Defensa actual" de BallScore):
 * actualiza la posición de las entradas activas del lineup; los créditos de
 * fildeo se resuelven por posición al crear cada evento, así que el historial
 * no se altera.
 */
r.put('/:id/positions/:teamId', async (req, res) => {
  const { id, teamId } = req.params;
  const entries = req.body.entries as { playerId: string; position: string }[];
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries requerido' });
  const byPlayer = new Map(entries.map((e) => [e.playerId, e.position]));
  const actives = await prisma.lineupEntry.findMany({ where: { gameId: id, teamId, active: true } });
  await prisma.$transaction(
    actives
      .filter((l) => byPlayer.has(l.playerId) && byPlayer.get(l.playerId) !== l.position)
      .map((l) => prisma.lineupEntry.update({ where: { id: l.id }, data: { position: byPlayer.get(l.playerId)! } })),
  );
  const lineups = await prisma.lineupEntry.findMany({
    where: { gameId: id }, include: { player: true }, orderBy: { order: 'asc' },
  });
  res.json(lineups);
});

/**
 * Corrección de identidad en juego iniciado: el anotador puso al jugador
 * EQUIVOCADO en el lineup (ej. anotó a Pedro pero quien bateaba era Luis).
 * Reasigna TODO lo que ya se grabó con ese nombre: entradas del lineup,
 * batterId/pitcherId de eventos, avances de base (queda en base si estaba),
 * créditos de fildeo (putouts/assists/errorOn) y decisiones W/L/SV/HLD/BS.
 * Si el jugador correcto YA está en el lineup → intercambio completo (swap)
 * entre ambos: sus jugadas y casillas se cruzan.
 * body: { teamId, aId (el que está de más), bId (el correcto) }
 */
r.post('/:id/swap-player', async (req, res) => {
  const u = await reqUser(req);
  const open = !(await authEnabled());
  if (!open && u?.role !== 'admin') return res.status(403).json({ error: 'Requiere rol admin' });
  const { teamId, aId, bId } = req.body as { teamId?: string; aId?: string; bId?: string };
  if (!teamId || !aId || !bId) return res.status(400).json({ error: 'teamId, aId, bId requeridos' });
  if (aId === bId) return res.status(400).json({ error: 'Es el mismo jugador' });
  // misma cola que POST/PUT de eventos — un reemapeo no se intercala con una jugada
  return enqueue(req.params.id, async () => {
  const game = await prisma.game.findUnique({
    where: { id: req.params.id }, include: { lineups: true, season: true },
  });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  const newP = await prisma.player.findUnique({ where: { id: bId } });
  if (!newP) return res.status(404).json({ error: 'El jugador correcto no existe' });
  const aEntries = await prisma.lineupEntry.findMany({
    where: { gameId: req.params.id, teamId, playerId: aId },
  });
  // juego importado sin lineup: el "erróneo" puede vivir solo en Game.statLines
  const lines = (game.statLines ?? []) as { playerId?: string; teamId?: string | null }[];
  const aInLines = lines.some((l) => l.playerId === aId && l.teamId === teamId);
  // o solo en los eventos: un lanzador que entró con PC no tiene fila de lineup —
  // sin este camino no se podía corregir "me equivoqué de lanzador"
  const aInEvents = !aEntries.length && !aInLines && !!(await prisma.gameEvent.findFirst({
    where: {
      gameId: req.params.id,
      OR: [
        { pitcherId: aId, half: teamId === game.homeTeamId ? 'TOP' : 'BOTTOM' },
        { batterId: aId, half: teamId === game.awayTeamId ? 'TOP' : 'BOTTOM' },
      ],
    },
    select: { id: true },
  }));
  if (!aEntries.length && !aInLines && !aInEvents) return res.status(404).json({ error: 'Ese jugador no está en la alineación de este equipo' });
  const bEntries = await prisma.lineupEntry.findMany({
    where: { gameId: req.params.id, teamId, playerId: bId },
  });

  const swapId = (x: string | null | undefined) => (x === aId ? bId! : x === bId ? aId : x ?? null);
  const swapJsonIds = (s: string | null) => {
    if (!s) return s;
    try { return JSON.stringify((JSON.parse(s) as string[]).map((x) => swapId(x))); } catch { return s; }
  };

  const ops: Prisma.PrismaPromise<unknown>[] = [
    ...aEntries.map((e) => prisma.lineupEntry.update({ where: { id: e.id }, data: { playerId: bId } })),
    ...bEntries.map((e) => prisma.lineupEntry.update({ where: { id: e.id }, data: { playerId: aId } })),
  ];

  // eventos grabados: bateador, lanzador, avances y créditos de fildeo
  let evFixed = 0;
  const evs = await prisma.gameEvent.findMany({ where: { gameId: req.params.id } });
  for (const e of evs) {
    const nBatter = swapId(e.batterId);
    const nPitcher = swapId(e.pitcherId);
    const adv = (e.advances as { playerId?: string; to: number }[] | null) ?? [];
    const nAdv = adv.map((a) => (a?.playerId ? { ...a, playerId: swapId(a.playerId)! } : a));
    const nErr = swapJsonIds(e.errorOn), nPut = swapJsonIds(e.putouts), nAst = swapJsonIds(e.assists);
    if (nBatter !== (e.batterId ?? null) || nPitcher !== (e.pitcherId ?? null)
      || JSON.stringify(nAdv) !== JSON.stringify(adv)
      || nErr !== e.errorOn || nPut !== e.putouts || nAst !== e.assists) {
      evFixed++;
      ops.push(prisma.gameEvent.update({
        where: { id: e.id },
        data: { batterId: nBatter, pitcherId: nPitcher, advances: nAdv, errorOn: nErr, putouts: nPut, assists: nAst },
      }));
    }
  }

  // decisiones si el juego ya cerró
  const gUpd: Record<string, unknown> = {};
  for (const k of ['wpId', 'lpId', 'svId'] as const) {
    if (game[k] === aId || game[k] === bId) gUpd[k] = swapId(game[k]);
  }
  for (const k of ['hldIds', 'bsIds'] as const) {
    const n = swapJsonIds(game[k]);
    if (n !== game[k]) gUpd[k] = n;
  }
  // líneas importadas/manuales (Game.statLines): el mismo cruce a↔b que en eventos —
  // sin esto la corrección era invisible en juegos sin stream de jugadas
  const nLines = lines.map((l) => (l.playerId ? { ...l, playerId: swapId(l.playerId)! } : l));
  if (JSON.stringify(nLines) !== JSON.stringify(lines)) {
    gUpd.statLines = JSON.parse(JSON.stringify(nLines));
    evFixed += 1;
  }
  if (Object.keys(gUpd).length) ops.push(prisma.game.update({ where: { id: game.id }, data: gUpd }));

  // juego ya cerrado: el cruce también debe moverse en PlayerSeasonStat —
  // sin esto los acumulados de temporada quedaban en el jugador equivocado
  // (el boxscore y las tablas de liga recalculan, la ficha del jugador no)
  const needResync = game.status === 'FINAL' || game.seasonApplied;
  const before = needResync ? await gameContrib(game) : null;
  await prisma.$transaction(ops);
  if (before) {
    const fresh = await prisma.game.findUnique({
      where: { id: game.id }, include: { lineups: true, season: true },
    });
    if (fresh) await applySeasonDelta(fresh, before, await gameContrib(fresh));
  }
  const lineups = await prisma.lineupEntry.findMany({
    where: { gameId: req.params.id }, include: { player: true }, orderBy: { order: 'asc' },
  });
  res.json({ ok: true, swapped: bEntries.length > 0, eventsFixed: evFixed, lineups });
  });
});

/**
 * Alt-drag en la hoja de anotación ("Desplazar turno"): mover un bateador CON
 * sus anotaciones a otra casilla — los dos intercambian su `order`. A
 * diferencia de swap-player (que cruza los IDs y las marcas quedan en la
 * casilla), aquí la planilla dibuja cada jugada en la casilla del ORDER
 * ACTUAL del bateador: con solo intercambiar `order` las marcas de cada uno
 * se redibujan en su casilla nueva. NO se tocan los `seq` — el juggling de
 * secuencias de la versión anterior desconfiguraba el orden al bate (los
 * turnos sobrantes del que tenía más PAs quedaban con seqs viejos y el
 * siguiente bateador saltaba/duplicaba).
 * body: { teamId, aId, bId } — ambos ya deben estar en el lineup.
 */
r.post('/:id/swap-order', async (req, res) => {
  const { teamId, aId, bId } = req.body as { teamId?: string; aId?: string; bId?: string };
  if (!teamId || !aId || !bId) return res.status(400).json({ error: 'teamId, aId, bId requeridos' });
  if (aId === bId) return res.status(400).json({ error: 'Es el mismo jugador' });
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });

  // las entradas visibles en la hoja (la activa del turno, o cualquiera si no hay activa)
  const aE = await prisma.lineupEntry.findFirst({ where: { gameId: game.id, teamId, playerId: aId, active: true } })
    ?? await prisma.lineupEntry.findFirst({ where: { gameId: game.id, teamId, playerId: aId } });
  const bE = await prisma.lineupEntry.findFirst({ where: { gameId: game.id, teamId, playerId: bId, active: true } })
    ?? await prisma.lineupEntry.findFirst({ where: { gameId: game.id, teamId, playerId: bId } });
  if (!aE || !bE) return res.status(404).json({ error: 'Ambos jugadores deben estar en la alineación' });

  await prisma.$transaction([
    prisma.lineupEntry.update({ where: { id: aE.id }, data: { order: bE.order } }),
    prisma.lineupEntry.update({ where: { id: bE.id }, data: { order: aE.order } }),
  ]);
  const lineups = await prisma.lineupEntry.findMany({
    where: { gameId: game.id }, include: { player: true }, orderBy: { order: 'asc' },
  });
  res.json({ ok: true, pasMoved: 0, lineups });
});

// Decisiones del juego (solo admin — el módulo 🛡 las corrige post-cierre):
// ganador/perdedor/juego salvado/holds/blown, empate y marcador forfeit.
// Si el juego ya acumuló temporada, resincroniza W/L/SV/HLD/BS por delta —
// un empate corregido a ganado deja de contar como empate en TODO el sistema.
r.put('/:id/decisions', async (req, res) => {
  const u = await reqUser(req);
  const open = !(await authEnabled());
  if (!open && u?.role !== 'admin') return res.status(403).json({ error: 'Requiere rol admin' });
  const { wpId, lpId, svId, hldIds, bsIds, tied, forfeitBy, fScoreAway, fScoreHome } = req.body as {
    wpId?: string | null; lpId?: string | null; svId?: string | null;
    hldIds?: string[] | null; bsIds?: string[] | null; tied?: boolean;
    forfeitBy?: string | null; fScoreAway?: number | null; fScoreHome?: number | null;
  };
  const gameId = req.params.id;
  return enqueue(gameId, async () => {
    const prev = await prisma.game.findUnique({ where: { id: gameId }, include: { lineups: true, season: true } });
    if (!prev) return res.status(404).json({ error: 'Juego no encontrado' });
    const data = {
      wpId: wpId === undefined ? undefined : wpId,
      lpId: lpId === undefined ? undefined : lpId,
      svId: svId === undefined ? undefined : svId,
      hldIds: hldIds === undefined ? undefined : (hldIds?.length ? JSON.stringify(hldIds) : null),
      bsIds: bsIds === undefined ? undefined : (bsIds?.length ? JSON.stringify(bsIds) : null),
      tied: tied === undefined ? undefined : !!tied,
      forfeitBy: forfeitBy === undefined ? undefined : forfeitBy,
      fScoreAway: fScoreAway === undefined ? undefined : fScoreAway,
      fScoreHome: fScoreHome === undefined ? undefined : fScoreHome,
    };
    // contribución previa solo si hay que resincronizar (juego ya cerrado)
    const before = (prev.status === 'FINAL' || prev.seasonApplied) ? await gameContrib(prev) : null;
    const game = await prisma.game.update({ where: { id: gameId }, data });
    if (before) {
      const after = await gameContrib({ ...prev, ...game } as typeof prev);
      await applySeasonDelta(prev, before, after);
      if (!prev.seasonApplied) {
        await prisma.game.update({ where: { id: gameId }, data: { seasonApplied: true } });
      }
    }
    res.json(game);
  });
});

/**
 * Línea manual de stats (módulo admin): "jugador que estuvo y no se anotó".
 * PUT establece la línea del jugador en Game.statLines — el agregador de liga/
 * website la SUMA sobre lo que den los eventos, igual que una línea importada.
 * Opcionalmente lo inserta en la alineación (lineup.add).
 * `g` = 1 solo si no participó por eventos/lineup (evita doble conteo de juegos).
 * Si el juego ya acumuló temporada (seasonApplied) ajusta PlayerSeasonStat por
 * la delta (nueva − anterior); si aún no, accumulateSeason la recoge al cerrar.
 */
r.put('/:id/stat-lines/:playerId', async (req, res) => {
  const u = await reqUser(req);
  const open = !(await authEnabled());
  if (!open && u?.role !== 'admin') return res.status(403).json({ error: 'Requiere rol admin' });
  const gameId = req.params.id, playerId = req.params.playerId;
  const { teamId, stats, lineup } = req.body as {
    teamId?: string;
    stats?: Record<string, unknown>;
    lineup?: { add?: boolean; order?: number; position?: string; role?: string };
  };
  return enqueue(gameId, async () => {
    const game = await prisma.game.findUnique({
      where: { id: gameId }, include: { lineups: true, season: true },
    });
    if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
    const player = await prisma.player.findUnique({ where: { id: playerId } });
    if (!player) return res.status(404).json({ error: 'Jugador no existe' });
    const tid = teamId ?? game.lineups.find((l) => l.playerId === playerId)?.teamId ?? null;
    if (tid && tid !== game.awayTeamId && tid !== game.homeTeamId)
      return res.status(400).json({ error: 'El equipo no es de este juego' });

    // números limpios: solo campos conocidos, enteros/decimales ≥ 0; `ip` decimal → outs
    const clean: Record<string, number> = {};
    for (const k of SL_NUMS) {
      if (stats && k in stats) {
        const v = Number(stats[k]);
        if (!Number.isFinite(v) || v < 0)
          return res.status(400).json({ error: `${k}: número inválido` });
        if (v) clean[k] = v;
      }
    }
    if (stats && 'ip' in stats) {
      const ip = Number(stats.ip);
      if (!Number.isFinite(ip) || ip < 0) return res.status(400).json({ error: 'ip: número inválido' });
      if (ip) clean.pOuts = Math.floor(ip) * 3 + Math.round((ip % 1) * 10);
    }

    const lines = (game.statLines ?? []) as unknown as StatLine[];
    const prev = mergeLines(lines.filter((l) => l.playerId === playerId));
    const others = lines.filter((l) => l.playerId !== playerId);

    // ¿ya participó? (alineación o cualquier referencia en el stream) → g = 0
    const evs = await prisma.gameEvent.findMany({
      where: { gameId },
      select: { batterId: true, pitcherId: true, advances: true, errorOn: true, putouts: true, assists: true },
    });
    const inLineup = game.lineups.some((l) => l.playerId === playerId);
    const inEvents = evs.some((e) =>
      e.batterId === playerId || e.pitcherId === playerId ||
      JSON.stringify(e.advances ?? '').includes(playerId) ||
      (e.errorOn ?? '').includes(playerId) || (e.putouts ?? '').includes(playerId) ||
      (e.assists ?? '').includes(playerId));
    const gFlag = inLineup || inEvents ? 0 : 1;

    const hasStats = Object.keys(clean).length > 0;
    const newline: StatLine | undefined = hasStats || gFlag
      ? { playerId, teamId: tid, g: gFlag, ...clean }
      : undefined;
    const nextLines = newline ? [...others, newline] : others;
    await prisma.game.update({
      where: { id: gameId },
      data: { statLines: JSON.parse(JSON.stringify(nextLines)) },
    });

    // insertar en la alineación (jugador olvidado por el anotador)
    let lineupAdded = false;
    if (lineup?.add && tid && !inLineup) {
      if (!lineup.position) return res.status(400).json({ error: 'Falta la posición para agregarlo al lineup' });
      const maxOrder = game.lineups.filter((l) => l.teamId === tid).reduce((m, l) => Math.max(m, l.order), 0);
      await prisma.lineupEntry.create({
        data: {
          gameId, teamId: tid, playerId,
          order: lineup.order && lineup.order > 0 ? lineup.order : maxOrder + 1,
          position: lineup.position, role: lineup.role ?? 'SUB', active: true,
        },
      });
      lineupAdded = true;
    }

    // temporada: delta (nueva − previa) cuando el juego ya terminó (status FINAL
    // — por la vía que fuera, su acumulado ya corrió; juegos viejos sin flag
    // también quedan consistentes). Si aún está vivo, accumulateSeason recoge
    // la línea al finalizar — no duplicar.
    let seasonAdjusted = false;
    if (game.status === 'FINAL' || game.seasonApplied) {
      const season = game.season?.year ?? new Date(game.date).getFullYear();
      const scope = game.seriesId ? 'POST' : 'REG';
      const delta: Record<string, number> = {};
      const merged = newline;
      for (const k of SEASON_KEYS) {
        const d = ((merged?.[k] ?? 0) - (prev?.[k] ?? 0));
        if (d) delta[k] = d;
      }
      if (Object.keys(delta).length) {
        await prisma.playerSeasonStat.upsert({
          where: { playerId_season_scope: { playerId, season, scope } },
          create: { playerId, season, scope, ...delta },
          update: Object.fromEntries(Object.entries(delta).map(([k, v]) => [k, { increment: v }])),
        });
        seasonAdjusted = true;
      }
    }

    const lineups = await prisma.lineupEntry.findMany({
      where: { gameId }, include: { player: true }, orderBy: { order: 'asc' },
    });
    res.json({ ok: true, line: newline, statLines: nextLines, lineupAdded, seasonAdjusted, lineups });
  });
});

/** Quita la línea manual del jugador (y opcionalmente su entrada de lineup, ?lineup=1). */
r.delete('/:id/stat-lines/:playerId', async (req, res) => {
  const u = await reqUser(req);
  const open = !(await authEnabled());
  if (!open && u?.role !== 'admin') return res.status(403).json({ error: 'Requiere rol admin' });
  const gameId = req.params.id, playerId = req.params.playerId;
  return enqueue(gameId, async () => {
    const game = await prisma.game.findUnique({ where: { id: gameId }, include: { lineups: true, season: true } });
    if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
    const lines = (game.statLines ?? []) as unknown as StatLine[];
    const prev = mergeLines(lines.filter((l) => l.playerId === playerId));
    if (!prev) return res.status(404).json({ error: 'El jugador no tiene línea manual en este juego' });
    const nextLines = lines.filter((l) => l.playerId !== playerId);
    await prisma.game.update({
      where: { id: gameId },
      data: { statLines: nextLines.length ? JSON.parse(JSON.stringify(nextLines)) : Prisma.DbNull },
    });
    if (req.query.lineup === '1') {
      await prisma.lineupEntry.deleteMany({ where: { gameId, playerId } });
    }
    if (game.status === 'FINAL' || game.seasonApplied) {
      const season = game.season?.year ?? new Date(game.date).getFullYear();
      const scope = game.seriesId ? 'POST' : 'REG';
      const delta: Record<string, number> = {};
      for (const k of SEASON_KEYS) { const v = prev[k]; if (v) delta[k] = -v; }
      if (Object.keys(delta).length) {
        await prisma.playerSeasonStat.upsert({
          where: { playerId_season_scope: { playerId, season, scope } },
          create: { playerId, season, scope, ...delta },
          update: Object.fromEntries(Object.entries(delta).map(([k, v]) => [k, { increment: v }])),
        });
      }
    }
    res.json({ ok: true, statLines: nextLines });
  });
});

// Borrar juego exige la clave de admin en el body {password} (estilo macOS).
r.delete('/:id', async (req, res) => {
  const auth = await adminOk(String(req.body?.password ?? ''));
  if (!auth.ok) return res.status(auth.code ?? 401).json({ error: auth.error });
  const game = await prisma.game.findUnique({
    where: { id: req.params.id },
    include: { lineups: true, season: true },
  });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  // si el juego ya acumuló temporada, su contribución se revierte al borrar
  // (mismo patrón que assignGameSeries — sin esto quedan stats fantasma)
  if (game.seasonApplied) {
    const scope = game.seriesId ? 'POST' : 'REG';
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

export default r;
