import { useEffect, useState } from 'react';
import { api, Game, League, LeagueStats, Player, StandingRow, Team } from '../api';
import PrintSheet from './PrintSheet';

// Reportes imprimibles de una liga (hoja carta 8.5×11 → Imprimir / Guardar como PDF).
// El modal elige qué reportes; la hoja los imprime en orden, cada uno en su página.

export type ReportId = 'resultados' | 'posiciones' | 'lideres' | 'lideres1' | 'mvp' | 'totales' | 'bateo' | 'pitcheo' | 'fildeo' | 'situacional' | 'rosters' | 'calendario';

export const REPORTS: { id: ReportId; label: string; desc: string; stats?: boolean }[] = [
  { id: 'resultados', label: 'Resultados', desc: 'Juegos finalizados con marcador, forfeit y empates' },
  { id: 'posiciones', label: 'Posiciones', desc: 'Tabla de posiciones con G, P, PCT, JB, CF, CC y DIF' },
  { id: 'lideres', label: 'Lideratos', desc: 'Top 10 de bateo y pitcheo (respeta reglas de clasificación de la liga)', stats: true },
  { id: 'lideres1', label: 'Líderes (solo 1º)', desc: 'Solo el líder de cada departamento — incluye todos los empatados', stats: true },
  { id: 'mvp', label: 'MVP de la temporada', desc: 'Calculado automático: WAR ofensivo + WAR de pitcheo + lideratos ponderados (tinta estilo MLB)', stats: true },
  { id: 'totales', label: 'Totales por equipo', desc: 'Carreras, hits, errores y dejados en base', stats: true },
  { id: 'bateo', label: 'Bateo individual', desc: 'Línea completa de bateo de cada jugador', stats: true },
  { id: 'pitcheo', label: 'Pitcheo individual', desc: 'Línea completa de pitcheo de cada lanzador', stats: true },
  { id: 'fildeo', label: 'Fildeo individual', desc: 'PO, A, E, TC y FPCT de cada jugador', stats: true },
  { id: 'situacional', label: 'Bateo situacional', desc: 'RISP, bases llenas, 2 outs y leadoff', stats: true },
  { id: 'rosters', label: 'Rosters', desc: 'Jugadores de cada equipo (número, nombre, posición, B/T)' },
  { id: 'calendario', label: 'Calendario', desc: 'Juegos programados por jornada' },
];

const f3 = (n: number) => n.toFixed(3).replace(/^0/, '');
const ipOf = (outs: number) => `${Math.floor(outs / 3)}.${outs % 3}`;
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const needsStats = (id: ReportId) => !!REPORTS.find((r) => r.id === id)?.stats;

type Ldr = { label: string; pts: number; rows: { playerId: string; name: string; team: string; val: string }[] };

// Líderes con las mismas reglas de clasificación que el reporte de la liga (PA/IP por juego del equipo)
// topOnly: solo el 1er lugar de cada departamento — con TODOS los empatados
function leaderCats(league: League, stats: LeagueStats, topOnly = false): { batCats: Ldr[]; pitCats: Ldr[] } {
  const qPa = league.qualPa ?? 3.1, qIp = league.qualIp ?? 1.0;
  const tg = (tid: string) => stats.teamTotals.find((t) => t.teamId === tid)?.g ?? 0;
  const paNeed = (b: { teamId: string; pa: number }) => Math.round(tg(b.teamId) * qPa);
  const outsNeed = (p: { teamId: string; outs: number }) => Math.round(tg(p.teamId) * qIp * 3);
  const batQ = stats.batting.filter((b) => qPa <= 0 || b.pa >= paNeed(b));
  const bestAvg = batQ.length ? Math.max(...batQ.map((b) => b.avg)) : -1;
  const avgSet = [...batQ, ...stats.batting.filter((b) =>
    !batQ.includes(b) && bestAvg > 0 && b.h > 0 && b.h / (b.ab + (paNeed(b) - b.pa)) >= bestAvg)];
  const pitQ = stats.pitching.filter((p) => qIp <= 0 || p.outs >= outsNeed(p));
  const TOP = 10;
  const pick = <T extends { name: string; shortName: string; playerId: string }>(arr: T[], key: (x: T) => number, fmt: (x: T) => string, min = 1) => {
    const sorted = [...arr].sort((a, b) => key(b) - key(a)).filter((x) => key(x) >= min);
    const kept = topOnly && sorted.length ? sorted.filter((x) => key(x) === key(sorted[0])) : sorted.slice(0, TOP);
    return kept.map((x) => ({ playerId: x.playerId, name: x.name, team: x.shortName, val: fmt(x) }));
  };
  const batCats = [
    { label: 'Promedio (AVG)', pts: 4, rows: pick(avgSet, (b) => b.avg, (b) => f3(b.avg), 0.001) },
    { label: 'Hits', pts: 3, rows: pick(stats.batting, (b) => b.h, (b) => String(b.h)) },
    { label: 'Jonrones', pts: 4, rows: pick(stats.batting, (b) => b.hr, (b) => String(b.hr)) },
    { label: 'Carreras impulsadas', pts: 4, rows: pick(stats.batting, (b) => b.rbi, (b) => String(b.rbi)) },
    { label: 'Carreras anotadas', pts: 3, rows: pick(stats.batting, (b) => b.r, (b) => String(b.r)) },
    { label: 'Bases robadas', pts: 2, rows: pick(stats.batting, (b) => b.sb, (b) => String(b.sb)) },
    { label: 'OPS', pts: 3, rows: pick(batQ, (b) => b.ops, (b) => f3(b.ops), 0.001) },
    ...(topOnly ? [
      { label: 'Dobles', pts: 2, rows: pick(stats.batting, (b) => b.doubles, (b) => String(b.doubles)) },
      { label: 'Triples', pts: 1, rows: pick(stats.batting, (b) => b.triples, (b) => String(b.triples)) },
      { label: 'Embasado (OBP)', pts: 2, rows: pick(batQ, (b) => b.obp, (b) => f3(b.obp), 0.001) },
      { label: 'Slugging (SLG)', pts: 3, rows: pick(batQ, (b) => b.slg, (b) => f3(b.slg), 0.001) },
      { label: 'Bases por bolas', pts: 2, rows: pick(stats.batting, (b) => b.bb, (b) => String(b.bb)) },
    ] : []),
  ].filter((c) => c.rows.length);
  const pitCats = [
    { label: 'Efectividad (ERA)', pts: 4, rows: pick(pitQ, (p) => -p.era, (p) => p.era.toFixed(2), -999) },
    { label: 'Ganados', pts: 4, rows: pick(stats.pitching, (p) => p.w, (p) => String(p.w)) },
    { label: 'Ponches', pts: 4, rows: pick(stats.pitching, (p) => p.k, (p) => String(p.k)) },
    { label: 'Salvados', pts: 3, rows: pick(stats.pitching, (p) => p.sv, (p) => String(p.sv)) },
    { label: 'Entradas (IP)', pts: 3, rows: pick(stats.pitching, (p) => p.outs, (p) => ipOf(p.outs)) },
    { label: 'WHIP', pts: 2, rows: pick(pitQ, (p) => -p.whip, (p) => p.whip.toFixed(2), -999) },
    ...(topOnly ? [
      { label: 'Hold (HLD)', pts: 1, rows: pick(stats.pitching, (p) => p.hld, (p) => String(p.hld)) },
      { label: 'Juegos completos', pts: 2, rows: pick(stats.pitching, (p) => p.cg, (p) => String(p.cg)) },
      { label: 'Blanqueadas', pts: 1, rows: pick(stats.pitching, (p) => p.sho, (p) => String(p.sho)) },
    ] : []),
  ].filter((c) => c.rows.length);
  return { batCats, pitCats };
}

// ── MVP automático: WAR* ofensivo + WAR* de pitcheo por jugador ─────────────
// WAR* lo calcula el server en aggregateGames (wRAA calibrado a la liga +
// FIP de pitcheo vs nivel de reemplazo). Un jugador de dos vías suma ambos.
export interface MvpRow {
  playerId: string; name: string; shortName: string;
  warBat: number; warPit: number; total: number;
  deps: number; depList: string[]; ink: number; score: number;
  line: string;   // resumen de su temporada para la tabla de candidatos
}
// puntos MVP = warBat + warPit × 0.75 + "tinta" ponderada por lideratos.
// El WAR de pitcheo se descuenta ×0.75 como hacen los votantes MLB: el
// lanzador controla más eventos por juego (en ligas locales puede lanzar
// TODOS los juegos) y acumula WAR más rápido que un bateador de línea —
// sin descuento el MVP sería casi siempre del as del staff. La tinta imita
// el Black Ink Test (cada depto vale 4/3/2/1 pts según peso: AVG·HR·CI·W·
// ERA·K = 4 … 3B·HLD·SHO = 1), empates cuentan completo para todos
// (co-líderes) y se escala ×0.25 con tope 3.0.
const MVP_PIT_FACTOR = 0.75;
const MVP_INK_SCALE = 0.25;
const MVP_INK_CAP = 3;
export function mvpCandidates(stats: LeagueStats, league: League): MvpRow[] {
  const m = new Map<string, MvpRow & { b?: { avg: number; hr: number; rbi: number; sb: number }; p?: { w: number; l: number; era: number; k: number; sv: number } }>();
  const row = (pid: string, name: string, shortName: string) => {
    if (!m.has(pid)) m.set(pid, { playerId: pid, name, shortName, warBat: 0, warPit: 0, total: 0, deps: 0, depList: [], ink: 0, score: 0, line: '' });
    return m.get(pid)!;
  };
  for (const b of stats.batting) {
    const r = row(b.playerId, b.name, b.shortName);
    r.warBat = b.war ?? 0;
    r.b = { avg: b.avg, hr: b.hr, rbi: b.rbi, sb: b.sb };
  }
  for (const p of stats.pitching) {
    const r = row(p.playerId, p.name, p.shortName);
    r.warPit = p.war ?? 0;
    r.p = { w: p.w, l: p.l, era: p.era, k: p.k, sv: p.sv };
  }
  // departamentos liderados por jugador (topOnly = líder + co-líderes empatados)
  const deps = new Map<string, string[]>();
  const inkOf = new Map<string, number>();
  const { batCats, pitCats } = leaderCats(league, stats, true);
  for (const c of [...batCats, ...pitCats]) {
    for (const r of c.rows) {
      deps.set(r.playerId, [...(deps.get(r.playerId) ?? []), c.label]);
      inkOf.set(r.playerId, (inkOf.get(r.playerId) ?? 0) + c.pts);
    }
  }
  return [...m.values()].map((r) => {
    const depList = deps.get(r.playerId) ?? [];
    const ink = inkOf.get(r.playerId) ?? 0;
    const total = +(r.warBat + r.warPit).toFixed(2);
    return {
      ...r,
      total,
      deps: depList.length,
      depList,
      ink,
      score: +(r.warBat + r.warPit * MVP_PIT_FACTOR + Math.min(MVP_INK_CAP, ink * MVP_INK_SCALE)).toFixed(2),
      line: [
        r.b ? `${f3(r.b.avg)} AVG · ${r.b.hr} HR · ${r.b.rbi} CI · ${r.b.sb} BR` : '',
        r.p ? `${r.p.w}-${r.p.l} · ${r.p.era.toFixed(2)} ERA · ${r.p.k} K${r.p.sv ? ` · ${r.p.sv} SV` : ''}` : '',
      ].filter(Boolean).join('  ·  '),
    };
  }).sort((a, b) => b.score - a.score || b.total - a.total || b.warBat - a.warBat);
}

// ───────────────────────── Modal de selección ─────────────────────────
export function LeagueReportsModal({ stats, onClose, onPrint }: {
  stats: LeagueStats | null; onClose: () => void; onPrint: (ids: ReportId[]) => void;
}) {
  const [sel, setSel] = useState<ReportId[]>(REPORTS.map((r) => r.id));
  const toggle = (id: ReportId) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const ready = (id: ReportId) => !(needsStats(id) && !stats);
  const chosen = REPORTS.map((r) => r.id).filter((id) => sel.includes(id) && ready(id));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 580 }}>
        <h2 style={{ marginTop: 0 }}>📄 Reportes de la liga</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Elige qué reportes incluir. Se abren en hoja carta 8.5×11 — en el diálogo de impresión elige «Guardar como PDF».
        </p>
        <div className="row" style={{ gap: '0.4rem', marginBottom: '0.3rem' }}>
          <button className="secondary sm" onClick={() => setSel(REPORTS.map((r) => r.id))}>Todos</button>
          <button className="secondary sm" onClick={() => setSel([])}>Ninguno</button>
        </div>
        {REPORTS.map((r) => {
          const dis = !ready(r.id);
          return (
            <label key={r.id} className="row" style={{ alignItems: 'flex-start', gap: '0.55rem', padding: '0.45rem 0', borderBottom: '1px solid var(--border)', opacity: dis ? 0.5 : 1, cursor: dis ? 'not-allowed' : 'pointer' }}>
              <input type="checkbox" checked={sel.includes(r.id)} disabled={dis} onChange={() => toggle(r.id)} style={{ marginTop: 4 }} />
              <span>
                <strong>{r.label}</strong>{dis && <span className="muted"> — cargando estadísticas…</span>}<br />
                <span className="muted" style={{ fontSize: '0.8rem' }}>{r.desc}</span>
              </span>
            </label>
          );
        })}
        <div className="row" style={{ justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
          <button className="secondary" onClick={onClose}>Cerrar</button>
          <button disabled={!chosen.length} onClick={() => onPrint(chosen)}>🖨️ Ver e imprimir ({chosen.length})</button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Hoja imprimible ─────────────────────────
export function LeagueReportSheet({ league, stats, standings, games, ids, yearLabel, phaseLabel, onClose }: {
  league: League; stats: LeagueStats | null; standings: StandingRow[]; games: Game[]; ids: ReportId[];
  yearLabel: string; phaseLabel: string; onClose: () => void;
}) {
  const [rosters, setRosters] = useState<{ team: Team; players: Player[] }[] | null>(null);
  useEffect(() => {
    if (!ids.includes('rosters')) return;
    Promise.all((league.teams ?? []).map((t) => api.team(t.id)))
      .then((rs) => setRosters(rs.map((t) => ({ team: t, players: (t.players ?? []).slice() }))))
      .catch(() => setRosters([]));
  }, []);

  const finals = games.filter((g) => g.status === 'FINAL');
  const sched = games.filter((g) => g.status === 'SCHEDULED')
    .slice().sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const Empty = ({ cols }: { cols: number }) => <tr><td colSpan={cols}>—</td></tr>;

  const renderSection = (id: ReportId) => {
    switch (id) {
      case 'resultados': return (<>
        <h2>Resultados</h2>
        <table className="report-table">
          <thead><tr><th>Fecha</th><th>Visitante</th><th>Carreras</th><th>Local</th><th>Carreras</th><th>Nota</th></tr></thead>
          <tbody>
            {finals.map((g) => (
              <tr key={g.id}>
                <td>{new Date(g.date).toLocaleDateString()}</td>
                <td>{g.awayTeam?.name}</td>
                <td><strong>{g.fScoreAway ?? g.state?.score.away ?? '—'}</strong></td>
                <td>{g.homeTeam?.name}</td>
                <td><strong>{g.fScoreHome ?? g.state?.score.home ?? '—'}</strong></td>
                <td>{g.forfeitBy ? 'FORFEIT' : g.tied ? 'EMPATE' : ''}</td>
              </tr>
            ))}
            {!finals.length && <tr><td colSpan={6}>Sin juegos finalizados</td></tr>}
          </tbody>
        </table>
      </>);
      case 'posiciones': return (<>
        <h2>Posiciones</h2>
        <table className="report-table">
          <thead><tr><th>#</th><th>Equipo</th><th>G</th><th>P</th><th>E</th><th>PCT</th><th>JB</th><th>CF</th><th>CC</th><th>DIF</th></tr></thead>
          <tbody>
            {standings.map((t, i) => (
              <tr key={t.teamId}><td>{i + 1}</td><td>{t.name}</td><td>{t.w}</td><td>{t.l}</td><td>{t.t}</td><td>{f3(t.pct)}</td><td>{t.gb === 0 ? '—' : t.gb.toFixed(1)}</td><td>{t.rf}</td><td>{t.ra}</td><td>{t.diff > 0 ? `+${t.diff}` : t.diff}</td></tr>
            ))}
            {!standings.length && <Empty cols={10} />}
          </tbody>
        </table>
      </>);
      case 'lideres': {
        if (!stats) return <p>Cargando estadísticas…</p>;
        const { batCats, pitCats } = leaderCats(league, stats);
        const Tbl = ({ label, rows }: Ldr) => (
          <table className="report-table" style={{ pageBreakInside: 'avoid' }}>
            <thead><tr><th colSpan={3} style={{ textAlign: 'left', fontSize: '0.8rem' }}>{label}</th></tr>
              <tr><th>#</th><th style={{ textAlign: 'left' }}>Jugador</th><th /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}><td>{i + 1}</td>
                  <td style={{ textAlign: 'left' }}>{r.name} <span style={{ color: '#666', fontSize: '0.9em' }}>{r.team}</span></td>
                  <td><strong>{r.val}</strong></td></tr>
              ))}
              {!rows.length && <tr><td colSpan={3}>—</td></tr>}
            </tbody>
          </table>
        );
        return (<>
          <h2>Lideratos — bateo</h2>
          <div className="ldr-grid">{batCats.map((c) => <Tbl key={c.label} {...c} />)}</div>
          <h2>Lideratos — pitcheo</h2>
          <div className="ldr-grid">{pitCats.map((c) => <Tbl key={c.label} {...c} />)}</div>
          {!batCats.length && !pitCats.length && <p>Sin datos — finaliza juegos del torneo.</p>}
        </>);
      }
      case 'lideres1': {
        if (!stats) return <p>Cargando estadísticas…</p>;
        const { batCats, pitCats } = leaderCats(league, stats, true);
        const Tbl = ({ title, cats }: { title: string; cats: Ldr[] }) => (
          <>
            <h2>{title}</h2>
            <table className="report-table">
              <thead><tr><th style={{ textAlign: 'left', width: '34%' }}>Departamento</th><th style={{ textAlign: 'left' }}>Líder</th><th>Marca</th></tr></thead>
              <tbody>
                {cats.map((c) => c.rows.map((r, i) => (
                  <tr key={`${c.label}-${i}`}>
                    {i === 0 && <td style={{ textAlign: 'left', fontWeight: 700 }} rowSpan={c.rows.length}>{c.label}</td>}
                    <td style={{ textAlign: 'left' }}>
                      {r.name} <span style={{ color: '#666', fontSize: '0.9em' }}>{r.team}</span>
                      {c.rows.length > 1 && <span style={{ color: '#b45309', fontSize: '0.85em' }}> (empate)</span>}
                    </td>
                    <td><strong>{r.val}</strong></td>
                  </tr>
                )))}
                {!cats.length && <tr><td colSpan={3}>—</td></tr>}
              </tbody>
            </table>
          </>
        );
        return (<>
          <Tbl title="Líderes — bateo" cats={batCats} />
          <Tbl title="Líderes — pitcheo" cats={pitCats} />
          {!batCats.length && !pitCats.length && <p>Sin datos — finaliza juegos del torneo.</p>}
        </>);
      }
      case 'mvp': {
        if (!stats) return <p>Cargando estadísticas…</p>;
        const rows = mvpCandidates(stats, league).filter((r) => r.score > 0);
        const win = rows[0];
        return (<>
          <h2>🏆 MVP de la temporada</h2>
          {win ? (<>
            <table className="report-table" style={{ pageBreakInside: 'avoid' }}>
              <tbody>
                <tr>
                  <td style={{ textAlign: 'left', fontSize: '1.15rem', fontWeight: 800 }}>{win.name} <span style={{ color: '#666', fontWeight: 400, fontSize: '0.9em' }}>{win.shortName}</span></td>
                  <td style={{ textAlign: 'right' }}>
                    <strong style={{ fontSize: '1.3rem' }}>{win.score.toFixed(2)}</strong>
                    <div style={{ fontSize: '0.8rem', color: '#666' }}>Puntos MVP</div>
                  </td>
                </tr>
                <tr><td colSpan={2} style={{ textAlign: 'left', fontSize: '0.9rem' }}>{win.line || '—'}</td></tr>
                {win.depList.length > 0 && (
                  <tr><td colSpan={2} style={{ textAlign: 'left', fontSize: '0.82rem', color: '#666' }}>
                    🏅 Lidera {win.deps} departamento(s) · {win.ink} pts tinta: {win.depList.join(' · ')}
                  </td></tr>
                )}
              </tbody>
            </table>
            <h3 style={{ marginTop: '1rem' }}>Candidatos</h3>
            <table className="report-table">
              <thead><tr><th>#</th><th style={{ textAlign: 'left' }}>Jugador</th><th style={{ textAlign: 'left' }}>Temporada</th><th>WAR of.</th><th>WAR pit.</th><th>WAR</th><th>Tinta</th><th>Puntos</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.playerId} style={i === 0 ? { background: '#fef9c3', fontWeight: 700 } : undefined}>
                    <td>{i + 1}</td>
                    <td style={{ textAlign: 'left' }}>{r.name} <span style={{ color: '#666', fontSize: '0.9em' }}>{r.shortName}</span></td>
                    <td style={{ textAlign: 'left', fontSize: '0.85rem' }}>
                      {r.line}
                      {r.depList.length > 0 && <div style={{ fontSize: '0.72rem', color: '#666' }}>🏅 {r.depList.join(' · ')}</div>}
                    </td>
                    <td>{r.warBat.toFixed(2)}</td><td>{r.warPit.toFixed(2)}</td><td>{r.total.toFixed(2)}</td>
                    <td>{r.ink ? `${r.ink} pts` : '—'}</td><td><strong>{r.score.toFixed(2)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>) : <p>Sin datos suficientes para un MVP — finaliza juegos del torneo.</p>}
          <p style={{ fontSize: '0.78rem', color: '#666' }}>
            Puntos MVP = WAR* ofensivo (wRAA calibrado a la liga) + WAR* de pitcheo (vs FIP) ×0.75
            + tinta ×0.25 (máx 3.0). Tinta = lideratos ponderados estilo Black Ink/MLB:
            4 pts AVG·HR·CI·W·ERA·K · 3 pts R·H·SLG·OPS·IP·SV · 2 pts 2B·OBP·BB·BR·WHIP·CG
            · 1 pt 3B·HLD·SHO. Los empates cuentan para todos los líderes — sin elección manual.
          </p>
        </>);
      }
      case 'totales': return (<>
        <h2>Totales por equipo</h2>
        <table className="report-table">
          <thead><tr><th>Equipo</th><th>G</th><th>Carreras</th><th>Hits</th><th>Errores</th><th>Dejados en base</th></tr></thead>
          <tbody>
            {(stats?.teamTotals ?? []).map((t) => (
              <tr key={t.teamId}><td>{t.name}</td><td>{t.g}</td><td>{t.r}</td><td>{t.h}</td><td>{t.e}</td><td>{t.lob}</td></tr>
            ))}
          </tbody>
        </table>
      </>);
      case 'bateo': return (<>
        <h2>Bateo individual completo</h2>
        <table className="report-table">
          <thead><tr><th>Jugador</th><th>Equipo</th><th>G</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
          <tbody>
            {[...(stats?.batting ?? [])].sort((a, b) => b.avg - a.avg).map((b) => (
              <tr key={b.playerId}><td>{b.name}</td><td>{b.shortName}</td><td>{b.g}</td><td>{b.pa}</td><td>{b.ab}</td><td>{b.r}</td><td>{b.h}</td><td>{b.doubles}</td><td>{b.triples}</td><td>{b.hr}</td><td>{b.rbi}</td><td>{b.bb}</td><td>{b.k}</td><td>{b.sb}</td><td><strong>{f3(b.avg)}</strong></td><td>{f3(b.obp)}</td><td>{f3(b.slg)}</td><td>{f3(b.ops)}</td></tr>
            ))}
          </tbody>
        </table>
      </>);
      case 'pitcheo': return (<>
        <h2>Pitcheo individual completo</h2>
        <table className="report-table">
          <thead><tr><th>Lanzador</th><th>Equipo</th><th>G</th><th>W-L</th><th>SV</th><th>HLD</th><th>BS</th><th>CG</th><th>SHO</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th><th>ERA</th><th>WHIP</th></tr></thead>
          <tbody>
            {(stats?.pitching ?? []).map((p) => (
              <tr key={p.playerId}><td>{p.name}</td><td>{p.shortName}</td><td>{p.gp}</td><td>{p.w}-{p.l}</td><td>{p.sv}</td><td>{p.hld}</td><td>{p.bs}</td><td>{p.cg}</td><td>{p.sho}</td><td>{ipOf(p.outs)}</td><td>{p.h}</td><td>{p.r}</td><td>{p.er}</td><td>{p.bb}</td><td>{p.k}</td><td>{p.hr}</td><td>{p.pitches}</td><td><strong>{p.era.toFixed(2)}</strong></td><td>{p.whip.toFixed(2)}</td></tr>
            ))}
          </tbody>
        </table>
      </>);
      case 'fildeo': return (<>
        <h2>Fildeo individual</h2>
        <table className="report-table">
          <thead><tr><th>Jugador</th><th>Equipo</th><th>PO</th><th>A</th><th>E</th><th>TC</th><th>FPCT</th></tr></thead>
          <tbody>
            {(stats?.fielding ?? []).map((f) => (
              <tr key={f.playerId}><td>{f.name}</td><td>{f.shortName}</td><td>{f.po}</td><td>{f.a}</td><td>{f.e}</td><td>{f.tc}</td><td>{f3(f.fpct)}</td></tr>
            ))}
          </tbody>
        </table>
      </>);
      case 'situacional': return (<>
        <h2>Bateo situacional</h2>
        <table className="report-table">
          <thead><tr><th>Jugador</th><th>Equipo</th><th>RISP AB-H</th><th>AVG</th><th>Llenas AB-H</th><th>AVG</th><th>2 outs AB-H</th><th>AVG</th><th>Leadoff AB-H</th><th>AVG</th></tr></thead>
          <tbody>
            {(stats?.batting ?? []).map((b) => (
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
      </>);
      case 'rosters': {
        if (!rosters) return <p>Cargando rosters…</p>;
        const byNum = (a: Player, b: Player) => (a.number ?? 999) - (b.number ?? 999) || a.lastName.localeCompare(b.lastName);
        const btl = (v?: string | null) => (v === 'L' ? 'Z' : v === 'S' ? 'A' : 'D');
        return (<>
          <h2>Rosters</h2>
          {rosters.map(({ team, players }) => {
            const rows = players.slice().sort(byNum);
            return (
              <div className="roster-team" key={team.id}>
                <h3 style={{ margin: '0.6rem 0 0.25rem' }}>{team.name}{team.shortName ? ` (${team.shortName})` : ''} <span style={{ fontWeight: 400, fontSize: '0.8rem' }}>— {rows.filter((p) => p.active !== false).length} jugadores</span></h3>
                <table className="report-table">
                  <thead><tr><th style={{ width: '8%' }}>No.</th><th style={{ width: '52%' }}>Nombre</th><th style={{ width: '25%' }}>Posición</th><th style={{ width: '15%' }}>B/T</th></tr></thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.id} style={p.active === false ? { color: '#999' } : undefined}>
                        <td>{p.number ?? ''}</td>
                        <td>{p.lastName}, {p.firstName}{p.active === false ? ' (baja)' : ''}</td>
                        <td>{p.positions ?? '—'}</td>
                        <td>{btl(p.bats)}/{btl(p.throws)}</td>
                      </tr>
                    ))}
                    {!rows.length && <tr><td colSpan={4}>Roster vacío</td></tr>}
                  </tbody>
                </table>
              </div>
            );
          })}
        </>);
      }
      case 'calendario': {
        let jor = 0, lastDay = '';
        return (<>
          <h2>Calendario</h2>
          <table className="report-table">
            <thead><tr>
              <th style={{ width: '7%' }}>Jor.</th><th style={{ width: '12%' }}>Fecha</th><th style={{ width: '12%' }}>Día</th>
              <th style={{ width: '9%' }}>Hora</th><th style={{ width: '30%' }}>Visitante</th><th style={{ width: '30%' }}>Home club</th>
            </tr></thead>
            <tbody>
              {sched.map((g) => {
                const d = new Date(g.date);
                if (d.toDateString() !== lastDay) { jor++; lastDay = d.toDateString(); }
                const qg = g.note?.includes('QG') ? g.note.split('—')[0].trim() : null; // etiqueta corta del triangular
                return (
                  <tr key={g.id}>
                    <td>{jor}</td>
                    <td>{d.toLocaleDateString()}</td>
                    <td>{DIAS[d.getDay()]}</td>
                    <td>{d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</td>
                    <td>{g.awayTeam?.name ?? '—'}{qg && <div style={{ fontSize: '0.7rem', color: '#b45309' }}>{qg}</div>}</td>
                    <td><strong>{g.homeTeam?.name ?? '—'}</strong></td>
                  </tr>
                );
              })}
              {!sched.length && <tr><td colSpan={6}>No hay juegos programados</td></tr>}
            </tbody>
          </table>
        </>);
      }
    }
  };

  return (
    <PrintSheet
      title={`Reportes — ${league.name} ${yearLabel}`}
      subtitle={`${league.sport === 'softball' ? 'Softball' : 'Baseball'} · ${phaseLabel} · Generado ${new Date().toLocaleDateString()}`}
      onClose={onClose}>
      {ids.map((id, i) => (
        <div key={id} className="rpt-sec" style={i > 0 ? { pageBreakBefore: 'always' } : undefined}>
          {renderSection(id)}
        </div>
      ))}
    </PrintSheet>
  );
}
