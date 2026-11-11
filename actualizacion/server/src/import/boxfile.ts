/**
 * Parser de box score suelto de BallScore (".box.txt" — texto plano o RTF).
 * Importación de UN juego desde 🛡 Administración → Importar.
 *
 * DOS layouts soportados:
 *  A) Clásico BallScore (archivos reales): tabla de bateo a DOS COLUMNAS
 *     lado a lado — visitante a la izquierda, local a la derecha —
 *     "Player AB R H BI BB SO P A E LOB Ave" (BI=CI, P/A/E=fildeo inline),
 *     nombres por apellido + inicial opcional ("Díaz B.", "D'Los Santos"),
 *     posición en minúscula al final del nombre, líneascore "…R H E",
 *     suplementarios "2B-/3B-/HR-/RBI-/SB-/SF-/FE-/LOB-/RLSP-" con
 *     "Nombre n(total)" = n en este juego, pitcheo "EQUIPO IP H R ER BB SO ERA"
 *     con decisión "(W 1-0)/(L 0-1)/(S)" pegada al nombre, y colas
 *     "Pitches-strikes-"/"Batters faced-"/"WP-" (wild pitch, NO ganador).
 *  B) Genérico de secciones "<EQUIPO> Batting/Pitching/Fielding" (tolerante,
 *     columnas por encabezado) — fallback para otras variantes.
 */


/** Expande tabs a la siguiente parada de 8 (como el bloc de notas viejo) y
 *  normaliza NBSP. El .box.txt nace con columnas fijas — si el archivo se
 *  re-guardó en Win11 con tabs, el ancho se descuadra y el "nombre" sale
 *  cortado a una letra (de ahí las filas "P" fantasma). */
const expandTabs = (line: string, stop = 8): string => {
  let out = '';
  for (const ch of line) {
    if (ch === '\t') out += ' '.repeat(stop - (out.length % stop));
    else out += ch.charCodeAt(0) === 0xA0 ? ' ' : ch;
  }
  return out;
};

/** Pre-formatea el texto antes de parsear: CRLF→LF, tabs→paradas de 8,
 *  NBSP→espacio, recorta cola. Así el layout vuelve a columnas fijas. */
function toLines(txt: string): string[] {
  return txt.split(/\r?\n/).map((l) => expandTabs(l).trimEnd()).filter((l) => l.trim().length);
}

/** RTF → líneas lógicas: `\par` marca el fin REAL de cada línea; los saltos
 *  físicos internos (el corte a ~120col de Win11) se concatenan conservando
 *  espacios. `\'hh` se decodifica como cp1252 (ñ/acentos de BallScore). */
function rtfLogicalLines(raw: string): string[] {
  let s = raw.replace(/\\'([0-9a-fA-F]{2})/g, (_m, h) => Buffer.from([parseInt(h, 16)]).toString('latin1'));
  s = s.replace(/\{\\fonttbl[^}]*\}?/g, '');
  return s.split(/\\par[d]?\s?/).map((seg) => {
    const t = seg.replace(/\\[a-zA-Z]+-?\d* ?/g, '').replace(/[{}\\]/g, '').replace(/\r?\n/g, '');
    return t.replace(/\s+$/g, '');
  }).filter((l) => l.trim().length);
}

/** Líneas lógicas del archivo crudo, sea RTF o texto plano. */
const boxLines = (txt: string) => (txt.includes('{\\rtf') ? rtfLogicalLines(txt) : toLines(txt));

/** Reformatea el archivo (RTF o texto) a .txt ALINEADO a columnas fijas
 *  estilo bloc de notas — mismo resultado que scripts/fmt-box.ts.
 *  Útil para guardar una copia legible o re-importar en herramientas que
 *  exijan el layout clásico. */
export function formatBoxText(txt: string): string {
  const lines = boxLines(txt);
  const NAME_W = 18;
  const fmtBat = (r?: Rec | null): string => {
    if (!r) return ' '.repeat(NAME_W);
    const head = ` ${(r.name + (r.pos ? ' ' + r.pos.toLowerCase() : '')).trim()}`.padEnd(NAME_W);
    const body = r.numToks.map((t, i) => t.padStart(i === r.numToks.length - 1 && t.startsWith('.') ? 7 : 3)).join('');
    return head + body;
  };
  const out: string[] = [];
  const hi = lines.findIndex((l) => (l.match(/\bPlayer\b/g) ?? []).length >= 2);
  let li = 0;
  for (; li < (hi < 0 ? lines.length : hi); li++) out.push(lines[li]);
  if (hi >= 0) {
    out.push(' Player          AB R  H BI BB SO  P  A  E LOB   Ave      Player          AB R  H BI BB SO  P  A  E LOB   Ave');
    out.push(' ------          -- -  - -- -- --  -  -  - ---   ---      ------          -- -  - -- -- --  -  -  - ---   ---');
    li = hi + 2;
    for (; li < lines.length; li++) {
      const l = lines[li];
      if (/^\s*Totals\b/i.test(l)) { out.push(l); li++; break; }
      if (!l.trim() || !/\d/.test(l)) { out.push(l); continue; }
      const recs = parseRecs(l);
      out.push(fmtBat(recs[0]) + (recs[1] ? '      ' + fmtBat(recs[1]).trimStart() : ''));
    }
  }
  const seenPit = new Set<string>(); // el export duplica a veces el bloque
  let inPit = false;
  for (; li < lines.length; li++) {
    const l = lines[li];
    if (/IP\s+H\s+R\s+ER/i.test(l)) { inPit = true; seenPit.clear(); out.push(l); continue; }
    if (inPit && /\d/.test(l)) {
      const recs = parseRecs(l).filter((r): r is Rec => !!r);
      if (recs.length === 1) {
        const r = recs[0];
        const key = `${r.name}|${r.numToks.join(',')}`;
        if (!seenPit.has(key)) {
          seenPit.add(key);
          const nums = r.numToks.map((t, i) => t.padStart(i === 0 ? 7 : i === r.numToks.length - 1 ? 7 : 3)).join('');
          out.push(` ${(r.name + (r.pos ? ' ' + r.pos.toLowerCase() : '')).padEnd(18)}${nums}`);
        }
        continue;
      }
    }
    if (inPit && (/-\s/.test(l) || !/\d/.test(l))) inPit = false;
    out.push(l);
  }
  return out.join('\r\n') + '\r\n';
}

const MESES: Record<string, number> = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, augosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

export interface BoxRow {
  team: string;                       // equipo como viene en el archivo
  section: 'bat' | 'pit' | 'fld';
  name: string;                       // nombre crudo del archivo ("LARA, Pedro" / "P. Lara" / "Pedro Lara")
  pos?: string;
  dec?: 'W' | 'L' | 'S' | 'H' | 'BS'; // decisión marcada en la línea
  stats: Record<string, number>;      // ya mapeado a columnas statLines
  partial?: boolean;                  // solo aparece en las notas (2B/HR…) — sin fila en la tabla
  noName?: boolean;                   // el archivo trae solo la posición ("P") en vez de nombre
}

export interface BoxGame {
  dateIso: string;
  away: string; home: string;
  scoreAway: number; scoreHome: number;
  innings: number;
  rows: BoxRow[];
  wp?: string; lp?: string; sv?: string; // nombres crudos del archivo
  recAway?: { w: number; l: number };    // récord (W-L) del encabezado — se reinicia en playoffs
  recHome?: { w: number; l: number };
  warnings: string[];
}

const NAME_CHARS = "A-Za-zÁÉÍÓÚÑÜáéíóúñü' .\\-,"; // los box usan "APELLIDO, Nombre"
const NAME_CHARS_ROW = NAME_CHARS + '()0-9'; // "(W)"/"(L)"/"(S)" y posiciones con dígito (1b/2b/3b)
const POS_RE = /^(P|C|1B|2B|3B|SS|LF|CF|RF|DH|EH|PH|PR|OF|IF|JC|BC|BD)(-(P|C|1B|2B|3B|SS|LF|CF|RF|DH|EH|OF|IF|JC))*$/i;
const DEC_RE = /\((W|L|S|H|BS)(?:\s*,?\s*[\d.-]+)?\)\s*$/i;

// token de encabezado → clave statLines (bateo/pitcheo/fildeo juntos;
// la sección decide qué significan h/r/bb/so)
const COL_ALIASES: Record<string, string> = {
  ab: 'ab', pa: 'pa', r: 'r', h: 'h', bi: 'rbi', rbi: 'rbi', ci: 'rbi',
  '2b': 'doubles', '3b': 'triples', hr: 'hr', bb: 'bb', ibb: '_skip',
  so: 'k', k: 'k', sb: 'sb', cs: '_skip', sh: 'sac', sac: 'sac', sf: 'sf',
  hbp: 'hbp', hp: 'hbp', gdp: '_skip', dp: '_skip', lob: '_skip', e: 'e',
  po: 'po', a: 'a', tc: '_skip', pb: '_skip',
  // pitcheo (las genéricas h/r/bb/so se renombran según sección abajo)
  ip: 'pOuts', outs: 'pOuts', er: 'pER', wp: '_skip', bk: '_skip',
  bf: 'bf', tbf: 'bf', np: '_skip', hb: '_skip', hbp2: '_skip', cg: 'cg', sho: 'sho',
};
// columnas que en sección de pitcheo cambian de nombre
const PIT_REMAP: Record<string, string> = {
  h: 'pH', r: 'pR', er: 'pER', bb: 'pBB', k: 'pK', so: 'pK', hr: 'pHR',
  ab: '_skip', rbi: '_skip', doubles: '_skip', triples: '_skip',
  sb: '_skip', sac: '_skip', sf: '_skip', hbp: '_skip', e: '_skip',
  po: '_skip', a: '_skip',
};

const SEC_RES: [RegExp, BoxRow['section']][] = [
  [/batting|bateo|bateador/i, 'bat'],
  [/pitching|pitcheo|lanzador/i, 'pit'],
  [/fielding|fildeo|defens/i, 'fld'],
];
// decisión declarada en línea propia — palabra/abreviatura completa, o letra
// suelta SOLO con ':' (sin ella "LARA, P." se tragaría como "L" perdedor)
const DEC_LINE = /^(WP|LP|SV|SAVE|GANADOR|PERDEDOR|SALVADO|WINNING\s+PITCHER|LOSING\s+PITCHER|HOLD|HLD)\s*[:.]?\s*(.+)$/i;
const DEC_LINE2 = /^(W|L|S|H|BS)\s*:\s*(.+)$/i;

const outsOf = (ip: number) => Math.floor(ip) * 3 + Math.round((ip - Math.floor(ip)) * 10);

/** token de encabezado → clave de stats según la sección */
function colKey(tok: string, section: BoxRow['section']): string | null {
  const t = tok.toLowerCase();
  if (t === 'pos' || t === 'player' || t === 'jugador' || t === 'nombre') return null;
  const base = COL_ALIASES[t] ?? null;
  if (base === null) return '_unknown';
  if (section === 'pit' && PIT_REMAP[t] !== undefined) return PIT_REMAP[t];
  return base;
}

// ======================= layout clásico BallScore (2 columnas) =======================

const POS_TAIL = /^(p|c|ss|lf|cf|rf|sf|if|of|dh|eh|ph|pr|bc|jc|ud|[1-3]b|s[1-9])$/i;
// el "nombre" es solo un código de posición — el archivo no anotó quién era
// (p.ej. el pitcher bateando listado como "P" a secas en boxscores viejos)
const isNoName = (name: string) => POS_TAIL.test(name.replace(/\s+/g, ''));
const BAT_COLS = ['ab', 'r', 'h', 'rbi', 'bb', 'k', 'po', 'a', 'e', '_lob', '_ave'] as const;
const PIT_COLS = ['pOuts', 'pH', 'pR', 'pER', 'pBB', 'pK', '_era'] as const;

/** "Nombre [pos…]  n n n …" por tokens — el formato real separa la posición
 *  de los números a veces con UN solo espacio ("Santos p 1 0…") y un jugador
 *  puede llevar VARIAS posiciones ("Luna cf c ss rf" = se movió de puesto).
 *  Los tokens del nombre conservan "(W 1-0)" (decisión pegada). */
function parseColPlayer(part: string): { name: string; pos?: string; nums: number[] } | null {
  const toks = part.trim().split(/\s+/);
  const ni = toks.findIndex((t) => /^\d[\d.]*$|^\.\d+$/.test(t)); // 1er número (incl. ".333")
  if (ni <= 0) return null;
  const nums = toks.slice(ni).map((v) => Number(v) || 0);
  if (nums.some((n) => Number.isNaN(n))) return null;
  const nameToks = toks.slice(0, ni);
  // posiciones conocidas al final del nombre (una o varias); las iniciales
  // con punto ("P.", "B.") NO son posiciones — quedan en el nombre
  const posArr: string[] = [];
  while (nameToks.length > 1 && POS_TAIL.test(nameToks[nameToks.length - 1])) posArr.unshift(nameToks.pop()!);
  const name = nameToks.join(' ').replace(/\s+/g, ' ').trim();
  if (!name || !/[A-Za-zÁÉÍÓÚÑÜáéíóúñü]/.test(name)) return null;
  return { name, pos: posArr.length ? posArr.join('-').toUpperCase() : undefined, nums };
}

const isNumTok = (t: string) => /^\d[\d.]*$|^\.\d+$/.test(t);

/** 1-2 registros "nombre…  n n n…" en UNA línea lógica, SIN usar columnas
 *  fijas: tokens de nombre hasta el 1er número, luego la corrida numérica,
 *  y lo que sobre es el segundo registro. Sirve igual para el archivo bien
 *  formateado que para el re-ensamblado de líneas cortadas por Win11. */
interface Rec { name: string; pos?: string; nums: number[]; numToks: string[] }
function parseRecs(part: string): (Rec | null)[] {
  const toks = part.trim().split(/\s+/).filter(Boolean);
  const recs: (Rec | null)[] = [];
  let i = 0;
  while (i < toks.length && recs.length < 2) {
    const nameT: string[] = [];
    while (i < toks.length && !isNumTok(toks[i])) nameT.push(toks[i++]);
    const numToks: string[] = [];
    while (i < toks.length && isNumTok(toks[i])) numToks.push(toks[i++]);
    if (!nameT.length || !numToks.length) { recs.push(null); break; }
    const posArr: string[] = [];
    while (nameT.length > 1 && POS_TAIL.test(nameT[nameT.length - 1])) posArr.unshift(nameT.pop()!);
    const name = nameT.join(' ').replace(/\s+/g, ' ').trim();
    if (!name || !/[A-Za-zÁÉÍÓÚÑÜáéíóúñü]/.test(name)) { recs.push(null); break; }
    recs.push({ name, pos: posArr.length ? posArr.join('-').toUpperCase() : undefined,
                nums: numToks.map((t) => Number(t) || 0), numToks });
  }
  return recs;
}

/** "Nombre n(total)" o "Nombre(total)" de las líneas suplementarias → n = de este juego. */
function supEntries(seg: string): [string, number][] {
  const out: [string, number][] = [];
  for (const item of seg.split(',')) {
    const m = item.trim().match(/^([A-Za-zÁÉÍÓÚÑÜáéíóúñü' .0-9-]+?)\s*(?:(\d+)\s*)?(?:\(\d+\))?;?$/);
    if (m) out.push([m[1].replace(/\s*\([A-Za-z]+\)\s*/g, ' ').trim(), m[2] ? Number(m[2]) : 1]);
  }
  return out;
}

/** Layout clásico: dos columnas de bateo (izquierda=visitante), pitcheo por equipo. */
function parseClassic(lines: string[], warnings: string[]): BoxGame | null {
  // encabezado doble "Player … Player"
  const hi = lines.findIndex((l) => (l.match(/\bPlayer\b/g) ?? []).length >= 2);
  if (hi < 0) return null;
  const col2 = lines[hi].indexOf('Player', 8);

  // equipos: la línea sobre el encabezado lleva "EQUIPO (W-L)" en cada
  // columna — se parte por los récords (n-n), NO por columnas fijas, porque
  // con tabs el corte cae en distinta posición que en la línea "Player"
  let away = '', home = '';
  let recAway: { w: number; l: number } | undefined, recHome: { w: number; l: number } | undefined;
  const mkRec = (s: string) => { const m = s.match(/\((\d+)-(\d+)\)/); return m ? { w: +m[1], l: +m[2] } : undefined; };
  for (let i = hi - 1; i >= 0; i--) {
    const recs = [...lines[i].matchAll(/\(\d+-\d+\)/g)];
    if (recs.length >= 2) {
      away = lines[i].slice(0, recs[0].index).trim();
      home = lines[i].slice(recs[0].index! + recs[0][0].length, recs[1].index).trim();
      recAway = mkRec(recs[0][0]); recHome = mkRec(recs[1][0]);
      break;
    }
    if (recs.length === 1 && !away) { // solo un récord — fallback por columna
      away = lines[i].slice(0, col2).replace(/\(\d+-\d+\)/g, '').trim();
      home = lines[i].slice(col2).replace(/\(\d+-\d+\)/g, '').trim();
      recAway = recHome = mkRec(recs[0][0]);
      break;
    }
  }
  if (!away || !home) { warnings.push('No se leyeron los equipos del encabezado.'); }

  const rows: BoxRow[] = [];
  const batByTeam = new Map<string, Map<string, BoxRow>>(); // nombre+equipo → fila (para suplementarios)
  const sideTeam = (side: number) => (side === 0 ? away : home);
  const addRow = (r: BoxRow) => {
    rows.push(r);
    if (r.section === 'bat') {
      const m = batByTeam.get(r.team) ?? new Map<string, BoxRow>();
      m.set(normName(r.name), r);
      batByTeam.set(r.team, m);
    }
  };

  // ---------- bateo + fildeo inline ----------
  // El export de Win11 CORTA las filas largas (~120 cols): el nombre queda
  // solo en una línea y los números (o el registro del equipo rival) en la
  // siguiente — "el box sale desordenado". Se RE-ENSAMBLAN las líneas
  // lógicas: una línea que empieza con letra a col ≤3 (o en la zona del
  // equipo local) abre fila nueva solo si el buffer ya cerró ≥1 registro;
  // si el buffer solo trae nombre sin números, la línea es continuación.
  let li = hi + 1;
  const block: string[] = [];
  for (; li < lines.length; li++) {
    const line = lines[li];
    if (/^\s*Totals\b/i.test(line)) break;
    if (line.trim() && /[\dA-Za-zÁÉÍÓÚ]/i.test(line)) block.push(line);
  }
  const logical: { text: string; right: boolean }[] = [];
  let buf = '', bufRight = false;
  const flush = () => { if (buf.trim()) logical.push({ text: buf, right: bufRight }); buf = ''; bufRight = false; };
  for (const line of block) {
    const col = line.length - line.trimStart().length;
    const startsName = /^[A-Za-zÁÉÍÓÚÑÜ'(]/i.test(line.trim());
    if (!buf) { buf = line; bufRight = col >= col2 - 8; continue; }
    // ¿el buffer terminó en un nombre SIN números? entonces el último
    // registro está incompleto y esta línea es su continuación ("RAMOS" +
    // "c 1b 2b s1  2 0…", "ALCANTARA" + "p  3 1…") — no abrir fila nueva
    const btoks = buf.trim().split(/\s+/);
    const trailingName = !isNumTok(btoks[btoks.length - 1]);
    if (startsName && (col <= 3 || col >= col2 - 8) && !trailingName
        && (parseRecs(buf)[0]?.nums.length ?? 0) > 0) {
      flush(); buf = line; bufRight = col >= col2 - 8; continue;
    }
    buf += ' ' + line.trim();
  }
  flush();

  for (const lg of logical) {
    const recs = parseRecs(lg.text).filter((r): r is NonNullable<typeof r> => !!r);
    const off = lg.right ? 1 : 0; // fila que arranca en la columna derecha = solo local
    recs.forEach((r, idx) => {
      const side = Math.min(off + idx, 1);
      const stats: Record<string, number> = {};
      // solo importan las 9 primeras (AB R H BI BB SO P A E) — LOB/Ave se ignoran
      for (let i = 0; i < r.nums.length && i < 9; i++) {
        const k = BAT_COLS[i];
        if (!k.startsWith('_')) stats[k] = (stats[k] ?? 0) + r.nums[i];
      }
      // marcas tipo "(R)" (refuerzo/reingreso) no son parte del nombre
      const nm = r.name.replace(/\s*\([A-Za-z]+\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
      if (nm) addRow({ team: sideTeam(side), section: 'bat', name: nm, pos: r.pos, stats, noName: isNoName(nm) || undefined });
    });
  }

  // ---------- linescore "1 2 3 …  R H E" ----------
  let scoreAway = 0, scoreHome = 0, innings = 0;
  const lsi = lines.findIndex((l) => {
    const t = l.trim().split(/\s+/);
    const ri = t.findIndex((x) => x === 'R');
    return ri >= 3 && t.slice(0, ri).every((x) => /^\d+$/.test(x)) && t[ri + 1] === 'H';
  });
  if (lsi >= 0) {
    const toks = lines[lsi].trim().split(/\s+/);
    innings = toks.findIndex((x) => x === 'R');
    for (let i = lsi + 1; i < Math.min(lsi + 4, lines.length); i++) {
      const m = lines[i].match(/^\s*([A-ZÁÉÍÓÚÑ' .0-9-]+?)\s+((?:[\dXx-]+\s+)+)(\d+)\s+(\d+)\s+(\d+)\s*$/);
      if (!m) continue;
      const team = m[1].trim();
      const r = Number(m[3]);
      if (normName(team) === normName(away)) scoreAway = r;
      else if (normName(team) === normName(home)) scoreHome = r;
    }
  }

  // ---------- suplementarios: 2B/3B/HR/SB/SF (no están en la tabla) ----------
  const sup = lines.slice(li).join(' ').replace(/\s+/g, ' ');
  // match laxo contra la tabla de bateo: exacto, o un nombre que contiene/
  // está contenido en el otro ("Herrera" ↔ "Herrera R.") — las notas de
  // BallScore a veces recortan el nombre
  const findBat = (nm: string): BoxRow | undefined => {
    const n = normName(nm);
    for (const t of [away, home, '']) {
      const m = batByTeam.get(t);
      if (!m) continue;
      if (m.has(n)) return m.get(n);
      for (const [k, r] of m) if (k.length > 2 && n.length > 2 && (k.startsWith(n) || n.startsWith(k))) return r;
    }
    return undefined;
  };
  for (const m of sup.matchAll(/(2B|3B|HR|SB|SF|CS)-\s*([^;]+);/g)) {
    const key = { '2B': 'doubles', '3B': 'triples', HR: 'hr', SB: 'sb', SF: 'sf', CS: '_skip' }[m[1]]!;
    if (key === '_skip') continue;
    for (const [nm, n] of supEntries(m[2])) {
      const row = findBat(nm);
      if (row) { row.stats[key] = (row.stats[key] ?? 0) + n; if (key === 'sf') row.stats.sf = n; }
      else {
        // el jugador no tiene fila en la tabla (el box lo anotó solo en las
        // notas) — en vez de perder el stat se crea una fila parcial sin
        // equipo: el admin le asigna jugador en la revisión
        warnings.push(`${m[1]}: «${nm}» solo aparece en las notas — fila parcial agregada, asígnale jugador.`);
        addRow({ team: '', section: 'bat', name: nm, stats: { [key]: n }, partial: true });
      }
    }
  }
  // RBI también viene en suplementarios pero ya está en la columna BI

  // ---------- pitcheo: "EQUIPO  IP H R ER BB SO ERA" ----------
  const pitRows = new Map<string, BoxRow>(); // normName → fila (para pitches/bf)
  for (let i = li; i < lines.length; i++) {
    const hm = lines[i].match(/^\s*([A-ZÁÉÍÓÚÑ' .0-9-]+?)\s{2,}IP\s+H\s+R\s+ER\s+BB\s+SO/i);
    if (!hm) continue;
    const team = normName(hm[1]) === normName(away) ? away : normName(hm[1]) === normName(home) ? home : hm[1].trim();
    const seenPit = new Set<string>(); // el export duplica a veces todo el bloque
    for (let j = i + 1; j < lines.length; j++) {
      // corta en Totals o en el encabezado "EQUIPO IP H R ER…" del otro equipo
      if (/^\s*Totals\b/i.test(lines[j]) || /IP\s+H\s+R\s+ER/i.test(lines[j])) break;
      // re-ensamblar líneas cortadas: juntar hasta que el buffer parsee
      // ("PIMENTEL" + "(L 3-6)  5.1 18 14…" es UNA fila en dos líneas)
      let merged = lines[j];
      while (j + 1 < lines.length && !parseColPlayer(merged) && /[A-Za-zÁÉÍÓÚ]/i.test(merged)) {
        merged += ' ' + lines[++j].trim();
      }
      const p = parseColPlayer(merged);
      if (!p) break;
      let dec: BoxRow['dec'];
      const dm = p.name.match(/\((W|L|S|SV|H|BS)\s*[\d-]*\)/i);
      if (dm) { dec = dm[1].toUpperCase() === 'SV' ? 'S' : (dm[1].toUpperCase() as BoxRow['dec']); p.name = p.name.replace(dm[0], '').trim(); }
      const stats: Record<string, number> = {};
      for (let k = 0; k < p.nums.length && k < PIT_COLS.length - 1; k++) {
        const key = PIT_COLS[k];
        if (!key.startsWith('_')) stats[key] = (stats[key] ?? 0) + p.nums[k];
      }
      if (stats.pOuts != null) stats.pOuts = outsOf(stats.pOuts);
      // el export de Win11 a veces duplica el bloque entero de pitcheo
      const dupKey = `${team}|${normName(p.name)}|${p.nums.join(',')}`;
      if (seenPit.has(dupKey)) continue;
      seenPit.add(dupKey);
      const row: BoxRow = { team, section: 'pit', name: p.name, pos: 'P', dec, stats };
      rows.push(row);
      pitRows.set(`${team}|${normName(p.name)}`, row);
    }
  }

  // ---------- colas: Pitches-strikes / Batters faced ----------
  for (const m of sup.matchAll(/Pitches-strikes-\s*([^;]+);/gi)) {
    for (const im of m[1].matchAll(/([A-Za-zÁÉÍÓÚÑÜáéíóúñü' .0-9-]+?)\s+(\d+)-\d+/g)) {
      const row = pitRows.get(`${away}|${normName(im[1])}`) ?? pitRows.get(`${home}|${normName(im[1])}`);
      if (row) row.stats.pPitches = Number(im[2]);
    }
  }
  for (const m of sup.matchAll(/Batters faced-\s*([^;]+);/gi)) {
    for (const im of m[1].matchAll(/([A-Za-zÁÉÍÓÚÑÜáéíóúñü' .0-9-]+?)\s+(\d+)/g)) {
      const row = pitRows.get(`${away}|${normName(im[1])}`) ?? pitRows.get(`${home}|${normName(im[1])}`);
      if (row) row.stats.bf = Number(im[2]);
    }
  }

  // decisiones de las filas de pitcheo
  let wp: string | undefined, lp: string | undefined, sv: string | undefined;
  for (const r of rows) {
    if (r.section !== 'pit' || !r.dec) continue;
    if ((r.dec === 'W') && !wp) wp = r.name;
    if ((r.dec === 'L') && !lp) lp = r.name;
    if (r.dec === 'S' && !sv) sv = r.name;
  }

  return { dateIso: '', away, home, scoreAway, scoreHome, innings, rows, wp, lp, sv, recAway, recHome, warnings };
}

/**
 * Parsea el .box.txt (texto o RTF). Devuelve null si no reconoce
 * ni linescore ni jugadores (entonces no es un box score BallScore).
 */
export function parseBoxFile(txt: string, filename?: string): BoxGame | null {
  const lines = boxLines(txt);
  const warnings: string[] = [];

  // layout clásico BallScore (doble columna) — el formato de los archivos reales
  const classic = parseClassic(lines, warnings);
  if (classic) {
    // el genérico no produce filas en este layout, pero lee fecha/equipos/
    // linescore/nombre de archivo → sirve de respaldo para los huecos
    const g = parseBoxFileGeneric(txt, filename, warnings);
    if (g) {
      classic.dateIso = g.dateIso;
      if (!classic.away) classic.away = g.away;
      if (!classic.home) classic.home = g.home;
      if (!classic.scoreAway && !classic.scoreHome) { classic.scoreAway = g.scoreAway; classic.scoreHome = g.scoreHome; }
      if (!classic.innings) classic.innings = g.innings;
      if (!classic.wp) classic.wp = g.wp;
      if (!classic.lp) classic.lp = g.lp;
      if (!classic.sv) classic.sv = g.sv;
      // el genérico no halla filas en este layout — su aviso no aplica
      classic.warnings = warnings.filter((w) => !w.includes('líneas de jugadores'));
    }
    return classic;
  }

  return parseBoxFileGeneric(txt, filename, warnings);
}

/** Layout genérico (secciones "<EQUIPO> Batting/Pitching/Fielding") — fallback. */
function parseBoxFileGeneric(txt: string, filename: string | undefined, warnings: string[]): BoxGame | null {
  const lines = boxLines(txt);

  // ---------- fecha ----------
  let dateIso = '';
  const dateLine = lines.find((l) => /\d{1,2},\s*\d{4}/.test(l));
  if (dateLine) {
    const m = dateLine.match(/([A-Za-zÁÉÍÓÚñ]+)\s+(\d{1,2}),\s*(\d{4})/i);
    if (m) {
      const mo = MESES[m[1].toLowerCase()];
      if (mo != null) dateIso = `${m[3]}-${String(mo + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
    }
  }
  // nombre de archivo "MM-DD-YY Away at Home.box.txt" (formato BallScore)
  const FN_RE = /(\d{2})-(\d{2})-(\d{2})\s+(.+?)\s+at\s+(.+?)\.box\.txt$/i;
  const fm = filename?.match(FN_RE);
  let fnAway = '', fnHome = '';
  if (fm) {
    if (!dateIso) dateIso = `20${fm[3]}-${fm[1]}-${fm[2]}`;
    fnAway = fm[4].trim(); fnHome = fm[5].trim();
  }

  // ---------- linescore ----------
  let away = fnAway, home = fnHome, scoreAway = 0, scoreHome = 0, innings = 0;
  const lsIdx = lines.findIndex((l) => {
    const toks = l.trim().split(/\s+/);
    const ri = toks.findIndex((t) => t === 'R');
    return ri >= 4 && toks.slice(0, ri).every((t) => /^\d+$|^-$/.test(t));
  });
  if (lsIdx >= 0) {
    const headToks = lines[lsIdx].trim().split(/\s+/);
    const rCol = headToks.findIndex((t) => t === 'R');
    innings = headToks.slice(0, rCol).filter((t) => /^\d+$/.test(t)).length;
    const up = (s: string) => s.trim().toUpperCase();
    for (let i = lsIdx + 1; i < Math.min(lsIdx + 4, lines.length); i++) {
      const m = lines[i].match(new RegExp(`^\\s*([${NAME_CHARS}][${NAME_CHARS}0-9]*?)\\s+((?:[\\dXx-]+\\s+)+)(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*$`, 'i'));
      if (!m) continue;
      const team = m[1].trim();
      const r = Number(m[3]); // R, luego m[4]=H, m[5]=E
      if (away && up(team) === up(away)) { scoreAway = r; continue; }
      if (home && up(team) === up(home)) { scoreHome = r; continue; }
      if (!away) { away = team; scoreAway = r; }
      else if (!home) { home = team; scoreHome = r; }
      else break;
    }
  }
  if (!away || !home) warnings.push('No se reconoció el linescore — elige los equipos manualmente.');

  // récord (W-L) del encabezado "EQUIPO (w-l)  EQUIPO (w-l)" — se reinicia en playoffs
  let recAway: { w: number; l: number } | undefined, recHome: { w: number; l: number } | undefined;
  for (const l of lines) {
    const recs = [...l.matchAll(/\((\d+)-(\d+)\)/g)];
    if (recs.length >= 2) {
      recAway = { w: +recs[0][1], l: +recs[0][2] };
      recHome = { w: +recs[1][1], l: +recs[1][2] };
      break;
    }
  }

  // ---------- secciones de jugadores ----------
  const rows: BoxRow[] = [];
  let section: BoxRow['section'] | null = null;
  let secTeam = '';
  let cols: (string | null)[] = [];
  const secCount: Record<string, number> = { bat: 0, pit: 0, fld: 0 }; // para equipo implícito

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();

    // encabezado de sección: "<EQUIPO> Batting …" o línea suelta "Batting"
    const sm = SEC_RES.map(([re, s]) => (line.match(re) ? s : null)).find(Boolean);
    if (sm && !/^\d/.test(line)) {
      const headMatch = line.match(new RegExp(`^([${NAME_CHARS}]+?)\\s*(batting|pitching|fielding|bateo|pitcheo|fildeo)`, 'i'));
      const tm = headMatch ? headMatch[1].trim() : '';
      const selfName = /^(batting|pitching|fielding|bateo|pitcheo|fildeo|player|jugador)/i.test(tm);
      section = sm;
      secTeam = selfName ? '' : tm;
      secCount[sm]++;
      cols = [];
      // el encabezado de columnas puede venir en la MISMA línea:
      // "CAROLINA Batting   AB  R  H RBI …"
      const rest = headMatch ? line.slice(headMatch[0].length).trim() : '';
      if (rest) {
        const rtoks = rest.split(/\s+/);
        const firstStat = rtoks.findIndex((t) => COL_ALIASES[t.toLowerCase()] !== undefined || /^(pos|player|jugador|nombre)$/i.test(t));
        if (firstStat >= 0 && rtoks.some((t) => /^(AB|IP|PO|TB)$/i.test(t))) {
          if (!secTeam && firstStat > 0) secTeam = rtoks.slice(0, firstStat).join(' ');
          cols = rtoks.slice(firstStat).map((t) => colKey(t, section!));
        }
      }
      continue;
    }
    if (!section) continue;

    // línea de encabezado de columnas suelta (contiene AB/IP/PO como token)
    const toks = line.split(/\s+/);
    if (!cols.length && toks.some((t) => /^(AB|IP|PO|TB)$/i.test(t))) {
      const firstStat = toks.findIndex((t) => COL_ALIASES[t.toLowerCase()] !== undefined || /^(pos|player|jugador|nombre)$/i.test(t));
      if (!secTeam && firstStat > 0) secTeam = toks.slice(0, firstStat).join(' ');
      cols = toks.slice(Math.max(0, firstStat)).map((t) => colKey(t, section!));
      continue;
    }

    if (/^totals?\b|^total\b/i.test(line)) continue; // fin de bloque — la sección sigue abierta por si viene otro equipo

    // fila de jugador: nombre [pos] numeros — "(W)"/"(L)"/"(S)" pegados al nombre
    const rm = line.match(new RegExp(`^([${NAME_CHARS_ROW}]+?)\\s+((?:\\d+\\.?\\d*|x|X)(?:\\s+\\d+\\.?\\d*)*)\\s*$`));
    if (rm && cols.length) {
      let nm = rm[1].trim();
      const dm2 = nm.match(DEC_RE);
      let dec: BoxRow['dec'];
      if (dm2) { dec = dm2[1].toUpperCase() as BoxRow['dec']; nm = nm.slice(0, dm2.index).trim(); }
      // posición = último token si es código de posición
      const ntoks = nm.split(/\s+/);
      let pos: string | undefined;
      if (ntoks.length > 1 && POS_RE.test(ntoks[ntoks.length - 1])) {
        pos = ntoks.pop()!.toUpperCase();
        nm = ntoks.join(' ');
      }
      const nums = rm[2].split(/\s+/).map((v) => (v.toLowerCase() === 'x' ? 0 : Number(v) || 0));
      const stats: Record<string, number> = {};
      // alineación posicional: las columnas _skip (IBB, CS…) también consumen
      // un número de la fila — solo se excluyen las de texto (pos/nombre→null)
      const statCols = cols.filter((c) => c !== null);
      for (let i = 0; i < nums.length && i < statCols.length; i++) {
        const k = statCols[i];
        if (!k || k === '_skip' || k === '_unknown') continue;
        stats[k] = (stats[k] ?? 0) + nums[i];
      }
      if (section === 'pit' && stats.pOuts != null) stats.pOuts = outsOf(stats.pOuts);
      // sección sin equipo en el encabezado ("BATTING" suelto): el 1er bloque
      // es el visitante y el 2º el local (orden estándar del box score)
      const team = secTeam || (secCount[section] === 1 ? away : secCount[section] === 2 ? home : '');
      rows.push({ team, section, name: nm, pos, dec, stats, noName: isNoName(nm) || undefined });
    }
  }

  // ---------- decisiones por línea explícita ----------
  let wp: string | undefined, lp: string | undefined, sv: string | undefined;
  for (const line of lines) {
    const dm = line.match(DEC_LINE) ?? line.match(DEC_LINE2);
    if (!dm) continue;
    const k = dm[1].toUpperCase().replace(/\s+/g, ' ');
    const who = dm[2].trim();
    if (/^(WP|W|GANADOR|WINNING PITCHER)$/.test(k)) wp = who;
    else if (/^(LP|L|PERDEDOR|LOSING PITCHER)$/.test(k)) lp = who;
    else if (/^(SV|S|SAVE|SALVADO)$/.test(k)) sv = who;
  }
  // decisiones marcadas en las filas de pitcheo
  for (const r of rows) {
    if (r.section !== 'pit' || !r.dec) continue;
    if (r.dec === 'W' && !wp) wp = r.name;
    if (r.dec === 'L' && !lp) lp = r.name;
    if (r.dec === 'S' && !sv) sv = r.name;
  }

  if (!rows.length && !away) return null;
  if (!rows.length) warnings.push('El box no trae líneas de jugadores — solo se importará el marcador.');
  return { dateIso, away, home, scoreAway, scoreHome, innings, rows, wp, lp, sv, recAway, recHome, warnings };
}

// ------------------------------------------------------------ matching
export const normName = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Distancia Levenshtein acotada (nombres son cortos). */
export function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 9;
  const dp: number[] = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return dp[b.length];
}

/** Normaliza el nombre del archivo a {first,last} — acepta "LARA, Pedro", "P. Lara", "Pedro Lara". */
export function fileNameParts(raw: string): { first: string; last: string } {
  const s = raw.replace(/\s+/g, ' ').trim();
  if (s.includes(',')) {
    const [last, first] = s.split(',').map((x) => x.trim());
    return { first: first ?? '', last: last ?? '' };
  }
  const toks = s.split(' ');
  if (toks.length === 1) return { first: '', last: toks[0] };
  // "P. Lara" / "P Lara" → inicial + apellido
  if (toks[0].replace(/\./g, '').length === 1) return { first: toks[0].replace(/\./g, ''), last: toks.slice(1).join(' ') };
  // "Pedro Lara" → último token = apellido (apellidos compuestos los cubre el fuzzy)
  return { first: toks.slice(0, -1).join(' '), last: toks[toks.length - 1] };
}

export interface MatchCandidate { playerId: string; name: string; score: number }
export interface PlayerLite { id: string; firstName: string; lastName: string }

/**
 * Puntaje de coincidencia archivo↔jugador del sistema:
 *  100 nombre completo idéntico · 95 mismos tokens en otro orden
 *  85 apellido + inicial de nombre · 70 apellido único · 60 typo (lev≤2)
 */
export function matchScore(raw: string, p: PlayerLite): number {
  const f = fileNameParts(raw);
  const sys = { first: normName(p.firstName), last: normName(p.lastName) };
  const fN = { first: normName(f.first), last: normName(f.last) };
  const sysFull = `${sys.first} ${sys.last}`.trim();
  const fFull = `${fN.first} ${fN.last}`.trim();
  const fFullRev = `${fN.last} ${fN.first}`.trim();
  if (fFull && fFull === sysFull) return 100;
  if (fFullRev && fFullRev === sysFull) return 95;
  // mismo conjunto de tokens (orden distinto, "Lara Perez Pedro" vs "Pedro Lara")
  const fSet = new Set(fFull.split(' ').filter(Boolean));
  const sSet = new Set(sysFull.split(' ').filter(Boolean));
  if (fSet.size && fSet.size === sSet.size && [...fSet].every((t) => sSet.has(t))) return 90;
  // apellido + inicial del nombre
  if (fN.last && fN.last === sys.last && fN.first && sys.first.startsWith(fN.first[0])) return 85;
  // nombre + inicial del apellido (orden invertido)
  if (fN.first && fN.first === sys.last && fN.last && sys.first.startsWith(fN.last[0])) return 80;
  // solo apellido
  if (fN.last && fN.last === sys.last && !fN.first) return 70;
  // apellido contenido en ambas direcciones ("Lara" ⊂ "Lara Vargas" y viceversa)
  const lastContained = fN.last && (sys.last === fN.last.split(' ')[0]
    || fN.last.split(' ').includes(sys.last) || sys.last.split(' ').includes(fN.last));
  if (lastContained && fN.first && sys.first.startsWith(fN.first[0])) return 78;
  if (lastContained) return 68;
  if (fFull && lev(fFull, sysFull) <= 2) return 60;
  if (fFullRev && lev(fFullRev, sysFull) <= 2) return 58;
  return 0;
}

/** Los mejores candidatos de un roster para el nombre del archivo. */
export function bestMatches(raw: string, roster: PlayerLite[], top = 4): MatchCandidate[] {
  return roster
    .map((p) => ({ playerId: p.id, name: `${p.firstName} ${p.lastName}`, score: matchScore(raw, p) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}

/** Match de nombre de equipo contra la liga (exacto > contiene > lev). */
export function bestTeam<T extends { id: string; name: string; shortName?: string | null }>(raw: string, teams: T[]): T | null {
  const n = normName(raw);
  if (!n) return null;
  const norm = teams.map((t) => ({ t, n1: normName(t.name), n2: normName(t.shortName ?? '') }));
  return norm.find((x) => x.n1 === n || x.n2 === n)?.t
    ?? norm.find((x) => x.n1.includes(n) || n.includes(x.n1) || (x.n2 && (x.n2.includes(n) || n.includes(x.n2))))?.t
    ?? norm.map((x) => ({ t: x.t, d: Math.min(lev(n, x.n1), x.n2 ? lev(n, x.n2) : 9) })).sort((a, b) => a.d - b.d)[0]?.t ?? null;
}
