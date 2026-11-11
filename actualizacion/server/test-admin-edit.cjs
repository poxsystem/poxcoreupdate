const B = 'http://localhost:4000/api';
const j = (r) => r.json();
const req = (p, o = {}) => fetch(B + p, o).then(async (r) => ({ st: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));

(async () => {
  // 1. login admin
  const login = await req('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  if (login.st !== 200) { console.log('LOGIN FAIL', login.st, login.body); return; }
  const tok = login.body.token;
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };
  console.log('login admin: OK');

  // 2. un juego FINAL con eventos
  const games = (await req('/games')).body;
  const fin = games.filter((g) => g.status === 'FINAL' && (g._count?.events ?? 1) > 3)[0];
  if (!fin) { console.log('sin juegos FINAL con eventos'); return; }
  console.log('juego:', fin.id, fin.awayTeam?.shortName, '@', fin.homeTeam?.shortName, fin.status);

  const evs = (await req(`/games/${fin.id}/events`)).body;
  console.log('eventos:', evs.length);
  const pa = evs.filter((e) => !['B', 'S', 'F', 'EI', 'ADJ', 'RBI', 'EU', 'LG', 'AO', 'SK', 'GR'].includes(e.result));
  const target = pa.find((e) => e.result === '3B') ?? pa.find((e) => ['1B', '2B'].includes(e.result)) ?? pa[0];
  console.log('jugada a editar: seq', target.seq, target.result, 'not:', target.notation);

  // 3. sin token → 401/403
  const noTok = await req(`/games/${fin.id}/events/${target.seq}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: 'HR' }) });
  console.log('PUT sin token →', noTok.st, noTok.st === 401 || noTok.st === 403 ? '✓' : '✗');

  // 4. anotador no-admin → 403
  const reg = await req('/auth/register', { method: 'POST', headers: H, body: JSON.stringify({ username: 'test_anot', password: 'x12345', role: 'anotador' }) });
  if (reg.st === 200 || reg.st === 201) {
    const t2 = (await req('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test_anot', password: 'x12345' }) })).body.token;
    const r2 = await req(`/games/${fin.id}/events/${target.seq}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t2}` }, body: JSON.stringify({ result: 'HR' }) });
    console.log('PUT anotador →', r2.st, r2.st === 403 ? '✓' : '✗');
  } else console.log('registro anotador:', reg.st, reg.body?.error ?? '');

  // 5. admin edita: 3B → HR
  const newResult = target.result === 'HR' ? '1B' : 'HR';
  const put = await req(`/games/${fin.id}/events/${target.seq}`, { method: 'PUT', headers: H, body: JSON.stringify({ result: newResult }) });
  console.log(`PUT admin ${target.result}→${newResult} →`, put.st, put.body?.event?.result === newResult ? '✓' : '✗', 'marcador', put.body?.state?.score?.away, '-', put.body?.state?.score?.home);

  // 6. notación → créditos recalculados ("6-4-3" DP: A:6,4 PO:4,3)
  const put2 = await req(`/games/${fin.id}/events/${target.seq}`, { method: 'PUT', headers: H, body: JSON.stringify({ result: 'DP', notation: '6-4-3' }) });
  const ev2 = put2.body?.event;
  console.log('PUT notación 6-4-3 →', put2.st, 'PO:', JSON.stringify(ev2?.putouts), 'A:', JSON.stringify(ev2?.assists));

  // 7. restaurar original
  const put3 = await req(`/games/${fin.id}/events/${target.seq}`, { method: 'PUT', headers: H, body: JSON.stringify({ result: target.result, notation: target.notation }) });
  console.log('restaurar →', put3.st, put3.body?.event?.result === target.result ? '✓' : '✗');

  // 8. seq inexistente → 404 controlado
  const put404 = await req(`/games/${fin.id}/events/99999`, { method: 'PUT', headers: H, body: JSON.stringify({ result: 'HR' }) });
  console.log('PUT seq inexistente →', put404.st, put404.st === 404 ? '✓' : '✗');

  // 9. malformados → 400
  const bad = await req(`/games/${fin.id}/events/${target.seq}`, { method: 'PUT', headers: H, body: JSON.stringify({ inning: 'abc' }) });
  const bad2 = await req(`/games/${fin.id}/events/${target.seq}`, { method: 'PUT', headers: H, body: JSON.stringify({ advances: 'x' }) });
  console.log('inning NaN →', bad.st, bad.st === 400 ? '✓' : '✗', '| advances no-array →', bad2.st, bad2.st === 400 ? '✓' : '✗');

  // 10. decisiones: wpId↔lpId y vuelta
  const game = (await req(`/games/${fin.id}`)).body;
  const dec = await req(`/games/${fin.id}/decisions`, { method: 'PUT', headers: H, body: JSON.stringify({ lpId: game.wpId ?? null, wpId: game.lpId ?? null }) });
  console.log('decisions swap W/L →', dec.st, dec.body?.wpId === (game.lpId ?? null) ? '✓' : '✗');
  const dec2 = await req(`/games/${fin.id}/decisions`, { method: 'PUT', headers: H, body: JSON.stringify({ wpId: game.wpId ?? null, lpId: game.lpId ?? null }) });
  console.log('decisions restaurar →', dec2.st, '✓');
  const dec404 = await req(`/games/noexiste/decisions`, { method: 'PUT', headers: H, body: JSON.stringify({ wpId: null }) });
  console.log('decisions juego inexistente →', dec404.st, dec404.st === 404 ? '✓' : '✗');

  // 11. juego sigue FINAL (no reabierto)
  const after = (await req(`/games/${fin.id}`)).body;
  console.log('status tras ediciones:', after.status, after.status === 'FINAL' ? '✓' : '✗');

  // limpiar usuario de prueba
  const users = (await req('/auth/users', { headers: H })).body;
  const tu = users?.find?.((u) => u.username === 'test_anot');
  if (tu) await req(`/auth/users/${tu.id}`, { method: 'DELETE', headers: H });
})().catch((e) => { console.log('EXC', e); process.exit(1); });
