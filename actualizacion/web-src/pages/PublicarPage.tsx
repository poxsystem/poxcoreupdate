import { useEffect, useRef, useState } from 'react';
import { api, type FtpProfilePublic, type League, type RemoteEntry } from '../api';

const EMPTY: { name: string; protocol: 'ftp' | 'ftps' | 'sftp'; host: string; port: string; user: string; pass: string; remotePath: string } =
  { name: '', protocol: 'ftp', host: '', port: '', user: '', pass: '', remotePath: '/' };

interface LogLine { t: string; kind: 'cmd' | 'ok' | 'err' | 'info'; text: string }
const now = () => new Date().toLocaleTimeString('es-DO', { hour12: false });

/** Módulo Publicar — réplica del flujo de FileZilla:
 *  barra de conexión rápida → log del protocolo → gestor de sitios + panel remoto. */
export default function PublicarPage() {
  const [profiles, setProfiles] = useState<FtpProfilePublic[]>([]);
  const [leagues, setLeagues] = useState<League[]>([]);
  const [form, setForm] = useState({ ...EMPTY });
  const [editId, setEditId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pubLeague, setPubLeague] = useState<Record<string, string>>({});
  // sesión "conectada" (el listado remoto, como el panel derecho de FileZilla)
  const [conn, setConn] = useState<{ label: string; path: string; files: RemoteEntry[] } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const load = () => api.ftpProfiles().then(setProfiles).catch(() => {});
  useEffect(() => {
    load();
    api.leagues().then(setLeagues).catch(() => {});
  }, []);
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [logs]);

  const say = (kind: LogLine['kind'], text: string) => setLogs((s) => [...s.slice(-300), { t: now(), kind, text }]);
  const sayAll = (lines?: string[]) => (lines ?? []).forEach((l) => say(
    /error|fall|refus|timed|denied|530|ECONN/i.test(l) ? 'err' : /^(CWD|STOR|PUT|LIST|MKD|PASV|QUIT)/i.test(l) ? 'cmd' : 'info', l));

  const save = async () => {
    setBusy('save');
    try {
      await api.saveFtpProfile({ ...form, id: editId ?? undefined, port: form.port ? Number(form.port) : undefined });
      setForm({ ...EMPTY }); setEditId(null); load();
      say('ok', editId ? 'Perfil actualizado' : `Sitio "${form.name}" guardado en el gestor`);
    } catch (e) { say('err', e instanceof Error ? e.message : 'Error'); }
    finally { setBusy(null); }
  };

  const edit = (p: FtpProfilePublic) => {
    setEditId(p.id);
    setForm({ name: p.name, protocol: p.protocol, host: p.host, port: p.port ? String(p.port) : '', user: p.user, pass: '', remotePath: p.remotePath });
    say('info', `Editando "${p.name}" — la clave queda igual si la dejas vacía`);
  };

  /** Conectar = probar + listar el directorio remoto (panel derecho) */
  const connect = async (src: { profileId?: string } | (Partial<FtpProfilePublic> & { pass?: string }), label: string) => {
    setBusy('conn'); setConn(null);
    say('info', `── ${label} ──`);
    try {
      const r = await api.connectFtp(src);
      sayAll(r.log);
      if (r.ok) {
        setConn({ label, path: r.path ?? '/', files: r.files ?? [] });
        say('ok', `Conectado — ${(r.files ?? []).length} elemento(s) en ${r.path}`);
      } else say('err', r.error ?? 'No conectó');
    } catch (e) { say('err', e instanceof Error ? e.message : 'Error de conexión'); }
    finally { setBusy(null); }
  };

  const publish = async (p: FtpProfilePublic) => {
    const leagueId = pubLeague[p.id];
    if (!leagueId) { say('err', 'Elige la liga a publicar en el selector del sitio'); return; }
    setBusy(`pub-${p.id}`);
    say('info', `── Publicando sitio en "${p.name}" ──`);
    try {
      const r = await api.publishLeague(p.id, leagueId);
      sayAll(r.log);
      if (r.ok) say('ok', `✓ Sitio publicado — index.html (${Math.round((r.bytes ?? 0) / 1024)} KB) en ${p.remotePath}`);
      else say('err', r.error ?? 'Falló la subida');
    } catch (e) { say('err', e instanceof Error ? e.message : 'Error'); }
    finally { setBusy(null); }
  };

  const del = async (p: FtpProfilePublic) => {
    if (!confirm(`¿Borrar el sitio "${p.name}" del gestor?`)) return;
    await api.deleteFtpProfile(p.id); load();
    say('info', `Sitio "${p.name}" eliminado`);
  };

  const F = (k: keyof typeof form, v: string) => setForm((s) => ({ ...s, [k]: v }));
  const fmtSize = (n: number) => n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;

  return (
    <div className="page fz">
      <h1 style={{ marginBottom: 2 }}>☁ Publicar en servidor</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Conexión FTP / FTPS / SFTP estilo FileZilla — sube los sitios generados de cada liga.
        Los perfiles se guardan solo en este equipo (<code>server/data/ftp-profiles.json</code>).
      </p>

      {/* ===== Barra de conexión rápida (Quickconnect) ===== */}
      <div className="fz-quick">
        <select value={form.protocol} onChange={(e) => F('protocol', e.target.value)} title="Protocolo" style={{ width: 92 }}>
          <option value="ftp">FTP</option>
          <option value="ftps">FTPS</option>
          <option value="sftp">SFTP</option>
        </select>
        <input value={form.host} onChange={(e) => F('host', e.target.value)} placeholder="Servidor (ftp.misitio.com)" style={{ flex: 2, minWidth: 150 }} />
        <input value={form.user} onChange={(e) => F('user', e.target.value)} placeholder="Usuario" style={{ flex: 1, minWidth: 100 }} />
        <input type="password" value={form.pass} onChange={(e) => F('pass', e.target.value)} placeholder="Clave" style={{ flex: 1, minWidth: 100 }} />
        <input value={form.port} onChange={(e) => F('port', e.target.value)} placeholder={form.protocol === 'sftp' ? '22' : '21'} style={{ width: 62 }} title="Puerto" />
        <input value={form.remotePath} onChange={(e) => F('remotePath', e.target.value)} placeholder="/carpeta/remota" style={{ flex: 1, minWidth: 110 }} title="Carpeta remota" />
        <button className="big" disabled={busy === 'conn' || !form.host || !form.user}
          onClick={() => connect({ ...form, port: form.port ? Number(form.port) : undefined } as never, `Conexión rápida → ${form.host}`)}>
          {busy === 'conn' ? 'Conectando…' : '⚡ Conectar'}
        </button>
      </div>

      {/* ===== Log del protocolo ===== */}
      <div className="fz-log" ref={logRef}>
        {logs.length === 0 && <div className="fz-line info"><span className="fz-t">--:--:--</span> El registro de conexiones aparece aquí — como el panel superior de FileZilla.</div>}
        {logs.map((l, i) => (
          <div key={i} className={`fz-line ${l.kind}`}><span className="fz-t">{l.t}</span> {l.text}</div>
        ))}
      </div>

      <div className="fz-panes">
        {/* ===== Gestor de sitios (panel izquierdo) ===== */}
        <div className="card fz-pane">
          <h3 style={{ marginTop: 0 }}>Gestor de sitios</h3>
          <div className="report-grid" style={{ marginBottom: '0.7rem' }}>
            <label>Nombre del sitio<input value={form.name} onChange={(e) => F('name', e.target.value)} placeholder="Mi hosting" /></label>
          </div>
          <div className="row" style={{ gap: '0.4rem' }}>
            <button onClick={save} disabled={busy === 'save' || !form.name || !form.host || !form.user}>
              💾 {editId ? 'Guardar cambios' : 'Guardar sitio'}
            </button>
            {editId && <button className="secondary" onClick={() => { setEditId(null); setForm({ ...EMPTY }); }}>Cancelar</button>}
          </div>
          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '0.9rem 0' }} />
          {!profiles.length && <p className="muted">Sin sitios guardados — llena la barra de arriba, asigna un nombre y «Guardar sitio».</p>}
          {profiles.map((p) => (
            <div key={p.id} className="fz-site">
              <div className="fz-site-head">
                <strong>{p.name}</strong>
                <span className="muted">{p.protocol.toUpperCase()} · {p.user}@{p.host}{p.port ? `:${p.port}` : ''}</span>
              </div>
              <div className="muted" style={{ fontSize: '0.78rem' }}>📁 {p.remotePath}</div>
              <div className="row" style={{ gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
                <button className="secondary sm" disabled={busy === 'conn'} onClick={() => connect({ profileId: p.id }, `Conectando a "${p.name}"`)}>⚡ Conectar</button>
                <select value={pubLeague[p.id] ?? ''} onChange={(e) => setPubLeague((s) => ({ ...s, [p.id]: e.target.value }))} style={{ fontSize: '0.8rem' }}>
                  <option value="">Liga…</option>
                  {leagues.map((l) => <option key={l.id} value={l.id}>{l.name} {l.year}</option>)}
                </select>
                <button className="secondary sm" disabled={busy === `pub-${p.id}`} onClick={() => publish(p)}>
                  {busy === `pub-${p.id}` ? 'Subiendo…' : '🚀 Publicar'}
                </button>
                <button className="secondary sm" onClick={() => edit(p)}>✏️</button>
                <button className="secondary sm" onClick={() => del(p)}>🗑</button>
              </div>
            </div>
          ))}
        </div>

        {/* ===== Sitio remoto (panel derecho) ===== */}
        <div className="card fz-pane">
          <h3 style={{ marginTop: 0 }}>🗂 Sitio remoto {conn ? `— ${conn.path}` : ''}</h3>
          {!conn && <p className="muted">Sin conexión. Usa «⚡ Conectar» en la barra o en un sitio guardado para listar los archivos remotos aquí.</p>}
          {conn && (
            <>
              <p className="muted" style={{ fontSize: '0.82rem' }}>{conn.label} · {conn.files.length} elemento(s)</p>
              <table className="fz-files">
                <thead><tr><th>Nombre</th><th style={{ textAlign: 'right' }}>Tamaño</th><th>Modificado</th></tr></thead>
                <tbody>
                  {conn.files.map((f) => (
                    <tr key={f.name}>
                      <td>{f.isDir ? '📁' : '📄'} {f.name}</td>
                      <td style={{ textAlign: 'right' }}>{f.isDir ? '—' : fmtSize(f.size)}</td>
                      <td className="muted">{f.modifiedAt ? new Date(f.modifiedAt).toLocaleDateString() : ''}</td>
                    </tr>
                  ))}
                  {!conn.files.length && <tr><td colSpan={3} className="muted">(carpeta vacía)</td></tr>}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
