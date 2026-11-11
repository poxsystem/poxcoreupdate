import { PrismaClient, type Prisma } from '@prisma/client';
import { applyEvent, defaultAdvances, initialState, type Advance, type GameState, type PlayResult } from '@poxscore/shared';

const prisma = new PrismaClient();
const API = 'http://localhost:4000/api';

/**
 * Simulador de HISTORIA: temporadas 2022-2025 de "Liga Test".
 * - Cada año crea su League + clones de los 6 equipos (como el rollover real)
 * - Los jugadores conservan su playerId entre temporadas (reassign teamId)
 * - Cada año simula TRASPASOS entre equipos + rookies nuevos + alguna baja
 * - Juegos con stream de eventos realista (pitch a pitch) y cierre /finish
 *   para acumular PlayerSeasonStat por temporada → prueba temporadas,
 *   stints por equipo, tarjetas históricas, splits por mes, etc.
 * Uso: npx tsx src/sim-history.ts   (requiere el server corriendo)
 */

const rnd = () => Math.random();
const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];

const POSNUM: Record<string, number> = { P: 1, C: 2, '1B': 3, '2B': 4, '3B': 5, SS: 6, LF: 7, CF: 8, RF: 9 };
const DEF_POS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'EH']; // softball

const TEAM_DEFS = [
  { name: 'Tigres', shortName: 'TIG', color: '#e8730c' },
  { name: 'Leones', shortName: 'LEO', color: '#c8102e' },
  { name: 'Águilas', shortName: 'AGU', color: '#1a5c1a' },
  { name: 'Cardenales', shortName: 'CAR', color: '#9b1c31' },
  { name: 'Tiburones', shortName: 'TIB', color: '#0c4a6e' },
  { name: 'Indios', shortName: 'IND', color: '#6b21a8' },
];

const FIRST = ['Carlos', 'José', 'Luis', 'Pedro', 'Miguel', 'Andrés', 'Jesús', 'Daniel', 'Rafael', 'Omar',
  'Kevin', 'Ángel', 'Víctor', 'Mario', 'Jorge', 'Eduardo', 'Héctor', 'Wilson', 'Óscar', 'Franklin',
  'Ramón', 'César', 'David', 'Julio', 'Fernando', 'Ricardo', 'Gabriel', 'Antonio', 'Marcos', 'Javier',
  'Sergio', 'Iván', 'Nelson', 'Tomás', 'Alfredo', 'Ernesto', 'Roberto', 'Manuel', 'Francisco', 'Alejandro',
  'Rubén', 'Alberto', 'Enrique', 'Arturo', 'Raúl', 'Ismael', 'Edgar', 'Armando', 'Felipe', 'Rodrigo',
  'Samuel', 'Elías', 'Noé', 'Adrián', 'Bruno', 'Emilio', 'Hugo', 'Germán', 'Rogelio', 'Salvador'];
const LAST = ['Pérez', 'Martínez', 'González', 'Ramírez', 'Torres', 'Flores', 'Rojas', 'Mora', 'Díaz', 'Vargas',
  'Soto', 'Reyes', 'Hernández', 'Castillo', 'Peña', 'Núñez', 'Cruz', 'Mendoza', 'Salazar', 'Ortiz',
  'Guerrero', 'Luna', 'Campos', 'Vega', 'López', 'Silva', 'Fuentes', 'Rivas', 'Acosta', 'Medina',
  'Paredes', 'Cabrera', 'Duarte', 'Ibarra', 'Suárez', 'Velasco', 'Domínguez', 'Espinoza', 'Aguilar', 'Zamora',
  'Mejía', 'Serrano', 'Navarro', 'Rosas', 'Miranda', 'Delgado', 'Ponce', 'Quiroz', 'Trejo', 'Carrillo'];

interface SimPlayer { id: string }
interface SideCtx {
  order: string[];
  fielder: Map<number, string>;
  pitcher: string; reliever: string;
  pitcherAtInning: Map<number, string>;
}

function mkSide(players: SimPlayer[]): SideCtx {
  const batters = players.slice(0, DEF_POS.length);
  const order = batters.map((p) => p.id);
  const fielder = new Map<number, string>();
  batters.forEach((p, i) => {
    const n = POSNUM[DEF_POS[i]];
    if (n) fielder.set(n, p.id);
  });
  const starter = fielder.get(1)!;
  const reliever = players[DEF_POS.length]?.id ?? starter;
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
  for (const [side, ctx] of [['away', away], ['home', home]] as const) {
    void side;
    ctx.order.forEach((pid, i) => entries.push({ gameId: game.id, teamId: ctx.teamId, playerId: pid, order: i + 1, position: DEF_POS[i], role: 'STARTER', active: true, batsInOrder: true }));
    entries.push({ gameId: game.id, teamId: ctx.teamId, playerId: ctx.reliever, order: 99, position: 'P', role: 'SUB', active: true, batsInOrder: false });
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

  const fd = await (await fetch(`${API}/games/${game.id}/finish-data`)).json() as { tied?: boolean; suggestedWpId?: string; suggestedLpId?: string };
  const score = s.score;
  const tied = score.away === score.home;
  await fetch(`${API}/games/${game.id}/finish`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tied ? { tied: true } : { wpId: fd.suggestedWpId, lpId: fd.suggestedLpId }),
  });
  return { id: game.id, score, tied };
}

// ── gestión de rosters por año ───────────────────────────────────────────────
const usedNames = new Set<string>();
function newPlayerData(teamId: string) {
  let first = '', last = '';
  do { first = pick(FIRST); last = pick(LAST); } while (usedNames.has(`${first} ${last}`));
  usedNames.add(`${first} ${last}`);
  return {
    teamId,
    firstName: first, lastName: last,
    number: Math.floor(rnd() * 55) + 1,
    bats: pick(['R', 'R', 'R', 'L', 'L', 'S']), // zurdos menos comunes
    active: true,
  };
}

async function main() {
  const years = [2022, 2023, 2024, 2025];
  // pool de jugadores por equipo-base (índice estable entre años)
  let roster: SimPlayer[][] = [[], [], [], [], [], []];
  let created = 0, moved = 0;

  for (const year of years) {
    const league = await prisma.league.create({
      data: { name: 'Liga Test', year, sport: 'softball', innings: 7 },
    });
    const teams = [] as { id: string; name: string }[];
    for (const t of TEAM_DEFS) {
      const team = await prisma.team.create({ data: { ...t, leagueId: league.id } });
      teams.push(team);
    }
    console.log(`\n=== Temporada ${year} ===`);

    if (year === 2022) {
      // plantillas iniciales: 12 por equipo
      for (let ti = 0; ti < teams.length; ti++) {
        const data = Array.from({ length: 12 }, () => newPlayerData(teams[ti].id));
        await prisma.player.createMany({ data });
        roster[ti] = await prisma.player.findMany({ where: { teamId: teams[ti].id }, select: { id: true } });
        created += roster[ti].length;
      }
      console.log(`  ${created} jugadores creados`);
    } else {
      // reasignar plantilla al clone del año + TRASPASOS + rookies + bajas
      for (let ti = 0; ti < teams.length; ti++) {
        // 2-3 jugadores se van a otro equipo (traspaso entre temporadas)
        const nMoves = 2 + Math.floor(rnd() * 2);
        for (let k = 0; k < nMoves && roster[ti].length > 8; k++) {
          const p = roster[ti].splice(Math.floor(rnd() * roster[ti].length), 1)[0];
          const dest = Math.floor(rnd() * teams.length);
          if (dest !== ti) { roster[dest].push(p); moved++; }
          else roster[ti].push(p); // al azar cayó en el mismo equipo: se queda
        }
        // 1 rookie por equipo la mayoría de años
        if (rnd() < 0.8) {
          const np = await prisma.player.create({ data: newPlayerData(teams[ti].id) });
          roster[ti].push({ id: np.id }); created++;
        }
        // baja ocasional (conserva historial)
        if (roster[ti].length > 11 && rnd() < 0.5) {
          const gone = roster[ti].splice(Math.floor(rnd() * roster[ti].length), 1)[0];
          await prisma.player.update({ where: { id: gone.id }, data: { active: false } });
        }
        // asignar todos al clone de este año
        await prisma.player.updateMany({ where: { id: { in: roster[ti].map((p) => p.id) } }, data: { teamId: teams[ti].id, active: true } });
      }
      console.log(`  traspasos acumulados: ${moved}, plantillas reasignadas`);
    }

    // juegos: cada pareja juega local y visita (round-robin simple) = 30 juegos
    const withPlayers = await Promise.all(teams.map(async (t) => ({
      teamId: t.id, name: t.name,
      players: await prisma.player.findMany({ where: { teamId: t.id, active: true }, select: { id: true }, orderBy: { number: 'asc' } }),
    })));
    const base = new Date(`${year}-02-15T18:00:00`);
    let gi = 0, done = 0;
    for (let i = 0; i < withPlayers.length; i++) {
      for (let j = 0; j < withPlayers.length; j++) {
        if (i === j) continue;
        const away = { teamId: withPlayers[i].teamId, ...mkSide(withPlayers[i].players) };
        const home = { teamId: withPlayers[j].teamId, ...mkSide(withPlayers[j].players) };
        const date = new Date(base.getTime() + Math.floor(gi / 3) * 86400000 + (gi % 3) * 7200000);
        await simulateGame(away, home, league.id, date);
        gi++;
        if (++done % 10 === 0) console.log(`  ${done} juegos…`);
      }
    }
    console.log(`  ${done} juegos FINAL en ${year}`);
  }

  const stats = await prisma.playerSeasonStat.groupBy({ by: ['season'], _count: true });
  console.log(`\n✅ Historia completa. Temporadas acumuladas:`, stats.map((x) => `${x.season}:${x._count}`).join('  '));
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
