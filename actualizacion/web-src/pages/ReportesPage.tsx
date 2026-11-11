import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api, type League, type PlayerListItem, type ReportFilters, type ReportResponse,
  type SqlResult, type Team,
} from '../api';

// resultados agrupados para el selector múltiple
const RESULT_GROUPS: { label: string; codes: string[] }[] = [
  { label: 'Hits', codes: ['1B', '2B', '3B', 'HR', '1BE', '2BE', '3BE'] },
  { label: 'Bolas/Bases', codes: ['BB', 'IBB', 'HBP', 'CI'] },
  { label: 'Outs', codes: ['K', 'KWP', 'KPB', 'GO', 'FO', 'LO', 'PO', 'DP', 'TP', 'SAC', 'SF', 'IF', 'XF'] },
  { label: 'Otros', codes: ['E', 'FC', 'RHB', 'OOT', 'AO', 'SK'] },
  { label: 'Mid-play', codes: ['SB', 'CS', 'WP', 'PB', 'BK', 'PO', 'BR'] },
];

// ---- Suite guiada: cada tarjeta es una pregunta; solo pide lo que necesita ----

type FieldKey =
  | 'player' | 'pitcher' | 'order' | 'team' | 'vsTeam'
  | 'bases' | 'twoOuts' | 'half' | 'inns' | 'results';
type ViewKey = 'bat' | 'saber' | 'pit' | 'pitsaber' | 'fld' | 'plays' | 'games' | 'innings';
type CatKey = 'Bateo' | 'Sabermetría' | 'Carrera' | 'Situaciones' | 'Pitcheo' | 'Fildeo' | 'Juegos y liga' | 'SQL libre';

interface Preset {
  id: string; cat: CatKey; icon: string; title: string; desc: string;
  dataset: 'batting' | 'pitching' | 'fielding' | 'plays' | 'games' | 'innings';
  groupBy: string;
  view: ViewKey;                  // qué columnas muestra la tabla
  fields: FieldKey[];             // campos que pide en la zona principal
  required?: FieldKey[];          // los que no pueden quedar vacíos
  fixed?: Partial<ReportFilters>; // filtros pre-fijados por la pregunta (el usuario aún puede acotar)
}

const PRESETS: Preset[] = [
  // ---------- Bateo ----------
  {
    id: 'bateo-jugador', cat: 'Bateo', icon: '🧢', title: '¿Cuánto batea un jugador?',
    desc: 'Línea completa de bateo: AVG, hits, jonrones, empujadas…',
    dataset: 'batting', groupBy: 'player', view: 'bat', fields: ['player'], required: ['player'],
  },
  {
    id: 'bateo-orden', cat: 'Bateo', icon: '🔢', title: 'Bateando en un puesto del orden',
    desc: '«¿Cuánto batea Manuel de 4º?» — o quiénes batean mejor en ese turno',
    dataset: 'batting', groupBy: 'player', view: 'bat', fields: ['order', 'player'], required: ['order'],
  },
  {
    id: 'bateo-vs-pitcher', cat: 'Bateo', icon: '🎯', title: 'Bateador contra un lanzador',
    desc: 'El duelo directo: qué le batea ese jugador a ese pitcher',
    dataset: 'batting', groupBy: 'player', view: 'bat', fields: ['player', 'pitcher'], required: ['player', 'pitcher'],
  },
  {
    id: 'bateo-vs-equipo', cat: 'Bateo', icon: '🆚', title: 'Bateador contra un equipo',
    desc: 'Cómo le ha ido al jugador en su carrera contra ese rival',
    dataset: 'batting', groupBy: 'player', view: 'bat', fields: ['player', 'vsTeam'], required: ['player', 'vsTeam'],
  },
  {
    id: 'equipo-batea', cat: 'Bateo', icon: '👥', title: 'Bateo de un equipo',
    desc: 'La línea de cada jugador del equipo — quién produce',
    dataset: 'batting', groupBy: 'player', view: 'bat', fields: ['team'], required: ['team'],
  },
  {
    id: 'lideres-bateo', cat: 'Bateo', icon: '🏆', title: 'Líderes de bateo',
    desc: 'Todos los bateadores ordenados — compara el torneo completo',
    dataset: 'batting', groupBy: 'player', view: 'bat', fields: [],
  },
  // ---------- Sabermetría ----------
  {
    id: 'saber-bateo', cat: 'Sabermetría', icon: '📈', title: 'Sabermetría ofensiva',
    desc: 'ISO · BABIP · wOBA · BB% · K% · carreras creadas — el bateo profundo',
    dataset: 'batting', groupBy: 'player', view: 'saber', fields: ['player'],
  },
  {
    id: 'saber-pit', cat: 'Sabermetría', icon: '🔬', title: 'Sabermetría de pitcheo',
    desc: 'FIP · BAA · K/BB · BB/9 · H/9 · HR/9 · P/IP — dominio real del pitcher',
    dataset: 'pitching', groupBy: 'player', view: 'pitsaber', fields: ['player'],
  },
  // ---------- Carrera ----------
  {
    id: 'carrera-bat', cat: 'Carrera', icon: '📜', title: 'Carrera bateando, por temporada',
    desc: 'Su línea año por año — progresión, mejor temporada, declive',
    dataset: 'batting', groupBy: 'season', view: 'bat', fields: ['player'], required: ['player'],
  },
  {
    id: 'carrera-pit', cat: 'Carrera', icon: '🗓', title: 'Carrera lanzando, por temporada',
    desc: 'ERA y dominio año por año — cómo evolucionó en el box',
    dataset: 'pitching', groupBy: 'season', view: 'pit', fields: ['player'], required: ['player'],
  },
  {
    id: 'carrera-vs-equipo', cat: 'Carrera', icon: '⚔️', title: 'Carrera contra un rival, por año',
    desc: '¿Cómo le ha bateado a Tigres en cada temporada?',
    dataset: 'batting', groupBy: 'season', view: 'bat', fields: ['player', 'vsTeam'], required: ['player', 'vsTeam'],
  },
  {
    id: 'carrera-mes', cat: 'Carrera', icon: '📅', title: 'Rendimiento mes a mes',
    desc: '¿Empieza frío y cierra caliente? — su línea agrupada por mes',
    dataset: 'batting', groupBy: 'month', view: 'bat', fields: ['player'], required: ['player'],
  },
  // ---------- Situaciones ----------
  {
    id: 'situ-risp', cat: 'Situaciones', icon: '🎯', title: 'Corredores en posición de anotar',
    desc: 'Quién responde con hombres en 2ª o 3ª — el bateo oportuno',
    dataset: 'batting', groupBy: 'player', view: 'bat', fields: ['player'], fixed: { bases: 'risp' },
  },
  {
    id: 'situ-llenas', cat: 'Situaciones', icon: '🏠', title: 'Con las bases llenas',
    desc: 'La casa llena: quién la aprovecha y quién se poncha',
    dataset: 'batting', groupBy: 'player', view: 'bat', fields: ['player'], fixed: { bases: 'loaded' },
  },
  {
    id: 'situ-dosouts', cat: 'Situaciones', icon: '✌️', title: 'Con dos outs',
    desc: 'Clutch: qué batean cuando la entrada está a un paso de morir',
    dataset: 'batting', groupBy: 'player', view: 'bat', fields: ['player'], fixed: { twoOuts: true },
  },
  {
    id: 'situ-tardias', cat: 'Situaciones', icon: '🌙', title: 'Entradas tardías',
    desc: 'De la 6ª en adelante por defecto — ajusta el rango si quieres',
    dataset: 'batting', groupBy: 'player', view: 'bat', fields: ['player', 'inns'], fixed: { inningFrom: 6 },
  },
  {
    id: 'situ-casa', cat: 'Situaciones', icon: '🏟', title: 'En casa vs de visita',
    desc: 'Dos filas: su rendimiento defendiendo su estadio y fuera',
    dataset: 'batting', groupBy: 'venue', view: 'bat', fields: ['player', 'team'],
  },
  {
    id: 'situ-post', cat: 'Situaciones', icon: '🏆', title: 'En postemporada',
    desc: 'Solo juegos de playoff — quién rinde cuando más vale',
    dataset: 'batting', groupBy: 'player', view: 'bat', fields: ['player'], fixed: { post: true },
  },
  {
    id: 'situ-vacias', cat: 'Situaciones', icon: '🚀', title: 'Con las bases vacías',
    desc: 'Qué hace cada bateador cuando no hay nadie en base',
    dataset: 'batting', groupBy: 'player', view: 'bat', fields: ['player'], fixed: { bases: 'empty' },
  },
  // ---------- Pitcheo ----------
  {
    id: 'pit-jugador', cat: 'Pitcheo', icon: '🥎', title: 'Línea de un lanzador',
    desc: 'ERA, innings, ponches, WHIP… de un pitcher',
    dataset: 'pitching', groupBy: 'player', view: 'pit', fields: ['player'], required: ['player'],
  },
  {
    id: 'pit-vs-equipo', cat: 'Pitcheo', icon: '🆚', title: 'Lanzador contra cada rival',
    desc: '¿Cómo le fue al pitcher cada vez que enfrentó a cada equipo?',
    dataset: 'pitching', groupBy: 'vs', view: 'pit', fields: ['player', 'vsTeam'], required: ['player'],
  },
  {
    id: 'pit-vs-bateadores', cat: 'Pitcheo', icon: '🎖', title: '¿A qué bateadores domina?',
    desc: 'Cada bateador que ha enfrentado y cuánto le batea',
    dataset: 'pitching', groupBy: 'counterpart', view: 'pit', fields: ['player'], required: ['player'],
  },
  // ---------- Fildeo ----------
  {
    id: 'fildeo', cat: 'Fildeo', icon: '🧤', title: 'Fildeo y errores',
    desc: 'PO · A · E · chances totales · promedio de fildeo por jugador',
    dataset: 'fielding', groupBy: 'player', view: 'fld', fields: ['player', 'team'],
  },
  // ---------- Juegos y liga ----------
  {
    id: 'equipo-vs-equipo', cat: 'Juegos y liga', icon: '⚔️', title: 'Equipo contra equipo',
    desc: 'Historial Águilas vs Tigres: todos los juegos y el record G-P-E',
    dataset: 'games', groupBy: 'player', view: 'games', fields: ['team', 'vsTeam'], required: ['team', 'vsTeam'],
  },
  {
    id: 'carreras-entrada', cat: 'Juegos y liga', icon: '📊', title: 'Carreras por entrada',
    desc: 'Matriz equipo × entrada — quién anota temprano, quién cierra fuerte',
    dataset: 'innings', groupBy: 'player', view: 'innings', fields: ['team'],
  },
  {
    id: 'jugadas', cat: 'Juegos y liga', icon: '📋', title: 'Jugadas (detalle)',
    desc: 'Cada turno con su contexto: outs, corredores, notación — máximo detalle',
    dataset: 'plays', groupBy: 'player', view: 'plays',
    fields: ['player', 'pitcher', 'order', 'bases', 'twoOuts', 'half', 'inns', 'results'],
  },
  {
    id: 'marcadores', cat: 'Juegos y liga', icon: '🗓', title: 'Marcadores / juegos',
    desc: 'Lista de juegos finalizados con su marcador — filtra por equipo o rival',
    dataset: 'games', groupBy: 'player', view: 'games', fields: ['team', 'vsTeam'],
  },
  // ---------- SQL libre ----------
  {
    id: 'sql-libre', cat: 'SQL libre', icon: '⚡', title: 'Consulta definida por ti',
    desc: 'Escribe tu propio SELECT directo a la base de datos — sin límites de la suite',
    dataset: 'games', groupBy: 'player', view: 'games', fields: [],
  },
];

const CATS: CatKey[] = ['Bateo', 'Sabermetría', 'Carrera', 'Situaciones', 'Pitcheo', 'Fildeo', 'Juegos y liga', 'SQL libre'];

const fmt3 = (n: number) => n.toFixed(3).replace(/^0/, '');
const fmt2 = (n: number) => n.toFixed(2);
const fmt1 = (n: number) => n.toFixed(1);
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

// ---- columnas por vista: encabezado + getter (el mismo para tabla y CSV) ----
/* eslint-disable @typescript-eslint/no-explicit-any */
interface Col { h: string; g: (r: any) => string | number; strong?: boolean }
const VIEWS: Record<Exclude<ViewKey, 'plays' | 'games' | 'innings'>, Col[]> = {
  bat: [
    { h: 'PA', g: (r) => r.pa }, { h: 'AB', g: (r) => r.ab }, { h: 'R', g: (r) => r.r },
    { h: 'H', g: (r) => r.h }, { h: '2B', g: (r) => r.d2 }, { h: '3B', g: (r) => r.d3 },
    { h: 'HR', g: (r) => r.hr }, { h: 'CI', g: (r) => r.rbi }, { h: 'BB', g: (r) => r.bb },
    { h: 'K', g: (r) => r.k }, { h: 'SAC', g: (r) => r.sac }, { h: 'SF', g: (r) => r.sf },
    { h: 'SB', g: (r) => r.sb },
    { h: 'AVG', g: (r) => fmt3(r.avg), strong: true }, { h: 'OBP', g: (r) => fmt3(r.obp) },
    { h: 'SLG', g: (r) => fmt3(r.slg) }, { h: 'OPS', g: (r) => fmt3(r.ops) },
  ],
  saber: [
    { h: 'PA', g: (r) => r.pa }, { h: 'AB', g: (r) => r.ab }, { h: 'R', g: (r) => r.r },
    { h: 'H', g: (r) => r.h }, { h: '1B', g: (r) => r.singles }, { h: '2B', g: (r) => r.d2 },
    { h: '3B', g: (r) => r.d3 }, { h: 'HR', g: (r) => r.hr }, { h: 'CI', g: (r) => r.rbi },
    { h: 'BB', g: (r) => r.bb }, { h: 'K', g: (r) => r.k }, { h: 'SB', g: (r) => r.sb },
    { h: 'AVG', g: (r) => fmt3(r.avg) }, { h: 'OBP', g: (r) => fmt3(r.obp) },
    { h: 'SLG', g: (r) => fmt3(r.slg) }, { h: 'OPS', g: (r) => fmt3(r.ops), strong: true },
    { h: 'ISO', g: (r) => fmt3(r.iso) }, { h: 'BABIP', g: (r) => fmt3(r.babip) },
    { h: 'wOBA', g: (r) => fmt3(r.woba) }, { h: 'BB%', g: (r) => pct(r.bbPct) },
    { h: 'K%', g: (r) => pct(r.kPct) }, { h: 'RC', g: (r) => fmt1(r.rc) },
  ],
  pit: [
    { h: 'IP', g: (r) => fmt1(r.ip) }, { h: 'H', g: (r) => r.h }, { h: 'C', g: (r) => r.r },
    { h: 'CL', g: (r) => r.er }, { h: 'BB', g: (r) => r.bb }, { h: 'K', g: (r) => r.k },
    { h: 'HR', g: (r) => r.hr }, { h: 'Pit', g: (r) => r.pitches },
    { h: 'ERA', g: (r) => fmt2(r.era), strong: true }, { h: 'WHIP', g: (r) => fmt2(r.whip) },
    { h: 'K/9', g: (r) => fmt1(r.k9) },
  ],
  pitsaber: [
    { h: 'IP', g: (r) => fmt1(r.ip) }, { h: 'BF', g: (r) => r.bf }, { h: 'H', g: (r) => r.h },
    { h: 'C', g: (r) => r.r }, { h: 'CL', g: (r) => r.er }, { h: 'BB', g: (r) => r.bb },
    { h: 'K', g: (r) => r.k }, { h: 'HR', g: (r) => r.hr }, { h: 'Pit', g: (r) => r.pitches },
    { h: 'ERA', g: (r) => fmt2(r.era) }, { h: 'WHIP', g: (r) => fmt2(r.whip) },
    { h: 'FIP', g: (r) => fmt2(r.fip), strong: true }, { h: 'BAA', g: (r) => fmt3(r.baa) },
    { h: 'K/9', g: (r) => fmt1(r.k9) }, { h: 'BB/9', g: (r) => fmt1(r.bb9) },
    { h: 'H/9', g: (r) => fmt1(r.h9) }, { h: 'HR/9', g: (r) => fmt2(r.hr9) },
    { h: 'K/BB', g: (r) => fmt2(r.kbb) }, { h: 'P/IP', g: (r) => fmt1(r.pip) },
  ],
  fld: [
    { h: 'PO', g: (r) => r.po }, { h: 'A', g: (r) => r.a }, { h: 'E', g: (r) => r.e },
    { h: 'TC', g: (r) => r.tc, strong: true }, { h: 'FLD%', g: (r) => fmt3(r.fpct), strong: true },
  ],
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export default function ReportesPage() {
  const [leagues, setLeagues] = useState<League[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [players, setPlayers] = useState<PlayerListItem[]>([]);
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [f, setF] = useState<ReportFilters>({});
  const [res, setRes] = useState<ReportResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState('');
  const [playerQuery, setPlayerQuery] = useState('');
  const [pitcherQuery, setPitcherQuery] = useState('');
  const [extraOpen, setExtraOpen] = useState(false);
  const [sql, setSql] = useState('');
  const [sqlRes, setSqlRes] = useState<SqlResult | null>(null);
  const [tables, setTables] = useState<string[] | null>(null);
  const [cat, setCat] = useState<CatKey>('Bateo');

  useEffect(() => {
    api.leagues().then(setLeagues).catch(() => {});
    api.teams().then(setTeams).catch(() => {});
    api.playerList().then(setPlayers).catch(() => {});
  }, []);

  const preset = PRESETS.find((p) => p.id === presetId)!;
  const needs = new Set<FieldKey>(preset.fields);
  const sqlMode = presetId === 'sql-libre';
  const pickPreset = (id: string) => {
    setPresetId(id); setF({}); setRes(null); setSqlRes(null); setWarn('');
    setPlayerQuery(''); setPitcherQuery('');
  };

  const set = (k: keyof ReportFilters, v: unknown) =>
    setF((p) => ({ ...p, [k]: v === '' || v == null ? undefined : v }));

  const toggleResult = (code: string) => {
    const cur = f.results ?? [];
    set('results', cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code]);
  };

  const filteredPlayers = useMemo(() => {
    const q = playerQuery.trim().toLowerCase();
    if (!q) return players;
    return players.filter((p) => p.label.toLowerCase().includes(q) || p.team.toLowerCase().includes(q));
  }, [players, playerQuery]);

  // validación amable: qué falta para esta pregunta
  const missing = () => {
    const req = preset.required ?? [];
    if (req.includes('player') && !f.playerId) return 'Elige el jugador';
    if (req.includes('pitcher') && !f.pitcherId) return 'Elige el lanzador';
    if (req.includes('team') && !f.teamId) return 'Elige el equipo';
    if (req.includes('vsTeam') && !f.vsTeamId) return 'Elige el equipo rival';
    if (req.includes('order') && !f.order) return 'Elige el turno del orden (1º, 2º, 3º…)';
    return '';
  };

  const run = async () => {
    const m = missing();
    if (m) { setWarn(`⚠ ${m}`); return; }
    setWarn(''); setBusy(true);
    try {
      setRes(await api.report({
        dataset: preset.dataset as never,
        filters: { ...(preset.fixed ?? {}), ...f }, // el usuario puede acotar sobre los fijos
        groupBy: preset.groupBy as never,
      }));
    } catch (e) {
      setWarn(e instanceof Error ? e.message : 'Error');
    } finally { setBusy(false); }
  };

  // ---- consulta SQL libre (solo lectura en el servidor) ----
  const runSql = async (q?: string) => {
    const query = (q ?? sql).trim();
    if (!query) { setWarn('⚠ Escribe la consulta'); return; }
    setWarn(''); setBusy(true);
    try {
      const out = await api.sqlQuery(query);
      setSqlRes(out);
      if (q) setSql(q); // al correr un ejemplo, queda en la caja
    } catch (e) {
      setSqlRes(null);
      setWarn(e instanceof Error ? e.message : 'Error');
    } finally { setBusy(false); }
  };

  const showTables = async () => {
    setWarn(''); setBusy(true);
    try {
      const out = await api.sqlQuery('SHOW TABLES');
      setTables(out.rows.map((r) => String(Object.values(r)[0])));
    } catch (e) { setWarn(e instanceof Error ? e.message : 'Error'); }
    finally { setBusy(false); }
  };

  const sqlCsv = () => {
    if (!sqlRes) return;
    const body = [sqlRes.columns, ...sqlRes.rows.map((r) => sqlRes.columns.map((c) => {
      const v = r[c];
      return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }))].map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`﻿${body}`], { type: 'text/csv;charset=utf-8' }));
    a.download = `sql-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  const SQL_EXAMPLES: [string, string][] = [
    ['Tablas de la BD', 'SHOW TABLES'],
    ['Jugadores', "SELECT p.id, p.firstName, p.lastName, t.name AS equipo FROM player p LEFT JOIN team t ON t.id = p.teamId WHERE p.active = 1 LIMIT 50"],
    ['Líderes AVG 2024', "SELECT p.firstName, p.lastName, s.ab, s.h, ROUND(s.h/s.ab,3) AS avg FROM playerseasonstat s JOIN player p ON p.id = s.playerId WHERE s.season = 2024 AND s.scope = 'REG' AND s.ab >= 10 ORDER BY avg DESC LIMIT 20"],
    ['Juegos por temporada', "SELECT s.year, COUNT(*) AS juegos FROM game g JOIN season s ON s.id = g.seasonId WHERE g.status = 'FINAL' GROUP BY s.year"],
    ['Jonroneros', "SELECT p.firstName, p.lastName, SUM(s.hr) AS hr FROM playerseasonstat s JOIN player p ON p.id = s.playerId GROUP BY s.playerId ORDER BY hr DESC LIMIT 15"],
  ];

  // record G-P-E del equipo elegido vs el rival (para equipo-vs-equipo / marcadores)
  const h2h = useMemo(() => {
    if (!res?.games?.length || !f.teamId || !f.vsTeamId) return null;
    let w = 0, l = 0, t = 0;
    for (const g of res.games) {
      const [ra, rh] = g.score.split('-').map(Number);
      const myRuns = g.awayTeamId === f.teamId ? ra : rh;
      const their = g.awayTeamId === f.teamId ? rh : ra;
      if (myRuns === their) t++; else if (myRuns > their) w++; else l++;
    }
    const me = teams.find((x) => x.id === f.teamId)?.name ?? 'Equipo';
    const opp = teams.find((x) => x.id === f.vsTeamId)?.name ?? 'Rival';
    return { me, opp, w, l, t };
  }, [res, f.teamId, f.vsTeamId, teams]);

  // ---- CSV de la tabla actual (misma vista que se muestra) ----
  const csv = () => {
    if (!res) return;
    let head: string[] = []; let lines: string[][] = [];
    const cols = VIEWS[preset.view as keyof typeof VIEWS];
    if (res.rows && cols) {
      head = ['Grupo', 'Jugador', ...cols.map((c) => c.h)];
      lines = res.rows.map((r2) => [r2.group, r2.player, ...cols.map((c) => c.g(r2))].map(String));
    } else if (res.dataset === 'plays' && res.plays) {
      head = ['Fecha', 'Juego', 'Ent', 'Mitad', 'Outs', 'Bases', 'Orden', 'Bateador', 'Lanzador', 'Resultado', 'Notación', 'Carreras'];
      lines = res.plays.map((p) => [String(p.date).slice(0, 10), p.game, p.inning, p.half === 'TOP' ? '▲' : '▼', p.outs0, p.bases0, p.order ?? '', res.names?.[p.batterId ?? ''] ?? p.batterId ?? '', res.names?.[p.pitcherId ?? ''] ?? p.pitcherId ?? '', p.result, p.notation ?? '', p.runs].map(String));
    } else if (res.dataset === 'games' && res.games) {
      head = ['Fecha', 'Liga', 'Visitante', 'Local', 'Marcador'];
      lines = res.games.map((g) => [String(g.date).slice(0, 10), g.league, g.away, g.home, g.score].map(String));
    } else if (res.dataset === 'innings' && res.innings) {
      head = ['Equipo', ...Array.from({ length: res.innings.maxInn }, (_, i) => `${i + 1}ª`), 'Total'];
      lines = res.innings.rows.map((t) => [t.team, ...t.innings.map(String), String(t.total)]);
    }
    const body = [head, ...lines].map((r2) => r2.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`﻿${body}`], { type: 'text/csv;charset=utf-8' }));
    a.download = `reporte-${res.dataset}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  const showRows = res?.rows && preset.view in VIEWS;
  const rowCols = showRows ? VIEWS[preset.view as keyof typeof VIEWS] : null;

  const playerField = (key: 'player' | 'pitcher') => {
    const q = key === 'player' ? playerQuery : pitcherQuery;
    const setQ = key === 'player' ? setPlayerQuery : setPitcherQuery;
    const listId = `rep-${key}s`;
    const list = key === 'player' ? filteredPlayers : players;
    return (
      <label key={key}>{key === 'player' ? (preset.dataset === 'pitching' ? 'Lanzador' : 'Jugador') : 'Vs lanzador'}
        <input list={listId} placeholder="Escribe el nombre…" value={q}
          onChange={(e) => {
            setQ(e.target.value);
            const m = players.find((p) => `${p.label} — ${p.team}` === e.target.value || p.label === e.target.value);
            set(key === 'player' ? 'playerId' : 'pitcherId', m?.id);
          }} />
        <datalist id={listId}>
          {list.slice(0, 60).map((p) => <option key={p.id} value={`${p.label} — ${p.team}`} />)}
        </datalist>
      </label>
    );
  };

  const teamField = (key: 'team' | 'vsTeam') => (
    <label key={key}>{key === 'team' ? 'Equipo' : 'Contra… (rival)'}
      <select value={(key === 'team' ? f.teamId : f.vsTeamId) ?? ''}
        onChange={(e) => set(key === 'team' ? 'teamId' : 'vsTeamId', e.target.value || undefined)}>
        <option value="">{key === 'team' ? 'Todos' : 'Cualquiera'}</option>
        {teams.map((t) => <option key={t.id} value={t.id}>{t.name} {t.league ? `(${t.league.year})` : ''}</option>)}
      </select>
    </label>
  );

  return (
    <div className="page report-page">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>📊 Suite de reportes</h1>
        {res && (
          <div className="row">
            <button className="secondary" onClick={csv}>⬇ CSV</button>
            <button className="secondary" onClick={() => window.print()}>🖨 Imprimir</button>
          </div>
        )}
      </div>

      {/* ---- Paso 1: ¿qué quieres saber? — chips de categoría + su grid ---- */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>1 · ¿Qué quieres saber?</h3>
        <div className="cat-tabs">
          {CATS.map((c) => (
            <button key={c} className={`cat-tab${cat === c ? ' on' : ''}`} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>
        <div className="preset-grid">
          {PRESETS.filter((p) => p.cat === cat).map((p) => (
            <button key={p.id} className={`preset-card${presetId === p.id ? ' on' : ''}`} onClick={() => pickPreset(p.id)}>
              <span className="preset-icon">{p.icon}</span>
              <span className="preset-txt"><strong>{p.title}</strong><small>{p.desc}</small></span>
            </button>
          ))}
        </div>
      </div>

      {/* ---- Paso 2: solo los campos que esta pregunta necesita ---- */}
      <div className="card report-form">
        <h3 style={{ marginTop: 0 }}>2 · {sqlMode ? 'Tu consulta' : 'Completa'} <span className="muted" style={{ fontWeight: 400, fontSize: '0.85rem' }}>— {preset.icon} {preset.title}{!sqlMode && preset.fixed ? ` · la pregunta ya trae su filtro${preset.fixed.inningFrom ? ` (entradas ${preset.fixed.inningFrom}+)` : ''}` : ''}</span></h3>

        {sqlMode && (
          <div>
            <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
              SQL directo a la base de datos — <strong>solo lectura</strong> (SELECT / SHOW / EXPLAIN, una sentencia, máx. 15s y 1000 filas).
              <button className="linklike" style={{ marginLeft: 8 }} onClick={showTables} disabled={busy}>{tables ? '▾ Ocultar tablas' : '▸ Ver tablas'}</button>
            </p>
            {tables && (
              <p className="muted" style={{ fontSize: '0.82rem', marginTop: '-0.3rem' }}>
                {tables.map((t) => <button key={t} className="chip-mini" style={{ marginRight: 4 }} onClick={() => setSql(`SELECT * FROM ${t} LIMIT 50`)}>{t}</button>)}
              </p>
            )}
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              placeholder="SELECT … FROM …"
              spellCheck={false}
              style={{ width: '100%', minHeight: 110, fontFamily: 'monospace', fontSize: '0.85rem', padding: '0.6rem', borderRadius: 8, border: '1px solid var(--border)' }}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runSql(); }}
            />
            <div className="row" style={{ gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.4rem' }}>
              <span className="muted" style={{ fontSize: '0.8rem' }}>Ejemplos:</span>
              {SQL_EXAMPLES.map(([label, q]) => (
                <button key={label} className="chip-mini" onClick={() => setSql(q)}>{label}</button>
              ))}
              <span className="muted" style={{ fontSize: '0.8rem' }}>· Ctrl+Enter corre</span>
            </div>
          </div>
        )}

        {!sqlMode && (
        <>
        {needs.size === 0 && (
          <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>Esta pregunta no necesita datos — genera directo (o acota con «Más filtros»).</p>
        )}
        <div className="report-grid">
          {needs.has('player') && playerField('player')}
          {needs.has('pitcher') && playerField('pitcher')}
          {needs.has('team') && teamField('team')}
          {needs.has('vsTeam') && teamField('vsTeam')}
          {needs.has('order') && (
            <label>Turno en el orden
              <select value={f.order ?? ''} onChange={(e) => set('order', e.target.value ? Number(e.target.value) : undefined)}>
                <option value="">Todos</option>
                {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}º</option>)}
              </select>
            </label>
          )}
          {needs.has('bases') && (
            <label>Corredores
              <select value={f.bases ?? ''} onChange={(e) => set('bases', e.target.value || undefined)}>
                <option value="">Cualquiera</option>
                <option value="empty">Bases vacías</option>
                <option value="any">Con corredores</option>
                <option value="risp">En posición de anotar (2ª/3ª)</option>
                <option value="loaded">Bases llenas</option>
              </select>
            </label>
          )}
          {needs.has('half') && (
            <label>Mitad
              <select value={f.half ?? ''} onChange={(e) => set('half', e.target.value || undefined)}>
                <option value="">Ambas</option>
                <option value="TOP">▲ Alta (visitante)</option>
                <option value="BOTTOM">▼ Baja (local)</option>
              </select>
            </label>
          )}
          {needs.has('inns') && (
            <label>Entradas
              <div className="row" style={{ gap: 4 }}>
                <input type="number" min={1} max={20} placeholder="de" style={{ width: 60 }}
                  value={f.inningFrom ?? preset.fixed?.inningFrom ?? ''} onChange={(e) => set('inningFrom', e.target.value ? Number(e.target.value) : undefined)} />
                <input type="number" min={1} max={20} placeholder="a" style={{ width: 60 }}
                  value={f.inningTo ?? ''} onChange={(e) => set('inningTo', e.target.value ? Number(e.target.value) : undefined)} />
              </div>
            </label>
          )}
          {needs.has('twoOuts') && (
            <label className="report-check">
              <input type="checkbox" checked={!!f.twoOuts} onChange={(e) => set('twoOuts', e.target.checked || undefined)} />
              {' '}Solo con 2 outs
            </label>
          )}
        </div>

        {needs.has('results') && (
          <div className="report-results-pick">
            <span className="muted" style={{ fontSize: '0.8rem' }}>Resultados (vacío = todos):</span>
            {RESULT_GROUPS.map((g) => (
              <div key={g.label} className="report-resgroup">
                <small className="muted">{g.label}</small>
                {g.codes.map((c) => (
                  <button key={c} className={`chip-mini${f.results?.includes(c) ? ' on' : ''}`}
                    onClick={() => toggleResult(c)}>{c}</button>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* ---- filtros extra (opcionales, colapsados) ---- */}
        <button className="linklike muted" style={{ marginTop: '0.5rem' }} onClick={() => setExtraOpen((v) => !v)}>
          {extraOpen ? '▾ Menos filtros' : '▸ Más filtros (liga · fechas · fase · equipo)'}
        </button>
        {extraOpen && (
          <div className="report-grid" style={{ marginTop: '0.4rem' }}>
            <label>Liga
              <select value={f.leagueId ?? ''} onChange={(e) => set('leagueId', e.target.value || undefined)}>
                <option value="">Todas</option>
                {leagues.map((l) => <option key={l.id} value={l.id}>{l.name} {l.year}</option>)}
              </select>
            </label>
            {!needs.has('team') && teamField('team')}
            {!needs.has('vsTeam') && teamField('vsTeam')}
            {!needs.has('half') && (
              <label>Mitad
                <select value={f.half ?? ''} onChange={(e) => set('half', e.target.value || undefined)}>
                  <option value="">Ambas</option>
                  <option value="TOP">▲ Alta</option>
                  <option value="BOTTOM">▼ Baja</option>
                </select>
              </label>
            )}
            {!needs.has('inns') && (
              <label>Entradas
                <div className="row" style={{ gap: 4 }}>
                  <input type="number" min={1} max={20} placeholder="de" style={{ width: 60 }}
                    value={f.inningFrom ?? ''} onChange={(e) => set('inningFrom', e.target.value ? Number(e.target.value) : undefined)} />
                  <input type="number" min={1} max={20} placeholder="a" style={{ width: 60 }}
                    value={f.inningTo ?? ''} onChange={(e) => set('inningTo', e.target.value ? Number(e.target.value) : undefined)} />
                </div>
              </label>
            )}
            <label>Fechas
              <div className="row" style={{ gap: 4 }}>
                <input type="date" value={f.dateFrom ?? ''} onChange={(e) => set('dateFrom', e.target.value || undefined)} />
                <input type="date" value={f.dateTo ?? ''} onChange={(e) => set('dateTo', e.target.value || undefined)} />
              </div>
            </label>
            <label>Fase
              <select value={f.post === undefined ? '' : String(f.post)} onChange={(e) => set('post', e.target.value === '' ? undefined : e.target.value === 'true')}>
                <option value="">Todas</option>
                <option value="false">Temporada regular</option>
                <option value="true">Playoffs</option>
              </select>
            </label>
          </div>
        )}

        </>
        )}

        <div className="row" style={{ marginTop: '0.8rem' }}>
          <button className="big" onClick={() => (sqlMode ? runSql() : run())} disabled={busy}>{busy ? 'Consultando…' : sqlMode ? '▶ Ejecutar consulta' : '▶ Generar reporte'}</button>
          {warn && <span style={{ color: 'var(--red, #dc2626)', fontSize: '0.85rem' }}>{warn}</span>}
          {res && !sqlMode && <span className="muted">{res.gamesCount != null && `${res.gamesCount} juegos · `}{res.rows?.length ?? res.plays?.length ?? res.games?.length ?? res.innings?.rows.length ?? 0} filas</span>}
          {sqlRes && sqlMode && <span className="muted">{sqlRes.rows.length} filas{sqlRes.truncated ? ' (limitado a 1000)' : ''} · {sqlRes.ms} ms</span>}
          {sqlRes && sqlMode && <button className="secondary" onClick={sqlCsv}>⬇ CSV</button>}
        </div>
      </div>

      {/* ---- record G-P-E cuando hay equipo y rival ---- */}
      {h2h && (
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '1.05rem', fontWeight: 700 }}>
            {h2h.me} <span className="muted">vs</span> {h2h.opp}
          </div>
          <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--navy)', marginTop: 4 }}>
            {h2h.w}G – {h2h.l}P{h2h.t ? ` – ${h2h.t}E` : ''}
            <span className="muted" style={{ fontSize: '0.85rem', fontWeight: 400 }}> en {h2h.w + h2h.l + h2h.t} juegos</span>
          </div>
        </div>
      )}

      {/* ---- Resultados ---- */}
      {showRows && rowCols && (
        <div className="card report-out">
          <table className="tbl">
            <thead><tr>
              <th>Grupo</th><th>{preset.dataset === 'pitching' ? 'Lanzador' : 'Jugador'}</th>
              {rowCols.map((c) => <th key={c.h}>{c.h}</th>)}
            </tr></thead>
            <tbody>
              {res!.rows!.map((r2, i) => (
                <tr key={i}>
                  <td className="muted">{r2.group}</td>
                  <td><Link to={`/players/${r2.playerId}`}>{r2.player}</Link></td>
                  {rowCols.map((c) => (
                    <td key={c.h}>{c.strong ? <strong>{c.g(r2)}</strong> : c.g(r2)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {res?.dataset === 'plays' && res.plays && (
        <div className="card report-out">
          {res.truncated && <p className="muted">⚠ Mostrando las primeras 800 jugadas — agrega filtros para acotar.</p>}
          <table className="tbl">
            <thead><tr>
              <th>Fecha</th><th>Juego</th><th>Ent</th><th></th><th>Outs</th><th>Bases</th><th>#Ord</th>
              <th>Bateador</th><th>Lanzador</th><th>Res</th><th>Notación</th><th>C</th>
            </tr></thead>
            <tbody>
              {res.plays.map((p, i) => (
                <tr key={i}>
                  <td>{String(p.date).slice(0, 10)}</td>
                  <td><Link to={`/games/${p.gameId}`}>{p.game}</Link></td>
                  <td>{p.inning}</td><td>{p.half === 'TOP' ? '▲' : '▼'}</td><td>{p.outs0}</td>
                  <td style={{ letterSpacing: 2 }}>{p.bases0}</td><td>{p.order ?? ''}</td>
                  <td>{p.batterId ? <Link to={`/players/${p.batterId}`}>{res.names?.[p.batterId] ?? p.batterId}</Link> : '—'}</td>
                  <td>{res.names?.[p.pitcherId ?? ''] ?? '—'}</td>
                  <td><strong>{p.result}</strong></td><td>{p.notation ?? ''}</td><td>{p.runs || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {res?.dataset === 'games' && res.games && (
        <div className="card report-out">
          <table className="tbl">
            <thead><tr><th>Fecha</th><th>Liga</th><th>Visitante</th><th>Local</th><th>Marcador</th></tr></thead>
            <tbody>
              {res.games.map((g) => (
                <tr key={g.gameId}>
                  <td>{String(g.date).slice(0, 10)}</td><td className="muted">{g.league}</td>
                  <td>{g.away}</td><td>{g.home}</td>
                  <td><Link to={`/games/${g.gameId}`}><strong>{g.score}</strong></Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {res?.dataset === 'innings' && res.innings && (
        <div className="card report-out">
          <table className="tbl">
            <thead><tr>
              <th>Equipo</th>
              {Array.from({ length: res.innings.maxInn }, (_, i) => <th key={i}>{i + 1}</th>)}
              <th>Total</th>
            </tr></thead>
            <tbody>
              {res.innings.rows.map((t) => (
                <tr key={t.teamId}>
                  <td style={{ textAlign: 'left' }}><strong>{t.team}</strong></td>
                  {t.innings.map((r2, i) => <td key={i} className={r2 ? '' : 'muted'}>{r2 || '·'}</td>)}
                  <td><strong>{t.total}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Resultado de la consulta SQL libre ---- */}
      {sqlRes && (
        <div className="card report-out">
          {sqlRes.truncated && <p className="muted">⚠ Limitado a las primeras 1000 filas — agrega LIMIT / WHERE para acotar.</p>}
          {sqlRes.rows.length === 0 && <p className="muted">0 filas{sqlRes.columns.length === 0 ? '' : ` · columnas: ${sqlRes.columns.join(', ')}`}</p>}
          {sqlRes.rows.length > 0 && (
            <div className="tw">
              <table className="tbl">
                <thead><tr>{sqlRes.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>
                  {sqlRes.rows.map((r, i) => (
                    <tr key={i}>
                      {sqlRes.columns.map((c) => {
                        const v = r[c];
                        return <td key={c} style={{ fontFamily: typeof v === 'number' ? 'inherit' : 'monospace', fontSize: '0.82rem' }}>
                          {v == null ? <span className="muted">null</span> : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                        </td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
