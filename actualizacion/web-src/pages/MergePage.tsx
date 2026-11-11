import { useEffect, useMemo, useState } from 'react';
import { api, League, PlayerListItem } from '../api';

/** Buscador de jugador: filtra la lista por nombre/equipo. */
function PlayerPicker({ label, value, onPick, excludeId, players }: {
  label: string; value: PlayerListItem | null; onPick: (p: PlayerListItem | null) => void;
  excludeId?: string; players: PlayerListItem[];
}) {
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    return players.filter((p) => p.id !== excludeId && p.label.toLowerCase().includes(s)).slice(0, 8);
  }, [q, players, excludeId]);

  return (
    <div className="card" style={{ flex: 1, minWidth: 240 }}>
      <h3 style={{ marginTop: 0 }}>{label}</h3>
      {value ? (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <strong>{value.label} <span className="muted">· {value.team}</span></strong>
          <button className="secondary" onClick={() => onPick(null)}>cambiar</button>
        </div>
      ) : (
        <>
          <input placeholder="Escribe el nombre…" value={q} onChange={(e) => setQ(e.target.value)} />
          {matches.map((p) => (
            <div key={p.id} className="pickrow" onClick={() => onPick(p)}>
              {p.label} <span className="muted">· {p.team}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** clave de duplicado: nombre sin número, minúsculas, sin acentos.
 *  "CMB" es etiqueta del usuario (jugador cambiado) — se ignora para que
 *  "Cmb Edison Gonzalez" agrupe con "Edison Gonzalez". */
const normName = (label: string) =>
  label.replace(/^#\d+\s+/, '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/\s+/).filter((t) => t !== 'cmb').join(' ').trim();

/** distancia de edición (para errores de digitación: Soto/Sotto, Lachapell/Lachapel) */
const lev = (a: string, b: string) => {
  const d: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
};

/** ¿Qué tan parecido es un nombre a otro? Devuelve la razón o ''. */
const simReason = (a: PlayerListItem, b: PlayerListItem, ka: string, kb: string): string => {
  if (!ka || !kb || ka === kb) return '';
  const ta = ka.split(/\s+/), tb = kb.split(/\s+/);
  const firstA = ta[0], firstB = tb[0];
  const lastA = ta[ta.length - 1], lastB = tb[tb.length - 1];
  if (lev(ka, kb) <= 2) return 'nombre casi igual';
  if (firstA === firstB && a.teamId && a.teamId === b.teamId) return `mismo nombre (${firstA}) en el mismo equipo`;
  if (lastA === lastB && firstA[0] === firstB[0] && a.teamId === b.teamId) return `mismo apellido (${lastA}) en el mismo equipo`;
  return '';
};

export default function MergePage() {
  const [players, setPlayers] = useState<PlayerListItem[]>([]);
  const [leagues, setLeagues] = useState<League[]>([]);
  const [leagueId, setLeagueId] = useState('');
  const [bye, setBye] = useState<PlayerListItem | null>(null);
  const [stay, setStay] = useState<PlayerListItem | null>(null);
  const [groupKey, setGroupKey] = useState<string | null>(null); // fusión por lotes abierta
  const [batchStay, setBatchStay] = useState('');
  const [batchByes, setBatchByes] = useState<Set<string>>(new Set());
  // "Fundir en esta ficha": se elige primero el jugador que QUEDA (la ficha
  // vigente) y debajo se tachan en lote sus parecidos + los dados de baja.
  const [target, setTarget] = useState<PlayerListItem | null>(null);
  const [intoByes, setIntoByes] = useState<Set<string>>(new Set());
  const [intoQ, setIntoQ] = useState(''); // buscador extra para nombres distintos
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api.playerList().then(setPlayers).catch((e) => setErr(e.message));
    api.leagues().then(setLeagues).catch(() => {});
  }, []);

  // solo jugadores de la liga administrada (o todos si no se elige)
  const filtered = useMemo(
    () => (leagueId ? players.filter((p) => p.leagueId === leagueId) : players),
    [players, leagueId],
  );

  // grupos de fichas con el mismo nombre dentro de la liga — candidatos a fusión por lotes
  const dupGroups = useMemo(() => {
    const m = new Map<string, PlayerListItem[]>();
    for (const p of filtered) {
      const k = normName(p.label);
      if (!k) continue;
      (m.get(k) ?? m.set(k, []).get(k)!).push(p);
    }
    return [...m.entries()].filter(([, v]) => v.length > 1)
      .map(([k, v]) => ({ key: k, items: v.slice().sort((a, b) => a.team.localeCompare(b.team)) }));
  }, [filtered]);

  // pares de fichas con nombres DISTINTOS pero parecidos — típico error de
  // digitación o apellido confundido (ej. "Angel Soto" vs "Angel Lachapell",
  // misma persona, mismo nombre de pila y mismo equipo). Al elegir un par se
  // pre-llenan los dos buscadores de la fusión manual.
  const simPairs = useMemo(() => {
    const out: { a: PlayerListItem; b: PlayerListItem; why: string }[] = [];
    const seen = new Set<string>();
    const keys = filtered.map((p) => normName(p.label));
    for (let i = 0; i < filtered.length; i++) {
      for (let j = i + 1; j < filtered.length; j++) {
        const A = filtered[i], B = filtered[j];
        const why = simReason(A, B, keys[i], keys[j]);
        if (!why) continue;
        const pairKey = [A.id, B.id].sort().join('|');
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        out.push({ a: A, b: B, why });
        if (out.length >= 30) return out;
      }
    }
    return out;
  }, [filtered]);

  // candidatos de "fundir en esta ficha": todo jugador de la liga (incluye
  // dados de baja) cuyo nombre se parece al de la ficha que queda.
  const intoCands = useMemo(() => {
    if (!target) return [];
    const kt = normName(target.label);
    return filtered.filter((p) => p.id !== target.id)
      .map((p) => ({ p, why: simReason(target, p, kt, normName(p.label)) }))
      .filter((c) => c.why)
      .slice(0, 30);
  }, [filtered, target]);

  // buscador extra: mismo jugador con nombre que NO se parece (ej. alias).
  const intoExtra = useMemo(() => {
    const s = intoQ.trim().toLowerCase();
    if (!target || s.length < 2) return [];
    const shown = new Set(intoCands.map((c) => c.p.id));
    return filtered.filter((p) => p.id !== target.id && !shown.has(p.id)
      && p.label.toLowerCase().includes(s)).slice(0, 8);
  }, [filtered, target, intoQ, intoCands]);

  const merge = async () => {
    if (!bye || !stay) return;
    if (!window.confirm(`¿Fusionar jugadores?\n\n"${bye.label}" se BORRARÁ y todo su historial\n(stats, eventos, lineups, decisiones) pasará a "${stay.label}".`)) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api.mergePlayers(bye.id, stay.id);
      const n = Object.entries(r.moved).map(([k, v]) => `${k}:${v}`).join(' · ');
      setMsg(`✔ "${r.eliminado}" fusionado en "${r.queda}" — ${n}`);
      setBye(null);
      setPlayers((ps) => ps.filter((p) => p.id !== bye.id));
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const openGroup = (key: string) => {
    setGroupKey(key === groupKey ? null : key);
    setBatchStay(''); setBatchByes(new Set());
  };

  const batchMerge = async () => {
    const g = dupGroups.find((d) => d.key === groupKey);
    if (!g || !batchStay || !batchByes.size) return;
    const stayP = g.items.find((p) => p.id === batchStay)!;
    const byes = g.items.filter((p) => batchByes.has(p.id));
    if (!window.confirm(
      `¿Fusionar ${byes.length} ficha(s) en "${stayP.label} · ${stayP.team}"?\n\n` +
      byes.map((b) => `• ${b.label} · ${b.team}  →  se borra y suma sus stats`).join('\n'),
    )) return;
    setBusy(true); setErr(''); setMsg('');
    const done: string[] = [];
    try {
      for (const b of byes) {
        const r = await api.mergePlayers(b.id, batchStay);
        done.push(`"${r.eliminado}" (${Object.values(r.moved).reduce((s, n) => s + n, 0)} movidos)`);
      }
      setMsg(`✔ Fusión por lotes: ${done.join(' · ')} → "${stayP.label} · ${stayP.team}"`);
      setPlayers((ps) => ps.filter((p) => !batchByes.has(p.id)));
      setGroupKey(null);
    } catch (e) { setErr(`${(e as Error).message} (fusionadas antes del error: ${done.length})`); }
    setBusy(false);
  };

  // fundir en lote HACIA la ficha elegida — la que queda siempre es `target`
  // (principio: la ficha vigente perdura con nombre, equipo y sus números).
  const mergeInto = async () => {
    if (!target || !intoByes.size) return;
    const byes = filtered.filter((p) => intoByes.has(p.id));
    if (!window.confirm(
      `¿Fusionar ${byes.length} ficha(s) en "${target.label} · ${target.team}"?\n\n` +
      `La ficha que QUEDA es la vigente — conserva nombre y equipo.\n` +
      byes.map((b) => `• ${b.label} · ${b.team}${b.active === false ? ' (baja)' : ''}  →  se borra y suma sus stats`).join('\n'),
    )) return;
    setBusy(true); setErr(''); setMsg('');
    const done: string[] = [];
    try {
      for (const b of byes) {
        const r = await api.mergePlayers(b.id, target.id);
        done.push(`"${r.eliminado}" (${Object.values(r.moved).reduce((s, n) => s + n, 0)} movidos)`);
      }
      setMsg(`✔ Fusionadas en "${target.label} · ${target.team}": ${done.join(' · ')}`);
      setPlayers((ps) => ps.filter((p) => !intoByes.has(p.id)));
      setIntoByes(new Set()); setIntoQ('');
    } catch (e) { setErr(`${(e as Error).message} (fusionadas antes del error: ${done.length})`); }
    setBusy(false);
  };

  const toggleInto = (id: string, on: boolean) => {
    const s = new Set(intoByes);
    on ? s.add(id) : s.delete(id);
    setIntoByes(s);
  };

  const group = dupGroups.find((d) => d.key === groupKey);

  const bajaBadge = (p: PlayerListItem) =>
    p.active === false
      ? <span className="pill" style={{ fontSize: '0.68rem', padding: '0 0.4rem', background: '#4a2c0a', color: '#fbbf24' }}>🛌 baja</span>
      : null;

  return (
    <div>
      <h1>🔀 Fusionar jugadores</h1>
      <p className="muted">
        Para duplicados (típico de ligas importadas sin refuerzos): las fichas que
        se borran suman todo su historial — estadísticas, jugadas, alineaciones y
        decisiones — a la ficha que queda. <strong>Solo dentro de la liga elegida.</strong>
      </p>

      <div className="card">
        <div className="row">
          <label>Liga que administras:&nbsp;</label>
          <select value={leagueId} onChange={(e) => { setLeagueId(e.target.value); setBye(null); setStay(null); setGroupKey(null); }}>
            <option value="">— elige la liga —</option>
            {leagues.map((l) => <option key={l.id} value={l.id}>{l.name}{l.year ? ` ${l.year}` : ''}</option>)}
          </select>
          {leagueId && <span className="muted">{filtered.length} jugadores en esta liga</span>}
        </div>
      </div>

      {leagueId && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Fusión por lotes — posibles duplicados en esta liga</h3>
          {!dupGroups.length && (
            <p className="muted" style={{ margin: 0 }}>
              ✔ No quedan fichas duplicadas en esta liga (mismo nombre en 2+ equipos o repetido en uno).
            </p>
          )}
          {simPairs.length > 0 && (
            <>
              <p className="muted" style={{ margin: '0.5rem 0 0.3rem' }}>
                <strong>Nombres parecidos</strong> — misma persona con otro nombre escrito (error de digitación o apellido confundido):
              </p>
              <table>
                <thead><tr><th>Ficha A</th><th>Ficha B</th><th>Por qué</th><th /></tr></thead>
                <tbody>
                  {simPairs.map((pr) => (
                    <tr key={pr.a.id + pr.b.id}>
                      <td><strong>{pr.a.label}</strong> <span className="muted">· {pr.a.team}</span></td>
                      <td><strong>{pr.b.label}</strong> <span className="muted">· {pr.b.team}</span></td>
                      <td className="muted">{pr.why}</td>
                      <td>
                        <button className="secondary" onClick={() => {
                          setBye(pr.b); setStay(pr.a);
                          document.getElementById('fusion-manual')?.scrollIntoView({ behavior: 'smooth' });
                        }}>
                          🔀 fusionar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {dupGroups.length > 0 && (
          <table>
            <thead><tr><th>Nombre</th><th>Fichas</th><th>Equipos</th><th /></tr></thead>
            <tbody>
              {dupGroups.map((g) => (
                <tr key={g.key}>
                  <td><strong>{g.items[0].label.replace(/^#\d+\s+/, '')}</strong></td>
                  <td>{g.items.length}</td>
                  <td className="muted">{g.items.map((p) => p.team).join(' · ')}</td>
                  <td>
                    <button className="secondary" onClick={() => openGroup(g.key)}>
                      {groupKey === g.key ? 'cerrar' : '🔀 fusión por lotes'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          )}

          {group && (
            <div className="card" style={{ background: 'var(--bg, #f6f8fa)', marginTop: 8 }}>
              <p><strong>Elige qué ficha QUEDA</strong> (las demás se borran y sus números se suman):</p>
              {group.items.map((p) => (
                <label key={p.id} className="row" style={{ display: 'flex', gap: 8, margin: '4px 0' }}>
                  <input type="radio" name="batchStay" checked={batchStay === p.id} onChange={() => setBatchStay(p.id)} />
                  <span style={{ minWidth: 260 }}>{p.label} <span className="muted">· {p.team}</span></span>
                  <input type="checkbox" disabled={batchStay === p.id}
                    checked={batchByes.has(p.id)}
                    onChange={(e) => {
                      const s = new Set(batchByes);
                      e.target.checked ? s.add(p.id) : s.delete(p.id);
                      setBatchByes(s);
                    }} />
                  <span className="muted">fusionar esta ficha</span>
                </label>
              ))}
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
                <button onClick={batchMerge} disabled={busy || !batchStay || batchByes.size === 0}>
                  {busy ? 'Fusionando…' : `🔀 Fusionar ${batchByes.size} ficha(s)`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---- Fundir HACIA una ficha vigente (incluye jugadores dados de baja) ---- */}
      {leagueId && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>🎯 Fundir en una ficha — la vigente queda, las demás se suman</h3>
          <p className="muted" style={{ margin: '0 0 0.5rem' }}>
            Elige la ficha actual (la que debe perdurar con su nombre, equipo y números).
            Abajo aparecen sus parecidos — <strong>incluidos los dados de baja</strong> —
            los tareas en lote y se funden en ella. También puedes buscar a mano al que
            sea el mismo aunque el nombre no se parezca.
          </p>
          <PlayerPicker label="✔ Ficha que QUEDA (el jugador vigente)" value={target}
            onPick={(p) => { setTarget(p); setIntoByes(new Set()); setIntoQ(''); }}
            players={filtered.filter((p) => p.active !== false)} />
          {target && (
            <>
              {intoCands.length > 0 && (
                <table style={{ marginTop: 10 }}>
                  <thead><tr><th /><th>Candidato</th><th>Por qué</th></tr></thead>
                  <tbody>
                    {intoCands.map(({ p, why }) => (
                      <tr key={p.id} style={{ opacity: p.active === false ? 0.75 : 1 }}>
                        <td>
                          <input type="checkbox" checked={intoByes.has(p.id)}
                            onChange={(e) => toggleInto(p.id, e.target.checked)} />
                        </td>
                        <td>
                          <strong>{p.label}</strong> <span className="muted">· {p.team}</span> {bajaBadge(p)}
                        </td>
                        <td className="muted">{why}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {!intoCands.length && (
                <p className="muted" style={{ margin: '0.5rem 0' }}>
                  No aparecen nombres parecidos — usa el buscador de abajo si es el mismo con otro nombre.
                </p>
              )}
              <div style={{ marginTop: 10 }}>
                <input placeholder="🔎 Buscar otro jugador (nombre distinto pero es el mismo)…"
                  value={intoQ} onChange={(e) => setIntoQ(e.target.value)} style={{ width: '100%', maxWidth: 460 }} />
                {intoExtra.map((p) => (
                  <div key={p.id} className="pickrow" onClick={() => { toggleInto(p.id, true); setIntoQ(''); }}>
                    ＋ {p.label} <span className="muted">· {p.team}</span> {bajaBadge(p)}
                    {intoByes.has(p.id) && <span style={{ color: 'var(--green)' }}> ✓ agregado</span>}
                  </div>
                ))}
              </div>
              {(() => {
                const chosen = filtered.filter((p) => intoByes.has(p.id) && !intoCands.some((c) => c.p.id === p.id));
                return chosen.length > 0 && (
                  <p className="muted" style={{ margin: '0.4rem 0 0' }}>
                    Agregados por búsqueda: {chosen.map((p) => `${p.label} · ${p.team}`).join(' | ')}
                  </p>
                );
              })()}
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
                <button onClick={mergeInto} disabled={busy || intoByes.size === 0}>
                  {busy ? 'Fusionando…' : `🔀 Fundir ${intoByes.size} ficha(s) en "${target.label.replace(/^#\d+\s+/, '')}"`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {err && <p className="pill sched">{err}</p>}
      {msg && <p className="pill" style={{ background: '#0a3d20', color: '#7ee2a8' }}>{msg}</p>}

      <h2 id="fusion-manual" style={{ fontSize: '1rem' }}>Fusión manual (dos jugadores — sirve aunque tengan nombres distintos)</h2>
      <div className="row" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <PlayerPicker label="❌ Jugador a eliminar" value={bye} onPick={setBye} excludeId={stay?.id} players={filtered} />
        <div style={{ fontSize: '1.6rem', paddingTop: 40 }}>→</div>
        <PlayerPicker label="✔ Jugador que se queda" value={stay} onPick={setStay} excludeId={bye?.id} players={filtered} />
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="muted">
            {bye && stay ? `"${bye.label}" → "${stay.label}"` : 'elige los dos jugadores'}
          </span>
          <button onClick={merge} disabled={!bye || !stay || busy}>
            {busy ? 'Fusionando…' : '🔀 Procesar fusión'}
          </button>
        </div>
      </div>
    </div>
  );
}
