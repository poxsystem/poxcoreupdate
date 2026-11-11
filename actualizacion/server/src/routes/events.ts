import { Router } from 'express';
import type { RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { reduceGame, applyEvent, initialState, defaultAdvances, FIELD_NUM } from '@poxscore/shared';
import type { GameEvent } from '@poxscore/shared';
import { loadEvents, toEvent, gameContrib, applySeasonDelta } from './games.js';
import { enqueue } from './game-queue.js';
import { reqUser, authEnabled } from '../auth.js';

const r = Router();

// Express 4 no lleva los throws de handlers async al error middleware — sin
// esta envoltura un fallo de Prisma cuelga el socket (la app espera eterna)
const asyncH = (f: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { Promise.resolve(f(req, res)).catch(next); };

// La cola por juego vive en game-queue.ts — la comparte swap-player (games.ts)
// para que un reemapeo no se intercale con un POST/PUT de jugada

// número de posición (de "E5") -> nombre
const NUM_TO_POS = Object.fromEntries(Object.entries(FIELD_NUM).map(([pos, n]) => [n, pos]));

type LineupLite = { playerId: string; position: string };

const fielderAt = (lineup: LineupLite[], n: number): string | null => {
  const pos = NUM_TO_POS[n];
  return pos ? (lineup.find((l) => l.position === pos)?.playerId ?? null) : null;
};

/** Fildeadores cargados con error según la notación ("E5", "E4 E5") */
function errorFielders(lineup: LineupLite[], notation?: string | null, result?: string): string[] {
  if (!notation) return [];
  // quita el prefijo de tipo del formato nuevo ("2B-7" → "7", "3BE-5" → "5") —
  // sin él la E del código ("3BE-5") se leería como error fantasma en la 5
  const n2 = result && notation.startsWith(`${result}-`) ? notation.slice(result.length + 1) : notation;
  const nums = [...n2.matchAll(/E-?(\d+)/g)].map((m) => Number(m[1]));
  const ids: string[] = [];
  for (const n of nums) {
    const pid = fielderAt(lineup, n);
    if (pid) ids.push(pid);
  }
  return ids;
}

/**
 * Outs de fildeo (PO) y asistencias (A) desde la notación — reglas oficiales:
 *  - Par consecutivo (A-B): quien lanza recibe asistencia, quien recibe el putout.
 *    "6-4-3" doble play → A: 6 y 4, PO: 4 y 3.
 *  - Token solitario ("8", "F8") → putout sin asistencia.
 *  - "E#" nunca recibe PO; el fildeador anterior mantiene su asistencia ("6-E4" → A:6).
 *  - Ponche sin notación → PO automático al receptor (pos 2).
 */
// un token letra+dígito no puede repetir su propio guante (L7-7→L7, E7-7→E7)
// ni salir duplicado (E7-E7→E7); la excepción es G# (rola fildeada + acción
// sin asistencia: "G6-6-3") y los dígitos pelados repiten libre ("6-6-3")
export const normNotation = (s: string) => s
  .replace(/([EFLPXH]+\d+)-(\d+)(?=-|$)/g, (m, lt: string, d: string) => (lt.endsWith(d) ? lt : m))
  .replace(/([A-Z]+\d+)-\1(?=-|$)/g, '$1')
  // "7-E7" → E7: fildear y errar el MISMO guante es solo el error (no hay
  // asistencia en jugada de error); "6-E4" queda — fildeadores distintos
  .replace(/(\d+)-E\1(?=-|$)/g, 'E$1')
  // jardinero jamás repite dígito seguido: "8-8"/"7-7"/"9-9" no existen en
  // anotación real (el OF no se tira a sí mismo). Solo el infield 1-6 repite:
  // "6-6-3" (fildea, saca en 2ª sin asistencia, tira a 1ª), "3-3", "1-1"
  .replace(/([7-9])(?:-\1)+(?=-|$)/g, '$1');

// Notación oficial de batazos (#16 revisado): el HIT se escribe
// "[TIPO]-[ZONA]" — "2B-7" doble al left, "1B-F8" sencillo en elevado al
// central, "HR-9" jonrón al right. Los outs aéreos quedan "F8"/"L6"/"X5"
// pelados. El formato viejo con prefijo H ("H8", "HF7", "H4") sigue
// aceptándose como ENTRADA (voz/IA/edición) y aquí se convierte:
//  - H1..H4 = marca del tipo (jonrón "H4" se quita; "H4-7" → "HR-7")
//  - H#/H[G|L|F|X]# = zona del batazo ("H8"→"1B-8", "HF7"→"2B-F7")
const HIT_RESULTS = new Set(['1B', '2B', '3B', 'HR', 'HRIP', '1BE', '2BE', '3BE', 'RHB']);
// resultados que NO deduplican por contenido: los de conteo se repiten a propósito
// (bola 1, bola 2) y los ajustes manuales se acumulan (dos RBI+1 seguidos = +2)
const NO_CONTENT_DEDUP = new Set(['B', 'S', 'F', 'IPL', 'EF', 'RBI', 'EU', 'ADJ', 'EI', 'LG', 'SK']);
const HIT_TYPE_MARK: Record<string, string> = { '1': '1B', '2': '2B', '3': '3B', '4': 'HR' };
const hitZonePrefix = (notation: string | null, result: string): string | null => {
  if (!notation || !HIT_RESULTS.has(result)) return notation;
  // formato nuevo directo
  if (/^[GLFX]?\d{1,2}$/.test(notation)) return `${result}-${notation}`;
  const hm = /^H([GLFX]?)(\d{1,2})(?:-(\d{1,2}))?$/i.exec(notation);
  if (hm) {
    const [, traj, d, zone] = hm;
    if (HIT_TYPE_MARK[d] && (HIT_TYPE_MARK[d] === result || (d === '4' && result === 'HRIP'))) {
      return zone ? `${result}-${zone}` : null; // "H4" en un HR = solo marca de tipo
    }
    return `${result}-${traj}${d}`.toUpperCase();
  }
  return notation;
};

function fieldingCredits(lineup: LineupLite[], notation: string | null | undefined, result: string, outsOnPlay: number): { po: string[]; a: string[] } {
  const po: string[] = [], a: string[] = [];
  let toks = normNotation(
    (notation && notation.startsWith(`${result}-`)) ? notation.slice(result.length + 1) : (notation ?? '')
  )
    .split(/[-\s]+/)
    .map((t) => t.trim())
    .filter((t) => !/^H/i.test(t)) // H1-4/H7-9 = marcador de hit, no guante
    .map((t) => ({ e: /^E/i.test(t), n: Number(t.replace(/^[A-Z]+/i, '')) }))
    .filter((t) => Number.isInteger(t.n) && t.n >= 1 && t.n <= 10);

  // híbrido hit+error ("L9-E5"): el primer token es la ZONA del batazo, no un
  // fildeador — sacarlo para que no cobre asistencia fantasma si hubo out
  if (['1BE', '2BE', '3BE'].includes(result) && toks.length > 1 && !toks[0].e) toks = toks.slice(1);

  if (!toks.length) {
    if (result === 'K' && outsOnPlay > 0) {
      const c = fielderAt(lineup, 2);
      if (c) po.push(c);
    }
    return { po, a };
  }

  // sin out no hay out ni asistencia — un avance por tiro "7-2" con el corredor
  // quieto en base no acredita nada al que tiró (solo cuando lo sacan)
  if (outsOnPlay === 0) return { po, a };

  let outsCredited = 0;
  if (toks.length === 1) {
    // hit: un token solo es la ZONA del batazo ("7", "G7", "H7"), nunca un
    // putout — el jardinero que fildea un sencillo no saca a nadie; la
    // secuencia real de relevo ("9-5" tira al corredor en 3ª) sigue abajo
    // (RHB = hit al bateador + out del corredor golpeado: la notación "RHB-8"
    // lleva la zona, el out lo marca advances, sin guante)
    const isHit = ['1B', '2B', '3B', 'HR', 'HRIP', '1BE', '2BE', '3BE', 'RHB'].includes(result);
    if (!toks[0].e && !isHit && outsOnPlay > 0) {
      const pid = fielderAt(lineup, toks[0].n);
      if (pid) { po.push(pid); outsCredited++; }
    }
    return { po, a };
  }
  // relevo de UN solo out ("5-6-3": la agarra el tercera, pasa al short, tira a
  // primera) → asistencia a TODOS menos el último, que recibe el putout.
  // La regla de pares solo aplica cuando hubo 2+ outs (doble/triple play).
  if (outsOnPlay <= 1) {
    // el putout lo recibe el ÚLTIMO fildeador de la cadena si no fue error;
    // "6-E4" (tiro bueno, error recibiendo) → solo asistencia para el 6
    const poTok = outsOnPlay === 1 && !toks[toks.length - 1].e ? toks[toks.length - 1] : null;
    for (const t of toks) {
      if (t.e) continue;
      const pid = fielderAt(lineup, t.n);
      if (!pid) continue;
      if (t === poTok) po.push(pid); else if (!a.includes(pid)) a.push(pid);
    }
    return { po, a };
  }
  for (let i = 0; i + 1 < toks.length; i++) {
    const cur = toks[i], nxt = toks[i + 1];
    // el mismo fildeador puede repetirse ("6-6-3": fildea, saca en 2ª sin
    // asistencia y tira a 1ª) → PO en la 1ª acción + asistencia en el tiro;
    // pero NADIE recibe 2 asistencias en una jugada → `a` se deduplica
    if (!cur.e) { // el que lanza/participa → asistencia
      const pid = fielderAt(lineup, cur.n);
      if (pid && !a.includes(pid)) a.push(pid);
    }
    if (!nxt.e && outsCredited < outsOnPlay) { // el que recibe → putout
      const pid = fielderAt(lineup, nxt.n);
      if (pid) { po.push(pid); outsCredited++; }
    }
  }
  return { po, a };
}

/**
 * Reparación idempotente al arranque: las versiones viejas guardaron notaciones
 * malformadas ("E2-2", "L-E7-7", "E4-4" — token letra+dígito con su guante
 * repetido). Se normaliza la notación y se recalculan errorOn/putouts/assists
 * contra el lineup del equipo que fildeaba (las filas viejas cargan además
 * asistencias fantasma que inflan las stats de fildeo).
 */
export async function repairEventNotation(): Promise<number> {
  const evs = await prisma.gameEvent.findMany({
    where: { notation: { not: null } },
    select: { id: true, gameId: true, notation: true, result: true, half: true, advances: true },
  });
  const games = new Map<string, { homeTeamId: string; awayTeamId: string }>();
  let fixed = 0;
  for (const ev of evs) {
    // normNotation limpia malformadas; hitZonePrefix migra el formato viejo
    // de hits ("H8"/"HF7"/"H4") al oficial "[TIPO]-[ZONA]"
    const clean = hitZonePrefix(normNotation(ev.notation!), ev.result);
    if (clean === ev.notation) continue;
    const g = games.get(ev.gameId) ?? await prisma.game.findUnique({ where: { id: ev.gameId }, select: { homeTeamId: true, awayTeamId: true } });
    if (!g) continue;
    games.set(ev.gameId, g);
    const teamId = ev.half === 'TOP' ? g.homeTeamId : g.awayTeamId;
    const lineup = await prisma.lineupEntry.findMany({ where: { gameId: ev.gameId, teamId, active: true } });
    const errorOn = errorFielders(lineup, clean, ev.result);
    const outsOnPlay = ((ev.advances as { to?: string }[] | null) ?? []).filter((x) => x?.to === 'OUT').length;
    const fld = fieldingCredits(lineup, clean, ev.result, outsOnPlay);
    await prisma.gameEvent.update({
      where: { id: ev.id },
      data: {
        notation: clean,
        errorOn: errorOn.length ? JSON.stringify(errorOn) : null,
        putouts: fld.po.length ? JSON.stringify(fld.po) : null,
        assists: fld.a.length ? JSON.stringify(fld.a) : null,
      },
    });
    fixed++;
  }
  return fixed;
}

r.get('/:id/events', asyncH(async (req, res) => {
  res.json(await loadEvents(req.params.id));
}));

/**
 * Edición de jugada (solo admin — el módulo 🛡 corrige juegos terminados):
 * cambia resultado, notación, bateador, lanzador, entrada/mi­tad y avances.
 * Los créditos de fildeo (PO/A/errorOn) se RECALCULAN desde la notación nueva
 * contra la alineación del lado que fildea — la hoja y las stats salen del
 * stream de eventos, así que todo se repara solo.
 */
// :seq = número de jugada dentro del juego (único por juego — el API no expone id)
r.put('/:id/events/:seq', asyncH(async (req, res) => {
  const u = await reqUser(req);
  const gameId = req.params.id;
  const [game, ev] = await Promise.all([
    prisma.game.findUnique({ where: { id: gameId } }),
    prisma.gameEvent.findUnique({ where: { gameId_seq: { gameId, seq: Number(req.params.seq) } } }),
  ]);
  if (!game || !ev) return res.status(404).json({ error: 'Jugada no encontrada' });
  // Corrección quirúrgica: admin siempre; anotador solo en juego vivo (los FINAL
  // van por /audit, que exige decisiones + bitácora). Sin usuarios = modo abierto.
  const open = !(await authEnabled());
  const allowed = open || u?.role === 'admin' || (u?.role === 'anotador' && game.status !== 'FINAL');
  if (!allowed) return res.status(403).json({ error: 'Juego finalizado — usa la Auditoría (admin)' });

  return enqueue(gameId, async () => {
    const { result, notation, batterId, pitcherId, advances, inning, half, sprayDir, sprayDist } = req.body as {
      result?: string; notation?: string | null; batterId?: string | null; pitcherId?: string | null;
      advances?: { playerId: string; to: number | 'HOME' | 'OUT' }[]; inning?: number; half?: 'TOP' | 'BOTTOM';
      sprayDir?: number | null; sprayDist?: number | null;
    };
    const str = (v: unknown, max: number) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);
    if (!str(result, 40) || !str(notation, 191) || !str(batterId, 191) || !str(pitcherId, 191)) {
      return res.status(400).json({ error: 'campo inválido o demasiado largo' });
    }
    const sprayNum = (v: unknown) => v == null || (typeof v === 'number' && Number.isFinite(v));
    if (!sprayNum(sprayDir) || !sprayNum(sprayDist)) return res.status(400).json({ error: 'spray inválido' });
    if (inning != null && (!Number.isFinite(Number(inning)) || Number(inning) < 1 || Number(inning) > 99)) {
      return res.status(400).json({ error: 'Entrada inválida' });
    }
    if (advances !== undefined && !Array.isArray(advances)) {
      return res.status(400).json({ error: 'advances debe ser una lista' });
    }
    const newHalf = (half === 'TOP' || half === 'BOTTOM') ? half : ev.half as 'TOP' | 'BOTTOM';
    const newResult = result ?? ev.result;
    const clean = notation === undefined ? ev.notation : (notation ? normNotation(String(notation)) : null);
    const newNotation = hitZonePrefix(
      clean && HIT_RESULTS.has(newResult)
        ? clean.replace(/(\d)-\1(?=-|$)/g, '$1')
        : clean,
      newResult);
    const newAdv = advances === undefined ? ev.advances : advances;

    // recalcula créditos contra la alineación del lado que fildea la nueva mitad
    const fieldingTeamId = newHalf === 'TOP' ? game.homeTeamId : game.awayTeamId;
    const lineup = await prisma.lineupEntry.findMany({ where: { gameId, teamId: fieldingTeamId, active: true } });
    const err = errorFielders(lineup, newNotation, newResult);
    const outsOnPlay = (newAdv as { to?: string }[] | null)?.filter((x) => x.to === 'OUT').length ?? 0;
    const fld = fieldingCredits(lineup, newNotation, newResult, outsOnPlay);

    const updated = await prisma.gameEvent.update({
      where: { id: ev.id },
      data: {
        result: newResult,
        notation: newNotation,
        batterId: batterId === undefined ? ev.batterId : batterId,
        pitcherId: pitcherId === undefined ? ev.pitcherId : pitcherId,
        advances: newAdv ?? undefined,
        inning: inning != null ? Number(inning) : ev.inning,
        half: newHalf,
        // spray: solo se toca si viene en el body (null lo limpia a propósito)
        ...(sprayDir !== undefined || sprayDist !== undefined
          ? { sprayDir: sprayDir ?? null, sprayDist: sprayDist ?? null } : {}),
        errorOn: err.length ? JSON.stringify(err) : null,
        putouts: fld.po.length ? JSON.stringify(fld.po) : null,
        assists: fld.a.length ? JSON.stringify(fld.a) : null,
      },
    });
    const events = await loadEvents(gameId);
    res.json({ event: toEvent(updated), state: reduceGame(events, game.innings) });
  });
}));

/**
 * Agrega un evento. El servidor recalcula el estado desde cero
 * (fuente de verdad) y deriva inning/half/seq automáticamente.
 */
r.post('/:id/events', asyncH(async (req, res) => {
  const gameId = req.params.id;
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });

  // escritura serializada por juego — dos POSTs concurrentes no se pisan el seq
  return enqueue(gameId, async () => {
  const events = await loadEvents(gameId);
  const state = reduceGame(events, game.innings);

  const { batterId, pitcherId, result, notation, advances, inning, half, aiVoice, aiJson, aiVideo, clientKey, sprayDir, sprayDist, beforeSeq } = req.body;
  if (!result || !Array.isArray(advances)) return res.status(400).json({ error: 'result y advances requeridos' });
  if (beforeSeq != null && (!Number.isInteger(beforeSeq) || beforeSeq < 1)) {
    return res.status(400).json({ error: 'beforeSeq inválido' });
  }
  const num = (v: unknown, lo: number, hi: number) => v == null || (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi);
  if (!num(sprayDir, -180, 180) || !num(sprayDist, 0, 400)) return res.status(400).json({ error: 'spray fuera de rango' });
  // tipos/longitudes — un string que no cabe en VARCHAR(191) o un tipo erróneo
  // no debe llegar a Prisma (revienta con 500); ai* son TEXT/MEDIUMTEXT
  const str = (v: unknown, max: number) => v == null || (typeof v === 'string' && v.length <= max);
  if (typeof result !== 'string' || result.length > 40
    || !str(notation, 191) || !str(clientKey, 191) || !str(batterId, 191) || !str(pitcherId, 191)
    || !str(aiVoice, 65000) || !str(aiJson, 16000000) || !str(aiVideo, 16000000)) {
    return res.status(400).json({ error: 'campo inválido o demasiado largo' });
  }

  // idempotencia: la cola offline y el doble toque reenvían la MISMA jugada
  // con su clientKey — si ya existe se devuelve la grabada, jamás un duplicado
  if (clientKey) {
    try {
      const dup = await prisma.gameEvent.findFirst({ where: { gameId, clientKey: String(clientKey) } });
      if (dup) {
        const evs = await loadEvents(gameId);
        return res.json({ event: toEvent(dup), state: reduceGame(evs, game.innings), dup: true });
      }
    } catch { /* cliente Prisma viejo sin clientKey — se anota sin dedup */ }
  }

  // "anotación al vuelo": inning/half explícitos → la jugada se graba con esas
  // etiquetas sin depender de la posición derivada (permite transcribir la hoja
  // de un solo equipo de corrido; el reduce interno se resincroniza al final).
  const fly = inning != null && (half === 'TOP' || half === 'BOTTOM');
  // status fresco DENTRO de la cola — el `game` de afuera se capturó antes de
  // encolar y otra operación pudo haber marcado el juego FINAL entretanto
  const cur = await prisma.game.findUnique({ where: { id: gameId }, select: { status: true } });
  if (cur?.status === 'FINAL' || (!fly && state.status === 'FINAL')) {
    return res.status(409).json({ error: 'El juego ya terminó' });
  }
  const evInning = fly ? Number(inning) : state.inning;
  const evHalf = (fly ? half : state.half) as 'TOP' | 'BOTTOM';

  // fildeo: errores + outs/asistencias por fildeador, resueltos contra la alineación activa
  const fieldingTeamId = evHalf === 'TOP' ? game.homeTeamId : game.awayTeamId;
  const lineup = await prisma.lineupEntry.findMany({ where: { gameId, teamId: fieldingTeamId, active: true } });
  const cleanNotation = notation ? normNotation(String(notation)) : null;
  // hit: la zona del batazo es UNA posición — dígito repetido consecutivo es
  // doble toque ("7-7"→"7"); en outs el mismo guante sí repite ("6-6-3")
  const hitNotation = hitZonePrefix(
    cleanNotation && HIT_RESULTS.has(result)
      ? cleanNotation.replace(/(\d)-\1(?=-|$)/g, '$1')
      : cleanNotation,
    result);
  const errorOn = errorFielders(lineup, hitNotation, result);
  const outsOnPlay = (advances as { to: string }[]).filter((x) => x.to === 'OUT').length;
  const fld = fieldingCredits(lineup, hitNotation, result, outsOnPlay);

  // red de seguridad: jugada IDÉNTICA a la última grabada = la misma jugada —
  // cubre clientes sin clientKey, doble envío con clave distinta y dos anotadores
  // en dispositivos distintos. Solo al anexar al final (una inserción dirigida
  // beforeSeq es deliberada). Los eventos de conteo (B/S/F…) y los ajustes
  // acumulables (RBI/EU/ADJ) se repiten legítimamente — no deduplican.
  const last = events[events.length - 1];
  const sameAdv = (a: unknown, b: unknown) => {
    const sig = (x: unknown) => ((x ?? []) as { playerId?: string; to?: unknown }[])
      .map((v) => `${v?.playerId}:${v?.to}`).join(',');
    return sig(a) === sig(b);
  };
  if (beforeSeq == null && last && !NO_CONTENT_DEDUP.has(String(result))
    && last.result === result
    && (last.batterId ?? null) === (batterId ?? null)
    && (last.pitcherId ?? null) === (pitcherId ?? null)
    && (last.notation ?? null) === (hitNotation ?? null)
    && sameAdv(last.advances, advances)) {
    const evs = await loadEvents(gameId);
    return res.json({ event: last, state: reduceGame(evs, game.innings), dup: true });
  }

  let seq = (events[events.length - 1]?.seq ?? 0) + 1;
  // inserción dirigida ("Anotar en esta casilla", Alt+clic en la planilla):
  // la jugada ocupa su lugar cronológico — los seq posteriores se desplazan.
  // El corrimiento va en DESC: "seq+1" aplicado al mayor primero nunca pisa
  // el @@unique(gameId,seq) durante el UPDATE
  if (beforeSeq != null) {
    const bs = Number(beforeSeq);
    if (bs > seq) return res.status(400).json({ error: `No existe la jugada #${bs}` });
    if (bs < seq) {
      await prisma.$executeRaw`UPDATE GameEvent SET seq = seq + 1 WHERE gameId = ${gameId} AND seq >= ${bs} ORDER BY seq DESC`;
    }
    seq = bs;
  }
  const data = {
    gameId,
    inning: evInning, half: evHalf,
    batterId: batterId ?? null, pitcherId: pitcherId ?? null,
    result, notation: hitNotation, advances,
    ...(sprayDir != null && sprayDist != null ? { sprayDir: Number(sprayDir), sprayDist: Number(sprayDist) } : {}),
    errorOn: errorOn.length ? JSON.stringify(errorOn) : null,
    putouts: fld.po.length ? JSON.stringify(fld.po) : null,
    assists: fld.a.length ? JSON.stringify(fld.a) : null,
    ...(clientKey ? { clientKey: String(clientKey) } : {}),
    // los campos ai* solo se envían con valor — un cliente Prisma
    // desactualizado (actualización sin `prisma generate`) los rechaza
    // aunque vengan null, y eso tumba el server entero al anotar
    ...(aiVoice ? { aiVoice } : {}), ...(aiJson ? { aiJson } : {}), ...(aiVideo ? { aiVideo } : {}),
  };
  // ¿el cliente Prisma quedó viejo tras una actualización sin `prisma generate`?
  // un campo nuevo del schema le lanza "Unknown argument 'x'" y tumba la
  // anotación en campo — se quita ESE campo y la jugada se reintenta sin él
  const droppedArgs = new Set<string>();
  let created;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    try {
      const d = droppedArgs.size
        ? (Object.fromEntries(Object.entries(data).filter(([k]) => !droppedArgs.has(k))) as typeof data)
        : data;
      created = await prisma.gameEvent.create({ data: { ...d, seq } });
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      const msg = String((e as Error)?.message ?? '');
      const target = String((e as { meta?: { target?: unknown } })?.meta?.target ?? '');
      // cliente viejo: "Unknown argument 'clientKey'/'aiVoice'/…" — la jugada
      // se graba sin ese meta (mejor perderlo que la jugada misma)
      const bad = /Unknown argument ['`"]?(\w+)['`"]?/.exec(msg)?.[1];
      if (bad && bad !== 'seq' && bad !== 'gameId' && !droppedArgs.has(bad)) {
        droppedArgs.add(bad);
        continue;
      }
      // misma clientKey llegó dos veces en carrera — devolver la que quedó grabada
      if (clientKey && code === 'P2002' && target.includes('clientKey')) {
        const dup = await prisma.gameEvent.findFirst({ where: { gameId, clientKey: String(clientKey) } });
        if (dup) {
          const evs = await loadEvents(gameId);
          return res.json({ event: toEvent(dup), state: reduceGame(evs, game.innings), dup: true });
        }
        throw e;
      }
      // seq chocó con otro POST concurrente — recalcular y reintentar
      if (code === 'P2002') {
        const evs = await loadEvents(gameId);
        seq = (evs[evs.length - 1]?.seq ?? 0) + 1;
        continue;
      }
      throw e;
    }
  }
  if (!created) return res.status(500).json({ error: 'No se pudo grabar la jugada — reintenta' });

  // actualizar status del juego si terminó — tras un retry de seq o una
  // inserción antesSeq el estado se recalcula leyendo los eventos frescos
  // (el evento nuevo NO queda al final del stream)
  const newEvents = (seq !== created.seq || beforeSeq != null) ? await loadEvents(gameId)
    : [...events, toEvent(created)];
  const newState = reduceGame(newEvents, game.innings);
  if (newState.status !== game.status) {
    await prisma.game.update({
      where: { id: gameId },
      data: { status: newState.status, endedAt: newState.status === 'FINAL' ? new Date() : undefined },
    });
  } else if (game.status === 'SCHEDULED') {
    await prisma.game.update({ where: { id: gameId }, data: { status: 'LIVE' } });
  }

  // devolver el evento serializado igual que loadEvents (errorOn/putouts/assists
  // como arrays — el objeto Prisma crudo los trae como string JSON y el frontend
  // contaría caracteres, no fildeadores)
  res.status(201).json({ event: toEvent(created), state: newState });
  });
}));

/** Deshace el último evento */
r.delete('/:id/events/last', asyncH(async (req, res) => {
  const gameId = req.params.id;
  return enqueue(gameId, async () => {
  const last = await prisma.gameEvent.findFirst({ where: { gameId }, orderBy: { seq: 'desc' } });
  if (!last) return res.status(404).json({ error: 'No hay eventos' });
  await prisma.gameEvent.delete({ where: { id: last.id } });
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  const state = reduceGame(await loadEvents(gameId), game?.innings ?? 9);
  if (game && game.status !== state.status && state.status === 'LIVE') {
    await prisma.game.update({ where: { id: gameId }, data: { status: 'LIVE' } });
  }
  res.json({ deleted: last, state });
  });
}));

/** Borra UNA jugada — "Limpiar celda completa" (clic derecho en la planilla)
    y corrección quirúrgica. Misma regla que PUT: admin siempre, anotador
    solo con el juego vivo (los FINAL van por /audit). */
r.delete('/:id/events/:seq', asyncH(async (req, res) => {
  const u = await reqUser(req);
  const gameId = req.params.id;
  const [game, ev] = await Promise.all([
    prisma.game.findUnique({ where: { id: gameId } }),
    prisma.gameEvent.findUnique({ where: { gameId_seq: { gameId, seq: Number(req.params.seq) } } }),
  ]);
  if (!game || !ev) return res.status(404).json({ error: 'Jugada no encontrada' });
  const open = !(await authEnabled());
  const allowed = open || u?.role === 'admin' || (u?.role === 'anotador' && game.status !== 'FINAL');
  if (!allowed) return res.status(403).json({ error: 'Juego finalizado — usa la Auditoría (admin)' });
  return enqueue(gameId, async () => {
    await prisma.gameEvent.delete({ where: { id: ev.id } });
    const state = reduceGame(await loadEvents(gameId), game.innings);
    if (game.status !== state.status && state.status === 'LIVE') {
      await prisma.game.update({ where: { id: gameId }, data: { status: 'LIVE' } });
    }
    res.json({ deleted: Number(req.params.seq), state });
  });
}));

/**
 * Borra desde una jugada en adelante — para corregir errores de anotación
 * que vienen de varias jugadas atrás. `?fromSeq=N` elimina la jugada N y
 * todas las posteriores; el estado se recalcula desde cero.
 */
r.delete('/:id/events', asyncH(async (req, res) => {
  const gameId = req.params.id;
  const fromSeq = Number(req.query.fromSeq);
  if (!Number.isInteger(fromSeq) || fromSeq < 1) {
    return res.status(400).json({ error: 'fromSeq requerido (número de jugada)' });
  }
  return enqueue(gameId, async () => {
  const total = await prisma.gameEvent.count({ where: { gameId } });
  if (!total) return res.status(404).json({ error: 'No hay eventos' });
  const { count } = await prisma.gameEvent.deleteMany({
    where: { gameId, seq: { gte: fromSeq } },
  });
  if (!count) return res.status(404).json({ error: `No hay jugada #${fromSeq}` });
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  const state = reduceGame(await loadEvents(gameId), game?.innings ?? 9);
  if (game && game.status !== state.status && state.status === 'LIVE') {
    await prisma.game.update({ where: { id: gameId }, data: { status: 'LIVE' } });
  }
  res.json({ deleted: count, fromSeq, state });
  });
}));

/**
 * POST /:id/repair-pitchers — repara pitcherId del lado equivocado.
 * Bug histórico del ScorePage: el pitcher quedaba fijo del equipo anterior al
 * cambiar de mitad, así que los eventos de una mitad podían quedar cargados al
 * pitcher del equipo contrario. Aquí: si el pitcherId de un evento pertenece al
 * lineup del equipo que BATEA, se reasigna al jugador con posición P del lineup
 * defensor (o al pitcher más frecuente ya correcto en esa mitad).
 */
r.post('/:id/repair-pitchers', asyncH(async (req, res) => {
  const gameId = req.params.id;
  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  const [evs, lineup] = await Promise.all([
    prisma.gameEvent.findMany({ where: { gameId }, orderBy: { seq: 'asc' } }),
    prisma.lineupEntry.findMany({ where: { gameId } }),
  ]);
  // equipo de cada jugador en ESTE juego (según lineup)
  const teamOf = new Map(lineup.map((l) => [l.playerId, l.teamId]));
  const battingTeam = (half: string) => (half === 'TOP' ? game.awayTeamId : game.homeTeamId);
  const fieldingTeam = (half: string) => (half === 'TOP' ? game.homeTeamId : game.awayTeamId);
  // candidatos a pitcher por equipo defensor: posición P en el lineup (activo o no)
  const psOf = (tid: string) => lineup.filter((l) => l.teamId === tid && l.position === 'P').map((l) => l.playerId);

  let fixed = 0;
  const updates: Promise<unknown>[] = [];
  for (const ev of evs) {
    if (!ev.pitcherId) continue;
    const wrongSide = teamOf.get(ev.pitcherId) === battingTeam(ev.half);
    if (!wrongSide) continue;
    const fid = fieldingTeam(ev.half);
    // reasignar al P del lineup defensor; si hay varios, al que ya lance correctamente esta mitad
    const candidates = psOf(fid);
    const freq = new Map<string, number>();
    for (const e2 of evs) {
      if (e2.half === ev.half && e2.pitcherId && teamOf.get(e2.pitcherId) === fid) {
        freq.set(e2.pitcherId, (freq.get(e2.pitcherId) ?? 0) + 1);
      }
    }
    const target = candidates.sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0))[0]
      ?? [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!target || target === ev.pitcherId) continue;
    updates.push(prisma.gameEvent.update({ where: { id: ev.id }, data: { pitcherId: target } }));
    fixed++;
  }
  await Promise.all(updates);
  res.json({ ok: true, fixed, total: evs.length });
}));

/**
 * POST /:id/audit — AUDITORÍA DE JUEGO (solo admin).
 * Edita, inserta o borra jugadas de un juego — incluido uno FINAL — y
 * recalcula TODO: estado, boxscore, acumulados de temporada por delta,
 * decisiones y standings (se derivan del stream + tied).
 *
 * body:
 *   ops: [{action:'edit',seq,...campos} | {action:'delete',seq} |
 *         {action:'deleteFrom',seq} | {action:'insert',beforeSeq,event:{...}}]
 *   decisions?: {wpId,lpId,svId,hldIds,bsIds,tied} — OBLIGATORIAS cuando la
 *     operación cambia el ganador/empate; si faltan se responde 409
 *     needDecisions SIN tocar la base (la edición no queda a medias).
 *   reason?: string — motivo, queda en la bitácora junto a fecha y usuario.
 */
interface AuditOp {
  action: 'edit' | 'delete' | 'deleteFrom' | 'insert';
  seq?: number; beforeSeq?: number;
  result?: string; notation?: string | null; batterId?: string | null; pitcherId?: string | null;
  inning?: number; half?: 'TOP' | 'BOTTOM';
  advances?: GameEvent['advances'];
  event?: {
    result: string; notation?: string | null; batterId?: string | null; pitcherId?: string | null;
    inning: number; half: 'TOP' | 'BOTTOM';
    advances: GameEvent['advances'];
  };
}

r.post('/:id/audit', asyncH(async (req, res) => {
  const u = await reqUser(req);
  const open = !(await authEnabled());
  if (!open && u?.role !== 'admin') return res.status(403).json({ error: 'Requiere rol admin' });
  const gameId = req.params.id;
  return enqueue(gameId, async () => {
    const { ops, decisions, reason } = req.body as {
      ops?: AuditOp[];
      decisions?: { wpId?: string | null; lpId?: string | null; svId?: string | null; hldIds?: string[]; bsIds?: string[]; tied?: boolean };
      reason?: string;
    };
    if (!Array.isArray(ops) || !ops.length) return res.status(400).json({ error: 'ops requerido' });
    const game = await prisma.game.findUnique({
      where: { id: gameId }, include: { lineups: true, season: true },
    });
    if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
    const rows = await prisma.gameEvent.findMany({ where: { gameId }, orderBy: { seq: 'asc' } });
    // fScore (marcador metido a mano) solo manda en juegos SIN jugadas
    // grabadas — si hay stream, la verdad es el stream: auditar un juego con
    // fScore puesto dejaba el escore "clavado" y parecía que nada cambiaba
    const scoreOf = (evs: GameEvent[]) =>
      !evs.length && game.fScoreAway != null && game.fScoreHome != null
        ? { away: game.fScoreAway, home: game.fScoreHome }
        : reduceGame(evs, game.innings).score;
    const oldEvents = rows.map(toEvent);
    const oldScore = scoreOf(oldEvents);
    const winnerOf = (s: { away: number; home: number }) => (s.away > s.home ? 'away' : s.home > s.away ? 'home' : 'tie');

    // ── aplicar las ops en memoria (la respuesta needDecisions no toca la BD) ──
    interface Desired { rowId: string | null; ev: GameEvent }
    const desired: Desired[] = oldEvents.map((ev, i) => ({ rowId: rows[i].id, ev }));
    const lineupOf = (half: 'TOP' | 'BOTTOM') => {
      const tid = half === 'TOP' ? game.homeTeamId : game.awayTeamId;
      return game.lineups.filter((l) => l.teamId === tid && l.active);
    };
    const credits = (ev: GameEvent) => {
      const lu = lineupOf(ev.half);
      const err = errorFielders(lu, ev.notation);
      const outs = ev.advances.filter((a) => a.to === 'OUT').length;
      const fld = fieldingCredits(lu, ev.notation, ev.result, outs);
      return {
        errorOn: err.length ? JSON.stringify(err) : null,
        putouts: fld.po.length ? JSON.stringify(fld.po) : null,
        assists: fld.a.length ? JSON.stringify(fld.a) : null,
      };
    };

    for (const op of ops) {
      if (op.action === 'edit') {
        const di = desired.findIndex((x) => x.ev.seq === op.seq);
        if (di < 0) return res.status(404).json({ error: `No hay jugada #${op.seq}` });
        const ev = desired[di].ev;
        const opRes = (op.result ?? ev.result) as GameEvent['result'];
        // Si cambió el resultado y el cliente no mandó avances, se regeneran
        // con defaultAdvances sobre el estado previo — si no, quedan avances
        // viejos (ej. «anotó») y el escore no se mueve pese al cambio.
        let adv = op.advances ?? ev.advances;
        const newBatter = op.batterId === undefined ? ev.batterId : op.batterId;
        if (op.advances === undefined && op.result !== undefined && op.result !== ev.result && newBatter) {
          const prev = reduceGame(desired.slice(0, di).map((x) => x.ev), game.innings);
          adv = defaultAdvances(prev, newBatter, opRes as Parameters<typeof defaultAdvances>[2]);
        }
        desired[di].ev = {
          ...ev,
          result: opRes,
          notation: op.notation === undefined ? ev.notation : hitZonePrefix(op.notation ? normNotation(String(op.notation)) : null, opRes),
          batterId: op.batterId === undefined ? ev.batterId : op.batterId,
          pitcherId: op.pitcherId === undefined ? ev.pitcherId : op.pitcherId,
          advances: adv,
          inning: op.inning != null ? Number(op.inning) : ev.inning,
          half: (op.half === 'TOP' || op.half === 'BOTTOM') ? op.half : ev.half,
        };
      } else if (op.action === 'delete') {
        const i = desired.findIndex((x) => x.ev.seq === op.seq);
        if (i < 0) return res.status(404).json({ error: `No hay jugada #${op.seq}` });
        desired.splice(i, 1);
      } else if (op.action === 'deleteFrom') {
        const i = desired.findIndex((x) => x.ev.seq === op.seq);
        if (i < 0) return res.status(404).json({ error: `No hay jugada #${op.seq}` });
        desired.splice(i);
      } else if (op.action === 'insert') {
        const e = op.event;
        if (!e?.result || !Array.isArray(e.advances) || !e.inning || (e.half !== 'TOP' && e.half !== 'BOTTOM')) {
          return res.status(400).json({ error: 'insert: event requiere result, inning, half y advances' });
        }
        const at = op.beforeSeq == null ? desired.length : desired.findIndex((x) => x.ev.seq === op.beforeSeq);
        const idx = at < 0 ? desired.length : at;
        desired.splice(idx, 0, {
          rowId: null,
          ev: {
            seq: 0, inning: Number(e.inning), half: e.half,
            batterId: e.batterId ?? null, pitcherId: e.pitcherId ?? null,
            result: e.result as GameEvent['result'],
            notation: e.notation ? normNotation(String(e.notation)) : null,
            advances: e.advances,
          },
        });
      } else {
        return res.status(400).json({ error: `acción inválida: ${(op as AuditOp).action}` });
      }
    }

    // ── recorte automático: en un juego FINAL, todo lo grabado después del
    // punto donde el partido quedó definido ya no es necesario (reduceGame lo
    // ignora, pero no debe seguir en la BD — infla el play-by-play y confunde)
    let trimmed = 0;
    if (game.status === 'FINAL') {
      let st = initialState();
      for (let i = 0; i < desired.length; i++) {
        st = applyEvent(st, desired[i].ev, game.innings);
        if (st.status === 'FINAL') {
          if (i + 1 < desired.length) {
            trimmed = desired.length - (i + 1);
            desired.splice(i + 1);
          }
          break;
        }
      }
    }

    const newEvents = desired.map((d) => d.ev);
    const newScore = scoreOf(newEvents);
    const oldWin = winnerOf(oldScore);
    const newWin = winnerOf(newScore);
    const outcomeChanged = oldWin !== newWin;
    const effWp = decisions?.wpId || game.wpId || null;
    const effLp = decisions?.lpId || game.lpId || null;

    // empate→ganado (o cambio de ganador) en juego cerrado: solo pide decisiones
    // si el nuevo resultado NO es empate y aún no hay ganador/perdedor definidos
    // (ni enviados ahora ni guardados previamente en el juego).
    if (outcomeChanged && game.status === 'FINAL' && newWin !== 'tie' && (!effWp || !effLp)) {
      return res.status(409).json({
        needDecisions: true, winner: newWin,
        scoreBefore: oldScore, scoreAfter: newScore,
        error: 'El resultado cambió — indica lanzador ganador y perdedor',
      });
    }

    // contribución previa para la resincronización de temporada
    const needResync = game.status === 'FINAL' || game.seasonApplied;
    const before = needResync ? await gameContrib(game) : null;

    // ── escribir: borrar salidas, re-numerar con margen, reescribir seqs ──
    const keepIds = desired.filter((d) => d.rowId).map((d) => d.rowId!);
    await prisma.gameEvent.deleteMany({
      where: { gameId, ...(keepIds.length ? { id: { notIn: keepIds } } : {}) },
    });
    await prisma.gameEvent.updateMany({ where: { gameId }, data: { seq: { increment: 100000 } } });
    for (let i = 0; i < desired.length; i++) {
      const d = desired[i];
      const cred = credits(d.ev);
      const data = {
        seq: i + 1, inning: d.ev.inning, half: d.ev.half,
        batterId: d.ev.batterId ?? null, pitcherId: d.ev.pitcherId ?? null,
        result: d.ev.result, notation: d.ev.notation ?? null,
        advances: (d.ev.advances ?? []) as unknown as Prisma.InputJsonValue,
        sprayDir: d.ev.sprayDir ?? null, sprayDist: d.ev.sprayDist ?? null,
        ...cred,
      };
      if (d.rowId) {
        await prisma.gameEvent.update({ where: { id: d.rowId }, data });
      } else {
        await prisma.gameEvent.create({
          data: { ...data, gameId, clientKey: `audit-${Date.now().toString(36)}-${i}` },
        });
      }
    }

    // ── decisiones: obligatorias si cambió el resultado, opcionales si no ──
    let merged = game;
    const isTieNow = newWin === 'tie';
    if (decisions || outcomeChanged || !!game.tied !== isTieNow) {
      const t = isTieNow ? true : (decisions?.tied ?? false);
      const upd = await prisma.game.update({
        where: { id: gameId },
        data: {
          tied: t,
          wpId: t ? null : (decisions?.wpId || game.wpId || null),
          lpId: t ? null : (decisions?.lpId || game.lpId || null),
          svId: t ? null : (decisions?.svId !== undefined ? decisions.svId : (game.svId ?? null)),
          hldIds: t ? null : (decisions?.hldIds !== undefined ? JSON.stringify(decisions.hldIds) : game.hldIds),
          bsIds: t ? null : (decisions?.bsIds !== undefined ? JSON.stringify(decisions.bsIds) : game.bsIds),
        },
      });
      merged = { ...game, ...upd };
    }

    // marcador manual (fScore): si el juego lo traía puesto (ej. se cerró por
    // reclamo con el escore digitado), se reescribe con el marcador auditado —
    // excepto forfeit, cuyo marcador oficial es reglamentario y se conserva
    if (!game.forfeitBy && game.fScoreAway != null && game.fScoreHome != null) {
      await prisma.game.update({
        where: { id: gameId },
        data: { fScoreAway: newScore.away, fScoreHome: newScore.home },
      });
    }

    // ── resincronizar temporada (delta antes/después) ──
    if (before) {
      const after = await gameContrib({ ...merged, lineups: game.lineups, season: game.season });
      await applySeasonDelta(game, before, after);
    }

    // ── bitácora ──
    const entry = {
      at: new Date().toISOString(), user: u?.username ?? 'admin', reason: reason ?? null,
      ops: ops.map((o) => ({ a: o.action, seq: o.seq ?? o.beforeSeq, r: o.result ?? o.event?.result })),
      scoreBefore: oldScore, scoreAfter: newScore,
      decisions: decisions ?? null,
      ...(trimmed ? { trimmed } : {}),
    };
    const log = [...((game.auditLog as unknown[] | null) ?? []), entry];
    await prisma.game.update({ where: { id: gameId }, data: { auditLog: log as Prisma.InputJsonValue } });

    const fresh = await loadEvents(gameId);
    res.json({
      ok: true, state: reduceGame(fresh, game.innings),
      score: newScore, outcomeChanged, trimmed, audit: entry,
    });
  });
}));

export default r;
