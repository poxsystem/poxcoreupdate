import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Game, type League, type Team } from '../api';

interface Item { to: string; icon: string; title: string; desc: string; live?: boolean }
interface Section { title: string; icon: string; items: Item[] }

const SECTIONS: Section[] = [
  {
    title: 'Anotación', icon: '✏️',
    items: [
      { to: '/juegos', icon: '🗓', title: 'Juegos', desc: 'Crear juegos, definir alineaciones, ver marcadores y boxscores' },
      { to: '/en-accion', icon: '🔴', title: 'En acción', desc: 'Juegos en vivo — seguir anotando ahora mismo', live: true },
    ],
  },
  {
    title: 'Organización', icon: '🏟',
    items: [
      { to: '/leagues', icon: '🏆', title: 'Ligas y torneos', desc: 'Standings, calendario, playoffs, rollover de temporada y sitio web' },
      { to: '/teams', icon: '👥', title: 'Equipos y jugadores', desc: 'Rosters, fotos, colores, transferencias y plantillas de alineación' },
    ],
  },
  {
    title: 'Estadísticas', icon: '📊',
    items: [
      { to: '/reportes', icon: '📈', title: 'Suite de reportes', desc: 'Preguntas guiadas: bateo, pitcheo, fildeo, sabermetría, carrera y situaciones' },
    ],
  },
  {
    title: 'Administración', icon: '🛠',
    items: [
      { to: '/publicar', icon: '🚀', title: 'Publicar sitio web', desc: 'Genera y sube el website de la liga por FTP/SFTP' },
      { to: '/backup', icon: '💾', title: 'Respaldo', desc: 'Exporta e importa la base de datos completa' },
    ],
  },
];

/** Pantalla de inicio — launcher de la suite */
export default function HomePage() {
  const [games, setGames] = useState<Game[]>([]);
  const [leagues, setLeagues] = useState<League[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [playerCount, setPlayerCount] = useState(0);

  useEffect(() => {
    api.games().then(setGames).catch(() => {});
    api.leagues().then(setLeagues).catch(() => {});
    api.teams().then(setTeams).catch(() => {});
    api.playerList().then((p) => setPlayerCount(p.length)).catch(() => {});
  }, []);

  const live = games.filter((g) => g.status === 'LIVE');
  const lastFinal = games.filter((g) => g.status === 'FINAL').slice(0, 5);
  const finalCount = games.filter((g) => g.status === 'FINAL').length;

  const item = (it: Item) => (
    <Link key={it.to + it.title} to={it.to} className="home-item">
      <span className="home-item-icon">{it.icon}</span>
      <span className="home-item-body">
        <strong>{it.title}
          {it.live && live.length > 0 && <span className="pill live" style={{ marginLeft: 8 }}>{live.length} en vivo</span>}
        </strong>
        <small>{it.desc}</small>
      </span>
      <span className="home-item-arrow">›</span>
    </Link>
  );

  return (
    <div className="page home-page">
      {/* hero */}
      <div className="home-hero">
        <div className="home-logo">⚾</div>
        <div>
          <h1>PoxScore</h1>
          <p className="muted">Anotación y estadísticas de baseball y softball — hoja de anotación digital, historia completa, reportes y sitio web de la liga.</p>
        </div>
      </div>

      {/* resumen rápido */}
      <div className="home-stats">
        <div><strong>{leagues.length}</strong><span>ligas</span></div>
        <div><strong>{teams.length}</strong><span>equipos</span></div>
        <div><strong>{playerCount}</strong><span>jugadores</span></div>
        <div><strong>{finalCount}</strong><span>juegos</span></div>
        <div className={live.length ? 'hot' : ''}><strong>{live.length}</strong><span>en vivo</span></div>
      </div>

      {/* en vivo ahora */}
      {live.length > 0 && (
        <div className="card home-live">
          <h3 style={{ marginTop: 0 }}>🔴 En juego ahora</h3>
          {live.map((g) => (
            <Link key={g.id} to={`/games/${g.id}/score`} className="home-live-row">
              <strong>{g.awayTeam?.shortName ?? g.awayTeam?.name} {g.state?.score.away ?? 0} — {g.state?.score.home ?? 0} {g.homeTeam?.shortName ?? g.homeTeam?.name}</strong>
              <span className="muted">{g.state ? `${g.state.inning}ª ${g.state.half === 'TOP' ? '▲' : '▼'}` : ''}</span>
            </Link>
          ))}
        </div>
      )}

      {/* launcher por secciones */}
      <div className="home-grid">
        {SECTIONS.map((s) => (
          <div key={s.title} className="card home-section">
            <h3>{s.icon} {s.title}</h3>
            <div className="home-items">{s.items.map(item)}</div>
          </div>
        ))}
      </div>

      {/* últimos resultados */}
      {lastFinal.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Últimos resultados</h3>
          <table className="tbl">
            <tbody>
              {lastFinal.map((g) => (
                <tr key={g.id}>
                  <td className="muted">{String(g.date).slice(0, 10)}</td>
                  <td className="muted">{g.league ? `${g.league.name} ${g.league.year}` : ''}</td>
                  <td>{g.awayTeam?.name}</td>
                  <td>{g.homeTeam?.name}</td>
                  <td><Link to={`/games/${g.id}`}><strong>Ver boxscore</strong></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
