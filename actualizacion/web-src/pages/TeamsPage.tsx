import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, League, Team } from '../api';

export default function TeamsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [leagues, setLeagues] = useState<League[]>([]);
  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [color, setColor] = useState('#1e3a5f');
  const [leagueId, setLeagueId] = useState('');
  const [error, setError] = useState('');

  const load = () => {
    api.teams().then(setTeams).catch((e) => setError(e.message));
    api.leagues().then(setLeagues).catch(() => {});
  };
  useEffect(() => { void load(); }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await api.createTeam({ name: name.trim(), shortName: shortName.trim() || undefined, color, leagueId: leagueId || null });
    setName(''); setShortName(''); setColor('#1e3a5f'); setLeagueId('');
    load();
  };

  return (
    <div>
      <h1>Equipos</h1>
      {error && <p className="pill sched">{error}</p>}
      <div className="card">
        <form className="row" onSubmit={create}>
          <input placeholder="Nombre del equipo" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Abrev. (ej. TIG)" value={shortName} onChange={(e) => setShortName(e.target.value)} style={{ width: 110 }} />
          <label className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.8rem' }}>
            Color
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Color del equipo (hoja de anotación, sitio web)" />
          </label>
          <select value={leagueId} onChange={(e) => setLeagueId(e.target.value)} title="Liga/torneo">
            <option value="">Sin liga</option>
            {leagues.map((l) => <option key={l.id} value={l.id}>{l.name} {l.year}</option>)}
          </select>
          <button type="submit">Crear equipo</button>
        </form>
      </div>
      {/* equipos agrupados por liga — cada liga su tarjeta; los sueltos al final */}
      {(() => {
        const ligaGroups = leagues
          .map((l) => ({ league: l, ts: teams.filter((t) => t.leagueId === l.id) }))
          .filter((g) => g.ts.length > 0);
        const sueltos = teams.filter((t) => !t.leagueId || !leagues.some((l) => l.id === t.leagueId));
        const groups: { title: React.ReactNode; ts: Team[] }[] = [
          ...ligaGroups.map((g) => ({
            title: <Link to={`/leagues/${g.league.id}`}>{g.league.name} {g.league.year ?? ''}</Link>,
            ts: g.ts,
          })),
          ...(sueltos.length ? [{ title: 'Sin liga', ts: sueltos }] : []),
        ];
        if (!groups.length) return <div className="card"><p className="muted">Sin equipos aún</p></div>;
        return groups.map((g, gi) => (
          <div className="card" key={gi}>
            <h2 style={{ marginTop: 0 }}>{g.title}</h2>
            <table>
              <thead><tr><th>Equipo</th><th>Abrev.</th><th>Color</th><th>Jugadores</th><th /></tr></thead>
              <tbody>
                {g.ts.map((t) => (
                  <tr key={t.id}>
                    <td><Link to={`/teams/${t.id}`}>{t.name}</Link></td>
                    <td>{t.shortName}</td>
                    <td>
                      <input
                        type="color" value={t.color ?? '#1e3a5f'} title="Color del equipo (hoja de anotación, sitio web)"
                        onChange={async (e) => { await api.updateTeam(t.id, { color: e.target.value }); load(); }}
                      />
                    </td>
                    <td>{t._count?.players ?? 0}</td>
                    <td><Link to={`/teams/${t.id}`}>Roster →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ));
      })()}
    </div>
  );
}
