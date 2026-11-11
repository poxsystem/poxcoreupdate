/** línea por juego importada o manual (Game.statLines) — campos numéricos se suman al combinar */
export interface StatLine {
  playerId: string; teamId: string | null;
  g?: number; pa?: number; ab?: number; r?: number; h?: number; doubles?: number;
  triples?: number; hr?: number; rbi?: number; bb?: number; k?: number; hbp?: number;
  sac?: number; sf?: number; sb?: number; gp?: number; gs?: number; w?: number; l?: number;
  sv?: number; hld?: number; bs?: number; cg?: number; sho?: number; pOuts?: number;
  pH?: number; pR?: number; pER?: number; pBB?: number; pK?: number; pHR?: number;
  pPitches?: number; bf?: number; po?: number; a?: number; e?: number;
}

export const SL_NUMS = [
  'g', 'pa', 'ab', 'r', 'h', 'doubles', 'triples', 'hr', 'rbi', 'bb', 'k', 'hbp', 'sac',
  'sf', 'sb', 'gp', 'gs', 'w', 'l', 'sv', 'hld', 'bs', 'cg', 'sho', 'pOuts', 'pH',
  'pR', 'pER', 'pBB', 'pK', 'pHR', 'pPitches', 'bf', 'po', 'a', 'e',
] as const;

/**
 * Combina varias líneas del MISMO jugador en un juego en una sola.
 * Pasa tras fusionar duplicados: las dos fichas quedaban con línea propia en el
 * mismo juego (una solía venir vacía en ceros) → la tarjeta tomaba solo la
 * primera y perdía stats. Base = la línea "más llena" (más acción), los números
 * se suman y teamId queda el de la base.
 */
export function mergeLines(lines: StatLine[]): StatLine | undefined {
  if (!lines.length) return undefined;
  if (lines.length === 1) return lines[0];
  const base = lines.reduce((a, b) =>
    ((b.pa ?? 0) + (b.pOuts ?? 0) > (a.pa ?? 0) + (a.pOuts ?? 0) ? b : a));
  const out: StatLine = { playerId: base.playerId, teamId: base.teamId ?? lines.find((l) => l.teamId)?.teamId ?? null };
  for (const k of SL_NUMS) {
    (out as unknown as Record<string, number>)[k] = lines.reduce((s, l) => s + ((l as unknown as Record<string, number | undefined>)[k] ?? 0), 0);
  }
  return out;
}
