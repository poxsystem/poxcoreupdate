import fs from 'node:fs';
import { prisma } from '../src/prisma';

// Resuelve jugadores por apellido (paquetes BallScore sin WebBuilder) contra el
// roster de la liga en la BD. Solo asigna cuando el apellido es ÚNICO en el
// equipo; los homónimos "(n)" y los sin candidato quedan para revisión manual.
// Uso: npx tsx scripts/resolve-surnames.ts <archivo.pox.json>

const norm = (s: string) => s.toUpperCase().replace(/\s+/g, ' ').trim();

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('uso: npx tsx scripts/resolve-surnames.ts <archivo.pox.json>'); process.exit(2); }
  const pox = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = pox.seasons[0];

  const teams = await prisma.team.findMany({ include: { players: true } });
  const roster = new Map<string, { name: string }[]>();
  for (const t of teams) {
    const k = norm(t.name);
    const arr = roster.get(k) ?? [];
    for (const p of t.players) {
      const name = `${p.firstName} ${p.lastName}`.trim();
      if (!arr.some((r) => norm(r.name) === norm(name))) arr.push({ name });
    }
    roster.set(k, arr);
  }

  const alias = new Map<string, string>();
  const pending: string[] = [];
  for (const p of s.players as { name: string; team: string }[]) {
    if (p.name.includes(' ')) continue; // ya resuelto a nombre completo
    const team = norm(p.team);
    const base = norm(p.name.replace(/\s*\(\d+\)$/, ''));
    const cands = (roster.get(team) ?? []).filter((r) => {
      const rn = norm(r.name);
      return rn.endsWith(' ' + base) || rn.split(' ').pop() === base.split(' ').pop();
    });
    if (cands.length === 1 && !/\(\d+\)$/.test(p.name)) alias.set(`${p.team}|${p.name}`, cands[0].name);
    else pending.push(`${p.name} (${p.team})${cands.length ? ` — ${cands.map((c) => c.name).join(' / ')}` : ' — sin candidato'}`);
  }

  for (const p of s.players as { name: string; team: string }[]) {
    const hit = alias.get(`${p.team}|${p.name}`);
    if (hit) p.name = hit;
  }
  for (const g of s.games as { stats?: { player: string; team: string }[] }[]) {
    for (const st of g.stats ?? []) {
      const hit = alias.get(`${st.team}|${st.player}`);
      if (hit) st.player = hit;
    }
  }
  fs.writeFileSync(file, JSON.stringify(pox, null, 1));
  console.log(`resueltos: ${alias.size} · pendientes: ${pending.length}`);
  pending.forEach((u) => console.log('  ? ' + u));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
