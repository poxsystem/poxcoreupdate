/**
 * restore-season.ts — recupera UNA temporada de un respaldo automático
 *
 * Uso:
 *   npx tsx scripts/restore-season.ts backups/auto-XXXX.json "Sector Norte 2026" 2026
 *   npx tsx scripts/restore-season.ts backups/auto-XXXX.json "Sector Norte 2026" 2026 --apply
 *
 * Sin --apply solo REPORTA lo que haría (dry-run). Con --apply:
 *   1. Borra la temporada actual de ese año en esa liga (si no es la del backup)
 *      — la que quedó con datos mal etiquetados — con sus juegos/lineups/eventos/series.
 *   2. Re-inserta la temporada del backup con los MISMOS ids: season, series,
 *      games (con statLines/boxscore/playByPlay/decisiones), lineup y eventos.
 *   3. Restaura los PlayerSeasonStat de ese año para los jugadores de la liga.
 *   4. Si un jugador referenciado ya no existe, lo recrea desde el backup
 *      (mismo id, mismo equipo del backup).
 */
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

async function main() {
  const [file, leagueName, yearArg, ...flags] = process.argv.slice(2);
  const apply = flags.includes('--apply');
  if (!file || !leagueName || !yearArg) {
    console.log('uso: npx tsx scripts/restore-season.ts <backup.json> "<nombre liga>" <año> [--apply]');
    process.exit(1);
  }
  const year = Number(yearArg);
  const bk = JSON.parse(fs.readFileSync(file, 'utf8'));
  const D = (k: string): any[] => (Array.isArray(bk[k]) ? bk[k] : []);

  // ---- datos del backup ----
  const bLeague = D('leagues').find((l: any) => norm(l.name) === norm(leagueName));
  if (!bLeague) throw new Error(`la liga "${leagueName}" no está en el respaldo — hay: ${D('leagues').map((l: any) => l.name).join(', ')}`);
  const bSeason = D('seasons').find((s: any) => s.leagueId === bLeague.id && s.year === year);
  if (!bSeason) throw new Error(`el respaldo no tiene temporada ${year} en "${bLeague.name}" — años: ${D('seasons').filter((s: any) => s.leagueId === bLeague.id).map((s: any) => s.year).join(', ')}`);
  const bTeams = D('teams').filter((t: any) => t.leagueId === bLeague.id);
  const bTeamIds = new Set(bTeams.map((t: any) => t.id));
  const bPlayers = D('players').filter((p: any) => bTeamIds.has(p.teamId));
  const bPlayerIds = new Set(bPlayers.map((p: any) => p.id));
  const bGames = D('games').filter((g: any) => g.seasonId === bSeason.id);
  const bGameIds = new Set(bGames.map((g: any) => g.id));
  const bLineups = D('lineups').filter((l: any) => bGameIds.has(l.gameId));
  const bEvents = D('events').filter((e: any) => bGameIds.has(e.gameId));
  const bSeries = D('series').filter((s: any) => s.seasonId === bSeason.id);
  const bStats = D('seasonStats').filter((s: any) => s.season === year && bPlayerIds.has(s.playerId));

  console.log(`RESPALDO → ${bLeague.name} ${year}: ${bGames.length} juegos · ${bEvents.length} eventos · ${bLineups.length} lineup · ${bSeries.length} series · ${bStats.length} seasonStats`);

  // ---- estado actual ----
  const league = await prisma.league.findFirst({ where: { name: { equals: leagueName } } })
    ?? await prisma.league.findFirst({ where: { name: { contains: leagueName } } });
  if (!league) throw new Error(`la liga "${leagueName}" no existe en la BD actual`);
  const curSeasons = await prisma.season.findMany({ where: { leagueId: league.id, year } });
  const wrong = curSeasons.filter((s) => s.id !== bSeason.id);
  for (const s of wrong) {
    const n = await prisma.game.count({ where: { seasonId: s.id } });
    console.log(`BORRARÍA temporada ${year} actual (id ${s.id} — ${n} juegos mal etiquetados)`);
  }
  const missingP = bPlayers.filter((p: any) => !bPlayerIds.has(p.id));
  const pInDb = new Set((await prisma.player.findMany({ where: { id: { in: [...bPlayerIds] } }, select: { id: true } })).map((p) => p.id));
  const pToCreate = bPlayers.filter((p: any) => !pInDb.has(p.id));
  if (pToCreate.length) console.log(`recrearía ${pToCreate.length} jugadores faltantes: ${pToCreate.slice(0, 8).map((p: any) => `${p.firstName} ${p.lastName}`).join(' | ')}`);
  const tInDb = new Set((await prisma.team.findMany({ where: { id: { in: [...bTeamIds] } }, select: { id: true } })).map((t) => t.id));
  const tToCreate = bTeams.filter((t: any) => !tInDb.has(t.id));
  if (tToCreate.length) console.log(`recrearía ${tToCreate.length} equipos faltantes: ${tToCreate.map((t: any) => t.name).join(' | ')}`);
  void missingP;

  if (!apply) { console.log('\n(dry-run — agrega --apply para ejecutar)'); return; }

  // ---- aplicar ----
  for (const s of wrong) {
    const og = (await prisma.game.findMany({ where: { seasonId: s.id }, select: { id: true } })).map((g) => g.id);
    await prisma.gameEvent.deleteMany({ where: { gameId: { in: og } } });
    await prisma.lineupEntry.deleteMany({ where: { gameId: { in: og } } });
    await prisma.game.deleteMany({ where: { id: { in: og } } });
    await prisma.series.deleteMany({ where: { seasonId: s.id } });
    const lp = await prisma.player.findMany({ where: { team: { leagueId: league.id } }, select: { id: true } });
    await prisma.playerSeasonStat.deleteMany({ where: { playerId: { in: lp.map((p) => p.id) }, season: year } });
    await prisma.season.delete({ where: { id: s.id } });
    console.log(`temporada dañada ${s.id} eliminada (${og.length} juegos)`);
  }
  await prisma.team.createMany({ data: tToCreate as any, skipDuplicates: true });
  await prisma.player.createMany({ data: pToCreate as any, skipDuplicates: true });
  await prisma.season.upsert({ where: { id: bSeason.id }, create: bSeason as any, update: { year: bSeason.year, status: bSeason.status, leagueId: league.id } });
  await prisma.series.deleteMany({ where: { seasonId: bSeason.id } });
  if (bSeries.length) await prisma.series.createMany({ data: bSeries as any, skipDuplicates: true });
  const existingG = new Set((await prisma.game.findMany({ where: { id: { in: [...bGameIds] } }, select: { id: true } })).map((g) => g.id));
  if (existingG.size) {
    const og = [...existingG];
    await prisma.gameEvent.deleteMany({ where: { gameId: { in: og } } });
    await prisma.lineupEntry.deleteMany({ where: { gameId: { in: og } } });
    await prisma.game.deleteMany({ where: { id: { in: og } } });
  }
  if (bGames.length) await prisma.game.createMany({ data: bGames as any, skipDuplicates: true });
  if (bLineups.length) await prisma.lineupEntry.createMany({ data: bLineups as any, skipDuplicates: true });
  if (bEvents.length) await prisma.gameEvent.createMany({ data: bEvents as any, skipDuplicates: true });
  // seasonStats del año: borrar las de jugadores de la liga y reinsertar las del backup
  const lp = await prisma.player.findMany({ where: { team: { leagueId: league.id } }, select: { id: true } });
  await prisma.playerSeasonStat.deleteMany({ where: { playerId: { in: lp.map((p) => p.id) }, season: year } });
  if (bStats.length) await prisma.playerSeasonStat.createMany({ data: bStats as any, skipDuplicates: true });
  console.log(`✔ restaurada ${bLeague.name} ${year}: ${bGames.length} juegos · ${bEvents.length} eventos · ${bStats.length} stats`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); }).finally(() => prisma.$disconnect());
