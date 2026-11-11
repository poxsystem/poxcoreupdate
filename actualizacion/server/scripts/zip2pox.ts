import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createExtractorFromData } from 'node-unrar-js';
import { convertBallstatFolder } from '../src/conv-ballstat';

/**
 * zip2pox — convierte paquetes BallScore sueltos a .pox.json de un solo paso.
 *
 * Fuentes (una o varias, se combinan):
 *   npx tsx scripts/zip2pox.ts "BallScore Reports.zip" "WebBuilder.zip" -o salida.pox.json
 *   npx tsx scripts/zip2pox.ts "Regular season.zip" "SEMIFINAL25.zip" "FINAL25.zip" -o liga2024.pox.json
 *   npx tsx scripts/zip2pox.ts <carpeta> -o salida.pox.json [--name "Mi Liga"]
 *
 * Cada fuente puede ser .zip, .rar o carpeta. El script busca las subcarpetas
 * "BallScore Reports" y "WebBuilder" donde sea dentro de cada una y las junta.
 *
 * Fases por nombre de base: si una fuente (o la carpeta que contiene sus
 * reportes) se llama algo como "SEMIFINALxx" / "FINALxx" / "Regular...", sus
 * juegos se etiquetan con esa fase — el dato de la base manda sobre el
 * detector por calendario del conversor.
 */

const PHASE_RE = [
  { re: /semifinal|semi/i, name: 'Semifinal' },
  { re: /final|finals/i, name: 'Final' },
  { re: /regular|regul|temporada/i, name: '' },         // '' = temporada regular (sin serie)
  { re: /playoff|post|serie|ronda/i, name: 'Postemporada' },
];

function phaseOf(name: string): string | null {
  for (const p of PHASE_RE) if (p.re.test(name)) return p.name;
  return null;
}

async function extractRar(buf: Buffer, dest: string): Promise<void> {
  const extractor = await createExtractorFromData({ data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer });
  const list = extractor.getFileList();
  const names = [...list.fileHeaders].filter((h) => !h.flags.directory).map((h) => h.name);
  const { files } = extractor.extract({ files: names });
  for (const f of files) {
    if (!f.extraction) continue;
    const out = path.join(dest, f.fileHeader.name.replace(/\\/g, '/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(f.extraction as Uint8Array));
  }
}

/** Busca recursivamente dirs con nombre `target` (case-insensitive). */
function findDirs(root: string, target: string, depth = 0, out: string[] = []): string[] {
  if (depth > 5) return out;
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const full = path.join(root, e.name);
      if (e.name.toLowerCase() === target.toLowerCase()) out.push(full);
      else findDirs(full, target, depth + 1, out);
    }
  } catch { /* ignore */ }
  return out;
}

/** Tag de fase para una carpeta de reportes: mira el nombre de la fuente
 * (zip/carpeta) y luego los ancestros hasta la raíz extraída. */
function tagFor(reportsDir: string, sourceLabel: string, extractRoot: string): string | null {
  let cur: string = sourceLabel;
  const hit = phaseOf(cur);
  if (hit !== null) return hit;
  cur = path.dirname(reportsDir);
  while (cur.startsWith(extractRoot) && cur !== extractRoot) {
    const ph = phaseOf(path.basename(cur));
    if (ph !== null) return ph;
    cur = path.dirname(cur);
  }
  return null;
}

const FN_RE = /^(\d{2})-(\d{2})-(\d{2})[a-z]?\s+(.+?)\s+at\s+(.+?)\.box\.txt$/i; // [a-z]? = dobleheader a/b
const gameKey = (iso: string, away: string, home: string) => `${iso}|${away.trim().toUpperCase()}|${home.trim().toUpperCase()}`;
const pairKey = (away: string, home: string) => `${away.trim().toUpperCase()}|${home.trim().toUpperCase()}`;
interface TaggedFile { key: string; pair: string; tag: string; used: boolean }

async function main() {
  const args = process.argv.slice(2);
  const sources: string[] = [];
  let out = ''; let leagueName = '';
  const merges: { name: string; team: string }[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o') out = args[++i];
    else if (args[i] === '--name') leagueName = args[++i];
    else if (args[i] === '--merge' && args[i + 1]) {
      const [name, team] = args[++i].split('|').map((s) => s.trim());
      if (name && team) merges.push({ name, team });
    } else sources.push(args[i]);
  }
  if (!sources.length || !out) {
    console.error('uso: npx tsx scripts/zip2pox.ts <zip|rar|carpeta>... -o salida.pox.json [--name "Liga"] [--merge "Nombre|Equipo"]');
    process.exit(2);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zip2pox-'));
  try {
    const combo = path.join(work, leagueName ? leagueName.replace(/[\\/:*?"<>|]/g, '') : 'liga');
    const repOut = path.join(combo, 'BallScore Reports');
    const wbOut = path.join(combo, 'WebBuilder');
    fs.mkdirSync(repOut, { recursive: true });
    const tagFiles: TaggedFile[] = [];
    let repFound = 0; let wbFound = 0; let copied = 0;

    for (const src of sources) {
      const label = path.basename(src).replace(/\.(zip|rar)$/i, '');
      let root = src;
      let tmp = '';
      if (fs.statSync(src).isFile()) {
        tmp = fs.mkdtempSync(path.join(work, 'src-'));
        const buf = fs.readFileSync(src);
        if (/\.rar$/i.test(src)) await extractRar(buf, tmp);
        else new AdmZip(buf).extractAllTo(tmp, true);
        root = tmp;
      }
      for (const rd of findDirs(root, 'BallScore Reports')) {
        repFound++;
        const tag = tagFor(rd, label, root);
        for (const f of fs.readdirSync(rd)) {
          const m = f.match(FN_RE);
          if (m && tag !== null) {
            const iso = `20${m[3]}-${m[1]}-${m[2]}`;
            tagFiles.push({ key: gameKey(iso, m[4], m[5]), pair: pairKey(m[4], m[5]), tag, used: false });
          }
          const dest = path.join(repOut, f);
          if (!fs.existsSync(dest)) { fs.copyFileSync(path.join(rd, f), dest); copied++; }
        }
      }
      for (const wd of findDirs(root, 'WebBuilder')) {
        wbFound++;
        fs.mkdirSync(wbOut, { recursive: true });
        for (const f of fs.readdirSync(wd)) {
          const dest = path.join(wbOut, f);
          if (!fs.existsSync(dest)) fs.copyFileSync(path.join(wd, f), dest);
        }
      }
      // Rosters/*.ros — roster nativo: nombres completos de quienes no tienen htm
      for (const rd of findDirs(root, 'Rosters')) {
        fs.mkdirSync(path.join(combo, 'Rosters'), { recursive: true });
        for (const f of fs.readdirSync(rd)) {
          const dest = path.join(combo, 'Rosters', f);
          if (!fs.existsSync(dest)) fs.copyFileSync(path.join(rd, f), dest);
        }
      }
    }

    if (!repFound) { console.error('ninguna fuente trae "BallScore Reports"'); process.exit(1); }
    console.log(`fuentes: ${sources.length} · carpetas de reportes: ${repFound} · WebBuilder: ${wbFound} · archivos copiados: ${copied}`);
    if (tagFiles.length) console.log(`fases por nombre de base: ${tagFiles.length} juegos etiquetados (${[...new Set(tagFiles.map((t) => t.tag))].map((t) => t || 'Regular').join(', ')})`);

    const r = convertBallstatFolder(combo, { merges });
    const pox = r.pox as {
      league: string;
      seasons: { year: number; series?: { name: string; round: number; home: string; away: string; winner?: string; status: string }[]; games: { date: string; away: string; home: string; scoreAway: number; scoreHome: number; series?: string }[] }[];
    };
    const s = pox.seasons[0];
    if (leagueName) pox.league = leagueName;

    // ---- re-etiquetar por base de origen: el nombre de la base manda ----
    if (tagFiles.length) {
      const byKey = new Map(tagFiles.map((t) => [t.key, t]));
      const untagged: typeof s.games = [];
      for (const g of s.games) {
        const tf = byKey.get(gameKey(g.date, g.away, g.home));
        if (tf) { tf.used = true; g.series = tf.tag || undefined; }
        else untagged.push(g);
      }
      // respaldo: la fecha del CONTENIDO del box puede diferir del filename —
      // casa por pareja cuando todos los archivos sin usar de esa pareja
      // comparten UNA fase
      for (const g of untagged) {
        const cands = tagFiles.filter((t) => !t.used && t.pair === pairKey(g.away, g.home));
        const tags = new Set(cands.map((t) => t.tag));
        if (cands.length && tags.size === 1) { cands[0].used = true; g.series = cands[0].tag || undefined; }
      }
      // reconstruir series[] con los juegos ya etiquetados
      type G = (typeof s.games)[number];
      const seriesDefs = new Map<string, { games: G[]; wins: Map<string, number> }>();
      for (const g of s.games) {
        if (!g.series) continue;
        const def = seriesDefs.get(g.series) ?? { games: [] as G[], wins: new Map<string, number>() };
        def.games.push(g);
        const w = g.scoreHome > g.scoreAway ? g.home : g.scoreAway > g.scoreHome ? g.away : '';
        if (w) def.wins.set(w, (def.wins.get(w) ?? 0) + 1);
        seriesDefs.set(g.series, def);
      }
      const order = [...seriesDefs.entries()].sort((a, b) => (a[1].games.at(-1)?.date ?? '').localeCompare(b[1].games.at(-1)?.date ?? ''));
      s.series = order.map(([name, def], i) => {
        const sorted = [...def.wins.entries()].sort((a, b) => b[1] - a[1]);
        return {
          name, round: i + 1, home: def.games[0].home, away: def.games[0].away,
          winner: sorted.length && sorted[0][1] > (sorted[1]?.[1] ?? -1) ? sorted[0][0] : undefined,
          status: 'ENDED',
        };
      });
    }

    const post = s.games.filter((g) => g.series).length;
    fs.writeFileSync(out, JSON.stringify(pox, null, 1));
    console.log(`\njuegos: ${s.games.length} (REG ${s.games.length - post} · POST ${post}) · jugadores: ${r.players} · equipos: ${r.teams.join(' | ')}`);
    for (const sr of s.series ?? []) console.log(`  ${sr.name}: ${sr.away} @ ${sr.home}${sr.winner ? ` → ${sr.winner}` : ''}`);
    console.log(`escrito ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
    if (r.warnings.length) { console.log(`avisos: ${r.warnings.length}`); r.warnings.slice(0, 20).forEach((w) => console.log(`  ⚠ ${w}`)); }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
