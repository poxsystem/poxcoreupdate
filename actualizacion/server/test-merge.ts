/**
 * test-merge.ts — escenario "2025" + "2025 B" (base partida a la mitad).
 * Liga con temporada 2025 ya cargada → importar fragmento del MISMO año
 * con mergeSeason: debe SUMAR juegos, saltar el repetido y sumar stats.
 * Uso: npx tsx test-merge.ts
 */
import { prisma } from './src/prisma';
import { importPox, type PoxFile } from './src/import/pox';

const warn: string[] = [];

const ligaA: PoxFile = {
  format: 'pox-import/1', league: 'Liga Merge Test', sport: 'SOFTBALL', innings: 7,
  seasons: [{
    year: 2025,
    teams: [{ name: 'Tigres' }, { name: 'Leones' }],
    players: [
      { name: 'Emerson Rodriguez', team: 'Tigres' },
      { name: 'Wilkin Colon', team: 'Leones' },
    ],
    games: [
      { date: '2025-03-02', away: 'Tigres', home: 'Leones', awayScore: 4, homeScore: 3, status: 'FINAL',
        stats: [{ player: 'Emerson Rodriguez', team: 'Tigres', g: 1, ab: 3, h: 1 }] },
      { date: '2025-03-09', away: 'Leones', home: 'Tigres', awayScore: 1, homeScore: 2, status: 'FINAL',
        stats: [{ player: 'Emerson Rodriguez', team: 'Tigres', g: 1, ab: 3, h: 2 }] },
    ],
    playerStats: [
      { player: 'Emerson Rodriguez', team: 'Tigres', g: 10, ab: 30, h: 12 }, // 10 juegos en la base que se dañó
      { player: 'Wilkin Colon', team: 'Leones', g: 10, ab: 32, h: 8 },
    ],
  }, {
    year: 2026, // temporada distinta — no debe tocarse
    teams: [{ name: 'Tigres' }, { name: 'Leones' }],
    players: [{ name: 'Emerson Rodriguez', team: 'Tigres' }],
    games: [{ date: '2026-03-01', away: 'Tigres', home: 'Leones', awayScore: 5, homeScore: 4, status: 'FINAL',
      stats: [{ player: 'Emerson Rodriguez', team: 'Tigres', g: 1, ab: 4, h: 2 }] }],
    playerStats: [{ player: 'Emerson Rodriguez', team: 'Tigres', g: 5, ab: 20, h: 8 }],
  }],
};

const ligaB: PoxFile = {
  format: 'pox-import/1', league: 'Liga Merge Test 2025 B', sport: 'SOFTBALL', innings: 7,
  seasons: [{
    year: 2025, // mismo año — fragmento "2025 B"
    teams: [{ name: 'Tigres' }, { name: 'Leones' }],
    players: [
      { name: 'Emerson Rodriguez 2025', team: 'Tigres' }, // con sufijo año — debe matchear la ficha existente
      { name: 'Wilkin Colon', team: 'Leones' },
    ],
    games: [
      // REPETIDO: mismo día + mismos equipos que uno ya importado → debe saltarse
      { date: '2025-03-09', away: 'Leones', home: 'Tigres', awayScore: 1, homeScore: 2, status: 'FINAL',
        stats: [{ player: 'Emerson Rodriguez 2025', team: 'Tigres', g: 1, ab: 3, h: 2 }] },
      // NUEVOS (el resto de la temporada tras dañarse la base)
      { date: '2025-03-16', away: 'Tigres', home: 'Leones', awayScore: 7, homeScore: 6, status: 'FINAL',
        stats: [{ player: 'Emerson Rodriguez 2025', team: 'Tigres', g: 1, ab: 4, h: 3 }] },
      { date: '2025-03-23', away: 'Leones', home: 'Tigres', awayScore: 0, homeScore: 8, status: 'FINAL',
        stats: [{ player: 'Emerson Rodriguez 2025', team: 'Tigres', g: 1, ab: 4, h: 1 }] },
    ],
    playerStats: [
      { player: 'Emerson Rodriguez 2025', team: 'Tigres', g: 11, ab: 40, h: 15 }, // 11 juegos restantes en la base B
      { player: 'Wilkin Colon', team: 'Leones', g: 11, ab: 41, h: 10 },
    ],
  }],
};

async function main() {
  // limpieza previa por si el test corrió antes
  const old = await prisma.league.findFirst({ where: { name: 'Liga Merge Test' } });
  if (old) await prisma.league.delete({ where: { id: old.id } });

  const w1: string[] = [];
  const r1 = await importPox(ligaA, w1);
  const leagueId = r1.leagueId;
  console.log('base A importada:', JSON.stringify(r1.created));

  // sin flags → debe rechazar con 409 (mismo año)
  try {
    await importPox(ligaB, warn, { appendToLeagueId: leagueId });
    console.log('❌ FALLO: import sin flags no rechazó el año duplicado');
  } catch (e) {
    console.log(`✓ sin flags rechazado (${(e as { status?: number }).status}): ${(e as Error).message.slice(0, 90)}`);
  }

  const gBefore = await prisma.game.count({ where: { season: { leagueId } } });

  const w2: string[] = [];
  const r2 = await importPox(ligaB, w2, { appendToLeagueId: leagueId, mergeSeason: true, mergeSameName: true });
  console.log('fragmento B fusionado:', JSON.stringify(r2.created), '| avisos:', w2);

  // verificaciones
  const seasons = await prisma.season.findMany({ where: { leagueId }, orderBy: { year: 'asc' } });
  const g25 = await prisma.game.count({ where: { season: { leagueId, year: 2025 } } });
  const g26 = await prisma.game.count({ where: { season: { leagueId, year: 2026 } } });
  const emerson = await prisma.player.findFirst({ where: { firstName: 'Emerson', team: { leagueId } } });
  const dupes = await prisma.player.count({ where: { firstName: { contains: 'Emerson' }, team: { leagueId } } });
  const st25 = emerson ? await prisma.playerSeasonStat.findFirst({ where: { playerId: emerson.id, season: 2025 } }) : null;
  const st26 = emerson ? await prisma.playerSeasonStat.findFirst({ where: { playerId: emerson.id, season: 2026 } }) : null;

  let ok = true;
  const check = (cond: boolean, msg: string) => { console.log(`${cond ? '✓' : '❌ FALLO'}: ${msg}`); if (!cond) ok = false; };

  check(seasons.length === 2, `2 temporadas (2025+2026), hay ${seasons.length}`);
  check(g25 === 4, `temporada 2025: 4 juegos únicos (2 A + 3 B - 1 repetido), hay ${g25}`);
  check(g26 === 1, `temporada 2026 intacta: 1 juego, hay ${g26}`);
  check(dupes === 1, `una sola ficha Emerson (sin "Emerson Rodriguez 2025"), hay ${dupes}`);
  // A: 10 declarados + 2 líneas de juego = 12 · B: 11 declarados + 2 juegos nuevos = 13 → 25
  check((st25?.g ?? 0) === 25, `Emerson 2025: g=25 (12+13 fusionados), tiene ${st25?.g}`);
  check((st26?.g ?? 0) === 6, `Emerson 2026: g=6 intacto (5+1 línea), tiene ${st26?.g}`);
  check(gBefore === 3, `antes de fusionar había 3 juegos, había ${gBefore}`);

  // limpieza
  await prisma.league.delete({ where: { id: leagueId } });
  console.log(ok ? '\n✅ TODO PASÓ' : '\n❌ HAY FALLOS');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('💥', e); process.exit(1); }).finally(() => prisma.$disconnect());
