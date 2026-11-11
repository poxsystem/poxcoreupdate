import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, Game, League, PlayoffSeries, SeriesGame, StandingRow } from '../api';
import { PassModal } from './PassModal';

export const roundName = (round: number, total: number | null | undefined, count: number) => {
  if (total && round === total) return 'Final';
  if (total && round === total - 1) return 'Semifinales';
  if (count === 2) return 'Semifinales';
  return `Ronda ${round}`;
};

/**
 * Panel de postemporada de una liga: config de clasificados/rondas,
 * pareos por ronda con sentados (bye) y series al mejor de N.
 */
export default function PlayoffsPanel({ league, onChanged }: { league: League; onChanged: () => void }) {
  const nav = useNavigate();
  const [series, setSeries] = useState<PlayoffSeries[]>([]);
  const [msg, setMsg] = useState('');
  // config
  const [cls, setCls] = useState(String(league.playoffTeams ?? ''));
  const [rnds, setRnds] = useState(String(league.playoffRounds ?? ''));
  // nuevo pareo
  const [nr, setNr] = useState(1);
  const [nHome, setNHome] = useState('');
  const [nAway, setNAway] = useState('');
  const [nWins, setNWins] = useState(3);
  const [nName, setNName] = useState('');
  // juego nuevo dentro de una serie: home club / visitante / entradas (estilo MLB:
  // la localía alterna por juego — el "local de la serie" es solo el de mejor seed)
  const [gf, setGf] = useState<{ sid: string; home: string; away: string; inn: number } | null>(null);
  // vincular un juego ya creado a una serie (sus stats pasan a postemporada)
  const [af, setAf] = useState<string | null>(null); // seriesId con el selector abierto
  const [aPick, setAPick] = useState('');
  const [aAll, setAAll] = useState(false); // incluir juegos de otros pareos
  // editar un juego de la serie (localía + entradas) y borrado con clave admin
  const [eg, setEg] = useState<{ gid: string; away: string; home: string; inn: number } | null>(null);
  const [delG, setDelG] = useState<SeriesGame | null>(null);

  const teams = league.teams ?? [];
  const [standings, setStandings] = useState<StandingRow[]>([]);
  // temporada activa (o la más reciente) — series y seeds viven por temporada
  const activeSeason = league.seasons?.find((x) => x.status === 'ACTIVE') ?? league.seasons?.[0];
  const load = () => {
    api.leagueSeries(league.id, activeSeason ? { season: activeSeason.id } : {}).then(setSeries).catch(() => {});
    api.leagueStandings(league.id, activeSeason ? { season: activeSeason.id } : {}).then(setStandings).catch(() => {});
  };
  useEffect(() => { load(); }, [league.id]);
  useEffect(() => { setCls(String(league.playoffTeams ?? '')); setRnds(String(league.playoffRounds ?? '')); }, [league.id]);

  // seeds por posición (standings de temporada regular); sin standings → orden de tabla
  const seedOrder = standings.length ? standings.map((s) => s.teamId) : teams.map((t) => t.id);
  // clasificados = top N por posición; sin config → todos
  const classified = league.playoffTeams ? seedOrder.slice(0, league.playoffTeams) : seedOrder;
  const eliminated = teams.filter((t) => !classified.includes(t.id));

  const byes = (league.byes ?? {}) as Record<string, string[]>;
  const rounds = useMemo(() => [...new Set(series.map((s) => s.round))].sort((a, b) => a - b), [series]);

  // pool elegible para la ronda r: ronda 1 = solo clasificados; después = ganadores + sentados de la ronda previa
  const poolFor = (r: number): string[] => {
    if (r <= 1) return classified;
    const winners = series.filter((s) => s.round === r - 1 && s.winnerTeamId).map((s) => s.winnerTeamId!);
    return [...new Set([...winners, ...(byes[String(r - 1)] ?? [])])];
  };
  const usedInRound = (r: number) => new Set(series.filter((s) => s.round === r).flatMap((s) => [s.homeTeamId, s.awayTeamId]));
  const nameOf = (tid: string) => teams.find((t) => t.id === tid)?.name ?? '?';
  const teamOpt = (tid: string) => {
    const t = teams.find((x) => x.id === tid);
    return t ? t.name : nameOf(tid);
  };

  const saveConfig = async () => {
    await api.updateLeague(league.id, {
      playoffTeams: cls ? Number(cls) : null,
      playoffRounds: rnds ? Number(rnds) : null,
    });
    setMsg('Configuración de playoffs guardada');
    onChanged();
  };

  const addSeries = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nHome || !nAway || nHome === nAway) return;
    await api.createSeries(league.id, {
      round: nr, name: nName || `${roundName(nr, league.playoffRounds, 0)} ${nr}`,
      homeTeamId: nHome, awayTeamId: nAway, winsNeeded: nWins, seasonId: activeSeason?.id,
    });
    setNHome(''); setNAway(''); setNName('');
    load();
  };

  const openGameForm = (s: PlayoffSeries) =>
    setGf({ sid: s.id, home: s.homeTeamId, away: s.awayTeamId, inn: league.innings ?? (league.sport === 'softball' ? 7 : 9) });

  const createGameInSeries = async (s: PlayoffSeries) => {
    if (!gf || gf.sid !== s.id || !gf.home || !gf.away || gf.home === gf.away) return;
    const g = await api.createGame({
      awayTeamId: gf.away, homeTeamId: gf.home,
      leagueId: league.id, seriesId: s.id, seasonId: s.seasonId ?? activeSeason?.id,
      sport: league.sport, innings: gf.inn,
    });
    nav(`/games/${g.id}`);
  };

  // juegos de la liga que se pueden vincular a esta serie: sin serie, de la
  // misma temporada y (por defecto) del mismo pareo en cualquier localía
  const attachable = (s: PlayoffSeries): Game[] => {
    const pair = [s.homeTeamId, s.awayTeamId].sort().join('|');
    const samePair = (g: Game) => [g.homeTeamId, g.awayTeamId].sort().join('|') === pair;
    return (league.games ?? [])
      .filter((g) => !g.seriesId && (!s.seasonId || !g.seasonId || g.seasonId === s.seasonId) && (aAll || samePair(g)))
      .sort((a, b) => +new Date(b.date) - +new Date(a.date));
  };

  const attachGame = async (s: PlayoffSeries) => {
    if (!aPick) return;
    await api.updateGame(aPick, { seriesId: s.id });
    setAPick(''); setAf(null);
    load(); onChanged();
  };

  const unlinkGame = async (g: SeriesGame) => {
    if (!confirm('¿Quitar este juego de la serie? Sus estadísticas vuelven a la temporada regular.')) return;
    await api.updateGame(g.id, { seriesId: null });
    load(); onChanged();
  };

  // corrige localía y entradas de un juego ya creado — los equipos solo se
  // cambian mientras esté programado (regla del server), las entradas siempre
  const saveGameEdit = async (g: SeriesGame) => {
    if (!eg || eg.gid !== g.id || !eg.home || !eg.away || eg.home === eg.away) return;
    await api.updateGame(g.id, {
      innings: eg.inn,
      ...(g.status === 'SCHEDULED' ? { awayTeamId: eg.away, homeTeamId: eg.home } : {}),
    });
    setEg(null); load();
  };

  const toggleBye = async (r: number, tid: string) => {
    const cur = new Set(byes[String(r)] ?? []);
    if (cur.has(tid)) cur.delete(tid); else cur.add(tid);
    await api.setByes(league.id, r, [...cur]);
    onChanged();
  };

  const pool = poolFor(nr);
  const used = usedInRound(nr);
  // orden por seed para los selects y el pareo automático
  const bySeed = (ids: string[]) => [...ids].sort((a, b) => seedOrder.indexOf(a) - seedOrder.indexOf(b));
  const freeInRound = bySeed(pool.filter((tid) => !used.has(tid) && !(byes[String(nr)] ?? []).includes(tid)));
  const prevRoundDone = nr <= 1 || (series.some((s) => s.round === nr - 1) && series.filter((s) => s.round === nr - 1).every((s) => s.status === 'DONE'));

  // pareo automático: mejor seed vs peor disponible (1vN, 2vN-1…); impar → queda sentado
  const autoPair = async () => {
    const free = [...freeInRound];
    let made = 0;
    while (free.length >= 2) {
      const home = free.shift()!;            // mejor seed = local
      const away = free.pop()!;              // peor seed disponible
      await api.createSeries(league.id, {
        round: nr, name: `${roundName(nr, league.playoffRounds, 0)} — ${nameOf(home)} vs ${nameOf(away)}`,
        homeTeamId: home, awayTeamId: away, winsNeeded: nWins, seasonId: activeSeason?.id,
      });
      made++;
    }
    if (free.length === 1) await api.setByes(league.id, nr, [free[0]]); // el que sobra espera
    setMsg(made ? `${made} pareo(s) creados por posición${free.length ? ' · 1 sentado' : ''}` : 'No hay parejas disponibles');
    load(); onChanged();
  };

  return (
    <div>
      {/* config */}
      <div className="card">
        <h2>Configuración de postemporada</h2>
        <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <label>Clasifican: <input type="number" min={0} style={{ width: 64 }} value={cls} onChange={(e) => setCls(e.target.value)} /></label>
          <label>Rondas de playoff: <input type="number" min={0} style={{ width: 64 }} value={rnds} onChange={(e) => setRnds(e.target.value)} /></label>
          <button onClick={saveConfig}>Guardar</button>
          <span className="muted" style={{ fontSize: '0.8rem' }}>Ej: 6 clasifican · 3 rondas (preliminar, semifinal, final)</span>
        </div>
        {league.playoffTeams ? (
          <p className="muted" style={{ fontSize: '0.82rem', margin: '0.5rem 0 0' }}>
            🏆 Clasifican: <strong>{classified.map(nameOf).join(', ') || '—'}</strong>
            {eliminated.length > 0 && <> · ❌ Eliminados: {eliminated.map((t) => t.name).join(', ')}</>}
          </p>
        ) : (
          <p className="muted" style={{ fontSize: '0.82rem', margin: '0.5rem 0 0' }}>Sin límite de clasificados — todos los equipos entran a la ronda 1.</p>
        )}
      </div>
      {msg && <div className="flash" onClick={() => setMsg('')}>{msg}</div>}

      {/* bracket visual: columna por ronda, caja por serie */}
      {series.length > 0 && (
        <div className="bracket card">
          {rounds.map((r) => (
            <div className="br-round" key={r}>
              <div className="br-round-name">{roundName(r, league.playoffRounds, series.filter((s) => s.round === r).length)}</div>
              <div className="br-col">
                {series.filter((s) => s.round === r).map((s) => (
                  <div className="br-serie" key={s.id}>
                    <div className={`br-team ${s.winnerTeamId === s.awayTeamId ? 'win' : ''}`}>
                      <span>{s.awayTeam.shortName ?? s.awayTeam.name}</span><b>{s.wins.away}</b>
                    </div>
                    <div className={`br-team ${s.winnerTeamId === s.homeTeamId ? 'win' : ''}`}>
                      <span>{s.homeTeam.shortName ?? s.homeTeam.name}</span><b>{s.wins.home}</b>
                    </div>
                    <div className="br-meta muted">{s.status === 'DONE' ? '✔' : s.status === 'LIVE' ? '🔴' : `al mejor de ${s.winsNeeded * 2 - 1}`}</div>
                  </div>
                ))}
                {(byes[String(r)] ?? []).map((tid) => (
                  <div className="br-serie bye" key={tid}>
                    <div className="br-team win"><span>{nameOf(tid)}</span><b>⏸</b></div>
                    <div className="br-meta muted">sentado</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* rondas existentes */}
      {rounds.map((r) => {
        const roundSeries = series.filter((s) => s.round === r);
        const roundByes = byes[String(r)] ?? [];
        const allDone = roundSeries.length > 0 && roundSeries.every((s) => s.status === 'DONE');
        return (
          <div className="card" key={r}>
            <div className="row" style={{ alignItems: 'baseline' }}>
              <h2 style={{ margin: 0 }}>🏆 {roundName(r, league.playoffRounds, roundSeries.length)}</h2>
              {allDone && <span className="pill final">COMPLETA</span>}
              <span className="spacer" />
            </div>
            {roundByes.length > 0 && (
              <p className="muted" style={{ margin: '0.3rem 0' }}>
                ⏸ Sentados esperando rival: <strong>{roundByes.map(nameOf).join(', ')}</strong>
              </p>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '0.7rem' }}>
              {roundSeries.map((s) => (
                <div className="card" key={s.id} style={{ margin: 0, padding: '0.7rem 0.9rem' }}>
                  <div className="row" style={{ alignItems: 'baseline' }}>
                    <strong>{s.name}</strong>
                    <span className="muted" style={{ fontSize: '0.75rem' }}>al mejor de {s.winsNeeded * 2 - 1}</span>
                    <span className="spacer" />
                    <button className="danger icon" title="Eliminar serie" onClick={async () => { if (confirm('¿Eliminar serie? Los juegos quedan pero se desvinculan.')) { await api.deleteSeries(league.id, s.id); load(); } }}>✕</button>
                  </div>
                  <p style={{ margin: '0.35rem 0', fontSize: '1.05rem' }}>
                    {s.winnerTeamId === s.awayTeamId ? '🏆 ' : ''}{s.awayTeam.name} <strong>{s.wins.away}</strong>
                    {' — '}
                    {s.winnerTeamId === s.homeTeamId ? '🏆 ' : ''}{s.homeTeam.name} <strong>{s.wins.home}</strong>
                  </p>
                  {s.winner && <p className="pill final" style={{ margin: '0.2rem 0' }}>Avanza: {s.winner.name}</p>}
                  {s.games.map((g, i) => (
                    <div key={g.id}>
                      <p className="muted" style={{ margin: '0.15rem 0', fontSize: '0.82rem' }}>
                        J{i + 1} · {new Date(g.date).toLocaleDateString()} ·{' '}
                        <Link to={`/games/${g.id}`}>{nameOf(g.awayTeamId)} @ {nameOf(g.homeTeamId)}</Link>
                        {' '}<b>{g.away} - {g.home}</b> · {g.innings} inn
                        {' '}<span className={`pill ${g.status === 'LIVE' ? 'live' : g.status === 'FINAL' ? 'final' : 'sched'}`} style={{ fontSize: '0.62rem' }}>{g.status}</span>
                        {g.status !== 'FINAL' && <> · <Link to={`/games/${g.id}/score`}>anotar</Link></>}
                        <button className="secondary icon" title="Editar juego: visitante, home club y entradas"
                          style={{ fontSize: '0.62rem', padding: '0 0.3rem', marginLeft: '0.3rem' }}
                          onClick={() => setEg(eg?.gid === g.id ? null : { gid: g.id, away: g.awayTeamId, home: g.homeTeamId, inn: g.innings })}>✎</button>
                        <button className="danger icon" title="Borrar el juego por completo (pide clave de admin)"
                          style={{ fontSize: '0.62rem', padding: '0 0.3rem', marginLeft: '0.2rem' }}
                          onClick={() => setDelG(g)}>🗑</button>
                        <button className="danger icon" title="Quitar de la serie — sus stats vuelven a la temporada regular"
                          style={{ fontSize: '0.62rem', padding: '0 0.3rem', marginLeft: '0.2rem' }}
                          onClick={() => unlinkGame(g)}>✕</button>
                      </p>
                      {eg?.gid === g.id && (
                        <form className="row" style={{ margin: '0.2rem 0 0.35rem', alignItems: 'center', flexWrap: 'wrap', gap: '0.3rem' }}
                          onSubmit={(e) => { e.preventDefault(); saveGameEdit(g); }}>
                          <select value={eg.away} onChange={(e) => setEg({ ...eg, away: e.target.value })}
                            disabled={g.status !== 'SCHEDULED'} title="Visitante">
                            <option value={s.awayTeamId}>🚌 {s.awayTeam.name}</option>
                            <option value={s.homeTeamId}>🚌 {s.homeTeam.name}</option>
                          </select>
                          <span className="muted">@</span>
                          <select value={eg.home} onChange={(e) => setEg({ ...eg, home: e.target.value })}
                            disabled={g.status !== 'SCHEDULED'} title="Home club">
                            <option value={s.homeTeamId}>🏠 {s.homeTeam.name}</option>
                            <option value={s.awayTeamId}>🏠 {s.awayTeam.name}</option>
                          </select>
                          <label style={{ fontSize: '0.78rem' }}>Entradas
                            <input type="number" min={1} max={30} style={{ width: 46, marginLeft: '0.25rem' }}
                              value={eg.inn} onChange={(e) => setEg({ ...eg, inn: Number(e.target.value) || 9 })} />
                          </label>
                          <button type="submit" disabled={!eg.home || !eg.away || eg.home === eg.away}>Guardar</button>
                          <button type="button" className="secondary icon" onClick={() => setEg(null)}>✕</button>
                          {g.status !== 'SCHEDULED' && <span className="muted" style={{ fontSize: '0.68rem' }}>los equipos solo se cambian en juegos programados</span>}
                        </form>
                      )}
                    </div>
                  ))}
                  {!s.winnerTeamId && (
                    <>
                      {gf?.sid === s.id ? (
                        <form className="row" style={{ marginTop: '0.4rem', alignItems: 'center', flexWrap: 'wrap', gap: '0.3rem' }}
                          onSubmit={(e) => { e.preventDefault(); createGameInSeries(s); }}>
                          <select value={gf.away} onChange={(e) => setGf({ ...gf, away: e.target.value })} title="Visitante">
                            <option value={s.awayTeamId}>🚌 {s.awayTeam.name}</option>
                            <option value={s.homeTeamId}>🚌 {s.homeTeam.name}</option>
                          </select>
                          <span className="muted">@</span>
                          <select value={gf.home} onChange={(e) => setGf({ ...gf, home: e.target.value })} title="Home club">
                            <option value={s.homeTeamId}>🏠 {s.homeTeam.name}</option>
                            <option value={s.awayTeamId}>🏠 {s.awayTeam.name}</option>
                          </select>
                          <label style={{ fontSize: '0.78rem' }}>Entradas
                            <input type="number" min={1} max={30} style={{ width: 46, marginLeft: '0.25rem' }}
                              value={gf.inn} onChange={(e) => setGf({ ...gf, inn: Number(e.target.value) || 9 })} />
                          </label>
                          <button type="submit" disabled={!gf.home || !gf.away || gf.home === gf.away}>▶ Crear</button>
                          <button type="button" className="secondary icon" onClick={() => setGf(null)}>✕</button>
                        </form>
                      ) : (
                        <div className="row" style={{ marginTop: '0.4rem', gap: '0.3rem' }}>
                          <button className="secondary" onClick={() => { setAf(null); openGameForm(s); }}>
                            ＋ Juego {s.games.length + 1}
                          </button>
                          <button className="secondary" title="Vincular un juego ya creado/jugado a esta serie — sus stats pasan a postemporada"
                            onClick={() => { setGf(null); setAf(af === s.id ? null : s.id); setAPick(''); setAAll(false); }}>
                            🔗 Existente
                          </button>
                        </div>
                      )}
                      {af === s.id && (
                        <>
                          <div className="row" style={{ marginTop: '0.35rem', alignItems: 'center', flexWrap: 'wrap', gap: '0.3rem' }}>
                            <select value={aPick} onChange={(e) => setAPick(e.target.value)} style={{ maxWidth: 300 }}>
                              <option value="">Juego sin serie…</option>
                              {attachable(s).map((g) => (
                                <option key={g.id} value={g.id}>
                                  {new Date(g.date).toLocaleDateString()} · {g.awayTeam?.name ?? '?'} @ {g.homeTeam?.name ?? '?'}
                                  {g.state ? ` (${g.state.score.away}-${g.state.score.home})` : ''} · {g.status}
                                </option>
                              ))}
                            </select>
                            <label className="muted" style={{ fontSize: '0.72rem' }} title="Incluir juegos de otros pareos">
                              <input type="checkbox" checked={aAll} onChange={(e) => setAAll(e.target.checked)} /> todos
                            </label>
                            <button className="secondary sm" disabled={!aPick} onClick={() => attachGame(s)}>🔗 Vincular</button>
                          </div>
                          <p className="muted" style={{ fontSize: '0.7rem', margin: '0.2rem 0 0' }}>
                            Si el juego ya terminó, sus estadísticas se mueven de la regular a la postemporada.
                          </p>
                        </>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
            {!roundSeries.length && <p className="muted">Sin pareos en esta ronda aún.</p>}
          </div>
        );
      })}

      {/* iniciar nueva ronda / pareo */}
      <div className="card">
        <h2>➕ Armar pareo</h2>
        <p className="muted" style={{ fontSize: '0.82rem' }}>
          Ronda {nr} — elegibles: {pool.length ? pool.map(teamOpt).join(', ') : 'ninguno (termina la ronda anterior primero)'}
        </p>
        <form className="row" onSubmit={addSeries} style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <label>Ronda: <input type="number" min={1} max={league.playoffRounds ?? 9} style={{ width: 56 }} value={nr} onChange={(e) => setNr(Number(e.target.value))} /></label>
          <input placeholder="Nombre (ej. Semifinal A)" value={nName} onChange={(e) => setNName(e.target.value)} style={{ width: 170 }} />
          <select value={nHome} onChange={(e) => setNHome(e.target.value)} title="Mejor seed / local de la serie">
            <option value="">Local (mayor seed)…</option>
            {freeInRound.map((t) => <option key={t} value={t}>{teamOpt(t)}</option>)}
          </select>
          <span className="muted">vs</span>
          <select value={nAway} onChange={(e) => setNAway(e.target.value)}>
            <option value="">Visitante…</option>
            {freeInRound.filter((t) => t !== nHome).map((t) => <option key={t} value={t}>{teamOpt(t)}</option>)}
          </select>
          <label>Gana con: <input type="number" min={1} style={{ width: 56 }} value={nWins} onChange={(e) => setNWins(Number(e.target.value))} /> victorias</label>
          <button type="submit" disabled={!nHome || !nAway || nHome === nAway || (nr > 1 && !prevRoundDone)}>
            Crear pareo
          </button>
          <button type="button" className="secondary" onClick={autoPair}
            disabled={freeInRound.length < 2 || (nr > 1 && !prevRoundDone)}
            title="Empareja mejor seed vs peor (1vN, 2vN-1…); impar queda sentado">
            🎲 Pareos automáticos
          </button>
        </form>
        {nr > 1 && !prevRoundDone && <p className="muted" style={{ fontSize: '0.8rem' }}>La ronda {nr - 1} debe estar completa para armar esta.</p>}

        {/* sentados de esta ronda */}
        {pool.length > 0 && (
          <>
            <p className="muted" style={{ fontSize: '0.82rem', marginBottom: '0.3rem' }}>⏸ Sentados en ronda {nr} (esperan rival):</p>
            <div className="row" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
              {pool.filter((tid) => !used.has(tid)).map((tid) => (
                <label key={tid} className="pill sched" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={(byes[String(nr)] ?? []).includes(tid)} onChange={() => toggleBye(nr, tid)} /> {teamOpt(tid)}
                </label>
              ))}
            </div>
          </>
        )}
      </div>

      {/* borrar un juego de la serie: jugado o programado, exige clave admin */}
      {delG && (
        <PassModal
          title="Borrar juego"
          message={`Se eliminará el juego ${nameOf(delG.awayTeamId)} @ ${nameOf(delG.homeTeamId)} del ${new Date(delG.date).toLocaleDateString()} con todas sus jugadas y estadísticas. No se puede deshacer.`}
          onClose={() => setDelG(null)}
          onDone={async (password) => {
            await api.deleteGame(delG.id, password);
            load(); onChanged();
          }}
        />
      )}
    </div>
  );
}
