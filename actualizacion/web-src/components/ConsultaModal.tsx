import { useEffect, useMemo, useState } from 'react';
import { api, GameCard, MatchupInfo, PlayerSituational, SituBatLine, SituPitLine } from '../api';

/** situación en curso del juego — resalta las filas del split que aplican */
export interface SituCtx { outs: number; r1: boolean; r2: boolean; r3: boolean; leadoff: boolean; order: number | null }

// filas del split (clave → etiqueta) — bateo y pitcheo comparten las situaciones;
// vsLHP/vsRHP solo aplica al bateador, vsLHB/vsRHB al lanzador
const SITU_ROWS: { key: string; label: string; active?: (c: SituCtx) => boolean; disc?: 'bat' | 'pit' }[] = [
  { key: 'empty', label: 'Bases vacías', active: (c) => !c.r1 && !c.r2 && !c.r3 },
  { key: 'menOn', label: 'Corredores en base', active: (c) => c.r1 || c.r2 || c.r3 },
  { key: 'risp', label: 'Posición de anotar (RISP)', active: (c) => c.r2 || c.r3 },
  { key: 'loaded', label: 'Bases llenas', active: (c) => c.r1 && c.r2 && c.r3 },
  { key: 'r3', label: 'Corredor en 3ª', active: (c) => c.r3 },
  { key: 'outs0', label: 'Sin outs', active: (c) => c.outs === 0 },
  { key: 'outs1', label: '1 out', active: (c) => c.outs === 1 },
  { key: 'outs2', label: '2 outs', active: (c) => c.outs === 2 },
  { key: 'risp2out', label: 'RISP con 2 outs', active: (c) => c.outs === 2 && (c.r2 || c.r3) },
  { key: 'leadoff', label: 'Abriendo la entrada', active: (c) => c.leadoff },
  { key: 'vsLHP', label: 'vs lanzador zurdo', disc: 'bat' },
  { key: 'vsRHP', label: 'vs lanzador derecho', disc: 'bat' },
  { key: 'vsLHB', label: 'vs bateador zurdo', disc: 'pit' },
  { key: 'vsRHB', label: 'vs bateador derecho', disc: 'pit' },
  { key: 'home', label: 'En casa' },
  { key: 'away', label: 'De visita' },
];

const f3 = (n: number) => (n ? n.toFixed(3).replace(/^0/, '') : '.000');
const f2 = (n: number) => n.toFixed(2);
const ipOf = (outs: number) => `${Math.floor(outs / 3)}${outs % 3 ? `.${outs % 3}` : ''}`;
const RESULT_LABEL: Record<string, string> = {
  K: 'Ponche', KWP: 'K suelto', KPB: 'K pasbola', BB: 'Base', IBB: 'Base int.',
  HBP: 'Golpeado', '1B': 'Sencillo', '2B': 'Doble', '3B': 'Triple', HR: 'Jonrón',
  HRIP: 'HR interno', E: 'Error', FC: 'Forzado', GO: 'Roleta out', FO: 'Fly out',
  LO: 'Linea out', PO: 'Elevado out', SAC: 'Sacrificio', SF: 'Fly sacrif.',
  DP: 'Doble play', TP: 'Triple play', IF: 'Infield fly', RHB: 'Corredor base',
  AO: 'Auto-out', XF: 'Out en foul', AIL: 'Acción ilegal', FI: 'Fanático', CI: 'Interf.',
};

/**
 * Consulta rápida en la anotación (Shift+I) — estilo "información del juego" de
 * BallScore: situacional y temporada del bateador de turno, su historial contra
 * el lanzador actual, últimos 3 enfrentamientos, y vista espejo del lanzador.
 */
export default function ConsultaModal({ gameId, batterId, pitcherId, ctx, onClose }: {
  gameId: string; batterId: string; pitcherId: string; ctx?: SituCtx; onClose: () => void;
}) {
  const [batCard, setBatCard] = useState<GameCard | null>(null);
  const [pitCard, setPitCard] = useState<GameCard | null>(null);
  const [batSit, setBatSit] = useState<PlayerSituational | null>(null);
  const [pitSit, setPitSit] = useState<PlayerSituational | null>(null);
  const [mu, setMu] = useState<MatchupInfo | null>(null);
  const [showPit, setShowPit] = useState(false);
  const [err, setErr] = useState('');

  const hasPit = pitcherId !== 'none' && pitcherId !== '';
  useEffect(() => {
    api.gameCard(gameId, batterId).then((c) => {
      setBatCard(c);
      // splits de la fase del juego (REG/POST) y su temporada
      api.playerSituational(batterId, { scope: c.scope ?? 'REG', ...(c.seasonYear ? { year: c.seasonYear } : {}) })
        .then(setBatSit).catch(() => {});
    }).catch(() => setErr('Sin datos del bateador'));
    if (hasPit) api.matchup(batterId, pitcherId).then(setMu).catch(() => {});
  }, [gameId, batterId, pitcherId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (showPit && hasPit && !pitCard) api.gameCard(gameId, pitcherId).then((c) => {
      setPitCard(c);
      api.playerSituational(pitcherId, { scope: c.scope ?? 'REG', ...(c.seasonYear ? { year: c.seasonYear } : {}) })
        .then(setPitSit).catch(() => {});
    }).catch(() => {});
  }, [showPit, gameId, pitcherId, pitCard, hasPit]);

  // temporada: regular y post son filas separadas (scope REG/POST). La línea
  // del scope del juego prefiere la del AÑO del juego; sin esa, cae a la última
  // jugada en esa fase (una post vieja es contexto válido, etiquetada con su año)
  const pickSeason = (
    ss: GameCard['seasons'] | undefined,
    post: boolean,
    year: number | undefined,
  ) => {
    const rows = (ss ?? []).filter((s) => (s.scope === 'POST') === post);
    return rows.find((s) => s.season === year) ?? rows.at(-1) ?? null;
  };
  const batReg = useMemo(() => pickSeason(batCard?.seasons, false, batCard?.seasonYear), [batCard]);
  const batPost = useMemo(() => pickSeason(batCard?.seasons, true, batCard?.seasonYear), [batCard]);
  const pitReg = useMemo(() => pickSeason(pitCard?.seasons, false, pitCard?.seasonYear), [pitCard]);
  const pitPost = useMemo(() => pickSeason(pitCard?.seasons, true, pitCard?.seasonYear), [pitCard]);
  const bat = batCard?.game.batting;
  const sit = batCard?.game.situational;
  const pit = pitCard?.game.pitching;

  const batLine = (s: NonNullable<typeof batReg>) =>
    `${s.g}G · ${s.ab} AB · ${s.h} H · ${s.hr} HR · ${s.rbi} CI · ${s.bb} BB · ${s.k} K · ${s.sb} BR`;
  const pitLine = (s: NonNullable<typeof pitReg>) =>
    `${s.w}-${s.l} · ${s.sv} SV · ${ipOf(s.pOuts)} IP · ${s.pH} H · ${s.pR} C · ${s.pER} CL · ${s.pBB} BB · ${s.pK} K`;

  const situLine = sit ? [
    `RISP ${sit.risp.h}-${sit.risp.ab}`,
    `Llenas ${sit.loaded.h}-${sit.loaded.ab}`,
    `2 outs ${sit.twoOut.h}-${sit.twoOut.ab}`,
    `Leadoff ${sit.leadoff.h}-${sit.leadoff.ab}`,
  ].join(' · ') : '';

  // ---- tabla de splits situacionales de temporada (estilo MLB) ----
  const situTable = (data: PlayerSituational | null, disc: 'bat' | 'pit') => {
    if (!data) return null;
    const rows = SITU_ROWS.filter((r) => !r.disc || r.disc === disc)
      .map((r) => ({ ...r, line: (disc === 'bat' ? data.batting[r.key] : data.pitching[r.key]) as SituBatLine | SituPitLine | undefined }))
      .filter((r) => r.line && (('pa' in r.line ? r.line.pa : 0) || ('bf' in r.line ? r.line.bf : 0)));
    const orderRows = Object.entries(disc === 'bat' ? data.batting : data.pitching)
      .filter(([k]) => k.startsWith('order'))
      .map(([k, v]) => ({ key: k, n: Number(k.slice(5)), line: v }))
      .sort((a, b) => a.n - b.n);
    if (!rows.length && !orderRows.length) return null;
    const on = (r: { active?: (c: SituCtx) => boolean }) => !!(ctx && r.active?.(ctx));
    const cell = { padding: '0.15rem 0.45rem', textAlign: 'right' as const };
    return (
      <div style={{ marginTop: '0.5rem' }}>
        <div className="section-label">Situacional {data.scope === 'POST' ? 'postemporada' : 'temporada'} {data.season ?? ''}{ctx ? ' — resaltado = aplica ahora' : ''}</div>
        <table className="compact" style={{ fontSize: '0.8rem' }}>
          <thead><tr>
            {disc === 'bat' ? (<>
              <th style={{ textAlign: 'left' }}>Situación</th><th style={cell}>PA</th>
              <th style={cell}>AB</th><th style={cell}>H</th><th style={cell}>2B</th><th style={cell}>3B</th>
              <th style={cell}>HR</th><th style={cell}>CI</th><th style={cell}>BB</th><th style={cell}>K</th>
              <th style={cell}>AVG</th><th style={cell}>OBP</th><th style={cell}>OPS</th>
            </>) : (<>
              <th style={{ textAlign: 'left' }}>Situación</th><th style={cell}>BF</th>
              <th style={cell}>IP</th><th style={cell}>H</th><th style={cell}>C</th><th style={cell}>CL</th>
              <th style={cell}>BB</th><th style={cell}>K</th><th style={cell}>DP</th>
              <th style={cell}>BAA</th><th style={cell}>WHIP</th><th style={cell}>ERA</th>
            </>)}
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const l = r.line!;
              const hl = on(r) ? { background: 'rgba(0,122,255,.13)', fontWeight: 700 } : undefined;
              return (
                <tr key={r.key} style={hl}>
                  <td>{r.label}{on(r) ? ' ◀' : ''}</td>
                  {disc === 'bat' ? (() => { const b = l as SituBatLine; return (<>
                    <td style={cell}>{b.pa}</td><td style={cell}>{b.ab}</td><td style={cell}>{b.h}</td>
                    <td style={cell}>{b.d2}</td><td style={cell}>{b.d3}</td><td style={cell}>{b.hr}</td>
                    <td style={cell}>{b.rbi}</td><td style={cell}>{b.bb}</td><td style={cell}>{b.k}</td>
                    <td style={cell}><strong>{f3(b.avg)}</strong></td><td style={cell}>{f3(b.obp)}</td><td style={cell}>{f3(b.ops)}</td>
                  </>); })() : (() => { const p = l as SituPitLine; return (<>
                    <td style={cell}>{p.bf}</td><td style={cell}>{ipOf(p.outs)}</td><td style={cell}>{p.h}</td>
                    <td style={cell}>{p.r}</td><td style={cell}>{p.er}</td><td style={cell}>{p.bb}</td>
                    <td style={cell}>{p.k}</td><td style={cell}>{p.dp}</td>
                    <td style={cell}><strong>{f3(p.baa)}</strong></td><td style={cell}>{f3(p.whip)}</td><td style={cell}>{f2(p.era)}</td>
                  </>); })()}
                </tr>
              );
            })}
            {orderRows.map((r) => {
              const active = ctx?.order === r.n;
              const hl = active ? { background: 'rgba(0,122,255,.13)', fontWeight: 700 } : undefined;
              const label = (disc === 'bat' ? `Bateando ${r.n}º` : `vs ${r.n}º del orden`) + (active ? ' ◀' : '');
              if (disc === 'bat') {
                const b = r.line as SituBatLine;
                return (
                  <tr key={r.key} style={hl}>
                    <td>{label}</td>
                    <td style={cell}>{b.pa}</td><td style={cell}>{b.ab}</td><td style={cell}>{b.h}</td>
                    <td style={cell}>{b.d2}</td><td style={cell}>{b.d3}</td><td style={cell}>{b.hr}</td>
                    <td style={cell}>{b.rbi}</td><td style={cell}>{b.bb}</td><td style={cell}>{b.k}</td>
                    <td style={cell}><strong>{f3(b.avg)}</strong></td><td style={cell}>{f3(b.obp)}</td><td style={cell}>{f3(b.ops)}</td>
                  </tr>
                );
              }
              const p = r.line as SituPitLine;
              return (
                <tr key={r.key} style={hl}>
                  <td>{label}</td>
                  <td style={cell}>{p.bf}</td><td style={cell}>{ipOf(p.outs)}</td><td style={cell}>{p.h}</td>
                  <td style={cell}>{p.r}</td><td style={cell}>{p.er}</td><td style={cell}>{p.bb}</td>
                  <td style={cell}>{p.k}</td><td style={cell}>{p.dp}</td>
                  <td style={cell}><strong>{f3(p.baa)}</strong></td><td style={cell}>{f3(p.whip)}</td><td style={cell}>{f2(p.era)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const last3Row = mu?.last3.length ? (
    <table className="compact">
      <thead><tr><th>Fecha</th><th>Entrada</th><th>Resultado</th><th>CI en jugada</th></tr></thead>
      <tbody>
        {mu.last3.map((e, i) => (
          <tr key={i}>
            <td>{new Date(e.date).toLocaleDateString()}</td>
            <td>{e.inning}ª</td>
            <td><strong>{RESULT_LABEL[e.result] ?? e.result}{e.notation ? ` (${e.notation})` : ''}</strong></td>
            <td>{e.runs || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  ) : <p className="muted" style={{ margin: '0.3rem 0' }}>Primer enfrentamiento entre ambos.</p>;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ alignItems: 'baseline' }}>
          <h2 style={{ margin: 0 }}>🔍 Consulta</h2>
          <span className="muted">Shift+I</span>
          <span className="spacer" />
          {hasPit && (
            <button className="secondary" onClick={() => setShowPit((s) => !s)}>
              {showPit ? '🏏 Ver bateador' : '⚾ Ver lanzador'}
            </button>
          )}
        </div>
        {err && <p style={{ color: 'var(--red)' }}>{err}</p>}

        {!showPit ? (
          <>
            <h3>{batCard ? `${batCard.player.number ? `#${batCard.player.number} ` : ''}${batCard.player.firstName} ${batCard.player.lastName}` : 'Cargando…'}
              <span className="muted" style={{ fontSize: '0.8rem' }}> — bateando</span></h3>
            {(() => {
              // en playoff la fila relevante es la POST — va primero; si aún no
              // existe se dice explícito (evita leer la regular como "el récord")
              const post = batCard?.scope === 'POST';
              const regP = batReg && (
                <p style={{ margin: '0.2rem 0', fontSize: '0.9rem' }}>
                  <strong>Temporada {batReg.season}:</strong>{' '}
                  {batLine(batReg)} · <strong>AVG {f3(batReg.ab ? batReg.h / batReg.ab : 0)}</strong>
                </p>);
              const postP = (
                <p style={{ margin: '0.2rem 0', fontSize: '0.9rem' }}>
                  <strong>Postemporada {batPost?.season ?? batCard?.seasonYear}:</strong>{' '}
                  {batPost
                    ? <>{batLine(batPost)} · <strong>AVG {f3(batPost.ab ? batPost.h / batPost.ab : 0)}</strong></>
                    : <span className="muted">sin acumulado aún</span>}
                </p>);
              return post ? <>{postP}{regP}</> : <>{regP}{batPost ? postP : null}</>;
            })()}
            {bat && (
              <p style={{ margin: '0.2rem 0', fontSize: '0.9rem' }}>
                <strong>Hoy:</strong> {bat.h}-{bat.ab}{bat.rbi ? ` · ${bat.rbi} CI` : ''}{bat.hr ? ` · ${bat.hr} HR` : ''}{bat.bb ? ` · ${bat.bb} BB` : ''}{bat.k ? ` · ${bat.k} K` : ''}
              </p>
            )}
            {sit && (sit.risp.ab + sit.loaded.ab + sit.twoOut.ab + sit.leadoff.ab) > 0 && (
              <p style={{ margin: '0.2rem 0', fontSize: '0.85rem' }} className="muted">Situacional hoy: {situLine}</p>
            )}
            {situTable(batSit, 'bat')}
          </>
        ) : (
          <>
            <h3>{pitCard ? `${pitCard.player.number ? `#${pitCard.player.number} ` : ''}${pitCard.player.firstName} ${pitCard.player.lastName}` : 'Cargando…'}
              <span className="muted" style={{ fontSize: '0.8rem' }}> — lanzando</span></h3>
            {(() => {
              // en playoff la fila relevante es la POST — va primero; si aún no
              // existe se dice explícito (evita leer la regular como "el récord")
              const post = pitCard?.scope === 'POST';
              // ERA con las entradas reglamentarias DEL JUEGO (×27 solo si 9 inn;
              // una liga de 6-7 innings mostraba ERA inflada vs la tarjeta)
              const outsPer = ((pitCard?.innings ?? batCard?.innings) ?? 9) * 3;
              const era = (s: NonNullable<typeof pitReg>) => f2(s.pOuts ? (s.pER * outsPer) / s.pOuts : 0);
              const regP = pitReg && (
                <p style={{ margin: '0.2rem 0', fontSize: '0.9rem' }}>
                  <strong>Temporada {pitReg.season}:</strong>{' '}
                  {pitLine(pitReg)} · <strong>ERA {era(pitReg)}</strong>
                </p>);
              const postP = (
                <p style={{ margin: '0.2rem 0', fontSize: '0.9rem' }}>
                  <strong>Postemporada {pitPost?.season ?? pitCard?.seasonYear}:</strong>{' '}
                  {pitPost
                    ? <>{pitLine(pitPost)} · <strong>ERA {era(pitPost)}</strong></>
                    : <span className="muted">sin acumulado aún</span>}
                </p>);
              return post ? <>{postP}{regP}</> : <>{regP}{pitPost ? postP : null}</>;
            })()}
            {pit && (
              <p style={{ margin: '0.2rem 0', fontSize: '0.9rem' }}>
                <strong>Hoy:</strong> {ipOf(pit.outs)} IP · {pit.h} H · {pit.r} C · {pit.er} CL · {pit.bb} BB · {pit.k} K · {pit.pitches} Pit
              </p>
            )}
            {situTable(pitSit, 'pit')}
          </>
        )}

        <div className="section-label" style={{ marginTop: '0.7rem' }}>
          Enfrentamiento directo — {!hasPit ? 'selecciona el lanzador arriba' : mu ? `${mu.pa} turnos en ${mu.games} juego(s)` : 'cargando…'}
        </div>
        {mu && mu.pa > 0 && (
          <table className="compact">
            <thead><tr><th>PA</th><th>AB</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
            <tbody><tr>
              <td>{mu.pa}</td><td>{mu.ab}</td><td>{mu.h}</td><td>{mu.doubles}</td><td>{mu.triples}</td>
              <td>{mu.hr}</td><td>{mu.rbi}</td><td>{mu.bb}</td><td>{mu.k}</td>
              <td><strong>{f3(mu.avg)}</strong></td><td>{f3(mu.obp)}</td><td>{f3(mu.slg)}</td><td>{f3(mu.ops)}</td>
            </tr></tbody>
          </table>
        )}
        <div className="section-label" style={{ marginTop: '0.5rem' }}>Últimos 3 enfrentamientos</div>
        {last3Row}
        <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'flex-end' }}>
          <button className="secondary" onClick={onClose}>Cerrar (Esc)</button>
        </div>
      </div>
    </div>
  );
}
