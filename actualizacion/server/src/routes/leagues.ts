import { Router } from 'express';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { applyEvent, computeBoxscore, computeCgSho, HITS, initialState, isMidResult, NON_AB, reduceGame } from '@poxscore/shared';
import { loadEvents, markDoubleheaders, assignGameSeries } from './games.js';
import { adminOk } from '../auth.js';
import { autoBackup } from '../backup-lib.js';
import { websiteHtml } from '../website.js';

const r = Router();

// ---- Ligas / torneos ----
r.get('/', async (_req, res) => {
  const leagues = await prisma.league.findMany({
    orderBy: [{ year: 'desc' }, { name: 'asc' }],
    include: {
      seasons: { orderBy: { year: 'desc' } },
      _count: { select: { teams: true, games: true } },
    },
  });
  res.json(leagues);
});

r.post('/', async (req, res) => {
  const { name, year, sport } = req.body;
  if (!name) return res.status(400).json({ error: 'name requerido' });
  const y = year ? Number(year) : null;
  const league = await prisma.league.create({
    data: { name, year: y ?? new Date().getFullYear(), sport: sport ?? 'baseball' },
  });
  // si se pasa año → crea la primera temporada de una vez (compat con el flujo anterior)
  if (y) await prisma.season.create({ data: { leagueId: league.id, year: y } }).catch(() => {});
  res.status(201).json(league);
});

r.get('/:id', async (req, res) => {
  const league = await prisma.league.findUnique({
    where: { id: req.params.id },
    include: {
      teams: { orderBy: { name: 'asc' }, include: { _count: { select: { players: true } } } },
      seasons: { orderBy: { year: 'desc' } },
      games: {
        orderBy: { date: 'asc' },
        include: {
          homeTeam: true, awayTeam: true,
          events: { orderBy: { seq: 'asc' } },
        },
      },
    },
  });
  if (!league) return res.status(404).json({ error: 'Liga no encontrada' });
  // marcador por juego (reduceGame sobre los eventos; forfeit usa el override)
  const games = league.games.map((g) => {
    const evs = g.events.map((e) => ({
      seq: e.seq, inning: e.inning, half: e.half as 'TOP' | 'BOTTOM',
      batterId: e.batterId, pitcherId: e.pitcherId,
      result: e.result as never, notation: e.notation,
      errorOn: e.errorOn ? JSON.parse(e.errorOn) : undefined,
      advances: e.advances as never,
    }));
    const state = reduceGame(evs, g.innings);
    if ((!evs.length || g.forfeitBy) && g.fScoreAway != null && g.fScoreHome != null) state.score = { away: g.fScoreAway, home: g.fScoreHome };
    const { events: _e, ...rest } = g;
    return { ...rest, state };
  });
  res.json({ ...league, games: markDoubleheaders(games) });
});

r.put('/:id', async (req, res) => {
  const { name, year, sport, qualPa, qualIp, playoffTeams, playoffRounds, innings, tb, sprayInput, wpMinOuts } = req.body;
  const league = await prisma.league.update({
    where: { id: req.params.id },
    data: {
      name, year: year != null ? Number(year) : undefined, sport,
      innings: innings !== undefined ? (innings === null || innings === '' || Number(innings) <= 0 ? null : Number(innings)) : undefined,
      qualPa: qualPa != null ? Number(qualPa) : undefined,
      qualIp: qualIp != null ? Number(qualIp) : undefined,
      playoffTeams: playoffTeams !== undefined ? (playoffTeams === null ? null : Number(playoffTeams)) : undefined,
      playoffRounds: playoffRounds !== undefined ? (playoffRounds === null ? null : Number(playoffRounds)) : undefined,
      tb: tb === 'pct' || tb === 'h2h' || tb === 'diff' ? tb : undefined,
      sprayInput: typeof sprayInput === 'boolean' ? sprayInput : undefined,
      wpMinOuts: wpMinOuts !== undefined ? (wpMinOuts === null || wpMinOuts === '' || Number(wpMinOuts) <= 0 ? null : Number(wpMinOuts)) : undefined,
    },
  });
  res.json(league);
});

// Borrar liga exige la clave de admin (la contraseña de un usuario admin).
// Se acepta POST y DELETE — ambos reciben {password} en el body.
const deleteLeagueHandler = async (req: Request, res: Response) => {
  const auth = await adminOk(String(req.body?.password ?? ''));
  if (!auth.ok) return res.status(auth.code ?? 401).json({ error: auth.error });
  // cascada real: Game/Team tienen onDelete:SetNull — hay que borrar el árbol
  const leagueId = req.params.id;
  await autoBackup('antes de borrar liga');
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
  await prisma.league.delete({ where: { id: leagueId } }); // seasons: onDelete Cascade
  res.status(204).end();
};
r.post('/:id/delete', deleteLeagueHandler);
r.delete('/:id', deleteLeagueHandler);

// ---- Calendario: generador por jornadas (normal MLB | triangular softball) ----
/**
 * POST /leagues/:id/schedule
 * {
 *   startDate?      'YYYY-MM-DD'  — fecha de la 1ª jornada (default: hoy)
 *   mode?           'normal' | 'triangular'  — triangular: home club rotativo por
 *                   jornada que recibe a 1-2 visitantes (softball de 3 equipos)
 *   playDays?       number[]      — días de la semana que se juega (0=Dom…6=Sáb);
 *                   las fechas saltan de uno a otro (los demás días = libres)
 *   daysBetween?    number        — compat: cada N días si no hay playDays
 *   rounds?         number        — vueltas completas (normal) / ciclos (triangular)
 *   seriesLen?      number        — juegos por serie seguidos en el mismo home (MLB)
 *   doubleheader?   boolean       — doble jornada: 2 juegos del mismo pareo el mismo día
 *   seriesStyle?    'ida-vuelta' | 'random' — ida y vuelta alterna localía | balanceada
 *   divRounds?      number        — vueltas extra solo dentro de la misma división
 *   firstHomeId?    string        — home club del primer día (ambos modos)
 *   firstAwayId?    string        — visitante del primer día (lo pareamos con el home)
 *   endDate?        'YYYY-MM-DD'  — última fecha del torneo: no se programan
 *                   jornadas después de ella (si se da sin rounds, se llena el rango)
 *   gamesPerDay?    number        — triangular: visitantes que recibe el home club (1-2)
 * }
 */
r.post('/:id/schedule', async (req, res) => {
  const league = await prisma.league.findUnique({
    where: { id: req.params.id },
    include: { teams: { orderBy: { createdAt: 'asc' } } },
  });
  if (!league) return res.status(404).json({ error: 'Liga no encontrada' });
  const body = req.body as {
    startDate?: string; mode?: 'normal' | 'triangular'; playDays?: number[];
    daysBetween?: number; rounds?: number; seriesLen?: number; doubleheader?: boolean;
    seriesStyle?: 'ida-vuelta' | 'random'; divRounds?: number; firstHomeId?: string;
    firstAwayId?: string; endDate?: string; gamesPerDay?: number;
  };
  const teams = league.teams;
  if (teams.length < 2) return res.status(400).json({ error: 'Se necesitan al menos 2 equipos' });
  const sport = league.sport;
  const innings = league.innings ?? (sport === 'softball' ? 7 : 9);
  const activeSeason = await prisma.season.findFirst({ where: { leagueId: league.id, status: 'ACTIVE' } });

  // ---- fechas de jornada: camina por los días de la semana elegidos ----
  const playDays = (body.playDays ?? []).filter((d) => d >= 0 && d <= 6);
  const daysBetween = Math.max(1, Number(body.daysBetween) || 7);
  let cursor = body.startDate ? new Date(`${body.startDate}T18:00:00`) : new Date();
  if (playDays.length) while (!playDays.includes(cursor.getDay())) cursor = new Date(cursor.getTime() + 86400000);
  const nextDate = () => {
    const d = cursor;
    do { cursor = new Date(cursor.getTime() + 86400000); }
    while (playDays.length ? !playDays.includes(cursor.getDay()) : false);
    if (!playDays.length) cursor = new Date(d.getTime() + daysBetween * 86400000);
    return d;
  };

  const data: Prisma.GameCreateManyInput[] = [];
  const gameAt = (date: Date, slot: number, away: string, home: string, note?: string) =>
    data.push({
      leagueId: league.id, sport, innings, status: 'SCHEDULED', seasonId: activeSeason?.id ?? null,
      awayTeamId: away, homeTeamId: home, date: new Date(date.getTime() + slot * 2 * 3600000),
      ...(note ? { note } : {}),
    });
  const firstHomeId = body.firstHomeId && teams.some((t) => t.id === body.firstHomeId) ? body.firstHomeId : undefined;
  const firstAwayId = body.firstAwayId && teams.some((t) => t.id === body.firstAwayId) && body.firstAwayId !== firstHomeId
    ? body.firstAwayId : undefined;
  // fecha de cierre del torneo: ninguna jornada se programa después de ella;
  // si el usuario da rango en vez de vueltas, generamos hasta que se acabe el calendario
  const end = body.endDate ? new Date(`${body.endDate}T23:59:59`) : null;
  const rounds = Math.max(1, Math.round(body.rounds ?? (end ? 99 : 2)));
  const dh = !!body.doubleheader; // doble jornada: cada pareo juega 2 el mismo día
  const mode = body.mode ?? 'normal';
  const MAX_JORNADAS = 400; // candado de seguridad con endDate

  if (mode === 'triangular') {
    /* Softball triangular: cada jornada un equipo es HOME CLUB y recibe a
     * `gamesPerDay` visitantes (día 1 lo elige el usuario). El home club rota
     * cada jornada (nadie repite dos días seguidos) y los pareos se eligen por
     * el que menos se ha jugado — así no se repite demasiado el mismo home.
     * gamesPerDay=3 → "ganador se queda": los 3 equipos juegan 2 veces c/u —
     *   J1: visitante @ home · J2: GANADOR del J1 vs el que esperó ·
     *   J3: PERDEDOR del J1 vs el que esperó — quien repite juego invierte
     *   su rol (si fue home pasa a visita y viceversa).
     * Como el resultado no existe al generar, J2/J3 salen con los equipos
     * provisionales (asumiendo que gana el home) + nota explicativa; el
     * anotador ajusta equipos al iniciar el juego si el J1 salió al revés. */
    const rawGpd = Math.round(body.gamesPerDay ?? 2);
    const winnerStays = rawGpd === 3 && teams.length >= 3;
    const perDay = winnerStays ? 3 : Math.min(Math.max(1, rawGpd), teams.length - 1);
    const ids = teams.map((t) => t.id);
    // orden del ciclo: día 1 = home club elegido recibiendo al visitante elegido
    const order = [
      ...(firstHomeId ? [firstHomeId] : []),
      ...(firstAwayId ? [firstAwayId] : []),
      ...ids.filter((x) => x !== firstHomeId && x !== firstAwayId),
    ];
    const meets = new Map<string, number>(); // veces que se han enfrentado dos equipos
    const key = (a: string, b: string) => [a, b].sort().join('|');
    if (winnerStays) {
      /* Ganador se queda: por jornada un trío (local, visita, el que espera).
       * Roles rotan por jornada (H→V→W) y el trío sale de los menos jugados. */
      const played = new Map<string, number>(ids.map((x) => [x, 0]));
      const jornadas = Math.min(rounds * Math.ceil(ids.length / 3), MAX_JORNADAS);
      let jornadasHechas = 0;
      for (let j = 0; j < jornadas; j++) {
        const date = nextDate();
        if (end && date > end) break;
        jornadasHechas++;
        const trio = [...ids]
          .sort((a, b) => (played.get(a)! - played.get(b)!) || order.indexOf(a) - order.indexOf(b))
          .slice(0, 3);
        const H = trio[j % 3], V = trio[(j + 1) % 3], W = trio[(j + 2) % 3];
        /* Regla: en tu SEGUNDO juego de la noche cambias de lado.
         *   J1: V@H. Si gana H → J2 = H visita @ W home; si gana V → J2 = W visita @ V home.
         *   J3: el perdedor también invierte: perdedor-visitante → home; perdedor-local → visita.
         * Provisionales abajo asumen que gana el home club (H gana → J2 = H@W, J3 = W@V). */
        gameAt(date, 0, V, H, 'Triangular QG · J1 — el ganador invierte rol en el J2');
        gameAt(date, 1, H, W, 'Triangular QG · J2 — el GANADOR del J1 vs el que esperó, INVIRTIENDO su rol: si ganó el visitante del J1 él va de home y el que esperó de visita (ajusta los equipos al iniciar)');
        gameAt(date, 2, W, V, 'Triangular QG · J3 — el PERDEDOR del J1 vs el que esperó, también invirtiendo rol: si el perdedor era visitante va de home, si era local va de visita (ajusta al iniciar)');
        played.set(H, played.get(H)! + 2); played.set(V, played.get(V)! + 2); played.set(W, played.get(W)! + 2);
      }
      const created = await prisma.game.createMany({ data });
      return res.status(201).json({ created: created.count, jornadas: jornadasHechas, mode: 'triangular', style: 'ganador-queda' });
    }
    const jornadas = Math.min(rounds * Math.ceil(ids.length * (ids.length - 1) / 2 / perDay), MAX_JORNADAS);
    let jornadasHechas = 0;
    for (let j = 0; j < jornadas; j++) {
      const date = nextDate();
      if (end && date > end) break; // cierre del torneo
      jornadasHechas++;
      const home = order[j % order.length];
      // visitantes = los que menos han jugado contra este home club
      const visitors = ids.filter((x) => x !== home)
        .sort((a, b) => (meets.get(key(a, home)) ?? 0) - (meets.get(key(b, home)) ?? 0)
          || order.indexOf(a) - order.indexOf(b))
        .slice(0, perDay);
      visitors.forEach((v, i) => {
        meets.set(key(home, v), (meets.get(key(home, v)) ?? 0) + 1);
        gameAt(date, i, v, home);
      });
    }
    const created = await prisma.game.createMany({ data });
    return res.status(201).json({ created: created.count, jornadas: jornadasHechas, mode: 'triangular' });
  }

  // ============================ modo NORMAL (estilo MLB) ============================
  const seriesLen = Math.max(1, Math.round(body.seriesLen ?? 1)); // juegos seguidos del mismo pareo en el mismo home
  const style = body.seriesStyle ?? 'ida-vuelta';
  const divRounds = Math.max(0, Math.round(body.divRounds ?? 0));
  const divOf = new Map(teams.map((t) => [t.id, t.division ?? ''] as const));
  const hasDiv = teams.some((t) => t.division);

  /** método del círculo sobre un subconjunto → jornadas (cada equipo 1 pareo/jornada) */
  const circleRounds = (ids: (string | null)[]) => {
    const n = ids.length;
    if (n % 2) ids = [...ids, null]; // impar: uno descansa por jornada
    const m = ids.length;
    const roundsList: [string, string][][] = [];
    const ring = ids.slice(1);
    for (let r = 0; r < m - 1; r++) {
      const pairs = [ids[0], ...ring];
      const day: [string, string][] = [];
      for (let i = 0; i < m / 2; i++) {
        const a = pairs[i], b = pairs[m - 1 - i];
        if (a && b) day.push([a, b]);
      }
      roundsList.push(day);
      ring.unshift(ring.pop()!);
    }
    return roundsList;
  };

  const homeCount = new Map<string, number>(); // balanceo de localía (estilo random)
  const pickHome = (a: string, b: string) =>
    (homeCount.get(a) ?? 0) <= (homeCount.get(b) ?? 0) ? a : b;

  // jornadas en orden: [ [pareo (a,b)], ... ] por fecha de serie
  const jornadas: { pairs: [string, string][]; vuelta: number }[] = [];
  const allIds = teams.map((t) => t.id);
  const baseRounds = circleRounds(allIds);
  for (let v = 0; v < rounds; v++) {
    baseRounds.forEach((day) => jornadas.push({ pairs: day.map(([a, b], i) => {
      // localía: ida-vuelta alterna por vuelta y jornada; random balancea el acumulado
      const home = style === 'random' ? pickHome(a, b) : ((v + i) % 2 === 0 ? a : b);
      return (home === a ? [b, a] : [a, b]) as [string, string]; // [visitante, local]
    }), vuelta: v }));
  }
  // vueltas extra intra-división (MLB: más juegos contra tu propia división)
  // las jornadas de TODAS las divisiones caen el mismo día (se combinan por índice)
  if (hasDiv && divRounds) {
    const byDiv = new Map<string, string[]>();
    for (const t of teams) {
      const d = t.division ?? '';
      if (!byDiv.has(d)) byDiv.set(d, []);
      byDiv.get(d)!.push(t.id);
    }
    const divLists = [...byDiv.values()].filter((m) => m.length >= 2).map((m) => circleRounds(m.slice()));
    const maxLen = Math.max(0, ...divLists.map((l) => l.length));
    for (let v = 0; v < divRounds; v++) {
      for (let r = 0; r < maxLen; r++) {
        const pairs: [string, string][] = [];
        for (const list of divLists) {
          for (const [a, b] of list[r % list.length]) {
            const home = (v + pairs.length) % 2 === 0 ? a : b;
            pairs.push(home === a ? [b, a] : [a, b]);
          }
        }
        if (pairs.length) jornadas.push({ pairs, vuelta: rounds + v });
      }
    }
  }

  // fijar home club y visitante del día 1: si quedan pareados juntos, el día 1
  // es exactamente "visitante @ home" (y con equipos impares rotamos jornadas
  // hasta que ambos jueguen — el bye se mueve a otra fecha)
  if ((firstHomeId || firstAwayId) && jornadas.length) {
    const plays = (id?: string) => !id || jornadas[0].pairs.some(([a, b]) => a === id || b === id);
    for (let k = 0; k < jornadas.length && !(plays(firstHomeId) && plays(firstAwayId)); k++) {
      jornadas.push(jornadas.shift()!); // rota: el que descansaba día 1 entra a jugar
    }
    const j0 = jornadas[0].pairs;
    const hI = j0.findIndex(([a, b]) => a === firstHomeId || b === firstHomeId);
    const aI = j0.findIndex(([a, b]) => a === firstAwayId || b === firstAwayId);
    if (hI >= 0 && aI >= 0 && hI !== aI) {
      // juntarlos: el rival original del home pasa a la pareja del visitante
      const oppHome = j0[hI][0] === firstHomeId ? j0[hI][1] : j0[hI][0];
      j0[aI] = j0[aI][0] === firstAwayId ? [oppHome, j0[aI][1]] : [j0[aI][0], oppHome];
      j0[hI] = [firstAwayId!, firstHomeId!]; // [visitante, local]
    } else if (hI >= 0) {
      const j = j0[hI];
      j0[hI] = j[1] === firstHomeId ? j : [j[1], j[0]]; // home club elegido queda de local
    } else if (aI >= 0) {
      const j = j0[aI];
      j0[aI] = j[0] === firstAwayId ? j : [j[1], j[0]]; // visitante elegido queda de visita
    }
  }

  // asignación de fechas: cada jornada ocupa `seriesLen` fechas de juego
  // consecutivas (la serie se juega completa en el mismo home club, como MLB)
  let diasUsados = 0;
  outer: for (const j of jornadas) {
    for (let s = 0; s < seriesLen; s++) {
      const date = nextDate();
      if (end && date > end) break outer; // cierre del torneo por fecha
      diasUsados++;
      j.pairs.forEach(([away, home], i) => {
        homeCount.set(home, (homeCount.get(home) ?? 0) + 1);
        gameAt(date, i, away, home);
        if (dh) gameAt(date, i + j.pairs.length, away, home); // 2º juego del doble
      });
    }
  }
  const created = await prisma.game.createMany({ data });
  res.status(201).json({ created: created.count, jornadas: diasUsados, mode: 'normal' });
});

/** DELETE /leagues/:id/schedule — borra SOLO juegos programados sin eventos ni serie (para regenerar) */
r.delete('/:id/schedule', async (req, res) => {
  const del = await prisma.game.deleteMany({
    where: { leagueId: req.params.id, status: 'SCHEDULED', seriesId: null, events: { none: {} } },
  });
  res.json({ deleted: del.count });
});

// ==================== TEMPORADAS (Season dentro de la liga) ====================
// Abrir una temporada la marca ACTIVE y cierra (ENDED) las demás — una activa por liga.
async function openSeason(leagueId: string, year: number) {
  const [season] = await prisma.$transaction([
    prisma.season.create({ data: { leagueId, year } }),
    prisma.season.updateMany({ where: { leagueId, year: { not: year } }, data: { status: 'ENDED' } }),
    prisma.league.update({ where: { id: leagueId }, data: { year } }),
  ]);
  return season;
}

r.post('/:id/seasons', async (req, res) => {
  const y = Number(req.body.year);
  if (!y || y < 1900 || y > 2200) return res.status(400).json({ error: 'Año inválido' });
  const league = await prisma.league.findUnique({ where: { id: req.params.id } });
  if (!league) return res.status(404).json({ error: 'Liga no encontrada' });
  const dupe = await prisma.season.findUnique({ where: { leagueId_year: { leagueId: league.id, year: y } } });
  if (dupe) return res.status(409).json({ error: `Ya existe la temporada ${y} en esta liga` });
  const season = await openSeason(league.id, y);
  res.status(201).json({ season });
});

// Reactivar una temporada vieja o cerrar la actual
r.put('/:id/seasons/:sid', async (req, res) => {
  const s = await prisma.season.findFirst({ where: { id: req.params.sid, leagueId: req.params.id } });
  if (!s) return res.status(404).json({ error: 'Temporada no encontrada' });
  const { status } = req.body as { status?: string };
  if (status === 'ACTIVE') {
    await prisma.$transaction([
      prisma.season.updateMany({ where: { leagueId: s.leagueId, id: { not: s.id } }, data: { status: 'ENDED' } }),
      prisma.season.update({ where: { id: s.id }, data: { status: 'ACTIVE' } }),
      prisma.league.update({ where: { id: s.leagueId }, data: { year: s.year } }),
    ]);
  } else if (status === 'ENDED') {
    await prisma.season.update({ where: { id: s.id }, data: { status: 'ENDED' } });
  }
  res.json({ season: await prisma.season.findUnique({ where: { id: s.id } }) });
});

// Borrar temporada vacía (sin juegos) — útil si se creó por error
r.delete('/:id/seasons/:sid', async (req, res) => {
  const s = await prisma.season.findFirst({ where: { id: req.params.sid, leagueId: req.params.id } });
  if (!s) return res.status(404).json({ error: 'Temporada no encontrada' });
  const g = await prisma.game.count({ where: { seasonId: s.id } });
  if (g) return res.status(409).json({ error: `La temporada ${s.year} tiene ${g} juegos — no se puede borrar` });
  await prisma.season.delete({ where: { id: s.id } });
  res.status(204).end();
});

// ---- Nueva temporada: crea una Season dentro de la MISMA liga ----
// Equipos y rosters permanecen (los movimientos se hacen por transferencia);
// los playerId no cambian → todo el historial por año los sigue.
r.post('/:id/rollover', async (req, res) => {
  const y = Number(req.body.year);
  if (!y || y < 1900 || y > 2200) return res.status(400).json({ error: 'Año inválido' });
  const league = await prisma.league.findUnique({ where: { id: req.params.id } });
  if (!league) return res.status(404).json({ error: 'Liga no encontrada' });
  const dupe = await prisma.season.findUnique({ where: { leagueId_year: { leagueId: league.id, year: y } } });
  if (dupe) return res.status(409).json({ error: `Ya existe la temporada ${y} en esta liga` });
  const season = await openSeason(league.id, y);
  res.json({ season, league: await prisma.league.findUnique({ where: { id: league.id } }) });
});

// ==================== PLAYOFFS / SERIES ====================

// marcador oficial de un juego FINAL (o LIVE en curso) — forfeit usa override
async function gameScore(g: { id: string; innings: number; fScoreAway: number | null; fScoreHome: number | null }) {
  const state = reduceGame(await loadEvents(g.id), g.innings);
  if (g.fScoreAway != null && g.fScoreHome != null) return { away: g.fScoreAway, home: g.fScoreHome };
  return state.score;
}

// resume una serie: juegos con marcador + victorias por lado + ganador automático
async function seriesDetail(s: { id: string; homeTeamId: string; awayTeamId: string; winsNeeded: number }) {
  const games = await prisma.game.findMany({
    where: { seriesId: s.id },
    orderBy: { date: 'asc' },
    include: { events: { orderBy: { seq: 'asc' } } },
  });
  let hw = 0, aw = 0;
  const list = [] as { id: string; date: Date; status: string; away: number; home: number; stadium: string | null; awayTeamId: string; homeTeamId: string; innings: number }[];
  for (const g of games) {
    const score = await gameScore(g);
    if (g.status === 'FINAL' && !g.tied) {
      const winner = score.home > score.away ? g.homeTeamId : g.awayTeamId;
      if (winner === s.homeTeamId) hw++; else if (winner === s.awayTeamId) aw++;
    }
    list.push({ id: g.id, date: g.date, status: g.status, away: score.away, home: score.home, stadium: g.stadium, awayTeamId: g.awayTeamId, homeTeamId: g.homeTeamId, innings: g.innings });
  }
  const winnerTeamId = hw >= s.winsNeeded ? s.homeTeamId : aw >= s.winsNeeded ? s.awayTeamId : null;
  const status = winnerTeamId ? 'DONE' : list.some((g) => g.status === 'LIVE') ? 'LIVE' : list.length ? 'LIVE' : 'PENDING';
  return { games: list, wins: { home: hw, away: aw }, winnerTeamId, status };
}

r.get('/:id/series', async (req, res) => {
  // ?season=<seasonId> filtra por temporada (sin filtro = todas, compat)
  const seasonFilter = req.query.season ? { seasonId: String(req.query.season) } : {};
  const rows = await prisma.series.findMany({ where: { leagueId: req.params.id, ...seasonFilter }, orderBy: [{ round: 'asc' }, { createdAt: 'asc' }] });
  const teamIds = [...new Set(rows.flatMap((s) => [s.homeTeamId, s.awayTeamId]))];
  const teams = await prisma.team.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true, shortName: true } });
  const tmap = new Map(teams.map((t) => [t.id, t]));
  const out = [];
  for (const s of rows) {
    const d = await seriesDetail(s);
    // persiste ganador si acaba de resolverse
    if (d.winnerTeamId && (!s.winnerTeamId || s.status !== 'DONE')) {
      await prisma.series.update({ where: { id: s.id }, data: { winnerTeamId: d.winnerTeamId, status: 'DONE' } });
    }
    out.push({
      ...s, ...d,
      homeTeam: tmap.get(s.homeTeamId) ?? { id: s.homeTeamId, name: '?', shortName: null },
      awayTeam: tmap.get(s.awayTeamId) ?? { id: s.awayTeamId, name: '?', shortName: null },
      winner: d.winnerTeamId ? tmap.get(d.winnerTeamId) ?? null : null,
    });
  }
  res.json(out);
});

// crear pareo individual: {round, name?, homeTeamId, awayTeamId, winsNeeded}
r.post('/:id/series', async (req, res) => {
  const { round, name, homeTeamId, awayTeamId, winsNeeded, seasonId } = req.body;
  if (!homeTeamId || !awayTeamId || homeTeamId === awayTeamId)
    return res.status(400).json({ error: 'homeTeamId y awayTeamId distintos requeridos' });
  const season = seasonId ?? (await prisma.season.findFirst({ where: { leagueId: req.params.id, status: 'ACTIVE' } }))?.id ?? null;
  const s = await prisma.series.create({
    data: {
      leagueId: req.params.id, seasonId: season, round: Number(round) || 1,
      name: name || `Serie`, homeTeamId, awayTeamId,
      winsNeeded: Math.max(1, Number(winsNeeded) || 3),
    },
  });
  res.status(201).json(s);
});

r.put('/:id/series/:sid', async (req, res) => {
  const { name, winsNeeded, winnerTeamId, status } = req.body;
  const s = await prisma.series.update({
    where: { id: req.params.sid },
    data: {
      name, winsNeeded: winsNeeded != null ? Math.max(1, Number(winsNeeded)) : undefined,
      winnerTeamId: winnerTeamId === null ? null : winnerTeamId,
      status,
    },
  });
  res.json(s);
});

r.delete('/:id/series/:sid', async (req, res) => {
  // desvincular pasa por assignGameSeries: los juegos que ya acumularon
  // temporada migran su contribución POST → REG (vuelven a ser regulares)
  const linked = await prisma.game.findMany({ where: { seriesId: req.params.sid }, select: { id: true } });
  for (const g of linked) await assignGameSeries(g.id, null);
  await prisma.series.deleteMany({ where: { id: req.params.sid } }); // idempotente
  res.status(204).end();
});

// sentados (bye) por ronda: PUT {round, teamIds} → merge en league.byes
r.put('/:id/byes', async (req, res) => {
  const { round, teamIds } = req.body;
  const league = await prisma.league.findUnique({ where: { id: req.params.id } });
  if (!league) return res.status(404).json({ error: 'Liga no encontrada' });
  const byes = ((league.byes as Record<string, string[]>) ?? {});
  if (Array.isArray(teamIds) && teamIds.length) byes[String(round)] = teamIds; else delete byes[String(round)];
  const saved = await prisma.league.update({ where: { id: league.id }, data: { byes } });
  res.json(saved.byes ?? {});
});

// ---- Standings del torneo (solo juegos FINAL; empates no suman W/L) ----
// Filtro de temporada: seasonId explícito (Season dentro de la liga) o año de fecha.
export interface SeasonFilter { year?: number; seasonId?: string }
const seasonGameWhere = (f?: SeasonFilter) =>
  f?.seasonId ? { seasonId: f.seasonId }
    : f?.year ? { date: { gte: new Date(f.year, 0, 1), lt: new Date(f.year + 1, 0, 1) } }
    : {};

export async function leagueStandings(leagueId: string, filter: SeasonFilter = {}) {
  const leagueTb = (await prisma.league.findUnique({ where: { id: leagueId }, select: { tb: true } }))?.tb;
  const tb = leagueTb ?? 'pct';
  const games = await prisma.game.findMany({
    where: {
      leagueId, status: 'FINAL', seriesId: null, // posiciones = solo temporada regular
      ...seasonGameWhere(filter),
    },
    orderBy: { date: 'asc' },
    include: { events: { orderBy: { seq: 'asc' } } },
  });
  const teams = await prisma.team.findMany({ where: { leagueId } });

  const table = new Map<string, { teamId: string; name: string; division: string | null; w: number; l: number; t: number; rf: number; ra: number }>();
  for (const t of teams) table.set(t.id, { teamId: t.id, name: t.name, division: t.division ?? null, w: 0, l: 0, t: 0, rf: 0, ra: 0 });
  // historial por equipo (para racha/últimos 10) y matriz cara-a-cara
  const hist = new Map<string, ('W' | 'L' | 'T')[]>();
  const h2h = new Map<string, Map<string, { w: number; l: number; t: number }>>();
  const recH2h = (me: string, opp: string, r: 'W' | 'L' | 'T') => {
    hist.set(me, [...(hist.get(me) ?? []), r]);
    const m = h2h.get(me) ?? new Map<string, { w: number; l: number; t: number }>();
    const v = m.get(opp) ?? { w: 0, l: 0, t: 0 };
    if (r === 'W') v.w++; else if (r === 'L') v.l++; else v.t++;
    m.set(opp, v); h2h.set(me, m);
  };

  for (const g of games) {
    let score: { away: number; home: number };
    if ((!g.events.length || g.forfeitBy) && g.fScoreAway != null && g.fScoreHome != null) {
      score = { away: g.fScoreAway, home: g.fScoreHome };
    } else {
      score = reduceGame(g.events.map((e) => ({
        seq: e.seq, inning: e.inning, half: e.half as 'TOP' | 'BOTTOM',
        batterId: e.batterId, pitcherId: e.pitcherId,
        result: e.result as never, notation: e.notation,
        errorOn: e.errorOn ? JSON.parse(e.errorOn) : undefined,
        advances: e.advances as never,
      })), g.innings).score;
    }
    const a = table.get(g.awayTeamId), h = table.get(g.homeTeamId);
    if (a) { a.rf += score.away; a.ra += score.home; }
    if (h) { h.rf += score.home; h.ra += score.away; }
    if (score.away === score.home || g.tied) {
      if (a) a.t++; if (h) h.t++;
      recH2h(g.awayTeamId, g.homeTeamId, 'T'); recH2h(g.homeTeamId, g.awayTeamId, 'T');
    } else if (score.away > score.home) {
      if (a) a.w++; if (h) h.l++;
      recH2h(g.awayTeamId, g.homeTeamId, 'W'); recH2h(g.homeTeamId, g.awayTeamId, 'L');
    } else {
      if (h) h.w++; if (a) a.l++;
      recH2h(g.homeTeamId, g.awayTeamId, 'W'); recH2h(g.awayTeamId, g.homeTeamId, 'L');
    }
  }

  const rows = [...table.values()]
    .map((t) => {
      const h = hist.get(t.teamId) ?? [];
      // racha: resultado repetido desde el último juego hacia atrás
      let streak: string | null = null;
      if (h.length) {
        const last = h[h.length - 1];
        let n = 0;
        for (let i = h.length - 1; i >= 0 && h[i] === last; i--) n++;
        streak = `${last === 'W' ? 'G' : last === 'L' ? 'P' : 'E'}${n}`;
      }
      const l10 = h.slice(-10).reduce((s, r) => ({ w: s.w + (r === 'W' ? 1 : 0), l: s.l + (r === 'L' ? 1 : 0), t: s.t + (r === 'T' ? 1 : 0) }), { w: 0, l: 0, t: 0 });
      return {
        ...t, pct: t.w + t.l ? t.w / (t.w + t.l) : 0, diff: t.rf - t.ra, gb: 0,
        streak, last10: l10, form: h.slice(-5),
        vs: Object.fromEntries(h2h.get(t.teamId) ?? []),
      };
    })
    .sort((x, y) => {
      // Desempate según la liga (league.tb):
      //  'pct'  → pct → victorias → diferencia de carreras (clásico)
      //  'h2h'  → pct → serie entre ellos (cara a cara) → diff
      //  'diff' → pct → diferencia de carreras → victorias
      const h2hCmp = () => {
        const a = x.vs?.[y.teamId] as { w?: number; l?: number } | undefined;
        const av = (a?.w ?? 0) - (a?.l ?? 0); // positivo = x le ganó la serie a y
        return -av; // sort asc: menor primero → invertimos
      };
      if (tb === 'h2h') return y.pct - x.pct || h2hCmp() || y.diff - x.diff;
      if (tb === 'diff') return y.pct - x.pct || y.diff - x.diff || y.w - x.w;
      return y.pct - x.pct || y.w - x.w || y.diff - x.diff;
    });
  // juegos detrás del líder
  const lead = rows[0];
  for (const t of rows) t.gb = lead ? ((lead.w - t.w) + (t.l - lead.l)) / 2 : 0;
  return rows;
}

r.get('/:id/standings', async (req, res) => {
  const year = Number(req.query.year) || undefined;
  const seasonId = req.query.season ? String(req.query.season) : undefined;
  res.json(await leagueStandings(req.params.id, { year, seasonId }));
});

// ---- Estadísticas del torneo: bateo + sabermetría + pitcheo + fildeo + situacional ----
/** Juegos con los datos que el agregador necesita (reutilizado por stats y splits) */
export const GAME_STATS_INCLUDE = {
  lineups: true,
  homeTeam: { select: { id: true, name: true, shortName: true } },
  awayTeam: { select: { id: true, name: true, shortName: true } },
} satisfies Prisma.GameInclude;
type StatsGame = Prisma.GameGetPayload<{ include: typeof GAME_STATS_INCLUDE }>;

/** Agrega un conjunto de juegos FINAL → líneas de bateo/pitcheo/fildeo/situacional + totales por equipo */
export async function aggregateGames(
  games: StatsGame[],
  leagueTeams: { id: string; name: string; shortName: string | null }[],
  /** correcciones manuales (PlayerSeasonStat.adj) ya filtradas por año/scope/equipo */
  adjRows?: { playerId: string; adj: unknown }[],
) {
  const playerIds = new Set<string>();
  for (const g of games) for (const l of g.lineups) playerIds.add(l.playerId);

  const bat = new Map<string, {
    playerId: string; g: number; pa: number; ab: number; r: number; h: number;
    doubles: number; triples: number; hr: number; rbi: number; bb: number; k: number;
    hbp: number; sac: number; sf: number; sb: number;
  }>();
  const pit = new Map<string, {
    playerId: string; gp: number; gs: number; outs: number; h: number; r: number; er: number;
    bb: number; k: number; hr: number; pitches: number; bf: number; abAg: number;
  }>();
  const fld = new Map<string, { playerId: string; po: number; a: number; e: number }>();
  const situ = new Map<string, {
    playerId: string;
    risp: { ab: number; h: number }; loaded: { ab: number; h: number };
    twoOut: { ab: number; h: number }; leadoff: { ab: number; h: number };
  }>();
  const played = new Map<string, number>(); // juegos jugados por jugador
  // datos extra para el sitio web navegable: resultado por juego, boxscores y log por jugador
  const results: {
    id: string; date: Date; innings: number; awayId: string; homeId: string;
    away: string; home: string; awayShort: string; homeShort: string;
    aR: number; hR: number; tied: boolean; forfeit: boolean; stadium: string | null;
    // lado de cada lanzador + decisiones del juego (boxscore del website)
    pitSide: Record<string, 'away' | 'home'>;
    dec: { w: string[]; l: string[]; sv: string[]; hld: string[]; bs: string[]; cg: string[]; sho: string[] };
  }[] = [];
  const boxes = new Map<string, ReturnType<typeof computeBoxscore>>();
  const playerLog = new Map<string, {
    gameId: string; date: Date; opp: string;
    bat: import('@poxscore/shared').BatterLine | null;
    pit: import('@poxscore/shared').PitcherLine | null;
  }[]>();
  // totales por equipo: bateo (ab/r/h/hr/ci/bb/k/br), fildeo (e) y pitcheo (outs/h/c/cl/bb/k) + dejados
  const teamTotals = new Map<string, {
    teamId: string; name: string; g: number;
    ab: number; r: number; h: number; doubles: number; triples: number; hr: number; rbi: number;
    bb: number; k: number; sb: number; e: number; lob: number;
    pOuts: number; pH: number; pR: number; pER: number; pBB: number; pK: number;
  }>();
  for (const t of leagueTeams) teamTotals.set(t.id, {
    teamId: t.id, name: t.shortName ?? t.name, g: 0,
    ab: 0, r: 0, h: 0, doubles: 0, triples: 0, hr: 0, rbi: 0, bb: 0, k: 0, sb: 0, e: 0, lob: 0,
    pOuts: 0, pH: 0, pR: 0, pER: 0, pBB: 0, pK: 0,
  });
  const dec = { w: new Map<string, number>(), l: new Map<string, number>(), sv: new Map<string, number>(), hld: new Map<string, number>(), bs: new Map<string, number>(), cg: new Map<string, number>(), sho: new Map<string, number>() };
  const bump = (m: Map<string, number>, id: string) => m.set(id, (m.get(id) ?? 0) + 1);

  // línea de equipo POR JUEGO (highs/lows del sitio web) + errores del equipo por partido
  const teamGameLines: {
    gameId: string; date: Date; teamId: string; opp: string; res: 'W' | 'L' | 'T';
    rf: number; ra: number; inn: number;
    ab: number; h: number; rbi: number; bb: number; k: number; sb: number; lob: number; e: number;
    pOuts: number; pH: number; pR: number; pBB: number; pK: number;
  }[] = [];
  // matriz bateador-vs-lanzador para matchups del sitio web
  const matchups = new Map<string, Map<string, { pa: number; ab: number; h: number; hr: number; rbi: number; bb: number; k: number }>>();
  const matchupOf = (bid: string, pid: string) => {
    if (!matchups.has(bid)) matchups.set(bid, new Map());
    const m = matchups.get(bid)!;
    if (!m.has(pid)) m.set(pid, { pa: 0, ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, k: 0 });
    return m.get(pid)!;
  };
  const NO_RBI_RES = new Set(['E', 'DP', 'TP', 'KWP', 'KPB']);

  const batOf = (pid: string) => {
    if (!bat.has(pid)) bat.set(pid, { playerId: pid, g: 0, pa: 0, ab: 0, r: 0, h: 0, doubles: 0, triples: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sac: 0, sf: 0, sb: 0 });
    return bat.get(pid)!;
  };
  const pitOf = (pid: string) => {
    if (!pit.has(pid)) pit.set(pid, { playerId: pid, gp: 0, gs: 0, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0, pitches: 0, bf: 0, abAg: 0 });
    return pit.get(pid)!;
  };
  const fldOf = (pid: string) => {
    if (!fld.has(pid)) fld.set(pid, { playerId: pid, po: 0, a: 0, e: 0 });
    return fld.get(pid)!;
  };
  const situOf = (pid: string) => {
    if (!situ.has(pid)) situ.set(pid, { playerId: pid, risp: { ab: 0, h: 0 }, loaded: { ab: 0, h: 0 }, twoOut: { ab: 0, h: 0 }, leadoff: { ab: 0, h: 0 } });
    return situ.get(pid)!;
  };

  for (const g of games) {
    const events = await loadEvents(g.id);
    const box = computeBoxscore(events, g.innings);
    for (const l of g.lineups) bump(played, l.playerId);
    // GS (juegos iniciados): el lanzador titular es la entrada STARTER con posición P
    for (const l of g.lineups) if (l.role === 'STARTER' && l.position === 'P') pitOf(l.playerId).gs += 1;
    if (g.wpId) bump(dec.w, g.wpId);
    if (g.lpId) bump(dec.l, g.lpId);
    if (g.svId) bump(dec.sv, g.svId);
    for (const pid of g.hldIds ? JSON.parse(g.hldIds) as string[] : []) bump(dec.hld, pid);
    for (const pid of g.bsIds ? JSON.parse(g.bsIds) as string[] : []) bump(dec.bs, pid);
    // CG/SHO automáticos (marcador oficial: forfeit usa fScore)
    const official = g.fScoreAway != null && g.fScoreHome != null ? { away: g.fScoreAway, home: g.fScoreHome } : undefined;
    const { cg, sho } = computeCgSho(events, g.innings, official);
    for (const pid of cg) bump(dec.cg, pid);
    for (const pid of sho) bump(dec.sho, pid);

    // totales de equipo: carreras (score oficial/forfeit), hits y dejados en base
    const score = g.fScoreAway != null && g.fScoreHome != null
      ? { away: g.fScoreAway, home: g.fScoreHome }
      : { away: box.linescore.away.reduce((s, n) => s + n, 0), home: box.linescore.home.reduce((s, n) => s + n, 0) };
    const ttAway = teamTotals.get(g.awayTeamId), ttHome = teamTotals.get(g.homeTeamId);
    // pitcheo por lado: en TOP lanza el home, en BOTTOM el away
    const pitSide = new Map<string, 'away' | 'home'>();
    const pitSideRec: Record<string, 'away' | 'home'> = {};
    for (const e of events) if (e.pitcherId) {
      const side = e.half === 'TOP' ? 'home' : 'away';
      pitSide.set(e.pitcherId, side); pitSideRec[e.pitcherId] = side;
    }
    // decisiones del juego para el boxscore del website (se completan abajo con statLines)
    const gDec = { w: [] as string[], l: [] as string[], sv: [] as string[], hld: [] as string[], bs: [] as string[], cg: [...cg], sho: [...sho] };
    const addDec = (arr: string[], pid: string) => { if (!arr.includes(pid)) arr.push(pid); };
    if (g.wpId) addDec(gDec.w, g.wpId);
    if (g.lpId) addDec(gDec.l, g.lpId);
    if (g.svId) addDec(gDec.sv, g.svId);
    for (const pid of g.hldIds ? JSON.parse(g.hldIds) as string[] : []) addDec(gDec.hld, pid);
    for (const pid of g.bsIds ? JSON.parse(g.bsIds) as string[] : []) addDec(gDec.bs, pid);
    const addTeamBat = (tt: (typeof teamTotals extends Map<string, infer V> ? V : never) | undefined, side: 'away' | 'home') => {
      if (!tt) return;
      tt.g += 1; tt.r += score[side]; tt.lob += box.lob[side];
      for (const l of Object.values(box[side])) {
        tt.ab += l.ab; tt.h += l.h; tt.doubles += l.doubles; tt.triples += l.triples;
        tt.hr += l.hr; tt.rbi += l.rbi; tt.bb += l.bb; tt.k += l.k; tt.sb += l.sb;
      }
    };
    addTeamBat(ttAway, 'away');
    addTeamBat(ttHome, 'home');

    // sitio web: resultado del juego + boxscore + log juego a juego por jugador
    results.push({
      id: g.id, date: g.date, innings: g.innings,
      awayId: g.awayTeamId, homeId: g.homeTeamId,
      away: g.awayTeam.name, home: g.homeTeam.name,
      awayShort: g.awayTeam.shortName ?? g.awayTeam.name,
      homeShort: g.homeTeam.shortName ?? g.homeTeam.name,
      aR: score.away, hR: score.home,
      tied: !!g.tied, forfeit: !!g.forfeitBy, stadium: g.stadium,
      pitSide: pitSideRec,
      dec: gDec,
    });
    boxes.set(g.id, box);
    const logOf = (pid: string) => {
      if (!playerLog.has(pid)) playerLog.set(pid, []);
      return playerLog.get(pid)!;
    };
    const logEntry = (pid: string, side: 'away' | 'home') => {
      const opp = side === 'away' ? (g.homeTeam.shortName ?? g.homeTeam.name) : (g.awayTeam.shortName ?? g.awayTeam.name);
      let row = logOf(pid).find((e) => e.gameId === g.id);
      if (!row) { row = { gameId: g.id, date: g.date, opp, bat: null, pit: null }; logOf(pid).push(row); }
      return row;
    };
    for (const line of Object.values(box.away)) logEntry(line.playerId, 'away').bat = line;
    for (const line of Object.values(box.home)) logEntry(line.playerId, 'home').bat = line;
    for (const line of Object.values(box.pitchers)) {
      const side = pitSide.get(line.playerId);
      if (side) logEntry(line.playerId, side).pit = line;
    }

    // ---- líneas importadas (juegos sin eventos): alimentan el mismo agregado ----
    const statLines = (g.statLines ?? []) as {
      playerId: string; teamId: string | null; g?: number; pa?: number; ab?: number; r?: number;
      h?: number; doubles?: number; triples?: number; hr?: number; rbi?: number; bb?: number;
      k?: number; hbp?: number; sac?: number; sf?: number; sb?: number;
      gp?: number; gs?: number; w?: number; l?: number; sv?: number; hld?: number; bs?: number;
      cg?: number; sho?: number; pOuts?: number; pH?: number; pR?: number; pER?: number;
      pBB?: number; pK?: number; pHR?: number; pPitches?: number; bf?: number;
      po?: number; a?: number; e?: number;
    }[];
    const sideOf = (tid: string | null) => (tid === g.awayTeamId ? 'away' : 'home');
    if (statLines.length) {
      // jugadores ya presentes por alineación/eventos: su línea suma números
      // pero no un juego extra en `played` (editor admin: línea manual)
      const inGame = new Set<string>(g.lineups.map((l) => l.playerId));
      // outs lanzados por lado (para derivar juego completo)
      const outsBySide = { away: 0, home: 0 };
      for (const ln of statLines) outsBySide[sideOf(ln.teamId)] += ln.pOuts ?? 0;
      // boxscore reconstruido desde las líneas → la página del juego muestra stats reales
      const pseudo = {
        away: {} as Record<string, import('@poxscore/shared').BatterLine>,
        home: {} as Record<string, import('@poxscore/shared').BatterLine>,
        pitchers: {} as Record<string, import('@poxscore/shared').PitcherLine>,
        linescore: { away: [] as number[], home: [] as number[] },
        lob: { away: 0, home: 0 },
      };
      for (const ln of statLines) {
        const pid = ln.playerId, side = sideOf(ln.teamId);
        const tt = side === 'away' ? ttAway : ttHome;
        if (!inGame.has(pid)) bump(played, pid);
        const b = batOf(pid);
        b.pa += ln.pa ?? 0; b.ab += ln.ab ?? 0; b.r += ln.r ?? 0; b.h += ln.h ?? 0;
        b.doubles += ln.doubles ?? 0; b.triples += ln.triples ?? 0; b.hr += ln.hr ?? 0;
        b.rbi += ln.rbi ?? 0; b.bb += ln.bb ?? 0; b.k += ln.k ?? 0; b.hbp += ln.hbp ?? 0;
        b.sac += ln.sac ?? 0; b.sf += ln.sf ?? 0; b.sb += ln.sb ?? 0;
        if (tt) {
          tt.ab += ln.ab ?? 0; tt.h += ln.h ?? 0; tt.doubles += ln.doubles ?? 0; tt.triples += ln.triples ?? 0;
          tt.hr += ln.hr ?? 0; tt.rbi += ln.rbi ?? 0; tt.bb += ln.bb ?? 0; tt.k += ln.k ?? 0; tt.sb += ln.sb ?? 0;
        }
        const batLine = {
          playerId: pid, pa: ln.pa ?? 0, ab: ln.ab ?? 0, r: ln.r ?? 0, h: ln.h ?? 0,
          rbi: ln.rbi ?? 0, bb: ln.bb ?? 0, k: ln.k ?? 0, hbp: ln.hbp ?? 0,
          doubles: ln.doubles ?? 0, triples: ln.triples ?? 0, hr: ln.hr ?? 0,
          sac: ln.sac ?? 0, sf: ln.sf ?? 0, sb: ln.sb ?? 0,
        };
        // línea duplicada del mismo jugador (post-fusión): ACUMULAR, no pisar
        const prevBat = pseudo[side][pid];
        if (prevBat) {
          prevBat.pa += batLine.pa; prevBat.ab += batLine.ab; prevBat.r += batLine.r; prevBat.h += batLine.h;
          prevBat.rbi += batLine.rbi; prevBat.bb += batLine.bb; prevBat.k += batLine.k; prevBat.hbp += batLine.hbp;
          prevBat.doubles += batLine.doubles; prevBat.triples += batLine.triples; prevBat.hr += batLine.hr;
          prevBat.sac += batLine.sac; prevBat.sf += batLine.sf; prevBat.sb += batLine.sb;
        } else pseudo[side][pid] = batLine;
        logEntry(pid, side).bat = pseudo[side][pid];
        if ((ln.gp ?? 0) || (ln.pOuts ?? 0)) {
          pitSide.set(pid, side); pitSideRec[pid] = side;
          const p = pitOf(pid);
          p.gp += 1; p.gs += ln.gs ?? 0; p.outs += ln.pOuts ?? 0; p.h += ln.pH ?? 0;
          p.r += ln.pR ?? 0; p.er += ln.pER ?? 0; p.bb += ln.pBB ?? 0; p.k += ln.pK ?? 0;
          p.hr += ln.pHR ?? 0; p.pitches += ln.pPitches ?? 0; p.bf += ln.bf ?? 0;
          p.abAg += (ln.pOuts ?? 0) + (ln.pH ?? 0); // AB contra aprox. (outs + hits permitidos)
          if (tt) {
            tt.pOuts += ln.pOuts ?? 0; tt.pH += ln.pH ?? 0; tt.pR += ln.pR ?? 0;
            tt.pER += ln.pER ?? 0; tt.pBB += ln.pBB ?? 0; tt.pK += ln.pK ?? 0;
          }
          // CG/SHO derivados: lanzó TODOS los outs de su lado (W/L/SV vienen del juego)
          if ((ln.pOuts ?? 0) > 0 && ln.pOuts === outsBySide[side]) {
            bump(dec.cg, pid); addDec(gDec.cg, pid);
            if ((side === 'away' ? score.home : score.away) === 0) { bump(dec.sho, pid); addDec(gDec.sho, pid); }
          }
          const pitLine = {
            playerId: pid, outs: ln.pOuts ?? 0, h: ln.pH ?? 0, r: ln.pR ?? 0, er: ln.pER ?? 0,
            bb: ln.pBB ?? 0, k: ln.pK ?? 0, hr: ln.pHR ?? 0, pitches: ln.pPitches ?? 0,
          };
          const prevPit = pseudo.pitchers[pid];
          if (prevPit) {
            prevPit.outs += pitLine.outs; prevPit.h += pitLine.h; prevPit.r += pitLine.r;
            prevPit.er += pitLine.er; prevPit.bb += pitLine.bb; prevPit.k += pitLine.k;
            prevPit.hr += pitLine.hr; prevPit.pitches += pitLine.pitches;
          } else pseudo.pitchers[pid] = pitLine;
          logEntry(pid, side).pit = pseudo.pitchers[pid];
        }
        // decisiones: las banderas de la línea solo si el juego no las trae ya (import las sella)
        if (ln.w && !g.wpId) { bump(dec.w, pid); addDec(gDec.w, pid); }
        if (ln.l && !g.lpId) { bump(dec.l, pid); addDec(gDec.l, pid); }
        if (ln.sv && !g.svId) { bump(dec.sv, pid); addDec(gDec.sv, pid); }
        if (ln.hld) { bump(dec.hld, pid); addDec(gDec.hld, pid); }
        if (ln.bs) { bump(dec.bs, pid); addDec(gDec.bs, pid); }
        const f = fldOf(pid);
        f.po += ln.po ?? 0; f.a += ln.a ?? 0; f.e += ln.e ?? 0;
        if (tt) tt.e += ln.e ?? 0;
      }
      boxes.set(g.id, pseudo as ReturnType<typeof computeBoxscore>);
    }

    for (const line of Object.values(box.pitchers)) {
      const tt = pitSide.get(line.playerId) === 'away' ? ttAway : ttHome;
      if (!tt) continue;
      tt.pOuts += line.outs; tt.pH += line.h; tt.pR += line.r; tt.pER += line.er; tt.pBB += line.bb; tt.pK += line.k;
    }

    for (const line of [...Object.values(box.away), ...Object.values(box.home)]) {
      const b = batOf(line.playerId);
      b.pa += line.pa; b.ab += line.ab; b.r += line.r; b.h += line.h;
      b.doubles += line.doubles; b.triples += line.triples; b.hr += line.hr;
      b.rbi += line.rbi; b.bb += line.bb; b.k += line.k; b.hbp += line.hbp;
      b.sac += line.sac; b.sf += line.sf; b.sb += line.sb;
    }
    for (const line of Object.values(box.pitchers)) {
      const p = pitOf(line.playerId);
      p.gp += 1; p.outs += line.outs; p.h += line.h; p.r += line.r; p.er += line.er;
      p.bb += line.bb; p.k += line.k; p.hr += line.hr; p.pitches += line.pitches;
    }

    // fildeo + situacional + matchups + errores de equipo: replay evento a evento
    let st = initialState();
    let firstPaOfHalf = true;
    const eCnt = { away: 0, home: 0 };
    for (const ev of events) {
      // fildeo (el equipo que fildea es el contrario al que batea en esa mitad)
      for (const pid of ev.errorOn ?? []) { fldOf(pid).e += 1; eCnt[ev.half === 'TOP' ? 'home' : 'away'] += 1; }
      const poArr = ev.putouts ?? [];
      const aArr = ev.assists ?? [];
      for (const pid of poArr) fldOf(pid).po += 1;
      for (const pid of aArr) fldOf(pid).a += 1;

      // bateadores enfrentados / AB contra (para AVG contra y K/BB del lanzador)
      if (!isMidResult(ev.result) && ev.pitcherId) {
        const pp = pitOf(ev.pitcherId);
        pp.bf += 1;
        if (!(NON_AB as readonly string[]).includes(ev.result)) pp.abAg += 1;
      }
      // matchup bateador vs lanzador
      if (!isMidResult(ev.result) && ev.batterId && ev.pitcherId) {
        const mm = matchupOf(ev.batterId, ev.pitcherId);
        mm.pa += 1;
        if (!(NON_AB as readonly string[]).includes(ev.result)) mm.ab += 1;
        if (HITS.includes(ev.result)) { mm.h += 1; if (ev.result === 'HR' || ev.result === 'HRIP') mm.hr += 1; }
        if (ev.result === 'BB' || ev.result === 'IBB') mm.bb += 1;
        if (ev.result === 'K' || ev.result === 'KWP' || ev.result === 'KPB') mm.k += 1;
        if (!NO_RBI_RES.has(ev.result)) mm.rbi += ev.advances.filter((a) => a.to === 'HOME').length;
      }
      // situacional: contexto ANTES de la jugada
      if (!isMidResult(ev.result) && ev.batterId) {
        const s = situOf(ev.batterId);
        const isHit = ['1B', '2B', '3B', 'HR', 'RHB', '1BE', '2BE', '3BE', 'HRIP'].includes(ev.result);
        if (st.bases[2] || st.bases[3]) { s.risp.ab += 1; if (isHit) s.risp.h += 1; }
        if (st.bases[1] && st.bases[2] && st.bases[3]) { s.loaded.ab += 1; if (isHit) s.loaded.h += 1; }
        if (st.outs === 2) { s.twoOut.ab += 1; if (isHit) s.twoOut.h += 1; }
        if (firstPaOfHalf) { s.leadoff.ab += 1; if (isHit) s.leadoff.h += 1; }
        firstPaOfHalf = false;
      }
      const prevHalf = st.half;
      st = applyEvent(st, ev, g.innings);
      if (st.half !== prevHalf) firstPaOfHalf = true;
    }

    // línea de equipo del juego (highs/lows) — de eventos o de statLines importadas
    const pushTgl = (side: 'away' | 'home', teamId: string, opp: string) => {
      const ls = statLines.filter((ln) => sideOf(ln.teamId) === side);
      const bl = ls.length ? ls : Object.values(box[side]);
      const pl = (ls.length
        ? ls.filter((l) => (l.gp ?? 0) || (l.pOuts ?? 0)).map((l) => ({ outs: l.pOuts ?? 0, h: l.pH ?? 0, r: l.pR ?? 0, bb: l.pBB ?? 0, k: l.pK ?? 0 }))
        : Object.values(box.pitchers).filter((l) => pitSide.get(l.playerId) === side));
      const rf = score[side], ra = side === 'away' ? score.home : score.away;
      teamGameLines.push({
        gameId: g.id, date: g.date, teamId, opp,
        res: g.tied || rf === ra ? 'T' : rf > ra ? 'W' : 'L',
        rf, ra, inn: g.innings,
        ab: bl.reduce((s, l) => s + (l.ab ?? 0), 0), h: bl.reduce((s, l) => s + (l.h ?? 0), 0),
        rbi: bl.reduce((s, l) => s + (l.rbi ?? 0), 0), bb: bl.reduce((s, l) => s + (l.bb ?? 0), 0),
        k: bl.reduce((s, l) => s + (l.k ?? 0), 0), sb: bl.reduce((s, l) => s + (l.sb ?? 0), 0),
        lob: box.lob[side], e: ls.length ? ls.reduce((s, l) => s + (l.e ?? 0), 0) : eCnt[side],
        pOuts: pl.reduce((s, l) => s + l.outs, 0), pH: pl.reduce((s, l) => s + l.h, 0),
        pR: pl.reduce((s, l) => s + l.r, 0), pBB: pl.reduce((s, l) => s + l.bb, 0), pK: pl.reduce((s, l) => s + l.k, 0),
      });
    };
    pushTgl('away', g.awayTeamId, g.homeTeam.shortName ?? g.homeTeam.name);
    pushTgl('home', g.homeTeamId, g.awayTeam.shortName ?? g.awayTeam.name);
  }

  // Correcciones manuales del acumulado (✏️ Editar stats en la tarjeta del
  // jugador): PlayerSeasonStat.adj = delta manual. Se suma sobre lo derivado
  // de los juegos para que líderes/tablas/reportes reflejen la corrección.
  for (const row of adjRows ?? []) {
    const a = (row.adj ?? null) as Record<string, number> | null;
    if (!a) continue;
    const pid = row.playerId;
    const b = batOf(pid);
    b.pa += a.pa ?? 0; b.ab += a.ab ?? 0; b.r += a.r ?? 0; b.h += a.h ?? 0;
    b.doubles += a.doubles ?? 0; b.triples += a.triples ?? 0; b.hr += a.hr ?? 0;
    b.rbi += a.rbi ?? 0; b.bb += a.bb ?? 0; b.k += a.k ?? 0; b.hbp += a.hbp ?? 0;
    b.sac += a.sac ?? 0; b.sf += a.sf ?? 0; b.sb += a.sb ?? 0;
    if (a.g) played.set(pid, (played.get(pid) ?? 0) + a.g);
    const p = pitOf(pid);
    p.gp += a.gp ?? 0; p.gs += a.gs ?? 0;
    p.outs += a.pOuts ?? 0; p.h += a.pH ?? 0; p.r += a.pR ?? 0; p.er += a.pER ?? 0;
    p.bb += a.pBB ?? 0; p.k += a.pK ?? 0; p.hr += a.pHR ?? 0; p.pitches += a.pPitches ?? 0;
    for (const [k, m] of [['w', dec.w], ['l', dec.l], ['sv', dec.sv], ['hld', dec.hld], ['bs', dec.bs], ['cg', dec.cg], ['sho', dec.sho]] as const) {
      if (a[k]) m.set(pid, (m.get(pid) ?? 0) + a[k]);
    }
    if (a.e) fldOf(pid).e += a.e;
  }

  const players = await prisma.player.findMany({
    where: { id: { in: [...playerIds, ...bat.keys(), ...pit.keys(), ...fld.keys()] } },
    include: { team: true },
  });
  const meta = new Map(players.map((p) => [p.id, {
    name: `${p.number ? `#${p.number} ` : ''}${p.firstName} ${p.lastName}`,
    teamId: p.teamId, teamName: p.team.name, shortName: p.team.shortName ?? p.team.name,
    number: p.number, bats: p.bats, throws: p.throws, positions: p.positions, photo: p.photo,
  }]));
  const metaOf = (pid: string) => meta.get(pid) ?? {
    name: '?', teamId: '', teamName: '?', shortName: '?',
    number: null, bats: null, throws: null, positions: null, photo: null,
  };

  const f3 = (n: number) => Number(n.toFixed(3));
  const f2 = (n: number) => Number(n.toFixed(2));

  const batting = [...bat.values()].map((b) => {
    const tb = b.h + b.doubles + 2 * b.triples + 3 * b.hr; // total bases
    const obpDen = b.ab + b.bb + b.hbp + b.sf;
    const slg = b.ab ? tb / b.ab : 0;
    const obp = obpDen ? (b.h + b.bb + b.hbp) / obpDen : 0;
    const s = situ.get(b.playerId);
    return {
      ...b, g: played.get(b.playerId) ?? 0, ...metaOf(b.playerId),
      avg: f3(b.ab ? b.h / b.ab : 0), obp: f3(obp), slg: f3(slg), ops: f3(obp + slg),
      iso: f3(slg - (b.ab ? b.h / b.ab : 0)),
      babip: f3(b.ab - b.k - b.hr + b.sf > 0 ? (b.h - b.hr) / (b.ab - b.k - b.hr + b.sf) : 0),
      situ: s ?? { risp: { ab: 0, h: 0 }, loaded: { ab: 0, h: 0 }, twoOut: { ab: 0, h: 0 }, leadoff: { ab: 0, h: 0 } },
    };
  }).sort((x, y) => y.ops - x.ops);

  // ERA/WHIP usan las entradas reglamentarias del torneo (9 baseball, 7 softball)
  const regInnings = games[0]?.innings ?? 9;
  const pitching = [...pit.values()].map((p) => {
    const ip = p.outs / 3;
    return {
      ...p, ip: f2(ip), ...metaOf(p.playerId),
      w: dec.w.get(p.playerId) ?? 0, l: dec.l.get(p.playerId) ?? 0,
      sv: dec.sv.get(p.playerId) ?? 0, hld: dec.hld.get(p.playerId) ?? 0,
      bs: dec.bs.get(p.playerId) ?? 0, cg: dec.cg.get(p.playerId) ?? 0, sho: dec.sho.get(p.playerId) ?? 0,
      era: f2(ip ? (p.er * regInnings) / ip : 0),
      whip: f2(ip ? (p.bb + p.h) / ip : 0),
      k9: f2(ip ? (p.k * regInnings) / ip : 0),
      bb9: f2(ip ? (p.bb * regInnings) / ip : 0),
      kbb: f2(p.bb ? p.k / p.bb : p.k),
      pIp: f2(ip ? p.pitches / ip : 0),
      avgAgainst: f3(p.abAg ? p.h / p.abAg : 0),
    };
  }).sort((x, y) => x.era - y.era);

  // ---- sabermetría de liga: wOBA/wRAA/FIP y WAR* estimado ----
  // Pesos wOBA (FanGraphs clásicos); la escala se deriva de la propia liga
  // (wOBAScale = lgOBP/lgWOBA) igual que el método oficial. RPW = carreras
  // totales por juego (aprox. runs-per-win de esta liga). Sin defensa/posición:
  // WAR* es ofensivo+pitcheo vs nivel de reemplazo — estimado, etiquetado.
  const W = { bb: 0.69, hbp: 0.72, s1: 0.88, d2: 1.25, t3: 1.58, hr: 2.08 };
  const lgBat = batting.reduce((s, b) => ({
    pa: s.pa + b.pa, ab: s.ab + b.ab, h: s.h + b.h, bb: s.bb + b.bb, hbp: s.hbp + b.hbp,
    sf: s.sf + b.sf, doubles: s.doubles + b.doubles, triples: s.triples + b.triples, hr: s.hr + b.hr,
  }), { pa: 0, ab: 0, h: 0, bb: 0, hbp: 0, sf: 0, doubles: 0, triples: 0, hr: 0 });
  const wobaNum = (x: { ab: number; h: number; bb: number; hbp: number; sf: number; doubles: number; triples: number; hr: number }) =>
    W.bb * x.bb + W.hbp * x.hbp + W.s1 * (x.h - x.doubles - x.triples - x.hr) + W.d2 * x.doubles + W.t3 * x.triples + W.hr * x.hr;
  const wobaDen = (x: { ab: number; bb: number; hbp: number; sf: number }) => x.ab + x.bb + x.hbp + x.sf;
  const lgWoba = wobaDen(lgBat) ? wobaNum(lgBat) / wobaDen(lgBat) : 0;
  const lgObp = wobaDen(lgBat) ? (lgBat.h + lgBat.bb + lgBat.hbp) / wobaDen(lgBat) : 0;
  const wobaScale = lgWoba > 0 && lgObp > 0 ? lgObp / lgWoba : 1.15;
  const totalRuns = teamTotals.size ? [...teamTotals.values()].reduce((s, t) => s + t.r, 0) : 0;
  const rpw = Math.max(4, totalRuns / Math.max(1, games.length)); // runs-per-win ≈ carreras/juego (ambos equipos)
  // FIP de liga para alinear: cFIP = lgERA - lgFIP
  const lgPit = pitching.reduce((s, p) => ({ outs: s.outs + p.outs, er: s.er + p.er, hr: s.hr + p.hr, bb: s.bb + p.bb, k: s.k + p.k }),
    { outs: 0, er: 0, hr: 0, bb: 0, k: 0 });
  const lgIp = lgPit.outs / 3;
  const lgEra = lgIp ? (lgPit.er * regInnings) / lgIp : 0;
  const lgFip = lgIp ? (13 * lgPit.hr + 3 * lgPit.bb - 2 * lgPit.k) / lgIp : 0;
  const cFip = lgEra - lgFip;

  const battingSab = batting.map((b) => {
    const woba = wobaDen(b) ? wobaNum(b) / wobaDen(b) : 0;
    const wraa = wobaScale ? ((woba - lgWoba) / wobaScale) * b.pa : 0;
    const repRuns = b.pa * (20 / 600); // nivel de reemplazo ~ +20 runs / 600 PA
    return { playerId: b.playerId, woba: f3(woba), wraa: f2(wraa), war: f2((wraa + repRuns) / rpw) };
  });
  const warBat = new Map(battingSab.map((x) => [x.playerId, x]));
  const battingOut = batting.map((b) => ({ ...b, ...(warBat.get(b.playerId) ?? { woba: 0, wraa: 0, war: 0 }) }));

  const pitchingOut = pitching.map((p) => {
    const ip = p.outs / 3;
    const fip = ip ? (13 * p.hr + 3 * p.bb - 2 * p.k) / ip + cFip : 0;
    // WAR pitcheo: (lgERA - FIP)/RPW por entrada + ~0.08 WAR por juego de reemplazo
    const war = ip ? ((lgEra - fip) / rpw + 0.08) * (ip / regInnings) : 0;
    return { ...p, fip: f2(fip), war: f2(war) };
  });

  const fielding = [...fld.values()].map((f) => ({
    ...f, ...metaOf(f.playerId),
    tc: f.po + f.a + f.e,
    fpct: f3(f.po + f.a + f.e > 0 ? (f.po + f.a) / (f.po + f.a + f.e) : 1),
  })).sort((x, y) => y.tc - x.tc);

  // errores del equipo = suma de errores de sus jugadores
  for (const f of fielding) {
    const tt = teamTotals.get(f.teamId);
    if (tt) tt.e += f.e;
  }

  return {
    batting: battingOut, pitching: pitchingOut, fielding,
    teamTotals: [...teamTotals.values()], games: games.length,
    results, boxes, playerLog, meta, teamGameLines, matchups,
  };
}

export async function leagueStats(leagueId: string, phase: 'reg' | 'post' | 'all' = 'reg', filter: SeasonFilter = {}, round?: number) {
  const games = await prisma.game.findMany({
    where: {
      leagueId, status: 'FINAL',
      // regular excluye playoffs; post solo series (con round = solo una
      // fase: eliminación/semifinal/final, estilo MLB por ronda); all todo
      ...(phase === 'reg' ? { seriesId: null }
        : phase === 'post' ? { seriesId: { not: null }, ...(round ? { series: { is: { round } } } : {}) }
        : {}),
      ...seasonGameWhere(filter), // temporada: Season explícita o año de fecha
    },
    orderBy: { date: 'asc' },
    include: GAME_STATS_INCLUDE,
  });
  const leagueTeams = await prisma.team.findMany({ where: { leagueId } });
  // Correcciones manuales del acumulado (PlayerSeasonStat.adj): se aplican al
  // scope de la fase vista (reg→REG, post→POST, all→ambas), al año filtrado
  // (o a todos en histórico) y solo a jugadores cuyo equipo ACTUAL está en
  // esta liga — PlayerSeasonStat no lleva leagueId y el delta es por año.
  const scopes = phase === 'post' ? ['POST'] : phase === 'reg' ? ['REG'] : ['REG', 'POST'];
  let years: number[] | undefined;
  if (filter.seasonId) {
    const s = await prisma.season.findUnique({ where: { id: filter.seasonId }, select: { year: true } });
    years = s ? [s.year] : [];
  } else if (filter.year) years = [filter.year];
  const adjRows = await prisma.playerSeasonStat.findMany({
    where: {
      scope: { in: scopes },
      ...(years ? { season: { in: years } } : {}),
      player: { teamId: { in: leagueTeams.map((t) => t.id) } },
      adj: { not: Prisma.DbNull },
    },
    select: { playerId: true, adj: true },
  });
  return aggregateGames(games, leagueTeams, adjRows);
}

r.get('/:id/stats', async (req, res) => {
  const phase = req.query.phase === 'post' ? 'post' : req.query.phase === 'all' ? 'all' : 'reg';
  const year = Number(req.query.year) || undefined;
  const seasonId = req.query.season ? String(req.query.season) : undefined;
  // ?round=N → solo juegos de series de esa ronda (eliminatoria/semifinal/final)
  const round = Number(req.query.round) || undefined;
  res.json(await leagueStats(req.params.id, phase, { year, seasonId }, round));
});

/**
 * Splits de tiempo (BallStat): mismo agregado por mes calendario,
 * por ventanas de últimos N juegos (4/6/10) y rachas por jugador
 * (juegos con hit / embasándose / ponchándose / sequía sin hit).
 */
r.get('/:id/splits', async (req, res) => {
  const splitSeason = req.query.season ? String(req.query.season) : undefined;
  const games = await prisma.game.findMany({
    where: {
      leagueId: req.params.id, status: 'FINAL', seriesId: null, // splits = temporada regular
      ...(splitSeason ? { seasonId: splitSeason } : {}),
    },
    orderBy: { date: 'asc' },
    include: GAME_STATS_INCLUDE,
  });
  const leagueTeams = await prisma.team.findMany({ where: { leagueId: req.params.id } });

  // por mes calendario
  const byMonthGames = new Map<string, StatsGame[]>();
  for (const g of games) {
    const key = new Date(g.date).toISOString().slice(0, 7); // YYYY-MM
    if (!byMonthGames.has(key)) byMonthGames.set(key, []);
    byMonthGames.get(key)!.push(g);
  }
  const byMonth = await Promise.all([...byMonthGames.entries()].map(async ([month, gs]) => ({
    month, ...(await aggregateGames(gs, leagueTeams)),
  })));

  // últimos N juegos (ventanas 4/6/10 sobre el orden de fecha)
  const lastN = await Promise.all([4, 6, 10].map(async (n) => ({
    n, ...(await aggregateGames(games.slice(-n), leagueTeams)),
  })));

  // rachas por jugador: replay juego a juego en orden de fecha
  const streaks = new Map<string, {
    playerId: string; hitCur: number; hitBest: number; obCur: number; obBest: number;
    kCur: number; kBest: number; droughtCur: number; droughtBest: number;
  }>();
  const sOf = (pid: string) => {
    if (!streaks.has(pid)) streaks.set(pid, {
      playerId: pid, hitCur: 0, hitBest: 0, obCur: 0, obBest: 0, kCur: 0, kBest: 0, droughtCur: 0, droughtBest: 0,
    });
    return streaks.get(pid)!;
  };
  for (const g of games) {
    const box = computeBoxscore(await loadEvents(g.id), g.innings);
    for (const line of [...Object.values(box.away), ...Object.values(box.home)]) {
      const s = sOf(line.playerId);
      const hit = line.h > 0, onBase = line.h + line.bb + line.hbp > 0, whiffed = line.k > 0, dry = line.ab > 0 && line.h === 0;
      s.hitCur = hit ? s.hitCur + 1 : 0; s.hitBest = Math.max(s.hitBest, s.hitCur);
      s.obCur = onBase ? s.obCur + 1 : 0; s.obBest = Math.max(s.obBest, s.obCur);
      s.kCur = whiffed ? s.kCur + 1 : 0; s.kBest = Math.max(s.kBest, s.kCur);
      s.droughtCur = dry ? s.droughtCur + 1 : 0; s.droughtBest = Math.max(s.droughtBest, s.droughtCur);
    }
  }
  const streakPlayers = await prisma.player.findMany({
    where: { id: { in: [...streaks.keys()] } }, include: { team: true },
  });
  const meta = new Map(streakPlayers.map((p) => [p.id, {
    name: `${p.number ? `#${p.number} ` : ''}${p.firstName} ${p.lastName}`,
    shortName: p.team.shortName ?? p.team.name,
  }]));

  res.json({
    byMonth, lastN,
    streaks: [...streaks.values()].map((s) => ({ ...s, ...(meta.get(s.playerId) ?? { name: '?', shortName: '?' }) }))
      .sort((a, b) => b.hitCur - a.hitCur || b.hitBest - a.hitBest),
  });
});

// ============================================================================
// Website Builder (ver website.ts — sitio navegable estilo BallStat)
// ============================================================================
r.get('/:id/website', async (req, res) => {
  const html = await websiteHtml(req.params.id);
  if (!html) return res.status(404).send('Liga no encontrada');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.query.dl) {
    const league = await prisma.league.findUnique({ where: { id: req.params.id } });
    const slug = (league?.name ?? 'liga').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}_${league?.year ?? ''}.html"`);
  }
  res.send(html);
});

export default r;
