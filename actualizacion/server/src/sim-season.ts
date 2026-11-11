import { PrismaClient, type Prisma } from '@prisma/client';
import { applyEvent, defaultAdvances, initialState, type Advance, type GameState, type PlayResult } from '@poxscore/shared';

const prisma = new PrismaClient();
const API = 'http://localhost:4000/api';

/**
 * Simulador de temporada casi completa para la liga de prueba.
 * Crea juegos con stream de eventos realista (pitch a pitch), lineups y
 * cierra con /finish para acumular PlayerSeasonStat.
 * Uso: npx tsx src/sim-season.ts
 */

const rnd = () => Math.random();
const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];

// posición defensiva → número de notación (P=1 … RF=9)
const POSNUM: Record<string, number> = { P: 1, C: 2, '1B': 3, '2B': 4, '3B': 5, SS: 6, LF: 7, CF: 8, RF: 9 };
const DEF_POS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'EH']; // softball

interface SimPlayer { id: string }
interface SideCtx {
  order: string[];          // orden de bateo (playerIds)
  fielder: Map<number, string>; // posnum → playerId (defensa)
  pitcher: string; reliever: string;
  pitcherAtInning: Map<number, string>; // relevo: a partir de entrada 5
}

function mkSide(players: SimPlayer[]): SideCtx {
  // 10 titulares con posición; order = los primeros 10; relevista = otro P
  const batters = players.slice(0, DEF_POS.length);
  const order = batters.map((p) => p.id);
  const fielder = new Map<number, string>();
  batters.forEach((p, i) => {
    const n = POSNUM[DEF_POS[i]];
    if (n) fielder.set(n, p.id);
  });
  const starter = fielder.get(1)!;
  const reliever = players[DEF_POS.length]?.id ?? starter; // 2do pitcher del roster
  const pitcherAtInning = new Map<number, string>();
  for (let i = 1; i <= 12; i++) pitcherAtInning.set(i, i >= 5 ? reliever : starter);
  return { order, fielder, pitcher: starter, reliever, pitcherAtInning };
}

// créditos de fildeo desde la notación — replica fieldingCredits de events.ts
function credits(fielder: Map<number, string>, notation: string | null, result: string, outsOnPlay: number) {
  const po: string[] = []; const a: string[] = []; const e: string[] = [];
  const at = (n: number) => fielder.get(n);
  if (result === 'K') { const c = at(2); if (c) po.push(c); return { po, a, e }; }
  if (!notation) return { po, a, e }; // hits, BB, mids: sin créditos de fildeo
  const err = /E(\d)/.exec(notation);
  if (err) { const p = at(Number(err[1])); if (p) e.push(p); return { po, a, e }; }
  if (!outsOnPlay) return { po, a, e }; // hit con dirección ("9", "F8"): solo localiza, no acredita
  const fly = /[FLP](\d)/.exec(notation);
  if (fly) { const p = at(Number(fly[1])); if (p) po.push(p); return { po, a, e }; }
  const nums = notation.split('-').map((t) => Number(t.replace(/^[A-Z]+/i, ''))).filter(Boolean);
  if (nums.length) {
    const last = nums[nums.length - 1];
    for (const n of nums.slice(0, -1)) { const p = at(n); if (p) a.push(p); }
    const p = at(last); if (p) po.push(p);
    // DP: 2 outs → el corredor también cae por el penúltimo (aprox. 6-4-3: 4 cubre, 3 captura)
    if (outsOnPlay >= 2 && nums.length >= 3) { const p2 = at(nums[nums.length - 2]); if (p2 && !po.includes(p2)) po.push(p2); }
  }
  return { po, a, e };
}

// trayectoria del batazo (prefijo de la notación): pesos tipo MLB — G rola, L línea, F elevado
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

async function simulateGame(away: SideCtx & { teamId: string }, home: SideCtx & { teamId: string }, leagueId: string, date: Date) {
  const innings = 7; // softball
  const game = await prisma.game.create({
    data: { leagueId, awayTeamId: away.teamId, homeTeamId: home.teamId, sport: 'softball', innings, date, status: 'SCHEDULED' },
  });
  // lineups
  const entries = [] as { gameId: string; teamId: string; playerId: string; order: number; position: string; role: string; active: boolean; batsInOrder: boolean }[];
  for (const [side, ctx] of [['away', away], ['home', home]] as const) {
    ctx.order.forEach((pid, i) => entries.push({ gameId: game.id, teamId: ctx.teamId, playerId: pid, order: i + 1, position: DEF_POS[i], role: 'STARTER', active: true, batsInOrder: true }));
    entries.push({ gameId: game.id, teamId: ctx.teamId, playerId: ctx.reliever, order: 99, position: 'P', role: 'SUB', active: true, batsInOrder: false });
  }
  await prisma.lineupEntry.createMany({ data: entries });

  let s = initialState();
  let seq = 1;
  const evs: Prisma.GameEventCreateManyInput[] = [];
  const idx = { TOP: 0, BOTTOM: 0 };
  const push = (result: PlayResult | string, notation: string | null, advances: Advance[], batterId: string | null, pitcherId: string | null, extra?: { po?: string[]; a?: string[]; e?: string[] }) => {
    const def = s.half === 'TOP' ? home : away; // defensa = lado contrario al que batea
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
    void extra;
  };

  let guard = 0;
  while (s.status !== 'FINAL' && guard++ < 800) {
    const bat = s.half === 'TOP' ? away : home;
    const def = s.half === 'TOP' ? home : away;
    const batter = bat.order[idx[s.half] % bat.order.length];
    const pitcher = def.pitcherAtInning.get(Math.min(s.inning, 12)) ?? def.pitcher;

    // turno pitch a pitch (conteo B-S-F) hasta cerrar
    let balls = 0, strikes = 0;
    for (;;) {
      const battingHalf = s.half; // capturar antes de que el 3er out voltee la mitad
      if (balls >= 4) {
        push('BB', null, defaultAdvances(s, batter, 'BB' as never), batter, pitcher);
        idx[battingHalf]++;
        break;
      }
      if (strikes >= 3) {
        push('K', null, defaultAdvances(s, batter, 'K' as never), batter, pitcher);
        idx[battingHalf]++;
        break;
      }
      const r = rnd();
      // zona del pitcheo "Zrc" (r/c 0-4, zona = 1-3): bolas tienden fuera, strikes dentro
      const zB = () => `Z${pick([0, 0, 1, 2, 3, 4, 4])}${pick([0, 1, 2, 3, 4, 4])}`;
      const zS = () => `Z${pick([1, 1, 2, 2, 3, 3, 0, 4])}${pick([1, 1, 2, 2, 3, 3, 0, 4])}`;
      if (r < 0.30) { balls++; push('B', zB(), [], batter, pitcher); continue; }
      if (r < 0.52) { strikes = Math.min(3, strikes + 1); push('S', zS(), [], batter, pitcher); continue; }
      if (r < 0.58) { strikes = Math.min(2, strikes + 1); push('F', zS(), [], batter, pitcher); continue; }
      // jugada en juego / base por bolas / robo ocasional
      if (s.bases[1] && !s.bases[2] && rnd() < 0.06) { push('SB', null, [{ playerId: s.bases[1]!, to: 2 }], batter, pitcher); continue; }
      const { result, notation } = inPlayResult(s);
      const adv = defaultAdvances(s, batter, result as never);
      push(result as never, notation, adv, batter, pitcher);
      idx[battingHalf]++;
      break;
    }
    // nota: nuestro idx propio avanza solo en cierre de turno — SK/LG no se usan aquí
  }

  if (evs.length) await prisma.gameEvent.createMany({ data: evs });

  // cerrar con decisiones sugeridas (W/L/SV) → FINAL + acumula temporada
  const fd = await (await fetch(`${API}/games/${game.id}/finish-data`)).json() as { tied?: boolean; suggestedWpId?: string; suggestedLpId?: string };
  const score = s.score;
  const tied = score.away === score.home;
  await fetch(`${API}/games/${game.id}/finish`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tied ? { tied: true } : { wpId: fd.suggestedWpId, lpId: fd.suggestedLpId }),
  });
  return { id: game.id, score, tied };
}

async function main() {
  const league = await prisma.league.findFirst({ where: { name: 'Liga Test' }, include: { teams: { include: { players: { where: { active: true }, orderBy: { number: 'asc' } } } } } });
  if (!league || league.teams.length < 2) throw new Error('Corre reset-seed.ts primero');
  const teams = league.teams;
  console.log(`Simulando temporada: ${teams.length} equipos, round-robin ×4 (~${teams.length * (teams.length - 1) * 2} juegos)`);

  const base = new Date('2026-01-10T18:00:00');
  let gi = 0, done = 0;
  // cada pareja juega 4 veces (2 como local cada uno)
  for (let i = 0; i < teams.length; i++) {
    for (let j = 0; j < teams.length; j++) {
      if (i === j) continue;
      for (let rep = 0; rep < 2; rep++) {
        const away = { teamId: teams[i].id, ...mkSide(teams[i].players) };
        const home = { teamId: teams[j].id, ...mkSide(teams[j].players) };
        const date = new Date(base.getTime() + Math.floor(gi / 3) * 86400000 + (gi % 3) * 7200000);
        const r = await simulateGame(away, home, league.id, date);
        gi++;
        if (++done % 10 === 0) console.log(`  ${done} juegos…`);
        void r;
      }
    }
  }
  console.log(`\n✅ ${done} juegos simulados (round-robin completo)`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
