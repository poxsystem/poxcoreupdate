import { PrismaClient, type Prisma } from '@prisma/client';
import { applyEvent, defaultAdvances, initialState, type Advance, type GameState, type PlayResult } from '@poxscore/shared';

/**
 * Maquinaria compartida de simulación (liga ejemplo, historia, playoffs):
 * simula un juego jugada a jugada con el motor real y lo cierra con /finish
 * → decisiones W/L + PlayerSeasonStat por temporada (REG o POST si hay serie).
 */

export const API = 'http://localhost:4000/api';

export const rnd = () => Math.random();
export const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];
export const shuffle = <T,>(arr: T[]) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export const POSNUM: Record<string, number> = { P: 1, C: 2, '1B': 3, '2B': 4, '3B': 5, SS: 6, LF: 7, CF: 8, RF: 9 };
// posiciones de la hoja de softball (EH = bateador extra)
export const FIELD_POS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'EH'];

export interface SideCtx {
  order: string[];
  fielder: Map<number, string>;
  pitcher: string; reliever: string;
  pitcherAtInning: Map<number, string>;
}

/** Alineación de un juego: pitcher abridor batea 10º + relevo desde el 5º. */
export function mkSide(pitcherIds: string[], fielderIds: string[]): SideCtx {
  const pitcher = pick(pitcherIds);
  const reliever = pick(pitcherIds.filter((p) => p !== pitcher)) ?? pitcher;
  const fielders = shuffle(fielderIds).slice(0, FIELD_POS.length);
  const order = [...fielders, pitcher]; // el pitcher batea de último
  const fielder = new Map<number, string>();
  fielders.forEach((pid, i) => { const n = POSNUM[FIELD_POS[i]]; if (n) fielder.set(n, pid); });
  fielder.set(1, pitcher);
  const pitcherAtInning = new Map<number, string>();
  for (let i = 1; i <= 12; i++) pitcherAtInning.set(i, i >= 5 ? reliever : pitcher);
  return { order, fielder, pitcher, reliever, pitcherAtInning };
}

function credits(fielder: Map<number, string>, notation: string | null, result: string, outsOnPlay: number) {
  const po: string[] = []; const a: string[] = []; const e: string[] = [];
  const at = (n: number) => fielder.get(n);
  if (result === 'K') { const c = at(2); if (c) po.push(c); return { po, a, e }; }
  if (!notation) return { po, a, e };
  const err = /E(\d)/.exec(notation);
  if (err) { const p = at(Number(err[1])); if (p) e.push(p); return { po, a, e }; }
  if (!outsOnPlay) return { po, a, e };
  const fly = /[FLP](\d)/.exec(notation);
  if (fly) { const p = at(Number(fly[1])); if (p) po.push(p); return { po, a, e }; }
  const nums = notation.split('-').map((t) => Number(t.replace(/^[A-Z]+/i, ''))).filter(Boolean);
  if (nums.length) {
    const last = nums[nums.length - 1];
    for (const n of nums.slice(0, -1)) { const p = at(n); if (p) a.push(p); }
    const p = at(last); if (p) po.push(p);
    if (outsOnPlay >= 2 && nums.length >= 3) { const p2 = at(nums[nums.length - 2]); if (p2 && !po.includes(p2)) po.push(p2); }
  }
  return { po, a, e };
}

function traj(weights: [number, number, number]): 'G' | 'L' | 'F' {
  const r = rnd() * 100;
  return r < weights[0] ? 'G' : r < weights[0] + weights[1] ? 'L' : 'F';
}

function inPlayResult(s: GameState): { result: string; notation: string | null } {
  const r1 = !!s.bases[1], r2 = !!s.bases[2], r3 = !!s.bases[3];
  const under2 = s.outs < 2;
  const r = rnd() * 100;
  if (r < 18) return { result: '1B', notation: `${traj([45, 25, 30])}${pick([7, 8, 9, 7, 8, 9, 3, 4, 5, 6])}` };
  if (r < 23) return { result: '2B', notation: `${traj([10, 40, 50])}${pick([7, 8, 9])}` };
  if (r < 24) return { result: '3B', notation: `${traj([10, 35, 55])}${pick([7, 8, 9])}` };
  if (r < 28) return { result: 'HR', notation: `${traj([0, 20, 80])}${pick([7, 8, 9])}` };
  if (r < 34) return { result: 'E', notation: `E${pick([3, 4, 5, 6])}` };
  if (r < 38) return r1 ? { result: 'FC', notation: `G${pick([4, 5, 6])}-4` } : { result: 'GO', notation: `${pick([1, 3, 4, 5, 6])}-3` };
  if (r < 60) return { result: 'GO', notation: `${pick([1, 3, 4, 5, 6])}-3` };
  if (r < 78) return { result: 'FO', notation: `F${pick([5, 6, 7, 8, 9])}` };
  if (r < 84) return { result: 'LO', notation: `L${pick([1, 3, 4, 5, 6])}` };
  if (r < 86) return r3 && under2 ? { result: 'SF', notation: `F${pick([7, 8, 9])}` } : { result: 'FO', notation: `F${pick([7, 8, 9])}` };
  if (r < 88) return (r1 || r2) && under2 ? { result: 'SAC', notation: `${pick([1, 3])}-4` } : { result: 'GO', notation: '3-1' };
  if (r < 92) return r1 && under2 ? { result: 'DP', notation: `G${pick(['6-4-3', '5-4-3', '4-6-3'])}` } : { result: 'GO', notation: '6-3' };
  if (r < 93) return r1 || r2 ? { result: 'IF', notation: `F${pick([4, 5, 6])}` } : { result: 'FO', notation: 'F7' };
  return { result: 'FO', notation: `F${pick([3, 7, 8, 9])}` };
}

export interface SimGameOpts {
  leagueId: string;
  seasonId: string;
  seriesId?: string | null;   // juego de playoff → stats scope POST
  sport?: string;
  innings?: number;
  stadium?: string;
}

/**
 * Crea el juego (SCHEDULED) y, si playIt, lo simula jugada a jugada + /finish.
 * Devuelve id + marcador final (para avanzar la serie).
 */
export async function simulateGame(
  prisma: PrismaClient,
  away: SideCtx & { teamId: string },
  home: SideCtx & { teamId: string },
  date: Date,
  opts: SimGameOpts,
  playIt = true,
): Promise<{ id: string; awayScore: number; homeScore: number; tied: boolean }> {
  const sport = opts.sport ?? 'softball';
  const innings = opts.innings ?? (sport === 'softball' ? 7 : 9);
  const game = await prisma.game.create({
    data: {
      leagueId: opts.leagueId, seasonId: opts.seasonId, seriesId: opts.seriesId ?? null,
      awayTeamId: away.teamId, homeTeamId: home.teamId, sport, innings, date,
      stadium: opts.stadium, status: 'SCHEDULED',
    },
  });
  if (!playIt) return { id: game.id, awayScore: 0, homeScore: 0, tied: false };

  const entries = [] as { gameId: string; teamId: string; playerId: string; order: number; position: string; role: string; active: boolean; batsInOrder: boolean }[];
  for (const ctx of [away, home]) {
    ctx.order.forEach((pid, i) => entries.push({
      gameId: game.id, teamId: ctx.teamId, playerId: pid, order: i + 1,
      position: i < FIELD_POS.length ? FIELD_POS[i] : 'P', role: 'STARTER', active: true, batsInOrder: true,
    }));
    if (ctx.reliever !== ctx.pitcher) entries.push({ gameId: game.id, teamId: ctx.teamId, playerId: ctx.reliever, order: 99, position: 'P', role: 'SUB', active: true, batsInOrder: false });
  }
  await prisma.lineupEntry.createMany({ data: entries });

  let s = initialState();
  let seq = 1;
  const evs: Prisma.GameEventCreateManyInput[] = [];
  const idx = { TOP: 0, BOTTOM: 0 };
  const push = (result: PlayResult | string, notation: string | null, advances: Advance[], batterId: string | null, pitcherId: string | null) => {
    const def = s.half === 'TOP' ? home : away;
    const cred = credits(def.fielder, notation, result, advances.filter((x) => x.to === 'OUT').length);
    evs.push({
      gameId: game.id, seq: seq++, inning: s.inning, half: s.half,
      batterId, pitcherId, result, notation,
      putouts: cred.po.length ? JSON.stringify(cred.po) : null,
      assists: cred.a.length ? JSON.stringify(cred.a) : null,
      errorOn: cred.e.length ? JSON.stringify(cred.e) : null,
      advances: advances as never,
    });
    s = applyEvent(s, evs[evs.length - 1] as never, innings);
  };

  let guard = 0;
  while (s.status !== 'FINAL' && guard++ < 800) {
    const bat = s.half === 'TOP' ? away : home;
    const def = s.half === 'TOP' ? home : away;
    const batter = bat.order[idx[s.half] % bat.order.length];
    const pitcher = def.pitcherAtInning.get(Math.min(s.inning, 12)) ?? def.pitcher;

    let balls = 0, strikes = 0;
    for (;;) {
      const battingHalf = s.half;
      if (balls >= 4) { push('BB', null, defaultAdvances(s, batter, 'BB' as never), batter, pitcher); idx[battingHalf]++; break; }
      if (strikes >= 3) { push('K', null, defaultAdvances(s, batter, 'K' as never), batter, pitcher); idx[battingHalf]++; break; }
      const r = rnd();
      const zB = () => `Z${pick([0, 0, 1, 2, 3, 4, 4])}${pick([0, 1, 2, 3, 4, 4])}`;
      const zS = () => `Z${pick([1, 1, 2, 2, 3, 3, 0, 4])}${pick([1, 1, 2, 2, 3, 3, 0, 4])}`;
      if (r < 0.30) { balls++; push('B', zB(), [], batter, pitcher); continue; }
      if (r < 0.52) { strikes = Math.min(3, strikes + 1); push('S', zS(), [], batter, pitcher); continue; }
      if (r < 0.58) { strikes = Math.min(2, strikes + 1); push('F', zS(), [], batter, pitcher); continue; }
      if (s.bases[1] && !s.bases[2] && rnd() < 0.06) { push('SB', null, [{ playerId: s.bases[1]!, to: 2 }], batter, pitcher); continue; }
      const { result, notation } = inPlayResult(s);
      const adv = defaultAdvances(s, batter, result as never);
      push(result as never, notation, adv, batter, pitcher);
      idx[battingHalf]++;
      break;
    }
  }

  if (evs.length) await prisma.gameEvent.createMany({ data: evs });
  await prisma.game.update({ where: { id: game.id }, data: { status: 'LIVE', startedAt: date } });

  const fd = await (await fetch(`${API}/games/${game.id}/finish-data`)).json() as { suggestedWpId?: string; suggestedLpId?: string };
  const tied = s.score.away === s.score.home;
  await fetch(`${API}/games/${game.id}/finish`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tied ? { tied: true } : { wpId: fd.suggestedWpId, lpId: fd.suggestedLpId }),
  });
  return { id: game.id, awayScore: s.score.away, homeScore: s.score.home, tied };
}

/** Abre una temporada nueva en la liga (cierra la anterior). */
export async function openSeason(prisma: PrismaClient, leagueId: string, year: number) {
  const [season] = await prisma.$transaction([
    prisma.season.create({ data: { leagueId, year } }),
    prisma.season.updateMany({ where: { leagueId, year: { not: year } }, data: { status: 'ENDED' } }),
    prisma.league.update({ where: { id: leagueId }, data: { year } }),
  ]);
  return season;
}
