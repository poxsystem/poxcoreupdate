// Crea la liga de prueba de los .box.txt (equipos + jugadores, SIN stats ni juegos)
// Uso: npx tsx scripts/setup-box-league.ts <carpeta-con-box.txt>
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../src/prisma.js';
import { parseBoxFile } from '../src/import/boxfile.js';

const dir = process.argv[2] ?? 'C:/app/poxscore/BOX';
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.txt'));

// nombre → primera posición vista, por equipo; y veces que repite nombre en el MISMO juego
const rosters = new Map<string, Map<string, { name: string; pos?: string; dup: number }>>();
const seenInGame = new Set<string>();
for (const f of files) {
  const raw = readFileSync(join(dir, f));
  const text = new TextDecoder('windows-1252').decode(raw);
  const parsed = parseBoxFile(text, f);
  if (!parsed) { console.error(`✗ ${f}: no reconocido`); continue; }
  const perGame = new Map<string, number>(); // team|norm → count en ESTE juego
  for (const r of parsed.rows) {
    const tname = (r.team ?? '').toUpperCase(); // el parser ya pone el nombre del equipo
    const norm = r.name.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const key = `${tname}|${norm}`;
    // dos líneas de BATEO del mismo nombre en un juego = dos personas distintas;
    // el pitcheo no cuenta (el que batea y lanza repite nombre legítimamente)
    const n = r.section === 'bat' ? (perGame.get(key) ?? 0) + 1 : 1;
    perGame.set(key, Math.max(perGame.get(key) ?? 0, n));
    let ros = rosters.get(tname);
    if (!ros) rosters.set(tname, (ros = new Map()));
    const cur = ros.get(norm);
    if (!cur) ros.set(norm, { name: r.name.trim(), pos: r.pos, dup: 0 });
    else { if (!cur.pos && r.pos) cur.pos = r.pos; cur.dup = Math.max(cur.dup, n - 1); }
  }
  console.log(`✓ ${f}: ${parsed.away} ${parsed.scoreAway} @ ${parsed.home} ${parsed.scoreHome} · ${parsed.rows.length} filas`);
}

const LEAGUE = 'PRUEBA BOX 2019';
let league = await prisma.league.findFirst({ where: { name: LEAGUE }, include: { _count: { select: { teams: true } } } });
if (league && league._count.teams > 0) { console.log(`⚠ ya existe "${LEAGUE}" con equipos (${league.id}) — no duplico`); process.exit(0); }
if (!league) {
  league = Object.assign(await prisma.league.create({ data: { name: LEAGUE, year: 2019, sport: 'softball' } }), { _count: { teams: 0 } });
  await prisma.season.create({ data: { leagueId: league.id, year: 2019 } }).catch(() => {});
}
console.log(`\nLiga: ${LEAGUE} (${league.id}) · temporada 2019`);

const cap = (s: string) => (s === s.toUpperCase() && s.length > 2 ? s[0] + s.slice(1).toLowerCase() : s);
for (const [tname, ros] of rosters) {
  const team = await prisma.team.create({ data: { name: tname, leagueId: league.id } });
  // si el mismo apellido juega 2+ posiciones/personas en un juego → fichas separadas " (2)"
  let created = 0;
  for (const [, pl] of ros) {
    for (let k = 0; k <= pl.dup; k++) {
      const rawName = k === 0 ? pl.name : `${pl.name} (${k + 1})`;
      const toks = rawName.split(' ');
      // inicial suelta al final ("Díaz B.") → firstName; el resto es apellido
      let firstName = '', lastName = rawName;
      if (toks.length > 1 && /^[A-ZÁÉÍÓÚÑ]\.$/.test(toks[toks.length - 1])) {
        firstName = toks.pop()!; lastName = toks.join(' ');
      }
      if (!firstName) firstName = '·'; // apellido solo — el matcher usa lastName
      await prisma.player.create({
        data: { teamId: team.id, firstName, lastName: cap(lastName), positions: pl.pos ?? null },
      });
      created++;
    }
  }
  console.log(`  ${tname}: ${created} jugadores (${ros.size} nombres)`);
}
await prisma.$disconnect();
