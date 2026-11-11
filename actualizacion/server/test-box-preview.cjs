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
  for (const file of fs.readdirSync('C:/app/poxscore/BOX').filter(f => f.endsWith('.txt'))) {
    const text = Buffer.from(fs.readFileSync(`C:/app/poxscore/BOX/${file}`)).toString('latin1');
    const r = await fetch(`${B}/import/boxscore`, { method: 'POST', headers: H,
      body: JSON.stringify({ leagueId: lg.id, name: file, data: text, dry: true }) });
    const p = await r.json();
    if (r.status !== 200) { console.log(file, '→', r.status, JSON.stringify(p).slice(0, 200)); continue; }
    const rows = p.players ?? [];
    const notAuto = rows.filter(x => x.action !== 'auto');
    const low = rows.filter(x => x.action === 'auto' && x.matchScore < 78);
    console.log(`\n═══ ${file}`);
    console.log(`   ${p.box.away} ${p.box.scoreAway} @ ${p.box.home} ${p.box.scoreHome} · ${p.box.dateIso} · ${p.box.innings} inn · W:${p.box.wp ?? '-'} L:${p.box.lp ?? '-'}`);
    console.log(`   filas ${rows.length} · auto ${rows.length - notAuto.length} · revisar ${notAuto.length}`);
    for (const m of notAuto) console.log(`   ⚠ ${m.file} (${m.teamFile}) → ${m.matchName ?? '➕ crear'} [${m.matchScore}]`);
    for (const m of low) console.log(`   ~ ${m.file} → ${m.matchName} [${m.matchScore}]`);
    if (p.warnings?.length) console.log('   warnings:', p.warnings.slice(0, 4).join(' | '));
  }
};
main().catch(e => { console.error(e); process.exit(1); });
