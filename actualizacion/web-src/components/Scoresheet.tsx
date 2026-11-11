import { useMemo, useState, type CSSProperties } from 'react';
import {
  applyEvent, initialState, isMidResult,
  type Advance, type GameEvent, type GameState, type InningTally,
} from '@poxscore/shared';
import type { LineupEntry, Player } from '../api';

// ---- reconstrucción de celdas desde el stream de eventos ----

export interface SheetAdvance { from: number | 'HOME'; to: Advance['to']; why?: string }

export interface SheetPlay {
  result: string;
  notation: string | null; // combinación defensiva "6-3", "6-4-3"…
  advances: SheetAdvance[];
  notes: string[]; // robos, wild pitch, etc. dentro del turno
  seq: number;
  outMark?: number; // número del out que produjo la jugada (badge ①②③ de BallScore)
  rbi?: number;     // carreras empujadas en la jugada → puntos rojos en la casilla (anotación manual)
  eu?: 'U' | 'E';   // corrección merecida/inmerecida del evento EU → repinta el círculo de la carrera
}

/** Celda: jugadas apiladas + marcas de cierre/inicio de entrada (diagonal manual de esquina) + línea vertical de entrada de bateador */
export interface SheetCell { plays: SheetPlay[]; inningEnd: boolean; innStart?: boolean; enterV?: 'SUB' | 'REIN' }

/** Racha de un lanzador: entradas en las que lanzó para este equipo */
export interface PitcherRun { playerId: string; fromInning: number; toInning: number }

/** resultados que son un OUT — los avances durante estas jugadas van en negro */
const OUT_PLAY = new Set(['GO', 'FO', 'LO', 'PO', 'XF', 'IF', 'DP', 'TP', 'FC', 'SAC', 'K', 'KWP', 'KPB', 'AO', 'OOT']);

const MID_NOTE: Record<string, string> = {
  SB: 'BR', CS: 'AR', WP: 'WP', PB: 'PB', BK: 'BK', PK: 'PK', DI: 'DI', CR: 'CE', INT: 'IF', OBS: 'OBS', GR: 'CF',
  IPL: 'IP', LE: 'ST', EF: 'EF', LG: 'SALE', SK: 'SALTA', DE: 'E', LIB: 'LIB', T: 'T',
  // B/S/F no llevan nota: solo alimentan el conteo B-S del bateador
};

// causa del avance cuando ocurre DENTRO de una jugada de turno (estilo hoja manual:
// la etiqueta se escribe a mitad del segmento base→base que recorrió el corredor)
const ADV_WHY: Record<string, string> = {
  E: 'E', '1BE': 'E', '2BE': 'E', '3BE': 'E', FC: 'FC',
  BB: 'BB', IBB: 'BB', HBP: 'BB', KWP: 'WP', KPB: 'PB',
  DP: 'DP', TP: 'TP', SAC: 'SAC', SF: 'SF',
};
const advWhy = (ev: GameEvent): string | undefined =>
  MID_NOTE[ev.result] ?? ADV_WHY[ev.result];

/**
 * Construye la planilla de un equipo reprocesando el juego evento a evento.
 * - cells[slot][col] = jugadas. La casilla del turno es el ORDER del bateador
 *   (orderOf) — MISMO criterio que la columna de nombres y las estadísticas,
 *   así insertar/mover jugadores no desplaza las marcas ajenas. Si el orden da
 *   la vuelta en una entrada, la siguiente columna se usa como EXTENSIÓN de
 *   esa entrada (misma numeración, como la flechita de la anotación manual).
 * - colInning[col] = número de entrada que muestra cada columna
 * - inningEnd: marca de cierre cuando cae el 3er out (diagonal, como la hoja manual)
 * - pitchers: rachas de lanzadores con su rango de entradas
 * - pitcherInnings[inning-1]: lanzadores de esa entrada en orden (para la fila L con línea horizontal)
 * - columnas crecen solas en entradas extras y extensiones de orden
 * - orderOf(pid, inning, half) → índice de casilla (order-1) del jugador EN
 *   ESE momento (un reingreso en otro slot reparte sus turnos por época);
 *   null si no tiene orden → se le asigna una fila libre al final
 */
export function buildSheet(
  events: GameEvent[],
  slots: number,
  side: 'away' | 'home',
  maxInnings: number,
  orderOf?: (playerId: string, inning: number, half: 'TOP' | 'BOTTOM') => number | null,
): { cells: SheetCell[][]; state: GameState; pitchers: PitcherRun[]; pitcherInnings: string[][]; colInning: number[] } {
  const cells: SheetCell[][] = Array.from({ length: Math.max(slots, 1) }, () =>
    Array.from({ length: maxInnings }, () => ({ plays: [], inningEnd: false }) as SheetCell));
  const ensureCol = (col: number) => {
    while (cells[0].length <= col) for (const row of cells) row.push({ plays: [], inningEnd: false });
  };
  const ensureRow = (slot: number) => {
    while (cells.length <= slot) cells.push(Array.from({ length: cells[0].length }, () => ({ plays: [], inningEnd: false }) as SheetCell));
  };

  // mapeo entrada→columna con extensiones: cuando el orden da la vuelta dentro de
  // una entrada, la vuelta extra se anota en la columna de al lado con el mismo número
  const colInning: number[] = [];
  let curInning = 0;
  // turnos por casilla en la entrada en curso (casilla → veces que ya bateó)
  let occ = new Map<number, number>();
  // vuelta del orden en que va la hoja ("pasada"): determina la columna de
  // cada PA — un jugador insertado a mitad de entrada escribe su primera PA
  // en la columna que se está anotando, no en la columna 0
  let curLap = 0;
  let maxOcc = 0;      // vueltas alcanzadas → extensiones de la entrada
  let extBefore = 0;   // columnas de extensión usadas por entradas anteriores
  const colOf = (inning: number, cycle?: number) => {
    if (inning > curInning) { // nueva entrada: pliega las extensiones de la anterior
      if (curInning > 0) extBefore += Math.max(0, maxOcc - 1);
      occ = new Map();
      maxOcc = 0;
      curLap = 0;
      curInning = inning;
    }
    const col = inning - 1 + extBefore + (cycle ?? curLap);
    ensureCol(col);
    if (colInning[col] == null) colInning[col] = inning;
    return col;
  };

  let state = initialState();
  // casilla (slot) de cada bateador sin orden: se le asigna fila libre al final
  const slotOf = new Map<string, number>();
  let nextFreeSlot = Math.max(slots, 1);
  const slotFor = (pid: string | null, inning: number, half: 'TOP' | 'BOTTOM'): number => {
    if (!pid) return 0;
    const o = orderOf?.(pid, inning, half);
    if (o != null && o >= 0) { ensureRow(o); return o; }
    let s = slotOf.get(pid);
    if (s == null) { s = nextFreeSlot++; slotOf.set(pid, s); ensureRow(s); }
    return s;
  };
  // casilla de un corredor (advances) — mismo criterio, pero no reserva fila si
  // aún no batea (su sombra cae en la casilla del bateador)
  const slotPeek = (pid: string, inning: number, half: 'TOP' | 'BOTTOM'): number | null => {
    const o = orderOf?.(pid, inning, half);
    if (o != null && o >= 0) return o;
    return slotOf.get(pid) ?? null;
  };
  // notas de jugadas mid-turno se acumulan y caen en la casilla del turno en curso
  // (la jugada aún no existe — no se pegan a la del bateador anterior)
  let pendingNotes: string[] = [];
  // avances mid-turno del propio bateador (BR) → se fusionan en su jugada al cerrar
  let pendingBatterAdv: SheetPlay['advances'] = [];
  // ajuste manual de empujadas (evento RBI '+/-') → se aplica al turno que cierra;
  // con sello '@<seq>' (corrección retroactiva) cae directo en ESA jugada
  let pendingRbi = 0;
  const playBySeq = new Map<number, SheetPlay>();
  // EU (merecida↔inmerecida): el círculo de la carrera vive en la casilla del
  // CORREDOR que anotó, no en la del bateador — por eso se registran TODAS las
  // jugadas tocadas por cada seq, más la última con carrera (toggle sin sello)
  const playsBySeq = new Map<number, SheetPlay[]>();
  let lastRunPlay: SheetPlay | null = null;
  // celda de la última PA cerrada (para la raya de cierre) + entradas ya abiertas
  let lastPa = { slot: 0, col: 0 };
  const seenInnings = new Set<number>();
  // regla oficial (espejo de computeBoxscore): sin empujada en E/DP/TP/3er-strike-suelto
  const NO_RBI_SHEET = new Set(['E', 'DP', 'TP', 'KWP', 'KPB']);

  // lanzadores: mi equipo defiende en la mitad contraria
  const myHalf = side === 'away' ? 'TOP' : 'BOTTOM';
  const fieldHalf = side === 'away' ? 'BOTTOM' : 'TOP';
  const pitchers: PitcherRun[] = [];
  const pitcherInnings: string[][] = [];
  let curPitcher: string | null = null;

  for (const ev of events) {
    const mine = ev.half === myHalf;

    // racha de lanzadores (cuando mi equipo defiende)
    if (ev.half === fieldHalf && ev.pitcherId && ev.pitcherId !== curPitcher) {
      curPitcher = ev.pitcherId;
      pitchers.push({ playerId: curPitcher, fromInning: ev.inning, toInning: ev.inning });
    }
    if (ev.half === fieldHalf && ev.pitcherId === curPitcher && pitchers.length) {
      pitchers[pitchers.length - 1].toInning = ev.inning;
    }
    // fila "L" de la planilla: lanzadores por entrada en orden de aparición
    if (ev.half === fieldHalf && ev.pitcherId) {
      const arr = pitcherInnings[ev.inning - 1] ?? (pitcherInnings[ev.inning - 1] = []);
      if (arr[arr.length - 1] !== ev.pitcherId) arr.push(ev.pitcherId);
    }

    const fromOf = (pid: string): number | 'HOME' => {
      for (const b of [1, 2, 3] as const) if (state.bases[b] === pid) return b;
      return 'HOME';
    };
    const regSeqPlay = (p: SheetPlay) => {
      const arr = playsBySeq.get(ev.seq) ?? [];
      if (!arr.includes(p)) arr.push(p);
      playsBySeq.set(ev.seq, arr);
    };
    // anotación manual: el avance de cada corredor se dibuja en SU casilla,
    // no en la del bateador (si aún no conocemos su casilla, queda en la jugada)
    const distributeRunnerAdv = (col: number, batterSlot: number | null) => {
      ensureCol(col);
      let outN = state.outs;
      const why = advWhy(ev);
      for (const a of ev.advances) {
        if (a.to === 'OUT') outN += 1;
        if (a.playerId === ev.batterId) continue;
        const from = fromOf(a.playerId);
        if (from === a.to) continue; // se queda en su base: nada que anotar
        const rslot = slotPeek(a.playerId, ev.inning, ev.half);
        if (rslot == null) {
          // corredor sin casilla conocida (emergente que aún no batea): queda en la del bateador
          if (batterSlot != null) {
            const plays = cells[batterSlot][col].plays;
            const last = plays[plays.length - 1];
            if (last) {
              last.advances.push({ from, to: a.to, why });
              regSeqPlay(last);
              if (a.to === 'HOME') lastRunPlay = last;
            }
          }
          continue;
        }
        ensureRow(rslot);
        const cell = cells[rslot][col];
        const last = cell.plays[cell.plays.length - 1];
        if (last) {
          // mismo diamante: la ruta del corredor se continúa en su casilla,
          // la notación de la jugada queda como nota (estilo anotación a mano)
          last.advances.push({ from, to: a.to, why });
          regSeqPlay(last);
          if (a.to === 'HOME') lastRunPlay = last;
          if (a.to === 'OUT') last.outMark = Math.min(3, outN);
          if (ev.notation && ev.notation !== last.notation && !last.notes.includes(ev.notation)) last.notes.push(ev.notation);
        } else {
          const play: SheetPlay = {
            result: '', seq: ev.seq, notes: [],
            notation: ev.notation ?? null,
            advances: [{ from, to: a.to, why }],
            outMark: a.to === 'OUT' ? Math.min(3, outN) : undefined,
          };
          cell.plays.push(play);
          regSeqPlay(play);
          if (a.to === 'HOME') lastRunPlay = play;
          // no sobrescribir: el seq también identifica la jugada del bateador
          if (!playBySeq.has(ev.seq)) playBySeq.set(ev.seq, play);
        }
      }
    };

    // merecida↔inmerecida (EU): repinta la casilla de la carrera corregida —
    // con sello '@seq' la jugada indicada; sin sello, la última con carrera
    if (mine && ev.result === 'EU') {
      const tag = /@(\d+)/.exec(ev.notation ?? '');
      const targets = tag ? (playsBySeq.get(Number(tag[1])) ?? []) : (lastRunPlay ? [lastRunPlay] : []);
      for (const p of targets) p.eu = ev.notation?.startsWith('U') ? 'U' : 'E';
    } else if (mine && ev.batterId) {
      if (isMidResult(ev.result)) {
        if (MID_NOTE[ev.result]) pendingNotes.push(MID_NOTE[ev.result]);
        if (ev.result === 'RBI') {
          // sello '@seq' → corrige la jugada indicada (ya anotada); sin sello → al turno que cierra
          const tag = /@(\d+)/.exec(ev.notation ?? '');
          const target = tag ? playBySeq.get(Number(tag[1])) : undefined;
          if (target) {
            target.rbi = Math.max(0, (target.rbi ?? 0) + (ev.notation?.startsWith('-') ? -1 : 1)) || undefined;
          } else {
            pendingRbi += ev.notation?.startsWith('-') ? -1 : 1;
          }
        }
        // avance del bateador mid-turno (BR): se acumula y cae en su jugada al cerrar
        for (const a of ev.advances) {
          if (a.playerId !== ev.batterId) continue;
          const from = fromOf(a.playerId);
          if (from !== a.to) pendingBatterAdv.push({ from, to: a.to, why: advWhy(ev) });
        }
        // robos/wild pitch/etc.: el avance se dibuja en la casilla del corredor
        distributeRunnerAdv(colOf(ev.inning), null);
      } else {
        // casilla = ORDER del bateador en ese momento (la misma fila que la
        // columna de nombres y las stats — insertar/mover jugadores no corre
        // las marcas ajenas); la columna = vuelta del orden en curso
        // (extensión de la hoja manual). curLap manda cuando el bateador es
        // nuevo: el insertado a mitad de entrada anota en la columna que se
        // está escribiendo, no en col0 — así HEREDA el turno de su casilla.
        const slot = slotFor(ev.batterId, ev.inning, ev.half);
        colOf(ev.inning); // pliega/reset si cambió la entrada (antes de leer occ)
        const own = occ.get(slot) ?? 0;
        const cyc = Math.max(own, curLap);
        occ.set(slot, own + 1);
        curLap = cyc;
        maxOcc = Math.max(maxOcc, cyc + 1);
        const col = colOf(ev.inning, cyc);
        const outsOnPlay = ev.advances.filter((a) => a.to === 'OUT').length;
        const play: SheetPlay = {
          result: ev.result, seq: ev.seq, notes: pendingNotes.splice(0),
          notation: ev.notation ?? null,
          // la casilla del bateador solo lleva SU avance (la notación sí va completa)
          // + avances mid-turno acumulados (BR) — un solo diamante, ruta continua
          advances: [
            ...pendingBatterAdv.splice(0),
            ...ev.advances
              .filter((a) => a.playerId === ev.batterId)
              .map((a) => ({ from: fromOf(a.playerId), to: a.to })),
          ],
          // badge del número de out (estado aún es pre-jugada): outs anteriores + outs de la jugada
          outMark: outsOnPlay > 0 ? Math.min(3, state.outs + outsOnPlay) : undefined,
          // puntos rojos de empujadas (como la hoja manual): carreras de la jugada
          // salvo resultados sin CI oficial; ajuste RBI '+/-' corrige el conteo
          rbi: Math.max(0,
            (NO_RBI_SHEET.has(ev.result) ? 0 : ev.advances.filter((a) => a.to === 'HOME').length)
            + pendingRbi) || undefined,
        };
        pendingRbi = 0;
        cells[slot][col].plays.push(play);
        playBySeq.set(ev.seq, play);
        regSeqPlay(play);
        if (play.advances.some((a) => a.to === 'HOME')) lastRunPlay = play;
        lastPa = { slot, col };
        // primera jugada de una entrada nueva (≥2): raya en su esquina superior-izq
        if (ev.inning > 1 && !seenInnings.has(ev.inning)) cells[slot][col].innStart = true;
        seenInnings.add(ev.inning);
        slotOf.set(ev.batterId!, slot);
        distributeRunnerAdv(col, slot);
      }
    } else if (mine) {
      // eventos de corredores sin bateador (casos raros)
      distributeRunnerAdv(colOf(ev.inning), null);
    }

    const prevHalf = state.half;
    state = applyEvent(state, ev, maxInnings);

    // cierre de entrada: mi equipo bateaba y cayó el 3er out → raya en la esquina
    // inferior-derecha de la celda donde cayó el out (la última jugada de la entrada)
    if (prevHalf === myHalf && state.half !== myHalf && ev.half === myHalf) {
      cells[lastPa.slot][lastPa.col].inningEnd = true;
    }
  }
  return { cells, state, pitchers, pitcherInnings, colInning };
}

// ---- mini-diamante por jugada ----

// esquinas del diamante: 2B arriba, 1B derecha, home abajo, 3B izquierda
const CORNER: Record<string, readonly [number, number]> = {
  '2': [30, 4], '1': [42, 16], HOME: [30, 28], '3': [18, 16],
};
const NEXT: Record<string, keyof typeof CORNER> = { HOME: '1', '1': '2', '2': '3', '3': 'HOME' };

/** la jugada involucra error/miscue defensivo (E# en notación, resultado error,
 *  híbrido hit+error o avance por error/pasada/balk/interferencia — toda
 *  carrera que anota en ella es sucia, como en el cálculo de ERA) */
const isDirtyPlay = (play: SheetPlay) =>
  /E-?\d/.test(play.notation ?? '')
  || ['E', '1BE', '2BE', '3BE', 'DE', 'PB', 'BK', 'IPL', 'CI', 'INT', 'OBS', 'KPB'].includes(play.result);
/** carrera sucia: anotó alguien en una jugada con error → celda en rojo traslúcido
 *  (la corrección EU del anotador manda sobre el color derivado de la jugada) */
const cellDirtyRun = (cell: SheetCell) =>
  cell.plays.some((p) => (p.eu ? p.eu === 'U' : isDirtyPlay(p)) && p.advances.some((a) => a.to === 'HOME'));

function MiniDiamond({ play }: { play: SheetPlay }) {
  // en el diamante, para hits se muestra el tipo (2B/3B/HR) — el detalle de la jugada va afuera;
  // para outs la notación defensiva ("6-4-3") es lo importante
  const isHitRes = ['1B', '2B', '3B', 'HR', 'RHB', '1BE', '2BE', '3BE', 'HRIP'].includes(play.result);
  const code = isHitRes ? play.result : (play.notation ?? play.result);
  // carrera sucia: la jugada tuvo error (E en la notación o resultado híbrido/error)
  const dirty = isDirtyPlay(play);
  // base que garantiza el hit del bateador; lo que exceda es por el error (rojo)
  const hitBase: Record<string, string> = { '1B': '1', '1BE': '1', '2B': '2', '2BE': '2', '3B': '3', '3BE': '3', HR: 'HOME', HRIP: 'HOME' };
  const earnedTo = hitBase[play.result];
  const segs: { d: string; cls: string }[] = [];
  const labels: { x: number; y: number; t: string; cls: string }[] = [];
  let scoredEarned = false;
  let scoredDirty = false;

  // etiqueta de la causa del avance a mitad del segmento, corrida hacia afuera del rombo
  const edgeLabel = (from: string, to: string, t: string, cls: string) => {
    const [x1, y1] = CORNER[from];
    const [x2, y2] = CORNER[to];
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    labels.push({ x: mx + (mx - 30) * 0.5, y: my + (my - 16) * 0.5 + 1.6, t, cls });
  };

  for (const a of play.advances) {
    const from = a.from === 'HOME' ? 'HOME' : String(a.from);
    if (a.to === 'OUT') {
      // línea roja hacia la base donde cayó el out + cruz en el destino
      const nxt = NEXT[from];
      if (nxt) {
        const [x1, y1] = CORNER[from];
        const [x2, y2] = CORNER[nxt];
        segs.push({ d: `M${x1} ${y1} L${x2} ${y2}`, cls: 'adv-out' });
        segs.push({ d: `M${x2 - 2.6} ${y2 - 2.6} L${x2 + 2.6} ${y2 + 2.6} M${x2 + 2.6} ${y2 - 2.6} L${x2 - 2.6} ${y2 + 2.6}`, cls: 'adv-out' });
        if (a.why) edgeLabel(from, nxt, a.why, 'adv-why-out');
      }
      continue;
    }
    // avance: recorre las aristas del diamante base por base (estilo hoja manual)
    const target = a.to === 'HOME' ? 'HOME' : String(a.to);
    const isBatter = from === 'HOME';
    let cur = from;
    let pastEarned = false; // el bateador ya pasó la base que garantiza el hit → resto es por el error
    for (let g = 0; g < 4 && cur !== target; g++) {
      const nxt = NEXT[cur];
      const [x1, y1] = CORNER[cur];
      const [x2, y2] = CORNER[nxt];
      // color por CAUSA del avance: rojo=error, negro=out, azul=robo,
      // amarillo=fly de sacrificio, verde=avance limpio (hit/BB/WP/PB…)
      let cls = 'adv-safe';
      if (a.why === 'BR' || a.why === 'AR') cls = 'adv-sb';       // robo (y atrapado robando si llegó safe)
      else if (isBatter && play.result === 'E') cls = 'adv-err';  // embasó por error: todo el avance es del error
      else if (isBatter && dirty && pastEarned) cls = 'adv-err';  // híbrido: bases más allá del hit garantizado
      else if (dirty || a.why === 'E' || a.why === 'EF') cls = 'adv-dirty'; // corredor avanzando por error
      else if (play.result === 'SF') cls = 'adv-sf';              // fly de sacrificio
      else if (OUT_PLAY.has(play.result)) cls = 'adv-outplay';    // avance durante un out (GO/FC/DP…)
      segs.push({ d: `M${x1} ${y1} L${x2} ${y2}`, cls });
      cur = nxt;
      if (isBatter && cur === earnedTo) pastEarned = true;
    }
    // causa del avance: etiqueta a mitad del último segmento recorrido
    const PREV: Record<string, string> = { '1': 'HOME', '2': '1', '3': '2', HOME: '3' };
    if (a.why && PREV[target]) edgeLabel(PREV[target], target, a.why, 'adv-why');
    // la corrección EU del anotador repinta el círculo: 'U' ámbar, 'E' verde
    if (a.to === 'HOME') ((play.eu ? play.eu === 'U' : dirty) ? (scoredDirty = true) : (scoredEarned = true));
  }

  return (
    <svg viewBox="0 0 46 34" className="mini-diamond">
      <path d="M30 4 L42 16 L30 28 L18 16 Z" fill="none" stroke="#cbd5e1" strokeWidth={1.4} />
      {segs.map((s, i) => (
        <path key={i} d={s.d} className={s.cls} fill="none" strokeLinecap="round"
          strokeWidth={s.cls === 'adv-out' ? 1.8 : 2.4} />
      ))}
      {labels.map((l, i) => (
        <text key={`w${i}`} x={l.x} y={l.y} textAnchor="middle" fontSize={4.6} fontWeight={700}
          className={l.cls}>{l.t}</text>
      ))}
      <text x={30} y={19} textAnchor="middle" fontSize={code.length > 3 ? 6.5 : 9} fontWeight={800}
        fill="#0f172a" stroke="#fff" strokeWidth={2.5} paintOrder="stroke">
        {code}
      </text>
      {scoredEarned && <circle cx={30} cy={28} r={3.2} fill="#16a34a" />}
      {scoredDirty && <circle cx={30} cy={28} r={3.2} fill="#f59e0b" stroke="#92400e" strokeWidth={1.2} />}
    </svg>
  );
}

function resultCls(r: string): string {
  if (['1B', '2B', '3B', 'HR', 'RHB', '1BE', '2BE', '3BE', 'HRIP'].includes(r)) return 'hit';
  if (['K', 'KWP', 'KPB', 'GO', 'FO', 'LO', 'PO', 'IF', 'XF', 'AIL', 'FI', 'AO', 'DP', 'TP', 'SAC', 'SF'].includes(r)) return 'out';
  // embasó sin hit por jugada de error → ámbar (misma paleta que la barra en vivo)
  if (['E', 'EF', 'DE'].includes(r)) return 'err';
  return 'misc';
}

// ---- componente planilla ----

interface Props {
  cells: SheetCell[][];
  pitcherInnings?: string[][];   // [inning-1] → lanzadores en orden (fila L de la hoja)
  lineup: LineupEntry[];         // incluye SUB/OUT para marcas de entrada
  innings: number;
  players: Map<string, Player>;
  teamName: string;
  nextSlot?: number;
  nextInning?: number;
  colInning?: number[];             // entrada que representa cada columna (extensiones repiten el número)
  onCellClick?: (slot: number, inning: number, cell: SheetCell) => void;
  onCellAlt?: (slot: number, col: number, cell: SheetCell) => void; // Alt+clic: anotar en ESTA casilla
  onCellContext?: (slot: number, col: number, cell: SheetCell, x: number, y: number) => void; // clic derecho en la celda
  onPlayContext?: (play: SheetPlay, x: number, y: number) => void; // clic derecho sobre una jugada
  onSwapBatter?: (fromId: string, toId: string, withMarks: boolean) => void; // arrastrar nombre: normal=solo nombre, Alt=con anotaciones
  tally?: InningTally[];            // fila RO/HO/LO de BallScore: C, H y dejados en base por entrada
  teamColor?: string;               // color del equipo → tiñe la planilla (suavizado por CSS)
}

export default function Scoresheet({ cells, pitcherInnings = [], lineup, innings, players, teamName, nextSlot, nextInning, colInning = [], onCellClick, onCellAlt, onCellContext, onPlayContext, onSwapBatter, tally, teamColor }: Props) {
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const cols = Math.max(innings + (colInning.length - new Set(colInning).size), cells[0]?.length ?? 0, pitcherInnings.length, tally?.length ?? 0);
  const nameOf = (pid: string) => {
    const p = players.get(pid);
    return p ? `${p.number ? `#${p.number} ` : ''}${p.firstName[0]}. ${p.lastName}` : '?';
  };
  const shortOf = (pid: string) => {
    const p = players.get(pid);
    return p ? (p.number ? `#${p.number}` : p.lastName) : '?';
  };

  // columna → entrada: la extensión de orden repite el número (⤷), las siguientes se recorren
  const extTotal = colInning.filter((v, i) => i > 0 && colInning[i] === colInning[i - 1]).length;
  const innOfCol = (col: number) => colInning[col] ?? (col + 1 - extTotal);
  const isExtCol = (col: number) => col > 0 && colInning[col] != null && colInning[col] === colInning[col - 1];
  const lastColOfInn = (col: number) => colInning[col] != null && colInning[col + 1] !== colInning[col];
  const firstColOfInn = (col: number) => colInning[col] != null && !isExtCol(col);
  // columna del próximo bateador: última usada de la entrada en curso o la primera libre
  const nextCol = nextInning != null
    ? (colInning.lastIndexOf(nextInning) >= 0 ? colInning.lastIndexOf(nextInning) : colInning.length)
    : -1;
  const headers = useMemo(() => Array.from({ length: cols }, (_, i) => innOfCol(i)), [cols, colInning]);

  // línea vertical en la casilla donde entra un bateador (SUB/REIN) — marca manual
  const enterMarks = useMemo(() => {
    const m = new Map<number, Map<number, 'SUB' | 'REIN'>>();
    for (const l of lineup) {
      if ((l.role === 'SUB' || l.role === 'REIN') && l.subInInning && l.order >= 1) {
        if (!m.has(l.order - 1)) m.set(l.order - 1, new Map());
        m.get(l.order - 1)!.set(l.subInInning, l.role);
      }
    }
    return m;
  }, [lineup]);

  return (
    <div className="scoresheet-wrap" style={teamColor ? ({ '--team-c': teamColor } as CSSProperties) : undefined}>
      <div className="scoresheet-title">{teamName}</div>
      <table className="scoresheet">
        <thead>
          <tr>
            <th className="ss-name-col">Bateador</th>
            {headers.map((h, i) => (
              <th key={i} className={isExtCol(i) ? 'ss-ext-col' : ''} title={isExtCol(i) ? `Extensión de la ${h}ª entrada` : undefined}>
                {isExtCol(i) ? `⤷${h}` : h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cells.map((row, slot) => {
            const entry = lineup.find((l) => l.order === slot + 1 && l.active) ?? lineup.find((l) => l.order === slot + 1);
            const subMark = (entry?.role === 'SUB' || entry?.role === 'REIN') && entry.subInInning
              ? `${entry.role === 'REIN' ? '↺ reingresa' : '↳ entra'} ${entry.subInInning}${entry.subInHalf === 'TOP' ? '▲' : '▼'}`
              : null;
            return (
              <tr key={slot}>
                <td
                  className={`ss-name-col ${dropSlot === slot ? 'ss-drop' : ''}`}
                  draggable={!!entry && !!onSwapBatter}
                  title={entry && onSwapBatter ? 'Arrastra a otra casilla: solo mueve el nombre · con Alt: mueve con sus anotaciones' : undefined}
                  onDragStart={entry && onSwapBatter ? (e) => {
                    e.dataTransfer.setData('text/plain', entry.playerId);
                    e.dataTransfer.effectAllowed = 'move';
                  } : undefined}
                  onDragOver={entry && onSwapBatter ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropSlot(slot); } : undefined}
                  onDragLeave={() => setDropSlot((s) => (s === slot ? null : s))}
                  onDrop={entry && onSwapBatter ? (e) => {
                    e.preventDefault(); setDropSlot(null);
                    const from = e.dataTransfer.getData('text/plain');
                    if (from && from !== entry.playerId) onSwapBatter(from, entry.playerId, e.altKey);
                  } : undefined}
                >
                  <div className="ss-player">
                    <span className="ss-order">{slot + 1}</span>
                    <span className="ss-pname">{entry ? nameOf(entry.playerId) : '—'}</span>
                    <span className="ss-pos">{entry?.position}</span>
                  </div>
                  {subMark && <div className="ss-submark">{subMark}</div>}
                </td>
                {Array.from({ length: cols }, (_, col) => {
                  const cell = row[col] ?? { plays: [], inningEnd: false };
                  const isNext = slot === nextSlot && col === nextCol;
                  const enter = isExtCol(col) ? undefined : enterMarks.get(slot)?.get(innOfCol(col));
                  return (
                    <td
                      key={col}
                      className={`ss-cell ${isNext ? 'ss-next' : ''} ${cell.plays.length ? 'ss-filled' : ''} ${cellDirtyRun(cell) ? 'ss-dirty' : ''} ${cell.inningEnd ? 'ss-innend' : ''} ${cell.innStart ? 'ss-innstart' : ''} ${isExtCol(col) ? 'ss-ext' : ''} ${enter ? `ss-enter-v ${enter === 'REIN' ? 'ss-enter-rein' : ''}` : ''}`}
                      onClick={(e) => (e.altKey ? onCellAlt?.(slot, col, cell) : onCellClick?.(slot, innOfCol(col), cell))}
                      onContextMenu={onCellContext ? (e) => { e.preventDefault(); onCellContext(slot, col, cell, e.clientX, e.clientY); } : undefined}
                    >
                      <div className="ss-plays">
                        {cell.plays.map((play) => (
                          <div className="ss-play" key={play.seq}
                            onContextMenu={onPlayContext ? (e) => { e.preventDefault(); e.stopPropagation(); onPlayContext(play, e.clientX, e.clientY); } : undefined}>
                            <span className={`ss-result r-${resultCls(play.result)}`}>
                              {play.result && play.notation?.startsWith(`${play.result}-`) ? play.notation : (play.result || play.notation)}
                              {!!play.result && play.notation && !play.notation.startsWith(`${play.result}-`) && play.notation !== play.result && <small> {play.notation}</small>}
                            </span>
                            <MiniDiamond play={play} />
                            {!!play.rbi && (
                              <span className="ss-rbi" title={`${play.rbi} carrera${play.rbi > 1 ? 's' : ''} empujada${play.rbi > 1 ? 's' : ''}`}>
                                {Array.from({ length: play.rbi }, (_, i) => <i key={i} />)}
                              </span>
                            )}
                            {play.notes.length > 0 && <span className="ss-notes">{play.notes.join(' ')}</span>}
                            {play.outMark && <span className="ss-outnum" title={`Out #${play.outMark}`}>{play.outMark}</span>}
                          </div>
                        ))}
                      </div>
                      {isNext && !cell.plays.length && <span className="ss-dot">●</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {/* Pie de planilla estilo BallScore: C (carreras), H (hits), E (errores propios
              a la defensiva), DB (dejados en base) por entrada + total en la etiqueta */}
          {tally && (
            <>
              {([['C', 'r'], ['H', 'h'], ['E', 'e'], ['DB', 'lob']] as [string, keyof InningTally][]).map(([label, key]) => (
                <tr key={key} className="ss-tally-tr">
                  <td className="ss-name-col ss-tally-label">
                    {label} <strong>{tally.reduce((s, t) => s + t[key], 0)}</strong>
                  </td>
                  {headers.map((h, i) => (
                    <td key={i} className="ss-cell ss-tally">
                      {lastColOfInn(i) && tally[h - 1] ? tally[h - 1][key] : ''}
                    </td>
                  ))}
                </tr>
              ))}
            </>
          )}
          {/* Fila de lanzadores: cada entrada con su pitcher; línea horizontal = cambio de lanzador */}
          {pitcherInnings.some((a) => a?.length) && (
            <tr className="ss-pitcher-tr">
              <td className="ss-name-col"><span className="ss-pos" style={{ fontWeight: 700 }}>Lanz.</span></td>
              {headers.map((h, i) => {
                const ids = firstColOfInn(i) ? (pitcherInnings[h - 1] ?? []) : [];
                return (
                  <td key={i} className="ss-cell ss-pcell">
                    {ids.map((pid, i) => (
                      <span key={`${pid}-${i}`} className="ss-pblock">
                        {i > 0 && <span className="ss-hline" title="Cambio de lanzador" />}
                        <span className="ss-pnum">{shortOf(pid)}</span>
                      </span>
                    ))}
                  </td>
                );
              })}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
