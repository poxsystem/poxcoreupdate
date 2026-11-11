import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isMidResult } from '@poxscore/shared';
import { api, Game, LineupEntry, Player } from '../api';

const RESULT_LABEL: Record<string, string> = {
  K: 'Ponche', KWP: 'Ponche+WP', KPB: 'Ponche+PB', BB: 'Base por bolas', IBB: 'BB intencional',
  HBP: 'Golpeado', '1B': 'Sencillo', '2B': 'Doble', '3B': 'Triple', HR: 'Jonrón',
  '1BE': 'Hit+error', '2BE': 'Hit+error (2B)', '3BE': 'Hit+error (3B)',
  E: 'Error', FC: 'Batazo de selección', GO: 'Rodado', FO: 'Elevado', LO: 'Línea', PO: 'Toque',
  SAC: 'Sacrificio', SF: 'Fly de sacrificio', DP: 'Doble play', TP: 'Triple play',
  IF: 'Infield fly', CI: 'Interferencia', WP: 'Wild pitch', PB: 'Pasbola', SB: 'Robo', CS: 'Out robando',
  T: 'Avance por tiro',
};

/** foto del jugador o avatar con iniciales (players vienen dentro de lineups/teams) */
function playerOf(g: Game, pid?: string | null): Player | null {
  if (!pid) return null;
  return (g.lineups ?? []).find((l) => l.playerId === pid)?.player
    ?? [...(g.homeTeam?.players ?? []), ...(g.awayTeam?.players ?? [])].find((x) => x.id === pid)
    ?? null;
}
const pName = (p: Player | null) => (p ? `${p.firstName} ${p.lastName}` : '—');

function Avatar({ p, size = 54 }: { p: Player | null; size?: number }) {
  if (p?.photo) return <img className="live-photo" src={p.photo} width={size} height={size} alt="" />;
  const ini = p ? `${p.firstName[0] ?? ''}${p.lastName[0] ?? ''}` : '·';
  return <span className="live-photo live-ini" style={{ width: size, height: size, fontSize: size * 0.36 }}>{ini}</span>;
}

/** Rombo SVG con los nombres de los corredores en cada base ocupada */
function RunnerDiamond({ g, big }: { g: Game; big?: boolean }) {
  const st = g.state;
  const r3 = playerOf(g, st?.bases?.[3]);
  const r2 = playerOf(g, st?.bases?.[2]);
  const r1 = playerOf(g, st?.bases?.[1]);
  const Base = ({ p, x, y, label }: { p: Player | null; x: number; y: number; label: string }) => (
    <g>
      <rect x={x - 11} y={y - 11} width={22} height={22} rx={4}
        transform={`rotate(45 ${x} ${y})`}
        fill={p ? '#e8b93e' : '#fff'} stroke={p ? '#a87f14' : '#c9c9cf'} strokeWidth={1.5} />
      {p && (
        <text x={x} y={y - 16} textAnchor="middle" fontSize={big ? 13 : 11} fontWeight={700} fill="#fff"
          style={{ paintOrder: 'stroke', stroke: 'rgba(0,0,0,.55)', strokeWidth: 3 }}>
          {`${p.number ? `#${p.number} ` : ''}${p.lastName}`}
        </text>
      )}
      {p && <title>{label}: {pName(p)}</title>}
    </g>
  );
  return (
    <svg viewBox="0 0 200 150" className="live-diamond">
      <path d="M100 128 L168 60 L100 18 L32 60 Z" fill="#4e9a51" opacity="0.55" />
      <path d="M100 128 L168 60 L100 18 L32 60 Z" fill="none" stroke="#fff" strokeWidth={1.4} />
      <Base p={r1} x={150} y={82} label="1ra" />
      <Base p={r2} x={100} y={40} label="2da" />
      <Base p={r3} x={50} y={82} label="3ra" />
      <path d="M94 122 h12 l-2 8 h-8 Z" fill="#fff" stroke="#c9c9cf" />
    </svg>
  );
}

/**
 * Vista pública / de transmisión de un juego — pantalla flotante sin menú.
 * `?obs` (ruta /en-vivo/:id/obs) = scorebug compacto de fondo transparente
 * pensado para una fuente "navegador" de OBS (lower-third).
 */
export default function LiveGamePage({ obs }: { obs?: boolean }) {
  const { id } = useParams();
  const [g, setG] = useState<Game | null>(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let t: ReturnType<typeof setInterval> | undefined;
    const load = () => api.game(id!)
      .then((game) => {
        setG(game);
        if (game.status === 'FINAL' && t) clearInterval(t);
      })
      .catch((e) => setErr(e.message));
    load();
    // OBS (transmisión) refresca cada 2.5 s — la vista pública cada 10 s
    t = setInterval(() => { load(); setTick((n) => n + 1); }, obs ? 2500 : 10000);
    return () => clearInterval(t);
  }, [id, obs]);

  // OBS: fondo transparente para captura limpia como browser source
  useEffect(() => {
    if (!obs) return;
    const prev = document.body.style.background;
    document.body.style.background = 'transparent';
    document.body.classList.add('obs-mode');
    return () => { document.body.style.background = prev; document.body.classList.remove('obs-mode'); };
  }, [obs]);

  const st = g?.state;
  const live = g?.status === 'LIVE';

  // quién batea / quién sigue / quién lanza — desde el lineup activo
  const actors = useMemo(() => {
    if (!g || !st) return { batter: null, onDeck: null, pitcher: null };
    const batTeamId = st.half === 'TOP' ? g.awayTeamId : g.homeTeamId;
    const defTeamId = st.half === 'TOP' ? g.homeTeamId : g.awayTeamId;
    const order = (g.lineups ?? [])
      .filter((l) => l.teamId === batTeamId && l.active && l.batsInOrder !== false)
      .sort((a, b) => a.order - b.order);
    const idx = st.half === 'TOP' ? st.awayBatterIndex : st.homeBatterIndex;
    const batter = order.length ? order[idx % order.length] : null;
    const onDeck = order.length > 1 ? order[(idx + 1) % order.length] : null;
    const pitcher = (g.lineups ?? [])
      .filter((l) => l.teamId === defTeamId && l.active && l.position === 'P')
      .sort((a, b) => (b.subInInning ?? 0) - (a.subInInning ?? 0))[0] ?? null;
    const ply = (l: LineupEntry | null) => l?.player ?? playerOf(g, l?.playerId);
    return { batter: ply(batter), onDeck: ply(onDeck), pitcher: ply(pitcher) };
  }, [g, st]);

  // flash ¡HOME RUN! en OBS: salta cuando aparece una jugada HR/HRIP nueva
  // (el primer cargue solo registra el seq — un HR viejo no flashea al abrir)
  const [hrFlash, setHrFlash] = useState(false);
  const seenHrSeq = useRef<number | null>(null);
  useEffect(() => {
    if (!obs || !g?.events?.length) return;
    const lastBig = [...g.events].reverse().find((e) => !['B', 'S', 'F'].includes(e.result));
    if (!lastBig) return;
    if (seenHrSeq.current === null) { seenHrSeq.current = lastBig.seq; return; }
    if (lastBig.seq !== seenHrSeq.current) {
      seenHrSeq.current = lastBig.seq;
      if (!['HR', 'HRIP'].includes(lastBig.result)) return;
      setHrFlash(true);
      const t = setTimeout(() => setHrFlash(false), 5200);
      return () => clearTimeout(t);
    }
  }, [obs, g]);

  if (err) return <p>{err}</p>;
  if (!g || !st) return <p className={obs ? 'obs-wrap' : ''}>Cargando…</p>;

  const lastEvents = [...(g.events ?? [])]
    .filter((e) => !['B', 'S', 'F'].includes(e.result))
    .slice(-8).reverse();
  const nameOf = (pid?: string | null) => pName(playerOf(g, pid));
  const ab = (t?: { name?: string; shortName?: string | null } | null) => t?.shortName || t?.name || '—';

  // ---------- modo OBS: scorebug estilo Fox Sports ----------
  if (obs) {
    const evs = g.events ?? [];
    const HITS = new Set(['1B', '2B', '3B', 'HR', 'HRIP', '1BE', '2BE', '3BE']);
    // R-H-E por equipo: batea el de half, defiende el otro — el error carga a la defensa
    const rhe = { away: { h: 0, e: 0 }, home: { h: 0, e: 0 } };
    for (const e of evs) {
      const bat = e.half === 'TOP' ? 'away' : 'home';
      const def = e.half === 'TOP' ? 'home' : 'away';
      if (HITS.has(e.result)) rhe[bat].h++;
      // errorOn resuelto → E# en notación → resultado que ES error
      const nErr = Math.max(
        e.errorOn?.length ?? 0,
        e.notation?.match(/E-?\d/g)?.length ?? 0,
        ['E', 'EF', 'DE', '1BE', '2BE', '3BE'].includes(e.result) ? 1 : 0,
      );
      if (nErr) rhe[def].e += nErr;
    }
    // conteo vigente: B/S/F desde el último cierre de turno (mid-play no lo resetea)
    let balls = 0, strikes = 0;
    for (let i = evs.length - 1; i >= 0; i--) {
      const r = evs[i].result;
      if (r === 'B') balls++;
      else if (r === 'S') strikes++;
      else if (r === 'F') { if (strikes < 2) strikes++; }
      else if (!isMidResult(r)) break;
    }
    // última jugada "grande" para el ticker
    const lastPlay = [...evs].reverse().find((e) => !['B', 'S', 'F'].includes(e.result));
    const playDesc = lastPlay
      ? `${RESULT_LABEL[lastPlay.result] ?? lastPlay.result}${lastPlay.notation ? ` ${lastPlay.notation}` : ''} — ${nameOf(lastPlay.batterId)}`
      : '';
    return (
      <div className="obs-wrap">
        {hrFlash && <div className="obsf-hr">💥 ¡HOME RUN!</div>}
        <div className="obsf">
          <div className="obsf-head">
            <span className="obsf-league">{g.league?.name ?? 'PoxScore'}{g.league?.year ? ` ${g.league.year}` : ''}</span>
            <span className="obsf-inn">
              {live ? <>{st.inning}<em className={st.half === 'TOP' ? 'up' : 'down'}>{st.half === 'TOP' ? '▲' : '▼'}</em></>
                : g.status === 'FINAL' ? 'FINAL' : g.status === 'SUSPENDED' ? 'SUSP' : '—'}
            </span>
          </div>
          <div className="obsf-body">
            <div className="obsf-teams">
              <div className="obsf-row obsf-cols"><span className="obsf-ab" /><span>C</span><span>H</span><span>E</span></div>
              <div className="obsf-row">
                <span className="obsf-ab">{ab(g.awayTeam)}</span>
                <span className="obsf-r">{st.score.away ?? g.fScoreAway ?? 0}</span>
                <span>{rhe.away.h}</span><span>{rhe.away.e}</span>
              </div>
              <div className="obsf-row">
                <span className="obsf-ab">{ab(g.homeTeam)}</span>
                <span className="obsf-r">{st.score.home ?? g.fScoreHome ?? 0}</span>
                <span>{rhe.home.h}</span><span>{rhe.home.e}</span>
              </div>
            </div>
            <div className="obsf-side">
              <svg viewBox="0 0 34 30" className="obsf-bases">
                {[['28', '22', st.bases?.[1]], ['17', '9', st.bases?.[2]], ['6', '22', st.bases?.[3]]].map(([x, y, on], i) => (
                  <rect key={i} x={Number(x) - 5} y={Number(y) - 5} width={10} height={10} rx={2}
                    transform={`rotate(45 ${x} ${y})`} fill={on ? '#e8b93e' : 'rgba(255,255,255,.22)'} />
                ))}
              </svg>
              {live && (
                <div className="obsf-outs">
                  {[0, 1, 2].map((i) => <i key={i} className={i < st.outs ? 'on' : ''} />)}
                </div>
              )}
              {live && <div className="obsf-bs">{balls}-{strikes}</div>}
            </div>
          </div>
          {(actors.pitcher || actors.batter) && (
            <div className="obsf-actors">
              {actors.pitcher && <span><b>P</b> {pName(actors.pitcher)}</span>}
              {actors.batter && <span><b>AB</b> {actors.batter.number ? `#${actors.batter.number} ` : ''}{pName(actors.batter)}</span>}
            </div>
          )}
          {playDesc && <div className="obsf-ticker" key={lastPlay!.seq}>▶ {playDesc}</div>}
        </div>
      </div>
    );
  }

  // ---------- vista pública flotante ----------
  return (
    <div className="liveview live-full">
      <p className="muted" style={{ textAlign: 'center', color: '#cdead9' }}>
        {g.league ? `${g.league.name} ${g.league.year}` : 'PoxScore'}{g.stadium ? ` · ${g.stadium}` : ''}
      </p>
      <div className="card livecard">
        <div className="lrow">
          <div className="lteam"><b>{g.awayTeam?.name ?? 'Visitante'}</b><span className="lscore">{st.score?.away ?? g.fScoreAway ?? 0}</span></div>
          <div className="lteam"><b>{g.homeTeam?.name ?? 'Local'}</b><span className="lscore">{st.score?.home ?? g.fScoreHome ?? 0}</span></div>
        </div>
        <div className="lstatus">
          {live && <span className="pill live">🔴 EN VIVO</span>}
          {g.status === 'FINAL' && <span className="pill">FINAL{g.tied ? ' · EMPATE' : ''}</span>}
          {g.status === 'SCHEDULED' && <span className="pill">Programado</span>}
          {g.status === 'SUSPENDED' && <span className="pill">⏸ Suspendido</span>}
          {live && (
            <span className="muted">
              {st.inning}ª {st.half === 'TOP' ? '⬆ alta' : '⬇ baja'} · {st.outs} out{st.outs === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {live && <RunnerDiamond g={g} big />}
        {live && (
          <div className="lactors">
            <div className="lactor">
              <Avatar p={actors.batter} size={64} />
              <span className="lactor-role">Al bate</span>
              <b>{pName(actors.batter)}</b>
              <span className="muted">{st.half === 'TOP' ? ab(g.awayTeam) : ab(g.homeTeam)}</span>
            </div>
            <div className="lactor">
              <Avatar p={actors.pitcher} size={54} />
              <span className="lactor-role">Lanzando</span>
              <b>{pName(actors.pitcher)}</b>
              <span className="muted">{st.half === 'TOP' ? ab(g.homeTeam) : ab(g.awayTeam)}</span>
            </div>
            <div className="lactor">
              <Avatar p={actors.onDeck} size={54} />
              <span className="lactor-role">En espera</span>
              <b>{pName(actors.onDeck)}</b>
              <span className="muted">a continuación</span>
            </div>
          </div>
        )}
      </div>

      {lastEvents.length > 0 && (
        <div className="card">
          <h3>Últimas jugadas</h3>
          {lastEvents.map((e) => (
            <div key={e.seq} style={{ margin: '0.25rem 0' }}>
              <p className="muted" style={{ margin: 0 }}>
                {e.inning}ª {e.half === 'TOP' ? '⬆' : '⬇'} — <b>{RESULT_LABEL[e.result] ?? e.result}</b>
                {e.notation ? ` ${e.notation}` : ''} · {nameOf(e.batterId)}
              </p>
              {e.aiNarration && <p className="live-narr">🗣 {e.aiNarration}</p>}
            </div>
          ))}
        </div>
      )}

      <p className="muted" style={{ textAlign: 'center' }}>
        <Link to={`/games/${g.id}`} style={{ color: '#9fd8b4' }}>Boxscore completo →</Link>
        {' · '}Se actualiza solo cada 10s{tick > 0 ? ' ✓' : ''}
        {' · '}<Link to={`/en-vivo/${g.id}/obs`} target="_blank" style={{ color: '#9fd8b4' }} title="Scorebug para fuente de navegador en OBS">📺 vista OBS</Link>
      </p>
    </div>
  );
}
