/**
 * Website Builder (BallStat): genera el sitio estático del torneo en UN solo HTML.
 * Router por hash — páginas internas: inicio (posiciones/resultados/totales),
 * equipo, jugador (línea + log juego a juego), juego (boxscore) y líderes.
 * Responsive (tablas con scroll horizontal) e imprimible.
 */
import { prisma } from './prisma.js';
import { leagueStats, leagueStandings } from './routes/leagues.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
));
// Celda "tapada en rojo" para entidades excluidas de la publicación (blocked):
// la redacción deja sus números en null y los formateadores dibujan el bloque.
const BLKCELL = '<span class="blk">██</span>';
const f3 = (n: number | null) => (n == null || !isFinite(n) ? BLKCELL : n ? n.toFixed(3).replace(/^0/, '') : '.000');
const f2 = (n: number | null) => (n == null || !isFinite(n) ? BLKCELL : n.toFixed(2));
const ipOf = (outs: number | null) => (outs == null ? BLKCELL : `${Math.floor(outs / 3)}${outs % 3 ? `.${outs % 3}` : ''}`);
const fecha = (d: Date | string) => new Date(d).toLocaleDateString('es');

export async function websiteHtml(leagueId: string): Promise<string | null> {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    include: { teams: true, seasons: { orderBy: { year: 'desc' } } },
  });
  if (!league) return null;

  // ── Publicación: equipos/jugadores "blocked" conservan sus datos en el
  // sistema pero en el sitio público salen como BLOQUEADO con números tapados.
  const blockedT = new Set(league.teams.filter((t) => t.blocked).map((t) => t.id));
  const blockedNames = new Set(
    league.teams.filter((t) => t.blocked).flatMap((t) => [t.name, t.shortName].filter(Boolean) as string[]));
  const blockedP = new Set((await prisma.player.findMany({
    where: { teamId: { in: league.teams.map((t) => t.id) }, blocked: true },
    select: { id: true },
  })).map((p) => p.id));
  const PBLK = '🔒 BLOQUEADO', TBLK = '🚫 EQUIPO BLOQUEADO';
  // Muto el nombre en league.teams: TODOS los resolutores id→nombre del sitio
  // (series, playoffs, matchups, fichas, buscador) devuelven BLOQUEADO solos.
  for (const t of league.teams) if (t.blocked) { t.name = TBLK; t.shortName = '🚫'; }
  const nullNums = (o: Record<string, unknown>) => {
    for (const k of Object.keys(o)) if (typeof o[k] === 'number') o[k] = null;
  };
  // Muta el Stats recién agregado: nombres → BLOQUEADO, números → null (→ ██).
  const redactStats = <T extends Stats>(st: T): T => {
    if (!blockedP.size && !blockedT.size) return st;
    for (const arr of [st.batting, st.pitching, st.fielding] as unknown as Record<string, unknown>[][]) {
      for (const row of arr) {
        if (blockedP.has(row.playerId as string)) { row.name = PBLK; nullNums(row); }
        if (blockedT.has(row.teamId as string)) { row.teamName = TBLK; row.shortName = '🚫'; }
      }
    }
    for (const [pid, m] of st.meta) {
      if (blockedP.has(pid)) { m.name = PBLK; m.photo = null; }
      if (blockedT.has(m.teamId)) { m.teamName = TBLK; m.shortName = '🚫'; }
    }
    for (const tt of st.teamTotals) if (blockedT.has(tt.teamId)) { tt.name = TBLK; nullNums(tt as unknown as Record<string, unknown>); }
    for (const r of st.results) {
      if (blockedT.has(r.awayId)) r.away = TBLK;
      if (blockedT.has(r.homeId)) r.home = TBLK;
    }
    for (const box of st.boxes.values()) {
      for (const side of [box?.away, box?.home]) {
        if (!side) continue;
        for (const [pid, line] of Object.entries(side)) {
          if (blockedP.has(pid)) {
            const rec = line as unknown as Record<string, unknown>;
            rec.name = PBLK; nullNums(rec);
          }
        }
      }
    }
    for (const arr of st.playerLog.values()) {
      for (const e of arr) if (e.opp && blockedNames.has(e.opp)) e.opp = '🚫';
    }
    for (const l of st.teamGameLines) {
      if (l.opp && blockedNames.has(l.opp)) l.opp = '🚫';
    }
    return st;
  };
  // Reemplaza el nombre de un equipo bloqueado dentro de un texto libre
  // (los nombres de serie vienen embebidos: "Semifinal — Tigres vs Águilas").
  const redactStr = (s: string) => {
    let r = s;
    for (const n of blockedNames) r = r.split(n).join('🚫 BLOQUEADO');
    return r;
  };
  // El equipo bloqueado conserva su fila/posición en la tabla pero dice BLOQUEADO.
  const redactStand = (rows: Stand): Stand => rows.map((t) =>
    (blockedT.has(t.teamId)
      ? { ...t, name: TBLK, w: null, l: null, t: null, rf: null, ra: null, pct: null, diff: null, gb: null }
      : t)) as Stand;

  // Temporadas de la liga: modelos Season (creadas dentro de la liga); si no hay,
  // respaldo = año de fecha de los juegos FINAL (ligas viejas sin temporadas).
  const finals = await prisma.game.findMany({ where: { leagueId, status: 'FINAL' }, select: { date: true } });
  const dateYears = [...new Set(finals.map((g) => new Date(g.date).getFullYear()))].sort((a, b) => b - a);
  const seasonList: { id: string | null; year: number }[] = league.seasons.length
    ? league.seasons.map((s) => ({ id: s.id, year: s.year }))
    : (dateYears.length ? dateYears : [league.year]).map((y) => ({ id: null, year: y }));
  const multiYear = seasonList.length > 1;
  const photoPool = new Map<string, string>(); // una copia por foto; se hidrata en el cliente
  type Stats = Awaited<ReturnType<typeof leagueStats>>;
  type Stand = Awaited<ReturnType<typeof leagueStandings>>;
  type SeriesRow = { id: string; round: number; name: string; homeTeamId: string; awayTeamId: string; winnerTeamId: string | null; winsNeeded: number; seasonId: string | null; _year?: number; games: { id: string; date: Date }[] };
  // todas las series de la liga con sus juegos (para la página de postemporada de cada temporada)
  const allSeries = await prisma.series.findMany({
    where: { leagueId },
    select: { id: true, round: true, name: true, homeTeamId: true, awayTeamId: true, winnerTeamId: true, winsNeeded: true, seasonId: true, games: { select: { id: true, date: true } } },
    orderBy: [{ round: 'asc' }, { createdAt: 'asc' }],
  });

  // ---- Fusión de temporadas → estadísticas de CARRERA ----
  // Suma los conteos de todas las temporadas y recalcula tasas y sabermetría
  // con el contexto de la liga completa (mismas fórmulas que el agregador de leagues.ts).
  const mergeStats = (list: Stats[]): Stats => {
    const regInn = list.find((s) => s.results[0]?.innings)?.results[0]?.innings ?? 9;
    const meta = new Map<string, any>();
    const bat = new Map<string, any>();
    const pit = new Map<string, any>();
    const fld = new Map<string, any>();
    const tt = new Map<string, any>();
    const results: any[] = [];
    const boxes = new Map<string, any>();
    const playerLog = new Map<string, any[]>();
    const teamGameLines: any[] = [];
    const matchups = new Map<string, Map<string, any>>();
    let games = 0;

    const addNum = (m: Map<string, any>, pid: string, src: any, keys: string[]) => {
      const d = m.get(pid) ?? { playerId: pid };
      for (const k of keys) d[k] = (d[k] ?? 0) + (typeof src[k] === 'number' ? src[k] : 0);
      m.set(pid, d);
    };
    const addSitu = (d: any, s: any) => {
      if (!s) return;
      d.situ = d.situ ?? { risp: { ab: 0, h: 0 }, loaded: { ab: 0, h: 0 }, twoOut: { ab: 0, h: 0 }, leadoff: { ab: 0, h: 0 } };
      for (const k of ['risp', 'loaded', 'twoOut', 'leadoff'] as const) { d.situ[k].ab += s[k].ab; d.situ[k].h += s[k].h; }
    };

    // de más vieja a más reciente → meta queda con el equipo más reciente
    for (const st of [...list].reverse()) {
      games += st.games;
      for (const [k, v] of st.meta) meta.set(k, v);
      for (const [k, v] of st.boxes) boxes.set(k, v);
      results.push(...st.results);
      teamGameLines.push(...st.teamGameLines);
      for (const [pid, arr] of st.playerLog) playerLog.set(pid, [...(playerLog.get(pid) ?? []), ...arr]);
      for (const [bid, mm] of st.matchups) {
        const dm = matchups.get(bid) ?? new Map<string, any>();
        for (const [oid, x] of mm) {
          const d = dm.get(oid) ?? { pa: 0, ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, k: 0 };
          for (const k of ['pa', 'ab', 'h', 'hr', 'rbi', 'bb', 'k'] as const) d[k] += x[k];
          dm.set(oid, d);
        }
        matchups.set(bid, dm);
      }
      for (const t of st.teamTotals) {
        const d = tt.get(t.teamId) ?? { teamId: t.teamId, name: t.name };
        for (const k of ['g', 'ab', 'r', 'h', 'doubles', 'triples', 'hr', 'rbi', 'bb', 'k', 'sb', 'lob', 'e', 'pOuts', 'pH', 'pR', 'pER', 'pBB', 'pK'] as const) d[k] = (d[k] ?? 0) + t[k];
        tt.set(t.teamId, d);
      }
      for (const b of st.batting) { addNum(bat, b.playerId, b, ['g', 'pa', 'ab', 'r', 'h', 'doubles', 'triples', 'hr', 'rbi', 'bb', 'k', 'hbp', 'sac', 'sf', 'sb']); addSitu(bat.get(b.playerId), b.situ); }
      for (const p of st.pitching) addNum(pit, p.playerId, p, ['gp', 'gs', 'outs', 'h', 'r', 'er', 'bb', 'k', 'hr', 'pitches', 'bf', 'abAg', 'w', 'l', 'sv', 'hld', 'bs', 'cg', 'sho']);
      for (const f of st.fielding) addNum(fld, f.playerId, f, ['po', 'a', 'e']);
    }
    results.sort((x, y) => +new Date(x.date) - +new Date(y.date));
    for (const arr of playerLog.values()) arr.sort((x, y) => +new Date(x.date) - +new Date(y.date));

    const f3n = (n: number) => Number(n.toFixed(3));
    const f2n = (n: number) => Number(n.toFixed(2));
    const metaOf = (pid: string) => meta.get(pid) ?? { name: '?', teamId: '', teamName: '?', shortName: '?', number: null, bats: null, throws: null, positions: null, photo: null };
    const situZero = { risp: { ab: 0, h: 0 }, loaded: { ab: 0, h: 0 }, twoOut: { ab: 0, h: 0 }, leadoff: { ab: 0, h: 0 } };
    const W = { bb: 0.69, hbp: 0.72, s1: 0.88, d2: 1.25, t3: 1.58, hr: 2.08 };
    const wobaNum = (x: any) => W.bb * x.bb + W.hbp * x.hbp + W.s1 * (x.h - x.doubles - x.triples - x.hr) + W.d2 * x.doubles + W.t3 * x.triples + W.hr * x.hr;
    const wobaDen = (x: any) => x.ab + x.bb + x.hbp + x.sf;
    const lgBat = [...bat.values()].reduce((s, b) => ({ pa: s.pa + b.pa, ab: s.ab + b.ab, h: s.h + b.h, bb: s.bb + b.bb, hbp: s.hbp + b.hbp, sf: s.sf + b.sf, doubles: s.doubles + b.doubles, triples: s.triples + b.triples, hr: s.hr + b.hr }), { pa: 0, ab: 0, h: 0, bb: 0, hbp: 0, sf: 0, doubles: 0, triples: 0, hr: 0 });
    const lgWoba = wobaDen(lgBat) ? wobaNum(lgBat) / wobaDen(lgBat) : 0;
    const lgObp = wobaDen(lgBat) ? (lgBat.h + lgBat.bb + lgBat.hbp) / wobaDen(lgBat) : 0;
    const wobaScale = lgWoba > 0 && lgObp > 0 ? lgObp / lgWoba : 1.15;
    const totalRuns = [...tt.values()].reduce((s, t) => s + t.r, 0);
    const rpw = Math.max(4, totalRuns / Math.max(1, games));
    const lgPit = [...pit.values()].reduce((s, p) => ({ outs: s.outs + p.outs, er: s.er + p.er, hr: s.hr + p.hr, bb: s.bb + p.bb, k: s.k + p.k }), { outs: 0, er: 0, hr: 0, bb: 0, k: 0 });
    const lgIp = lgPit.outs / 3;
    const lgEra = lgIp ? (lgPit.er * regInn) / lgIp : 0;
    const lgFip = lgIp ? (13 * lgPit.hr + 3 * lgPit.bb - 2 * lgPit.k) / lgIp : 0;
    const cFip = lgEra - lgFip;

    const batting = [...bat.values()].map((b) => {
      const tb = b.h + b.doubles + 2 * b.triples + 3 * b.hr;
      const od = b.ab + b.bb + b.hbp + b.sf;
      const slg = b.ab ? tb / b.ab : 0, obp = od ? (b.h + b.bb + b.hbp) / od : 0;
      const woba = wobaDen(b) ? wobaNum(b) / wobaDen(b) : 0;
      const wraa = ((woba - lgWoba) / wobaScale) * b.pa;
      const rep = b.pa * (20 / 600);
      return { ...b, ...metaOf(b.playerId), situ: b.situ ?? situZero,
        avg: f3n(b.ab ? b.h / b.ab : 0), obp: f3n(obp), slg: f3n(slg), ops: f3n(obp + slg),
        iso: f3n(slg - (b.ab ? b.h / b.ab : 0)),
        babip: f3n(b.ab - b.k - b.hr + b.sf > 0 ? (b.h - b.hr) / (b.ab - b.k - b.hr + b.sf) : 0),
        woba: f3n(woba), wraa: f2n(wraa), war: f2n((wraa + rep) / rpw) };
    }).sort((x, y) => y.ops - x.ops);
    const pitching = [...pit.values()].map((p) => {
      const ip = p.outs / 3;
      const fip = ip ? (13 * p.hr + 3 * p.bb - 2 * p.k) / ip + cFip : 0;
      const war = ip ? ((lgEra - fip) / rpw + 0.08) * (ip / regInn) : 0;
      return { ...p, ...metaOf(p.playerId), ip: f2n(ip),
        era: f2n(ip ? (p.er * regInn) / ip : 0), whip: f2n(ip ? (p.bb + p.h) / ip : 0),
        k9: f2n(ip ? (p.k * regInn) / ip : 0), bb9: f2n(ip ? (p.bb * regInn) / ip : 0),
        kbb: f2n(p.bb ? p.k / p.bb : p.k), pIp: f2n(ip ? p.pitches / ip : 0),
        avgAgainst: f3n(p.abAg ? p.h / p.abAg : 0), fip: f2n(fip), war: f2n(war) };
    }).sort((x, y) => x.era - y.era);
    const fielding = [...fld.values()].map((f) => ({ ...f, ...metaOf(f.playerId), tc: f.po + f.a + f.e, fpct: f3n(f.po + f.a + f.e > 0 ? (f.po + f.a) / (f.po + f.a + f.e) : 1) })).sort((x, y) => y.tc - x.tc);

    return { batting, pitching, fielding, teamTotals: [...tt.values()], games, results, boxes, playerLog, meta, teamGameLines, matchups } as unknown as Stats;
  };

  // Posiciones de carrera: W/L/E acumulados de todas las temporadas (desde los resultados fusionados)
  const careerStandings = (st: Stats): Stand => {
    const tbl = new Map<string, { teamId: string; name: string; w: number; l: number; t: number; rf: number; ra: number }>();
    for (const t of league.teams) tbl.set(t.id, { teamId: t.id, name: t.name, w: 0, l: 0, t: 0, rf: 0, ra: 0 });
    for (const r of st.results) {
      const a = tbl.get(r.awayId), h = tbl.get(r.homeId);
      if (a) { a.rf += r.aR; a.ra += r.hR; }
      if (h) { h.rf += r.hR; h.ra += r.aR; }
      if (r.tied) { if (a) a.t++; if (h) h.t++; }
      else if (r.aR > r.hR) { if (a) a.w++; if (h) h.l++; }
      else { if (h) h.w++; if (a) a.l++; }
    }
    const rows = [...tbl.values()]
      .map((t) => ({ ...t, pct: t.w + t.l ? t.w / (t.w + t.l) : 0, diff: t.rf - t.ra, gb: 0, streak: null, last10: { w: 0, l: 0, t: 0 }, form: [] as ('W' | 'L' | 'T')[], vs: {} }))
      .sort((x, y) => y.pct - x.pct || y.w - x.w || y.diff - x.diff);
    const lead = rows[0];
    for (const t of rows) t.gb = lead ? ((lead.w - t.w) + (t.l - lead.l)) / 2 : 0;
    return rows as Stand;
  };

  const yearOfSeries = (sr: SeriesRow) => {
    if (sr.seasonId) { const s = league.seasons.find((x) => x.id === sr.seasonId); if (s) return s.year; }
    const d = sr.games[0]?.date;
    return d ? new Date(d).getFullYear() : 0;
  };

  // Datos de todas las temporadas (rellenado en el loop; lo usa la página de carrera)
  const yearData: { year: number; stats: Stats; post: Stats }[] = [];

  // Genera TODAS las páginas de una temporada (pfx = prefijo de ids, p.ej. "pg@2024").
  const buildYear = (stats: Stats, standings: Stand, pfx: string, series: SeriesRow[], post: Stats, career = false): string => {
  const reg = stats.results[0]?.innings ?? 9;

  const teamLink = (tid: string, name: string) => `<a href="#/equipo/${tid}">${esc(name)}</a>`;
  const playerLink = (pid: string, name: string) => `<a href="#/jugador/${pid}">${esc(name)}</a>`;
  const gameLink = (gid: string, label: string) => `<a href="#/juego/${gid}">${esc(label)}</a>`;
  const batName = (b: { playerId: string; name: string; shortName: string }) =>
    `${playerLink(b.playerId, b.name)} <span class="m">(${esc(b.shortName)})</span>`;

  // ---- extras de standings: casa/fuera, juegos de 1 carrera, L10, racha ----
  const extras = new Map<string, { hw: number; hl: number; aw: number; al: number; oW: number; oL: number; seq: ('W' | 'L' | 'T')[] }>();
  const xOf = (tid: string) => {
    if (!extras.has(tid)) extras.set(tid, { hw: 0, hl: 0, aw: 0, al: 0, oW: 0, oL: 0, seq: [] });
    return extras.get(tid)!;
  };
  for (const r of stats.results) {
    const xa = xOf(r.awayId), xh = xOf(r.homeId);
    const diff = r.aR - r.hR;
    const aRes: 'W' | 'L' | 'T' = r.tied ? 'T' : diff > 0 ? 'W' : 'L';
    const hRes: 'W' | 'L' | 'T' = r.tied ? 'T' : diff > 0 ? 'L' : 'W';
    xa.seq.push(aRes); xh.seq.push(hRes);
    if (aRes === 'W') xa.aw++; else if (aRes === 'L') xa.al++;
    if (hRes === 'W') xh.hw++; else if (hRes === 'L') xh.hl++;
    if (!r.tied && Math.abs(diff) === 1) {
      if (aRes === 'W') xa.oW++; else xa.oL++;
      if (hRes === 'W') xh.oW++; else xh.oL++;
    }
  }
  const strkOf = (seq: ('W' | 'L' | 'T')[]) => {
    if (!seq.length) return '—';
    const last = seq[seq.length - 1];
    let n = 0;
    for (let i = seq.length - 1; i >= 0 && seq[i] === last; i--) n++;
    return `${last === 'W' ? 'G' : last === 'L' ? 'P' : 'E'}${n}`;
  };
  const l10Of = (seq: ('W' | 'L' | 'T')[]) => {
    const last = seq.slice(-10);
    return `${last.filter((x) => x === 'W').length}-${last.filter((x) => x === 'L').length}`;
  };
  const ttOf = (tid: string) => stats.teamTotals.find((t) => t.teamId === tid);
  const teamBa = (tid: string) => { if (blockedT.has(tid)) return BLKCELL; const t = ttOf(tid); return t && t.ab ? f3(t.h / t.ab) : '.000'; };
  const teamEra = (tid: string) => { if (blockedT.has(tid)) return BLKCELL; const t = ttOf(tid); return t && t.pOuts ? f2((t.pER * reg * 3) / t.pOuts) : '0.00'; };

  // ============================ PÁGINA PRINCIPAL ============================
  const standRows = standings.map((t) => {
    const blkd = blockedT.has(t.teamId);
    const x = blkd ? null : extras.get(t.teamId);
    const xe = (v: string) => (x ? v : blkd ? BLKCELL : '—');
    return `<tr><td class="l">${teamLink(t.teamId, t.name)}</td><td>${t.w ?? BLKCELL}</td><td>${t.l ?? BLKCELL}</td><td>${t.t ?? BLKCELL}</td>
      <td><b>${f3(t.pct)}</b></td><td>${t.gb == null ? BLKCELL : t.gb || '—'}</td><td>${xe(l10Of(x?.seq ?? []))}</td><td>${xe(strkOf(x?.seq ?? []))}</td>
      <td>${xe(`${x?.hw ?? 0}-${x?.hl ?? 0}`)}</td><td>${xe(`${x?.aw ?? 0}-${x?.al ?? 0}`)}</td><td>${xe(`${x?.oW ?? 0}-${x?.oL ?? 0}`)}</td>
      <td>${teamBa(t.teamId)}</td><td>${teamEra(t.teamId)}</td></tr>`;
  }).join('');

  const resultRows = [...stats.results].reverse().map((r) => {
    const tag = r.forfeit ? ' (forfeit)' : r.tied ? ' (empate)' : '';
    return `<tr><td>${fecha(r.date)}</td><td class="l">${teamLink(r.awayId, r.away)} <b>${r.aR}</b></td>
      <td>@</td><td class="l">${teamLink(r.homeId, r.home)} <b>${r.hR}</b></td>
      <td class="m">${esc(r.stadium ?? '')}${tag}</td><td>${gameLink(r.id, 'boxscore')}</td></tr>`;
  }).join('');

  const teamBatRows = stats.teamTotals.map((t) => `<tr><td class="l">${teamLink(t.teamId, t.name)}</td>
    <td>${t.g}</td><td>${t.ab}</td><td>${t.h}</td><td>${t.r}</td><td>${t.rbi}</td><td>${t.doubles}</td><td>${t.triples}</td>
    <td>${t.hr}</td><td>${t.bb}</td><td>${t.k}</td><td>${t.sb}</td><td>${t.lob}</td>
    <td><b>${f3(t.ab ? t.h / t.ab : 0)}</b></td></tr>`).join('');
  const teamPitRows = stats.teamTotals.map((t) => `<tr><td class="l">${teamLink(t.teamId, t.name)}</td>
    <td>${ipOf(t.pOuts)}</td><td>${t.pH}</td><td>${t.pR}</td><td>${t.pER}</td><td>${t.pBB}</td><td>${t.pK}</td>
    <td><b>${t.pOuts ? f2((t.pER * reg * 3) / t.pOuts) : '0.00'}</b></td>
    <td>${t.pOuts ? f2(((t.pBB + t.pH) * 3) / t.pOuts) : '0.00'}</td></tr>`).join('');
  const teamFldRows = stats.teamTotals.map((t) => `<tr><td class="l">${teamLink(t.teamId, t.name)}</td><td>${t.e}</td></tr>`).join('');

  const leaderCard = <T,>(title: string, arr: T[], by: (x: T) => number, fmt: (x: T) => string,
    link: (x: T) => string, opts: { asc?: boolean; min?: (x: T) => boolean } = {}) => {
    const top = arr.filter(opts.min ?? ((x) => by(x) > 0)).sort((a, b) => (opts.asc ? by(a) - by(b) : by(b) - by(a))).slice(0, 3);
    if (!top.length) return '';
    const ph = (x: T) => {
      const pid = (x as { playerId?: string }).playerId;
      const m = x as { photo?: string | null; name?: string };
      if (pid && m.photo) return `<span class="lph pph" data-ph="${pid}"></span>`;
      const ini = (m.name ?? '?').replace(/^#\d+\s*/, '').trim().charAt(0).toUpperCase() || '?';
      return `<span class="lph linit">${esc(ini)}</span>`;
    };
    return `<div class="leader"><h4>${title}</h4><ol>${top.map((x) => `<li>${ph(x)}${link(x)} — <b>${fmt(x)}</b></li>`).join('')}</ol></div>`;
  };

  // ---- Clasificación configurable por liga (MLB 9.22) — aplica a líderes de portada y página ----
  // PA ≥ juegos del equipo × qualPa / IP ≥ juegos del equipo × qualIp. Excepción oficial:
  // quien no llegue al mínimo pero siga liderando rellenando con turnos hitless, también clasifica.
  const qPa = league.qualPa ?? 3.1, qIp = league.qualIp ?? 1.0;
  const paNeed = (b: { teamId: string }) => Math.round((ttOf(b.teamId)?.g ?? 0) * qPa);
  const outsNeed = (p: { teamId: string }) => Math.round((ttOf(p.teamId)?.g ?? 0) * qIp * 3);
  const qualRate = (num: (b: (typeof stats.batting)[number]) => number, den: (b: (typeof stats.batting)[number]) => number) => {
    const need = (b: (typeof stats.batting)[number]) => paNeed(b);
    const qual = stats.batting.filter((b) => qPa <= 0 || b.pa >= need(b));
    const best = qual.length ? Math.max(...qual.map((b) => den(b) ? num(b) / den(b) : 0)) : -1;
    const extra = qPa <= 0 ? [] : stats.batting.filter((b) => !qual.includes(b) && best > 0
      && num(b) > 0 && num(b) / (den(b) + (need(b) - b.pa)) >= best);
    return [...qual, ...extra];
  };
  const batQualAvg = qualRate((b) => b.h, (b) => b.ab);
  const batQualObp = qualRate((b) => b.h + b.bb + b.hbp, (b) => b.ab + b.bb + b.hbp + b.sf);
  const batQualSlg = qualRate((b) => b.h + b.doubles + 2 * b.triples + 3 * b.hr, (b) => b.ab);
  const batQualPa = stats.batting.filter((b) => qPa <= 0 || b.pa >= paNeed(b)); // OPS/ISO/BABIP
  const pitQual = stats.pitching.filter((p) => qIp <= 0 || p.outs >= outsNeed(p));

  // equipo histórico del jugador en una temporada: lado del boxscore donde aparece
  const histTeamOf = (st: Stats, pid: string) => {
    const cnt = new Map<string, number>();
    const resByIdL = new Map(st.results.map((r) => [r.id, r]));
    for (const e of st.playerLog.get(pid) ?? []) {
      const box = st.boxes.get(e.gameId);
      const res = resByIdL.get(e.gameId);
      if (!box || !res) continue;
      const tid = (box.away as any)[pid] ? res.awayId : (box.home as any)[pid] ? res.homeId : null;
      if (tid) cnt.set(tid, (cnt.get(tid) ?? 0) + 1);
    }
    return [...cnt.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  };
  const teamShort = (tid: string | null) => tid ? esc(league.teams.find((t) => t.id === tid)?.shortName ?? '') : '';

  const mainPage = `<div class="page" id="${pfx}/">
  <h2>${career ? 'Posiciones históricas — todas las temporadas' : 'Posiciones'}</h2>
  <div class="tw"><table><thead><tr><th class="l">Equipo</th><th>G</th><th>P</th><th>E</th><th>PCT</th><th>JB</th><th>L10</th><th>Racha</th><th>Casa</th><th>Fuera</th><th>1-Run</th><th>BA</th><th>ERA</th></tr></thead>
  <tbody>${standRows || '<tr><td colspan="13" class="m">Sin juegos finalizados</td></tr>'}</tbody></table></div>
  <h2>Resultados</h2>
  <div class="tw"><table><thead><tr><th>Fecha</th><th class="l">Visitante</th><th></th><th class="l">Local</th><th>Estadio</th><th></th></tr></thead>
  <tbody>${resultRows || '<tr><td colspan="6" class="m">Sin juegos</td></tr>'}</tbody></table></div>
  <h2>Líderes del torneo</h2>
  ${leaderCard('AVG', batQualAvg, (b) => b.avg, (b) => f3(b.avg), batName)}
  ${leaderCard('Jonrones', stats.batting, (b) => b.hr, (b) => String(b.hr), batName)}
  ${leaderCard('Carreras impulsadas', stats.batting, (b) => b.rbi, (b) => String(b.rbi), batName)}
  ${leaderCard('Hits', stats.batting, (b) => b.h, (b) => String(b.h), batName)}
  ${leaderCard('Bases robadas', stats.batting, (b) => b.sb, (b) => String(b.sb), batName)}
  ${leaderCard('Carreras anotadas', stats.batting, (b) => b.r, (b) => String(b.r), batName)}
  ${leaderCard('Dobles', stats.batting, (b) => b.doubles, (b) => String(b.doubles), batName)}
  ${leaderCard('OPS', batQualPa, (b) => b.ops, (b) => f3(b.ops), batName)}
  ${leaderCard('WAR*', stats.batting, (b) => b.war, (b) => f2(b.war), batName)}
  ${leaderCard('BABIP', stats.batting, (b) => b.babip, (b) => f3(b.babip), batName)}
  ${leaderCard('ERA', pitQual, (p) => p.era, (p) => f2(p.era), (p) => batName(p), { asc: true, min: (p) => p.outs > 0 })}
  ${leaderCard('WHIP', pitQual, (p) => p.whip, (p) => f2(p.whip), (p) => batName(p), { asc: true, min: (p) => p.outs > 0 })}
  ${leaderCard('Ganados', stats.pitching, (p) => p.w, (p) => String(p.w), (p) => batName(p))}
  ${leaderCard('Ponches', stats.pitching, (p) => p.k, (p) => String(p.k), (p) => batName(p))}
  ${leaderCard('Salvados', stats.pitching, (p) => p.sv, (p) => String(p.sv), (p) => batName(p))}
  <p><a href="#/lideres">→ Reporte completo de líderes</a></p>
  <h2>Bateo por equipo</h2>
  <div class="tw"><table><thead><tr><th class="l">Equipo</th><th>G</th><th>AB</th><th>H</th><th>C</th><th>CI</th><th>2B</th><th>3B</th><th>HR</th><th>BB</th><th>K</th><th>BR</th><th>LOB</th><th>BA</th></tr></thead>
  <tbody>${teamBatRows}</tbody></table></div>
  <h2>Pitcheo por equipo</h2>
  <div class="tw"><table><thead><tr><th class="l">Equipo</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>ERA</th><th>WHIP</th></tr></thead>
  <tbody>${teamPitRows}</tbody></table></div>
  <h2>Fildeo por equipo</h2>
  <div class="tw"><table><thead><tr><th class="l">Equipo</th><th>Errores</th></tr></thead><tbody>${teamFldRows}</tbody></table></div>
</div>`;

  // ============================ PÁGINAS DE EQUIPO ============================
  const teamPages = league.teams.map((t) => {
    if (blockedT.has(t.id)) {
      return `<div class="page" id="${pfx}/equipo/${t.id}">
  <h2>🚫 EQUIPO BLOQUEADO</h2>
  <p class="m">Este equipo fue excluido de la publicación. Sus datos siguen en el sistema.</p>
</div>`;
    }
    const st = standings.find((s) => s.teamId === t.id);
    const bat = stats.batting.filter((b) => b.teamId === t.id);
    const pit = stats.pitching.filter((p) => p.teamId === t.id);
    const fld = stats.fielding.filter((f) => f.teamId === t.id);
    const res = [...stats.results].reverse().filter((r) => r.awayId === t.id || r.homeId === t.id);
    return `<div class="page" id="${pfx}/equipo/${t.id}">
  <h2>${esc(t.name)} ${st ? `<span class="m">— ${st.w}-${st.l}${st.t ? `-${st.t}` : ''} · PCT ${f3(st.pct)}</span>` : ''}</h2>
  <h3>Bateo</h3>
  <div class="tw"><table><thead><tr><th class="l">Jugador</th><th>G</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
  <tbody>${bat.map((b) => `<tr><td class="l">${playerLink(b.playerId, b.name)}</td><td>${b.g}</td><td>${b.pa}</td><td>${b.ab}</td><td>${b.r}</td><td>${b.h}</td><td>${b.doubles}</td><td>${b.triples}</td><td>${b.hr}</td><td>${b.rbi}</td><td>${b.bb}</td><td>${b.k}</td><td>${b.sb}</td><td><b>${f3(b.avg)}</b></td><td>${f3(b.obp)}</td><td>${f3(b.slg)}</td><td>${f3(b.ops)}</td></tr>`).join('') || '<tr><td colspan="17" class="m">Sin datos</td></tr>'}</tbody></table></div>
  <h3>Pitcheo</h3>
  <div class="tw"><table><thead><tr><th class="l">Lanzador</th><th>G</th><th>W-L</th><th>SV</th><th>HLD</th><th>BS</th><th>CG</th><th>SHO</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>ERA</th><th>WHIP</th></tr></thead>
  <tbody>${pit.map((p) => `<tr><td class="l">${playerLink(p.playerId, p.name)}</td><td>${p.gp}</td><td>${p.w}-${p.l}</td><td>${p.sv}</td><td>${p.hld}</td><td>${p.bs}</td><td>${p.cg}</td><td>${p.sho}</td><td>${ipOf(p.outs)}</td><td>${p.h}</td><td>${p.r}</td><td>${p.er}</td><td>${p.bb}</td><td>${p.k}</td><td>${p.hr}</td><td><b>${f2(p.era)}</b></td><td>${f2(p.whip)}</td></tr>`).join('') || '<tr><td colspan="17" class="m">Sin datos</td></tr>'}</tbody></table></div>
  <h3>Fildeo</h3>
  <div class="tw"><table><thead><tr><th class="l">Jugador</th><th>PO</th><th>A</th><th>E</th><th>TC</th><th>FPCT</th></tr></thead>
  <tbody>${fld.map((f) => `<tr><td class="l">${playerLink(f.playerId, f.name)}</td><td>${f.po}</td><td>${f.a}</td><td>${f.e}</td><td>${f.tc}</td><td><b>${f3(f.fpct)}</b></td></tr>`).join('') || '<tr><td colspan="6" class="m">Sin datos</td></tr>'}</tbody></table></div>
  <h3>Resultados</h3>
  <div class="tw"><table><thead><tr><th>Fecha</th><th class="l">Rival</th><th>Marcador</th><th></th></tr></thead>
  <tbody>${res.map((r) => {
      const mine = r.awayId === t.id ? 'away' : 'home';
      const me = mine === 'away' ? r.aR : r.hR; const opp = mine === 'away' ? r.hR : r.aR;
      const wl = r.tied ? 'E' : me > opp ? 'G' : 'P';
      return `<tr><td>${fecha(r.date)}</td><td class="l">${mine === 'away' ? '@ ' + teamLink(r.homeId, r.home) : teamLink(r.awayId, r.away)}</td>
        <td><b>${wl} ${me}-${opp}</b></td><td>${gameLink(r.id, 'boxscore')}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="m">Sin juegos</td></tr>'}</tbody></table></div>
</div>`;
  }).join('\n');

  // ============================ PÁGINAS DE JUGADOR ============================
  const playerIds = new Set<string>([
    ...stats.playerLog.keys(),
    ...stats.batting.map((b) => b.playerId),
    ...stats.pitching.map((p) => p.playerId),
    ...post.playerLog.keys(),
    ...post.batting.map((b) => b.playerId),
    ...post.pitching.map((p) => p.playerId),
  ]);
  const batSeasonTable = (b: NonNullable<(typeof stats.batting)[number]>) => `
  <div class="tw"><table><thead><tr><th>G</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>GP</th><th>SAC</th><th>SF</th><th>BR</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th><th>wOBA</th><th>WAR*</th></tr></thead>
  <tbody><tr><td>${b.g}</td><td>${b.pa}</td><td>${b.ab}</td><td>${b.r}</td><td>${b.h}</td><td>${b.doubles}</td><td>${b.triples}</td><td>${b.hr}</td><td>${b.rbi}</td><td>${b.bb}</td><td>${b.k}</td><td>${b.hbp}</td><td>${b.sac}</td><td>${b.sf}</td><td>${b.sb}</td><td><b>${f3(b.avg)}</b></td><td>${f3(b.obp)}</td><td>${f3(b.slg)}</td><td><b>${f3(b.ops)}</b></td><td>${f3(b.woba)}</td><td><b>${f2(b.war)}</b></td></tr></tbody></table></div>`;
  const pitSeasonTable = (p: NonNullable<(typeof stats.pitching)[number]>) => `
  <div class="tw"><table><thead><tr><th>G</th><th>W-L</th><th>SV</th><th>HLD</th><th>BS</th><th>CG</th><th>SHO</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th><th>ERA</th><th>WHIP</th><th>FIP</th><th>WAR*</th></tr></thead>
  <tbody><tr><td>${p.gp}</td><td>${p.w}-${p.l}</td><td>${p.sv}</td><td>${p.hld}</td><td>${p.bs}</td><td>${p.cg}</td><td>${p.sho}</td><td>${ipOf(p.outs)}</td><td>${p.h}</td><td>${p.r}</td><td>${p.er}</td><td>${p.bb}</td><td>${p.k}</td><td>${p.hr}</td><td>${p.pitches}</td><td><b>${f2(p.era)}</b></td><td>${f2(p.whip)}</td><td>${f2(p.fip)}</td><td><b>${f2(p.war)}</b></td></tr></tbody></table></div>`;
  const playerPages = [...playerIds].map((pid) => {
    if (blockedP.has(pid)) {
      return `<div class="page" id="${pfx}/jugador/${pid}">
  <div class="player-head"><div class="pphoto pph"></div><div><h2>🔒 BLOQUEADO</h2>
  <p class="m">Este jugador fue excluido de la publicación. Sus datos siguen en el sistema.</p></div></div>
</div>`;
    }
    const m = stats.meta.get(pid) ?? post.meta.get(pid);
    if (!m) return '';
    const b = stats.batting.find((x) => x.playerId === pid);
    const p = stats.pitching.find((x) => x.playerId === pid);
    const f = stats.fielding.find((x) => x.playerId === pid);
    const pb = post.batting.find((x) => x.playerId === pid);
    const pp = post.pitching.find((x) => x.playerId === pid);
    const pf = post.fielding.find((x) => x.playerId === pid);
    const log = (stats.playerLog.get(pid) ?? []).slice().sort((x, y) => +new Date(x.date) - +new Date(y.date));
    const postLog = (post.playerLog.get(pid) ?? []).slice().sort((x, y) => +new Date(x.date) - +new Date(y.date));

    const batLogRows = (entries: typeof log) => {
      let cumAb = 0, cumH = 0;
      return entries.filter((e) => e.bat && e.bat.pa > 0).map((e) => {
        const l = e.bat!;
        cumAb += l.ab; cumH += l.h;
        return `<tr><td>${fecha(e.date)}</td><td class="l">${gameLink(e.gameId, 'vs ' + e.opp)}</td>
          <td>${l.ab}</td><td>${l.r}</td><td>${l.h}</td><td>${l.doubles}</td><td>${l.triples}</td><td>${l.hr}</td>
          <td>${l.rbi}</td><td>${l.bb}</td><td>${l.k}</td><td>${l.sb}</td><td class="m">${f3(cumAb ? cumH / cumAb : 0)}</td></tr>`;
      }).join('');
    };
    const pitLogRowsOf = (entries: typeof log) => entries.filter((e) => e.pit && e.pit.outs > 0).map((e) => {
      const l = e.pit!;
      return `<tr><td>${fecha(e.date)}</td><td class="l">${gameLink(e.gameId, 'vs ' + e.opp)}</td>
        <td>${ipOf(l.outs)}</td><td>${l.h}</td><td>${l.r}</td><td>${l.er}</td><td>${l.bb}</td><td>${l.k}</td><td>${l.hr}</td><td>${l.pitches}</td></tr>`;
    }).join('');
    const logRows = batLogRows(log);
    const pitLogRows = pitLogRowsOf(log);
    const postBatRows = batLogRows(postLog);
    const postPitRows = pitLogRowsOf(postLog);

    // ---- filas por temporada para la ficha de CARRERA ----
    const batSplitRow = (label: string, sn: string, x: (typeof stats.batting)[number], tot = false) =>
      `<tr${tot ? ' style="font-weight:700;background:#eef4fb"' : ''}><td>${label}</td><td>${sn}</td><td>${x.g}</td><td>${x.pa}</td><td>${x.ab}</td><td>${x.r}</td><td>${x.h}</td><td>${x.doubles}</td><td>${x.triples}</td><td>${x.hr}</td><td>${x.rbi}</td><td>${x.bb}</td><td>${x.k}</td><td>${x.sb}</td><td>${f3(x.avg)}</td><td>${f3(x.obp)}</td><td>${f3(x.slg)}</td><td><b>${f3(x.ops)}</b></td></tr>`;
    const pitSplitRow = (label: string, sn: string, x: (typeof stats.pitching)[number], tot = false) =>
      `<tr${tot ? ' style="font-weight:700;background:#eef4fb"' : ''}><td>${label}</td><td>${sn}</td><td>${x.gp}</td><td>${x.w}-${x.l}</td><td>${x.sv}</td><td>${ipOf(x.outs)}</td><td>${x.h}</td><td>${x.r}</td><td>${x.er}</td><td>${x.bb}</td><td>${x.k}</td><td>${x.hr}</td><td><b>${f2(x.era)}</b></td><td>${f2(x.whip)}</td></tr>`;
    const fldSplitRow = (label: string, sn: string, x: (typeof stats.fielding)[number], tot = false) =>
      `<tr${tot ? ' style="font-weight:700;background:#eef4fb"' : ''}><td>${label}</td><td>${sn}</td><td>${x.po}</td><td>${x.a}</td><td>${x.e}</td><td>${x.tc}</td><td>${f3(x.fpct)}</td></tr>`;
    let carBatRows = '', carPitRows = '', carFldRows = '';
    if (career) {
      for (const yd of [...yearData].reverse()) {
        const sn = teamShort(histTeamOf(yd.stats, pid) ?? histTeamOf(yd.post, pid) ?? b?.teamId ?? null);
        const bl = yd.stats.batting.find((x) => x.playerId === pid);
        const pl = yd.post.batting.find((x) => x.playerId === pid);
        const pi = yd.stats.pitching.find((x) => x.playerId === pid);
        const ppi = yd.post.pitching.find((x) => x.playerId === pid);
        const fl = yd.stats.fielding.find((x) => x.playerId === pid);
        const pfl = yd.post.fielding.find((x) => x.playerId === pid);
        if (bl) carBatRows += batSplitRow(String(yd.year), sn, bl);
        if (pl) carBatRows += batSplitRow(`${yd.year} <span class="m">PO</span>`, sn, pl);
        if (pi) carPitRows += pitSplitRow(String(yd.year), sn, pi);
        if (ppi) carPitRows += pitSplitRow(`${yd.year} <span class="m">PO</span>`, sn, ppi);
        if (fl) carFldRows += fldSplitRow(String(yd.year), sn, fl);
        if (pfl) carFldRows += fldSplitRow(`${yd.year} <span class="m">PO</span>`, sn, pfl);
      }
      if (b) carBatRows += batSplitRow('Carrera', '', b, true);
      if (pb) carBatRows += batSplitRow('Carrera 🏆', '', pb, true);
      if (p) carPitRows += pitSplitRow('Carrera', '', p, true);
      if (pp) carPitRows += pitSplitRow('Carrera 🏆', '', pp, true);
      if (f) carFldRows += fldSplitRow('Carrera', '', f, true);
      if (pf) carFldRows += fldSplitRow('Carrera 🏆', '', pf, true);
    }

    if (m.photo) photoPool.set(pid, m.photo);
    return `<div class="page" id="${pfx}/jugador/${pid}">
  <div class="player-head">
    ${m.photo ? `<div class="pphoto pph" data-ph="${pid}"></div>` : '<div class="pphoto pph"></div>'}
    <div><h2>${esc(m.name)}</h2>
    <div class="m">${m.teamId ? teamLink(m.teamId, m.teamName) : esc(m.teamName)} · Batea: ${esc(m.bats ?? '—')} · Tira: ${esc(m.throws ?? '—')} · Pos: ${esc(m.positions ?? '—')}</div>
    <button class="cdl" onclick="makeCard('${pid}')" title="Card estilo MLB en PNG — formato vertical para compartir">🃏 Descargar card PNG</button></div>
  </div>
  ${career && carBatRows ? `<h3>Bateo — carrera por temporada</h3>
  <div class="tw"><table><thead><tr><th>Año</th><th>Eq</th><th>G</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
  <tbody>${carBatRows}</tbody></table></div>` : ''}
  ${career && carPitRows ? `<h3>Pitcheo — carrera por temporada</h3>
  <div class="tw"><table><thead><tr><th>Año</th><th>Eq</th><th>G</th><th>W-L</th><th>SV</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>ERA</th><th>WHIP</th></tr></thead>
  <tbody>${carPitRows}</tbody></table></div>` : ''}
  ${career && carFldRows ? `<h3>Fildeo — carrera por temporada</h3>
  <div class="tw"><table><thead><tr><th>Año</th><th>Eq</th><th>PO</th><th>A</th><th>E</th><th>TC</th><th>FPCT</th></tr></thead>
  <tbody>${carFldRows}</tbody></table></div>` : ''}
  ${!career && b ? `<h3>Bateo — temporada</h3>${batSeasonTable(b)}` : ''}
  ${b && (b.situ.risp.ab + b.situ.loaded.ab + b.situ.twoOut.ab + b.situ.leadoff.ab) > 0 ? `<p class="m">Situacional${career ? ' carrera' : ''} — RISP: ${b.situ.risp.h}-${b.situ.risp.ab} · Llenas: ${b.situ.loaded.h}-${b.situ.loaded.ab} · 2 outs: ${b.situ.twoOut.h}-${b.situ.twoOut.ab} · Leadoff: ${b.situ.leadoff.h}-${b.situ.leadoff.ab}</p>` : ''}
  ${!career && p ? `<h3>Pitcheo — temporada</h3>${pitSeasonTable(p)}` : ''}
  ${!career && f ? `<p class="m">Fildeo: ${f.po} PO · ${f.a} A · ${f.e} E · TC ${f.tc} · FPCT ${f3(f.fpct)}</p>` : ''}
  ${!career && (pb || pp || pf) ? `<h2 class="sec">🏆 Postemporada</h2>` : ''}
  ${!career && pb ? `<h3>Bateo — playoff</h3>${batSeasonTable(pb)}` : ''}
  ${!career && pp ? `<h3>Pitcheo — playoff</h3>${pitSeasonTable(pp)}` : ''}
  ${!career && pf ? `<p class="m">Fildeo playoff: ${pf.po} PO · ${pf.a} A · ${pf.e} E · TC ${pf.tc} · FPCT ${f3(pf.fpct)}</p>` : ''}
  ${postBatRows ? `<h3>Bateo juego a juego — playoff</h3>
  <div class="tw"><table><thead><tr><th>Fecha</th><th class="l">Opp</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th></tr></thead>
  <tbody>${postBatRows}</tbody></table></div>` : ''}
  ${postPitRows ? `<h3>Pitcheo juego a juego — playoff</h3>
  <div class="tw"><table><thead><tr><th>Fecha</th><th class="l">Opp</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th></tr></thead>
  <tbody>${postPitRows}</tbody></table></div>` : ''}
  ${(() => {
      const vs = stats.matchups.get(pid);
      if (!vs || !vs.size) return '';
      const rows = [...vs.entries()].map(([pitId, m]) => ({ pitId, m })).sort((a, b) => b.m.pa - a.m.pa);
      return `<h3>vs Lanzadores</h3>
  <div class="tw"><table><thead><tr><th class="l">Lanzador</th><th>PA</th><th>AB</th><th>H</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>AVG</th></tr></thead>
  <tbody>${rows.map(({ pitId, m }) => `<tr><td class="l">${playerLink(pitId, stats.meta.get(pitId)?.name ?? pitId)}</td><td>${m.pa}</td><td>${m.ab}</td><td>${m.h}</td><td>${m.hr}</td><td>${m.rbi}</td><td>${m.bb}</td><td>${m.k}</td><td><b>${f3(m.ab ? m.h / m.ab : 0)}</b></td></tr>`).join('')}</tbody></table></div>`;
    })()}
  ${(() => {
      const rows: { bid: string; m: { pa: number; ab: number; h: number; hr: number; rbi: number; bb: number; k: number } }[] = [];
      for (const [bid, mmap] of stats.matchups) { const m = mmap.get(pid); if (m) rows.push({ bid, m }); }
      if (!rows.length) return '';
      rows.sort((a, b) => b.m.pa - a.m.pa);
      return `<h3>vs Bateadores (lanzando)</h3>
  <div class="tw"><table><thead><tr><th class="l">Bateador</th><th>PA</th><th>AB</th><th>H</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>AVG</th></tr></thead>
  <tbody>${rows.map(({ bid, m }) => `<tr><td class="l">${playerLink(bid, stats.meta.get(bid)?.name ?? bid)}</td><td>${m.pa}</td><td>${m.ab}</td><td>${m.h}</td><td>${m.hr}</td><td>${m.rbi}</td><td>${m.bb}</td><td>${m.k}</td><td><b>${f3(m.ab ? m.h / m.ab : 0)}</b></td></tr>`).join('')}</tbody></table></div>`;
    })()}
  ${logRows ? `<h3>Bateo juego a juego</h3>
  <div class="tw"><table><thead><tr><th>Fecha</th><th class="l">Opp</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th></tr></thead>
  <tbody>${logRows}</tbody></table></div>` : ''}
  ${pitLogRows ? `<h3>Pitcheo juego a juego</h3>
  <div class="tw"><table><thead><tr><th>Fecha</th><th class="l">Opp</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th></tr></thead>
  <tbody>${pitLogRows}</tbody></table></div>` : ''}
  ${!b && !p && !pb && !pp ? '<p class="m">Sin actividad registrada en el torneo.</p>' : ''}
</div>`;
  }).join('\n');

  // ============================ PÁGINAS DE JUEGO (boxscore) ============================
  const postIds = new Set(post.results.map((r) => r.id));
  const allResults = [...stats.results, ...post.results];
  const metaName = (pid: string) => stats.meta.get(pid)?.name ?? post.meta.get(pid)?.name ?? pid;
  // en modo carrera los boxscores ya fueron emitidos por las temporadas (id único global)
  const gamePages = career ? '' : allResults.map((r) => {
    const box = stats.boxes.get(r.id) ?? post.boxes.get(r.id);
    if (!box) return '';
    const tag = (postIds.has(r.id) ? ' 🏆 playoff' : '') + (r.forfeit ? ' (forfeit)' : r.tied ? ' (empate)' : '');
    const inn = Math.max(box.linescore.away.length, box.linescore.home.length);
    const batRows = (side: 'away' | 'home') => Object.values(box[side])
      .sort((a, b2) => b2.ab - a.ab)
      .map((l) => `<tr><td class="l">${playerLink(l.playerId, metaName(l.playerId))}</td><td>${l.ab}</td><td>${l.r}</td><td>${l.h}</td><td>${l.rbi}</td><td>${l.doubles}</td><td>${l.triples}</td><td>${l.hr}</td><td>${l.bb}</td><td>${l.k}</td><td>${l.sb}</td><td>${f3(l.ab ? l.h / l.ab : 0)}</td></tr>`)
      .join('');
    // lado del lanzador: del evento/statLine (pitSide); respaldo = equipo actual
    const sideOfPit = (pid: string) =>
      r.pitSide[pid] ?? (stats.meta.get(pid)?.teamId === r.awayId ? 'away' : 'home');
    const decTags = (pid: string) => {
      const d = r.dec;
      return [
        d.w.includes(pid) ? 'G' : '', d.l.includes(pid) ? 'P' : '',
        d.sv.includes(pid) ? 'SV' : '', d.hld.includes(pid) ? 'H' : '', d.bs.includes(pid) ? 'BS' : '',
        d.cg.includes(pid) ? 'JC' : '', d.sho.includes(pid) ? 'SHO' : '',
      ].filter(Boolean).join(',');
    };
    const pitRows = (side: 'away' | 'home') => Object.values(box.pitchers)
      .filter((pl) => sideOfPit(pl.playerId) === side)
      .map((pl) => `<tr><td class="l">${playerLink(pl.playerId, metaName(pl.playerId))}</td><td>${ipOf(pl.outs)}</td><td>${pl.h}</td><td>${pl.r}</td><td>${pl.er}</td><td>${pl.bb}</td><td>${pl.k}</td><td>${pl.hr}</td><td>${pl.pitches}</td><td><b>${decTags(pl.playerId)}</b></td></tr>`)
      .join('');
    const pitTable = (side: 'away' | 'home', name: string) => `
    <div><h3>${esc(name)} — Pitcheo</h3><div class="tw"><table><thead><tr><th class="l">Lanzador</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>Pit</th><th>Dec</th></tr></thead><tbody>${pitRows(side) || '<tr><td colspan="10" class="m">—</td></tr>'}</tbody></table></div></div>`;
    // recap estilo MLB: decisiones con récord de temporada + notas de bateo por equipo
    const recapName = (pid: string) => esc(metaName(pid).replace(/^#\d+\s*/, ''));
    // récord de temporada EN LA FASE del juego: en playoff el récord es el de
    // postemporada (estilo MLB), en regular el de temporada regular
    const pitPool = postIds.has(r.id) ? post.pitching : stats.pitching;
    const seasonPit = (pid: string) =>
      pitPool.find((p) => p.playerId === pid) ?? stats.pitching.find((p) => p.playerId === pid) ?? post.pitching.find((p) => p.playerId === pid);
    const decParts = [
      ...r.dec.w.map((pid) => `G: ${recapName(pid)} (${seasonPit(pid)?.w ?? 0}-${seasonPit(pid)?.l ?? 0})`),
      ...r.dec.l.map((pid) => `P: ${recapName(pid)} (${seasonPit(pid)?.w ?? 0}-${seasonPit(pid)?.l ?? 0})`),
      ...r.dec.sv.map((pid) => `SV: ${recapName(pid)} (${seasonPit(pid)?.sv ?? 0})`),
      ...r.dec.hld.map((pid) => `H: ${recapName(pid)} (${seasonPit(pid)?.hld ?? 0})`),
      ...r.dec.bs.map((pid) => `BS: ${recapName(pid)}`),
      ...r.dec.cg.map((pid) => `JC: ${recapName(pid)}`),
      ...r.dec.sho.map((pid) => `SHO: ${recapName(pid)}`),
    ];
    const recapSide = (side: 'away' | 'home') => {
      const lines = Object.values(box[side]);
      const seg = (label: string, key: (l: (typeof lines)[number]) => number) => {
        const xs = lines.filter((l) => key(l) > 0)
          .sort((a, b) => key(b) - key(a))
          .map((l) => `${recapName(l.playerId)}${key(l) > 1 ? ` (${key(l)})` : ''}`);
        return xs.length ? `${label}: ${xs.join(', ')}` : '';
      };
      const parts = [
        seg('2B', (l) => l.doubles), seg('3B', (l) => l.triples), seg('HR', (l) => l.hr),
        seg('CI', (l) => l.rbi), seg('BR', (l) => l.sb), seg('SAC', (l) => l.sac + l.sf),
      ].filter(Boolean);
      parts.push(`Dejados en base: ${box.lob[side]}`);
      return `<p><b>${esc(side === 'away' ? r.awayShort : r.homeShort)}</b> — ${parts.join(' · ')}</p>`;
    };
    return `<div class="page" id="pg/juego/${r.id}">
  <h2>${teamLink(r.awayId, r.away)} ${r.aR} @ ${teamLink(r.homeId, r.home)} ${r.hR} <span class="m">— ${fecha(r.date)}${r.stadium ? ` · ${esc(r.stadium)}` : ''}${tag}</span></h2>
  <div class="tw"><table><thead><tr><th></th>${Array.from({ length: inn }, (_, i) => `<th>${i + 1}</th>`).join('')}<th>R</th><th>H</th><th>DB</th></tr></thead>
  <tbody>
  <tr><td class="l">${esc(r.awayShort)}</td>${Array.from({ length: inn }, (_, i) => `<td>${box.linescore.away[i] ?? '—'}</td>`).join('')}<td><b>${r.aR}</b></td><td>${Object.values(box.away).reduce((s, l) => s + l.h, 0)}</td><td>${box.lob.away}</td></tr>
  <tr><td class="l">${esc(r.homeShort)}</td>${Array.from({ length: inn }, (_, i) => `<td>${box.linescore.home[i] ?? '—'}</td>`).join('')}<td><b>${r.hR}</b></td><td>${Object.values(box.home).reduce((s, l) => s + l.h, 0)}</td><td>${box.lob.home}</td></tr>
  </tbody></table></div>
  <div class="two">
    <div><h3>${esc(r.away)} — Bateo</h3><div class="tw"><table><thead><tr><th class="l">Bateador</th><th>AB</th><th>R</th><th>H</th><th>CI</th><th>2B</th><th>3B</th><th>HR</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th></tr></thead><tbody>${batRows('away')}</tbody></table></div></div>
    <div><h3>${esc(r.home)} — Bateo</h3><div class="tw"><table><thead><tr><th class="l">Bateador</th><th>AB</th><th>R</th><th>H</th><th>CI</th><th>2B</th><th>3B</th><th>HR</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th></tr></thead><tbody>${batRows('home')}</tbody></table></div></div>
  </div>
  <div class="two">
    ${pitTable('away', r.away)}
    ${pitTable('home', r.home)}
  </div>
  <h3>Recap</h3>
  ${decParts.length ? `<p><b>Decisiones:</b> ${decParts.join(' · ')}</p>` : ''}
  ${recapSide('away')}
  ${recapSide('home')}
</div>`;
  }).join('\n');

  // ============================ PÁGINA DE LÍDERES (estilo MLB.com) ============================
  // (regla de clasificación definida arriba, junto a leaderCard, para reusarla en portada)
  const singlesOf = (b: (typeof stats.batting)[number]) => b.h - b.doubles - b.triples - b.hr;
  const leadersTable = (title: string, rows: string, cols: string) =>
    `<h3>${title}</h3><div class="tw"><table><thead><tr>${cols}</tr></thead><tbody>${rows || '<tr><td colspan="8" class="m">Sin datos</td></tr>'}</tbody></table></div>`;
  const top15 = <T,>(arr: T[], by: (x: T) => number, min: (x: T) => boolean, asc = false) =>
    arr.filter(min).sort((a, b) => (asc ? by(a) - by(b) : by(b) - by(a))).slice(0, 15);
  const tbOf = (b: (typeof stats.batting)[number]) => b.h + b.doubles + 2 * b.triples + 3 * b.hr;
  const xbhOf = (b: (typeof stats.batting)[number]) => b.doubles + b.triples + b.hr;

  // récords individuales en un juego (del game log) — definidos antes porque la
  // sección de pitcheo de líderes también muestra sus highs/lows
  const allLog = [...stats.playerLog.entries()].flatMap(([pid, arr]) => arr.map((e) => ({ pid, ...e })));
  const pNameOf = (pid: string) => stats.meta.get(pid)?.name ?? pid;
  const indRows = (pick: (e: (typeof allLog)[number]) => number, line: (e: (typeof allLog)[number]) => string, min = 1) => {
    const top = allLog.filter((e) => pick(e) >= min).sort((a, b) => pick(b) - pick(a)).slice(0, 3);
    return top.map((e) => `<tr><td>${playerLink(e.pid, pNameOf(e.pid))}</td><td><b>${line(e)}</b></td>
      <td class="m">vs ${esc(e.opp)}</td><td>${gameLink(e.gameId, fecha(e.date))}</td></tr>`).join('');
  };
  const indTable = (title: string, pick: (e: (typeof allLog)[number]) => number, line: (e: (typeof allLog)[number]) => string, min?: number) =>
    leadersTable(title, indRows(pick, line, min), '<th class="l">Jugador</th><th>Marca</th><th>Rival</th><th>Fecha</th>');
  // juegos jugados por jugador (para Range Factor sabermétrico)
  const gOf = (pid: string) => stats.batting.find((b) => b.playerId === pid)?.g
    ?? stats.playerLog.get(pid)?.length ?? 0;

  const leadersPage = `<div class="page" id="${pfx}/lideres">
  <h2>Líderes del torneo</h2>
  <p class="m">Clasifican a estadísticas de promedio: <b>≥ PA por juego × ${qPa}</b> (bateo) y <b>≥ IP por juego × ${qIp}</b> (pitcheo) — configurable en la liga (regla tipo MLB 9.22, con excepción de relleno para AVG/OBP/SLG).</p>
  <div class="lbar"><label><b>Ver líderes de:</b> <select onchange="lseg(this)">
    <option value="bat">⚾ Bateo</option>
    <option value="sab">📊 Sabermetría — bateo</option>
    <option value="pit">🥎 Pitcheo</option>
    <option value="fld">🧤 Defensa</option>
    <option value="_records">🏅 Marcas del torneo (Highs &amp; Lows)</option>
  </select></label></div>
  <div class="lsec" data-ls="bat">
  <h2 class="sec">Bateo</h2>
  ${leadersTable('Promedio (AVG)', top15(batQualAvg, (b) => b.avg, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f3(b.avg)}</b></td><td>${b.ab}</td><td>${b.h}</td></tr>`).join(''), '<th class="l">Jugador</th><th>AVG</th><th>AB</th><th>H</th>')}
  ${leadersTable('Hits', top15(stats.batting, (b) => b.h, (b) => b.h > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.h}</b></td><td>${b.ab}</td></tr>`).join(''), '<th class="l">Jugador</th><th>H</th><th>AB</th>')}
  ${leadersTable('Sencillos', top15(stats.batting, singlesOf, (b) => singlesOf(b) > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${singlesOf(b)}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>1B</th>')}
  ${leadersTable('Carreras anotadas', top15(stats.batting, (b) => b.r, (b) => b.r > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.r}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>C</th>')}
  ${leadersTable('Carreras impulsadas', top15(stats.batting, (b) => b.rbi, (b) => b.rbi > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.rbi}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>CI</th>')}
  ${leadersTable('Jonrones', top15(stats.batting, (b) => b.hr, (b) => b.hr > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.hr}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>HR</th>')}
  ${leadersTable('Dobles', top15(stats.batting, (b) => b.doubles, (b) => b.doubles > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.doubles}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>2B</th>')}
  ${leadersTable('Triples', top15(stats.batting, (b) => b.triples, (b) => b.triples > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.triples}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>3B</th>')}
  ${leadersTable('Total de bases (TB)', top15(stats.batting, tbOf, (b) => tbOf(b) > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${tbOf(b)}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>TB</th>')}
  ${leadersTable('Extrabases (XBH)', top15(stats.batting, xbhOf, (b) => xbhOf(b) > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${xbhOf(b)}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>XBH</th>')}
  ${leadersTable('Bases robadas', top15(stats.batting, (b) => b.sb, (b) => b.sb > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.sb}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>BR</th>')}
  ${leadersTable('Bases por bolas', top15(stats.batting, (b) => b.bb, (b) => b.bb > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.bb}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>BB</th>')}
  ${leadersTable('Golpeados', top15(stats.batting, (b) => b.hbp, (b) => b.hbp > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.hbp}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>GP</th>')}
  ${leadersTable('Sacrificios', top15(stats.batting, (b) => b.sac + b.sf, (b) => b.sac + b.sf > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${b.sac + b.sf}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>SAC+SF</th>')}
  </div>
  <div class="lsec" data-ls="sab" style="display:none">
  <h2 class="sec">Sabermetría</h2>
  ${leadersTable('OPS (OBP+SLG)', top15(batQualPa, (b) => b.ops, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f3(b.ops)}</b></td><td>${f3(b.obp)}</td><td>${f3(b.slg)}</td></tr>`).join(''), '<th class="l">Jugador</th><th>OPS</th><th>OBP</th><th>SLG</th>')}
  ${leadersTable('OBP (% embasado)', top15(batQualObp, (b) => b.obp, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f3(b.obp)}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>OBP</th>')}
  ${leadersTable('SLG (slugging)', top15(batQualSlg, (b) => b.slg, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f3(b.slg)}</b></td><td>${tbOf(b)}</td></tr>`).join(''), '<th class="l">Jugador</th><th>SLG</th><th>TB</th>')}
  ${leadersTable('ISO (poder aislado)', top15(batQualPa, (b) => b.iso, (b) => b.iso > 0).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f3(b.iso)}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>ISO</th>')}
  ${leadersTable('BABIP', top15(batQualPa, (b) => b.babip, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f3(b.babip)}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>BABIP</th>')}
  ${leadersTable('wOBA', top15(batQualPa, (b) => b.woba, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f3(b.woba)}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>wOBA</th>')}
  ${leadersTable('wRAA (carreras sobre promedio)', top15(batQualPa, (b) => b.wraa, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f2(b.wraa)}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>wRAA</th>')}
  ${leadersTable('WAR* (estimado)', top15(batQualPa, (b) => b.war, () => true).map((b) => `<tr><td class="l">${batName(b)}</td><td><b>${f2(b.war)}</b></td><td>${f3(b.woba)}</td></tr>`).join(''), '<th class="l">Jugador</th><th>WAR*</th><th>wOBA</th>')}
  </div>
  <div class="lsec" data-ls="pit" style="display:none">
  <h2 class="sec">Pitcheo</h2>
  <p class="m">*WAR = estimación sabermétrica de la liga: wRAA del bateo (pesos wOBA, escala derivada de la liga) y FIP del pitcheo, contra nivel de reemplazo. Sin ajuste defensivo, posicional ni de parque — no es el WAR oficial de MLB.</p>
  ${leadersTable('Efectividad (ERA)', top15(pitQual, (p) => p.era, () => true, true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.era)}</b></td><td>${ipOf(p.outs)}</td><td>${p.w}-${p.l}</td></tr>`).join(''), '<th class="l">Lanzador</th><th>ERA</th><th>IP</th><th>W-L</th>')}
  ${leadersTable('Ganados', top15(stats.pitching, (p) => p.w, (p) => p.w > 0).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${p.w}</b></td><td>${f2(p.era)}</td></tr>`).join(''), '<th class="l">Lanzador</th><th>W</th><th>ERA</th>')}
  ${leadersTable('Ponches', top15(stats.pitching, (p) => p.k, (p) => p.k > 0).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${p.k}</b></td><td>${ipOf(p.outs)}</td></tr>`).join(''), '<th class="l">Lanzador</th><th>K</th><th>IP</th>')}
  ${leadersTable('WHIP', top15(pitQual, (p) => p.whip, () => true, true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.whip)}</b></td><td>${ipOf(p.outs)}</td></tr>`).join(''), '<th class="l">Lanzador</th><th>WHIP</th><th>IP</th>')}
  ${leadersTable('Salvados', top15(stats.pitching, (p) => p.sv, (p) => p.sv > 0).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${p.sv}</b></td></tr>`).join(''), '<th class="l">Lanzador</th><th>SV</th>')}
  ${leadersTable('Holds (HLD)', top15(stats.pitching, (p) => p.hld, (p) => p.hld > 0).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${p.hld}</b></td></tr>`).join(''), '<th class="l">Lanzador</th><th>HLD</th>')}
  ${leadersTable('Innings lanzados', top15(stats.pitching, (p) => p.outs, (p) => p.outs > 0).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${ipOf(p.outs)}</b></td><td>${p.gp}G</td></tr>`).join(''), '<th class="l">Lanzador</th><th>IP</th><th>G</th>')}
  ${leadersTable('Juegos completos', top15(stats.pitching, (p) => p.cg, (p) => p.cg > 0).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${p.cg}</b></td></tr>`).join(''), '<th class="l">Lanzador</th><th>CG</th>')}
  ${leadersTable('Blanqueadas', top15(stats.pitching, (p) => p.sho, (p) => p.sho > 0).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${p.sho}</b></td></tr>`).join(''), '<th class="l">Lanzador</th><th>SHO</th>')}
  <h2 class="sec">Pitcheo avanzado</h2>
  ${leadersTable('K/9', top15(pitQual, (p) => p.k9, () => true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.k9)}</b></td></tr>`).join(''), '<th class="l">Lanzador</th><th>K/9</th>')}
  ${leadersTable('BB/9 (control)', top15(pitQual, (p) => p.bb9, () => true, true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.bb9)}</b></td></tr>`).join(''), '<th class="l">Lanzador</th><th>BB/9</th>')}
  ${leadersTable('K/BB', top15(pitQual, (p) => p.kbb, () => true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.kbb)}</b></td></tr>`).join(''), '<th class="l">Lanzador</th><th>K/BB</th>')}
  ${leadersTable('P/IP (eficiencia)', top15(pitQual, (p) => p.pIp, () => true, true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.pIp)}</b></td></tr>`).join(''), '<th class="l">Lanzador</th><th>P/IP</th>')}
  ${leadersTable('AVG contra', top15(pitQual, (p) => p.avgAgainst, (p) => p.bf > 0, true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f3(p.avgAgainst)}</b></td><td>${p.abAg} AB</td></tr>`).join(''), '<th class="l">Lanzador</th><th>AVG</th><th>AB contra</th>')}
  ${leadersTable('FIP', top15(pitQual, (p) => p.fip, () => true, true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.fip)}</b></td><td>${f2(p.era)}</td></tr>`).join(''), '<th class="l">Lanzador</th><th>FIP</th><th>ERA</th>')}
  ${leadersTable('WAR* pitcheo (estimado)', top15(pitQual, (p) => p.war, () => true).map((p) => `<tr><td class="l">${batName(p)}</td><td><b>${f2(p.war)}</b></td><td>${f2(p.fip)}</td></tr>`).join(''), '<th class="l">Lanzador</th><th>WAR*</th><th>FIP</th>')}
  <h2 class="sec">Marcas individuales de pitcheo (highs &amp; lows en un juego)</h2>
  ${indTable('Más innings', (e) => e.pit?.outs ?? 0, (e) => `${ipOf(e.pit!.outs)} IP`)}
  ${indTable('Más ponches', (e) => e.pit?.k ?? 0, (e) => `${e.pit!.k} K`, 2)}
  ${indTable('Más lanzamientos', (e) => e.pit?.pitches ?? 0, (e) => `${e.pit!.pitches} Pit`, 5)}
  ${indTable('Menos hits permitidos (5+ outs)', (e) => (e.pit && e.pit.outs >= 5) ? -e.pit.h : 0, (e) => `${e.pit!.h} H en ${ipOf(e.pit!.outs)} IP`)}
  ${indTable('Más bases por bolas', (e) => e.pit?.bb ?? 0, (e) => `${e.pit!.bb} BB`, 2)}
  </div>
  <div class="lsec" data-ls="fld" style="display:none">
  <h2 class="sec">Defensa</h2>
  ${leadersTable('Promedio de fildeo', top15(stats.fielding, (f) => f.fpct, (f) => f.tc >= 3).map((f) => `<tr><td class="l">${playerLink(f.playerId, f.name)} <span class="m">(${esc(f.shortName)})</span></td><td><b>${f3(f.fpct)}</b></td><td>${f.tc} TC</td></tr>`).join(''), '<th class="l">Jugador</th><th>FPCT</th><th>TC</th>')}
  ${leadersTable('Range Factor (PO+A)/J', top15(stats.fielding, (f) => (f.po + f.a) / Math.max(1, gOf(f.playerId)), (f) => gOf(f.playerId) >= 2 && f.po + f.a > 0).map((f) => `<tr><td class="l">${playerLink(f.playerId, f.name)} <span class="m">(${esc(f.shortName)})</span></td><td><b>${f2((f.po + f.a) / Math.max(1, gOf(f.playerId)))}</b></td><td>${gOf(f.playerId)} JJ</td><td>${f.po}+${f.a}</td></tr>`).join(''), '<th class="l">Jugador</th><th>RF/G</th><th>JJ</th><th>PO+A</th>')}
  ${leadersTable('Menos errores (min. 5 TC)', top15(stats.fielding, (f) => f.e, (f) => f.tc >= 5, true).map((f) => `<tr><td class="l">${playerLink(f.playerId, f.name)} <span class="m">(${esc(f.shortName)})</span></td><td><b>${f.e}</b></td><td>${f3(f.fpct)}</td></tr>`).join(''), '<th class="l">Jugador</th><th>E</th><th>FPCT</th>')}
  ${leadersTable('Putouts', top15(stats.fielding, (f) => f.po, (f) => f.po > 0).map((f) => `<tr><td class="l">${playerLink(f.playerId, f.name)} <span class="m">(${esc(f.shortName)})</span></td><td><b>${f.po}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>PO</th>')}
  ${leadersTable('Asistencias', top15(stats.fielding, (f) => f.a, (f) => f.a > 0).map((f) => `<tr><td class="l">${playerLink(f.playerId, f.name)} <span class="m">(${esc(f.shortName)})</span></td><td><b>${f.a}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>A</th>')}
  ${leadersTable('Oportunidades (TC)', top15(stats.fielding, (f) => f.tc, (f) => f.tc > 0).map((f) => `<tr><td class="l">${playerLink(f.playerId, f.name)} <span class="m">(${esc(f.shortName)})</span></td><td><b>${f.tc}</b></td></tr>`).join(''), '<th class="l">Jugador</th><th>TC</th>')}
  </div>
</div>`;

  // ============================ PÁGINA DE RECORDS (highs/lows estilo BallStat) ============================
  const tgl = stats.teamGameLines;
  const tName = (tid: string) => league.teams.find((t) => t.id === tid);
  const bestOf = <T,>(arr: T[], by: (x: T) => number, high = true) =>
    arr.length ? arr.reduce((a, b) => (high ? by(b) > by(a) : by(b) < by(a)) ? b : a) : null;
  const tglRow = (label: string, by: (l: (typeof tgl)[number]) => number, high: boolean, fmt: (l: (typeof tgl)[number]) => string) => {
    const l = bestOf(tgl, by, high);
    if (!l) return '';
    const t = tName(l.teamId);
    return `<tr><td class="l">${label}</td><td><b>${fmt(l)}</b></td>
      <td class="l">${t ? teamLink(l.teamId, t.name) : esc(l.teamId)} vs ${esc(l.opp)}</td>
      <td>${gameLink(l.gameId, fecha(l.date))}</td></tr>`;
  };
  const margin = (w: boolean) => { const f = w ? (l: (typeof tgl)[number]) => l.rf - l.ra : (l: (typeof tgl)[number]) => l.ra - l.rf; return f; };
  const recordsPage = `<div class="page" id="${pfx}/records">
  <h2>Marcas del torneo (Highs &amp; Lows)</h2>
  <h3>Equipo — mejor juego</h3>
  <div class="tw"><table><thead><tr><th class="l">Marca</th><th>Valor</th><th class="l">Equipo</th><th>Fecha</th></tr></thead>
  <tbody>
  ${tglRow('Más carreras anotadas', (l) => l.rf, true, (l) => `${l.rf}`)}
  ${tglRow('Más hits', (l) => l.h, true, (l) => `${l.h}`)}
  ${tglRow('Más carreras impulsadas', (l) => l.rbi, true, (l) => `${l.rbi}`)}
  ${tglRow('Más bases por bolas', (l) => l.bb, true, (l) => `${l.bb}`)}
  ${tglRow('Más bases robadas', (l) => l.sb, true, (l) => `${l.sb}`)}
  ${tglRow('Más dejados en base', (l) => l.lob, true, (l) => `${l.lob}`)}
  ${tglRow('Mayor margen de victoria', margin(true), true, (l) => `+${l.rf - l.ra} (${l.rf}-${l.ra})`)}
  ${tglRow('Juego más largo', (l) => l.inn, true, (l) => `${l.inn} entradas`)}
  ${tglRow('Más ponches lanzados', (l) => l.pK, true, (l) => `${l.pK}`)}
  ${tglRow('Menos hits permitidos', (l) => l.pH, false, (l) => `${l.pH}`)}
  </tbody></table></div>
  <h3>Equipo — peor juego</h3>
  <div class="tw"><table><thead><tr><th class="l">Marca</th><th>Valor</th><th class="l">Equipo</th><th>Fecha</th></tr></thead>
  <tbody>
  ${tglRow('Menos carreras anotadas', (l) => l.rf, false, (l) => `${l.rf}`)}
  ${tglRow('Menos hits', (l) => l.h, false, (l) => `${l.h}`)}
  ${tglRow('Más carreras permitidas', (l) => l.ra, true, (l) => `${l.ra}`)}
  ${tglRow('Más hits permitidos', (l) => l.pH, true, (l) => `${l.pH}`)}
  ${tglRow('Más errores', (l) => l.e, true, (l) => `${l.e}`)}
  ${tglRow('Más ponches al bate', (l) => l.k, true, (l) => `${l.k}`)}
  ${tglRow('Mayor margen de derrota', margin(false), true, (l) => `-${l.ra - l.rf} (${l.rf}-${l.ra})`)}
  </tbody></table></div>
  <h2 class="sec">Marcas individuales en un juego — Bateo</h2>
  ${indTable('Más hits', (e) => e.bat?.h ?? 0, (e) => `${e.bat!.h} H`, 2)}
  ${indTable('Más jonrones', (e) => e.bat?.hr ?? 0, (e) => `${e.bat!.hr} HR`)}
  ${indTable('Más carreras impulsadas', (e) => e.bat?.rbi ?? 0, (e) => `${e.bat!.rbi} CI`, 2)}
  ${indTable('Más carreras anotadas', (e) => e.bat?.r ?? 0, (e) => `${e.bat!.r} C`, 2)}
  ${indTable('Más bases robadas', (e) => e.bat?.sb ?? 0, (e) => `${e.bat!.sb} BR`)}
  ${indTable('Más bases por bolas', (e) => e.bat?.bb ?? 0, (e) => `${e.bat!.bb} BB`, 2)}
  <h2 class="sec">Marcas individuales en un juego — Pitcheo</h2>
  ${indTable('Más innings', (e) => e.pit?.outs ?? 0, (e) => `${ipOf(e.pit!.outs)} IP`)}
  ${indTable('Más ponches', (e) => e.pit?.k ?? 0, (e) => `${e.pit!.k} K`, 2)}
  ${indTable('Más lanzamientos', (e) => e.pit?.pitches ?? 0, (e) => `${e.pit!.pitches} Pit`, 5)}
  ${indTable('Menos hits permitidos (5+ outs)', (e) => (e.pit && e.pit.outs >= 5) ? -e.pit.h : 0, (e) => `${e.pit!.h} H en ${ipOf(e.pit!.outs)} IP`)}
  ${indTable('Más bases por bolas', (e) => e.pit?.bb ?? 0, (e) => `${e.pit!.bb} BB`, 2)}
</div>`;

  // ============================ PÁGINA DE POSTEMPORADA ============================
  const resById = new Map(post.results.map((r) => [r.id, r]));
  const poRounds = [...new Set(series.map((x) => x.round))].sort((a, b) => a - b);
  const seriesBlock = (sr: SeriesRow) => {
    const wins = new Map<string, number>();
    const rows = [...sr.games].sort((a, b) => +new Date(a.date) - +new Date(b.date)).map((g, i) => {
      const r = resById.get(g.id);
      if (!r) return `<tr><td>J${i + 1}</td><td colspan="4" class="m">Programado</td></tr>`;
      const gw = r.tied ? null : r.aR > r.hR ? r.awayId : r.homeId;
      if (gw) wins.set(gw, (wins.get(gw) ?? 0) + 1);
      return `<tr><td>J${i + 1} · ${fecha(r.date)}</td><td class="l">${teamLink(r.awayId, r.away)} <b>${r.aR}</b></td><td>@</td><td class="l">${teamLink(r.homeId, r.home)} <b>${r.hR}</b></td><td>${gameLink(r.id, 'boxscore')}</td></tr>`;
    }).join('');
    const winName = sr.winnerTeamId ? tName(sr.winnerTeamId)?.name : null;
    return `<h4>${esc(redactStr(sr.name))} <span class="m">— al mejor de ${sr.winsNeeded * 2 - 1}${winName ? ` · ✔ gana <b>${esc(winName)}</b>` : ''}</span></h4>
      <div class="tw"><table><tbody>${rows || '<tr><td class="m">Sin juegos todavía</td></tr>'}</tbody></table></div>
      <p class="m">Serie: ${tName(sr.homeTeamId)?.shortName ?? '?'} <b>${wins.get(sr.homeTeamId) ?? 0}</b> — <b>${wins.get(sr.awayTeamId) ?? 0}</b> ${tName(sr.awayTeamId)?.shortName ?? '?'}</p>`;
  };
  const champ = poRounds.length ? series.find((x) => x.round === poRounds[poRounds.length - 1] && x.winnerTeamId) : null;
  // bracket visual: una columna por ronda, cada serie = celda con marcador de serie
  const seriesWins = (sr: SeriesRow) => {
    const w = new Map<string, number>();
    for (const g of sr.games) {
      const r = resById.get(g.id);
      if (!r || r.tied) continue;
      const gw = r.aR > r.hR ? r.awayId : r.homeId;
      w.set(gw, (w.get(gw) ?? 0) + 1);
    }
    return w;
  };
  const bracket = !career && poRounds.length ? `<div class="brk">${poRounds.map((rd) => {
    const label = rd === poRounds[poRounds.length - 1] && poRounds.length > 1 ? 'Final' : `Ronda ${rd}`;
    const cells = series.filter((x) => x.round === rd).map((sr) => {
      const w = seriesWins(sr);
      const aw = w.get(sr.awayTeamId ?? '') ?? 0, hw = w.get(sr.homeTeamId ?? '') ?? 0;
      const aWin = sr.winnerTeamId && sr.winnerTeamId === sr.awayTeamId;
      const hWin = sr.winnerTeamId && sr.winnerTeamId === sr.homeTeamId;
      return `<div class="brk-s">
        <div class="brk-t${aWin ? ' win' : ''}"><span>${esc(tName(sr.awayTeamId)?.shortName ?? tName(sr.awayTeamId)?.name ?? '—')}</span><b>${aw}</b></div>
        <div class="brk-t${hWin ? ' win' : ''}"><span>${esc(tName(sr.homeTeamId)?.shortName ?? tName(sr.homeTeamId)?.name ?? '—')}</span><b>${hw}</b></div>
        <div class="brk-m">${esc(redactStr(sr.name))} · mejor de ${sr.winsNeeded * 2 - 1}</div>
      </div>`;
    }).join('');
    return `<div class="brk-r"><h4>${label}</h4>${cells}</div>`;
  }).join('')}</div>` : '';
  // carrera: agrupar por temporada; temporada: por ronda
  const poGroups: { label: string; rows: SeriesRow[] }[] = career
    ? [...new Set(series.map((x) => x._year ?? 0))].sort((a, b) => a - b)
        .map((y) => ({ label: `Temporada ${y}`, rows: series.filter((x) => (x._year ?? 0) === y) }))
    : poRounds.map((rd) => ({ label: rd === poRounds[poRounds.length - 1] && poRounds.length > 1 ? 'Final' : `Ronda ${rd}`, rows: series.filter((x) => x.round === rd) }));
  const champLine = career
    ? poGroups.map((g) => {
        const yr = g.rows;
        const fin = yr.filter((x) => x.round === Math.max(...yr.map((r) => r.round)));
        const w = fin.find((x) => x.winnerTeamId)?.winnerTeamId;
        return w ? `<b>${g.label.replace('Temporada ', '')}</b>: ${esc(tName(w)?.name ?? '')}` : null;
      }).filter(Boolean).join(' · ')
    : '';
  const poLead = (title: string, arr: typeof post.batting, fmt: (x: (typeof post.batting)[number]) => string, min?: (x: (typeof post.batting)[number]) => boolean) =>
    leaderCard(title, arr, (b) => b.avg, fmt, batName, { min: min ?? ((b) => b.pa >= 6) });
  const playoffsPage = `<div class="page" id="${pfx}/playoffs">
  <h2>🏆 Postemporada${career ? ' — histórico' : ''}</h2>
  ${career && champLine ? `<div class="champ">🏆 Campeones: ${champLine}</div>` : ''}
  ${!career && champ?.winnerTeamId ? `<div class="champ">🏆 Campeón de la temporada: <b>${esc(tName(champ.winnerTeamId)?.name ?? '')}</b></div>` : ''}
  ${bracket}
  ${poGroups.length ? poGroups.map((g) => `<h3>${g.label}</h3>` + g.rows.map(seriesBlock).join('')).join('')
    : '<p class="m">Esta temporada aún no tiene postemporada.</p>'}
  ${post.games ? `<h2 class="sec">Líderes de playoff</h2>
    ${poLead('AVG', post.batting, (b) => f3(b.avg))}
    ${leaderCard('Jonrones', post.batting, (b) => b.hr, (b) => String(b.hr), batName)}
    ${leaderCard('Carreras impulsadas', post.batting, (b) => b.rbi, (b) => String(b.rbi), batName)}
    ${leaderCard('Hits', post.batting, (b) => b.h, (b) => String(b.h), batName)}
    ${leaderCard('Ganados', post.pitching, (p) => p.w, (p) => String(p.w), (p) => batName(p))}
    ${leaderCard('Salvados', post.pitching, (p) => p.sv, (p) => String(p.sv), (p) => batName(p))}
    ${leaderCard('ERA', post.pitching, (p) => p.era, (p) => f2(p.era), (p) => batName(p), { asc: true, min: (p) => p.outs >= 6 })}
    ${leaderCard('Ponches', post.pitching, (p) => p.k, (p) => String(p.k), (p) => batName(p))}` : ''}
</div>`;

  return [mainPage, teamPages, playerPages, gamePages, playoffsPage, leadersPage, recordsPage].join('\n');
  };

  // Una copia del sitio por temporada (Season explícita o respaldo por año de fecha).
  const parts: string[] = [];
  for (const s of seasonList) {
    const filter = s.id ? { seasonId: s.id } : { year: s.year };
    const [stats, standings, post] = await Promise.all([
      leagueStats(league.id, 'reg', filter),
      leagueStandings(league.id, filter),
      leagueStats(league.id, 'post', filter),
    ]);
    // series de esta temporada: por seasonId; respaldo = series viejas sin temporada, por año de fecha de sus juegos
    const seasonSeries = allSeries.filter((sr) =>
      s.id ? sr.seasonId === s.id : !sr.seasonId && sr.games.some((g) => new Date(g.date).getFullYear() === s.year));
    yearData.push({ year: s.year, stats: redactStats(stats), post: redactStats(post) });
    const yd = yearData[yearData.length - 1];
    parts.push(buildYear(yd.stats, redactStand(standings), `pg@${s.year}`, seasonSeries, yd.post));
  }
  // Carrera: copia extra con todas las temporadas fusionadas (posiciones históricas,
  // líderes de carrera, fichas por año en cada jugador, postemporada histórica)
  if (multiYear) {
    const regC = redactStats(mergeStats(yearData.map((y) => y.stats)));
    const postC = redactStats(mergeStats(yearData.map((y) => y.post)));
    const seriesC = allSeries.map((sr) => ({ ...sr, _year: yearOfSeries(sr) }));
    parts.push(buildYear(regC, redactStand(careerStandings(regC)), 'pg@car', seriesC, postC, true));
  }
  const photoImgs = [...photoPool.entries()].map(([pid, src]) => `<img id="ph-${pid}" src="${src}" alt="">`).join('');
  const yearSel = multiYear
    ? `<select id="ysel" class="ysel" title="Temporada">${seasonList.map((s) => `<option value="${s.year}">Temporada ${s.year}</option>`).join('')}<option value="car">Carrera</option></select>`
    : '';
  // índice de jugadores para el buscador del menú (id + nombre + equipo) — todas las temporadas
  const playersJson = JSON.stringify(
    [...new Map(yearData.flatMap((y) => [...y.stats.meta, ...y.post.meta])).entries()]
      .map(([id, m]) => ({ id, n: m.name, t: m.teamName })),
  ).replace(/</g, '\\u003c');
  // stats por jugador/año (REG+POST sumadas) para el comparador y la card PNG del site:
  // bateo + pitcheo (prefijo p) + meta (número/posición/B-T/color del equipo)
  const pstats: Record<string, { n: string; t: string; no?: number | null; pos?: string | null; bt?: string | null; col?: string | null; y: Record<string, Record<string, number>> }> = {};
  const BKEYS = ['g', 'pa', 'ab', 'r', 'h', 'doubles', 'triples', 'hr', 'rbi', 'bb', 'k', 'sb', 'hbp', 'sf'] as const;
  const PKEYS = { gp: 'pGP', outs: 'pOuts', er: 'pER', r: 'pR', bb: 'pBB', k: 'pK', h: 'pH', w: 'pW', l: 'pL', sv: 'pSV', gs: 'pGS' } as const;
  const teamCol = (tid: string) => league.teams.find((t) => t.id === tid)?.color ?? null;
  const fillMeta = (d: { no?: number | null; pos?: string | null; bt?: string | null; col?: string | null }, m: { number?: number | null; positions?: string | null; bats?: string | null; throws?: string | null; teamId?: string }) => {
    d.no = m.number ?? null; d.pos = m.positions ?? null;
    d.bt = `${m.bats ?? '?'}/${m.throws ?? '?'}`;
    d.col = m.teamId ? teamCol(m.teamId) : null;
  };
  for (const yd of yearData) for (const src of [yd.stats, yd.post]) {
    for (const b of src.batting) {
      const d = (pstats[b.playerId] ??= { n: b.name, t: b.teamName, y: {} });
      fillMeta(d, b);
      const yy = (d.y[yd.year] ??= {});
      for (const k of BKEYS) yy[k] = (yy[k] ?? 0) + ((b as unknown as Record<string, number>)[k] ?? 0);
    }
    for (const p of src.pitching) {
      const d = (pstats[p.playerId] ??= { n: p.name, t: p.teamName, y: {} });
      fillMeta(d, p);
      const yy = (d.y[yd.year] ??= {});
      for (const [k, kk] of Object.entries(PKEYS)) yy[kk] = (yy[kk] ?? 0) + ((p as unknown as Record<string, number>)[k] ?? 0);
    }
  }
  const pstatsJson = JSON.stringify(pstats).replace(/</g, '\\u003c');
  // página del comparador — una sola, sin prefijo de año (el JS elige el período)
  parts.push(`<div class="page" id="pg/comparar">
  <h2>⚖️ Comparar jugadores</h2>
  <div class="cmpslots">
    <div class="cmpslot"><input id="cmpqa" type="search" placeholder="Jugador A…" autocomplete="off"><div id="cmpda" class="cmpd"></div></div>
    <div class="cmpslot"><input id="cmpqb" type="search" placeholder="Jugador B…" autocomplete="off"><div id="cmpdb" class="cmpd"></div></div>
  </div>
  <div id="cmpout"><p class="m">Elige los dos jugadores para compararlos — por carrera o por año.</p></div>
</div>`);
  const nav = `<nav class="topnav"><a class="brand" href="#/">⚾ ${esc(league.name)} ${multiYear ? '<b id="yrLbl"></b>' : league.year}</a>${yearSel}${league.teams.map((t) => `<a href="#/equipo/${t.id}">${esc(t.blocked ? '🚫 BLOQUEADO' : (t.shortName ?? t.name))}</a>`).join('')}<a href="#/lideres">Líderes</a><a href="#/playoffs">Playoffs</a><a href="#/records">Records</a><a href="#/comparar">Comparar</a><span class="srch"><input id="psq" type="search" placeholder="🔎 Buscar jugador…" autocomplete="off"><div id="psd"></div></span></nav>`;

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(league.name)} ${league.year} — PoxScore</title>
<style>
.blk{background:#b91c1c;color:#b91c1c;border-radius:3px;padding:0 1px;white-space:nowrap}
  :root { --navy:#1e3a5f; --line:#d7dee8; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; margin: 0; color:#1f2937; background:#f1f5f9; }
  .topnav { position:sticky; top:0; z-index:5; background:var(--navy); display:flex; flex-wrap:wrap; gap:2px; align-items:stretch; overflow-x:auto; }
  .topnav a { color:#eef3f8; text-decoration:none; padding:.55rem .8rem; font-size:.95rem; font-weight:600; white-space:nowrap; }
  .topnav a:hover { background:rgba(255,255,255,.15); }
  .topnav .brand { color:#fff; font-weight:800; }
  .srch { margin-left:auto; display:flex; align-items:center; position:relative; padding:0 .4rem; }
  .srch input { background:rgba(255,255,255,.15); border:1px solid rgba(255,255,255,.3); color:#fff; border-radius:6px; padding:.32rem .6rem; font-size:.8rem; width:170px; transition:width .2s; }
  .srch input::placeholder { color:#b8c4d8; }
  .srch input:focus { outline:none; background:rgba(255,255,255,.25); width:230px; border-color:rgba(255,255,255,.55); }
  #psd { position:fixed; min-width:270px; background:#fff; border-radius:8px; box-shadow:0 8px 28px rgba(0,0,0,.32); display:none; overflow:hidden; z-index:30; }
  #psd.on { display:block; }
  #psd a { display:flex; flex-direction:column; gap:1px; padding:.45rem .8rem; color:#1f2937; text-decoration:none; border-bottom:1px solid #eef1f5; font-size:.9rem; white-space:normal; }
  #psd a:hover { background:#f1f5f9; }
  #psd a span { color:#64748b; font-size:.74rem; text-transform:none; font-weight:400; }
  #psd .none { padding:.55rem .8rem; color:#64748b; font-size:.85rem; }
  .wrap { max-width:1100px; margin:0 auto; padding:1rem; }
  .banner { background:linear-gradient(90deg,var(--navy),#2f5b8f); color:#fff; padding:1rem 1.5rem; border-radius:10px; margin-bottom:1rem; }
  .banner h1 { margin:0; font-size:1.5rem; } .banner .m { color:#bcd; }
  h2 { color:var(--navy); border-bottom:2px solid var(--navy); padding-bottom:.2rem; margin-top:1.4rem; }
  h3 { color:var(--navy); margin:.9rem 0 .35rem; }
  h2.sec { background:var(--navy); color:#fff; padding:.3rem .7rem; border-radius:6px; }
  .tw { overflow-x:auto; }
  .page { display:none; }
  table { border-collapse:collapse; width:100%; font-size:.82rem; background:#fff; margin-bottom:.8rem; min-width:520px; }
  th,td { border:1px solid var(--line); padding:.3rem .45rem; text-align:center; white-space:nowrap; }
  th { background:var(--navy); color:#fff; font-weight:600; }
  td.l, th.l { text-align:left; } .m { color:#64748b; }
  a { color:#1668b4; }
  a[href^="#/jugador/"] { text-transform:uppercase; font-weight:700; font-size:1.06em; }
  a[href^="#/equipo/"] { font-weight:700; font-size:1.06em; }
  .player-head h2 { font-size:1.75rem; text-transform:uppercase; margin:.1rem 0 .15rem; }
  .player-head .pphoto { width:104px; height:104px; }
  h2 { font-size:1.35rem; }
  tr:nth-child(even) td { background:#f8fafc; }
  .leader { display:inline-block; vertical-align:top; min-width:210px; margin:0 1rem .8rem 0; background:#fff; border:1px solid var(--line); border-radius:8px; padding:.5rem .9rem; }
  .champ { background:linear-gradient(90deg,#fef3c7,#fde68a); border:1px solid #d97706; border-radius:8px; padding:.7rem 1rem; font-size:1.15rem; margin-bottom:1rem; }
  .leader h4 { margin:.2rem 0 .3rem; color:var(--navy); } .leader ol { margin:0; padding-left:1.2rem; }
  .leader li { display:flex; align-items:center; gap:.45rem; margin:.22rem 0; }
  .leader .lph { width:30px; height:30px; border-radius:50%; flex:none; display:inline-flex; align-items:center; justify-content:center; overflow:hidden; background:#cbd5e1; }
  .leader .lph .pphoto { width:30px; height:30px; border-radius:50%; }
  .leader .lph.pph::after { content:''; }
  .leader .linit { color:#475569; font-weight:700; font-size:.85rem; }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
  .player-head { display:flex; gap:1rem; align-items:center; margin-bottom:.4rem; }
  .pphoto { width:84px; height:84px; border-radius:10px; object-fit:cover; background:#cbd5e1; }
  .pph { display:flex; align-items:center; justify-content:center; color:#64748b; font-size:.62rem; }
  .pph::after { content:'SIN FOTO'; }
  .ysel { align-self:center; margin:.3rem .5rem .3rem .2rem; background:#fff; color:var(--navy); border:0; border-radius:6px; padding:.28rem .45rem; font-weight:700; font-size:.82rem; cursor:pointer; }
  /* bracket visual de playoffs */
  .brk { display:flex; gap:1.1rem; overflow-x:auto; margin:.6rem 0 1rem; padding-bottom:.3rem; }
  .brk-r { min-width:180px; flex:none; }
  .brk-r h4 { margin:.15rem 0 .5rem; color:var(--navy); text-transform:uppercase; font-size:.75rem; letter-spacing:.5px; }
  .brk-s { border:1.5px solid var(--line); border-radius:8px; margin-bottom:.9rem; background:#fff; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.07); }
  .brk-t { display:flex; justify-content:space-between; gap:.6rem; padding:.35rem .65rem; font-size:.84rem; }
  .brk-t+.brk-t { border-top:1px solid #eef1f5; }
  .brk-t.win { background:#dcfce7; font-weight:700; }
  .brk-m { font-size:.66rem; color:#64748b; padding:.28rem .65rem; background:#f8fafc; }
  /* comparador de jugadores */
  .cmpslots { display:grid; grid-template-columns:1fr 1fr; gap:1rem; margin-bottom:1rem; max-width:640px; }
  .cmpslot { position:relative; }
  .cmpslot input { width:100%; }
  .cmpd { position:absolute; left:0; right:0; top:calc(100% + 4px); background:#fff; border-radius:8px; box-shadow:0 8px 28px rgba(0,0,0,.28); display:none; overflow:hidden; z-index:20; }
  .cmpd.on { display:block; }
  .cmpd a { display:flex; flex-direction:column; gap:1px; padding:.45rem .8rem; color:#1f2937; cursor:pointer; border-bottom:1px solid #eef1f5; font-size:.9rem; }
  .cmpd a:hover { background:#f1f5f9; }
  .cmpd a span { color:#64748b; font-size:.74rem; }
  .cmpper { text-align:center; margin-bottom:.7rem; }
  .cmpt { max-width:600px; margin:0 auto; }
  .cmpt table { min-width:0; }
  .cmpt td { vertical-align:middle; }
  .cnum { display:block; font-weight:700; font-size:1.02rem; }
  .cbar { display:block; height:7px; border-radius:4px; background:#e2e8f0; margin-top:3px; }
  td.cvl .cbar { margin-left:auto; }
  td.cvl { text-align:right; width:44%; }
  td.cvr { text-align:left; width:44%; }
  td.clb { text-align:center; color:#6b7280; font-size:.78rem; letter-spacing:1px; width:12%; }
  td.w .cbar { background:linear-gradient(90deg,#16a34a,#4ade80); }
  td.w .cnum { color:#15803d; }
  .lbar { background:#fff; border:1px solid var(--line); border-radius:8px; padding:.5rem .9rem; margin:.6rem 0 1rem; display:inline-block; }
  .lbar select { font-size:.95rem; font-weight:600; padding:.3rem .5rem; border-radius:6px; border:1px solid var(--line); }
  .cdl { margin-top:.5rem; background:linear-gradient(135deg,#1e3a5f,#2f5b8f); color:#fff; border:0; border-radius:8px; padding:.45rem .9rem; font-size:.85rem; font-weight:700; cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,.2); }
  .cdl:hover { filter:brightness(1.15); }
  footer { color:#94a3b8; font-size:.8rem; margin:2rem 0; text-align:center; }
  @media (max-width:700px) { .two { grid-template-columns:1fr; } table { font-size:.75rem; } .wrap { padding:.6rem; } }
  @media print { .topnav { display:none } }
</style></head><body>
${nav}
<div class="wrap">
<header class="banner"><h1>⚾ ${esc(league.name)}</h1><div class="m">${multiYear ? `${seasonList[seasonList.length - 1].year}–${seasonList[0].year}` : league.year} · ${league.sport === 'softball' ? 'Softball' : 'Baseball'} · ${finals.length} juegos finalizados${multiYear ? ' · elige la temporada en el selector de arriba' : ''}</div></header>
${parts.join('\n').replace(/>(?:[^<>]*\b(?:null|NaN|undefined)\b[^<>]*)</g, '><span class="blk">██</span><')}
<div id="phpool" hidden>${photoImgs}</div>
<footer>Generado por PoxScore · ${new Date().toLocaleString('es')}<br>Desarrollado por Alexis Lara · 2026</footer>
</div>
<script>
var YEARS=[${seasonList.map((s) => s.year).join(',')}];
var PLAYERS=${playersJson};
var curYear=YEARS[0];
var pages=document.querySelectorAll('.page');
var sel=document.getElementById('ysel');
function findpg(path){
  var e=document.getElementById('pg@'+curYear+path); if(e)return e;
  e=document.getElementById('pg'+path); if(e)return e;
  for(var i=0;i<YEARS.length;i++){e=document.getElementById('pg@'+YEARS[i]+path); if(e)return e;}
  return document.getElementById('pg@'+curYear+'/')||document.getElementById('pg/');
}
function showpg(el){
  for(var i=0;i<pages.length;i++) pages[i].style.display='none';
  if(!el)return;
  el.style.display='block';
  var ph=el.querySelectorAll('[data-ph]');
  for(var j=0;j<ph.length;j++){var s=document.getElementById('ph-'+ph[j].getAttribute('data-ph'));
    if(s&&!ph[j].firstChild){var img=document.createElement('img');img.className='pphoto';img.src=s.src;ph[j].appendChild(img);ph[j].classList.remove('pph');}}
}
function yearSeg(h){
  var seg=h.split('/');
  if(seg.length>1&&seg[1]==='car')return 'car';
  return seg.length>1&&seg[1].length===4&&YEARS.indexOf(+seg[1])>=0?seg[1]:null;
}
function route(){
  var h=location.hash.charAt(0)==='#'?location.hash.slice(1):location.hash;
  h=h||'/';
  var y=yearSeg(h);
  if(y){curYear=(y==='car')?'car':+y;h='/'+h.split('/').slice(2).join('/');}
  if(sel)sel.value=String(curYear);
  var yl=document.getElementById('yrLbl');if(yl)yl.textContent=(curYear==='car'?'Carrera':curYear);
  showpg(findpg(h));
  window.scrollTo(0,0);
}
if(sel)sel.onchange=function(){
  var h=location.hash.slice(1)||'/';
  if(yearSeg(h))h='/'+h.split('/').slice(2).join('/');
  if(h.charAt(0)!=='/')h='/'+h;
  location.hash='/'+sel.value+h;
};
var PSQ=document.getElementById('psq'),PSD=document.getElementById('psd');
function normTxt(s){return (s||'').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g,'');}
function posPSD(){var r=PSQ.getBoundingClientRect();PSD.style.top=(r.bottom+4)+'px';PSD.style.right=(innerWidth-r.right)+'px';}
if(PSQ){
  PSQ.addEventListener('focus',posPSD);
  addEventListener('resize',function(){if(PSD.classList.contains('on'))posPSD();});
  PSQ.addEventListener('input',function(){
    posPSD();
    var q=normTxt(PSQ.value);
    PSD.innerHTML='';
    if(q.length<2){PSD.classList.remove('on');return;}
    var n=0;
    for(var i=0;i<PLAYERS.length;i++){
      var p=PLAYERS[i];
      if(normTxt(p.n).indexOf(q)<0)continue;
      var a=document.createElement('a');
      a.href='#/jugador/'+p.id;
      a.innerHTML='<b>'+p.n+'</b>'+(p.t?'<span>'+p.t+'</span>':'');
      a.onclick=function(){PSD.classList.remove('on');PSQ.value='';};
      PSD.appendChild(a);
      if(++n>=12)break;
    }
    if(!n){var d=document.createElement('div');d.className='none';d.textContent='Sin resultados';PSD.appendChild(d);}
    PSD.classList.add('on');
  });
  PSQ.addEventListener('keydown',function(e){
    if(e.key==='Enter'){var a=PSD.querySelector('a');if(a){location.hash=a.getAttribute('href');PSD.classList.remove('on');PSQ.value='';}}
    if(e.key==='Escape'){PSD.classList.remove('on');PSQ.blur();}
  });
  document.addEventListener('click',function(e){if(!PSQ.parentNode.contains(e.target))PSD.classList.remove('on');});
}
/* ---- comparador de jugadores (#/comparar) ---- */
var PSTATS=${pstatsJson};
var CMP={a:null,b:null,per:'car'};
function cmpWire(qid,did,slot){
  var q=document.getElementById(qid),d=document.getElementById(did);
  if(!q||!d)return;
  q.addEventListener('input',function(){
    var qq=normTxt(q.value);d.innerHTML='';
    if(qq.length<2){d.classList.remove('on');return;}
    var n=0;
    for(var i=0;i<PLAYERS.length;i++){var p=PLAYERS[i];
      if(!PSTATS[p.id]||normTxt(p.n).indexOf(qq)<0)continue;
      var a=document.createElement('a');
      a.innerHTML='<b>'+p.n+'</b>'+(p.t?'<span>'+p.t+'</span>':'');
      a.onclick=function(pid,nn){return function(){CMP[slot]=pid;q.value=nn;d.classList.remove('on');renderCmp();};}(p.id,p.n);
      d.appendChild(a);if(++n>=10)break;
    }
    if(!n){var e=document.createElement('a');e.innerHTML='<span>Sin resultados</span>';d.appendChild(e);}
    d.classList.add('on');
  });
  document.addEventListener('click',function(e){if(!q.parentNode.contains(e.target))d.classList.remove('on');});
}
function cmpSum(pid){
  var y=PSTATS[pid]?PSTATS[pid].y:{};var z={};
  for(var yr in y){if(CMP.per!=='car'&&+yr!==CMP.per)continue;var s=y[yr];for(var k in s)z[k]=(z[k]||0)+s[k];}
  var od=(z.ab||0)+(z.bb||0)+(z.hbp||0)+(z.sf||0);
  z.avg=z.ab?(z.h||0)/z.ab:0;
  z.obp=od?((z.h||0)+(z.bb||0)+(z.hbp||0))/od:0;
  z.slg=z.ab?((z.h||0)+(z.doubles||0)+2*(z.triples||0)+3*(z.hr||0))/z.ab:0;
  z.ops=z.obp+z.slg;
  return z;
}
function cmpF(n,rate){return rate?n.toFixed(3).replace(/^0/,''):String(n||0);}
function renderCmp(){
  var out=document.getElementById('cmpout');if(!out)return;
  if(!CMP.a||!CMP.b){out.innerHTML='<p class="m">Elige los dos jugadores para compararlos — por carrera o por año.</p>';return;}
  var yrs={},yr;
  for(yr in PSTATS[CMP.a].y)yrs[yr]=1;
  for(yr in PSTATS[CMP.b].y)yrs[yr]=1;
  yrs=Object.keys(yrs).sort(function(x,y){return +y-+x;});
  if(CMP.per!=='car'&&yrs.indexOf(String(CMP.per))<0)CMP.per='car';
  var sa=cmpSum(CMP.a),sb=cmpSum(CMP.b);
  var cats=[['JJ','g'],['VB','ab'],['CA','r'],['H','h'],['2B','doubles'],['3B','triples'],['HR','hr'],['CI','rbi'],['BB','bb'],['SO','k'],['BR','sb'],['AVG','avg'],['OBP','obp'],['SLG','slg'],['OPS','ops']];
  var rows=cats.map(function(c){
    var rate=c[1].length>2;
    var va=sa[c[1]]||0,vb=sb[c[1]]||0,hi=Math.max(va,vb);
    var pa=hi?Math.max(6,Math.round(va/hi*100)):0,pb=hi?Math.max(6,Math.round(vb/hi*100)):0;
    return '<tr><td class="cvl'+(va>vb?' w':'')+'"><span class="cnum">'+cmpF(va,rate)+'</span><span class="cbar" style="width:'+pa+'%"></span></td>'
      +'<td class="clb">'+c[0]+'</td>'
      +'<td class="cvr'+(vb>va?' w':'')+'"><span class="cnum">'+cmpF(vb,rate)+'</span><span class="cbar" style="width:'+pb+'%"></span></td></tr>';
  }).join('');
  var sel='<select id="cmper"><option value="car"'+(CMP.per==='car'?' selected':'')+'>Carrera</option>'
    +yrs.map(function(y){return '<option value="'+y+'"'+(String(CMP.per)===y?' selected':'')+'>'+y+'</option>';}).join('')+'</select>';
  out.innerHTML='<div class="cmpper">Período: '+sel+'</div><div class="tw cmpt"><table><thead><tr><th>'+PSTATS[CMP.a].n+'</th><th></th><th class="l" style="text-align:left">'+PSTATS[CMP.b].n+'</th></tr></thead><tbody>'+rows+'</tbody></table></div><p class="m">La barra verde marca quién gana cada categoría'+(CMP.per!=='car'?' en '+CMP.per:' en su carrera')+'.</p>';
  var pe=document.getElementById('cmper');
  if(pe)pe.onchange=function(){CMP.per=this.value==='car'?'car':+this.value;renderCmp();};
}
cmpWire('cmpqa','cmpda','a');cmpWire('cmpqb','cmpdb','b');
/* ---- selector de secciones en Líderes (bateo/saber/pitcheo/defensa/marcas) ---- */
function lseg(s){
  var v=s.value;
  if(v==='_records'){location.hash='#/records';return;}
  var pg=s.parentNode;
  while(pg&&(!pg.className||(' '+pg.className+' ').indexOf(' page ')<0))pg=pg.parentNode;
  if(!pg)return;
  var secs=pg.querySelectorAll('[data-ls]');
  for(var i=0;i<secs.length;i++)secs[i].style.display=secs[i].getAttribute('data-ls')===v?'':'none';
}
/* ---- card PNG estilo MLB (vertical, para WhatsApp/redes) ---- */
var LEAGUE=${JSON.stringify(league.name)};var REGINN=${league.innings ?? (league.sport === 'softball' ? 7 : 9)};
function cardSum(pid,per){
  var d=PSTATS[pid];if(!d)return null;
  var y=d.y,z={};
  for(var yr in y){if(per!=='car'&&+yr!==+per)continue;var s=y[yr];for(var k in s)z[k]=(z[k]||0)+s[k];}
  var od=(z.ab||0)+(z.bb||0)+(z.hbp||0)+(z.sf||0);
  z.avg=z.ab?(z.h||0)/z.ab:0;
  z.obp=od?((z.h||0)+(z.bb||0)+(z.hbp||0))/od:0;
  z.slg=z.ab?((z.h||0)+(z.doubles||0)+2*(z.triples||0)+3*(z.hr||0))/z.ab:0;
  z.ops=z.obp+z.slg;
  z.ip=(z.pOuts||0)/3;
  z.era=z.ip?(z.pER||0)*REGINN/z.ip:0;
  z.whip=z.ip?((z.pBB||0)+(z.pH||0))/z.ip:0;
  return z;
}
function rrect(x,X,Y,W,H,R){x.beginPath();x.moveTo(X+R,Y);x.arcTo(X+W,Y,X+W,Y+H,R);x.arcTo(X+W,Y+H,X,Y+H,R);x.arcTo(X,Y+H,X,Y,R);x.arcTo(X,Y,X+W,Y,R);x.closePath();}
function cf3(n){return n?(''+n.toFixed(3)).replace(/^0/,''):'.000';}
function makeCard(pid){
  var d=PSTATS[pid];if(!d)return;
  var per=curYear==='car'?'car':curYear;
  var s=cardSum(pid,per)||{};
  var cv=document.createElement('canvas');cv.width=800;cv.height=1120;
  var x=cv.getContext('2d');
  var col=d.col||'#1e3a5f';
  // fondo: degradado del color del equipo a oscuro
  var g=x.createLinearGradient(0,0,0,1120);
  g.addColorStop(0,col);g.addColorStop(0.62,'#101c30');g.addColorStop(1,'#0a1120');
  x.fillStyle=g;x.fillRect(0,0,800,1120);
  // franjas sutiles
  x.fillStyle='rgba(255,255,255,.05)';
  for(var i=0;i<8;i++){x.save();x.translate(i*140-140,0);x.transform(1,0,-0.35,1,0,0);x.fillRect(0,0,46,1120);x.restore();}
  // banda superior
  x.fillStyle='rgba(0,0,0,.4)';x.fillRect(0,0,800,88);
  x.fillStyle='#fff';x.font='800 34px system-ui,sans-serif';x.textAlign='center';
  x.fillText(LEAGUE.toUpperCase(),400,56);
  x.fillStyle='rgba(255,255,255,.8)';x.font='600 22px system-ui';
  x.fillText(per==='car'?'CARRERA':'TEMPORADA '+per,400,84);
  // marco y foto (o iniciales)
  x.fillStyle='#fff';rrect(x,140,120,520,500,20);x.fill();
  var img=document.getElementById('ph-'+pid);
  x.save();rrect(x,160,140,480,460,14);x.clip();
  if(img&&img.naturalWidth){
    var iw=img.naturalWidth,ih=img.naturalHeight,sc=Math.max(480/iw,460/ih);
    var dw=iw*sc,dh=ih*sc;
    x.drawImage(img,160+(480-dw)/2,140+(460-dh)/2,dw,dh);
  }else{
    x.fillStyle='#94a3b8';x.fillRect(160,140,480,460);
    var ini=(d.n||'?').replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ ]/g,'').trim().split(/\s+/);
    var ii=((ini[0]||'?').charAt(0)+(ini.length>1?ini[ini.length-1].charAt(0):'')).toUpperCase();
    x.fillStyle='#1e3a5f';x.font='800 200px system-ui';
    x.fillText(ii,400,430);
    x.fillStyle='rgba(30,58,95,.55)';x.font='700 26px system-ui';x.fillText('SIN FOTO',400,575);
  }
  x.restore();
  // nombre (auto-encoge si es largo)
  var nm=(d.n||'').toUpperCase(),fs=54;
  x.font='800 '+fs+'px system-ui';
  while(x.measureText(nm).width>740&&fs>30){fs-=3;x.font='800 '+fs+'px system-ui';}
  x.fillStyle='#fff';x.fillText(nm,400,686);
  // equipo · número · posición · B/T
  x.fillStyle='#ffd54d';x.font='700 28px system-ui';
  var sub=(d.t||'')+(d.no?'  ·  #'+d.no:'')+(d.pos?'  ·  '+d.pos:'')+(d.bt?'  ·  B/T '+d.bt:'');
  x.fillText(sub,400,730);
  // cajas de números: bateo (y pitcheo si lanzó)
  function statBoxes(list,y0){
    var n=list.length,w=Math.min(150,(740-(n-1)*14)/n),x0=(800-(w*n+(n-1)*14))/2;
    for(var i=0;i<n;i++){
      var bx=x0+i*(w+14);
      x.fillStyle='rgba(255,255,255,.09)';rrect(x,bx,y0,w,120,14);x.fill();
      x.strokeStyle='rgba(255,255,255,.25)';x.lineWidth=1.5;rrect(x,bx,y0,w,120,14);x.stroke();
      x.fillStyle='#9fb4d0';x.font='700 22px system-ui';x.fillText(list[i][0],bx+w/2,y0+40);
      x.fillStyle='#fff';x.font='800 40px system-ui';x.fillText(list[i][1],bx+w/2,y0+92);
    }
  }
  var batBoxes=[['AVG',cf3(s.avg)],['OPS',cf3(s.ops)],['HR',String(s.hr||0)],['CI',String(s.rbi||0)],['BR',String(s.sb||0)]];
  statBoxes(batBoxes,780);
  if((s.pOuts||0)>0){
    var pitBoxes=[['G-P',(s.pW||0)+'-'+(s.pL||0)],['ERA',(s.era||0).toFixed(2)],['WHIP',(s.whip||0).toFixed(2)],['K',String(s.pK||0)],['JS',String(s.pSV||0)]];
    statBoxes(pitBoxes,920);
    x.fillStyle='#9fb4d0';x.font='700 22px system-ui';x.fillText('PITCHEO',400,910);
  }
  // pie
  x.fillStyle='rgba(0,0,0,.4)';x.fillRect(0,1060,800,60);
  x.fillStyle='rgba(255,255,255,.75)';x.font='600 22px system-ui';
  x.fillText('Generado en PoxScore · Alexis Lara · 2026',400,1098);
  // descargar
  var a=document.createElement('a');
  a.download='card-'+(d.n||'jugador').toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.png';
  a.href=cv.toDataURL('image/png');a.click();
}
addEventListener('hashchange',route); route();
</script>
</body></html>`;
  return html;
}
