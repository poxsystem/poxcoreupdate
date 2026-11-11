const B = 'http://localhost:4000/api';
const j = (r) => r.json();
const log = (...a) => console.log(...a);

const main = async () => {
  const tok = (await j(await fetch(`${B}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }))).token;
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };

  // limpiar juego desechable colgado de la corrida anterior
  const stale = (await j(await fetch(`${B}/games`, { headers: H }))).find((x) => x.id === 'cmv4nh7j');
  if (stale) {
    // borrar evento y luego el juego
    await fetch(`${B}/games/${stale.id}/events`, { method: 'DELETE', headers: H });
    const d = await fetch(`${B}/games/${stale.id}`, { method: 'DELETE', headers: H, body: JSON.stringify({ password: 'admin123' }) });
    log(`stale borrado → ${d.status}`);
  }

  const leagues = await j(await fetch(`${B}/leagues`, { headers: H }));
  const lg = leagues.find((l) => l.name.includes('PRUEBA BOX'));
  const lfull = await j(await fetch(`${B}/leagues/${lg.id}`, { headers: H }));
  const [t1, t2] = lfull.teams;
  const t1f = await j(await fetch(`${B}/teams/${t1.id}`, { headers: H }));

  const g = await j(await fetch(`${B}/games`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ leagueId: lg.id, awayTeamId: t1.id, homeTeamId: t2.id, innings: 7 }),
  }));
  const batter = t1f.players[0];
  const r1 = await j(await fetch(`${B}/games/${g.id}/events`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      result: '2B', notation: '9', inning: 1, half: 'TOP',
      batterId: batter.id, advances: [{ playerId: batter.id, to: '2B' }],
      sprayDir: 30, sprayDist: 92, clientKey: 'spray-test-1',
    }),
  }));
  log(`POST → sprayDir=${r1.event.sprayDir} sprayDist=${r1.event.sprayDist}`);

  // PUT por seq: corregir a HR por CF (dir 0, dist 110)
  const r2 = await fetch(`${B}/games/${g.id}/events/${r1.event.seq}`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ sprayDir: 0, sprayDist: 110 }),
  });
  const b2 = await j(r2);
  log(`PUT ${r2.status} → sprayDir=${b2.event?.sprayDir} sprayDist=${b2.event?.sprayDist}`);

  // quitar el spray (null explícito)
  const r3 = await fetch(`${B}/games/${g.id}/events/${r1.event.seq}`, {
    method: 'PUT', headers: H,
    body: JSON.stringify({ sprayDir: null, sprayDist: null }),
  });
  const b3 = await j(r3);
  log(`PUT null → sprayDir=${b3.event?.sprayDir} (esperado null)`);

  const bad = await fetch(`${B}/games/${g.id}/events`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ result: '1B', notation: '7', inning: 1, half: 'TOP', batterId: batter.id, advances: [{ playerId: batter.id, to: '1B' }], sprayDir: 999, sprayDist: 50 }),
  });
  log(`sprayDir=999 → HTTP ${bad.status} (esperado 400)`);

  await fetch(`${B}/games/${g.id}/events`, { method: 'DELETE', headers: H });
  const del = await fetch(`${B}/games/${g.id}`, { method: 'DELETE', headers: H, body: JSON.stringify({ password: 'admin123' }) });
  log(`DELETE juego → ${del.status}`);
};
main().catch((e) => { console.error(e); process.exit(1); });
