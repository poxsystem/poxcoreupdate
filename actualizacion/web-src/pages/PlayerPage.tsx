import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, PlayerFull, PlayerMatchups, PlayerSplits, PlayerSpray, PitchLoc, MatchupLine, PlayerBattingLine, PlayerPitchingLine, PlayerFieldingLine, YearBlock, SeasonStat, Team, TournamentBlock } from '../api';
import PlayerAvatar from '../components/PlayerAvatar';
import SprayChart from '../components/SprayChart';
import ZoneChart from '../components/ZoneChart';

const f3 = (n?: number) => (n ?? 0).toFixed(3).replace(/^0/, '');
const ipOf = (outs: number) => `${Math.floor(outs / 3)}.${outs % 3}`;
const batsOf = (b?: string | null) => (b === 'L' ? 'Zurdo' : b === 'S' ? 'Ambidiestro' : 'Derecho');
const monthName = (ym: string) => new Date(`${ym}-01T12:00:00`).toLocaleDateString('es', { month: 'long', year: 'numeric' });

type Tab = 'torneos' | 'temporadas' | 'matchups' | 'juegos' | 'splits' | 'spray';

// trayectoria por temporada: TIG 2022, TIG 2023 → "Tigres 2022–23"; cambio de equipo o salto de año → nuevo segmento
function stintSegments(stints: { teamId: string; team: string; year?: number }[], teams: { id: string; name: string }[]) {
  const segs: { teamId: string; name: string; from: number; to: number }[] = [];
  for (const st of stints) {
    const y = st.year ?? 0;
    const last = segs[segs.length - 1];
    if (last && last.teamId === st.teamId && y && y === last.to + 1) last.to = y;
    else segs.push({ teamId: st.teamId, name: teams.find((x) => x.id === st.teamId)?.name ?? st.team, from: y, to: y });
  }
  return segs;
}

function BatTable({ line: b }: { line: PlayerBattingLine }) {
  return (
    <table className="summary-table">
      <thead><tr><th>G</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
      <tbody><tr>
        <td>{b.g}</td><td>{b.pa}</td><td>{b.ab}</td><td>{b.r}</td><td>{b.h}</td>
        <td>{b.doubles}</td><td>{b.triples}</td><td>{b.hr}</td><td>{b.rbi}</td>
        <td>{b.bb}</td><td>{b.k}</td><td>{b.sb}</td>
        <td><strong>{f3(b.avg)}</strong></td><td>{f3(b.obp)}</td><td>{f3(b.slg)}</td><td>{f3(b.ops)}</td>
      </tr></tbody>
    </table>
  );
}

function PitTable({ line: p }: { line: PlayerPitchingLine }) {
  return (
    <table className="summary-table">
      <thead><tr><th>G</th><th>GS</th><th>W-L</th><th>SV</th><th>HLD</th><th>CG</th><th>SHO</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th><th>ERA</th><th>WHIP</th></tr></thead>
      <tbody><tr>
        <td>{p.gp}</td><td>{p.gs ?? 0}</td><td><strong>{(p.w ?? 0)}-{(p.l ?? 0)}</strong></td>
        <td>{p.sv ?? 0}</td><td>{p.hld ?? 0}</td><td>{p.cg ?? 0}</td><td>{p.sho ?? 0}</td>
        <td>{ipOf(p.outs)}</td><td>{p.h}</td><td>{p.r}</td>
        <td>{p.er}</td><td>{p.bb}</td><td>{p.k}</td><td>{p.hr}</td>
        <td>{p.pitches ?? 0}</td><td><strong>{(p.era ?? 0).toFixed(2)}</strong></td><td>{(p.whip ?? 0).toFixed(2)}</td>
      </tr></tbody>
    </table>
  );
}

function FldLine({ f }: { f: PlayerFieldingLine }) {
  if (f.tc <= 0) return null;
  return (
    <p className="muted" style={{ fontSize: '0.82rem', margin: '0.3rem 0 0' }}>
      Fildeo: {f.po} PO · {f.a} A · {f.e} E · FPCT {f3(f.fpct)}
    </p>
  );
}

// bloque de una temporada dentro de una liga multi-año: año + equipo + sus stats completas
function YearCard({ y, disc, hi }: { y: YearBlock; disc: 'bat' | 'pit'; hi: boolean }) {
  return (
    <div className={`yr-block${hi ? ' yr-hi' : ''}`}>
      <div className="yr-head">
        <strong>{y.year}</strong>
        <span className="muted">{y.teams.map((x) => x.shortName ?? x.name).join(' → ') || '—'}</span>
      </div>
      {disc === 'bat' ? <BatTable line={y.batting} /> : <PitTable line={y.pitching} />}
      <FldLine f={y.fielding} />
    </div>
  );
}

function MatchupTable({ title, rows }: { title: string; rows: MatchupLine[] }) {
  if (!rows.length) return null;
  return (
    <>
      <div className="section-label">{title}</div>
      <table className="summary-table">
        <thead><tr><th>Contra</th><th>PA</th><th>AB</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.pa}</td><td>{r.ab}</td><td>{r.h}</td><td>{r.doubles}</td><td>{r.triples}</td><td>{r.hr}</td>
              <td>{r.rbi}</td><td>{r.bb}</td><td>{r.k}</td>
              <td><strong>{f3(r.avg)}</strong></td><td>{f3(r.obp)}</td><td>{f3(r.slg)}</td><td>{f3(r.ops)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export default function PlayerPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState<PlayerFull | null>(null);
  const [matchups, setMatchups] = useState<PlayerMatchups | null>(null);
  const [splits, setSplits] = useState<PlayerSplits | null>(null);
  const [spray, setSpray] = useState<PlayerSpray | null>(null);
  const [pitchLoc, setPitchLoc] = useState<PitchLoc | null>(null);
  const [sprayHitsOnly, setSprayHitsOnly] = useState(false);
  const [tab, setTab] = useState<Tab>('torneos');
  const [disc, setDisc] = useState<'bat' | 'pit' | null>(null); // disciplina mostrada (null = auto)
  const [yearSel, setYearSel] = useState<number | 'all' | null>(null); // null = año más reciente
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [splitSel, setSplitSel] = useState('n:10');
  const [error, setError] = useState('');
  // edición manual del acumulado de temporada (correcciones post-import, etc.)
  const [editSeason, setEditSeason] = useState<SeasonStat | null>(null);
  const [editVals, setEditVals] = useState<Record<string, string>>({});
  const [savingStats, setSavingStats] = useState(false);
  const [statsMsg, setStatsMsg] = useState('');
  // cambio de equipo / baja desde la tarjeta
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTo, setMoveTo] = useState('');
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [busyAdmin, setBusyAdmin] = useState(false);
  const [moveReactivate, setMoveReactivate] = useState(true);

  useEffect(() => {
    if (!id) return;
    api.playerFull(id).then(setData).catch((e) => setError(e.message));
    api.playerSpray(id).then(setSpray).catch(() => {});
    api.playerPitchLoc(id).then(setPitchLoc).catch(() => {});
  }, [id]);

  // matchups y splits se agregan en el servidor → re-pedir al cambiar de año
  // (availYears/effYear viven abajo, tras el early-return de bloqueado — el
  // efecto usa data.tournaments solo cuando data llega completa)
  const availYears = data?.tournaments ? [...new Set([
    ...data.seasons.map((s) => s.season),
    ...data.tournaments.flatMap((t) => t.log.map((g) => (g.date ? new Date(g.date).getFullYear() : 0))),
    ...(spray?.points.map((p) => p.season) ?? []),
    ...(pitchLoc?.points.map((p) => p.season) ?? []),
  ])].filter((y) => y > 0).sort((a, b) => b - a) : [] as number[];
  const effYear = (yearSel !== null && (yearSel === 'all' || availYears.includes(yearSel)) ? yearSel : availYears[0]) ?? ('all' as const);
  const inYear = (d?: string) => effYear === 'all' || (d ? new Date(d).getFullYear() === effYear : false);

  useEffect(() => {
    if (!id || !data || data.blocked) return;
    setMatchups(null); setSplits(null); setSplitSel('n:10');
    api.playerMatchups(id, effYear).then(setMatchups).catch(() => {});
    api.playerSplits(id, effYear).then(setSplits).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, effYear, data]);

  if (!data) return <p>{error || 'Cargando…'}</p>;
  // excluido de la publicación: el perfil existe pero dice BLOQUEADO y sus números van tapados
  if (data.blocked) {
    return (
      <div className="page">
        <div className="card admin-denied">
          <div className="passicon">🔒</div>
          <h2>{data.name ?? 'JUGADOR BLOQUEADO'}</h2>
          <p className="muted">{data.teamName ?? ''}</p>
          <p>
            <span className="blk">██</span> <span className="blk">██</span> <span className="blk">██</span>{' '}
            <span className="blk">██</span> <span className="blk">██</span>
          </p>
          <p className="muted">Este jugador fue bloqueado de la publicación. Sus datos siguen en el sistema y vuelven a verse al reactivarlo.</p>
        </div>
      </div>
    );
  }
  const p = data.player;

  // ---- edición manual de temporada ----
  const EDIT_FIELDS: { key: string; label: string; sec: 'Bateo' | 'Pitcheo' | 'Fildeo' }[] = [
    { key: 'g', label: 'J', sec: 'Bateo' }, { key: 'pa', label: 'PA', sec: 'Bateo' }, { key: 'ab', label: 'AB', sec: 'Bateo' },
    { key: 'r', label: 'C', sec: 'Bateo' }, { key: 'h', label: 'H', sec: 'Bateo' }, { key: 'doubles', label: '2B', sec: 'Bateo' },
    { key: 'triples', label: '3B', sec: 'Bateo' }, { key: 'hr', label: 'HR', sec: 'Bateo' }, { key: 'rbi', label: 'CI', sec: 'Bateo' },
    { key: 'bb', label: 'BB', sec: 'Bateo' }, { key: 'k', label: 'K', sec: 'Bateo' }, { key: 'hbp', label: 'HBP', sec: 'Bateo' },
    { key: 'sac', label: 'SAC', sec: 'Bateo' }, { key: 'sf', label: 'SF', sec: 'Bateo' }, { key: 'sb', label: 'BR', sec: 'Bateo' },
    { key: 'gp', label: 'G', sec: 'Pitcheo' }, { key: 'gs', label: 'GS', sec: 'Pitcheo' }, { key: 'w', label: 'W', sec: 'Pitcheo' },
    { key: 'l', label: 'L', sec: 'Pitcheo' }, { key: 'sv', label: 'SV', sec: 'Pitcheo' }, { key: 'hld', label: 'HLD', sec: 'Pitcheo' },
    { key: 'bs', label: 'BS', sec: 'Pitcheo' }, { key: 'cg', label: 'CG', sec: 'Pitcheo' }, { key: 'sho', label: 'SHO', sec: 'Pitcheo' },
    { key: 'ip', label: 'IP', sec: 'Pitcheo' }, { key: 'pH', label: 'H', sec: 'Pitcheo' }, { key: 'pR', label: 'C', sec: 'Pitcheo' },
    { key: 'pER', label: 'CL', sec: 'Pitcheo' }, { key: 'pBB', label: 'BB', sec: 'Pitcheo' }, { key: 'pK', label: 'K', sec: 'Pitcheo' },
    { key: 'pHR', label: 'HR', sec: 'Pitcheo' }, { key: 'pPitches', label: 'Pit', sec: 'Pitcheo' },
    { key: 'e', label: 'E', sec: 'Fildeo' },
  ];
  const openEditStats = (s: SeasonStat) => {
    const vals: Record<string, string> = {};
    for (const f of EDIT_FIELDS) {
      if (f.key === 'ip') vals.ip = ipOf(s.pOuts);
      else vals[f.key] = String((s as unknown as Record<string, number>)[f.key] ?? 0);
    }
    setEditVals(vals);
    setEditSeason(s);
    setStatsMsg('');
  };
  const saveStats = async () => {
    if (!editSeason || !id) return;
    setSavingStats(true); setStatsMsg('');
    try {
      const body: Record<string, unknown> = { season: editSeason.season, scope: editSeason.scope ?? 'REG' };
      for (const [k, v] of Object.entries(editVals)) {
        const n = parseFloat(v);
        if (v.trim() !== '' && Number.isFinite(n)) body[k] = n;
      }
      await api.updatePlayerSeason(id, body as { season: number; scope?: string } & Record<string, number>);
      setEditSeason(null);
      setStatsMsg('✔ Stats actualizados');
      setTimeout(() => setStatsMsg(''), 4000);
      await api.playerFull(id).then(setData); // recargar tarjeta
    } catch (e) { setStatsMsg((e as Error).message); }
    setSavingStats(false);
  };
  // botón del encabezado: edita la temporada del año seleccionado (crea la fila si no existe)
  const openEditCurrent = () => {
    const yr = effYear === 'all' ? availYears[0] : effYear;
    const s = data.seasons.find((x) => x.season === yr && (x.scope ?? 'REG') === 'REG')
      ?? data.seasons.find((x) => (x.scope ?? 'REG') === 'REG');
    if (s) { openEditStats(s); return; }
    const blank = {
      id: '', playerId: id!, season: yr ?? new Date().getFullYear(), scope: 'REG',
      g: 0, pa: 0, ab: 0, r: 0, h: 0, doubles: 0, triples: 0, hr: 0, rbi: 0, bb: 0, k: 0,
      hbp: 0, sac: 0, sf: 0, sb: 0, gp: 0, gs: 0, w: 0, l: 0, sv: 0, hld: 0, bs: 0, cg: 0,
      sho: 0, pOuts: 0, pH: 0, pR: 0, pER: 0, pBB: 0, pK: 0, pHR: 0, pPitches: 0, e: 0,
    } as SeasonStat;
    openEditStats(blank);
  };

  // etapas por equipo dentro de una temporada — alimentan el desglose
  // "logró en cada equipo + total" del tab Temporadas (traspasos a mitad de año)
  const stintsOf = (s: SeasonStat) => {
    const scope = s.scope ?? 'REG';
    type St = TournamentBlock['stints'][number];
    const map = new Map<string, St>();
    const add = (st: St) => {
      let cur = map.get(st.teamId);
      if (!cur) {
        cur = {
          teamId: st.teamId, team: st.team, year: st.year, g: 0,
          batting: { ...st.batting, pa: 0, ab: 0, r: 0, h: 0, doubles: 0, triples: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sac: 0, sf: 0, sb: 0 },
          pitching: { ...st.pitching, gp: 0, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0, pitches: 0 },
          fielding: { ...st.fielding, po: 0, a: 0, e: 0 },
        } as St;
        map.set(st.teamId, cur);
      }
      cur.g += st.g;
      const cb = cur.batting as unknown as Record<string, number>;
      for (const k of ['pa', 'ab', 'r', 'h', 'doubles', 'triples', 'hr', 'rbi', 'bb', 'k', 'hbp', 'sac', 'sf', 'sb'] as const) cb[k] += st.batting[k] ?? 0;
      const cp = cur.pitching as unknown as Record<string, number>;
      for (const k of ['gp', 'outs', 'h', 'r', 'er', 'bb', 'k', 'hr', 'pitches'] as const) cp[k] += st.pitching[k] ?? 0;
      cur.fielding.po += st.fielding.po; cur.fielding.a += st.fielding.a; cur.fielding.e += st.fielding.e;
    };
    for (const t of data.tournaments) {
      if (scope === 'POST') { for (const st of t.playoff?.stints ?? []) if (st.year === s.season) add(st); }
      else for (const y of t.byYear ?? []) if (y.year === s.season) for (const st of y.stints ?? []) add(st);
    }
    return [...map.values()];
  };

  // cambio de equipo: conserva el playerId → stats e historial lo siguen.
  // Si está BAJA puede reactivarse de una vez en el equipo destino (caso:
  // jugador de una temporada atrasada que vuelve a la liga en otro equipo)
  const saveMove = async () => {
    if (!p.teamId || !moveTo) return;
    setBusyAdmin(true);
    try {
      await api.updatePlayer(p.teamId, p.id, { teamId: moveTo, ...(p.active ? {} : { active: moveReactivate }) });
      setMoveOpen(false); setMoveTo('');
      const d = await api.playerFull(id!); setData(d);
    } finally { setBusyAdmin(false); }
  };
  // baja/alta del roster — conserva todo el historial
  const toggleActive = async () => {
    if (!p.teamId) return;
    if (p.active && !confirm(`¿Dar de baja a ${p.firstName} ${p.lastName}? Conserva sus stats; puedes reactivarlo luego.`)) return;
    setBusyAdmin(true);
    try {
      await api.updatePlayer(p.teamId, p.id, { active: !p.active });
      const d = await api.playerFull(id!); setData(d);
    } finally { setBusyAdmin(false); }
  };

  // ¿batea Y lanza? → mostrar el interruptor Bateo/Pitcheo (como B-Ref separa las páginas)
  const hasPit = data.tournaments.some((t) =>
    (t.pitching.gp ?? 0) > 0 || (t.byYear ?? []).some((y) => (y.pitching.gp ?? 0) > 0) || (t.playoff?.pitching.gp ?? 0) > 0)
    || data.seasons.some((s) => s.pOuts > 0);
  const hasBat = data.tournaments.some((t) => t.batting.pa > 0 || (t.byYear ?? []).some((y) => y.batting.pa > 0))
    || data.seasons.some((s) => s.pa > 0 || s.ab > 0);
  const effDisc = disc ?? (hasPit && !hasBat ? 'pit' : 'bat');
  const eraBase = data.tournaments[0]?.sport === 'softball' ? 21 : 27; // ERA según entradas del deporte

  return (
    <div>
      <p className="no-print" style={{ margin: '0 0 0.3rem' }}>
        <button
          className="linklike"
          onClick={() => ((window.history.state?.idx ?? 0) > 0 ? nav(-1) : nav(p.teamId ? `/teams/${p.teamId}` : '/teams'))}
        >
          ← Volver{p.team?.name ? ` a ${p.team.name}` : ''}
        </button>
      </p>
      <div className="row no-print" style={{ alignItems: 'center' }}>
        <PlayerAvatar player={p} size={72} />
        <h1 style={{ margin: 0, textTransform: 'uppercase', fontSize: '2rem', letterSpacing: '0.02em' }}>
          {p.number ? `#${p.number} ` : ''}{p.firstName} {p.lastName}
        </h1>
        <span className="muted">{p.team?.name ?? 'Sin equipo'}</span>
        {!p.active && <span className="pill final">BAJA</span>}
        <span className="spacer" />
        <button onClick={openEditCurrent}>✏️ Editar stats</button>
        <button className="secondary" disabled={busyAdmin}
          onClick={() => { setMoveOpen(true); setMoveTo(''); api.teams().then(setAllTeams).catch(() => {}); }}>
          ↔ Cambiar equipo
        </button>
        <button className={p.active ? 'secondary' : ''} disabled={busyAdmin} onClick={toggleActive}
          title={p.active ? 'Dar de baja (conserva historial)' : 'Reactivar en el roster'}>
          {p.active ? '⛔ Dar de baja' : '✓ Reactivar'}
        </button>
        <button className="secondary" onClick={() => window.print()}>🖨 Imprimir tarjeta</button>
      </div>
      <p className="muted" style={{ marginTop: 2 }}>
        Batea: {batsOf(p.bats)} · Tira: {p.throws === 'L' ? 'Zurdo' : 'Derecho'} · Pos: {p.positions || '—'}
      </p>

      <div className="row no-print" style={{ gap: '0.3rem', margin: '0.8rem 0' }}>
        {([['torneos', 'Por torneo'], ['temporadas', 'Por año'], ['matchups', 'Matchups'], ['splits', '⏱ Splits/Rachas'], ['juegos', 'Juego a juego'], ['spray', '📍 Spray']] as [Tab, string][]).map(([t, l]) => (
          <button key={t} className={tab === t ? '' : 'secondary'} onClick={() => setTab(t)}>{l}</button>
        ))}
        {hasPit && hasBat && (
          <span className="row" style={{ gap: '0.3rem', marginLeft: '0.8rem', borderLeft: '1px solid var(--border)', paddingLeft: '0.8rem' }}>
            <button className={effDisc === 'bat' ? '' : 'secondary'} onClick={() => setDisc('bat')}>🏏 Bateo</button>
            <button className={effDisc === 'pit' ? '' : 'secondary'} onClick={() => setDisc('pit')}>⚾ Pitcheo</button>
          </span>
        )}
      </div>

      {availYears.length > 1 && (
        <div className="row no-print" style={{ gap: '0.3rem', margin: '-0.3rem 0 0.8rem', alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: '0.8rem' }}>Año:</span>
          <button className={effYear === 'all' ? '' : 'secondary'} onClick={() => setYearSel('all')}>Todos</button>
          {availYears.map((y) => (
            <button key={y} className={effYear === y ? '' : 'secondary'} onClick={() => setYearSel(y)}>{y}</button>
          ))}
        </div>
      )}

      {/* ---- Por torneo (año tras año estilo MLB) — siempre en la versión impresa ---- */}
      {(
        <div className={tab === 'torneos' ? '' : 'print-only'}>
          {data.tournaments.map((t) => (
            <div className="card" key={t.leagueId}>
              <div className="row" style={{ alignItems: 'baseline' }}>
                <h2 style={{ margin: 0 }}>
                  <Link to={`/leagues/${t.leagueId}`} className="no-print">{t.league}</Link>
                  <span className="print-only-inline">{t.league}</span>{' '}
                  {(t.byYear?.length ?? 0) > 1
                    ? `${t.byYear![t.byYear!.length - 1].year}–${t.byYear![0].year}`
                    : t.year}
                </h2>
                <span className="muted">{t.sport === 'softball' ? '🥎' : '⚾'}</span>
                <span className="spacer" />
                <button className="secondary icon no-print" onClick={() => setOpenLog(openLog === t.leagueId ? null : t.leagueId)}>
                  {openLog === t.leagueId ? 'Ocultar log' : 'Juego a juego'}
                </button>
              </div>
              {(() => {
                const multiYr = (t.byYear?.length ?? 0) > 1;
                const segs = stintSegments(t.stints ?? [], t.teams ?? []);
                if (!segs.length) return null;
                return (
                  <p className="muted" style={{ margin: '0.15rem 0 0.5rem', fontSize: '0.85rem' }}>
                    {multiYr ? 'Trayectoria: ' : segs.length > 1 ? 'Equipos: ' : 'Equipo: '}
                    {segs.map((sg, i) => (
                      <span key={`${sg.teamId}-${sg.from}`}>
                        {i > 0 && ' → '}
                        <Link to={`/teams/${sg.teamId}`} className="no-print">{sg.name}</Link>
                        <span className="print-only-inline">{sg.name}</span>
                        {multiYr && sg.from > 0 && ` (${sg.from === sg.to ? sg.from : `${sg.from}–${String(sg.to).slice(2)}`})`}
                      </span>
                    ))}
                  </p>
                );
              })()}
              {/* liga multi-temporada: cada año es su propia temporada con todas sus stats */}
              {(t.byYear?.length ?? 0) > 1 && (
                <>
                  <div className="section-label">Por temporada</div>
                  {t.byYear!.map((y) => <YearCard key={y.year} y={y} disc={effDisc} hi={y.year === effYear} />)}
                </>
              )}
              {/* stints por equipo+temporada — solo si un año tuvo >1 equipo (traspaso a media temporada) */}
              {effDisc === 'bat' && (t.stints?.length ?? 0) > (t.byYear?.length ?? 1) && (
                <table className="summary-table" style={{ marginTop: '0.4rem' }}>
                  <thead><tr>{(t.byYear?.length ?? 0) > 1 && <th>Año</th>}<th>Eq</th><th>G</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th></tr></thead>
                  <tbody>
                    {t.stints.map((st) => (
                      <tr key={`${st.teamId}-${st.year}`}>
                        {(t.byYear?.length ?? 0) > 1 && <td><strong>{st.year}</strong></td>}
                        <td><strong>{st.team}</strong></td>
                        <td>{st.g}</td><td>{st.batting.pa}</td><td>{st.batting.ab}</td><td>{st.batting.r}</td>
                        <td>{st.batting.h}</td><td>{st.batting.doubles}</td><td>{st.batting.triples}</td><td>{st.batting.hr}</td>
                        <td>{st.batting.rbi}</td><td>{st.batting.bb}</td><td>{st.batting.k}</td><td>{st.batting.sb}</td>
                        <td><strong>{f3(st.batting.avg)}</strong></td>
                      </tr>
                    ))}
                    <tr className="muted">
                      <td colSpan={(t.byYear?.length ?? 0) > 1 ? 2 : 1}><strong>TOT</strong></td>
                      <td>{t.batting.g}</td><td>{t.batting.pa}</td><td>{t.batting.ab}</td><td>{t.batting.r}</td>
                      <td>{t.batting.h}</td><td>{t.batting.doubles}</td><td>{t.batting.triples}</td><td>{t.batting.hr}</td>
                      <td>{t.batting.rbi}</td><td>{t.batting.bb}</td><td>{t.batting.k}</td><td>{t.batting.sb}</td>
                      <td><strong>{f3(t.batting.avg)}</strong></td>
                    </tr>
                  </tbody>
                </table>
              )}
              {effDisc === 'pit' && (t.stints?.filter((st) => (st.pitching.gp ?? 0) > 0).length ?? 0) > (t.byYear?.length ?? 1) && (
                <table className="summary-table" style={{ marginTop: '0.4rem' }}>
                  <thead><tr>{(t.byYear?.length ?? 0) > 1 && <th>Año</th>}<th>Eq</th><th>G</th><th>W-L</th><th>SV</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>ERA</th><th>WHIP</th></tr></thead>
                  <tbody>
                    {t.stints.filter((st) => (st.pitching.gp ?? 0) > 0).map((st) => (
                      <tr key={`${st.teamId}-${st.year}`}>
                        {(t.byYear?.length ?? 0) > 1 && <td><strong>{st.year}</strong></td>}
                        <td><strong>{st.team}</strong></td>
                        <td>{st.pitching.gp}</td><td><strong>{(st.pitching.w ?? 0)}-{(st.pitching.l ?? 0)}</strong></td>
                        <td>{st.pitching.sv ?? 0}</td><td>{ipOf(st.pitching.outs)}</td><td>{st.pitching.h}</td>
                        <td>{st.pitching.r}</td><td>{st.pitching.er}</td><td>{st.pitching.bb}</td><td>{st.pitching.k}</td>
                        <td>{st.pitching.hr}</td><td><strong>{(st.pitching.era ?? 0).toFixed(2)}</strong></td><td>{(st.pitching.whip ?? 0).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {(t.byYear?.length ?? 0) > 1 && <div className="section-label" style={{ marginTop: '0.5rem' }}>Total en la liga</div>}
              {effDisc === 'bat' ? <BatTable line={t.batting} /> : <PitTable line={t.pitching} />}
              <FldLine f={t.fielding} />

              {/* postemporada — separada de la temporada regular */}
              {t.playoff && (
                <div style={{ marginTop: '0.7rem', borderTop: '2px solid var(--gold)', paddingTop: '0.4rem' }}>
                  <p style={{ margin: '0 0 0.3rem' }}><span className="pill live">🏆 POSTEMPORADA</span>
                    <span className="muted" style={{ fontSize: '0.8rem', marginLeft: 6 }}>
                      {t.playoff.teams.map((x) => x.shortName ?? x.name).join(' → ')}
                    </span></p>
                  {effDisc === 'bat' ? <BatTable line={t.playoff.batting} /> : <PitTable line={t.playoff.pitching} />}
                  <FldLine f={t.playoff.fielding} />
                </div>
              )}
              {openLog === t.leagueId && (
                <table className="summary-table no-print" style={{ marginTop: '0.4rem' }}>
                  <thead><tr><th>Fecha</th>{t.teams?.length > 1 && <th>Eq</th>}<th>vs</th><th>AB</th><th>R</th><th>H</th><th>CI</th><th>BB</th><th>K</th><th>IP(pitch)</th><th>C</th><th>CL</th><th>K</th><th>Dec</th></tr></thead>
                  <tbody>
                    {!t.log.some((g) => inYear(g.date)) && <tr><td colSpan={13} className="muted">Sin juegos en {effYear}</td></tr>}
                    {t.log.filter((g) => inYear(g.date)).map((g) => (
                      <tr key={g.gameId}>
                        <td>{g.date ? new Date(g.date).toLocaleDateString() : '—'}</td>
                        {t.teams?.length > 1 && <td><strong>{g.team ?? '—'}</strong></td>}
                        <td><Link to={`/games/${g.gameId}`}>{g.vs}</Link></td>
                        <td>{g.batting?.ab ?? '—'}</td><td>{g.batting?.r ?? '—'}</td><td>{g.batting?.h ?? '—'}</td>
                        <td>{g.batting?.rbi ?? '—'}</td><td>{g.batting?.bb ?? '—'}</td><td>{g.batting?.k ?? '—'}</td>
                        <td>{g.pitching ? ipOf(g.pitching.outs) : '—'}</td>
                        <td>{g.pitching?.r ?? '—'}</td><td>{g.pitching?.er ?? '—'}</td><td>{g.pitching?.k ?? '—'}</td>
                        <td>{g.pitching ? [g.pitching.w ? 'G' : '', g.pitching.l ? 'P' : '', g.pitching.sv ? 'JS' : '', g.pitching.hld ? 'HLD' : ''].filter(Boolean).join('/') || '—' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
          {!data.tournaments.length && <p className="muted">Sin torneos finalizados aún.</p>}
        </div>
      )}

      {/* ---- Por año (acumulado oficial de temporada) — columnas según Bateo/Pitcheo ---- */}
      {tab === 'temporadas' && (
        <div className="card">
          <h2>Temporadas — {effDisc === 'bat' ? 'bateo' : 'pitcheo'} <span className="muted" style={{ fontSize: '0.8rem', fontWeight: 400 }}>✏️ = editar acumulado (correcciones)</span></h2>
          {statsMsg && <p style={{ margin: '0 0 6px' }}>{statsMsg}</p>}
          <table className="summary-table">
            {effDisc === 'bat' ? (
              <>
                <thead><tr><th>Año</th><th>Equipos</th><th>G</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th><th>E</th><th></th></tr></thead>
                <tbody>
                  {data.seasons.map((s) => {
                    // traspaso a mitad de temporada: una fila por equipo + la fila TOT debajo
                    const sts = stintsOf(s).filter((x) => x.g > 0 || x.batting.pa > 0);
                    const multi = sts.length > 1;
                    return (
                      <Fragment key={s.id}>
                        {multi && sts.map((st) => (
                          <tr key={st.teamId} className="stint-sub">
                            <td className="muted" style={{ paddingLeft: '1.1rem' }}>{s.season}</td>
                            <td><strong>{st.team}</strong></td>
                            <td>{st.g}</td><td>{st.batting.pa}</td><td>{st.batting.ab}</td><td>{st.batting.r}</td>
                            <td>{st.batting.h}</td><td>{st.batting.doubles}</td><td>{st.batting.triples}</td>
                            <td>{st.batting.hr}</td><td>{st.batting.rbi}</td><td>{st.batting.bb}</td>
                            <td>{st.batting.k}</td><td>{st.batting.sb}</td>
                            <td>{f3(st.batting.ab ? st.batting.h / st.batting.ab : 0)}</td><td>{st.fielding.e}</td><td></td>
                          </tr>
                        ))}
                        <tr className={multi ? 'stint-tot' : undefined}>
                          <td><strong>{s.season}</strong>{s.scope === 'POST' && <span className="pill live" style={{ marginLeft: 4, fontSize: '0.62rem' }}>🏆 POST</span>}</td>
                          <td className="muted">{multi ? <strong style={{ color: 'var(--navy)' }}>TOTAL</strong> : (s.teams ?? []).join(' → ') || '—'}</td>
                          <td>{s.g}</td><td>{s.pa}</td><td>{s.ab}</td><td>{s.r}</td><td>{s.h}</td><td>{s.doubles}</td><td>{s.triples}</td>
                          <td>{s.hr}</td><td>{s.rbi}</td><td>{s.bb}</td><td>{s.k}</td><td>{s.sb}</td>
                          <td><strong>{f3(s.ab ? s.h / s.ab : 0)}</strong></td><td>{s.e}</td>
                          <td className="no-print"><button className="linklike" title="Editar acumulado" onClick={() => openEditStats(s)}>✏️</button></td>
                        </tr>
                      </Fragment>
                    );
                  })}
                  {!data.seasons.length && <tr><td colSpan={17} className="muted">Sin temporadas acumuladas</td></tr>}
                </tbody>
              </>
            ) : (
              <>
                <thead><tr><th>Año</th><th>Equipos</th><th>G</th><th>GS</th><th>W-L</th><th>SV</th><th>HLD</th><th>CG</th><th>SHO</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>ERA</th><th>WHIP</th><th>E</th><th></th></tr></thead>
                <tbody>
                  {data.seasons.map((s) => {
                    const sts = stintsOf(s).filter((x) => (x.pitching.gp ?? 0) > 0 || x.pitching.outs > 0);
                    const multi = sts.length > 1;
                    return (
                      <Fragment key={s.id}>
                        {multi && sts.map((st) => (
                          <tr key={st.teamId} className="stint-sub">
                            <td className="muted" style={{ paddingLeft: '1.1rem' }}>{s.season}</td>
                            <td><strong>{st.team}</strong></td>
                            <td>{st.pitching.gp}</td><td>·</td><td>·</td><td>·</td><td>·</td><td>·</td><td>·</td>
                            <td>{ipOf(st.pitching.outs)}</td><td>{st.pitching.h}</td><td>{st.pitching.r}</td>
                            <td>{st.pitching.er}</td><td>{st.pitching.bb}</td><td>{st.pitching.k}</td><td>{st.pitching.hr}</td>
                            <td>{st.pitching.outs ? ((st.pitching.er * eraBase) / st.pitching.outs).toFixed(2) : '—'}</td>
                            <td>{st.pitching.outs ? (((st.pitching.h + st.pitching.bb) * 3) / st.pitching.outs).toFixed(2) : '—'}</td>
                            <td>{st.fielding.e}</td><td></td>
                          </tr>
                        ))}
                        <tr className={multi ? 'stint-tot' : undefined}>
                          <td><strong>{s.season}</strong>{s.scope === 'POST' && <span className="pill live" style={{ marginLeft: 4, fontSize: '0.62rem' }}>🏆 POST</span>}</td>
                          <td className="muted">{multi ? <strong style={{ color: 'var(--navy)' }}>TOTAL</strong> : (s.teams ?? []).join(' → ') || '—'}</td>
                          <td>{s.gp}</td><td>{s.gs}</td><td>{s.w}-{s.l}</td><td>{s.sv}</td><td>{s.hld}</td><td>{s.cg}</td><td>{s.sho}</td>
                          <td>{ipOf(s.pOuts)}</td><td>{s.pH}</td><td>{s.pR}</td><td>{s.pER}</td><td>{s.pBB}</td><td>{s.pK}</td><td>{s.pHR}</td>
                          <td>{s.pOuts ? <strong>{((s.pER * eraBase) / s.pOuts).toFixed(2)}</strong> : '—'}</td>
                          <td>{s.pOuts ? (((s.pH + s.pBB) * 3) / s.pOuts).toFixed(2) : '—'}</td><td>{s.e}</td>
                          <td className="no-print"><button className="linklike" title="Editar acumulado" onClick={() => openEditStats(s)}>✏️</button></td>
                        </tr>
                      </Fragment>
                    );
                  })}
                  {!data.seasons.length && <tr><td colSpan={20} className="muted">Sin temporadas acumuladas</td></tr>}
                </tbody>
              </>
            )}
          </table>
        </div>
      )}

      {/* ---- Matchups — filtrado por la disciplina elegida ---- */}
      {tab === 'matchups' && matchups && (
        <div className="card">
          {effDisc === 'bat' ? (
            <>
              <h2>Bateando</h2>
              <MatchupTable title="Contra lanzadores" rows={matchups.vsPitchers} />
              <MatchupTable title="Contra equipos" rows={matchups.vsTeams} />
              {!matchups.vsPitchers.length && !matchups.vsTeams.length && <p className="muted">Sin enfrentamientos registrados.</p>}
            </>
          ) : (
            <>
              <h2>Lanzando</h2>
              <MatchupTable title="Contra bateadores" rows={matchups.pitchingVsBatters} />
              <MatchupTable title="Contra equipos" rows={matchups.pitchingVsTeams} />
              {!matchups.pitchingVsBatters.length && !matchups.pitchingVsTeams.length && <p className="muted">Sin enfrentamientos registrados.</p>}
            </>
          )}
        </div>
      )}

      {/* ---- Splits por mes / últimos N + rachas ---- */}
      {tab === 'splits' && splits && (() => {
        const sel = splitSel.startsWith('m:')
          ? splits.byMonth.find((m) => `m:${m.month}` === splitSel) ?? null
          : splits.lastN.find((w) => `n:${w.n}` === splitSel) ?? null;
        const s = splits.streaks;
        const chip = (label: string, cur: number, best: number, good = true) => (
          <div className="card" style={{ padding: '0.6rem 0.9rem', textAlign: 'center' }}>
            <div className="muted" style={{ fontSize: '0.75rem' }}>{label}</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: cur > 0 ? (good ? 'var(--green)' : 'var(--red)') : undefined }}>
              {cur > 0 ? cur : '—'}
            </div>
            <div className="muted" style={{ fontSize: '0.72rem' }}>mejor: {best}</div>
          </div>
        );
        return (
          <div className="card">
            <h2>Rachas</h2>
            <div className="row" style={{ gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
              {chip('Juegos con hit', s.hitCur, s.hitBest)}
              {chip('Embasándose', s.obCur, s.obBest)}
              {chip('Ponchándose', s.kCur, s.kBest, false)}
              {chip('Sequía sin hit', s.droughtCur, s.droughtBest, false)}
            </div>

            <h2>Línea por período</h2>
            <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
              {splits.lastN.map((w) => (
                <button key={w.n} className={splitSel === `n:${w.n}` ? '' : 'secondary'} onClick={() => setSplitSel(`n:${w.n}`)}>
                  Últimos {w.n}
                </button>
              ))}
              {splits.byMonth.map((m) => (
                <button key={m.month} className={splitSel === `m:${m.month}` ? '' : 'secondary'} onClick={() => setSplitSel(`m:${m.month}`)}>
                  📅 {monthName(m.month)}
                </button>
              ))}
            </div>
            {sel && (
              <>
                <p className="muted" style={{ margin: '0 0 0.4rem' }}>{sel.games} juego(s) en el período</p>
                {effDisc === 'bat' ? (
                  sel.batting ? (
                    <>
                      <table className="summary-table">
                        <thead><tr><th>G</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
                        <tbody><tr>
                          <td>{sel.batting.g}</td><td>{sel.batting.pa}</td><td>{sel.batting.ab}</td><td>{sel.batting.r}</td><td>{sel.batting.h}</td>
                          <td>{sel.batting.doubles}</td><td>{sel.batting.triples}</td><td>{sel.batting.hr}</td><td>{sel.batting.rbi}</td>
                          <td>{sel.batting.bb}</td><td>{sel.batting.k}</td><td>{sel.batting.sb}</td>
                          <td><strong>{f3(sel.batting.avg)}</strong></td><td>{f3(sel.batting.obp)}</td><td>{f3(sel.batting.slg)}</td><td><strong>{f3(sel.batting.ops)}</strong></td>
                        </tr></tbody>
                      </table>
                      {(sel.batting.situ.risp.ab + sel.batting.situ.loaded.ab + sel.batting.situ.twoOut.ab + sel.batting.situ.leadoff.ab) > 0 && (
                        <p className="muted" style={{ fontSize: '0.82rem', margin: '0.3rem 0' }}>
                          Situacional — RISP: {sel.batting.situ.risp.h}-{sel.batting.situ.risp.ab} ·
                          Llenas: {sel.batting.situ.loaded.h}-{sel.batting.situ.loaded.ab} ·
                          2 outs: {sel.batting.situ.twoOut.h}-{sel.batting.situ.twoOut.ab} ·
                          Leadoff: {sel.batting.situ.leadoff.h}-{sel.batting.situ.leadoff.ab}
                        </p>
                      )}
                    </>
                  ) : <p className="muted">Sin turnos al bate en el período.</p>
                ) : (
                  sel.pitching ? (
                    <table className="summary-table">
                      <thead><tr><th>G</th><th>W</th><th>L</th><th>SV</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>ERA</th><th>WHIP</th></tr></thead>
                      <tbody><tr>
                        <td>{sel.pitching.gp}</td><td>{sel.pitching.w}</td><td>{sel.pitching.l}</td><td>{sel.pitching.sv}</td>
                        <td>{ipOf(sel.pitching.outs)}</td><td>{sel.pitching.h}</td><td>{sel.pitching.r}</td><td>{sel.pitching.er}</td>
                        <td>{sel.pitching.bb}</td><td>{sel.pitching.k}</td>
                        <td><strong>{sel.pitching.era.toFixed(2)}</strong></td><td>{sel.pitching.whip.toFixed(2)}</td>
                      </tr></tbody>
                    </table>
                  ) : <p className="muted">Sin innings lanzados en el período.</p>
                )}
                {sel.fielding && sel.fielding.tc > 0 && (
                  <p className="muted" style={{ fontSize: '0.82rem', margin: '0.3rem 0 0' }}>
                    Fildeo: {sel.fielding.po} PO · {sel.fielding.a} A · {sel.fielding.e} E · FPCT {f3(sel.fielding.fpct)}
                  </p>
                )}
              </>
            )}
            {!sel && <p className="muted">Selecciona un período.</p>}
          </div>
        );
      })()}

      {/* ---- Juego a juego global — columnas según Bateo/Pitcheo ---- */}
      {tab === 'juegos' && (
        <div className="card">
          <h2>Juego a juego — todos los torneos</h2>
          {data.tournaments.map((t) => (
            <div key={t.leagueId}>
              <div className="section-label">{t.league} {t.year}{effYear !== 'all' ? ` · ${effYear}` : ''}</div>
              {effDisc === 'bat' ? (
                <table className="summary-table">
                  <thead><tr><th>Fecha</th><th>Eq</th><th>vs</th><th>AB</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th></tr></thead>
                  <tbody>
                    {!t.log.some((g) => inYear(g.date)) && <tr><td colSpan={11} className="muted">Sin juegos en {effYear}</td></tr>}
                    {t.log.filter((g) => inYear(g.date)).map((g) => (
                      <tr key={g.gameId}>
                        <td>{g.date ? new Date(g.date).toLocaleDateString() : '—'}</td>
                        <td><strong>{g.team ?? '—'}</strong></td>
                        <td><Link to={`/games/${g.gameId}`}>{g.vs}</Link></td>
                        <td>{g.batting?.ab ?? '—'}</td><td>{g.batting?.h ?? '—'}</td><td>{g.batting?.doubles ?? '—'}</td><td>{g.batting?.triples ?? '—'}</td>
                        <td>{g.batting?.hr ?? '—'}</td><td>{g.batting?.rbi ?? '—'}</td><td>{g.batting?.bb ?? '—'}</td><td>{g.batting?.k ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="summary-table">
                  <thead><tr><th>Fecha</th><th>Eq</th><th>vs</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th></tr></thead>
                  <tbody>
                    {!t.log.some((g) => inYear(g.date)) && <tr><td colSpan={11} className="muted">Sin juegos en {effYear}</td></tr>}
                    {t.log.filter((g) => inYear(g.date)).map((g) => (
                      <tr key={g.gameId}>
                        <td>{g.date ? new Date(g.date).toLocaleDateString() : '—'}</td>
                        <td><strong>{g.team ?? '—'}</strong></td>
                        <td><Link to={`/games/${g.gameId}`}>{g.vs}</Link></td>
                        <td>{g.pitching ? ipOf(g.pitching.outs) : '—'}</td><td>{g.pitching?.h ?? '—'}</td>
                        <td>{g.pitching?.r ?? '—'}</td><td>{g.pitching?.er ?? '—'}</td><td>{g.pitching?.bb ?? '—'}</td>
                        <td>{g.pitching?.k ?? '—'}</td><td>{g.pitching?.hr ?? '—'}</td><td>{g.pitching?.pitches ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ---- Spray chart (bateo) / Zona de pitcheo (lanzando) — según la disciplina ---- */}
      {tab === 'spray' && effDisc === 'bat' && (
        <div className="card">
          <div className="row" style={{ alignItems: 'baseline' }}>
            <h2 style={{ margin: 0 }}>Spray chart</h2>
            <span className="muted">donde cayó cada batazo (posición del fildeador)</span>
            <span className="spacer" />
            <button className={sprayHitsOnly ? 'secondary' : ''} onClick={() => setSprayHitsOnly(false)}>Todos</button>
            <button className={sprayHitsOnly ? '' : 'secondary'} onClick={() => setSprayHitsOnly(true)}>Solo hits</button>
          </div>
          {spray?.points.filter((pt) => effYear === 'all' || pt.season === effYear).length ? (
            <SprayChart points={spray.points.filter((pt) => effYear === 'all' || pt.season === effYear)} hitsOnly={sprayHitsOnly} />
          ) : (
            <p className="muted">Sin batazos localizados {effYear !== 'all' ? `en ${effYear}` : 'aún'} — la dirección se anota en la jugada (ej. hit al 9, F8, 6-3).</p>
          )}
        </div>
      )}
      {tab === 'spray' && effDisc === 'pit' && (
        <div className="card">
          <div className="row" style={{ alignItems: 'baseline' }}>
            <h2 style={{ margin: 0 }}>Zona de pitcheo</h2>
            <span className="muted">dónde pasaron sus lanzamientos (marcados al anotar)</span>
          </div>
          {pitchLoc && pitchLoc.points.filter((pt) => effYear === 'all' || pt.season === effYear).length > 0 ? (
            <ZoneChart points={pitchLoc.points.filter((pt) => effYear === 'all' || pt.season === effYear)} />
          ) : (
            <p className="muted">Sin lanzamientos localizados {effYear !== 'all' ? `en ${effYear}` : 'aún'} — la zona se anota con cada pitcheo.</p>
          )}
        </div>
      )}

      {/* ---- Modal edición manual de acumulado de temporada ---- */}
      {editSeason && (
        <div className="modal-back" onClick={() => !savingStats && setEditSeason(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
            <div className="modal-head">
              <h3>✏️ Editar stats — {editSeason.season}{editSeason.scope === 'POST' ? ' 🏆 postemporada' : ''}</h3>
              <button onClick={() => setEditSeason(null)}>✕</button>
            </div>
            <p className="muted">Corrige el acumulado de temporada (ej. si al HR le faltan 2: escribe el total correcto y Guardar). El ajuste se refleja también en el torneo, líderes y reportes de la liga.</p>
            {(['Bateo', 'Pitcheo', 'Fildeo'] as const).map((sec) => (
              <div key={sec}>
                <h4 style={{ margin: '10px 0 6px' }}>{sec}</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))', gap: 6 }}>
                  {EDIT_FIELDS.filter((f) => f.sec === sec).map((f) => (
                    <label key={f.key} style={{ display: 'flex', flexDirection: 'column', fontSize: '0.7rem' }} className="muted">
                      {f.label}
                      <input type="number" min="0" step={f.key === 'ip' ? 0.1 : 1} value={editVals[f.key] ?? ''}
                        onChange={(e) => setEditVals((v) => ({ ...v, [f.key]: e.target.value }))}
                        style={{ padding: '4px 6px' }} />
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end', gap: 8 }}>
              <button className="secondary" onClick={() => setEditSeason(null)} disabled={savingStats}>Cancelar</button>
              <button onClick={saveStats} disabled={savingStats}>{savingStats ? 'Guardando…' : 'Guardar'}</button>
            </div>
          </div>
        </div>
      )}

      {/* cambio de equipo — conserva playerId, stats e historial */}
      {moveOpen && (
        <div className="modal-back" onClick={() => !busyAdmin && setMoveOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>↔ Cambiar de equipo</h3>
              <button onClick={() => setMoveOpen(false)}>✕</button>
            </div>
            <p className="muted">
              {p.firstName} {p.lastName} pasa al nuevo equipo conservando sus estadísticas e historial
              {p.team?.name ? ` (actual: ${p.team.name})` : ''}.
            </p>
            <div className="row" style={{ alignItems: 'center' }}>
              <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} autoFocus>
                <option value="">Elegir equipo…</option>
                {/* solo equipos de la MISMA liga — mover entre ligas mezclaba
                    fichas de torneos distintos */}
                {allTeams
                  .filter((t) => t.id !== p.teamId
                    && (!p.team?.leagueId || t.leagueId === p.team.leagueId))
                  .map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
              </select>
            </div>
            {!p.active && (
              <label className="row" style={{ marginTop: '0.6rem', gap: '0.4rem', alignItems: 'center' }}>
                <input type="checkbox" checked={moveReactivate} onChange={(e) => setMoveReactivate(e.target.checked)} />
                Reactivar en el equipo destino (está BAJA — volvería al roster activo)
              </label>
            )}
            <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end', gap: 8 }}>
              <button className="secondary" onClick={() => setMoveOpen(false)} disabled={busyAdmin}>Cancelar</button>
              <button onClick={saveMove} disabled={busyAdmin || !moveTo}>{busyAdmin ? 'Moviendo…' : 'Mover'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
