/**
 * restore-league.ts — recupera UNA liga entera al estado de un respaldo.
 * (misma lógica que el modal «🕐 Restaurar» de la app — restoreLeagueFromBackup)
 *
 * Uso:
 *   npx tsx scripts/restore-league.ts backups/auto-XXXX.json "Sector Norte 2026"
 *     → VISTA PREVIA (no toca nada)
 *   npx tsx scripts/restore-league.ts backups/auto-XXXX.json "Sector Norte 2026" --apply
 */
import fs from 'node:fs';
import { prisma } from '../src/prisma.js';
import { previewBackupLeagues, restoreLeagueFromBackup } from '../src/backup-lib.js';

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

const [file, leagueName, ...rest] = process.argv.slice(2);
const apply = rest.includes('--apply');
if (!file || !leagueName) {
  console.log('uso: npx tsx scripts/restore-league.ts <backup.json> "<liga>" [--apply]');
  process.exit(1);
}
if (!fs.existsSync(file)) { console.error(`no existe: ${file}`); process.exit(1); }

const bk = JSON.parse(fs.readFileSync(file, 'utf8'));
const info = previewBackupLeagues(bk).find((l) => norm(l.name) === norm(leagueName));
if (!info) {
  console.error(`"${leagueName}" no está en el respaldo. Ligas que trae:`);
  for (const l of previewBackupLeagues(bk)) console.error('  -', l.name);
  process.exit(1);
}

console.log(`\n=== RESPALDO ${file} ===`);
console.log(`liga: ${info.name} · temporadas: [${info.years.join(', ')}]`);
console.log(`equipos: ${info.teams} · jugadores: ${info.players} · juegos: ${info.games} (${info.from} → ${info.to})`);

const lgDb = await prisma.league.findFirst({ where: { name: { equals: info.name } } });
if (lgDb) {
  const sDb = await prisma.season.findMany({ where: { leagueId: lgDb.id }, select: { year: true, _count: { select: { games: true } } } });
  const tDb = await prisma.team.count({ where: { leagueId: lgDb.id } });
  const pDb = await prisma.player.count({ where: { team: { leagueId: lgDb.id } } });
  console.log(`\n=== BASE ACTUAL ===`);
  console.log(`temporadas: ${sDb.map((s) => `${s.year}(${s._count.games} juegos)`).join(' ')} · equipos: ${tDb} · jugadores: ${pDb}`);
} else {
  console.log(`\n=== BASE ACTUAL: la liga NO existe (solo se insertará) ===`);
}

if (!apply) {
  console.log(`\n— VISTA PREVIA — corre de nuevo con --apply para restaurar`);
  process.exit(0);
}

const out = await restoreLeagueFromBackup(bk, leagueName);
console.log(`✔ "${out.league}" restaurada: ${out.years.join(', ')} · ${out.teams} equipos · ${out.players} jugadores · ${out.games} juegos`);
