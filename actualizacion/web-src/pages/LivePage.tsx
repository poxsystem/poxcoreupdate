import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Game } from '../api';

/** Juegos LIVE en este momento — la pestaña "En Acción" del menú. */
export default function LivePage() {
  const [live, setLive] = useState<Game[] | null>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    const load = () => api.games()
      .then((gs) => setLive(gs.filter((g) => g.status === 'LIVE')))
      .catch((e) => setErr(e.message));
    load();
    const t = setInterval(load, 15000); // refresca marcadores cada 15s
    return () => clearInterval(t);
  }, []);

  if (err) return <p>{err}</p>;
  if (!live) return <p>Cargando…</p>;

  return (
    <div>
      <h1>🔴 En Acción</h1>
      {!live.length && (
        <div className="card">
          <p className="muted">No hay juegos en vivo ahora mismo.</p>
          <p><Link to="/juegos">Ver todos los juegos →</Link> · <Link to="/leagues">Programar desde una liga →</Link></p>
        </div>
      )}
      {live.map((g) => (
        <div className="card" key={g.id}>
          <div className="row" style={{ alignItems: 'baseline' }}>
            <h2 style={{ margin: 0 }}>
              {g.awayTeam?.name} <strong>{g.state?.score?.away ?? 0}</strong>
              {' @ '}
              {g.homeTeam?.name} <strong>{g.state?.score?.home ?? 0}</strong>
            </h2>
            <span className="pill live">EN VIVO</span>
            <span className="muted">
              {g.state ? `${g.state.inning}ª ${g.state.half === 'TOP' ? 'alta' : 'baja'}` : ''}
              {g.stadium ? ` · ${g.stadium}` : ''}
              {g.league ? ` · ${g.league.name}` : ''}
            </span>
            <span className="spacer" />
            <Link to={`/games/${g.id}/score`}><button>📋 Seguir anotando →</button></Link>
            <Link to={`/en-vivo/${g.id}`} target="_blank" className="secondary no-print" style={{ textDecoration: 'none' }}>👁 En vivo</Link>
            <button className="secondary icon" title="Copiar dirección del scorebug para OBS"
              onClick={() => {
                navigator.clipboard?.writeText(`${location.origin}/en-vivo/${g.id}/obs`).catch(() => {});
                setCopied(g.id);
              }}>📺</button>
            <Link to={`/games/${g.id}`} className="secondary no-print" style={{ textDecoration: 'none' }}>Ver</Link>
          </div>
          <p className="muted" style={{ margin: '0.3rem 0 0' }}>
            Outs: {g.state?.outs ?? 0} · Batea: {g.state?.half === 'TOP' ? g.awayTeam?.shortName ?? g.awayTeam?.name : g.homeTeam?.shortName ?? g.homeTeam?.name}
          </p>
          {copied === g.id && <p className="muted" style={{ margin: '0.2rem 0 0', fontSize: '0.75rem' }}>Scorebug OBS copiado: <code>{`${location.origin}/en-vivo/${g.id}/obs`}</code></p>}
        </div>
      ))}
    </div>
  );
}
