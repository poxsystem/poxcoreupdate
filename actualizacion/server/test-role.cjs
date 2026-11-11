const B = 'http://localhost:4000/api';
const req = (p, o = {}) => fetch(B + p, o).then(async (r) => ({ st: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));
(async () => {
  const H = { 'Content-Type': 'application/json' };
  const login = await req('/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  const AH = { ...H, Authorization: `Bearer ${login.body.token}` };
  // crear anotador de prueba
  const mk = await req('/auth/users', { method: 'POST', headers: AH, body: JSON.stringify({ username: 'test_anot', password: 'x12345', role: 'anotador' }) });
  console.log('crear anotador:', mk.st, mk.body?.user?.username ?? mk.body?.error ?? '');
  const l2 = await req('/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ username: 'test_anot', password: 'x12345' }) });
  if (l2.st !== 200) { console.log('login anotador FAIL', l2.st); }
  else {
    const TH = { ...H, Authorization: `Bearer ${l2.body.token}` };
    const games = (await req('/games')).body;
    const fin = games.find((g) => g.status === 'FINAL' && (g._count?.events ?? 1) > 3);
    const evs = (await req(`/games/${fin.id}/events`)).body;
    const r1 = await req(`/games/${fin.id}/events/${evs[0].seq}`, { method: 'PUT', headers: TH, body: JSON.stringify({ result: 'HR' }) });
    const r2 = await req(`/games/${fin.id}/decisions`, { method: 'PUT', headers: TH, body: JSON.stringify({ wpId: null }) });
    console.log('PUT evento como anotador →', r1.st, r1.st === 403 ? '✓' : '✗');
    console.log('PUT decisions como anotador →', r2.st, r2.st === 403 ? '✓' : '✗');
  }
  // borrar usuario de prueba
  const users = (await req('/auth/users', { headers: AH })).body;
  const tu = users?.find?.((u) => u.username === 'test_anot');
  if (tu) console.log('borrar test_anot:', (await req(`/auth/users/${tu.id}`, { method: 'DELETE', headers: AH })).st);
})().catch(console.error);
