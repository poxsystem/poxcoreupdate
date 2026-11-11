import { PrismaClient } from '@prisma/client';
import { mkSide, openSeason, pick, rnd, shuffle, simulateGame } from './sim-lib.js';
import { computeSeeds, simulatePlayoffs } from './sim-playoffs.js';

const prisma = new PrismaClient();

/**
 * LIGA EJEMPLO — datos de prueba con la estructura nueva (Season dentro de la liga).
 *
 * Crea desde cero:
 *  - "Liga Ejemplo" (softball, 7 entradas).
 *  - 6 equipos con color y abreviatura, cada uno con roster de 20 jugadores
 *    (4 lanzadores + 16 de campo, con nombre/posición/mano/numero).
 *  - 3 temporadas como entidades Season: 2024, 2025 y 2026 (la última queda
 *    ACTIVE y a mitad — 20 juegos jugados + 10 programados).
 *  - Round-robin ida/vuelta por temporada (30 juegos) simulados jugada a
 *    jugada con el motor real (conteo B-S, notación defensiva, fildeo,
 *    errores, relevos) y cerrados con /finish → decisiones W/L +
 *    PlayerSeasonStat por año.
 *  - TRASPASOS REALES entre temporadas (~8 por año): el playerId se mueve
 *    de equipo → la tarjeta muestra su trayectoria año por año.
 *
 * Uso: npx tsx src/sim-example.ts   (requiere el server corriendo)
 */

const LEAGUE_NAME = 'Liga Ejemplo';
const SPORT = 'softball';
const INN = 7;
const YEARS = [2024, 2025, 2026];

const TEAMS = [
  { name: 'Tigres', short: 'TIG', color: '#f97316' },
  { name: 'Leones', short: 'LEO', color: '#eab308' },
  { name: 'Águilas', short: 'AGU', color: '#1e3a8a' },
  { name: 'Cardenales', short: 'CAR', color: '#dc2626' },
  { name: 'Tiburones', short: 'TIB', color: '#0891b2' },
  { name: 'Indios', short: 'IND', color: '#16a34a' },
];

const FIRST = ['Alexis', 'Juan', 'Carlos', 'Miguel', 'José', 'Luis', 'Pedro', 'Rafael', 'Daniel', 'Fernando', 'Ricardo', 'Andrés', 'Javier', 'Sergio', 'Roberto', 'Eduardo', 'Manuel', 'Francisco', 'David', 'Óscar', 'Mario', 'Héctor', 'Pablo', 'Diego', 'Jorge', 'Ramón', 'Víctor', 'Enrique', 'Alberto', 'Raúl'];
const LAST = ['Lara', 'Paredes', 'González', 'Martínez', 'Rodríguez', 'Fernández', 'López', 'Díaz', 'Pérez', 'Sánchez', 'Ramírez', 'Torres', 'Flores', 'Rivera', 'Gómez', 'Morales', 'Castillo', 'Reyes', 'Vargas', 'Ortiz', 'Soto', 'Ríos', 'Cruz', 'Herrera', 'Medina', 'Castro', 'Mendoza', 'Guerrero', 'Núñez', 'Camacho'];
const BATS = ['R', 'R', 'R', 'L', 'L', 'S'];
const THROWS = ['R', 'R', 'R', 'R', 'L'];

async function main() {
  // ── 1. liga + equipos (color) ──
  const prev = await prisma.league.findFirst({ where: { name: LEAGUE_NAME } });
  if (prev) throw new Error(`"${LEAGUE_NAME}" ya existe (${prev.id}) — bórrala primero si quieres regenerar`);
  const league = await prisma.league.create({ data: { name: LEAGUE_NAME, sport: SPORT, year: YEARS[YEARS.length - 1] } });
  const teamIds: string[] = [];
  for (const t of TEAMS) {
    const team = await prisma.team.create({ data: { name: t.name, shortName: t.short, color: t.color, leagueId: league.id } });
    teamIds.push(team.id);
  }
  console.log(`${LEAGUE_NAME}: ${TEAMS.map((t) => t.name).join(' · ')}`);

  // ── 2. roster de 20 por equipo: 4 P + 16 de campo ──
  const usedNames = new Set<string>();
  const mkName = () => {
    for (;;) {
      const n = `${pick(FIRST)} ${pick(LAST)} ${rnd() < 0.5 ? pick(LAST) : ''}`.trim();
      if (!usedNames.has(n)) { usedNames.add(n); return n; }
    }
  };
  const rosterField: Record<string, string[]> = {}; // teamId → posiciones de su roster
  const FIELD_DIST = ['C', 'C', '1B', '1B', '2B', '2B', '3B', '3B', 'SS', 'SS', 'LF', 'LF', 'CF', 'CF', 'RF', 'RF'];
  const playersOf = new Map<string, { pitchers: string[]; fielders: string[] }>();
  let jersey = 1;
  for (const tid of teamIds) {
    rosterField[tid] = [];
    const pitchers: string[] = []; const fielders: string[] = [];
    for (let i = 0; i < 20; i++) {
      const isP = i < 4;
      const pos = isP ? 'P' : FIELD_DIST[i - 4];
      const [firstName, ...rest] = mkName().split(' ');
      const p = await prisma.player.create({
        data: {
          teamId: tid, firstName, lastName: rest.join(' ') || pick(LAST),
          number: (jersey++ % 55) + 1,
          bats: pick(BATS), throws: pick(THROWS), positions: pos,
        },
      });
      (isP ? pitchers : fielders).push(p.id);
    }
    playersOf.set(tid, { pitchers, fielders });
  }
  console.log(`120 jugadores creados (20 por equipo: 4 P + 16 de campo)`);
  const nameOf = new Map((await prisma.player.findMany({ select: { id: true, firstName: true, lastName: true, teamId: true } }))
    .map((p) => [p.id, { name: `${p.firstName} ${p.lastName}`, teamId: p.teamId }]));

  // ── 3. temporadas: juegos round-robin + traspasos entre ellas ──
  const movedLog: string[] = [];
  for (let yi = 0; yi < YEARS.length; yi++) {
    const year = YEARS[yi];
    // traspasos reales ANTES de la temporada (menos la primera)
    if (yi > 0) {
      for (const tid of shuffle(teamIds)) {
        const moves = 1 + Math.floor(rnd() * 2);
        for (let k = 0; k < moves; k++) {
          const from = playersOf.get(tid)!;
          const pool = rnd() < 0.3 && from.pitchers.length > 2 ? 'pitchers' : 'fielders';
          const arr = from[pool as 'pitchers' | 'fielders'];
          if (arr.length <= 3) continue;
          const pid = arr.splice(Math.floor(rnd() * arr.length), 1)[0];
          const dest = pick(teamIds.filter((x) => x !== tid));
          playersOf.get(dest)![pool as 'pitchers' | 'fielders'].push(pid);
          await prisma.player.update({ where: { id: pid }, data: { teamId: dest } }); // transferencia real
          const t = TEAMS[teamIds.indexOf(tid)], d = TEAMS[teamIds.indexOf(dest)];
          movedLog.push(`${year}: ${nameOf.get(pid)?.name ?? pid} ${t.short}→${d.short}`);
        }
      }
    }

    const season = await openSeason(prisma, league.id, year);
    console.log(`\n=== Temporada ${year} (${yi === YEARS.length - 1 ? 'activa' : 'terminada'}) ===`);

    // round-robin ida/vuelta: 30 juegos por temporada
    const base = new Date(`${year}-02-07T18:00:00`);
    const pairs: [number, number][] = [];
    for (let i = 0; i < teamIds.length; i++) for (let j = 0; j < teamIds.length; j++) if (i !== j) pairs.push([i, j]);
    const sched = shuffle(pairs);
    // la última temporada (activa) deja los últimos 10 juegos programados sin jugar
    const pending = yi === YEARS.length - 1 ? 10 : 0;
    let gi = 0, done = 0;
    for (const [ai, hi] of sched) {
      const date = new Date(base.getTime() + Math.floor(gi / 3) * 86400000 * 7 + (gi % 3) * 7200000);
      const away = { teamId: teamIds[ai], ...mkSide(playersOf.get(teamIds[ai])!.pitchers, playersOf.get(teamIds[ai])!.fielders) };
      const home = { teamId: teamIds[hi], ...mkSide(playersOf.get(teamIds[hi])!.pitchers, playersOf.get(teamIds[hi])!.fielders) };
      await simulateGame(prisma, away, home, date, { leagueId: league.id, seasonId: season.id, sport: SPORT, innings: INN }, gi < sched.length - pending);
      gi++;
      if (playable(gi, pending) && ++done % 15 === 0) console.log(`  ${year}: ${done} juegos…`);
    }
    console.log(`  ${year}: ${done} jugados${pending ? ` + ${pending} programados` : ''}`);

    // postemporada de la temporada terminada: top 4 → semis + final al mejor de 3
    if (!pending) {
      const seeds = (await computeSeeds(league.id, season.id)).slice(0, 4);
      console.log(`  Playoffs ${year}: ${seeds.map((t) => TEAMS[teamIds.indexOf(t)]?.short ?? '?').join(' · ')}`);
      const po = await simulatePlayoffs({
        leagueId: league.id, seasonId: season.id, year, seeds, rosters: playersOf,
        teamName: (t) => TEAMS[teamIds.indexOf(t)]?.name ?? '?',
        baseDate: new Date(`${year}-07-05T18:00:00`),
      });
      console.log(`  🏆 Campeón ${year}: ${po.champion ? TEAMS[teamIds.indexOf(po.champion)]?.name : '—'} (${po.games} juegos de serie)`);
    }
  }
  function playable(gi: number, pending: number) { return gi <= 30 - pending; }

  const stats = await prisma.playerSeasonStat.groupBy({ by: ['season'], _count: true, orderBy: { season: 'asc' } });
  console.log('\n✅ Liga Ejemplo lista. Jugadores con stats por temporada:', stats.map((x) => `${x.season}:${x._count}`).join('  '));
  console.log(`\nTraspasos entre temporadas (${movedLog.length}):`);
  for (const m of movedLog.slice(0, 18)) console.log('  ' + m);
  if (movedLog.length > 18) console.log(`  … y ${movedLog.length - 18} más`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
