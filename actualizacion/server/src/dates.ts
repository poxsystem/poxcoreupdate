/**
 * "2026-04-15" (input type=date, fecha importada) → mediodía LOCAL.
 *
 * Un date-input pelado se parsea como medianoche UTC y en zonas UTC-4/-5
 * retrocede un día al mostrarse (el 15 de abril aparece como 14 en el listado,
 * el boxscore y las rachas). Mediodía aguanta ±12h de desfase sin moverse de
 * fecha. Cadenas con hora ("YYYY-MM-DDTHH:MM") se leen como hora local tal cual.
 */
export function gameDate(d: string | Date | null | undefined): Date | undefined {
  if (!d) return undefined;
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  }
  return new Date(d);
}
