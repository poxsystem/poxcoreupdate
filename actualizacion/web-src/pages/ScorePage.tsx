import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, Game, Player, SeasonStat, getToken, type LineupEntry } from '../api';
import {
  applyEvent, computeBoxscore, computeInningTallies, defaultAdvances, initialState, isMidResult, ERROR_RESULTS,
  type Advance, type AdvanceTo, type GameEvent, type GameState, type InningTally, type PAResult, type PlayResult,
} from '@poxscore/shared';
import Diamond from '../components/Diamond';
import Scoresheet, { buildSheet } from '../components/Scoresheet';
import AdvanceModal, { type AdvanceRow } from '../components/AdvanceModal';
import RunnerMoveModal from '../components/RunnerMoveModal';
import SubModal from '../components/SubModal';
import TeamSummary from '../components/TeamSummary';
import FinishModal from '../components/FinishModal';
import PlayerCardModal from '../components/PlayerCardModal';
import ConsultaModal from '../components/ConsultaModal';
import VoiceModal from '../components/VoiceModal';
import LiveMic, { type VoiceCmd } from '../components/LiveMic';
import { voiceNotation as voiceNotationOf, normCmd } from '../lib/voiceCmd';
import { type MicCtxData } from '../components/MicCtx';
import PlayerAvatar from '../components/PlayerAvatar';
import DefenseBoard, { FIELD_POSITIONS } from '../components/DefenseBoard';
import { flushQueue, pendingCount, queueItems, clearQueue } from '../api';

import { RESULT_LABEL } from '../lib/labels';

// Botones grandes estilo BallScore: HIT / OUT / EMBASA abren el menú de variantes.
// Ordenados por semejanza: HIT lleva los embasados limpios (hits + pasaportes +
// fly de sacrificio — todo lo que el anotador agrupa como "se embasó"); OUT los
// ponches, luego outs de batazo por trayectoria, sacrificio, multi-outs y raras;
// EMBASA lo que alcanza base sin ser hit (error, selección/forzado, interferencia).
// '1BI' y 'FCT' son pseudo-resultados de UI: se traducen en openPlay a
// '1B' (hit de cuadro, rola preset) y 'FC' (forzado — corredor out) respectivamente.
const PICKER_GROUPS = [
  { key: 'hit' as const, label: 'HIT', cls: 'hit', results: [
    '1B', '1BI', '2B', '3B', 'HR', 'HRIP', // hits por bases
    'BB', 'IBB', 'HBP',                  // pasaportes (BallScore los agrupa aquí)
    'SF',                                // fly de sacrificio (embase del corredor)
    '1BE', '2BE', '3BE',                 // hit + error: 1ª fase el hit (zona), 2ª fase el E#
  ] as string[] },
  { key: 'out' as const, label: 'OUT', cls: 'out', results: [
    'K', 'KWP', 'KPB',                   // ponches
    'GO', 'FO', 'LO', 'PO',              // outs de batazo por trayectoria
    'FCT',                               // force out: corredor forzado out, bateador a 1ª (FC)
    'XF', 'IF',                          // outs en foul / infield fly
    'SAC', 'DP', 'TP',                   // sacrificio / doble / triple play
    'RHB', 'OOT', 'AIL', 'FI',           // jugadas raras
  ] as string[] },
  { key: 'base' as const, label: 'EMBASA', cls: 'walk', results: [
    'FC', 'FCT',                         // selección / forzado (jugada de selección)
    'E', 'CI',                           // error / interferencia del receptor
  ] as string[] },
];

// pseudo-resultados de la botonera → resultado real que se graba
// 1BI = hit de cuadro (1B con trayectoria rola y notación de infield)
// FCT = forzado (FC donde el compañero es out en base, ej. 4-6)
const PSEUDO: Record<string, PAResult> = { '1BI': '1B', FCT: 'FC' };

// 'ADJ' incluido para que la voz pueda abrir la pantalla de corredores
// ("avance por error del 2" → ADJ+E2: error cargado + corredor decide)
// 'LIB' = avance libre: el corredor se mueve sin que medie jugada (jugadas
// raras y correcciones manuales de la planilla)
const MID_BUTTONS = ['SB', 'CS', 'WP', 'PB', 'BK', 'PK', 'DI', 'IPL', 'LE', 'EF', 'INT', 'OBS', 'ADJ', 'LIB'] as const;

// Híbridos hit+error: 1ª fase se marca el hit, 2ª fase el error (E#) y la base extra del bateador
const HYBRID: Record<string, { hitCode: PAResult; extraTo: AdvanceTo; extraLabel: string }> = {
  '1BE': { hitCode: '1B', extraTo: 2, extraLabel: 'a 2ª' },
  '2BE': { hitCode: '2B', extraTo: 3, extraLabel: 'a 3ª' },
  '3BE': { hitCode: '3B', extraTo: 'HOME', extraLabel: 'anota' },
};

// indicadores del turno en la barra en vivo: mismos colores que los avances
// del mini-diamante — verde = embasó limpio, rojo = out, ámbar = error
const HIT_TURNS = new Set(['1B', '2B', '3B', 'HR', 'RHB', '1BE', '2BE', '3BE', 'HRIP']);
const OUT_TURNS = new Set(['K', 'KWP', 'KPB', 'GO', 'FO', 'LO', 'PO', 'IF', 'XF', 'SAC', 'SF', 'DP', 'TP', 'AO', 'OOT', 'AIL', 'FI']);

// numeración defensiva para el selector de error
const FIELD_POS: { n: number; pos: string }[] = [
  { n: 1, pos: 'P' }, { n: 2, pos: 'C' }, { n: 3, pos: '1B' }, { n: 4, pos: '2B' },
  { n: 5, pos: '3B' }, { n: 6, pos: 'SS' }, { n: 7, pos: 'LF' }, { n: 8, pos: 'CF' }, { n: 9, pos: 'RF' },
];

// llave de idempotencia por jugada: el doble toque y la cola offline reenvían
// el mismo clientKey → el server devuelve lo grabado, nunca duplica
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

interface PendingPlay {
  result: string;
  /** título del modal cuando difiere de RESULT_LABEL[result] (pseudo-resultados) */
  title?: string;
  rows: AdvanceRow[];
  isMid: boolean;
  /** llave de idempotencia de esta intención de jugada */
  ck?: string;
  requireError?: boolean;
  notationHint?: string;
  askTraj?: boolean;
  /** hit: la notación es la zona del batazo — una sola posición */
  zoneOnly?: boolean;
  /** batazo en juego: muestra el spray sheet si la liga lo tiene activo */
  spray?: boolean;
  /** notación sugerida por voz/IA — prellena el campo en AdvanceModal */
  preNotation?: string;
  /** "atrapado estirando" sobre un hit: bases donde el bateador puede caer out */
  traps?: AdvanceTo[];
  /** metadatos IA a persistir en el evento */
  aiVoice?: string;
  aiJson?: string;
  aiVideo?: string;
}

export default function ScorePage() {
  const { id } = useParams();
  const [game, setGame] = useState<Game | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [pending, setPending] = useState<PendingPlay | null>(null);
  const [showSub, setShowSub] = useState(false);
  const [subPlayerId, setSubPlayerId] = useState<string | null>(null); // entrante dicho por voz
  const [voiceSubText, setVoiceSubText] = useState('');               // texto hablado con el modal abierto
  const [subConfirm, setSubConfirm] = useState(0);                    // «confirmar» hablado en el modal
  const [voiceNotation, setVoiceNotation] = useState('');             // notación dictada con el modal abierto
  const [voiceAdvances, setVoiceAdvances] = useState<{ key: number; list: { playerId: string; to: AdvanceTo }[] } | null>(null); // avances dictados con el modal abierto
  const [subInitial, setSubInitial] = useState<'SUB' | 'PC' | 'RL' | 'CR' | undefined>(undefined);
  const [confirmSignal, setConfirmSignal] = useState(0); // comando de voz "confirmar"
  const [showSummary, setShowSummary] = useState(false);
  const [showFinish, setShowFinish] = useState(false);
  const autoFinish = useRef(false);
  const [now, setNow] = useState(Date.now());
  const [pickGroup, setPickGroup] = useState<'hit' | 'out' | 'base' | null>(null);
  const [showRunners, setShowRunners] = useState(false); // diamante EN BASE (mover corredores)
  const [errorPhase, setErrorPhase] = useState<{ result: string; advances: Advance[]; hitNotation: string | null; ck?: string; spray?: { dir: number; dist: number } } | null>(null);
  const [errorToken, setErrorToken] = useState('');
  const [extraTo, setExtraTo] = useState<AdvanceTo>(2);
  const [sheetSide, setSheetSide] = useState<'batting' | 'away'>('batting');
  const [pitcherId, setPitcherId] = useState<string>('');
  // equipo defensor al que pertenece el pitcher elegido — al cambiar la mitad
  // (TOP↔BOTTOM) el pitcher anterior es del otro equipo y hay que re-resolver
  const pitcherTeam = useRef<string>('');
  const [queued, setQueued] = useState(pendingCount());
  const [showQueue, setShowQueue] = useState(false);         // modal de la cola offline
  const [syncing, setSyncing] = useState(false);           // resincronizando con el server
  const [msg, setMsg] = useState('');
  // menú Especial (estilo BallScore): terminar entrada, ajustar corredores/outs, cambiar lados
  const [showSpecial, setShowSpecial] = useState(false);
  const [showAdjust, setShowAdjust] = useState(false);
  const [adjOuts, setAdjOuts] = useState(0);
  const [adjBases, setAdjBases] = useState<[string, string, string]>(['', '', '']);
  const [cardPlayerId, setCardPlayerId] = useState<string | null>(null);
  // editor "Defensa actual": posición → playerId del equipo que defiende
  const [showDefense, setShowDefense] = useState(false);
  const [defMap, setDefMap] = useState<Record<string, string>>({});
  const [euPitcher, setEuPitcher] = useState(''); // pitcher al que se le alterna merecida/inmerecida
  const [showLeft, setShowLeft] = useState(false); // jugador que salió del estadio → auto-out
  const [showUndoLog, setShowUndoLog] = useState(false); // modal: borrar desde una jugada
  const [showConsulta, setShowConsulta] = useState(false); // Shift+I: bateador vs lanzador
  // anotar sin lineup: el orden se arma bateador a bateador. luMode[teamId]:
  // 'open' = se está armando (agregando jugadores al llegar su turno);
  // 'closed' = el orden ya dio la vuelta (wrap normal). Persistente por juego.
  const [luMode, setLuMode] = useState<Record<string, 'open' | 'closed'>>(() => {
    try { return JSON.parse(localStorage.getItem(`pox-lu-${id}`) ?? '{}'); } catch { return {}; }
  });
  const setLuTeam = (teamId: string, mode: 'open' | 'closed') =>
    setLuMode((m) => {
      const n = { ...m, [teamId]: mode };
      localStorage.setItem(`pox-lu-${id}`, JSON.stringify(n));
      return n;
    });
  const [showBatterPick, setShowBatterPick] = useState(false);
  const [pickMode, setPickMode] = useState<'bat' | 'field'>('bat');
  const [showKeys, setShowKeys] = useState(false); // ⌨ / ? — lista de atajos
  const [sheetMenu, setSheetMenu] = useState<{ x: number; y: number; ev: GameEvent } | null>(null); // clic derecho en casilla
  // corrección quirúrgica: edita UNA jugada ya grabada (avances/resultado/notación)
  const [editPlay, setEditPlay] = useState<{ ev: GameEvent; rows: AdvanceRow[] } | null>(null);
  const [editResult, setEditResult] = useState('');
  // clic derecho en la CELDA (fondo, no sobre una jugada): "Limpiar celda completa"
  const [cellMenu, setCellMenu] = useState<{ x: number; y: number; side: 'away' | 'home'; slot: number; col: number } | null>(null);
  // Alt+clic izquierdo en una casilla: "Anotar en esta casilla" — elige resultado,
  // confirma avances y la jugada se inserta en su lugar cronológico (beforeSeq)
  const [insertCell, setInsertCell] = useState<{ side: 'away' | 'home'; slot: number; col: number } | null>(null);
  const [insertTarget, setInsertTarget] = useState<{ batterId: string; pitcherId?: string; inning: number; half: 'TOP' | 'BOTTOM'; beforeSeq?: number } | null>(null);
  const [insertPlay, setInsertPlay] = useState<PendingPlay | null>(null);
  // "al vuelo": transcribir la hoja completa de UN equipo sin alternar mitades
  // (las jugadas se graban con inning/half explícitos — para compilar fuera del estadio)
  const [fly, setFly] = useState<null | { teamId: string; half: 'TOP' | 'BOTTOM'; inning: number }>(null);
  const [showFly, setShowFly] = useState(false);
  const [flyTeamId, setFlyTeamId] = useState(''); // equipo elegido en el modal de entrada al modo
  const [flyInning, setFlyInning] = useState(1);
  // ── módulos IA ──
  const [showVoice, setShowVoice] = useState(false);       // 🎤 anotar por voz
  const [narration, setNarration] = useState('');          // 🗣 narración de la última jugada
  const [ttsOn, setTtsOn] = useState(() => localStorage.getItem('pox-tts') === '1');
  // panel de audio (🎤 Voz + mic en vivo): se apaga para anotación táctil sin interferencias
  const [audioPanel, setAudioPanel] = useState(() => localStorage.getItem('pox-audio') !== '0');
  const [showInsights, setShowInsights] = useState(false); // 📊 stats en vivo
  const [insights, setInsights] = useState<Awaited<ReturnType<typeof api.aiInsights>> | null>(null);
  const [videoBusy, setVideoBusy] = useState(false);       // 📹 análisis de video (mock/MVP)

  const lastLoadAt = useRef(0);
  const load = async () => {
    if (!id) return;
    const g = await api.game(id);
    lastLoadAt.current = Date.now();
    setGame(g);
    setState(g.state ?? null);
    setEvents(g.events ?? []);
  };
  useEffect(() => { load().catch((e) => setMsg(e.message)); }, [id]);
  // recarga al volver a la pestaña: si el lineup se creó/editó fuera de esta
  // vista (GamePage, otra PC, el celular del manager) la copia en memoria queda
  // vieja — antes había que salir a liga y reentrar para que "apareciera"
  useEffect(() => {
    if (!id) return;
    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastLoadAt.current < 3000) return;
      load().catch(() => {});
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    const onOnline = () => flushQueue().then(() => setQueued(pendingCount()));
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);
  // reloj de juego: corre desde startedAt hasta endedAt; congelado si suspendido
  // o si el anotador lo pausó (pausedAt) — las pausas se descuentan con pauseSecs
  useEffect(() => {
    if (!game?.startedAt || game.endedAt || game.status === 'SUSPENDED' || game.pausedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [game?.startedAt, game?.endedAt, game?.status, game?.pausedAt]);

  // ⏱ auto-pausa del reloj: al cerrar/ocultar la app el reloj se detiene
  // (pausedAuto=true) y al volver se reanuda SOLO si la pausa fue automática —
  // una pausa manual del anotador (lluvia) jamás se quita sola.
  const gameRef = useRef(game);
  gameRef.current = game;
  useEffect(() => {
    if (!id) return;
    const tok = () => getToken();
    const pauseAuto = () => {
      const g = gameRef.current;
      if (g?.status !== 'LIVE' || g.pausedAt || !g.startedAt) return;
      void fetch(`/api/games/${id}/pause`, {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json', ...(tok() ? { Authorization: `Bearer ${tok()}` } : {}) },
        body: JSON.stringify({ auto: true }),
      }).catch(() => {});
    };
    const resumeAuto = async () => {
      const g = gameRef.current;
      if (g?.pausedAt && g.pausedAuto && g.status === 'LIVE') {
        try { setGame(await api.pauseGame(id, false)); } catch { /* offline: reintenta en el próximo evento */ }
      }
    };
    const onVis = () => { document.visibilityState === 'hidden' ? pauseAuto() : void resumeAuto(); };
    window.addEventListener('pagehide', pauseAuto);
    document.addEventListener('visibilitychange', onVis);
    void resumeAuto(); // al entrar a anotar: descongela una auto-pausa previa
    // por si OTRO anotador cerró su vista: chequeo periódico mientras estoy visible
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void resumeAuto(); }, 15000);
    return () => {
      window.removeEventListener('pagehide', pauseAuto);
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(poll);
    };
  }, [id]);

  // 🚫 una sola pestaña anotando este juego: dos ventanas anotando el mismo
  // juego duplican jugadas y pelean el reloj. La última pestaña en abrirse
  // o reclamar manda; la anterior queda bloqueada hasta recuperar el control.
  const tabId = useMemo(() => Math.random().toString(36).slice(2), []);
  const [taken, setTaken] = useState(false);
  const scoreChan = useRef<BroadcastChannel | null>(null);
  const claimScore = () => scoreChan.current?.postMessage({ type: 'claim', tab: tabId });
  useEffect(() => {
    if (!id || typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(`poxscore-score-${id}`);
    scoreChan.current = ch;
    ch.onmessage = (e) => {
      if (e.data?.type === 'claim' && e.data.tab !== tabId) setTaken(true);
    };
    ch.postMessage({ type: 'claim', tab: tabId });
    return () => { scoreChan.current = null; ch.close(); };
  }, [id]);

  // 🔄 resincronizar: vacía la cola pendiente y recarga juego/estado del server
  const resync = async () => {
    setSyncing(true); setMsg('Sincronizando…');
    try {
      const sent = await flushQueue();
      setQueued(pendingCount());
      await load();
      setMsg(sent ? `✓ Sincronizado — ${sent} jugada(s) subidas` : '✓ Sincronizado');
    } catch (e) { setMsg((e as Error).message); }
    finally { setSyncing(false); }
  };

  // fin automático: cuando el motor marca FINAL por las entradas del juego,
  // se abre sola la pantalla de decisiones (una vez)
  useEffect(() => {
    if (state?.status === 'FINAL' && !game?.seasonApplied && !autoFinish.current && !fly) {
      autoFinish.current = true;
      setShowFinish(true);
    }
  }, [state?.status, game?.seasonApplied]);

  // Shift+L: resumen rápido del juego (estilo BallScore)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;
      if (e.shiftKey && e.key.toLowerCase() === 'l') setShowSummary((s) => !s);
      if (e.shiftKey && e.key.toLowerCase() === 'i') setShowConsulta((s) => !s);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const players = useMemo(() => {
    const m = new Map<string, Player>();
    for (const p of [...(game?.awayTeam?.players ?? []), ...(game?.homeTeam?.players ?? [])]) m.set(p.id, p);
    for (const l of game?.lineups ?? []) if (l.player) m.set(l.player.id, l.player);
    return m;
  }, [game]);

  const labelOf = (pid: string | null | undefined) => {
    if (!pid) return '—';
    const p = players.get(pid);
    return p ? `${p.number ? `#${p.number} ` : ''}${p.firstName[0]}. ${p.lastName}` : '?';
  };
  const fullNameOf = (pid: string | null | undefined) => {
    const p = pid ? players.get(pid) : undefined;
    return p ? `${p.number ? `#${p.number} ` : ''}${p.firstName} ${p.lastName}` : '?';
  };
  // corredores en el diamante: "#22 Reyes" (número + apellido, como se grita en el dugout)
  const labels = useMemo(
    () => Object.fromEntries([...players.values()].map((p) => [p.id, `${p.number ? `#${p.number} ` : ''}${p.lastName}`])),
    [players],
  );

  // lineup de bateo: activos que sí batean (excluye lanzadores "solo lanza")
  const battingOf = (teamId: string) =>
    (game?.lineups ?? []).filter((l) => l.teamId === teamId && l.active && l.batsInOrder !== false && l.order < 50)
      .sort((a, b) => a.order - b.order);
  // lineup defensivo: todos los activos (incluye el P que no batea)
  const fieldingOf = (teamId: string) =>
    (game?.lineups ?? []).filter((l) => l.teamId === teamId && l.active)
      .sort((a, b) => a.order - b.order);

  // ---- modo "al vuelo": la mitad la decide el modo, no la progresión interna ----
  const effHalf: 'TOP' | 'BOTTOM' | undefined = fly?.half ?? state?.half;
  // estado de la media entrada al vuelo: replay solo de SUS jugadas en la entrada actual
  // (outs/bases/corredores reales de esa hoja — la progresión global no aplica)
  const flyEvents = useMemo(
    () => (fly ? events.filter((e) => e.half === fly.half && e.inning === fly.inning) : []),
    [fly, events],
  );
  const flySt = useMemo(() => {
    let s = initialState();
    for (const e of flyEvents) s = applyEvent(s, e, 99);
    return s;
  }, [flyEvents]);
  const flyOutsDone = flyEvents.reduce((n, e) => n + e.advances.filter((a) => a.to === 'OUT').length, 0);
  const flyDone = fly ? flyOutsDone >= 3 || flyEvents.some((e) => e.result === 'EI') : false;
  // turnos cerrados del equipo al vuelo en TODO el juego → su siguiente lugar en el orden
  // (sobrevive a undo, a cambiar de equipo y a recargar la página)
  const flyPaCount = useMemo(
    () => (fly ? events.filter((e) => e.half === fly.half && (!isMidResult(e.result) || e.result === 'SK')).length : 0),
    [fly, events],
  );
  // estado efectivo: en al vuelo sustituye bases/outs/posición por los de esa media entrada
  const effState: GameState | null = fly && state
    ? { ...state, inning: fly.inning, half: fly.half, outs: flyOutsDone, bases: flySt.bases }
    : state;

  // primera entrada donde la mitad aún no tiene 3 outs/EI — sugerencia al elegir equipo
  const suggestInning = (half: 'TOP' | 'BOTTOM') => {
    let i = 1;
    for (;;) {
      const evs = events.filter((e) => e.half === half && e.inning === i);
      const done = evs.some((e) => e.result === 'EI')
        || evs.reduce((n, e) => n + e.advances.filter((a) => a.to === 'OUT').length, 0) >= 3;
      if (!done) return i;
      i++;
    }
  };
  const openFly = () => {
    const tid = flyTeamId || game?.awayTeamId || '';
    setFlyTeamId(tid);
    setFlyInning(suggestInning(tid === game?.awayTeamId ? 'TOP' : 'BOTTOM'));
    setShowFly(true);
  };

  const battingTeamId = effHalf === 'TOP' ? game?.awayTeamId : game?.homeTeamId;
  const fieldingTeamId = effHalf === 'TOP' ? game?.homeTeamId : game?.awayTeamId;
  const battingLineup = battingTeamId ? battingOf(battingTeamId) : [];

  // envío de jugadas: en modo "al vuelo" la jugada lleva inning/half explícitos
  // de la hoja que se está transcribiendo (el server los usa en vez de derivarlos)
  const sendEvent = (payload: Parameters<typeof api.addEvent>[1]) =>
    api.addEvent(id!, fly ? { ...payload, inning: fly.inning, half: fly.half } : payload);
  const fieldingLineup = fieldingTeamId ? fieldingOf(fieldingTeamId) : [];
  // aviso suave: el equipo defensor no tiene posiciones asignadas — no bloquea
  // la anotación, pero sin posiciones no se pueden resolver E/PO/A por guante
  const defenseMissing = !!fieldingTeamId && fieldingLineup.length > 0
    && !fieldingLineup.some((l) => FIELD_POSITIONS.includes(l.position));
  const [defWarned, setDefWarned] = useState<Set<string>>(new Set());
  const defWarnKey = `${id}:${fieldingTeamId}`;
  // lanzadores disponibles: todo el roster del equipo defensor + lineup (incluye relevistas que no batean)
  const fieldingRoster = fieldingTeamId === game?.awayTeamId ? (game?.awayTeam?.players ?? []) : (game?.homeTeam?.players ?? []);
  const pitcherOptions = useMemo(() => {
    const m = new Map<string, { id: string; label: string; tag?: string }>();
    for (const p of fieldingRoster) m.set(p.id, { id: p.id, label: labelOf(p.id), tag: 'roster' });
    for (const l of fieldingLineup) m.set(l.playerId, { id: l.playerId, label: labelOf(l.playerId), tag: l.position });
    return [...m.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldingRoster, fieldingLineup, players]);
  const batterIndex = fly ? flyPaCount : (state ? (state.half === 'TOP' ? state.awayBatterIndex : state.homeBatterIndex) : 0);
  // "sin lineup": mientras el orden se arma, el turno NO gira solo — cuando el
  // índice alcanza el largo de la lista el próximo bateador hay que agregarlo.
  // Solo cuando el orden da la vuelta (luClosed) vuelve el wrap normal.
  const battingOpen = battingTeamId ? luMode[battingTeamId] === 'open' : false;

  // casilla (order-1) de cada jugador — por ORDER, la misma fuente que la
  // columna de nombres de la planilla y las estadísticas. Para jugadores con
  // varias entradas (SUB/OUT/REIN) se elige la que estaba activa EN la posición
  // del evento (subInInning/subInHalf acotan la época de cada entrada).
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

  // El próximo bateador se resuelve por ORDER, no por conteo de turnos: el
  // último turno cerrado deja su casilla y quien sigue en el orden es el que
  // batea. Así un jugador insertado en un slot vacío a mitad de juego HEREDA
  // el turno de ese slot, y una reordenación (Alt-arrastre) no salta ni
  // duplica bateadores. Sin referencia de orden cae al conteo clásico.
  const lastTurnEv = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.half === effHalf && e.batterId && (!isMidResult(e.result as PlayResult) || e.result === 'SK')) return e;
    }
    return null;
  }, [events, effHalf]);
  const lastOrder = lastTurnEv?.batterId && battingTeamId
    ? (battingLineup.find((l) => l.playerId === lastTurnEv.batterId)?.order
       ?? ((orderSlotOf(battingTeamId)(lastTurnEv.batterId, lastTurnEv.inning, lastTurnEv.half) ?? -1) + 1 || undefined))
    : undefined;
  const resolved = battingLineup.length
    ? (lastOrder != null
        ? (battingLineup.find((l) => l.order > lastOrder) ?? (battingOpen ? null : battingLineup[0]))
        : (battingOpen && batterIndex >= battingLineup.length ? null : (battingLineup[batterIndex % battingLineup.length] ?? null)))
    : null;
  const needBatter = battingLineup.length === 0 || !resolved;
  const batter = resolved;
  const nextBatter = batter
    ? (battingLineup.find((l) => l.order > batter.order) ?? (battingOpen ? null : battingLineup[0]))
    : null;

  // lanzador activo por equipo defensor — se deriva del STREAM DE EVENTOS:
  // el último PC (cambio de lanzador) grabado para ese equipo. Persiste entre
  // innings y recargas de página porque vive en la fuente de verdad, no en
  // estado de React. Sin PC → el pitcher P de la alineación.
  const pitcherByEvents = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) {
      if (e.result !== 'PC' || !e.pitcherId) continue;
      const defTeam = e.half === 'TOP' ? game?.homeTeamId : game?.awayTeamId;
      if (defTeam) m.set(defTeam, e.pitcherId);
    }
    return m;
  }, [events, game?.homeTeamId, game?.awayTeamId]);

  // pitcher por defecto: último PC del equipo que defiende; si no, quien tenga
  // posición P en la alineación. Al cambiar de mitad el pitcher guardado es del
  // equipo contrario → re-resolver. El relevista ya NO se pierde al cerrar la entrada.
  useEffect(() => {
    if (!fieldingTeamId) return;
    if (!pitcherId || pitcherTeam.current !== fieldingTeamId) {
      const p = pitcherByEvents.get(fieldingTeamId)
        ?? (fieldingLineup.find((l) => l.position === 'P') ?? fieldingLineup[0])?.playerId;
      if (p) { setPitcherId(p); pitcherTeam.current = fieldingTeamId; }
    }
  }, [fieldingLineup, fieldingTeamId, pitcherId, pitcherByEvents]);

  const baseRunners = effState ? [effState.bases[1], effState.bases[2], effState.bases[3]].filter(Boolean) : [];

  // Planillas por equipo + linescore por entrada (recalculado de los eventos)
  const sheets = useMemo(() => ({
    away: buildSheet(events, battingOf(game?.awayTeamId ?? '').length || 9, 'away', game?.innings ?? 9, game?.awayTeamId ? orderSlotOf(game.awayTeamId) : undefined),
    home: buildSheet(events, battingOf(game?.homeTeamId ?? '').length || 9, 'home', game?.innings ?? 9, game?.homeTeamId ? orderSlotOf(game.homeTeamId) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [events, game?.lineups, game?.innings, game?.ghostRunner, orderSlotOf]);

  const { awayLine, homeLine, lineLen } = useMemo(() => {
    const away: number[] = [], home: number[] = [];
    for (const ev of events) {
      const runs = ev.advances.filter((a) => a.to === 'HOME').length;
      const arr = ev.half === 'TOP' ? away : home;
      while (arr.length < ev.inning) arr.push(0);
      arr[ev.inning - 1] += runs;
    }
    return { awayLine: away, homeLine: home, lineLen: Math.max(away.length, home.length) };
  }, [events]);

  // errores por equipo defensor: TOP = defiende el home, BOTTOM = el away.
  // Cuenta como el tally: errorOn resuelto → E# en la notación → resultado
  // que ES error — un fildeador sin posición no deja invisible el E
  const errLine = useMemo(() => {
    const e = { away: 0, home: 0 };
    for (const ev of events) {
      // tolerante: eventos recién anotados pueden traer errorOn como string JSON
      const n = Math.max(
        Array.isArray(ev.errorOn) ? ev.errorOn.length
          : typeof ev.errorOn === 'string' ? (JSON.parse(ev.errorOn) as string[]).length : 0,
        ev.notation?.match(/E-?\d/g)?.length ?? 0,
        ERROR_RESULTS.has(ev.result) ? 1 : 0,
      );
      if (n) e[ev.half === 'TOP' ? 'home' : 'away'] += n;
    }
    return e;
  }, [events]);

  // stats en vivo: panel del bateador y del lanzador (estilo BallScore)
  const box = useMemo(() => computeBoxscore(events, game?.innings ?? 9), [events, game?.innings, game?.ghostRunner]);
  // pie de planilla: carreras/hits/dejados por entrada
  const tallies = useMemo(() => computeInningTallies(events, game?.innings ?? 9), [events, game?.innings]);

  // ── resumen al cerrar la media entrada (y resumen final) ──
  // Salta cuando el estado derivado cambia de mitad/entrada → repasa los
  // números de la media que acaba de terminar + score + próximos bateadores.
  const [innSummary, setInnSummary] = useState<null | {
    title: string; tally?: InningTally; score: string;
    next?: string[]; finalTotals?: { away: InningTally; home: InningTally };
  }>(null);
  const prevPhase = useRef<{ inning: number; half: string; status: string } | null>(null);
  useEffect(() => {
    const s = state;
    if (!s || !game) { prevPhase.current = null; return; }
    const p = prevPhase.current;
    prevPhase.current = { inning: s.inning, half: s.half, status: s.status };
    if (!p || fly) return; // primera carga / modo al vuelo: solo marca fase
    if (p.inning === s.inning && p.half === s.half && p.status === s.status) return;

    const scoreTxt = `${game.awayTeam?.shortName ?? 'VIS'} ${s.score.away} — ${s.score.home} ${game.homeTeam?.shortName ?? 'LOC'}`;
    const next3 = (side: 'away' | 'home') => {
      const lu = battingOf(side === 'away' ? game.awayTeamId : game.homeTeamId);
      const bi = side === 'away' ? s.awayBatterIndex : s.homeBatterIndex;
      return lu.length ? [0, 1, 2].map((i) => labelOf(lu[(bi + i) % lu.length].playerId)) : [];
    };

    if (s.status === 'FINAL' && p.status !== 'FINAL') {
      // resumen final: si la última jugada cerró una media, súmala; y totales del juego
      const zero = { r: 0, h: 0, e: 0, lob: 0 };
      const tot = (arr: InningTally[]) => arr.reduce((a, t) => ({ r: a.r + t.r, h: a.h + t.h, e: a.e + t.e, lob: a.lob + t.lob }), { ...zero });
      setInnSummary({
        title: '🔚 Final del juego', score: scoreTxt,
        finalTotals: { away: tot(tallies.away), home: tot(tallies.home) },
      });
      return;
    }
    if (p.half === 'TOP' && s.half === 'BOTTOM') {
      setInnSummary({
        title: `Fin de la alta del ${p.inning}º — ${game.awayTeam?.shortName ?? 'Visitante'}`,
        tally: tallies.away[p.inning - 1], score: scoreTxt, next: next3('home'),
      });
    } else if (s.inning > p.inning) {
      setInnSummary({
        title: `Fin de la baja del ${p.inning}º — ${game.homeTeam?.shortName ?? 'Local'}`,
        tally: tallies.home[p.inning - 1], score: scoreTxt, next: next3('away'),
      });
    }
  }, [state, events]); // eslint-disable-line react-hooks/exhaustive-deps
  const batterSide = effHalf === 'TOP' ? 'away' : 'home';
  const batterLine = batter ? box[batterSide][batter.playerId] : undefined;
  const batterPlays = useMemo(
    () => events.filter((e) => e.batterId === batter?.playerId && !isMidResult(e.result)).map((e) => {
      // color por lo que pasó en el turno (misma paleta que los avances del
      // mini-diamante): verde = embasó, rojo = out, ámbar = error en la jugada
      const bAdv = e.advances?.find((a) => a.playerId === e.batterId)?.to;
      const cls = bAdv === 'OUT' ? 'out'
        : HIT_TURNS.has(e.result) ? 'hit'
        : ERROR_RESULTS.has(e.result) || (e.errorOn?.length ?? 0) > 0 || /E-?\d/.test(e.notation ?? '') ? 'err'
        : OUT_TURNS.has(e.result) ? 'out'
        : bAdv != null ? 'hit'
        : 'misc';
      return { label: e.notation ?? e.result, cls };
    }),
    [events, batter?.playerId],
  );
  const pitcherLine = pitcherId ? box.pitchers[pitcherId] : undefined;
  // temporada acumulada por jugador (se fusiona con la línea del juego en vivo)
  const [seasonMap, setSeasonMap] = useState<Map<string, SeasonStat>>(new Map());
  const seasonFetched = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const pid of [batter?.playerId, pitcherId]) {
      if (!pid || seasonFetched.current.has(pid) || !id) continue;
      seasonFetched.current.add(pid);
      api.gameCard(id, pid).then((c) => {
        // la fila debe ser de la fase del juego: en playoff el acumulado POST,
        // nunca el REG (si no, la post sumaría sobre los números de la regular)
        const scope = c.scope ?? 'REG';
        const rows = (c.seasons ?? []).filter((s) => (s.scope ?? 'REG') === scope);
        // playoff: solo la fila de ESTE año (la post de otro año no es esta post);
        // regular: la del año del juego o la última REG (ligas sin Season)
        const latest = rows.find((s) => s.season === c.seasonYear)
          ?? (scope === 'REG' ? rows[rows.length - 1] : undefined)
          ?? null;
        if (latest) setSeasonMap((m) => new Map(m).set(pid, latest));
      }).catch(() => {});
    }
  }, [batter?.playerId, pitcherId, id]);
  const batterSeason = batter ? seasonMap.get(batter.playerId) : undefined;
  const pitcherSeason = pitcherId ? seasonMap.get(pitcherId) : undefined;
  // temporada + juego en vivo — visible aunque el bateador aún no cierre turno
  // (TEMP arranca en ceros si el jugador no tiene temporada acumulada)
  const batTot = useMemo(() => (!batter ? null : {
    ab: (batterSeason?.ab ?? 0) + (batterLine?.ab ?? 0), r: (batterSeason?.r ?? 0) + (batterLine?.r ?? 0),
    h: (batterSeason?.h ?? 0) + (batterLine?.h ?? 0), hr: (batterSeason?.hr ?? 0) + (batterLine?.hr ?? 0),
    rbi: (batterSeason?.rbi ?? 0) + (batterLine?.rbi ?? 0), bb: (batterSeason?.bb ?? 0) + (batterLine?.bb ?? 0),
    k: (batterSeason?.k ?? 0) + (batterLine?.k ?? 0), sb: (batterSeason?.sb ?? 0) + (batterLine?.sb ?? 0),
  }), [batter, batterSeason, batterLine]);
  const pitTot = useMemo(() => {
    if (!pitcherSeason) return null;
    const outs = pitcherSeason.pOuts + (pitcherLine?.outs ?? 0);
    const er = pitcherSeason.pER + (pitcherLine?.er ?? 0);
    return {
      outs, er, era: outs ? er * (game?.innings ?? 9) * 3 / outs : 0,
      h: pitcherSeason.pH + (pitcherLine?.h ?? 0), r: pitcherSeason.pR + (pitcherLine?.r ?? 0),
      bb: pitcherSeason.pBB + (pitcherLine?.bb ?? 0), k: pitcherSeason.pK + (pitcherLine?.k ?? 0),
      hr: pitcherSeason.pHR + (pitcherLine?.hr ?? 0),
      wl: `${pitcherSeason.w}-${pitcherSeason.l}`, sv: pitcherSeason.sv,
    };
  }, [pitcherSeason, pitcherLine, game?.innings]);
  const pitcherBF = useMemo(
    () => events.filter((e) => e.pitcherId === pitcherId && !isMidResult(e.result)).length,
    [events, pitcherId],
  );

  // conteo B-S del turno en curso: mid-events del bateador actual desde su último turno cerrado
  const count = useMemo(() => {
    let b = 0, s = 0;
    for (const e of events) {
      if (!isMidResult(e.result)) { b = 0; s = 0; continue; } // turno cerrado → conteo nuevo
      if (e.batterId !== batter?.playerId) continue;
      if (e.result === 'B' || e.result === 'IPL') b += 1;
      else if (e.result === 'S') s = Math.min(3, s + 1);
      else if ((e.result === 'F' || e.result === 'EF') && s < 2) s += 1; // foul cuenta strike solo si <2
    }
    return { b, s };
  }, [events, batter?.playerId]);

  // zona del pitcheo (opcional): tocar una celda del mapa y luego B/S/F → queda en notation "Zrc"
  const [pitchZone, setPitchZone] = useState<{ r: number; c: number } | null>(null);

  // lanzamiento individual: B/S/F como evento (conteo real del turno y pitcheos del lanzador)
  const pitch = async (result: 'B' | 'S' | 'F') => {
    if (!id || !batter || finished || flyDone) return;
    // conteo lleno → abrir directo la jugada terminal (4 bolas = BB, 3er strike = K)
    if (result === 'B' && count.b >= 3) { openPlay('BB'); return; }
    if (result === 'S' && count.s >= 2) { openPlay('K'); return; }
    try {
      const res = await sendEvent( {
        batterId: batter.playerId, pitcherId: pitcherId || undefined,
        result, notation: pitchZone ? `Z${pitchZone.r}${pitchZone.c}` : undefined, advances: [],
        // misma entrada+turno+conteo = el mismo lanzamiento: el doble toque de
        // B/S/F graba una sola vez; el siguiente pitcheo legítimo cambia el conteo
        clientKey: `p-${result}-${state?.inning}${state?.half}-${batterIndex}-${count.b}${count.s}`,
      });
      setPitchZone(null);
      setState(res.state);
      setEvents((prev) => (prev.some((e) => e.seq === res.event.seq) ? prev : [...prev, res.event]));
      setQueued(pendingCount());
    } catch {
      setMsg('Sin conexión: jugada en cola');
      setQueued(pendingCount());
      load();
    }
  };

  const openPlay = (result: string, ai?: { preNotation?: string | null; voice?: string; json?: string; video?: string; preAdvances?: { playerId: string; to: number | 'HOME' | 'OUT' }[] }) => {
    if (!effState || flyDone) return;
    const isMid = (MID_BUTTONS as readonly string[]).includes(result);
    const rows: AdvanceRow[] = [];
    // pseudo-resultados: 1BI→1B (hit de cuadro), FCT→FC (forzado: corredor out)
    const real = (PSEUDO[result] ?? result) as string;
    // avances que la voz ya entendió por nombre ("virgilio pinales a tercera") — prevalecen sobre el default
    const said = new Map((ai?.preAdvances ?? []).map((a) => [a.playerId, a.to as AdvanceTo]));
    const saidOr = (pid: string, def: AdvanceTo) => said.get(pid) ?? def;

    if (!isMid && batter) {
      // híbridos: la 1ª fase marca el hit puro (1BE se anota como 1B, el error va en la 2ª fase)
      const defResult = HYBRID[real]?.hitCode ?? (real as PAResult);
      const defs = defaultAdvances(effState, batter.playerId, defResult);
      // FCT (forzado): el compañero forzado más adelantado sale OUT por defecto —
      // el clásico 6-4/4-6 en 2ª (o a 3ª/home si están más llenas las bases).
      // Con 2 outs ese out es el 3ro: ningún otro corredor avanza ni anota por defecto.
      if (result === 'FCT') {
        const forced = effState.bases[1] ?? effState.bases[2] ?? effState.bases[3];
        if (forced) {
          const d = defs.find((x) => x.playerId === forced);
          if (d) d.to = 'OUT';
          if (effState.outs >= 2) {
            for (const [b, pid] of [[1, effState.bases[1]], [2, effState.bases[2]], [3, effState.bases[3]]] as const) {
              if (pid && pid !== forced) {
                const x = defs.find((a) => a.playerId === pid);
                if (x) x.to = b;
              }
            }
          }
        }
      }
      const defOf = (pid: string) => defs.find((d) => d.playerId === pid)?.to;
      rows.push({
        playerId: batter.playerId,
        label: `${labelOf(batter.playerId)} (bateador)`,
        from: 'Home',
        options: [1, 2, 3, 'HOME', 'OUT'],
        initial: saidOr(batter.playerId, defOf(batter.playerId) ?? 'OUT'),
      });
      for (const [b, pid] of [[1, effState.bases[1]], [2, effState.bases[2]], [3, effState.bases[3]]] as const) {
        if (pid) rows.push({
          playerId: pid, label: labelOf(pid), from: `En ${b}ª`,
          options: [1, 2, 3, 'HOME', 'OUT'] as AdvanceTo[],
          initial: saidOr(pid, defOf(pid) ?? (b as AdvanceTo)),
        });
      }
    } else {
      // jugada de corredores: cada corredor decide
      for (const [b, pid] of [[1, effState.bases[1]], [2, effState.bases[2]], [3, effState.bases[3]]] as const) {
        if (pid) rows.push({
          playerId: pid, label: labelOf(pid), from: `En ${b}ª`,
          options: [1, 2, 3, 'HOME', 'OUT'] as AdvanceTo[],
          // lanzamiento ilegal (softball): bola + todos avanzan una base por regla
          initial: saidOr(pid, result === 'IPL' ? (b === 3 ? 'HOME' : ((b + 1) as AdvanceTo)) : (b as AdvanceTo)),
        });
      }
    }
    // hits: la notación sirve para localizar el batazo (spray chart)
    // RHB también es hit (sencillo al bateador + out del corredor golpeado)
    const isHit = ['1B', '2B', '3B', 'HR', '1BE', '2BE', '3BE', 'RHB'].includes(real);
    // trayectoria: solo donde el resultado no la implica (GO/FO/LO ya dicen rola/elevado/línea)
    const askTraj = ['1B', '2B', '3B', 'HR', '1BE', '2BE', '3BE', 'E', 'FC', 'DP', 'TP', 'RHB'].includes(real);
    // spray sheet: todo batazo en juego (igual que BIP del endpoint /spray)
    const isBip = ['1B', '2B', '3B', 'HR', 'GO', 'FO', 'LO', 'PO', 'DP', 'TP', 'SAC', 'SF', 'E', 'FC', 'IF', 'XF', '1BE', '2BE', '3BE', 'RHB'].includes(real);
    // atrapado estirando: sobre un hit, bases extra donde el bateador puede caer out
    // (sencillo → a 2ª/3ª/home · doble → a 3ª/home · triple → al plato)
    const trapTo: Record<string, AdvanceTo[]> = {
      '1B': [2, 3, 'HOME'], '1BI': [2, 3, 'HOME'],
      '2B': [3, 'HOME'], '3B': ['HOME'],
    };
    setPending({
      result: real,
      title: result !== real ? RESULT_LABEL[result] : undefined,
      rows, isMid,
      // E/EF siempre exigen E#; ADJ solo cuando la voz dijo "error" ("avance por
      // error") — así «confirmar» no graba el avance sin marcar quién erró
      requireError: real === 'E' || real === 'EF'
        || (real === 'ADJ' && (/error|bambalazo|lindon|metida de manos/i.test(ai?.voice ?? '') || /E\d/.test(ai?.preNotation ?? ''))),
      notationHint: real === 'RHB'
        ? '⚾ Bola golpea a corredor (fair) — marca OUT al corredor golpeado; el bateador se embasa con hit'
        : isHit
        ? (result === '1BI' ? 'Infield hit — ¿dónde? (ej. 6 = SS, 5 = 3B)' : '¿Hacia dónde fue el batazo? (ej. 9 = jardín derecho)')
        : result === 'FCT' ? '¿Cómo fue el out? (ej. 4-6 = el 2B tira al SS)' : undefined,
      zoneOnly: isHit, // hit = una sola zona, nunca secuencia 7-7
      spray: isBip,    // spray sheet en el modal (si la liga lo permite)
      ck: uid(),
      askTraj,
      traps: trapTo[result],
      // 1BI: hit de cuadro → la trayectoria ya es rola (G) y el título lo dice
      preNotation: ai?.preNotation ?? (result === '1BI' ? 'G' : undefined),
      aiVoice: ai?.voice, aiJson: ai?.json, aiVideo: ai?.video,
    });
  };

  const confirmPlay = async (advances: Advance[], notation: string | null, spray?: { dir: number; dist: number } | null, resultOverride?: string) => {
    if (!id || !pending) return;
    setVoiceNotation(''); setVoiceAdvances(null);
    // híbrido resuelto en la misma pantalla (chip "⚠ error" del modal):
    // viene '1BE'/'2BE'/'3BE' listo — se graba directo sin 2ª fase
    if (resultOverride) {
      setPending(null);
      try {
        const res = await sendEvent({
          batterId: batter?.playerId,
          pitcherId: pitcherId || undefined,
          result: resultOverride, notation,
          advances, clientKey: pending.ck,
          aiVoice: pending.aiVoice, aiJson: pending.aiJson, aiVideo: pending.aiVideo,
          ...(spray ? { sprayDir: spray.dir, sprayDist: spray.dist } : {}),
        });
        setState(res.state);
        setEvents((prev) => (prev.some((e) => e.seq === res.event.seq) ? prev : [...prev, res.event]));
        setQueued(pendingCount());
      } catch {
        setMsg('Sin conexión: jugada en cola, se sincronizará luego');
        setQueued(pendingCount());
        load();
      }
      return;
    }
    // híbridos: tras confirmar el hit queda la pantalla para marcar el error (E#) y la base extra
    if (HYBRID[pending.result]) {
      // la notación del hit completa ("L9" = línea al RF) viaja a la 2ª fase y
      // queda pegada al token de error → "L9-E5"; el server ignora la zona al
      // repartir PO/A (es dirección de batazo, no fildeador). Se despega cualquier
      // E# que ya viniera escrito (voz/manual) — el error lo pide la 2ª pantalla
      const hitPart = notation?.split('-').filter((t) => !/^E/i.test(t)).join('-');
      setErrorPhase({ result: pending.result, advances, hitNotation: hitPart || null, ck: uid(), spray: spray ?? undefined });
      // la voz ya pudo decir el fildeador ("error del right"→E9) y la base
      // extra ("avanza a segunda"→2ª) — se prellenan en la 2ª pantalla
      setErrorToken(notation?.match(/E-?\d/)?.[0] ?? '');
      const bAdv = advances.find((a) => a.playerId === batter?.playerId)?.to;
      const hitBase = ({ '1BE': 1, '2BE': 2, '3BE': 3 } as Record<string, number>)[pending.result] ?? 1;
      setExtraTo((typeof bAdv === 'number' && bAdv > hitBase) || bAdv === 'HOME' ? bAdv : HYBRID[pending.result].extraTo);
      setPending(null);
      return;
    }
    setPending(null);
    // auto-promoción a DP/TP: bateador out + corredor(es) out
    let result = pending.result;
    if (!pending.isMid && result !== 'DP' && result !== 'TP') {
      const outs = advances.filter((a) => a.to === 'OUT').length;
      if (outs >= 3) result = 'TP';
      else if (outs === 2) result = 'DP';
    }
    // ── validador IA: chequeo de lógica antes de grabar (no bloquea si falla la red)
    try {
      const v = await api.validatePlay(id, { result, advances });
      if (!v.is_valid) {
        const txt = v.errors.map((e) => `⚠ ${e.error}${e.suggestion ? `\n→ ${e.suggestion}` : ''}`).join('\n');
        if (!confirm(`Oye, eso no cuadra:\n\n${txt}\n\n¿Grabar de todos modos?`)) return;
      }
    } catch { /* sin conexión → se graba igual */ }
    try {
      const res = await sendEvent( {
        batterId: batter?.playerId,
        pitcherId: pitcherId || undefined,
        result, notation,
        advances, clientKey: pending.ck,
        aiVoice: pending.aiVoice, aiJson: pending.aiJson, aiVideo: pending.aiVideo,
        ...(spray ? { sprayDir: spray.dir, sprayDist: spray.dist } : {}),
      });
      setState(res.state);
      setEvents((prev) => (prev.some((e) => e.seq === res.event.seq) ? prev : [...prev, res.event])); // la planilla se actualiza sin refresh
      setQueued(pendingCount());
      // ── narrador IA: comenta la jugada en el feed (fire & forget)
      if (!pending.isMid && ['1B','2B','3B','HR','HRIP','K','DP','TP','SF','E'].includes(result)) {
        api.narrate(id).then((n) => {
          if (!n.narration) return;
          setNarration(n.narration);
          setTimeout(() => setNarration(''), 9000);
          if (ttsOn && 'speechSynthesis' in window) {
            const u = new SpeechSynthesisUtterance(n.narration);
            u.lang = 'es-DO';
            speechSynthesis.speak(u);
          }
          setEvents((prev) => prev.map((e) => e.seq === n.seq ? { ...e, aiNarration: n.narration } : e));
        }).catch(() => { /* narración opcional */ });
      }
    } catch {
      setMsg('Sin conexión: jugada en cola, se sincronizará luego');
      setQueued(pendingCount());
      load();
    }
  };

  const undo = async (byVoice = false) => {
    if (!id) return;
    // en al vuelo, deshacer solo toca jugadas de la mitad/entrada que se compila
    const last = events[events.length - 1];
    if (fly && last && (last.half !== fly.half || last.inning !== fly.inning)) {
      alert('⚡ Al vuelo: la última jugada global no pertenece a esta hoja. Corrige desde el boxscore o sal del modo.');
      return;
    }
    if (!byVoice && !confirm('¿Deshacer última jugada?')) return;
    const res = await api.undoEvent(id);
    setState(res.state);
    setEvents((prev) => prev.slice(0, -1));
    load();
  };

  // deshacer DESDE una jugada en adelante (errores de anotación de varias jugadas atrás)
  const undoFrom = async (fromSeq: number) => {
    if (!id) return;
    const n = events.filter((e) => e.seq >= fromSeq).length;
    if (!confirm(`¿Borrar la jugada #${fromSeq} y las ${n - 1} posteriores?\n\nEl juego vuelve al estado anterior a esa jugada.`)) return;
    const res = await api.deleteEventsFrom(id, fromSeq);
    setState(res.state);
    setEvents((prev) => prev.filter((e) => e.seq < fromSeq));
    setShowUndoLog(false);
    load();
  };

  // ── comandos de voz del mic en vivo ──
  // "cambio lanzador X" / "reingresa X": graba el cambio/reingreso como lo hace
  // SubModal (misma lógica: REIN por su slot si salió, siempre evento PC)
  const voicePitcher = async (pid: string, isReentry: boolean, name: string) => {
    if (!id || !effState || !fieldingTeamId) return;
    try {
      if (isReentry) {
        const out = (game?.lineups ?? []).find((l) => l.teamId === fieldingTeamId && l.playerId === pid && !l.active);
        if (out) {
          const occupant = (game?.lineups ?? []).find((l) => l.teamId === fieldingTeamId && l.active && l.order === out.order)
            ?? (game?.lineups ?? []).find((l) => l.teamId === fieldingTeamId && l.active && l.position === 'P');
          if (occupant && occupant.playerId !== pid) {
            await api.substitute(id, { teamId: fieldingTeamId, outPlayerId: occupant.playerId, inPlayerId: pid, position: 'P', subInInning: effState.inning, subInHalf: effState.half });
          }
        }
      }
      await api.addEvent(id, { result: 'PC', pitcherId: pid, advances: [], inning: effState.inning, half: effState.half });
      setPitcherId(pid); pitcherTeam.current = fieldingTeamId;
      setMsg(`🎙 ${isReentry ? '↺ Reingresa a lanzar' : '⚾ Cambio de lanzador'}: ${name}`);
      load();
    } catch (e) { setMsg(`Cambio de lanzador falló: ${(e as Error).message}`); }
  };

  // selector manual de pitcher: elegir otro ES un cambio de lanzador — se graba
  // como evento PC para que sobreviva al cambio de entrada y a la recarga
  // (sin evento, la próxima mitad re-derivaba al abridor otra vez).
  const selectPitcher = async (pid: string) => {
    if (!id || !effState || !fieldingTeamId || !pid || pid === pitcherId) return;
    const resolved = pitcherByEvents.get(fieldingTeamId)
      ?? fieldingLineup.find((l) => l.position === 'P')?.playerId;
    // elegir el que ya está resuelto solo fija el estado local — no graba PC de ruido
    if (pid === resolved) { setPitcherId(pid); pitcherTeam.current = fieldingTeamId; return; }
    // pitcher sin fila de lineup (el selector ofrece todo el roster): ofrecer
    // agregarlo — sin la fila queda "solo en eventos" (no sale en la hoja y la
    // auditoría no podía ni seleccionarlo para corregirlo)
    if (!fieldingLineup.some((l) => l.playerId === pid)
      && window.confirm(`${labelOf(pid)} no está en la alineación — ¿agregarlo como lanzador (SUB)?`)) {
      await api.lineupAdd(id, fieldingTeamId, { playerId: pid, position: 'P' }).catch(() => {});
      load();
    }
    try {
      const res = await api.addEvent(id, { result: 'PC', pitcherId: pid, advances: [], inning: effState.inning, half: effState.half, clientKey: `PC-${pid}-${events.length}` });
      setState(res.state);
      setEvents((prev) => (prev.some((e) => e.seq === res.event.seq) ? prev : [...prev, res.event]));
      setPitcherId(pid); pitcherTeam.current = fieldingTeamId;
    } catch { setMsg('Sin conexión: el cambio de lanzador no quedó grabado'); }
  };

  const voiceCommand = async (cmd: VoiceCmd) => {
    switch (cmd.type) {
      case 'CONFIRM':
        if (showSub) { setSubConfirm((n) => n + 1); setMsg('🎙 «confirmar» — aplicando sustitución'); return; }
        if (errorPhase) { setMsg('🎙 «confirmar» — grabando jugada'); void confirmHybrid(); return; }
        if (pending) { setConfirmSignal((n) => n + 1); setMsg('🎙 «confirmar» — grabando jugada'); }
        else setMsg('🎙 «confirmar» — no hay jugada abierta que confirmar');
        return;
      case 'UNDO':
        // primero descarta lo que está ABIERTO sin confirmar (modal de la jugada
        // en curso) — solo si no hay nada abierto se revierte lo ya anotado.
        // Antes: "línea al 7 de paredes" abierta + «deshacer» borraba el BB ya
        // grabado del bateador anterior en vez de descartar la sugerencia.
        if (showSub) { setShowSub(false); setSubPlayerId(null); setMsg('🎙 «deshacer» — sustitución cancelada'); return; }
        if (showRunners) { setShowRunners(false); setMsg('🎙 «deshacer» — movimiento descartado'); return; }
        if (pickGroup) { setPickGroup(null); setMsg('🎙 «deshacer» — jugada descartada'); return; }
        if (pending) { setPending(null); setVoiceNotation(''); setVoiceAdvances(null); setMsg('🎙 «deshacer» — jugada descartada'); return; }
        if (errorPhase) { setErrorPhase(null); setMsg('🎙 «deshacer» — jugada descartada'); return; }
        setMsg('🎙 «deshacer» — revirtiendo última jugada'); void undo(true); return;
      case 'BACK':
        // «volver» — siempre regresa a la jugada anterior: cierra lo que esté
        // abierto Y revierte la última anotada ("vuelve al turno del que boleó")
        setPickGroup(null); setPending(null); setErrorPhase(null); setVoiceNotation(''); setVoiceAdvances(null); setShowRunners(false);
        setMsg('🎙 «volver» — regresando a la jugada anterior'); void undo(true); return;
      // SUB / CR: bateador emergente / corredor emergente → SubModal en esa pestaña
      case 'SUB':
      case 'CR':
        setSubPlayerId(cmd.playerId ?? null);
        setSubInitial(cmd.type); setShowSub(true);
        setMsg(`🎙 ${cmd.type === 'CR' ? 'Corredor emergente' : 'Bateador emergente'}${cmd.playerName ? `: ${cmd.playerName}` : ''} — elige quién entra`);
        return;
      // PC / RL: sin nombre reconocido abre el modal de sustitución en la pestaña correcta
      case 'PC':
      case 'RL':
        if (!cmd.pitcherId) {
          setSubInitial(cmd.type); setShowSub(true);
          setMsg(`🎙 ${cmd.type === 'RL' ? 'Reingreso' : 'Cambio'} de lanzador — elige quién entra`);
          return;
        }
        await voicePitcher(cmd.pitcherId, cmd.type === 'RL', cmd.pitcherName ?? labelOf(cmd.pitcherId));
        return;
    }
  };

  // contexto que ve el mic en vivo: quién lanza, quién batea, corredores
  const micCtx: MicCtxData = {
    batter: batter ? labelOf(batter.playerId) : undefined,
    pitcher: pitcherId ? labelOf(pitcherId) : undefined,
    bases: ([1, 2, 3] as const)
      .map((b) => ({ base: b, name: effState?.bases[b] ? labelOf(effState.bases[b]) : '' }))
      .filter((r) => r.name) as MicCtxData['bases'],
  };

  // cualquier ventana/modal abierto — el teclado de anotación se apaga y el mic
  // en vivo NO dispara jugadas (el texto crudo lo recibe la ventana por onVoiceText)
  const modalOpen = !!(pending || pickGroup || errorPhase || showSub || showSummary || showFinish || showVoice ||
    showSpecial || showAdjust || cardPlayerId || showDefense || showLeft || showConsulta || showKeys || showUndoLog || showInsights || showRunners || showBatterPick);

  // atajos de teclado de anotación: solo con juego vivo y sin modal abierto.
  // Sin deps → se re-registra en cada render para leer estado fresco.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Escape') {
        if (pickGroup) setPickGroup(null);
        else if (pending) setPending(null);
        else if (errorPhase) setErrorPhase(null);
        else if (showConsulta) setShowConsulta(false);
        else if (showSummary) setShowSummary(false);
        else if (cardPlayerId) setCardPlayerId(null);
        else if (showSub) setShowSub(false);
        else if (showSpecial) setShowSpecial(false);
        else if (showAdjust) setShowAdjust(false);
        else if (showDefense) setShowDefense(false);
        else if (showLeft) setShowLeft(false);
        else if (showKeys) setShowKeys(false);
        else if (showUndoLog) setShowUndoLog(false);
        else if (showVoice) setShowVoice(false);
        else if (showInsights) setShowInsights(false);
        else if (showRunners) setShowRunners(false);
        else if (showBatterPick) setShowBatterPick(false);
        return;
      }
      if (e.key === '?' || e.key === 'F1') { e.preventDefault(); setShowKeys((s) => !s); return; }
      if (modalOpen) return;
      // defensa — tablero de posiciones: disponible siempre que no haya modal (aun sin bateador al bate)
      if (e.key.toLowerCase() === 'd' && !finished) { e.preventDefault(); openDefense(); return; }
      if (finished || !batter) return;
      const map: Record<string, () => void> = {
        // conteo pitch a pitch
        b: () => pitch('B'), s: () => pitch('S'), f: () => pitch('F'),
        // en base / sin batear
        w: () => openPlay('BB'), i: () => openPlay('IBB'), p: () => openPlay('HBP'),
        // hits
        '1': () => openPlay('1B'), '2': () => openPlay('2B'), '3': () => openPlay('3B'),
        '4': () => openPlay('HR'), h: () => openPlay('HR'),
        // outs en jugada
        k: () => openPlay('K'), r: () => openPlay('GO'), v: () => openPlay('FO'),
        l: () => openPlay('LO'), o: () => openPlay('DP'), t: () => openPlay('SAC'), y: () => openPlay('SF'),
        // embasado defensivo
        e: () => openPlay('E'), x: () => openPlay('FC'),
        // corredores
        a: () => openPlay('SB'), c: () => openPlay('CS'),
        // utilidades
        u: () => void undo(),
      };
      const fn = map[e.key.toLowerCase()];
      if (fn) { e.preventDefault(); fn(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // tokens del error híbrido: repetido se ignora (E7-7→E7), dígito tras E#
  // completo corrige el fildeador (E7+5→E5), tras 'E' suelta pega sin guion
  const addErrTok = (t: string, tok: string) => {
    if (!t) return tok;
    const last = t.split('-').pop()!;
    if (last === tok && !/^\d$/.test(tok)) return t;
    if (/^\d$/.test(tok)) {
      // jardinero (7-9) nunca repite dígito seguido — "8-8" no existe; solo el
      // infield 1-6 puede fildear y sacar sin asistencia ("6-6-3", "3-3")
      if (last === tok && Number(tok) > 6) return t;
      // el mismo fildeador no puede tener el mismo error dos veces en la jugada
      if (t.split('-').includes(`E${tok}`)) return t;
      // "7-E"+7 → E7: fildear y errar el mismo guante es solo el error
      if (last === 'E') {
        const toks = t.split('-');
        if (toks[toks.length - 2] === tok) return [...toks.slice(0, -2), `E${tok}`].join('-');
      }
      // token letra+dígito no repite su guante (L7-7/E7-7 inválidos; G# sí:
      // "G6-6" rola fildeada + out sin asistencia); E# + dígito = corrección
      const m = last.match(/^([A-Z]+)(\d+)$/);
      if (m) {
        if (m[2] === tok) return m[1] === 'G' ? `${t}-${tok}` : t;
        if (m[1] === 'E') return `${t.slice(0, -1)}${tok}`;
      }
    }
    return /^[A-Z]$/.test(last) ? `${t}${tok}` : `${t}-${tok}`;
  };

  // 2ª fase del hit+error: envía la jugada con la notación E# y la base extra del bateador
  const confirmHybrid = async () => {
    if (!id || !errorPhase || !/E\d/.test(errorToken)) return;
    const advances = errorPhase.advances.map((a) =>
      a.playerId === batter?.playerId ? { ...a, to: extraTo } : a);
    setErrorPhase(null);
    try {
      const res = await sendEvent( {
        batterId: batter?.playerId,
        pitcherId: pitcherId || undefined,
        result: errorPhase.result,
        notation: [errorPhase.hitNotation, errorToken].filter(Boolean).join('-'),
        advances, clientKey: errorPhase.ck,
        ...(errorPhase.spray ? { sprayDir: errorPhase.spray.dir, sprayDist: errorPhase.spray.dist } : {}),
      });
      setState(res.state);
      setEvents((prev) => (prev.some((e) => e.seq === res.event.seq) ? prev : [...prev, res.event]));
      setQueued(pendingCount());
    } catch {
      setMsg('Sin conexión: jugada en cola, se sincronizará luego');
      setQueued(pendingCount());
      load();
    }
  };

  // ---- Menú Especial ----
  // Terminar la media entrada antes del 3er out (regla de carrera, decisión del anotador, etc.)
  const endInning = async () => {
    if (!id || !effState) return;
    const half = effHalf === 'TOP' ? 'alta' : 'baja';
    if (!confirm(`¿Terminar la ${half} de la ${effState.inning}ª entrada antes del 3er out?`)) return;
    setShowSpecial(false);
    try {
      const res = await sendEvent( { result: 'EI', advances: [], clientKey: `EI-${events.length}` });
      setState(res.state);
      setEvents((prev) => (prev.some((e) => e.seq === res.event.seq) ? prev : [...prev, res.event]));
    } catch {
      setMsg('Sin conexión: jugada en cola'); setQueued(pendingCount()); load();
    }
  };

  // Ajuste manual de corredores y outs (notation "O:n" + advances colocan corredores)
  const confirmAdjust = async () => {
    if (!id) return;
    const advances: Advance[] = [];
    adjBases.forEach((pid, i) => {
      if (pid) advances.push({ playerId: pid, to: (i + 1) as AdvanceTo });
    });
    setShowAdjust(false);
    try {
      const res = await sendEvent( { result: 'ADJ', notation: `O:${adjOuts}`, advances, clientKey: `ADJ-${adjOuts}-${advances.map((a) => `${a.playerId}:${a.to}`).join(',')}-${events.length}` });
      setState(res.state);
      setEvents((prev) => (prev.some((e) => e.seq === res.event.seq) ? prev : [...prev, res.event]));
    } catch {
      setMsg('Sin conexión: jugada en cola'); setQueued(pendingCount()); load();
    }
  };

  // anotar sin lineup: el jugador que llega a la caja se agrega al final del orden.
  // pickTeamId = el equipo del selector abierto (bateo o defensa).
  const pickTeamId = pickMode === 'bat' ? battingTeamId : fieldingTeamId;
  const addToLineup = async (pid: string, position?: string) => {
    if (!id || !pickTeamId) return;
    try {
      await api.lineupAdd(id, pickTeamId, { playerId: pid, position });
      if (pickMode === 'bat') setLuTeam(pickTeamId, 'open'); // el orden queda "armándose"
      setShowBatterPick(false);
      load();
    } catch (e) { setMsg((e as Error).message); }
  };

  // EN BASE — confirmación del diamante interactivo (movimiento de corredores sin batazo)
  const confirmRunners = async (result: string, advances: Advance[], notation: string | null) => {
    if (!id) return;
    setShowRunners(false);
    try {
      const res = await sendEvent({
        // batterId de contexto: sin él el boxscore ignora el evento (crédito SB/carreras)
        // — en modo sin-lineup el turno aún no llega → el último del orden basta
        batterId: batter?.playerId ?? battingLineup[battingLineup.length - 1]?.playerId,
        pitcherId: pitcherId || undefined,
        result, notation,
        // clave determinista por contenido: antes era uid() por llamada y el
        // doble toque en Confirmar grababa la misma jugada dos veces
        advances, clientKey: `RN-${result}-${state?.inning}${effHalf}-${advances.map((a) => `${a.playerId}:${a.to}`).join(',')}-${events.length}`,
      });
      setState(res.state);
      setEvents((prev) => (prev.some((e) => e.seq === res.event.seq) ? prev : [...prev, res.event]));
      setQueued(pendingCount());
    } catch {
      setMsg('Sin conexión: jugada en cola'); setQueued(pendingCount()); load();
    }
  };

  // Cambiar deporte con el juego en curso (error al crear el juego): el server
  // ajusta las entradas reglamentarias al default del nuevo deporte (7↔9)
  const changeSport = async () => {
    if (!id || !game) return;
    const other = game.sport === 'softball' ? 'baseball' : 'softball';
    const inn = other === 'softball' ? 7 : 9;
    if (!confirm(`¿Cambiar este juego a ${other}?\n\nLas entradas reglamentarias pasan a ${inn} (si estaban en el default). Las jugadas ya anotadas no se tocan.`)) return;
    setShowSpecial(false);
    try {
      await api.updateGame(id, { sport: other });
      setMsg(`Deporte cambiado a ${other} — ${inn} entradas reglamentarias`);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  // Cambiar lados: las jugadas se quedan con su equipo (el server invierte las mitades)
  const swapSides = async () => {
    if (!id) return;
    if (!confirm('¿Cambiar los lados de los equipos (visitante ↔ local)? Las jugadas anotadas se quedan con su equipo.')) return;
    setShowSpecial(false);
    try {
      await api.swapSides(id);
      load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  // Ajuste manual de CI del bateador actual (BallScore: Increment/Decrement RBI count)
  const adjRbi = async (delta: 1 | -1) => {
    if (!id || !batter) return;
    try {
      const res = await sendEvent( { result: 'RBI', batterId: batter.playerId, notation: delta > 0 ? '+' : '-', advances: [], clientKey: `RBI-${batter.playerId}-${delta}-${events.length}` });
      setState(res.state);
      setEvents((prev) => (prev.some((e) => e.seq === res.event.seq) ? prev : [...prev, res.event]));
    } catch {
      setMsg('Sin conexión: jugada en cola'); setQueued(pendingCount()); load();
    }
  };

  // Alternar carrera merecida/inmerecida del pitcher elegido (BallScore: Toggle Earned/Unearned)
  const toggleEU = async (unearned: boolean) => {
    if (!id || !euPitcher) return;
    try {
      const res = await sendEvent( { result: 'EU', pitcherId: euPitcher, notation: unearned ? 'U' : 'E', advances: [], clientKey: `EU-${euPitcher}-${unearned ? 'U' : 'E'}-${events.length}` });
      setState(res.state);
      setEvents((prev) => (prev.some((e) => e.seq === res.event.seq) ? prev : [...prev, res.event]));
      setMsg(`Carrera del pitcher ${labelOf(euPitcher)} marcada como ${unearned ? 'inmerecida' : 'merecida'}`);
    } catch {
      setMsg('Sin conexión: jugada en cola'); setQueued(pendingCount()); load();
    }
  };

  // Editor de posiciones defensivas ("Defensa actual") — equipo que defiende ahora
  const openDefense = () => {
    const m: Record<string, string> = {};
    // solo posiciones de campo → EH/DH/banca quedan en el panel lateral del tablero
    for (const l of fieldingLineup) if (FIELD_POSITIONS.includes(l.position) && !m[l.position]) m[l.position] = l.playerId;
    setDefMap(m);
    setShowSpecial(false);
    setShowDefense(true);
  };

  const saveDefense = async () => {
    if (!id || !fieldingTeamId) return;
    // mapa playerId → posición elegida; quien quedó fuera del terreno NO conserva
    // una posición de campo vieja (evita dos jugadores "en 3B" → fielderAt ambiguo)
    const entries = fieldingLineup.map((l) => ({
      playerId: l.playerId,
      position: Object.entries(defMap).find(([, pid]) => pid === l.playerId)?.[0]
        ?? (FIELD_POSITIONS.includes(l.position) ? '' : l.position),
    }));
    await api.setPositions(id, fieldingTeamId, entries);
    setShowDefense(false);
    load();
  };

  // Jugadores que salieron del estadio sin sustituto (softball): su turno = auto-out.
  // Marcador LG en el stream de eventos; notation 'IN' = regresó.
  const leftPlayers = useMemo(() => {
    const s = new Set<string>();
    for (const ev of events) {
      if (ev.result !== 'LG' || !ev.batterId) continue;
      if (ev.notation === 'IN') s.delete(ev.batterId); else s.add(ev.batterId);
    }
    return s;
  }, [events]);

  const markLeft = async (pid: string) => {
    if (!id) return;
    const back = leftPlayers.has(pid);
    try {
      const res = await sendEvent( { result: 'LG', batterId: pid, notation: back ? 'IN' : null, advances: [], clientKey: `LG-${pid}-${back ? 'IN' : 'OUT'}-${events.length}` });
      setState(res.state);
      setEvents((prev) => (prev.some((e) => e.seq === res.event.seq) ? prev : [...prev, res.event]));
    } catch {
      setMsg('Sin conexión: jugada en cola'); setQueued(pendingCount()); load();
    }
  };

  // Auto-out: el turno del jugador que se fue se registra como out y sigue el orden
  const autoOut = async () => {
    if (!id || !batter) return;
    try {
      const res = await sendEvent( {
        result: 'AO', batterId: batter.playerId,
        pitcherId: pitcherId || undefined,
        advances: [{ playerId: batter.playerId, to: 'OUT' }],
        clientKey: `AO-${batter.playerId}-${events.length}`,
      });
      setState(res.state);
      setEvents((prev) => (prev.some((e) => e.seq === res.event.seq) ? prev : [...prev, res.event]));
    } catch {
      setMsg('Sin conexión: jugada en cola'); setQueued(pendingCount()); load();
    }
  };

  // Pasar turno sin out (softball): el ausente se salta y batea el siguiente
  const skipTurn = async () => {
    if (!id || !batter) return;
    try {
      const res = await sendEvent( { result: 'SK', batterId: batter.playerId, advances: [], clientKey: `SK-${batter.playerId}-${events.length}` });
      setState(res.state);
      setEvents((prev) => (prev.some((e) => e.seq === res.event.seq) ? prev : [...prev, res.event]));
    } catch {
      setMsg('Sin conexión: jugada en cola'); setQueued(pendingCount()); load();
    }
  };

  // Corredor fantasma (tie-break): botón manual — el anotador decide cuándo aplica la regla
  const confirmGhost = async () => {
    if (!id || !effState) return;
    const side = effHalf === 'TOP' ? 'away' : 'home';
    // al vuelo: el último out sale de la media entrada que se transcribe
    const flyLast = fly
      ? [...flyEvents].reverse().flatMap((e) => e.advances.filter((a) => a.to === 'OUT').map((a) => a.playerId))[0]
      : undefined;
    const ghostPid = (fly ? flyLast : undefined)
      ?? effState.lastOut?.[side]
      ?? battingLineup[(batterIndex - 1 + battingLineup.length) % battingLineup.length]?.playerId;
    if (!ghostPid) { setMsg('No hay último out para el corredor fantasma'); return; }
    if (!confirm(`Corredor fantasma: ${labelOf(ghostPid)} empieza en 2ª. ¿Confirmar?`)) return;
    try {
      const res = await sendEvent( { result: 'GR', advances: [{ playerId: ghostPid, to: 2 }], clientKey: `GR-${events.length}` });
      setState(res.state);
      setEvents((prev) => (prev.some((e) => e.seq === res.event.seq) ? prev : [...prev, res.event]));
    } catch {
      setMsg('Sin conexión: jugada en cola');
      setQueued(pendingCount());
      load();
    }
  };

  // ── "Anotar en esta casilla" (Alt+clic) y "Limpiar celda" (clic derecho) ──

  /** seq de la jugada ANTES de la cual cabe la PA de la casilla (slot, col):
      cada PA de ese lado+entrada ocupa una posición = ciclo × filas + slot;
      la nueva va antes de la primera PA de posición posterior — o al final
      del bloque de la mitad si ya no hay turnos posteriores. */
  const seqForCell = (side: 'away' | 'home', slot: number, col: number): number | undefined => {
    const sheet = sheets[side];
    const inn = sheet.colInning[col];
    if (inn == null || !game) return undefined;
    const sideHalf = side === 'away' ? 'TOP' : 'BOTTOM';
    const tid = side === 'away' ? game.awayTeamId : game.homeTeamId;
    const L = Math.max(sheet.cells.length, 1);
    const cyc = sheet.colInning.slice(0, col).filter((v) => v === inn).length;
    const targetPos = cyc * L + slot;
    const occ = new Map<number, number>();
    const slotOf = orderSlotOf(tid);
    let beforeSeq: number | undefined;
    let lastBlockIdx = -1;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.half === sideHalf && e.inning === inn) lastBlockIdx = i;
      if (e.half !== sideHalf || e.inning !== inn || !e.batterId || isMidResult(e.result as PlayResult)) continue;
      const s = slotOf(e.batterId, e.inning, e.half) ?? (L + 99); // sin orden → al final
      const c = occ.get(s) ?? 0;
      occ.set(s, c + 1);
      if (beforeSeq == null && c * L + s >= targetPos) beforeSeq = e.seq;
    }
    return beforeSeq ?? events[lastBlockIdx + 1]?.seq;
  };

  /** Alt+clic → eligió resultado: arma el modal de avances con el estado real
      justo antes de donde cae la casilla (corredores y bateador correctos). */
  const openInsertPlay = (result: string) => {
    if (!insertCell || !game || !id) return;
    const { side, slot, col } = insertCell;
    const inn = sheets[side].colInning[col];
    if (inn == null) { setMsg('Esa columna no corresponde a una entrada anotada'); return; }
    const tid = side === 'away' ? game.awayTeamId : game.homeTeamId;
    const half: 'TOP' | 'BOTTOM' = side === 'away' ? 'TOP' : 'BOTTOM';
    const ets = (game.lineups ?? []).filter((l) => l.teamId === tid && l.order === slot + 1 && l.batsInOrder !== false);
    const batterE = ets.find((l) => l.active) ?? ets[0];
    if (!batterE) { setMsg('Esa casilla no tiene jugador en la alineación — agrégalo primero'); return; }
    const beforeSeq = seqForCell(side, slot, col);
    let prev = initialState();
    for (const e of events) { if (beforeSeq != null && e.seq >= beforeSeq) break; prev = applyEvent(prev, e, game.innings); }
    const pit = [...events].reverse().find((e) => e.seq < (beforeSeq ?? Infinity) && e.half === half && e.pitcherId)?.pitcherId ?? undefined;
    const real = (PSEUDO[result] ?? result) as string;
    const defs = defaultAdvances(prev, batterE.playerId, (HYBRID[real]?.hitCode ?? real) as PAResult);
    const rows: AdvanceRow[] = [{
      playerId: batterE.playerId, label: `${labelOf(batterE.playerId)} (bateador)`, from: 'Home',
      options: [1, 2, 3, 'HOME', 'OUT'], initial: defs.find((d) => d.playerId === batterE.playerId)?.to ?? 'OUT',
    }];
    for (const [b, pid] of [[1, prev.bases[1]], [2, prev.bases[2]], [3, prev.bases[3]]] as const) {
      if (pid) rows.push({
        playerId: pid, label: labelOf(pid), from: `En ${b}ª`, options: [1, 2, 3, 'HOME', 'OUT'] as AdvanceTo[],
        initial: defs.find((d) => d.playerId === pid)?.to ?? (b as AdvanceTo),
      });
    }
    const isHit = ['1B', '2B', '3B', 'HR', '1BE', '2BE', '3BE', 'RHB'].includes(real);
    setInsertTarget({ batterId: batterE.playerId, pitcherId: pit, inning: inn, half, beforeSeq });
    setInsertPlay({
      result: real, rows, isMid: false, ck: uid(),
      zoneOnly: isHit,
      askTraj: ['1B', '2B', '3B', 'HR', '1BE', '2BE', '3BE', 'E', 'FC', 'DP', 'TP', 'RHB'].includes(real),
      spray: ['1B', '2B', '3B', 'HR', 'GO', 'FO', 'LO', 'PO', 'DP', 'TP', 'SAC', 'SF', 'E', 'FC', 'IF', 'XF', '1BE', '2BE', '3BE', 'RHB'].includes(real),
      requireError: real === 'E',
      notationHint: real === 'RHB'
        ? '⚾ Bola golpea a corredor (fair) — marca OUT al corredor golpeado; el bateador se embasa con hit'
        : isHit ? '¿Hacia dónde fue el batazo? (ej. 9 = jardín derecho)' : undefined,
    });
    setInsertCell(null);
  };

  const confirmInsert = async (advances: Advance[], notation: string | null, spray?: { dir: number; dist: number } | null, resultOverride?: string) => {
    if (!id || !insertPlay || !insertTarget) return;
    const result = resultOverride ?? insertPlay.result;
    setInsertPlay(null);
    try {
      const res = await api.addEvent(id, {
        batterId: insertTarget.batterId,
        pitcherId: insertTarget.pitcherId,
        result, notation, advances,
        inning: insertTarget.inning, half: insertTarget.half,
        beforeSeq: insertTarget.beforeSeq,
        clientKey: insertPlay.ck,
        ...(spray ? { sprayDir: spray.dir, sprayDist: spray.dist } : {}),
      });
      setState(res.state);
      // llega con seq intermedio → reinsertar ordenado en la lista local
      setEvents((prev) => [...prev.filter((e) => e.seq !== res.event.seq), res.event].sort((a, b) => a.seq - b.seq));
      setQueued(pendingCount());
      setMsg(`✓ Jugada anotada en la casilla (#${res.event.seq})`);
      load();
    } catch {
      setMsg('Sin conexión: jugada en cola, se sincronizará luego');
      setQueued(pendingCount());
      load();
    }
  };

  /** "Limpiar celda completa": borra la(s) jugada(s) de turno de la casilla y
      quita quirúrgicamente los avances de los corredores de ESA fila que
      provengan de otros eventos — contenido, notación y bases se van. */
  const clearCell = async () => {
    if (!cellMenu || !game || !id) return;
    const { side, slot, col } = cellMenu;
    const cell = sheets[side].cells[slot]?.[col];
    const inn = sheets[side].colInning[col];
    setCellMenu(null);
    if (!cell?.plays.length) return;
    if (!confirm(`Limpiar la casilla del ${slot + 1}º del orden, ${inn}ª entrada (${side === 'away' ? 'visitante' : 'local'})?\n\nSe borra ${cell.plays.length === 1 ? 'su jugada' : `sus ${cell.plays.length} jugadas`} con toda la notación y los avances de base.`)) return;
    const tid = side === 'away' ? game.awayTeamId : game.homeTeamId;
    const slotPids = new Set((game.lineups ?? []).filter((l) => l.teamId === tid && l.order === slot + 1).map((l) => l.playerId));
    try {
      for (const play of cell.plays) {
        const ev = events.find((e) => e.seq === play.seq);
        if (!ev) continue;
        if (play.result) {
          await api.deleteEvent(id, ev.seq); // la PA vive en esta casilla → evento completo
        } else {
          // sombra de corredor: se quitan solo los avances de los jugadores de esta fila
          const nAdv = (ev.advances ?? []).filter((a) => !slotPids.has(a.playerId));
          if (nAdv.length !== (ev.advances?.length ?? 0)) {
            if (!nAdv.length && isMidResult(ev.result as PlayResult)) await api.deleteEvent(id, ev.seq);
            else await api.updateEvent(id, ev.seq, { advances: nAdv });
          }
        }
      }
      await load();
      setMsg('✓ Casilla limpia');
    } catch (e) { setMsg((e as Error).message); await load(); }
  };

  if (!game || !state) return <p>{msg || 'Cargando…'}</p>;

  const hasRunners = baseRunners.length > 0;
  const finished = !fly && (state.status === 'FINAL' || game.status === 'FINAL'); // fin manual/forfeit también cierra (en al vuelo el reduce interno no manda)
  // reloj: tiempo transcurrido menos las pausas acumuladas
  const elapsedSec = game.startedAt
    ? Math.max(0, Math.floor(((game.endedAt ?? game.pausedAt ? new Date((game.endedAt ?? game.pausedAt)!).getTime() : now) - new Date(game.startedAt).getTime()) / 1000) - (game.pauseSecs ?? 0))
    : 0;
  const clock = `${Math.floor(elapsedSec / 3600)}:${String(Math.floor(elapsedSec / 60) % 60).padStart(2, '0')}:${String(elapsedSec % 60).padStart(2, '0')}`;
  const hldList: string[] = game.hldIds ? JSON.parse(game.hldIds) : [];

  return (
    <div>
      <div className="row">
        <Link to={`/games/${game.id}`}>← Juego</Link>
        {game.startedAt && (
          <span className="game-clock" title="Tiempo de juego">
            ⏱ {clock}{(game.status === 'SUSPENDED' || game.pausedAt) ? ' ⏸' : (!game.endedAt && !finished ? '' : ' (fin)')}
          </span>
        )}
        {game.status === 'LIVE' && !finished && (
          <button className="secondary sm" title={game.pausedAt ? '▶ Reanudar el reloj' : '⏸ Pausar el reloj (lluvia, luz, reunión)'}
            onClick={async () => { try { const g = await api.pauseGame(game.id); setGame(g); } catch (e) { setMsg((e as Error).message); } }}>
            {game.pausedAt ? '▶' : '⏸'}
          </button>
        )}
        {(game.stadium || game.date) && (
          <span className="muted game-meta">
            {game.stadium ? `🏟 ${game.stadium} · ` : ''}{new Date(game.date).toLocaleDateString()}
          </span>
        )}
        <span className="spacer" />
        <button className="secondary sm" title="Recargar juego y subir jugadas pendientes (🔄 resincronizar)"
          disabled={syncing} onClick={resync}>{syncing ? '…' : '🔄'}</button>
        {queued > 0 && (
          <button className="pill live" style={{ cursor: 'pointer', border: 'none' }} title="Ver / reintentar / vaciar la cola"
            onClick={() => setShowQueue(true)}>{queued} jugadas en cola</button>
        )}
        {!finished && <button className="secondary" title="Shift+I — situacional, temporada y vs lanzador" onClick={() => setShowConsulta(true)}>🔍 Consulta</button>}
        {!finished && <button className="secondary" title="? — lista de atajos de teclado" onClick={() => setShowKeys(true)}>⌨</button>}
        {!finished && !fly && <button className="secondary" title="Transcribir la hoja de un equipo de corrido (compilar sin estar en el estadio)" onClick={openFly}>⚡ Al vuelo</button>}
        {!finished && <button className="secondary" onClick={() => { setEuPitcher(pitcherId); setShowSpecial(true); }}>⚙ Especial</button>}
        {!finished && <button className="secondary" onClick={() => setShowSub(true)}>⇄ Sustitución</button>}
        {!finished && <button className="secondary" onClick={() => void undo()}>↩ Deshacer</button>}
        <button className="secondary" title="Borrar desde una jugada en adelante" onClick={() => setShowUndoLog(true)}>↩ Jugadas…</button>
        <button className="danger" onClick={() => setShowFinish(true)}>
          {finished && !game.seasonApplied ? '⚑ Decisiones del juego' : finished ? '⚑ Decisiones' : '⚑ Finalizar'}
        </button>
      </div>

      {/* Linescore + paneles en vivo estilo BallScore */}
      <div className="live-grid">
      <div className="card" style={{ padding: '0.6rem 1rem' }}>
        <table className="linescore">
          <thead>
            <tr>
              <th />
              {Array.from({ length: Math.max(game.innings, state.inning, lineLen) }, (_, i) => <th key={i}>{i + 1}</th>)}
              <th className="ls-total">R</th><th className="ls-total">H</th><th className="ls-total">E</th><th className="ls-total">LOB</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="ls-team">{game.awayTeam?.shortName ?? game.awayTeam?.name}</td>
              {Array.from({ length: Math.max(game.innings, state.inning, effState?.inning ?? 1, lineLen) }, (_, i) => (
                <td key={i} className={effHalf === 'TOP' && effState?.inning === i + 1 && !finished ? 'ls-live' : ''}>
                  {awayLine[i] ?? (i < (effState?.inning ?? 1) || (i + 1 === effState?.inning && effHalf !== 'TOP') ? 0 : '')}
                </td>
              ))}
              <td className="ls-total">{state.score.away}</td>
              <td className="ls-total">{Object.values(box.away).reduce((s, b) => s + b.h, 0)}</td>
              <td className="ls-total">{errLine.away}</td>
              <td className="ls-total">{box.lob.away}</td>
            </tr>
            <tr>
              <td className="ls-team">{game.homeTeam?.shortName ?? game.homeTeam?.name}</td>
              {Array.from({ length: Math.max(game.innings, state.inning, effState?.inning ?? 1, lineLen) }, (_, i) => (
                <td key={i} className={effHalf === 'BOTTOM' && effState?.inning === i + 1 && !finished ? 'ls-live' : ''}>
                  {homeLine[i] ?? (i < (effState?.inning ?? 1) || (i + 1 === effState?.inning && effHalf !== 'BOTTOM') ? 0 : '')}
                </td>
              ))}
              <td className="ls-total">{state.score.home}</td>
              <td className="ls-total">{Object.values(box.home).reduce((s, b) => s + b.h, 0)}</td>
              <td className="ls-total">{errLine.home}</td>
              <td className="ls-total">{box.lob.home}</td>
            </tr>
          </tbody>
        </table>
        <div className="row" style={{ marginTop: '0.4rem', fontSize: '0.9rem' }}>
          <span className="muted">Entrada:</span>
          <strong>{effHalf === 'TOP' ? '▲ Alta' : '▼ Baja'} de la {effState?.inning ?? 1}ª</strong>
          <span className="muted">· Outs:</span><strong>{effState?.outs ?? 0}</strong>
          <span className="muted">· Al bate:</span><strong>{batter ? labelOf(batter.playerId) : '—'}</strong>
          {fly && <span className="pill fly-pill">⚡ AL VUELO</span>}
        </div>
      </div>

      {/* aviso no bloqueante: la defensa del equipo que fildea no está definida —
          se puede anotar igual, pero E/PO/A no se resuelven por guante */}
      {defenseMissing && !defWarned.has(defWarnKey) && (
        <div className="def-warn row">
          <span>⚠ <strong>Defensa no definida</strong> — puedes anotar igual, pero los E/PO/A no saldrán por guante.</span>
          <span className="spacer" />
          <button className="secondary sm" onClick={openDefense}>🧤 Definir defensa</button>
          <button className="secondary sm" title="Ocultar aviso" onClick={() => setDefWarned((s) => new Set(s).add(defWarnKey))}>✕</button>
        </div>
      )}

      {/* Barra en vivo estilo scorebug: bateador y lanzador en una sola tira horizontal */}
      <div className="live-bar card">
        <div className="lb-lane">
          <span className="ls-tag">Al bate</span>
          {batter && <PlayerAvatar player={players.get(batter.playerId)} size={26} />}
          {batter
            ? <button className="linklike lb-name" onClick={() => setCardPlayerId(batter.playerId)}>{fullNameOf(batter.playerId)}</button>
            : <strong>—</strong>}
          <span className="muted">{batter?.position}</span>
          {batter && (
            <>
              <span className="lb-plays">
                {batterPlays.length ? batterPlays.map((p, i) => <span key={i} className={`ss-result r-${p.cls}`}>{p.label}</span>) : <span className="muted lb-turno">1er turno</span>}
              </span>
              <i className="lb-sep" />
              <span className="lb-run"><em>JUEGO</em>
                AB <strong>{batterLine?.ab ?? 0}</strong> · R <strong>{batterLine?.r ?? 0}</strong> · H <strong>{batterLine?.h ?? 0}</strong> · 2B <strong>{batterLine?.doubles ?? 0}</strong> · 3B <strong>{batterLine?.triples ?? 0}</strong> · HR <strong>{batterLine?.hr ?? 0}</strong> · CI <strong>{batterLine?.rbi ?? 0}</strong> · BB <strong>{batterLine?.bb ?? 0}</strong> · K <strong>{batterLine?.k ?? 0}</strong> · AVG <strong>{batterLine?.ab ? (batterLine.h / batterLine.ab).toFixed(3).replace(/^0/, '') : '.000'}</strong>
              </span>
              {batTot && (
                <span className="lb-run temp"><em>{game?.seriesId ? 'POST' : 'TEMP'}</em>
                  AB <strong>{batTot.ab}</strong> · R <strong>{batTot.r}</strong> · H <strong>{batTot.h}</strong> · HR <strong>{batTot.hr}</strong> · CI <strong>{batTot.rbi}</strong> · BB <strong>{batTot.bb}</strong> · K <strong>{batTot.k}</strong> · BR <strong>{batTot.sb}</strong> · AVG <strong>{batTot.ab ? (batTot.h / batTot.ab).toFixed(3).replace(/^0/, '') : '.000'}</strong>
                </span>
              )}
              {nextBatter && <span className="lb-next muted">→ sig: <strong>{fullNameOf(nextBatter.playerId)}</strong> {nextBatter.position}</span>}
            </>
          )}
        </div>
        <div className="lb-lane">
          <span className="ls-tag">Lanza</span>
          <strong className="lb-name">{pitcherId ? fullNameOf(pitcherId) : '—'}</strong>
          {pitcherLine && (
            <>
              <i className="lb-sep" />
              <span className="lb-run"><em>JUEGO</em>
                IP <strong>{Math.floor(pitcherLine.outs / 3)}.{pitcherLine.outs % 3}</strong> · H <strong>{pitcherLine.h}</strong> · C <strong>{pitcherLine.r}</strong> · CL <strong>{pitcherLine.er}</strong> · BB <strong>{pitcherLine.bb}</strong> · K <strong>{pitcherLine.k}</strong> · HR <strong>{pitcherLine.hr}</strong> · BF <strong>{pitcherBF}</strong> · Pit <strong>{pitcherLine.pitches}</strong>
              </span>
            </>
          )}
          {pitTot && (
            <span className="lb-run temp"><em>{game?.seriesId ? 'POST' : 'TEMP'}</em>
              G-P <strong>{pitTot.wl}</strong> · SV <strong>{pitTot.sv}</strong> · IP <strong>{Math.floor(pitTot.outs / 3)}.{pitTot.outs % 3}</strong> · H <strong>{pitTot.h}</strong> · C <strong>{pitTot.r}</strong> · CL <strong>{pitTot.er}</strong> · BB <strong>{pitTot.bb}</strong> · K <strong>{pitTot.k}</strong> · ERA <strong>{pitTot.era.toFixed(2)}</strong>
            </span>
          )}
          <button className="secondary lb-more" title="Resumen del juego (Shift+L)" onClick={() => setShowSummary(true)}>☰ Resumen</button>
        </div>
      </div>
      </div>

      {finished && (
        <div className="card">
          <h2>FINAL — {game.awayTeam?.name} {state.score.away}, {game.homeTeam?.name} {state.score.home}
            {game.tied && <span className="pill sched" style={{ marginLeft: 8 }}>EMPATE</span>}
          </h2>
          {(game.wpId || game.lpId || game.svId || hldList.length > 0) && (
            <div className="row" style={{ fontSize: '0.9rem' }}>
              {game.wpId && <span>G: <strong>{labelOf(game.wpId)}</strong></span>}
              {game.lpId && <span>P: <strong>{labelOf(game.lpId)}</strong></span>}
              {game.svId && <span>SV: <strong>{labelOf(game.svId)}</strong></span>}
              {hldList.length > 0 && <span>HLD: <strong>{hldList.map(labelOf).join(', ')}</strong></span>}
            </div>
          )}
          <Link to={`/games/${game.id}`}>Ver boxscore →</Link>
        </div>
      )}

      {fly && (
        <div className="fly-banner">
          <strong>⚡ ANOTACIÓN AL VUELO</strong>
          <span>{fly.half === 'TOP' ? game.awayTeam?.name : game.homeTeam?.name}</span>
          <span className="muted">{fly.half === 'TOP' ? '▲ Alta' : '▼ Baja'} de la {fly.inning}ª · outs: {flyOutsDone}/3</span>
          <span className="spacer" />
          <button className="secondary" onClick={() => { setFlyTeamId(fly.teamId === game.awayTeamId ? game.homeTeamId : game.awayTeamId); setFlyInning(1); setShowFly(true); }}>⇄ Otro equipo</button>
          <button className="secondary" onClick={() => setFly({ ...fly, inning: fly.inning + 1 })}>⏭ {flyDone ? `Siguiente entrada (${fly.inning + 1}ª)` : `${fly.inning + 1}ª entrada`}</button>
          <button className="secondary" onClick={() => setFly(null)}>✔ Terminar al vuelo</button>
        </div>
      )}
      {flyDone && <p className="fly-done">⛔ Media entrada completa (3 outs) — pulsa "⏭ Siguiente entrada" para seguir con este equipo.</p>}

      {!finished && (
        <div className="score-grid">
          <div className="card">
            <Diamond bases={effState!.bases} outs={effState!.outs} labels={labels} />
            <hr />
            <p><strong>Al bate:</strong> {batter ? labelOf(batter.playerId) : needBatter
              ? <button className="linklike" style={{ fontWeight: 700 }} onClick={() => { setPickMode('bat'); setShowBatterPick(true); }}>＋ ¿Quién batea? tócalo aquí</button>
              : <span className="muted">Define la alineación en la página del juego</span>}</p>
            <div className="row">
              <strong>Lanza:</strong>
              <select value={pitcherId} onChange={(e) => void selectPitcher(e.target.value)}>
                {pitcherOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}{o.tag === 'roster' ? ' (relevista)' : ` (${o.tag})`}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="card">
            {/* conteo del turno: bola / strike / foul pitch a pitch + mapa de zona opcional */}
            <div className="count-row">
              <span className="count-badge" title="Conteo del bateador">B-S <strong>{count.b}-{count.s}</strong></span>
              <button className="pitch-btn ball" onClick={() => pitch('B')} disabled={!batter}>Bola</button>
              <button className="pitch-btn strike" onClick={() => pitch('S')} disabled={!batter}>Strike</button>
              <button className="pitch-btn foul" onClick={() => pitch('F')} disabled={!batter}>Foul</button>
            </div>
            {/* mapa de zona: tocar celda → el próximo B/S/F queda localizado (chart del pitcher) */}
            <div className="zone-pick" title="Toca la zona donde pasó el pitcheo (opcional)">
              <div className="zone-grid">
                {[0, 1, 2, 3, 4].map((r) =>
                  [0, 1, 2, 3, 4].map((c) => {
                    const inner = r >= 1 && r <= 3 && c >= 1 && c <= 3;
                    const sel = pitchZone?.r === r && pitchZone?.c === c;
                    return (
                      <button key={`${r}${c}`}
                        className={`zc ${inner ? 'zc-in' : 'zc-out'} ${sel ? 'zc-sel' : ''}`}
                        onClick={() => setPitchZone(sel ? null : { r, c })}
                        aria-label={`zona ${r}${c}`} />
                    );
                  }),
                )}
              </div>
              {pitchZone && <span className="muted" style={{ fontSize: '0.72rem' }}>zona marcada</span>}
            </div>
            {/* jugador que salió del estadio sin sustituto → su turno es out automático */}
            {batter && leftPlayers.has(batter.playerId) && (
              <div className="row" style={{ background: '#fef3c7', borderRadius: 8, padding: '0.4rem 0.7rem', marginBottom: '0.5rem', alignItems: 'center' }}>
                <span style={{ flex: 1, fontSize: '0.85rem', fontWeight: 600, color: '#92400e' }}>
                  ⚠ {labelOf(batter.playerId)} salió del juego
                </span>
                <button className="danger" onClick={autoOut}>⏭ AUTO-OUT</button>
                <button className="secondary" onClick={skipTurn} title="Su turno pasa al siguiente sin out (regla softball sin penalización)">⤵ Pasar turno</button>
              </div>
            )}
            {/* sin lineup: el turno no gira solo — toca al que llega a la caja */}
            {needBatter && !finished && (
              <>
              <button className="big-play hit" style={{ width: '100%', marginBottom: '0.4rem' }}
                onClick={() => { setPickMode('bat'); setShowBatterPick(true); }}>
                ＋ Bateador al plato — agrégalo a la alineación
              </button>
              {/* modo "orden armándose" pegado con un lineup ya completo (venía
                  de otra sesión/dispositivo): el turno no resuelve y el panel se
                  apaga — un toque cierra el orden y sigue con el 1º */}
              {battingLineup.length > 0 && (
                <button className="secondary" style={{ width: '100%', marginBottom: '0.4rem' }}
                  onClick={() => battingTeamId && setLuTeam(battingTeamId, 'closed')}
                  title="La alineación ya está completa — el turno vuelve al 1º del orden">
                  🔁 Orden completo — sigue con el 1º ({labelOf(battingLineup[0]?.playerId)})
                </button>
              )}
              </>
            )}
            <div className="big-play-grid">
              {PICKER_GROUPS.map((g) => (
                <button key={g.key} className={`big-play ${g.cls}`} onClick={() => setPickGroup(g.key)} disabled={!batter}>
                  {g.label}
                </button>
              ))}
              {/* EN BASE: diamante interactivo — mover corredores sin batazo */}
              <button className="big-play walk" onClick={() => setShowRunners(true)}
                disabled={!hasRunners || finished || flyDone} title="Mover corredores en las bases — toca el corredor y su destino">
                EN BASE
              </button>
            </div>
            {/* módulos IA: voz + video-asistente + stats en vivo */}
            <div className="row" style={{ gap: '0.4rem', marginTop: '0.4rem' }}>
              {audioPanel && (<>
              <button className="secondary" style={{ flex: 1, fontWeight: 700 }}
                title="Dictar la jugada (dominicano) — ej. «rolling por segunda», «se fue»"
                onClick={() => batter ? setShowVoice(true) : setMsg('Sin bateador en turno — espera al próximo turno')}>🎤 Voz</button>
              <LiveMic
                gameId={id}
                blocked={modalOpen || !batter || flyDone}
                onStatus={setMsg}
                onCommand={voiceCommand}
                onVoiceText={(t) => {
                  if (showSub) { setVoiceSubText(`${Date.now()}|${t}`); return; }
                  // fase de error híbrida (1BE/2BE/3BE): "e dos"→E2, "a tercera"→base extra
                  if (errorPhase) {
                    const vn = voiceNotationOf(t);
                    // token completo ("E7", "G-E5") reemplaza; dígito suelto
                    // ("siete") se agrega como chip → "e siete" queda E7
                    if (vn) {
                      if (/^[A-Z]/.test(vn) || vn.includes('-') || !errorToken) { setErrorToken(vn); }
                      else setErrorToken((t) => addErrTok(t, vn));
                      setMsg(`🎙 notación: ${vn}`); return;
                    }
                    const nb = normCmd(t);
                    if (/anota|home|plato|goma/.test(nb)) { setExtraTo('HOME'); setMsg('🎙 extra: anota'); }
                    else if (/tercer|antesala|esquina/.test(nb)) { setExtraTo(3); setMsg('🎙 extra: a 3ª'); }
                    else if (/segund|intermedi/.test(nb)) { setExtraTo(2); setMsg('🎙 extra: a 2ª'); }
                    else if (/primer|inicial/.test(nb)) { setExtraTo(1); setMsg('🎙 extra: a 1ª'); }
                    return;
                  }
                  if (!pending) return;
                  // modal de avances abierto: "e dos"→E2, "seis cuatro tres"→6-4-3,
                  // "elevado siete"→F7 — si no es notación, va al server como
                  // avance hablado ("en primera a tercera" marca la fila)
                  const vn = voiceNotationOf(t);
                  if (vn) { setVoiceNotation(vn); setMsg(`🎙 notación: ${vn}`); return; }
                  void api.aiNotation(t, id!).then((s) => {
                    if (s?.advances?.length) {
                      setVoiceAdvances({ key: Date.now(), list: s.advances as { playerId: string; to: AdvanceTo }[] });
                      if (s.notation) setVoiceNotation(s.notation);
                      setMsg(`🎙 ${s.ai?.description_spanish ?? 'avance marcado'}`);
                    } else if (s?.notation) { setVoiceNotation(s.notation); setMsg(`🎙 notación: ${s.notation}`); }
                  }).catch(() => { /* frase no reconocida → silencio, sigue el modal */ });
                }}
                ctx={micCtx}
                onPick={(result, notation, aiVoice, aiJson, advances) => openPlay(result, { preNotation: notation, voice: aiVoice, json: aiJson, preAdvances: advances })}
              />
              </>)}
              {/* pestaña audio: apaga 🎤 Voz + mic en vivo para anotación táctil */}
              <button className="secondary" style={{ fontWeight: 700 }}
                title={audioPanel ? 'Ocultar panel de audio (voz/mic en vivo)' : 'Mostrar panel de audio (voz/mic en vivo)'}
                onClick={() => { const v = !audioPanel; setAudioPanel(v); localStorage.setItem('pox-audio', v ? '1' : '0'); }}>
                🎙
              </button>
              <button className="secondary" style={{ flex: 1, fontWeight: 700 }} disabled={videoBusy}
                title="Analizar jugada por video (asistente IA)"
                onClick={async () => {
                  if (!batter) { setMsg('Sin bateador en turno — espera al próximo turno'); return; }
                  setVideoBusy(true);
                  try {
                    const v = await api.videoAnalyze();
                    const label = RESULT_LABEL[v.result] ?? v.result;
                    if (confirm(`🎥 Parece ser: ${label}${v.notation ? ` (${v.notation})` : ''} — ${Math.round(v.confidence * 100)}% confianza\n\n¿Usar esta jugada?`)) {
                      openPlay(v.result, { preNotation: v.notation, video: JSON.stringify(v) });
                    }
                  } catch (e) { setMsg(`Video IA: ${(e as Error).message}`); }
                  finally { setVideoBusy(false); }
                }}>{videoBusy ? '📹 Analizando…' : '📹 Video'}</button>
              <button className="secondary" style={{ flex: 1, fontWeight: 700 }}
                title="Stats avanzadas y probabilidad en vivo"
                onClick={async () => {
                  if (showInsights) { setShowInsights(false); return; }
                  setInsights(null); setShowInsights(true); // abre el panel de inmediato (feedback visual)
                  try { setInsights(await api.aiInsights(id!)); }
                  catch (e) { setMsg(`Stats IA: ${(e as Error).message}`); setShowInsights(false); }
                }}>📊 Stats</button>
              <button className="secondary" style={{ fontWeight: 700 }}
                title={ttsOn ? 'Narración por voz: ON' : 'Narración por voz: OFF'}
                onClick={() => { const v = !ttsOn; setTtsOn(v); localStorage.setItem('pox-tts', v ? '1' : '0'); if (!v) window.speechSynthesis?.cancel(); }}>
                {ttsOn ? '🔊' : '🔇'}
              </button>
            </div>
            <div className="section-label">Juego de corredores</div>
            <div className="result-grid">
              {MID_BUTTONS.map((r) => (
                <button key={r} className="mid" onClick={() => openPlay(r)}
                  disabled={!hasRunners && !['WP', 'PB', 'BK', 'IPL', 'EF'].includes(r)}>
                  {RESULT_LABEL[r]}
                </button>
              ))}
              <button className="mid ghost" onClick={confirmGhost} disabled={!!effState?.bases[2] || finished} title="Corredor fantasma: coloca en 2ª al último out">👻 Fantasma</button>
            </div>
          </div>
        </div>
      )}

      {/* Planilla del equipo al bate — estilo BallScore */}
      {battingTeamId && (
        <div className="card" style={{ padding: '0.6rem' }}>
          <div className="row" style={{ marginBottom: '0.4rem' }}>
            <span className="section-label" style={{ margin: 0 }}>Hoja de anotación — {effHalf === 'TOP' ? 'Visitante' : 'Local'}</span>
            <span className="spacer" />
            <button className="secondary icon" onClick={() => setSheetSide(sheetSide === 'batting' ? 'away' : 'batting')} title="Alternar hoja de anotación">
              {sheetSide === 'batting' ? 'Ver ambas' : 'Ver solo bateando'}
            </button>
          </div>
          <div className="sheet-stack">
            {(sheetSide === 'batting' ? [battingTeamId === game.awayTeamId ? 'away' as const : 'home' as const] : ['away', 'home'] as const).map((side) => {
              const tid = side === 'away' ? game.awayTeamId : game.homeTeamId;
              const lu = battingOf(tid);
              const luAll = (game.lineups ?? []).filter((l) => l.teamId === tid && l.batsInOrder !== false).sort((a, b) => a.order - b.order);
              const sheet = sheets[side];
              return (
                <Scoresheet
                  key={side}
                  cells={sheet.cells}
                  pitcherInnings={sheet.pitcherInnings}
                  lineup={luAll}
                  innings={game.innings}
                  players={players}
                  teamName={side === 'away' ? (game.awayTeam?.name ?? 'Visitante') : (game.homeTeam?.name ?? 'Local')}
                  teamColor={side === 'away' ? (game.awayTeam?.color ?? undefined) : (game.homeTeam?.color ?? undefined)}
                  nextSlot={side === (effHalf === 'TOP' ? 'away' : 'home') && batter ? batter.order - 1 : undefined}
                  nextInning={side === (effHalf === 'TOP' ? 'away' : 'home') ? effState?.inning : undefined}
                  colInning={sheet.colInning}
                  tally={tallies[side]}
                  onPlayContext={(play, x, y) => {
                    const ev = events.find((e) => e.seq === play.seq);
                    if (ev) setSheetMenu({ x, y, ev });
                  }}
                  onCellContext={(slot, col, cell, x, y) => {
                    setCellMenu({ x, y, side, slot, col });
                  }}
                  onCellAlt={(slot, col) => {
                    if (finished) return;
                    setInsertCell({ side, slot, col });
                  }}
                  onSwapBatter={(aId, bId, withMarks) => {
                    const nA = players.get(aId)?.lastName ?? aId;
                    const nB = players.get(bId)?.lastName ?? bId;
                    const tid = side === 'away' ? game.awayTeamId : game.homeTeamId;
                    const q = withMarks
                      ? `Mover a ${nA} CON todas sus anotaciones a la casilla de ${nB} (y ${nB} con las suyas a la de ${nA}). ¿Aplicar?`
                      : `Cambiar ${nA} por ${nB} en la casilla — las anotaciones se quedan donde están. ¿Aplicar?`;
                    if (!window.confirm(q)) return;
                    (withMarks ? api.swapOrder(game.id, { teamId: tid, aId, bId }) : api.swapPlayer(game.id, { teamId: tid, aId, bId }))
                      .then(() => load().then(() => setMsg('✓ Intercambio aplicado')))
                      .catch((e) => setMsg((e as Error).message));
                  }}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* menú contextual de casilla: clic derecho sobre una jugada de la planilla */}
      {sheetMenu && (() => {
        const ev = sheetMenu.ev;
        const bp = ev.batterId ? players.get(ev.batterId) : undefined;
        const pp = ev.pitcherId ? players.get(ev.pitcherId) : undefined;
        const fix = async (kind: 'RBI+' | 'RBI-' | 'EU-E' | 'EU-U') => {
          const body = kind.startsWith('RBI')
            ? { result: 'RBI', notation: `${kind === 'RBI-' ? '-' : '+'}@${ev.seq}`, batterId: ev.batterId ?? undefined, advances: [] as Advance[], inning: ev.inning, half: ev.half as 'TOP' | 'BOTTOM' }
            : { result: 'EU', notation: `${kind === 'EU-U' ? 'U' : 'E'}@${ev.seq}`, pitcherId: ev.pitcherId ?? undefined, advances: [] as Advance[], inning: ev.inning, half: ev.half as 'TOP' | 'BOTTOM' };
          setSheetMenu(null);
          try { await api.addEvent(id!, body); load(); }
          catch (e) { setMsg((e as Error).message); }
        };
        const x = Math.min(sheetMenu.x, window.innerWidth - 250);
        const y = Math.min(sheetMenu.y, window.innerHeight - 230);
        return (
          <>
            <div className="ctx-back" onClick={() => setSheetMenu(null)} onContextMenu={(e) => { e.preventDefault(); setSheetMenu(null); }} />
            <div className="ctx-menu" style={{ left: x, top: y }}>
              <div className="ctx-title">
                {ev.inning}ª {ev.half === 'TOP' ? '↑' : '↓'} · {ev.result}{ev.notation ? ` ${ev.notation}` : ''}
                {bp ? ` — ${bp.firstName} ${bp.lastName}` : ''}
                {pp ? <span className="muted"> · P: {pp.firstName} {pp.lastName}</span> : null}
              </div>
              <button onClick={() => fix('RBI+')} disabled={!ev.batterId}>➕ Acreditar empujada (+CI)</button>
              <button onClick={() => fix('RBI-')} disabled={!ev.batterId}>➖ Restar empujada (−CI)</button>
              <div className="ctx-sep" />
              <button onClick={() => fix('EU-U')} disabled={!ev.pitcherId}>🟠 Carrera sucia para el pitcher (−CL)</button>
              <button onClick={() => fix('EU-E')} disabled={!ev.pitcherId}>🟢 Carrera limpia para el pitcher (+CL)</button>
              <div className="ctx-sep" />
              {/* corrección quirúrgica: edita avances/resultado de ESA jugada sin borrar la entrada */}
              <button onClick={() => {
                if (!game) return;
                // estado justo ANTES de la jugada → bases ocupadas y origen de cada corredor
                let prev = initialState();
                for (const e of events) { if (e.seq >= ev.seq) break; prev = applyEvent(prev, e, game.innings); }
                const nm = (pid: string) => { const p = players.get(pid); return p ? `${p.firstName} ${p.lastName}` : '?'; };
                const opts: AdvanceTo[] = [1, 2, 3, 'HOME', 'OUT'];
                const rows: AdvanceRow[] = [];
                if (ev.batterId && !isMidResult(ev.result)) {
                  const rec = ev.advances.find((a) => a.playerId === ev.batterId);
                  rows.push({ playerId: ev.batterId, label: `${nm(ev.batterId)} (bateador)`, from: 'al bate', options: opts, initial: rec?.to ?? 'OUT' });
                }
                for (const b of [1, 2, 3] as const) {
                  const pid = prev.bases[b];
                  if (!pid || pid === ev.batterId) continue;
                  const rec = ev.advances.find((a) => a.playerId === pid);
                  rows.push({ playerId: pid, label: nm(pid), from: `en ${b}ª (se queda si marca ${b}ª)`, options: opts, initial: rec?.to ?? b });
                }
                setEditResult(ev.result);
                setEditPlay({ ev, rows });
                setSheetMenu(null);
              }}>✏️ Corregir jugada (avances/resultado)</button>
              <div className="ctx-sep" />
              <button onClick={() => setSheetMenu(null)}>Cerrar</button>
            </div>
          </>
        );
      })()}

      {/* clic derecho en la CELDA (fondo, no sobre una jugada): limpiarla completa
          o anotar directamente en ella (mismo destino que Alt+clic) */}
      {cellMenu && (() => {
        const { side, slot, col } = cellMenu;
        const cell = sheets[side].cells[slot]?.[col];
        const inn = sheets[side].colInning[col];
        const x = Math.min(cellMenu.x, window.innerWidth - 250);
        const y = Math.min(cellMenu.y, window.innerHeight - 140);
        return (
          <>
            <div className="ctx-back" onClick={() => setCellMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCellMenu(null); }} />
            <div className="ctx-menu" style={{ left: x, top: y }}>
              <div className="ctx-title">
                Casilla del {slot + 1}º · {inn}ª entrada {side === 'away' ? '↑' : '↓'} — {cell?.plays.length ?? 0} jugada(s)
              </div>
              <button className="danger" disabled={!cell?.plays.length} onClick={() => void clearCell()}>🧹 Limpiar celda completa</button>
              <div className="ctx-sep" />
              <button disabled={finished} onClick={() => { const c = { side, slot, col }; setCellMenu(null); setInsertCell(c); }}>✏️ Anotar en esta casilla</button>
              <button onClick={() => setCellMenu(null)}>Cerrar</button>
            </div>
          </>
        );
      })()}

      {/* Alt+clic izquierdo en una casilla → "Anotar en esta casilla":
          la jugada elegida se inserta en su lugar cronológico (sin mover otras) */}
      {insertCell && (
        <div className="modal-backdrop" onClick={() => setInsertCell(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <h2>Anotar en esta casilla</h2>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              {insertCell.slot + 1}º del orden · {sheets[insertCell.side].colInning[insertCell.col] ?? '—'}ª entrada ·{' '}
              {insertCell.side === 'away' ? (game.awayTeam?.name ?? 'Visitante') : (game.homeTeam?.name ?? 'Local')}
              — la jugada queda en su lugar del juego, no al final.
            </p>
            <div className="result-grid">
              {['1B', '2B', '3B', 'HR', 'BB', 'IBB', 'HBP', 'K', 'GO', 'FO', 'LO', 'PO', 'SAC', 'SF', 'DP', 'E', 'FC', 'RHB', 'OOT'].map((r) => (
                <button key={r} className="mid" onClick={() => openInsertPlay(r)}>{RESULT_LABEL[r] ?? r}</button>
              ))}
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.6rem' }}>
              <button className="secondary" onClick={() => setInsertCell(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {insertPlay && insertTarget && (
        <AdvanceModal
          title={`✏️ Anotar en casilla — ${insertTarget.inning}ª ${insertTarget.half === 'TOP' ? '↑' : '↓'} · ${RESULT_LABEL[insertPlay.result] ?? insertPlay.result}`}
          rows={insertPlay.rows}
          requireError={insertPlay.requireError}
          notationHint={insertPlay.notationHint}
          askTraj={insertPlay.askTraj}
          zoneOnly={insertPlay.zoneOnly}
          spray={insertPlay.spray && game?.league?.sprayInput !== false ? { result: insertPlay.result } : undefined}
          onConfirm={confirmInsert}
          onCancel={() => setInsertPlay(null)}
        />
      )}

      {showSub && (
        <SubModal game={game} state={effState!} events={events} currentPitcherId={pitcherId} currentBatterId={batter?.playerId}
          initialMode={subInitial}
          initialInId={subPlayerId ?? undefined}
          voiceText={voiceSubText ? voiceSubText.split('|').slice(1).join('|') : undefined}
          confirmSignal={subConfirm}
          onCancel={() => { setShowSub(false); setSubInitial(undefined); setSubPlayerId(null); }}
          onDone={(newPitcherId) => { setShowSub(false); setSubInitial(undefined); setSubPlayerId(null); if (newPitcherId) { setPitcherId(newPitcherId); pitcherTeam.current = fieldingTeamId ?? ''; } load(); }} />
      )}

      {showSummary && (
        <TeamSummary game={game} events={events} players={players} onClose={() => setShowSummary(false)} />
      )}

      {cardPlayerId && (
        <PlayerCardModal gameId={game.id} playerId={cardPlayerId} onClose={() => setCardPlayerId(null)} />
      )}
      {showConsulta && batter && (
        <ConsultaModal
          gameId={game.id}
          batterId={batter.playerId}
          pitcherId={pitcherId || 'none'}
          // situación en curso → la tabla de splits resalta las filas que aplican
          ctx={{
            outs: effState?.outs ?? 0,
            r1: !!effState?.bases?.[1], r2: !!effState?.bases?.[2], r3: !!effState?.bases?.[3],
            leadoff: !events.some((e) => e.half === effHalf && e.inning === effState?.inning && !isMidResult(e.result)),
            order: batter.order ?? null,
          }}
          onClose={() => setShowConsulta(false)}
        />
      )}

      {/* Menú Especial — estilo BallScore */}
      {showSpecial && (
        <div className="modal-backdrop" onClick={() => setShowSpecial(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Especial</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <button className="secondary" onClick={endInning}>⏹ Terminar entrada antes del 3er out</button>
              <button className="secondary" onClick={() => {
                setAdjOuts(effState?.outs ?? 0);
                setAdjBases([effState?.bases[1] ?? '', effState?.bases[2] ?? '', effState?.bases[3] ?? '']);
                setShowSpecial(false);
                setShowAdjust(true);
              }}>✎ Corredores, outs o resetear la entrada…</button>
              <button className="secondary" onClick={openDefense}>🧤 Defensa — tablero de posiciones… <kbd>D</kbd></button>
              <button className="secondary" onClick={() => { setShowSpecial(false); setPickMode('bat'); setShowBatterPick(true); }}>＋ Agregar bateador al orden (sin lineup)…</button>
              <button className="secondary" onClick={() => { setShowSpecial(false); setPickMode('field'); setShowBatterPick(true); }}>＋ Agregar fildeador al equipo que defiende…</button>
              <button className="secondary" onClick={() => { setShowSpecial(false); setShowLeft(true); }}>🚪 Jugador salió del estadio (auto-out)…</button>
              <button className="secondary" onClick={() => { setShowSpecial(false); void skipTurn(); }} disabled={!batter}>⤵ Pasar turno actual sin out (ausente/lesión)</button>
              <button className="secondary" onClick={swapSides}>⇄ Cambiar lados de equipos</button>
              <button className="secondary" onClick={changeSport}>
                {game.sport === 'softball' ? '⚾ Cambiar a baseball' : '🥎 Cambiar a softball'}
                <span className="muted" style={{ fontSize: '0.7rem' }}> ({game.sport === 'softball' ? '9' : '7'} entradas)</span>
              </button>
              {/* Ajuste de CI del bateador actual (Increment/Decrement RBI count) */}
              {batter && (
                <div className="row" style={{ alignItems: 'center' }}>
                  <span style={{ flex: 1, fontSize: '0.85rem' }}>CI de {labelOf(batter.playerId)}</span>
                  <button className="secondary" onClick={() => adjRbi(-1)} title="Restar una empujada">CI −1</button>
                  <button className="secondary" onClick={() => adjRbi(1)} title="Sumar una empujada">CI +1</button>
                </div>
              )}
              {/* Alternar merecida/inmerecida (Toggle Earned/Unearned run) */}
              <div className="row" style={{ alignItems: 'center' }}>
                <select value={euPitcher} onChange={(e) => setEuPitcher(e.target.value)} style={{ flex: 1 }}>
                  <option value="">— pitcher —</option>
                  {pitcherOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}{box.pitchers[p.id] ? ` (C ${box.pitchers[p.id].r} · CL ${box.pitchers[p.id].er})` : ''}
                    </option>
                  ))}
                </select>
                <button className="secondary" disabled={!euPitcher} onClick={() => toggleEU(false)} title="La carrera cuenta como merecida">CL</button>
                <button className="secondary" disabled={!euPitcher} onClick={() => toggleEU(true)} title="La carrera no cuenta como merecida">CI→inm.</button>
              </div>
              <div className="muted" style={{ fontSize: '0.85rem', marginTop: '0.3rem' }}>
                ⏱ Tiempo del juego: <strong>{clock}</strong>
              </div>
            </div>
            <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setShowSpecial(false)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {/* Ajuste manual: corredores en base + outs (registrar posición real tras corrección) */}
      {showAdjust && (
        <div className="modal-backdrop" onClick={() => setShowAdjust(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Corredores y outs</h2>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Fija el estado real de la entrada. Deja la base vacía para quitar al corredor.
            </p>
            {[0, 1, 2].map((i) => (
              <div className="row" key={i} style={{ marginBottom: '0.4rem' }}>
                <span style={{ width: 60 }}>{i + 1}ª base</span>
                <select value={adjBases[i]} style={{ flex: 1 }}
                  onChange={(e) => setAdjBases((b) => { const n = [...b] as typeof b; n[i] = e.target.value; return n; })}>
                  <option value="">— vacía —</option>
                  {battingLineup.map((l) => (
                    <option key={l.playerId} value={l.playerId}>{labelOf(l.playerId)}</option>
                  ))}
                </select>
              </div>
            ))}
            <div className="row">
              <span style={{ width: 60 }}>Outs</span>
              <select value={adjOuts} onChange={(e) => setAdjOuts(Number(e.target.value))}>
                {[0, 1, 2, 3].map((o) => <option key={o} value={o}>{o}{o === 3 ? ' (termina la entrada)' : ''}</option>)}
              </select>
            </div>
            <div className="row" style={{ marginTop: '1rem', justifyContent: 'space-between' }}>
              <button className="secondary" onClick={() => {
                setAdjBases(['', '', '']); setAdjOuts(0);
              }}>Resetear entrada</button>
              <span className="row" style={{ gap: '0.5rem' }}>
                <button className="secondary" onClick={() => setShowAdjust(false)}>Cancelar</button>
                <button className="big" onClick={confirmAdjust}>Aplicar</button>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Anotación al vuelo — transcribir la hoja completa de UN equipo de corrido */}
      {showFly && (
        <div className="modal-backdrop" onClick={() => setShowFly(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>⚡ Anotación al vuelo</h2>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Anota <strong>todas las jugadas de un equipo de corrido</strong>, entrada por entrada,
              sin que el juego te cambie al otro equipo. Ideal para compilar una hoja
              anotada sin estar en el estadio. Cuando termines, pasa al otro equipo con «⇄ Otro equipo».
            </p>
            <div className="section-label">Equipo que vas a transcribir</div>
            <div className="fly-team-pick">
              <button className={flyTeamId === game.awayTeamId ? 'big' : 'secondary'}
                onClick={() => { setFlyTeamId(game.awayTeamId); setFlyInning(suggestInning('TOP')); }}>
                ▲ {game.awayTeam?.name ?? 'Visitante'}
              </button>
              <button className={flyTeamId === game.homeTeamId ? 'big' : 'secondary'}
                onClick={() => { setFlyTeamId(game.homeTeamId); setFlyInning(suggestInning('BOTTOM')); }}>
                ▼ {game.homeTeam?.name ?? 'Local'}
              </button>
            </div>
            <div className="row" style={{ marginTop: '0.8rem', alignItems: 'center' }}>
              <span style={{ width: 110 }}>Empezar en la</span>
              <input type="number" min={1} max={Math.max(game.innings, 15)} value={flyInning}
                onChange={(e) => setFlyInning(Math.max(1, Number(e.target.value) || 1))}
                style={{ width: 70 }} />
              <span>ª entrada</span>
              <span className="muted" style={{ fontSize: '0.8rem' }}>(se sugiere la primera sin 3 outs)</span>
            </div>
            <div className="row" style={{ marginTop: '1rem', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button className="secondary" onClick={() => setShowFly(false)}>Cancelar</button>
              <button className="big" disabled={!flyTeamId} onClick={() => {
                setFly({
                  teamId: flyTeamId,
                  half: flyTeamId === game.awayTeamId ? 'TOP' : 'BOTTOM',
                  inning: flyInning,
                });
                setShowFly(false);
              }}>⚡ Comenzar</button>
            </div>
          </div>
        </div>
      )}

      {/* Defensa — tablero visual del terreno (atajo D). Los créditos E/PO/A se resuelven
          por posición al crear cada evento → mover a Jose de SS a 3B hace que E5 le caiga a él */}
      {showDefense && (
        <div className="modal-backdrop" onClick={() => setShowDefense(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760 }}>
            <h2>🧤 Defensa — {fieldingTeamId === game.awayTeamId ? game.awayTeam?.name : game.homeTeam?.name}</h2>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Reasigna posiciones del equipo que defiende. Las jugadas ya anotadas conservan sus créditos.
            </p>
            {fieldingLineup.length === 0 && (
              <button className="secondary" style={{ width: '100%', marginBottom: '0.6rem' }}
                onClick={() => { setPickMode('field'); setShowBatterPick(true); }}>
                ＋ El equipo defensor no tiene alineación — agregar fildeador del roster…
              </button>
            )}
            <DefenseBoard
              lineup={fieldingLineup}
              labelOf={labelOf}
              softball={game.sport === 'softball'}
              defMap={defMap}
              onChange={setDefMap}
            />
            <div className="row" style={{ marginTop: '1rem', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <button className="secondary" onClick={() => setShowDefense(false)}>Cancelar</button>
              <button className="big" onClick={saveDefense}>Aplicar defensa</button>
            </div>
          </div>
        </div>
      )}

      {/* Jugador que dejó el estadio sin sustituto (softball) — marca/regreso */}
      {showUndoLog && (
        <div className="modal-backdrop" onClick={() => setShowUndoLog(false)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <h2>↩ Deshacer desde una jugada</h2>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Toca «borrar desde aquí» en la jugada donde empezó el error: esa jugada y
              todas las posteriores se eliminan y el juego vuelve a ese punto.
            </p>
            <div style={{ maxHeight: 380, overflowY: 'auto' }}>
              <table style={{ fontSize: '0.85rem' }}>
                <thead><tr><th>#</th><th>Entrada</th><th>Bateador</th><th>Jugada</th><th /></tr></thead>
                <tbody>
                  {[...events].reverse().map((ev) => (
                    <tr key={ev.seq}>
                      <td className="muted">{ev.seq}</td>
                      <td>{ev.inning}°{ev.half === 'TOP' ? '↑' : '↓'}</td>
                      <td>{labelOf(ev.batterId)}</td>
                      <td><strong>{ev.notation ? `${RESULT_LABEL[ev.result] ?? ev.result} (${ev.notation})` : (RESULT_LABEL[ev.result] ?? ev.result)}</strong></td>
                      <td>
                        <button className="secondary" style={{ padding: '0 8px', fontSize: '0.78rem', color: 'var(--red)' }}
                          onClick={() => undoFrom(ev.seq)}>borrar desde aquí</button>
                      </td>
                    </tr>
                  ))}
                  {events.length === 0 && <tr><td colSpan={5} className="muted">Sin jugadas aún</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setShowUndoLog(false)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {showLeft && (
        <div className="modal-backdrop" onClick={() => setShowLeft(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>🚪 Jugador fuera del juego</h2>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Si un jugador se fue del estadio y no hay quien lo sustituya, márcalo aquí:
              cada vez que llegue su turno se registrará un <strong>auto-out</strong> y pasará
              al siguiente en el orden. Si regresa, tócalo de nuevo para reintegrarlo.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {[game.awayTeamId, game.homeTeamId].map((tid) => (
                <div key={tid}>
                  <div className="section-label">{tid === game.awayTeamId ? (game.awayTeam?.name ?? 'Visitante') : (game.homeTeam?.name ?? 'Local')}</div>
                  {battingOf(tid).map((l) => {
                    const out = leftPlayers.has(l.playerId);
                    return (
                      <button key={l.playerId} className="secondary"
                        style={{ textAlign: 'left', width: '100%', marginBottom: '0.3rem', borderColor: out ? 'var(--red)' : undefined, color: out ? 'var(--red)' : undefined }}
                        onClick={() => markLeft(l.playerId)}>
                        {out ? '↩ ' : ''}{l.order}. {labelOf(l.playerId)} — {out ? 'marcar regreso' : 'salió del juego'}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setShowLeft(false)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {/* "sin lineup": el jugador que llega a la caja/fila se agrega al orden.
          En modo bateo también sirve para cerrar la alineación (orden dio la vuelta). */}
      {showBatterPick && pickTeamId && (() => {
        const team = pickTeamId === game.awayTeamId ? game.awayTeam : game.homeTeam;
        const inLineup = new Set((game.lineups ?? []).filter((l) => l.teamId === pickTeamId && l.active).map((l) => l.playerId));
        const roster = (team?.players ?? []).filter((p) => p.active && !inLineup.has(p.id))
          .sort((a, b) => (a.number ?? 99) - (b.number ?? 99) || `${a.lastName}${a.firstName}`.localeCompare(`${b.lastName}${b.firstName}`));
        const luLen = (game.lineups ?? []).filter((l) => l.teamId === pickTeamId && l.active && l.batsInOrder !== false && l.order < 50).length;
        return (
          <div className="modal-backdrop" onClick={() => setShowBatterPick(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h2>{pickMode === 'bat' ? '¿Quién batea?' : '🧤 Agregar fildeador'} — {team?.name}</h2>
              <p className="muted" style={{ fontSize: '0.85rem' }}>
                {pickMode === 'bat'
                  ? `Tócalo y entra al orden como el #${luLen + 1}. Su posición sale de su ficha (se corrige después con 🧤 Defensa).`
                  : 'Agrégalo a la alineación del equipo que defiende — luego fija su posición con 🧤 Defensa.'}
              </p>
              <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {roster.map((p) => (
                  <button key={p.id} className="secondary" style={{ textAlign: 'left' }}
                    onClick={() => addToLineup(p.id, p.positions?.split(',')[0]?.trim() || 'EH')}>
                    {p.number ? <strong style={{ width: '2rem', display: 'inline-block' }}>#{p.number}</strong> : null}
                    {p.firstName} {p.lastName}
                    <span className="muted" style={{ marginLeft: 6, fontSize: '0.78rem' }}>{p.positions}</span>
                  </button>
                ))}
                {roster.length === 0 && <p className="muted">No quedan jugadores del roster fuera de la alineación.</p>}
              </div>
              {pickMode === 'bat' && luLen > 0 && (
                <button className="secondary" style={{ width: '100%', marginTop: '0.6rem' }}
                  onClick={() => { setLuTeam(pickTeamId, 'closed'); setShowBatterPick(false); }}
                  title="El orden ya giró: vuelve a batear el 1º — ya no se agregan más">
                  🔁 La alineación ya dio la vuelta — sigue con el 1º ({labelOf(battingLineup[0]?.playerId)})
                </button>
              )}
              <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'flex-end' }}>
                <button className="secondary" onClick={() => setShowBatterPick(false)}>Cerrar</button>
              </div>
            </div>
          </div>
        );
      })()}

      {showFinish && (
        <FinishModal game={game} players={players} events={events}
          onDone={() => { setShowFinish(false); load(); }}
          onCancel={() => setShowFinish(false)} />
      )}

      {pickGroup && (
        <div className="modal-backdrop" onClick={() => setPickGroup(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{PICKER_GROUPS.find((g) => g.key === pickGroup)!.label}</h2>
            <div className="result-grid">
              {PICKER_GROUPS.find((g) => g.key === pickGroup)!.results.map((r) => (
                <button key={r} className={PICKER_GROUPS.find((g) => g.key === pickGroup)!.cls}
                  onClick={() => { setPickGroup(null); openPlay(r); }}>
                  {RESULT_LABEL[r]}
                </button>
              ))}
            </div>
            <button className="secondary" style={{ marginTop: '0.8rem' }} onClick={() => setPickGroup(null)}>Cancelar</button>
          </div>
        </div>
      )}

      {/* 2ª fase del hit+error: quién cometió el error y a dónde llegó el bateador */}
      {errorPhase && (
        <div className="modal-backdrop">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{RESULT_LABEL[errorPhase.result]} — el error</h2>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Hit confirmado{errorPhase.hitNotation ? ` (${errorPhase.hitNotation})` : ''}. Ahora marca quién cometió el error:
            </p>
            <div className="notation-picker">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className={!/E\d/.test(errorToken) ? 'notation-hint' : 'muted'} style={{ fontSize: '0.8rem' }}>
                  Error de quién (ej. E5) — obligatorio
                </span>
                <strong className="notation-preview">{errorToken || '—'}</strong>
              </div>
              <div className="notation-chips">
                <button className="chip chip-e" onClick={() => setErrorToken((t) => (t ? `${t}-E` : 'E'))}>E<small>error</small></button>
                {FIELD_POS.map((c) => (
                  <button key={c.n} className="chip" title={c.pos}
                    onClick={() => setErrorToken((t) => addErrTok(t, String(c.n)))}>
                    {c.n}<small>{c.pos}</small>
                  </button>
                ))}
                <button className="chip chip-ghost" onClick={() => setErrorToken((t) => t.split('-').slice(0, -1).join('-'))}>⌫</button>
                <button className="chip chip-ghost" onClick={() => setErrorToken('')}>✕</button>
              </div>
            </div>
            <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.7rem' }}>El bateador llegó (por el error):</p>
            <div className="row">
              {(() => {
                const hitBase = errorPhase.result === '1BE' ? 1 : errorPhase.result === '2BE' ? 2 : 3;
                return ([1, 2, 3, 'HOME'] as AdvanceTo[]).filter((t) => t === 'HOME' || (t as number) >= hitBase).map((t) => (
                  <button key={String(t)} className={extraTo === t ? '' : 'secondary'} onClick={() => setExtraTo(t)}>
                    {t === 'HOME' ? 'anota' : t === hitBase ? `se queda en ${t}ª` : `a ${t}ª`}
                  </button>
                ));
              })()}
            </div>
            <div className="row" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setErrorPhase(null)}>Cancelar</button>
              <button className="big" disabled={!/E\d/.test(errorToken)} onClick={confirmHybrid}>Confirmar</button>
            </div>
          </div>
        </div>
      )}

      {showRunners && effState && (
        <RunnerMoveModal
          bases={effState.bases}
          labels={labels}
          onConfirm={confirmRunners}
          onCancel={() => setShowRunners(false)}
        />
      )}

      {/* resumen al cerrar la media entrada / final del juego */}
      {innSummary && (
        <div className="modal-backdrop" onClick={() => setInnSummary(null)}>
          <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: '0.4rem' }}>{innSummary.title}</h2>
            {innSummary.tally && (
              <div className="row" style={{ justifyContent: 'space-around', margin: '0.5rem 0', textAlign: 'center' }}>
                <div><div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{innSummary.tally.r}</div><div className="muted" style={{ fontSize: '0.72rem' }}>carreras</div></div>
                <div><div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{innSummary.tally.h}</div><div className="muted" style={{ fontSize: '0.72rem' }}>hits</div></div>
                <div><div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{innSummary.tally.e}</div><div className="muted" style={{ fontSize: '0.72rem' }}>errores</div></div>
                <div><div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{innSummary.tally.lob}</div><div className="muted" style={{ fontSize: '0.72rem' }}>dejados</div></div>
              </div>
            )}
            {innSummary.finalTotals && game && (
              <table style={{ width: '100%', margin: '0.5rem 0', textAlign: 'center' }}>
                <thead><tr><th></th><th>C</th><th>H</th><th>E</th><th>LOB</th></tr></thead>
                <tbody>
                  <tr><td style={{ textAlign: 'left' }}>{game.awayTeam?.shortName ?? 'Visitante'}</td>
                    <td><strong>{innSummary.finalTotals.away.r}</strong></td><td>{innSummary.finalTotals.away.h}</td><td>{innSummary.finalTotals.away.e}</td><td>{innSummary.finalTotals.away.lob}</td></tr>
                  <tr><td style={{ textAlign: 'left' }}>{game.homeTeam?.shortName ?? 'Local'}</td>
                    <td><strong>{innSummary.finalTotals.home.r}</strong></td><td>{innSummary.finalTotals.home.h}</td><td>{innSummary.finalTotals.home.e}</td><td>{innSummary.finalTotals.home.lob}</td></tr>
                </tbody>
              </table>
            )}
            <p style={{ textAlign: 'center', fontWeight: 800, fontSize: '1.1rem', margin: '0.4rem 0' }}>{innSummary.score}</p>
            {!!innSummary.next?.length && (
              <p className="muted" style={{ fontSize: '0.85rem', textAlign: 'center' }}>
                Próximos al bate: {innSummary.next.join(' · ')}
              </p>
            )}
            <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'flex-end' }}>
              <button className="big" onClick={() => setInnSummary(null)}>OK</button>
            </div>
          </div>
        </div>
      )}

      {/* corrección quirúrgica desde la planilla: una casilla sin borrar la entrada */}
      {editPlay && game && (
        <AdvanceModal
          title={`✏️ Corregir jugada #${editPlay.ev.seq} — ${editPlay.ev.inning}ª ${editPlay.ev.half === 'TOP' ? '↑' : '↓'}`}
          rows={editPlay.rows}
          defaultNotation={editPlay.ev.notation ?? ''}
          resultEdit={{
            value: editResult,
            onChange: setEditResult,
            options: [
              ...['1B', '2B', '3B', 'HR', 'HRIP', 'BB', 'IBB', 'HBP', 'K', 'KWP', 'KPB', 'E', 'FC',
                'GO', 'FO', 'LO', 'PO', 'IF', 'XF', 'SAC', 'SF', 'DP', 'TP', 'CI', 'RHB', 'OOT', 'AIL', 'FI', 'AO',
                '1BE', '2BE', '3BE']
                .map((v) => ({ v, l: `${RESULT_LABEL[v] ?? v} (${v})` })),
              ...['SB', 'CS', 'WP', 'PB', 'BK', 'PK', 'DI', 'DE', 'LIB', 'T', 'INT', 'OBS', 'EI']
                .map((v) => ({ v, l: `${RESULT_LABEL[v] ?? v} (${v})` })),
            ],
          }}
          onConfirm={async (advances, notation, spray) => {
            const ev = editPlay.ev;
            // "se queda": un corredor cuyo destino es su propia base no genera avance
            let prev = initialState();
            for (const e of events) { if (e.seq >= ev.seq) break; prev = applyEvent(prev, e, game.innings); }
            const fromOf = (pid: string): AdvanceTo => {
              for (const b of [1, 2, 3] as const) if (prev.bases[b] === pid) return b;
              return 'HOME';
            };
            const adv = advances.filter((a) => a.to !== fromOf(a.playerId));
            setEditPlay(null);
            try {
              await api.updateEvent(id!, ev.seq, {
                result: editResult !== ev.result ? editResult : undefined,
                notation: notation ?? null,
                advances: adv,
                ...(spray ? { sprayDir: spray.dir, sprayDist: spray.dist } : {}),
              });
              load();
            } catch (e) { setMsg((e as Error).message); }
          }}
          onCancel={() => setEditPlay(null)}
        />
      )}

      {pending && (
        <AdvanceModal
          title={pending.title ?? RESULT_LABEL[pending.result]}
          rows={pending.rows}
          requireError={pending.requireError}
          notationHint={pending.notationHint}
          askTraj={pending.askTraj}
          zoneOnly={pending.zoneOnly}
          defaultNotation={pending.preNotation}
          confirmSignal={confirmSignal}
          voiceNotation={voiceNotation}
          voiceAdvances={voiceAdvances ?? undefined}
          spray={pending.spray && game?.league?.sprayInput !== false ? { result: pending.result } : undefined}
          traps={pending.traps}
          onConfirm={confirmPlay}
          onCancel={() => { setPending(null); setVoiceNotation(''); setVoiceAdvances(null); }}
        />
      )}

      {showVoice && (
        <VoiceModal
          gameId={id}
          ctx={micCtx}
          onPick={(result, notation, aiVoice, aiJson, advances) => { setShowVoice(false); openPlay(result, { preNotation: notation, voice: aiVoice, json: aiJson, preAdvances: advances }); }}
          onCommand={(cmd) => { setShowVoice(false); void voiceCommand(cmd); }}
          onCancel={() => setShowVoice(false)}
        />
      )}

      {/* cola offline: lista las jugadas pendientes, reintenta o vacía */}
      {showQueue && (
        <div className="modal-backdrop" onClick={() => setShowQueue(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <h2>📤 Jugadas en cola ({queued})</h2>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Jugadas guardadas mientras no había conexión al servidor. Súbelas con «Reintentar»
              o vacíalas si ya no corresponden al juego real.
            </p>
            <div style={{ maxHeight: '40vh', overflow: 'auto', marginBottom: '0.6rem' }}>
              {queueItems().map((q, i) => {
                const p = q.payload as { result?: string; notation?: string | null; inning?: number; half?: string };
                return (
                  <div key={i} className="row" style={{ fontSize: '0.85rem', borderBottom: '1px solid var(--line)', padding: '0.3rem 0' }}>
                    <span style={{ width: '1.5rem' }} className="muted">{i + 1}.</span>
                    <span><b>{p.result ?? '?'}</b>{p.notation ? ` (${p.notation})` : ''}{p.inning ? ` · ${p.inning} ${p.half === 'TOP' ? '↑' : '↓'}` : ''}</span>
                    <span className="spacer" />
                    <span className="muted" style={{ fontSize: '0.75rem' }}>{new Date(q.queuedAt).toLocaleString()}</span>
                  </div>
                );
              })}
              {queueItems().length === 0 && <p className="muted">Cola vacía.</p>}
            </div>
            <div className="row" style={{ gap: '0.5rem' }}>
              <button disabled={syncing} onClick={async () => {
                setSyncing(true);
                try {
                  const sent = await flushQueue();
                  setQueued(pendingCount()); load();
                  if (!pendingCount()) setShowQueue(false);
                  setMsg(`✓ ${sent} jugada(s) subidas`);
                } catch (e) { setMsg((e as Error).message); }
                finally { setSyncing(false); }
              }}>{syncing ? 'Subiendo…' : '↻ Reintentar ahora'}</button>
              <button className="danger" onClick={() => {
                if (confirm(`¿Vaciar la cola? Se pierden las ${queued} jugadas pendientes (no se pueden recuperar).`)) {
                  clearQueue(); setQueued(0); setShowQueue(false); setMsg('Cola vaciada');
                }
              }}>🗑 Vaciar cola</button>
              <button className="secondary" onClick={() => setShowQueue(false)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {/* toast del narrador IA */}
      {narration && (
        <div className="ai-narration" onClick={() => { setNarration(''); speechSynthesis?.cancel(); }}>
          🗣 {narration}
        </div>
      )}

      {/* panel de stats avanzadas en vivo */}
      {showInsights && !insights && <div className="card" style={{ marginTop: '0.5rem' }}><p className="muted">📊 Calculando stats…</p></div>}
      {showInsights && insights && (
        <div className="card" style={{ marginTop: '0.5rem' }}>
          <div className="row" style={{ marginBottom: '0.3rem' }}>
            <span className="section-label" style={{ margin: 0 }}>📊 Stats en vivo</span>
            <span className="spacer" />
            <button className="secondary icon" onClick={() => setShowInsights(false)}>✕</button>
          </div>
          <div className="insights-grid">
            <div>
              <div className="muted" style={{ fontSize: '0.75rem' }}>Probabilidad de ganar</div>
              <div className="insight-win">
                <span>{game.awayTeam?.name ?? 'Vis'} {insights.winProb.away}%</span>
                <span>{insights.winProb.home}% {game.homeTeam?.name ?? 'Loc'}</span>
              </div>
            </div>
            {insights.batter && (
              <div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>Al bate: {insights.batter.name}</div>
                {insights.batter.risp && <div>RISP: {insights.batter.risp.h}-{insights.batter.risp.ab} ({insights.batter.risp.ab ? (insights.batter.risp.h / insights.batter.risp.ab).toFixed(3) : '.000'})</div>}
                {insights.batter.vsPitcher && <div>vs pitcher: {insights.batter.vsPitcher.h}-{insights.batter.vsPitcher.ab}</div>}
              </div>
            )}
            {insights.pitcher && (
              <div>
                <div className="muted" style={{ fontSize: '0.75rem' }}>Lanzando: {insights.pitcher.name}</div>
                <div>{insights.pitcher.pitches} lanzamientos{insights.pitcher.pitches >= 85 ? ' — ⚠ considerar relevo' : ''}</div>
              </div>
            )}
          </div>
          {insights.insight && <div className="ai-insight">💡 {insights.insight}</div>}
          <button className="secondary sm" style={{ marginTop: '0.4rem' }}
            onClick={async () => { try { setInsights(await api.aiInsights(id!)); } catch { /* noop */ } }}>↻ Actualizar</button>
        </div>
      )}

      {showKeys && (
        <div className="modal-backdrop" onClick={() => setShowKeys(false)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <h2 style={{ marginTop: 0 }}>⌨ Atajos de teclado</h2>
            <div className="keys-grid">
              <div>
                <h3>Conteo (pitch a pitch)</h3>
                <table className="keys"><tbody>
                  <tr><td><kbd>B</kbd></td><td>Bola</td></tr>
                  <tr><td><kbd>S</kbd></td><td>Strike</td></tr>
                  <tr><td><kbd>F</kbd></td><td>Foul</td></tr>
                </tbody></table>
                <h3>En base</h3>
                <table className="keys"><tbody>
                  <tr><td><kbd>W</kbd></td><td>Base por bolas</td></tr>
                  <tr><td><kbd>I</kbd></td><td>Base x bolas intencional (IBB)</td></tr>
                  <tr><td><kbd>P</kbd></td><td>Golpeado (HBP)</td></tr>
                  <tr><td><kbd>E</kbd></td><td>Error</td></tr>
                  <tr><td><kbd>X</kbd></td><td>Jugada de selección (FC)</td></tr>
                </tbody></table>
                <h3>Corredores</h3>
                <table className="keys"><tbody>
                  <tr><td><kbd>A</kbd></td><td>Robo de base (SB)</td></tr>
                  <tr><td><kbd>C</kbd></td><td>Atrapado robando (CS)</td></tr>
                </tbody></table>
              </div>
              <div>
                <h3>Hits</h3>
                <table className="keys"><tbody>
                  <tr><td><kbd>1</kbd></td><td>Sencillo</td></tr>
                  <tr><td><kbd>2</kbd></td><td>Doble</td></tr>
                  <tr><td><kbd>3</kbd></td><td>Triple</td></tr>
                  <tr><td><kbd>4</kbd> / <kbd>H</kbd></td><td>Jonrón</td></tr>
                </tbody></table>
                <h3>Outs en jugada</h3>
                <table className="keys"><tbody>
                  <tr><td><kbd>K</kbd></td><td>Ponche</td></tr>
                  <tr><td><kbd>R</kbd></td><td>Rola (GO)</td></tr>
                  <tr><td><kbd>V</kbd></td><td>Elevado (FO)</td></tr>
                  <tr><td><kbd>L</kbd></td><td>Línea (LO)</td></tr>
                  <tr><td><kbd>O</kbd></td><td>Doble play</td></tr>
                  <tr><td><kbd>T</kbd></td><td>Toque / sacrificio (SAC)</td></tr>
                  <tr><td><kbd>Y</kbd></td><td>Fly de sacrificio (SF)</td></tr>
                </tbody></table>
                <h3>Utilidades</h3>
                <table className="keys"><tbody>
                  <tr><td><kbd>U</kbd></td><td>Deshacer última jugada</td></tr>
                  <tr><td><kbd>D</kbd></td><td>Defensa — tablero de posiciones</td></tr>
                  <tr><td><kbd>Shift</kbd>+<kbd>I</kbd></td><td>Consulta (bateador vs lanzador)</td></tr>
                  <tr><td><kbd>Shift</kbd>+<kbd>L</kbd></td><td>Resumen del juego</td></tr>
                  <tr><td><kbd>?</kbd></td><td>Esta ayuda</td></tr>
                  <tr><td><kbd>Esc</kbd></td><td>Cerrar ventana / cancelar</td></tr>
                </tbody></table>
              </div>
            </div>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Los atajos solo actúan con el juego en vivo y sin ventana abierta; no aplican mientras escribes en un campo.
            </p>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => setShowKeys(false)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
      {taken && (
        <div className="modal-backdrop" style={{ zIndex: 2000 }}>
          <div className="modal" style={{ maxWidth: 380, textAlign: 'center' }}>
            <h2>🚫 Anotando en otra ventana</h2>
            <p className="muted">
              Este juego ya está abierto en otra pestaña o ventana. Solo una puede
              anotar a la vez — así no se duplican jugadas ni se pelea el reloj.
            </p>
            <button onClick={() => { setTaken(false); claimScore(); }}>
              Anotar en esta ventana
            </button>
          </div>
        </div>
      )}
      {msg && <div className="flash" onClick={() => setMsg('')}>{msg}</div>}
    </div>
  );
}
