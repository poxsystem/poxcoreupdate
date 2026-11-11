/**
 * backup-to-pox.ts — convierte UNA temporada de un respaldo auto-*.json
 * en un .pox.json listo para importar por la app (📥 Importar → anexar).
 *
 * Uso:
 *   npx tsx scripts/backup-to-pox.ts backups/auto-XXXX.json "Sector Norte 2026" 2026 -o restaurar-2026.json
 *
 * El archivo resultante se importa desde la app sin tocar cmd:
 *   Ligas → 📥 Importar → elegir el .json → "Agregar como temporada a «liga»"
 *   → ♻️ Reemplazar (borra la temporada dañada) → Importar.
 */
import fs from 'node:fs';

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

const [file, leagueName, yearArg, ...rest] = process.argv.slice(2);
if (!file || !leagueName || !yearArg) {
  console.log('uso: npx tsx scripts/backup-to-pox.ts <backup.json> "<liga>" <año> [-o salida.json]');
  process.exit(1);
}
const year = Number(yearArg);
const out = rest[rest.indexOf('-o') + 1] || `restaurar-${year}.json`;

const bk = JSON.parse(fs.readFileSync(file, 'utf8'));
const D = (k: string): any[] => (Array.isArray(bk[k]) ? bk[k] : []);

const league = D('leagues').find((l: any) => norm(l.name) === norm(leagueName));
if (!league) throw new Error(`liga "${leagueName}" no está en el respaldo — hay: ${D('leagues').map((l: any) => l.name).join(', ')}`);
const season = D('seasons').find((s: any) => s.leagueId === league.id && s.year === year);
if (!season) throw new Error(`el respaldo no tiene ${year} en "${league.name}" — años: ${D('seasons').filter((s: any) => s.leagueId === league.id).map((s: any) => s.year).join(', ')}`);

const teams = D('teams').filter((t: any) => t.leagueId === league.id);
const teamById = new Map(teams.map((t: any) => [t.id, t]));
const players = D('players').filter((p: any) => teamById.has(p.teamId));
const playerById = new Map(players.map((p: any) => [p.id, p]));
const series = D('series').filter((s: any) => s.seasonId === season.id);
const seriesById = new Map(series.map((s: any) => [s.id, s]));
const games = D('games').filter((g: any) => g.seasonId === season.id);

const pname = (id?: string | null) => {
  const p = id && playerById.get(id);
  return p ? `${p.firstName} ${p.lastName}`.trim() : undefined;
};
const tname = (id?: string | null) => (id && teamById.get(id)?.name) || undefined;

// claves de stats que viajan en Game.statLines / PlayerSeasonStat
const SKIP = new Set(['playerId', 'teamId', 'player', 'team']);
const statLine = (row: any) => {
  const out: Record<string, unknown> = { player: pname(row.playerId), team: tname(row.teamId) };
  for (const [k, v] of Object.entries(row)) {
    if (!SKIP.has(k) && typeof v === 'number' && v !== 0) out[k] = v;
  }
  return out.player ? out : null;
};

let noLines = 0, noPlayer = 0;
const pox = {
  format: 'pox-import/1',
  league: league.name,
  sport: league.sport ?? 'softball',
  seasons: [{
    year,
    status: season.status,
    teams: teams.map((t: any) => ({ name: t.name, short: t.short, color: t.color })),
    players: players.map((p: any) => ({
      name: `${p.firstName} ${p.lastName}`.trim(),
      team: tname(p.teamId),
      number: p.num ?? undefined, bats: p.bats ?? undefined,
      throws: p.throws ?? undefined, pos: p.pos ?? undefined,
      ...(p.active === false ? { active: false } : {}),
    })),
    series: series.map((s: any) => ({
      name: s.name, round: s.round,
      home: tname(s.homeTeamId), away: tname(s.awayTeamId),
      winsNeeded: s.winsNeeded, winner: tname(s.winnerTeamId), status: s.status,
    })),
    games: games
      .sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)))
      .map((g: any) => {
        const lines = (Array.isArray(g.statLines) ? g.statLines : []).map(statLine).filter(Boolean);
        for (const row of Array.isArray(g.statLines) ? g.statLines : []) if (!pname(row.playerId)) noPlayer++;
        if (!lines.length) noLines++;
        return {
          date: String(g.date ?? '').slice(0, 10) || undefined,
          away: tname(g.awayTeamId), home: tname(g.homeTeamId),
          status: g.status === 'FINAL' ? 'FINAL' : undefined,
          scoreAway: g.fScoreAway ?? undefined, scoreHome: g.fScoreHome ?? undefined,
          tied: g.tied || undefined, forfeitBy: tname(g.forfeitBy) || g.forfeitBy || undefined,
          stadium: g.stadium || undefined, note: g.note || undefined,
          wp: pname(g.wpId), lp: pname(g.lpId), sv: pname(g.svId),
          series: g.seriesId ? seriesById.get(g.seriesId)?.name : undefined,
          stats: lines.length ? lines : undefined,
        };
      }),
  }],
};

fs.writeFileSync(out, JSON.stringify(pox));
const sz = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`✔ ${out} (${sz} KB) — ${league.name} ${year}: ${games.length} juegos · ${players.length} jugadores · ${series.length} series`);
if (noLines) console.log(`  ⚠ ${noLines} juegos sin líneas de stats en el respaldo`);
if (noPlayer) console.log(`  ⚠ ${noPlayer} líneas con jugador no resoluble (se omiten)`);
console.log('→ impórtalo en la app: 📥 Importar → este archivo → "Agregar como temporada" → ♻️ Reemplazar');
