import { PrismaClient } from '@prisma/client';
import { mkSide, simulateGame } from './sim-lib.js';

const prisma = new PrismaClient();

/**
 * POSTEMPORADA SIMULADA — para una temporada terminada de una liga.
 *
 * Formato: los 4 mejores por posiciones → 2 semifinales al mejor de 3
 * (1° vs 4°, 2° vs 3°) → final al mejor de 3. Sede: el mejor seed es local
 * en juegos 1 y 3, el peor en el 2. Los juegos llevan seriesId → sus stats
 * se acumulan con scope POST (no ensucian la temporada regular).
 *
 * Se usa desde sim-example.ts y también suelto:
 *   npx tsx src/sim-playoffs.ts            → playoffs de temporadas ENDED sin series en "Liga Ejemplo"
 */

interface Rosters { pitchers: string[]; fielders: string[] }

export interface PlayoffResult { series: number; games: number; champion: string | null }

/**
 * Simula la postemporada de una temporada: semis + final al mejor de 3.
 * Devuelve cuántos juegos se jugaron y el campeón.
 */
export async function simulatePlayoffs(opts: {
  leagueId: string; seasonId: string; year: number;
  seeds: string[]; // teamIds ordenados por posición (mejor primero)
  rosters: Map<string, Rosters>;
  teamName: (tid: string) => string;
  baseDate: Date;
}): Promise<PlayoffResult> {
  const { leagueId, seasonId, seeds, rosters, teamName } = opts;
  let { baseDate } = opts;
  const nextDate = () => { const d = baseDate; baseDate = new Date(baseDate.getTime() + 86400000); return d; };
  const side = (tid: string) => ({ teamId: tid, ...mkSide(rosters.get(tid)!.pitchers, rosters.get(tid)!.fielders) });

  let games = 0;
  const playSeries = async (hi: string, lo: string, name: string, round: number): Promise<string | null> => {
    const series = await prisma.series.create({
      data: { leagueId, seasonId, round, name: `${name} — ${teamName(hi)} vs ${teamName(lo)}`, homeTeamId: hi, awayTeamId: lo, winsNeeded: 2, status: 'LIVE' },
    });
    const wins = { [hi]: 0, [lo]: 0 } as Record<string, number>;
    // sedes: mejor seed local en juegos 1 y 3
    for (let g = 0; g < 3 && wins[hi] < 2 && wins[lo] < 2; g++) {
      const homeId = g === 1 ? lo : hi;
      const awayId = g === 1 ? hi : lo;
      const r = await simulateGame(prisma, side(awayId), side(homeId), nextDate(), { leagueId, seasonId, seriesId: series.id, sport: 'softball', innings: 7 });
      const winner = r.tied ? null : r.awayScore > r.homeScore ? awayId : homeId;
      if (winner) wins[winner]++;
      games++;
    }
    const winnerId = wins[hi] === 2 ? hi : wins[lo] === 2 ? lo : null;
    await prisma.series.update({ where: { id: series.id }, data: { winnerTeamId: winnerId, status: 'DONE' } });
    console.log(`    ${name}: ${teamName(hi)} ${wins[hi]}-${wins[lo]} ${teamName(lo)} → ${winnerId ? teamName(winnerId) : '?'}`);
    return winnerId;
  };

  const [s1, s2, s3, s4] = seeds;
  const fA = await playSeries(s1, s4, 'Semifinal A', 1);
  const fB = await playSeries(s2, s3, 'Semifinal B', 1);
  let champion: string | null = null;
  if (fA && fB) {
    const [hi, lo] = seeds.indexOf(fA) < seeds.indexOf(fB) ? [fA, fB] : [fB, fA];
    champion = await playSeries(hi, lo, 'FINAL', 2);
  }
  return { series: 3, games, champion };
}

/** Semillas por posiciones: W-L-PCT desde los juegos FINAL regulares. */
export async function computeSeeds(leagueId: string, seasonId: string): Promise<string[]> {
  const games = await prisma.game.findMany({
    where: { leagueId, seasonId, status: 'FINAL', seriesId: null },
    select: { id: true, awayTeamId: true, homeTeamId: true },
  });
  const rec = new Map<string, { w: number; l: number; t: number; g: number }>();
  const recOf = (tid: string) => { const r = rec.get(tid) ?? { w: 0, l: 0, t: 0, g: 0 }; rec.set(tid, r); return r; };
  for (const g of games) {
    const evs = await prisma.gameEvent.findMany({ where: { gameId: g.id }, select: { advances: true, half: true } });
    let a = 0, h = 0;
    for (const e of evs) {
      for (const adv of (e.advances as { to: unknown }[] | null) ?? []) {
        if (adv.to === 'HOME') { if (e.half === 'TOP') a++; else h++; }
      }
    }
    recOf(g.awayTeamId).g++; recOf(g.homeTeamId).g++;
    if (a === h) { recOf(g.awayTeamId).t++; recOf(g.homeTeamId).t++; }
    else if (a > h) { recOf(g.awayTeamId).w++; recOf(g.homeTeamId).l++; }
    else { recOf(g.homeTeamId).w++; recOf(g.awayTeamId).l++; }
  }
  return [...rec.entries()]
    .sort((x, y) => {
      const px = x[1].g ? (x[1].w + x[1].t * 0.5) / x[1].g : 0;
      const py = y[1].g ? (y[1].w + y[1].t * 0.5) / y[1].g : 0;
      return py - px;
    })
    .map(([tid]) => tid);
}

// ── suelto: playoffs para temporadas ENDED de "Liga Ejemplo" sin series ──
async function main() {
  const league = await prisma.league.findFirstOrThrow({ where: { name: 'Liga Ejemplo' }, include: { seasons: { orderBy: { year: 'asc' } }, teams: true } });
  const tmap = new Map(league.teams.map((t) => [t.id, t.name]));
  // rosters actuales (el sim usa la plantilla vigente)
  const players = await prisma.player.findMany({ where: { teamId: { in: league.teams.map((t) => t.id) }, active: true }, select: { id: true, teamId: true, positions: true } });
  const rosters = new Map<string, Rosters>();
  for (const t of league.teams) {
    const ps = players.filter((p) => p.teamId === t.id);
    rosters.set(t.id, { pitchers: ps.filter((p) => (p.positions ?? '').includes('P')).map((p) => p.id), fielders: ps.filter((p) => !(p.positions ?? '').includes('P')).map((p) => p.id) });
  }

  for (const season of league.seasons) {
    const existing = await prisma.series.count({ where: { leagueId: league.id, seasonId: season.id } });
    if (existing) { console.log(`${season.year}: ya tiene series — salto`); continue; }
    const played = await prisma.game.count({ where: { seasonId: season.id, status: 'FINAL', seriesId: null } });
    if (!played) { console.log(`${season.year}: sin juegos regulares — salto`); continue; }
    if (season.status === 'ACTIVE') { console.log(`${season.year}: temporada en curso — playoffs al terminar`); continue; }
    const seeds = (await computeSeeds(league.id, season.id)).slice(0, 4);
    console.log(`\n=== Playoffs ${season.year} — ${seeds.map((t) => tmap.get(t)).join(' · ')} ===`);
    const base = new Date(`${season.year}-07-05T18:00:00`);
    const r = await simulatePlayoffs({ leagueId: league.id, seasonId: season.id, year: season.year, seeds, rosters, teamName: (t) => tmap.get(t) ?? '?', baseDate: base });
    console.log(`  🏆 Campeón ${season.year}: ${r.champion ? tmap.get(r.champion) : '—'} (${r.games} juegos)`);
  }
  await prisma.$disconnect();
}

if (process.argv[1] && /sim-playoffs\.(ts|js)$/.test(process.argv[1])) {
  main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
}
