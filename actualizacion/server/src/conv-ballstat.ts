/**
 * Conversor BallStat → .pox.json
 *   npx tsx src/conv-ballstat.ts "C:\ruta\LIGA" [-o salida.pox.json]
 *
 * Fuentes (carpeta exportada de BallStat):
 *  - "BallScore Reports/*.box.txt"  → juegos: fecha, marcador, local/visita, linescore
 *  - "WebBuilder/{equipo}_{jug}.htm"→ jugador: nombre completo, Bats/Throws/Pos +
 *      logs por juego (bateo, pitcheo con decisión, fildeo) — nombre completo,
 *      resuelve la ambigüedad de apellidos de los reportes.
 * Resultado: pox-import/1 con games[].stats[] (stats por juego) + players[].
 */
import fs from 'node:fs';
import path from 'node:path';

const MESES: Record<string, number> = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, augosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
};

// ------------------------------------------------------------------ utilidades
export function rtfToLines(txt: string): string[] {
  // quita cabecera rtf, convierte \par en saltos, decodifica \'hh (cp1252)
  let s = txt.replace(/^\{\\rtf1[^\n]*\n?/, '').replace(/\{\\fonttbl[^}]*\}?/, '');
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_m, h) => Buffer.from([parseInt(h, 16)]).toString('latin1'));
  s = s.replace(/\\par[d]?/g, '\n').replace(/\\[a-zA-Z]+-?\d* ?/g, '').replace(/[{}]/g, '');
  return s.split('\n').map((l) => l.replace(/\s+$/g, '')).filter((l) => l.trim().length);
}

function stripHtml(html: string): string[][] {
  // devuelve celdas de tabla: array de filas, cada una = array de textos <TD>
  const rows: string[][] = [];
  let cur: string[] = [];
  for (const m of html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)) {
    const t = m[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (m[0].match(/<td\b[^>]*>\s*$/i) && t === '') { /* celda vacía con salto */ }
    cur.push(t);
    if (/Totals/i.test(t)) { rows.push(cur); cur = []; }
  }
  if (cur.length) rows.push(cur);
  return rows;
}

const title = (s: string) =>
  s.toLowerCase().replace(/(^|\s|[,\-'])\S/g, (c) => c.toUpperCase());

interface BsGame {
  date: string; dateIso: string; away: string; home: string;
  scoreAway: number; scoreHome: number; innings: number;
  recAway?: { w: number; l: number };   // récord (W-L) del encabezado — se reinicia en playoffs
  recHome?: { w: number; l: number };
  series?: string;                      // nombre de la serie playoff detectada
  wpSurs?: string[]; svSurs?: string[]; // "WP-/S- APELLIDO[, APELLIDO]" del pie — líneas envueltas traen varios nombres
  decW?: string[]; decL?: string[]; decS?: string[]; // "APELLIDO(W 1-0)" / "(L 0-2)" / "(S 1)" en la tabla de pitcheo
}
interface PlayerLog {
  team: string; name: string; firstName: string; lastName: string;
  bats?: string; throws?: string; pos: string[];
  bat: Map<string, Record<string, number>>;  // key date+opp
  pit: Map<string, Record<string, number>>;
  fld: Map<string, Record<string, number>>;
  dec: Map<string, string>; // date → decisión W/L/S
}

// ------------------------------------------------------------------ .box.txt
function parseBox(txt: string): BsGame | null {
  const lines = rtfToLines(txt);
  const dateLine = lines.find((l) => /\d{1,2},\s*\d{4}/.test(l));
  let dateIso = '';
  let dateShort = '';
  if (dateLine) {
    const m = dateLine.match(/(\w+)\s+(\d{1,2}),\s*(\d{4})/);
    if (m) {
      const mo = MESES[m[1].toLowerCase()];
      if (mo != null) {
        const y = Number(m[3]), d = Number(m[2]);
        dateIso = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        dateShort = `${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}-${String(y).slice(2)}`;
      }
    }
  }
  // linescore: filas "EQUIPO  1 2 3 ... R H E" — visita primero
  const lsIdx = lines.findIndex((l) => /^\s*1\s+2\s+3.*\bR\b/.test(l) || /-\s+-\s+-.*\b-\s+-\s+-/.test(l));
  const scoreRows: { team: string; r: number }[] = [];
  if (lsIdx >= 0) {
    for (let i = lsIdx + 1; i < Math.min(lsIdx + 4, lines.length); i++) {
      const m = lines[i].match(/^\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .]+?)\s+([\d\s]+?)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/i);
      if (m) scoreRows.push({ team: m[1].trim(), r: Number(m[3]) });
    }
  }
  // récord (W-L) del encabezado "EQUIPO (w-l)  EQUIPO (w-l)": izquierda=visita
  // — BallScore lo REINICIA al empezar la postemporada → detector de playoffs
  let recAway: { w: number; l: number } | undefined, recHome: { w: number; l: number } | undefined;
  for (const l of lines) {
    const recs = [...l.matchAll(/\((\d+)-(\d+)\)/g)];
    if (recs.length >= 2) {
      recAway = { w: +recs[0][1], l: +recs[0][2] };
      recHome = { w: +recs[1][1], l: +recs[1][2] };
      break;
    }
  }
  // fallback: título "GANADOR n, PERDEDOR n" — pero necesitamos away/home del nombre de archivo
  return { date: dateShort, dateIso, away: '', home: '', scoreAway: 0, scoreHome: 0, innings: 0, recAway, recHome, _rows: scoreRows } as BsGame & { _rows: { team: string; r: number }[] };
}

// ---------------------------------------------------------- página de jugador
function cellsOf(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)) {
    out.push(m[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
  }
  return out;
}

const isDate = (s: string) => /^\d{2}-\d{2}-\d{2}$/.test(s);
const num = (s: string) => (s === '' || s === '--' ? 0 : Number(s.replace(',', '.')) || 0);

const BAT_COLS = ['ab', 'r', 'h', 'rbi', 'doubles', 'triples', 'hr', 'bb', 'k', 'sb', 'ar', 'hbp', 'sac', 'sf', 'ibb', 'gdp', 'rlsp', 'lob', 'rc', 'ba', 'slg', 'obp'];
// Dec IP CP CL H 2B 3B HR BB K HB WP BK SH SF DPI BR/6 TBF OBA OSLG OOBP ERA
const PIT_COLS = ['dec', 'ip', 'r', 'er', 'h', 'doubles', 'triples', 'hr', 'bb', 'k', 'hb', 'wp', 'bk', 'sh', 'sf', 'dpi', 'br6', 'tbf', 'oba', 'oslg', 'oobp', 'era'];
// P A E/F/T TC DP PB RTO OSB G/P G/C G/1B G/2B  (eft = "f/t/total" compuesto)
const FLD_COLS = ['po', 'a', 'eft', 'tc', 'dp', 'pb', 'rto', 'osb', 'gp', 'gc', 'g1b', 'g2b'];

function parseLogSection(cells: string[], start: number, end: number, cols: string[]): { rows: Map<string, Record<string, number>>; dec: Map<string, string> } {
  const rows = new Map<string, Record<string, number>>();
  const dec = new Map<string, string>();
  let i = start;
  while (i < end) {
    if (!isDate(cells[i])) { i++; continue; }
    const date = cells[i];
    const opp = cells[i + 1] ?? '';
    const rec: Record<string, number> = { _opp: 0 };
    // guarda el rival en una clave especial
    rec.__opp = 0;
    (rec as Record<string, unknown>).__oppName = opp;
    let j = i + 2;
    for (let c = 0; c < cols.length && j < cells.length && !isDate(cells[j]); c++, j++) {
      const col = cols[c], v = cells[j];
      if (col === 'dec') { if (v) dec.set(date + '|' + opp, v); (rec as Record<string, unknown>).__dec = v; continue; }
      if (col === 'pos') { (rec as Record<string, unknown>).__pos = v; continue; }
      if (col === 'eft') { const parts = v.split('/'); rec.e = num(parts[parts.length - 1] ?? '0'); continue; }
      if (/^[-\d.]+$/.test(v) || v === '') rec[col] = num(v);
      else if (col !== 'dec' && col !== 'pos') break; // columna no numérica → fin de fila real
    }
    rows.set(date + '|' + opp, rec);
    i = j;
  }
  return { rows, dec };
}

function parsePlayerPage(html: string): PlayerLog | null {
  // encabezado: "APELLIDO , NOMBRE" + "EQUIPO" + "Bats: R Throws: R Pos: P CF DH"
  const mHead = html.match(/<font[^>]*>\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ '.\-]+)\s*,\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑ '.\-]+)\s*<\/font>/i)
    ?? html.match(/>\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ '.\-]+)\s*,\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑ '.\-]+)\s*</i);
  const mTeam = html.match(/>([A-ZÁÉÍÓÚÑ ]{3,})<BR>\s*Bats/i);
  const mB = html.match(/Bats:\s*([LRS])/i), mT = html.match(/Throws:\s*([LR])/i), mP = html.match(/Pos:\s*([^<]+)</i);
  if (!mHead) return null;
  const lastName = title(mHead[1].trim()), firstName = title(mHead[2].trim());
  const pl: PlayerLog = {
    team: mTeam ? mTeam[1].trim() : '',
    name: `${firstName} ${lastName}`.replace(/\s+/g, ' ').trim(),
    firstName, lastName,
    bats: mB?.[1], throws: mT?.[1],
    pos: mP ? mP[1].trim().split(/\s+/).filter(Boolean) : [],
    bat: new Map(), pit: new Map(), fld: new Map(), dec: new Map(),
  };
  const cells = cellsOf(html);
  // secciones por ancla: <a name="bat"> <a name="pit"> <a name="fld">
  const batAt = cells.findIndex((c) => /Batting by Game/i.test(c));
  const pitAt = cells.findIndex((c) => /Pitching by Game/i.test(c));
  const fldAt = cells.findIndex((c) => /Fielding by Game/i.test(c));
  // tras el encabezado de columnas, las filas empiezan con la fecha
  // cada sección se acota hasta la siguiente para no pisar filas con la misma fecha
  const bound = (at: number) => [pitAt, fldAt].filter((x) => x > at).concat(cells.length).sort((a, b) => a - b)[0];
  if (batAt >= 0) { const r = parseLogSection(cells, batAt, bound(batAt), BAT_COLS); pl.bat = r.rows; }
  if (pitAt >= 0) { const r = parseLogSection(cells, pitAt, bound(pitAt), PIT_COLS); pl.pit = r.rows; for (const [k, v] of r.dec) pl.dec.set(k, v); }
  if (fldAt >= 0) { const r = parseLogSection(cells, fldAt, bound(fldAt), FLD_COLS); pl.fld = r.rows; }
  return pl;
}

// ------------------------------------------------------------------ .cmp.txt
// Reporte comprensivo por juego: secciones "EQUIPO Batting/Pitching/Fielding"
// con una línea por jugador (apellido solamente). Cuando BallStat pierde las
// estadísticas de un jugador (su log WebBuilder queda en ceros), el .cmp sigue
// teniendo sus líneas reales → es la fuente de recuperación.
interface CmpRow { surname: string; nums: number[] }
interface CmpData { bat: Map<string, CmpRow[]>; pit: Map<string, CmpRow[]>; fld: Map<string, CmpRow[]> }

const surKey = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ');

function parseCmp(txt: string): CmpData {
  const data: CmpData = { bat: new Map(), pit: new Map(), fld: new Map() };
  const lines = rtfToLines(txt);
  let team = '', sec: 'bat' | 'pit' | 'fld' | '' = '';
  let pendingName: string | null = null;
  for (const raw of lines) {
    const l = raw.replace(/\\/g, '');
    const secM = l.match(/^\s*([A-ZÁÉÍÓÚÑ .]{3,}?)\s+(Batting|Pitching|Fielding)\s*$/);
    if (secM) { team = secM[1].trim(); sec = secM[2] === 'Batting' ? 'bat' : secM[2] === 'Pitching' ? 'pit' : 'fld'; pendingName = null; continue; }
    if (/^\s*Totals/i.test(l)) { sec = ''; pendingName = null; continue; }
    if (!sec) continue;
    if (/^\s*Player|--/.test(l)) continue;
    // "APELLIDO" solo → los números vienen en la siguiente línea
    const solo = l.match(/^\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .]{2,})\s*$/);
    if (solo) { pendingName = solo[1].trim(); continue; }
    // "APELLIDO 3 2 1 …" o línea de números (apellido pendiente)
    const both = l.match(/^\s*([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .]{2,}?)\s+([\d.][\d .]*)\s*$/);
    let name: string | null = null; let numsStr = '';
    if (both) { name = both[1].trim(); numsStr = both[2]; }
    else if (pendingName && /^\s*[\d.]/.test(l)) { name = pendingName; numsStr = l; }
    if (name && numsStr) {
      const nums = numsStr.trim().split(/\s+/).map((v) => Number(v) || 0);
      const rows = data[sec].get(team) ?? [];
      rows.push({ surname: name, nums });
      data[sec].set(team, rows);
      pendingName = null;
    }
  }
  return data;
}

const normUpper = (s: string) => s.toUpperCase().replace(/\s+/g, ' ').trim();

// índices de columnas .cmp → campos pox
// Batting:  PA AB R H RBI BB SO KL 2B 3B HR … SB CS SH SF HBP …
const CMP_BAT: [idx: number, field: string][] = [
  [0, 'pa'], [1, 'ab'], [2, 'r'], [3, 'h'], [4, 'rbi'], [5, 'bb'], [6, 'k'],
  [8, 'doubles'], [9, 'triples'], [10, 'hr'], [15, 'sb'], [17, 'sac'], [18, 'sf'], [19, 'hbp'],
];
// Pitching: IP H R ER BB IB SO 2B 3B HR HB WP BK AB DI PK SA CS DP IR IRS BF …
const CMP_PIT: [idx: number, field: string][] = [
  [1, 'pH'], [2, 'pR'], [3, 'pER'], [4, 'pBB'], [6, 'pK'], [9, 'pHR'], [10, 'hbp'], [21, 'bf'],
];
// Fielding: IN P A FE TE PB RTO OSB → po/a/e (e = FE+TE)

const batIsZero = (r: Record<string, unknown>) =>
  !(Number(r.ab) || Number(r.h) || Number(r.r) || Number(r.rbi) || Number(r.bb) || Number(r.k) || Number(r.hbp));
const pitIsZero = (r: Record<string, unknown>) => !(Number(r.pOuts) || Number(r.pH) || Number(r.bf));
const fldIsZero = (r: Record<string, unknown>) => !(Number(r.po) || Number(r.a) || Number(r.e));

/**
 * Para un juego y un equipo: cruza las líneas del .cmp con las filas stats[]
 * de los jugadores (apellido → jugador). Primera pasada: filas que ya coinciden
 * con el .cmp quedan como están; las filas en cero (datos perdidos) se rellenan
 * con la línea sobrante del .cmp; las líneas .cmp sin fila se asignan al jugador
 * del apellido que no tenga fila (p.ej. partidos que desaparecieron de su log).
 */
const outsOf = (ip: number) => Math.floor(ip) * 3 + Math.round((ip - Math.floor(ip)) * 10);

function recoverSection(
  cmpRows: CmpRow[], playersOfTeam: PlayerLog[], statsRows: Map<PlayerLog, Record<string, unknown>>,
  apply: (row: Record<string, unknown>, nums: number[]) => void,
  matches: (row: Record<string, unknown>, nums: number[]) => boolean,
  isZero: (r: Record<string, unknown>) => boolean,
  field: 'bateo' | 'pitcheo' | 'fildeo', ctx: string, warn: string[],
): void {
  const bySur = new Map<string, CmpRow[]>();
  for (const r of cmpRows) {
    const k = surKey(r.surname);
    bySur.set(k, [...(bySur.get(k) ?? []), r]);
  }
  for (const [sur, rows] of bySur) {
    const cands = playersOfTeam.filter((pl) => surKey(pl.lastName) === sur);
    if (!cands.length) { warn.push(`${ctx}: "${sur}" sin jugador en plantilla → ${field} omitido`); continue; }
    const used = new Set<CmpRow>(); const filled = new Set<PlayerLog>();
    // 1 · coincidencia exacta: la fila existente ya trae los mismos números
    for (const r of rows) {
      const hit = cands.find((pl) => {
        const s = statsRows.get(pl);
        return s && !filled.has(pl) && !isZero(s) && matches(s, r.nums);
      });
      if (hit) { used.add(r); filled.add(hit); }
    }
    // 2 · las líneas .cmp restantes rellenan filas en cero o crean las ausentes
    for (const r of rows) {
      if (used.has(r)) continue;
      // preferir quien tiene fila en cero (estuvo en el juego), luego el ausente
      const zero = cands.find((pl) => !filled.has(pl) && statsRows.has(pl) && isZero(statsRows.get(pl)!));
      const absent = cands.find((pl) => !filled.has(pl) && !statsRows.has(pl));
      const pl = zero ?? absent;
      if (!pl) { warn.push(`${ctx}: línea ${field} de ${sur} sin jugador a quien asignar`); continue; }
      let s = statsRows.get(pl);
      if (!s) { s = { player: pl.name, team: pl.team, g: 1, pa: 0, ab: 0, r: 0, h: 0, rbi: 0, bb: 0, k: 0, hbp: 0, sac: 0, sf: 0, sb: 0, doubles: 0, triples: 0, hr: 0, gp: 0, pOuts: 0, pH: 0, pR: 0, pER: 0, pBB: 0, pK: 0, pHR: 0, pPitches: 0, bf: 0, po: 0, a: 0, e: 0 }; statsRows.set(pl, s); }
      apply(s, r.nums);
      used.add(r); filled.add(pl);
    }
    if (cands.length > 1 && rows.length > 1 && rows.some((r) => !used.has(r)))
      warn.push(`${ctx}: ${sur} tiene ${cands.length} jugadores homónimos — revisar asignación ${field}`);
  }
}

// ---------------------------------------------------------------------- main
export interface BallstatFolderResult {
  pox: Record<string, unknown>;
  warnings: string[];
  games: number; players: number; teams: string[];
}

export interface BallstatMerge { name: string; team: string }

/** Convierte una carpeta BallStat extraída (con "BallScore Reports" + "WebBuilder") a pox-import/1.
 *  opts.merges: jugadores confirmados como la MISMA persona en varios equipos → un solo registro
 *  bajo `team` (sus líneas de juego conservan el equipo con el que jugó ese día). */
export function convertBallstatFolder(dir: string, opts?: { merges?: BallstatMerge[] }): BallstatFolderResult {
const leagueName = path.basename(dir).replace(/_/g, ' ');

// 1 · juegos desde .box.txt
const boxDir = path.join(dir, 'BallScore Reports');
const games: BsGame[] = [];
const FN_RE = /^(\d{2}-\d{2}-\d{2})[a-z]?\s+(.+?)\s+at\s+(.+?)\.box\.txt$/i; // [a-z]? = dobleheader 09-18-22a / 09-18-22b
for (const f of fs.readdirSync(boxDir).filter((f) => f.endsWith('.box.txt'))) {
  const m = f.match(FN_RE);
  const txt = fs.readFileSync(path.join(boxDir, f), 'utf8');
  const parsed = parseBox(txt);
  if (!parsed || !m) continue;
  const g = parsed as BsGame & { _rows?: { team: string; r: number }[] };
  // decisiones del pie: "WP- APELLIDO n, APELLIDO;" — la línea se envuelve y
  // puede traer varios apellidos; el real se resuelve contra el lado ganador
  const joined = rtfToLines(txt).join(' ');
  const grabDec = (tag: string): string[] => {
    const m = joined.match(new RegExp(`\\b${tag}-\\s*([^;]{1,80})`));
    if (!m) return [];
    return m[1].split(/[\d,()\/]+/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => /^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .]{1,}$/.test(s));
  };
  g.wpSurs = grabDec('WP');
  g.svSurs = grabDec('S');
  // decisiones en línea del bloque de pitcheo: "GERMAN(L 0-2) 3.2 8 8 …" / "CHALAS(W 1-0) 5.1 …"
  // nombre = ≤3 palabras mayúsculas pegadas al paréntesis (la cabecera "…SO ERA"
  // también es mayúscula → puede colarse; se resuelve por sufijo en applyDec)
  g.decW = []; g.decL = []; g.decS = [];
  for (const dm of joined.matchAll(/\b([A-ZÁÉÍÓÚÑ]{2,}(?: +[A-ZÁÉÍÓÚÑ]{2,}){0,2})\((W|L|S|SV)\s*\d+-\d+\)/g)) {
    const sur = dm[1].replace(/\s+/g, ' ').trim();
    if (dm[2] === 'W') g.decW.push(sur);
    else if (dm[2] === 'L') g.decL.push(sur);
    else g.decS.push(sur);
  }
  // el nombre de archivo siempre trae MM-DD-YY fiable — respaldo si el RTF falla
  if (!g.date) {
    g.date = m[1];
    g.dateIso = `20${m[1].slice(6)}-${m[1].slice(0, 2)}-${m[1].slice(3, 5)}`;
  }
  g.away = title(m[2].trim()); g.home = title(m[3].trim());
  if (g._rows?.length === 2) {
    // el linescore lista visita primero; confirmar por nombre y asignar
    const up = (s: string) => s.toUpperCase();
    if (up(g._rows[0].team).includes(up(g.away)) || up(g.away).includes(up(g._rows[0].team))) {
      g.scoreAway = g._rows[0].r; g.scoreHome = g._rows[1].r;
    } else {
      g.scoreAway = g._rows[1].r; g.scoreHome = g._rows[0].r;
    }
  }
  games.push(g);
}
console.log(`juegos .box.txt: ${games.length}`);

// 2 · jugadores desde WebBuilder — o fichas sintéticas por APELLIDO cuando
// el paquete solo trae reportes (.box/.cmp): el .cmp conserva las líneas por
// juego pero con apellido solo → se crea "Apellido" (y "Apellido (n)" cuando
// un juego muestra el mismo apellido varias veces en el mismo equipo).
const wbDir = path.join(dir, 'WebBuilder');
const players: PlayerLog[] = [];
const warn: string[] = [];
if (fs.existsSync(wbDir)) {
  for (const f of fs.readdirSync(wbDir).filter((f) => f.endsWith('.htm') && !f.includes('_opp') && !f.includes('_pit') && !f.includes('month') && !f.includes('cap') && !f.includes('leader') && !f.startsWith('index') && !f.startsWith('standings'))) {
    const pl = parsePlayerPage(fs.readFileSync(path.join(wbDir, f), 'utf8'));
    if (pl && pl.team && (pl.bat.size || pl.pit.size)) players.push(pl);
  }
  console.log(`jugadores WebBuilder: ${players.length}`);
} else {
  const maxPer = new Map<string, Map<string, number>>(); // team → apellido → máx filas en un juego
  for (const f of fs.readdirSync(boxDir).filter((f) => f.endsWith('.cmp.txt'))) {
    const cmp = parseCmp(fs.readFileSync(path.join(boxDir, f), 'utf8'));
    for (const sec of [cmp.bat, cmp.pit, cmp.fld]) {
      for (const [team, rows] of sec) {
        const t = normUpper(team);
        let tm = maxPer.get(t);
        if (!tm) { tm = new Map(); maxPer.set(t, tm); }
        const perSur = new Map<string, number>();
        for (const r of rows) perSur.set(surKey(r.surname), (perSur.get(surKey(r.surname)) ?? 0) + 1);
        for (const [sur, n] of perSur) tm.set(sur, Math.max(tm.get(sur) ?? 0, n));
      }
    }
  }
  for (const [team, surs] of maxPer) {
    for (const [sur, n] of [...surs.entries()].sort()) {
      for (let i = 1; i <= n; i++) {
        players.push({
          team, name: title(sur) + (i > 1 ? ` (${i})` : ''),
          firstName: title(sur), lastName: sur, pos: [],
          bat: new Map(), pit: new Map(), fld: new Map(), dec: new Map(),
        });
      }
    }
  }
  console.log(`jugadores por apellido (.cmp): ${players.length}`);
  warn.push('paquete sin WebBuilder → jugadores por APELLIDO; los "(n)" son homónimos del mismo equipo — revisar asignación al importar');
}

// 2b · Rosters/*.ros — roster nativo de BallScore (binario de registros fijos):
// jugadores que NO tienen página WebBuilder quedan con NOMBRE COMPLETO en vez
// de perder sus líneas. Layout observado: encabezado con nombre del equipo y
// luego registros de 115 bytes: firstName[30] + lastName[30] + datos. El
// apellido puede traer prefijo 'r' (jugador removido del roster) → se limpia.
const ROS_REC = 115, ROS_FN = 30, ROS_LN = 30;
const rosDir = path.join(dir, 'Rosters');
if (fs.existsSync(rosDir)) {
  const seen = new Set(players.map((p) => normUpper(`${p.team}|${p.name}`)));
  let added = 0;
  const cleanName = (s: string) => s.replace(/^r(?=[A-ZÁÉÍÓÚÑ])/, '').replace(/\s+/g, ' ').trim();
  const NAME_RE = /^[A-ZÁÉÍÓÚÑa-záéíóúñ][A-ZÁÉÍÓÚÑa-záéíóúñ'.\s\-]*$/;
  const field = (buf: Buffer, off: number, len: number) => {
    const end = buf.indexOf(0, off);
    return buf.toString('latin1', off, end < 0 || end > off + len ? off + len : end).trim();
  };
  const firstStr = (buf: Buffer) => {
    const m = buf.toString('latin1', 0, Math.min(buf.length, 400)).match(/[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑa-záéíóúñ .]{2,}/);
    return m ? m[0].trim() : '';
  };
  for (const f of fs.readdirSync(rosDir).filter((f) => /\.ros$/i.test(f))) {
    const buf = fs.readFileSync(path.join(rosDir, f));
    const team = firstStr(buf); // encabezado: nombre del equipo
    // el primer registro puede variar de offset según el encabezado →
    // probar inicios y quedarse el que rinda ≥3 pares nombre/apellido válidos
    let start = -1;
    for (let s = 200; s < 400 && start < 0; s++) {
      let n = 0;
      for (let off = s; off + ROS_FN + ROS_LN <= buf.length && n < 40; off += ROS_REC) {
        const fn = cleanName(field(buf, off, ROS_FN));
        const ln = cleanName(field(buf, off + ROS_FN, ROS_LN));
        if (fn && ln && NAME_RE.test(fn) && NAME_RE.test(ln)) n++;
        else break;
      }
      if (n >= 3) start = s;
    }
    if (start < 0) { warn.push(`Rosters/${f}: no se pudo leer el roster`); continue; }
    for (let off = start; off + ROS_FN + ROS_LN <= buf.length; off += ROS_REC) {
      const fn = cleanName(field(buf, off, ROS_FN));
      const ln = cleanName(field(buf, off + ROS_FN, ROS_LN));
      if (!(fn && ln && NAME_RE.test(fn) && NAME_RE.test(ln))) break;
      const name = title(`${fn} ${ln}`);
      const key = normUpper(`${team}|${name}`); // misma persona en 2 rosters = 2 fichas (traspaso se funde al importar)
      if (seen.has(key)) continue;
      seen.add(key);
      players.push({
        team, name, firstName: title(fn), lastName: title(ln), pos: [],
        bat: new Map(), pit: new Map(), fld: new Map(), dec: new Map(),
      });
      added++;
    }
  }
  if (added) console.log(`jugadores solo en roster (.ros): ${added}`);
}
// 3 · equipos conocidos del .box + normalización de nombre (los .htm vienen en MAYUS)
const teamNames = [...new Set(games.flatMap((g) => [g.home, g.away]))];
const normTeam = (t: string) =>
  teamNames.find((n) => n.toUpperCase() === t.trim().toUpperCase()) ?? title(t.trim());
const slugToTeam = new Map<string, string>();
for (const t of teamNames) {
  slugToTeam.set(t.replace(/\s+/g, '_').toLowerCase(), t);
  // abreviatura de 3 letras que usa el log (@CAJ, CAJ)
  const noArt = t.replace(/^(el|la|los|las)\s+/i, '');
  const abbr = noArt.slice(0, 3).toUpperCase();
  slugToTeam.set('@' + abbr, t); slugToTeam.set(abbr, t);
}
// más formas de abreviar que usan los logs: cada palabra (DUN, BAH, MAN),
// iniciales (LD, AB) y 1ª letra + 2 consonantes de la última palabra (LDN).
// Solo se registran alias que no colisionen con otro equipo.
{
  const aliasOwner = new Map<string, string>();
  const tryAlias = (alias: string, team: string) => {
    if (!alias || alias.length < 2) return;
    const cur = aliasOwner.get(alias);
    if (cur === undefined) { aliasOwner.set(alias, team); return; }
    if (cur !== team) aliasOwner.set(alias, ''); // colisión → no mapear a nadie
  };
  for (const t of teamNames) {
    const words = t.split(/\s+/);
    const noArtWords = words.filter((w) => !/^(el|la|los|las|de|del)$/i.test(w));
    for (const w of noArtWords) tryAlias(w.slice(0, 3).toUpperCase(), t);
    if (words.length > 1) {
      tryAlias(words.map((w) => w[0]).join('').toUpperCase(), t); // iniciales: AB
      // 2 letras de la 1ª palabra + inicial de las demás: Arroyo Bahia→ARB
      tryAlias(noArtWords[0].slice(0, 2).toUpperCase() + noArtWords.slice(1).map((w) => w[0].toUpperCase()).join(''), t);
      // incl. artículo como 2 letras: Las Dunas→LAD
      tryAlias(words[0].slice(0, 2).toUpperCase() + words.slice(1).map((w) => w[0].toUpperCase()).join(''), t);
    }
    if (noArtWords.length > 1) {
      const last = noArtWords[noArtWords.length - 1].toUpperCase();
      const cons = last.replace(/[AEIOU]/g, '').slice(0, 2);
      tryAlias(t.trim()[0].toUpperCase() + cons, t); // 1ª letra + consonantes última palabra
    }
    // con artículo + una sola palabra: letra del artículo + consonantes (Las Dunas→LDN)
    if (/^(el|la|los|las)\s+/i.test(t) && noArtWords.length === 1) {
      const cons = noArtWords[0].toUpperCase().replace(/[AEIOU]/g, '').slice(0, 2);
      tryAlias(t.trim()[0].toUpperCase() + cons, t);
    }
  }
  for (const [alias, team] of aliasOwner) {
    if (!team) continue; // alias ambiguo entre equipos
    slugToTeam.set('@' + alias, team); slugToTeam.set(alias, team);
  }
}
console.log('equipos:', teamNames.join(' | '));
for (const pl of players) pl.team = normTeam(pl.team);

// 4 · cruzar logs con juegos: clave DIRIGIDA = fecha + local + visita —
// sin dirección un dobleheader (mismo día, misma pareja, local invertido)
// mezclaba las líneas de los dos juegos en uno solo.
const gameKey = (date: string, home: string, away: string) => `${date}|${home}|${away}`;
const gameMap = new Map<string, BsGame & { stats: Record<string, unknown>[]; synth?: boolean }>();
for (const g of games) {
  gameMap.set(gameKey(g.date, g.home, g.away), Object.assign(g, { stats: [] }));
}

for (const pl of players) {
  const keys = new Set([...pl.bat.keys(), ...pl.pit.keys()]);
  for (const k of keys) {
    const [date, oppCell] = k.split('|');
    const oppName = oppCell.replace(/^@/, '');
    const opp = slugToTeam.get(oppName)
      ?? slugToTeam.get(oppCell.replace(/^@/, '').toLowerCase())
      ?? slugToTeam.get(oppName.trim().toLowerCase().replace(/[\s-]+/g, '_')); // "Las Dunas" → las_dunas
    if (!opp) { warn.push(`${pl.name}: rival "${oppCell}" no mapea a equipo`); continue; }
    // '@' en el log = juego DE VISITA para mi equipo
    const away = oppCell.startsWith('@') ? pl.team : opp;
    const home = oppCell.startsWith('@') ? opp : pl.team;
    const key = gameKey(date, home, away);
    let g = gameMap.get(key);
    if (!g) {
      // juego sin .box.txt (04-19: no se exportó) — se sintetiza; marcador = suma de 'r' por equipo
      const [mo, dy, yy] = date.split('-');
      g = { date, dateIso: `20${yy}-${mo}-${dy}`, away, home, scoreAway: 0, scoreHome: 0, innings: 0, stats: [], synth: true } as BsGame & { stats: Record<string, unknown>[]; synth?: boolean };
      gameMap.set(key, g);
      games.push(g);
    }
    const b = pl.bat.get(k) as Record<string, number> | undefined;
    const p = pl.pit.get(k) as Record<string, number> | undefined;
    const f = pl.fld.get(k) as Record<string, number> | undefined;
    const dec = pl.dec.get(k) ?? '';
    const ab = b?.ab ?? 0, bb = b?.bb ?? 0, hbp = b?.hbp ?? 0, sac = b?.sac ?? 0, sf = b?.sf ?? 0;
    const ip = p?.ip ?? 0;
    const pOuts = Math.floor(ip) * 3 + Math.round((ip - Math.floor(ip)) * 10);
    const row: Record<string, unknown> = {
      player: pl.name, team: pl.team,
      g: 1, pa: ab + bb + hbp + sac + sf, ab, r: b?.r ?? 0, h: b?.h ?? 0,
      doubles: b?.doubles ?? 0, triples: b?.triples ?? 0, hr: b?.hr ?? 0,
      rbi: b?.rbi ?? 0, bb, k: b?.k ?? 0, hbp, sac, sf, sb: b?.sb ?? 0,
      gp: p ? 1 : 0,
      pOuts, pH: p?.h ?? 0, pR: p?.r ?? 0, pER: p?.er ?? 0,
      pBB: p?.bb ?? 0, pK: p?.k ?? 0, pHR: p?.hr ?? 0, pPitches: 0,
      bf: p?.tbf ?? 0,
      po: f?.po ?? 0, a: f?.a ?? 0, e: f?.e ?? 0,
    };
    if (/^w/i.test(dec) || /^G$/.test(dec)) row.w = 1;
    else if (/^l/i.test(dec) || /^P$/.test(dec)) row.l = 1;
    if (/^s/i.test(dec) || /^J$/.test(dec)) row.sv = 1;
    g.stats.push(row);
  }
}

// 4b · recuperación desde .cmp.txt: los reportes por juego conservan las líneas
// que las fichas WebBuilder traen borradas (apellidos en cero / juegos ausentes)
type ConvGame = BsGame & { stats: Record<string, unknown>[]; synth?: boolean };
const statsRowByPlayer = new Map<ConvGame, Map<PlayerLog, Record<string, unknown>>>();
for (const g of games as ConvGame[]) {
  const m = new Map<PlayerLog, Record<string, unknown>>();
  for (const s of g.stats) {
    const pl = players.find((p) => p.name === s.player && p.team === s.team);
    if (pl) m.set(pl, s);
  }
  statsRowByPlayer.set(g, m);
}
const cmpDir = path.join(dir, 'BallScore Reports');
for (const f of fs.readdirSync(cmpDir).filter((f) => f.endsWith('.cmp.txt'))) {
  const m = f.match(/^(\d{2}-\d{2}-\d{2})[a-z]?\s+(.+?)\s+at\s+(.+?)\.cmp\.txt$/i);
  if (!m) continue;
  const g = gameMap.get(gameKey(m[1], title(m[3].trim()), title(m[2].trim()))) as ConvGame | undefined;
  if (!g) continue;
  const cmp = parseCmp(fs.readFileSync(path.join(cmpDir, f), 'utf8'));
  const sRows = statsRowByPlayer.get(g)!;
  for (const side of [g.away, g.home]) {
    const teamPlayers = players.filter((pl) => pl.team === side);
    const ctx = `${g.date} ${side}`;
    const bat = [...cmp.bat.entries()].find(([t]) => normUpper(t) === normUpper(side))?.[1];
    const pit = [...cmp.pit.entries()].find(([t]) => normUpper(t) === normUpper(side))?.[1];
    const fld = [...cmp.fld.entries()].find(([t]) => normUpper(t) === normUpper(side))?.[1];
    if (bat) recoverSection(bat, teamPlayers, sRows,
      (s, n) => { for (const [i, f2] of CMP_BAT) s[f2] = n[i] ?? 0; },
      (s, n) => n[1] === Number(s.ab) && n[3] === Number(s.h) && n[4] === Number(s.rbi),
      batIsZero, 'bateo', ctx, warn);
    if (pit) recoverSection(pit, teamPlayers, sRows,
      (s, n) => { s.pOuts = outsOf(n[0] ?? 0); s.gp = 1; for (const [i, f2] of CMP_PIT) if (f2 !== 'hbp') s[f2] = n[i] ?? 0; },
      (s, n) => outsOf(n[0] ?? 0) === Number(s.pOuts) && n[1] === Number(s.pH),
      pitIsZero, 'pitcheo', ctx, warn);
    if (fld) recoverSection(fld, teamPlayers, sRows,
      (s, n) => { s.po = n[1] ?? 0; s.a = n[2] ?? 0; s.e = (n[3] ?? 0) + (n[4] ?? 0); },
      (s, n) => n[1] === Number(s.po) && n[2] === Number(s.a),
      fldIsZero, 'fildeo', ctx, warn);
  }
}
// filas creadas por la recuperación (jugadores sin línea previa en el juego)
for (const g of games as ConvGame[]) {
  const have = new Set(g.stats);
  for (const s of statsRowByPlayer.get(g)!.values()) if (!have.has(s)) g.stats.push(s);
}

// decisiones de pitcheo: primero las marcas en línea "APELLIDO(W/L/S w-l)"
// del bloque de pitcheo; el pie "WP-/S-" queda de respaldo. Solo si el juego
// no trae ya esa decisión (los logs WebBuilder la marcan).
for (const g of games as ConvGame[]) {
  const sRows = statsRowByPlayer.get(g);
  if (!sRows || (!g.decW?.length && !g.decL?.length && !g.decS?.length && !g.wpSurs?.length && !g.svSurs?.length)) continue;
  const winSide = g.scoreHome > g.scoreAway ? g.home : g.scoreAway > g.scoreHome ? g.away : null;
  const loseSide = g.scoreHome > g.scoreAway ? g.away : g.scoreAway > g.scoreHome ? g.home : null;
  const applyDec = (surs: string[] | undefined, field: 'w' | 'l' | 'sv', side: string | null) => {
    if (!surs?.length || !side) return;
    if ([...sRows.values()].some((s) => Number(s[field]))) return;
    for (const sur of surs) {
      const cands = [...sRows.entries()].filter(([pl]) =>
        pl.team === side &&
        (surKey(pl.lastName) === surKey(sur) || surKey(sur).endsWith(' ' + surKey(pl.lastName))));
      const pick = cands.find(([, s]) => Number(s.pOuts) > 0 || Number(s.gp) > 0) ?? cands[0];
      if (pick) { pick[1][field] = 1; return; }
    }
    // apellido anotado no aparece → pitcher de más outs del lado correspondiente
    const pitchers = [...sRows.entries()].filter(([pl, s]) => pl.team === side && Number(s.pOuts) > 0);
    pitchers.sort((a, b) => Number(b[1].pOuts) - Number(a[1].pOuts));
    if (pitchers[0]) {
      pitchers[0][1][field] = 1;
      warn.push(`${g.date}: ${field.toUpperCase()} "${surs.join('/')}" no aparece → se asignó a ${pitchers[0][0].name} (${side}, más outs)`);
    } else {
      warn.push(`${g.date}: ${field.toUpperCase()} "${surs.join(', ')}" sin ficha ni pitcher en ${side}`);
    }
  };
  applyDec(g.decW, 'w', winSide);
  applyDec(g.decL, 'l', loseSide);
  applyDec(g.decS, 'sv', winSide);
  applyDec(g.wpSurs, 'w', winSide);
  applyDec(g.svSurs, 'sv', winSide);
}

// marcador de juegos sintetizados = suma de carreras de sus bateadores
for (const g of games as ConvGame[]) {
  if (!g.synth) continue;
  for (const s of g.stats) {
    if (s.team === g.away) g.scoreAway += Number(s.r ?? 0);
    else if (s.team === g.home) g.scoreHome += Number(s.r ?? 0);
  }
  warn.push(`juego sin boxscore: ${g.date} ${g.away} @ ${g.home} → marcador sintetizado ${g.scoreAway}-${g.scoreHome} desde logs`);
}

// 4.5 · postemporada: el récord (W-L) del encabezado se REINICIA al arrancar
// cada fase (semis, final) — la señal real es que la SUMA w+l BAJA respecto al
// récord anterior del equipo (de ~30 a 1). Comparar contra juegos jugados da
// falsos positivos (w+l <= jugados casi siempre es cierto). Cada caída abre
// una fase nueva. El nombre de la carpeta como pista ("SEMIFINAL25"→Semifinal,
// "FINAL25"→Final) manda sobre lo detectado — bases separadas por fase.
games.sort((a, b) => a.dateIso.localeCompare(b.dateIso));
// post = COLA del calendario donde juegan menos equipos que la liga tiene
// (regular: todos los equipos por jornada; semis/final: solo una pareja).
// Dentro del post, la caída del récord (w+l baja >=3 del máximo) marca el
// arranque de la siguiente fase — robusto al desorden de dobleheaders.
const teamCount = teamNames.length;
const byDate = new Map<string, Set<string>>();
for (const g of games) {
  const ds = byDate.get(g.dateIso) ?? new Set<string>();
  ds.add(g.away); ds.add(g.home); byDate.set(g.dateIso, ds);
}
const dates = [...byDate.keys()].sort();
let postFrom: string | null = null;
for (let i = dates.length - 1; i >= 0; i--) {
  if ((byDate.get(dates[i])?.size ?? 0) < teamCount) postFrom = dates[i];
  else break;
}
const maxSum = new Map<string, number>();
const phaseOf = new Map<BsGame, number>();
// suma w+l que cae >=3 del máximo = récord reiniciado → nueva base del equipo
const updSum = (t: string, s: number | null): boolean => {
  if (s == null) return false;
  const mx = maxSum.get(t) ?? 0;
  if (mx - s >= 3) { maxSum.set(t, s); return true; }
  if (s > mx) maxSum.set(t, s);
  return false;
};
let postPhase = 0; let sawPost = false;
for (const g of games) {
  const sumA = g.recAway ? g.recAway.w + g.recAway.l : null;
  const sumH = g.recHome ? g.recHome.w + g.recHome.l : null;
  if (postFrom && g.dateIso >= postFrom) {
    const dA = updSum(g.away, sumA); const dH = updSum(g.home, sumH); // sin || : ambos reinician base
    if (!sawPost) { sawPost = true; postPhase = 1; }   // el primer reset ES la fase 1
    else if (dA || dH) postPhase++;                    // siguiente reset = nueva fase
    phaseOf.set(g, postPhase);
  } else {
    updSum(g.away, sumA); updSum(g.home, sumH);
  }
}
const dirHint = /semifinal|semi/i.test(leagueName) ? 'Semifinal'
  : /final/i.test(leagueName) ? 'Final'
  : /playoff|post|serie/i.test(leagueName) ? 'Postemporada' : null;
interface SeriesRun { home: string; away: string; games: BsGame[]; wins: Map<string, number> }
// Una pareja de equipos POR FASE = UNA serie (en un bracket una pareja no se
// repite dentro de la misma fase), aunque se intercalen en el calendario.
// Orden de rondas = cuándo TERMINA cada serie: la última es siempre la Final.
const byPair = new Map<string, SeriesRun>();
for (const g of games) {
  const ph = dirHint ? 1 : (phaseOf.get(g) ?? 0);
  if (!ph) continue;
  const pair = `${ph}|${[g.away, g.home].sort().join('|')}`;
  let sr = byPair.get(pair);
  if (!sr) { sr = { home: g.home, away: g.away, games: [], wins: new Map() }; byPair.set(pair, sr); }
  sr.games.push(g);
  const winT = g.scoreHome > g.scoreAway ? g.home : g.scoreAway > g.scoreHome ? g.away : '';
  if (winT) sr.wins.set(winT, (sr.wins.get(winT) ?? 0) + 1);
}
if (dirHint) for (const sr of byPair.values()) for (const g of sr.games) g.series = dirHint;
const seriesRuns: SeriesRun[] = [...byPair.values()]
  .sort((a, b) => (a.games.at(-1)?.dateIso ?? '').localeCompare(b.games.at(-1)?.dateIso ?? ''));
const seriesName = (i: number) =>
  i === seriesRuns.length - 1 ? 'Final'
    : seriesRuns.length <= 3 ? (seriesRuns.length === 3 ? `Semifinal ${i + 1}` : 'Semifinal')
    : i === seriesRuns.length - 2 ? 'Semifinal' : `Serie ${i + 1}`;
for (const [i, sr] of seriesRuns.entries()) {
  const name = dirHint ?? seriesName(i);
  for (const g of sr.games) g.series = name;
  const sorted = [...sr.wins.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length) warn.push(`postemporada: serie "${name}" ${sr.away} @ ${sr.home} → ${sorted.map(([t, w]) => `${t} ${w}`).join(' / ')}`);
}

// 5 · archivo pox
// merges: un jugador confirmado en varios equipos → una sola ficha bajo `team`
const merges = opts?.merges ?? [];
const mergedOut = new Set(
  players.filter((pl) => merges.some((mm) => mm.name.trim().toLowerCase() === pl.name.toLowerCase() && mm.team !== pl.team))
    .map((pl) => `${pl.name}|${pl.team}`),
);
for (const mm of merges) {
  if (!players.some((pl) => pl.name.toLowerCase() === mm.name.toLowerCase() && pl.team === mm.team))
    warn.push(`merge "${mm.name}" → ${mm.team}: no existe ficha en ese equipo`);
}
// año de temporada = el de la mayoría de juegos (playoffs que cruzan a enero
// no deben renombrar la temporada: 04-2024→01-2025 sigue siendo temporada 2024)
const yearCount = new Map<number, number>();
for (const g of games) yearCount.set(Number(g.dateIso.slice(0, 4)), (yearCount.get(Number(g.dateIso.slice(0, 4))) ?? 0) + 1);
const seasonYear = yearCount.size ? [...yearCount.entries()].sort((a, b) => b[1] - a[1])[0][0] : new Date().getFullYear();
const pox = {
  format: 'pox-import/1',
  league: title(leagueName),
  sport: 'softball',
  innings: 6,
  merges: merges.length ? merges : undefined,
  seasons: [{
    year: seasonYear, status: 'ACTIVE',
    teams: teamNames.map((t) => ({ name: t })),
    players: players.filter((pl) => !mergedOut.has(`${pl.name}|${pl.team}`)).map((pl) => ({
      name: pl.name, team: pl.team,
      bats: pl.bats, throws: pl.throws,
      pos: pl.pos.join(','),
    })),
    series: seriesRuns.map((sr, i) => {
      const sorted = [...sr.wins.entries()].sort((a, b) => b[1] - a[1]);
      return {
        name: seriesName(i), round: i + 1,
        home: sr.games[0].home, away: sr.games[0].away,
        winner: sorted.length && sorted[0][1] > (sorted[1]?.[1] ?? -1) ? sorted[0][0] : undefined,
        status: 'ENDED',
      };
    }),
    games: (games as ConvGame[]).map((g) => ({
      date: g.dateIso, away: g.away, home: g.home,
      scoreAway: g.scoreAway, scoreHome: g.scoreHome,
      series: g.series,
      stats: g.stats,
    })),
  }],
};

return { pox: pox as unknown as Record<string, unknown>, warnings: warn, games: games.length, players: players.length, teams: teamNames };
}

// ---------------------------------------------------- CLI: tsx conv-ballstat.ts <carpeta> [-o salida]
// solo corre como CLI cuando ESTE archivo es el punto de entrada — no al importarse
const isCli = !!process.argv[1] && /conv-ballstat/.test(process.argv[1]);
const cliDir = isCli ? process.argv[2] : undefined;
if (cliDir && fs.existsSync(cliDir)) {
  const outIdx = process.argv.indexOf('-o');
  const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;
  // --merge "Nombre Jugador|Equipo" (repetible): misma persona en varios equipos
  const merges: BallstatMerge[] = [];
  process.argv.forEach((a, i) => {
    if (a === '--merge' && process.argv[i + 1]) {
      const [name, team] = process.argv[i + 1].split('|').map((s) => s.trim());
      if (name && team) merges.push({ name, team });
    }
  });
  const r = convertBallstatFolder(cliDir, { merges });
  console.log(`juegos: ${r.games} · jugadores: ${r.players} · equipos: ${r.teams.join(' | ')}`);
  const json = JSON.stringify(r.pox, null, 1);
  if (outFile) { fs.writeFileSync(outFile, json); console.log(`escrito ${outFile} (${(json.length / 1024).toFixed(0)} KB)`); }
  else console.log(json.slice(0, 3000));
  console.log(`avisos: ${r.warnings.length}`); r.warnings.slice(0, 15).forEach((w) => console.log('  ⚠ ' + w));
} else if (isCli) {
  console.error('uso: npx tsx src/conv-ballstat.ts <carpeta BallStat> [-o salida.json]');
}
