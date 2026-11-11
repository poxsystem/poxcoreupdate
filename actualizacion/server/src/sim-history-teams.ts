import { PrismaClient, type Prisma } from '@prisma/client';
import { applyEvent, defaultAdvances, initialState, type Advance, type GameState, type PlayResult } from '@poxscore/shared';

const prisma = new PrismaClient();
const API = 'http://localhost:4000/api';

/**
 * Simulador de HISTORIA v2 — temporadas 2022-2025 de "Liga Test" con los
 * JUGADORES REALES de la liga (los que aparecen en los juegos 2026).
 *
 * Por qué v2: la v1 (sim-history.ts) creaba jugadores ficticios por año, así
 * que la tarjeta de un jugador real solo mostraba 2026. Aquí:
 *  - Se borran los juegos <2026 de la sim anterior + sus stats + los
 *    jugadores ficticios que solo existían en ellos.
 *  - La plantilla "real" = jugadores que aparecen en lineups/eventos de
 *    juegos con fecha >= 2026, agrupados por su equipo actual.
 *  - Cada año 2022-2025 juega round-robin ida/vuelta (42 juegos) con los
 *    equipos reales; entre años se simulan TRASPASOS persistentes (2-3 por
 *    equipo) → la tarjeta muestra "Liga Test 2022–2026" con una fila por
 *    año y su equipo, igual que una carrera real.
 *  - Los juegos se cierran con /finish → PlayerSeasonStat por año.
 *
 * Uso: npx tsx src/sim-history-teams.ts   (requiere el server corriendo)
 */

const rnd = () => Math.random();
const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];
const shuffle = <T,>(arr: T[]) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const POSNUM: Record<string, number> = { P: 1, C: 2, '1B': 3, '2B': 4, '3B': 5, SS: 6, LF: 7, CF: 8, RF: 9 };
const DEF_POS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'EH']; // softball

interface SideCtx {
  order: string[];
  fielder: Map<number, string>;
  pitcher: string; reliever: string;
  pitcherAtInning: Map<number, string>;
}

function mkSide(playerIds: string[]): SideCtx {
  const batters = playerIds.slice(0, DEF_POS.length);
  const order = batters;
  const fielder = new Map<number, string>();
  batters.forEach((pid, i) => {
    const n = POSNUM[DEF_POS[i]];
    if (n) fielder.set(n, pid);
  });
  const starter = fielder.get(1)!;
  const reliever = playerIds[DEF_POS.length] ?? starter;
  const pitcherAtInning = new Map<number, string>();
  for (let i = 1; i <= 12; i++) pitcherAtInning.set(i, i >= 5 ? reliever : starter);
  return { order, fielder, pitcher: starter, reliever, pitcherAtInning };
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

async function simulateGame(away: SideCtx & { teamId: string }, home: SideCtx & { teamId: string }, leagueId: string, date: Date) {
  const innings = 7; // softball
  const game = await prisma.game.create({
    data: { leagueId, awayTeamId: away.teamId, homeTeamId: home.teamId, sport: 'softball', innings, date, status: 'SCHEDULED' },
  });
  const entries = [] as { gameId: string; teamId: string; playerId: string; order: number; position: string; role: string; active: boolean; batsInOrder: boolean }[];
  for (const ctx of [away, home]) {
    ctx.order.forEach((pid, i) => entries.push({ gameId: game.id, teamId: ctx.teamId, playerId: pid, order: i + 1, position: DEF_POS[i], role: 'STARTER', active: true, batsInOrder: true }));
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

  const fd = await (await fetch(`${API}/games/${game.id}/finish-data`)).json() as { suggestedWpId?: string; suggestedLpId?: string };
  const tied = s.score.away === s.score.home;
  await fetch(`${API}/games/${game.id}/finish`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tied ? { tied: true } : { wpId: fd.suggestedWpId, lpId: fd.suggestedLpId }),
  });
}

async function main() {
  const league = await prisma.league.findFirstOrThrow({ where: { name: 'Liga Test' }, include: { teams: true } });
  const teamIds = league.teams.map((t) => t.id);
  console.log(`Liga Test: ${league.teams.map((t) => t.name).join(', ')}`);

  // ── 1. jugadores "reales": los que aparecen en juegos con fecha >= 2026 ──
  const realGames = await prisma.game.findMany({ where: { leagueId: league.id, date: { gte: new Date(2026, 0, 1) } }, select: { id: true } });
  const realGameIds = realGames.map((g) => g.id);
  const [luRefs, evRefs] = await Promise.all([
    prisma.lineupEntry.findMany({ where: { gameId: { in: realGameIds } }, select: { playerId: true, teamId: true } }),
    prisma.gameEvent.findMany({ where: { gameId: { in: realGameIds }, OR: [{ batterId: { not: null } }, { pitcherId: { not: null } }] }, select: { batterId: true, pitcherId: true } }),
  ]);
  const realTeamOf = new Map<string, string>(); // playerId → su equipo real (por lineup 2026)
  for (const l of luRefs) realTeamOf.set(l.playerId, l.teamId);
  const realIds = new Set([...realTeamOf.keys()]);
  for (const e of evRefs) { if (e.batterId) realIds.add(e.batterId); if (e.pitcherId) realIds.add(e.pitcherId); }
  // fallback: si no está en lineups, su teamId actual dentro de la liga
  const realPlayers = await prisma.player.findMany({ where: { id: { in: [...realIds] } }, select: { id: true, teamId: true, firstName: true, lastName: true } });
  for (const p of realPlayers) if (!realTeamOf.has(p.id)) realTeamOf.set(p.id, p.teamId);
  console.log(`${realIds.size} jugadores reales en juegos 2026`);

  // ── 2. borrar la sim v1: juegos <2026 + stats + jugadores ficticios ──
  const oldGames = await prisma.game.findMany({ where: { leagueId: league.id, date: { lt: new Date(2026, 0, 1) } }, select: { id: true } });
  const oldIds = oldGames.map((g) => g.id);
  if (oldIds.length) {
    // jugadores ficticios de la sim v1 = referenciados SOLO en juegos viejos
    const oldLu = await prisma.lineupEntry.findMany({ where: { gameId: { in: oldIds } }, select: { playerId: true } });
    const oldEv = await prisma.gameEvent.findMany({ where: { gameId: { in: oldIds } }, select: { batterId: true, pitcherId: true } });
    const simOnly = new Set<string>();
    for (const l of oldLu) if (!realIds.has(l.playerId)) simOnly.add(l.playerId);
    for (const e of oldEv) for (const pid of [e.batterId, e.pitcherId]) if (pid && !realIds.has(pid)) simOnly.add(pid);

    await prisma.gameEvent.deleteMany({ where: { gameId: { in: oldIds } } });
    await prisma.lineupEntry.deleteMany({ where: { gameId: { in: oldIds } } });
    await prisma.playerSeasonStat.deleteMany({ where: { season: { lt: 2026 } } });
    await prisma.game.deleteMany({ where: { id: { in: oldIds } } });
    const delP = await prisma.player.deleteMany({ where: { id: { in: [...simOnly] } } });
    console.log(`🗑 ${oldIds.length} juegos viejos borrados · ${delP.count} jugadores ficticios eliminados`);
  }

  // ── 3. plantillas por año con traspasos persistentes ──
  // roster[teamId] = playerIds reales; evoluciona año a año.
  // Fuente: jugadores en juegos 2026 + activos registrados del equipo
  // (incluye titulares que no jugaron aún — reciben historia también)
  const roster = new Map<string, string[]>();
  for (const tid of teamIds) roster.set(tid, []);
  for (const p of realPlayers) {
    const tid = realTeamOf.get(p.id) ?? p.teamId;
    if (roster.has(tid)) roster.get(tid)!.push(p.id);
  }
  // jugadores reales sin equipo en la liga → al equipo con menos
  for (const p of realPlayers) {
    if (!teamIds.includes(realTeamOf.get(p.id) ?? '')) {
      const smallest = teamIds.reduce((a, b) => (roster.get(a)!.length <= roster.get(b)!.length ? a : b));
      roster.get(smallest)!.push(p.id);
    }
  }
  const activeExtra = await prisma.player.findMany({
    where: { teamId: { in: teamIds }, active: true, id: { notIn: [...realIds] } },
    select: { id: true, teamId: true, firstName: true, lastName: true },
  });
  for (const p of activeExtra) roster.get(p.teamId)?.push(p.id);
  const nameOf = new Map([...realPlayers, ...activeExtra].map((x) => [x.id, `${x.firstName} ${x.lastName}`]));
  console.log(`+${activeExtra.length} activos sin juego 2026 incluidos en la historia`);
  console.log('plantillas:', league.teams.map((t) => `${t.shortName ?? t.name}:${roster.get(t.id)!.length}`).join(' '));

  const years = [2022, 2023, 2024, 2025];
  const movedLog: string[] = [];
  for (const year of years) {
    if (year > 2022) {
      // traspasos persistentes: 1-2 jugadores por equipo se mueven
      for (const tid of shuffle(teamIds)) {
        const r = roster.get(tid)!;
        const nMoves = 1 + Math.floor(rnd() * 2);
        for (let k = 0; k < nMoves && r.length > 10; k++) {
          const pid = r.splice(Math.floor(rnd() * r.length), 1)[0];
          const dest = pick(teamIds.filter((x) => x !== tid));
          roster.get(dest)!.push(pid);
          const t = league.teams.find((x) => x.id === tid)!;
          const d = league.teams.find((x) => x.id === dest)!;
          movedLog.push(`${year}: ${nameOf.get(pid) ?? pid} ${t.shortName}→${d.shortName}`);
        }
      }
    }
    // round-robin ida y vuelta con roster barajado por juego
    const base = new Date(`${year}-02-15T18:00:00`);
    let gi = 0, done = 0;
    for (let i = 0; i < teamIds.length; i++) {
      for (let j = 0; j < teamIds.length; j++) {
        if (i === j) continue;
        const away = { teamId: teamIds[i], ...mkSide(shuffle(roster.get(teamIds[i])!)) };
        const home = { teamId: teamIds[j], ...mkSide(shuffle(roster.get(teamIds[j])!)) };
        if (!away.order.length || !home.order.length) continue;
        const date = new Date(base.getTime() + Math.floor(gi / 3) * 86400000 + (gi % 3) * 7200000);
        await simulateGame(away, home, league.id, date);
        gi++;
        if (++done % 14 === 0) console.log(`  ${year}: ${done} juegos…`);
      }
    }
    console.log(`=== ${year}: ${done} juegos FINAL ===`);
  }

  const stats = await prisma.playerSeasonStat.groupBy({ by: ['season'], _count: true, orderBy: { season: 'asc' } });
  console.log('\n✅ Historia con jugadores reales. SeasonStat por año:', stats.map((x) => `${x.season}:${x._count}`).join('  '));
  console.log(`\nTraspasos simulados (${movedLog.length}):`);
  for (const m of movedLog.slice(0, 15)) console.log('  ' + m);
  if (movedLog.length > 15) console.log(`  … y ${movedLog.length - 15} más`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
