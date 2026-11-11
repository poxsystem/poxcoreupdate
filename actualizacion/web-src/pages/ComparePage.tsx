import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, PlayerFull, PlayerSearchHit, SeasonStat } from '../api';

function SearchSlot({ label, onPick }: { label: string; onPick: (p: PlayerSearchHit) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PlayerSearchHit[]>([]);
  const t = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    clearTimeout(t.current);
    t.current = setTimeout(() => api.searchPlayers(q).then(setHits).catch(() => {}), 250);
  }, [q]);
  return (
    <div className="cmp-search">
      <label><b>{label}</b>
        <input placeholder="Nombre del jugador…" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {hits.length > 0 && (
        <ul className="cmp-hits">
          {hits.map((h) => (
            <li key={h.id} onClick={() => { onPick(h); setHits([]); setQ(`${h.firstName} ${h.lastName}`); }}>
              <b>{h.firstName} {h.lastName}</b> <span className="muted">{h.team} · {h.league}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const F = (n: number | undefined | null, dec = 3) =>
  n == null ? '—' : (dec === 0 ? String(n) : (n as number).toFixed(dec).replace(/^0/, ''));

function batRow(s: SeasonStat | undefined) {
  if (!s) return null;
  const ab = s.ab ?? 0, h = s.h ?? 0, bb = s.bb ?? 0, hbp = s.hbp ?? 0, sf = s.sf ?? 0;
  const avg = ab ? h / ab : 0;
  const obp = ab + bb + hbp + sf ? (h + bb + hbp) / (ab + bb + hbp + sf) : 0;
  const tb = h + (s.doubles ?? 0) + 2 * (s.triples ?? 0) + 3 * (s.hr ?? 0);
  const slg = ab ? tb / ab : 0;
  return { g: s.g, pa: s.pa, ab, h, avg, obp, slg, ops: obp + slg, r: s.r, doubles: s.doubles, triples: s.triples, hr: s.hr, rbi: s.rbi, bb, k: s.k, sb: s.sb };
}

/** Comparador cara a cara de dos jugadores — carrera completa o un año específico. */
export default function ComparePage() {
  const [a, setA] = useState<PlayerFull | null>(null);
  const [b, setB] = useState<PlayerFull | null>(null);
  const [pickA, setPickA] = useState<PlayerSearchHit | null>(null);
  const [pickB, setPickB] = useState<PlayerSearchHit | null>(null);
  const [year, setYear] = useState<number | 'career'>('career');

  useEffect(() => { pickA && api.playerFull(pickA.id).then(setA).catch(() => {}); }, [pickA]);
  useEffect(() => { pickB && api.playerFull(pickB.id).then(setB).catch(() => {}); }, [pickB]);

  // años disponibles = unión de las temporadas de ambos jugadores
  const years = [...new Set([...(a?.seasons ?? []), ...(b?.seasons ?? [])].map((s) => s.season))].sort((x, y) => y - x);

  // carrera = suma de todas las temporadas REG+POST; año = solo las de ese año
  const sumSeasons = (p: PlayerFull | null): SeasonStat => {
    const z = { season: 0 } as unknown as SeasonStat;
    const zn = z as unknown as Record<string, number>;
    for (const s of p?.seasons ?? []) {
      if (year !== 'career' && s.season !== year) continue;
      for (const [k, v] of Object.entries(s)) {
        if (typeof v === 'number' && k !== 'season') zn[k] = (zn[k] ?? 0) + v;
      }
    }
    return z;
  };
  const sa = batRow(sumSeasons(a)), sb = batRow(sumSeasons(b));
  const wins = (av?: number | null, bv?: number | null) =>
    av == null || bv == null ? '' : av > bv ? ' a-w' : av < bv ? ' b-w' : '';

  const BAT: [string, (s: ReturnType<typeof batRow>) => number | null | undefined, number?][] = [
    ['JJ', (s) => s?.g, 0], ['VB', (s) => s?.ab, 0], ['CA', (s) => s?.r, 0], ['H', (s) => s?.h, 0],
    ['2B', (s) => s?.doubles, 0], ['3B', (s) => s?.triples, 0], ['HR', (s) => s?.hr, 0],
    ['CI', (s) => s?.rbi, 0], ['BB', (s) => s?.bb, 0], ['SO', (s) => s?.k, 0], ['BR', (s) => s?.sb, 0],
    ['AVG', (s) => s?.avg], ['OBP', (s) => s?.obp], ['SLG', (s) => s?.slg], ['OPS', (s) => s?.ops],
  ];

  return (
    <div>
      <h1>⚖️ Comparar jugadores</h1>
      <div className="cmp-grid">
        <SearchSlot label="Jugador A" onPick={setPickA} />
        <SearchSlot label="Jugador B" onPick={setPickB} />
      </div>
      {a && b && (
        <div className="card cmp-card">
          <div className="cmp-period">
            <label>Período:&nbsp;
              <select value={year} onChange={(e) => setYear(e.target.value === 'career' ? 'career' : Number(e.target.value))}>
                <option value="career">Carrera (todas las temporadas)</option>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
          </div>
          <table className="cmp-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'right' }}><Link to={`/players/${a.player.id}`}>{a.player.firstName} {a.player.lastName}</Link></th>
                <th></th>
                <th style={{ textAlign: 'left' }}><Link to={`/players/${b.player.id}`}>{b.player.firstName} {b.player.lastName}</Link></th>
              </tr>
            </thead>
            <tbody>
              {BAT.map(([lbl, fn, dec]) => {
                const va = fn(sa), vb = fn(sb);
                const hi = Math.max(va ?? 0, vb ?? 0);
                const pa = hi ? Math.max(6, Math.round(((va ?? 0) / hi) * 100)) : 0;
                const pb = hi ? Math.max(6, Math.round(((vb ?? 0) / hi) * 100)) : 0;
                const winCls = wins(va, vb);
                return (
                  <tr key={lbl} className={winCls}>
                    <td className="cmp-a">
                      <span className="cmp-num">{F(va, dec ?? 3)}</span>
                      <span className="cmp-bar cmp-bar-a" style={{ width: `${pa}%` }} />
                    </td>
                    <td className="cmp-l">{lbl}</td>
                    <td className="cmp-b">
                      <span className="cmp-bar cmp-bar-b" style={{ width: `${pb}%` }} />
                      <span className="cmp-num">{F(vb, dec ?? 3)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted">La barra verde marca quién gana cada categoría{year !== 'career' ? ` en ${year}` : ' en su carrera'}.</p>
        </div>
      )}
      {(!a || !b) && <p className="muted">Elige los dos jugadores para compararlos — por carrera o por año.</p>}
    </div>
  );
}
