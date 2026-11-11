// Prueba end-to-end: ZIP de .box.txt → totales por jugador → comparar → aplicar
const B = 'http://localhost:4000/api';
const fs = require('fs');
const j = (r) => r.json();
const log = (...a) => console.log(...a);

const main = async () => {
  const tok = (await j(await fetch(`${B}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }))).token;
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };

  const leagues = await j(await fetch(`${B}/leagues`, { headers: H }));
  const lg = leagues.find((l) => l.name.includes('PRUEBA BOX'));
  const lfull = await j(await fetch(`${B}/leagues/${lg.id}`, { headers: H }));
  // jugador real: un bateador de LAS DUNAS que esté en los archivos
  const team = lfull.teams.find((t) => t.name.includes('DUNAS'));
  const tf = await j(await fetch(`${B}/teams/${team.id}`, { headers: H }));
  const p = tf.players.find((x) => /chalas/i.test(x.lastName)) ?? tf.players[0];
  log(`jugador: ${p.firstName} ${p.lastName} (${team.name})`);

  const zip64 = fs.readFileSync('C:/app/poxscore/BOX/test-totals.zip').toString('base64');
  const r = await j(await fetch(`${B}/import/boxscore/zip-totals`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ leagueId: lg.id, playerId: p.id, data: zip64 }),
  }));
  log(`files=${r.files} skipped=${r.skipped?.length ?? 0} year=${r.year} players=${r.players.length}`);
  const sug = r.players.filter((x) => x.suggested);
  log(`sugeridas: ${sug.map((s) => `${s.name} (${s.team}) JJ=${s.stats.g} H=${s.stats.h} AB=${s.stats.ab}`).join(' | ') || 'ninguna'}`);
  const mine = r.players.find((x) => x.suggested);
  if (mine) {
    log(`totales zip: ${JSON.stringify(mine.stats)}`);
    log(`actual temporada: ${JSON.stringify(r.current)}`);
    // aplicar → PUT season con los totales del zip
    const body = { season: r.year };
    for (const k of ['g','pa','ab','r','h','doubles','triples','hr','rbi','bb','k','hbp','sac','sf','sb','gp','gs','w','l','sv','hld','bs','cg','sho','pOuts','pH','pR','pER','pBB','pK','pHR','pPitches','e'])
      body[k] = mine.stats[k] ?? 0;
    const ap = await j(await fetch(`${B}/stats/players/${p.id}/season`, {
      method: 'PUT', headers: H, body: JSON.stringify(body),
    }));
    log(`apply → g=${ap.stat.g} ab=${ap.stat.ab} h=${ap.stat.h} w=${ap.stat.w} l=${ap.stat.l}`);
    // re-preview: current ahora debe igualar el zip
    const r2 = await j(await fetch(`${B}/import/boxscore/zip-totals`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ leagueId: lg.id, playerId: p.id, data: zip64 }),
    }));
    const diffs = Object.keys(body).filter((k) => k !== 'season' && (r2.current?.[k] ?? 0) !== body[k]);
    log(`verificación: diffs tras aplicar = ${diffs.length ? diffs.join(',') : 'NINGUNA ✓'}`);
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
