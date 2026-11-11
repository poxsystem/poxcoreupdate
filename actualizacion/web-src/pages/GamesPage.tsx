import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Game, League, Team } from '../api';

function StatusPill({ status }: { status: string }) {
  const cls = status === 'LIVE' ? 'live' : status === 'FINAL' || status === 'FORFEIT' ? 'final' : 'sched';
  const label = status === 'LIVE' ? 'EN VIVO' : status === 'FINAL' ? 'FINAL'
    : status === 'FORFEIT' ? 'FORFEIT' : status === 'SUSPENDED' ? 'SUSPENDIDO' : 'PROGRAMADO';
  return <span className={`pill ${cls}`}>{label}</span>;
}

export default function GamesPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [leagues, setLeagues] = useState<League[]>([]);
  const [leagueId, setLeagueId] = useState('');
  const [away, setAway] = useState('');
  const [home, setHome] = useState('');
  const [sport, setSport] = useState<'baseball' | 'softball'>('baseball');
  const [innings, setInnings] = useState(9);
  // fecha por defecto = hoy (sistema) — el anotador la cambia para juegos atrasados
  const [date, setDate] = useState(() => {
    const d = new Date(); // LOCAL — toISOString da UTC y retrocede 1 día en UTC-4
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [ghostRunner, setGhostRunner] = useState(false);
  const [error, setError] = useState('');

  const load = () => {
    api.games().then(setGames).catch((e) => setError(e.message));
    api.teams().then(setTeams).catch(() => {});
    api.leagues().then(setLeagues).catch(() => {});
  };
  useEffect(load, []);

  // equipos elegibles: si hay liga elegida, solo los de esa liga
  const eligible = leagueId ? teams.filter((t) => t.leagueId === leagueId) : teams;

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!away || !home || away === home) { setError('Elige dos equipos distintos'); return; }
    const g = await api.createGame({ awayTeamId: away, homeTeamId: home, innings, sport, ghostRunner, leagueId: leagueId || undefined, date: date || undefined });
    window.location.href = `/games/${g.id}`;
  };

  return (
    <div>
      <h1>Juegos</h1>
      {error && <p className="pill sched">{error}</p>}

      <div className="card">
        <h2>Nuevo juego</h2>
        {teams.length < 2
          ? <p className="muted">Necesitas al menos 2 equipos. <Link to="/teams">Crear equipos →</Link></p>
          : (
            <form className="row" onSubmit={create}>
              <div className="sport-toggle">
                <button type="button" className={sport === 'baseball' ? '' : 'secondary'} onClick={() => { setSport('baseball'); setInnings(9); }}>⚾ Baseball</button>
                <button type="button" className={sport === 'softball' ? '' : 'secondary'} onClick={() => { setSport('softball'); setInnings(7); }}>🥎 Softball</button>
              </div>
              <select value={leagueId} onChange={(e) => { setLeagueId(e.target.value); setAway(''); setHome(''); }} title="Liga del juego">
                <option value="">Sin liga / todos</option>
                {leagues.map((l) => <option key={l.id} value={l.id}>{l.name} {l.year}</option>)}
              </select>
              <label>Visitante
                <select value={away} onChange={(e) => setAway(e.target.value)}>
                  <option value="">—</option>
                  {eligible.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <span>@</span>
              <label>Local
                <select value={home} onChange={(e) => setHome(e.target.value)}>
                  <option value="">—</option>
                  {eligible.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <label>Fecha
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} title="Hoy por defecto — cámbiala para juegos atrasados" />
              </label>
              <label>Entradas
                <input type="number" min={1} max={20} value={innings} onChange={(e) => setInnings(Number(e.target.value))} style={{ width: 65 }} />
              </label>
              <label className="row" style={{ gap: '0.3rem' }} title="En entradas extras cada mitad inicia con corredor en 2ª (el último out)">
                <input type="checkbox" checked={ghostRunner} onChange={(e) => setGhostRunner(e.target.checked)} />
                Corredor fantasma
              </label>
              <button type="submit">Crear</button>
            </form>
          )}
      </div>

      <div className="card">
        <table>
          <thead><tr><th>Fecha</th><th>Juego</th><th>Marcador</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {games.map((g) => (
              <tr key={g.id}>
                <td>{new Date(g.date).toLocaleDateString()}</td>
                <td>
                  <Link to={`/games/${g.id}`}>{g.awayTeam?.shortName ?? g.awayTeam?.name}{g.dhAway ? <sup title={`Juego ${g.dhAway} del equipo este día`} className="muted"> J{g.dhAway}</sup> : null} @ {g.homeTeam?.shortName ?? g.homeTeam?.name}{g.dhHome ? <sup title={`Juego ${g.dhHome} del equipo este día`} className="muted"> J{g.dhHome}</sup> : null}</Link>
                  <span className="muted" style={{ marginLeft: 6 }}>{g.sport === 'softball' ? '🥎' : '⚾'}</span>
                  {g.league && <span className="pill sched" style={{ marginLeft: 6 }}>{g.league.name}</span>}
                </td>
                <td>{g.fScoreAway != null ? `${g.fScoreAway} - ${g.fScoreHome}` : g.state ? `${g.state.score.away} - ${g.state.score.home}` : '—'}</td>
                <td><StatusPill status={g.forfeitBy ? 'FORFEIT' : g.status} /></td>
                <td><Link to={`/games/${g.id}`}>Abrir →</Link></td>
              </tr>
            ))}
            {games.length === 0 && <tr><td colSpan={5} className="muted">Sin juegos aún</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
