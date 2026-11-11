const fs = require('fs');
const B = 'http://localhost:4000/api';
const j = (r) => r.json();
const main = async () => {
  const tok = (await j(await fetch(`${B}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  }))).token;
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };
  const leagues = await j(await fetch(`${B}/leagues`, { headers: H }));
  const lg = leagues.find((l) => l.name === 'PRUEBA BOX 2019');
  const detail = await j(await fetch(`${B}/leagues/${lg.id}`, { headers: H }));
  const dunas = detail.teams.find(t => t.name === 'LAS DUNAS');
  const bahia = detail.teams.find(t => t.name === 'ARROYO BAHIA');
  const bahiaFull = await j(await fetch(`${B}/teams/${bahia.id}`, { headers: H }));
  const pena = bahiaFull.players.find(p => p.lastName === 'Peña'); // ya está en BAHIA (traspaso previo)
  console.log('Peña ahora vive en:', bahia.name);
  const text = fs.readFileSync('C:/app/poxscore/BOX/03-30-19  las dunas  at  arroyo bahia.box.txt').toString('latin1');
  const r = await j(await fetch(`${B}/import/boxscore`, { method: 'POST', headers: H,
    body: JSON.stringify({ leagueId: lg.id, name: 'x.box.txt', data: text, dry: true }) }));
  const row = r.players.find(p => p.file === 'Peña' && p.section === 'bat');
  console.log('Peña (archivo: DUNAS) → match:', row.matchName, '· hoy en:', row.matchTeam, '· moved:', row.moved, '· score:', row.matchScore);
  console.log('candidates:', row.candidates.map(c => `${c.name}(${c.team})`).join(' | '));
  console.log('roster búsqueda manual:', r.roster.length, 'jugadores ·', r.roster.slice(0,3).map(x=>x.name).join(', '));
  // revertir traspaso: Peña vuelve a DUNAS
  await fetch(`${B}/teams/${bahia.id}/players/${pena.id}`, { method: 'PUT', headers: H,
    body: JSON.stringify({ firstName: pena.firstName, lastName: pena.lastName, teamId: dunas.id }) });
  const dunasFull = await j(await fetch(`${B}/teams/${dunas.id}`, { headers: H }));
  console.log('revertido ✓ Peña está de vuelta en DUNAS:', dunasFull.players.some(p => p.id === pena.id));
};
main().catch(e => { console.error(e); process.exit(1); });
