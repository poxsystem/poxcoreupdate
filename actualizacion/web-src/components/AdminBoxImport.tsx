import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type BoxPlayerPreview, type BoxPreview, type Team } from '../api';
import AdminZipTotals from './AdminZipTotals';

interface Props { leagueId: string; teams: Team[] }

const ipTxt = (outs?: number) => (outs == null ? '—' : `${Math.floor(outs / 3)}.${outs % 3}`);

/** Resume los números de una fila parseada según su sección. */
function statTxt(p: BoxPlayerPreview): string {
  const s = p.stats;
  if (p.section === 'bat') return `VB ${s.ab ?? 0} · C ${s.r ?? 0} · H ${s.h ?? 0} · CI ${s.rbi ?? 0}${s.hr ? ` · HR ${s.hr}` : ''}${s.k ? ` · K ${s.k}` : ''}`;
  if (p.section === 'pit') return `IP ${ipTxt(s.pOuts)} · H ${s.pH ?? 0} · CL ${s.pR ?? 0} · CP ${s.pER ?? 0} · BB ${s.pBB ?? 0} · K ${s.pK ?? 0}`;
  return `PO ${s.po ?? 0} · A ${s.a ?? 0} · E ${s.e ?? 0}`;
}

const SEC_LABEL = { bat: 'Bateo', pit: 'Pitcheo', fld: 'Fildeo' } as const;

interface BatchItem {
  name: string;
  data: string;
  prev?: BoxPreview;          // resultado del dry-run
  parseErr?: string;          // el server no lo reconoció
  ov: Record<string, string>; // overrides por clave equipo|nombre
  newNames: Record<string, string>; // clave → nombre completo al CREAR (el box solo trae apellido)
  teamSel: { away: string; home: string };
  checked: boolean;           // entra en la importación por lotes
  status: 'pending' | 'ready' | 'imported' | 'error' | 'skipped';
  result?: string;            // gameId o mensaje de error
}

/** Importa juegos desde .box.txt de BallScore — uno o varios por lote,
 *  con match inteligente de nombres y revisión individual. */
export default function AdminBoxImport({ leagueId, teams }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'games' | 'zip'>('games'); // juegos sueltos | totales desde ZIP
  const [items, setItems] = useState<BatchItem[]>([]);
  const [active, setActive] = useState(-1); // índice del archivo en revisión detallada
  const [searchKey, setSearchKey] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // aprendizaje por lote: un pick manual se aplica a todas las filas con el
  // mismo (equipo del archivo + nombre del archivo) en los demás .box.txt —
  // como los txt solo traen apellido, "RAMOS → Willy Ramos" se resuelve UNA vez
  const learned = useRef(new Map<string, string>());
  const nrm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const normKey = (p: BoxPlayerPreview) => `${nrm(p.teamFile)}|${nrm(p.file)}`;
  // nombres completos aprendidos por lote: escribes «Willy Ramos» una vez y
  // los demás .box.txt del lote crean «RAMOS» con ese nombre completo
  const learnedNames = useRef(new Map<string, string>());
  const pick = (p: BoxPlayerPreview, val: string) => {
    const nk = normKey(p);
    if (val !== 'NEW' && val !== 'SKIP') learned.current.set(nk, val); else learned.current.delete(nk);
    setItems((cur) => cur.map((it) => {
      if (!it.prev) return it;
      let changed = false;
      const ov = { ...it.ov };
      for (const pl of it.prev.players) if (normKey(pl) === nk && ov[pl.key] !== val) { ov[pl.key] = val; changed = true; }
      return changed ? { ...it, ov } : it;
    }));
  };
  const pickName = (p: BoxPlayerPreview, full: string) => {
    const nk = normKey(p);
    if (full.trim()) learnedNames.current.set(nk, full); else learnedNames.current.delete(nk);
    setItems((cur) => cur.map((it) => {
      if (!it.prev) return it;
      let changed = false;
      const newNames = { ...it.newNames };
      for (const pl of it.prev.players) if (normKey(pl) === nk && newNames[pl.key] !== full) { newNames[pl.key] = full; changed = true; }
      return changed ? { ...it, newNames } : it;
    }));
  };

  const readFiles = async (list: FileList) => {
    setErr('');
    const nuevos: BatchItem[] = [];
    for (const f of Array.from(list)) {
      const buf = await f.arrayBuffer();
      // Los .box.txt de BallScore vienen en Windows-1252 (Latin-1) — UTF-8
      // estricto primero y fallback 1252 para los acentos.
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch { text = new TextDecoder('windows-1252').decode(buf); }
      nuevos.push({ name: f.name, data: text, ov: {}, newNames: {}, teamSel: { away: '', home: '' }, checked: true, status: 'pending' });
    }
    setItems((cur) => {
      const have = new Set(cur.map((i) => i.name));
      return [...cur, ...nuevos.filter((n) => !have.has(n.name))];
    });
  };

  const setItem = (i: number, patch: Partial<BatchItem>) =>
    setItems((cur) => cur.map((it, ix) => (ix === i ? { ...it, ...patch } : it)));

  const analyze = async () => {
    setBusy(true); setErr('');
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.prev || it.status === 'imported') continue;
      try {
        const p = await api.boxscorePreview({ leagueId, name: it.name, data: it.data });
        const ov: Record<string, string> = {};
        const newNames: Record<string, string> = {};
        for (const pl of p.players) {
          ov[pl.key] = learned.current.get(normKey(pl)) ?? (pl.action === 'skip' ? 'SKIP' : (pl.matchId ?? 'NEW'));
          const nn = learnedNames.current.get(normKey(pl));
          if (nn) newNames[pl.key] = nn;
        }
        setItem(i, {
          prev: p, ov, newNames,
          teamSel: { away: p.awayTeam.teamId ?? '', home: p.homeTeam.teamId ?? '' },
          status: 'ready',
          checked: !p.dupGameId, // duplicado probable → desmarcado por defecto
        });
      } catch (e) {
        setItem(i, { parseErr: e instanceof Error ? e.message : String(e), status: 'error', checked: false });
      }
    }
    setBusy(false);
  };

  const applyOne = async (i: number): Promise<boolean> => {
    const it = items[i];
    if (!it?.prev) return false;
    if (!it.teamSel.away || !it.teamSel.home) { setItem(i, { status: 'error', result: 'Faltan los dos equipos' }); return false; }
    try {
      const r = await api.boxscoreImport({
        leagueId, name: it.name, data: it.data,
        awayTeamId: it.teamSel.away, homeTeamId: it.teamSel.home, overrides: it.ov, newNames: it.newNames,
      });
      setItem(i, { status: 'imported', result: r.gameId, checked: false });
      return true;
    } catch (e) {
      setItem(i, { status: 'error', result: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  const applyAll = async () => {
    setBusy(true); setErr('');
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.checked || it.status !== 'ready') continue;
      await applyOne(i); // secuencial — el resumen queda por archivo
    }
    setBusy(false);
  };

  const removeItem = (i: number) => {
    setItems((cur) => cur.filter((_, ix) => ix !== i));
    if (active === i) setActive(-1);
    else if (active > i) setActive(active - 1);
  };

  const cur = items[active];
  const prev = cur?.prev ?? null;
  const pendientes = items.filter((i) => i.status === 'pending').length;
  const listos = items.filter((i) => i.checked && i.status === 'ready').length;

  // jugadores únicos por clave (cada uno puede tener fila bat+pit+fld)
  const uniq = new Map<string, BoxPlayerPreview[]>();
  for (const p of prev?.players ?? []) {
    const arr = uniq.get(p.key) ?? [];
    arr.push(p); uniq.set(p.key, arr);
  }
  const groups = [...uniq.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="card">
      <h3>📥 Importar desde box score BallScore</h3>
      <div className="ge-row" style={{ marginBottom: '0.8rem' }}>
        <button className={mode === 'games' ? 'icon ok' : 'secondary icon'} onClick={() => setMode('games')}>📄 Juegos (.txt)</button>
        <button className={mode === 'zip' ? 'icon ok' : 'secondary icon'} onClick={() => setMode('zip')}>📦 Totales desde ZIP</button>
      </div>
      {mode === 'zip' && <AdminZipTotals leagueId={leagueId} teams={teams} />}
      {mode === 'games' && (<>

      <p className="muted">
        Sube uno o varios <code>.box.txt</code> — se leen marcador, líneas de bateo/pitcheo/fildeo
        y decisiones, y cada nombre se cruza con el roster («LARA, Pedro» ↔ «Pedro Lara»),
        incluidos traspasados que hoy estén en otro equipo. Los que no existan puedes crearlos u omitirlos.
      </p>
      <div className="ge-row" style={{ marginBottom: '0.8rem' }}>
        <input ref={fileRef} type="file" accept=".txt,.box.txt" multiple style={{ display: 'none' }}
          onChange={(e) => { if (e.target.files?.length) void readFiles(e.target.files); e.target.value = ''; }} />
        <button className="secondary icon" onClick={() => fileRef.current?.click()}>📄 Elegir .box.txt (varios)</button>
        <button className="icon ok" disabled={!pendientes || busy} onClick={() => void analyze()}>
          🔍 Analizar{pendientes ? ` ${pendientes}` : ''}
        </button>
        {!!items.length && <button className="secondary icon" onClick={() => { setItems([]); setActive(-1); }}>� Limpiar lista</button>}
      </div>
      {err && <div className="passerr" style={{ margin: '8px 0' }}>⚠️ {err}</div>}

      {!!items.length && (
        <table className="admin-table ge-table" style={{ marginBottom: '0.8rem' }}>
          <thead><tr><th></th><th>Archivo</th><th>Juego</th><th>Match</th><th>Estado</th><th></th></tr></thead>
          <tbody>
            {items.map((it, i) => {
              const rows = it.prev?.players ?? [];
              const auto = rows.filter((r) => r.action === 'auto').length;
              const news = Object.values(it.ov).filter((v) => v === 'NEW').length;
              const moved = rows.filter((r) => r.moved).length;
              return (
                <tr key={it.name}>
                  <td><input type="checkbox" checked={it.checked} disabled={it.status === 'imported'}
                    onChange={(e) => setItem(i, { checked: e.target.checked })} /></td>
                  <td className="muted" style={{ fontSize: '0.82rem' }}>{it.name}</td>
                  <td>
                    {it.prev
                      ? <><b>{it.prev.box.away} {it.prev.box.scoreAway} — {it.prev.box.scoreHome} {it.prev.box.home}</b>
                          <div className="muted" style={{ fontSize: '0.78rem' }}>{it.prev.box.dateIso} · {it.prev.box.innings || '?'} ent.</div></>
                      : <span className="muted">{it.parseErr ?? 'sin analizar'}</span>}
                  </td>
                  <td className="muted" style={{ fontSize: '0.82rem' }}>
                    {it.prev && <>{auto} auto{news ? ` · ${news} nuevos` : ''}{moved ? ` · ⚠ ${moved} traspasados` : ''}</>}
                    {it.prev?.dupGameId && <div className="passerr" style={{ margin: 0 }}>⚠ ya existe</div>}
                  </td>
                  <td>
                    {it.status === 'pending' && <span className="muted">pendiente</span>}
                    {it.status === 'ready' && <span style={{ color: 'var(--green)' }}>lista</span>}
                    {it.status === 'imported' && <Link to={`/games/${it.result}`} style={{ color: 'var(--green)' }}>✓ importado</Link>}
                    {it.status === 'error' && <span className="passerr" style={{ margin: 0 }}>✗ {it.result ?? it.parseErr}</span>}
                  </td>
                  <td>
                    {it.prev && it.status !== 'imported' && (
                      <button className="secondary icon" onClick={() => { setActive(active === i ? -1 : i); setSearchKey(null); }}>
                        {active === i ? '▲ cerrar' : '🔍 revisar'}
                      </button>
                    )}
                    {it.status !== 'imported' && <button className="icon" title="quitar" onClick={() => removeItem(i)}>✕</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {!!listos && (
        <div className="ge-row" style={{ marginBottom: '0.8rem' }}>
          <button className="icon ok" disabled={busy} onClick={() => void applyAll()}>
            ✓ Importar {listos} juego{listos === 1 ? '' : 's'} marcados
          </button>
        </div>
      )}

      {prev && cur && (
        <>
          <div className="ge-row" style={{ marginBottom: '0.6rem' }}>
            <label>Visita ({prev.box.away || '?'})
              <select value={cur.teamSel.away} onChange={(e) => setItem(active, { teamSel: { ...cur.teamSel, away: e.target.value } })}>
                <option value="">— elegir —</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <b>{prev.box.scoreAway} — {prev.box.scoreHome}</b>
            <label>Local ({prev.box.home || '?'})
              <select value={cur.teamSel.home} onChange={(e) => setItem(active, { teamSel: { ...cur.teamSel, home: e.target.value } })}>
                <option value="">— elegir —</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <span className="muted">{prev.box.dateIso || 'sin fecha'} · {prev.box.innings || '?'} ent.</span>
          </div>
          {prev.dupGameId && <div className="passerr" style={{ margin: '6px 0' }}>⚠️ Ya existe un juego con ese marcador esa fecha — <Link to={`/games/${prev.dupGameId}`}>ver</Link></div>}
          {!!prev.warnings.length && <p className="muted">⚠️ {prev.warnings.join(' · ')}</p>}
          {(prev.box.wp || prev.box.lp || prev.box.sv) && (
            <p className="muted">Decisiones: {prev.box.wp ? `G: ${prev.box.wp} · ` : ''}{prev.box.lp ? `P: ${prev.box.lp} · ` : ''}{prev.box.sv ? `JS: ${prev.box.sv}` : ''}</p>
          )}

          <table className="admin-table ge-table">
            <thead>
              <tr><th>En el archivo</th><th>Equipo</th><th>Sección</th><th>Stats</th><th>→ En el sistema</th></tr>
            </thead>
            <tbody>
              {groups.map(([key, rows]) => {
                const p = rows[0];
                const val = cur.ov[key] ?? 'NEW';
                return (
                  <tr key={key} className={val === 'NEW' ? 'ge-dirty' : ''}>
                    <td>
                      <b>{p.file}</b>{p.pos ? <span className="muted"> · {p.pos}</span> : ''}{p.dec ? <b className="muted"> ({p.dec})</b> : null}
                      {p.noName && <div className="passerr" style={{ margin: '2px 0 0', fontSize: '0.75rem' }}>⚠ el archivo solo trajo la posición — elige el jugador u omite</div>}
                      {p.partial && <div style={{ color: '#d9a', fontSize: '0.75rem' }}>⚠ solo en las notas del box — asígnale jugador</div>}
                      {p.ambiguous && <div className="passerr" style={{ margin: '2px 0 0', fontSize: '0.75rem' }}>⚠ apellido ambiguo — hay {p.candidates.length} coincidencias, confirma a mano</div>}
                    </td>
                    <td className="muted">{p.teamFile || '—'}</td>
                    <td className="muted">{rows.map((r) => SEC_LABEL[r.section]).join(' + ')}</td>
                    <td className="muted" style={{ fontSize: '0.8rem' }}>{rows.map((r) => statTxt(r)).join(' | ')}</td>
                    <td>
                      <div className="ge-row" style={{ gap: '0.3rem' }}>
                        <select value={val} onChange={(e) => pick(p, e.target.value)}>
                          {p.candidates.map((c) => (
                            <option key={c.playerId} value={c.playerId}>
                              {c.name}{c.team ? ` · ${c.team}` : ''} {c.score >= 85 ? '✓' : `~${c.score}%`}
                            </option>
                          ))}
                          {p.matchId && !p.candidates.some((c) => c.playerId === p.matchId) && (
                            <option value={p.matchId}>{p.matchName}{p.matchTeam ? ` · ${p.matchTeam}` : ''}</option>
                          )}
                          {val !== 'NEW' && val !== 'SKIP' && val !== p.matchId
                            && !p.candidates.some((c) => c.playerId === val) && (() => {
                              const pl = prev.roster?.find((r) => r.id === val);
                              return <option value={val}>{pl ? `${pl.name} · ${pl.team}` : val}</option>;
                            })()}
                          <option value="NEW">➕ Crear jugador nuevo</option>
                          <option value="SKIP">🚫 Omitir</option>
                        </select>
                        <button className="icon" title="Buscar en toda la liga" onClick={() => { setSearchKey(searchKey === key ? null : key); setQ(''); }}>🔎</button>
                      </div>
                      {val === 'NEW' && (
                        <input style={{ marginTop: 4, width: '100%', fontSize: '0.8rem' }}
                          placeholder={`Nombre completo (el archivo solo trae "${p.file}")`}
                          value={cur.newNames[key] ?? ''}
                          onChange={(e) => pickName(p, e.target.value)} />
                      )}
                      {p.moved && cur.ov[key] === p.matchId && (
                        <div className="passerr" style={{ margin: '4px 0 0', fontSize: '0.78rem' }}>
                          ⚠ hoy está en {p.matchTeam} — si es otro jugador, búscalo o créalo
                        </div>
                      )}
                      {searchKey === key && prev.roster && (
                        <div className="ge-find">
                          <input autoFocus placeholder="Buscar en toda la liga…" value={q}
                            onChange={(e) => setQ(e.target.value)} />
                          <div className="ge-find-list">
                            {prev.roster
                              .filter((pl) => !q || pl.name.toLowerCase().includes(q.toLowerCase()) || pl.team.toLowerCase().includes(q.toLowerCase()))
                              .slice(0, 8)
                              .map((pl) => (
                                <button key={pl.id} className="ge-find-item" onClick={() => { pick(p, pl.id); setSearchKey(null); }}>
                                  {pl.name} <span className="muted">· {pl.team}</span>
                                </button>
                              ))}
                            {!prev.roster.filter((pl) => !q || pl.name.toLowerCase().includes(q.toLowerCase())).length && (
                              <span className="muted" style={{ padding: '4px 8px' }}>sin resultados</span>
                            )}
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!groups.length && <tr><td colSpan={5} className="muted">El archivo no trajo líneas de jugadores — solo se importará el marcador.</td></tr>}
            </tbody>
          </table>

          <div className="ge-row" style={{ marginTop: '0.7rem' }}>
            <button className="icon ok" disabled={busy || !cur.teamSel.away || !cur.teamSel.home}
              onClick={() => { void applyOne(active).then((ok) => { if (ok) setActive(-1); }); }}>
              ✓ Importar este juego
            </button>
            <span className="muted">
              {groups.length} jugadores · {Object.values(cur.ov).filter((v) => v === 'NEW').length} se crearán ·{' '}
              {Object.values(cur.ov).filter((v) => v === 'SKIP').length} omitidos
            </span>
          </div>
        </>
      )}
      </>)}
    </div>
  );
}
