// Prueba end-to-end: línea manual de stats en juego FINAL (editor admin)
const B = 'http://localhost:4000/api';
const j = (r) => r.json();
const log = (...a) => console.log(...a);

const main = async () => {
  const tok = (await j(await fetch(`${B}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }))).token;
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };

  // juego FINAL con lineup
  const games = await j(await fetch(`${B}/games`, { headers: H }));
  const g = games.find((x) => x.status === 'FINAL');
  if (!g) throw new Error('sin juego FINAL');
  const full = await j(await fetch(`${B}/games/${g.id}`, { headers: H }));
  log(`juego: ${full.awayTeam.name} @ ${full.homeTeam.name} (${full.id.slice(0, 8)}) status=${full.status} seasonApplied=${full.seasonApplied}`);

  // jugador del roster home que NO esté en el lineup
  const inLup = new Set(full.lineups.map((l) => l.playerId));
  const extra = full.homeTeam.players.find((p) => !inLup.has(p.id) && p.active !== false)
    ?? full.awayTeam.players.find((p) => !inLup.has(p.id) && p.active !== false);
  const tid = full.homeTeam.players.includes(extra) ? full.homeTeamId : full.awayTeamId;
  if (!extra) throw new Error('todos los del roster ya están en el lineup');
  log(`extra elegido: ${extra.firstName} ${extra.lastName} (${tid === full.homeTeamId ? 'home' : 'away'}) · lineup actual=${full.lineups.filter((l) => l.teamId === tid).length}`);

  // temporada antes (directo de PlayerSeasonStat vía prisma CLI inline es lento;
  // usamos la tarjeta full que sí existe)
  const card0 = await j(await fetch(`${B}/stats/players/${extra.id}/full`, { headers: H }));
  const abBefore = JSON.stringify(card0).match(/"ab":(\d+)/)?.[1] ?? '0';

  // 1) PUT: agregar con stats + al lineup
  const r1 = await fetch(`${B}/games/${g.id}/stat-lines/${extra.id}`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({
      teamId: tid,
      stats: { pa: 4, ab: 4, r: 1, h: 2, doubles: 1, rbi: 2, bb: 0, k: 1, po: 3, a: 2 },
      lineup: { add: true, position: 'RF' },
    }),
  });
  const d1 = await r1.json();
  log(`PUT → ${r1.status} line=${JSON.stringify(d1.line)} lineupAdded=${d1.lineupAdded} seasonAdjusted=${d1.seasonAdjusted}`);

  // 2) verificar que quedó en el lineup (orden siguiente)
  const lu = (await j(await fetch(`${B}/games/${g.id}`, { headers: H }))).lineups
    .filter((l) => l.playerId === extra.id);
  log(`lineup entries del jugador: ${lu.length} (order=${lu[0]?.order}, pos=${lu[0]?.position}, role=${lu[0]?.role})`);

  // 3) editar: h 2→3
  const r2 = await fetch(`${B}/games/${g.id}/stat-lines/${extra.id}`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ teamId: tid, stats: { pa: 4, ab: 4, r: 1, h: 3, doubles: 1, rbi: 2, k: 1, po: 3, a: 2 } }),
  });
  const d2 = await r2.json();
  log(`edit → ${r2.status} line.h=${d2.line?.h} seasonAdjusted=${d2.seasonAdjusted}`);

  // 4) temporada después
  const after = JSON.stringify(await j(await fetch(`${B}/stats/players/${extra.id}/full`, { headers: H })));
  const abAfter = after.match(/"ab":(\d+)/)?.[1] ?? '0';
  log(`temporada ab: ${abBefore} → ${abAfter} (esperado +4)`);

  // 5) sin permiso: anotador/anon → 401/403
  const r3 = await fetch(`${B}/games/${g.id}/stat-lines/${extra.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stats: { ab: 1 } }),
  });
  log(`sin token → ${r3.status} (esperado 401/403)`);

  // 6) DELETE quitando del lineup → revertir todo
  const r4 = await fetch(`${B}/games/${g.id}/stat-lines/${extra.id}?lineup=1`, { method: 'DELETE', headers: H });
  const d4 = await r4.json();
  log(`DELETE → ${r4.status} statLines quedan: ${(d4.statLines ?? []).length}`);
  const final = await j(await fetch(`${B}/games/${g.id}`, { headers: H }));
  log(`lineup vuelve a ${final.lineups.filter((l) => l.teamId === tid).length} · statLines=${(final.statLines ?? []).length}`);
  const abEnd = JSON.stringify(await j(await fetch(`${B}/stats/players/${extra.id}/full`, { headers: H }))).match(/"ab":(\d+)/)?.[1] ?? '0';
  log(`temporada ab final: ${abEnd} (debe volver a ${abBefore})`);
};
main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
