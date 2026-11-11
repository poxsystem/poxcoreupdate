/**
 * Formato neutro de importación `.pox.json` — cualquier origen (BallStat, Excel,
 * otra liga) se convierte a esto y el sistema solo necesita un importador.
 *
 * {
 *   format: 'pox-import/1',
 *   league: 'Liga Verano',
 *   sport?: 'baseball'|'softball', innings?: number,
 *   seasons: [{
 *     year: 2025, status?: 'ACTIVE'|'ENDED',
 *     teams?:   [{ name, short?, color? }],
 *     players?: [{ name, team, number?, bats?, throws?, pos? }],
 *     playerStats?: [{ player, team?, scope?, ...stats }]   // acumulado de temporada
 *     series?:  [{ name, round?, home, away, winsNeeded?, winner?, status? }],
 *     games?:   [{
 *       date?, away, home, status?: 'FINAL'|'SCHEDULED',
 *       scoreAway?, scoreHome?, tied?, forfeitBy?, stadium?, note?,
 *       wp?, lp?, sv?,                       // decisiones por nombre
 *       series?: 'Semifinal A',              // nombre de la serie
 *       lineups?: [{ team, player, order?, position?, bats? }],
 *       events?:  [{ inning, half, batter?, pitcher?, result, notation?,
 *                    errors?: [name], po?: [name], a?: [name],
 *                    advances?: [{ player, to }] }],         // fidelidad total
 *       stats?:   [{ player, team?, ...stats }]              // línea de ese juego
 *     }]
 *   }]
 * }
 *
 * Niveles: `events` → boxscores/stats reales (pasan por accumulateSeason);
 * `stats`/`playerStats` → se guardan como acumulado (sin jugada a jugada).
 */
import { prisma } from '../prisma.js';
import { gameDate } from '../dates.js';
import { lev } from './boxfile.js';
import { accumulateSeason } from '../routes/games.js';
import { autoBackup } from '../backup-lib.js';
import { applyEvent, defaultAdvances, initialState } from '@poxscore/shared';
import type { Advance, GameEvent, GameState, PAResult } from '@poxscore/shared';

export interface PoxTeam { name: string; short?: string; color?: string }
export interface PoxPlayer { name: string; team: string; number?: number; bats?: string; throws?: string; pos?: string; active?: boolean }
export interface PoxStatLine { player: string; team?: string; scope?: string;[k: string]: unknown }
export interface PoxAdvance { player: string; to: number | string }
export interface PoxEvent {
  inning?: number; half?: string; batter?: string; pitcher?: string;
  result: string; notation?: string;
  errors?: string[]; po?: string[]; a?: string[];
  advances?: PoxAdvance[];
}
export interface PoxLineup { team: string; player: string; order?: number; position?: string; bats?: boolean }
export interface PoxGame {
  date?: string; away: string; home: string; status?: string;
  scoreAway?: number; scoreHome?: number; tied?: boolean; forfeitBy?: string;
  stadium?: string; note?: string; wp?: string; lp?: string; sv?: string;
  series?: string; lineups?: PoxLineup[]; events?: PoxEvent[]; stats?: PoxStatLine[];
}
export interface PoxSeries { name: string; round?: number; home: string; away: string; winsNeeded?: number; winner?: string; status?: string }
export interface PoxSeason {
  year: number; status?: string;
  teams?: PoxTeam[]; players?: PoxPlayer[]; playerStats?: PoxStatLine[];
  series?: PoxSeries[]; games?: PoxGame[];
}
export interface PoxFile {
  format?: string; league: string; sport?: string; innings?: number;
  /** misma persona en varios equipos → una sola ficha bajo `team` */
  merges?: { name: string; team: string }[];
  seasons: PoxSeason[];
}

export interface PoxPreview {
  league: string; sport: string; seasons: number;
  teams: number; players: number; games: number;
  gamesWithEvents: number; warnings: string[];
  years: number[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
// "CMB" es una etiqueta del usuario en el roster (jugador cambiado), no parte
// del nombre — se ignora al CASAR jugadores (el nombre de la ficha se conserva)
// para que "CMB Edison Gonzalez" caiga en la ficha de "Edison Gonzalez".
const normP = (s: string) => norm(s).split(' ').filter((t) => t !== 'cmb').join(' ');
/** "Emerson Rodriguez 2025" → "emerson rodriguez" — año pegado al nombre en el
 *  archivo fuente; NO quita "(2)" (ese sufijo marca OTRO jugador con el mismo
 *  apellido, no un alias del mismo). */
const stripYear = (s: string) => normP(s).replace(/\s*(?:19|20)\d{2}$/, '').trim();

function splitName(full: string): { firstName: string; lastName: string } {
  const t = full.trim();
  const i = t.indexOf(',');
  if (i > 0) return { lastName: t.slice(0, i).trim(), firstName: t.slice(i + 1).trim() };
  const sp = t.indexOf(' ');
  return sp < 0 ? { firstName: t, lastName: '' } : { firstName: t.slice(0, sp), lastName: t.slice(sp + 1) };
}

// ---------------------------------------------------------------- validación
export function validatePox(raw: unknown): { file?: PoxFile; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof raw !== 'object' || raw === null) return { errors: ['El archivo no es un JSON válido'], warnings };
  const f = raw as PoxFile;
  if (f.format && f.format !== 'pox-import/1') warnings.push(`formato "${f.format}" — se intenta leer como pox-import/1`);
  if (!f.league || typeof f.league !== 'string') errors.push('falta "league" (nombre de la liga)');
  if (!Array.isArray(f.seasons) || f.seasons.length === 0) errors.push('falta "seasons" (al menos una temporada)');
  for (const [i, s] of (f.seasons ?? []).entries()) {
    if (!Number.isInteger(s.year)) errors.push(`seasons[${i}]: falta "year"`);
    for (const [j, g] of (s.games ?? []).entries()) {
      if (!g.away || !g.home) errors.push(`seasons[${i}].games[${j}]: falta "away"/"home"`);
      const final = g.status !== 'SCHEDULED';
      if (final && !(g.events?.length) && g.scoreAway == null && g.scoreHome == null)
        warnings.push(`${s.year} juego ${j + 1} (${g.away} @ ${g.home}): FINAL sin marcador ni eventos → 0-0`);
    }
  }
  return errors.length ? { errors, warnings } : { file: f, errors, warnings };
}

/** Resumen sin tocar la BD — para la vista previa del modal. */
export function previewPox(file: PoxFile, warnings: string[]): PoxPreview {
  const teams = new Set<string>();
  const players = new Set<string>();
  let games = 0; let withEvents = 0;
  for (const s of file.seasons) {
    for (const t of s.teams ?? []) teams.add(norm(t.name));
    for (const p of s.players ?? []) { players.add(normP(p.name)); teams.add(norm(p.team)); }
    for (const g of s.games ?? []) {
      games++;
      teams.add(norm(g.away)); teams.add(norm(g.home));
      if (g.events?.length) withEvents++;
      for (const l of g.lineups ?? []) { players.add(normP(l.player)); teams.add(norm(l.team)); }
      for (const st of g.stats ?? []) players.add(normP(st.player));
      for (const e of g.events ?? []) { if (e.batter) players.add(normP(e.batter)); if (e.pitcher) players.add(normP(e.pitcher)); }
    }
    for (const st of s.playerStats ?? []) players.add(normP(st.player));
  }
  return {
    league: file.league, sport: file.sport ?? 'baseball',
    seasons: file.seasons.length, teams: teams.size, players: players.size,
    games, gamesWithEvents: withEvents, warnings,
    years: file.seasons.map((s) => s.year),
  };
}

// ---------------------------------------------------- mapeo de columnas stats
const STAT_ALIASES: Record<string, string> = {
  '2b': 'doubles', '3b': 'triples', 'ci': 'rbi', 'so': 'k',
  outs: 'pOuts', ip: 'pOuts', ph: 'pH', pr: 'pR', per: 'pER', pbb: 'pBB',
  pk: 'pK', phr: 'pHR', ppitches: 'pPitches', pitches: 'pPitches',
};
const STAT_COLS = new Set([
  'g', 'pa', 'ab', 'r', 'h', 'doubles', 'triples', 'hr', 'rbi', 'bb', 'k', 'hbp',
  'sac', 'sf', 'sb', 'gp', 'gs', 'w', 'l', 'sv', 'hld', 'bs', 'cg', 'sho',
  'pOuts', 'pH', 'pR', 'pER', 'pBB', 'pK', 'pHR', 'pPitches', 'e',
]);

/** Traduce un renglón pox a columnas PlayerSeasonStat (ip decimal → outs). */
function statData(row: PoxStatLine): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v == null || typeof v !== 'number') continue;
    let col = STAT_ALIASES[k.toLowerCase()] ?? (STAT_COLS.has(k) ? k : null);
    if (!col) continue;
    // "ip" llega en entradas (7.2 = 7 IP + 2 outs) → convierte a outs
    if (col === 'pOuts' && (k === 'ip' || k === 'IP')) {
      const inn = Math.floor(v);
      out[col] = (out[col] ?? 0) + inn * 3 + Math.round((v - inn) * 10);
    } else {
      out[col] = (out[col] ?? 0) + v;
    }
  }
  return out;
}

// ------------------------------------------------------------------ importar
export interface ImportOpts {
  /** agregar las temporadas del archivo a ESTA liga en vez de crear otra
   *  (el nombre del ZIP puede variar por técnico — el destino lo elige el usuario) */
  appendToLeagueId?: string;
  /** mismo nombre en varios equipos = la MISMA persona → una sola ficha;
   *  su equipo actual = el de su último juego por FECHA, stats sumadas */
  mergeSameName?: boolean;
  /** si la temporada (year) ya existe en la liga destino → borrarla y re-importar */
  replaceSeason?: boolean;
  /** si la temporada ya existe → AGREGAR sus juegos sin borrar (la fuente se
   *  partió en dos bases BallStat: "2025" y "2025 B" = la misma temporada).
   *  Juegos ya presentes (misma fecha + equipos) se omiten. */
  mergeSeason?: boolean;
  /** el usuario decide a dónde van los números cuando el nombre cambió
   *  (ej. "Wilkin Ramos" en 2024 → "Wilkin Colon" en 2025 = la misma persona).
   *  `fromTeam` acota el alias a ese equipo — dos homónimos no se confunden. */
  playerAliases?: { from: string; fromTeam?: string; to: string }[];
}
export interface ImportResult { leagueId: string; appended: boolean; summary: PoxPreview; created: { teams: number; players: number; playersReused: number; games: number }; }

export async function importPox(file: PoxFile, warnings: string[], opts: ImportOpts = {}): Promise<ImportResult> {
  const sport = file.sport === 'softball' ? 'softball' : 'baseball';
  const innings = file.innings ?? (sport === 'softball' ? 7 : 9);
  const lastYear = Math.max(...file.seasons.map((s) => s.year));
  const appending = !!opts.appendToLeagueId;

  let league: { id: string };
  if (appending) {
    const found = await prisma.league.findUnique({ where: { id: opts.appendToLeagueId } });
    if (!found) throw Object.assign(new Error('la liga destino no existe'), { status: 404 });
    league = found;
  } else {
    const dup = await prisma.league.findFirst({ where: { name: file.league.trim() } });
    if (dup) throw Object.assign(new Error(`ya existe una liga llamada "${file.league.trim()}" — puedes agregar el archivo como temporada`), { status: 409, leagueId: dup.id });
    league = await prisma.league.create({
      data: { name: file.league.trim(), year: lastYear, sport, innings },
    });
  }

  // filas creadas en ESTA corrida — la limpieza atómica solo borra estas,
  // así un append fallido no se lleva la liga ni sus datos previos
  const created = { teams: new Set<string>(), players: new Set<string>(), seasons: new Set<string>(), games: new Set<string>(), series: new Set<string>() };
  const touchedYears = new Set<number>();
  const reusedPids = new Set<string>();
  // temporada vigente = el año más alto que quedará en la liga tras importar:
  // jugadores creados en una temporada ATRASADA nacen PASIVOS (no inflan el
  // roster actual) y el teamId de fichas reusadas solo se mueve si aparecen
  // en la temporada vigente (un import de 2023 no devuelve a nadie a su equipo viejo)
  let curYear = 0;
  const maxYearOf = new Map<string, number>(); // playerId → último año del archivo donde aparece
  const toReactivate = new Set<string>();      // fichas pasivas que vuelven a jugar
  const existYears = (await prisma.season.findMany({ where: { leagueId: league.id }, select: { year: true } })).map((s) => s.year);
  const latestYear = Math.max(0, ...existYears, ...file.seasons.map((s) => s.year));
  // modo fusionar: snapshot de los acumulados previos por año — si el import
  // muere a la mitad se restauran (el rollback borra por año sin distinguir)
  const preStats = new Map<number, unknown[]>();
  // playerId → equipo de su último juego POR FECHA (regla "queda en noviembre")
  const lastGameTeam = new Map<string, { t: number; tid: string }>();

  const warned = new Set<string>();
  const warn = (m: string) => { if (!warned.has(m)) { warned.add(m); warnings.push(m); } };

  const teamIds = new Map<string, string>();    // norm(name) → teamId
  const playerIds = new Map<string, string>();  // norm(team|name) o *|name → playerId
  const playerByName = new Map<string, string>(); // norm(name) → playerId (modo fundir)
  const nameKeys = new Map<string, string[]>(); // norm(name) → llaves (homónimos multi-equipo)
  const playerTeam = new Map<string, string>(); // playerId → último teamId visto
  // jugadores confirmados como la misma persona en varios equipos
  const mergeTeam = new Map<string, string>();  // normP(name) → equipo canónico
  for (const m of file.merges ?? []) mergeTeam.set(normP(m.name), m.team);

  // precarga al agregar temporada: equipos y jugadores YA existentes en la liga
  if (appending) {
    for (const t of await prisma.team.findMany({ where: { leagueId: league.id } })) teamIds.set(norm(t.name), t.id);
    for (const p of await prisma.player.findMany({ where: { team: { leagueId: league.id } }, include: { team: true } })) {
      const fn = `${p.firstName} ${p.lastName}`.trim();
      const k = `${norm(p.team.name)}|${normP(fn)}`;
      playerIds.set(k, p.id);
      // llave alternativa sin año pegado: "Equipo|fulano 2025" cae en "fulano"
      const ky = `${norm(p.team.name)}|${stripYear(fn)}`;
      if (ky !== k && !playerIds.has(ky)) playerIds.set(ky, p.id);
      nameKeys.set(normP(fn), [...(nameKeys.get(normP(fn)) ?? []), k]);
      playerTeam.set(p.id, p.teamId);
      if (!playerByName.has(normP(fn))) playerByName.set(normP(fn), p.id);
      else warn(`homónimo "${fn}" en varios equipos de la liga — las stats irán a la primera ficha`);
    }
  }

  // llave de identidad del jugador: fundir → nombre solo; normal → equipo+nombre
  const pKey = (name: string, teamName?: string) =>
    opts.mergeSameName ? `*|${normP(name)}` : `${norm(mergeTeam.get(normP(name)) ?? teamName ?? '')}|${normP(name)}`;

  // alias manuales: norm(from) → nombre canónico; con equipo → solo aplica ahí
  const aliasMap = new Map<string, string>();
  const aliasMapTeam = new Map<string, string>(); // norm(team|from) → to
  for (const a of opts.playerAliases ?? []) {
    if (a.fromTeam) aliasMapTeam.set(`${norm(a.fromTeam)}|${normP(a.from)}`, a.to.trim());
    else aliasMap.set(normP(a.from), a.to.trim());
  }
  const aliasFor = (name: string, teamName?: string): string => {
    if (teamName) {
      const t = aliasMapTeam.get(`${norm(teamName)}|${normP(name)}`);
      if (t) return t;
    }
    return aliasMap.get(normP(name)) ?? name;
  };

  const getTeam = async (name: string): Promise<string> => {
    const k = norm(name);
    const hit = teamIds.get(k);
    if (hit) return hit;
    const t = await prisma.team.create({ data: { name: name.trim(), leagueId: league.id } });
    teamIds.set(k, t.id);
    created.teams.add(t.id);
    warn(`equipo "${name.trim()}" no estaba declarado → creado`);
    return t.id;
  };

  const regPlayer = (key: string, name: string, pid: string) => {
    playerIds.set(key, pid);
    nameKeys.set(normP(name), [...(nameKeys.get(normP(name)) ?? []), key]);
    if (!playerByName.has(normP(name))) playerByName.set(normP(name), pid);
  };

  const getPlayer = async (name: string, teamName?: string): Promise<string> => {
    const aliased = aliasFor(name, teamName); // el usuario decide a dónde van sus números
    const wasAliased = aliased !== name;
    name = aliased;
    const merged = mergeTeam.has(normP(name));
    let k = pKey(name, teamName);
    let hit = playerIds.get(k);
    // nombre con año pegado ("fulano 2025" → "fulano" del MISMO equipo)
    if (!hit && teamName) hit = playerIds.get(`${norm(mergeTeam.get(normP(name)) ?? teamName)}|${stripYear(name)}`);
    // modo fundir o alias explícito: la ficha puede existir bajo otro equipo
    if (!hit && (opts.mergeSameName || wasAliased)) hit = playerByName.get(normP(name)) ?? playerByName.get(stripYear(name));
    // resolución por nombre solo (wp/lp/sv, eventos): única ficha con ese nombre
    if (!hit && !teamName) {
      const ks = nameKeys.get(normP(name)) ?? [];
      if (ks.length === 1) { k = ks[0]; hit = playerIds.get(k); }
      else if (ks.length > 1) { k = ks[0]; hit = playerIds.get(k); warn(`jugador "${name.trim()}" existe en varios equipos → se usó la primera ficha`); }
    }
    if (hit) {
      if (!created.players.has(hit)) reusedPids.add(hit);
      if (teamName) {
        maxYearOf.set(hit, Math.max(maxYearOf.get(hit) ?? 0, curYear));
        if (curYear >= latestYear) toReactivate.add(hit); // aparece en la temporada vigente → juega hoy
        if (!merged) playerTeam.set(hit, await getTeam(teamName));
      }
      return hit;
    }
    const { firstName, lastName } = splitName(name);
    const tid = await getTeam(mergeTeam.get(normP(name)) ?? teamName ?? 'Sin equipo');
    const p = await prisma.player.create({ data: { firstName, lastName, teamId: tid, active: curYear >= latestYear } });
    maxYearOf.set(p.id, curYear);
    created.players.add(p.id);
    regPlayer(k, name, p.id);
    playerTeam.set(p.id, tid);
    if (!teamName && !merged) warn(`jugador "${name.trim()}" sin equipo → "Sin equipo"`);
    return p.id;
  };

  const optPlayer = async (name?: string): Promise<string | null> =>
    name ? getPlayer(name) : null;

  try {
    for (const s of file.seasons) {
      curYear = s.year;
      // temporada duplicada en la liga destino: rechazar o reemplazar
      const exist = await prisma.season.findFirst({ where: { leagueId: league.id, year: s.year } });
      if (exist && opts.mergeSeason && !preStats.has(s.year)) {
        await autoBackup(`antes de fusionar temporada ${s.year}`);
        const lp = await prisma.player.findMany({ where: { team: { leagueId: league.id } }, select: { id: true } });
        preStats.set(s.year, await prisma.playerSeasonStat.findMany({ where: { playerId: { in: lp.map((p) => p.id) }, season: s.year } }));
      }
      if (exist && !opts.mergeSeason) {
        if (!opts.replaceSeason) {
          throw Object.assign(new Error(`la temporada ${s.year} ya existe en esta liga — marca "fusionar" para AGREGAR los juegos sin borrar, o "reemplazar" para sobreescribirla`), { status: 409 });
        }
        await autoBackup(`antes de reemplazar temporada ${s.year}`);
        const og = (await prisma.game.findMany({ where: { seasonId: exist.id }, select: { id: true } })).map((g) => g.id);
        await prisma.gameEvent.deleteMany({ where: { gameId: { in: og } } });
        await prisma.lineupEntry.deleteMany({ where: { gameId: { in: og } } });
        await prisma.game.deleteMany({ where: { id: { in: og } } });
        await prisma.series.deleteMany({ where: { seasonId: exist.id } });
        const lp = await prisma.player.findMany({ where: { team: { leagueId: league.id } }, select: { id: true } });
        await prisma.playerSeasonStat.deleteMany({ where: { playerId: { in: lp.map((p) => p.id) }, season: s.year } });
        await prisma.season.delete({ where: { id: exist.id } });
      }
      // fusionar → la temporada ya existe: se reusa y los juegos nuevos se suman
      const season = exist && opts.mergeSeason
        ? exist
        : await prisma.season.create({
            data: { leagueId: league.id, year: s.year, status: s.status === 'ENDED' ? 'ENDED' : 'ACTIVE' },
          });
      if (!(exist && opts.mergeSeason)) created.seasons.add(season.id);
      touchedYears.add(s.year);
      // dedupe de juegos al fusionar: mismo día + mismos equipos = ya estaba
      const existGameKeys = exist && opts.mergeSeason
        ? new Set((await prisma.game.findMany({ where: { seasonId: exist.id }, select: { date: true, awayTeamId: true, homeTeamId: true } }))
            .map((g) => `${g.date.toISOString().slice(0, 10)}|${g.awayTeamId}|${g.homeTeamId}`))
        : null;
      let skippedDup = 0;
      // equipos declarados
      for (const t of s.teams ?? []) {
        const k = norm(t.name);
        if (!teamIds.has(k)) {
          const row = await prisma.team.create({
            data: { name: t.name.trim(), shortName: t.short?.trim() || null, color: t.color?.trim() || null, leagueId: league.id },
          });
          teamIds.set(k, row.id);
          created.teams.add(row.id);
        } else if (t.short || t.color) {
          await prisma.team.update({ where: { id: teamIds.get(k)! }, data: { shortName: t.short ?? undefined, color: t.color ?? undefined } });
        }
      }
      // jugadores declarados (nombre canónico tras alias manual)
      for (const p of s.players ?? []) {
        const pname = aliasFor(p.name, p.team);
        const merged = mergeTeam.has(normP(pname));
        const k = pKey(pname, p.team);
        const tid = await getTeam(mergeTeam.get(normP(pname)) ?? p.team);
        // nombre con año pegado ("fulano 2025" → ficha "fulano") o fundido por nombre
        const prev = playerIds.get(k)
          ?? playerIds.get(pKey(stripYear(pname), p.team))
          ?? (opts.mergeSameName ? playerByName.get(normP(pname)) ?? playerByName.get(stripYear(pname)) : undefined);
        if (!prev) {
          const { firstName, lastName } = splitName(pname);
          const row = await prisma.player.create({
            data: {
              firstName, lastName, teamId: tid,
              number: p.number ?? null, bats: p.bats ?? null, throws: p.throws ?? null,
              // temporada atrasada → nace pasivo (su roster es el del año importado)
              positions: p.pos ?? null, active: p.active !== false && s.year >= latestYear,
            },
          });
          created.players.add(row.id);
          regPlayer(k, pname, row.id);
          playerTeam.set(row.id, tid);
          maxYearOf.set(row.id, s.year);
        } else {
          maxYearOf.set(prev, Math.max(maxYearOf.get(prev) ?? 0, s.year));
          if (s.year >= latestYear) toReactivate.add(prev);
          if (!merged) playerTeam.set(prev, tid); // última temporada gana (equipo actual)
        }
      }
      // series de playoff
      const seriesIds = new Map<string, string>();
      for (const sr of s.series ?? []) {
        const row = await prisma.series.create({
          data: {
            leagueId: league.id, seasonId: season.id,
            round: sr.round ?? 1, name: sr.name,
            homeTeamId: await getTeam(sr.home), awayTeamId: await getTeam(sr.away),
            winsNeeded: sr.winsNeeded ?? 3,
            status: sr.status === 'DONE' ? 'DONE' : sr.status === 'LIVE' ? 'LIVE' : 'PENDING',
            winnerTeamId: sr.winner ? await getTeam(sr.winner) : null,
          },
        });
        created.series.add(row.id);
        seriesIds.set(norm(sr.name), row.id);
      }
      // juegos
      for (const [gi, g] of (s.games ?? []).entries()) {
        const final = g.status !== 'SCHEDULED';
        const hasEvents = !!g.events?.length;
        const date = gameDate(g.date) ?? new Date();
        // al fusionar una temporada: mismo día + mismos equipos = ya estaba
        if (existGameKeys) {
          const aId = teamIds.get(norm(g.away)), hId = teamIds.get(norm(g.home));
          if (aId && hId && existGameKeys.has(`${date.toISOString().slice(0, 10)}|${aId}|${hId}`)) { skippedDup++; continue; }
        }
        const game = await prisma.game.create({
          data: {
            date, status: final ? 'FINAL' : 'SCHEDULED', sport, innings,
            leagueId: league.id, seasonId: season.id,
            awayTeamId: await getTeam(g.away), homeTeamId: await getTeam(g.home),
            stadium: g.stadium ?? null, note: g.note ?? null,
            tied: !!g.tied,
            forfeitBy: g.forfeitBy ? await getTeam(g.forfeitBy) : null,
            seriesId: g.series ? (seriesIds.get(norm(g.series)) ?? null) : null,
            // marcador oficial para juegos sin eventos (el fScore manda en toda la app)
            fScoreAway: final && !hasEvents ? (g.scoreAway ?? 0) : (g.scoreAway ?? null),
            fScoreHome: final && !hasEvents ? (g.scoreHome ?? 0) : (g.scoreHome ?? null),
            wpId: await optPlayer(g.wp), lpId: await optPlayer(g.lp), svId: await optPlayer(g.sv),
            startedAt: final ? date : null, endedAt: final ? date : null,
          },
        });
        created.games.add(game.id);
        // equipo del jugador = el de su ÚLTIMO juego por fecha
        const markSeen = async (pid: string, teamName?: string) => {
          const tid = teamName ? await getTeam(teamName) : playerTeam.get(pid);
          if (!tid) return;
          const cur = lastGameTeam.get(pid);
          if (!cur || date.getTime() >= cur.t) lastGameTeam.set(pid, { t: date.getTime(), tid });
        };
        // alineaciones declaradas
        const seenLineup = new Set<string>();
        for (const l of g.lineups ?? []) {
          const tid = await getTeam(l.team);
          const pid = await getPlayer(l.player, l.team);
          await markSeen(pid, l.team);
          seenLineup.add(pid);
          await prisma.lineupEntry.create({
            data: {
              gameId: game.id, teamId: tid, playerId: pid,
              order: l.order ?? 0, position: l.position ?? 'DH',
              batsInOrder: l.bats !== false,
            },
          });
        }
        // eventos → jugada a jugada real
        if (hasEvents) {
          const perTeam = new Map<string, number>(); // orden de aparición por equipo
          let st: GameState = initialState();
          for (const [ei, e] of g.events!.entries()) {
            const bid = e.batter ? await getPlayer(e.batter) : null;
            const pid2 = e.pitcher ? await getPlayer(e.pitcher) : null;
            const half = e.half === 'BOTTOM' ? 'BOTTOM' : e.half === 'TOP' ? 'TOP' : st.half;
            const inning = e.inning ?? st.inning;
            // lineup sintético: cada jugador nuevo entra en orden de aparición
            for (const [pid, side] of [[bid, half === 'TOP' ? 'away' : 'home'], [pid2, half === 'TOP' ? 'home' : 'away']] as const) {
              if (pid && !seenLineup.has(pid)) {
                seenLineup.add(pid);
                const tid = await getTeam(side === 'away' ? g.away : g.home);
                perTeam.set(tid, (perTeam.get(tid) ?? 0) + 1);
                await prisma.lineupEntry.create({
                  data: { gameId: game.id, teamId: tid, playerId: pid, order: perTeam.get(tid)!, position: 'DH' },
                });
              }
            }
            // avances: los del archivo o los estándar del motor (HR→carrera+CI, etc.)
            let adv: Advance[] = [];
            if (e.advances?.length) {
              for (const a of e.advances) adv.push({ playerId: await getPlayer(a.player), to: a.to as Advance['to'] });
            } else if (bid) {
              adv = defaultAdvances(st, bid, e.result as PAResult);
            }
            const seq = ei + 1;
            await prisma.gameEvent.create({
              data: {
                gameId: game.id, seq,
                inning, half,
                batterId: bid, pitcherId: pid2,
                result: e.result, notation: e.notation ?? null,
                errorOn: e.errors?.length ? JSON.stringify(e.errors.map((n) => playerIds.get(normP(n)) ?? n)) : null,
                putouts: e.po?.length ? JSON.stringify(e.po.map((n) => playerIds.get(normP(n)) ?? n)) : null,
                assists: e.a?.length ? JSON.stringify(e.a.map((n) => playerIds.get(normP(n)) ?? n)) : null,
                advances: JSON.parse(JSON.stringify(adv)),
              },
            });
            // alimenta el motor: bases/outs/entradas quedan consistentes para el siguiente evento
            st = applyEvent(st, {
              seq, inning, half, batterId: bid, pitcherId: pid2,
              result: e.result as GameEvent['result'], notation: e.notation ?? null,
              errorOn: e.errors?.map((n) => playerIds.get(normP(n)) ?? n),
              putouts: e.po?.map((n) => playerIds.get(normP(n)) ?? n),
              assists: e.a?.map((n) => playerIds.get(normP(n)) ?? n),
              advances: adv,
            } as GameEvent, innings);
          }
          if (final) await accumulateSeason(game.id); // stats reales desde eventos
        }
        // líneas de stats por juego (sin eventos)
        const statLines: Record<string, unknown>[] = [];
        for (const row of g.stats ?? []) {
          const pid = await getPlayer(row.player, row.team);
          await markSeen(pid, row.team);
          const data = { g: 1, ...statData(row) };
          const scope = g.series ? 'POST' : 'REG';
          await prisma.playerSeasonStat.upsert({
            where: { playerId_season_scope: { playerId: pid, season: s.year, scope } },
            create: { playerId: pid, season: s.year, scope, ...data },
            update: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { increment: v }])),
          });
          // Game.statLines: la línea por juego que consume el agregador de liga/website
          // (po/a/bf no existen en PlayerSeasonStat — viajan solo en la línea)
          statLines.push({
            playerId: pid,
            teamId: row.team ? await getTeam(row.team) : (playerTeam.get(pid) ?? null),
            ...data,
            ...(typeof row.po === 'number' ? { po: row.po } : {}),
            ...(typeof row.a === 'number' ? { a: row.a } : {}),
            ...(typeof row.bf === 'number' ? { bf: row.bf } : {}),
          });
        }
        if (statLines.length) {
          // temporada ya acumulada arriba línea por línea → marcar para que
          // accumulateSeason no la re-sume si algo re-finalizara el juego
          const upd: Record<string, unknown> = { statLines: JSON.parse(JSON.stringify(statLines)), seasonApplied: true };
          // decisiones desde banderas w/l/sv de las líneas si no venían declaradas
          if (!game.wpId) { const w = statLines.find((l) => l.w); if (w) upd.wpId = w.playerId; }
          if (!game.lpId) { const l = statLines.find((l) => l.l); if (l) upd.lpId = l.playerId; }
          if (!game.svId) { const sv = statLines.find((l) => l.sv); if (sv) upd.svId = sv.playerId; }
          await prisma.game.update({ where: { id: game.id }, data: upd });
        }
        void gi;
      }
      if (skippedDup) warn(`${skippedDup} juegos ya estaban en la temporada ${s.year} (misma fecha/equipos) — se omitieron`);
      // acumulados de temporada declarados
      for (const row of s.playerStats ?? []) {
        const pid = await getPlayer(row.player, row.team);
        const data = statData(row);
        const scope = row.scope === 'POST' ? 'POST' : 'REG';
        await prisma.playerSeasonStat.upsert({
          where: { playerId_season_scope: { playerId: pid, season: s.year, scope } },
          create: { playerId: pid, season: s.year, scope, ...data },
          update: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { increment: v }])),
        });
      }
    }
    // último juego por FECHA decide el equipo actual (regla multi-equipo)
    for (const [pid, info] of lastGameTeam) playerTeam.set(pid, info.tid);
    // equipo actual = el de la última temporada donde apareció — solo fichas
    // nuevas o reusadas que llegan hasta la temporada vigente; las reusadas de
    // temporadas atrasadas conservan su equipo actual de la liga
    for (const [pid, tid] of playerTeam) {
      if (!created.players.has(pid) && (maxYearOf.get(pid) ?? 0) < latestYear) continue;
      await prisma.player.update({ where: { id: pid }, data: { teamId: tid } });
    }
    // fichas pasivas que sí aparecen en la temporada vigente vuelven a activos
    if (toReactivate.size)
      await prisma.player.updateMany({ where: { id: { in: [...toReactivate] } }, data: { active: true } });
  } catch (err) {
    // limpieza atómica: SOLO lo creado por esta corrida —
    // en append la liga y sus temporadas/juegos/jugadores previos quedan intactos
    const gids = [...created.games];
    const pids = [...created.players];
    await prisma.gameEvent.deleteMany({ where: { gameId: { in: gids } } });
    await prisma.lineupEntry.deleteMany({ where: { OR: [{ gameId: { in: gids } }, { playerId: { in: pids } }] } });
    await prisma.game.deleteMany({ where: { id: { in: gids } } });
    await prisma.series.deleteMany({ where: { id: { in: [...created.series] } } });
    // acumulados del año importado: solo para jugadores de esta liga
    const leaguePids = appending
      ? (await prisma.player.findMany({ where: { team: { leagueId: league.id } }, select: { id: true } })).map((p) => p.id)
      : [...playerIds.values()];
    await prisma.playerSeasonStat.deleteMany({ where: { playerId: { in: leaguePids }, season: { in: [...touchedYears] } } });
    // modo fusionar: devolver los acumulados que ya existían antes del import
    for (const rows of preStats.values()) {
      if (rows.length) await prisma.playerSeasonStat.createMany({ data: rows as never[], skipDuplicates: true });
    }
    await prisma.player.deleteMany({ where: { id: { in: pids } } });
    await prisma.team.deleteMany({ where: { id: { in: [...created.teams] } } });
    await prisma.season.deleteMany({ where: { id: { in: [...created.seasons] } } });
    if (!appending) await prisma.league.delete({ where: { id: league.id } });
    throw err;
  }

  return {
    leagueId: league.id,
    appended: appending,
    summary: previewPox(file, warnings),
    created: {
      teams: created.teams.size,
      players: created.players.size,
      playersReused: reusedPids.size,
      games: created.games.size,
    },
  };
}

// ------------------------------------------- vista previa de append
export interface AppendCandidate { id: string; name: string; team: string; why: string }
export interface AppendPreview {
  leagueId: string; league: string;
  /** nombres del archivo que NO existen en la liga → el usuario decide a dónde van */
  unmatched: { name: string; teams: string[]; candidates: AppendCandidate[] }[];
  /** nombres del archivo que ya existen en la liga */
  matched: number;
  /** mismo nombre bajo varios equipos en el archivo → candidato de fusión */
  multiTeam: { name: string; teams: string[] }[];
  /** años de temporada ya existentes en la liga destino */
  existingYears: number[];
  /** juegos por año existente — el aviso de "reemplazar" muestra qué se borraría */
  existingYearGames: Record<number, number>;
  /** roster completo de la liga — el buscador de la tabla de nombres lo filtra */
  roster: { id: string; name: string; team: string }[];
}

export async function appendPreview(file: PoxFile, leagueId: string): Promise<AppendPreview | null> {
  const league = await prisma.league.findUnique({ where: { id: leagueId } });
  if (!league) return null;

  const lp = await prisma.player.findMany({ where: { team: { leagueId } }, include: { team: true } });
  const roster = lp.map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}`.trim(), team: p.team.name }));
  const byNorm = new Map<string, { id: string; name: string; team: string }>();
  for (const p of roster) { if (!byNorm.has(normP(p.name))) byNorm.set(normP(p.name), p); }

  // nombres del archivo con sus contextos de equipo
  const fileNames = new Map<string, Set<string>>();
  const addN = (n?: string, t?: string) => {
    if (!n?.trim()) return;
    const k = n.trim();
    fileNames.set(k, new Set([...(fileNames.get(k) ?? []), ...(t ? [t] : [])]));
  };
  for (const s of file.seasons) {
    for (const p of s.players ?? []) addN(p.name, p.team);
    for (const g of s.games ?? []) {
      addN(g.wp); addN(g.lp); addN(g.sv);
      for (const l of g.lineups ?? []) addN(l.player, l.team);
      for (const st of g.stats ?? []) addN(st.player, st.team);
      for (const e of g.events ?? []) {
        addN(e.batter); addN(e.pitcher);
        for (const x of e.errors ?? []) addN(x);
        for (const x of e.po ?? []) addN(x);
        for (const x of e.a ?? []) addN(x);
        for (const adv of e.advances ?? []) addN(adv.player);
      }
    }
  }

  const firstTok = (s: string) => normP(s).split(' ')[0] ?? '';
  const lastTok = (s: string) => normP(s).split(' ').slice(-1)[0] ?? '';
  // "Emerson Rodriguez 2025" → año pegado al nombre (auto-match seguro);
  // "Peguero (2)" → OTRO jugador de mismo apellido (solo candidato, nunca auto)
  const stripYear = (s: string) => normP(s).replace(/\s*(19|20)\d{2}$/, '').trim();
  const baseName = (s: string) => normP(s).replace(/\s*\(?\d+\)?\s*$/, '').replace(/\s*(19|20)\d{2}$/, '').trim();

  let matched = 0;
  const unmatched: AppendPreview['unmatched'] = [];
  const multiTeam: AppendPreview['multiTeam'] = [];
  for (const [name, teams] of fileNames) {
    if (teams.size > 1) multiTeam.push({ name, teams: [...teams] });
    if (byNorm.has(normP(name)) || byNorm.has(stripYear(name))) { matched++; continue; }
    const fn = firstTok(name), ln = lastTok(name), bn = baseName(name);
    const cands = new Map<string, AppendCandidate>();
    for (const p of roster) {
      if (bn !== normP(name) && baseName(p.name) === bn)
        cands.set(p.id, { ...p, why: 'mismo nombre sin el año/"(n)" del archivo' });
      else if (firstTok(p.name) === fn && fn.length > 2)
        cands.set(p.id, { ...p, why: `mismo nombre de pila "${firstTok(p.name)}" — apellido distinto` });
      else if (lastTok(p.name) === ln && ln.length > 2)
        cands.set(p.id, { ...p, why: `mismo apellido` });
      else if (lev(normP(name), normP(p.name)) <= 2 || lev(bn, baseName(p.name)) <= 2)
        cands.set(p.id, { ...p, why: 'nombre muy parecido (typo?)' });
    }
    unmatched.push({
      name, teams: [...teams],
      candidates: [...cands.values()].slice(0, 6),
    });
  }
  const existing = await prisma.season.findMany({ where: { leagueId }, select: { year: true, _count: { select: { games: true } } } });
  const existingYears = existing.map((s) => s.year);
  const existingYearGames = Object.fromEntries(existing.map((s) => [s.year, s._count.games]));
  const rosterOut = roster.slice().sort((a, b) => a.name.localeCompare(b.name));
  return { leagueId, league: league.name, unmatched, matched, multiTeam, existingYears, existingYearGames, roster: rosterOut };
}
