import { useEffect, useMemo, useState } from 'react';
import type { GameEvent } from '@poxscore/shared';
import { api, FinishData, Game, Player } from '../api';

type Mode = 'final' | 'suspend' | 'forfeit';

/**
 * Pantalla de cierre del juego:
 * - Final normal → decisiones (WP/LP/SV/HLD) o empate (sin W ni L)
 * - Suspendido → queda guardado para continuar después
 * - Forfeit → regla oficial: 1 carrera por entrada reglamentaria (9-0/7-0) para el
 *   equipo perjudicado, salvo que ya fuera ganando (queda el marcador real). Editable.
 *   WP/LP solo si el ganador por forfeit ya estaba arriba.
 * Al finalizar/forfeit las stats se acumulan por playerId en la temporada.
 */
export default function FinishModal({ game, players, events, onDone, onCancel }: {
  game: Game;
  players: Map<string, Player>;
  // eventos VIVOS de ScorePage — game.events solo se refresca con load() y
  // llega sin las jugadas anotadas en esta sesión (los selects W/L salían vacíos)
  events: GameEvent[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [data, setData] = useState<FinishData | null>(null);
  const [mode, setMode] = useState<Mode>('final');
  const [tied, setTied] = useState(false);
  const [wpId, setWpId] = useState('');
  const [lpId, setLpId] = useState('');
  const [svId, setSvId] = useState('');
  const [hlds, setHlds] = useState<Set<string>>(new Set());
  const [bss, setBss] = useState<Set<string>>(new Set()); // blown saves
  const [forfeitBy, setForfeitBy] = useState<'away' | 'home'>('away');
  const [fScore, setFScore] = useState({ away: 0, home: 0 });
  const [err, setErr] = useState('');

  useEffect(() => {
    api.finishData(game.id).then((d) => {
      setData(d);
      setTied(d.tied);
      setWpId(d.suggestedWpId ?? '');
      setLpId(d.suggestedLpId ?? '');
      applyForfeitScore('away', d);
    }).catch((e) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id]);

  const nameOf = (pid: string) => {
    const p = players.get(pid);
    return p ? `${p.number ? `#${p.number} ` : ''}${p.firstName} ${p.lastName}` : pid;
  };

  // opciones: SOLO los lanzadores que participaron en el juego (pitcherId en los eventos)
  const teamPitchers = useMemo((): { away: string[]; home: string[] } => {
    const away = new Set<string>();
    const home = new Set<string>();
    for (const ev of events) {
      // en TOP batea el visitante → el pitcher es del home; en BOTTOM es del away
      if (ev.half === 'TOP' && ev.pitcherId) home.add(ev.pitcherId);
      if (ev.half === 'BOTTOM' && ev.pitcherId) away.add(ev.pitcherId);
    }
    return { away: [...away], home: [...home] };
  }, [events]);

  const winnerSide = mode === 'forfeit'
    ? (forfeitBy === 'away' ? 'home' : 'away')
    : data?.winner;
  const winnerIds = winnerSide === 'away' || winnerSide === 'home' ? teamPitchers[winnerSide] : [];
  const loserIds = winnerSide === 'away' ? teamPitchers.home : winnerSide === 'home' ? teamPitchers.away : [];

  // regla de forfeit: innings-0 para el perjudicado; si ya iba ganando queda el marcador real
  function applyForfeitScore(by: 'away' | 'home', d: FinishData | null = data) {
    const s = d?.score ?? { away: 0, home: 0 };
    const offended = by === 'away' ? 'home' : 'away';
    if (s[offended] > s[by]) setFScore({ ...s });
    else setFScore(offended === 'home' ? { away: 0, home: game.innings } : { away: game.innings, home: 0 });
  }

  const offendedAhead = mode === 'forfeit' && data
    ? (forfeitBy === 'away' ? data.score.home > data.score.away : data.score.away > data.score.home)
    : false;

  const save = async () => {
    try {
      if (mode === 'suspend') {
        await api.suspendGame(game.id);
      } else if (mode === 'forfeit') {
        await api.forfeitGame(game.id, {
          forfeitBy: forfeitBy === 'away' ? game.awayTeamId : game.homeTeamId,
          scoreAway: fScore.away, scoreHome: fScore.home,
          wpId: offendedAhead ? wpId || null : null,
          lpId: offendedAhead ? lpId || null : null,
          svId: offendedAhead ? svId || null : null,
          hldIds: offendedAhead ? [...hlds] : [],
          bsIds: [...bss],
        });
      } else {
        await api.finishGame(game.id, {
          tied,
          wpId: tied ? null : wpId || null,
          lpId: tied ? null : lpId || null,
          svId: tied ? null : svId || null,
          hldIds: tied ? [] : [...hlds],
          bsIds: tied ? [] : [...bss],
        });
      }
      onDone();
    } catch (e) { setErr((e as Error).message); }
  };

  const sel = (value: string, set: (v: string) => void, ids: string[], label: string, disabled = false) => (
    <label style={{ display: 'block', marginBottom: '0.6rem' }}>{label}
      <select value={value} onChange={(e) => set(e.target.value)} style={{ width: '100%' }} disabled={disabled}>
        <option value="">— sin decisión —</option>
        {ids.map((pid) => <option key={pid} value={pid}>{nameOf(pid)}</option>)}
      </select>
    </label>
  );

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Cierre del juego</h2>
        {data && (
          <p className="row" style={{ fontSize: '1.1rem', fontWeight: 700 }}>
            {game.awayTeam?.shortName ?? game.awayTeam?.name} {data.score.away}
            <span className="muted">@</span>
            {game.homeTeam?.shortName ?? game.homeTeam?.name} {data.score.home}
            {winnerSide === 'tie' && mode !== 'forfeit' && <span className="pill sched">EMPATE</span>}
          </p>
        )}

        {/* modo de cierre */}
        <div className="row" style={{ gap: '0.4rem', marginBottom: '0.9rem' }}>
          {([['final', '⚑ Final'], ['suspend', '⏸ Suspendido'], ['forfeit', '⛔ Forfeit']] as [Mode, string][]).map(([m, l]) => (
            <button key={m} className={mode === m ? '' : 'secondary'} onClick={() => setMode(m)}>{l}</button>
          ))}
        </div>

        {mode === 'suspend' && (
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            El juego queda <strong>SUSPENDIDO</strong>: se guarda con sus eventos y estadísticas,
            pero aún no es final — podrás continuarlo después desde la página del juego.
          </p>
        )}

        {mode === 'forfeit' && (
          <>
            <label style={{ display: 'block', marginBottom: '0.6rem' }}>Pierde por forfeit
              <select value={forfeitBy} onChange={(e) => { const v = e.target.value as 'away' | 'home'; setForfeitBy(v); applyForfeitScore(v); }} style={{ width: '100%' }}>
                <option value="away">{game.awayTeam?.name} (visitante)</option>
                <option value="home">{game.homeTeam?.name} (local)</option>
              </select>
            </label>
            <div className="row" style={{ gap: '0.7rem', marginBottom: '0.6rem' }}>
              <label>{game.awayTeam?.shortName ?? 'Vis.'}
                <input type="number" min={0} value={fScore.away} style={{ width: 72 }}
                  onChange={(e) => setFScore((s) => ({ ...s, away: Number(e.target.value) }))} />
              </label>
              <strong>—</strong>
              <label>{game.homeTeam?.shortName ?? 'Loc.'}
                <input type="number" min={0} value={fScore.home} style={{ width: 72 }}
                  onChange={(e) => setFScore((s) => ({ ...s, home: Number(e.target.value) }))} />
              </label>
            </div>
            <p className="muted" style={{ fontSize: '0.78rem' }}>
              Regla: {game.innings}-0 a favor del perjudicado; si ya iba ganando se conserva el marcador real.
              {offendedAhead
                ? ' El perjudicado ya ganaba → se registran WP/LP.'
                : ' Perjudicado abajo o empatado → por regla no hay pitcher ganador ni derrotado.'}
            </p>
          </>
        )}

        {mode === 'final' && (
          <label className="row" style={{ gap: '0.4rem', marginBottom: '0.8rem', fontWeight: 600 }}>
            <input type="checkbox" checked={tied} onChange={(e) => setTied(e.target.checked)} />
            Juego empatado (sin ganador ni derrotado)
          </label>
        )}

        {mode !== 'suspend' && !tied && (
          <>
            {sel(wpId, setWpId, winnerIds, 'Pitcher ganador (W)', mode === 'forfeit' && !offendedAhead)}
            {mode === 'final' && data?.wpKind && (
              <p className="muted" style={{ fontSize: '0.78rem', marginTop: '-0.4rem', marginBottom: '0.6rem' }}>
                Sugerencia 9.17: {data.wpKind === 'starter' && `abridor (${Math.floor((data.wpStarterOuts ?? 0) / 3)}.${(data.wpStarterOuts ?? 0) % 3} IP ≥ ${Math.floor((data.wpMinStarterOuts ?? 0) / 3)} mínimo)`}
                {data.wpKind === 'record' && 'pitcher de registro al tomar la delantera definitiva'}
                {data.wpKind === 'effective' && `relevista más efectivo — abridor ${Math.floor((data.wpStarterOuts ?? 0) / 3)}.${(data.wpStarterOuts ?? 0) % 3} IP < ${Math.floor((data.wpMinStarterOuts ?? 0) / 3)} mínimo (editable)`}
                {data.wpKind === 'ineffective' && 'relevista posterior — el récord fue breve e inefectivo (<1 IP, 2+ CL) (editable)'}
              </p>
            )}
            {sel(lpId, setLpId, loserIds, 'Pitcher derrotado (L)', mode === 'forfeit' && !offendedAhead)}
            {sel(svId, setSvId, winnerIds, 'Salvado (SV)', mode === 'forfeit' && !offendedAhead)}
            {!(mode === 'forfeit' && !offendedAhead) && (
              <div style={{ marginBottom: '0.6rem' }}>
                <div className="muted" style={{ fontSize: '0.8rem', marginBottom: '0.3rem' }}>Hold (HLD) — relevistas del equipo ganador:</div>
                <div className="row" style={{ gap: '0.3rem' }}>
                  {winnerIds.map((pid: string) => (
                    <button key={pid} type="button"
                      className={hlds.has(pid) ? 'icon' : 'secondary icon'}
                      onClick={() => setHlds((s) => { const n = new Set(s); n.has(pid) ? n.delete(pid) : n.add(pid); return n; })}>
                      {nameOf(pid)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* BS — blown save: puede ser de cualquier equipo (dejó empatar/perder la ventaja) */}
            <div style={{ marginBottom: '0.6rem' }}>
              <div className="muted" style={{ fontSize: '0.8rem', marginBottom: '0.3rem' }}>Blown save (BS) — quien desperdició ventaja de salvado:</div>
              <div className="row" style={{ gap: '0.3rem' }}>
                {[...teamPitchers.away, ...teamPitchers.home].map((pid: string) => (
                  <button key={pid} type="button"
                    className={bss.has(pid) ? 'icon' : 'secondary icon'}
                    onClick={() => setBss((s) => { const n = new Set(s); n.has(pid) ? n.delete(pid) : n.add(pid); return n; })}>
                    {nameOf(pid)}
                  </button>
                ))}
              </div>
            </div>
            {/* CG/SHO automáticos — BallScore los exporta solo */}
            {data && (data.cgIds.length > 0 || data.shoIds.length > 0) && (
              <p className="muted" style={{ fontSize: '0.82rem' }}>
                {data.cgIds.map((pid) => `CG · ${nameOf(pid)}`).join(' · ')}
                {data.shoIds.length > 0 && ` — SHO · ${data.shoIds.map(nameOf).join(', ')}`}
                {' '}(automático)
              </p>
            )}
          </>
        )}
        {err && <p style={{ color: 'var(--red)', fontWeight: 600 }}>{err}</p>}
        <div className="row" style={{ marginTop: '0.6rem', justifyContent: 'flex-end' }}>
          <button className="secondary" onClick={onCancel}>Cancelar</button>
          <button className="big" onClick={save}>
            {mode === 'suspend' ? '⏸ Suspender' : mode === 'forfeit' ? '⛔ Registrar forfeit' : 'Guardar y finalizar'}
          </button>
        </div>
      </div>
    </div>
  );
}
