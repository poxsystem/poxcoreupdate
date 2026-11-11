import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Game, type League, type Player, type Team } from '../api';
import { PassModal } from '../components/PassModal';
import AdminGameEdit from '../components/AdminGameEdit';
import AdminBoxImport from '../components/AdminBoxImport';

type TeamWithPlayers = Team & { players?: Player[] };
type Pending = { kind: 'league' | 'team' | 'player' | 'game'; id: string; teamId?: string; label: string } | null;

/** Administración de ligas — solo admin: borrar con clave y bloquear publicación. */
export default function AdminPage() {
  const [me, setMe] = useState<{ role: string } | null | undefined>(undefined);
  const [authOn, setAuthOn] = useState(false); // sin usuarios = modo abierto → /admin libre
  const [leagues, setLeagues] = useState<League[]>([]);
  const [sel, setSel] = useState<string>('');
  const [league, setLeague] = useState<League | null>(null);
  const [teams, setTeams] = useState<TeamWithPlayers[]>([]);
  const [tab, setTab] = useState<'equipos' | 'jugadores' | 'juegos' | 'liga' | 'importar'>('equipos');
  const [selTeam, setSelTeam] = useState<string>(''); // drill-down: navegar DENTRO del módulo
  const [pending, setPending] = useState<Pending>(null);
  const [editGame, setEditGame] = useState<string | null>(null); // juego abierto en el editor
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const loadLeagues = useCallback(() => {
    api.leagues().then((ls) => {
      setLeagues(ls);
      if (!sel && ls.length) setSel(ls[0].id);
    }).catch(() => setLeagues([]));
  }, [sel]);

  const load = useCallback(async () => {
    if (!sel) { setLeague(null); setTeams([]); return; }
    const lg = await api.league(sel);
    setLeague(lg);
    const ts = lg.teams ?? [];
    const full = await Promise.all(ts.map((t) => api.team(t.id).catch(() => t as TeamWithPlayers)));
    setTeams(full);
  }, [sel]);

  useEffect(() => { api.authStatus().then((s) => { setMe(s.user); setAuthOn(s.enabled); }).catch(() => setMe(null)); }, []);
  useEffect(() => { loadLeagues(); }, [loadLeagues]);
  useEffect(() => { void load(); }, [load]);

  if (me === undefined) return <div className="page"><p className="muted">Cargando…</p></div>;
  if (authOn && (!me || me.role !== 'admin')) {
    return (
      <div className="page">
        <div className="card admin-denied">
          <div className="passicon">⛔</div>
          <h2>Solo el administrador puede entrar</h2>
          <p className="muted">Esta sección administra ligas, equipos, jugadores y juegos — incluye acciones destructivas.</p>
        </div>
      </div>
    );
  }

  const doDelete = async (password: string) => {
    if (!pending) return;
    if (pending.kind === 'league') { await api.deleteLeague(pending.id, password); setSel(''); setLeague(null); setTeams([]); loadLeagues(); return; }
    if (pending.kind === 'team') { await api.deleteTeam(pending.id, password); if (pending.id === selTeam) setSelTeam(''); }
    if (pending.kind === 'player') await api.deletePlayer(pending.teamId!, pending.id, password);
    if (pending.kind === 'game') await api.deleteGame(pending.id, password);
    await load();
  };

  const toggleBlock = async (kind: 'team' | 'player', id: string, blocked: boolean, teamId?: string) => {
    setBusy(id); setErr('');
    try {
      if (kind === 'team') await api.blockTeam(id, blocked);
      else await api.blockPlayer(teamId!, id, blocked);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const games = (league?.games ?? []) as (Game & { state?: { score?: { away: number; home: number } } })[];
  const curTeam = teams.find((t) => t.id === selTeam);
  // con equipo seleccionado: jugadores solo suyos, juegos donde participa
  const visTeams = selTeam ? teams.filter((t) => t.id === selTeam) : teams;
  const visGames = selTeam ? games.filter((g) => g.awayTeamId === selTeam || g.homeTeamId === selTeam) : games;
  const openTeam = (id: string) => { setSelTeam(id); setTab('jugadores'); };

  if (editGame) {
    return (
      <div className="page admin-page">
        <AdminGameEdit gameId={editGame} onClose={() => { setEditGame(null); void load(); }} />
      </div>
    );
  }

  return (
    <div className="page admin-page">
      <h2>🛡 Administración de ligas</h2>
      <p className="muted">Borrar pide la clave de administrador. «Publicado / Bloqueado» decide si el equipo o jugador aparece en la página web pública — sus datos siempre quedan en el sistema.</p>

      <div className="admin-bar">
        <select value={sel} onChange={(e) => { setSel(e.target.value); setSelTeam(''); }}>
          {leagues.map((l) => <option key={l.id} value={l.id}>{l.name} {l.year}</option>)}
          {!leagues.length && <option value="">— Sin ligas —</option>}
        </select>
        <div className="admin-tabs">
          {(['equipos', 'jugadores', 'juegos', 'liga', 'importar'] as const).map((t) => (
            <button key={t} className={tab === t ? '' : 'secondary'} onClick={() => setTab(t)}>
              {{ equipos: '🛡 Equipos', jugadores: '👥 Jugadores', juegos: '🎮 Juegos', liga: '🏆 Liga', importar: '📥 Importar' }[t]}
            </button>
          ))}
        </div>
      </div>
      {curTeam && (
        <div className="admin-crumb">
          🏟 <b>{curTeam.name}</b>
          <span className="muted">— viendo solo este equipo</span>
          <button className="secondary icon" title="Volver a toda la liga" onClick={() => setSelTeam('')}>✕ Todos</button>
        </div>
      )}
      {err && <div className="passerr" style={{ margin: '8px 0' }}>⚠️ {err}</div>}

      {!league && <div className="card"><p className="muted">Elige una liga arriba.</p></div>}

      {league && tab === 'equipos' && (
        <div className="card">
          <table className="admin-table">
            <thead><tr><th>Equipo</th><th>Jugadores</th><th>Publicación</th><th></th></tr></thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.id} className={t.blocked ? 'is-blocked' : ''}>
                  <td>
                    {t.color && <span className="team-dot" style={{ background: t.color }} />}
                    <button className="linklike" title="Ver jugadores y juegos de este equipo aquí"
                      onClick={() => openTeam(t.id)}>{t.name}</button>
                    <Link className="admin-ext" to={`/teams/${t.id}`} target="_blank" title="Abrir página del equipo en otra pestaña">↗</Link>
                    {t.division && <span className="muted"> · {t.division}</span>}
                  </td>
                  <td className="muted">{t.players?.length ?? t._count?.players ?? 0}</td>
                  <td>
                    <button
                      className={`${t.blocked ? 'danger icon' : 'icon ok'}`}
                      disabled={busy === t.id}
                      title={t.blocked ? 'Bloqueado: sale "EQUIPO BLOQUEADO" en la web — clic para publicar' : 'Publicado en la página web — clic para bloquear'}
                      onClick={() => void toggleBlock('team', t.id, !t.blocked)}
                    >{t.blocked ? '🚫 BLOQUEADO' : '🌐 Publicado'}</button>
                  </td>
                  <td className="admin-acts">
                    <button className="danger icon" title="Borrar equipo (pide clave)"
                      onClick={() => setPending({ kind: 'team', id: t.id, label: `el equipo «${t.name}» y sus ${t.players?.length ?? 0} jugadores` })}>🗑</button>
                  </td>
                </tr>
              ))}
              {!teams.length && <tr><td colSpan={4} className="muted">La liga no tiene equipos.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {league && tab === 'jugadores' && (
        <div className="card">
          <table className="admin-table">
            <thead><tr><th>Jugador</th><th>Equipo</th><th>Publicación</th><th></th></tr></thead>
            <tbody>
              {visTeams.flatMap((t) => (t.players ?? []).map((p) => { const team = t; return (
                <tr key={p.id} className={p.blocked ? 'is-blocked' : ''}>
                  <td>
                    {p.number != null && <span className="muted">#{p.number} </span>}
                    <b>{p.lastName}, {p.firstName}</b>
                    <Link className="admin-ext" to={`/players/${p.id}`} target="_blank" title="Abrir tarjeta del jugador en otra pestaña">↗</Link>
                    {!p.active && <span className="muted"> (baja)</span>}
                  </td>
                  <td className="muted">{team.shortName ?? team.name}</td>
                  <td>
                    <button
                      className={`${p.blocked ? 'danger icon' : 'icon ok'}`}
                      disabled={busy === p.id}
                      title={p.blocked ? 'Bloqueado: su perfil dice "BLOQUEADO" con números tapados — clic para publicar' : 'Publicado en la página web — clic para bloquear'}
                      onClick={() => void toggleBlock('player', p.id, !p.blocked, team.id)}
                    >{p.blocked ? '🚫 BLOQUEADO' : '🌐 Publicado'}</button>
                  </td>
                  <td className="admin-acts">
                    <button className="danger icon" title="Borrar jugador (pide clave)"
                      onClick={() => setPending({ kind: 'player', id: p.id, teamId: team.id, label: `al jugador «${p.firstName} ${p.lastName}»` })}>🗑</button>
                  </td>
                </tr>
              ); }))}
              {!visTeams.some((t) => t.players?.length) && <tr><td colSpan={4} className="muted">Sin jugadores{selTeam ? ' en este equipo' : ' en la liga'}.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {league && tab === 'juegos' && (
        <div className="card">
          <table className="admin-table">
            <thead><tr><th>Fecha</th><th>Juego</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              {visGames.map((g) => (
                <tr key={g.id}>
                  <td className="muted">{new Date(g.date).toLocaleDateString('es')}</td>
                  <td>
                    <button className="linklike" title="Abrir el juego en el editor de aquí"
                      onClick={() => setEditGame(g.id)}>
                      {g.awayTeam?.shortName ?? g.awayTeam?.name ?? '?'} @ {g.homeTeam?.shortName ?? g.homeTeam?.name ?? '?'}
                    </button>
                    <Link className="admin-ext" to={`/games/${g.id}`} target="_blank" title="Abrir la página del juego en otra pestaña">↗</Link>
                    {g.state?.score && <b> {g.state.score.away}-{g.state.score.home}</b>}
                  </td>
                  <td className="muted">{g.status}</td>
                  <td className="admin-acts">
                    <button className="icon" title="Auditoría de juego: editar/insertar/borrar jugadas, decisiones, recalcula todo"
                      onClick={() => setEditGame(g.id)}>🔍 Auditoría</button>
                    <button className="danger icon" title="Borrar juego (pide clave)"
                      onClick={() => setPending({ kind: 'game', id: g.id, label: `el juego «${g.awayTeam?.name ?? '?'} @ ${g.homeTeam?.name ?? '?'}» del ${new Date(g.date).toLocaleDateString('es')}` })}>🗑</button>
                  </td>
                </tr>
              ))}
              {!visGames.length && <tr><td colSpan={4} className="muted">Sin juegos{selTeam ? ' de este equipo' : ' en la liga'}.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {league && tab === 'liga' && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h3>⚙️ Opciones del anotador</h3>
          <div className="ge-row">
            <button
              className={`${league.sprayInput !== false ? 'icon ok' : 'secondary icon'}`}
              title="Spray sheet al anotar: campo de círculos para ubicar dónde cayó el batazo"
              onClick={async () => {
                const upd = await api.updateLeague(league.id, { sprayInput: league.sprayInput === false });
                setLeague({ ...league, sprayInput: upd.sprayInput });
              }}>
              {league.sprayInput !== false ? '🎯 Spray sheet: ACTIVO' : '🎯 Spray sheet: APAGADO'}
            </button>
            <span className="muted">Al anotar, el campo de círculos ubica cada batazo (out/hit/HR) — apágalo si prefieren solo la notación por números.</span>
          </div>
        </div>
      )}
      {league && tab === 'liga' && (
        <div className="card admin-danger">
          <h3>⚠️ Zona peligrosa</h3>
          <p>
            <b>{league.name} {league.year}</b> — {teams.length} equipos,{' '}
            {teams.reduce((s, t) => s + (t.players?.length ?? 0), 0)} jugadores, {games.length} juegos.
          </p>
          <p className="muted">Borrar la liga elimina equipos, jugadores, juegos, eventos y estadísticas. No se puede deshacer — pide la clave de administrador.</p>
          <button className="danger"
            onClick={() => setPending({ kind: 'league', id: league.id, label: `la liga completa «${league.name} ${league.year}» con todos sus equipos, jugadores y juegos` })}>
            🗑 Borrar liga completa
          </button>
        </div>
      )}

      {league && tab === 'importar' && (
        <AdminBoxImport leagueId={league.id} teams={teams} />
      )}

      {pending && (
        <PassModal
          title={`Borrar ${pending.kind === 'league' ? 'liga' : pending.kind === 'team' ? 'equipo' : pending.kind === 'player' ? 'jugador' : 'juego'}`}
          message={`Vas a borrar ${pending.label}. Esta acción no se puede deshacer.`}
          onClose={() => setPending(null)}
          onDone={doDelete}
        />
      )}
    </div>
  );
}
