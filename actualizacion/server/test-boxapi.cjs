const B = 'http://localhost:4000/api';
const fs = require('fs');
const req = (p, o = {}) => fetch(B + p, o).then(async (r) => ({ st: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));
(async () => {
  const H = { 'Content-Type': 'application/json' };
  const login = await req('/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  const AH = { ...H, Authorization: `Bearer ${login.body.token}` };
  const leagues = (await req('/leagues')).body;
  // liga con equipos con roster
  let lg = null;
  for (const l of leagues) {
    const full = (await req(`/leagues/${l.id}`)).body;
    if ((full.teams ?? []).length >= 2) { lg = full; break; }
  }
  if (!lg) { console.log('sin liga con equipos'); return; }
  console.log('liga:', lg.name, '—', lg.teams.map((t) => t.name).join(', '));

  // arma el box con nombres REALES de dos equipos de la liga
  const t1 = lg.teams[0], t2 = lg.teams[1];
  const p1 = t1.players?.[0], p2 = t2.players?.[0];
  console.log('equipos:', t1.name, 'vs', t2.name);
  const n1 = p1 ? `${p1.lastName.toUpperCase()}, ${p1.firstName}` : 'RIVERA, Pablo';
  const n2 = p2 ? `${p2.lastName.toUpperCase()}, ${p2.firstName}` : 'GOMEZ, Luis';
  const data = `BallScore Box Score
PRUEBA
Octubre 10, 2026

                          1  2  3  4  5  6  7   R  H  E
${t1.name.toUpperCase()}                0  1  0  3  0  1  0   5  9  1
${t2.name.toUpperCase()}                   2  0  0  0  0  0  x   2  5  0

${t1.name.toUpperCase()} Batting            AB  R  H RBI 2B 3B HR BB SO SB
${n1} cf             4  2  3  1  1  0  0  0  1  0
NUEVO, Jugador 1b          4  1  2  2  0  0  1  0  0  0
Totals                      33  5  9  5  2  0  1  2  5  1

${t1.name.toUpperCase()} Pitching           IP  H  R ER BB SO HR
${n1} (W)            7  5  2  1  1  6  0
Totals                       7  5  2  1  1  6  0

${t2.name.toUpperCase()} Batting            AB  R  H RBI 2B 3B HR BB SO SB
${n2} ss             3  1  1  0  0  0  0  1  0  0
Totals                      28  2  5  2  0  0  0  2  6  0

${t2.name.toUpperCase()} Pitching           IP  H  R ER BB SO HR
${n2} (L)            6.2  8  5  4  2  4  1
Totals                       6.2  8  5  4  2  4  1
`;
  fs.writeFileSync('test-real.box.txt', data);

  // 1. DRY — vista previa con matches
  const dry = await req('/import/boxscore', { method: 'POST', headers: AH, body: JSON.stringify({ leagueId: lg.id, name: '10-10-26 box.box.txt', data, dry: true }) });
  console.log('dry →', dry.st);
  if (dry.st !== 200) { console.log(dry.body); return; }
  const b = dry.body;
  console.log('box:', b.box.away, b.box.scoreAway, '@', b.box.home, b.box.scoreHome, b.box.dateIso);
  console.log('equipos:', JSON.stringify(b.teams));
  for (const p of b.players) console.log(` ${p.file} → ${p.matchName ?? 'NUEVO'} (${p.matchScore}%) [${p.section}]`);
  console.log('dup:', b.dupGameId, 'warns:', b.warnings);

  // 2. COMMIT
  const ov = {};
  for (const p of b.players) ov[p.key] = p.matchId ?? 'NEW';
  const imp = await req('/import/boxscore', { method: 'POST', headers: AH, body: JSON.stringify({ leagueId: lg.id, name: 'x.box.txt', data, awayTeamId: b.awayTeam.teamId, homeTeamId: b.homeTeam.teamId, overrides: ov }) });
  console.log('commit →', imp.st, JSON.stringify(imp.body));
  if (imp.st === 200) {
    const g = (await req(`/games/${imp.body.gameId}`)).body;
    console.log('juego:', g.awayTeam?.shortName, g.fScoreAway, '@', g.homeTeam?.shortName, g.fScoreHome, g.status, '| statLines:', (g.statLines ?? []).length, '| wp:', g.wpId?.slice(-4), 'lp:', g.lpId?.slice(-4));
    for (const l of g.statLines ?? []) console.log('  line:', JSON.stringify(l).slice(0, 140));
  }
  // 3. anotador no puede (401/403)
  const noTok = await req('/import/boxscore', { method: 'POST', headers: H, body: JSON.stringify({ leagueId: lg.id, data: 'x' }) });
  console.log('sin token →', noTok.st);
})().catch(console.error);
