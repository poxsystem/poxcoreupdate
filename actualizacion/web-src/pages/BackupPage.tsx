import { useEffect, useRef, useState } from 'react';
import { api, League, getToken } from '../api';

export default function BackupPage() {
  const [msg, setMsg] = useState('');
  const [leagues, setLeagues] = useState<League[]>([]);
  const [leagueId, setLeagueId] = useState('');
  const [auto, setAuto] = useState<{ dir: string; files: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const authH = () => ({ Authorization: `Bearer ${getToken()}` });
  const loadAuto = () => fetch('/api/backup/auto', { headers: authH() })
    .then((r) => r.json()).then(setAuto).catch(() => {});
  useEffect(() => { api.leagues().then(setLeagues).catch(() => {}); loadAuto(); }, []);

  const download = () => { window.location.href = '/api/backup/export'; };
  const downloadLeague = () => { window.location.href = `/api/backup/export?league=${leagueId}`; };

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const json = JSON.parse(await file.text());
    const res = await fetch('/api/backup/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authH() }, body: JSON.stringify(json),
    });
    const data = await res.json();
    setMsg(res.ok ? `Importado: ${JSON.stringify(data.imported)}` : `Error: ${data.error}`);
  };

  return (
    <div>
      <h1>Respaldo</h1>
      <div className="card">
        <h2>Exportar todo</h2>
        <p className="muted">
          Descarga la base completa como JSON: ligas, temporadas, equipos, jugadores,
          juegos, jugadas, series de playoff y acumulados de temporada.
        </p>
        <button onClick={download}>Descargar respaldo completo</button>
      </div>
      <div className="card">
        <h2>Exportar una liga</h2>
        <p className="muted">
          Solo esa liga: sus temporadas, equipos, jugadores, juegos, jugadas, playoffs y stats acumulados.
        </p>
        <div className="row">
          <select value={leagueId} onChange={(e) => setLeagueId(e.target.value)}>
            <option value="">Elegir liga…</option>
            {leagues.map((l) => <option key={l.id} value={l.id}>{l.name} {l.year}</option>)}
          </select>
          <button onClick={downloadLeague} disabled={!leagueId}>Descargar liga</button>
        </div>
      </div>
      <div className="card">
        <h2>Importar</h2>
        <p className="muted">Restaura un respaldo JSON (completo o de una liga). Los registros existentes (mismo id) se omiten.</p>
        <div className="row">
          <input type="file" accept=".json" ref={fileRef} />
          <button onClick={upload}>Importar</button>
        </div>
        {msg && <p>{msg}</p>}
      </div>
      <div className="card">
        <h2>Respaldo automático</h2>
        <p className="muted">
          El servidor respalda solo: al arrancar, cada 6 horas y cada vez que cierra un juego.
          Guarda en <code>{auto?.dir ?? 'backups/'}</code> y conserva los últimos 30.
        </p>
        <div className="row">
          <button className="secondary" onClick={async () => {
            await fetch('/api/backup/auto', { method: 'POST', headers: authH() });
            loadAuto();
          }}>⬇ Respaldar ahora</button>
        </div>
        {auto && auto.files.length > 0 && (
          <ul className="muted" style={{ fontSize: '0.82rem', marginTop: '0.5rem' }}>
            {auto.files.slice(0, 8).map((f) => <li key={f}>{f}</li>)}
            {auto.files.length > 8 && <li>…y {auto.files.length - 8} más</li>}
          </ul>
        )}
      </div>
      <div className="card">
        <h2>Respaldo de MySQL</h2>
        <p className="muted">
          Para un respaldo a nivel de base de datos, ejecuta el script{' '}
          <code>scripts/backup.ps1</code> (usa <code>mysqldump</code> y guarda en <code>backups/</code>).
        </p>
      </div>
    </div>
  );
}
