import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../prisma.js';
import { aiChat, aiCheck, aiEnabled, aiTranscribe, DOMINICAN_GLOSSARY } from '../services/ai.js';
import { applyEvent, computeBoxscore, initialState, reduceGame } from '@poxscore/shared';
import type { GameEvent } from '@poxscore/shared';
import { toEvent } from './games.js';
import { normNotation } from './events.js';

const r = Router();
const loadEvents = async (gameId: string): Promise<GameEvent[]> =>
  (await prisma.gameEvent.findMany({ where: { gameId }, orderBy: { seq: 'asc' } })).map(toEvent);

/* ============ CONFIG — clave OpenAI desde la app ============ */
// El .env vive en <server>/.env — puede correr desde src/, dist/ o launcher.
const envPath = (): string => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const cands = [
    path.resolve(dir, '../.env'),      // dist bundle (server/dist) → server/.env
    path.resolve(dir, '../../.env'),   // src/routes → server/.env
    path.resolve(process.cwd(), '.env'),           // cwd = server (launcher)
    path.resolve(process.cwd(), 'server', '.env'), // cwd = raíz del repo
  ];
  return cands.find((p) => fs.existsSync(p)) ?? cands[0];
};

r.get('/ai/config', (_req, res) => {
  res.json({ openai: aiEnabled() });
});

/** Guarda/borra OPENAI_API_KEY en .env, la aplica en caliente y la VALIDA contra OpenAI. */
r.post('/ai/config', async (req, res) => {
  const key = String(req.body?.openaiKey ?? '').trim();
  const fp = envPath();
  const lines = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8').split(/\r?\n/) : [];
  let found = false;
  const out = lines
    .map((l) => (/^OPENAI_API_KEY\s*=/.test(l) ? (found = true, key ? `OPENAI_API_KEY=${key}` : null) : l))
    .filter((l): l is string => l !== null);
  if (!found && key) out.push(`OPENAI_API_KEY=${key}`);
  fs.writeFileSync(fp, out.join('\n'));
  if (key) process.env.OPENAI_API_KEY = key;
  else delete process.env.OPENAI_API_KEY;
  const check = key ? await aiCheck() : null; // la clave guardada se prueba de una vez
  res.json({ ok: true, openai: !!key, valid: check?.ok ?? null, error: check?.error });
});
/* ========================================================== */

const playerName = (p?: { firstName: string; lastName: string; number?: number | null } | null) =>
  p ? `${p.number ? `#${p.number} ` : ''}${p.firstName} ${p.lastName}` : '';

/* ================= MÓDULO 1 — VOZ → NOTACIÓN OFICIAL =================
 * Transcripción dominicana → JSON de notación. Mapea play_code a nuestros
 * result codes del engine (result + notation). */
const CODE_MAP: Record<string, { result: string; notation?: string }> = {
  K: { result: 'K' }, BB: { result: 'BB' }, IBB: { result: 'IBB' }, HBP: { result: 'HBP' },
  '2B': { result: '2B' }, '3B': { result: '3B' }, HR: { result: 'HR' }, HRIP: { result: 'HRIP' },
  FC: { result: 'FC' }, SF: { result: 'SF' }, SH: { result: 'SAC' }, SAC: { result: 'SAC' },
  SB: { result: 'SB' }, CS: { result: 'CS' }, WP: { result: 'WP' }, PB: { result: 'PB' }, BK: { result: 'BK' },
};

function codeToEngine(code: string): { result: string; notation?: string } | null {
  const c = code.trim().toUpperCase();
  if (CODE_MAP[c]) return CODE_MAP[c];
  if (/^H[1-4]$/.test(c)) return { result: ({ H1: '1B', H2: '2B', H3: '3B', H4: 'HR' } as Record<string, string>)[c], notation: c }; // H1-4 = tipo de hit
  if (/^H[789]$/.test(c)) return { result: '1B', notation: c };              // hit a jardín: H7/H8/H9
  if (/^[1-9]?E?[1-9]$/.test(c.replace('E', '')) && c.startsWith('E')) return { result: 'E', notation: c }; // E5
  if (/^[1-9]-[1-9]-[1-9]$/.test(c)) return { result: 'DP', notation: c };   // 6-4-3
  if (/^[1-9]-[1-9]$/.test(c)) return { result: 'GO', notation: c };         // 4-3, 6-3
  if (/^U?[1-9]$/.test(c) || /^[FL][1-9]$/.test(c)) return { result: 'FO', notation: c }; // F8, L6
  if (/^[1-9]$/.test(c)) return { result: 'FO', notation: c };               // fly directo "8"
  return null;
}

// respaldo sin IA: frases dominicanas frecuentes → código
// ORDEN IMPORTA: la primera que coincida gana — las más específicas primero.
// Secciones: multi-out → turno del bateador → corrido (mid-play) → fildeo/genéricas.
const FALLBACK_PHRASES: [RegExp, { result: string; notation?: string }, string][] = [
  /* ---- multi-out ---- */
  [/triple ?play|tripleplay|triple ?plei|triple matanza|\btp\b/i, { result: 'TP' }, 'triple play'],
  [/dobl?e ?pl?a?y|doble ?plei|double ?play|dos por uno|6-4-3|cuatro seis tres|doble matanza|\bmatanza\b|\bdp\b/i, { result: 'DP', notation: '6-4-3' }, 'doble play'],
  /* ---- ponche y pasaportes ---- */
  // tercer strike suelto: K + wild pitch o K + pasbola (el bateador corre a 1ra)
  [/ponche\w*.{0,30}(pasbola|pasbol|se le (fue|escap[óo])( la bola)? al (receptor|catcher|mascota)|dej[óo] caer)|tercer strike.{0,25}(pas[óo]|suelto|malo|se le fue|escap[óo])/i, { result: 'KPB' }, 'ponche + pasbola'],
  [/ponche\w*.{0,30}(wild|descontrol|pitcheo malo|lanzamiento malo|bola loca)|tercer strike.{0,25}wild/i, { result: 'KWP' }, 'ponche + wild pitch'],
  [/foul tip|toque.{0,15}foul|foul.{0,15}toque/i, { result: 'K' }, 'foul tip al tercer strike'],
  [/ponche|chocolate|tir[áa]ndole|cantaron|cant[óo] el|abanic[óo]|se lo comi[óo]|puls[oó]|pulso|mirando|tres strikes|strike tres|lo sent[óo]|lo domin[óo] tirando|se fue en blanco|lo dej[óo] mirando/i, { result: 'K' }, 'ponche'],
  [/base intencional|boleto intencional|pasaporte intencional|base autom[aá]tica|pasaporte autom[aá]tico|la pasaron|lo pasaron|le dieron (la )?base intencional/i, { result: 'IBB' }, 'base intencional'],
  [/indiferencia|defensive indifference|le regalaron la base|le regal[oó] la base|nadie le tir|la dejaron tomar/i, { result: 'DI' }, 'indiferencia defensiva'],
  [/base por bola|boleto|pasaporte|cuatro malas|cuatro bolas|(?<!el |la |un |del |su |mismo )camin[oó]|lo caminaron|le caminaron|le di[oó] la base|le regal[oó] la primera|free pass|regal[óo] de base/i, { result: 'BB' }, 'base por bolas'],
  [/pelota[sz]a?o|bola[sz]a?o|golpead|hit by pitch|lo tocaron|lo golpe[oó]|lo golpearon|le peg[oó] (la|una|el)? ?bola|le dio (un )?pelota[sz]a?o|pelota[sz]a?o en/i, { result: 'HBP' }, 'pelotazo (HBP)'],
  /* ---- extra bases ---- */
  // hit + error va ANTES que el hit pelado ("sencillo y error del right" → 1BE)
  [/triple.{0,20}error/i, { result: '3BE' }, 'triple con error'],
  [/doble.{0,20}error|doblete.{0,20}error|hit de dos.{0,15}error/i, { result: '2BE' }, 'doble con error'],
  [/sencillo.{0,20}error|hit.{0,20}error|j[ií]t.{0,20}error|imparable.{0,20}error/i, { result: '1BE' }, 'sencillo con error'],
  [/bate[óo] fuera de turno|bateador fuera de turno|turno robado|bateador equivocado|bate[óo] por otro/i, { result: 'OOT' }, 'bateó fuera de turno'],
  [/dentro del parque|inside the park|corri[óo] las cuatro bases|se dio la vuelta completa|cuadrangular dentro/i, { result: 'HRIP' }, 'jonrón dentro del parque'],
  [/jonr[óo]n|cuadrangular|se fue(?! ?(antes|temprano|para|corriendo|de la base|a segunda|a tercera))|bot[óo] la bola|homerun|home run|tabla[sz]o|desapareci[óo]|la sac[oó] del|cuatro esquinas|chinela|se la vol[oó]|por el muro|la mand[oó] pa fuera|grand slam|bases llenas|casa llena/i, { result: 'HR' }, 'jonrón'],
  [/triple(?! ?play)|tres bases|tres almohadillas/i, { result: '3B' }, 'triple'],
  [/doble(?! ?play| ?matanza| ?robo)|doblete|dos bases|dos almohadillas|tubey|doble por regla|ground rule|bot[óo] y sali[óo]|bot[óo] pa fuera|se meti[óo] debajo|salt[óo] la verja|por debajo de la verja|doble de regla|rebote por encima/i, { result: '2B' }, 'doble'],
  /* ---- corrido de bases — mid-play (NO terminan el turno del bateador) ---- */
  // OJO: "atrapa" suelto NO es CS — "la atrapa el center" es un elevado atrapado.
  // CS exige atrapado/atrapó (pasado) o contexto de robo/corrido.
  [/caught stealing|atrapad\w*|lo atrap[óo]|lo atraparon|lo pescaron|lo esperaron|pillor|pillado|lo cogieron|out robando|retirad\w* robando|retirado en el robo|no pudo robar|lo pararon|lo quemaron|fuzil|lo mataron|fuera robando|no lleg[oó]|lo fusilaron|intento de robo|rundown|entre (las |dos )?bases|en el corrido|en la calle|lo agarraron entre|fuera de (la )?l[íi]nea|se sali[óo] de la l[íi]nea|abandon[óo] (la|su) base|fuera de la raya/i, { result: 'CS' }, 'atrapado robando'],
  [/pick ?off|sorprend|enganchad|dormido en la base|lo agarraron|revire|tir[oó] atr[áa]s|pill[oó] fuera|lo pillaron|descuidado en la base/i, { result: 'PK' }, 'pickoff'],
  [/lanzamiento ilegal|illegal pitch|pitcheo ilegal|pitch ilegal|lanzamiento prohibido/i, { result: 'IPL' }, 'lanzamiento ilegal'],
  [/sale temprano|sali[óo] temprano|anticipado|se fue antes|arranc[óo] temprano|se adelant[óo]|salieron antes|left early|dej[óo] la base antes/i, { result: 'LE' }, 'sale temprano'],
  [/avanza? por (un )?error|avance por (un )?error|por (el|un) error del|error en el tiro|tiro malo|la tiraron mal|tir[oó] mal|levant[óo] el tiro|pas[óo] el tiro|tiro desviado|tir[oó] para cualquier lado/i, { result: 'ADJ' }, 'avance por error'],
  [/robo|rob[óo]|se estaf[óo]|estaf[oó]|estafa|se la rob[óo]|lleg[óo] callao|stolen|se meti[óo]|vino robando|robadita|arranc[óo] (para|pa'?l?)|corri[óo] (para|pa'?l?)|le peg[óo] el robo|se fue para|se lanz[óo] (para|pa'?l?)|doble robo|se robaron|robaron dos/i, { result: 'SB' }, 'robo'],
  [/wild|descontrol|bola loca|pitcheo malo|se le fue al pitcher|se le escap[óo] al pitcher|env[ií]o malo|env[ií]o descontrolado|pitch descontrolado|bola salvaje|pic[óo] el lanzamiento/i, { result: 'WP' }, 'wild pitch'],
  [/pasbola|pasbol|passed ball|se le fue al receptor|se le escap[óo] al (catcher|receptor|mascota)|pas[óo] entre las piernas|se le fue la bola|no la aguant[óo]|bola pasada|la dej[óo] pasar|dej[óo] pasar la bola/i, { result: 'PB' }, 'pasbola'],
  [/balk|balc|desm[áa]n|movimiento ilegal|enga[ñn][óo] al corredor|se vir[oó] el pitcher|se vir[oó] en la loma/i, { result: 'BK' }, 'balk'],
  /* ---- sacrificios, selección, reglas especiales ---- */
  [/elevado de sacrificio|fly de sacrificio|sacrifice fly|sacro de fly|sacro fly|sacrificio de fly|fly de sacro|elevado productor|fly productor/i, { result: 'SF' }, 'fly de sacrificio'],
  [/sacrificio|toque|toquito|toc[óo] la bola|deposit[óo]|de posit|jug[óo] al toque|toquecito|tocadita|muertito|squeeze|toque suicida|suicida|arrastr[óe]|arrastre|toc[óo] por|por la banda/i, { result: 'SAC' }, 'toque de sacrificio'],
  [/selecci[óo]n|choice|decidi[óo]|forzad|force|eligieron|fueron por el corredor|prioriz[oó] el corredor|jugaron al plato/i, { result: 'FC' }, 'jugada de selección'],
  [/infield fly|regla infield|fly corto|in fil flai/i, { result: 'IF' }, 'infield fly'],
  [/interferencia del catcher|catcher interfer|obstrucci[óo]n del (catcher|receptor|mascota)/i, { result: 'CI' }, 'interferencia del catcher'],
  [/obstrucci[óo]n|obstruy[óo]|le tap[óo] la base|le cerr[óo] el camino/i, { result: 'OBS' }, 'obstrucción'],
  [/interferencia (del? |de un )?fan[aá]tico|fan[aá]tico.{0,20}(toc[óo]|agarr[óo]|interfiri)|un fan[aá]tico la (toc[óo]|agarr[óo])/i, { result: 'FI' }, 'interferencia de fanático'],
  [/interferencia|interfiri[óo]/i, { result: 'INT' }, 'interferencia'],
  [/error en foul|error de foul/i, { result: 'EF' }, 'error en foul'],
  /* ---- error, contacto y outs genéricos ---- */
  [/error|bot[óo]|se le cay[óo]|pelli[sz]c|le rebot[óo]|la perdió|la pate[oó]|muff|entre las piernas|la dej[óo] caer|se le sali[óo]|bambalazo|lindon|metida de manos?/i, { result: 'E' }, 'error'],
  [/l[íi]nea|li[ñn]a|line drive|l[íi]nea[sz]o|li[ñn]a[sz]o|flechazo|ca[ñn]onazo|ca[ñn][óo]n|una flecha/i, { result: 'LO' }, 'línea'],
  [/de foul|en foul|foul/i, { result: 'FO' }, 'out de foul'],
  [/fly|flai|elevado|alto|la cogió de aire|de aire|palo(?!zo)|capit|palomita|volandera|lo caz[óo]|la caz[óo]|en los aires|la atrapa|lo atrapa|la agarr[óo]|lo agarr[óo]|se la qued[óo]/i, { result: 'FO' }, 'elevado'],
  [/poblado|\bpop\b|pup[úu]|pepita|chocolatito/i, { result: 'PO' }, 'poblado'],
  [/hit|sencillo|imparable|bata[sz]o|single|tubey sencillo|j[ií]t|se embasó limpio|jit limpio|bata[sz]o limpio|la sac[óo] del cuadro|conect[óo] (un )?(jit|hit|sencillo|imparable)|le dio jit|rollazo|hit limpio/i, { result: '1B' }, 'sencillo'],
  [/rolling|roling|rol[íi]n|rodado|ground|r[óo]ling|roletazo|rodadito|roledito|chop|chopito|pico|piquito/i, { result: 'GO' }, 'rolling'],
  [/agarra|fildea|recoge|guante|filde[oó]|jugada de rutina/i, { result: 'GO' }, 'jugada de fildeo'],
  [/v[íi]a|por la v[íi]a|relev[oó]|relay|en cadena|combinaci[óo]n de|jugada combinada/i, { result: 'GO' }, 'jugada en relevo'],
  [/out en primera|out por primera|quieto en primera|tiro a primera/i, { result: 'GO', notation: '4-3' }, 'out en primera'],
  [/quieto|out|lo dominaron|fuera|lo retiraron|lo sentaron/i, { result: 'GO' }, 'out'],
];

// "por segunda/el right/left/center/el short/primera/tercera" → posición defensiva
const ZONE: [RegExp, string][] = [
  [/segunda|segund/i, '4'], [/short|torpedero|paradas? cortas?|campo ?corto/i, '6'], [/tercera|tercer/i, '5'],
  [/primera|primer/i, '3'], [/left|izquierd/i, '7'], [/center|centro|central/i, '8'], [/right|derech/i, '9'],
  [/pitcher|p[ií]tcher|lanzador|box|lomita|serpentinero/i, '1'], [/catcher|receptor|mascota|home/i, '2'],
];

// secuencia de fildeadores en orden hablado: "seis cuatro tres"→6-4-3,
// "por segunda a primera"→4-3, "la agarra el short y tira a primera"→6-3.
// Tokens: posiciones por nombre, posiciones por palabra (uno..nueve) y dígitos.
const FIELDER_TOKEN = /p[ií]tcher|pitcher|lanzador|lomita|serpentinero|catcher|receptor|mascota|primera|primer|segunda|segundo|tercera|tercer|campo ?corto|campocorto|short|torpedero|left|izquierd\w*|center|centro|central|right|derech\w*|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|[1-9]/gi;
const TOKEN_POS: [RegExp, string][] = [
  [/^p[ií]tcher$|^pitcher$|^lanzador$|^lomita$|^serpentinero$|^uno$|^1$/, '1'],
  [/^catcher$|^receptor$|^mascota$|^dos$|^2$/, '2'],
  [/^primera$|^primer$|^tres$|^3$/, '3'],
  [/^segunda$|^segundo$|^cuatro$|^4$/, '4'],
  [/^tercera$|^tercer$|^cinco$|^5$/, '5'],
  [/^short$|^torpedero$|^campo ?corto$|^campocorto$|^seis$|^6$/, '6'],
  [/^left$|^izquierd\w*$|^siete$|^7$/, '7'],
  [/^center$|^centro$|^central$|^ocho$|^8$/, '8'],
  [/^right$|^derech\w*$|^nueve$|^9$/, '9'],
];
function fieldersOf(t: string): string[] {
  const out: string[] = [];
  for (const m of t.matchAll(FIELDER_TOKEN)) {
    const pos = TOKEN_POS.find(([re]) => re.test(m[0].toLowerCase()))?.[1];
    if (pos) out.push(pos);
  }
  return out;
}

// el guante del error es SOLO el token que sigue a "error del/de/por":
// "por error del 6"→6, "bambalazo del right"→9, "error del catcher"→2.
// Sin él → null: la base destino ("avance A SEGUNDA por error") no es fildeador.
const ERR_WORD = /error|bambalazo|lindon|metida de manos?/i;
function errorFielder(t: string): string | null {
  const m = t.match(/(?:error|bambalazo|lindon|metida de manos?)\w*\s+(?:del?|por|al)\s+(?:el|la|los|un|una)?\s*([a-záéíóúñ]+|\d)/i);
  if (!m) return null;
  return TOKEN_POS.find(([re]) => re.test(m[1].toLowerCase()))?.[1] ?? null;
}

/* -------- jugadores y avances hablados (contexto del juego) -------- */
// normName: minúsculas sin acentos para comparar nombres hablados
const normName = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const BASE_WORD: [RegExp, number | 'HOME'][] = [
  [/primer[ao]|1ra|1a\b|la inicial|primera almohadilla|la primera base/, 1],
  [/segund[ao]|2da|2a\b|la intermedia|segunda almohadilla|la segunda base|almohadilla del medio/, 2],
  [/tercer[ao]|3ra|3a\b|la antesala|esquina caliente|tercera almohadilla|la tercera base/, 3],
  [/home|plato|goma|registradora|el pentágono|el pentagono|el home|la registradora/, 'HOME'],
];
const OUT_WORD = /out|retirad|quieto|dominad|fuera|lo sacaron|lo pusieron|pescaron|cogieron|quemaron|fuzilaron|agarraron|lo pararon|atrapad/i;
const SCORE_WORD = /anot[óao]|pis[óo]|entr[óo] en carrera|viene pa'?l plato|lleg[óo] a la goma|empuj[óo]|remolc[óo]|entr[óo] a la goma|pas[óo] por el plato|pisa el home|flete[óo]|embols[óo]|trajo (la|una) carrera|a la registradora/i;
// "avanza", "corre", "se fue" sin nombrar la base → la siguiente
const ADV_VERB = /avanz|avanza|sigue|corre|se fue|se meti|llega|lleg[oó]|gan[oó]|se mueve|corri[óo]|sigui[óo]|se lanz[óo]|se embarc[óo]|se adelant[óo]|trep[óo]/i;

interface PlayerMention { playerId: string; label: string; index: number; nameText: string; ambig?: boolean }
interface GameCtx {
  batterId: string | null;
  bases: Record<number, string | null>;
  players: Map<string, { firstName: string; lastName: string }>;
  fieldTeamId: string | null;
  // roster COMPLETO del equipo que defiende (incluye banca) — para resolver
  // nombres de lanzadores que no están en el lineup ("cambio lanzador pepito")
  roster: Map<string, { firstName: string; lastName: string }>;
  // roster completo del equipo AL BATE — "bateador emergente fulano" resuelve
  // tanto al que entra (banca) como al que sale (lineup)
  batRoster: Map<string, { firstName: string; lastName: string }>;
  currentPitcherId: string | null;
}

// encuentra menciones de jugadores del lineup (apellido o nombre+apellido)
function findMentions(t: string, ctx: GameCtx): PlayerMention[] {
  const nt = ' ' + normName(t) + ' ';
  const out: PlayerMention[] = [];
  // nombre de pila solo matchea si es único en el lineup ("alexis" duplicado → no)
  const firstCount = new Map<string, number>();
  for (const [, p] of ctx.players) {
    const f = normName(p.firstName).split(' ')[0];
    firstCount.set(f, (firstCount.get(f) ?? 0) + 1);
  }
  for (const [pid, p] of ctx.players) {
    const last = normName(p.lastName).split(' ')[0];
    const lastFull = normName(p.lastName);              // apellido compuesto ("núñez vargas")
    const first = normName(p.firstName).split(' ')[0];
    const full = `${first} ${last}`;
    const fullLong = `${first} ${lastFull}`;            // nombre + apellido compuesto
    const cands = (firstCount.get(first) ?? 0) === 1
      ? [fullLong, full, lastFull, last, first]
      : [fullLong, full, lastFull, last];
    // nombre completo primero (índice más preciso), luego apellido, luego nombre único
    for (const cand of cands) {
      if (!cand || cand.length < 3) continue;
      const idx = nt.indexOf(' ' + cand);
      // borde de palabra: "juan" no matchea "juanita"
      if (idx >= 0 && !/[a-zñ]/.test(nt[idx + 1 + cand.length] ?? ' ')) {
        out.push({ playerId: pid, label: `${p.firstName} ${p.lastName}`, index: idx, nameText: cand }); break;
      }
      // apellido puede venir con palabra extra ("pinales a tercera")
      const idx2 = nt.indexOf(cand);
      if (idx2 >= 0 && last === cand) { out.push({ playerId: pid, label: `${p.firstName} ${p.lastName}`, index: idx2, nameText: cand }); break; }
    }
  }
  // dedup por jugador, en orden de aparición en el texto;
  // a igual posición gana el texto MÁS LARGO ("núñez vargas" > "núñez" de otro jugador)
  const seen = new Set<string>();
  const sorted = out
    .filter((m) => (seen.has(m.playerId) ? false : (seen.add(m.playerId), true)))
    .sort((a, b) => a.index - b.index || b.nameText.length - a.nameText.length);
  // apellidos compartidos: si la mención corta cae DENTRO del nombre completo de otro,
  // gana el nombre completo ("alexis flores" no genera mención aparte para "juan flores").
  // si el apellido solo es ambiguo (varios jugadores, mismo texto), queda el 1º y se marca.
  const lastCount = new Map<string, number>();
  for (const [, p] of ctx.players) {
    const l = normName(p.lastName).split(' ')[0];
    lastCount.set(l, (lastCount.get(l) ?? 0) + 1);
  }
  const kept: PlayerMention[] = [];
  for (const m of sorted) {
    const inside = kept.find((k) => m.index >= k.index && m.index < k.index + k.nameText.length + 1);
    if (inside) continue;
    const dup = kept.find((k) => k.index === m.index && k.nameText === m.nameText);
    if (dup) { dup.ambig = true; continue; }
    if ((lastCount.get(m.nameText) ?? 0) > 1) m.ambig = true; // apellido solo compartido
    kept.push(m);
  }
  return kept;
}

// "cambio lanzador", "viene a lanzar pérez", "sacan al pitcher", "relevista",
// "reingresa el lanzador", "vuelve al box" → cambio/reingreso de lanzador
const PITCHER_CHANGE_RE = /cambio|cambian|nuevo|entra|viene|sale|sacan|levantan|relev|traen?|llama|manda|meten?|abren?|sube|ponen/i;
const PITCHER_WORD_RE = /lanzador|pitcher|p[ií]tcher|serpentinero|lomita|box|pitcheo|lanza|mont[ií]culo|abridor|relevista|lanzante|el que lanza|quien est[aá] lanzando/i;
const REENTRY_RE = /reingres|reingreso|vuelve|regresa|de nuevo a lanzar|otra vez a lanzar/i;

// sustituciones de posición/corrido — argot dominicano:
// "bateador emergente X", "emergente por mendoza", "pinch hitter", "entra a batear X",
// "corredor emergente X", "entra a correr X", "pinch runner X"
const CR_CMD_RE = /corredor emergente|pinch ?run|entra a correr|viene a correr|a correr por|corredor por/i;
const SUB_CMD_RE = /bateador emergente|bateador sustituto|bateador de reemplazo|emergente (?:por|en|al bate|a batear)|sustituto (?:por|en|al bate)|\bpinch ?hitter|cambio de bateador|entra a batear|viene a batear|manda a batear|mete a batear|quita al bateador|saca al bateador/i;

interface SubCmd { action: 'SUB' | 'CR'; playerId: string | null; playerName: string | null; ambig?: boolean }
function parseSubCmd(t: string, ctx: GameCtx): SubCmd | null {
  const nt = normName(t);
  const action: 'SUB' | 'CR' | null = CR_CMD_RE.test(nt) ? 'CR' : SUB_CMD_RE.test(nt) ? 'SUB' : null;
  if (!action) return null;
  // nombres contra el roster del equipo al bate (el que entra es de la banca)
  const nameCtx: GameCtx = { ...ctx, players: ctx.batRoster.size ? ctx.batRoster : ctx.players };
  const m = findMentions(t, nameCtx)[0];
  return { action, playerId: m?.playerId ?? null, playerName: m?.label ?? null, ambig: m?.ambig ?? false };
}

interface PitcherCmd { action: 'PC' | 'RL'; pitcherId: string | null; pitcherName: string | null; ambig?: boolean }
function parsePitcherCmd(t: string, ctx: GameCtx): PitcherCmd | null {
  const nt = normName(t);
  const isReentry = REENTRY_RE.test(nt);
  const isChange = PITCHER_CHANGE_RE.test(nt) && PITCHER_WORD_RE.test(nt);
  if (!isChange && !isReentry) return null;
  // "el pitcher tira a primera" es jugada, no cambio — exige verbo de cambio real
  if (!isReentry && !isChange) return null;

  // resolver el nombre del nuevo lanzador contra el roster defensor (lineup + banca)
  const nameCtx: GameCtx = { ...ctx, players: ctx.roster.size ? ctx.roster : ctx.players };
  const mentions = findMentions(t, nameCtx).filter((m) => m.playerId !== ctx.currentPitcherId);
  const m = mentions[0];
  return {
    action: isReentry ? 'RL' : 'PC',
    pitcherId: m?.playerId ?? null,
    pitcherName: m?.label ?? null,
    ambig: m?.ambig ?? false,
  };
}

// "<nombre> a tercera" / "corredor de segunda anota" / "el de primera avanza" / "X out"
function parseAdvances(t: string, ctx: GameCtx, mentions: PlayerMention[]): { playerId: string; to: number | 'HOME' | 'OUT'; via: string }[] {
  const adv: { playerId: string; to: number | 'HOME' | 'OUT'; via: string }[] = [];
  const nt = normName(t);

  const baseOf = (frag: string): number | 'HOME' | 'OUT' | null => {
    if (OUT_WORD.test(frag)) return 'OUT';
    if (SCORE_WORD.test(frag)) return 'HOME';
    for (const [re, b] of BASE_WORD) if (re.test(frag)) return b;
    return null;
  };
  // "avanza por wild pitch" sin decir la base → la que sigue (o anota si está en 3ª)
  const nextOf = (pid: string): number | 'HOME' | null => {
    for (const b of [1, 2, 3] as const) if (ctx.bases[b] === pid) return b === 3 ? 'HOME' : b + 1;
    return null;
  };

  // menciones con nombre: lo que sigue al nombre manda
  for (let i = 0; i < mentions.length; i++) {
    const m = mentions[i];
    const rest = nt.slice(m.index);
    const next = mentions[i + 1]?.index ?? rest.length;
    const frag = rest.slice(0, next);
    // "a tercera" | "anota" | "avanza a segunda" | "out" | "retirado" | "avanza"
    const to = baseOf(frag) ?? (ADV_VERB.test(frag) ? nextOf(m.playerId) : null);
    if (to != null) adv.push({ playerId: m.playerId, to, via: m.label });
  }

  // corredor sin nombre: "el corredor de segunda anota" / "el de tercera out" /
  // "en primera corre a tercera" / "avance en segunda robo de tercera" —
  // el fragmento siguiente debe traer verbo o base destino, si no se descarta
  for (const m of nt.matchAll(/(?:corredor(?:es)? (?:de|en|que est[aá](?:ba)? en)|el corredor en|el de|el que est[aá](?:ba)? en|(?:el |un )?hombre (?:de|en|que est[aá](?:ba)? en)|ocupando|avance (?:en|de)|en|de) (primera|segunda|tercera|primero|segundo|tercero|la inicial|la intermedia|la antesala)/g)) {
    const w = m[1].replace('primero', 'primera').replace('segundo', 'segunda').replace('tercero', 'tercera');
    const b = BASE_WORD.find(([re]) => re.test(w))?.[1];
    if (typeof b !== 'number') continue;
    const pid = ctx.bases[b];
    if (!pid || adv.some((a) => a.playerId === pid)) continue;
    const frag = nt.slice(m.index! + m[0].length, m.index! + m[0].length + 60);
    const to = baseOf(frag) ?? (ADV_VERB.test(frag) ? (b === 3 ? 'HOME' : b + 1) : null);
    if (to == null) continue;
    // "por error del 2" / "por error" / "por bambalazo del 6" → la vía explica la causa
    const ePos = frag.match(/(?:error|bambalazo|lindon|metida de manos?)\w* (?:del?|de la?) ([1-9]|pitcher|receptor|c[aá]tcher|primera|segunda|short|torpedero|campo ?corto|tercera|izquierdo|left|central|center|derecho|right)/i);
    const errVia = frag.match(/por error|por bambalazo|por lindon|por (?:una )?metida de manos?/i);
    let via = `corredor de ${b}`;
    if (ePos) via = `error del ${ePos[1]}`;
    else if (errVia) via = 'por error';
    adv.push({ playerId: pid, to, via });
  }

  return adv;
}

// quita del texto lo que NO es la jugada (nombres de jugadores, "corredor de segunda",
// "a tercera" del avance hablado) para que no contamine la secuencia de fildeadores.
// OJO: se quedan verbos de resultado (out/anota/ponche...) — esos sí describen la jugada.
const CORREDOR_RE = /corredor(?:es)? (?:de|en|que est[aá](?:ba)? en) (primera|segunda|tercera|primero|segundo|tercero)|el corredor en (primera|segunda|tercera)|el de (primera|segunda|tercera)|el que est[aá](?:ba)? en (primera|segunda|tercera)|(?:el |un )?hombre (?:de|en|que est[aá](?:ba)? en) (primera|segunda|tercera|primero|segundo|tercero|la inicial|la intermedia|la antesala)|ocupando (primera|segunda|tercera)/g;
const A_BASE_RE = /a(?:l)? (?:la )?(primera|segunda|tercera|inicial|intermedia|antesala|plato|goma|home|registradora|pent[aá]gono)/g;
// "en/de <base>" también es referencia de corredor, no fildeador — se quita del
// texto de jugada cuando ya se parsearon avances ("en primera a segunda por
// error del 2" → el error es del 2, no del 3)
const EN_BASE_RE = /\b(?:en|de) (?:la )?(primera|segunda|tercera|inicial|intermedia|antesala)/g;
function playTextOf(transcript: string, mentions: PlayerMention[], hasAdvances: boolean): string {
  let s = normName(transcript);
  for (const m of mentions) {
    const esc = m.nameText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp('\\b' + esc, 'g'), ' ');
  }
  s = s.replace(CORREDOR_RE, ' ');
  // "avanza a tercera" siempre es un avance hablado, nunca la zona del batazo —
  // se quita siempre para que no se lea como fildeador (H5 fantasma)
  s = s.replace(/avanz\w*\s+(?:a|al|hasta|para|pa'?l?)\s+(?:la\s+)?(?:primera|segunda|tercera|inicial|intermedia|antesala|home|plato|goma|registradora|pent[aá]gono)/gi, ' avanza ');
  if (hasAdvances) s = s.replace(A_BASE_RE, ' ').replace(EN_BASE_RE, ' ');
  return s;
}

// explica la notación numérica en dominicano simple (cuando no hay IA que la redacte)
const POS_NAME: Record<string, string> = {
  '1': 'el pitcher', '2': 'el catcher', '3': 'primera', '4': 'segunda', '5': 'tercera',
  '6': 'el short', '7': 'el left', '8': 'el center', '9': 'el right',
};
const RESULT_DESC: Record<string, string> = {
  GO: 'Roletazo', DP: 'Doble play', TP: 'Triple play', FO: 'Elevado', LO: 'Línea',
  K: 'Ponche', KWP: 'Ponche con tercer strike suelto', KPB: 'Ponche con pasbola',
  CS: 'Atrapado robando', E: 'Error', FC: 'Jugada de selección', SAC: 'Toque de sacrificio',
  SF: 'Fly de sacrificio', '1B': 'Sencillo', '2B': 'Doble', '3B': 'Triple', HR: 'Jonrón',
  BB: 'Base por bolas', IBB: 'Base intencional', HBP: 'Pelotazo', SB: 'Robo de base',
  PK: 'Pickoff', DI: 'Indiferencia defensiva', IPL: 'Lanzamiento ilegal', LE: 'Sale temprano',
  OBS: 'Obstrucción', INT: 'Interferencia', ADJ: 'Avance por error',
  WP: 'Wild pitch', PB: 'Pasbola', BK: 'Balk', IF: 'Infield fly', PO: 'Out de foul',
};
function explainNotation(result: string, notation: string | null | undefined): string {
  const head = RESULT_DESC[result] ?? result;
  if (!notation) return head;
  // marcador de hit H1-4/H7-9 — la H no es guante; "H4-7" lleva dirección
  const hm = notation.match(/^H[1-9](?:-([1-9]))?$/);
  if (hm) return hm[1] ? `${head} por ${POS_NAME[hm[1]]} (${notation})` : `${head} (${notation})`;
  const seq = notation.replace(/^[A-Z]+/, '').split('-').filter((s) => POS_NAME[s]);
  if (!seq.length) {
    // notación tipo F8/L6/H9: la posición va pegada a la letra
    const z = notation.match(/^[A-Z]([1-9])/)?.[1];
    return z ? `${head} por ${POS_NAME[z]}` : `${head} (${notation})`;
  }
  const DEST_NAME: Record<string, string> = {
    '1': 'al pitcher', '2': 'al catcher', '3': 'a primera', '4': 'a segunda', '5': 'a tercera',
    '6': 'al short', '7': 'al left', '8': 'al center', '9': 'al right',
  };
  const [a, ...rest] = seq;
  // en CS/K suelto el primer guante es quien TIRA (catcher → short/primera)
  if (['CS', 'KWP', 'KPB'].includes(result) && rest.length) {
    return `${head}; ${POS_NAME[a]} tira ${rest.map((p) => DEST_NAME[p]).join(' y ')} (${notation})`;
  }
  const trail = rest.length ? `; tira ${rest.map((p) => DEST_NAME[p]).join(' y ')}` : '';
  return `${head} por ${POS_NAME[a]}${trail} (${notation})`;
}

function fallbackTranscribe(t: string) {
  for (const [re, code, desc] of FALLBACK_PHRASES) {
    if (!re.test(t)) continue;
    const zone = ZONE.find(([z]) => z.test(t))?.[1];
    const out = { ...code };
    let d = desc;
    // "batazo a tercera, el short tira a primera" — el "batazo" con secuencia de
    // fildeadores + out es roletazo (GO), no hit: la intención manda sobre la palabra
    if (out.result === '1B' && /out|quieto|domin|retir|fuera|a primera|tir[aóo]|v[íi]a/i.test(t)) {
      const fs = fieldersOf(t);
      if (fs.length >= 2) { out.result = 'GO'; out.notation = undefined; d = 'jugada de fildeo'; }
    }
    // palabra de HIT + trayectoria = hit con traj, NO out: "sencillo línea al
    // cinco"→1B L5 (no LO), "doble rola al short"→2B G6, "sencillo elevado al
    // ocho"→1B F8. Solo si no hay intención de out ("hit y quieto" sigue out;
    // "hit robado — la cazó" también: la atrapa es la intención de out).
    // DP/TP NO entran aquí: "doble play"/"triple play" son JUGADA, no hit —
    // la palabra "doble/triple" dentro de la frase de play no lo vuelve 2B/3B.
    const isHitSaid = /\b(?:hits?|j[ií]t|sencillo|imparable|doble|triple|jonr[oó]n|cuadrangular|home ?run|homerun|tubey|batazo)\b/i.test(t);
    const outIntent = /out|quieto|domin|retir|fuera|atrapad|pescad|la caz[óo]|lo caz[óo]|se la qued|fuzil/i.test(t);
    if (isHitSaid && !outIntent && ['GO', 'FO', 'LO', 'PO'].includes(out.result)) {
      out.result = /jonr[oó]n|cuadrangular|home ?run|homerun|vuelacerca|se fue/i.test(t) ? 'HR'
        : /triple/i.test(t) ? '3B' : /doble|tubey|dos bases/i.test(t) ? '2B' : '1B';
      out.notation = undefined;
      d = 'hit con trayectoria';
    }
    if (['GO', 'DP', 'TP'].includes(out.result)) {
      // secuencia completa si nombró fildeadores ("seis cuatro tres", "segunda a primera")
      const fs = fieldersOf(t);
      if (fs.length >= 2) out.notation = fs.join('-');
      else if (fs.length === 1 && !out.notation) out.notation = `${fs[0]}-3`;
      else if (!out.notation) out.notation = out.result === 'DP' ? '6-4-3' : out.result === 'TP' ? '5-4-3' : undefined;
    } else if (['FO', 'LO', 'PO', 'E', '1B', '2B', '3B', 'HR', 'SF'].includes(out.result)) {
      // zona: palabra-número ("al ocho"→8) vale lo mismo que el nombre del jardín;
      // en el error el guante es el de "error del N" — si dijo "por error" sin
      // nombrar fildeador no se inventa uno (la base destino no es guante)
      const z = out.result === 'E'
        ? (ERR_WORD.test(t) ? errorFielder(t) : (fieldersOf(t)[0] ?? zone))
        : (fieldersOf(t)[0] ?? zone);
      // trayectoria hablada en el hit: "rodado al 7"→G7, "línea al 5"→L5,
      // "elevado al 8"→F8; sin trayectoria queda la zona del hit (H7)
      const hitTraj = ['1B', '2B', '3B', 'HR'].includes(out.result)
        ? (/rol|rod|ground|chop|pic|roletazo|roledito|piso|tierra|por el suelo/i.test(t) ? 'G'
          : /l[ií]nea|flecha|flechazo|cañonazo|trazo|lineazo|lindorazo|escopetazo|rifle/i.test(t) ? 'L'
          : /elevad|fly|flai|alto|de aire|paloma|palomazo|palomita|pompia|volandera|aires|al cielo|al espacio/i.test(t) ? 'F' : null)
        : null;
      if (z) out.notation = out.result === 'E' ? `E${z}`
        : out.result === 'FO' || out.result === 'SF' ? `F${z}`
        : out.result === 'LO' ? `L${z}`
        : out.result === 'PO' ? `P${z}`
        // hit: trayectoria dicha → G7/L7/F8; sin trayectoria → la zona pelada
        // ("hit al 7" → 7). H# queda como vocabulario de ENTRADA ("ache cuatro")
        : hitTraj ? `${hitTraj}${z}` : z;
    } else if (out.result === 'ADJ') {
      // "avance por error del 2/catcher" → notación E# carga el error al
      // fildeador; sin fildeador dicho NO se inventa (evitaba el E4 fantasma)
      const z = errorFielder(t);
      if (z) out.notation = `E${z}`;
    } else if (['CS', 'PK'].includes(out.result)) {
      // "atrapado dos seis" → CS 2-6 (el primer guante es quien tira)
      const fs = fieldersOf(t);
      if (fs.length >= 2) out.notation = fs.join('-');
    }
    return { ...out, desc: d };
  }
  return null;
}

r.post('/ai/notation', async (req, res) => {
  const { transcript, gameId } = req.body as { transcript?: string; gameId?: string };
  if (!transcript?.trim()) return res.status(400).json({ error: 'transcript requerido' });

  // contexto del juego (opcional): jugadores del lineup, corredores, bateador actual
  let ctx: GameCtx | null = null;
  if (gameId) {
    const game = await prisma.game.findUnique({ where: { id: gameId } });
    if (game) {
      const entries = await prisma.lineupEntry.findMany({
        where: { gameId }, include: { player: true },
      });
      const events = await loadEvents(gameId);
      const st = reduceGame(events, game.innings);
      const batTid = st.half === 'TOP' ? game.awayTeamId : game.homeTeamId;
      const fldTid = st.half === 'TOP' ? game.homeTeamId : game.awayTeamId;
      // roster completo del equipo defensor (banca incluida) → nombres de lanzadores
      const fldTeam = await prisma.team.findUnique({ where: { id: fldTid }, include: { players: true } });
      const roster = new Map<string, { firstName: string; lastName: string }>();
      for (const p of fldTeam?.players ?? []) roster.set(p.id, { firstName: p.firstName, lastName: p.lastName });
      for (const e of entries) if (e.teamId === fldTid) roster.set(e.playerId, { firstName: e.player.firstName, lastName: e.player.lastName });
      // roster del equipo al bate (banca incluida) — bateador/corredor emergente
      const batTeam = await prisma.team.findUnique({ where: { id: batTid }, include: { players: true } });
      const batRoster = new Map<string, { firstName: string; lastName: string }>();
      for (const p of batTeam?.players ?? []) batRoster.set(p.id, { firstName: p.firstName, lastName: p.lastName });
      for (const e of entries) if (e.teamId === batTid) batRoster.set(e.playerId, { firstName: e.player.firstName, lastName: e.player.lastName });
      // pitcher actual: último evento que lo nombra en esta mitad, o el P del lineup defensor
      const fieldHalf = st.half;
      const lastP = [...events].reverse().find((e) => e.half === fieldHalf && e.pitcherId)?.pitcherId
        ?? entries.find((e) => e.teamId === fldTid && e.position === 'P' && e.active)?.playerId ?? null;
      ctx = {
        batterId: null,
        bases: { 1: st.bases[1], 2: st.bases[2], 3: st.bases[3] },
        players: new Map(entries.map((e) => [e.playerId, { firstName: e.player.firstName, lastName: e.player.lastName }])),
        fieldTeamId: fldTid,
        roster,
        batRoster,
        currentPitcherId: lastP,
      };
      // bateador actual: el turno que sigue en el orden activo de la mitad en curso
      const ord = entries.filter((e) => e.teamId === batTid && e.active && e.batsInOrder !== false).sort((a, b) => a.order - b.order);
      const bi = st.half === 'TOP' ? st.awayBatterIndex : st.homeBatterIndex;
      if (ord.length) ctx.batterId = ord[bi % ord.length].playerId;
    }
  }

  // comando de lanzador: "cambio lanzador pérez" / "reingresa el que abrió"
  if (ctx) {
    const cmd = parsePitcherCmd(transcript, ctx);
    if (cmd) {
      return res.json({
        ok: true, source: 'local', transcript,
        action: cmd.action, pitcherId: cmd.pitcherId, pitcherName: cmd.pitcherName,
        note: cmd.ambig ? `«${cmd.pitcherName}» — apellido compartido, verifica`
          : cmd.pitcherId ? '' : 'No reconocí el nombre del lanzador — elígelo',
        ai: { play_code: cmd.action, runs_scored: 0, outs_made: null, description_spanish: cmd.pitcherName ? `${cmd.action === 'RL' ? 'Reingresa' : 'Entra a lanzar'} ${cmd.pitcherName}` : 'Cambio de lanzador' },
      });
    }
    // sustitución de bateador/corredor: "bateador emergente X", "corredor
    // emergente por mendoza", "entra a batear fulano", "pinch runner X"
    const sub = parseSubCmd(transcript, ctx);
    if (sub) {
      return res.json({
        ok: true, source: 'local', transcript,
        action: sub.action, playerId: sub.playerId, playerName: sub.playerName,
        note: sub.ambig ? `«${sub.playerName}» — apellido compartido, verifica`
          : sub.playerName ? '' : 'Elige quién entra y quién sale',
        ai: { play_code: sub.action, runs_scored: 0, outs_made: null, description_spanish: `${sub.action === 'CR' ? 'Corredor emergente' : 'Bateador emergente'}${sub.playerName ? `: ${sub.playerName}` : ''}` },
      });
    }
  }

  // jugadores y avances hablados — se parsean ANTES de interpretar la jugada para
  // limpiar el texto ("virgilio pinales a tercera" no debe colarse como fildeador 5)
  const mentions = ctx ? findMentions(transcript, ctx) : [];
  const advances = ctx ? parseAdvances(transcript, ctx, mentions) : [];
  // ── vocabulario del movimiento: AVANZA es la clave que ordena MOVER ──
  const ntSp = normName(transcript);
  const HIT_WORD = /\bhit\b|sencillo|imparable|j[ií]t|tubey|doble|triple|jonr[óo]n|cuadrangular|homerun|home ?run|batazo/i;
  const RUNNER_SUBJ = /corredor|el de|(?:en|de|ocupando) (?:la )?(?:primera|segunda|tercera|inicial|intermedia|antesala)/i;
  const DEST_RE = /(?:avanz\w*|a|al|hasta|para|pa'?l?|corre|llega)\s+(?:la\s+)?(primera|segunda|tercera|inicial|intermedia|antesala|home|plato|goma|registradora|pent[aá]gono)/i;
  const destOf = (s: string) => { const m = s.match(DEST_RE); return m ? (BASE_WORD.find(([re]) => re.test(m[1]) || re.test(`la ${m[1]}`))?.[1] ?? null) : null; };
  // con hit hablado, "avanza a <base>" mueve al BATEADOR — se empuja ANTES de
  // limpiar playText para que la base destino no se lea como zona del batazo
  if (ctx?.batterId && HIT_WORD.test(ntSp) && !RUNNER_SUBJ.test(ntSp)) {
    const db = destOf(ntSp);
    if (db && db !== 1 && !advances.some((a) => a.playerId === ctx.batterId)) {
      advances.push({ playerId: ctx.batterId, to: db as number | 'HOME', via: 'bateador' });
    }
  }
  // "avanza a segunda" sin sujeto ni hit: con un solo corredor en base es él
  // quien se mueve (sin base dicha → la siguiente)
  if (ctx && /avanz|avanza|se mueve|se embarca|trep[oó]/i.test(ntSp) && !HIT_WORD.test(ntSp) && !advances.length) {
    const only = ([1, 2, 3] as const).filter((b) => ctx.bases[b]);
    if (only.length === 1) {
      const db = destOf(ntSp);
      const b = only[0];
      advances.push({ playerId: ctx.bases[b]!, to: (db ?? (b === 3 ? 'HOME' : b + 1)) as number | 'HOME', via: `corredor de ${b}ª` });
    }
  }
  const playText = ctx ? playTextOf(transcript, mentions, advances.length > 0) : transcript;

  const system = `Eres anotador oficial de baseball/softball MLB. Convierte narración dominicana a notación oficial.
${DOMINICAN_GLOSSARY}
Posiciones: 1=P 2=C 3=1B 4=2B 5=3B 6=SS 7=LF 8=CF 9=RF.
Regla A-B-C: la bola va a A, A tira a B, B a C. 4-3-2 = out en 1ra + tiro a home. CS 2-4/2-6 = atrapado robando. K con tercer strike suelto = KWP/KPB + tiro (2-3). SH = toque sacrificio. SF = fly de sacrificio.
Responde SOLO JSON: {"play_code":"4-3"|"K"|"BB"|"H7"|"E5"|"6-4-3"|"HR"|"2B"|"3B"|"FC"|"SF"|"HBP", "runs_scored":0, "outs_made":1, "description_spanish":"..."}.
Ejemplos: "rolling por segunda out en primera"→{"play_code":"4-3"} · "hit por el right"→{"play_code":"H9"} ·
"ponche tirandole"→{"play_code":"K"} · "doble play seis cuatro tres"→{"play_code":"6-4-3"} ·
"elevado al center"→{"play_code":"F8"} · "se fue por el left"→{"play_code":"HR"} ·
"el tercera la botó"→{"play_code":"E5"} · "base por bola"→{"play_code":"BB"} · "tablazo por el centro dos carreras"→{"play_code":"H8","runs_scored":2}`;

  // diccionario local PRIMERO (~0ms): la IA remota solo corre cuando la frase
  // no está cubierta — antes cada jugada esperaba la red aunque fuera local
  const fb = fallbackTranscribe(playText);
  let mapped: { result: string; notation?: string } | null = fb ? { result: fb.result, notation: fb.notation } : null;
  let source = aiEnabled() ? 'fallback' : 'local';
  const ai = mapped ? null : (await aiChat(system, playText)) as { play_code?: string; runs_scored?: number; outs_made?: number; description_spanish?: string } | null;
  if (!mapped && ai?.play_code) { mapped = codeToEngine(ai.play_code); source = 'ai'; }
  // notación hablada pelada: "e dos"→E2, "efe ocho"→F8, "ele siete"→L7,
  // "pe cinco"→P5, "ache nueve"→H9 — la letra puede venir como letra o nombre
  if (!mapped) {
    const NUMW: Record<string, string> = {
      uno: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5',
      seis: '6', siete: '7', ocho: '8', nueve: '9',
    };
    const LNAME: Record<string, string> = { e: 'E', error: 'E', efe: 'F', ele: 'L', pe: 'P', poblado: 'P', ache: 'H', h: 'H', ge: 'G' };
    const nm = playText.trim().match(/^([a-záéíóúñ]+|[1-9])\s+([1-9]|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)$/i);
    const letter = nm ? LNAME[normName(nm[1])] : null;
    if (letter && nm) {
      const num = NUMW[normName(nm[2])] ?? nm[2];
      // H1-4 = tipo de hit (sencillo/doble/triple/jonrón); H5-9 = hit por la zona
      const res = letter === 'E' ? 'E' : letter === 'F' ? 'FO' : letter === 'L' ? 'LO' : letter === 'P' ? 'PO'
        : letter === 'H' ? (num === '4' ? 'HR' : num === '3' ? '3B' : num === '2' ? '2B' : '1B') : 'GO';
      mapped = { result: res, notation: `${letter}${num}` };
      source = 'local';
    }
  }
  // secuencia de dígitos suelta sin palabra de jugada: "4 3"→GO 4-3, "6 4 3"→DP 6-4-3,
  // "4 3 2"→GO 4-3 con intento en home (anotador decide avances), "2 4"/"2 6" con robo→CS
  if (!mapped) {
    const fs = fieldersOf(playText);
    if (fs.length >= 2) {
      const isCS = /\bcs\b|atrapad|out robando|robando|lo pescaron/i.test(playText);
      const isK = /\bk\b|ponche|chocolate|strike/i.test(playText);
      if (isCS) mapped = { result: 'CS', notation: fs.join('-') };
      else if (isK) mapped = { result: 'KWP', notation: fs.join('-') };
      else mapped = fs.length >= 3 ? { result: 'DP', notation: fs.join('-') } : { result: 'GO', notation: fs.join('-') };
      source = 'local';
    }
  }
  // "flores avanza por error del catcher" → error a mitad de turno: ADJ + E#
  // (E solo termina el PA si el BATEADOR se embasa por el error; "avanza"/"anota"
  //  delatan acción de corredor aunque el nombre no haya resuelto)
  if (mapped?.result === 'E' && /avanz|avanza|avance|anota|roba|corre a|se meti/i.test(playText)
    && (advances.length || /corredor|el de|anota/.test(playText))) {
    mapped = { result: 'ADJ', notation: mapped.notation };
  }
  // ── lógica de baseball: con hit hablado la jugada ES el hit. "avanza a
  // <base>" movió al BATEADOR (ya empujado arriba, salvo sujeto corredor
  // explícito) y el error sobre ese avance vuelve la jugada híbrida por la
  // base alcanzada: 2ª→1BE, 3ª→2BE, home→3BE. Error sobre el corredor → la
  // E# viaja en la notación del hit (errorOn sale de ahí en events.ts).
  const pureHit = (r?: string | null): string | null => r && ['1B', '2B', '3B', 'HR', 'HRIP', '1BE', '2BE', '3BE'].includes(r)
    ? ({ '1B': '1B', '2B': '2B', '3B': '3B', '1BE': '1B', '2BE': '2B', '3BE': '3B', 'HR': 'HR', 'HRIP': 'HRIP' } as Record<string, string>)[r]
    : null;
  if (ctx && (pureHit(mapped?.result) || (HIT_WORD.test(ntSp) && ['E', 'ADJ', 'FC'].includes(mapped?.result ?? '')))) {
    const baseHit = pureHit(mapped?.result)
      ?? (/doble|tubey|\b2b\b|dos bases/i.test(ntSp) ? '2B'
        : /triple|\b3b\b|tres bases/i.test(ntSp) ? '3B'
        : /jonr[óo]n|cuadrangular|homerun|home ?run|\bh4\b/i.test(ntSp) ? 'HR' : '1B');
    if (!pureHit(mapped?.result)) mapped = { result: baseHit };
    const runnerSubj = RUNNER_SUBJ.test(ntSp);
    const destBase = destOf(ntSp);                    // base dicha del avance
    const anota = !destBase && SCORE_WORD.test(ntSp); // "anota" sin base dicha
    const err = ERR_WORD.test(ntSp);
    const only = ([1, 2, 3] as const).map((b) => ctx.bases[b]).filter(Boolean) as string[];
    // el híbrido xBE solo vale si el avance extra era del BATEADOR — "hit y
    // anota por error" con corredor en base = el CORREDOR anotó por el error
    if (['1BE', '2BE', '3BE'].includes(mapped!.result) && (anota || (runnerSubj && destBase != null))) {
      mapped = { result: baseHit, notation: mapped!.notation };
    }
    if (!runnerSubj && destBase && destBase !== 1) {
      // el avance del bateador ya fue empujado pre-playText — falta el híbrido
      const hitBase = ({ '1B': 1, '2B': 2, '3B': 3 } as Record<string, number>)[baseHit] ?? 0;
      const destN = destBase === 'HOME' ? 4 : destBase;
      if (err && hitBase && destN > hitBase) {
        mapped = { result: ({ 2: '1BE', 3: '2BE', 4: '3BE' } as Record<number, string>)[destN] };
      }
      const bAdv = advances.find((a) => a.playerId === ctx.batterId);
      if (bAdv && err && bAdv.via === 'bateador') bAdv.via = 'bateador por error';
    } else if (anota && !runnerSubj && !only.length && ctx.batterId) {
      // "hit y anota" sin corredores: el bateador llegó al home (error → 3BE)
      if (!advances.some((a) => a.playerId === ctx.batterId)) {
        advances.push({ playerId: ctx.batterId, to: 'HOME', via: err ? 'bateador por error' : 'bateador' });
      }
      if (err && baseHit !== 'HR' && baseHit !== 'HRIP') mapped = { result: '3BE' };
    } else {
      // sujeto corredor (explícito o único en base): el avance es del corredor
      if (only.length === 1 && !advances.some((a) => a.playerId === only[0])) {
        const to = destBase ?? (anota ? 'HOME' : null);
        if (to) advances.push({ playerId: only[0]!, to, via: err ? 'corredor por error' : 'corredor' });
      }
    }
    // la E# dicha viaja en la notación (en híbrido el modal la prellena)
    const ef = err ? errorFielder(ntSp) : null;
    if (ef && !mapped!.notation) mapped = { ...mapped!, notation: `E${ef}` };
  }
  // "se robó segunda por error del 2": el robo cuenta (SB) y la E# marca el
  // error del tiro — la notación carga errorOn en events.ts (E/ADJ/xBE ya
  // resuelven su propia E# arriba)
  const efAny = ERR_WORD.test(ntSp) ? errorFielder(ntSp) : null;
  if (efAny && mapped && !mapped.notation && !['E', 'ADJ', '1BE', '2BE', '3BE'].includes(mapped.result)) {
    mapped = { ...mapped, notation: `E${efAny}` };
  }
  // "la bola le pegó al corredor" / interferencia del corredor: el texto de
  // jugada perdió "corredor en <base>", así que se chequea el transcript crudo
  if (!mapped && /la (bola|pelota).{0,25}(peg[oó]|toc[oó]|dio).{0,15}corredor|corredor.{0,20}interfiri|interferencia.{0,10}corredor/i.test(normName(transcript))) {
    mapped = { result: 'INT' };
    source = 'local';
  }
  // "se robó segunda" sin nombre → el corredor de la base anterior;
  // "atrapado robando a tercera" → el de segunda queda OUT;
  // "avance en primera atrapado robando" → el de primera OUT;
  // "out robando" solo → el de primera (o el más adelantado) OUT;
  // "se robó el home" → el de tercera anota; "doble robo" → todos los destinos.
  // La base se toma en ORDEN HABLADO: la última nombrada es el destino.
  // OJO: las bases se leen del TRANSCRIPT original — playText ya no trae
  // "corredor en segunda" ni "a tercera" (los limpió playTextOf).
  if (ctx && ['SB', 'CS', 'PK', 'WP', 'PB', 'DI', 'INT'].includes(mapped?.result ?? '')) {
    const fail = ['CS', 'PK', 'INT'].includes(mapped!.result);
    const ntFull = normName(transcript);
    // los alias llevan artículo en BASE_WORD ("la inicial") — se prueba con y sin
    const baseFor = (w: string) =>
      BASE_WORD.find(([re]) => re.test(w) || re.test(`la ${w}`))?.[1];
    const mentioned = [...ntFull.matchAll(/primera|segunda|tercera|inicial|intermedia|antesala|1ra|2da|3ra|home|plato|goma|registradora|pent[aá]gono/g)]
      .map((m) => baseFor(m[0]))
      .filter((b): b is number | 'HOME' => b != null);
    const pushAdv = (fromBase: 1 | 2 | 3, to: number | 'HOME' | 'OUT') => {
      const pid = ctx.bases[fromBase];
      if (pid && !advances.some((a) => a.playerId === pid)) {
        advances.push({ playerId: pid, to, via: `corredor de ${fromBase}ª` });
      }
    };
    // "corredor EN segunda" → el de segunda mismo (no el de la anterior);
    // "robo DE/A tercera" → el de segunda va a tercera
    const enBase = [...ntFull.matchAll(/\ben (?:la )?(primera|segunda|tercera|inicial|intermedia|antesala)/g)]
      .map((m) => baseFor(m[1]))
      .filter((b): b is number => typeof b === 'number')
      .pop();
    // doble robo: "se robaron segunda y tercera" → todos los corredores avanzan
    if (!fail && /doble robo|se robaron|robaron dos/i.test(ntFull) && mentioned.length > 1) {
      for (const d of mentioned) {
        if (d === 'HOME') pushAdv(3, 'HOME');
        else if (d > 1) pushAdv((d - 1) as 1 | 2, d);
      }
    } else if (fail) {
      if (enBase != null) pushAdv(enBase as 1 | 2 | 3, 'OUT');
      else {
        const dest = mentioned[mentioned.length - 1];
        if (dest === 'HOME') pushAdv(3, 'OUT');
        else if (typeof dest === 'number') pushAdv((dest === 1 ? 1 : dest - 1) as 1 | 2, 'OUT');
        else {
          // sin base nombrada → el corredor de primera; si no hay, el más adelantado
          const pid = ctx.bases[1] ?? ctx.bases[2] ?? ctx.bases[3];
          if (pid && !advances.some((a) => a.playerId === pid)) {
            advances.push({ playerId: pid, to: 'OUT', via: 'corredor' });
          }
        }
      }
    } else {
      const dest = mentioned[mentioned.length - 1];
      if (dest === 'HOME') pushAdv(3, 'HOME');
      else if (typeof dest === 'number' && dest > 1) pushAdv((dest - 1) as 1 | 2, dest);
    }
  }
  // avance hablado sin jugada acompañante: "perdomo anota", "el de segunda a
  // tercera", "perdomo roba tercera" (cuando SB/CS no lo resolvió por base)
  let advOnlyDesc: string | null = null;
  let advOnlyWarn = '';
  if (!mapped && advances.length) {
    mapped = { result: 'ADJ' };
    source = 'local';
    advOnlyDesc = `Avance: ${advances.map((a) => `${a.via} → ${a.to === 'HOME' ? 'anota' : a.to === 'OUT' ? 'out' : `${a.to}ª`}`).join(' · ')}`;
    // el anotador puede nombrar a alguien que NO está en base ("perdomo anota"
    // con perdomo en la banca) — avisar para que verifique antes de confirmar
    if (ctx) {
      const onBase = new Set([ctx.bases[1], ctx.bases[2], ctx.bases[3]].filter(Boolean));
      const off = advances.filter((a) => !onBase.has(a.playerId));
      if (off.length) advOnlyWarn = `⚠ ${off.map((a) => a.via).join(', ')} no aparece en base — verifica`;
    }
  }
  // frase no reconocida → log persistente para engordar el vocabulario:
  // missed-voice.log junto al dist/src, una línea por frase con fecha y juego
  if (!mapped) {
    try {
      const dir = path.dirname(envPath());
      fs.appendFileSync(path.join(dir, 'missed-voice.log'),
        `${new Date().toISOString()}\t${gameId ?? '-'}\t${transcript.trim()}\n`);
    } catch { /* el log nunca debe romper la respuesta */ }
    return res.status(422).json({ error: 'No entendí la jugada — intenta de nuevo o anótala manual', transcript });
  }

  // el primer nombre mencionado sin avance = el bateador ("yuri beltre 4 3")
  let saidBatterId: string | null = null;
  let note = '';
  if (ctx) {
    const sinAdv = mentions.filter((m) => !advances.some((a) => a.playerId === m.playerId));
    if (sinAdv.length && sinAdv[0].playerId !== ctx.batterId) {
      const cand = sinAdv[0];
      saidBatterId = cand.playerId;
      const onBase = Object.values(ctx.bases).includes(cand.playerId);
      note = onBase
        ? `${cand.label} está en base — lo tomé como corredor`
        : `${cand.label} no es el bateador del turno — verifica`;
    }
    const ambig = mentions.filter((m) => m.ambig);
    if (ambig.length) {
      const extra = `«${ambig.map((m) => m.nameText).join('»/«')}» es un apellido compartido — verifica el jugador`;
      note = note ? `${note} · ${extra}` : extra;
    }
  }

  // la notación que viaja a la pantalla pasa por el mismo filtro que la
  // grabación — "ocho ocho" precarga 8, jamás 8-8 (jardinero no se repite)
  const outNotation = mapped.notation ? normNotation(mapped.notation) : null;
  res.json({
    ok: true, source, transcript,
    result: mapped.result, notation: outNotation,
    advances, batterId: saidBatterId, playerNames: mentions.map((m) => m.label),
    note: [note, advOnlyWarn].filter(Boolean).join(' · '),
    ai: { play_code: ai?.play_code ?? mapped.result, runs_scored: ai?.runs_scored ?? 0, outs_made: ai?.outs_made ?? null, description_spanish: advOnlyDesc ?? (ai?.description_spanish || explainNotation(mapped.result, outNotation)) },
  });
});

/* -------- M1b — transcripción de audio (Whisper, fallback del Web Speech API) -------- */
r.post('/ai/transcribe', async (req, res) => {
  const { audio, mime } = req.body as { audio?: string; mime?: string };
  if (!audio) return res.status(400).json({ error: 'audio requerido' });
  const t = await aiTranscribe(audio, mime ?? 'audio/webm');
  if (t.error || !t.text) return res.status(503).json({ error: t.error ?? 'Whisper no devolvió texto' });
  res.json({ ok: true, transcript: t.text });
});

/* ================= MÓDULO 6 — VALIDADOR DE ANOTACIÓN ================= */
r.post('/games/:id/validate-play', async (req, res) => {
  const { result, advances = [] } = req.body as { result?: string; advances?: { playerId: string; to: string | number }[] };
  const game = await prisma.game.findUnique({ where: { id: req.params.id } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  const st = reduceGame(await loadEvents(game.id), game.innings);
  const onBase = [st.bases[1], st.bases[2], st.bases[3]].filter(Boolean).length;
  const outs = st.outs;
  const runs = advances.filter((a) => a.to === 'HOME').length;
  const outsInPlay = advances.filter((a) => a.to === 'OUT').length;
  const fails: { error: string; suggestion: string }[] = [];

  if ((result === 'DP' || result === 'TP') && onBase === 0)
    fails.push({ error: 'Doble play sin corredores en base', suggestion: '¿Fue un out normal (6-3) o un force en una base?' });
  if (result === 'DP' && outs === 2)
    fails.push({ error: 'Doble play con 2 outs: el inning debió terminar', suggestion: 'El primer out del DP cierra la entrada — verifica el orden de los outs' });
  if (runs > 0 && onBase === 0 && !['HR', 'HRIP'].includes(result ?? ''))
    fails.push({ error: 'Carrera anotada sin corredores y sin jonrón', suggestion: '¿Olvidaste embasar al corredor que anotó?' });
  if (runs > onBase + 1)
    fails.push({ error: `${runs} carreras pero solo ${onBase} corredor(es) + el bateador`, suggestion: 'Revisa los avances: ¿quién anotó?' });
  if (outs + outsInPlay > 3)
    fails.push({ error: `La jugada hace ${outs + outsInPlay} outs — la entrada ya debió cerrar`, suggestion: 'Toca "Finalizar entrada" o corrige el out extra' });
  if (result === 'SF' && (onBase === 0 || !st.bases[3]))
    fails.push({ error: 'Fly de sacrificio sin corredor en 3ra', suggestion: 'El SF necesita corredor en 3ra anotando — ¿fue un fly out normal?' });
  if (result === 'SAC' && onBase === 0)
    fails.push({ error: 'Sacrificio sin corredores en base', suggestion: 'El toque de sacrificio necesita corredor que avance' });
  res.json({ is_valid: fails.length === 0, errors: fails });
});

/* ================= MÓDULO 4 — BOXSCORE + PLAY-BY-PLAY ================= */
const RESULT_TXT: Record<string, string> = {
  '1B': 'sencillo', '2B': 'doble', '3B': 'triple', HR: 'jonrón', HRIP: 'jonrón dentro del parque',
  BB: 'base por bolas', IBB: 'base intencional', K: 'ponche', KWP: 'K+wild', KPB: 'K+pasbola',
  HBP: 'pelotazo', E: 'error', FC: 'jugada de selección', DP: 'doble play', TP: 'triple play',
  GO: 'rolling out', FO: 'elevado', LO: 'línea', PO: 'batazo al pitcher', SAC: 'toque de sacrificio', SF: 'fly de sacrificio',
};

r.get('/games/:id/boxscore-ai', async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id }, include: { homeTeam: true, awayTeam: true, lineups: { include: { player: true } } } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  const evs = await loadEvents(game.id);
  const box = computeBoxscore(evs, game.innings);
  const nameOf = (pid?: string | null) => {
    const l = game.lineups.find((x) => x.playerId === pid);
    return l ? `${l.player.firstName[0]}. ${l.player.lastName}` : '';
  };
  // jugada a jugada en texto (saltando jugadas mid-turno)
  const lines: string[] = [];
  let curHalf = '';
  for (const e of evs) {
    const half = `${e.inning === 1 ? '1ra' : e.inning === 2 ? '2da' : e.inning === 3 ? '3ra' : `${e.inning}ta`} ${e.half === 'TOP' ? '↑' : '↓'}`;
    if (half !== curHalf) { curHalf = half; lines.push(`\n${half}:`); }
    const res = RESULT_TXT[e.result] ?? e.result;
    if (e.batterId) lines.push(`${nameOf(e.batterId)}: ${res}${e.notation ? ` (${e.notation})` : ''}${e.advances.some((a) => a.to === 'HOME') ? ' — ANOTA' : ''}`);
  }
  const pbp = lines.join('\n').trim();
  try { // el guardado es opcional: un cliente Prisma viejo (sin estas columnas) no debe tumbar la respuesta
    await prisma.game.update({ where: { id: game.id }, data: { boxscoreJson: JSON.stringify(box), playByPlay: pbp } });
  } catch (e) { console.error('boxscore save:', e); }
  res.json({ boxscore: box, playByPlay: pbp, teams: { away: game.awayTeam.name, home: game.homeTeam.name }, status: game.status });
});

/* ================= MÓDULO 3 — NARRADOR AUTOMÁTICO ================= */
r.post('/games/:id/narrate', async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id }, include: { lineups: { include: { player: true } } } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  const evs = await loadEvents(game.id);
  const ev = evs[evs.length - 1];
  if (!ev) return res.status(400).json({ error: 'Sin jugadas aún' });
  const nameOf = (pid?: string | null) => playerName(game.lineups.find((x) => x.playerId === pid)?.player);
  const runs = ev.advances.filter((a) => a.to === 'HOME').length;
  const ctx = `Jugada: ${RESULT_TXT[ev.result] ?? ev.result}${ev.notation ? ' ' + ev.notation : ''}. Bateador: ${nameOf(ev.batterId)}. Pitcher: ${nameOf(ev.pitcherId)}. Carreras en la jugada: ${runs}. Entrada ${ev.inning} ${ev.half === 'TOP' ? 'alto' : 'bajo'}.`;
  const ai = (await aiChat(
    `Eres narrador dominicano de pelota (estilo Mendy López). Genera narración emocionante de 1-2 frases en slang dominicano con los nombres. JSON {"narration_text":"...","narration_type":"exciting"|"normal"}.`,
    ctx,
  )) as { narration_text?: string } | null;

  let text = ai?.narration_text;
  if (!text) { // respaldo sin IA
    const bn = nameOf(ev.batterId) || 'el bateador';
    const lib: Record<string, string> = {
      HR: `¡Tablazooo de ${bn}! ¡La bola se fue del parque!${runs > 1 ? ` ¡${runs} carreras al plato!` : ''}`,
      '3B': `¡Triple de ${bn}! ¡Se paró en tercera como un avión!`,
      '2B': `¡Doblete de ${bn} por los lados!${runs ? ` ¡${runs} anota${runs > 1 ? 'n' : ''}!` : ''}`,
      '1B': `¡Hit de ${bn}!${runs ? ` ¡Empuja ${runs}!` : ''}`,
      K: `¡Ponche! ¡El pitcher ${nameOf(ev.pitcherId)} se lo cantó a ${bn}!`,
      BB: `Base por bolas para ${bn}, cuatro malas.`,
      DP: `¡Doble play! ¡${ev.notation ?? ''} de lujo!`,
      E: `¡Error! ${bn} se embasa gratis.`,
    };
    text = lib[ev.result] ?? `${bn}: ${RESULT_TXT[ev.result] ?? ev.result}.`;
  }
  try { // persistir la narración es opcional — no debe tumbar el request
    await prisma.gameEvent.update({ where: { gameId_seq: { gameId: game.id, seq: ev.seq } }, data: { aiNarr: text } });
  } catch (e) { console.error('narration save:', e); }
  res.json({ narration: text, seq: ev.seq });
});

/* ================= MÓDULO 5 — STATS EN VIVO + INSIGHT ================= */
r.get('/games/:id/insights', async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id }, include: { homeTeam: true, awayTeam: true, lineups: { include: { player: true } } } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  const evs = await loadEvents(game.id);
  const st = reduceGame(evs, game.innings);
  const box = computeBoxscore(evs, game.innings);

  // probabilidad de victoria (modelo simple: marcador + inning + bases + outs)
  const diff = st.score.away - st.score.home;
  const baseProb = 0.5 + diff * 0.085;
  const innFactor = Math.min(1, st.inning / game.innings);
  const halfAdj = st.half === 'TOP' ? 0 : -0.01;
  let pHome = 1 - (baseProb * (1 - innFactor * 0.0) + halfAdj);
  pHome = Math.max(0.02, Math.min(0.98, 0.5 - diff * 0.085 - (st.half === 'BOTTOM' && diff < 0 ? 0.04 : 0)));

  // bateador actual: stats con corredores en posición y vs el pitcher actual
  const battingTeam = st.half === 'TOP' ? game.awayTeamId : game.homeTeamId;
  const lineup = game.lineups.filter((l) => l.teamId === battingTeam && l.active && l.batsInOrder !== false).sort((a, b) => a.order - b.order);
  const batterIdx = (st.half === 'TOP' ? st.awayBatterIndex : st.homeBatterIndex) % Math.max(lineup.length, 1);
  const batter = lineup[batterIdx];
  const curPitcherId = evs.filter((e) => e.pitcherId).at(-1)?.pitcherId ?? null;

  let rispLine = null as null | { ab: number; h: number };
  let vsPitcher = null as null | { ab: number; h: number };
  if (batter) {
    let rispAb = 0, rispH = 0, vsAb = 0, vsH = 0;
    let rs = initialState();
    for (const e of evs) {
      if (e.batterId === batter.playerId && !['SB', 'CS', 'WP', 'PB', 'BK', 'PK', 'DI', 'CR', 'PC', 'INT', 'OBS', 'GR', 'B', 'S', 'F', 'IPL', 'LE', 'EF', 'EI', 'ADJ', 'RBI', 'EU', 'LG', 'SK', 'DE', 'LIB'].includes(e.result)) {
        const isAB = !['BB', 'IBB', 'HBP', 'SAC', 'SF', 'CI', 'OOT'].includes(e.result);
        const isH = ['1B', '2B', '3B', 'HR', 'HRIP', '1BE', '2BE', '3BE'].includes(e.result);
        if (rs.bases[2] || rs.bases[3]) { if (isAB) rispAb++; if (isH) rispH++; }
        if (e.pitcherId === curPitcherId) { if (isAB) vsAb++; if (isH) vsH++; }
      }
      rs = applyEvent(rs, e, game.innings);
    }
    rispLine = { ab: rispAb, h: rispH };
    vsPitcher = { ab: vsAb, h: vsH };
  }
  const pitcherLine = curPitcherId ? box.pitchers[curPitcherId] : null;
  const batterName = batter ? playerName(batter.player) : '';
  const statsCtx = `Bateador ${batterName}: ${batter ? JSON.stringify(box[st.half === 'TOP' ? 'away' : 'home'][batter.playerId] ?? {}) : '{}'} · RISP ${rispLine?.h}/${rispLine?.ab} · vs pitcher ${vsPitcher?.h}/${vsPitcher?.ab} · Pitcher ${curPitcherId ? playerName(game.lineups.find((l) => l.playerId === curPitcherId)?.player) : ''} lanzamientos ${pitcherLine?.pitches ?? 0} · Marcador ${st.score.away}-${st.score.home}, entrada ${st.inning}, outs ${st.outs}`;
  const ai = (await aiChat('Eres coach de pelota. Da 1 consejo táctico corto para el dirigente en español dominicano, máx 15 palabras. JSON {"insight":"..."}', statsCtx)) as { insight?: string } | null;

  let insight = ai?.insight ?? null;
  if (!insight && pitcherLine && pitcherLine.pitches >= 80) insight = `${pitcherLine.pitches} lanzamientos — considera el relevo`;
  else if (!insight && rispLine && rispLine.ab >= 2 && rispLine.h / rispLine.ab >= 0.4) insight = `${batterName} batea de ${rispLine.ab}-${rispLine.h} con corredores en posición`;
  else if (!insight && vsPitcher && vsPitcher.ab >= 2 && vsPitcher.h === 0) insight = `${batterName} no le ha dado a este pitcher (${vsPitcher.ab} turnos)`;

  res.json({
    winProb: { away: +(1 - pHome).toFixed(2), home: +pHome.toFixed(2) },
    batter: batter ? { playerId: batter.playerId, name: batterName, risp: rispLine, vsPitcher } : null,
    pitcher: curPitcherId ? { playerId: curPitcherId, name: playerName(game.lineups.find((l) => l.playerId === curPitcherId)?.player), pitches: pitcherLine?.pitches ?? 0 } : null,
    insight, ai: aiEnabled(),
  });
});

/* ================= MÓDULO 7 — RESUMEN PARA REDES ================= */
r.get('/games/:id/share', async (req, res) => {
  const game = await prisma.game.findUnique({ where: { id: req.params.id }, include: { homeTeam: true, awayTeam: true, lineups: { include: { player: true } } } });
  if (!game) return res.status(404).json({ error: 'Juego no encontrado' });
  const evs = await loadEvents(game.id);
  const box = computeBoxscore(evs, game.innings);
  const st = reduceGame(evs, game.innings);
  const score = { away: st.score.away, home: st.score.home };
  const nameOf = (pid?: string | null) => playerName(game.lineups.find((x) => x.playerId === pid)?.player);

  // MVP: mayor fórmula simple (H + HR×2 + RBI) del juego
  let mvp: { id: string; name: string; line: string } | null = null;
  let best = -1;
  for (const side of ['away', 'home'] as const) {
    for (const [pid, b] of Object.entries(box[side])) {
      const val = b.h + b.hr * 2 + b.rbi;
      if (val > best) {
        best = val;
        mvp = { id: pid, name: nameOf(pid) ?? pid, line: `${b.ab}-${b.h}${b.hr ? `, ${b.hr} HR` : ''}${b.rbi ? `, ${b.rbi} CI` : ''}${b.r ? `, ${b.r} C` : ''}` };
      }
    }
  }
  const ai = (await aiChat(
    'Genera resumen de juego de liga amateur en español dominicano, 2-3 párrafos cortos + 3 titulares. JSON {"summary_text":"...","headlines":["...","...","..."]}.',
    `Final: ${game.awayTeam.name} ${score.away} - ${score.home} ${game.homeTeam.name}. MVP: ${mvp?.name} (${mvp?.line}). Jugadas: ${(game as { playByPlay?: string | null }).playByPlay ?? ''}`,
  )) as { summary_text?: string; headlines?: string[] } | null;

  const winner = score.away > score.home ? game.awayTeam.name : score.home > score.away ? game.homeTeam.name : null;
  const whatsapp = `🏁 RESULTADO FINAL\n${game.awayTeam.name} ${score.away} — ${score.home} ${game.homeTeam.name}` +
    (mvp ? `\n⭐ MVP: ${mvp.name} (${mvp.line})` : '') +
    (ai?.headlines?.[0] ? `\n\n${ai.headlines[0]}` : '') + `\n\n— PoxScore · Alexis Lara 2026`;
  res.json({
    score, winner, mvp,
    summary: ai?.summary_text ?? `${winner ? `Victoria de ${winner}` : 'Empate'} ${Math.max(score.away, score.home)}-${Math.min(score.away, score.home)}. ${mvp ? `${mvp.name} la figura: ${mvp.line}.` : ''}`,
    headlines: ai?.headlines ?? [],
    whatsapp, facebook: ai?.summary_text ?? whatsapp,
    ai: aiEnabled(),
  });
});

/* ================= MÓDULO 8 — ASISTENTE DE CONSULTAS (pregunta → stats) =================
 * "¿quién tiene más 2b entre Ulises Herrera y Juan Colón?" → compara datos reales.
 * Sin IA: detector de nombres + estadística por palabras clave. Con IA: GPT redacta
 * la respuesta usando los números calculados (no inventa). */
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// palabra clave → estadística (campo de PlayerSeasonStat o derivada)
const STAT_KEYS: { re: RegExp; key: string; label: string; compute?: (s: StatAgg) => number }[] = [
  { re: /dobles?|2b|dos bases/, key: 'doubles', label: 'dobles' },
  { re: /triples?|3b|tres bases/, key: 'triples', label: 'triples' },
  { re: /jonr|cuadrangular|hr(?!a)|tablazo/, key: 'hr', label: 'jonrones' },
  { re: /empujad|impulsad|remolc|\bci\b|rbi/, key: 'rbi', label: 'carreras empujadas' },
  { re: /anotad|\bcarreras?\b|\brun/, key: 'r', label: 'carreras anotadas' },
  { re: /hits?|imparable|sencillos?|batazos?/, key: 'h', label: 'hits' },
  { re: /bases? por bola|boletos?|pasaportes?|\bbb\b/, key: 'bb', label: 'bases por bolas' },
  { re: /robad|robo|\bsb\b/, key: 'sb', label: 'bases robadas' },
  { re: /ponches?|chocolates?|\bk\b/, key: 'k', label: 'ponches (al bate)' },
  { re: /batea|promedio|avg|average/, key: 'avg', label: 'promedio de bateo', compute: (s) => (s.ab ? s.h / s.ab : 0) },
  { re: /obp|embasamiento/, key: 'obp', label: 'OBP', compute: (s) => (s.ab + s.bb + s.hbp + s.sf ? (s.h + s.bb + s.hbp) / (s.ab + s.bb + s.hbp + s.sf) : 0) },
  { re: /slug|slg/, key: 'slg', label: 'slugging', compute: (s) => (s.ab ? (s.h + s.doubles + s.triples * 2 + s.hr * 3) / s.ab : 0) },
  { re: /ops/, key: 'ops', label: 'OPS', compute: (s) => (s.ab + s.bb + s.hbp + s.sf ? (s.h + s.bb + s.hbp) / (s.ab + s.bb + s.hbp + s.sf) : 0) + (s.ab ? (s.h + s.doubles + s.triples * 2 + s.hr * 3) / s.ab : 0) },
  { re: /ganad|victoria|\bwin/, key: 'w', label: 'juegos ganados (pitcheo)' },
  { re: /perdid|derrota|\bloss/, key: 'l', label: 'juegos perdidos' },
  { re: /salvad|\bsv\b/, key: 'sv', label: 'juegos salvados' },
  { re: /era|efectividad|limpia/, key: 'era', label: 'ERA', compute: (s) => (s.pOuts ? (s.pER * 27) / s.pOuts : 0) },
  { re: /ponches? de lanzador|k.*pitcher|poncho.*bateador/, key: 'pK', label: 'ponches lanzados' },
  { re: /errores?/, key: 'e', label: 'errores' },
  { re: /juegos?\b|partidos?/, key: 'g', label: 'juegos' },
];

interface StatAgg { [k: string]: number }

// ── filtros situacionales: "con hombres en posición de anotar", "con 2 outs",
// "vs tal pitcher", "últimos 3 juegos", "bateando cuarto" ──
interface SitFilter {
  bases?: 'risp' | 'loaded' | 'empty' | 'any' | number[]; // number[] = bases ocupadas exactas
  outs?: number;
  pitcherId?: string; pitcherName?: string;
  lastGames?: number;
  order?: number;
  innFrom?: number; innTo?: number;
  desc: string[];
}
const ORD_WORD: Record<string, number> = { primer: 1, primero: 1, segundo: 2, tercer: 3, tercero: 3, cuarto: 4, quinto: 5, sexto: 6, septimo: 7, 'séptimo': 7, octavo: 8, noveno: 9 };

function parseFilters(q: string): SitFilter {
  const f: SitFilter = { desc: [] };
  if (/posici[óo]n de anotar|posici[óo]n anotadora|risp|scoring|segunda o tercera|2da o 3era/.test(q)) { f.bases = 'risp'; f.desc.push('con corredores en posición de anotar'); }
  if (/bases? llenas?|casa llena|lleno de corredores/.test(q)) { f.bases = 'loaded'; f.desc.push('con bases llenas'); }
  else if (/bases? vac[íi]as?|sin corredores|sin nadie en base/.test(q)) { f.bases = 'empty'; f.desc.push('con bases vacías'); }
  else if (/(?:hombre|corredor|con uno) en (?:segunda|2da|2a)/.test(q)) { f.bases = [2]; f.desc.push('con corredor en 2da'); }
  else if (/(?:hombre|corredor|con uno) en (?:tercera|3ra|3a)/.test(q)) { f.bases = [3]; f.desc.push('con corredor en 3ra'); }
  else if (/(?:hombre|corredor|con uno) en (?:primera|1ra|1a)/.test(q)) { f.bases = [1]; f.desc.push('con corredor en 1ra'); }
  const mOut = q.match(/(?:con|y)\s+(\d+|un|uno|dos|tres)\s+outs?/);
  if (mOut) {
    const w: Record<string, number> = { un: 1, uno: 1, dos: 2, tres: 3 };
    f.outs = w[mOut[1]] ?? +mOut[1];
    f.desc.push(`con ${f.outs} out${f.outs === 1 ? '' : 's'}`);
  }
  const mLast = q.match(/[úu]ltimos?\s+(\d+)\s+juegos?/);
  if (mLast) { f.lastGames = +mLast[1]; f.desc.push(`últimos ${f.lastGames} juegos`); }
  else if (/[úu]ltimos?\s+juegos?|recentemente|forma reciente/.test(q)) { f.lastGames = 5; f.desc.push('últimos 5 juegos'); }
  const mOrd = q.match(/(\d+)\s*(?:º|to|do|ro|mo|vo|no|ero|era)?\s*bate\b|bateando\s+(?:de\s+)?(\w+)|(?:de|siendo|como)\s+(\w+)\s+bate\b|(\w+)\s+bate\b/);
  if (mOrd) {
    const w = mOrd[1] ?? mOrd[2] ?? mOrd[3] ?? mOrd[4] ?? '';
    const n = +w || +((w.match(/\d+/) ?? [])[0] ?? 0) || ORD_WORD[w] || ORD_WORD[norm(w)];
    if (n && n >= 1 && n <= 9) { f.order = n; f.desc.push(`bateando ${n}º`); }
  }
  const mInn = q.match(/(?:entrada|inning)s?\s+(\d+)(?:\s*[-a]\s*(\d+))?/);
  if (mInn) { f.innFrom = +mInn[1]; f.innTo = +(mInn[2] ?? mInn[1]); f.desc.push(f.innFrom === f.innTo ? `entrada ${f.innFrom}` : `entradas ${f.innFrom}-${f.innTo}`); }
  else if (/entradas? tard[íi]as?|late innings?/.test(q)) { f.innFrom = 7; f.desc.push('entradas tardías (7+)'); }
  return f;
}

/** Línea de bateo de un jugador filtrada por situación — re-simula los eventos */
async function situationalLine(playerId: string, flt: SitFilter) {
  // juegos donde bateó + sus metadatos
  const evRows = await prisma.gameEvent.findMany({
    where: { batterId: playerId },
    select: { gameId: true },
    distinct: ['gameId'],
  });
  if (!evRows.length) return null;
  let gameIds = evRows.map((e) => e.gameId);
  const games = await prisma.game.findMany({
    where: { id: { in: gameIds } },
    select: { id: true, date: true, innings: true },
    orderBy: { date: 'asc' },
  });
  if (flt.lastGames && games.length > flt.lastGames) {
    const keep = new Set(games.slice(-flt.lastGames).map((g) => g.id));
    gameIds = gameIds.filter((id) => keep.has(id));
  }
  // orden de bateo por juego (para "bateando 4to")
  const orderByGame = new Map<string, number>();
  if (flt.order) {
    for (const l of await prisma.lineupEntry.findMany({ where: { gameId: { in: gameIds }, playerId, order: { gte: 1, lte: 9 } } }))
      orderByGame.set(l.gameId, l.order);
  }
  const line = { pa: 0, ab: 0, h: 0, d2: 0, d3: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sf: 0, sac: 0, sb: 0, g: new Set<string>() };
  const NO_AB = new Set(['BB', 'IBB', 'HBP', 'SAC', 'SF', 'CI', 'OOT', 'SK', 'LG', 'AO']);
  const IS_H = new Set(['1B', '2B', '3B', 'HR', 'HRIP', '1BE', '2BE', '3BE']);
  const MID = new Set(['SB', 'CS', 'WP', 'PB', 'BK', 'PK', 'DI', 'CR', 'PC', 'INT', 'OBS', 'GR', 'B', 'S', 'F', 'IPL', 'LE', 'EF', 'EI', 'ADJ', 'RBI', 'EU', 'LG', 'SK', 'DE', 'LIB']);
  const NO_RBI = new Set(['E', 'DP', 'TP', 'KWP', 'KPB']);

  for (const gid of gameIds) {
    const g = games.find((x) => x.id === gid)!;
    const evs = await prisma.gameEvent.findMany({ where: { gameId: gid }, orderBy: { seq: 'asc' } });
    let st = initialState();
    for (const raw of evs) {
      const e = toEvent(raw);
      if (e.batterId === playerId && !MID.has(e.result)) {
        // ¿cumple el filtro situacional? (estado ANTES de la jugada)
        const b = st.bases;
        const pass =
          (!flt.bases || flt.bases === 'risp' && (b[2] || b[3]) || flt.bases === 'loaded' && (b[1] && b[2] && b[3])
            || flt.bases === 'empty' && !(b[1] || b[2] || b[3]) || flt.bases === 'any' && (b[1] || b[2] || b[3])
            || (Array.isArray(flt.bases) && (flt.bases as number[]).every((bb) => !!b[bb as 1 | 2 | 3])))
          && (flt.outs == null || st.outs === flt.outs)
          && (!flt.pitcherId || e.pitcherId === flt.pitcherId)
          && (!flt.order || orderByGame.get(gid) === flt.order)
          && (!flt.innFrom || (e.inning >= flt.innFrom && e.inning <= (flt.innTo ?? flt.innFrom)));
        if (pass) {
          line.pa++; line.g.add(gid);
          if (!NO_AB.has(e.result)) line.ab++;
          if (IS_H.has(e.result)) { line.h++; if (e.result.startsWith('2B')) line.d2++; if (e.result.startsWith('3B')) line.d3++; if (e.result.startsWith('HR')) line.hr++; }
          if (['BB', 'IBB'].includes(e.result)) line.bb++;
          if (['K', 'KWP', 'KPB'].includes(e.result)) line.k++;
          if (e.result === 'HBP') line.hbp++;
          if (e.result === 'SF') line.sf++;
          if (e.result === 'SAC') line.sac++;
          if (!NO_RBI.has(e.result)) line.rbi += e.advances.filter((a) => a.to === 'HOME' && a.playerId !== playerId).length;
          if (['HR', 'HRIP'].includes(e.result)) line.rbi++;
        }
      }
      st = applyEvent(st, e, g.innings);
    }
  }
  return line;
}

const lineValue = (l: { pa: number; ab: number; h: number; d2: number; d3: number; hr: number; rbi: number; bb: number; k: number; hbp: number; sf: number; sb: number; g: Set<string> }, key: string): number => {
  const obp = (l.ab + l.bb + l.hbp + l.sf) ? (l.h + l.bb + l.hbp) / (l.ab + l.bb + l.hbp + l.sf) : 0;
  const slg = l.ab ? (l.h + l.d2 + l.d3 * 2 + l.hr * 3) / l.ab : 0;
  switch (key) {
    case 'avg': return l.ab ? l.h / l.ab : 0;
    case 'obp': return obp;
    case 'slg': return slg;
    case 'ops': return obp + slg;
    case 'iso': return slg - (l.ab ? l.h / l.ab : 0);
    case 'babip': return (l.ab - l.k - l.hr + l.sf) ? (l.h - l.hr) / (l.ab - l.k - l.hr + l.sf) : 0;
    case 'woba': return (l.ab + l.bb + l.hbp + l.sf) ? (0.69 * (l.bb + l.hbp) + 0.89 * (l.h - l.d2 - l.d3 - l.hr) + 1.28 * l.d2 + 1.6 * l.d3 + 2.08 * l.hr) / (l.ab + l.bb + l.hbp + l.sf) : 0;
    case 'whip': return 0; // WHIP es de pitcheo — no aplica a la línea de bateo
    case 'bbp': return l.pa ? l.bb / l.pa : 0;
    case 'kp': return l.pa ? l.k / l.pa : 0;
    case 'doubles': return l.d2; case 'triples': return l.d3; case 'hr': return l.hr;
    case 'rbi': return l.rbi; case 'r': return 0; case 'h': return l.h; case 'bb': return l.bb;
    case 'k': return l.k; case 'sb': return l.sb; case 'g': return l.g.size;
    default: return l.ab ? l.h / l.ab : 0;
  }
};

// stats sabermétricas extra (además de STAT_KEYS)
const SABER_KEYS: { re: RegExp; key: string; label: string; compute?: (s: StatAgg) => number }[] = [
  { re: /\biso\b|poder aislado/, key: 'iso', label: 'ISO (poder aislado)' },
  { re: /babip/, key: 'babip', label: 'BABIP' },
  { re: /woba/, key: 'woba', label: 'wOBA aprox' },
  { re: /whip/, key: 'whip', label: 'WHIP' },
  { re: /bb%|porcentaje de bases/, key: 'bbp', label: 'BB%' },
  { re: /k%|porcentaje de ponches/, key: 'kp', label: 'K%' },
];

r.post('/ai/ask', async (req, res) => {
  const { question } = req.body as { question?: string };
  if (!question?.trim()) return res.status(400).json({ error: 'question requerido' });
  const q = norm(question);

  // 1. jugadores mencionados: buscar nombres en la pregunta (nombre o apellido)
  const players = await prisma.player.findMany({ include: { team: { select: { name: true } }, seasons: true } });
  const found = new Map<string, { p: typeof players[0]; hits: number }>();
  for (const p of players) {
    const fn = normName(p.firstName), ln = normName(p.lastName);
    let hits = 0;
    if (fn.length > 2 && new RegExp(`\\b${fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q)) hits++;
    for (const part of ln.split(/\s+/)) if (part.length > 3 && new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q)) hits++;
    if (hits) found.set(p.id, { p, hits });
  }
  // preferir nombre+apellido (hits>=2); si nadie lo tiene, aceptar parciales
  const full = [...found.values()].filter((f) => f.hits >= 2).map((f) => f.p);
  let unique = (full.length ? full : [...found.values()].map((f) => f.p)).slice(0, 6);

  // 1b. "vs [pitcher]" / "al pitcher X" / "le batea a X": separa el lanzador del bateador
  const flt = parseFilters(q);
  const mVs = q.match(/(?:\bvs\.?|\bcontra|\bante|\bfrenta?\s+al?|\benfrenta(?:ndo)?\s+al?|\b(?:al|del|de)\s+(?:pitcher|lanzador|serpentinero))\s+(?:el\s+|al\s+|los?\s+)?([a-záéíóúñ]+(?:\s+[a-záéíóúñ]+)?)/);
  if (mVs && unique.length >= 2) {
    const vsParts = (mVs[1] ?? '').split(/\s+/).filter((w) => w.length > 2 && !['pitcher', 'lanzador', 'serpentinero'].includes(w));
    const pitcher = vsParts.length
      ? unique.find((p) => vsParts.every((w) => norm(`${p.firstName} ${p.lastName}`).includes(w)))
        ?? unique.find((p) => vsParts.some((w) => w.length > 3 && normName(p.lastName).includes(w)))
      : undefined;
    if (pitcher) { flt.pitcherId = pitcher.id; flt.pitcherName = `${pitcher.firstName} ${pitcher.lastName}`; flt.desc.push(`vs ${flt.pitcherName}`); unique = unique.filter((p) => p.id !== pitcher.id); }
  }

  // 2. estadística pedida (básicas + sabermétricas) — "últimos N juegos" sin stat
  // concreta = quiere su línea general, no el conteo de juegos
  let stat = STAT_KEYS.find((s) => s.re.test(q)) ?? SABER_KEYS.find((s) => s.re.test(q)) ?? null;
  if (stat?.key === 'g' && flt.lastGames) stat = null;
  const hasFilter = flt.desc.length > 0;

  // 3. valores por jugador: con filtro situacional re-simula eventos; sin filtro, acumulado
  const aggOf = (p: typeof players[0]): StatAgg => {
    const a: StatAgg = {};
    for (const s of p.seasons) for (const [k, v] of Object.entries(s))
      if (typeof v === 'number' && !['season'].includes(k)) a[k] = (a[k] ?? 0) + v;
    return a;
  };
  const RATE = ['avg', 'obp', 'slg', 'ops', 'iso', 'babip', 'bbp', 'kp', 'era', 'whip', 'woba'];
  const fmt = (v: number) => (stat && RATE.includes(stat.key)
    ? (['era', 'whip'].includes(stat.key) ? v.toFixed(2) : v.toFixed(3).replace(/^0/, ''))
    : String(Math.round(v)));

  const rows: { id: string; name: string; team: string; value: number | null; g: number; ab: number; h: number; hr: number; rbi: number; line?: string }[] = [];
  for (const p of unique) {
    const base = { id: p.id, name: `${p.firstName} ${p.lastName}`, team: p.team?.name ?? '' };
    if (hasFilter) {
      const l = await situationalLine(p.id, flt);
      const v = stat ? lineValue(l ?? { pa: 0, ab: 0, h: 0, d2: 0, d3: 0, hr: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sf: 0, sb: 0, g: new Set<string>() }, stat.key) : (l?.ab ? l.h / l.ab : 0);
      rows.push({
        ...base, value: v, g: l?.g.size ?? 0, ab: l?.ab ?? 0, h: l?.h ?? 0, hr: l?.hr ?? 0, rbi: l?.rbi ?? 0,
        line: l && l.pa ? `${l.ab}-${l.h}${l.hr ? `, ${l.hr} HR` : ''}${l.rbi ? `, ${l.rbi} CI` : ''}${l.bb ? `, ${l.bb} BB` : ''}${l.k ? `, ${l.k} K` : ''}` : 'sin turnos en esa situación',
      });
    } else {
      const s = aggOf(p);
      // derivadas sabermétricas sobre el acumulado
      const whip = s.pOuts ? ((s.pH + s.pBB) * 3) / s.pOuts : 0;
      const woba = s.ab ? ((0.69 * (s.bb + s.hbp) + 0.89 * (s.h - s.doubles - s.triples - s.hr) + 1.28 * s.doubles + 1.6 * s.triples + 2.08 * s.hr) / (s.ab + s.bb + s.hbp + s.sf)) : 0;
      const ext: StatAgg = { ...s, iso: (s.ab ? (s.h + s.doubles + s.triples * 2 + s.hr * 3) / s.ab : 0) - (s.ab ? s.h / s.ab : 0), babip: (s.ab - s.k - s.hr + s.sf) ? (s.h - s.hr) / (s.ab - s.k - s.hr + s.sf) : 0, whip, woba, bbp: s.pa ? s.bb / s.pa : 0, kp: s.pa ? s.k / s.pa : 0 };
      const vv = stat ? (stat.compute ? stat.compute(s) : ext[stat.key] ?? 0) : null;
      rows.push({ ...base, value: vv, g: s.g ?? 0, ab: s.ab ?? 0, h: s.h ?? 0, hr: s.hr ?? 0, rbi: s.rbi ?? 0 });
    }
  }
  rows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const filterDesc = flt.desc.length ? ` (${flt.desc.join(', ')})` : '';

  // 4. respuesta local
  let answer = '';
  if (!rows.length && !flt.pitcherId) answer = 'No reconocí jugadores en la pregunta — escribe el nombre completo (ej. "¿cuánto batea Juan Colón con 2 outs?").';
  else if (!rows.length) answer = `No reconocí al bateador — solo vi al pitcher ${flt.pitcherName}.`;
  else if (!stat) {
    const r0 = rows[0];
    answer = `${r0.name} (${r0.team})${filterDesc}: ${r0.line ?? `${r0.g} juegos, ${r0.ab}-${r0.h} (${r0.ab ? (r0.h / r0.ab).toFixed(3).replace(/^0/, '') : '.000'}), ${r0.hr} HR, ${r0.rbi} CI`}.`;
  } else {
    const top = rows[0];
    if (rows.length === 1) answer = `${top.name} (${top.team})${filterDesc}: ${fmt(top.value!)} ${stat.label}${top.line ? ` — ${top.line}` : ''}.`;
    else {
      const cmp = rows.slice(0, 4).map((r) => `${r.name} ${fmt(r.value!)}${r.line ? ` (${r.line})` : ''}`).join(' · ');
      answer = `${top.name} tiene más ${stat.label}${filterDesc}: ${cmp}.`;
    }
  }

  // 5. con IA: redacción natural usando los números ya calculados
  const ai = (await aiChat(
    'Eres comentarista dominicano de pelota. Responde la pregunta del usuario en español dominicano, 1-3 frases, usando SOLO los datos JSON dados (no inventes números). Si el filtro dice "vs X" ese es el pitcher. Si falta el dato dilo.',
    `Pregunta: "${question}". Datos: ${JSON.stringify({ jugadores: rows.map((r) => ({ nombre: r.name, equipo: r.team, valor: r.value, linea: r.line, g: r.g, ab: r.ab, h: r.h, hr: r.hr, rbi: r.rbi })), stat: stat?.label ?? null, filtro: flt.desc.join(', ') || null, respuesta_base: answer })}`,
  )) as { answer?: string } | string | null;
  const aiText = typeof ai === 'string' ? ai : ai?.answer;
  if (aiText) answer = aiText;

  res.json({ ok: true, answer, stat: stat?.key ?? null, filter: flt.desc.join(', ') || null, players: rows, ai: aiEnabled() });
});

/* ================= MÓDULO 2 — ANÁLISIS DE VIDEO (MVP simulado) ================= */
r.post('/ai/video-analyze', async (_req, res) => {
  // MVP: detección simulada — la integración real enviaría frames a GPT-4o Vision
  const opts = [
    { detected_play: 'hit', direction: 'CF', suggested_code: 'H8', confidence: 0.85, result: '1B', notation: 'H8' },
    { detected_play: 'out', direction: 'INF', suggested_code: '6-3', confidence: 0.9, result: 'GO', notation: '6-3' },
    { detected_play: 'out', direction: 'RF', suggested_code: 'F9', confidence: 0.78, result: 'FO', notation: 'F9' },
    { detected_play: 'error', direction: 'INF', suggested_code: 'E6', confidence: 0.74, result: 'E', notation: 'E6' },
    { detected_play: 'hit', direction: 'LF', suggested_code: '2B', confidence: 0.81, result: '2B', notation: null },
  ];
  const pick = opts[Math.floor(Math.random() * opts.length)];
  res.json({ ok: true, ...pick, mock: true });
});

export default r;
