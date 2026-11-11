import { api, Game } from '../api';

/**
 * Genera una tarjeta PNG del resultado (canvas client-side, sin dependencias):
 * marcador, línea score, mejores bateadores — para compartir por WhatsApp/Facebook.
 */
export async function downloadScorecard(g: Game) {
  const box = await api.boxscore(g.id);
  const W = 1080, H = 1080;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;

  // fondo navy con banda ámbar (paleta PoxScore)
  ctx.fillStyle = '#0d1b2a'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#f5a623'; ctx.fillRect(0, 0, W, 14); ctx.fillRect(0, H - 14, W, 14);
  ctx.fillStyle = '#12293f'; ctx.fillRect(60, 200, W - 120, 460);

  const league = g.league ? `${g.league.name} ${g.league.year}` : 'PoxScore';
  const fecha = new Date(g.date).toLocaleDateString('es-DO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  ctx.textAlign = 'center';
  ctx.fillStyle = '#f5a623';
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.fillText(league.toUpperCase(), W / 2, 110);
  ctx.fillStyle = '#9fb3c8';
  ctx.font = '30px system-ui, sans-serif';
  ctx.fillText(fecha + (g.stadium ? ` · ${g.stadium}` : ''), W / 2, 160);

  // marcador
  const away = g.awayTeam?.name ?? 'Visitante', home = g.homeTeam?.name ?? 'Local';
  const sa = g.state?.score?.away ?? g.fScoreAway ?? 0;
  const sh = g.state?.score?.home ?? g.fScoreHome ?? 0;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 58px system-ui, sans-serif';
  ctx.fillText(away.toUpperCase(), W / 2, 320);
  ctx.fillText(home.toUpperCase(), W / 2, 560);
  ctx.font = 'bold 140px system-ui, sans-serif';
  ctx.fillStyle = '#f5a623';
  ctx.fillText(String(sa), W / 2 - 260, 480);
  ctx.fillText(String(sh), W / 2 + 260, 480);
  ctx.fillStyle = '#9fb3c8';
  ctx.font = '60px system-ui, sans-serif';
  ctx.fillText('—', W / 2, 465);
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.fillStyle = g.status === 'FINAL' ? '#7ec96f' : '#e05d5d';
  ctx.fillText(g.status === 'FINAL' ? 'FINAL' : g.status === 'LIVE' ? 'EN VIVO' : g.status, W / 2, 640);

  // mejores bateadores (top 3 por hits, empate CI)
  const nameOf = (pid: string) => {
    const p = [...(g.homeTeam?.players ?? []), ...(g.awayTeam?.players ?? [])].find((x) => x.id === pid);
    return p ? `${p.firstName} ${p.lastName}` : '?';
  };
  const all = [
    ...Object.values(box.away).map((b) => ({ ...b, team: g.awayTeam?.shortName ?? away })),
    ...Object.values(box.home).map((b) => ({ ...b, team: g.homeTeam?.shortName ?? home })),
  ].filter((b) => b.ab > 0).sort((x, y) => y.h - x.h || y.rbi - x.rbi).slice(0, 3);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#f5a623';
  ctx.font = 'bold 32px system-ui, sans-serif';
  ctx.fillText('DESTACADOS', 80, 750);
  ctx.font = '30px system-ui, sans-serif';
  ctx.fillStyle = '#fff';
  all.forEach((b, i) => {
    const y = 800 + i * 48;
    ctx.fillText(`${nameOf(b.playerId).toUpperCase()} (${b.team})`, 80, y);
    ctx.fillStyle = '#9fb3c8';
    ctx.fillText(`${b.h}-${b.ab} · ${b.rbi} CI${b.hr ? ` · ${b.hr} HR` : ''}`, W - 460, y);
    ctx.fillStyle = '#fff';
  });

  ctx.textAlign = 'center';
  ctx.fillStyle = '#5a728a';
  ctx.font = '24px system-ui, sans-serif';
  ctx.fillText('PoxScore · Desarrollado por Alexis Lara', W / 2, H - 60);

  const a = document.createElement('a');
  a.download = `resultado-${away}-vs-${home}.png`.replace(/\s+/g, '-');
  a.href = cv.toDataURL('image/png');
  a.click();
}
