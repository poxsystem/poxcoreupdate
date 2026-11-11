/**
 * selftest.cjs — chequeo rápido post-actualización / pre-juego.
 * Uso: node selftest.cjs  (con PoxScore corriendo)
 * Exit 0 = todo sano · 1 = algo malo (imprime qué).
 */
const BASE = `http://localhost:${process.env.PORT || 4000}`;
let fails = 0;
const ok = (m) => console.log(`  [OK] ${m}`);
const bad = (m) => { fails++; console.log(`  [!!] ${m}`); };

(async () => {
  let h;
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(4000) });
    h = await r.json();
  } catch {
    console.log(`  [··] el server no responde en ${BASE}`);
    console.log('       inicia PoxScore y vuelve a correr:  node selftest.cjs');
    process.exit(2); // no es falla del sistema — simplemente está apagado
  }
  ok(`API viva — build ${h.build || '?'} · v${h.v || '?'}`);

  if (h.staleClient) {
    bad('cliente Prisma VIEJO — corre:  cd server && npx prisma generate  y reinicia');
  } else {
    ok('cliente Prisma al día');
  }

  // la BD responde (una liga cualquiera alcanza para probar la conexión)
  try {
    const r = await fetch(`${BASE}/api/leagues`, { signal: AbortSignal.timeout(5000) });
    const ls = await r.json();
    ok(`BD responde — ${Array.isArray(ls) ? ls.length : '?'} liga(s)`);
  } catch (e) {
    bad(`la BD no responde — ${e.message}`);
  }

  // espacio en disco para respaldos (un respaldo ~10 MB)
  try {
    const fs = require('node:fs');
    const st = fs.statfsSync ? fs.statfsSync(require('node:path').resolve('backups')) : null;
    if (st && st.bavail * st.bsize < 200 * 1024 * 1024) bad('quedan <200 MB de disco — los respaldos automáticos pueden fallar');
    else ok('disco OK para respaldos');
  } catch { /* statfs no existe en este node — se omite */ }

  console.log(fails ? `\n${fails} problema(s) — no anotes en campo hasta resolver.` : '\nTodo sano — listo para campo.');
  process.exit(fails ? 1 : 0);
})();
