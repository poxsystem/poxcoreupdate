import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, Game, Head2Head, LineupEntry, Player, Team } from '../api';
import { computeFielding, computeInningTallies, computeSituational, type Boxscore, type GameEvent } from '@poxscore/shared';
import LineupBuilder from '../components/LineupBuilder';
import Scoresheet, { buildSheet } from '../components/Scoresheet';
import PlayerCardModal from '../components/PlayerCardModal';
import { downloadScorecard } from '../components/ScorecardImage';
import LineupCard from '../components/LineupCard';
import ShareModal from '../components/ShareModal';
import { PassModal } from '../components/PassModal';

function fmtPlay(ev: GameEvent, nameOf: (id: string | null) => string): string {
  const R: Record<string, string> = {
    K: 'se ponchó', KWP: 'se ponchó — 3er strike suelto (WP)', KPB: 'se ponchó — 3er strike suelto (PB)',
    BB: 'recibió base por bolas', IBB: 'base intencional', HBP: 'golpeado por lanzamiento',
    '1B': 'sencillo', '2B': 'doble', '3B': 'triple', HR: '¡JONRÓN!',
    '1BE': 'sencillo y error', '2BE': 'doble y error', '3BE': 'triple y error', HRIP: '¡jonrón de piernas!',
    E: 'alcanzó por error', FC: 'jugada de selección',
    GO: 'out por rola', FO: 'out en elevado', LO: 'out en línea', PO: 'out en toque', IF: 'out — infield fly', XF: 'out en foul',
    AIL: 'out — acción ilegal del bateador', FI: 'out — interferencia de fanático',
    SAC: 'sacrificio', SF: 'elevado de sacrificio', DP: 'doble play', TP: 'triple play',
    SB: 'base robada', CS: 'atrapado robando', WP: 'wild pitch', PB: 'passed ball', BK: 'balk', PK: 'pickoff', DI: 'indiferencia defensiva',
    PC: 'cambio de lanzador', CI: 'interferencia del receptor', RHB: 'corredor golpeado por batazo (hit)',
    INT: 'interferencia del corredor', OBS: 'obstrucción', OOT: 'out por turno robado', GR: 'corredor fantasma',
    IPL: 'lanzamiento ilegal', LE: 'corredor sale temprano (out)', EF: 'error en foul',
    RBI: 'ajuste de carreras empujadas', EU: 'carrera reclasificada merecida/inmerecida',
    AO: 'auto-out (salió del juego)', LG: 'salió del juego', SK: 'pasó su turno (ausente, sin out)',
    T: 'avanzó por tiro a otra base', DE: 'avanzó por error', LIB: 'avance libre',
  };
  if (ev.result === 'PC') return `${nameOf(ev.pitcherId)} entra a lanzar`;
  if (ev.result === 'RBI') return `${nameOf(ev.batterId)} ajuste CI ${ev.notation === '-' ? '−1' : '+1'}`;
  if (ev.result === 'EU') return `${nameOf(ev.pitcherId)} — carrera pasa a ${ev.notation === 'U' ? 'inmerecida' : 'merecida'}`;
  if (ev.result === 'CR') {
    const a = ev.advances[0];
    return a ? `${nameOf(a.playerId)} entra a correr en ${a.to}ª` : `${nameOf(ev.batterId)} corredor emergente`;
  }
  const runs = ev.advances.filter((a) => a.to === 'HOME').length;
  return `${nameOf(ev.batterId)} ${R[ev.result] ?? ev.result}${runs ? ` — ${runs} carrera(s)` : ''}`;
}

type Tab = 'lineups' | 'boxscore' | 'sheet' | 'plays' | 'reportes';
type ReportTab = 'compuesto' | 'situaciones' | 'h2h';
const f3 = (n: number) => (n ? n.toFixed(3).replace(/^0/, '') : '.000');
const ipStr = (outs: number) => `${Math.floor(outs / 3)}${outs % 3 ? `.${outs % 3}` : ''}`;

export default function GamePage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [game, setGame] = useState<Game | null>(null);
  const [box, setBox] = useState<Boxscore | null>(null);
  const [tab, setTab] = useState<Tab>('lineups');
  const [error, setError] = useState('');
  const [showStart, setShowStart] = useState(false);
  const [startDate, setStartDate] = useState(() => {
    const d = new Date(); // fecha LOCAL — toISOString da la UTC y se adelanta 1 día en UTC-4
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [stadium, setStadium] = useState('');
  const [umpires, setUmpires] = useState({ hp: '', b1: '', b2: '', b3: '' });
  const [knownStadiums, setKnownStadiums] = useState<string[]>([]);
  // triangular "ganador se queda": J2/J3 vienen con equipos provisionales —
  // al iniciar se corrigen según el resultado del J1
  const [triTeams, setTriTeams] = useState<Team[]>([]);
  const [fixAway, setFixAway] = useState('');
  const [fixHome, setFixHome] = useState('');
  const [report, setReport] = useState<ReportTab>('compuesto');
  const [reportOpen, setReportOpen] = useState(false);
  const [h2h, setH2h] = useState<Head2Head | null>(null);
  const [cardPlayerId, setCardPlayerId] = useState<string | null>(null);
  const [shareMsg, setShareMsg] = useState('');
  const [showLiveLinks, setShowLiveLinks] = useState(false); // 📺 panel con las URLs en vivo/OBS
  const [lanIps, setLanIps] = useState<string[]>([]);        // IPs LAN del server (para OBS en otra PC)
  const [printCard, setPrintCard] = useState(false);
  const [showShare, setShowShare] = useState(false); // 📣 resumen automático para redes
  const [showPbp, setShowPbp] = useState(false);     // 📋 jugada a jugada generada
  const [pbp, setPbp] = useState<{ playByPlay: string; teams: { away: string; home: string } } | null>(null);
  const [showEdit, setShowEdit] = useState(false);   // ✏️ editar fecha/estadio/ampáyers (sirve en juego en curso)
  const [editDate, setEditDate] = useState('');
  const [editStart, setEditStart] = useState('');    // hora de inicio del reloj (datetime-local)
  const [editStadium, setEditStadium] = useState('');
  const [editUmp, setEditUmp] = useState({ hp: '', b1: '', b2: '', b3: '' });
  const [editInn, setEditInn] = useState(9);       // entradas pactadas (editable en el mismo modal)
  const [editMsg, setEditMsg] = useState('');
  const [showDel, setShowDel] = useState(false);   // 🗑 borrar el juego (pide clave de admin)

  const load = () => {
    if (!id) return;
    api.game(id).then((g) => {
      setGame(g);
      api.boxscore(id).then(setBox).catch(() => {});
    }).catch((e) => setError(e.message));
  };
  useEffect(load, [id]);

  const players = useMemo(() => {
    const m = new Map<string, Player>();
    for (const p of [...(game?.awayTeam?.players ?? []), ...(game?.homeTeam?.players ?? [])]) m.set(p.id, p);
    // refuerzos: jugadores de otros equipos llegan vía lineups[].player
    for (const l of game?.lineups ?? []) if (l.player) m.set(l.player.id, l.player);
    // statLines importados: jugadores que hoy son de otro equipo (el server los adjunta)
    for (const p of game?.statPlayers ?? []) m.set(p.id, p as Player);
    return m;
  }, [game]);

  const startErr = error;

  // reportes del juego (estilo BallScore): situacional y fildeo derivados del stream
  const situ = useMemo(() => computeSituational(game?.events ?? [], game?.innings ?? 9), [game?.events, game?.innings]);
  const fldGame = useMemo(() => computeFielding(game?.events ?? []), [game?.events]);
  const tallies = useMemo(() => computeInningTallies(game?.events ?? [], game?.innings ?? 9), [game?.events, game?.innings]);
  // equipo de cada jugador EN ESTE JUEGO: lineup primero (un refuerzo es de SU equipo del día),
  // roster solo como respaldo — así un refuerzo no aparece bajo los dos equipos
  const teamOf = useMemo(() => {
    const lu = new Map<string, string>();
    for (const l of game?.lineups ?? []) lu.set(l.playerId, l.teamId);
    const ro = new Map<string, string>();
    for (const p of game?.awayTeam?.players ?? []) ro.set(p.id, game!.awayTeamId);
    for (const p of game?.homeTeam?.players ?? []) ro.set(p.id, game!.homeTeamId);
    return (pid: string) => lu.get(pid) ?? ro.get(pid) ?? null;
  }, [game]);
  // decisiones de pitcheo del juego (G/P/SV/H/BS)
  const decisionIds = useMemo(() => {
    let hld: string[] = [], bs: string[] = [];
    try { hld = JSON.parse(game?.hldIds ?? '[]'); } catch { /* vacío */ }
    try { bs = JSON.parse(game?.bsIds ?? '[]'); } catch { /* vacío */ }
    return { hld, bs };
  }, [game?.hldIds, game?.bsIds]);
  const decisionOf = (pid: string, sl?: { w?: number; l?: number; sv?: number; hld?: number; bs?: number }) => {
    const m: string[] = [];
    if (game?.wpId === pid || sl?.w) m.push('G');
    if (game?.lpId === pid || sl?.l) m.push('P');
    if (game?.svId === pid || sl?.sv) m.push('SV');
    if (decisionIds.hld.includes(pid) || sl?.hld) m.push('H');
    if (decisionIds.bs.includes(pid) || sl?.bs) m.push('BS');
    return m.length ? ` (${m.join(',')})` : '';
  };
  // casilla (order-1) de cada jugador EN el momento del evento — la planilla
  // dibuja por ORDER, la misma fuente que la columna de nombres y las stats
  const orderSlotOf = useMemo(() => {
    const byTeam = new Map<string, LineupEntry[]>();
    for (const l of game?.lineups ?? []) {
      if (l.batsInOrder === false || l.order >= 50) continue;
      const arr = byTeam.get(l.teamId) ?? [];
      arr.push(l);
      byTeam.set(l.teamId, arr);
    }
    const pos = (inn: number, h: 'TOP' | 'BOTTOM') => inn * 2 + (h === 'TOP' ? 0 : 1);
    return (tid: string) => {
      const ets = byTeam.get(tid) ?? [];
      const bound = (l: LineupEntry) => (l.subInInning && l.subInHalf ? pos(l.subInInning, l.subInHalf as 'TOP' | 'BOTTOM') : 0);
      return (pid: string, inning: number, half: 'TOP' | 'BOTTOM') => {
        const mine = ets.filter((l) => l.playerId === pid);
        if (!mine.length) return null;
        const at = pos(inning, half);
        const elig = mine.filter((l) => bound(l) <= at);
        const pick = (elig.length ? elig : mine).sort((a, b) => bound(b) - bound(a) || a.order - b.order)[0];
        return pick.order - 1;
      };
    };
  }, [game?.lineups]);
  // juegos importados (sin eventos) → el boxscore se dibuja desde Game.statLines
  const statLines = useMemo(() => game?.statLines ?? [], [game?.statLines]);
  const importedBox = statLines.length > 0 && !(game?.events?.length);
  // histórico vs el oponente actual — solo se carga al abrir ese reporte
  useEffect(() => {
    if (tab === 'reportes' && report === 'h2h' && reportOpen && game && !h2h) {
      api.head2head(game.awayTeamId, game.homeTeamId).then(setH2h).catch(() => {});
    }
  }, [tab, report, reportOpen, game, h2h]);

  // estadios conocidos (datalist al iniciar el juego) — hook ANTES del early return
  useEffect(() => {
    if (!showStart) return;
    // la fecha del juego manda (programada/atrasada); si coincide con hoy da igual
    if (game?.date) {
      const d = new Date(game.date);
      setStartDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    api.games().then((gs) => {
      setKnownStadiums([...new Set(gs.map((g) => g.stadium).filter((s): s is string => !!s))]);
    }).catch(() => {});
    // triangular QG: traer los equipos de la liga para corregir el pareo
    if (game?.leagueId && (game.note ?? '').includes('QG')) {
      api.league(game.leagueId).then((l) => setTriTeams(l.teams ?? [])).catch(() => {});
      setFixAway(game.awayTeamId); setFixHome(game.homeTeamId);
    }
  }, [showStart]); // eslint-disable-line react-hooks/exhaustive-deps

  const nameOf = (pid: string | null) => {
    if (!pid) return '—';
    const p = players.get(pid);
    return p ? `${p.firstName[0]}. ${p.lastName}` : '?';
  };

  if (!game) return <p>{error || 'Cargando…'}</p>;

  const start = async () => {
    try {
      // triangular QG: si el pareo provisional no cuadra con el resultado del J1, se corrige aquí
      if ((fixAway && fixAway !== game.awayTeamId) || (fixHome && fixHome !== game.homeTeamId))
        await api.updateGame(game.id, { awayTeamId: fixAway, homeTeamId: fixHome });
      await api.startGame(game.id, {
        date: startDate,
        stadium: stadium.trim() || undefined,
        umpireHp: umpires.hp.trim() || undefined,
        umpire1b: umpires.b1.trim() || undefined,
        umpire2b: umpires.b2.trim() || undefined,
        umpire3b: umpires.b3.trim() || undefined,
      });
      setShowStart(false);
      nav(`/games/${game.id}/score`);
    } catch (e) {
      try { setError(JSON.parse((e as Error).message).error); } catch { setError((e as Error).message); }
      setShowStart(false);
    }
  };

  return (
    <div>
      <p><Link to="/juegos">← Juegos</Link></p>
      <h1>
        {game.awayTeam?.name} @ {game.homeTeam?.name}
        {game.state && <span className="muted"> — {game.state.score.away}:{game.state.score.home}</span>}
      </h1>
      <div className="row" style={{ marginBottom: '1rem' }}>
        <span className={`pill ${game.status === 'LIVE' ? 'live' : game.status === 'FINAL' ? 'final' : 'sched'}`}>
          {game.forfeitBy ? 'FORFEIT' : game.status === 'SUSPENDED' ? 'SUSPENDIDO' : game.status}
        </span>
        <span className="muted">
          {new Date(game.date).toLocaleString()} · {game.innings} entradas
          {game.status !== 'FINAL' && (
            <button className="secondary icon" title="Editar fecha, estadio y ampáyers (sirve con el juego en curso)"
              style={{ marginLeft: '0.3rem', fontSize: '0.75rem', padding: '0 0.4rem' }}
              onClick={() => {
                const d = new Date(game.date);
                setEditDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
                const s = game.startedAt ? new Date(game.startedAt) : null;
                setEditStart(s ? `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}T${String(s.getHours()).padStart(2, '0')}:${String(s.getMinutes()).padStart(2, '0')}` : '');
                setEditStadium(game.stadium ?? '');
                setEditUmp({ hp: game.umpireHp ?? '', b1: game.umpire1b ?? '', b2: game.umpire2b ?? '', b3: game.umpire3b ?? '' });
                setEditInn(game.innings);
                setEditMsg(''); setShowEdit(true);
              }}>✏️</button>
          )}
        </span>
        {game.note && <span className="muted" title={game.note} style={{ fontSize: '0.8rem', fontStyle: 'italic' }}>📝 {game.note}</span>}
        <span className="spacer" />
        {game.status !== 'FINAL' && (
          <button className="big" onClick={() => (game.status === 'SCHEDULED' ? setShowStart(true) : nav(`/games/${game.id}/score`))}>
            {game.status === 'SCHEDULED' ? '▶ Iniciar y anotar'
              : game.status === 'SUSPENDED' ? '▶ Reanudar juego' : '✏️ Continuar anotando'}
          </button>
        )}
        <button className="secondary" title="Direcciones para compartir: vista pública y scorebug para OBS"
          onClick={() => {
            setShowLiveLinks(!showLiveLinks);
            if (!lanIps.length) api.health().then((h) => setLanIps(h.lan ?? [])).catch(() => {});
          }}>� En vivo</button>
        {game.status !== 'SCHEDULED' && (
          <button className="secondary" title="Descarga una imagen PNG del resultado para compartir"
            onClick={() => downloadScorecard(game).catch(() => {})}>📤 Tarjeta</button>
        )}
        {game.status === 'FINAL' && (
          <button className="secondary" title="Resumen automático + tarjeta MVP para WhatsApp/Facebook"
            onClick={() => setShowShare(true)}>📣 Compartir</button>
        )}
        {!!game.events?.length && (
          <button className="secondary" title="Jugada a jugada + boxscore oficial generado automáticamente"
            onClick={() => { setPbp(null); setShowPbp(true); api.boxscoreAi(game.id).then(setPbp).catch(() => {}); }}>📋 Jugada a jugada</button>
        )}
        {box && (
          <button className="secondary" title="Box score oficial en hoja carta — Imprimir o Guardar como PDF"
            onClick={() => { setTab('reportes'); setReport('compuesto'); setReportOpen(true); }}>🖨️ Boxscore</button>
        )}
        <button className="secondary" title="Tarjeta de alineación imprimible (para el umpire)"
          onClick={() => setPrintCard(true)}>🖨 Alineación</button>
        <button className="danger" title="Borrar el juego por completo — jugado o programado (pide clave de admin)"
          onClick={() => setShowDel(true)}>🗑</button>
      </div>
      {showLiveLinks && (
        <div className="card" style={{ padding: '0.7rem 1rem', marginBottom: '1rem' }}>
          <b style={{ fontSize: '0.9rem' }}>📺 Direcciones del juego en vivo</b>
          {([
            ['Vista pública (afición)', `${location.origin}/en-vivo/${game.id}`],
            ['Scorebug OBS (esta PC)', `${location.origin}/en-vivo/${game.id}/obs`],
            ...lanIps.map((ip): [string, string] => [`Scorebug OBS · otra PC (${ip})`, `http://${ip}:${location.port || '4000'}/en-vivo/${game.id}/obs`]),
          ]).map(([label, url]) => (
            <div className="row" key={url} style={{ gap: '0.4rem', alignItems: 'center', marginTop: '0.35rem' }}>
              <span className="muted" style={{ minWidth: '12.5rem', fontSize: '0.82rem' }}>{label}</span>
              <input readOnly value={url} onFocus={(e) => e.target.select()}
                style={{ flex: 1, fontFamily: 'monospace', fontSize: '0.78rem', padding: '0.2rem 0.4rem' }} />
              <button className="secondary sm" title="Copiar"
                onClick={(e) => {
                  const inp = (e.currentTarget.previousElementSibling as HTMLInputElement | null);
                  inp?.select();
                  try { document.execCommand('copy'); } catch { /* clipboard viejo */ }
                  navigator.clipboard?.writeText(url).catch(() => {});
                  setShareMsg(url);
                }}>📋</button>
            </div>
          ))}
          <span className="muted" style={{ fontSize: '0.74rem', display: 'block', marginTop: '0.4rem' }}>
            OBS: Fuentes → + → Navegador → pega la del scorebug (ancho 380 · alto 260) · se actualiza solo cada 2.5s
          </span>
        </div>
      )}
      {shareMsg && <p className="muted">Link copiado: <code>{shareMsg}</code></p>}
      {startErr && <p style={{ color: 'var(--red)', fontWeight: 600 }}>{startErr}</p>}

      {/* Inicio de juego: fecha y estadio antes de arrancar el reloj */}
      {showStart && (
        <div className="modal-backdrop" onClick={() => setShowStart(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Iniciar juego</h2>
            <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.7rem' }}>
              <label>Fecha del juego
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </label>
              <label>Estadio / campo
                <input type="text" value={stadium} onChange={(e) => setStadium(e.target.value)}
                  placeholder="Ej. Estadio Municipal" list="stadiums" />
                <datalist id="stadiums">{knownStadiums.map((s) => <option key={s} value={s} />)}</datalist>
              </label>
              {(game.note ?? '').includes('QG') && game.status === 'SCHEDULED' && triTeams.length > 0 && (
                <div style={{ background: 'rgba(255,159,10,0.08)', border: '1px solid rgba(255,159,10,0.3)', borderRadius: 10, padding: '0.5rem 0.7rem' }}>
                  <div className="muted" style={{ fontSize: '0.78rem', marginBottom: '0.35rem' }}>
                    🔄 Triangular «ganador se queda» — verifica el pareo según el resultado del J1:
                  </div>
                  <div className="row" style={{ gap: '0.4rem' }}>
                    <label style={{ flex: 1, fontSize: '0.85rem' }}>Visitante
                      <select value={fixAway} onChange={(e) => setFixAway(e.target.value)} style={{ width: '100%' }}>
                        {triTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </label>
                    <label style={{ flex: 1, fontSize: '0.85rem' }}>Home club
                      <select value={fixHome} onChange={(e) => setFixHome(e.target.value)} style={{ width: '100%' }}>
                        {triTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </label>
                  </div>
                </div>
              )}
              <div>
                <span className="muted" style={{ fontSize: '0.8rem' }}>Ampáyers (opcional)</span>
                <div className="row" style={{ gap: '0.4rem' }}>
                  <input placeholder="HP" style={{ flex: 1 }} value={umpires.hp} onChange={(e) => setUmpires({ ...umpires, hp: e.target.value })} />
                  <input placeholder="1B" style={{ flex: 1 }} value={umpires.b1} onChange={(e) => setUmpires({ ...umpires, b1: e.target.value })} />
                  <input placeholder="2B" style={{ flex: 1 }} value={umpires.b2} onChange={(e) => setUmpires({ ...umpires, b2: e.target.value })} />
                  <input placeholder="3B" style={{ flex: 1 }} value={umpires.b3} onChange={(e) => setUmpires({ ...umpires, b3: e.target.value })} />
                </div>
              </div>
            </div>
            <div className="row" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setShowStart(false)}>Cancelar</button>
              <button className="big" onClick={start}>▶ Iniciar</button>
            </div>
          </div>
        </div>
      )}

      {/* Editar datos del juego — disponible también con el juego en curso
          (corrige la fecha si el juego se programó/arrancó en día equivocado) */}
      {showEdit && (
        <div className="modal-backdrop" onClick={() => setShowEdit(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Editar juego</h2>
            <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.7rem' }}>
              <label>Fecha del juego
                <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
              </label>
              <label>Entradas pactadas
                <input type="number" min={1} max={30} style={{ width: 80 }} value={editInn}
                  onChange={(e) => setEditInn(Number(e.target.value) || 9)} />
              </label>
              {game.startedAt && (
                <label>Hora de inicio del reloj
                  <input type="datetime-local" value={editStart} onChange={(e) => setEditStart(e.target.value)} />
                  <span className="muted" style={{ fontSize: '0.72rem' }}>Corrige cuándo empezó el juego — ajusta el tiempo transcurrido del reloj</span>
                </label>
              )}
              <label>Estadio / campo
                <input type="text" value={editStadium} onChange={(e) => setEditStadium(e.target.value)}
                  placeholder="Ej. Estadio Municipal" list="stadiums" />
              </label>
              <div>
                <span className="muted" style={{ fontSize: '0.8rem' }}>Ampáyers</span>
                <div className="row" style={{ gap: '0.4rem' }}>
                  <input placeholder="HP" style={{ flex: 1 }} value={editUmp.hp} onChange={(e) => setEditUmp({ ...editUmp, hp: e.target.value })} />
                  <input placeholder="1B" style={{ flex: 1 }} value={editUmp.b1} onChange={(e) => setEditUmp({ ...editUmp, b1: e.target.value })} />
                  <input placeholder="2B" style={{ flex: 1 }} value={editUmp.b2} onChange={(e) => setEditUmp({ ...editUmp, b2: e.target.value })} />
                  <input placeholder="3B" style={{ flex: 1 }} value={editUmp.b3} onChange={(e) => setEditUmp({ ...editUmp, b3: e.target.value })} />
                </div>
              </div>
              {editMsg && <p style={{ color: 'var(--red)' }}>{editMsg}</p>}
            </div>
            <div className="row" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setShowEdit(false)}>Cancelar</button>
              <button onClick={async () => {
                try {
                  await api.updateGame(game.id, {
                    date: editDate,
                    innings: editInn,
                    startedAt: editStart ? new Date(editStart).toISOString() : undefined,
                    stadium: editStadium.trim() || undefined,
                    umpireHp: editUmp.hp.trim() || undefined,
                    umpire1b: editUmp.b1.trim() || undefined,
                    umpire2b: editUmp.b2.trim() || undefined,
                    umpire3b: editUmp.b3.trim() || undefined,
                  });
                  setShowEdit(false); load();
                } catch (e) {
                  try { setEditMsg(JSON.parse((e as Error).message).error); } catch { setEditMsg((e as Error).message); }
                }
              }}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      <div className="row" style={{ gap: '0.3rem', marginBottom: '0.8rem' }}>
        {([['lineups', 'Alineaciones'], ['sheet', 'Hoja de anotación'], ['boxscore', 'Boxscore'], ['plays', 'Jugadas'], ['reportes', 'Reportes']] as [Tab, string][]).map(([t, label]) => (
          <button key={t} className={tab === t ? '' : 'secondary'} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>

      {tab === 'lineups' && (
        <>
          <LineupBuilder game={game} teamId={game.awayTeamId} side="away" onSaved={load} />
          <LineupBuilder game={game} teamId={game.homeTeamId} side="home" onSaved={load} />
        </>
      )}

      {tab === 'boxscore' && importedBox && (
        // juego importado sin eventos: las tablas salen de Game.statLines
        <>
          {([['away', game.awayTeam], ['home', game.homeTeam]] as const).map(([side, team]) => {
            const tid = side === 'away' ? game.awayTeamId : game.homeTeamId;
            const lines = statLines.filter((s) => s.teamId === tid);
            if (!lines.length) return null;
            return (
              <div className="card" key={`ibat-${side}`}>
                <h2>{team?.name} <span className="muted" style={{ fontSize: '0.7em' }}>(importado)</span></h2>
                <table>
                  <thead><tr><th>Jugador</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>SB</th><th>E</th></tr></thead>
                  <tbody>
                    {lines.map((s) => (
                      <tr key={s.playerId}>
                        <td><button className="linklike" onClick={() => setCardPlayerId(s.playerId)}>{nameOf(s.playerId)}</button></td>
                        <td>{s.ab ?? 0}</td><td>{s.r ?? 0}</td><td>{s.h ?? 0}</td>
                        <td>{s.doubles ?? 0}</td><td>{s.triples ?? 0}</td><td>{s.hr ?? 0}</td>
                        <td>{s.rbi ?? 0}</td><td>{s.bb ?? 0}</td><td>{s.k ?? 0}</td><td>{s.sb ?? 0}</td>
                        <td>{s.e ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          {([['away', game.awayTeam], ['home', game.homeTeam]] as const).map(([side, team]) => {
            const tid = side === 'away' ? game.awayTeamId : game.homeTeamId;
            const pitchers = statLines.filter((s) => s.teamId === tid && ((s.gp ?? 0) || (s.pOuts ?? 0)));
            if (!pitchers.length) return null;
            return (
              <div className="card" key={`ipit-${side}`}>
                <h2>Pitcheo — {team?.name}</h2>
                <table>
                  <thead><tr><th>Lanzador</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Decisión</th></tr></thead>
                  <tbody>
                    {pitchers.map((s) => (
                      <tr key={s.playerId}>
                        <td>{nameOf(s.playerId)}</td>
                        <td>{ipStr(s.pOuts ?? 0)}</td>
                        <td>{s.pH ?? 0}</td><td>{s.pR ?? 0}</td><td>{s.pER ?? 0}</td>
                        <td>{s.pBB ?? 0}</td><td>{s.pK ?? 0}</td><td>{s.pHR ?? 0}</td>
                        <td>{decisionOf(s.playerId, s) || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </>
      )}
      {tab === 'boxscore' && box && !importedBox && (
        <>
          {([['away', game.awayTeam], ['home', game.homeTeam]] as const).map(([side, team]) => (
            <div className="card" key={side}>
              <h2>{team?.name}</h2>
              <table>
                <thead><tr><th>Jugador</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>RBI</th><th>BB</th><th>K</th><th>SB</th><th>AVG</th></tr></thead>
                <tbody>
                  {(game.lineups ?? [])
                    .filter((l) => l.teamId === (side === 'away' ? game.awayTeamId : game.homeTeamId) && l.batsInOrder !== false)
                    .sort((a, b) => a.order - b.order || (a.role === 'STARTER' ? -1 : 1))
                    .map((l: LineupEntry) => {
                      const line = box[side][l.playerId];
                      const isSub = l.role === 'SUB' || l.role === 'REIN';
                      return (
                        <tr key={l.id} className={!l.active ? 'sub-out' : ''}>
                          <td>
                            {isSub && <span className="muted">{l.role === 'REIN' ? '↺ ' : '↳ '}</span>}
                            <button className="linklike" onClick={() => setCardPlayerId(l.playerId)}>{nameOf(l.playerId)}</button>{' '}
                            <span className="muted">{l.position}</span>
                            {l.player && l.player.teamId !== (side === 'away' ? game.awayTeamId : game.homeTeamId) && <span className="pill ref-pill">REF</span>}
                            {!l.active && <span className="muted"> (salió)</span>}
                          </td>
                          <td>{line?.ab ?? 0}</td><td>{line?.r ?? 0}</td><td>{line?.h ?? 0}</td>
                          <td>{line?.doubles ?? 0}</td><td>{line?.triples ?? 0}</td><td>{line?.hr ?? 0}</td>
                          <td>{line?.rbi ?? 0}</td><td>{line?.bb ?? 0}</td><td>{line?.k ?? 0}</td><td>{line?.sb ?? 0}</td>
                          <td>{line && line.ab ? (line.h / line.ab).toFixed(3).replace(/^0/, '') : '.000'}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          ))}
          {/* Pitcheo por equipo: un jugador de posición que entra a lanzar aparece bajo su equipo.
              Equipo = lineup de este juego primero, roster después → refuerzo no sale en ambos */}
          {([['away', game.awayTeam], ['home', game.homeTeam]] as const).map(([side, team]) => {
            const tid = side === 'away' ? game.awayTeamId : game.homeTeamId;
            const pitchers = Object.values(box.pitchers).filter((p) => teamOf(p.playerId) === tid);
            if (!pitchers.length) return null;
            return (
              <div className="card" key={`pit-${side}`}>
                <h2>Pitcheo — {team?.name}</h2>
                <table>
                  <thead><tr><th>Lanzador</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th></tr></thead>
                  <tbody>
                    {pitchers.map((p, pi) => (
                      <tr key={p.playerId}>
                        <td>{nameOf(p.playerId)}{pi > 0 && <span className="muted"> (LR)</span>}{decisionOf(p.playerId)}</td>
                        <td>{Math.floor(p.outs / 3)}{p.outs % 3 ? `.${p.outs % 3}` : ''}</td>
                        <td>{p.h}</td><td>{p.r}</td><td>{p.er}</td><td>{p.bb}</td><td>{p.k}</td><td>{p.hr}</td>
                        <td>{p.pitches}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          {/* corredores dejados en base */}
          {(box.lob.away > 0 || box.lob.home > 0) && (
            <div className="card row" style={{ gap: '1.5rem' }}>
              <span><strong>Dejados en base:</strong></span>
              <span>{game.awayTeam?.name}: <strong>{box.lob.away}</strong></span>
              <span>{game.homeTeam?.name}: <strong>{box.lob.home}</strong></span>
            </div>
          )}
        </>
      )}

      {tab === 'sheet' && (['away', 'home'] as const).map((side) => {
        const tid = side === 'away' ? game.awayTeamId : game.homeTeamId;
        const lu = (game.lineups ?? []).filter((l) => l.teamId === tid && l.batsInOrder !== false).sort((a, b) => a.order - b.order);
        const sheet = buildSheet(game.events ?? [], lu.filter((l) => l.active).length || 9, side, game.innings, orderSlotOf(tid));
        return (
          <div className="card" style={{ padding: '0.6rem' }} key={side}>
            <Scoresheet
              cells={sheet.cells}
              pitcherInnings={sheet.pitcherInnings}
              lineup={lu}
              innings={game.innings}
              players={players}
              teamName={side === 'away' ? (game.awayTeam?.name ?? 'Visitante') : (game.homeTeam?.name ?? 'Local')}
              teamColor={side === 'away' ? (game.awayTeam?.color ?? undefined) : (game.homeTeam?.color ?? undefined)}
              colInning={sheet.colInning}
              tally={tallies[side]}
              onSwapBatter={(aId, bId, withMarks) => {
                const nA = players.get(aId)?.lastName ?? aId;
                const nB = players.get(bId)?.lastName ?? bId;
                const q = withMarks
                  ? `Mover a ${nA} CON todas sus anotaciones a la casilla de ${nB} (y ${nB} con las suyas a la de ${nA}). ¿Aplicar?`
                  : `Cambiar ${nA} por ${nB} en la casilla — las anotaciones se quedan donde están. ¿Aplicar?`;
                if (!window.confirm(q)) return;
                (withMarks ? api.swapOrder(game.id, { teamId: tid, aId, bId }) : api.swapPlayer(game.id, { teamId: tid, aId, bId }))
                  .then(() => load())
                  .catch((e) => setError((e as Error).message));
              }}
            />
          </div>
        );
      })}

      {tab === 'plays' && (
        <div className="card">
          <h2>Jugada a jugada</h2>
          <table>
            <tbody>
              {(game.events ?? []).filter((ev: GameEvent) => !['B', 'S', 'F'].includes(ev.result)).map((ev: GameEvent) => (
                <tr key={ev.seq}>
                  <td className="muted" style={{ width: 90 }}>{ev.half === 'TOP' ? '▲' : '▼'} {ev.inning}ª</td>
                  <td>{fmtPlay(ev, nameOf)}</td>
                </tr>
              ))}
              {(game.events?.length ?? 0) === 0 && <tr><td className="muted">Sin jugadas aún</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* Reportes del juego — estilo BallScore: cada uno abre en ventana emergente */}
      {tab === 'reportes' && box && (
        <div>
          <div className="row print-controls" style={{ gap: '0.3rem', marginBottom: '0.8rem' }}>
            {([['compuesto', 'Box score compuesto'], ['situaciones', 'Situaciones'], ['h2h', 'vs Rival (histórico)']] as [ReportTab, string][]).map(([t, label]) => (
              <button key={t} className="secondary" onClick={() => { setReport(t); setReportOpen(true); }}>📄 {label}</button>
            ))}
          </div>
          <p className="muted">Elige un reporte para verlo en ventana emergente (imprimible).</p>
        </div>
      )}

      {tab === 'reportes' && box && reportOpen && (
        <div className="modal-backdrop report-overlay" onClick={() => setReportOpen(false)}>
          <div className="modal modal-wide modal-report" onClick={(e) => e.stopPropagation()}>
            <div className="row no-print" style={{ alignItems: 'center', marginBottom: '0.6rem' }}>
              <strong>{{ compuesto: 'Box score compuesto', situaciones: 'Situaciones', h2h: 'vs Rival (histórico)' }[report]}</strong>
              <span className="muted" style={{ fontSize: '0.75rem' }}>— para PDF elige «Guardar como PDF» en el diálogo de impresión</span>
              <span className="spacer" />
              <button onClick={() => window.print()}>🖨️ Imprimir / PDF</button>
              <button className="secondary" onClick={() => setReportOpen(false)}>✕ Cerrar</button>
            </div>

          {report === 'compuesto' && (
            <div className="report-page">
              <div className="report-header">
                <h1>{game.awayTeam?.name} @ {game.homeTeam?.name}</h1>
                <p className="muted">
                  {new Date(game.date).toLocaleDateString()}
                  {game.stadium ? ` · ${game.stadium}` : ''}
                  {game.league ? ` · ${game.league.name} ${game.league.year}` : ''}
                  {game.forfeitBy ? ' · FORFEIT' : game.tied ? ' · EMPATE' : ''}
                </p>
                {(game.umpireHp || game.umpire1b || game.umpire2b || game.umpire3b) && (
                  <p className="muted" style={{ fontSize: '0.8rem' }}>
                    Ampáyers: {[
                      game.umpireHp && `HP ${game.umpireHp}`,
                      game.umpire1b && `1B ${game.umpire1b}`,
                      game.umpire2b && `2B ${game.umpire2b}`,
                      game.umpire3b && `3B ${game.umpire3b}`,
                    ].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>

              {/* linescore con C-H-E-LOB */}
              <table className="linescore">
                <thead>
                  <tr>
                    <th>Equipo</th>
                    {Array.from({ length: Math.max(game.innings, box.linescore.away.length, box.linescore.home.length) }, (_, i) => <th key={i}>{i + 1}</th>)}
                    <th className="ls-total">C</th><th className="ls-total">H</th><th className="ls-total">E</th><th className="ls-total">LOB</th>
                  </tr>
                </thead>
                <tbody>
                  {([['away', game.awayTeam, box.linescore.away, box.lob.away], ['home', game.homeTeam, box.linescore.home, box.lob.home]] as const).map(([side, team, ls, lob]) => {
                    const tid = side === 'away' ? game.awayTeamId : game.homeTeamId;
                    const teamFld = Object.entries(fldGame).filter(([pid]) =>
                      (game.lineups ?? []).some((l) => l.playerId === pid && l.teamId === tid)
                      || (team?.players ?? []).some((p) => p.id === pid));
                    const e = teamFld.reduce((s, [, f]) => s + f.e, 0);
                    const h = Object.values(box[side]).reduce((s, b) => s + b.h, 0);
                    return (
                      <tr key={side}>
                        <td className="ls-team">{team?.name}</td>
                        {Array.from({ length: Math.max(game.innings, box.linescore.away.length, box.linescore.home.length) }, (_, i) => (
                          <td key={i}>{ls[i] ?? (i < ls.length ? 0 : '—')}</td>
                        ))}
                        <td className="ls-total"><strong>{side === 'away' ? game.state?.score.away : game.state?.score.home}</strong></td>
                        <td className="ls-total">{h}</td><td className="ls-total">{e}</td><td className="ls-total">{lob}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* bateo completo por equipo */}
              {(['away', 'home'] as const).map((side) => {
                const team = side === 'away' ? game.awayTeam : game.homeTeam;
                const tid = side === 'away' ? game.awayTeamId : game.homeTeamId;
                return (
                  <div key={side} className="report-block">
                    <h3>Bateo — {team?.name}</h3>
                    <table>
                      <thead><tr><th>Jugador</th><th>AB</th><th>R</th><th>H</th><th>CI</th><th>2B</th><th>3B</th><th>HR</th><th>BB</th><th>K</th><th>BR</th><th>SAC</th><th>SF</th><th>AVG</th></tr></thead>
                      <tbody>
                        {(game.lineups ?? [])
                          .filter((l) => l.teamId === tid && l.batsInOrder !== false)
                          .sort((a, b) => a.order - b.order)
                          .map((l) => {
                            const b = box[side][l.playerId];
                            if (!b) return null;
                            return (
                              <tr key={l.id}>
                                <td>{nameOf(l.playerId)} <span className="muted">{l.position}</span></td>
                                <td>{b.ab}</td><td>{b.r}</td><td>{b.h}</td><td>{b.rbi}</td>
                                <td>{b.doubles}</td><td>{b.triples}</td><td>{b.hr}</td>
                                <td>{b.bb}</td><td>{b.k}</td><td>{b.sb}</td><td>{b.sac}</td><td>{b.sf}</td>
                                <td>{f3(b.ab ? b.h / b.ab : 0)}</td>
                              </tr>
                            );
                          })}
                        {(() => {
                          const tot = Object.values(box[side]).reduce((a, b) => ({
                            ab: a.ab + b.ab, r: a.r + b.r, h: a.h + b.h, rbi: a.rbi + b.rbi,
                            doubles: a.doubles + b.doubles, triples: a.triples + b.triples, hr: a.hr + b.hr,
                            bb: a.bb + b.bb, k: a.k + b.k, sb: a.sb + b.sb, sac: a.sac + b.sac, sf: a.sf + b.sf,
                          }), { ab: 0, r: 0, h: 0, rbi: 0, doubles: 0, triples: 0, hr: 0, bb: 0, k: 0, sb: 0, sac: 0, sf: 0 });
                          return (
                            <tr className="total-row">
                              <td><strong>Total</strong></td>
                              <td>{tot.ab}</td><td>{tot.r}</td><td>{tot.h}</td><td>{tot.rbi}</td>
                              <td>{tot.doubles}</td><td>{tot.triples}</td><td>{tot.hr}</td>
                              <td>{tot.bb}</td><td>{tot.k}</td><td>{tot.sb}</td><td>{tot.sac}</td><td>{tot.sf}</td>
                              <td>{f3(tot.ab ? tot.h / tot.ab : 0)}</td>
                            </tr>
                          );
                        })()}
                      </tbody>
                    </table>
                  </div>
                );
              })}

              {/* pitcheo + fildeo por equipo */}
              {(['away', 'home'] as const).map((side) => {
                const team = side === 'away' ? game.awayTeam : game.homeTeam;
                const tid = side === 'away' ? game.awayTeamId : game.homeTeamId;
                const pitchers = Object.values(box.pitchers).filter((p) => teamOf(p.playerId) === tid);
                const fielders = Object.entries(fldGame).filter(([pid]) => teamOf(pid) === tid);
                if (!pitchers.length && !fielders.length) return null;
                return (
                  <div key={side} className="report-block">
                    {pitchers.length > 0 && (
                      <>
                        <h3>Pitcheo — {team?.name}</h3>
                        <table>
                          <thead><tr><th>Lanzador</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th><th>ERA</th></tr></thead>
                          <tbody>
                            {pitchers.map((p) => (
                              <tr key={p.playerId}>
                                <td>{nameOf(p.playerId)}{decisionOf(p.playerId)}</td>
                                <td>{ipStr(p.outs)}</td><td>{p.h}</td><td>{p.r}</td><td>{p.er}</td>
                                <td>{p.bb}</td><td>{p.k}</td><td>{p.hr}</td><td>{p.pitches}</td>
                                <td>{p.outs ? ((p.er * game.innings * 3) / p.outs).toFixed(2) : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                    {fielders.length > 0 && (
                      <>
                        <h3>Fildeo — {team?.name}</h3>
                        <table>
                          <thead><tr><th>Jugador</th><th>PO</th><th>A</th><th>E</th><th>TC</th><th>FPCT</th></tr></thead>
                          <tbody>
                            {fielders.sort((x, y) => (y[1].po + y[1].a + y[1].e) - (x[1].po + x[1].a + x[1].e)).map(([pid, f]) => {
                              const tc = f.po + f.a + f.e;
                              return (
                                <tr key={pid}>
                                  <td>{nameOf(pid)}</td>
                                  <td>{f.po}</td><td>{f.a}</td><td>{f.e}</td><td>{tc}</td>
                                  <td>{f3(tc ? (f.po + f.a) / tc : 1)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                );
              })}

              {/* decisiones */}
              {(game.wpId || game.lpId || game.svId || game.hldIds) && (
                <p className="muted">
                  {game.wpId && <>G: <strong>{nameOf(game.wpId)}</strong> · </>}
                  {game.lpId && <>P: <strong>{nameOf(game.lpId)}</strong> · </>}
                  {game.svId && <>SV: <strong>{nameOf(game.svId)}</strong> · </>}
                  {game.hldIds && (JSON.parse(game.hldIds) as string[]).length > 0 &&
                    <>HLD: <strong>{(JSON.parse(game.hldIds) as string[]).map(nameOf).join(', ')}</strong></>}
                </p>
              )}
            </div>
          )}

          {report === 'situaciones' && (
            <div className="report-page">
              <div className="report-header"><h1>Situaciones — {game.awayTeam?.name} @ {game.homeTeam?.name}</h1></div>
              {(['away', 'home'] as const).map((side) => {
                const team = side === 'away' ? game.awayTeam : game.homeTeam;
                const rows = Object.entries(situ[side]);
                return (
                  <div key={side} className="report-block">
                    <h3>{team?.name}</h3>
                    <table>
                      <thead><tr><th>Jugador</th><th>RISP</th><th>AVG</th><th>Bases llenas</th><th>Con 2 outs</th><th>Abriendo entrada</th></tr></thead>
                      <tbody>
                        {rows.map(([pid, s]) => (
                          <tr key={pid}>
                            <td>{nameOf(pid)}</td>
                            <td>{s.risp.h}-{s.risp.ab}</td>
                            <td>{f3(s.risp.ab ? s.risp.h / s.risp.ab : 0)}</td>
                            <td>{s.loaded.h}-{s.loaded.ab}</td>
                            <td>{s.twoOut.h}-{s.twoOut.ab}</td>
                            <td>{s.leadoff.h}-{s.leadoff.ab}</td>
                          </tr>
                        ))}
                        {!rows.length && <tr><td colSpan={6} className="muted">Sin turnos aún</td></tr>}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          )}

          {report === 'h2h' && (
            <div className="report-page">
              <div className="report-header">
                <h1>Historial — {game.awayTeam?.name} vs {game.homeTeam?.name}</h1>
                {h2h && (
                  <p className="muted">
                    Serie: <strong>{h2h.record.w}-{h2h.record.l}{h2h.record.t ? `-${h2h.record.t}` : ''}</strong>
                    {' '}para {game.awayTeam?.name} en {h2h.games.length} juego(s)
                  </p>
                )}
              </div>
              {!h2h && <p className="muted">Cargando…</p>}
              {h2h && h2h.games.length === 0 && <p className="muted">Nunca se han enfrentado (juegos finalizados).</p>}
              {h2h && h2h.games.length > 0 && (
                <>
                  <table>
                    <thead><tr><th>Fecha</th><th>{game.awayTeam?.name}</th><th>{game.homeTeam?.name}</th></tr></thead>
                    <tbody>
                      {h2h.games.map((g) => (
                        <tr key={g.id}>
                          <td>{new Date(g.date).toLocaleDateString()}</td>
                          <td><strong>{g.aScore}</strong></td>
                          <td><strong>{g.bScore}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {([['A', game.awayTeam, h2h.battingA, h2h.pitchingA], ['B', game.homeTeam, h2h.battingB, h2h.pitchingB]] as const).map(([k, team, bat, pit]) => (
                    <div key={k} className="report-block">
                      <h3>Bateo histórico — {team?.name}</h3>
                      <table>
                        <thead><tr><th>Jugador</th><th>PA</th><th>AB</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>AVG</th><th>OBP</th><th>SLG</th></tr></thead>
                        <tbody>
                          {bat.map((m) => (
                            <tr key={m.id}>
                              <td>{m.name}</td><td>{m.pa}</td><td>{m.ab}</td><td>{m.h}</td>
                              <td>{m.doubles}</td><td>{m.triples}</td><td>{m.hr}</td>
                              <td>{m.rbi}</td><td>{m.bb}</td><td>{m.k}</td>
                              <td>{f3(m.avg)}</td><td>{f3(m.obp)}</td><td>{f3(m.slg)}</td>
                            </tr>
                          ))}
                          {!bat.length && <tr><td colSpan={13} className="muted">Sin datos</td></tr>}
                        </tbody>
                      </table>
                      {pit.length > 0 && (
                        <>
                          <h3>Pitcheo histórico — {team?.name}</h3>
                          <table>
                            <thead><tr><th>Lanzador</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th></tr></thead>
                            <tbody>
                              {pit.map((p) => (
                                <tr key={p.playerId}>
                                  <td>{p.name}</td><td>{ipStr(p.outs)}</td><td>{p.h}</td><td>{p.r}</td>
                                  <td>{p.er}</td><td>{p.bb}</td><td>{p.k}</td><td>{p.hr}</td><td>{p.pitches}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
          </div>
        </div>
      )}

      {cardPlayerId && (
        <PlayerCardModal gameId={game.id} playerId={cardPlayerId} onClose={() => setCardPlayerId(null)} />
      )}
      {printCard && <LineupCard game={game} nameOf={nameOf} onClose={() => setPrintCard(false)} />}
      {showShare && <ShareModal game={game} onClose={() => setShowShare(false)} />}
      {showPbp && (
        <div className="modal-backdrop" onClick={() => setShowPbp(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <h2>📋 Jugada a jugada</h2>
            {!pbp ? <p className="muted">Generando…</p> : (
              <>
                <pre className="share-text" style={{ maxHeight: '50vh', overflowY: 'auto' }}>{pbp.playByPlay}</pre>
                <button className="secondary sm" onClick={() => navigator.clipboard?.writeText(pbp.playByPlay)}>📋 Copiar texto</button>
              </>
            )}
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.6rem' }}>
              <button className="secondary" onClick={() => setShowPbp(false)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
      {showDel && (
        <PassModal
          title="Borrar juego"
          message={`Se eliminará ${game.awayTeam?.name ?? '?'} @ ${game.homeTeam?.name ?? '?'} del ${new Date(game.date).toLocaleDateString()} con todas sus jugadas y estadísticas. No se puede deshacer.`}
          onClose={() => setShowDel(false)}
          onDone={async (password) => {
            await api.deleteGame(game.id, password);
            nav(game.leagueId ? `/leagues/${game.leagueId}` : '/juegos');
          }}
        />
      )}
    </div>
  );
}
