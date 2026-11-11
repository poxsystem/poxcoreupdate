// Vocabulario de comandos hablados compartido por LiveMic (escucha permanente)
// y VoiceModal (una toma). La frase se limpia de muletillas para que
// "confirma la jugada", "graba eso", "dale que va" cuenten igual que "confirmar".
export const normCmd = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const FILLER_RE = /\b(por favor|la|el|eso|esta|jugada|jugadita|ahora|ya|entonces|pu[eé]s|me|te|lo|vamos)\b/g;
export const cmdText = (s: string) => normCmd(s).replace(/[^a-zñ ]/g, ' ').replace(FILLER_RE, ' ').replace(/\s+/g, ' ').trim();

// confirmar: TODAS las palabras restantes deben ser de confirmación →
// "ok confirma", "sí dale", "graba bien", "confírmala" cuentan igual.
// Los sufijos \w* cubren -la/-lo/-me/-r (confírmala, grábalo, anótame).
const CONFIRM_WORDS = /^(ok|okay|si|dale|confirma\w*|graba\w*|guarda\w*|anota\w*|marca\w*|escribe\w*|salva\w*|procesa\w*|agrega\w*|listo|adelante|va|bien|perfecto|correcto|exacto|afirmativo|aprobado|asi|mismo|metela|ponla|zumbale\w*|suelta\w*|deja\w*|aplica\w*|acepta\w*|usa\w*|vale)$/;
export const isConfirm = (t: string) => !!t && t.split(' ').every((w) => CONFIRM_WORDS.test(w));

// deshacer: descarta la jugada ABIERTA sin confirmar (o revierte si no hay nada)
export const UNDO_RE = /deshace|deshaga|deshaz|borra|quita|quitalo|revierte|reversa|anula|cancela|elimina|retira|sacal[oa]|equivoqu|descarta|me equivoque|no eso no/i;

// volver: revierte SIEMPRE la última jugada ya anotada (regresa al turno
// anterior), aunque haya una sugerencia abierta — cierra esa sugerencia también
export const BACK_RE = /^(volver|vuelve\w*|regresa\w*|retroced\w*|devuelve\w*|pa'? ?atras|para atras|hacia atras|vuelve atras|atras)$/;

// "repite" = vuelve a decir la última interpretación (LiveMic)
export const REPEAT_RE = /^(repite|repetir|describe|describeme|que dijiste|como quedo|otra vez|de nuevo|que entendiste|que escribiste|que anotaste|dilo|dimelo|leela|cuentame|vuelve a decir|que dije|lee)$/;

// "corrige" = descarta la sugerencia y dicta de nuevo (VoiceModal con sugerencia abierta)
export const CORRECT_RE = /corrige|corregir|corrij|malo|equivocad|no eso|no asi|otra vez|de nuevo|repite|repetir|descarta|descartar|vuelve|repite|intenta/i;

// ── notación hablada: "e dos"→E2 · "seis cuatro tres"→6-4-3 · "efe ocho"→F8 ──
const NUMW: Record<string, string> = {
  uno: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5',
  seis: '6', siete: '7', ocho: '8', nueve: '9',
};
const LET_POS: Record<string, string> = { e: 'E', error: 'E', efe: 'F', ele: 'L', pe: 'P', poblado: 'P', ache: 'H', h: 'H', ge: 'G' };
// trayectoria del batazo → prefijo G/L/F de la notación (rola/línea/elevado)
const TRAJW: Record<string, string> = {
  elevado: 'F', elevadito: 'F', fly: 'F', fli: 'F', alto: 'F', palomazo: 'F', paloma: 'F',
  pompia: 'F', pompiao: 'F', aire: 'F', aires: 'F', vuelo: 'F',
  linea: 'L', flechazo: 'L', canonazo: 'L', flecha: 'L', trazo: 'L',
  rola: 'G', rolita: 'G', rolling: 'G', rodado: 'G', chop: 'G', chopito: 'G', piquito: 'G',
  grounder: 'G', piso: 'G', tierra: 'G', bola: 'G',
};
// un token letra+dígito no puede repetir su propio guante ("ele siete siete"
// → L7, no L7-7) ni salir dos veces (E7-E7); la excepción es G# — rola
// fildeada + acción sin asistencia ("rola seis seis tres" → G6-6-3); los
// dígitos pelados repiten libre ("seis seis tres" → 6-6-3)
const collapseNotation = (s: string) => s.split('-').filter((tk, i, a) =>
  !(i > 0 && /^\d$/.test(tk) && /^[EFLPXH]\d+$/.test(a[i - 1]) && a[i - 1].endsWith(tk))
  && !(i > 0 && tk === a[i - 1] && /^[A-Z]+\d+$/.test(tk))
  // dígito igual seguido solo en el infield (1-6): "seis seis tres"→6-6-3;
  // el jardinero nunca repite — "ocho ocho"→8, no 8-8
  && !(i > 0 && /^\d$/.test(tk) && tk === a[i - 1] && Number(tk) > 6)
).join('-');

export function voiceNotation(t: string): string | null {
  // igual que cmdText pero conserva los dígitos ("e 2" → "e 2", no "e")
  const n = normCmd(t).replace(/[^a-zñ0-9 ]/g, ' ').replace(FILLER_RE, ' ').replace(/\s+/g, ' ').trim();
  // letra + número: "e 2", "e dos", "efe ocho" → E2 / F8
  const words = n.split(' ');
  // letra + número(s): "e dos"→E2, "e2"→E2, "ache cuatro"→H4 (jonrón),
  // "ache cuatro siete"→H4-7 (jonrón al left), "efe ocho"→F8,
  // "error del dos"→E2 (la letra puede no ser la 1ª palabra y llevar relleno)
  let headL: string | null = null;
  let headNums: string[] = [];
  let headIdx = -1;
  const g = words[0].match(/^([a-zñ]+)([1-9](?:-?[1-9])*)$/); // "e2", "h4", "h4-7" pegados
  if (g && LET_POS[g[1]]) { headL = LET_POS[g[1]]; headNums = g[2].split('-'); headIdx = 0; }
  else {
    headIdx = words.findIndex((w) => !!LET_POS[w]);
    if (headIdx >= 0) headL = LET_POS[words[headIdx]];
  }
  if (headL && headIdx >= 0) {
    const nums = [...headNums, ...(words.slice(headIdx + 1)
      .map((w) => NUMW[w] ?? (/^[1-9]$/.test(w) ? w : null))
      .filter(Boolean) as string[])];
    if (nums.length) return collapseNotation(`${headL}${nums.join('-')}`);
  }
  // trayectoria + posiciones: "elevado siete"→F7, "rola seis tres"→G6-3,
  // "un elevado al siete"→F7, "elevado" solo→F (prende el chip sin tocar la notación)
  const ti = words.findIndex((w) => TRAJW[w]);
  if (ti >= 0) {
    const rest = words.filter((w, i) => i !== ti && (NUMW[w] || /^[1-9]$/.test(w)))
      .map((w) => NUMW[w] ?? w);
    return collapseNotation(`${TRAJW[words[ti]]}${rest.join('-')}`);
  }
  // cadena de posiciones: "seis cuatro tres" → 6-4-3, "dos seis" → 2-6
  const toks = words.map((w) => NUMW[w] ?? (/^[1-9]$/.test(w) ? w : null));
  return toks.every(Boolean) && toks.length >= 2 ? toks.join('-') : null;
}
