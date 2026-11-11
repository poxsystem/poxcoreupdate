// Las jugadas son ORDENADAS por naturaleza (el seq lo manda). Las escrituras
// del mismo juego pasan por una cola en proceso — sin ella dos POSTs
// concurrentes leen el mismo último seq y chocan la llave única (P2002 →
// estampida de reintentos). Colas por juego: juegos distintos no se bloquean.
const gameChains = new Map<string, Promise<unknown>>();
export function enqueue<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
  const prev = gameChains.get(gameId) ?? Promise.resolve();
  const p = prev.then(fn, fn); // corre aunque la jugada anterior haya fallado
  const tail = p.catch(() => undefined);
  gameChains.set(gameId, tail);
  // limpiar la entrada al drenar la cola — sin esto el mapa acumula una
  // promesa por cada juego anotado en la vida del proceso
  void tail.finally(() => { if (gameChains.get(gameId) === tail) gameChains.delete(gameId); });
  return p;
}
