import type { BatterLine, GameEvent, GameState, Boxscore, PitcherLine, SituStats } from '@poxscore/shared';

// Temporada dentro de la liga — cada año es una Season independiente
export interface Season { id: string; leagueId: string; year: number; status: 'ACTIVE' | 'ENDED' }
export interface BackupLeagueInfo { name: string; years: number[]; teams: number; players: number; games: number; events: number; from: string | null; to: string | null }
export interface League {
  id: string; name: string; year: number; sport: string;
  innings?: number | null;    // entradas reglamentarias de la liga (null = según deporte)
  wpMinOuts?: number | null;  // mínimo del abridor para la W en tercios/outs (null = regla oficial MLB 9.17/WBSC)
  qualPa?: number;  // PA/juego p/ clasificar a líderes de bateo (MLB 3.1; 0 = todos)
  qualIp?: number;  // IP/juego p/ clasificar a líderes de pitcheo (MLB 1.0; 0 = todos)
  playoffTeams?: number | null;  // cuántos clasifican a postemporada
  playoffRounds?: number | null; // cuántas rondas de playoff
  byes?: Record<string, string[]> | null; // sentados por ronda {round: [teamId]}
  tb?: string; // desempate en standings: pct | h2h | diff
  sprayInput?: boolean; // anotador: spray sheet al confirmar la jugada (apagable por liga)
  createdAt?: string;
  teams?: Team[]; games?: Game[];
  seasons?: Season[];         // temporadas de la liga (desc por año)
  _count?: { teams: number; games: number };
}

// ---- Playoffs ----
export interface SeriesGame {
  id: string; date: string; status: string; away: number; home: number; stadium?: string | null;
  awayTeamId: string; homeTeamId: string; innings: number;
}
export interface PlayoffSeries {
  id: string; leagueId: string; seasonId?: string | null; round: number; name: string;
  homeTeamId: string; awayTeamId: string; winsNeeded: number;
  status: string; winnerTeamId?: string | null;
  games: SeriesGame[]; wins: { home: number; away: number };
  homeTeam: { id: string; name: string; shortName: string | null };
  awayTeam: { id: string; name: string; shortName: string | null };
  winner: { id: string; name: string; shortName: string | null } | null;
}
export interface PlayerSearchHit {
  id: string; firstName: string; lastName: string; number: number | null;
  positions: string | null; active: boolean;
  team: string | null; league: string | null;
}
export interface Team {
  id: string; name: string; shortName?: string | null; color?: string | null;
  division?: string | null; // división dentro de la liga (Este/Oeste…)
  leagueId?: string | null;
  lineupTemplate?: string | null;   // JSON plantilla de alineación ("Save Lineup" de BallScore)
  league?: { name: string; year: number } | null;
  blocked?: boolean; // excluido de la publicación web
  _count?: { players: number };
}
export interface Player {
  id: string; teamId: string; firstName: string; lastName: string;
  number?: number | null; bats?: string | null; throws?: string | null; positions?: string | null; active: boolean;
  photo?: string | null; // JPEG cuadrado 256px en base64 (data URL)
  blocked?: boolean; // excluido de la publicación web
}
export interface LineupEntry {
  id: string; gameId: string; teamId: string; playerId: string;
  order: number; position: string; role: string; // STARTER | SUB | OUT
  active: boolean; replacesId?: string;
  batsInOrder: boolean;             // false = lanza pero no batea
  subInInning?: number | null; subInHalf?: string | null;
  player?: Player;
}
// línea por jugador dentro de un juego (juegos importados sin eventos)
export interface StatLine {
  playerId: string; teamId: string | null; g?: number;
  pa?: number; ab?: number; r?: number; h?: number;
  doubles?: number; triples?: number; hr?: number; rbi?: number;
  bb?: number; k?: number; hbp?: number; sac?: number; sf?: number; sb?: number;
  gp?: number; gs?: number; w?: number; l?: number; sv?: number; hld?: number; bs?: number;
  cg?: number; sho?: number;
  pOuts?: number; pH?: number; pR?: number; pER?: number; pBB?: number; pK?: number; pHR?: number; pPitches?: number;
  e?: number; po?: number; a?: number; bf?: number;
  [k: string]: unknown;
}

export interface Game {
  id: string; date: string; status: string; innings: number; sport: string;
  ghostRunner: boolean;               // corredor fantasma en extras
  stadium?: string | null;
  umpireHp?: string | null; umpire1b?: string | null; umpire2b?: string | null; umpire3b?: string | null;
  startedAt?: string | null;          // inicio real — reloj de juego
  endedAt?: string | null;
  pausedAt?: string | null;           // reloj pausado desde este momento
  pauseSecs?: number;                 // segundos acumulados en pausa
  pausedAuto?: boolean;               // pausa automática (app cerrada) — se reanuda sola al volver
  wpId?: string | null; lpId?: string | null; svId?: string | null;
  hldIds?: string | null;             // JSON [playerId]
  bsIds?: string | null;              // JSON [playerId] — blown saves
  auditLog?: AuditEntry[] | null;     // bitácora de auditoría post-final
  tied?: boolean;                     // empate: sin W ni L
  forfeitBy?: string | null;          // teamId que perdió por forfeit
  fScoreAway?: number | null; fScoreHome?: number | null; // marcador forfeit (override)
  seasonApplied?: boolean;            // stats ya acumuladas en temporada
  dhAway?: number;                    // doble jornada: n-ésimo juego del visitante ese día (2, 3…)
  dhHome?: number;                    // doble jornada: n-ésimo juego del local ese día
  homeTeamId: string; awayTeamId: string; note?: string;
  leagueId?: string | null;
  seasonId?: string | null;           // temporada dentro de la liga
  seriesId?: string | null;           // juego de playoff (serie) — stats scope POST
  league?: (League & { sprayInput?: boolean }) | null; // GET /games/:id incluye {sprayInput}
  homeTeam?: Team & { players?: Player[] };
  awayTeam?: Team & { players?: Player[] };
  lineups?: LineupEntry[];
  events?: GameEvent[];
  statLines?: StatLine[];             // juegos importados sin eventos (BallStat)
  statPlayers?: Pick<Player, 'id' | 'firstName' | 'lastName'>[]; // nombres de statLines fuera de roster
  state?: GameState;
  _count?: { events: number };
}

// ---- Vista previa del box score BallScore (importación de un juego) ----
export interface BoxPlayerPreview {
  key: string;                    // "equipo|NOMBRE" — clave de override
  file: string;                   // nombre como viene en el archivo
  teamFile: string;
  section: 'bat' | 'pit' | 'fld';
  pos?: string; dec?: string;
  stats: Record<string, number>;
  partial?: boolean;              // solo aparece en las notas del box (sin fila en la tabla)
  noName?: boolean;               // el archivo trae solo la posición ("P") en vez de nombre
  ambiguous?: boolean;            // apellido solo + 2+ candidatos empatados — confirmar a mano
  matchId: string | null; matchName: string | null; matchScore: number;
  matchTeam?: string | null;          // equipo donde vive el match propuesto
  moved?: boolean;                    // matcheó en OTRO equipo — traspasado desde la fecha del juego
  candidates: { playerId: string; name: string; score: number; team?: string; sameTeam?: boolean }[];
  action: 'auto' | 'picked' | 'new' | 'skip';
}
export interface BoxPreview {
  ok: boolean; dry: boolean;
  box: { dateIso: string; away: string; home: string; scoreAway: number; scoreHome: number; innings: number; wp?: string; lp?: string; sv?: string };
  awayTeam: { file: string; teamId: string | null; name: string | null };
  homeTeam: { file: string; teamId: string | null; name: string | null };
  teams: { file: string; teamId: string | null; name: string | null }[];
  players: BoxPlayerPreview[];
  roster?: { id: string; name: string; team: string }[]; // toda la liga — búsqueda manual
  dupGameId: string | null;
  warnings: string[];
}

/** Fila agregada de un ZIP de .box.txt — acumulado por (equipo del archivo, nombre). */
export interface BoxZipPlayer {
  key: string; name: string; team: string; suggested?: boolean;
  dup?: boolean; // el nombre apareció 2+ veces en un mismo juego (homónimos — números posiblemente ambiguos)
  stats: Record<string, number>; // columnas statLines + g (juegos del zip)
}
export interface BoxZipTotals {
  ok: boolean; files: number; skipped: string[]; year: number;
  players: BoxZipPlayer[];
  current: Record<string, number> | null; // PlayerSeasonStat REG actual (o null)
}

export interface FinishData {
  score: { away: number; home: number };
  winner: 'away' | 'home' | 'tie';
  tied: boolean;
  suggestedWpId: string | null;
  suggestedLpId: string | null;
  /** por qué se sugirió el WP (regla 9.17): abridor calificado / récord / relevista efectivo */
  wpKind?: 'starter' | 'record' | 'effective' | 'ineffective' | null;
  wpStarterOuts?: number;             // outs del abridor ganador
  wpMinStarterOuts?: number;          // mínimo reglamentario (ceil(innings/2)·3)
  cgIds: string[];                    // juego completo — automático
  shoIds: string[];                   // blanqueada individual — automático
}

export interface GameDecisions {
  wpId?: string | null; lpId?: string | null; svId?: string | null;
  hldIds?: string[]; bsIds?: string[]; tied?: boolean;
}

/** Entrada de la bitácora de auditoría post-final (Game.auditLog) */
export interface AuditEntry {
  at: string; user: string; reason?: string | null;
  ops: { a: string; seq?: number; r?: string }[];
  scoreBefore: { away: number; home: number }; scoreAfter: { away: number; home: number };
  decisions?: GameDecisions | null;
}
export interface AuditOp {
  action: 'edit' | 'delete' | 'deleteFrom' | 'insert';
  seq?: number; beforeSeq?: number;
  result?: string; notation?: string | null; batterId?: string | null; pitcherId?: string | null;
  inning?: number; half?: 'TOP' | 'BOTTOM';
  advances?: { playerId: string; to: number | 'HOME' | 'OUT' }[];
  event?: { result: string; notation?: string | null; batterId?: string | null; pitcherId?: string | null; inning: number; half: 'TOP' | 'BOTTOM'; advances: { playerId: string; to: number | 'HOME' | 'OUT' }[] };
}
export interface AuditResult {
  ok: true; state: GameState; score: { away: number; home: number };
  outcomeChanged: boolean; trimmed: number; audit: AuditEntry;
}

// ---- Auth: token Bearer guardado en localStorage (opt-in del server) ----
export interface AuthUser { id: string; username: string; role: 'admin' | 'anotador' | 'visita'; active: boolean }
/** Plantilla de alineación nombrada — "Mis Alineaciones" (varias por equipo) */
export interface LineupTpl { id: string; name: string; at: number; entries: { playerId: string; position: string; batsInOrder?: boolean }[] }
export const parseLineupTpls = (raw?: string | null): LineupTpl[] => {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return [{ id: 'legacy', name: 'Plantilla guardada', at: 0, entries: j }];
    if (j && Array.isArray(j.items)) return j.items as LineupTpl[];
  } catch { /* corrupto → vacío */ }
  return [];
};
const TOKEN_KEY = 'poxscore-token';
export function getToken() { return localStorage.getItem(TOKEN_KEY) ?? ''; }
export function setToken(t: string) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }

/** Se dispara cuando un request devuelve 401 → App muestra el login. */
let onAuthRequired: (() => void) | null = null;
export function setAuthRequiredHandler(fn: () => void) { onAuthRequired = fn; }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const tok = getToken();
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    ...init,
  });
  if (!res.ok) {
    // 401 de /auth/* son errores de credenciales (login fallido, clave admin
    // incorrecta en PassModal) — no deben abrir el modal de login
    if (res.status === 401 && !path.startsWith('/auth/')) onAuthRequired?.();
    const text = await res.text();
    throw new Error(text || `Error ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ---- Cola offline: si el POST falla por red, se guarda y reintenta ----
const OUTBOX_KEY = 'poxscore-outbox';
interface QueuedEvent { gameId: string; payload: object; queuedAt: string }

function readQueue(): QueuedEvent[] {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]'); } catch { return []; }
}
function writeQueue(q: QueuedEvent[]) { localStorage.setItem(OUTBOX_KEY, JSON.stringify(q)); }

export function pendingCount(): number { return readQueue().length; }
export function queueItems(): QueuedEvent[] { return readQueue(); }
export function clearQueue() { writeQueue([]); }

export async function flushQueue(): Promise<number> {
  const q = readQueue();
  let sent = 0;
  const remaining: QueuedEvent[] = [];
  for (const item of q) {
    try {
      await request(`/games/${item.gameId}/events`, { method: 'POST', body: JSON.stringify(item.payload) });
      sent++;
    } catch { remaining.push(item); }
  }
  writeQueue(remaining);
  return sent;
}

export const api = {
  health: () => request<{ ok: boolean; v?: string; lan?: string[] }>('/health'),
  authStatus: () => request<{ enabled: boolean; user: AuthUser | null }>('/auth/status'),
  login: (username: string, password: string) =>
    request<{ token: string; user: AuthUser }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  users: () => request<AuthUser[]>('/auth/users'),
  createUser: (u: { username: string; password: string; role?: string }) =>
    request<AuthUser & { token?: string }>('/auth/users', { method: 'POST', body: JSON.stringify(u) }),
  updateUser: (id: string, u: { password?: string; role?: string; active?: boolean }) =>
    request<AuthUser>(`/auth/users/${id}`, { method: 'PUT', body: JSON.stringify(u) }),
  deleteUser: (id: string) => request<{ ok: boolean }>(`/auth/users/${id}`, { method: 'DELETE' }),
  // segundo factor estilo macOS: confirma la contraseña antes de borrar
  verifyPass: (password: string) =>
    request<{ ok: boolean }>('/auth/verify', { method: 'POST', body: JSON.stringify({ password }) }),
  teams: () => request<Team[]>('/teams'),
  team: (id: string) => request<Team & { players: Player[] }>(`/teams/${id}`),
  createTeam: (data: Partial<Team>) => request<Team>('/teams', { method: 'POST', body: JSON.stringify(data) }),
  deleteTeam: (id: string, password: string) =>
    request<void>(`/teams/${id}`, { method: 'DELETE', body: JSON.stringify({ password }) }),
  addPlayer: (teamId: string, p: Partial<Player>) => request<Player>(`/teams/${teamId}/players`, { method: 'POST', body: JSON.stringify(p) }),
  updatePlayer: (teamId: string, pid: string, p: Partial<Player>) => request<Player>(`/teams/${teamId}/players/${pid}`, { method: 'PUT', body: JSON.stringify(p) }),
  bulkMovePlayers: (teamId: string, playerIds: string[], toTeamId: string) =>
    request<{ moved: number }>(`/teams/${teamId}/players/bulk-move`, { method: 'POST', body: JSON.stringify({ playerIds, toTeamId }) }),
  deletePlayer: (teamId: string, pid: string, password: string) =>
    request<void>(`/teams/${teamId}/players/${pid}`, { method: 'DELETE', body: JSON.stringify({ password }) }),
  // excluir/incluir de la publicación web — el dato queda en el sistema
  blockTeam: (id: string, blocked: boolean) =>
    request<Team>(`/teams/${id}/block`, { method: 'PUT', body: JSON.stringify({ blocked }) }),
  blockPlayer: (teamId: string, pid: string, blocked: boolean) =>
    request<Player>(`/teams/${teamId}/players/${pid}/block`, { method: 'PUT', body: JSON.stringify({ blocked }) }),
  bulkPlayers: (teamId: string, players: object[]) =>
    request<{ created: number; skipped: number }>(`/teams/${teamId}/players/bulk`, { method: 'POST', body: JSON.stringify({ players }) }),

  games: () => request<Game[]>('/games'),
  game: (id: string) => request<Game>(`/games/${id}`),
  createGame: (data: object) => request<Game>('/games', { method: 'POST', body: JSON.stringify(data) }),
  setLineup: (gameId: string, teamId: string, entries: object[]) =>
    request<LineupEntry[]>(`/games/${gameId}/lineup/${teamId}`, { method: 'PUT', body: JSON.stringify({ entries }) })
      .then((r) => {
        // un lineup real apaga el modo "orden armándose" (sin-lineup) que pudiera
        // quedar pegado en localStorage — si sobrevive, al dar la vuelta el orden
        // no hay bateador resuelto y el panel de anotar se apaga sin razón
        try {
          const k = `pox-lu-${gameId}`;
          const m = JSON.parse(localStorage.getItem(k) ?? '{}') as Record<string, string>;
          if (m[teamId]) { delete m[teamId]; localStorage.setItem(k, JSON.stringify(m)); }
        } catch { /* noop */ }
        return r;
      }),
  // anotar sin lineup: agrega un bateador al final del orden (no toca el resto)
  lineupAdd: (gameId: string, teamId: string, data: { playerId: string; position?: string }) =>
    request<LineupEntry>(`/games/${gameId}/lineup-add/${teamId}`, { method: 'POST', body: JSON.stringify(data) }),
  saveLineupTemplate: (gameId: string, teamId: string, entries: object[], opts?: { name?: string; tplId?: string }) =>
    request<{ ok: boolean; templates: LineupTpl[]; tplId?: string }>(`/games/${gameId}/lineup-template/${teamId}`, { method: 'POST', body: JSON.stringify({ entries, ...opts }) }),
  deleteLineupTemplate: (gameId: string, teamId: string, tplId: string) =>
    request<{ ok: boolean; templates: LineupTpl[] }>(`/games/${gameId}/lineup-template/${teamId}`, { method: 'POST', body: JSON.stringify({ deleteId: tplId }) }),
  renameLineupTemplate: (gameId: string, teamId: string, tplId: string, name: string) =>
    request<{ ok: boolean; templates: LineupTpl[] }>(`/games/${gameId}/lineup-template/${teamId}`, { method: 'POST', body: JSON.stringify({ renameId: tplId, name }) }),
  pauseGame: (id: string, auto?: boolean) => request<Game>(`/games/${id}/pause`, { method: 'POST', body: JSON.stringify({ auto }) }),
  startGame: (id: string, data?: { date?: string; stadium?: string; umpireHp?: string; umpire1b?: string; umpire2b?: string; umpire3b?: string }) =>
    request<Game>(`/games/${id}/start`, { method: 'POST', body: JSON.stringify(data ?? {}) }),
  finishData: (id: string) => request<FinishData>(`/games/${id}/finish-data`),
  finishGame: (id: string, decisions: GameDecisions) =>
    request<Game>(`/games/${id}/finish`, { method: 'POST', body: JSON.stringify(decisions) }),
  suspendGame: (id: string) => request<Game>(`/games/${id}/suspend`, { method: 'POST' }),
  updateGame: (id: string, data: { sport?: string; innings?: number; ghostRunner?: boolean; leagueId?: string | null; seriesId?: string | null; note?: string; status?: string; stadium?: string; date?: string; awayTeamId?: string; homeTeamId?: string; umpireHp?: string; umpire1b?: string; umpire2b?: string; umpire3b?: string; startedAt?: string }) =>
    request<Game>(`/games/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  swapSides: (id: string) => request<Game>(`/games/${id}/swap-sides`, { method: 'POST' }),
  gameCard: (gameId: string, playerId: string) => request<GameCard>(`/games/${gameId}/card/${playerId}`),
  head2head: (a: string, b: string) => request<Head2Head>(`/stats/head2head?a=${a}&b=${b}`),
  forfeitGame: (id: string, data: { forfeitBy: string; scoreAway: number; scoreHome: number } & GameDecisions) =>
    request<Game>(`/games/${id}/forfeit`, { method: 'POST', body: JSON.stringify(data) }),
  substitute: (gameId: string, data: { teamId: string; outPlayerId: string; inPlayerId: string; position?: string; subInInning?: number; subInHalf?: 'TOP' | 'BOTTOM' }) =>
    request<LineupEntry>(`/games/${gameId}/substitute`, { method: 'POST', body: JSON.stringify(data) }),
  // corrección de identidad: las jugadas ya anotadas pasan al jugador correcto (swap si ambos estaban en lineup)
  swapPlayer: (gameId: string, data: { teamId: string; aId: string; bId: string }) =>
    request<{ ok: boolean; swapped: boolean; eventsFixed: number; lineups: LineupEntry[] }>(`/games/${gameId}/swap-player`, { method: 'POST', body: JSON.stringify(data) }),
  // alt-drag en la hoja: intercambia el lugar en el orden CON sus anotaciones (seqs de turnos)
  swapOrder: (gameId: string, data: { teamId: string; aId: string; bId: string }) =>
    request<{ ok: boolean; pasMoved: number; lineups: LineupEntry[] }>(`/games/${gameId}/swap-order`, { method: 'POST', body: JSON.stringify(data) }),
  undoSub: (gameId: string, entryId: string) =>
    request<{ ok: boolean; restored: string; role: string; lineups: LineupEntry[] }>(`/games/${gameId}/undo-sub`, { method: 'POST', body: JSON.stringify({ entryId }) }),
  setPositions: (gameId: string, teamId: string, entries: { playerId: string; position: string }[]) =>
    request<LineupEntry[]>(`/games/${gameId}/positions/${teamId}`, { method: 'PUT', body: JSON.stringify({ entries }) }),
  updateTeam: (id: string, data: Partial<Team>) =>
    request<Team>(`/teams/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteGame: (id: string, password: string) =>
    request<void>(`/games/${id}`, { method: 'DELETE', body: JSON.stringify({ password }) }),

  // importar un juego desde box score BallScore (.box.txt) — módulo 🛡 Admin
  boxscorePreview: (data: { leagueId: string; name?: string; data: string }) =>
    request<BoxPreview>('/import/boxscore', { method: 'POST', body: JSON.stringify({ ...data, dry: true }) }),
  boxscoreImport: (data: { leagueId: string; name?: string; data: string; awayTeamId?: string; homeTeamId?: string; seasonId?: string; overrides?: Record<string, string>; newNames?: Record<string, string> }) =>
    request<{ ok: boolean; gameId: string; players: number; created: number; skipped: string[]; warnings: string[] }>(
      '/import/boxscore', { method: 'POST', body: JSON.stringify(data) }),
  /** ZIP de .box.txt → totales por jugador (solo lectura — comparar y aplicar con updatePlayerSeason) */
  boxscoreZipTotals: (data: { leagueId: string; playerId?: string; data: string }) =>
    request<BoxZipTotals>('/import/boxscore/zip-totals', { method: 'POST', body: JSON.stringify(data) }),

  events: (gameId: string) => request<GameEvent[]>(`/games/${gameId}/events`),
  // edición de jugada desde el módulo 🛡 Admin (solo admin): resultado, notación,
  // bateador, lanzador, entrada y avances — el server recalcula PO/A/errorOn
  updateEvent: (gameId: string, seq: number, data: { result?: string; notation?: string | null; batterId?: string | null; pitcherId?: string | null; advances?: { playerId: string; to: number | 'HOME' | 'OUT' }[]; inning?: number; half?: 'TOP' | 'BOTTOM'; sprayDir?: number | null; sprayDist?: number | null }) =>
    request<{ event: GameEvent; state: GameState }>(`/games/${gameId}/events/${seq}`, { method: 'PUT', body: JSON.stringify(data) }),
  // decisiones del juego (W/L/SV/HLD/BS, empate, marcador forfeit) — solo admin
  updateDecisions: (id: string, data: { wpId?: string | null; lpId?: string | null; svId?: string | null; hldIds?: string[] | null; bsIds?: string[] | null; tied?: boolean; forfeitBy?: string | null; fScoreAway?: number | null; fScoreHome?: number | null }) =>
    request<Game>(`/games/${id}/decisions`, { method: 'PUT', body: JSON.stringify(data) }),
  // auditoría de juego (admin): edita/inserta/borra jugadas post-final, recalcula
  // todo (estado, boxscore, temporada, standing) y exige decisiones si el
  // resultado cambia — 409 {needDecisions} si faltan
  auditGame: (gameId: string, ops: AuditOp[], decisions?: GameDecisions | null, reason?: string) =>
    request<AuditResult>(`/games/${gameId}/audit`, { method: 'POST', body: JSON.stringify({ ops, decisions, reason }) }),
  // línea manual de stats: jugador que estuvo y no se anotó (módulo admin)
  setStatLine: (gameId: string, playerId: string, data: { teamId?: string; stats: Record<string, number>; lineup?: { add?: boolean; order?: number; position?: string; role?: string } }) =>
    request<{ ok: boolean; statLines: StatLine[]; lineupAdded: boolean; seasonAdjusted: boolean; lineups: LineupEntry[] }>(
      `/games/${gameId}/stat-lines/${playerId}`, { method: 'PUT', body: JSON.stringify(data) }),
  delStatLine: (gameId: string, playerId: string, removeLineup = false) =>
    request<{ ok: boolean; statLines: StatLine[] }>(
      `/games/${gameId}/stat-lines/${playerId}${removeLineup ? '?lineup=1' : ''}`, { method: 'DELETE' }),
  addEvent: async (gameId: string, payload: { batterId?: string; pitcherId?: string; result: string; notation?: string | null; advances: { playerId: string; to: number | 'HOME' | 'OUT' }[]; inning?: number; half?: 'TOP' | 'BOTTOM'; aiVoice?: string; aiJson?: string; aiVideo?: string; clientKey?: string; sprayDir?: number; sprayDist?: number; beforeSeq?: number }) => {
    try {
      return await request<{ event: GameEvent; state: GameState }>(`/games/${gameId}/events`, { method: 'POST', body: JSON.stringify(payload) });
    } catch (e) {
      // solo fallos de RED van a la cola offline — errores HTTP (401/403/400) no reintentan
      if (e instanceof TypeError) {
        const q = readQueue();
        q.push({ gameId, payload, queuedAt: new Date().toISOString() });
        writeQueue(q);
      }
      throw e;
    }
  },
  undoEvent: (gameId: string) => request<{ state: GameState }>(`/games/${gameId}/events/last`, { method: 'DELETE' }),
  // borra UNA jugada — "Limpiar celda completa" (clic derecho en la planilla)
  deleteEvent: (gameId: string, seq: number) =>
    request<{ deleted: number; state: GameState }>(`/games/${gameId}/events/${seq}`, { method: 'DELETE' }),
  // ── módulos AI ──
  aiConfig: () => request<{ openai: boolean }>(`/ai/config`),
  aiSaveKey: (openaiKey: string) =>
    request<{ ok: boolean; openai: boolean; valid: boolean | null; error?: string }>(`/ai/config`, { method: 'POST', body: JSON.stringify({ openaiKey }) }),
  aiNotation: (transcript: string, gameId?: string) =>
    request<{
      ok: boolean; source: string; transcript: string; result: string; notation: string | null;
      advances?: { playerId: string; to: number | 'HOME' | 'OUT'; via: string }[];
      batterId?: string | null; playerNames?: string[]; note?: string;
      // comandos: "cambio lanzador X"→'PC'|'RL' con pitcher resuelto ·
      // "bateador emergente X"→'SUB' · "corredor emergente X"→'CR' (playerName)
      action?: 'PC' | 'RL' | 'SUB' | 'CR'; pitcherId?: string | null; pitcherName?: string | null; playerId?: string | null; playerName?: string | null;
      ai: { play_code: string; runs_scored: number; outs_made: number | null; description_spanish: string };
    }>('/ai/notation', { method: 'POST', body: JSON.stringify({ transcript, gameId }) }),
  validatePlay: (gameId: string, data: { result: string; advances: { playerId: string; to: number | 'HOME' | 'OUT' }[] }) =>
    request<{ is_valid: boolean; errors: { error: string; suggestion: string }[] }>(`/games/${gameId}/validate-play`, { method: 'POST', body: JSON.stringify(data) }),
  narrate: (gameId: string) =>
    request<{ narration: string; seq: number }>(`/games/${gameId}/narrate`, { method: 'POST' }),
  aiInsights: (gameId: string) =>
    request<{ winProb: { away: number; home: number }; batter: { playerId: string; name: string; risp: { ab: number; h: number } | null; vsPitcher: { ab: number; h: number } | null } | null; pitcher: { playerId: string; name: string; pitches: number } | null; insight: string | null; ai: boolean }>(`/games/${gameId}/insights`),
  gameShare: (gameId: string) =>
    request<{ score: { away: number; home: number }; winner: string | null; mvp: { id: string; name: string; line: string } | null; summary: string; headlines: string[]; whatsapp: string; facebook: string; ai: boolean }>(`/games/${gameId}/share`),
  videoAnalyze: () =>
    request<{ ok: boolean; detected_play: string; direction: string; suggested_code: string; confidence: number; result: string; notation: string | null; mock: boolean }>('/ai/video-analyze', { method: 'POST' }),
  aiAsk: (question: string) =>
    request<{ ok: boolean; answer: string; stat: string | null; filter: string | null; players: { id: string; name: string; team: string; value: number | null; line?: string; g: number; ab: number; h: number; hr: number; rbi: number }[]; ai: boolean }>('/ai/ask', { method: 'POST', body: JSON.stringify({ question }) }),
  aiTranscribe: (audio: string, mime: string) =>
    request<{ ok: boolean; transcript: string }>('/ai/transcribe', { method: 'POST', body: JSON.stringify({ audio, mime }) }),
  /** borra la jugada `fromSeq` y todas las posteriores (corrección de errores de anotación) */
  deleteEventsFrom: (gameId: string, fromSeq: number) =>
    request<{ deleted: number; state: GameState }>(`/games/${gameId}/events?fromSeq=${fromSeq}`, { method: 'DELETE' }),

  boxscore: (gameId: string) => request<Boxscore>(`/stats/games/${gameId}/boxscore`),
  boxscoreAi: (gameId: string) => request<{ boxscore: Boxscore; playByPlay: string; teams: { away: string; home: string }; status: string }>(`/games/${gameId}/boxscore-ai`),
  playerStats: (playerId: string) => request<Record<string, unknown>>(`/stats/players/${playerId}`),
  searchPlayers: (q: string) =>
    request<PlayerSearchHit[]>(`/stats/search-players?q=${encodeURIComponent(q)}`),
  playerFull: (playerId: string) => request<PlayerFull>(`/stats/players/${playerId}/full`),
  playerSpray: (playerId: string) => request<PlayerSpray>(`/stats/players/${playerId}/spray`),
  playerPitchLoc: (playerId: string) => request<PitchLoc>(`/stats/players/${playerId}/pitchloc`),
  playerMatchups: (playerId: string, year?: number | 'all') =>
    request<PlayerMatchups>(`/stats/players/${playerId}/matchups${typeof year === 'number' ? `?year=${year}` : ''}`),
  matchup: (batterId: string, pitcherId: string) =>
    request<MatchupInfo>(`/stats/matchup?a=${batterId}&b=${pitcherId}`),
  playerSituational: (playerId: string, opts: { year?: number; scope?: 'REG' | 'POST' } = {}) =>
    request<PlayerSituational>(`/stats/players/${playerId}/situational?${new URLSearchParams(
      Object.entries(opts).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]),
    ).toString()}`),
  playerList: () => request<PlayerListItem[]>('/stats/player-list'),
  updatePlayerSeason: (playerId: string, body: { season: number; scope?: string } & Record<string, number>) =>
    request<{ ok: boolean; stat: SeasonStat }>(`/stats/players/${playerId}/season`, { method: 'PUT', body: JSON.stringify(body) }),
  report: (body: ReportRequest) =>
    request<ReportResponse>('/stats/report', { method: 'POST', body: JSON.stringify(body) }),
  // reconstruye los acumulados de un año desde los juegos (repara desfases)
  recalcStats: (year: number) =>
    request<{ ok: boolean; year: number; games: number; updated: number; created: number; cleared: number; markedApplied: number }>('/stats/recalc', { method: 'POST', body: JSON.stringify({ year }) }),
  sqlQuery: (sql: string) =>
    request<SqlResult>('/stats/sql', { method: 'POST', body: JSON.stringify({ sql }) }),
  mergePlayers: (removeId: string, keepId: string) =>
    request<{ ok: boolean; moved: Record<string, number>; eliminado: string; queda: string }>(
      '/stats/merge-player', { method: 'POST', body: JSON.stringify({ removeId, keepId }) }),

  // ---- Publicar por FTP/SFTP (servidor remoto) ----
  ftpProfiles: () => request<FtpProfilePublic[]>('/publish/profiles'),
  saveFtpProfile: (p: Partial<FtpProfilePublic> & { pass?: string }) =>
    request<FtpProfilePublic>('/publish/profiles', { method: 'POST', body: JSON.stringify(p) }),
  deleteFtpProfile: (id: string) =>
    request<{ ok: true }>(`/publish/profiles/${id}`, { method: 'DELETE' }),
  testFtp: (p: { profileId?: string } | Partial<FtpProfilePublic> & { pass?: string }) =>
    request<{ ok: boolean; files?: number; log?: string[]; error?: string }>('/publish/test', { method: 'POST', body: JSON.stringify(p) }),
  connectFtp: (p: { profileId?: string } | Partial<FtpProfilePublic> & { pass?: string }) =>
    request<{ ok: boolean; path?: string; files?: RemoteEntry[]; log?: string[]; error?: string }>('/publish/connect', { method: 'POST', body: JSON.stringify(p) }),
  uploadFtp: (profileId: string, files: { name: string; content: string; base64?: boolean }[]) =>
    request<{ ok: boolean; uploaded?: string[]; log?: string[]; error?: string }>('/publish/upload', { method: 'POST', body: JSON.stringify({ profileId, files }) }),
  publishLeague: (profileId: string, leagueId: string) =>
    request<{ ok: boolean; file?: string; bytes?: number; log?: string[]; error?: string }>('/publish/publish-league', { method: 'POST', body: JSON.stringify({ profileId, leagueId }) }),

  // ---- Ligas / torneos ----
  leagues: () => request<League[]>('/leagues'),
  importLeague: (payload: { name?: string; data: unknown; encoding?: string; appendToLeagueId?: string; mergeSameName?: boolean; replaceSeason?: boolean; mergeSeason?: boolean; playerAliases?: { from: string; fromTeam?: string; to: string }[] }, dry = false) =>
    request<ImportResult>(`/import${dry ? '?dry=1' : ''}`, { method: 'POST', body: JSON.stringify(payload) }),
  league: (id: string) => request<League>(`/leagues/${id}`),
  createLeague: (data: { name: string; year?: number; sport: string }) =>
    request<League>('/leagues', { method: 'POST', body: JSON.stringify(data) }),
  // temporadas dentro de la liga (nueva temporada / terminar / reactivar)
  createSeason: (leagueId: string, year: number) =>
    request<{ season: Season }>(`/leagues/${leagueId}/seasons`, { method: 'POST', body: JSON.stringify({ year }) }),
  updateSeason: (leagueId: string, seasonId: string, status: 'ACTIVE' | 'ENDED') =>
    request<{ season: Season }>(`/leagues/${leagueId}/seasons/${seasonId}`, { method: 'PUT', body: JSON.stringify({ status }) }),
  deleteSeason: (leagueId: string, seasonId: string) =>
    request<void>(`/leagues/${leagueId}/seasons/${seasonId}`, { method: 'DELETE' }),
  rolloverLeague: (id: string, year: number) =>
    request<{ season: Season; league: League }>(`/leagues/${id}/rollover`, { method: 'POST', body: JSON.stringify({ year }) }),
  updateLeague: (id: string, data: { name?: string; year?: number; sport?: string; innings?: number | null; qualPa?: number; qualIp?: number; playoffTeams?: number | null; playoffRounds?: number | null; tb?: string; sprayInput?: boolean; wpMinOuts?: number | null }) =>
    request<League>(`/leagues/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  genSchedule: (id: string, data: {
    startDate?: string; endDate?: string; mode?: 'normal' | 'triangular'; playDays?: number[];
    daysBetween?: number; rounds?: number; seriesLen?: number; doubleheader?: boolean;
    seriesStyle?: 'ida-vuelta' | 'random'; divRounds?: number; firstHomeId?: string;
    firstAwayId?: string; gamesPerDay?: number;
  }) =>
    request<{ created: number; jornadas: number; mode: string; rounds?: number; daysBetween?: number }>(`/leagues/${id}/schedule`, { method: 'POST', body: JSON.stringify(data) }),
  clearSchedule: (id: string) =>
    request<{ deleted: number }>(`/leagues/${id}/schedule`, { method: 'DELETE' }),
  deleteLeague: (id: string, password: string) =>
    request<void>(`/leagues/${id}/delete`, { method: 'POST', body: JSON.stringify({ password }) }),
  // respaldos automáticos del server — restaurar una liga a su estado previo
  backupAuto: () => request<{ dir: string; files: string[] }>('/backup/auto'),
  backupRestorePreview: (file: string) =>
    request<{ file: string; leagues: BackupLeagueInfo[] }>('/backup/restore-preview', { method: 'POST', body: JSON.stringify({ file }) }),
  backupRestoreScan: (league: string) =>
    request<{ league: string; files: (BackupLeagueInfo & { file: string; found: boolean; mtime?: string })[] }>(
      '/backup/restore-scan', { method: 'POST', body: JSON.stringify({ league }) }),
  backupRestoreLeague: (file: string, league: string, password: string) =>
    request<{ ok: boolean; league: string; replaced: boolean; years: number[]; teams: number; players: number; games: number }>(
      '/backup/restore-league', { method: 'POST', body: JSON.stringify({ file, league, password }) }),
  leagueStandings: (id: string, filter: { year?: number; season?: string } = {}) =>
    request<StandingRow[]>(`/leagues/${id}/standings?${filter.year ? `year=${filter.year}&` : ''}${filter.season ? `season=${filter.season}` : ''}`),
  leagueStats: (id: string, phase: 'reg' | 'post' | 'all' = 'reg', filter: { year?: number; season?: string; round?: number } = {}) =>
    request<LeagueStats>(`/leagues/${id}/stats?phase=${phase}${filter.year ? `&year=${filter.year}` : ''}${filter.season ? `&season=${filter.season}` : ''}${filter.round ? `&round=${filter.round}` : ''}`),
  leagueSplits: (id: string, season?: string) => request<LeagueSplits>(`/leagues/${id}/splits${season ? `?season=${season}` : ''}`),
  leagueSeries: (id: string, opts?: { season?: string }) => request<PlayoffSeries[]>(`/leagues/${id}/series${opts?.season ? `?season=${opts.season}` : ''}`),
  createSeries: (id: string, d: { round: number; name?: string; homeTeamId: string; awayTeamId: string; winsNeeded: number; seasonId?: string }) =>
    request<PlayoffSeries>(`/leagues/${id}/series`, { method: 'POST', body: JSON.stringify(d) }),
  updateSeries: (id: string, sid: string, d: Partial<PlayoffSeries>) =>
    request<PlayoffSeries>(`/leagues/${id}/series/${sid}`, { method: 'PUT', body: JSON.stringify(d) }),
  deleteSeries: (id: string, sid: string) =>
    request<void>(`/leagues/${id}/series/${sid}`, { method: 'DELETE' }),
  setByes: (id: string, round: number, teamIds: string[]) =>
    request<Record<string, string[]>>(`/leagues/${id}/byes`, { method: 'PUT', body: JSON.stringify({ round, teamIds }) }),
  playerSplits: (playerId: string, year?: number | 'all') =>
    request<PlayerSplits>(`/stats/players/${playerId}/splits${typeof year === 'number' ? `?year=${year}` : ''}`),
};

export interface StandingRow {
  teamId: string; name: string; division?: string | null; w: number; l: number; t: number;
  rf: number; ra: number; pct: number; diff: number; gb: number;
  streak?: string | null;              // 'G3' / 'P2' / 'E1'
  last10?: { w: number; l: number; t: number };
  form?: ('W' | 'L' | 'T')[];          // últimos 5 resultados
  vs?: Record<string, { w: number; l: number; t: number }>; // matriz cara-a-cara
}

interface SituLine { ab: number; h: number }
export interface LeagueBatting {
  playerId: string; teamId: string; name: string; teamName: string; shortName: string;
  g: number; pa: number; ab: number; r: number; h: number;
  doubles: number; triples: number; hr: number; rbi: number;
  bb: number; k: number; hbp: number; sac: number; sf: number; sb: number;
  avg: number; obp: number; slg: number; ops: number; iso: number; babip: number;
  woba?: number; wraa?: number; war?: number;   // WAR* estimado del server (alimenta el MVP)
  situ: { risp: SituLine; loaded: SituLine; twoOut: SituLine; leadoff: SituLine };
}
export interface LeaguePitching {
  playerId: string; teamId: string; name: string; teamName: string; shortName: string;
  gp: number; gs: number; w: number; l: number; sv: number; hld: number;
  bs: number; cg: number; sho: number; // blown save / juego completo / blanqueada
  outs: number; ip: number; h: number; r: number; er: number;
  bb: number; k: number; hr: number; pitches: number;
  era: number; whip: number; k9: number; bb9: number;
  fip?: number; war?: number;                 // FIP y WAR* estimado del server (alimenta el MVP)
}
export interface LeagueFielding {
  playerId: string; name: string; teamName: string; shortName: string;
  po: number; a: number; e: number; tc: number; fpct: number;
}
export interface LeagueTeamTotals {
  teamId: string; name: string; g: number;
  ab: number; r: number; h: number; doubles: number; triples: number; hr: number;
  rbi: number; bb: number; k: number; sb: number; e: number; lob: number;
  pOuts: number; pH: number; pR: number; pER: number; pBB: number; pK: number;
}
export interface LeagueStats {
  batting: LeagueBatting[]; pitching: LeaguePitching[]; fielding: LeagueFielding[];
  teamTotals: LeagueTeamTotals[];
  games: number;
}

// ---- Splits de tiempo (BallStat): por mes / últimos N juegos / rachas ----
export interface StreakLine {
  playerId: string; name: string; shortName: string;
  hitCur: number; hitBest: number;   // racha de juegos con hit (actual / mejor)
  obCur: number; obBest: number;     // embasándose (H+BB+HBP)
  kCur: number; kBest: number;       // juegos ponchándose
  droughtCur: number; droughtBest: number; // sequía sin hit
}
export interface LeagueSplits {
  byMonth: (LeagueStats & { month: string })[];
  lastN: (LeagueStats & { n: number })[];
  streaks: StreakLine[];
}
export interface PlayerSplitSet {
  games: number;
  batting: LeagueBatting | null;
  pitching: LeaguePitching | null;
  fielding: LeagueFielding | null;
}
export interface PlayerSplits {
  byMonth: (PlayerSplitSet & { month: string })[];
  lastN: (PlayerSplitSet & { n: number })[];
  streaks: Omit<StreakLine, 'playerId' | 'name' | 'shortName'>;
}

// ---- Tarjeta completa del jugador (estilo MLB / BallStat) ----
export interface PlayerBattingLine {
  g?: number; pa: number; ab: number; r: number; h: number;
  doubles: number; triples: number; hr: number; rbi: number;
  bb: number; k: number; hbp?: number; sac: number; sf: number; sb: number;
  avg?: number; obp?: number; slg?: number; ops?: number;
}
export interface PlayerPitchingLine {
  gp?: number; gs?: number; w?: number; l?: number; sv?: number; hld?: number;
  bs?: number; cg?: number; sho?: number; outs: number; h: number; r: number; er: number;
  bb: number; k: number; hr: number; pitches?: number;
  era?: number; whip?: number;
}
export interface PlayerFieldingLine { po: number; a: number; e: number; tc: number; fpct: number }
export interface GameLogEntry {
  gameId: string; date?: string; team?: string | null; vs?: string;
  batting: PlayerBattingLine | null; pitching: PlayerPitchingLine | null;
}
export interface TournamentBlock {
  batting: PlayerBattingLine; pitching: PlayerPitchingLine; fielding: PlayerFieldingLine;
  teams: { id: string; name: string; shortName: string | null }[]; // orden cronológico A→B→C
  stints: { teamId: string; team: string; year?: number; g: number; batting: PlayerBattingLine; pitching: PlayerPitchingLine; fielding: PlayerFieldingLine }[];
  log: GameLogEntry[];
}
export interface YearBlock extends TournamentBlock { year: number } // temporada dentro de la liga
export interface TournamentLine extends TournamentBlock {
  leagueId: string; league: string; year: number; sport: string;
  byYear?: YearBlock[];              // desglose por año de fecha (liga multi-temporada)
  playoff: TournamentBlock | null; // postemporada separada de la temporada regular
}
export interface SeasonStat {
  id: string; playerId: string; season: number;
  scope?: string; // REG (default) | POST (playoffs — separado de la temporada regular)
  g: number; pa: number; ab: number; r: number; h: number; doubles: number; triples: number; hr: number;
  rbi: number; bb: number; k: number; hbp: number; sac: number; sf: number; sb: number;
  gp: number; gs: number; w: number; l: number; sv: number; hld: number;
  bs: number; cg: number; sho: number; // blown save / juego completo / blanqueada
  pOuts: number; pH: number; pR: number; pER: number; pBB: number; pK: number; pHR: number; pPitches: number;
  e: number;
  teams?: string[]; // equipos donde jugó ese año (derivado de stints)
}
export interface SprayPoint { result: string; loc: number; traj?: 'G' | 'L' | 'F' | null; season: number; post: boolean; dir?: number; dist?: number; }
export interface PlayerSpray { points: SprayPoint[]; }

// ---- Generador de reportes ----
export interface PlayerListItem { id: string; label: string; active?: boolean; team: string; teamId?: string; leagueId?: string; league?: string }
export interface ReportFilters {
  leagueId?: string; teamId?: string; vsTeamId?: string;
  playerId?: string; pitcherId?: string; order?: number;
  results?: string[]; half?: 'TOP' | 'BOTTOM';
  inningFrom?: number; inningTo?: number;
  dateFrom?: string; dateTo?: string; post?: boolean;
  bases?: 'empty' | 'any' | 'risp' | 'loaded';
  twoOuts?: boolean; homeAway?: 'home' | 'away';
}
export interface ReportRequest {
  dataset: 'batting' | 'pitching' | 'fielding' | 'plays' | 'games' | 'innings';
  filters?: ReportFilters;
  groupBy?: 'player' | 'order' | 'inning' | 'month' | 'game' | 'vs' | 'counterpart' | 'season' | 'venue';
}
export interface ReportBatRow {
  key: string; group: string; playerId: string; player: string;
  pa: number; ab: number; r: number; h: number; d2: number; d3: number; hr: number;
  rbi: number; bb: number; k: number; hbp: number; sac: number; sf: number; sb: number;
  avg: number; obp: number; slg: number; ops: number;
  // sabermetría
  singles: number; iso: number; babip: number; woba: number;
  bbPct: number; kPct: number; rc: number;
}
export interface ReportPitRow {
  key: string; group: string; playerId: string; player: string;
  outs: number; h: number; r: number; er: number; bb: number; k: number; hr: number; pitches: number;
  ip: number; era: number; whip: number; k9: number;
  // sabermetría
  bf: number; aba: number; bb9: number; h9: number; hr9: number;
  kbb: number; fip: number; baa: number; pip: number;
}
export interface ReportFldRow {
  key: string; group: string; playerId: string; player: string;
  po: number; a: number; e: number; tc: number; fpct: number;
}
export interface ReportPlay {
  gameId: string; game: string; date: string; seq: number;
  inning: number; half: string; outs0: number; bases0: string;
  batterId: string | null; pitcherId: string | null; order: number | null;
  result: string; notation: string | null; runs: number; outs: number;
}
export interface ReportGame {
  gameId: string; date: string; league: string;
  away: string; home: string; awayTeamId: string; homeTeamId: string; score: string;
}
export interface ReportInningRow {
  teamId: string; team: string; innings: number[]; total: number;
}
export interface ReportResponse {
  dataset: string;
  rows?: (ReportBatRow | ReportPitRow | ReportFldRow)[];
  plays?: ReportPlay[]; names?: Record<string, string>; truncated?: boolean;
  games?: ReportGame[]; gamesCount?: number;
  innings?: { maxInn: number; rows: ReportInningRow[] };
}

/** Consulta SQL libre (solo lectura) — reporte definido por el usuario */
export interface ImportPreview {
  league: string; sport: string; seasons: number;
  teams: number; players: number; games: number;
  gamesWithEvents: number; warnings: string[];
  years?: number[];
}
export interface AppendCandidate { id: string; name: string; team: string; why: string }
export interface AppendPreview {
  leagueId: string; league: string;
  unmatched: { name: string; teams: string[]; candidates: AppendCandidate[] }[];
  matched: number;
  multiTeam: { name: string; teams: string[] }[];
  existingYears: number[];
  existingYearGames?: Record<number, number>;
  roster?: { id: string; name: string; team: string }[];
}
export interface ImportResult {
  ok: boolean;
  preview?: ImportPreview;
  append?: AppendPreview;
  leagueId?: string;
  appended?: boolean;
  created?: { teams: number; players: number; playersReused: number; games: number };
  summary?: ImportPreview;
  /** presente cuando el archivo era un respaldo PoxScore restaurado completo */
  backup?: boolean;
  imported?: Record<string, number>;
}

export interface SqlResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated?: boolean;
  ms: number;
}

export interface RemoteEntry { name: string; size: number; isDir: boolean; modifiedAt?: string }
export interface FtpProfilePublic {
  id: string; name: string;
  protocol: 'ftp' | 'ftps' | 'sftp';
  host: string; port?: number; user: string; pass: string; // pass viene enmascarado ("••••••")
  remotePath: string;
}
export interface PitchPoint { r: number; c: number; result: string; season: number; post: boolean; }
export interface PitchLoc { points: PitchPoint[]; }

export interface PlayerFull {
  player: Player & { team?: Team };
  tournaments: TournamentLine[];
  seasons: SeasonStat[];
  // excluido de la publicación: la ficha devuelve solo nombre y equipo
  blocked?: boolean;
  name?: string;
  teamName?: string | null;
}
export interface MatchupLine {
  id: string; name: string;
  pa: number; ab: number; h: number; doubles: number; triples: number; hr: number;
  rbi: number; bb: number; k: number; hbp: number; sf: number;
  avg: number; obp: number; slg: number; ops: number;
}
/** Splits situacionales de una temporada (estilo MLB) — alimenta la Consulta */
export interface SituBatLine {
  pa: number; ab: number; r: number; h: number; d2: number; d3: number; hr: number;
  rbi: number; bb: number; k: number; hbp: number; sf: number;
  avg: number; obp: number; slg: number; ops: number;
}
export interface SituPitLine {
  bf: number; outs: number; ab: number; h: number; hr: number; bb: number; k: number;
  r: number; er: number; erW: number; dp: number; baa: number; era: number; whip: number;
}
export interface PlayerSituational {
  season: number | null; scope: 'REG' | 'POST'; games: number;
  batting: Record<string, SituBatLine>;
  pitching: Record<string, SituPitLine>;
}

export interface MatchupInfo {
  pa: number; ab: number; h: number; doubles: number; triples: number; hr: number;
  rbi: number; bb: number; k: number; hbp: number; sf: number;
  avg: number; obp: number; slg: number; ops: number; games: number;
  last3: { gameId: string; date: string; inning: number; result: string; notation?: string | null; runs: number }[];
}
export interface PlayerMatchups {
  vsPitchers: MatchupLine[]; vsTeams: MatchupLine[];
  pitchingVsBatters: MatchupLine[]; pitchingVsTeams: MatchupLine[];
}

// ---- Tarjeta del jugador dentro de un juego (estilo BallScore "Batting totals") ----
export interface GameCard {
  player: Player & { team?: Team };
  game: {
    batting: BatterLine | null;
    pitching: PitcherLine | null;
    fielding: { po: number; a: number; e: number };
    situational: SituStats | null;
  };
  seasons: SeasonStat[];
  scope?: 'REG' | 'POST';   // fase del juego — qué acumulado mostrar (post no infla la regular)
  seasonYear?: number;      // año de la temporada del juego
  innings?: number;         // entradas reglamentarias del juego (base del ERA)
}

// ---- Histórico entre dos equipos (BallScore "vs oponente actual") ----
export interface Head2HeadPitch {
  playerId: string; name: string;
  outs: number; h: number; r: number; er: number; bb: number; k: number; hr: number; pitches: number;
}
export interface Head2Head {
  record: { w: number; l: number; t: number }; // del equipo "a" contra "b"
  games: { id: string; date: string; aScore: number; bScore: number }[];
  battingA: MatchupLine[]; battingB: MatchupLine[];
  pitchingA: Head2HeadPitch[]; pitchingB: Head2HeadPitch[];
}
