import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import HomePage from './pages/HomePage';
import GamesPage from './pages/GamesPage';
import TeamsPage from './pages/TeamsPage';
import TeamDetailPage from './pages/TeamDetailPage';
import GamePage from './pages/GamePage';
import ScorePage from './pages/ScorePage';
import BackupPage from './pages/BackupPage';
import LeaguesPage from './pages/LeaguesPage';
import LeaguePage from './pages/LeaguePage';
import PlayerPage from './pages/PlayerPage';
import LivePage from './pages/LivePage';
import ReportesPage from './pages/ReportesPage';
import PublicarPage from './pages/PublicarPage';
import MergePage from './pages/MergePage';
import ComparePage from './pages/ComparePage';
import UsersPage from './pages/UsersPage';
import AdminPage from './pages/AdminPage';
import LiveGamePage from './pages/LiveGamePage';
import PlayerSearch from './components/PlayerSearch';
import AuthBar from './components/AuthBar';
import AskModal from './components/AskModal';
import { api } from './api';

/** Pestaña "En Acción" con badge cuando hay juegos LIVE */
function LiveTab() {
  const [count, setCount] = useState(0);
  const loc = useLocation();
  useEffect(() => {
    let alive = true;
    const load = () => api.games()
      .then((gs) => { if (alive) setCount(gs.filter((g) => g.status === 'LIVE').length); })
      .catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [loc.pathname]);
  return (
    <NavLink to="/en-accion">
      En Acción{count > 0 && <span className="pill live" style={{ marginLeft: 6, fontSize: '0.7rem' }}>{count}</span>}
    </NavLink>
  );
}

export default function App() {
  const loc = useLocation();
  const [showAsk, setShowAsk] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false); // menu lateral
  useEffect(() => { setMenuOpen(false); }, [loc.pathname]); // 🤖 asistente de consultas (módulo IA)
  // vistas públicas/de transmisión van sin menú ni pie — pantalla flotante limpia
  const bare = loc.pathname.startsWith('/en-vivo');
  return (
    <div className="app">
      {!bare && menuOpen && <>
        <div className="side-overlay" onClick={() => setMenuOpen(false)} />
        <aside className="side-menu">
          <div className="side-menu-head">
            <span className="side-brand">⚾ PoxScore</span>
            <button className="side-close" title="Cerrar" onClick={() => setMenuOpen(false)}>✕</button>
          </div>
          <nav className="side-nav">
            <NavLink to="/leagues">🏆 Ligas</NavLink>
            <NavLink to="/teams">🛡️ Equipos</NavLink>
            <NavLink to="/fusionar">🔀 Fusionar</NavLink>
            <NavLink to="/comparar">⚖️ Comparar</NavLink>
            <NavLink to="/juegos">🎮 Juegos</NavLink>
            <NavLink to="/reportes">📊 Reportes</NavLink>
            <NavLink to="/publicar">🌐 Publicar</NavLink>
            <LiveTab />
            <NavLink to="/backup">💾 Respaldo</NavLink>
            <NavLink to="/usuarios">👥 Usuarios</NavLink>
            <NavLink to="/admin">🛡 Administración</NavLink>
          </nav>
        </aside>
      </>}
      {!bare && <header className="topbar">
        <button className="menu-btn" title="Menu" onClick={() => setMenuOpen(true)}>☰</button>
        <NavLink to="/" className="brand" end>⚾ PoxScore</NavLink>
        <div className="topbar-right">
          <PlayerSearch />
          <button className="topbar-ask" title="Pregunta al anotador — consulta stats en dominicano"
            onClick={() => setShowAsk(true)}>🤖</button>
          <AuthBar />
        </div>
      </header>}
      {showAsk && <AskModal onClose={() => setShowAsk(false)} />}
      <main>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/juegos" element={<GamesPage />} />
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/fusionar" element={<MergePage />} />
          <Route path="/teams/:id" element={<TeamDetailPage />} />
          <Route path="/games/:id" element={<GamePage />} />
          <Route path="/games/:id/score" element={<ScorePage />} />
          <Route path="/leagues" element={<LeaguesPage />} />
          <Route path="/leagues/:id" element={<LeaguePage />} />
          <Route path="/players/:id" element={<PlayerPage />} />
          <Route path="/comparar" element={<ComparePage />} />
          <Route path="/usuarios" element={<UsersPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/en-accion" element={<LivePage />} />
          <Route path="/en-vivo/:id" element={<LiveGamePage />} />
          <Route path="/en-vivo/:id/obs" element={<LiveGamePage obs />} />
          <Route path="/reportes" element={<ReportesPage />} />
          <Route path="/publicar" element={<PublicarPage />} />
          <Route path="/backup" element={<BackupPage />} />
        </Routes>
      </main>
      {!bare && <footer className="app-footer">Desarrollado por Alexis Lara · 2026</footer>}
    </div>
  );
}
