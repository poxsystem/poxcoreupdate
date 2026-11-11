// ---- Tipos del dominio de baseball ----

export type Half = 'TOP' | 'BOTTOM';
export type BaseNum = 1 | 2 | 3;
export type GameStatus = 'SCHEDULED' | 'LIVE' | 'FINAL';

/** Destino posible de un corredor/bateador en una jugada */
export type AdvanceTo = BaseNum | 'HOME' | 'OUT';

export interface Advance {
  playerId: string;
  to: AdvanceTo;
}

export interface BaseState {
  1: string | null;
  2: string | null;
  3: string | null;
}

export interface GameState {
  inning: number;
  half: Half;
  outs: number;
  bases: BaseState;
  score: { away: number; home: number };
  /** Índice del próximo bateador en el orden de cada equipo */
  awayBatterIndex: number;
  homeBatterIndex: number;
  /** Último out de cada equipo al bate — base del corredor fantasma (tie-break) */
  lastOut: { away: string | null; home: string | null };
  status: GameStatus;
}

/**
 * Resultados de aparición al plato (terminan el turno del bateador)
 * K=ponche BB=base IBB=intencional HBP=golpeado
 * 1B/2B/3B/HR=hits E=error FC=jugada de selección
 * GO=rola FO=elevado LO=línea PO=toque/ponche foul atrapado
 * SAC=toque sacrificio SF=elevado sacrificio DP/TP=doble/triple play
 * CI=interferencia del receptor (bateador a 1ª, sin AB)
 * RHB=corredor golpeado por batazo fair (corredor out + hit al bateador)
 * OOT=turno robado (batear fuera de turno, out sin AB)
 * 1BE/2BE/3BE=hit+doble+triple y error (hit acreditado + base extra por error)
 * HRIP=jonrón de piernas (dentro del parque, sin error)
 * XF=out en foul atrapado, AIL=acción ilegal del bateador (bate alterado, cambio
 * de caja, interferencia con el receptor, línea de 3 pies…), FI=interferencia de fanático
 */
export type PAResult =
  | 'K' | 'KWP' | 'KPB' | 'BB' | 'IBB' | 'HBP'
  | '1B' | '2B' | '3B' | 'HR'
  | '1BE' | '2BE' | '3BE' | 'HRIP'
  | 'E' | 'FC'
  | 'GO' | 'FO' | 'LO' | 'PO' | 'IF' | 'XF'
  | 'SAC' | 'SF' | 'DP' | 'TP'
  | 'CI' | 'RHB' | 'OOT' | 'AIL' | 'FI' | 'AO';
// KWP/KPB = ponche con 3er strike suelto (wild pitch/passed ball) — bateador puede llegar a 1ª
// IF = infield fly (regla: bateador out automático, corredores a su riesgo)

/** Jugadas durante el turno (no terminan la aparición). CR = corredor emergente, PC = cambio de lanzador,
 *  INT = interferencia, OBS = obstrucción, GR = corredor fantasma (tie-break, manual),
 *  B/S/F = conteo pitch a pitch (bola/strike/foul), IPL = lanzamiento ilegal (softball),
 *  LE = corredor sale temprano (softball, dead ball out), EF = error en foul (extiende el turno),
 *  EI = terminar entrada antes del 3er out (menú Especial), ADJ = ajuste manual de corredores/outs,
 *  LG = jugador salió del juego (marker; 'IN' = regresó), SK = pasar turno del ausente sin out (softball),
 *  DE = corredor avanza por error defensivo (la notación trae "E#" del fildeador),
 *  LIB = avance libre: el corredor se movió sin que mediara jugada (ni pitcheo,
 *  robo, error ni indiferencia — ej. la defensa ni siquiera lo vio),
 *  T = avance por tiro a otra base (ej. el jardinero tira al plato y el corredor
 *  se mueve — la notación trae los guantes "7-2") */
export type MidResult = 'SB' | 'CS' | 'WP' | 'PB' | 'BK' | 'PK' | 'DI' | 'CR' | 'PC' | 'INT' | 'OBS' | 'GR'
  | 'B' | 'S' | 'F' | 'IPL' | 'LE' | 'EF' | 'EI' | 'ADJ' | 'RBI' | 'EU' | 'LG' | 'SK' | 'DE' | 'LIB' | 'T';

export type PlayResult = PAResult | MidResult;

/** Evento persistido — la fuente de verdad del juego */
export interface GameEvent {
  seq: number;
  inning: number;
  half: Half;
  batterId: string | null;
  pitcherId: string | null;
  result: PlayResult;
  /** Combinación defensiva (opcional): "6-3", "6-4-3", "F8", "E5" */
  notation?: string | null;
  /** Ubicación fina del batazo (spray sheet): dirección en grados desde CF
   *  (-45 línea LF · 0 CF · +45 línea RF · |dir|>45 foul) y distancia en %
   *  del muro por esa dirección (100 = muro, >100 = fuera del parque) */
  sprayDir?: number | null;
  sprayDist?: number | null;
  /** Fildeadores cargados con error en la jugada (playerIds, derivado de "E5"…) */
  errorOn?: string[];
  /** Outs de fildeo y asistencias por jugador (derivados de la notación "6-4-3"…) */
  putouts?: string[];
  assists?: string[];
  advances: Advance[];
  /** metadatos IA (módulos 1/2/3): dictado por voz, JSON de notación, análisis de video, narración */
  aiVoice?: string | null;
  aiJson?: string | null;
  aiVideo?: string | null;
  aiNarration?: string | null;
}

/** Número de fildeo por posición (scorekeeping estándar) */
export const FIELD_NUM: Record<string, number> = {
  P: 1, C: 2, '1B': 3, '2B': 4, '3B': 5, SS: 6, LF: 7, CF: 8, RF: 9, JC: 10,
};

export interface LineupSlot {
  playerId: string;
  order: number;
  position: string;
}

export const PA_RESULTS: readonly PlayResult[] = [
  'K', 'KWP', 'KPB', 'BB', 'IBB', 'HBP', '1B', '2B', '3B', 'HR',
  '1BE', '2BE', '3BE', 'HRIP',
  'E', 'FC', 'GO', 'FO', 'LO', 'PO', 'IF', 'XF', 'SAC', 'SF', 'DP', 'TP', 'CI', 'RHB', 'OOT', 'AIL', 'FI', 'AO',
];

// RHB se acredita como sencillo; 1BE/2BE/3BE/HRIP son hits + error/piernas
export const HITS: readonly PlayResult[] = ['1B', '2B', '3B', 'HR', 'RHB', '1BE', '2BE', '3BE', 'HRIP'];

/** Resultados que cuentan como turno oficial (AB) */
export const NON_AB: readonly PlayResult[] = ['BB', 'IBB', 'HBP', 'SAC', 'SF', 'CI', 'OOT'];

export const POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'JC', 'EH', 'DH'] as const;
// JC = jardinero corto (softball), EH = bateador extra (softball), DH = bateador designado
