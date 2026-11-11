import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import MicCtx, { type MicCtxData } from './MicCtx';
import { cmdText, isConfirm, UNDO_RE, BACK_RE, REPEAT_RE } from '../lib/voiceCmd';

type SRResult = { isFinal: boolean; 0: { transcript: string } };
type SREvent = { resultIndex: number; results: { [i: number]: SRResult; length: number } };
type SR = {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void;
  onresult: ((e: SREvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
};

export type VoiceCmd =
  | { type: 'CONFIRM' }
  | { type: 'UNDO' }   // «deshacer» — descarta lo abierto o revierte si no hay nada
  | { type: 'BACK' }   // «volver» — revierte SIEMPRE la última jugada anotada
  | { type: 'PC' | 'RL'; pitcherId?: string | null; pitcherName?: string | null }
  | { type: 'SUB' | 'CR'; playerId?: string | null; playerName?: string | null }; // bateador/corredor emergente

interface Props {
  gameId?: string;
  // jugada interpretada lista para confirmar (abre el AdvanceModal prellenado)
  onPick: (result: string, notation: string | null, aiVoice: string, aiJson: string, advances?: { playerId: string; to: number | 'HOME' | 'OUT' }[]) => void;
  // comandos hablados: "confirmar" graba la jugada abierta, "deshacer" revierte,
  // "cambio lanzador X" / "reingresa X" → cambio de pitcher
  onCommand?: (cmd: VoiceCmd) => void;
  blocked: boolean;                  // modal de jugada abierto o sin bateador — escucha pero no dispara jugadas
  // texto hablado mientras está bloqueado (modal abierto): para elegir nombres
  // por voz dentro del modal de sustitución
  onVoiceText?: (t: string) => void;
  onStatus?: (msg: string) => void;
  // contexto del juego para el panel: quién lanza, quién batea, corredores en base
  ctx?: MicCtxData;
}

// comandos hablados: vocabulario compartido en ../lib/voiceCmd.ts
// (confirmar → graba · deshacer → ↩ · repite → relee la última jugada)

/**
 * Anotación al vuelo: el mic queda ABIERTO escuchando de forma continua.
 * Cada frase final se interpreta (IA o diccionario local) y, si produce una
 * jugada, se abre el modal de avance prellenado — el anotador solo confirma.
 * Comandos de voz: "confirmar"→graba · "deshacer"→↩ · "cambio lanzador X"→PC ·
 * "reingresa X"→reingreso. El panel muestra P/bateador y el diamante con nombres.
 * - Web Speech API (continuous + interim) donde exista (Chrome/Edge).
 * - Si no (LibreWolf/Firefox): bucle MediaRecorder ~4.5s → Whisper.
 * - Si hay un modal abierto (blocked) sigue oyendo comandos pero no abre jugadas.
 */
export default function LiveMic({ gameId, onPick, onCommand, blocked, onStatus, ctx, onVoiceText }: Props) {
  const [on, setOn] = useState(false);
  const [interim, setInterim] = useState('');
  const [err, setErr] = useState('');
  const [last, setLast] = useState(''); // última jugada interpretada (para "repite")
  const onRef = useRef(false);
  const blockedRef = useRef(blocked);
  const lastRef = useRef('');
  const recRef = useRef<SR | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // handlers de SR se atan UNA vez — sin refs leen props de un render viejo
  // (pending=undefined para siempre → "confirmar" se descartaba en silencio)
  const onPickRef = useRef(onPick);
  const onCommandRef = useRef(onCommand);
  const onStatusRef = useRef(onStatus);
  const onVoiceTextRef = useRef(onVoiceText);
  const gameIdRef = useRef(gameId);
  const recGen = useRef(0);   // generación de la sesión SR — los handlers viejos se auto-ignoran
  // ---- push-to-talk: mantén ⇧ IZQUIERDO → habla → suelta → interpreta ----
  // Cada pulsación crea una sesión de reconocimiento NUEVA y al soltar se
  // descarta — el servicio se reinicia por frase: no hay buffer que se llene
  // ni sesión continua que se "canse" (era la causa del mic colgado).
  const pttDown = useRef(false);
  const pttFin = useRef('');    // texto final acumulado de la pulsación
  const pttInter = useRef('');  // texto parcial (por si se suelta sin resultado final)
  const mrRef = useRef<MediaRecorder | null>(null);
  const [talking, setTalking] = useState(false);
  const [busy, setBusy] = useState(false);     // interpretando lo dictado
  const pressAt = useRef(0);                  // inicio de la pulsación del botón
  const lastTimer = useRef<number | undefined>(undefined);

  useEffect(() => { blockedRef.current = blocked; }, [blocked]);
  useEffect(() => {
    onPickRef.current = onPick;
    onCommandRef.current = onCommand;
    onStatusRef.current = onStatus;
    onVoiceTextRef.current = onVoiceText;
    gameIdRef.current = gameId;
  });
  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const commandOf = (txt: string): VoiceCmd | null => {
    const t = cmdText(txt);
    if (isConfirm(t)) return { type: 'CONFIRM' };
    if (BACK_RE.test(t)) return { type: 'BACK' };
    if (UNDO_RE.test(t)) return { type: 'UNDO' };
    return null;
  };

  const showLast = (d: string) => {
    setLast(d); lastRef.current = d;
    window.clearTimeout(lastTimer.current);
    // sin modo permanente armado, el panel se cierra solo tras mostrar el resultado
    lastTimer.current = window.setTimeout(() => setLast((l) => (l === d ? '' : l)), 8000);
  };

  const analyze = async (t: string) => {
    const txt = t.trim();
    if (!txt) return;
    setBusy(true);
    try { await analyzeInner(txt); }
    finally { setBusy(false); }
  };

  const analyzeInner = async (txt: string) => {
    // los comandos funcionan AUNQUE haya modal abierto ("confirmar" es para eso)
    const cmd = commandOf(txt);
    if (cmd) { onCommandRef.current?.(cmd); return; }
    if (REPEAT_RE.test(cmdText(txt))) {
      if (lastRef.current) onStatusRef.current?.(`🔁 ${lastRef.current}`);
      else onStatusRef.current?.('Todavía no he interpretado ninguna jugada');
      return;
    }
    // modal abierto: no dispara jugadas, pero el texto crudo sigue arriba —
    // el modal de sustitución lo usa para elegir al jugador por voz
    if (blockedRef.current) { onVoiceTextRef.current?.(txt); return; }
    try {
      const s = await api.aiNotation(txt, gameIdRef.current);
      if (s?.action) {
        // comando de lanzador o sustitución resuelto en el server
        if (s.note) onStatusRef.current?.(`⚠ ${s.note}`);
        if (s.action === 'SUB' || s.action === 'CR') {
          onCommandRef.current?.({ type: s.action, playerId: s.playerId, playerName: s.playerName });
          const d = `${s.action === 'CR' ? '🏃 Corredor emergente' : '🏏 Bateador emergente'}${s.playerName ? `: ${s.playerName}` : ''}`;
          showLast(d);
        } else {
          onCommandRef.current?.({ type: s.action, pitcherId: s.pitcherId, pitcherName: s.pitcherName });
          if (s.pitcherName) {
            const d = `${s.action === 'RL' ? '↺ Reingresa a lanzar' : '⚾ Cambio de lanzador'}: ${s.pitcherName}`;
            showLast(d);
          }
        }
        return;
      }
      if (s?.result && !blockedRef.current) {
        if (s.note) onStatusRef.current?.(`⚠ ${s.note}`);
        const adv = (s.advances ?? []).map((a) => `${a.via} → ${a.to === 'HOME' ? 'anota' : a.to === 'OUT' ? 'out' : `${a.to}ª`}`).join(' · ');
        const d = `${s.ai?.description_spanish ?? s.result}${adv ? ` — ${adv}` : ''}`;
        showLast(d);
        onPickRef.current(s.result, s.notation, txt, JSON.stringify({ ...(s.ai ?? {}), advances: s.advances }), s.advances);
      }
    } catch { /* frase no reconocida → sigue escuchando sin ruido */ }
  };

  const blobToB64 = (blob: Blob) => new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });

  // ---- PTT inicio: sesión NUEVA por pulsación (SR o MediaRecorder→Whisper) ----
  const talkStart = async () => {
    setErr(''); setInterim('');
    pttFin.current = ''; pttInter.current = '';
    const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    if (w.SpeechRecognition ?? w.webkitSpeechRecognition) {
      const rec = new (w.SpeechRecognition ?? w.webkitSpeechRecognition)!();
      const gen = ++recGen.current;
      rec.lang = 'es-DO'; rec.continuous = true; rec.interimResults = true;
      rec.onresult = (e) => {
        if (recGen.current !== gen) return;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) pttFin.current += r[0].transcript; else pttInter.current = r[0].transcript;
        }
        setInterim(pttInter.current || pttFin.current);
      };
      rec.onend = () => { /* la sesión muere con la pulsación — la próxima crea otra */ };
      rec.onerror = (e) => {
        if (recGen.current !== gen) return;
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { setErr('Mic bloqueado — permite el acceso'); stop(); }
        else if (e.error && e.error !== 'no-speech' && e.error !== 'aborted') setErr(`Dictado: ${e.error}`);
      };
      recRef.current = rec;
      try { rec.start(); } catch { /* noop */ }
      return;
    }
    // sin Speech API (LibreWolf/Firefox): graba mientras la tecla/botón esté abajo → Whisper
    try {
      if (!streamRef.current) streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const mr = new MediaRecorder(streamRef.current, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      const startedAt = Date.now();
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = async () => {
        // toque corto: clip diminuto — transcribirlo solo devuelve ruido
        if (Date.now() - startedAt < 350) return;
        try {
          const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
          const t = await api.aiTranscribe(await blobToB64(blob), blob.type);
          if (t.transcript) await analyze(t.transcript);
        } catch (e) { setErr((e as Error).message); }
      };
      mrRef.current = mr;
      // soltó el botón antes de que el mic respondiera → no empezar
      if (!pttDown.current) { mrRef.current = null; return; }
      mr.start();
    } catch { setErr('Sin permiso de micrófono'); }
  };

  // ---- PTT fin: cierra la sesión y procesa lo que quedó ----
  const talkEnd = () => {
    if (recRef.current) {
      const rec = recRef.current;
      recGen.current++; // invalida resultados tardíos de esta sesión
      try { rec.stop(); } catch { /* noop */ }
      recRef.current = null;
      const fin = (pttFin.current + ' ' + pttInter.current).trim();
      pttFin.current = ''; pttInter.current = ''; setInterim('');
      if (fin) void analyze(fin);
    }
    if (mrRef.current) {
      try { if (mrRef.current.state === 'recording') mrRef.current.stop(); } catch { /* noop */ }
      mrRef.current = null;
    }
  };

  // tecla mantenida: SHIFT IZQUIERDO — antes era ESPACIO pero el navegador
  // hace scroll de página con la barra (los keydown repetidos al mantenerla
  // se saltaban el preventDefault); ⇧ no desplaza nada ni choca con atajos
  useEffect(() => {
    if (!on) return;
    const isPtt = (e: KeyboardEvent) => e.code === 'ShiftLeft';
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return;
      if (!isPtt(e) || e.repeat || pttDown.current) return;
      e.preventDefault();
      pttDown.current = true; setTalking(true);
      void talkStart();
    };
    const up = (e: KeyboardEvent) => {
      if (!isPtt(e) || !pttDown.current) return;
      e.preventDefault();
      pttDown.current = false; setTalking(false);
      talkEnd();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);

  const start = () => {
    setErr(''); setInterim('');
    onRef.current = true; setOn(true);
    onStatusRef.current?.('👂 Al vuelo — mantén el botón o ⇧ IZQUIERDO y habla · suelta para interpretar · "confirmar" graba');
  };

  function stop() {
    onRef.current = false; setOn(false); setInterim('');
    window.clearTimeout(lastTimer.current); setLast(''); lastRef.current = '';
    pttDown.current = false; setTalking(false); setBusy(false);
    recGen.current++;
    try { recRef.current?.stop(); } catch { /* noop */ }
    recRef.current = null;
    try { if (mrRef.current?.state === 'recording') mrRef.current.stop(); } catch { /* noop */ }
    mrRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  // ---- el BOTÓN es push-to-talk: mantener = grabar · soltar = interpretar ----
  // (un toque corto <400ms solo alterna el modo permanente con ⇧ IZQUIERDO)
  const pressDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    pressAt.current = Date.now();
    if (pttDown.current) return;
    pttDown.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
    setTalking(true);
    void talkStart();
  };
  const pressUp = () => {
    if (!pttDown.current) return;
    pttDown.current = false;
    setTalking(false);
    talkEnd();
  };
  const clickToggle = () => {
    if (Date.now() - pressAt.current > 400) return; // fue mantener, no un toque
    setErr('');
    if (on) stop(); else start();
  };

  return (
    <>
      <button
        className={talking ? 'danger' : on ? 'danger' : 'secondary'}
        style={{ flex: 1, fontWeight: 700, touchAction: 'none', userSelect: 'none' }}
        title="Mantén presionado y habla — al soltar se interpreta la jugada · un toque corto activa el modo ⇧ IZQUIERDO"
        onPointerDown={pressDown}
        onPointerUp={pressUp}
        onPointerCancel={pressUp}
        onClick={clickToggle}
        onContextMenu={(e) => e.preventDefault()}
      >
        {talking ? '🎙 Suelta para interpretar' : on ? '👂 ⇧ activo' : '🎙 Mantén p/ hablar'}
      </button>
      {(on || talking || busy || last || err) && (
        <div className="livemic-panel" onClick={() => { stop(); setErr(''); }} title={on ? 'Toca para detener' : 'Toca para cerrar'}>
          <div className="livemic-close" title="Cerrar">✕</div>
          <MicCtx batter={ctx?.batter} pitcher={ctx?.pitcher} bases={ctx?.bases} />
          <div className="livemic-chip-inner">
            {err ? `⚠ ${err} — toca para cerrar`
              : busy ? '⏳ interpretando…'
              : talking ? `🎙 ${interim || 'habla…'}`
              : on ? '⏸ mantén el botón o ⇧ IZQUIERDO y habla — suelta para interpretar'
              : ''}
          </div>
          {last && !err && <div className="livemic-last">✓ {last}</div>}
          {!err && (
            <div className="livemic-hint">
              mantén el botón o ⇧ IZQUIERDO · «confirmar» graba · «deshacer» descarta · «volver» revierte · «cambio lanzador + nombre»
            </div>
          )}
        </div>
      )}
    </>
  );
}
