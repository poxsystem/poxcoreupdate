import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, Game, League, LeagueStats, LeagueSplits, LeagueBatting, LeaguePitching, LeagueFielding, LeagueTeamTotals, PlayoffSeries, StandingRow } from '../api';
import PlayoffsPanel, { roundName } from '../components/PlayoffsPanel';
import { PassModal } from '../components/PassModal';
import { LeagueReportsModal, LeagueReportSheet, ReportId } from '../components/LeagueReports';
import { downloadCsv } from '../utils/csv';

type Tab = 'equipos' | 'juegos' | 'calendario' | 'posiciones' | 'stats' | 'reporte' | 'playoffs';
const f3 = (n: number) => n.toFixed(3).replace(/^0/, '');
const ipOf = (outs: number) => `${Math.floor(outs / 3)}.${outs % 3}`;
// deltas de la comparación año vs año
const dI = (a?: number | null, b?: number | null) => (a == null || b == null ? '—' : b - a > 0 ? `+${b - a}` : `${b - a}`);
const dR = (a?: number | null, b?: number | null, dec = 3) => {
  if (a == null || b == null) return '—';
  const d = b - a;
  const s = Math.abs(d).toFixed(dec).replace(/^0/, '');
  return d > 0 ? `+${s}` : d < 0 ? `-${s}` : s;
};
type CmpRow<T> = { pid: string; name: string; a: T | null; b: T | null };
const monthName = (ym: string) => {
  const d = new Date(`${ym}-01T12:00:00`);
  return d.toLocaleDateString('es', { month: 'long', year: 'numeric' });
};

// Tablas compactas para los splits (por mes / últimos N juegos)
const SplitBatTable = ({ rows }: { rows: LeagueBatting[] }) => (
  <table className="summary-table">
    <thead><tr><th>Jugador</th><th>Equipo</th><th>G</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
    <tbody>
      {rows.map((b) => (
        <tr key={b.playerId}>
          <td><Link to={`/players/${b.playerId}`}>{b.name}</Link></td><td className="muted">{b.shortName}</td>
          <td>{b.g}</td><td>{b.ab}</td><td>{b.r}</td><td>{b.h}</td><td>{b.doubles}</td><td>{b.triples}</td><td>{b.hr}</td>
          <td>{b.rbi}</td><td>{b.bb}</td><td>{b.k}</td><td>{b.sb}</td>
          <td><strong>{f3(b.avg)}</strong></td><td>{f3(b.obp)}</td><td>{f3(b.slg)}</td><td><strong>{f3(b.ops)}</strong></td>
        </tr>
      ))}
      {!rows.length && <tr><td colSpan={17} className="muted">Sin datos en el período</td></tr>}
    </tbody>
  </table>
);
const SplitPitTable = ({ rows, reg }: { rows: LeaguePitching[]; reg: number }) => (
  <table className="summary-table">
    <thead><tr><th>Lanzador</th><th>Equipo</th><th>G</th><th>W</th><th>L</th><th>SV</th><th>HLD</th><th>BS</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>ERA</th><th>WHIP</th><th>K/{reg}</th></tr></thead>
    <tbody>
      {rows.map((p) => (
        <tr key={p.playerId}>
          <td><Link to={`/players/${p.playerId}`}>{p.name}</Link></td><td className="muted">{p.shortName}</td>
          <td>{p.gp}</td><td>{p.w}</td><td>{p.l}</td><td>{p.sv}</td><td>{p.hld}</td><td>{p.bs}</td>
          <td>{ipOf(p.outs)}</td><td>{p.h}</td><td>{p.r}</td><td>{p.er}</td><td>{p.bb}</td><td>{p.k}</td>
          <td><strong>{p.era.toFixed(2)}</strong></td><td>{p.whip.toFixed(2)}</td><td>{p.k9.toFixed(1)}</td>
        </tr>
      ))}
      {!rows.length && <tr><td colSpan={17} className="muted">Sin datos de pitcheo</td></tr>}
    </tbody>
  </table>
);
const SplitFldTable = ({ rows }: { rows: LeagueFielding[] }) => (
  <table className="summary-table">
    <thead><tr><th>Jugador</th><th>Equipo</th><th>PO</th><th>A</th><th>E</th><th>TC</th><th>FPCT</th></tr></thead>
    <tbody>
      {rows.map((f) => (
        <tr key={f.playerId}>
          <td><Link to={`/players/${f.playerId}`}>{f.name}</Link></td><td className="muted">{f.shortName}</td>
          <td>{f.po}</td><td>{f.a}</td><td>{f.e}</td><td>{f.tc}</td><td><strong>{f3(f.fpct)}</strong></td>
        </tr>
      ))}
      {!rows.length && <tr><td colSpan={7} className="muted">Sin datos de fildeo</td></tr>}
    </tbody>
  </table>
);
const SplitTeamTable = ({ rows, reg }: { rows: LeagueTeamTotals[]; reg: number }) => (
  <table className="summary-table">
    <thead><tr>
      <th>Equipo</th><th>G</th><th>AB</th><th>C</th><th>H</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>AVG</th>
      <th>IP</th><th>C-</th><th>CL</th><th>ERA</th><th>E</th><th>DB</th>
    </tr></thead>
    <tbody>
      {rows.map((t) => (
        <tr key={t.teamId}>
          <td><strong>{t.name}</strong></td><td>{t.g}</td>
          <td>{t.ab}</td><td>{t.r}</td><td>{t.h}</td><td>{t.hr}</td><td>{t.rbi}</td><td>{t.bb}</td><td>{t.k}</td>
          <td><strong>{f3(t.ab ? t.h / t.ab : 0)}</strong></td>
          <td>{ipOf(t.pOuts)}</td><td>{t.pR}</td><td>{t.pER}</td>
          <td>{(t.pOuts ? (t.pER * reg * 3) / t.pOuts : 0).toFixed(2)}</td>
          <td>{t.e}</td><td>{t.lob}</td>
        </tr>
      ))}
      {!rows.length && <tr><td colSpan={16} className="muted">Sin datos</td></tr>}
    </tbody>
  </table>
);

export default function LeaguePage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [league, setLeague] = useState<League | null>(null);
  const [standings, setStandings] = useState<StandingRow[]>([]);
  const [stats, setStats] = useState<LeagueStats | null>(null);
  const [tab, setTab] = useState<Tab>('equipos');
  const [error, setError] = useState('');
  // equipo nuevo dentro de la liga
  const [teamName, setTeamName] = useState('');
  const [teamShort, setTeamShort] = useState('');
  const [teamDiv, setTeamDiv] = useState(''); // división del equipo nuevo
  // juego nuevo dentro de la liga
  const [away, setAway] = useState('');
  const [home, setHome] = useState('');
  const [innings, setInnings] = useState(9);
  const [statTab, setStatTab] = useState<'bateo' | 'pitcheo' | 'fildeo' | 'situacional' | 'tiempo'>('bateo');
  // fase de stats estilo MLB: 'reg' = temporada regular · 'r:N' = una ronda/fase
  // de playoff (eliminación, semifinal, final) · 'post' = postemporada total
  const [phase, setPhase] = useState<string>('reg');
  const [pseries, setPseries] = useState<PlayoffSeries[]>([]); // series de la temporada vista
  const [splits, setSplits] = useState<LeagueSplits | null>(null);
  const [splitSel, setSplitSel] = useState('n:10'); // 'm:YYYY-MM' o 'n:4|6|10'
  // nueva temporada: crea una Season DENTRO de la liga (termina la anterior)
  const [rolloverOpen, setRolloverOpen] = useState(false);
  const [rolloverYear, setRolloverYear] = useState(0);
  const [rolloverBusy, setRolloverBusy] = useState(false);
  const rollover = async () => {
    if (!id || !rolloverYear) return;
    setRolloverBusy(true);
    try {
      await api.createSeason(id, rolloverYear);
      setSeasonSel(null); // vista → la temporada activa nueva
      load();
    } catch (e) { setError((e as Error).message); }
    setRolloverBusy(false); setRolloverOpen(false);
  };
  const endSeason = async () => {
    if (!id || !effSeason) return;
    if (!confirm(`¿Terminar la temporada ${effSeason.year}? Podrás reactivarla luego; los datos no se pierden.`)) return;
    await api.updateSeason(id, effSeason.id, 'ENDED');
    load();
  };
  // reglas de clasificación de líderes (MLB 9.22) + entradas reglamentarias de la liga
  const [qualPa, setQualPa] = useState('3.1');
  const [qualIp, setQualIp] = useState('1.0');
  const [leagueInn, setLeagueInn] = useState('');
  const [wpMinInn, setWpMinInn] = useState('');      // mínimo del abridor p/ ganar: entradas
  const [wpMinThirds, setWpMinThirds] = useState('0'); // …y tercios (0-2)
  const [qualMsg, setQualMsg] = useState('');
  // calendario automático: normal estilo MLB | triangular (softball, home rotativo)
  const [schedStart, setSchedStart] = useState('');
  const [schedEnd, setSchedEnd] = useState('');             // última fecha del torneo
  const [schedRounds, setSchedRounds] = useState(2);
  const [schedDays, setSchedDays] = useState(7);
  const [schedMsg, setSchedMsg] = useState('');
  const [schedMode, setSchedMode] = useState<'normal' | 'triangular'>('normal');
  const [schedPlayDays, setSchedPlayDays] = useState<number[]>([6, 0]); // sábado + domingo
  const [schedSeriesLen, setSchedSeriesLen] = useState(1); // juegos por serie seguidos (MLB)
  const [schedDH, setSchedDH] = useState(false);           // doble jornada
  const [schedStyle, setSchedStyle] = useState<'ida-vuelta' | 'random'>('ida-vuelta');
  const [schedFirstHome, setSchedFirstHome] = useState(''); // home club del día 1
  const [schedFirstAway, setSchedFirstAway] = useState(''); // visitante del día 1
  const [askPrintCal, setAskPrintCal] = useState(false);    // "¿imprimir calendario?" tras generar
  const [schedDivRounds, setSchedDivRounds] = useState(0);  // vueltas extra intra-división
  const [schedTriGpd, setSchedTriGpd] = useState(2);        // triangular: juegos por jornada
  // editar nombre/año de la liga (correcciones)
  const [editLeague, setEditLeague] = useState(false);
  const [lgForm, setLgForm] = useState({ name: '', year: '', tb: 'pct' });
  const [editTeam, setEditTeam] = useState<string | null>(null);
  const [tmForm, setTmForm] = useState({ name: '', shortName: '', color: '', division: '' });
  const [savingLg, setSavingLg] = useState(false);
  const saveLeague = async () => {
    if (!id || !lgForm.name.trim()) return;
    setSavingLg(true);
    try {
      await api.updateLeague(id, { name: lgForm.name.trim(), year: Number(lgForm.year) || league!.year, tb: lgForm.tb });
      setEditLeague(false); load();
    } catch (e) { setError((e as Error).message); }
    setSavingLg(false);
  };
  const [savingTm, setSavingTm] = useState(false);
  const saveTeam = async () => {
    if (!editTeam || !tmForm.name.trim()) return;
    setSavingTm(true);
    try {
      await api.updateTeam(editTeam, {
        name: tmForm.name.trim(),
        shortName: tmForm.shortName.trim() || null,
        color: tmForm.color || null,
        division: tmForm.division.trim() || null,
      });
      setEditTeam(null); load();
    } catch (e) { setError((e as Error).message); }
    setSavingTm(false);
  };
  /** Exporta la tabla de estadísticas visible como CSV (Excel). */
  const csvStats = () => {
    if (!stats || !league) return;
    const base = `${league.name}-${effSeason?.year ?? 'historico'}-${phase === 'reg' ? 'regular' : phase === 'post' ? 'postemporada' : `playoffs-r${phase.slice(2)}`}`;
    const av = (h: number, ab: number) => f3(ab ? h / ab : 0);
    if (statTab === 'bateo') downloadCsv(`${base}-bateo`,
      ['Jugador', 'Equipo', 'G', 'AB', 'R', 'H', '2B', '3B', 'HR', 'CI', 'BB', 'K', 'BR', 'AVG', 'OBP', 'SLG', 'OPS', 'ISO', 'BABIP'],
      stats.batting.map((b) => [b.name, b.shortName, b.g, b.ab, b.r, b.h, b.doubles, b.triples, b.hr, b.rbi, b.bb, b.k, b.sb, f3(b.avg), f3(b.obp), f3(b.slg), f3(b.ops), f3(b.iso), f3(b.babip)]));
    else if (statTab === 'pitcheo') downloadCsv(`${base}-pitcheo`,
      ['Lanzador', 'Equipo', 'G', 'GI', 'W', 'L', 'SV', 'HLD', 'BS', 'CG', 'SHO', 'IP', 'H', 'C', 'CL', 'BB', 'K', 'HR', 'Pit', 'ERA', 'WHIP', 'K9', 'BB9'],
      stats.pitching.map((p) => [p.name, p.shortName, p.gp, p.gs, p.w, p.l, p.sv, p.hld, p.bs, p.cg, p.sho, ipOf(p.outs), p.h, p.r, p.er, p.bb, p.k, p.hr, p.pitches, p.era.toFixed(2), p.whip.toFixed(2), p.k9.toFixed(1), p.bb9.toFixed(1)]));
    else if (statTab === 'fildeo') downloadCsv(`${base}-fildeo`,
      ['Jugador', 'Equipo', 'PO', 'A', 'E', 'TC', 'FPCT'],
      stats.fielding.map((f) => [f.name, f.shortName, f.po, f.a, f.e, f.tc, f3(f.fpct)]));
    else if (statTab === 'situacional') downloadCsv(`${base}-situacional`,
      ['Jugador', 'Equipo', 'RISP-AB', 'RISP-H', 'RISP-AVG', 'Llenas-AB', 'Llenas-H', 'Llenas-AVG', '2Outs-AB', '2Outs-H', '2Outs-AVG', 'Leadoff-AB', 'Leadoff-H', 'Leadoff-AVG'],
      stats.batting.map((b) => [b.name, b.shortName,
        b.situ.risp.ab, b.situ.risp.h, av(b.situ.risp.h, b.situ.risp.ab),
        b.situ.loaded.ab, b.situ.loaded.h, av(b.situ.loaded.h, b.situ.loaded.ab),
        b.situ.twoOut.ab, b.situ.twoOut.h, av(b.situ.twoOut.h, b.situ.twoOut.ab),
        b.situ.leadoff.ab, b.situ.leadoff.h, av(b.situ.leadoff.h, b.situ.leadoff.ab)]));
  };

  // temporada seleccionada: seasonId | 'all' (histórico) | null (activa/reciente)
  const seasons = league?.seasons ?? [];
  const [seasonSel, setSeasonSel] = useState<string | 'all' | null>(null);
  const effSeason = seasonSel === 'all' ? null
    : (seasons.find((s) => s.id === seasonSel) ?? seasons.find((s) => s.status === 'ACTIVE') ?? seasons[0] ?? null);
  const effSeasonId = seasonSel === 'all' ? undefined : effSeason?.id;
  // años disponibles para comparaciones (por Season; respaldo = año de fecha de juego)
  const gameYears = seasons.length ? seasons.map((s) => s.year)
    : [...new Set((league?.games ?? []).map((g) => new Date(g.date).getFullYear()))].sort((a, b) => b - a);
  // comparar años del mismo jugador (reporte) — stats por año de fecha de juego
  const [cmpA, setCmpA] = useState<number | null>(null);
  const [cmpB, setCmpB] = useState<number | null>(null);
  const [cmpPlayer, setCmpPlayer] = useState('');
  const [cmpSA, setCmpSA] = useState<LeagueStats | null>(null);
  const [cmpSB, setCmpSB] = useState<LeagueStats | null>(null);
  // reportes imprimibles: modal de selección → hoja carta 8.5×11 con las secciones elegidas
  const [reportsOpen, setReportsOpen] = useState(false);
  const [printSel, setPrintSel] = useState<ReportId[] | null>(null);
  // juego pendiente de borrar (jugado o programado — exige la clave de admin)
  const [delG, setDelG] = useState<Game | null>(null);

  const load = () => {
    if (!id) return;
    api.league(id).then((l) => {
      setLeague(l);
      setInnings(l.innings ?? (l.sport === 'softball' ? 7 : 9));
      setLeagueInn(l.innings ? String(l.innings) : '');
      setQualPa(String(l.qualPa ?? 3.1));
      setQualIp(String(l.qualIp ?? 1));
      setWpMinInn(l.wpMinOuts ? String(Math.floor(l.wpMinOuts / 3)) : '');
      setWpMinThirds(l.wpMinOuts ? String(l.wpMinOuts % 3) : '0');
    }).catch((e) => setError(e.message));
    api.leagueStandings(id, { season: effSeasonId }).then(setStandings).catch(() => {});
    // fase 'r:N' = solo juegos de series de esa ronda; 'post' = toda la postemporada
    const round = phase.startsWith('r:') ? Number(phase.slice(2)) : undefined;
    api.leagueStats(id, phase === 'reg' ? 'reg' : 'post', { season: effSeasonId, round }).then(setStats).catch(() => {});
    api.leagueSplits(id, effSeasonId).then(setSplits).catch(() => {});
    api.leagueSeries(id, { season: effSeasonId }).then(setPseries).catch(() => {});
  };
  useEffect(load, [id, phase, effSeasonId]);

  // años por defecto de la comparación: penúltimo vs último con juegos
  useEffect(() => {
    if (cmpA == null && gameYears.length) { setCmpA(gameYears[1] ?? gameYears[0]); setCmpB(gameYears[0]); }
  });
  useEffect(() => {
    if (!id || tab !== 'reporte' || cmpA == null || cmpB == null) return;
    api.leagueStats(id, 'reg', { year: cmpA }).then(setCmpSA).catch(() => setCmpSA(null));
    api.leagueStats(id, 'reg', { year: cmpB }).then(setCmpSB).catch(() => setCmpSB(null));
  }, [id, tab, cmpA, cmpB]);

  // jugadores presentes en cualquiera de los dos años, unidos por playerId
  const cmp = useMemo(() => {
    const merge = <T extends { playerId: string; name: string }>(la: T[], lb: T[], has: (l: T) => boolean): CmpRow<T>[] => {
      const ids = new Set([...la.map((x) => x.playerId), ...lb.map((x) => x.playerId)]);
      return [...ids].map((pid) => ({
        pid,
        name: (la.find((x) => x.playerId === pid) ?? lb.find((x) => x.playerId === pid))!.name,
        a: la.find((x) => x.playerId === pid) ?? null,
        b: lb.find((x) => x.playerId === pid) ?? null,
      })).filter((r) => (!cmpPlayer || r.pid === cmpPlayer) && !!((r.a && has(r.a)) || (r.b && has(r.b))))
        .sort((x, y) => x.name.localeCompare(y.name));
    };
    if (!cmpSA || !cmpSB) return { bat: [], pit: [], fld: [] };
    return {
      bat: merge(cmpSA.batting, cmpSB.batting, (l) => l.pa > 0),
      pit: merge(cmpSA.pitching, cmpSB.pitching, (l) => l.outs > 0),
      fld: merge(cmpSA.fielding, cmpSB.fielding, (l) => l.tc > 0),
    };
  }, [cmpSA, cmpSB, cmpPlayer]);
  const cmpNames = useMemo(() => {
    const m = new Map<string, string>();
    [cmpSA, cmpSB].forEach((s) => {
      s?.batting.forEach((b) => m.set(b.playerId, b.name));
      s?.pitching.forEach((p) => m.set(p.playerId, p.name));
      s?.fielding.forEach((f) => m.set(f.playerId, f.name));
    });
    return [...m.entries()].sort((x, y) => x[1].localeCompare(y[1]));
  }, [cmpSA, cmpSB]);

  // Datos de la hoja imprimible (líderes / MVP / totales…): SIEMPRE la
  // temporada vigente (ACTIVE, o la más reciente) y SOLO temporada regular —
  // ni el toggle de fase ni el selector de temporada de la vista la afectan.
  // Si el usuario estaba viendo playoffs u "Histórico", la hoja salía con
  // datos de otra fase/año = "fantasmas". El agregado ya junta al jugador
  // que cambió de equipo en el año (mismo playerId en varios lineups).
  // OJO: estos hooks van ANTES del early return de `!league` (regla de hooks).
  const repSeason = seasons.find((s) => s.status === 'ACTIVE') ?? seasons[0] ?? null;
  // sin Season: "año en curso" = año de la liga o el más reciente con juegos
  const repYear = repSeason?.year ?? league?.year ?? gameYears[0];
  const [repStats, setRepStats] = useState<LeagueStats | null>(null);
  const [repStandings, setRepStandings] = useState<StandingRow[]>([]);
  useEffect(() => {
    if (!printSel || !id) return;
    setRepStats(null); setRepStandings([]);
    const filt = repSeason ? { season: repSeason.id } : repYear ? { year: repYear } : {};
    api.leagueStats(id, 'reg', filt).then(setRepStats).catch(() => {});
    api.leagueStandings(id, filt).then(setRepStandings).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printSel, id, repSeason?.id, repYear]);

  // fases de postemporada presentes en la temporada vista (una por ronda):
  // nombre = base común de las series ("Semifinal A"+"B" → "Semifinal") o roundName
  const postRounds = useMemo(() => {
    const byRound = new Map<number, PlayoffSeries[]>();
    for (const s of pseries) byRound.set(s.round, [...(byRound.get(s.round) ?? []), s]);
    return [...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([n, list]) => {
      const bases = [...new Set(list.map((s) => s.name.replace(/\s+[A-Z]$/, '').trim()))];
      const label = bases.length === 1 && bases[0] && !/^serie$/i.test(bases[0])
        ? bases[0]
        : roundName(n, league?.playoffRounds, list.length);
      return { n, label };
    });
  }, [pseries, league?.playoffRounds]);
  // etiqueta de la fase activa (para el texto "N juegos finalizados")
  const phaseLabel = phase === 'reg' ? '' : phase === 'post' ? 'postemporada' : postRounds.find((r) => `r:${r.n}` === phase)?.label ?? 'playoff';

  if (!league) return <p>{error || 'Cargando…'}</p>;
  const teams = league.teams ?? [];
  const divList = [...new Set(teams.map((t) => t.division).filter((d): d is string => !!d))].sort();
  const games = league.games ?? [];
  const gamesY = seasonSel === 'all' || !effSeason ? games : games.filter((g) => g.seasonId === effSeason.id);
  const repGames = games.filter((g) => !g.seriesId
    && (repSeason ? g.seasonId === repSeason.id : repYear ? new Date(g.date).getFullYear() === repYear : true));

  const createTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamName.trim()) return;
    await api.createTeam({ name: teamName.trim(), shortName: teamShort.trim() || undefined, division: teamDiv.trim() || undefined, leagueId: league.id });
    setTeamName(''); setTeamShort(''); setTeamDiv('');
    load();
  };

  const createGame = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effSeason) { setError('Primero crea una temporada (botón 🗓 de arriba) — los juegos se organizan por temporada'); return; }
    if (!away || !home || away === home) { setError('Elige dos equipos distintos'); return; }
    const g = await api.createGame({ awayTeamId: away, homeTeamId: home, innings, sport: league.sport, leagueId: league.id, seasonId: effSeason.id });
    nav(`/games/${g.id}`);
  };

  const saveQual = async (e: React.FormEvent) => {
    e.preventDefault();
    const inn = leagueInn.trim() ? Number(leagueInn) : null;
    const wpMin = wpMinInn.trim() ? Number(wpMinInn) * 3 + (Number(wpMinThirds) || 0) : null;
    await api.updateLeague(league.id, { qualPa: Number(qualPa), qualIp: Number(qualIp), innings: inn, wpMinOuts: wpMin });
    setQualMsg('Guardado ✓ — reglas y entradas aplicadas a líderes y nuevos juegos');
    load();
  };

  const genSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setSchedMsg('');
    try {
      const r = await api.genSchedule(league.id, {
        startDate: schedStart || undefined, endDate: schedEnd || undefined, mode: schedMode,
        playDays: schedPlayDays.length ? schedPlayDays : undefined,
        daysBetween: schedPlayDays.length ? undefined : schedDays,
        rounds: schedEnd ? undefined : schedRounds, seriesLen: schedSeriesLen, doubleheader: schedDH,
        seriesStyle: schedStyle, divRounds: schedDivRounds,
        firstHomeId: schedFirstHome || undefined, firstAwayId: schedFirstAway || undefined,
        gamesPerDay: schedTriGpd,
      });
      setSchedMsg(`✓ ${r.created} juegos programados — ${r.jornadas} jornadas${r.mode === 'triangular' ? ' (triangular: home club rotativo)' : ''}`);
      setAskPrintCal(r.created > 0);
      load();
    } catch (err) { setSchedMsg((err as Error).message); }
  };
  const clearSchedule = async () => {
    if (!confirm('¿Borrar todos los juegos PROGRAMADOS sin iniciar? Los jugados/finalizados no se tocan.')) return;
    const r = await api.clearSchedule(league.id);
    setSchedMsg(`🗑 ${r.deleted} juegos programados eliminados`);
    load();
  };

  return (
    <div>
      <p className="no-print"><Link to="/leagues">← Ligas</Link></p>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>{league.name} <span className="muted">{seasonSel === 'all' ? 'Histórico' : effSeason?.year ?? ''}</span></h1>
        <span className="pill sched">{league.sport === 'softball' ? '🥎 Softball' : '⚾ Baseball'}</span>
        <button className="secondary no-print" title="Editar liga" onClick={() => { setLgForm({ name: league.name, year: String(league.year), tb: league.tb ?? 'pct' }); setEditLeague(true); }}>
          ✏️ Editar
        </button>
        <span className="spacer" />
        <button className="secondary no-print" title="Sube el ZIP/RAR del año nuevo y se agrega como temporada a ESTA liga (fusiona jugadores y detecta la postemporada)"
          onClick={() => nav(`/leagues?append=${league.id}`)}>
          📥 Temporada desde ZIP
        </button>
        <button className="secondary no-print" onClick={() => { setRolloverOpen(true); setRolloverYear((seasons[0]?.year ?? league.year) + 1); }}>
          🗓 {seasons.length ? 'Nueva temporada' : 'Crear temporada'}
        </button>
      </div>
      {/* barra de acciones agrupada por tema: website / pdf */}
      <div className="row no-print lg-actions">
        <span className="lg-group">
          <span className="lg-label">🌐 Website</span>
          <a className="secondary sm" href={`/api/leagues/${league.id}/website`} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>Abrir</a>
          <a className="secondary sm" href={`/api/leagues/${league.id}/website?dl=1`} download style={{ textDecoration: 'none' }}>⬇ Descargar</a>
          <Link className="secondary sm" to="/publicar" style={{ textDecoration: 'none' }}>🚀 Publicar</Link>
        </span>
        <span className="lg-group">
          <span className="lg-label">🖨️ PDF</span>
          <button className="secondary sm" title="Abre el diálogo de impresión — elige «Guardar como PDF» para descargar"
            onClick={() => { setTab('reporte'); setTimeout(() => window.print(), 300); }}>Reporte</button>
          <button className="secondary sm" title="Elige y genera reportes imprimibles en PDF: resultados, posiciones, lideratos, bateo, pitcheo, fildeo, rosters, calendario…"
            onClick={() => setReportsOpen(true)}>📄 Reportes</button>
          <button className="secondary sm" disabled={!stats} title="Hoja limpia solo con el líder de cada departamento (incluye empatados)"
            onClick={() => setPrintSel(['lideres1'])}>🏅 Imprimir líderes</button>
          <button className="secondary sm" disabled={!stats} title="MVP calculado por el sistema: WAR ofensivo + WAR de pitcheo"
            onClick={() => setPrintSel(['mvp'])}>🏆 MVP</button>
        </span>
        {/* temporadas: posiciones, stats y juegos se filtran por Season */}
        {seasons.length > 0 && (
          <span className="lg-group">
            <span className="lg-label">🗓 Temporada</span>
            {seasons.map((s) => (
              <button key={s.id} className={(seasonSel !== 'all' && effSeason?.id === s.id ? '' : 'secondary ') + 'sm'} onClick={() => setSeasonSel(s.id)}>
                {s.year}{s.status === 'ACTIVE' ? ' ●' : ''}
              </button>
            ))}
            {seasons.length > 1 && (
              <button className={(seasonSel === 'all' ? '' : 'secondary ') + 'sm'} onClick={() => setSeasonSel('all')}>Histórico</button>
            )}
            {effSeason?.status === 'ACTIVE' && seasonSel !== 'all' && (
              <button className="secondary sm" onClick={endSeason} title="Marca la temporada como terminada">⏹ Terminar</button>
            )}
            {effSeason?.status === 'ENDED' && seasonSel !== 'all' && (
              <button className="secondary sm" onClick={async () => { await api.updateSeason(id!, effSeason.id, 'ACTIVE'); load(); }} title="Reactivar esta temporada">▶ Reactivar</button>
            )}
            {effSeason && (
              <button className="secondary sm" title="Reconstruye los acumulados de esta temporada desde los juegos — repara desfases (stats viejas, correcciones)" onClick={async () => {
                if (!id || !confirm(`¿Recalcular los acumulados de ${effSeason.year} desde los juegos?`)) return;
                try {
                  const r = await api.recalcStats(effSeason.year);
                  alert(`Acumulados ${effSeason.year}: ${r.updated} actualizados · ${r.created} creados · ${r.cleared} limpiados`);
                  load();
                } catch (e) { setError((e as Error).message); }
              }}>♻️ Recalcular</button>
            )}
          </span>
        )}
      </div>
      {error && <p className="pill sched">{error}</p>}
      {seasons.length === 0 && (
        <div className="card no-print" style={{ borderLeft: '4px solid var(--accent, #1668b4)' }}>
          <strong>Esta liga aún no tiene temporada.</strong>
          <span className="muted"> Crea la primera (ej. {new Date().getFullYear()}) para programar y anotar juegos — cada año será una temporada independiente.</span>
          <button style={{ marginLeft: '0.6rem' }} onClick={() => { setRolloverOpen(true); setRolloverYear(new Date().getFullYear()); }}>
            🗓 Crear temporada
          </button>
        </div>
      )}

      <div className="row no-print" style={{ gap: '0.3rem', margin: '0.8rem 0' }}>
        {([['equipos', 'Equipos'], ['juegos', 'Juegos'], ['calendario', '📅 Calendario'], ['posiciones', 'Posiciones'], ['stats', 'Estadísticas'], ['playoffs', '🏆 Playoffs'], ['reporte', 'Reporte']] as [Tab, string][]).map(([t, label]) => (
          <button key={t} className={tab === t ? '' : 'secondary'} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>

      {/* ---- Equipos de la liga ---- */}
      {tab === 'equipos' && (
        <>
          <div className="card">
            <h2>Nuevo equipo en {league.name}</h2>
            <form className="row" onSubmit={createTeam}>
              <input placeholder="Nombre del equipo" value={teamName} onChange={(e) => setTeamName(e.target.value)} />
              <input placeholder="Abrev." value={teamShort} onChange={(e) => setTeamShort(e.target.value)} style={{ width: 100 }} />
              <input placeholder="División (opcional)" value={teamDiv} onChange={(e) => setTeamDiv(e.target.value)} list="divisions" style={{ width: 150 }} />
              <datalist id="divisions">{divList.map((d) => <option key={d} value={d} />)}</datalist>
              <button type="submit">Agregar equipo</button>
            </form>
          </div>
          <div className="card">
            <table>
              <thead><tr><th>Equipo</th><th>Abrev.</th><th>División</th><th>Jugadores</th><th /></tr></thead>
              <tbody>
                {teams.map((t) => (
                  <tr key={t.id}>
                    <td>
                      {t.color && <span className="team-dot" style={{ background: t.color }} />}
                      <Link to={`/teams/${t.id}`}>{t.name}</Link>
                    </td>
                    <td>{t.shortName}</td>
                    <td>{t.division ? <span className="pill sched">{t.division}</span> : <span className="muted">—</span>}</td>
                    <td>{t._count?.players ?? 0}</td>
                    <td>
                      <button className="secondary" title="Editar equipo" onClick={() => { setEditTeam(t.id); setTmForm({ name: t.name, shortName: t.shortName ?? '', color: t.color ?? '', division: t.division ?? '' }); }}>✏️</button>{' '}
                      <Link to={`/teams/${t.id}`}>Roster →</Link>
                    </td>
                  </tr>
                ))}
                {teams.length === 0 && <tr><td colSpan={5} className="muted">Sin equipos en esta liga — agrégalos arriba o desde la página de Equipos</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h2>⚙ Reglas de la liga</h2>
            <form className="row" onSubmit={saveQual} style={{ marginBottom: '0.6rem' }}>
              <label>Entradas por juego
                <input type="number" min={1} max={20} value={leagueInn} onChange={(e) => setLeagueInn(e.target.value)} style={{ width: 70 }} placeholder={league.sport === 'softball' ? '7' : '9'} />
              </label>
              <span className="muted" style={{ alignSelf: 'end', fontSize: '0.85rem' }}>vacío = {league.sport === 'softball' ? '7 (softball)' : '9 (baseball)'} — aplica a juegos nuevos y calendario</span>
            </form>
            <h3 style={{ margin: '0.4rem 0 0.2rem' }}>Victoria del lanzador abridor</h3>
            <p className="muted">
              Mínimo que debe lanzar el abridor para ganar el juego (regla 9.17). Se mide en <b>entradas y tercios</b>
              (1 tercio = 1 out): <b>4.1</b> = cuatro entradas y un tercio. Si el abridor queda corto, la victoria
              la sugiere el relevista más efectivo.
            </p>
            <form className="row" onSubmit={saveQual}>
              <label>Mínimo — entradas
                <input type="number" min={0} max={20} value={wpMinInn} onChange={(e) => setWpMinInn(e.target.value)} style={{ width: 70 }} placeholder="auto" />
              </label>
              <label>…y tercios
                <select value={wpMinThirds} onChange={(e) => setWpMinThirds(e.target.value)} disabled={!wpMinInn.trim()}>
                  <option value="0">0 (completas)</option>
                  <option value="1">1 tercio</option>
                  <option value="2">2 tercios</option>
                </select>
              </label>
              <button type="submit">Guardar reglas</button>
            </form>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              {wpMinInn.trim()
                ? <>Esta liga: abridor necesita <b>{wpMinInn}.{wpMinThirds} entradas</b> para acreditarse la victoria.</>
                : <>Vacío = <b>regla oficial automática</b>: {league.sport === 'softball'
                    ? 'softball → 4 IP si el juego dura 6+, 3 IP si termina en 5 (WBSC/NCAA).'
                    : 'baseball → 5 IP si el juego dura 6+, 4 IP si termina en 5 (MLB 9.17).'}</>}
            </p>
            <h3 style={{ margin: '0.4rem 0 0.2rem' }}>Clasificación de líderes</h3>
            <p className="muted">
              Formato <b>MLB regla 9.22</b>: un jugador solo aparece en líderes de promedio si acumula
              <b> PA ≥ juegos del equipo × {qualPa}</b> (bateo) o <b>IP ≥ juegos del equipo × {qualIp}</b> (pitcheo).
              Quien quede corto pero aún lidere rellenando con turnos sin hit, también clasifica.
              Pon <b>0</b> para que todos aparezcan sin mínimo.
            </p>
            <form className="row" onSubmit={saveQual}>
              <label>Bateo — PA por juego
                <input type="number" step="0.1" min={0} max={10} value={qualPa} onChange={(e) => setQualPa(e.target.value)} style={{ width: 80 }} />
              </label>
              <label>Pitcheo — IP por juego
                <input type="number" step="0.1" min={0} max={10} value={qualIp} onChange={(e) => setQualIp(e.target.value)} style={{ width: 80 }} />
              </label>
              <button type="submit">Guardar reglas</button>
            </form>
            {qualMsg && <p className="muted">{qualMsg}</p>}
            <p className="muted">Referencia: MLB = 3.1 PA / 1.0 IP por juego · Menores/independientes = 2.7 / 0.8 · Liga local corta ≈ 1.0–2.0 / 0.5</p>
          </div>
        </>
      )}

      {/* ---- Juegos del torneo ---- */}
      {tab === 'juegos' && (
        <>
          <div className="card">
            <h2>Programar juego</h2>
            {teams.length < 2 ? <p className="muted">Necesitas 2 equipos en la liga.</p> : (
              <form className="row" onSubmit={createGame}>
                <select value={away} onChange={(e) => setAway(e.target.value)}>
                  <option value="">Visitante…</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <span>@</span>
                <select value={home} onChange={(e) => setHome(e.target.value)}>
                  <option value="">Local…</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <label>Entradas <input type="number" min={1} max={20} value={innings} onChange={(e) => setInnings(Number(e.target.value))} style={{ width: 65 }} /></label>
                <button type="submit">Crear juego</button>
              </form>
            )}
          </div>
        </>
      )}

      {/* ---- Calendario automático (generador) ---- */}
      {tab === 'calendario' && (
        <>
          <div className="card">
            <h2>📅 Generador de calendario</h2>
            {teams.length < 2 ? <p className="muted">Necesitas 2 equipos en la liga.</p> : (
              <form onSubmit={genSchedule} style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                <div className="row" style={{ alignItems: 'center' }}>
                  <label>Formato:</label>
                  <select value={schedMode} onChange={(e) => setSchedMode(e.target.value as 'normal' | 'triangular')}>
                    <option value="normal">Normal — todos contra todos (estilo MLB)</option>
                    <option value="triangular">Triangular — home club rotativo (softball de 3)</option>
                  </select>
                  <label>Del <input type="date" value={schedStart} onChange={(e) => setSchedStart(e.target.value)} title="Fecha de la 1ª jornada" /></label>
                  <label>al <input type="date" value={schedEnd} onChange={(e) => setSchedEnd(e.target.value)} title="Última fecha del torneo — el generador llena el rango (opcional)" /></label>
                  <label>Home club día 1
                    <select value={schedFirstHome} onChange={(e) => setSchedFirstHome(e.target.value)}>
                      <option value="">— decide el generador —</option>
                      {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </label>
                  <label>Visitante día 1
                    <select value={schedFirstAway} onChange={(e) => setSchedFirstAway(e.target.value)}>
                      <option value="">— decide el generador —</option>
                      {teams.filter((t) => t.id !== schedFirstHome).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </label>
                </div>
                <div className="row" style={{ alignItems: 'center' }}>
                  <label>Días que se juega:</label>
                  {(['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'] as const).map((d, i) => (
                    <label key={d} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: '0.85rem' }}>
                      <input type="checkbox" checked={schedPlayDays.includes(i)}
                        onChange={(e) => setSchedPlayDays(e.target.checked ? [...schedPlayDays, i].sort() : schedPlayDays.filter((x) => x !== i))} />
                      {d}
                    </label>
                  ))}
                  <span className="muted" style={{ fontSize: '0.8rem' }}>los demás días quedan libres</span>
                  {!schedPlayDays.length && (
                    <label>o cada <input type="number" min={1} max={30} value={schedDays} onChange={(e) => setSchedDays(Number(e.target.value))} style={{ width: 55 }} /> días</label>
                  )}
                </div>
                {schedMode === 'triangular' ? (
                  <div className="row" style={{ alignItems: 'center' }}>
                    <label>Juegos por jornada
                      <select value={schedTriGpd} onChange={(e) => setSchedTriGpd(Number(e.target.value))}>
                        <option value={1}>1 — el que espera descansa</option>
                        <option value={2}>2 — el home club recibe a los dos visitantes</option>
                        <option value={3}>3 — ganador se queda (los 3 juegan 2)</option>
                      </select>
                    </label>
                    <label>Ciclos <input type="number" min={1} max={20} value={schedRounds} onChange={(e) => setSchedRounds(Number(e.target.value))} style={{ width: 60 }} disabled={!!schedEnd} title={schedEnd ? 'Con fecha final el rango manda' : ''} /></label>
                    <span className="muted" style={{ fontSize: '0.82rem' }}>
                      {schedTriGpd === 3
                        ? 'J2 = ganador del J1 vs el que esperó · J3 = perdedor del J1 vs el que esperó — quien repite juego invierte su rol (el que fue home va de visita y viceversa); los equipos de J2/J3 se ajustan al iniciar según el resultado'
                        : 'el home club rota cada jornada (no se repite) y cada equipo recibe a todos por igual'}
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="row" style={{ alignItems: 'center' }}>
                      <label>Vueltas <input type="number" min={1} max={10} value={schedRounds} onChange={(e) => setSchedRounds(Number(e.target.value))} style={{ width: 60 }} disabled={!!schedEnd} title={schedEnd ? 'Con fecha final el rango manda' : ''} /></label>
                      <label>Juegos por serie
                        <select value={schedSeriesLen} onChange={(e) => setSchedSeriesLen(Number(e.target.value))}>
                          {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n === 1 ? '1 — juego simple' : `${n} — serie de ${n} seguidos`}</option>)}
                        </select>
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input type="checkbox" checked={schedDH} onChange={(e) => setSchedDH(e.target.checked)} /> Doble jornada (2 juegos el mismo día)
                      </label>
                    </div>
                    <div className="row" style={{ alignItems: 'center' }}>
                      <label>Series:</label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input type="radio" checked={schedStyle === 'ida-vuelta'} onChange={() => setSchedStyle('ida-vuelta')} /> Ida y vuelta (cada uno recibe al otro)
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input type="radio" checked={schedStyle === 'random'} onChange={() => setSchedStyle('random')} /> Aleatorias (localía balanceada)
                      </label>
                      {teams.some((t) => t.division) && (
                        <label>Vueltas extra dentro de la división
                          <input type="number" min={0} max={6} value={schedDivRounds} onChange={(e) => setSchedDivRounds(Number(e.target.value))} style={{ width: 55 }} />
                        </label>
                      )}
                    </div>
                  </>
                )}
                <div className="row">
                  <button type="submit">⚙ Generar calendario</button>
                  <button type="button" className="danger" onClick={clearSchedule} title="Solo borra juegos programados sin iniciar">🗑 Borrar programados</button>
                  <button type="button" className="secondary" onClick={() => setPrintSel(['calendario'])}
                    disabled={!gamesY.some((g) => g.status === 'SCHEDULED')}
                    title="Vista previa del calendario en hoja carta — Imprimir o Guardar como PDF">🖨️ Calendario PDF</button>
                </div>
              </form>
            )}
            {schedMsg && <p className="muted">{schedMsg}</p>}
            {askPrintCal && (
              <div className="row no-print" style={{ alignItems: 'center', gap: '0.5rem', background: 'rgba(0,122,255,0.07)', border: '1px solid rgba(0,122,255,0.25)', borderRadius: 10, padding: '0.45rem 0.8rem', marginTop: '0.4rem' }}>
                <span style={{ fontSize: '0.9rem' }}>¿Imprimir el calendario en PDF ahora?</span>
                <button className="sm" onClick={() => { setPrintSel(['calendario']); setAskPrintCal(false); }}>🖨️ Sí, ver para imprimir</button>
                <button className="secondary sm" onClick={() => setAskPrintCal(false)}>Ahora no</button>
              </div>
            )}
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              {schedMode === 'triangular'
                ? schedTriGpd === 3
                  ? `Triangular "ganador se queda": cada jornada 3 juegos — J1 visitante@home; J2 el ganador vs el que esperó; J3 el perdedor vs el que esperó. Quien repite juego invierte su rol (home→visita, visita→home). J2/J3 salen provisionales con su nota.`
                  : `Triangular: cada jornada un equipo es home club y recibe ${schedTriGpd === 2 ? 'a los otros dos' : 'a un visitante'}; la localía rota cada jornada. Con ${teams.length || 'N'} equipos un ciclo completo son ${teams.length >= 2 ? Math.ceil(teams.length * (teams.length - 1) / 2 / schedTriGpd) : '…'} jornadas.`
                : `Round-robin por jornadas: cada vuelta enfrenta a todos contra todos una vez. Con ${teams.length || 'N'} equipos son ${teams.length ? (teams.length % 2 ? teams.length : teams.length - 1) : '…'} jornadas por vuelta${schedSeriesLen > 1 ? ` × ${schedSeriesLen} juegos de serie` : ''}.`}
              {' '}Las entradas salen de la configuración de la liga ({leagueInn || (league.sport === 'softball' ? 7 : 9)} inn).
            </p>
          </div>
        </>
      )}

      {tab === 'juegos' && (
        <>
          <div className="card">
            <table>
              <thead><tr><th>Fecha</th><th>Juego</th><th>Marcador</th><th>Estado</th><th /></tr></thead>
              <tbody>
                {gamesY.map((g) => (
                  <tr key={g.id}>
                    <td>{new Date(g.date).toLocaleDateString()}</td>
                    <td><Link to={`/games/${g.id}`}>{g.seriesId ? '🏆 ' : ''}{g.awayTeam?.name}{g.dhAway ? <sup title={`Juego ${g.dhAway} del equipo este día`} className="muted"> J{g.dhAway}</sup> : null} @ {g.homeTeam?.name}{g.dhHome ? <sup title={`Juego ${g.dhHome} del equipo este día`} className="muted"> J{g.dhHome}</sup> : null}</Link></td>
                    <td>{g.fScoreAway != null ? `${g.fScoreAway} - ${g.fScoreHome}` : g.state ? `${g.state.score.away} - ${g.state.score.home}` : '—'}</td>
                    <td><span className={`pill ${g.status === 'LIVE' ? 'live' : g.status === 'FINAL' ? 'final' : 'sched'}`}>{g.seriesId ? 'PLAYOFF' : g.forfeitBy ? 'FORFEIT' : g.status}</span></td>
                    <td>
                      <Link to={`/games/${g.id}`}>Abrir →</Link>{' '}
                      <button className="danger icon" title="Borrar el juego por completo (pide clave de admin)"
                        style={{ fontSize: '0.7rem', padding: '0 0.3rem' }}
                        onClick={() => setDelG(g)}>🗑</button>
                    </td>
                  </tr>
                ))}
                {gamesY.length === 0 && <tr><td colSpan={5} className="muted">Sin juegos en {effSeason?.year ?? 'la liga'}</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ---- Posiciones ---- */}
      {tab === 'posiciones' && (
        <>
          <div className="card">
            <div className="row no-print" style={{ alignItems: 'baseline' }}>
              <h2 style={{ margin: 0 }}>Posiciones — {league.name} {effSeason?.year ?? '(histórico)'}</h2>
              <span className="spacer" />
              <button className="secondary sm" title="Descarga esta tabla como CSV (Excel)"
                onClick={() => downloadCsv(
                  `posiciones-${league.name}-${effSeason?.year ?? 'historico'}`,
                  ['#', 'Equipo', 'G', 'P', 'E', 'PCT', 'JB', 'CF', 'CC', 'Dif', 'Racha', 'Ult10'],
                  standings.map((t, i) => [i + 1, t.name, t.w, t.l, t.t, f3(t.pct), t.gb === 0 ? '' : t.gb.toFixed(1), t.rf, t.ra, t.diff, t.streak ?? '', t.last10 ? `${t.last10.w}-${t.last10.l}${t.last10.t ? `-${t.last10.t}` : ''}` : '']),
                )}>📊 CSV</button>
            </div>
            {(() => {
              // si la liga tiene divisiones, la tabla se agrupa por división (JB dentro del grupo)
              const standTable = (rows: StandingRow[]) => {
                const lead = rows[0];
                const withGb = rows.map((t) => ({ ...t, gb: lead ? ((lead.w - t.w) + (t.l - lead.l)) / 2 : 0 }));
                return (
                  <table>
                    <thead><tr><th>#</th><th>Equipo</th><th>G</th><th>P</th><th>E</th><th>PCT</th><th>JB</th><th>CF</th><th>CC</th><th>Dif</th><th>Racha</th><th>Últ10</th><th>Forma</th></tr></thead>
                    <tbody>
                      {withGb.map((t, i) => (
                        <tr key={t.teamId} style={league.playoffTeams && i < league.playoffTeams ? { background: '#f0fdf4' } : undefined}>
                          <td>{i + 1}{league.playoffTeams && i < league.playoffTeams ? ' 🏆' : ''}</td>
                          <td>{t.name}</td>
                          <td>{t.w}</td><td>{t.l}</td><td>{t.t}</td>
                          <td><strong>{f3(t.pct)}</strong></td>
                          <td>{t.gb === 0 ? '—' : t.gb.toFixed(1)}</td>
                          <td>{t.rf}</td><td>{t.ra}</td><td>{t.diff > 0 ? `+${t.diff}` : t.diff}</td>
                          <td>
                            {t.streak && (
                              <span className={`pill ${t.streak.startsWith('G') ? 'live' : t.streak.startsWith('P') ? 'sched' : 'final'}`} title="Racha actual">
                                {t.streak}
                              </span>
                            )}
                          </td>
                          <td>{t.last10 ? `${t.last10.w}-${t.last10.l}${t.last10.t ? `-${t.last10.t}` : ''}` : '—'}</td>
                          <td>{(t.form ?? []).map((r, j) => (
                            <span key={j} title={r === 'W' ? 'Ganó' : r === 'L' ? 'Perdió' : 'Empató'} style={{
                              display: 'inline-block', width: 9, height: 9, borderRadius: '50%', marginRight: 3,
                              background: r === 'W' ? '#16a34a' : r === 'L' ? '#dc2626' : '#9ca3af',
                            }} />
                          ))}</td>
                        </tr>
                      ))}
                      {withGb.length === 0 && <tr><td colSpan={13} className="muted">Sin juegos finalizados</td></tr>}
                    </tbody>
                  </table>
                );
              };
              const divs = [...new Set(standings.map((t) => t.division ?? null))];
              const grouped = standings.some((t) => t.division);
              if (!grouped) return standTable(standings);
              return divs.map((d) => (
                <div key={d ?? 'sin'} style={{ marginBottom: '0.8rem' }}>
                  <h3 style={{ margin: '0 0 0.3rem' }}>{d ? `División ${d}` : 'Sin división'}</h3>
                  {standTable(standings.filter((t) => (t.division ?? null) === d))}
                </div>
              ));
            })()}
          </div>
          {standings.length > 0 && standings.some((t) => t.vs && Object.keys(t.vs).length) && (
            <div className="card">
              <h2>Cara a cara (G-P)</h2>
              <div className="tw">
                <table className="h2h">
                  <thead><tr><th />
                    {standings.map((t) => <th key={t.teamId}>{t.name}</th>)}
                  </tr></thead>
                  <tbody>
                    {standings.map((row) => (
                      <tr key={row.teamId}>
                        <td><strong>{row.name}</strong></td>
                        {standings.map((col) => {
                          if (col.teamId === row.teamId) return <td key={col.teamId} className="muted">—</td>;
                          const v = row.vs?.[col.teamId];
                          return (
                            <td key={col.teamId} title={`${row.name} vs ${col.name}`}>
                              {v ? `${v.w}-${v.l}${v.t ? `-${v.t}` : ''}` : '·'}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* ---- Estadísticas del torneo ---- */}
      {tab === 'stats' && stats && (
        <div className="card">
          <div className="row" style={{ gap: '0.3rem', marginBottom: '0.6rem' }}>
            {([['bateo', 'Bateo'], ['pitcheo', 'Pitcheo'], ['fildeo', 'Fildeo'], ['situacional', 'Situacional'], ['tiempo', '⏱ Tiempo/Rachas']] as const).map(([t, label]) => (
              <button key={t} className={statTab === t ? '' : 'secondary'} onClick={() => setStatTab(t)}>{label}</button>
            ))}
            <span className="spacer" />
            <select value={phase} onChange={(e) => setPhase(e.target.value)}
              title="Fase — estilo MLB: cada ronda por separado y el total de postemporada">
              <option value="reg">Temporada regular</option>
              {postRounds.map((r) => <option key={r.n} value={`r:${r.n}`}>🏆 {r.label}</option>)}
              <option value="post">🏆 Postemporada {effSeason?.year ?? ''} (total)</option>
            </select>
            <span className="muted">{stats.games} juego(s){phaseLabel ? ` · ${phaseLabel}` : ''} finalizados</span>
            <button className="secondary sm" title="Descarga la tabla visible como CSV (Excel)" onClick={csvStats}>📊 CSV</button>
          </div>

          {statTab === 'bateo' && (
            <table className="summary-table">
              <thead><tr>
                <th>Jugador</th><th>Equipo</th><th>G</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th>
                <th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th><th>ISO</th><th>BABIP</th>
              </tr></thead>
              <tbody>
                {stats.batting.map((b) => (
                  <tr key={b.playerId}>
                    <td><Link to={`/players/${b.playerId}`}>{b.name}</Link></td><td className="muted">{b.shortName}</td>
                    <td>{b.g}</td><td>{b.ab}</td><td>{b.r}</td><td>{b.h}</td>
                    <td>{b.doubles}</td><td>{b.triples}</td><td>{b.hr}</td><td>{b.rbi}</td>
                    <td>{b.bb}</td><td>{b.k}</td><td>{b.sb}</td>
                    <td><strong>{f3(b.avg)}</strong></td><td>{f3(b.obp)}</td><td>{f3(b.slg)}</td>
                    <td><strong>{f3(b.ops)}</strong></td><td>{f3(b.iso)}</td><td>{f3(b.babip)}</td>
                  </tr>
                ))}
                {!stats.batting.length && <tr><td colSpan={19} className="muted">Sin datos — finaliza juegos del torneo</td></tr>}
              </tbody>
            </table>
          )}

          {statTab === 'pitcheo' && (
            <table className="summary-table">
              <thead><tr>
                <th>Lanzador</th><th>Equipo</th><th>G</th><th>GI</th><th>W</th><th>L</th><th>SV</th><th>HLD</th><th>BS</th><th>CG</th><th>SHO</th><th>IP</th>
                <th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th><th>ERA</th><th>WHIP</th><th>K/{league.innings ?? (league.sport === 'softball' ? 7 : 9)}</th><th>BB/{league.innings ?? (league.sport === 'softball' ? 7 : 9)}</th>
              </tr></thead>
              <tbody>
                {stats.pitching.map((p) => (
                  <tr key={p.playerId}>
                    <td><Link to={`/players/${p.playerId}`}>{p.name}</Link></td><td className="muted">{p.shortName}</td>
                    <td>{p.gp}</td><td>{p.gs}</td><td>{p.w}</td><td>{p.l}</td><td>{p.sv}</td><td>{p.hld}</td><td>{p.bs}</td><td>{p.cg}</td><td>{p.sho}</td>
                    <td>{ipOf(p.outs)}</td><td>{p.h}</td><td>{p.r}</td><td>{p.er}</td><td>{p.bb}</td><td>{p.k}</td><td>{p.hr}</td><td>{p.pitches}</td>
                    <td><strong>{p.era.toFixed(2)}</strong></td><td>{p.whip.toFixed(2)}</td><td>{p.k9.toFixed(1)}</td><td>{p.bb9.toFixed(1)}</td>
                  </tr>
                ))}
                {!stats.pitching.length && <tr><td colSpan={22} className="muted">Sin datos de pitcheo</td></tr>}
              </tbody>
            </table>
          )}

          {statTab === 'fildeo' && (
            <table className="summary-table">
              <thead><tr><th>Jugador</th><th>Equipo</th><th>PO</th><th>A</th><th>E</th><th>TC</th><th>FPCT</th></tr></thead>
              <tbody>
                {stats.fielding.map((f) => (
                  <tr key={f.playerId}>
                    <td><Link to={`/players/${f.playerId}`}>{f.name}</Link></td><td className="muted">{f.shortName}</td>
                    <td>{f.po}</td><td>{f.a}</td><td>{f.e}</td><td>{f.tc}</td>
                    <td><strong>{f3(f.fpct)}</strong></td>
                  </tr>
                ))}
                {!stats.fielding.length && <tr><td colSpan={7} className="muted">Sin datos — el fildeo se deriva de la notación (6-3, F8, E5…)</td></tr>}
              </tbody>
            </table>
          )}

          {statTab === 'situacional' && (
            <table className="summary-table">
              <thead><tr>
                <th>Jugador</th><th>Equipo</th>
                <th colSpan={3}>C/posición anotar</th><th colSpan={3}>Bases llenas</th><th colSpan={3}>Con 2 outs</th><th colSpan={3}>Abriendo entrada</th>
              </tr>
              <tr>
                <th /><th />
                <th>AB</th><th>H</th><th>AVG</th><th>AB</th><th>H</th><th>AVG</th><th>AB</th><th>H</th><th>AVG</th><th>AB</th><th>H</th><th>AVG</th>
              </tr></thead>
              <tbody>
                {stats.batting.map((b) => (
                  <tr key={b.playerId}>
                    <td><Link to={`/players/${b.playerId}`}>{b.name}</Link></td><td className="muted">{b.shortName}</td>
                    <td>{b.situ.risp.ab}</td><td>{b.situ.risp.h}</td><td>{f3(b.situ.risp.ab ? b.situ.risp.h / b.situ.risp.ab : 0)}</td>
                    <td>{b.situ.loaded.ab}</td><td>{b.situ.loaded.h}</td><td>{f3(b.situ.loaded.ab ? b.situ.loaded.h / b.situ.loaded.ab : 0)}</td>
                    <td>{b.situ.twoOut.ab}</td><td>{b.situ.twoOut.h}</td><td>{f3(b.situ.twoOut.ab ? b.situ.twoOut.h / b.situ.twoOut.ab : 0)}</td>
                    <td>{b.situ.leadoff.ab}</td><td>{b.situ.leadoff.h}</td><td>{f3(b.situ.leadoff.ab ? b.situ.leadoff.h / b.situ.leadoff.ab : 0)}</td>
                  </tr>
                ))}
                {!stats.batting.length && <tr><td colSpan={14} className="muted">Sin datos</td></tr>}
              </tbody>
            </table>
          )}

          {/* ---- Splits de tiempo + rachas (BallStat) ---- */}
          {statTab === 'tiempo' && splits && (() => {
            const sel = splitSel.startsWith('m:')
              ? splits.byMonth.find((m) => `m:${m.month}` === splitSel) ?? null
              : splits.lastN.find((w) => `n:${w.n}` === splitSel) ?? null;
            const reg = league.sport === 'softball' ? 7 : 9;
            return (
              <>
                <h3 style={{ margin: '0.3rem 0' }}>Rachas de jugadores</h3>
                <table className="summary-table">
                  <thead><tr>
                    <th>Jugador</th><th>Equipo</th>
                    <th>Racha H</th><th>Mejor H</th>
                    <th>Racha Emb.</th><th>Mejor Emb.</th>
                    <th>Racha K</th><th>Mejor K</th>
                    <th>Sequía</th><th>Peor sequía</th>
                  </tr></thead>
                  <tbody>
                    {splits.streaks.map((s) => (
                      <tr key={s.playerId}>
                        <td><Link to={`/players/${s.playerId}`}>{s.name}</Link></td><td className="muted">{s.shortName}</td>
                        <td><strong>{s.hitCur || '—'}</strong></td><td>{s.hitBest}</td>
                        <td><strong>{s.obCur || '—'}</strong></td><td>{s.obBest}</td>
                        <td><strong>{s.kCur || '—'}</strong></td><td>{s.kBest}</td>
                        <td><strong>{s.droughtCur || '—'}</strong></td><td>{s.droughtBest}</td>
                      </tr>
                    ))}
                    {!splits.streaks.length && <tr><td colSpan={10} className="muted">Sin datos — finaliza juegos del torneo</td></tr>}
                  </tbody>
                </table>

                <div className="row" style={{ gap: '0.4rem', margin: '0.9rem 0 0.4rem', flexWrap: 'wrap' }}>
                  <span className="section-label" style={{ margin: 0 }}>Período:</span>
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
                    <p className="muted" style={{ margin: '0 0 0.5rem' }}>
                      {sel.games} juego(s) en el período — equipo, bateo, pitcheo y fildeo
                    </p>
                    <h3 style={{ margin: '0.4rem 0' }}>Por equipo</h3>
                    <SplitTeamTable rows={sel.teamTotals} reg={reg} />
                    <h3 style={{ margin: '0.8rem 0 0.4rem' }}>Bateo</h3>
                    <SplitBatTable rows={sel.batting} />
                    <h3 style={{ margin: '0.8rem 0 0.4rem' }}>Pitcheo</h3>
                    <SplitPitTable rows={sel.pitching} reg={reg} />
                    <h3 style={{ margin: '0.8rem 0 0.4rem' }}>Fildeo</h3>
                    <SplitFldTable rows={sel.fielding} />
                  </>
                )}
                {!sel && <p className="muted">Selecciona un período arriba.</p>}
              </>
            );
          })()}
          {statTab === 'tiempo' && !splits && <p className="muted">Cargando splits…</p>}
        </div>
      )}

      {/* ---- Reporte imprimible estilo BallStat ---- */}
      {tab === 'playoffs' && <PlayoffsPanel league={league} onChanged={load} />}

      {tab === 'reporte' && stats && (
        <div className="print-report">
          <div className="report-header">
            <h1>{league.name} — {league.year}</h1>
            <p>{league.sport === 'softball' ? 'Softball' : 'Baseball'} · {stats.games} juegos · Generado {new Date().toLocaleDateString()}</p>
          </div>

          {/* ---- Comparar años: rendimiento del mismo jugador, año A vs año B ---- */}
          {gameYears.length > 1 && cmpA != null && cmpB != null && (
            <section>
              <div className="row cmp-controls no-print">
                <strong>⚖ Comparar años:</strong>
                <select value={cmpA} onChange={(e) => setCmpA(Number(e.target.value))}>
                  {gameYears.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
                <span className="muted">vs</span>
                <select value={cmpB} onChange={(e) => setCmpB(Number(e.target.value))}>
                  {gameYears.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
                <select value={cmpPlayer} onChange={(e) => setCmpPlayer(e.target.value)}>
                  <option value="">Todos los jugadores</option>
                  {cmpNames.map(([pid, name]) => <option key={pid} value={pid}>{name}</option>)}
                </select>
              </div>
              {(!cmpSA || !cmpSB) && <p className="muted">Cargando comparación…</p>}
              {cmpSA && cmpSB && (
                <>
                  <h2>Comparación {cmpA} vs {cmpB} — bateo</h2>
                  <table className="report-table">
                    <thead><tr><th>Jugador</th><th>Año</th><th>Eq</th><th>G</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
                    <tbody>
                      {cmp.bat.map((r) => (
                        <Fragment key={r.pid}>
                          <tr>
                            <td rowSpan={3} className="cmp-name"><Link to={`/players/${r.pid}`}><strong>{r.name}</strong></Link></td>
                            <td>{cmpA}</td>
                            {r.a ? (
                              <><td>{r.a.shortName}</td><td>{r.a.g}</td><td>{r.a.pa}</td><td>{r.a.ab}</td><td>{r.a.r}</td><td>{r.a.h}</td><td>{r.a.doubles}</td><td>{r.a.triples}</td><td>{r.a.hr}</td><td>{r.a.rbi}</td><td>{r.a.bb}</td><td>{r.a.k}</td><td>{r.a.sb}</td><td><strong>{f3(r.a.avg)}</strong></td><td>{f3(r.a.obp)}</td><td>{f3(r.a.slg)}</td><td>{f3(r.a.ops)}</td></>
                            ) : <td colSpan={17} className="muted">no jugó</td>}
                          </tr>
                          <tr>
                            <td>{cmpB}</td>
                            {r.b ? (
                              <><td>{r.b.shortName}</td><td>{r.b.g}</td><td>{r.b.pa}</td><td>{r.b.ab}</td><td>{r.b.r}</td><td>{r.b.h}</td><td>{r.b.doubles}</td><td>{r.b.triples}</td><td>{r.b.hr}</td><td>{r.b.rbi}</td><td>{r.b.bb}</td><td>{r.b.k}</td><td>{r.b.sb}</td><td><strong>{f3(r.b.avg)}</strong></td><td>{f3(r.b.obp)}</td><td>{f3(r.b.slg)}</td><td>{f3(r.b.ops)}</td></>
                            ) : <td colSpan={17} className="muted">no jugó</td>}
                          </tr>
                          <tr className="cmp-delta">
                            <td>Δ</td><td></td>
                            <td>{dI(r.a?.g, r.b?.g)}</td><td>{dI(r.a?.pa, r.b?.pa)}</td><td>{dI(r.a?.ab, r.b?.ab)}</td><td>{dI(r.a?.r, r.b?.r)}</td><td>{dI(r.a?.h, r.b?.h)}</td><td>{dI(r.a?.doubles, r.b?.doubles)}</td><td>{dI(r.a?.triples, r.b?.triples)}</td><td>{dI(r.a?.hr, r.b?.hr)}</td><td>{dI(r.a?.rbi, r.b?.rbi)}</td><td>{dI(r.a?.bb, r.b?.bb)}</td><td>{dI(r.a?.k, r.b?.k)}</td><td>{dI(r.a?.sb, r.b?.sb)}</td><td><strong>{dR(r.a?.avg, r.b?.avg)}</strong></td><td>{dR(r.a?.obp, r.b?.obp)}</td><td>{dR(r.a?.slg, r.b?.slg)}</td><td><strong>{dR(r.a?.ops, r.b?.ops)}</strong></td>
                          </tr>
                        </Fragment>
                      ))}
                      {!cmp.bat.length && <tr><td colSpan={19} className="muted">Sin datos de bateo en esos años</td></tr>}
                    </tbody>
                  </table>

                  {cmp.pit.length > 0 && (
                    <>
                      <h2>Comparación {cmpA} vs {cmpB} — pitcheo</h2>
                      <table className="report-table">
                        <thead><tr><th>Lanzador</th><th>Año</th><th>Eq</th><th>G</th><th>W</th><th>L</th><th>SV</th><th>HLD</th><th>CG</th><th>SHO</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>ERA</th><th>WHIP</th></tr></thead>
                        <tbody>
                          {cmp.pit.map((r) => (
                            <Fragment key={r.pid}>
                              <tr>
                                <td rowSpan={3} className="cmp-name"><Link to={`/players/${r.pid}`}><strong>{r.name}</strong></Link></td>
                                <td>{cmpA}</td>
                                {r.a ? (
                                  <><td>{r.a.shortName}</td><td>{r.a.gp}</td><td>{r.a.w}</td><td>{r.a.l}</td><td>{r.a.sv}</td><td>{r.a.hld}</td><td>{r.a.cg}</td><td>{r.a.sho}</td><td>{ipOf(r.a.outs)}</td><td>{r.a.h}</td><td>{r.a.r}</td><td>{r.a.er}</td><td>{r.a.bb}</td><td>{r.a.k}</td><td>{r.a.hr}</td><td><strong>{r.a.era.toFixed(2)}</strong></td><td>{r.a.whip.toFixed(2)}</td></>
                                ) : <td colSpan={17} className="muted">no lanzó</td>}
                              </tr>
                              <tr>
                                <td>{cmpB}</td>
                                {r.b ? (
                                  <><td>{r.b.shortName}</td><td>{r.b.gp}</td><td>{r.b.w}</td><td>{r.b.l}</td><td>{r.b.sv}</td><td>{r.b.hld}</td><td>{r.b.cg}</td><td>{r.b.sho}</td><td>{ipOf(r.b.outs)}</td><td>{r.b.h}</td><td>{r.b.r}</td><td>{r.b.er}</td><td>{r.b.bb}</td><td>{r.b.k}</td><td>{r.b.hr}</td><td><strong>{r.b.era.toFixed(2)}</strong></td><td>{r.b.whip.toFixed(2)}</td></>
                                ) : <td colSpan={17} className="muted">no lanzó</td>}
                              </tr>
                              <tr className="cmp-delta">
                                <td>Δ</td><td></td>
                                <td>{dI(r.a?.gp, r.b?.gp)}</td><td>{dI(r.a?.w, r.b?.w)}</td><td>{dI(r.a?.l, r.b?.l)}</td><td>{dI(r.a?.sv, r.b?.sv)}</td><td>{dI(r.a?.hld, r.b?.hld)}</td><td>{dI(r.a?.cg, r.b?.cg)}</td><td>{dI(r.a?.sho, r.b?.sho)}</td><td>{dI(r.a?.outs, r.b?.outs)}</td><td>{dI(r.a?.h, r.b?.h)}</td><td>{dI(r.a?.r, r.b?.r)}</td><td>{dI(r.a?.er, r.b?.er)}</td><td>{dI(r.a?.bb, r.b?.bb)}</td><td>{dI(r.a?.k, r.b?.k)}</td><td>{dI(r.a?.hr, r.b?.hr)}</td><td><strong>{dR(r.a?.era, r.b?.era, 2)}</strong></td><td>{dR(r.a?.whip, r.b?.whip, 2)}</td>
                              </tr>
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}

                  {cmp.fld.length > 0 && (
                    <>
                      <h2>Comparación {cmpA} vs {cmpB} — fildeo</h2>
                      <table className="report-table">
                        <thead><tr><th>Jugador</th><th>Año</th><th>Eq</th><th>PO</th><th>A</th><th>E</th><th>TC</th><th>FPCT</th></tr></thead>
                        <tbody>
                          {cmp.fld.map((r) => (
                            <Fragment key={r.pid}>
                              <tr>
                                <td rowSpan={3} className="cmp-name"><Link to={`/players/${r.pid}`}><strong>{r.name}</strong></Link></td>
                                <td>{cmpA}</td>
                                {r.a ? (
                                  <><td>{r.a.shortName}</td><td>{r.a.po}</td><td>{r.a.a}</td><td>{r.a.e}</td><td>{r.a.tc}</td><td><strong>{f3(r.a.fpct)}</strong></td></>
                                ) : <td colSpan={6} className="muted">sin fildeo</td>}
                              </tr>
                              <tr>
                                <td>{cmpB}</td>
                                {r.b ? (
                                  <><td>{r.b.shortName}</td><td>{r.b.po}</td><td>{r.b.a}</td><td>{r.b.e}</td><td>{r.b.tc}</td><td><strong>{f3(r.b.fpct)}</strong></td></>
                                ) : <td colSpan={6} className="muted">sin fildeo</td>}
                              </tr>
                              <tr className="cmp-delta">
                                <td>Δ</td><td></td>
                                <td>{dI(r.a?.po, r.b?.po)}</td><td>{dI(r.a?.a, r.b?.a)}</td><td>{dI(r.a?.e, r.b?.e)}</td><td>{dI(r.a?.tc, r.b?.tc)}</td><td><strong>{dR(r.a?.fpct, r.b?.fpct)}</strong></td>
                              </tr>
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </>
              )}
            </section>
          )}

          <h2>Resultados</h2>
          <table className="report-table">
            <thead><tr><th>Fecha</th><th>Visitante</th><th>Carreras</th><th>Local</th><th>Carreras</th><th>Nota</th></tr></thead>
            <tbody>
              {gamesY.filter((g) => g.status === 'FINAL').map((g) => (
                <tr key={g.id}>
                  <td>{new Date(g.date).toLocaleDateString()}</td>
                  <td>{g.awayTeam?.name}</td>
                  <td><strong>{g.fScoreAway ?? g.state?.score.away ?? '—'}</strong></td>
                  <td>{g.homeTeam?.name}</td>
                  <td><strong>{g.fScoreHome ?? g.state?.score.home ?? '—'}</strong></td>
                  <td>{g.forfeitBy ? 'FORFEIT' : g.tied ? 'EMPATE' : ''}</td>
                </tr>
              ))}
              {gamesY.filter((g) => g.status === 'FINAL').length === 0 && <tr><td colSpan={6}>Sin juegos finalizados</td></tr>}
            </tbody>
          </table>

          <h2>Posiciones</h2>
          <table className="report-table">
            <thead><tr><th>#</th><th>Equipo</th><th>G</th><th>P</th><th>E</th><th>PCT</th><th>JB</th><th>CF</th><th>CC</th><th>DIF</th></tr></thead>
            <tbody>
              {standings.map((t, i) => (
                <tr key={t.teamId}><td>{i + 1}</td><td>{t.name}</td><td>{t.w}</td><td>{t.l}</td><td>{t.t}</td><td>{f3(t.pct)}</td><td>{t.gb === 0 ? '—' : t.gb.toFixed(1)}</td><td>{t.rf}</td><td>{t.ra}</td><td>{t.diff > 0 ? `+${t.diff}` : t.diff}</td></tr>
              ))}
            </tbody>
          </table>

          <h2>Totales por equipo</h2>
          <table className="report-table">
            <thead><tr><th>Equipo</th><th>G</th><th>Carreras</th><th>Hits</th><th>Errores</th><th>Dejados en base</th></tr></thead>
            <tbody>
              {stats.teamTotals.map((t) => (
                <tr key={t.teamId}><td>{t.name}</td><td>{t.g}</td><td>{t.r}</td><td>{t.h}</td><td>{t.e}</td><td>{t.lob}</td></tr>
              ))}
            </tbody>
          </table>

          {/* Líderes por categoría — estilo BallStat; promedios respetan la regla de clasificación de la liga */}
          {stats.batting.length > 0 && (() => {
            const qPa = league?.qualPa ?? 3.1, qIp = league?.qualIp ?? 1.0;
            const tg = (tid: string) => stats.teamTotals.find((t) => t.teamId === tid)?.g ?? 0;
            const paNeed = (b: { teamId: string; pa: number }) => Math.round(tg(b.teamId) * qPa);
            const outsNeed = (p: { teamId: string; outs: number }) => Math.round(tg(p.teamId) * qIp * 3);
            const batQ = stats.batting.filter((b) => qPa <= 0 || b.pa >= paNeed(b));
            // excepción oficial: quien no llega al mínimo pero sigue liderando rellenando con turnos sin hit
            const bestAvg = batQ.length ? Math.max(...batQ.map((b) => b.avg)) : -1;
            const avgSet = [...batQ, ...stats.batting.filter((b) =>
              !batQ.includes(b) && bestAvg > 0 && b.h > 0 && b.h / (b.ab + (paNeed(b) - b.pa)) >= bestAvg)];
            const pitQ = stats.pitching.filter((p) => qIp <= 0 || p.outs >= outsNeed(p));
            const cats: { label: string; rows: { name: string; team: string; val: string }[] }[] = [];
            const pick = <T extends { name: string; shortName: string }>(arr: T[], key: (x: T) => number, fmt: (x: T) => string, min = 1) => {
              const top = [...arr].sort((a, b) => key(b) - key(a)).slice(0, 3).filter((x) => key(x) >= min);
              return top.map((x) => ({ name: x.name, team: x.shortName, val: fmt(x) }));
            };
            const push = (label: string, rows: { name: string; team: string; val: string }[]) => { if (rows.length) cats.push({ label, rows }); };
            push('AVG', pick(avgSet, (b) => b.avg, (b) => f3(b.avg), 0.001));
            push('Jonrones', pick(stats.batting, (b) => b.hr, (b) => String(b.hr)));
            push('Carreras impulsadas', pick(stats.batting, (b) => b.rbi, (b) => String(b.rbi)));
            push('Hits', pick(stats.batting, (b) => b.h, (b) => String(b.h)));
            push('Bases robadas', pick(stats.batting, (b) => b.sb, (b) => String(b.sb)));
            push('OPS', pick(batQ, (b) => b.ops, (b) => f3(b.ops), 0.001));
            push('ERA', pick(pitQ, (p) => -p.era, (p) => p.era.toFixed(2), -999));
            push('Ganados', pick(stats.pitching, (p) => p.w, (p) => String(p.w)));
            push('Ponches', pick(stats.pitching, (p) => p.k, (p) => String(p.k)));
            push('Salvados', pick(stats.pitching, (p) => p.sv, (p) => String(p.sv)));
            return (
              <>
                <h2>Líderes del torneo</h2>
                <div className="leader-grid">
                  {cats.map((c) => (
                    <div key={c.label} className="leader-card">
                      <div className="leader-title">{c.label}</div>
                      {c.rows.map((r, i) => (
                        <div key={i} className="leader-row">
                          <span>{r.name} <span className="muted">{r.team}</span></span><strong>{r.val}</strong>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            );
          })()}

          <h2>Bateo individual completo</h2>
          <table className="report-table">
            <thead><tr><th>Jugador</th><th>Equipo</th><th>G</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
            <tbody>
              {[...stats.batting].sort((a, b) => b.avg - a.avg).map((b) => (
                <tr key={b.playerId}><td>{b.name}</td><td>{b.shortName}</td><td>{b.g}</td><td>{b.pa}</td><td>{b.ab}</td><td>{b.r}</td><td>{b.h}</td><td>{b.doubles}</td><td>{b.triples}</td><td>{b.hr}</td><td>{b.rbi}</td><td>{b.bb}</td><td>{b.k}</td><td>{b.sb}</td><td><strong>{f3(b.avg)}</strong></td><td>{f3(b.obp)}</td><td>{f3(b.slg)}</td><td>{f3(b.ops)}</td></tr>
              ))}
            </tbody>
          </table>

          <h2>Pitcheo individual completo</h2>
          <table className="report-table">
            <thead><tr><th>Lanzador</th><th>Equipo</th><th>G</th><th>W-L</th><th>SV</th><th>HLD</th><th>BS</th><th>CG</th><th>SHO</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th><th>ERA</th><th>WHIP</th></tr></thead>
            <tbody>
              {stats.pitching.map((p) => (
                <tr key={p.playerId}><td>{p.name}</td><td>{p.shortName}</td><td>{p.gp}</td><td>{p.w}-{p.l}</td><td>{p.sv}</td><td>{p.hld}</td><td>{p.bs}</td><td>{p.cg}</td><td>{p.sho}</td><td>{ipOf(p.outs)}</td><td>{p.h}</td><td>{p.r}</td><td>{p.er}</td><td>{p.bb}</td><td>{p.k}</td><td>{p.hr}</td><td>{p.pitches}</td><td><strong>{p.era.toFixed(2)}</strong></td><td>{p.whip.toFixed(2)}</td></tr>
              ))}
            </tbody>
          </table>

          <h2>Fildeo individual</h2>
          <table className="report-table">
            <thead><tr><th>Jugador</th><th>Equipo</th><th>PO</th><th>A</th><th>E</th><th>TC</th><th>FPCT</th></tr></thead>
            <tbody>
              {stats.fielding.map((f) => (
                <tr key={f.playerId}><td>{f.name}</td><td>{f.shortName}</td><td>{f.po}</td><td>{f.a}</td><td>{f.e}</td><td>{f.tc}</td><td>{f3(f.fpct)}</td></tr>
              ))}
            </tbody>
          </table>

          <h2>Bateo situacional</h2>
          <table className="report-table">
            <thead><tr><th>Jugador</th><th>Equipo</th><th>RISP AB-H</th><th>AVG</th><th>Llenas AB-H</th><th>AVG</th><th>2 outs AB-H</th><th>AVG</th><th>Leadoff AB-H</th><th>AVG</th></tr></thead>
            <tbody>
              {stats.batting.map((b) => (
                <tr key={b.playerId}>
                  <td>{b.name}</td><td>{b.shortName}</td>
                  <td>{b.situ.risp.ab}-{b.situ.risp.h}</td><td>{f3(b.situ.risp.ab ? b.situ.risp.h / b.situ.risp.ab : 0)}</td>
                  <td>{b.situ.loaded.ab}-{b.situ.loaded.h}</td><td>{f3(b.situ.loaded.ab ? b.situ.loaded.h / b.situ.loaded.ab : 0)}</td>
                  <td>{b.situ.twoOut.ab}-{b.situ.twoOut.h}</td><td>{f3(b.situ.twoOut.ab ? b.situ.twoOut.h / b.situ.twoOut.ab : 0)}</td>
                  <td>{b.situ.leadoff.ab}-{b.situ.leadoff.h}</td><td>{f3(b.situ.leadoff.ab ? b.situ.leadoff.h / b.situ.leadoff.ab : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="muted no-print" style={{ marginTop: '1rem' }}>Usa Ctrl+P o el botón de imprimir — esta vista está optimizada para papel.</p>
          <p className="print-sign">PoxScore · Desarrollado por Alexis Lara · 2026</p>
        </div>
      )}

      {/* ---- Reportes imprimibles carta vertical 8.5×11 (modal → hoja) ---- */}
      {reportsOpen && <LeagueReportsModal stats={stats} onClose={() => setReportsOpen(false)}
        onPrint={(ids) => { setReportsOpen(false); setPrintSel(ids); }} />}
      {printSel && league && <LeagueReportSheet league={league} stats={repStats} standings={repStandings} games={repGames} ids={printSel}
        yearLabel={String(repYear ?? '')}
        phaseLabel="Temporada regular"
        onClose={() => setPrintSel(null)} />}

      {/* Modal editar liga */}
      {editLeague && (
        <div className="modal-backdrop" onClick={() => !savingLg && setEditLeague(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>✏️ Editar liga</h2>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Corrige el nombre o el año — equipos, juegos y estadísticas no se tocan.
            </p>
            <div className="row" style={{ alignItems: 'center' }}>
              <input placeholder="Nombre de la liga" value={lgForm.name} onChange={(e) => setLgForm({ ...lgForm, name: e.target.value })} autoFocus />
              <input type="number" placeholder="Año" value={lgForm.year} onChange={(e) => setLgForm({ ...lgForm, year: e.target.value })} style={{ width: 90 }} />
            </div>
            <label style={{ display: 'block', marginTop: '0.6rem', fontSize: '0.85rem' }}>
              Regla de desempate en posiciones:{' '}
              <select value={lgForm.tb} onChange={(e) => setLgForm({ ...lgForm, tb: e.target.value })}>
                <option value="pct">Porcentaje → victorias → diferencia</option>
                <option value="h2h">Porcentaje → serie entre ellos (cara a cara)</option>
                <option value="diff">Porcentaje → diferencia de carreras</option>
              </select>
            </label>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button className="secondary" onClick={() => setEditLeague(false)} disabled={savingLg}>Cancelar</button>
              <button onClick={saveLeague} disabled={savingLg || !lgForm.name.trim()}>
                {savingLg ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal editar equipo — nombre, abreviatura y color */}
      {editTeam && (
        <div className="modal-backdrop" onClick={() => !savingTm && setEditTeam(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>✏️ Editar equipo</h2>
            <div className="row" style={{ alignItems: 'center' }}>
              <input placeholder="Nombre del equipo" value={tmForm.name} onChange={(e) => setTmForm({ ...tmForm, name: e.target.value })} autoFocus />
              <input placeholder="Abrev." value={tmForm.shortName} onChange={(e) => setTmForm({ ...tmForm, shortName: e.target.value })} style={{ width: 90 }} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.7rem', fontSize: '0.9rem' }}>
              División:
              <input placeholder="ej. Este / A / Norte" value={tmForm.division} onChange={(e) => setTmForm({ ...tmForm, division: e.target.value })} list="divisions" style={{ width: 160 }} />
              <datalist id="divisions">{divList.map((d) => <option key={d} value={d} />)}</datalist>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.7rem', fontSize: '0.9rem' }}>
              Color del equipo:
              <input type="color" value={tmForm.color || '#1e3a5f'} onChange={(e) => setTmForm({ ...tmForm, color: e.target.value })} style={{ width: 46, height: 30, padding: 2 }} />
              {tmForm.color
                ? <button type="button" className="secondary" onClick={() => setTmForm({ ...tmForm, color: '' })}>Quitar</button>
                : <span className="muted">sin color</span>}
            </label>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button className="secondary" onClick={() => setEditTeam(null)} disabled={savingTm}>Cancelar</button>
              <button onClick={saveTeam} disabled={savingTm || !tmForm.name.trim()}>
                {savingTm ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal nueva temporada */}
      {rolloverOpen && (
        <div className="modal-backdrop" onClick={() => setRolloverOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>🗓 Nueva temporada</h2>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Se crea la temporada <strong>{rolloverYear}</strong> dentro de <strong>{league.name}</strong>
              {seasons.length ? ' y la actual queda terminada' : ''}.
              Los equipos y rosters permanecen — los movimientos se hacen por transferencia
              y cada jugador conserva su historial año por año.
            </p>
            <div className="row" style={{ alignItems: 'center' }}>
              <label>Año:</label>
              <input type="number" value={rolloverYear} onChange={(e) => setRolloverYear(Number(e.target.value))} style={{ width: 90 }} />
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button className="secondary" onClick={() => setRolloverOpen(false)}>Cancelar</button>
              <button onClick={rollover} disabled={rolloverBusy || !rolloverYear}>
                {rolloverBusy ? 'Creando…' : `Crear temporada ${rolloverYear}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* borrar un juego: jugado o programado, exige la clave de admin */}
      {delG && (
        <PassModal
          title="Borrar juego"
          message={`Se eliminará el juego ${delG.awayTeam?.name ?? '?'} @ ${delG.homeTeam?.name ?? '?'} del ${new Date(delG.date).toLocaleDateString()} con todas sus jugadas y estadísticas. No se puede deshacer.`}
          onClose={() => setDelG(null)}
          onDone={async (password) => {
            await api.deleteGame(delG.id, password);
            load();
          }}
        />
      )}
    </div>
  );
}
