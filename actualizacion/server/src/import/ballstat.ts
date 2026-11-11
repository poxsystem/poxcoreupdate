/**
 * Conversor BallStat → pox-import/1.
 *
 * Acepta el paquete de liga completo (`.rar` o `.zip` de la carpeta BallStat
 * con "BallScore Reports" + "WebBuilder"): lo extrae a un dir temporal y corre
 * `convertBallstatFolder` (conv-ballstat.ts) que parsea los .box.txt (juegos)
 * y las páginas de jugador de WebBuilder (logs juego a juego con nombre
 * completo — resuelven la ambigüedad de apellidos de los reportes).
 *
 * Los .sbk son ZIP con `current.sb` binario propietario: se detectan y se
 * reporta claramente que la jugada a jugada aún no se decodifica.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createExtractorFromData } from 'node-unrar-js';
import { convertBallstatFolder } from '../conv-ballstat.js';
import type { PoxFile } from './pox.js';

export function detectBallstat(fileName: string, text: string): boolean {
  const n = fileName.toLowerCase();
  if (isBallstatPackage(n) || n.endsWith('.sbk') || n.endsWith('.ros')) return true;
  const head = text.slice(0, 2000).toLowerCase();
  return head.includes('ballscore') || head.includes('ballstat');
}

/** ¿el archivo es un paquete de liga extraíble? */
export function isBallstatPackage(fileName: string): boolean {
  return /\.(rar|zip)$/i.test(fileName);
}

/** Localiza la raíz de la liga dentro del árbol extraído. */
function findLeagueRoot(dir: string, depth = 0): string | null {
  if (depth > 4) return null;
  try {
    // "BallScore Reports" basta: sin WebBuilder el conversor cae al modo
    // apellidos (fichas sintéticas desde las líneas .cmp.txt)
    if (fs.existsSync(path.join(dir, 'BallScore Reports'))) return dir;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { const r = findLeagueRoot(path.join(dir, e.name), depth + 1); if (r) return r; }
    }
  } catch { /* permisos/encoding de nombres */ }
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

/**
 * Convierte un paquete BallStat (.rar/.zip de la carpeta de liga) a PoxFile.
 * Devuelve también las advertencias del conversor (juegos sintetizados, etc.).
 */
export async function convertBallstatPackage(fileName: string, buf: Buffer): Promise<{ file: PoxFile; warnings: string[] }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pox-bs-'));
  try {
    if (/\.rar$/i.test(fileName)) await extractRar(buf, tmp);
    else new AdmZip(buf).extractAllTo(tmp, true);

    const root = findLeagueRoot(tmp);
    if (!root) {
      throw Object.assign(new Error(
        'paquete BallStat sin datos reconocibles: debe contener la carpeta "BallScore Reports" ' +
        '(en BallStat: League → Generate → Web Pages / Text Reports). Los .sbk sueltos no se pueden leer todavía.',
      ), { status: 422 });
    }
    const r = convertBallstatFolder(root);
    return { file: r.pox as unknown as PoxFile, warnings: r.warnings };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** .sbk/.ros sueltos: todavía no hay parser del binario current.sb */
export function convertBallstat(fileName: string, _text: string): PoxFile {
  if (fileName.toLowerCase().endsWith('.sbk')) {
    throw Object.assign(
      new Error('.sbk es un scorebook binario propietario — sube el paquete de liga completo (.rar/.zip con BallScore Reports + WebBuilder)'),
      { status: 501 },
    );
  }
  throw Object.assign(
    new Error('formato BallStat no soportado aún — usa el .rar/.zip de la carpeta de liga completa'),
    { status: 501 },
  );
}
