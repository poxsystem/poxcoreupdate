import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api, type AuditOp, type Game, type GameDecisions, type LineupEntry, type Player, type StatLine, type Team } from '../api';
import { applyEvent, defaultAdvances, initialState, isMidResult, PA_RESULTS, reduceGame, thirdOutIsForce, type GameEvent, type GameState } from '@poxscore/shared';

type FullGame = Game & {
  homeTeam?: Team & { players?: Player[] };
  awayTeam?: Team & { players?: Player[] };
  lineups?: (LineupEntry & { player?: Player })[];
  state?: GameState;
};

interface Props { gameId: string; onClose: () => void; }

const pname = (p?: Player) => (p ? `${p.firstName} ${p.lastName}` : '—');

// campos digitables de la línea manual (key StatLine → etiqueta española)
const SL_KEYS: [keyof StatLine | 'ip', string][] = [
  ['pa', 'PA'], ['ab', 'VB'], ['r', 'CA'], ['h', 'H'], ['doubles', '2B'], ['triples', '3B'],
  ['hr', 'HR'], ['rbi', 'CI'], ['bb', 'BB'], ['k', 'SO'], ['hbp', 'CP'], ['sac', 'SAC'],
  ['sf', 'SF'], ['sb', 'BR'],
  ['ip', 'IL'], ['pH', 'H L'], ['pR', 'C L'], ['pER', 'CL'], ['pBB', 'BB L'], ['pK', 'SO L'],
  ['pHR', 'HR L'], ['pPitches', 'Lanz'],
  ['po', 'PO'], ['a', 'A'], ['e', 'E'],
];
const SL_POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'SF', 'IF', 'OF', 'EH', 'DH', 'PH', 'PR'];

/** Editor de juego del módulo admin: scoreboard, jugadas, jugador erróneo y decisiones. */
export default function AdminGameEdit({ gameId, onClose }: Props) {
  const [game, setGame] = useState<FullGame | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [state, setState] = useState<GameState | null>(null);
  const [draft, setDraft] = useState<Record<string, Partial<GameEvent>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [swap, setSwap] = useState({ teamId: '', aId: '', bId: '' });
  const [dec, setDec] = useState({ wpId: '', lpId: '', svId: '', hldIds: [] as string[], bsIds: [] as string[], tied: false });
  const [meta, setMeta] = useState({ date: '', stadium: '', status: '' });
  // línea manual: jugador que estuvo y no quedó anotado (ej. el 9no del lineup)
  const [slP, setSlP] = useState({ teamId: '', playerId: '', addLineup: false, position: '', order: '' });
  const [slN, setSlN] = useState<Record<string, string>>({}); // stats digitados (texto → número al enviar)
  // auditoría: op esperando decisiones obligatorias + formulario de inserción + motivo
  const [pendingAudit, setPendingAudit] = useState<{ ops: AuditOp[]; needScore: { away: number; home: number } } | null>(null);
  const [auditReason, setAuditReason] = useState('');
  const [showAuditLog, setShowAuditLog] = useState(false);
  const [ins, setIns] = useState<null | { beforeSeq: number }>(null); // insertar jugada antes de esta seq
  const [insF, setInsF] = useState({ result: '1B', batterId: '', pitcherId: '', notation: '' });
  const [advOpen, setAdvOpen] = useState<number | null>(null); // seq con editor de avances abierto
  const [advAdd, setAdvAdd] = useState({ pid: '', to: 'HOME' }); // corredor a agregar en la fila abierta

  const load = useCallback(async () => {
    const [g, evs] = await Promise.all([api.game(gameId), api.events(gameId)]);
    setGame(g as FullGame);
    setEvents(evs);
    setState((g as FullGame).state ?? null);
    const parseIds = (s: string | null | undefined): string[] => {
      try { return s ? (JSON.parse(s) as string[]) : []; } catch { return []; }
    };
    setDec({
      wpId: g.wpId ?? '', lpId: g.lpId ?? '', svId: g.svId ?? '',
      hldIds: parseIds(g.hldIds), bsIds: parseIds(g.bsIds), tied: !!g.tied,
    });
    setMeta({
      date: g.date ? new Date(g.date).toISOString().slice(0, 10) : '',
      stadium: g.stadium ?? '', status: g.status ?? '',
    });
    setDraft({});
  }, [gameId]);
  useEffect(() => { void load().catch((e) => setErr(e.message)); }, [load]);

  // mapa jugadorId → {jugador, equipoId} de rosters + lineups (incluye bajas/transferidos)
  const players = useMemo(() => {
    const m = new Map<string, { p: Player; teamId: string }>();
    for (const side of [game?.awayTeam, game?.homeTeam]) {
      for (const p of side?.players ?? []) m.set(p.id, { p, teamId: side!.id });
    }
    for (const l of game?.lineups ?? []) {
      if (l.player && !m.has(l.playerId)) m.set(l.playerId, { p: l.player, teamId: l.teamId });
    }
    for (const p of game?.statPlayers ?? []) {
      if (!m.has(p.id)) m.set(p.id, { p: p as Player, teamId: '' });
    }
    return m;
  }, [game]);

  const popt = (pid: string | null | undefined) => players.get(pid ?? '')?.p;
  const lineupOf = (teamId: string) => (game?.lineups ?? []).filter((l) => l.teamId === teamId);
  // quién jugó por ese equipo: lineup + statLines + referencias en el stream.
  // Un pitcher entrado por PC puede no tener fila de lineup (el selector de
  // lanzador ofrece todo el roster) — el endpoint ya lo cruza, el select no
  // lo ofrecía y no había forma de corregir "me equivoqué de lanzador".
  const playedOf = (teamId: string) => {
    const ids = new Set(lineupOf(teamId).map((l) => l.playerId));
    for (const l of game?.statLines ?? []) if (l.playerId && l.teamId === teamId) ids.add(l.playerId);
    for (const e of events) {
      const batting = e.half === 'TOP' ? game?.awayTeamId : game?.homeTeamId;
      const fielding = e.half === 'TOP' ? game?.homeTeamId : game?.awayTeamId;
      if (teamId === batting) {
        if (e.batterId) ids.add(e.batterId);
        for (const a of e.advances ?? []) if (a.playerId) ids.add(a.playerId);
      }
      if (teamId === fielding) {
        if (e.pitcherId) ids.add(e.pitcherId);
        for (const pid of [...(e.errorOn ?? []), ...(e.putouts ?? []), ...(e.assists ?? [])]) ids.add(pid);
      }
    }
    return [...ids];
  };
  const rosterOf = (teamId: string) =>
    (teamId === game?.homeTeam?.id ? game?.homeTeam?.players : game?.awayTeam?.players) ?? [];

  const dirtyOf = (e: GameEvent) => draft[`seq${e.seq}`];
  const setField = (e: GameEvent, k: keyof GameEvent, v: unknown) => {
    const key = `seq${e.seq}`;
    setDraft((d) => ({ ...d, [key]: { ...d[key], [k]: v } }));
  };
  const val = <K extends keyof GameEvent>(e: GameEvent, k: K): GameEvent[K] =>
    (dirtyOf(e)?.[k] ?? e[k]) as GameEvent[K];

  // ── Auditoría de juego: TODA mutación de jugadas pasa por /audit — recalcula
  // estado + boxscore + temporada + standing. Si el usuario ya tiene Ganó/Perdió
  // seleccionados en pantalla, los envía de una vez para no rebotar con 409.
  const runAudit = async (ops: AuditOp[]) => {
    setBusy('audit'); setErr(''); setMsg('');
    try {
      const preDec: GameDecisions | null = (dec.wpId && dec.lpId)
        ? { wpId: dec.wpId, lpId: dec.lpId, svId: dec.svId || null, hldIds: dec.hldIds, bsIds: dec.bsIds, tied: false }
        : null;
      const r = await api.auditGame(gameId, ops, preDec, auditReason || undefined);
      setState(r.state);
      setDraft({});
      setPendingAudit(null);
      setMsg(`Auditoría aplicada — marcador ${r.score.away}-${r.score.home}${r.outcomeChanged ? ' · resultado cambiado, decisiones actualizadas' : ''}${r.trimmed ? ` · ${r.trimmed} jugada(s) sobrantes eliminadas` : ''}`);
      await load();
    } catch (ex) {
      const e = ex as Error;
      // el 409 llega como JSON en e.message — parseo para extraer needDecisions
      let body: { needDecisions?: boolean; scoreAfter?: { away: number; home: number }; error?: string } | null = null;
      try { body = JSON.parse(e.message); } catch { /* texto plano */ }
      if (body?.needDecisions || /needDecisions/i.test(e.message)) {
        const sc = body?.scoreAfter ?? { away: 0, home: 0 };
        setPendingAudit({ ops, needScore: sc });
        if (sc.away !== sc.home) setDec((d) => ({ ...d, tied: false }));
        const txt = `El resultado del juego CAMBIÓ a ${sc.away}-${sc.home} — baja a «Decisiones de pitcheo», marca Ganador y Perdedor y pulsa «✓ Confirmar auditoría».`;
        setErr(`⚠️ ${txt}`);
        window.alert(`⚠️ ${txt}`);
        document.querySelector('.ge-dec')?.scrollIntoView({ behavior: 'smooth' });
      } else {
        setErr(body?.error ?? e.message);
      }
    } finally { setBusy(null); }
  };

  // reenvía la op pendiente con las decisiones marcadas
  const applyPendingAudit = async () => {
    if (!pendingAudit) return;
    setBusy('audit'); setErr(''); setMsg('');
    try {
      const isTie = pendingAudit.needScore.away === pendingAudit.needScore.home;
      const dec2: GameDecisions = {
        wpId: dec.wpId || null, lpId: dec.lpId || null, svId: dec.svId || null,
        hldIds: dec.hldIds, bsIds: dec.bsIds, tied: isTie ? true : false,
      };
      const r = await api.auditGame(gameId, pendingAudit.ops, dec2, auditReason || undefined);
      setState(r.state);
      setDraft({});
      setPendingAudit(null);
      setMsg(`Auditoría aplicada — marcador ${r.score.away}-${r.score.home}${r.trimmed ? ` · ${r.trimmed} jugada(s) sobrantes eliminadas` : ''}`);
      await load();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(null); }
  };

  const opOf = (e: GameEvent): AuditOp | null => {
    const d = dirtyOf(e);
    if (!d) return null;
    return {
      action: 'edit', seq: e.seq,
      result: d.result as string | undefined,
      notation: d.notation === undefined ? undefined : (d.notation as string | null),
      batterId: d.batterId === undefined ? undefined : (d.batterId as string | null),
      pitcherId: d.pitcherId === undefined ? undefined : (d.pitcherId as string | null),
      inning: d.inning as number | undefined,
      half: d.half as 'TOP' | 'BOTTOM' | undefined,
      advances: d.advances as GameEvent['advances'] | undefined,
    };
  };
  const apply = async (e: GameEvent) => {
    // aplica todos los cambios pendientes (incluyendo el de esta fila u otra que haya quedado editada)
    const ops = events.map(opOf).filter((x): x is AuditOp => !!x);
    if (!ops.length) {
      window.alert(`La jugada #${e.seq} no tiene cambios todavía.\n\nPara corregirla: cambia el Resultado / Notación / Entrada arriba en la fila, o pulsa 🏃 para corregir a dónde llegó cada corredor (ej. «anotó» → «a 3ª» quita la carrera). Luego ✓ Aplicar.`);
      return;
    }
    await runAudit(ops);
  };
  // un solo clic aplica TODAS las filas editadas — más claro que un ✓ por fila
  const applyAll = async () => {
    const ops = events.map(opOf).filter((x): x is AuditOp => !!x);
    if (ops.length) await runAudit(ops);
  };

  // ── editor de avances por jugada: "anotó"→"a 3ª" resta la carrera al recalcular ──
  const advOf = (e: GameEvent) => (val(e, 'advances') ?? []) as { playerId: string; to: number | 'HOME' | 'OUT' }[];
  const setAdvTo = (e: GameEvent, i: number, to: string) => {
    if (to === 'NA') { delAdv(e, i); return; } // NA = el corredor no avanzó en esta jugada
    const cur = advOf(e).slice();
    cur[i] = { ...cur[i], to: to === 'HOME' || to === 'OUT' ? to : Number(to) };
    setField(e, 'advances', cur);
  };
  const delAdv = (e: GameEvent, i: number) => setField(e, 'advances', advOf(e).filter((_, j) => j !== i));
  const addAdv = (e: GameEvent) => {
    if (!advAdd.pid || advOf(e).some((a) => a.playerId === advAdd.pid)) return;
    setField(e, 'advances', [...advOf(e), { playerId: advAdd.pid, to: advAdd.to === 'HOME' || advAdd.to === 'OUT' ? advAdd.to : Number(advAdd.to) }]);
    setAdvAdd({ pid: '', to: 'HOME' });
  };

  const auditDelete = (e: GameEvent, fromHere: boolean) => {
    const what = fromHere ? `la jugada #${e.seq} Y TODAS las posteriores` : `la jugada #${e.seq}`;
    if (!window.confirm(`¿Borrar ${what}? El juego se recalcula completo (score, stats, temporada, standing).`)) return;
    void runAudit([{ action: fromHere ? 'deleteFrom' : 'delete', seq: e.seq }]);
  };

  // avances sugeridos para la jugada insertada: estado justo ANTES de esa seq
  // (reduceGame sobre el prefijo) + avances por defecto del resultado elegido
  const insAdv = useMemo(() => {
    if (!ins) return [] as GameEvent['advances'];
    const before = events.filter((e) => e.seq < ins.beforeSeq);
    const st = reduceGame(before, game?.innings ?? 9);
    return insF.batterId ? defaultAdvances(st, insF.batterId, insF.result as Parameters<typeof defaultAdvances>[2]) : [];
  }, [ins, insF.result, insF.batterId, events, game?.innings]);

  // estado en el punto de inserción (para sugerir avances por defecto)
  const doInsert = async (beforeSeq: number) => {
    if (!insF.result) return;
    await runAudit([{
      action: 'insert', beforeSeq,
      event: {
        result: insF.result,
        notation: insF.notation || null,
        batterId: insF.batterId || null,
        pitcherId: insF.pitcherId || null,
        inning: events.find((e) => e.seq === beforeSeq)?.inning ?? events[events.length - 1]?.inning ?? 1,
        half: events.find((e) => e.seq === beforeSeq)?.half ?? 'TOP',
        advances: insAdv ?? [],
      },
    }]);
    setIns(null);
  };

  const doSwap = async () => {
    if (!swap.teamId || !swap.aId || !swap.bId) return;
    setBusy('swap'); setErr(''); setMsg('');
    try {
      const r = await api.swapPlayer(gameId, swap);
      setMsg(`Jugador corregido — ${r.eventsFixed} jugadas reasignadas${r.swapped ? ' (intercambio)' : ''}`);
      setSwap({ teamId: '', aId: '', bId: '' });
      await load();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(null); }
  };

  const doDecisions = async () => {
    setBusy('dec'); setErr(''); setMsg('');
    try {
      await api.updateDecisions(gameId, {
        wpId: dec.wpId || null, lpId: dec.lpId || null, svId: dec.svId || null,
        hldIds: dec.hldIds, bsIds: dec.bsIds, tied: dec.tied,
      });
      setMsg('Decisiones actualizadas');
      await load();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(null); }
  };

  const doMeta = async () => {
    setBusy('meta'); setErr(''); setMsg('');
    try {
      await api.updateGame(gameId, { date: meta.date || undefined, stadium: meta.stadium || undefined, status: meta.status || undefined });
      setMsg('Datos del juego actualizados');
      await load();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(null); }
  };

  // ── línea manual ──
  const loadLine = (ln: StatLine) => {
    setSlP({ teamId: ln.teamId ?? '', playerId: ln.playerId, addLineup: false, position: '', order: '' });
    const n: Record<string, string> = {};
    for (const [k] of SL_KEYS) if (k !== 'ip' && ln[k] != null && Number(ln[k])) n[k] = String(ln[k]);
    if (ln.pOuts) n.ip = `${Math.floor(ln.pOuts / 3)}.${ln.pOuts % 3}`;
    setSlN(n);
  };
  const doSetLine = async () => {
    if (!slP.playerId || !slP.teamId) return;
    setBusy('sl'); setErr(''); setMsg('');
    try {
      const stats: Record<string, number> = {};
      for (const [k, v] of Object.entries(slN)) {
        const n = Number(v);
        if (v !== '' && Number.isFinite(n) && n > 0) stats[k] = n;
      }
      const r = await api.setStatLine(gameId, slP.playerId, {
        teamId: slP.teamId, stats,
        lineup: slP.addLineup ? { add: true, position: slP.position, order: slP.order ? Number(slP.order) : undefined } : undefined,
      });
      setMsg(`Línea guardada para ${pname(popt(slP.playerId))}${r.lineupAdded ? ' — agregado a la alineación' : ''}${r.seasonAdjusted ? ' · temporada ajustada' : ''}`);
      setSlP({ teamId: '', playerId: '', addLineup: false, position: '', order: '' });
      setSlN({});
      await load();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(null); }
  };
  const doDelLine = async (ln: StatLine) => {
    const inLn = (game?.lineups ?? []).some((l) => l.playerId === ln.playerId);
    const rmLn = inLn && window.confirm('También quitarlo de la alineación del juego?');
    setBusy('sl'); setErr(''); setMsg('');
    try {
      await api.delStatLine(gameId, ln.playerId, rmLn);
      setMsg('Línea eliminada');
      await load();
    } catch (ex) { setErr(ex instanceof Error ? ex.message : String(ex)); }
    finally { setBusy(null); }
  };

  if (!game) return <div className="card"><p className="muted">Cargando juego…</p></div>;
  const paEvents = events; // todas — incl. mid-play (WP/SB/avances): una carrera puede anotar en una de esas
  const midCount = events.filter((e) => isMidResult(e.result)).length;
  const dirtyCount = Object.keys(draft).length;

  // Desglose exacto de qué jugadas suman cada carrera en el motor (applyEvent + thirdOutIsForce)
  const runBreakdown = (() => {
    const away: { seq: number; inning: number; half: 'TOP' | 'BOTTOM'; pid: string; advIdx: number; result: string }[] = [];
    const home: { seq: number; inning: number; half: 'TOP' | 'BOTTOM'; pid: string; advIdx: number; result: string }[] = [];
    const cancelledSeqs = new Set<number>();
    let st = initialState();
    for (const ev of events) {
      if (st.status === 'FINAL') break;
      const cancel = thirdOutIsForce(st, ev);
      (ev.advances ?? []).forEach((a, idx) => {
        if (a.to === 'HOME') {
          if (cancel) cancelledSeqs.add(ev.seq);
          else (ev.half === 'TOP' ? away : home).push({ seq: ev.seq, inning: ev.inning, half: ev.half, pid: a.playerId, advIdx: idx, result: ev.result });
        }
      });
      st = applyEvent(st, ev, game.innings ?? 9);
    }
    return { away, home, cancelledSeqs };
  })();

  // Quita una carrera en 1 solo click (cambia ese avance HOME -> a 3ª y aplica la auditoría)
  const quickRemoveRun = async (seq: number, advIdx: number, pid: string) => {
    const ev = events.find((x) => x.seq === seq);
    if (!ev) return;
    if (!window.confirm(`¿Quitar la carrera de ${pname(popt(pid))} en la jugada #${seq} (${ev.inning}${ev.half === 'TOP' ? '▲' : '▼'} · ${ev.result})?`)) return;
    const nextAdv = (ev.advances ?? []).map((a, i) => (i === advIdx ? { ...a, to: 3 as const } : a));
    await runAudit([{ action: 'edit', seq, advances: nextAdv }]);
  };
  // candidatos a decisión: lanzaron por eventos, tienen línea manual con outs, o son P del lineup
  const pitCands = [...new Set<string>([
    ...events.map((e) => e.pitcherId).filter((x): x is string => !!x),
    ...(game.statLines ?? []).filter((l) => (l.pOuts ?? 0) > 0).map((l) => l.playerId),
    ...(game.lineups ?? []).filter((l) => l.position === 'P').map((l) => l.playerId),
  ])];

  // opciones de los selects de decisión: los pitchers detectados primero,
  // y debajo TODOS los jugadores de ambos equipos — si el lanzador que
  // necesitas no está en los detectados, la lista vacía dejaba el botón
  // "Confirmar auditoría" deshabilitado para siempre
  const decisionOptions = (
    <>
      {pitCands.length > 0 && (
        <optgroup label="Lanzadores del juego">
          {pitCands.map((pid) => <option key={pid} value={pid}>{pname(popt(pid))}</option>)}
        </optgroup>
      )}
      {[game.awayTeam, game.homeTeam].filter(Boolean).map((t) => (
        <optgroup key={t!.id} label={`Todos — ${t!.shortName ?? t!.name}`}>
          {(t!.players ?? []).filter((p) => !pitCands.includes(p.id)).map((p) => (
            <option key={p.id} value={p.id}>{pname(p)}</option>
          ))}
        </optgroup>
      ))}
    </>
  );

  const playerSelect = (e: GameEvent, field: 'batterId' | 'pitcherId') => (
    <select
      value={val(e, field) ?? ''}
      onChange={(ev) => setField(e, field, ev.target.value || null)}
    >
      <option value="">—</option>
      {[game.awayTeam, game.homeTeam].filter(Boolean).map((t) => (
        <optgroup key={t!.id} label={t!.shortName ?? t!.name}>
          {lineupOf(t!.id).map((l) => (
            <option key={l.playerId} value={l.playerId}>
              {pname(l.player ?? popt(l.playerId))}{l.player ? '' : ' (roster)'}
            </option>
          ))}
          {(t!.players ?? []).filter((p) => !lineupOf(t!.id).some((l) => l.playerId === p.id)).map((p) => (
            <option key={p.id} value={p.id}>{pname(p)} ·roster·</option>
          ))}
        </optgroup>
      ))}
    </select>
  );

  return (
    <div className="ge-edit">
      <div className="ge-head">
        <button className="secondary icon" onClick={onClose}>← Volver</button>
        <h3>
          {game.awayTeam?.name ?? '?'} <b>{state?.score.away ?? 0}</b> @{' '}
          {game.homeTeam?.name ?? '?'} <b>{state?.score.home ?? 0}</b>
          <span className="muted"> · {game.status} · {game.date ? new Date(game.date).toLocaleDateString('es') : ''}</span>
        </h3>
      </div>
      {err && <div className="passerr">⚠️ {err}</div>}
      {msg && <div className="ge-ok">✓ {msg}</div>}

      {/* ── Datos del juego ── */}
      <div className="card ge-sec">
        <h4>Datos del juego</h4>
        <div className="ge-row">
          <label>Fecha <input type="date" value={meta.date} onChange={(e) => setMeta({ ...meta, date: e.target.value })} /></label>
          <label>Estadio <input value={meta.stadium} onChange={(e) => setMeta({ ...meta, stadium: e.target.value })} /></label>
          <label>Estado
            <select value={meta.status} onChange={(e) => setMeta({ ...meta, status: e.target.value })}>
              {['SCHEDULED', 'LIVE', 'SUSPENDED', 'FINAL'].map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <button className="icon ok" disabled={busy === 'meta'} onClick={() => void doMeta()}>✓ Aplicar</button>
        </div>
      </div>

      {/* ── Corregir jugador erróneo ── */}
      <div className="card ge-sec">
        <h4>Corregir jugador erróneo</h4>
        <p className="muted">El jugador equivocado sale del lineup y de sus jugadas; el correcto hereda todo (también sirve si quedó fuera de la alineación).</p>
        <div className="ge-row">
          <select value={swap.teamId} onChange={(e) => setSwap({ teamId: e.target.value, aId: '', bId: '' })}>
            <option value="">Equipo…</option>
            {[game.awayTeam, game.homeTeam].filter(Boolean).map((t) => <option key={t!.id} value={t!.id}>{t!.name}</option>)}
          </select>
          <select value={swap.aId} onChange={(e) => setSwap({ ...swap, aId: e.target.value })} disabled={!swap.teamId}>
            <option value="">Erróneo (jugó por ese equipo)…</option>
            {playedOf(swap.teamId).map((pid) => <option key={pid} value={pid}>{pname(popt(pid))}</option>)}
          </select>
          <select value={swap.bId} onChange={(e) => setSwap({ ...swap, bId: e.target.value })} disabled={!swap.teamId}>
            <option value="">Correcto (roster)…</option>
            {rosterOf(swap.teamId).filter((p) => p.id !== swap.aId).map((p) => <option key={p.id} value={p.id}>{pname(p)}</option>)}
          </select>
          <button className="icon ok" disabled={busy === 'swap' || !swap.aId || !swap.bId} onClick={() => void doSwap()}>↔ Corregir</button>
        </div>
      </div>

      {/* ── Jugador no anotado (línea manual) ── */}
      <div className="card ge-sec">
        <h4>Jugador que estuvo y no se anotó</h4>
        <p className="muted">
          Agrega al jugador faltante con sus números escritos a mano (ej. el lineup tiene 8 y jugó un 9no).
          Los números se <b>suman</b> a su ficha y a las tablas de la liga/website; si también lo incluyes
          en la alineación aparece en la hoja y el boxscore.
        </p>
        <div className="ge-row">
          <select value={slP.teamId} onChange={(e) => setSlP({ ...slP, teamId: e.target.value, playerId: '' })}>
            <option value="">Equipo…</option>
            {[game.awayTeam, game.homeTeam].filter(Boolean).map((t) => <option key={t!.id} value={t!.id}>{t!.name}</option>)}
          </select>
          <select value={slP.playerId} onChange={(e) => setSlP({ ...slP, playerId: e.target.value })} disabled={!slP.teamId}>
            <option value="">Jugador…</option>
            {rosterOf(slP.teamId).map((p) => <option key={p.id} value={p.id}>{pname(p)}</option>)}
          </select>
          <label className="ge-check">
            <input type="checkbox" checked={slP.addLineup} onChange={(e) => setSlP({ ...slP, addLineup: e.target.checked })} />
            Incluir en la alineación
          </label>
          {slP.addLineup && (
            <>
              <select value={slP.position} onChange={(e) => setSlP({ ...slP, position: e.target.value })}>
                <option value="">Posición…</option>
                {SL_POSITIONS.map((p) => <option key={p}>{p}</option>)}
              </select>
              <input className="ge-inn" style={{ width: 56 }} placeholder="Orden" title="Casilla del orden bateador (vacío = siguiente)"
                value={slP.order} onChange={(e) => setSlP({ ...slP, order: e.target.value.replace(/\D/g, '') })} />
            </>
          )}
        </div>
        {slP.playerId && (
          <div className="ge-slgrid">
            {SL_KEYS.map(([k, lbl]) => (
              <label key={k} className="ge-slcell">
                <span>{lbl}</span>
                <input inputMode="decimal" value={slN[k] ?? ''} placeholder="0"
                  onChange={(e) => setSlN({ ...slN, [k]: e.target.value.replace(/[^\d.]/g, '') })} />
              </label>
            ))}
          </div>
        )}
        <div className="ge-row">
          <button className="icon ok" disabled={busy === 'sl' || !slP.playerId || !slP.teamId || (slP.addLineup && !slP.position)}
            onClick={() => void doSetLine()}>✓ Guardar línea</button>
          {slP.playerId && <button className="secondary icon" onClick={() => { setSlP({ teamId: '', playerId: '', addLineup: false, position: '', order: '' }); setSlN({}); }}>✕ Cancelar</button>}
        </div>
        {(game.statLines ?? []).length > 0 && (
          <table className="admin-table ge-table" style={{ marginTop: 8 }}>
            <thead><tr><th>Jugador</th><th>Equipo</th><th>Bateo</th><th>Pitcheo</th><th>Fildeo</th><th></th></tr></thead>
            <tbody>
              {(game.statLines ?? []).map((ln, i) => {
                const t = ln.teamId === game.awayTeamId ? game.awayTeam : ln.teamId === game.homeTeamId ? game.homeTeam : null;
                return (
                  <tr key={`${ln.playerId}-${i}`}>
                    <td>{pname(popt(ln.playerId))}</td>
                    <td className="muted">{t?.shortName ?? t?.name ?? '—'}</td>
                    <td>{(ln.ab ?? 0)}-{ln.h ?? 0}{ln.hr ? `, ${ln.hr} HR` : ''}{ln.rbi ? `, ${ln.rbi} CI` : ''}{ln.r ? `, ${ln.r} CA` : ''}</td>
                    <td>{ln.pOuts ? `${Math.floor(ln.pOuts / 3)}.${ln.pOuts % 3} IL` : '—'}</td>
                    <td>{ln.po || ln.a || ln.e ? `${ln.po ?? 0}-${ln.a ?? 0}-${ln.e ?? 0}` : '—'}</td>
                    <td className="admin-acts">
                      <button className="secondary icon" title="Editar línea" onClick={() => loadLine(ln)}>✏️</button>
                      <button className="secondary icon danger" title="Quitar línea" disabled={busy === 'sl'}
                        onClick={() => void doDelLine(ln)}>🗑</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Decisiones ── */}
      <div className="card ge-sec ge-dec">
        <h4>Decisiones de pitcheo</h4>
        {pendingAudit && (
          <div className="passerr" style={{ marginBottom: 8 }}>
            🔺 <b>El resultado cambió a {pendingAudit.needScore.away}-{pendingAudit.needScore.home}</b> —
            indica quién gana y quién pierde (o marca Empate) y confirma la auditoría:
            <div className="ge-row" style={{ marginTop: 6 }}>
              <button className="icon ok" disabled={busy === 'audit' || (!dec.tied && (!dec.wpId || !dec.lpId))}
                onClick={() => void applyPendingAudit()}>✓ Confirmar auditoría con estas decisiones</button>
              <button className="secondary icon" onClick={() => setPendingAudit(null)}>✕ Cancelar</button>
            </div>
          </div>
        )}
        <div className="ge-row">
          {(['wpId', 'lpId', 'svId'] as const).map((k) => (
            <label key={k}>{k === 'wpId' ? 'Ganó' : k === 'lpId' ? 'Perdió' : 'Salvó'}
              <select value={dec[k]} onChange={(e) => setDec({ ...dec, [k]: e.target.value })}>
                <option value="">—</option>
                {decisionOptions}
              </select>
            </label>
          ))}
          {(['hldIds', 'bsIds'] as const).map((k) => (
            <label key={k}>{k === 'hldIds' ? 'Holds' : 'Salvados fallados'}
              <select multiple size={5} value={dec[k]}
                onChange={(e) => setDec({ ...dec, [k]: [...e.target.selectedOptions].map((o) => o.value) })}>
                {decisionOptions}
              </select>
            </label>
          ))}
          <label className="ge-check"><input type="checkbox" checked={dec.tied} onChange={(e) => setDec({ ...dec, tied: e.target.checked })} /> Empate</label>
          <button className="icon ok" disabled={busy === 'dec'} onClick={() => void doDecisions()}>✓ Aplicar</button>
        </div>
      </div>

      {/* ── Jugadas (auditoría: editar / borrar / insertar, todo recalcula) ── */}
      <div className="card ge-sec">
        <h4>Jugadas ({paEvents.length}{midCount ? ` · ${midCount} movimientos entre turnos` : ' turnos'}) {dirtyCount > 0 && <span className="muted">· {dirtyCount} sin aplicar</span>}</h4>
        <div className="ge-row" style={{ marginBottom: 6 }}>
          {dirtyCount > 0 && (
            <button className="icon ok" style={{ fontWeight: 700 }} disabled={busy === 'audit'}
              title="Aplica todas las filas editadas (marcadas en amarillo) de una vez"
              onClick={() => void applyAll()}>✓ APLICAR {dirtyCount} CAMBIO{dirtyCount > 1 ? 'S' : ''}</button>
          )}
          <input placeholder="Motivo de la auditoría (queda en la bitácora)…" value={auditReason}
            onChange={(e) => setAuditReason(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
          <button className="secondary icon" title="Insertar jugada al FINAL del juego"
            onClick={() => { setIns({ beforeSeq: 9_999_999 }); setInsF({ result: '1B', batterId: '', pitcherId: '', notation: '' }); }}>＋ jugada al final</button>
          <button className="secondary icon" onClick={() => setShowAuditLog(!showAuditLog)}>
            📜 Bitácora{Array.isArray(game.auditLog) && game.auditLog.length ? ` (${game.auditLog.length})` : ''}
          </button>
        </div>
        {showAuditLog && (
          <div className="card" style={{ margin: '0 0 8px', padding: '0.5rem 0.8rem', background: 'var(--bg, #f6f8fa)' }}>
            {!Array.isArray(game.auditLog) || !game.auditLog.length
              ? <p className="muted" style={{ margin: 0 }}>Sin cambios auditados.</p>
              : (game.auditLog as { at: string; user: string; reason?: string | null; ops: { a: string; seq?: number; r?: string }[]; scoreBefore: { away: number; home: number }; scoreAfter: { away: number; home: number } }[]).map((a, i) => (
                <div key={i} style={{ padding: '0.2rem 0', borderBottom: '1px solid var(--border, #e2e8f0)', fontSize: '0.82rem' }}>
                  <b>{new Date(a.at).toLocaleString('es')}</b> · {a.user}
                  {a.reason ? ` · «${a.reason}»` : ''}
                  <div className="muted">
                    {a.ops.map((o, j) => (
                      <span key={j} style={{ marginRight: 8 }}>
                        {o.a === 'edit' ? '✏️ editó' : o.a === 'delete' ? '🗑 borró' : o.a === 'deleteFrom' ? '🗑 borró desde' : '＋ insertó en'} #{o.seq}{o.r ? ` (${o.r})` : ''}
                      </span>
                    ))}
                    · {a.scoreBefore.away}-{a.scoreBefore.home} → <b>{a.scoreAfter.away}-{a.scoreAfter.home}</b>
                  </div>
                </div>
              ))}
          </div>
        )}
        {(runBreakdown.away.length > 0 || runBreakdown.home.length > 0) && (
          <div className="card" style={{ margin: '0 0 8px', padding: '0.5rem 0.8rem', background: 'var(--bg, #f6f8fa)', fontSize: '0.82rem' }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>⚾ Carreras que están sumando al marcador (pulsa ✕ en una para quitarla directo):</div>
            {([
              [game.awayTeam?.name ?? 'Visitante', runBreakdown.away],
              [game.homeTeam?.name ?? 'Local', runBreakdown.home],
            ] as const).map(([tname, list]) => (
              <div key={tname} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                <b style={{ minWidth: 130 }}>{tname} ({list.length}):</b>
                {!list.length && <span className="muted">0 carreras</span>}
                {list.map((r, i) => (
                  <span key={`${r.seq}-${r.advIdx}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#dcfce7', color: '#14532d', border: '1px solid #86efac', borderRadius: 6, padding: '2px 6px' }}>
                    <a href={`#ge-seq-${r.seq}`} onClick={(ev) => { ev.preventDefault(); setAdvOpen(r.seq); document.getElementById(`ge-seq-${r.seq}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}
                      style={{ color: '#14532d', textDecoration: 'none', fontWeight: 600 }}
                      title="Ver jugada">
                      #{r.seq} ({r.inning}{r.half === 'TOP' ? '▲' : '▼'} {r.result}) {pname(popt(r.pid))}
                    </a>
                    <button className="secondary icon danger" disabled={busy === 'audit'}
                      style={{ padding: '0 4px', fontSize: '0.75rem', lineHeight: 1.2 }}
                      title="Quitar esta carrera (deja al corredor en 3ª y recalcula el marcador)"
                      onClick={() => void quickRemoveRun(r.seq, r.advIdx, r.pid)}>✕</button>
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
        <table className="admin-table ge-table">
          <thead>
            <tr><th>#</th><th>Ent</th><th>Bateador</th><th>Resultado</th><th>Notación</th><th>Lanzador</th><th></th></tr>
          </thead>
          <tbody>
            {paEvents.map((e) => {
              const key = `seq${e.seq}`;
              const dirty = !!dirtyOf(e);
              return (
                <Fragment key={key}>
                <tr id={`ge-seq-${e.seq}`} className={dirty ? 'ge-dirty' : ''}>
                  <td className="muted">
                    {e.seq}
                    {isMidResult(e.result) && <span title="Movimiento entre turnos (avance de corredores — WP, robo, error…)" style={{ color: '#a855f7' }}> ·</span>}
                    {advOf(e).some((a) => a.to === 'HOME') && (
                      runBreakdown.cancelledSeqs.has(e.seq)
                        ? <span title="Carrera anulada por 3er out forzado (ya NO suma al marcador)" style={{ marginLeft: 4, fontSize: '0.72rem', color: '#64748b' }}>🚫forzado</span>
                        : <span title="En esta jugada entra carrera al marcador" style={{ marginLeft: 4, fontSize: '0.72rem', background: '#16a34a', color: '#fff', borderRadius: 4, padding: '1px 4px', fontWeight: 700 }}>+{advOf(e).filter((a) => a.to === 'HOME').length}C</span>
                    )}
                  </td>
                  <td>
                    <input className="ge-inn" type="number" min={1} value={val(e, 'inning')} style={{ width: 42 }}
                      onChange={(ev) => setField(e, 'inning', Number(ev.target.value))} />
                    <select value={val(e, 'half')} onChange={(ev) => setField(e, 'half', ev.target.value)}>
                      <option value="TOP">▲</option><option value="BOTTOM">▼</option>
                    </select>
                  </td>
                  <td>{playerSelect(e, 'batterId')}</td>
                  <td>
                    <select value={val(e, 'result')} onChange={(ev) => setField(e, 'result', ev.target.value)}>
                      {PA_RESULTS.map((r) => <option key={r} value={r}>{r}</option>)}
                      {!PA_RESULTS.includes(val(e, 'result') as typeof PA_RESULTS[number]) && (
                        <option value={val(e, 'result')}>{val(e, 'result')}</option>
                      )}
                    </select>
                  </td>
                  <td>
                    <input className="ge-not" value={val(e, 'notation') ?? ''} placeholder="6-4-3"
                      onChange={(ev) => setField(e, 'notation', ev.target.value || null)} />
                  </td>
                  <td>{playerSelect(e, 'pitcherId')}</td>
                  <td className="admin-acts">
                    <button className="icon ok" disabled={busy === 'audit'} style={dirty ? {} : { opacity: 0.45 }}
                      title={dirty ? 'Aplicar cambios de esta jugada' : 'Sin cambios — pulsa para ver cómo corregir esta jugada'}
                      onClick={() => void apply(e)}>✓</button>
                    {dirty && <button className="secondary icon" title="Descartar"
                      onClick={() => setDraft((d) => { const n = { ...d }; delete n[key]; return n; })}>✕</button>}
                    <button className="secondary icon" title="Corregir corredores: a dónde llegó cada uno (ej. «anotó» → «a 3ª» quita la carrera)"
                      disabled={busy === 'audit'}
                      onClick={() => setAdvOpen(advOpen === e.seq ? null : e.seq)}>🏃{advOf(e).length ? ` ${advOf(e).length}` : ''}</button>
                    <button className="secondary icon" title="Insertar jugada ANTES de esta"
                      disabled={busy === 'audit'}
                      onClick={() => { setIns(ins?.beforeSeq === e.seq ? null : { beforeSeq: e.seq }); setInsF({ result: '1B', batterId: '', pitcherId: '', notation: '' }); }}>＋</button>
                    <button className="secondary icon danger" title="Borrar ESTA jugada"
                      disabled={busy === 'audit'} onClick={() => auditDelete(e, false)}>🗑</button>
                    <button className="secondary icon danger" title="Borrar DESDE esta jugada en adelante"
                      disabled={busy === 'audit'} onClick={() => auditDelete(e, true)}>⏭🗑</button>
                  </td>
                </tr>
                {advOpen === e.seq && (
                  <tr><td colSpan={7}>
                    <div style={{ background: 'var(--bg, #f6f8fa)', padding: '8px 10px', borderRadius: 6 }}>
                      <div className="muted" style={{ fontSize: '0.8rem', marginBottom: 6 }}>
                        ⚾ ¿A dónde llegó cada corredor? — si alguien anotó por error, ponle «a 3ª» (o la base correcta) y la carrera se resta sola.
                      </div>
                      {!advOf(e).length && <span className="muted">Esta jugada no tiene avances grabados.</span>}
                      {advOf(e).map((a, i) => (
                        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                          <b style={{ minWidth: 160 }}>{pname(popt(a.playerId))}</b>
                          <span className="muted">llegó</span>
                          <select value={String(a.to)} onChange={(ev) => setAdvTo(e, i, ev.target.value)} style={{ minWidth: 110 }}>
                            <option value="1">a 1ª</option>
                            <option value="2">a 2ª</option>
                            <option value="3">a 3ª</option>
                            <option value="HOME">✅ ANOTÓ</option>
                            <option value="OUT">❌ out</option>
                            <option value="NA">NA — no avanza</option>
                          </select>
                          <button className="secondary icon danger" title="Quitar — el corredor no llegó a ningún lado en esta jugada" onClick={() => delAdv(e, i)}>✕</button>
                        </div>
                      ))}
                      <details style={{ marginTop: 6 }}>
                        <summary className="muted" style={{ cursor: 'pointer', fontSize: '0.8rem' }}>＋ Agregar un corredor que falta en esta jugada</summary>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                          <select value={advAdd.pid} onChange={(ev) => setAdvAdd({ ...advAdd, pid: ev.target.value })}>
                            <option value="">jugador…</option>
                            {[...players.values()].filter((x) => !advOf(e).some((a) => a.playerId === x.p.id)).map((x) => (
                              <option key={x.p.id} value={x.p.id}>{pname(x.p)}</option>
                            ))}
                          </select>
                          <span className="muted">llegó</span>
                          <select value={advAdd.to} onChange={(ev) => setAdvAdd({ ...advAdd, to: ev.target.value })}>
                            <option value="1">a 1ª</option>
                            <option value="2">a 2ª</option>
                            <option value="3">a 3ª</option>
                            <option value="HOME">anotó</option>
                            <option value="OUT">out</option>
                          </select>
                          <button className="secondary icon" disabled={!advAdd.pid} onClick={() => addAdv(e)}>＋</button>
                        </div>
                      </details>
                      <button className="icon ok" style={{ marginTop: 8, fontWeight: 700 }} disabled={!dirty || busy === 'audit'}
                        onClick={() => void apply(e)}>✓ Aplicar corrección</button>
                    </div>
                  </td></tr>
                )}
                {ins?.beforeSeq === e.seq && (
                  <tr><td colSpan={7}>
                    <div className="ge-row" style={{ background: 'var(--bg, #f6f8fa)', padding: 6, borderRadius: 6 }}>
                      <span>Insertar antes de #{e.seq}:</span>
                      <select value={insF.result} onChange={(ev) => setInsF({ ...insF, result: ev.target.value })}>
                        {PA_RESULTS.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                      <select value={insF.batterId} onChange={(ev) => setInsF({ ...insF, batterId: ev.target.value })}>
                        <option value="">Bateador…</option>
                        {[game.awayTeam, game.homeTeam].filter(Boolean).map((t) => (
                          <optgroup key={t!.id} label={t!.shortName ?? t!.name}>
                            {(t!.players ?? []).map((p) => <option key={p.id} value={p.id}>{pname(p)}</option>)}
                          </optgroup>
                        ))}
                      </select>
                      <select value={insF.pitcherId} onChange={(ev) => setInsF({ ...insF, pitcherId: ev.target.value })}>
                        <option value="">Lanzador…</option>
                        {pitCands.map((pid) => <option key={pid} value={pid}>{pname(popt(pid))}</option>)}
                      </select>
                      <input className="ge-not" placeholder="Notación (opc)" value={insF.notation}
                        onChange={(ev) => setInsF({ ...insF, notation: ev.target.value })} />
                      <button className="icon ok" disabled={busy === 'audit'} onClick={() => void doInsert(e.seq)}>✓ Insertar</button>
                      <button className="secondary icon" onClick={() => setIns(null)}>✕</button>
                      <span className="muted" style={{ fontSize: '0.78rem' }}>
                        avances por defecto según el estado previo ({insAdv.length} mov.)
                      </span>
                    </div>
                  </td></tr>
                )}
                </Fragment>
              );
            })}
            {ins?.beforeSeq === 9_999_999 && (
              <tr><td colSpan={7}>
                <div className="ge-row" style={{ background: 'var(--bg, #f6f8fa)', padding: 6, borderRadius: 6 }}>
                  <span>Insertar al final:</span>
                  <select value={insF.result} onChange={(ev) => setInsF({ ...insF, result: ev.target.value })}>
                    {PA_RESULTS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <select value={insF.batterId} onChange={(ev) => setInsF({ ...insF, batterId: ev.target.value })}>
                    <option value="">Bateador…</option>
                    {[game.awayTeam, game.homeTeam].filter(Boolean).map((t) => (
                      <optgroup key={t!.id} label={t!.shortName ?? t!.name}>
                        {(t!.players ?? []).map((p) => <option key={p.id} value={p.id}>{pname(p)}</option>)}
                      </optgroup>
                    ))}
                  </select>
                  <select value={insF.pitcherId} onChange={(ev) => setInsF({ ...insF, pitcherId: ev.target.value })}>
                    <option value="">Lanzador…</option>
                    {pitCands.map((pid) => <option key={pid} value={pid}>{pname(popt(pid))}</option>)}
                  </select>
                  <input className="ge-not" placeholder="Notación (opc)" value={insF.notation}
                    onChange={(ev) => setInsF({ ...insF, notation: ev.target.value })} />
                  <label>Entrada <input className="ge-inn" type="number" min={1} style={{ width: 42 }}
                    defaultValue={events[events.length - 1]?.inning ?? 1} id="ge-ins-inn" /></label>
                  <select id="ge-ins-half" defaultValue={events[events.length - 1]?.half ?? 'TOP'}>
                    <option value="TOP">▲</option><option value="BOTTOM">▼</option>
                  </select>
                  <button className="icon ok" disabled={busy === 'audit'}
                    onClick={() => void runAudit([{
                      action: 'insert',
                      event: {
                        result: insF.result, notation: insF.notation || null,
                        batterId: insF.batterId || null, pitcherId: insF.pitcherId || null,
                        inning: Number((document.getElementById('ge-ins-inn') as HTMLInputElement)?.value) || (events[events.length - 1]?.inning ?? 1),
                        half: ((document.getElementById('ge-ins-half') as HTMLSelectElement)?.value as 'TOP' | 'BOTTOM') || 'TOP',
                        advances: insAdv ?? [],
                      },
                    }]).then(() => setIns(null))}>✓ Insertar</button>
                  <button className="secondary icon" onClick={() => setIns(null)}>✕</button>
                </div>
              </td></tr>
            )}
            {!paEvents.length && <tr><td colSpan={7} className="muted">El juego no tiene jugadas.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
