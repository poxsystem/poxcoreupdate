import { useEffect, useRef, useState } from 'react';
import type { Advance, AdvanceTo } from '@poxscore/shared';
import SprayPicker, { type SprayPick } from './SprayPicker';

export interface AdvanceRow {
  playerId: string;
  label: string;
  from: string; // texto: "bateador", "1B", etc.
  options: AdvanceTo[];
  initial: AdvanceTo;
}

interface Props {
  title: string;
  rows: AdvanceRow[];
  /** mostrar selector de combinación defensiva (6-3, 6-4-3, F8, E5…) */
  showNotation?: boolean;
  /** la jugada tiene error: obliga a indicar el fildeador ("E5") en la notación */
  requireError?: boolean;
  /** texto de ayuda personalizado (ej. dirección del batazo en hits) */
  notationHint?: string;
  /** batazo en juego: muestra chips de trayectoria Rola/Línea/Elevado (prefijo G/L/F en la notación) */
  askTraj?: boolean;
  /** notación sugerida (ej. por voz/IA) — prellena el campo */
  defaultNotation?: string;
  /** al cambiar de valor, confirma automáticamente (comando de voz "confirmar") */
  confirmSignal?: number;
  /** notación dictada por voz con el modal abierto: "e dos"→E2, "seis cuatro tres"→6-4-3 */
  voiceNotation?: string;
  /** la notación es la ZONA del batazo (hits): una sola posición — un dígito
   * nuevo corrige, nunca secuencia ("hit al 7" + 7 → 7, no 7-7) */
  zoneOnly?: boolean;
  /** avances dictados por voz con el modal abierto: "en primera a tercera" → marca las filas */
  voiceAdvances?: { key: number; list: { playerId: string; to: AdvanceTo }[] };
  /** batazo en juego + spray sheet activo en la liga: muestra el campo de
   *  círculos para ubicar dónde cayó (dir/dist viajan en el evento) */
  spray?: { result: string };
  /** "atrapado estirando": bases extra donde el bateador puede caer out
   *  (sencillo→2ª/3ª/home…). Chips que fijan su fila en OUT — la notación
   *  del tiro (ej. 9-4) se marca con los chips de siempre */
  traps?: AdvanceTo[];
  /** corrección quirúrgica (planilla): permite cambiar el RESULTADO de la
   *  jugada ya grabada — un select sobre las filas de avance */
  resultEdit?: { value: string; options: { v: string; l: string }[]; onChange: (v: string) => void };
  /** resultOverride: el modal ya capturó un híbrido hit+error (chip "⚠ error")
   *  → '1BE'/'2BE'/'3BE'; el caller graba directo sin pasar a 2ª fase */
  onConfirm: (advances: Advance[], notation: string | null, spray?: { dir: number; dist: number } | null, resultOverride?: string) => void;
  onCancel: () => void;
}

const TO_LABEL: Record<string, string> = { 1: '1B', 2: '2B', 3: '3B', HOME: 'Carrera', OUT: 'Out' };

// numeración de fildeo estándar
const FIELD_CHIPS: { n: number; pos: string }[] = [
  { n: 1, pos: 'P' }, { n: 2, pos: 'C' }, { n: 3, pos: '1B' }, { n: 4, pos: '2B' },
  { n: 5, pos: '3B' }, { n: 6, pos: 'SS' }, { n: 7, pos: 'LF' }, { n: 8, pos: 'CF' }, { n: 9, pos: 'RF' },
];

const TRAJ_CHIPS: { t: 'G' | 'L' | 'F'; label: string }[] = [
  { t: 'G', label: 'Rola' }, { t: 'L', label: 'Línea' }, { t: 'F', label: 'Elevado' },
];

export default function AdvanceModal({ title, rows, showNotation = true, requireError = false, notationHint, askTraj = false, defaultNotation, confirmSignal, voiceNotation, voiceAdvances, zoneOnly = false, spray, traps, resultEdit, onConfirm, onCancel }: Props) {
  const [sel, setSel] = useState<Record<string, AdvanceTo>>(
    Object.fromEntries(rows.map((r) => [r.playerId, r.initial])),
  );
  // sugerencia (voz/IA): el prefijo de trayectoria (G/L/F) se separa al chip
  const preTraj = defaultNotation?.match(/^[GLF]/)?.[0] as 'G' | 'L' | 'F' | undefined;
  const [notation, setNotation] = useState(() => (defaultNotation ?? '').replace(/^[GLF]/, ''));
  const [traj, setTraj] = useState<'G' | 'L' | 'F' | null>(preTraj ?? null);
  const [spraySel, setSpraySel] = useState<SprayPick | null>(null);
  // chip de "atrapado" elegido (visual): cuál base intentaba el bateador;
  // 'ERR' = hit limpio pero el bateador avanzó una base extra por error
  const [trapSel, setTrapSel] = useState<AdvanceTo | 'ERR' | null>(null);
  const [errTo, setErrTo] = useState<AdvanceTo | null>(null); // base extra alcanzada por el error
  const hasError = /E\d/.test(notation);
  // reglas de confirmación según el chip:
  // · atrapado → OBLIGA la combinación defensiva (ej. 9-4) — sin ella se
  //   pierden los PO/asistencias del out en las bases
  // · error → OBLIGA el E# (quién erró) y la base extra alcanzada
  // el atrapado exige la combinación COMPLETA (≥2 fildeadores, "9-4"): un solo
  // dígito en un hit es la zona del batazo y no acredita PO/asistencia a nadie
  const needPlay = trapSel !== null && trapSel !== 'ERR'
    ? notation.split('-').filter((t) => /\d/.test(t)).length >= 2
    : true;
  const needErr = trapSel === 'ERR' ? /E\d/.test(notation) && errTo !== null : true;
  const canConfirm = (!requireError || hasError) && needPlay && needErr;

  // comando de voz "confirmar" → graba la jugada tal como está en pantalla.
  // Solo reacciona a señales NUEVAS (seenRef): si confirmSignal ya venía >0 al
  // abrirse el modal, sin el ref la jugada se autoconfirmaría sin revisarla.
  const doConfirm = () => onConfirm(
    rows.map((r) => ({ playerId: r.playerId, to: sel[r.playerId] })),
    `${traj ?? ''}${notation}` || null,
    spraySel ? { dir: spraySel.dir, dist: spraySel.dist } : null,
    // error en la misma pantalla: 1B+E → '1BE' (resultado híbrido directo)
    trapSel === 'ERR' ? `${typeof rows[0]?.initial === 'number' ? rows[0].initial : 1}BE` : undefined,
  );
  const seenSignal = useRef(confirmSignal ?? 0);
  useEffect(() => {
    if (confirmSignal && confirmSignal !== seenSignal.current) {
      seenSignal.current = confirmSignal;
      if (canConfirm) doConfirm();
    }
  }, [confirmSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  // notación dictada por voz con el modal abierto: "e dos"→E2, "seis cuatro
  // tres"→6-4-3 — se inyecta como si se hubieran tocado los chips
  useEffect(() => {
    if (!voiceNotation) return;
    const t = voiceNotation.match(/^[GLF]/)?.[0] as 'G' | 'L' | 'F' | undefined;
    if (t) setTraj(t);
    const rest = voiceNotation.replace(/^[GLF]/, '');
    // secuencia o token con letra ("E2", "6-4-3") reemplaza; dígito suelto
    // ("siete") se agrega como chip → "e siete" en dos frases queda "E7"
    if (rest) {
      if (rest.includes('-') || /^[A-Z]/.test(rest) || !notation) setNotation(rest);
      else addToken(rest);
    }
  }, [voiceNotation]);

  // avances dictados por voz con el modal abierto: "en primera a tercera" marca
  // esa fila sin tocar las demás (el anotador puede corregir con los botones)
  const seenAdv = useRef(voiceAdvances?.key ?? 0);
  useEffect(() => {
    if (!voiceAdvances || voiceAdvances.key === seenAdv.current || !voiceAdvances.list.length) return;
    seenAdv.current = voiceAdvances.key;
    setSel((prev) => ({ ...prev, ...Object.fromEntries(voiceAdvances.list.map((a) => [a.playerId, a.to])) }));
  }, [voiceAdvances]);

  // reglas de anotación oficial:
  // · letra suelta + dígito → pega ("E"+7→"E7"); dígito pelado repite libre
  //   ("6-6-3": el 6 fildea, saca en 2ª sin asistencia y tira a 1ª)
  // · token letra+dígito NO repite su guante: L7-7/F8-8/E7-7 son inválidos —
  //   el fildeador ya atrapó o erró; la única excepción es G# (rola fildeada
  //   + acción sin asistencia: "G6-6-3"); dígito distinto = relevo (F8-3)
  // · E# + dígito = corrige el fildeador del error (E7+5→"E5"); el mismo E#
  //   jamás sale dos veces (E7-E7)
  const addToken = (t: string) => setNotation((n) => {
    if (!n) return t;
    const last = n.split('-').pop()!;
    // zona del batazo (hits): UNA sola posición — dígito nuevo la corrige,
    // jamás secuencia ("hit al 7" + 8 → H8/8, no 7-8 ni 7-7).
    // EXCEPCIÓN: con jugada marcada (atrapado/error) la notación es la
    // combinación defensiva ("9-4", "8-E4") — los dígitos encadenan libre.
    // En modo ⚠ error el primer dígito sigue siendo la zona del hit hasta
    // que aparezca la E (hit+error = "9-E5", zona primero, error después)
    if ((zoneOnly && trapSel == null || (trapSel === 'ERR' && !/E/.test(n))) && /^\d$/.test(t)) {
      const m = last.match(/^([A-Z]+)(\d+)$/);
      if (m) return `${n.slice(0, -1)}${t}`;
      if (/^\d$/.test(last)) return `${n.slice(0, -1)}${t}`;
      return /^[A-Z]$/.test(last) ? `${n}${t}` : `${n}-${t}`;
    }
    if (last === t && !/^\d$/.test(t)) return n;
    if (/^\d$/.test(t)) {
      // dígito igual al anterior solo vale en el infield (1-6): el 6 fildea y
      // saca sin asistencia ("6-6-3"). Un jardinero JAMÁS repite — "8-8"/"7-7"/
      // "9-9" no existen (el OF no puede tirarse a sí mismo para un out)
      if (last === t && Number(t) > 6) return n;
      if (n.split('-').includes(`E${t}`)) return n;
      // "7-E"+7 → E7: fildear y errar el MISMO guante es solo el error —
      // no hay asistencia en una jugada de error ("6-E"+4 → 6-E4 sí: otro fildeador)
      if (last === 'E') {
        const toks = n.split('-');
        if (toks[toks.length - 2] === t) return [...toks.slice(0, -2), `E${t}`].join('-');
      }
      const m = last.match(/^([A-Z]+)(\d+)$/);
      if (m) {
        if (m[2] === t) return m[1] === 'G' ? `${n}-${t}` : n;
        if (m[1] === 'E') return `${n.slice(0, -1)}${t}`;
      }
    }
    return /^[A-Z]$/.test(last) ? `${n}${t}` : `${n}-${t}`;
  });
  const backspace = () => setNotation((n) => n.split('-').slice(0, -1).join('-'));

  // toque en el spray sheet: guarda dir/dist y rellena la notación con la
  // posición más cercana (o X# en territorio foul) — coexiste con los chips:
  // solo la pisa si está vacía o si la escribió el propio picker
  const lastSprayLoc = useRef<string | null>(null);
  const pickSpray = (p: SprayPick) => {
    setSpraySel(p);
    const tok = p.foul ? `X${p.loc}` : String(p.loc);
    if (zoneOnly) setNotation(tok);
    else setNotation((n) => (!n || n === lastSprayLoc.current ? tok : n));
    lastSprayLoc.current = tok;
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {resultEdit && (
          <div className="row" style={{ marginBottom: '0.5rem', gap: '0.5rem' }}>
            <span className="muted" style={{ fontSize: '0.85rem' }}>Resultado:</span>
            <select value={resultEdit.value} onChange={(e) => resultEdit.onChange(e.target.value)}
              style={{ flex: 1, padding: '0.3rem' }}>
              {resultEdit.options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
          </div>
        )}
        {rows.map((r) => (
          <div className="advance-row" key={r.playerId}>
            <div className="name">
              {r.label}
              <div className="muted" style={{ fontSize: '0.78rem', fontWeight: 400 }}>{r.from}</div>
            </div>
            <div className="to-btns">
              {r.options.map((o) => (
                <button
                  key={String(o)}
                  className={sel[r.playerId] === o ? (o === 'OUT' ? 'sel out-sel' : 'sel') : ''}
                  onClick={() => setSel({ ...sel, [r.playerId]: o })}
                >
                  {TO_LABEL[String(o)]}
                </button>
              ))}
            </div>
          </div>
        ))}

        {/* qué pasó tras el batazo: limpio / atrapado estirando (out, exige la
            combinación ej. 9-4 para no perder PO/asistencias) / avanzó por error
            (exige el E# y la base extra — graba el híbrido en un solo paso) */}
        {traps && rows.length > 0 && (
          <div className="traj-picker">
            <span className="muted" style={{ fontSize: '0.78rem' }}>¿Pasó algo más?</span>
            <div className="traj-chips">
              <button className={`chip chip-traj sm${trapSel === null ? ' sel' : ''}`}
                onClick={() => {
                  setTrapSel(null); setErrTo(null);
                  setSel({ ...sel, [rows[0].playerId]: rows[0].initial });
                  // se canceló la jugada defensiva: la notación vuelve a ser
                  // solo la zona del hit — "9-4" colado grabaría PO/asistencia
                  // fantasma por un out que no hubo
                  setNotation((n) => {
                    const z = n.split('-')[0];
                    return /^X?\d$/.test(z) ? z : '';
                  });
                }}>
                no — limpio
              </button>
              {traps.map((t) => (
                <button key={String(t)} className={`chip chip-traj sm${trapSel === t ? ' sel' : ''}`}
                  onClick={() => { setTrapSel(t); setErrTo(null); setSel({ ...sel, [rows[0].playerId]: 'OUT' }); }}>
                  out a {t === 'HOME' ? 'home' : `${t}ª`}
                </button>
              ))}
              <button className={`chip chip-traj sm chip-e${trapSel === 'ERR' ? ' sel' : ''}`}
                onClick={() => { setTrapSel('ERR'); }}>
                ⚠ error
              </button>
            </div>
            {trapSel === 'ERR' && (
              <div className="traj-chips" style={{ marginTop: '0.3rem' }}>
                <span className="muted" style={{ fontSize: '0.78rem', alignSelf: 'center' }}>Llegó por el error a:</span>
                {traps.map((t) => (
                  <button key={String(t)} className={`chip chip-traj sm${errTo === t ? ' sel' : ''}`}
                    onClick={() => { setErrTo(t); setSel({ ...sel, [rows[0].playerId]: t }); }}>
                    {t === 'HOME' ? 'anota' : `${t}ª`}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {spray && (
          <SprayPicker result={spray.result} picked={spraySel}
            onPick={pickSpray}
            onClear={() => { setSpraySel(null); lastSprayLoc.current = null; }} />
        )}

        {askTraj && (
          <div className="traj-picker">
            <span className="muted" style={{ fontSize: '0.8rem' }}>Trayectoria del batazo</span>
            <div className="traj-chips">
              {TRAJ_CHIPS.map((c) => (
                <button key={c.t} className={`chip chip-traj${traj === c.t ? ' sel' : ''}`}
                  onClick={() => setTraj(traj === c.t ? null : c.t)}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {showNotation && (
          <div className="notation-picker">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className={(requireError && !hasError) || !needPlay || !needErr ? 'notation-hint' : 'muted'} style={{ fontSize: '0.8rem' }}>
                {requireError ? '¿Quién cometió el error? (ej. E5) — obligatorio'
                  : trapSel === 'ERR' ? 'Zona del hit + quién erró (ej. 9-E5) — el E# es obligatorio'
                  : trapSel !== null ? '¿Cómo lo sacaron? (ej. 9-4) — obligatorio'
                  : notationHint ?? 'Combinación (ej. 6-4-3, F8, E5)'}
              </span>
              <strong className="notation-preview">{`${traj ?? ''}${notation}` || '—'}</strong>
            </div>
            <div className="notation-chips">
              {FIELD_CHIPS.map((c) => (
                <button key={c.n} className="chip" title={c.pos} onClick={() => addToken(String(c.n))}>
                  {c.n}<small>{c.pos}</small>
                </button>
              ))}
              <button className="chip chip-e" onClick={() => addToken('E')}>E<small>error</small></button>
              <button className="chip chip-f" onClick={() => addToken('F')}>F<small>fly</small></button>
              <button className="chip chip-f" onClick={() => addToken('X')}>X<small>foul</small></button>
              <button className="chip chip-ghost" onClick={backspace}>⌫</button>
              <button className="chip chip-ghost" onClick={() => setNotation('')}>✕</button>
            </div>
          </div>
        )}

        <div className="row" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
          <button className="secondary" onClick={onCancel}>Cancelar</button>
          <button className="big" disabled={!canConfirm}
            onClick={doConfirm}>
            Confirmar jugada
          </button>
        </div>
      </div>
    </div>
  );
}
