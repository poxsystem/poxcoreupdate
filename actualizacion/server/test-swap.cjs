const B = 'http://localhost:4000/api';
const req = (p, o = {}) => fetch(B + p, o).then(async (r) => ({ st: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) }));
(async () => {
  const H = { 'Content-Type': 'application/json' };
  const login = await req('/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
  const AH = { ...H, Authorization: `Bearer ${login.body.token}` };
  const games = (await req('/games')).body;
  const fin = games.find((g) => g.status === 'FINAL' && (g._count?.events ?? 1) > 5);
  const g = (await req(`/games/${fin.id}`)).body;
  // jugador A: alguien del lineup que bateó (tiene eventos)
  const evs = (await req(`/games/${fin.id}/events`)).body;
  const batterIds = new Set(evs.map((e) => e.batterId).filter(Boolean));
  const lu = g.lineups.find((l) => batterIds.has(l.playerId));
  const teamId = lu.teamId;
  const roster = teamId === g.homeTeam.id ? g.homeTeam.players : g.awayTeam.players;
  // B: jugador del roster que NO esté en el lineup (el caso "dejado fuera")
  const B = roster.find((p) => !g.lineups.some((l) => l.playerId === p.id && l.teamId === teamId) && p.id !== lu.playerId);
  console.log('juego:', fin.id, '| lineup:', lu.player.firstName, lu.player.lastName, '→ roster:', B?.firstName, B?.lastName);
  if (!B) { console.log('todo el roster está en el lineup — no puedo probar el caso "fuera del lineup"'); }
  const before = {
    evCount: evs.filter((e) => e.batterId === lu.playerId || e.pitcherId === lu.playerId).length,
    luPid: lu.playerId,
  };
  console.log('eventos con A antes:', before.evCount);
  if (B) {
    const sw = await req(`/games/${fin.id}/swap-player`, { method: 'POST', headers: AH, body: JSON.stringify({ teamId, aId: lu.playerId, bId: B.id }) });
    console.log('swap →', sw.st, 'eventsFixed:', sw.body?.eventsFixed, 'swapped:', sw.body?.swapped);
    const evs2 = (await req(`/games/${fin.id}/events`)).body;
    const stillA = evs2.filter((e) => e.batterId === lu.playerId || e.pitcherId === lu.playerId).length;
    const nowB = evs2.filter((e) => e.batterId === B.id || e.pitcherId === B.id).length;
    console.log('eventos con A después:', stillA, stillA === 0 ? '✓' : '✗', '| con B:', nowB, nowB === before.evCount ? '✓' : '✗');
    const g2 = (await req(`/games/${fin.id}`)).body;
    const lu2 = g2.lineups.find((l) => l.id === lu.id);
    console.log('lineupEntry ahora →', lu2?.player?.firstName, lu2?.player?.lastName, lu2?.playerId === B.id ? '✓' : '✗');
    // revertir
    const sw2 = await req(`/games/${fin.id}/swap-player`, { method: 'POST', headers: AH, body: JSON.stringify({ teamId, aId: B.id, bId: lu.playerId }) });
    const evs3 = (await req(`/games/${fin.id}/events`)).body;
    const backA = evs3.filter((e) => e.batterId === lu.playerId || e.pitcherId === lu.playerId).length;
    console.log('revertir →', sw2.st, '| eventos de A otra vez:', backA, backA === before.evCount ? '✓' : '✗');
  }
  // swaps malos
  const bad1 = await req(`/games/${fin.id}/swap-player`, { method: 'POST', headers: AH, body: JSON.stringify({ teamId, aId: lu.playerId, bId: lu.playerId }) });
  const bad2 = await req(`/games/${fin.id}/swap-player`, { method: 'POST', headers: AH, body: JSON.stringify({ teamId, aId: 'noexiste', bId: lu.playerId }) });
  console.log('mismo jugador →', bad1.st, bad1.st === 400 ? '✓' : '✗', '| A inexistente →', bad2.st, [400, 404].includes(bad2.st) ? '✓' : '✗');
})().catch(console.error);
