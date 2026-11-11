import { useEffect, useMemo, useState } from 'react';
import { api, Game, LineupEntry, Player, Team } from '../api';
import { POSITIONS, type GameState, type GameEvent } from '@poxscore/shared';

export type Mode = 'SUB' | 'CR' | 'PC' | 'RL' | 'FIX';

const MODE_LABEL: Record<Mode, string> = {
  SUB: 'Cambio de jugador',
  CR: 'Corredor emergente',
  PC: 'Cambio de lanzador',
  RL: '↺ Reingreso lanzador',
  FIX: '✏️ Corregir jugador',
};

interface Props {
  game: Game;
  state: GameState;
  events?: GameEvent[];          // para saber qué pitchers ya lanzaron (modo RL)
  currentBatterId?: string;
  currentPitcherId?: string;     // el que está lanzando ahora (se excluye de RL)
  onDone: (newPitcherId?: string) => void;
  onCancel: () => void;
  /** pestaña inicial (voz: "cambio lanzador" → PC, "reingresa lanzador" → RL) */
  initialMode?: Mode;
  /** voz con nombre: "bateador emergente mendoza" → entra preseleccionado */
  initialInId?: string;
  /** texto hablado con el modal abierto — "mendoza" elige al entrante */
  voiceText?: string;
  /** señal «confirmar» por voz → equivale al botón Confirmar */
  confirmSignal?: number;
}

const pname = (p?: Player) => (p ? `${p.number ? `#${p.number} ` : ''}${p.firstName} ${p.lastName}` : '—');

/**
 * Sustituciones estilo oficial:
 * - SUB: cambio de jugador (bateador emergente, defensivo) — ocupa el slot del saliente
 * - CR: corredor emergente — toma la base del corredor saliente + evento CR
 * - PC: cambio de lanzador — evento PC sin tocar el lineup
 * - RL: reingreso de lanzador (softball) — solo pitchers que YA lanzaron en este juego;
 *   si salió del lineup vuelve por su slot (REIN) + evento PC; si sigue en el lineup, solo PC
 * - Reingreso (softball): si el entrante ya salió del juego → rol REIN, stats se acumulan por playerId
 */
export default function SubModal({ game, state, events = [], currentBatterId, currentPitcherId, onDone, onCancel, initialMode, initialInId, voiceText, confirmSignal }: Props) {
  const [mode, setMode] = useState<Mode>(initialMode ?? 'SUB');
  const [teamId, setTeamId] = useState(game.awayTeamId);
  const [outEntryId, setOutEntryId] = useState('');
  const [inPlayerId, setInPlayerId] = useState(initialInId ?? '');
  const [position, setPosition] = useState('');
  const [search, setSearch] = useState('');
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [refTeamId, setRefTeamId] = useState('');
  const [refPlayers, setRefPlayers] = useState<Player[]>([]);
  const [showRef, setShowRef] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { api.teams().then(setAllTeams).catch(() => {}); }, []);
  useEffect(() => {
    if (refTeamId) api.team(refTeamId).then((t) => setRefPlayers(t.players ?? [])).catch(() => {});
    else setRefPlayers([]);
  }, [refTeamId]);

  const battingTeamId = state.half === 'TOP' ? game.awayTeamId : game.homeTeamId;
  const fieldingTeamId = state.half === 'TOP' ? game.homeTeamId : game.awayTeamId;
  const effTeamId = mode === 'CR' ? battingTeamId : (mode === 'PC' || mode === 'RL') ? fieldingTeamId : teamId;
  const team = effTeamId === game.awayTeamId ? game.awayTeam : game.homeTeam;

  const lineup = useMemo(() =>
    (game.lineups ?? []).filter((l) => l.teamId === effTeamId && l.active).sort((a, b) => a.order - b.order),
    [game.lineups, effTeamId]);
  const activeIds = new Set(lineup.map((l) => l.playerId));
  // jugadores que salieron (candidatos a REINGRESO en softball)
  const outPlayers = (game.lineups ?? []).filter((l) => l.teamId === effTeamId && !l.active);
  const outIds = new Set(outPlayers.map((l) => l.playerId));

  // FIX: el equivocado puede haber salido ya del juego — se listan todas sus entradas del equipo,
  // MÁS quien solo vive en los eventos (un lanzador que entró por PC no tiene fila de lineup:
  // sin esto "me equivoqué de lanzador" no se podía corregir — swap-player los remapea igual)
  const fixable = useMemo(() => {
    const list = (game.lineups ?? []).filter((l) => l.teamId === effTeamId)
      .sort((a, b) => a.order - b.order || Number(b.active) - Number(a.active));
    const seen = new Set(list.map((l) => l.playerId));
    for (const ev of events) {
      const pid = ev.half === (effTeamId === game.homeTeamId ? 'TOP' : 'BOTTOM') ? ev.pitcherId
        : ev.half === (effTeamId === game.awayTeamId ? 'TOP' : 'BOTTOM') ? ev.batterId : null;
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      list.push({
        id: `ev-${pid}`, gameId: game.id, teamId: effTeamId, playerId: pid,
        order: 99, position: '·jugadas', role: 'SUB', active: true, batsInOrder: false,
        player: team?.players?.find((p) => p.id === pid)
          ?? (game.lineups ?? []).find((l) => l.playerId === pid)?.player,
      } as LineupEntry);
    }
    return list;
  }, [game.lineups, effTeamId, events, game.id, game.homeTeamId, game.awayTeamId, team]);
  const outEntry = (mode === 'FIX' ? fixable : lineup).find((l) => l.id === outEntryId);

  const candidates: { player: Player; ref: boolean; rein: boolean }[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (p: Player) => !q || `${p.firstName} ${p.lastName} ${p.number ?? ''}`.toLowerCase().includes(q);
    // FIX: el jugador real puede estar ya en el lineup (→ intercambio) — se listan todos menos el equivocado
    const skip = (p: Player) => (mode === 'FIX' ? p.id === outEntry?.playerId : activeIds.has(p.id));
    const own = (team?.players ?? []).filter((p) => p.active && !skip(p) && match(p))
      .map((player) => ({ player, ref: false, rein: mode === 'FIX' ? false : outIds.has(player.id) }));
    const refs = (showRef ? refPlayers : []).filter((p) => p.active && !skip(p) && match(p))
      .map((player) => ({ player, ref: true, rein: false }));
    return [...own, ...refs];
  }, [team, refPlayers, showRef, search, game.lineups, effTeamId, mode, outEntry]);

  // ── RL: pitchers que YA lanzaron por el equipo defensor en este juego ──
  // fuente = eventos (lanzó en la mitad en que este equipo defiende) + entries P del lineup
  const fieldHalf = fieldingTeamId === game.homeTeamId ? 'TOP' : 'BOTTOM';
  // sin useMemo: el cómputo es trivial y depende de `mode`/`team` (deps frágiles)
  const reinPitchers = (() => {
    const ids = new Map<string, string>(); // pid → 'active' | 'out' | 'lineup'
    for (const ev of events) {
      if (ev.half === fieldHalf && ev.pitcherId && ev.pitcherId !== currentPitcherId) ids.set(ev.pitcherId, 'lineup');
    }
    for (const l of game.lineups ?? []) {
      if (l.teamId !== fieldingTeamId || l.position !== 'P' || l.playerId === currentPitcherId) continue;
      ids.set(l.playerId, l.active ? 'active' : 'out');
    }
    return [...ids.entries()].map(([pid, status]) => ({
      pid,
      status,
      player: team?.players?.find((p) => p.id === pid)
        ?? (game.lineups ?? []).find((l) => l.playerId === pid)?.player,
    }));
  })();

  // corredores en base para el modo CR
  const runners = ([1, 2, 3] as const)
    .map((b) => ({ base: b, pid: state.bases[b] }))
    .filter((r) => r.pid) as { base: 1 | 2 | 3; pid: string }[];

  // cambios deshacibles: entradas SUB/REIN con replacesId que nadie más reemplazó
  // (si el que entró también salió sustituido, hay que deshacer el último primero)
  const undoableSubs = (game.lineups ?? []).filter((l) =>
    l.replacesId && (l.role === 'SUB' || l.role === 'REIN')
    && !(game.lineups ?? []).some((o) => o.replacesId === l.id),
  );
  const undoSub = async (subId: string) => {
    const sub = (game.lineups ?? []).find((l) => l.id === subId);
    const out = (game.lineups ?? []).find((l) => l.id === sub?.replacesId);
    if (!sub || !out) return;
    if (!window.confirm(`¿Deshacer el cambio?\n\nVuelve ${pname(out.player)} y sale ${pname(sub.player)}.`)) return;
    setBusy(true); setErr('');
    try { await api.undoSub(game.id, subId); onDone(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  // ── selección por voz con el modal abierto ──
  // "mendoza" → elige el entrante · "fulano por mengano" → entrante y saliente ·
  // en CR "en primera" elige la base del corredor que sale.
  const normV = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  useEffect(() => {
    const t = voiceText?.trim();
    if (!t) return;
    const [inTxt, outTxt] = normV(t).split(/\bpor\b/).map((s) => s.trim());
    const hits = (pool: { id: string; p?: { firstName: string; lastName: string } }[], txt: string) =>
      pool.filter((x) => {
        const full = normV(`${x.p?.firstName ?? ''} ${x.p?.lastName ?? ''}`).trim();
        if (full.length < 3) return false;
        return ` ${txt} `.includes(` ${full} `) ||
          full.split(' ').some((w) => w.length > 2 && ` ${txt} `.includes(` ${w} `));
      });
    const inHits = hits(candidates.map((c) => ({ id: c.player.id, p: c.player })), inTxt);
    if (inHits.length === 1) {
      setInPlayerId(inHits[0].id);
      // SUB sin saliente dicho → se asume el bateador del turno (emergente clásico)
      if (mode === 'SUB' && !outEntryId && currentBatterId && !outTxt) {
        const be = lineup.find((l) => l.playerId === currentBatterId);
        if (be) { setOutEntryId(be.id); setPosition(be.position); }
      }
    } else if (inHits.length > 1) {
      setErr(`«${inTxt}» coincide con varios — di nombre y apellido`);
    }
    if (outTxt && (mode === 'SUB' || mode === 'FIX')) {
      const outHits = hits((mode === 'FIX' ? fixable : lineup).map((l) => ({ id: l.id, p: l.player })), outTxt);
      if (outHits.length === 1) { setOutEntryId(outHits[0].id); setPosition(lineup.find((l) => l.id === outHits[0].id)?.position ?? ''); }
    }
    // CR: "en primera/segunda/tercera" elige el corredor que sale por su base
    if (mode === 'CR') {
      const b = /primera|inicial/.test(t) ? 1 : /segunda|intermedia/.test(t) ? 2 : /tercera|antesala/.test(t) ? 3 : null;
      if (b && runners.some((r) => r.base === b)) setOutEntryId(String(b));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceText]);

  // «confirmar» hablado → equivale a tocar el botón Confirmar
  useEffect(() => { if (confirmSignal) void submit(); }, [confirmSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectMode = (m: Mode) => {
    setMode(m); setOutEntryId(''); setInPlayerId(''); setErr('');
    if (m === 'CR') setTeamId(battingTeamId);
    if (m === 'PC' || m === 'RL') setTeamId(fieldingTeamId);
  };

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      if (mode === 'PC') {
        if (!inPlayerId) throw new Error('Elige el nuevo lanzador');
        await api.addEvent(game.id, { result: 'PC', pitcherId: inPlayerId, advances: [], inning: state.inning, half: state.half });
        onDone(inPlayerId);
        return;
      }
      if (mode === 'RL') {
        // reingreso de lanzador (softball): vuelve al juego por su slot original (REIN)
        // — quien ocupa ese lugar ahora sale; si sigue en el lineup solo se registra el PC
        if (!inPlayerId) throw new Error('Elige el lanzador que reingresa');
        const out = (game.lineups ?? []).find((l) => l.teamId === fieldingTeamId && l.playerId === inPlayerId && !l.active);
        if (out) {
          const occupant = (game.lineups ?? []).find((l) => l.teamId === fieldingTeamId && l.active && l.order === out.order)
            ?? (game.lineups ?? []).find((l) => l.teamId === fieldingTeamId && l.active && l.position === 'P');
          if (occupant && occupant.playerId !== inPlayerId) {
            await api.substitute(game.id, { teamId: fieldingTeamId, outPlayerId: occupant.playerId, inPlayerId, position: 'P', subInInning: state.inning, subInHalf: state.half });
          }
        }
        await api.addEvent(game.id, { result: 'PC', pitcherId: inPlayerId, advances: [], inning: state.inning, half: state.half });
        onDone(inPlayerId);
        return;
      }
      if (mode === 'CR') {
        const run = runners.find((r) => String(r.base) === outEntryId);
        if (!run) throw new Error('Elige el corredor que sale');
        if (!inPlayerId) throw new Error('Elige el corredor emergente');
        const entry = lineup.find((l) => l.playerId === run.pid);
        if (entry) {
          await api.substitute(game.id, { teamId: effTeamId, outPlayerId: run.pid, inPlayerId, position: position || entry.position, subInInning: state.inning, subInHalf: state.half });
        }
        await api.addEvent(game.id, {
          result: 'CR', batterId: currentBatterId,
          advances: [{ playerId: inPlayerId, to: run.base }],
          inning: state.inning, half: state.half,
        });
        onDone();
        return;
      }
      if (mode === 'FIX') {
        if (!outEntry || !inPlayerId) throw new Error('Completa la selección');
        const p = candidates.find((c) => c.player.id === inPlayerId)?.player;
        const already = activeIds.has(inPlayerId);
        const msg = `¿Corregir la identidad del jugador?\n\n${pname(outEntry.player)} → ${pname(p)}\n\n` +
          `TODAS las jugadas ya anotadas a ${pname(outEntry.player)} pasarán a ${pname(p)}` +
          (already ? `\ny las de ${pname(p)} pasarán a ${pname(outEntry.player)} (intercambio)` : '') +
          `\n— incluye bases ocupadas, hits, fildeo y pitcheo.`;
        if (!window.confirm(msg)) { setBusy(false); return; }
        await api.swapPlayer(game.id, { teamId: effTeamId, aId: outEntry.playerId, bId: inPlayerId });
        onDone();
        return;
      }
      // SUB
      if (!outEntry || !inPlayerId) throw new Error('Completa la selección');
      await api.substitute(game.id, {
        teamId: effTeamId, outPlayerId: outEntry.playerId, inPlayerId,
        position: position || outEntry.position,
        subInInning: state.inning, subInHalf: state.half,
      });
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Sustitución</h2>
        <div className="row" style={{ marginBottom: '0.7rem' }}>
          {(Object.keys(MODE_LABEL) as Mode[]).filter((m) => m !== 'RL' || game.sport === 'softball').map((m) => (
            <button key={m} className={mode === m ? '' : 'secondary'} onClick={() => selectMode(m)}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>

        {(mode === 'SUB' || mode === 'FIX') && (
          <div className="row" style={{ marginBottom: '0.6rem' }}>
            <button className={effTeamId === game.awayTeamId ? '' : 'secondary'} onClick={() => { setTeamId(game.awayTeamId); setOutEntryId(''); }}>
              {game.awayTeam?.shortName ?? 'Visitante'}
            </button>
            <button className={effTeamId === game.homeTeamId ? '' : 'secondary'} onClick={() => { setTeamId(game.homeTeamId); setOutEntryId(''); }}>
              {game.homeTeam?.shortName ?? 'Local'}
            </button>
          </div>
        )}

        {mode === 'CR' && (
          <>
            <label className="muted">Corredor que sale (en base):</label>
            <select value={outEntryId} onChange={(e) => setOutEntryId(e.target.value)} style={{ width: '100%', margin: '0.3rem 0 0.8rem' }}>
              <option value="">— elige corredor —</option>
              {runners.map((r) => {
                const p = (team?.players ?? []).find((x) => x.id === r.pid)
                  ?? (game.lineups ?? []).find((l) => l.playerId === r.pid)?.player;
                return <option key={r.base} value={r.base}>En {r.base}ª: {pname(p)}</option>;
              })}
            </select>
          </>
        )}

        {(mode === 'SUB' || mode === 'FIX') && (
          <>
            <label className="muted">{mode === 'FIX' ? 'Anotaste por error a:' : 'Sale del juego:'}</label>
            <select value={outEntryId} onChange={(e) => { setOutEntryId(e.target.value); setPosition(lineup.find((l) => l.id === e.target.value)?.position ?? ''); }} style={{ width: '100%', margin: '0.3rem 0 0.8rem' }}>
              <option value="">— elige jugador —</option>
              {(mode === 'FIX' ? fixable : lineup).map((l) => (
                <option key={l.id} value={l.id}>{l.order < 50 ? `${l.order}. ` : ''}{pname(l.player)} ({l.position}){l.batsInOrder === false ? ' — solo lanza' : ''}{!l.active ? ' — fuera' : ''}</option>
              ))}
            </select>
          </>
        )}

        {mode === 'RL' ? (
          <>
            <label className="muted">Lanzador que reingresa ({team?.name}):</label>
            {!reinPitchers.length && (
              <p className="muted" style={{ margin: '0.5rem 0' }}>Ningún otro pitcher ha lanzado por este equipo en este juego.</p>
            )}
            <div className="lb-pool-list" style={{ maxHeight: 200, margin: '0.3rem 0' }}>
              {reinPitchers.map(({ pid, status, player }) => (
                <button key={pid} className={`pool-item ${inPlayerId === pid ? 'sel' : ''}`}
                  onClick={() => setInPlayerId(pid)}>
                  <span className="pool-num">{player?.number ?? '—'}</span>
                  <span className="pool-name">{pname(player)}</span>
                  <span className="pill" style={{
                    marginLeft: '0.4rem',
                    background: status === 'out' ? '#dcfce7' : '#e2e8f0',
                    color: status === 'out' ? '#14532d' : '#334155',
                  }}>
                    {status === 'out' ? 'REINGRESO' : status === 'active' ? 'en lineup' : 'ya lanzó'}
                  </span>
                </button>
              ))}
            </div>
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              Regla de reingreso (softball): el pitcher que salió vuelve a su lugar en el orden — quien lo ocupa sale del juego.
            </p>
          </>
        ) : mode === 'PC' ? (
          <>
            <label className="muted">Nuevo lanzador ({team?.name}):</label>
            <select value={inPlayerId} onChange={(e) => setInPlayerId(e.target.value)} style={{ width: '100%', margin: '0.3rem 0 0.8rem' }}>
              <option value="">— elige lanzador —</option>
              {(team?.players ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {pname(p)} {activeIds.has(p.id) ? '' : outIds.has(p.id) ? '· REINGRESO' : '· banca'}
                </option>
              ))}
            </select>
            <p className="muted" style={{ fontSize: '0.8rem' }}>
              Solo cambia quién lanza — no toca el orden de bateo. Si el pitcher también entra a batear, usa "Cambio de jugador".
            </p>
          </>
        ) : (
          <>
            <label className="muted">{mode === 'FIX' ? 'El jugador real era:' : 'Entra al juego:'}</label>
            {mode === 'FIX' && (
              <p className="muted" style={{ fontSize: '0.8rem', margin: '0.3rem 0' }}>
                Sus jugadas ya anotadas pasan al jugador correcto (hits, bases, fildeo, pitcheo). Si estaba en base, el rombo lo muestra corregido.
              </p>
            )}
            <input className="lb-search" placeholder="🔍 Buscar por nombre o #..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: '100%', margin: '0.3rem 0' }} />
            <div className="lb-pool-list" style={{ maxHeight: 180 }}>
              {candidates.map(({ player, ref, rein }) => (
                <button key={player.id} className={`pool-item ${ref ? 'ref' : ''} ${inPlayerId === player.id ? 'sel' : ''}`}
                  onClick={() => setInPlayerId(player.id)}>
                  <span className="pool-num">{player.number ?? '—'}</span>
                  <span className="pool-name">{player.firstName} {player.lastName}</span>
                  {rein && <span className="pill" style={{ background: '#dcfce7', color: '#14532d', marginLeft: '0.4rem' }}>REINGRESO</span>}
                  {ref && <span className="pill ref-pill">REF</span>}
                </button>
              ))}
              {candidates.length === 0 && <p className="muted" style={{ padding: '0.4rem' }}>Sin jugadores disponibles</p>}
            </div>

            <label className="row" style={{ gap: '0.4rem', margin: '0.5rem 0' }}>
              <input type="checkbox" checked={showRef} onChange={(e) => setShowRef(e.target.checked)} />
              <strong>Refuerzo de otro equipo</strong>
            </label>
            {showRef && (
              <select value={refTeamId} onChange={(e) => setRefTeamId(e.target.value)} style={{ width: '100%', marginBottom: '0.5rem' }}>
                <option value="">— equipo del refuerzo —</option>
                {allTeams.filter((t) => t.id !== effTeamId
                  && (!game.leagueId || t.leagueId === game.leagueId)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}

            {mode !== 'FIX' && (
              <div className="row" style={{ marginTop: '0.3rem' }}>
                <label>Posición
                  <select value={position} onChange={(e) => setPosition(e.target.value)} style={{ marginLeft: 6 }}>
                    {POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>
              </div>
            )}
          </>
        )}

        {undoableSubs.length > 0 && (
          <div style={{ borderTop: '1px solid var(--line, #e2e8f0)', marginTop: '0.8rem', paddingTop: '0.6rem' }}>
            <label className="muted" style={{ fontSize: '0.8rem' }}>↩ Deshacer un cambio hecho:</label>
            {undoableSubs.map((s) => {
              const out = (game.lineups ?? []).find((l) => l.id === s.replacesId);
              const tname = s.teamId === game.awayTeamId ? (game.awayTeam?.shortName ?? 'Vis') : (game.homeTeam?.shortName ?? 'Loc');
              return (
                <div key={s.id} className="row" style={{ justifyContent: 'space-between', padding: '2px 0', fontSize: '0.9rem' }}>
                  <span>
                    <span className="muted">{tname}:</span> entró <strong>{pname(s.player)}</strong>
                    <span className="muted"> por </span>{out ? pname(out.player) : '?'}
                    {s.subInInning != null && <span className="muted"> ({s.subInInning}°{s.subInHalf === 'BOTTOM' ? '↓' : '↑'})</span>}
                  </span>
                  <button className="secondary" style={{ padding: '0 8px', fontSize: '0.8rem' }} onClick={() => undoSub(s.id)} disabled={busy}>↩ deshacer</button>
                </div>
              );
            })}
          </div>
        )}

        <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'flex-end' }}>
          <button className="secondary" onClick={onCancel}>Cancelar</button>
          <button onClick={submit} disabled={busy || !inPlayerId || ((mode === 'SUB' || mode === 'CR' || mode === 'FIX') && !outEntryId)}>
            {busy ? 'Guardando…' : 'Confirmar'}
          </button>
        </div>
        {err && <p style={{ color: 'var(--red)' }}>{err}</p>}
      </div>
    </div>
  );
}
