import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { RESULT_LABEL } from '../lib/labels';
import MicCtx, { type MicCtxData } from './MicCtx';
import { cmdText, isConfirm, CORRECT_RE } from '../lib/voiceCmd';
import type { VoiceCmd } from './LiveMic';

interface Suggestion {
  result?: string; notation: string | null;
  advances?: { playerId: string; to: number | 'HOME' | 'OUT'; via: string }[];
  batterId?: string | null; playerNames?: string[]; note?: string;
  ai: { play_code: string; runs_scored: number; outs_made: number | null; description_spanish: string };
  source: string;
  // comandos que no son jugada: cambio/reingreso de lanzador, emergentes
  action?: 'PC' | 'RL' | 'SUB' | 'CR';
  pitcherId?: string | null; pitcherName?: string | null; playerName?: string | null;
}
interface Props {
  gameId?: string;
  ctx?: MicCtxData;
  onPick: (result: string, notation: string | null, aiVoice: string, aiJson: string, advances?: { playerId: string; to: number | 'HOME' | 'OUT' }[]) => void;
  // comandos que no son jugada (lanzador/emergente) — van por voiceCommand
  onCommand?: (cmd: VoiceCmd) => void;
  onCancel: () => void;
}

type SR = {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void;
  onresult: ((e: { results: { [i: number]: { [j: number]: { transcript: string } } } }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
};

type MicState = 'idle' | 'asking' | 'ready' | 'denied' | 'insecure';

/**
 * Anotar por voz: al abrir pide el micrófono y empieza a escuchar.
 * - Web Speech API (es-DO) si el navegador la tiene (Chrome/Edge, localhost o HTTPS).
 * - Si no, graba con MediaRecorder y transcribe por Whisper (necesita OPENAI_API_KEY).
 * - ⚙️ Configurar: pide permiso explícito y deja elegir la entrada de audio.
 */
export default function VoiceModal({ gameId, ctx, onPick, onCommand, onCancel }: Props) {
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [sugg, setSugg] = useState<Suggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [mic, setMic] = useState<MicState>('idle');
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState(() => localStorage.getItem('pox-mic') ?? '');
  const [showCfg, setShowCfg] = useState(false);
  const [recording, setRecording] = useState(false);
  const [aiOn, setAiOn] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [keyMsg, setKeyMsg] = useState('');
  const recRef = useRef<SR | null>(null);
  const mrRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // refs: los handlers de SR/Whisper se atan a la render vieja — sin ref leen sugg/transcript stale
  const suggRef = useRef<Suggestion | null>(null);
  const txRef = useRef('');
  const micOkRef = useRef(false); // true cuando el mic ya está concedido
  const onPickRef = useRef(onPick);
  const onCmdRef = useRef(onCommand);
  const gameIdRef = useRef(gameId);
  useEffect(() => { suggRef.current = sugg; onPickRef.current = onPick; onCmdRef.current = onCommand; gameIdRef.current = gameId; });

  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  const SR_Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  const srSupported = !!SR_Ctor;
  const secure = window.isSecureContext;

  useEffect(() => {
    // al abrir: el clic en "🎤 Voz" es gesto de usuario — pide el mic y arranca
    void ensureMic().then((ok) => { if (ok) startListening(); });
    return () => { try { recRef.current?.stop(); } catch { /* noop */ } streamRef.current?.getTracks().forEach((t) => t.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ensureMic = async (useSaved = true): Promise<boolean> => {
    if (!secure) { setMic('insecure'); return false; }
    if (!navigator.mediaDevices?.getUserMedia) { setMic('denied'); return false; }
    setMic('asking');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: useSaved && micId ? { deviceId: { exact: micId } } : true,
      });
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = stream;
      setMic('ready'); micOkRef.current = true;
      const list = await navigator.mediaDevices.enumerateDevices();
      setMics(list.filter((d) => d.kind === 'audioinput'));
      return true;
    } catch {
      // deviceId guardado obsoleto (incógnito anonimiza ids por sesión) → reintenta con el por defecto
      if (useSaved && micId) {
        setMicId(''); localStorage.removeItem('pox-mic');
        return ensureMic(false);
      }
      setMic('denied');
      return false;
    }
  };

  const pickMic = async (deviceId: string) => {
    setMicId(deviceId);
    localStorage.setItem('pox-mic', deviceId);
    await ensureMic();
  };

  // tras interpretar una jugada el mic vuelve a escuchar UN turno esperando
  // «confirmar»/«corregir» — no hace falta tocar Hablar otra vez
  const awaitCmdRef = useRef(false);

  const startListening = (forCmd = false) => {
    if (srSupported) {
      const rec = new SR_Ctor!();
      rec.lang = 'es-DO'; rec.continuous = false; rec.interimResults = false;
      rec.onresult = (e) => { const t = e.results[0]?.[0]?.transcript ?? ''; if (t) { setTranscript(t); analyze(t); } };
      rec.onend = () => setListening(false);
      rec.onerror = (e) => {
        setListening(false);
        // silencio esperando «confirmar» → se calla sin ruido de error
        if (e.error === 'no-speech' && awaitCmdRef.current) { awaitCmdRef.current = false; return; }
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setErr('Micrófono bloqueado — toca ⚙️ Configurar y permite el acceso');
        else if (e.error === 'no-speech') setErr('No escuché nada — intenta de nuevo');
        else if (e.error === 'network' || e.error === 'audio-capture' || e.error === 'language-not-supported') {
          // el dictado del navegador necesita internet (Google) — cae a grabar + Whisper
          setErr('El dictado del navegador falló — grabando para Whisper…');
          void startRecording();
        } else if (e.error) setErr(`Dictado: ${e.error}`);
      };
      recRef.current = rec;
      setErr('');
      if (!forCmd) setSugg(null); // nueva jugada → sugerencia vieja fuera; modo comando la conserva
      setListening(true);
      rec.start();
      return;
    }
    // sin Speech API → MediaRecorder + Whisper
    void startRecording();
  };

  const startRecording = async () => {
    if (!streamRef.current) { if (!(await ensureMic())) return; }
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    const mr = new MediaRecorder(streamRef.current!, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      setRecording(false);
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
      setBusy(true);
      try {
        const b64 = await new Promise<string>((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result).split(',')[1]);
          fr.onerror = rej;
          fr.readAsDataURL(blob);
        });
        const t = await api.aiTranscribe(b64, blob.type);
        setTranscript(t.transcript);
        if (t.transcript) analyze(t.transcript);
      } catch (e) { setErr((e as Error).message); }
      finally { setBusy(false); }
    };
    mrRef.current = mr;
    setErr(''); setSugg(null);
    setRecording(true);
    mr.start();
    setTimeout(() => { try { mr.state === 'recording' && mr.stop(); } catch { /* noop */ } }, 6000);
  };

  // "confirmar/graba/dale" con sugerencia abierta = tocar ✓ Confirmar;
  // "corregir/otra vez" = ↺ Corregir. Así la voz completa el flujo sin botones.
  const confirmSugg = () => {
    const s = suggRef.current;
    if (!s) return;
    // comando (lanzador/emergente) → ruta de comando, no jugada
    if (s.action) {
      onCmdRef.current?.(s.action === 'SUB' || s.action === 'CR'
        ? { type: s.action, playerName: s.playerName }
        : { type: s.action, pitcherId: s.pitcherId, pitcherName: s.pitcherName });
      return;
    }
    if (!s.result) return;
    onPickRef.current(s.result, s.notation, txRef.current, JSON.stringify({ ...s.ai, advances: s.advances }), s.advances);
  };

  const analyze = async (t: string) => {
    if (!t.trim()) return;
    awaitCmdRef.current = false;
    txRef.current = t;
    const cmd = cmdText(t);
    if (suggRef.current && isConfirm(cmd)) { confirmSugg(); return; }
    if (suggRef.current && CORRECT_RE.test(cmd)) { setSugg(null); setTranscript(''); return; }
    if (isConfirm(cmd)) { setErr('No hay jugada interpretada — dicta la jugada primero'); return; }
    setBusy(true); setErr(''); setSugg(null);
    try {
      const s = await api.aiNotation(t, gameIdRef.current);
      setSugg(s);
      // jugada interpretada → escucha «confirmar»/«corregir» sin tocar nada
      if ((s?.result || s?.action) && srSupported && micOkRef.current) { awaitCmdRef.current = true; startListening(true); }
    }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const active = listening || recording;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>🎤 Anotar por voz</h2>
        {ctx && (
          <div className="voice-ctxbar">
            <MicCtx batter={ctx.batter} pitcher={ctx.pitcher} bases={ctx.bases} />
          </div>
        )}
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Habla normal: <i>«rolling por segunda»</i> · <i>«hit por el right»</i> · <i>«ponche tirándole»</i> · <i>«se fue»</i>
        </p>

        {/* estado del micrófono */}
        {mic === 'insecure' && (
          <p style={{ color: 'var(--red)', fontSize: '0.85rem' }}>
            ⚠ El micrófono solo funciona en <b>localhost</b> o con <b>HTTPS</b> — estás en una IP sin seguridad.
            Usa el dictado escrito abajo.
          </p>
        )}
        {mic === 'denied' && (
          <p style={{ color: 'var(--red)', fontSize: '0.85rem' }}>
            ⚠ Micrófono sin permiso. Toca <b>⚙️ Configurar micrófono</b> y acepta el permiso del navegador
            (ícono 🔒/🎤 en la barra de direcciones).
          </p>
        )}

        <div className="row" style={{ justifyContent: 'center', gap: '0.6rem', margin: '0.6rem 0', flexWrap: 'wrap' }}>
          <button className={active ? 'danger' : ''} style={{ fontSize: '1.05rem', padding: '0.7rem 1.2rem' }}
            disabled={mic === 'insecure' || mic === 'denied' || busy}
            onClick={() => (active ? (recRef.current?.stop(), mrRef.current?.state === 'recording' && mrRef.current.stop()) : (mic === 'ready' ? startListening() : void ensureMic().then((ok) => ok && startListening())))}>
            {active ? '⏹ Escuchando… toca para parar' : mic === 'asking' ? '🎙 Pidiendo permiso…' : '🎤 Hablar'}
          </button>
          <button className="secondary" title="Permiso y selección del micrófono de entrada"
            onClick={() => { setShowCfg((s) => !s); if (!showCfg) { void ensureMic(); api.aiConfig().then((c) => setAiOn(c.openai)).catch(() => {}); } }}>⚙️ Micrófono</button>
        </div>

        {showCfg && (
          <div className="voice-sugg" style={{ marginTop: 0 }}>
            <div className="muted" style={{ fontSize: '0.8rem' }}>
              Estado: {mic === 'ready' ? '✓ listo' : mic === 'asking' ? 'pidiendo permiso…' : mic === 'insecure' ? '✗ sin contexto seguro' : mic === 'denied' ? '✗ permiso denegado' : 'sin probar'}
            </div>
            {mics.length > 0 && (
              <select value={micId} onChange={(e) => void pickMic(e.target.value)} style={{ width: '100%', marginTop: '0.3rem' }}>
                <option value="">Predeterminado del sistema</option>
                {mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label || `Micrófono ${m.deviceId.slice(0, 6)}`}</option>)}
              </select>
            )}
            {!srSupported && mic === 'ready' && (
              <div className="muted" style={{ fontSize: '0.75rem', marginTop: '0.3rem' }}>
                Este navegador no transcribe local — se grabará y enviará a Whisper (necesita clave OpenAI).
              </div>
            )}
            {/* clave OpenAI — habilita Whisper + respuestas IA; se guarda en server\.env */}
            <div style={{ marginTop: '0.6rem', borderTop: '1px solid var(--line)', paddingTop: '0.5rem' }}>
              <div className="muted" style={{ fontSize: '0.8rem', marginBottom: '0.25rem' }}>
                Clave OpenAI {aiOn === null ? '' : aiOn ? '· ✓ configurada' : '· sin configurar'}
              </div>
              <div className="row" style={{ gap: '0.4rem' }}>
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                  placeholder={aiOn ? 'sk-•••••• (pega otra para cambiar)' : 'sk-...'}
                  style={{ flex: 1, fontSize: '0.85rem' }} />
                <button className="secondary sm" disabled={!apiKey.trim()} onClick={async () => {
                  setKeyMsg('Verificando con OpenAI…');
                  try {
                    const r = await api.aiSaveKey(apiKey.trim());
                    setAiOn(r.openai); setApiKey('');
                    setKeyMsg(
                      r.valid === true ? '✓ Clave guardada y verificada — IA activa'
                        : r.valid === false ? `⚠ Guardada pero OpenAI la rechaza: ${r.error}`
                        : 'Clave quitada');
                  } catch (e) { setKeyMsg((e as Error).message); }
                }}>Guardar</button>
              </div>
              {keyMsg && <div className="muted" style={{ fontSize: '0.72rem', marginTop: '0.2rem' }}>{keyMsg}</div>}
              <div className="muted" style={{ fontSize: '0.68rem', marginTop: '0.25rem' }}>
                Sin clave todo funciona con el diccionario local; con clave: Whisper, narrador y respuestas GPT-4o.
              </div>
            </div>
          </div>
        )}

        <input value={transcript} onChange={(e) => setTranscript(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && analyze(transcript)}
          placeholder="…o escribe la jugada aquí y Enter" style={{ width: '100%', marginTop: '0.5rem', marginBottom: '0.5rem' }} />
        {busy && <p className="muted">{recording ? 'Grabando…' : 'Interpretando…'}</p>}
        {err && <p style={{ color: 'var(--red)' }}>{err}</p>}
        {sugg && (
          <div className="voice-sugg">
            <div className="voice-sugg-code">
              {sugg.action ? sugg.ai?.description_spanish || sugg.action : (RESULT_LABEL[sugg.result ?? ''] ?? sugg.result)}
              {sugg.notation ? ` (${sugg.notation})` : ''}
            </div>
            {sugg.ai.description_spanish && <div className="muted">{sugg.ai.description_spanish}</div>}
            {sugg.ai.outs_made != null && <div className="muted">{sugg.ai.outs_made} out{sugg.ai.outs_made !== 1 ? 's' : ''}{sugg.ai.runs_scored ? ` · ${sugg.ai.runs_scored} carr.` : ''}</div>}
            {!!sugg.advances?.length && (
              <div className="muted" style={{ color: 'var(--blue)' }}>
                Avances: {sugg.advances.map((a) => `${a.via} → ${a.to === 'HOME' ? 'anota' : a.to === 'OUT' ? 'out' : `${a.to}ª`}`).join(' · ')}
              </div>
            )}
            {sugg.note && <div className="muted" style={{ color: 'var(--orange, #d97706)' }}>⚠ {sugg.note}</div>}
            <div className="row" style={{ gap: '0.5rem', marginTop: '0.5rem' }}>
              <button onClick={confirmSugg}>
                ✓ Confirmar
              </button>
              <button className="secondary" onClick={() => { setSugg(null); setTranscript(''); }}>
                ↺ Corregir (repetir)
              </button>
            </div>
            <div className="muted" style={{ fontSize: '0.72rem', marginTop: '0.3rem' }}>
              {sugg.source === 'ai' ? 'Interpretado por IA' : 'Interpretado localmente'} · di <b>«confirmar»</b> para aplicar o <b>«corregir»</b> para repetir · luego eliges los avances como siempre
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
