// Lote end-to-end sobre liga desechable: preview x4 + commit secuencial
const fs = require('fs');
const B = 'http://localhost:4000/api';
const j = (r) => r.json();
const main = async () => {
  const tok = (await j(await fetch(`${B}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }))).token;
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };
  // liga desechable con los 3 equipos vacíos
  const lg = await j(await fetch(`${B}/leagues`, { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'TMP BATCH TEST', year: 2019, sport: 'softball' }) }));
  for (const tn of ['EL MANACLAR', 'LAS DUNAS', 'ARROYO BAHIA'])
    await fetch(`${B}/teams`, { method: 'POST', headers: H, body: JSON.stringify({ name: tn, leagueId: lg.id }) });
  // lote: analizar + importar cada archivo (jugadores se crean al vuelo)
  for (const f of fs.readdirSync('C:/app/poxscore/BOX').filter(x => x.endsWith('.txt'))) {
    const text = fs.readFileSync(`C:/app/poxscore/BOX/${f}`).toString('latin1');
    const p = await j(await fetch(`${B}/import/boxscore`, { method: 'POST', headers: H,
      body: JSON.stringify({ leagueId: lg.id, name: f, data: text, dry: true }) }));
    const ov = {}; for (const pl of p.players) ov[pl.key] = pl.matchId ?? 'NEW';
    const r = await j(await fetch(`${B}/import/boxscore`, { method: 'POST', headers: H,
      body: JSON.stringify({ leagueId: lg.id, name: f, data: text,
        awayTeamId: p.awayTeam.teamId, homeTeamId: p.homeTeam.teamId, overrides: ov }) }));
    console.log(`${f.slice(0, 26)} → game ${r.gameId?.slice(-6) ?? r.error} · ${r.players} líneas · ${r.created} creados · skip:${r.skipped?.length ?? 0}`);
  }
  // verificar acumulados
  const det = await j(await fetch(`${B}/leagues/${lg.id}`, { headers: H }));
  console.log('juegos en liga:', det.games?.length ?? '?');
  for (const t of det.teams) {
    const tf = await j(await fetch(`${B}/teams/${t.id}`, { headers: H }));
    console.log(`  ${t.name}: ${tf.players.length} jugadores`);
  }
  // limpiar liga desechable
  const del = await fetch(`${B}/leagues/${lg.id}/delete`, { method: 'POST', headers: H, body: JSON.stringify({ password: 'admin123' }) });
  console.log('liga temporal borrada:', del.status);
};
main().catch(e => { console.error(e); process.exit(1); });
