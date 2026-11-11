/**
 * Corrige la simulación histórica: las ligas "Liga Test" por año pasan a ser
 * UNA sola liga con años dentro (2022-2026).
 *  - Fusiona los equipos homónimos (clones por temporada) en uno solo por nombre
 *    — canónico = el de la liga destino (el más reciente disponible).
 *  - Reasigna game.homeTeamId/awayTeamId/forfeitBy, lineup.teamId, player.teamId.
 *  - Mueve todos los juegos a la liga destino y borra ligas/equipos vacíos.
 *  - Limpia el apellido de jugadores: quita el sufijo " ABC" si es un shortName
 *    de equipo (ej. "Pérez TIG" → "Pérez").
 *
 * Ejecutar: npx tsx src/fix-league-merge.ts
 */
import { prisma } from './prisma.js';

async function main() {
  // solo la familia "Liga Test" — no tocar otras ligas reales
  const leagues = await prisma.league.findMany({ where: { name: 'Liga Test' }, orderBy: { year: 'asc' } });
  if (leagues.length === 0) { console.log('No hay ligas "Liga Test"'); return; }
  const target = leagues.reduce((a, b) => (b.year >= a.year ? b : a));
  console.log(`Liga destino: ${target.name} ${target.year} (${target.id})`);
  const familyIds = new Set(leagues.map((l) => l.id));

  // canónico por nombre: equipo de la liga destino si existe, si no el de mayor año
  const teams = await prisma.team.findMany({ where: { leagueId: { in: [...familyIds] } }, include: { league: true } });
  const canon = new Map<string, (typeof teams)[0]>();
  for (const t of teams) {
    const cur = canon.get(t.name);
    if (!cur || t.leagueId === target.id || (cur.leagueId !== target.id && (t.league?.year ?? 0) > (cur.league?.year ?? 0))) {
      canon.set(t.name, t);
    }
  }

  let moved = 0, dropped = 0;
  for (const t of teams) {
    const c = canon.get(t.name)!;
    if (c.id === t.id) continue;
    // reasignar referencias del clon → equipo canónico
    await prisma.game.updateMany({ where: { homeTeamId: t.id }, data: { homeTeamId: c.id } });
    await prisma.game.updateMany({ where: { awayTeamId: t.id }, data: { awayTeamId: c.id } });
    await prisma.game.updateMany({ where: { forfeitBy: t.id }, data: { forfeitBy: c.id } });
    await prisma.lineupEntry.updateMany({ where: { teamId: t.id }, data: { teamId: c.id } });
    await prisma.player.updateMany({ where: { teamId: t.id }, data: { teamId: c.id } });
    await prisma.series.updateMany({ where: { homeTeamId: t.id }, data: { homeTeamId: c.id } });
    await prisma.series.updateMany({ where: { awayTeamId: t.id }, data: { awayTeamId: c.id } });
    await prisma.team.delete({ where: { id: t.id } });
    moved++;
    console.log(`  ${t.name} (${t.league?.year ?? '?'}) → fusionado en canónico`);
  }

  // todos los juegos de la familia a la liga destino
  const g = await prisma.game.updateMany({ where: { leagueId: { in: [...familyIds].filter((x) => x !== target.id) } }, data: { leagueId: target.id } });
  console.log(`Juegos movidos a liga destino: ${g.count}`);

  // borrar ligas vacías (distintas de la destino)
  const rest = await prisma.league.findMany({ where: { id: { in: [...familyIds].filter((x) => x !== target.id) } }, include: { _count: { select: { teams: true, games: true } } } });
  for (const l of rest) {
    if (l._count.teams === 0 && l._count.games === 0) {
      await prisma.league.delete({ where: { id: l.id } });
      dropped++;
      console.log(`  liga borrada: ${l.name} ${l.year}`);
    } else {
      console.log(`  ⚠ liga NO borrada (aún tiene datos): ${l.name} ${l.year} — ${l._count.teams} eq / ${l._count.games} j`);
    }
  }

  // limpiar apellidos: sufijo que coincida con un shortName de equipo
  const shorts = new Set(teams.map((t) => t.shortName).filter(Boolean) as string[]);
  const players = await prisma.player.findMany({ select: { id: true, lastName: true } });
  let fixed = 0;
  for (const pl of players) {
    const m = pl.lastName.match(/^(.*)\s+([A-ZÁÉÍÓÚÑ]{2,5})$/);
    if (m && m[1].trim() && shorts.has(m[2])) {
      await prisma.player.update({ where: { id: pl.id }, data: { lastName: m[1].trim() } });
      fixed++;
    }
  }

  console.log(`\nResumen: ${moved} equipos fusionados, ${dropped} ligas borradas, ${fixed} apellidos corregidos`);
}

main().finally(() => prisma.$disconnect());
