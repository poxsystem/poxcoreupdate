import { Router } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { Client as FtpClient } from 'basic-ftp';
import SftpClient from 'ssh2-sftp-client';
import { websiteHtml } from '../website.js';

const r = Router();

// ---- perfiles de servidor (FTP/FTPS/SFTP) — archivo local, no va a la BD ni al respaldo ----
const DATA_DIR = path.join(process.cwd(), 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'ftp-profiles.json');

export interface FtpProfile {
  id: string;
  name: string;
  protocol: 'ftp' | 'ftps' | 'sftp';
  host: string;
  port?: number;
  user: string;
  pass: string;
  remotePath: string; // ej. /public_html/liga
}

async function loadProfiles(): Promise<FtpProfile[]> {
  try { return JSON.parse(await fs.readFile(PROFILES_FILE, 'utf8')); } catch { return []; }
}
async function saveProfiles(list: FtpProfile[]) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(PROFILES_FILE, JSON.stringify(list, null, 2));
}

const publicProfile = (p: FtpProfile) => ({ ...p, pass: p.pass ? '••••••' : '' });

export interface RemoteEntry { name: string; size: number; isDir: boolean; modifiedAt?: string }

// ---- conexión unificada FTP/FTPS/SFTP — con log estilo FileZilla ----
async function withConn<T>(
  p: FtpProfile,
  log: string[] | undefined,
  fn: (up: (name: string, buf: Buffer) => Promise<void>, list: (dir?: string) => Promise<RemoteEntry[]>) => Promise<T>,
): Promise<T> {
  const say = (m: string) => { log?.push(m); };
  const port = p.port ?? (p.protocol === 'sftp' ? 22 : 21);
  say(`Conectando a ${p.host}:${port} (${p.protocol.toUpperCase()})…`);
  if (p.protocol === 'sftp') {
    const s = new SftpClient();
    s.on('debug', (m: string) => { const x = String(m).trim(); if (x) say(`SFTP: ${x.slice(0, 200)}`); });
    await s.connect({
      host: p.host, port, username: p.user, password: p.pass,
      readyTimeout: 15000,
      debug: (m: string) => { const x = String(m).trim(); if (x) say(`SSH: ${x.slice(0, 200)}`); },
    });
    say('Conexión SSH establecida — sesión SFTP iniciada');
    try {
      const norm = (dir: string, l: { name: string; size: number; modifyTime: number; type: string }[]) =>
        l.map((f) => ({ name: f.name, size: f.size, isDir: f.type === 'd', modifiedAt: f.modifyTime ? new Date(f.modifyTime).toISOString() : undefined }));
      return await fn(
        async (name, buf) => {
          const remote = `${p.remotePath.replace(/\/$/, '')}/${name}`;
          const dir = path.posix.dirname(remote);
          if (!(await s.exists(dir))) { say(`MKD ${dir}`); await s.mkdir(dir, true); }
          say(`PUT ${name} (${buf.length} bytes)`);
          await s.put(buf, remote);
        },
        async (dir) => norm(dir ?? (p.remotePath || '.'), await s.list(dir ?? (p.remotePath || '.'))),
      );
    } finally { say('Cerrando conexión'); await s.end(); }
  }
  const ftp = new FtpClient(12000);
  // canal del protocolo → cada línea del servidor/comando cae al log
  ftp.ftp.log = (m: string) => { const x = m.trim(); if (x && !/^PASS /i.test(x)) say(x); else if (x) say('PASS ******'); };
  await ftp.access({
    host: p.host, port, user: p.user, password: p.pass,
    secure: p.protocol === 'ftps',
  });
  say(`Sesión iniciada — usuario ${p.user}`);
  try {
    return await fn(
      async (name, buf) => {
        const dir = p.remotePath.replace(/\/$/, '');
        if (dir) { say(`CWD ${dir}`); await ftp.ensureDir(dir); }
        else { say('CWD /'); await ftp.cd('/'); }
        say(`STOR ${name} (${buf.length} bytes)`);
        await ftp.uploadFrom(Readable.from(buf), name);
      },
      async (dir) => {
        const l = await ftp.list(dir ?? (p.remotePath || undefined));
        return l.map((f) => ({ name: f.name, size: f.size, isDir: f.isDirectory, modifiedAt: f.modifiedAt?.toISOString() }));
      },
    );
  } finally { say('QUIT — conexión cerrada'); ftp.close(); }
}

// ---- CRUD de perfiles ----
r.get('/profiles', async (_req, res) => {
  res.json((await loadProfiles()).map(publicProfile));
});

r.post('/profiles', async (req, res) => {
  const b = req.body as Partial<FtpProfile>;
  if (!b.name || !b.host || !b.user) return res.status(400).json({ error: 'name, host y user requeridos' });
  const list = await loadProfiles();
  if (b.id) {
    const i = list.findIndex((p) => p.id === b.id);
    if (i < 0) return res.status(404).json({ error: 'Perfil no existe' });
    list[i] = {
      ...list[i], name: b.name, host: b.host, user: b.user,
      protocol: (b.protocol as FtpProfile['protocol']) ?? 'ftp',
      port: b.port, remotePath: b.remotePath ?? '/',
      pass: b.pass && b.pass !== '••••••' ? b.pass : list[i].pass, // no enviar pass = conservar
    };
    await saveProfiles(list);
    return res.json(publicProfile(list[i]));
  }
  const p: FtpProfile = {
    id: `ftp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: b.name, host: b.host, user: b.user, pass: b.pass ?? '',
    protocol: (b.protocol as FtpProfile['protocol']) ?? 'ftp',
    port: b.port, remotePath: b.remotePath ?? '/',
  };
  list.push(p);
  await saveProfiles(list);
  res.json(publicProfile(p));
});

r.delete('/profiles/:id', async (req, res) => {
  const list = await loadProfiles();
  await saveProfiles(list.filter((p) => p.id !== req.params.id));
  res.json({ ok: true });
});

/** POST /test — prueba la conexión (perfil guardado o datos sueltos) */
r.post('/test', async (req, res) => {
  const p = await resolveProfile(req.body);
  if (!p) return res.status(400).json({ error: 'Perfil o datos de conexión requeridos' });
  const log: string[] = [];
  try {
    const files = await withConn(p, log, (_up, list) => list());
    res.json({ ok: true, files: files.length, log });
  } catch (e) {
    res.status(502).json({ ok: false, error: e instanceof Error ? e.message : 'No conectó', log });
  }
});

/** POST /connect — conexión estilo FileZilla: log del protocolo + listado del directorio remoto */
r.post('/connect', async (req, res) => {
  const p = await resolveProfile(req.body);
  if (!p) return res.status(400).json({ error: 'Perfil o datos de conexión requeridos' });
  const log: string[] = [];
  try {
    const files = await withConn(p, log, (_up, list) => list());
    res.json({ ok: true, path: p.remotePath || '/', files, log });
  } catch (e) {
    res.status(502).json({ ok: false, error: e instanceof Error ? e.message : 'No conectó', log });
  }
});

/** POST /upload — sube archivos: {profileId, files:[{name,content(base64|texto)}]} */
r.post('/upload', async (req, res) => {
  const { profileId, files } = req.body as { profileId?: string; files?: { name: string; content: string; base64?: boolean }[] };
  const p = await resolveProfile(req.body);
  if (!p) return res.status(400).json({ error: 'Perfil requerido' });
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'files[] requerido' });
  const log: string[] = [];
  try {
    const uploaded = await withConn(p, log, async (up) => {
      const names: string[] = [];
      for (const f of files) {
        const buf = f.base64 ? Buffer.from(f.content, 'base64') : Buffer.from(f.content, 'utf8');
        await up(f.name, buf);
        names.push(f.name);
      }
      return names;
    });
    res.json({ ok: true, uploaded, log });
  } catch (e) {
    res.status(502).json({ ok: false, error: e instanceof Error ? e.message : 'Falló la subida', log });
  }
});

/** POST /publish-league — genera el website de la liga y lo sube como index.html */
r.post('/publish-league', async (req, res) => {
  const { profileId, leagueId } = req.body as { profileId?: string; leagueId?: string };
  if (!leagueId) return res.status(400).json({ error: 'leagueId requerido' });
  const p = await resolveProfile({ profileId });
  if (!p) return res.status(400).json({ error: 'profileId requerido' });
  const html = await websiteHtml(leagueId);
  if (!html) return res.status(404).json({ error: 'Liga no encontrada' });
  const log: string[] = [];
  try {
    await withConn(p, log, async (up) => { await up('index.html', Buffer.from(html, 'utf8')); });
    res.json({ ok: true, file: 'index.html', bytes: html.length, log });
  } catch (e) {
    res.status(502).json({ ok: false, error: e instanceof Error ? e.message : 'Falló la subida', log });
  }
});

async function resolveProfile(b: Record<string, unknown>): Promise<FtpProfile | null> {
  if (b.profileId) {
    const p = (await loadProfiles()).find((x) => x.id === b.profileId);
    return p ?? null;
  }
  if (b.host && b.user) {
    return {
      id: '', name: '', protocol: (b.protocol as FtpProfile['protocol']) ?? 'ftp',
      host: b.host as string, port: b.port as number | undefined,
      user: b.user as string, pass: (b.pass as string) ?? '', remotePath: (b.remotePath as string) ?? '/',
    };
  }
  return null;
}

export default r;
