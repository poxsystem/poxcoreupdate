import {
  Advance, BaseNum, GameEvent, GameState, HITS, MidResult, NON_AB, PAResult, PlayResult,
} from './types.js';

export function initialState(): GameState {
  return {
    inning: 1,
    half: 'TOP',
    outs: 0,
    bases: { 1: null, 2: null, 3: null },
    score: { away: 0, home: 0 },
    awayBatterIndex: 0,
    homeBatterIndex: 0,
    lastOut: { away: null, home: null },
    status: 'LIVE',
  };
}

const MID_RESULTS: PlayResult[] = ['SB', 'CS', 'WP', 'PB', 'BK', 'PK', 'DI', 'CR', 'PC', 'INT', 'OBS', 'GR', 'B', 'S', 'F', 'IPL', 'LE', 'EF', 'EI', 'ADJ', 'RBI', 'EU', 'LG', 'SK', 'DE', 'LIB', 'T'];

export function isMidResult(r: PlayResult): r is MidResult {
  return MID_RESULTS.includes(r);
}

/**
 * Propone avances por defecto según el resultado y los corredores en base.
 * El anotador puede ajustarlos antes de confirmar.
 */
export function defaultAdvances(state: GameState, batterId: string, result: PAResult): Advance[] {
  const { bases } = state;
  const adv: Advance[] = [];
  const r1 = bases[1], r2 = bases[2], r3 = bases[3];

  switch (result) {
    case 'K':
    case 'OOT': // turno robado: el bateador correcto es out, corredores regresan
    case 'XF':  // elevado foul atrapado: bateador out, corredores se esperan
    case 'AIL': // acción ilegal del bateador: out por regla
    case 'FI':  // interferencia de fanático: juicio del ampáyer (default: out)
    case 'AO':  // auto-out: el jugador se fue del estadio sin sustituto — out al llegar su turno
      return [{ playerId: batterId, to: 'OUT' }];
    case 'KWP':
    case 'KPB': {
      // 3er strike suelto: el bateador puede llegar a 1ª solo si está libre o hay 2 outs;
      // con 1ª ocupada y <2 outs es out automático (regla oficial). Corredores avanzan a su riesgo.
      const batterCanRun = !r1 || state.outs >= 2;
      adv.push({ playerId: batterId, to: batterCanRun ? 1 : 'OUT' });
      if (batterCanRun && r1) adv.push({ playerId: r1, to: 2 }); // forzado si embasa el bateador
      if (r2) adv.push({ playerId: r2, to: 2 });
      if (r3) adv.push({ playerId: r3, to: 3 });
      return adv;
    }
    case 'BB':
    case 'IBB':
    case 'HBP':
    case 'CI': {
      // Avance forzado
      adv.push({ playerId: batterId, to: 1 });
      if (r1) {
        adv.push({ playerId: r1, to: 2 });
        if (r2) {
          adv.push({ playerId: r2, to: 3 });
          if (r3) adv.push({ playerId: r3, to: 'HOME' });
        }
      }
      return adv;
    }
    case 'RHB': {
      // corredor golpeado por batazo fair: ESE corredor es OUT, hit al
      // bateador (1ª premiada). Los demás regresan a su base — salvo la
      // cadena forzada que el bateador al ocupar 1ª empuja (r1→2ª, eso
      // empuja r2→3ª, etc.); el out del golpeado rompe la cadena.
      const hitRunner = r3 ?? r2 ?? r1;
      adv.push({ playerId: batterId, to: 1 });
      if (hitRunner) adv.push({ playerId: hitRunner, to: 'OUT' });
      let push = true;
      for (const [b, pid] of [[1, r1], [2, r2], [3, r3]] as const) {
        if (!pid || pid === hitRunner) { push = false; continue; }
        adv.push({ playerId: pid, to: push ? (b === 3 ? 'HOME' : ((b + 1) as 2 | 3)) : b });
      }
      return adv;
    }
    case '1B':
    case 'E':
      adv.push({ playerId: batterId, to: 1 });
      if (r3) adv.push({ playerId: r3, to: 'HOME' });
      if (r2) adv.push({ playerId: r2, to: 3 });
      if (r1) adv.push({ playerId: r1, to: 2 });
      return adv;
    case '1BE': // sencillo + error: bateador toma 2ª
      adv.push({ playerId: batterId, to: 2 });
      if (r3) adv.push({ playerId: r3, to: 'HOME' });
      if (r2) adv.push({ playerId: r2, to: 3 });
      if (r1) adv.push({ playerId: r1, to: 2 });
      return adv;
    case '2B':
      adv.push({ playerId: batterId, to: 2 });
      if (r3) adv.push({ playerId: r3, to: 'HOME' });
      if (r2) adv.push({ playerId: r2, to: 'HOME' });
      // doble típico: el corredor de 1ª llega a 3ª (no anota) — se ajusta si anotó
      if (r1) adv.push({ playerId: r1, to: 3 });
      return adv;
    case '2BE': // doble + error: bateador a 3ª
      adv.push({ playerId: batterId, to: 3 });
      if (r3) adv.push({ playerId: r3, to: 'HOME' });
      if (r2) adv.push({ playerId: r2, to: 'HOME' });
      if (r1) adv.push({ playerId: r1, to: 'HOME' });
      return adv;
    case '3B':
      adv.push({ playerId: batterId, to: 3 });
      if (r3) adv.push({ playerId: r3, to: 'HOME' });
      if (r2) adv.push({ playerId: r2, to: 'HOME' });
      if (r1) adv.push({ playerId: r1, to: 'HOME' });
      return adv;
    case '3BE': // triple + error: bateador anota (su carrera es inmerecida por el error)
    case 'HR':   // jonrón
    case 'HRIP': // jonrón de piernas
      adv.push({ playerId: batterId, to: 'HOME' });
      if (r3) adv.push({ playerId: r3, to: 'HOME' });
      if (r2) adv.push({ playerId: r2, to: 'HOME' });
      if (r1) adv.push({ playerId: r1, to: 'HOME' });
      return adv;
    case 'FC':
      adv.push({ playerId: batterId, to: 1 });
      if (r1) adv.push({ playerId: r1, to: 2 });
      if (r2) adv.push({ playerId: r2, to: 3 });
      if (r3) adv.push({ playerId: r3, to: 'HOME' });
      return adv;
    case 'GO': {
      adv.push({ playerId: batterId, to: 'OUT' });
      // Rola al cuadro: el corredor de 1ª suele avanzar a 2ª, el de 2ª a 3ª.
      // Con 2 outs es el 3er out y nadie avanza; el de 3ª se queda por defecto (jugo rutinario).
      if (state.outs < 2) {
        if (r3) adv.push({ playerId: r3, to: 3 });
        if (r2) adv.push({ playerId: r2, to: r3 ? 2 : 3 });
        if (r1) adv.push({ playerId: r1, to: !r2 || !r3 ? 2 : 1 });
      } else {
        if (r3) adv.push({ playerId: r3, to: 3 });
        if (r2) adv.push({ playerId: r2, to: 2 });
        if (r1) adv.push({ playerId: r1, to: 1 });
      }
      return adv;
    }
    case 'IF':  // infield fly: bateador out automático, corredores a su riesgo (se esperan por defecto)
    case 'FO':
    case 'LO':
    case 'PO':
      // elevado/línea/toque: corredores se esperan en su base
      adv.push({ playerId: batterId, to: 'OUT' });
      if (r1) adv.push({ playerId: r1, to: 1 });
      if (r2) adv.push({ playerId: r2, to: 2 });
      if (r3) adv.push({ playerId: r3, to: 3 });
      return adv;
    case 'SAC':
      adv.push({ playerId: batterId, to: 'OUT' });
      if (r1) adv.push({ playerId: r1, to: 2 });
      if (r2) adv.push({ playerId: r2, to: 3 });
      if (r3) adv.push({ playerId: r3, to: 'HOME' });
      return adv;
    case 'SF':
      adv.push({ playerId: batterId, to: 'OUT' });
      if (r3) adv.push({ playerId: r3, to: 'HOME' });
      if (r2) adv.push({ playerId: r2, to: 2 });
      if (r1) adv.push({ playerId: r1, to: 1 });
      return adv;
    case 'DP':
      adv.push({ playerId: batterId, to: 'OUT' });
      if (r1) adv.push({ playerId: r1, to: 'OUT' });
      else if (r2) adv.push({ playerId: r2, to: 'OUT' });
      else if (r3) adv.push({ playerId: r3, to: 'OUT' });
      // los demás corredores avanzan una base (los corredores suelen ir en movimiento)
      if (r3 && adv.length < 4 && r3 !== adv[1]?.playerId) adv.push({ playerId: r3, to: 3 });
      if (r2 && r2 !== adv[1]?.playerId) adv.push({ playerId: r2, to: 3 });
      if (r1 && r1 !== adv[1]?.playerId) adv.push({ playerId: r1, to: 2 });
      return adv;
    case 'TP':
      adv.push({ playerId: batterId, to: 'OUT' });
      if (r1) adv.push({ playerId: r1, to: 'OUT' });
      if (r2) adv.push({ playerId: r2, to: 'OUT' });
      else if (r3) adv.push({ playerId: r3, to: 'OUT' });
      return adv;
    default:
      return adv;
  }
}

// resultados donde el bateador se convierte en corredor (bola en juego, bases
// por bola, strike suelto) — solo ahí los corredores pueden ser "forzados"
const BATTER_RUNNER = new Set<PlayResult>([
  '1B', '2B', '3B', 'HR', 'HRIP', '1BE', '2BE', '3BE',
  'E', 'FC', 'GO', 'DP', 'TP', 'RHB', 'SAC', 'BB', 'IBB', 'HBP', 'CI', 'KWP', 'KPB',
]);

// out del BATEADOR que anula carreras como 3er out: solo cuando murió camino a
// 1ª con bola en juego (rola, doble play, toque de sacrificio) o en el strike
// suelto que siguió vivo. Si el resultado le dio 1ª — hit, BB, E, FC — y lo
// sorprendieron estirando a otra base es TAG out, no force: la carrera cuenta
// (doble + corredor de 2ª anota + bateador out en 3ª). Los elevados/líneas
// tampoco son forzado (el fly de sacrificio existe precisamente por eso).
const BATTER_FORCE_OUT = new Set<PlayResult>(['GO', 'DP', 'TP', 'SAC', 'KWP', 'KPB']);

/**
 * Regla oficial del 3er out forzado (MLB 5.08(a) — softball igual):
 * NO anota ninguna carrera de la jugada si el 3er out es
 *  a) el bateador-corredor retirado antes de llegar a 1ª, o
 *  b) un corredor forzado a avanzar (todas las bases detrás ocupadas al lanzarse
 *     el pitcheo y el bateador hecho corredor) — aunque haya "pisado" home antes.
 * Si el bateador ya fue retirado antes en la misma jugada, el forzado se
 * desactiva para los outs posteriores (jugada de tiempo).
 */
export function thirdOutIsForce(prev: GameState, ev: GameEvent): boolean {
  const outs = ev.advances.filter((a) => a.to === 'OUT');
  if (!outs.length || prev.outs + outs.length < 3) return false;
  // RHB: la bola muere al golpear al corredor — su out JAMÁS es forzado
  // (5.09(b)(7): es jugada de tiempo; las carreras previas sí cuentan)
  if (ev.result === 'RHB') return false;
  const last = outs[outs.length - 1]; // el último out de la jugada es el 3ro
  if (last.playerId === ev.batterId) return BATTER_FORCE_OUT.has(ev.result);
  if (outs.slice(0, -1).some((a) => a.playerId === ev.batterId)) return false; // bateador ya out → sin forzado
  if (!BATTER_RUNNER.has(ev.result)) return false; // elevado/línea: nadie forzado
  const base = ([1, 2, 3] as BaseNum[]).find((b) => prev.bases[b] === last.playerId);
  if (!base) return false;
  for (let b = 1; b < base; b++) if (!prev.bases[b as BaseNum]) return false;
  // Jugada de tiempo: el out fue MÁS ALLÁ de la base a la que el corredor iba
  // forzado → ya no es forzado, la carrera cuenta si pisó antes (ej. r1
  // forzado a 2ª pero sorprendido en 3ª por tag). La base del out se deduce
  // del último fildeador de la notación; sin notación se asume forzado.
  // Máxima base forzada desde 1ª sin huecos: 2 si hay r1, 3 si hay r1+r2, 4(home) si bases llenas
  let maxForcedBase = 1;
  while (maxForcedBase <= 3 && prev.bases[maxForcedBase as BaseNum]) maxForcedBase++;
  const forcedTo = base + 1; // 2/3/4(home)
  const m = /(\d)(?!.*\d)/.exec(ev.notation ?? ''); // último dígito = quien saca
  if (m) {
    const outBase = { 2: 4, 3: 1, 4: 2, 5: 3, 6: 2 }[Number(m[1])]; // guante → base que cubre
    if (outBase != null) {
      if (outBase > maxForcedBase) return false;
      if (outBase === 4 && forcedTo < 4 && ev.advances.some((a) => a.playerId === prev.bases[3] && a.to === 'HOME')) return false;
    }
  }
  return true;
}

/** Aplica un evento al estado y devuelve el nuevo estado (sin mutar). */
export function applyEvent(state: GameState, ev: GameEvent, maxInnings = 9): GameState {
  const s: GameState = {
    ...state,
    bases: { ...state.bases },
    score: { ...state.score },
    lastOut: { ...state.lastOut },
  };

  // Jugadas administrativas (menú Especial de BallScore):
  // EI = terminar la media entrada antes del 3er out; ADJ = ajuste manual de
  // corredores/outs (notation "O:n" fija los outs; advances colocan corredores).
  if (ev.result === 'EI' || ev.result === 'ADJ') {
    if (ev.result === 'ADJ') {
      const m = /O:(\d)/.exec(ev.notation ?? '');
      if (m) s.outs = Math.min(3, Number(m[1]));
      s.bases = { 1: null, 2: null, 3: null };
      for (const a of ev.advances) {
        if (a.to === 1 || a.to === 2 || a.to === 3) s.bases[a.to] = a.playerId;
      }
    } else {
      s.outs = 3;
    }
    if (s.outs >= 3) {
      if (s.half === 'TOP') {
        s.half = 'BOTTOM';
      } else {
        const tied = s.score.home === s.score.away;
        if (s.inning >= maxInnings && !tied) s.status = 'FINAL';
        else { s.inning += 1; s.half = 'TOP'; }
      }
      s.outs = 0;
      s.bases = { 1: null, 2: null, 3: null };
    }
    return s;
  }

  // último out del equipo al bate (para el corredor fantasma).
  // Se atribuye por ev.half (etiqueta del evento), no por la progresión interna
  // de s.half: tras "cambiar lados" los eventos conservan su equipo real.
  const outsInPlay = ev.advances.filter((a) => a.to === 'OUT');
  if (outsInPlay.length) {
    const last = outsInPlay[outsInPlay.length - 1].playerId;
    if (ev.half === 'TOP') s.lastOut.away = last; else s.lastOut.home = last;
  }

  // Desplaza corredores y coloca al bateador según los avances
  for (const a of ev.advances) {
    // quitar al corredor de su base actual
    for (const b of [1, 2, 3] as BaseNum[]) {
      if (s.bases[b] === a.playerId) s.bases[b] = null;
    }
  }
  // 3er out forzado: las carreras de la jugada NO cuentan (regla oficial)
  const cancelRuns = thirdOutIsForce(state, ev);
  let outs = s.outs;
  for (const a of ev.advances) {
    if (a.to === 'OUT') {
      outs += 1;
    } else if (a.to === 'HOME') {
      if (!cancelRuns) {
        if (ev.half === 'TOP') s.score.away += 1;
        else s.score.home += 1;
      }
    } else {
      s.bases[a.to] = a.playerId;
    }
  }
  s.outs = outs;

  // El bateador avanza en el orden solo si el resultado termina su turno.
  // SK (jugador ausente, regla softball sin out) avanza el orden sin cerrar PA.
  if (!isMidResult(ev.result) || ev.result === 'SK') {
    if (ev.half === 'TOP') s.awayBatterIndex += 1;
    else s.homeBatterIndex += 1;
  }

  // Cambio de entrada / fin de juego
  if (s.outs >= 3) {
    if (s.half === 'TOP') {
      s.half = 'BOTTOM';
    } else {
      // fin del inning completo
      const tied = s.score.home === s.score.away;
      if (s.inning >= maxInnings && !tied) {
        s.status = 'FINAL';
      } else {
        s.inning += 1;
        s.half = 'TOP';
      }
    }
    s.outs = 0;
    s.bases = { 1: null, 2: null, 3: null };
  }

  // Victoria anticipada: home gana en bottom 9+ sin completar 3 outs
  if (s.half === 'BOTTOM' && s.inning >= maxInnings && s.score.home > s.score.away) {
    s.status = 'FINAL';
  }

  return s;
}

/** Reconstruye el estado del juego desde cero aplicando todos los eventos. */
export function reduceGame(events: GameEvent[], maxInnings = 9): GameState {
  let s = initialState();
  for (const ev of events) {
    if (s.status === 'FINAL') break;
    s = applyEvent(s, ev, maxInnings);
  }
  return s;
}

// ----------------- Boxscore -----------------

export interface BatterLine {
  playerId: string;
  pa: number; ab: number; r: number; h: number;
  rbi: number; bb: number; k: number; hbp: number;
  doubles: number; triples: number; hr: number;
  sac: number; sf: number; sb: number;
}

export interface PitcherLine {
  playerId: string;
  outs: number; // IP = outs/3
  h: number; r: number; er: number; bb: number; k: number; hr: number;
  pitches: number; // lanzamientos totales (B/S/F/WP/PB/BK/IPL/EF + cada turno que termina)
}

export interface Boxscore {
  away: Record<string, BatterLine>;
  home: Record<string, BatterLine>;
  pitchers: Record<string, PitcherLine>;
  linescore: { away: number[]; home: number[] };
  lob: { away: number; home: number }; // corredores dejados en base
}

function emptyBatter(playerId: string): BatterLine {
  return {
    playerId, pa: 0, ab: 0, r: 0, h: 0, rbi: 0, bb: 0, k: 0, hbp: 0,
    doubles: 0, triples: 0, hr: 0, sac: 0, sf: 0, sb: 0,
  };
}

function emptyPitcher(playerId: string): PitcherLine {
  return { playerId, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, hr: 0, pitches: 0 };
}

// resultados que son un lanzamiento real (para el conteo de pitches del lanzador)
const PITCH_MID = new Set<string>(['B', 'S', 'F', 'WP', 'PB', 'BK', 'IPL', 'EF']);

const NO_RBI: PlayResult[] = ['E', 'DP', 'TP', 'KWP', 'KPB'];

/** Resultados que hacen inmerecida la carrera del corredor que embasó así */
const UNEARNED_REACH = new Set<string>(['E', 'CI', 'GR', 'ADJ', 'INT', 'OBS', 'KPB']);

/** Embasados "regalados" por la defensa: en la reconstrucción sin errores de la
 *  entrada (regla 9.16) el bateador cuenta como OUT — al acumular 3 outs
 *  ficticios la entrada "ya debió terminar" y toda carrera posterior es
 *  inmerecida. Errores consecutivos acumulan outs ficticios. */
const ERROR_REACH = new Set<string>(['E', 'CI', 'INT', 'OBS', 'KPB']);

/** Resultados que SON un error defensivo aunque no traigan fildeador resuelto
 *  (E, error en foul, avance por error, híbridos hit+error) */
export const ERROR_RESULTS = new Set<string>(['E', 'EF', 'DE', '1BE', '2BE', '3BE']);

export function computeBoxscore(events: GameEvent[], maxInnings = 9): Boxscore {
  const box: Boxscore = {
    away: {}, home: {}, pitchers: {},
    linescore: { away: [], home: [] },
    lob: { away: 0, home: 0 },
  };

  const batterOf = (team: 'away' | 'home', id: string) => {
    const t = box[team];
    if (!t[id]) t[id] = emptyBatter(id);
    return t[id];
  };
  const pitcherOf = (id: string) => {
    if (!box.pitchers[id]) box.pitchers[id] = emptyPitcher(id);
    return box.pitchers[id];
  };

  // replay del estado: cómo llegó cada corredor a base y contra qué pitcher
  let st = initialState();
  const reach = new Map<string, { res: string; pitcherId: string | null }>();
  // Reconstrucción sin errores de la entrada (9.16): outs que la defensa DEBIÓ
  // registrar. Reinicia en cada mitad y con cada relevo — el relevista no se
  // beneficia de "outs regalados" cometidos antes de su entrada; sus carreras
  // se reconstruyen desde su primer bateador.
  let reconOuts = 0, curHalf: string | null = null, curPitcher: string | null = null;

  for (const ev of events) {
    const prevSt = st;
    const team: 'away' | 'home' = ev.half === 'TOP' ? 'away' : 'home';
    const ls = box.linescore[team];
    while (ls.length < ev.inning) ls.push(0);

    // 3er out forzado anula las carreras de la jugada — ni score, ni stats,
    // ni línea por entrada (aunque el corredor "pisó" home antes del out)
    const cancelRuns = thirdOutIsForce(prevSt, ev);
    const runsOnPlay = cancelRuns ? [] : ev.advances.filter((a) => a.to === 'HOME');
    const outsOnPlay = ev.advances.filter((a) => a.to === 'OUT').length;
    const runnerOuts = ev.advances.filter((a) => a.to === 'OUT' && a.playerId !== ev.batterId).length;
    ls[ev.inning - 1] += runsOnPlay.length;

    // reconstrucción 9.16: cambio de mitad o de pitcher reinicia los outs ficticios
    if (ev.half !== curHalf || (!!ev.pitcherId && ev.pitcherId !== curPitcher)) {
      reconOuts = 0;
      curHalf = ev.half;
      if (ev.pitcherId) curPitcher = ev.pitcherId;
    }
    // bateador embasado "gratis" (error/interferencia/K+PB, o FC donde el error
    // salvó a todos): en la reconstrucción era un out
    const batterErrReach = !!ev.batterId
      && ev.advances.some((a) => a.playerId === ev.batterId && a.to !== 'OUT' && a.to !== 'HOME')
      && (ERROR_REACH.has(ev.result)
          || (ev.result === 'FC' && !!ev.errorOn?.length && outsOnPlay === 0));
    // entrada "ya debió terminar": todo lo que anote desde ahora es inmerecido
    const deadInning = reconOuts + (batterErrReach ? 1 : 0) >= 3;

    // carreras anotadas por corredor
    for (const a of runsOnPlay) {
      if (a.playerId !== ev.batterId) {
        const scorer = batterOf(team, a.playerId);
        scorer.r += 1;
      }
    }

    // línea del pitcher que lanza ahora: outs, hits, bases, ponches, jonrones, pitcheos
    if (ev.pitcherId) {
      const p = pitcherOf(ev.pitcherId);
      p.outs += outsOnPlay;
      if (HITS.includes(ev.result)) p.h += 1;
      if (ev.result === 'HR' || ev.result === 'HRIP') p.hr += 1;
      if (ev.result === 'BB' || ev.result === 'IBB') p.bb += 1;
      if (ev.result === 'K' || ev.result === 'KWP' || ev.result === 'KPB') p.k += 1;
      if (PITCH_MID.has(ev.result) || !isMidResult(ev.result)) p.pitches += 1;
      // EU: alterna merecida/inmerecida del pitcher (notation 'U' = inmerecida, 'E' = merecida)
      if (ev.result === 'EU') {
        p.er = Math.max(0, Math.min(p.r, p.er + (ev.notation?.startsWith('U') ? -1 : 1)));
      }
    }

    // carreras se cargan al pitcher que dejó embasado al corredor (regla de corredores heredados);
    // el bateador que anota en su propia jugada se la carga a quien le lanzó.
    // PB/BK/IPL/DE cuentan como error para 9.16 (la carrera que cruza en ellas es
    // inmerecida); WP NO — el lanzamiento descontrolado es culpa del pitcher.
    const playHadError = ev.result === 'E' || !!ev.errorOn?.length
      || ev.result === '1BE' || ev.result === '2BE' || ev.result === '3BE'
      || ev.result === 'PB' || ev.result === 'BK' || ev.result === 'IPL' || ev.result === 'DE'
      // interferencia/obstrucción = error defensivo aunque no haya E# resuelto;
      // E# en la notación cubre fildeadores no resueltos contra la alineación
      || ev.result === 'CI' || ev.result === 'INT' || ev.result === 'OBS'
      || /E-?\d/.test(ev.notation ?? '');
    for (const a of runsOnPlay) {
      const rec = reach.get(a.playerId);
      const chargeTo = rec?.pitcherId ?? ev.pitcherId;
      if (!chargeTo) continue;
      const p = pitcherOf(chargeTo);
      p.r += 1;
      const earned = !deadInning && !playHadError && !UNEARNED_REACH.has(rec?.res ?? '');
      if (earned) p.er += 1;
    }

    // outs reales que también valen en la reconstrucción — un corredor embasado
    // por error YA era out ficticio: su out real no se vuelve a contar
    for (const a of ev.advances) {
      if (a.to !== 'OUT') continue;
      const rec = a.playerId === ev.batterId ? null : reach.get(a.playerId);
      if (!rec || !UNEARNED_REACH.has(rec.res)) reconOuts += 1;
    }
    if (batterErrReach) reconOuts += 1;

    // replay: cómo llegó cada corredor a base (batterErrReach → 'E': en FC donde
    // el error salvó a todos, su carrera futura también es inmerecida)
    if (ev.batterId && ev.advances.some((a) => a.playerId === ev.batterId && a.to !== 'OUT' && a.to !== 'HOME')) {
      reach.set(ev.batterId, { res: batterErrReach ? 'E' : ev.result, pitcherId: ev.pitcherId });
    }
    // corredor que AVANZA POR ERROR (9.16 reconstrucción): aunque se embasó
    // limpio, la base extra se la dio la defensa → res pasa a 'E' y una carrera
    // futura es inmerecida. Carga sigue del pitcher que lo embasó.
    // Criterio: mid-result de error (DE/PB/BK/IPL…) → todo avance es por la
    // falla; jugada de turno con error → solo el que fue MÁS ALLÁ de lo que
    // defaultAdvances da naturalmente (forzado/normal no cuenta — el error no
    // lo ayudó); FC donde el default era OUT y sobrevivió por el error → 'E'.
    if (playHadError) {
      const midErr = isMidResult(ev.result);
      const defs = midErr || !ev.batterId ? null : defaultAdvances(prevSt, ev.batterId, ev.result as PAResult);
      for (const a of ev.advances) {
        if (a.to === 'OUT' || a.to === 'HOME' || a.playerId === ev.batterId) continue;
        if (!midErr && typeof a.to === 'number') {
          const nat = defs?.find((d) => d.playerId === a.playerId)?.to;
          if (typeof nat === 'number' && a.to <= nat) continue; // avance natural → no lo ayudó el error
        }
        const prev = reach.get(a.playerId);
        reach.set(a.playerId, { res: 'E', pitcherId: prev?.pitcherId ?? ev.pitcherId });
      }
    }
    // corredor emergente: hereda la responsabilidad del pitcher del corredor reemplazado
    if (ev.result === 'CR') {
      for (const a of ev.advances) {
        if (a.to === 'OUT' || a.to === 'HOME') continue;
        const oldPid = prevSt.bases[a.to as BaseNum];
        if (oldPid && reach.has(oldPid)) reach.set(a.playerId, reach.get(oldPid)!);
      }
    }
    // ajuste manual (ADJ): corredores colocados por el anotador — responsabilidad indeterminada → inmerecida
    if (ev.result === 'ADJ') {
      for (const a of ev.advances) {
        if (a.to !== 'OUT' && a.to !== 'HOME') reach.set(a.playerId, { res: 'ADJ', pitcherId: null });
      }
    }
    st = applyEvent(st, ev, maxInnings);
    // corredor fantasma (evento GR): sus carreras son inmerecidas (regla tie-break)
    if (ev.result === 'GR') for (const a of ev.advances) reach.set(a.playerId, { res: 'GR', pitcherId: ev.pitcherId });
    // limpiar reach de quien ya no está en base
    const onBase = new Set([st.bases[1], st.bases[2], st.bases[3]].filter(Boolean));
    for (const pid of [...reach.keys()]) if (!onBase.has(pid)) reach.delete(pid);

    // corredores dejados en base al terminar el medio inning / el juego
    // (las carreras anuladas por 3er out forzado no cuentan como LOB —
    //  ocupaban base pero su cruce fue cancelado)
    const halfEnded = prevSt.half !== st.half || (prevSt.status !== 'FINAL' && st.status === 'FINAL');
    if (halfEnded) {
      const occupied = [prevSt.bases[1], prevSt.bases[2], prevSt.bases[3]].filter(Boolean).length;
      const crossed = ev.advances.filter((a) => a.to === 'HOME').length; // anuladas o no
      const leftOn = occupied - crossed - runnerOuts;
      if (leftOn > 0) box.lob[team] += leftOn;
    }

    if (!ev.batterId) continue;
    const b = batterOf(team, ev.batterId);

    // carrera del propio bateador (HR, o se estafó el home — raro)
    if (runsOnPlay.some((a) => a.playerId === ev.batterId)) b.r += 1;

    if (isMidResult(ev.result)) {
      // SB se acredita al corredor que avanza (puede ser más de uno)
      if (ev.result === 'SB') {
        for (const a of ev.advances) {
          if (a.to !== 'OUT') batterOf(team, a.playerId).sb += 1;
        }
      }
      // RBI: ajuste manual de empujadas del bateador (notation '+'/'-')
      if (ev.result === 'RBI') {
        // notation '-'/'+' o con sello de jugada ('-@42' = resta al turno seq 42)
        b.rbi = Math.max(0, b.rbi + (ev.notation?.startsWith('-') ? -1 : 1));
      }
      continue;
    }

    const r = ev.result as PAResult;
    b.pa += 1;
    if (HITS.includes(r)) {
      b.h += 1; b.ab += 1;
      if (r === '2B' || r === '2BE') b.doubles += 1;
      if (r === '3B' || r === '3BE') b.triples += 1;
      if (r === 'HR' || r === 'HRIP') b.hr += 1;
    } else if (r === 'BB' || r === 'IBB') {
      b.bb += 1;
    } else if (r === 'K' || r === 'KWP' || r === 'KPB') {
      b.k += 1; b.ab += 1;
    } else if (r === 'HBP') {
      b.hbp += 1; // golpeado: cuenta PA pero no AB (necesario para OBP)
    } else if (r === 'SAC') {
      b.sac += 1;
    } else if (r === 'SF') {
      b.sf += 1;
    } else if (r === 'CI' || r === 'OOT') {
      // interferencia del receptor / turno robado: sin turno oficial
    } else {
      b.ab += 1; // outs, E, FC, DP, TP cuentan como AB
    }

    if (!NO_RBI.includes(r)) b.rbi += runsOnPlay.length;
  }

  return box;
}

// ----------------- Decisiones W/L (regla 9.17) -----------------

export interface DecisionSuggest {
  wpId: string | null;
  lpId: string | null;
  /** por qué se sugirió el WP: abridor calificado · récord · relevista más efectivo · relevista récord inefectivo */
  wpKind: 'starter' | 'record' | 'effective' | 'ineffective' | null;
  /** outs lanzados por el abridor ganador y mínimo reglamentario (según entradas jugadas y deporte) */
  starterOuts: number;
  minStarterOuts: number;
}

/**
 * Sugerencia de pitcher ganador/derrotado (regla oficial 9.17):
 * - LP = pitcher RESPONSABLE de la carrera de la delantera definitiva:
 *   corredor heredado que anota → se carga a quien lo embasó, no a quien
 *   permitió la jugada que lo trajo.
 * - WP = pitcher de registro cuando el equipo tomó la delantera definitiva
 *   (nunca la volvió a perder ni empatar). Cuenta también si fue removido
 *   DURANTE la media entrada ofensiva de la delantera (NCAA: las carreras de
 *   esa media entrada son a su crédito para el récord).
 * - Si el récord es el ABRIDOR, exige el mínimo por DURACIÓN real a la defensa:
 *   baseball MLB 9.17(b): juego de 6+ inn → 5 IP · de 5 inn → 4 IP · <5 sin mínimo.
 *   softball WBSC/NCAA: juego de 6+ inn → 4 IP · terminado en 5 → 3 IP · <5 sin
 *   mínimo. Corto → victoria al relevista más efectivo (juicio del anotador).
 * - 9.17(c): si el récord es un relevista breve e inefectivo (<1 IP y 2+ CL,
 *   aunque las carreras se carguen a otro), se sugiere al siguiente relevista
 *   efectivo. A igual efectividad entre relevistas, presunción al que entró antes.
 * - Empate final → sin decisión.
 * `wpMinOutsOverride`: si la liga configuró un mínimo propio (en tercios = outs),
 * manda sobre la tabla oficial por deporte/duración.
 */
export function suggestDecisions(events: GameEvent[], maxInnings = 9, sport = 'baseball', wpMinOutsOverride?: number | null): DecisionSuggest {
  const none: DecisionSuggest = { wpId: null, lpId: null, wpKind: null, starterOuts: 0, minStarterOuts: 0 };

  // 1er replay: marcador tras cada evento + primer/último pitcher por mitad
  let st = initialState();
  const diffs: number[] = [];
  const firstPid: Record<'TOP' | 'BOTTOM', string | null> = { TOP: null, BOTTOM: null };
  for (const ev of events) {
    st = applyEvent(st, ev, maxInnings);
    diffs.push(st.score.away - st.score.home);
    if (ev.pitcherId && !firstPid[ev.half]) firstPid[ev.half] = ev.pitcherId;
  }
  const finalDiff = st.score.away - st.score.home;
  if (finalDiff === 0) return none;
  const winner: 'away' | 'home' = finalDiff > 0 ? 'away' : 'home';
  const winDiff = (i: number) => (winner === 'away' ? diffs[i] : -diffs[i]);

  // último evento en que el ganador NO estaba arriba → la siguiente jugada
  // es la que dio la delantera definitiva
  let boundary = -1;
  for (let i = 0; i < diffs.length; i++) if (winDiff(i) <= 0) boundary = i;
  const goAheadIdx = boundary + 1;
  const goAhead = events[goAheadIdx];
  // el ganador fildea en la mitad contraria a la que batea
  const winnerFieldHalf: 'TOP' | 'BOTTOM' = winner === 'home' ? 'TOP' : 'BOTTOM';

  // 2º replay hasta la jugada de la ventaja: pitcher de registro del ganador
  // + rastro de qué pitcher embasó a cada corredor (para cargar el LP real)
  const reachP = new Map<string, string | null>();
  let recordPitcher: string | null = null;
  let lpId: string | null = null;
  let st2 = initialState();
  for (let i = 0; i <= goAheadIdx && i < events.length; i++) {
    const ev = events[i];
    const prevSt2 = st2;
    if (i === goAheadIdx) {
      // la carrera de la delantera = la anotación que pone la diferencia en >0
      let d = boundary >= 0 ? winDiff(boundary) : 0;
      for (const a of ev.advances) {
        if (a.to !== 'HOME') continue;
        d += 1;
        if (d > 0) { lpId = reachP.get(a.playerId) ?? ev.pitcherId ?? null; break; }
      }
      lpId ??= ev.pitcherId ?? null;
    }
    // reach: bateador embasado / corredor emergente hereda / ADJ sin dueño / GR al pitcher actual
    if (ev.batterId && ev.advances.some((a) => a.playerId === ev.batterId && a.to !== 'OUT' && a.to !== 'HOME')) {
      reachP.set(ev.batterId, ev.pitcherId);
    }
    if (ev.result === 'CR') {
      for (const a of ev.advances) {
        if (a.to === 'OUT' || a.to === 'HOME') continue;
        const oldPid = prevSt2.bases[a.to as BaseNum];
        if (oldPid && reachP.has(oldPid)) reachP.set(a.playerId, reachP.get(oldPid)!);
      }
    }
    if (ev.result === 'ADJ' || ev.result === 'GR') {
      for (const a of ev.advances) {
        if (a.to !== 'OUT' && a.to !== 'HOME') reachP.set(a.playerId, ev.result === 'ADJ' ? null : ev.pitcherId);
      }
    }
    st2 = applyEvent(st2, ev, maxInnings);
    const onBase = new Set([st2.bases[1], st2.bases[2], st2.bases[3]].filter(Boolean));
    for (const pid of [...reachP.keys()]) if (!onBase.has(pid)) reachP.delete(pid);
    if (ev.half === winnerFieldHalf && ev.pitcherId) recordPitcher = ev.pitcherId;
  }

  // WP: pitcher de registro; si es el abridor exige el mínimo según cuánto duró
  // el juego a la defensa (st.inning) y el deporte:
  //   baseball MLB 9.17(b): 6+ inn jugados → 5 IP · 5 inn → 4 IP · <5 sin mínimo
  //   softball WBSC/NCAA:   6+ inn jugados → 4 IP · terminado en 5 → 3 IP · <5 sin mínimo
  const starter = firstPid[winnerFieldHalf];
  // entradas que duró el juego a la defensa = entrada del ÚLTIMO evento
  // (st.inning ya rodó a la siguiente cuando el juego se cortó en 5)
  const defInns = events.length ? events[events.length - 1].inning : maxInnings;
  const minInn = sport === 'softball'
    ? (defInns >= 6 ? 4 : defInns === 5 ? 3 : 0)
    : (defInns >= 6 ? 5 : defInns === 5 ? 4 : 0);
  // la liga puede fijar su propio mínimo (wpMinOuts en tercios); 0/null = oficial
  const minStarterOuts = wpMinOutsOverride && wpMinOutsOverride > 0 ? wpMinOutsOverride : minInn * 3;
  const box = computeBoxscore(events, maxInnings);
  const starterOuts = starter ? (box.pitchers[starter]?.outs ?? 0) : 0;
  // relevistas del ganador en orden de entrada; efectividad = más outs,
  // menos carreras, menos limpias — a igualdad, presunción al más temprano
  const relOrder: string[] = [];
  for (const e of events) {
    if (e.half === winnerFieldHalf && e.pitcherId && e.pitcherId !== starter && !relOrder.includes(e.pitcherId)) {
      relOrder.push(e.pitcherId);
    }
  }
  const byEffective = (a: string, b: string) => {
    const A = box.pitchers[a], B = box.pitchers[b];
    return (B?.outs ?? 0) - (A?.outs ?? 0) || (A?.r ?? 0) - (B?.r ?? 0) || (A?.er ?? 0) - (B?.er ?? 0);
  };
  const rec = recordPitcher ?? starter;
  let wpId: string | null = rec ?? null;
  let wpKind: DecisionSuggest['wpKind'] = null;
  if (rec === starter) {
    if (rec && starterOuts >= minStarterOuts) wpKind = 'starter';
    else if (rec) {
      // abridor corto que se fue ganando → relevista más efectivo (juicio del anotador)
      const rels = [...relOrder].sort(byEffective);
      wpId = rels[0] ?? rec;
      wpKind = rels.length ? 'effective' : 'starter';
    }
  } else if (rec) {
    // 9.17(c): relevista breve e inefectivo (<1 IP y 2+ CL aunque sean heredadas)
    // → victoria al relevista posterior más efectivo
    const rp = box.pitchers[rec];
    if (rp && rp.outs < 3 && rp.er >= 2) {
      const later = relOrder.slice(relOrder.indexOf(rec) + 1).sort(byEffective);
      if (later.length) { wpId = later[0]; wpKind = 'ineffective'; }
      else wpKind = 'record';
    } else wpKind = 'record';
  }
  return { wpId, lpId, wpKind, starterOuts, minStarterOuts };
}

// ----------------- Situacional y fildeo (reutilizable: juego, liga, head-to-head) -----------------

export interface SituLine { ab: number; h: number }
export interface SituStats {
  risp: SituLine;     // corredores en posición de anotar (2ª/3ª)
  loaded: SituLine;   // bases llenas
  twoOut: SituLine;   // con 2 outs
  leadoff: SituLine;  // primer bateador de la media entrada
}

const emptySitu = (): SituStats => ({
  risp: { ab: 0, h: 0 }, loaded: { ab: 0, h: 0 }, twoOut: { ab: 0, h: 0 }, leadoff: { ab: 0, h: 0 },
});

/**
 * Splits situacionales por bateador: replay del juego y clasificación de cada
 * turno según el estado ANTES de la jugada (corredores en base, outs, leadoff).
 */
export function computeSituational(events: GameEvent[], maxInnings = 9): { away: Record<string, SituStats>; home: Record<string, SituStats> } {
  const out = { away: {} as Record<string, SituStats>, home: {} as Record<string, SituStats> };
  let st = initialState();
  let paInHalf = 0; // turnos ya vistos en la media entrada actual (para leadoff)
  for (const ev of events) {
    if (!isMidResult(ev.result) && ev.batterId) {
      const side = ev.half === 'TOP' ? 'away' : 'home';
      const s = (out[side][ev.batterId] ??= emptySitu());
      const r = ev.result;
      const isAB = !(NON_AB as readonly string[]).includes(r);
      const isH = (HITS as readonly string[]).includes(r);
      const bump = (l: SituLine) => { if (isAB) l.ab += 1; if (isH) l.h += 1; };
      if (st.bases[2] || st.bases[3]) bump(s.risp);
      if (st.bases[1] && st.bases[2] && st.bases[3]) bump(s.loaded);
      if (st.outs === 2) bump(s.twoOut);
      if (paInHalf === 0) bump(s.leadoff);
      paInHalf += 1;
    }
    const prevHalf = st.half;
    st = applyEvent(st, ev, maxInnings);
    if (st.half !== prevHalf) paInHalf = 0;
  }
  return out;
}

/** Totales por entrada para el pie de la planilla (RO/HO/LO de BallScore) */
export interface InningTally { r: number; h: number; e: number; lob: number }

/**
 * Carreras, hits, errores y dejados en base por entrada para cada equipo —
 * la fila "RO HO LO" al pie de la hoja de anotación manual.
 * E = errores cometidos por la DEFENSA durante el turno al bate de ese equipo
 * (en TOP se anotan en la fila del away — los comete el home). Así la columna
 * resume siempre la media entrada ofensiva del equipo: sus carreras, sus hits,
 * los errores que la defensa cometió durante su turno y sus dejados.
 */
export function computeInningTallies(events: GameEvent[], maxInnings = 9): { away: InningTally[]; home: InningTally[] } {
  const out = { away: [] as InningTally[], home: [] as InningTally[] };
  const at = (side: 'away' | 'home', inn: number) => {
    const arr = out[side];
    while (arr.length < inn) arr.push({ r: 0, h: 0, e: 0, lob: 0 });
    return arr[inn - 1];
  };
  let st = initialState();
  for (const ev of events) {
    const prevSt = st;
    const side = ev.half === 'TOP' ? 'away' : 'home';
    const runsOnPlay = ev.advances.filter((a) => a.to === 'HOME');
    const runnerOuts = ev.advances.filter((a) => a.to === 'OUT' && a.playerId !== ev.batterId).length;
    const t = at(side, ev.inning);
    t.r += runsOnPlay.length;
    if (HITS.includes(ev.result)) t.h += 1;
    // errores: los comete la DEFENSA durante el turno al bate de este equipo —
    // se anotan en la fila del bateador (convención de planilla "RO HO LO": la
    // columna resume la media entrada ofensiva); así el resumen de fin de
    // entrada y el pie de hoja los muestran en la columna donde ocurrieron.
    // Cuenta: errorOn resuelto → E# en la notación → resultado que ES error
    // (el fildeador sin resolver o la notación faltante no vuelve invisible el E)
    const eCnt = Math.max(
      Array.isArray(ev.errorOn) ? ev.errorOn.length
        : typeof ev.errorOn === 'string' ? (JSON.parse(ev.errorOn) as string[]).length : 0,
      ev.notation?.match(/E-?\d/g)?.length ?? 0,
      ERROR_RESULTS.has(ev.result) ? 1 : 0,
    );
    if (eCnt) at(side, ev.inning).e += eCnt;
    st = applyEvent(st, ev, maxInnings);
    const halfEnded = prevSt.half !== st.half || (prevSt.status !== 'FINAL' && st.status === 'FINAL');
    if (halfEnded) {
      const occupied = [prevSt.bases[1], prevSt.bases[2], prevSt.bases[3]].filter(Boolean).length;
      const leftOn = occupied - runsOnPlay.length - runnerOuts;
      if (leftOn > 0) t.lob += leftOn;
    }
  }
  return out;
}

/**
 * Juego completo (CG) y blanqueada individual (SHO) — derivados automáticos
 * como en BallScore ("Complete games & Shutouts are exported automatically"):
 * CG = el pitcher registró TODOS los outs defensivos de su lado;
 * SHO = CG + el equipo rival anotó 0 (con marcador oficial/forfeit si aplica).
 */
export function computeCgSho(
  events: GameEvent[], maxInnings = 9,
  score?: { away: number; home: number },
): { cg: string[]; sho: string[] } {
  // lado que defiende cada pitcher: en TOP lanza el home, en BOTTOM el away
  const pitSide = new Map<string, 'away' | 'home'>();
  for (const e of events) if (e.pitcherId) pitSide.set(e.pitcherId, e.half === 'TOP' ? 'home' : 'away');
  const box = computeBoxscore(events, maxInnings);
  const outsBySide = { away: 0, home: 0 };
  for (const [pid, s] of pitSide) outsBySide[s] += box.pitchers[pid]?.outs ?? 0;
  const runs = score ?? {
    away: box.linescore.away.reduce((a, n) => a + n, 0),
    home: box.linescore.home.reduce((a, n) => a + n, 0),
  };
  const cg: string[] = [], sho: string[] = [];
  for (const [pid, s] of pitSide) {
    const p = box.pitchers[pid];
    if (!p || outsBySide[s] === 0 || p.outs !== outsBySide[s]) continue;
    cg.push(pid);
    if (runs[s === 'home' ? 'away' : 'home'] === 0) sho.push(pid);
  }
  return { cg, sho };
}

/** Fildeo por jugador: PO / A / E acumulados de los metadatos de cada evento */
export function computeFielding(events: GameEvent[]): Record<string, { po: number; a: number; e: number }> {
  const map: Record<string, { po: number; a: number; e: number }> = {};
  const add = (pid: string, k: 'po' | 'a' | 'e') => {
    (map[pid] ??= { po: 0, a: 0, e: 0 })[k] += 1;
  };
  // tolerante a strings JSON crudos (eventos devueltos sin serializar por toEvent)
  const ids = (v: unknown): string[] =>
    Array.isArray(v) ? v as string[]
    : typeof v === 'string' ? (JSON.parse(v) as string[])
    : [];
  for (const ev of events) {
    for (const pid of ids(ev.putouts)) add(pid, 'po');
    for (const pid of ids(ev.assists)) add(pid, 'a');
    for (const pid of ids(ev.errorOn)) add(pid, 'e');
  }
  return map;
}
