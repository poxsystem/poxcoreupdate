/**
 * fixpost-imported.ts — marca postemporada en temporadas IMPORTADAS que quedaron
 * sin series (los .box.txt no declaran playoff; el conversor nuevo lo detecta por
 * reinicio de récord (W-L) — este script es para ligas ya importadas).
 *
 * Señal: temporada regular juega varias parejas por fecha; playoff = racha final
 * de fechas donde SOLO juega una pareja. Límite = primera fecha tras la cual
 * TODAS las fechas tienen una sola pareja. Cada racha consecutiva de la misma
 * pareja = una Series (última=Final, penúltima=Semifinal, antes=Ronda N).
 *
 * Efectos: crea Series (DONE, winner = más victorias, winsNeeded = sus W),
 * game.seriesId, y re-divide PlayerSeasonStat: suma statLines de juegos POST a
 * fila scope=POST y las descuenta de scope=REG (todo era REG al importar).
 *
 *   npx tsx scripts/fixpost-imported.ts [nombre-liga]   (sin arg = todas)
 */
import { prisma } from '../src/prisma.js';

// columnas numéricas de PlayerSeasonStat (po/a/bf NO existen ahí — solo en statLines)
const COLS = [
  'g', 'pa', 'ab', 'r', 'h', 'doubles', 'triples', 'hr', 'rbi', 'bb', 'k', 'hbp',
  'sac', 'sf', 'sb', 'gp', 'gs', 'w', 'l', 'sv', 'hld', 'bs', 'cg', 'sho',
  'pOuts', 'pH', 'pR', 'pER', 'pBB', 'pK', 'pHR', 'pPitches', 'e',
];

const main = async () => {
  const arg = process.argv[2];
  const leagues = await prisma.league.findMany({ where: arg ? { name: { contains: arg } } : {} });
  for (const league of leagues) {
    const seasons = await prisma.season.findMany({ where: { leagueId: league.id }, orderBy: { year: 'asc' } });
    for (const s of seasons) {
      const games = await prisma.game.findMany({
        where: { seasonId: s.id, seriesId: null },
        orderBy: { date: 'asc' },
        include: { awayTeam: { select: { id: true, name: true } }, homeTeam: { select: { id: true, name: true } } },
      });
      if (!games.length) continue;
      const byDate = new Map<string, Set<string>>();
      for (const g of games) {
        const d = g.date.toISOString().slice(0, 10);
        const pair = [g.awayTeam.name, g.homeTeam.name].sort().join('|');
        byDate.set(d, (byDate.get(d) ?? new Set()).add(pair));
      }
      const dates = [...byDate.keys()];
      const boundary = dates.find((d, i) => byDate.get(d)!.size === 1 && dates.slice(i).every((x) => byDate.get(x)!.size === 1));
      if (!boundary) { console.log(`${league.name} ${s.year}: sin post detectable`); continue; }

      // una pareja = UNA serie aunque los juegos se intercalen con otra serie
      // (agrupar por "racha" partía una serie intercalada en varios pedazos y
      // confundía Semifinal/Final). El orden de rondas lo decide cuándo TERMINA
      // cada serie: la última en acabar es siempre la Final.
      const postGames = games.filter((g) => g.date.toISOString().slice(0, 10) >= boundary);
      const byPair = new Map<string, typeof postGames>();
      for (const g of postGames) {
        const pair = [g.awayTeam.name, g.homeTeam.name].sort().join('|');
        const arr = byPair.get(pair) ?? [];
        arr.push(g);
        byPair.set(pair, arr);
      }
      const runs = [...byPair.entries()]
        .map(([pair, gs]) => ({ pair, gs, last: gs.reduce((m, g) => Math.max(m, g.date.getTime()), 0) }))
        .sort((a, b) => a.last - b.last);
      console.log(`${league.name} ${s.year}: post desde ${boundary} · ${runs.length} serie(s)`);

      for (const [i, run] of runs.entries()) {
        const [aName, hName] = run.pair.split('|');
        const rg = run.gs;
        const wins = new Map<string, number>();
        for (const g of rg) {
          const a = g.fScoreAway ?? 0, h = g.fScoreHome ?? 0;
          if (a === h) continue;
          wins.set(a > h ? g.awayTeamId : g.homeTeamId, (wins.get(a > h ? g.awayTeamId : g.homeTeamId) ?? 0) + 1);
        }
        const winner = [...wins.entries()].sort((x, y) => y[1] - x[1])[0];
        const name = i === runs.length - 1 ? 'Final'
          : runs.length <= 3 ? (runs.length === 3 ? `Semifinal ${i + 1}` : 'Semifinal')
          : i === runs.length - 2 ? 'Semifinal' : `Ronda ${i + 1}`;
        const homeT = rg[0].homeTeam.name === aName ? { id: rg[0].homeTeamId, name: aName } : { id: rg[0].awayTeamId, name: aName };
        const awayT = rg[0].homeTeam.name === hName ? { id: rg[0].homeTeamId, name: hName } : { id: rg[0].awayTeamId, name: hName };
        const serie = await prisma.series.create({
          data: {
            leagueId: league.id, seasonId: s.id, round: i + 1, name,
            homeTeamId: winner ? winner[0] : homeT.id,
            awayTeamId: winner ? (winner[0] === homeT.id ? awayT.id : homeT.id) : awayT.id,
            winsNeeded: winner?.[1] ?? 3, status: 'DONE', winnerTeamId: winner?.[0] ?? null,
          },
        });
        for (const g of rg) await prisma.game.update({ where: { id: g.id }, data: { seriesId: serie.id } });
        const wn = await prisma.team.findUnique({ where: { id: winner?.[0] ?? '' }, select: { name: true } });
        console.log(`   ${name}: ${aName} vs ${hName} · ${rg.length} juegos · gana ${wn?.name ?? '?'} (${winner?.[1] ?? 0}-${[...wins.values()].reduce((x, y) => x + y, 0) - (winner?.[1] ?? 0)})`);
      }

      // re-divide acumulados: statLines de juegos post → scope POST, resta de REG
      const postIds = new Set(postGames.map((g) => g.id));
      const sum = new Map<string, Record<string, number>>();
      for (const g of postGames) {
        for (const l of (g.statLines as Record<string, unknown>[] | null) ?? []) {
          const pid = l.playerId as string;
          const acc = sum.get(pid) ?? {};
          for (const c of COLS) if (typeof l[c] === 'number' && l[c]) acc[c] = (acc[c] ?? 0) + (l[c] as number);
          sum.set(pid, acc);
        }
      }
      let moved = 0;
      for (const [pid, data] of sum) {
        await prisma.playerSeasonStat.upsert({
          where: { playerId_season_scope: { playerId: pid, season: s.year, scope: 'POST' } },
          create: { playerId: pid, season: s.year, scope: 'POST', ...data },
          update: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { increment: v }])),
        });
        const reg = await prisma.playerSeasonStat.findUnique({ where: { playerId_season_scope: { playerId: pid, season: s.year, scope: 'REG' } } });
        if (reg) {
          const regNum = reg as unknown as Record<string, number>;
          const fix = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Math.max(0, (regNum[k] ?? 0) - v)]));
          await prisma.playerSeasonStat.update({ where: { playerId_season_scope: { playerId: pid, season: s.year, scope: 'REG' } }, data: fix });
        }
        moved++;
      }
      console.log(`   acumulados re-divididos: ${moved} jugadores · ${postIds.size} juegos POST`);
    }
  }
  await prisma.$disconnect();
};
main();
