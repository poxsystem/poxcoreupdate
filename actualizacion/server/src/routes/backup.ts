import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../prisma.js';
import { adminOk } from '../auth.js';
import { ALL_TABLES, exportAll, exportLeague, backupDir, autoBackup, importBackup, previewBackupLeagues, restoreLeagueFromBackup } from '../backup-lib.js';

const r = Router();

/**
 * GET /backup/export — respaldo completo de la base (todas las ligas).
 * GET /backup/export?league=<id> — respaldo de una sola liga (equipos, jugadores,
 * juegos, jugadas, temporadas, series de playoff y acumulados de temporada).
 */
r.get('/export', async (req, res) => {
  const leagueId = req.query.league ? String(req.query.league) : null;
  const stamp = new Date().toISOString().slice(0, 10);

  if (!leagueId) {
    res.setHeader('Content-Disposition', `attachment; filename="poxscore-backup-${stamp}.json"`);
    return res.json(await exportAll());
  }
  const data = await exportLeague(leagueId);
  if (!data) return res.status(404).json({ error: 'Liga no encontrada' });
  const safe = (data.leagues[0] as { name: string }).name.replace(/[^\wáéíóúñü -]+/gi, '').trim().replace(/\s+/g, '-');
  res.setHeader('Content-Disposition', `attachment; filename="poxscore-${safe}-${stamp}.json"`);
  res.json(data);
});

/**
 * POST /backup/import — restaura un respaldo JSON (v1 o v2).
 * Inserta omitiendo duplicados por id — seguro correrlo más de una vez.
 */
r.post('/import', async (req, res) => {
  const { imported } = await importBackup(req.body as Record<string, unknown>);
  res.json({ ok: true, imported });
});

/**
 * GET /backup/auto — estado del respaldo automático (carpeta + últimos archivos).
 * POST /backup/auto — fuerza un respaldo ahora.
 */
r.get('/auto', (_req, res) => {
  const dir = backupDir();
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse()
    : [];
  res.json({ dir, files: files.slice(0, 30) });
});

r.post('/auto', async (_req, res) => {
  await autoBackup('manual');
  const dir = backupDir();
  res.json({ ok: true, dir, files: fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse() });
});

// ─── Restaurar UNA liga desde un auto-*.json (modal «🕐 Restaurar») ──────────
const backupFile = (name: unknown): string | null => {
  const safe = path.basename(String(name ?? ''));
  if (!safe.endsWith('.json') || safe !== String(name ?? '').trim()) return null;
  const fp = path.join(backupDir(), safe);
  return fs.existsSync(fp) ? fp : null;
};

/** POST /backup/restore-preview {file} — ligas que trae el respaldo con conteos. */
r.post('/restore-preview', async (req, res) => {
  const fp = backupFile(req.body?.file);
  if (!fp) return res.status(404).json({ error: 'Respaldo no encontrado en la carpeta de respaldos' });
  const b = JSON.parse(fs.readFileSync(fp, 'utf8')) as Record<string, unknown>;
  res.json({ file: path.basename(fp), leagues: previewBackupLeagues(b) });
});

/** POST /backup/restore-scan {league} — escanea TODOS los respaldos y dice en
 *  cuáles está la liga y con qué años/juegos (elige el archivo correcto a la
 *  vista: el de antes del import muestra solo la temporada vigente). */
r.post('/restore-scan', async (req, res) => {
  const name = String(req.body?.league ?? '').trim();
  if (!name) return res.status(400).json({ error: 'falta league' });
  const normL = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const dir = backupDir();
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.startsWith('auto-') && f.endsWith('.json')).sort().reverse()
    : [];
  const out = [];
  for (const f of files) {
    const fp = path.join(dir, f);
    try {
      const b = JSON.parse(fs.readFileSync(fp, 'utf8')) as Record<string, unknown>;
      const info = previewBackupLeagues(b).find((l) => normL(l.name) === normL(name));
      out.push({ file: f, mtime: fs.statSync(fp).mtime, found: !!info, ...(info ?? {}) });
    } catch { out.push({ file: f, found: false }); }
  }
  res.json({ league: name, files: out });
});

/** POST /backup/restore-league {file, league, password} — borra la liga actual y
 *  la reinserta como está en el respaldo (reversible solo por el respaldo que
 *  él mismo hace antes de borrar). */
r.post('/restore-league', async (req, res) => {
  const auth = await adminOk(String(req.body?.password ?? ''));
  if (!auth.ok) return res.status(auth.code ?? 401).json({ error: auth.error });
  const fp = backupFile(req.body?.file);
  if (!fp) return res.status(404).json({ error: 'Respaldo no encontrado en la carpeta de respaldos' });
  const b = JSON.parse(fs.readFileSync(fp, 'utf8')) as Record<string, unknown>;
  const out = await restoreLeagueFromBackup(b, String(req.body?.league ?? ''));
  res.json({ ok: true, ...out });
});

export default r;
