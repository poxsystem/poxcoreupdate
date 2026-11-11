// Re-formatea .box.txt (RTF de Win11 o texto plano desalineado) → .txt
// alineado a columnas fijas estilo bloc de notas.
//   npx tsx scripts/fmt-box.ts <carpeta-salida> <archivo1> [archivo2...]
// La lógica vive en src/import/boxfile.ts (formatBoxText) — es la misma
// que el importador usa internamente al leer los archivos.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { formatBoxText } from '../src/import/boxfile.js';

const outDir = process.argv[2];
if (!outDir || process.argv.length < 4) {
  console.error('uso: npx tsx scripts/fmt-box.ts <carpeta-salida> <archivos...>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
for (const f of process.argv.slice(3)) {
  const dst = join(outDir, basename(f));
  writeFileSync(dst, formatBoxText(readFileSync(f, 'latin1')), 'latin1');
  console.log('OK →', dst);
}
