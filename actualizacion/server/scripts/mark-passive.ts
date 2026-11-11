/**
 * Marca PASIVOS los jugadores que no participaron en la temporada vigente.
 *
 * Contexto: las temporadas importadas con la regla vieja (antes de que los
 * jugadores nuevos nacieran pasivos) dejaron ACTIVOS a jugadores de años
 * viejos — el roster del año vigente se abulta con gente que ya no juega.
 *
 * Regla: un jugador de la liga queda ACTIVO solo si aparece en al menos un
 * juego de la temporada MÁS RECIENTE (lineup, statLine o evento). El resto
 * pasa a passive (active=false) — conserva ficha, stats e historial; se
 * reactiva manual o automáticamente si vuelve a jugar.
 *
 * Uso:
 *   npx tsx scripts/mark-passive.ts <nombre-liga>            → vista previa (no toca nada)
 *   npx tsx scripts/mark-passive.ts <nombre-liga> --apply    → aplica la baja
 *   npx tsx scripts/mark-passive.ts <nombre-liga> --year=2025 → vigente forzado a 2025
 */
import { prisma } from '../src/prisma.js';

const name = process.argv[2];
const apply = process.argv.includes('--apply');
const yearArg = Number(process.argv.find((a) => a.startsWith('--year='))?.split('=')[1]) || undefined;
if (!name) {
  console.error('uso: npx tsx scripts/mark-passive.ts <nombre-liga> [--apply] [--year=YYYY]');
  process.exit(1);
}

const league = await prisma.league.findFirst({ where: { name: { contains: name } }, include: { seasons: true } });
if (!league) { console.error(`Liga "${name}" no encontrada`); process.exit(1); }
const seasons = league.seasons.map((s) => s.year).sort((a, b) => b - a);
const curYear = yearArg ?? seasons[0];
const curSeason = league.seasons.find((s) => s.year === curYear);
if (!curSeason) { console.error(`La liga no tiene temporada ${curYear}`); process.exit(1); }

const teams = await prisma.team.findMany({ where: { leagueId: league.id } });
const players = await prisma.player.findMany({ where: { teamId: { in: teams.map((t) => t.id) } } });

// juegos de la temporada vigente
const games = await prisma.game.findMany({
  where: { leagueId: league.id, seasonId: curSeason.id },
  select: { id: true, statLines: true, lineups: { select: { playerId: true } }, events: { select: { batterId: true, pitcherId: true, advances: true } } },
});

// jugadores que SÍ participaron en la temporada vigente
const played = new Set<string>();
for (const g of games) {
  for (const l of g.lineups) played.add(l.playerId);
  for (const e of g.events) {
    if (e.batterId) played.add(e.batterId);
    if (e.pitcherId) played.add(e.pitcherId);
    for (const a of (e.advances as { playerId?: string }[] | null) ?? []) if (a.playerId) played.add(a.playerId);
  }
  for (const sl of (g.statLines as { playerId?: string }[] | null) ?? []) if (sl.playerId) played.add(sl.playerId);
}

const toPassive = players.filter((p) => p.active !== false && !played.has(p.id));
const staysActive = players.filter((p) => p.active !== false && played.has(p.id));

const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? '?';
console.log(`\n=== ${league.name} — temporada vigente ${curYear} (${games.length} juegos) ===`);
console.log(`Activos que SÍ jugaron ${curYear}: ${staysActive.length}`);
console.log(`Activos que NO jugaron ${curYear} → pasarían a PASIVOS: ${toPassive.length}\n`);
for (const p of toPassive) {
  console.log(`  ${teamName(p.teamId).padEnd(12)} ${p.firstName} ${p.lastName}`);
}
if (!toPassive.length) console.log('  (ninguno — los rosters están limpios)');

if (apply && toPassive.length) {
  const r = await prisma.player.updateMany({ where: { id: { in: toPassive.map((p) => p.id) } }, data: { active: false } });
  console.log(`\n✔ ${r.count} jugadores pasados a PASIVOS (conservan stats e historial)`);
} else if (toPassive.length) {
  console.log(`\n(vista previa — corre con --apply para aplicar)`);
}
process.exit(0);
