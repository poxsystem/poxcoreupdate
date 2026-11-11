import { useEffect, useRef, useState } from 'react';

// búsqueda tolerante: "jhonny turby" encuentra "jonny turbi" — cada token de la
// consulta debe coincidir con algún token del nombre (prefijo, contiene, o a 1
// letra de distancia). Insensible a acentos.
const nz = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const lev1 = (a: string, b: string): boolean => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++d > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
};
const fuzzyMatch = (q: string, name: string): boolean => {
  const nts = nz(name).split(/\s+/).filter(Boolean);
  return nz(q).split(/\s+/).filter(Boolean)
    .every((qt) => nts.some((nt) => nt.startsWith(qt) || qt.startsWith(nt) || nt.includes(qt) || lev1(qt, nt)));
};
import { Link, useSearchParams } from 'react-router-dom';
import { api, AppendPreview, BackupLeagueInfo, ImportPreview, League } from '../api';

export default function LeaguesPage() {
  const [leagues, setLeagues] = useState<League[]>([]);
  const [name, setName] = useState('');
  const [sport, setSport] = useState<'baseball' | 'softball'>('baseball');
  const [error, setError] = useState('');
  const [imp, setImp] = useState<{ name: string; text: string; payload: { name: string; data: unknown; encoding?: string } } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [impBackup, setImpBackup] = useState(false);
  const [impBusy, setImpBusy] = useState(false);
  const [impErr, setImpErr] = useState('');
  const [appendTo, setAppendTo] = useState('');   // '' = nueva liga · id = agregar temporada a esa liga
  const [mergeSame, setMergeSame] = useState(true); // mismo nombre en varios equipos = una ficha
  const [replaceY, setReplaceY] = useState(false);  // si el año ya existe → sobreescribirla
  const [mergeY, setMergeY] = useState(false);      // si el año ya existe → sumar juegos sin borrar
  const [appendPrev, setAppendPrev] = useState<AppendPreview | null>(null); // sugerencias nombre→ficha
  const [aliasSel, setAliasSel] = useState<Record<string, string>>({});     // "nombre|equipo" → nombre canónico
  const [aliasSearch, setAliasSearch] = useState<Record<string, string>>({}); // búsqueda libre en el roster
  const [msg, setMsg] = useState('');
  const [delLg, setDelLg] = useState<League | null>(null);
  const [delPass, setDelPass] = useState('');
  const [delErr, setDelErr] = useState('');
  const [delBusy, setDelBusy] = useState(false);
  // 🕐 restaurar liga al estado de un respaldo automático
  const [restOpen, setRestOpen] = useState(false);
  const [restScan, setRestScan] = useState<(BackupLeagueInfo & { file: string; found: boolean })[]>([]);
  const [restFile, setRestFile] = useState('');
  const [restLg, setRestLg] = useState('');
  const [restPass, setRestPass] = useState('');
  const [restBusy, setRestBusy] = useState(false);
  const [restErr, setRestErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const [params] = useSearchParams();
  const preAppend = params.get('append') ?? ''; // /leagues?append=<id> → destino pre-elegido

  const load = () => api.leagues().then(setLeagues).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  // vino desde «📥 Temporada desde ZIP» en la página de una liga → abrir el
  // selector de archivo de una vez (la liga destino se pre-elige al analizar)
  useEffect(() => {
    if (preAppend) fileRef.current?.click();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preAppend]);

  // al elegir liga destino → re-analizar: qué nombres del archivo no existen
  // en esa liga y a quién podrían corresponder (el usuario decide a dónde van)
  const pickAppend = (leagueId: string) => {
    setAppendTo(leagueId);
    setAppendPrev(null);
    setAliasSel({});
    if (!imp || !leagueId || impBackup) return;
    void (async () => {
      try {
        const r = await api.importLeague({ ...imp.payload, appendToLeagueId: leagueId }, true);
        setAppendPrev(r.append ?? null);
        if (!r.append) setImpErr('la vista de sugerencias no llegó — el server puede estar viejo (reinicia PoxScore)');
      } catch (e) { setImpErr(`sugerencias: ${(e as Error).message}`); }
    })();
  };

  const pickFile = (f: File) => {
    const isBin = /\.(rar|zip)$/i.test(f.name);
    const rd = new FileReader();
    rd.onload = async () => {
      let payload: { name: string; data: unknown; encoding?: string };
      if (isBin) {
        // .rar/.zip de BallStat → base64 para el server (extrae y convierte)
        const b64 = String(rd.result ?? '').split(',')[1] ?? '';
        payload = { name: f.name, data: b64, encoding: 'base64' };
      } else {
        const text = String(rd.result ?? '');
        let data: unknown = text;
        try { data = JSON.parse(text); } catch { /* .sbk u otro texto — el server decide */ }
        payload = { name: f.name, data };
      }
      setImp({ name: f.name, text: isBin ? `${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)` : String(payload.data).slice(0, 300), payload });
      setPreview(null);
      setImpErr('');
      setAppendTo('');
      setMergeSame(true);
      setReplaceY(false);
      setMergeY(false);
      setImpBackup(false);
      setAppendPrev(null);
      setAliasSel({});
      setImpBusy(true);
      try {
        const r = await api.importLeague(payload, true);
        if (r.preview) setPreview(r.preview);
        if (r.backup) setImpBackup(true);
        if (preAppend) pickAppend(preAppend); // destino pre-elegido → sugerencias nombre→ficha de una vez
      } catch (e) { setImpErr((e as Error).message); } // el error se ve DENTRO del modal
      setImpBusy(false);
    };
    if (isBin) rd.readAsDataURL(f);
    else rd.readAsText(f);
  };

  const doImport = async () => {
    if (!imp) return;
    setImpBusy(true);
    setImpErr('');
    try {
      // aliases elegidos: "nombre|equipo" del archivo → ficha existente
      const playerAliases = Object.entries(aliasSel)
        .filter(([, to]) => to)
        .map(([k, to]) => {
          const [from, fromTeam] = k.split('||');
          return { from, fromTeam: fromTeam || undefined, to };
        });
      const r = await api.importLeague({
        ...imp.payload,
        appendToLeagueId: appendTo || undefined,
        mergeSameName: mergeSame,
        replaceSeason: replaceY,
        mergeSeason: mergeY,
        playerAliases: playerAliases.length ? playerAliases : undefined,
      });
      if (r.backup) {
        // respaldo completo: restaura tablas, no crea una sola liga
        const imp2 = r.imported ?? {};
        setImp(null);
        setMsg(`✅ Respaldo restaurado — ${imp2.leagues ?? 0} liga(s), ${imp2.teams ?? 0} equipos, ${imp2.players ?? 0} jugadores, ${imp2.games ?? 0} juegos`);
        load();
      } else if (r.leagueId) {
        if (r.appended && r.created) {
          setMsg(`✅ Temporada agregada — ${r.created.players} jugadores nuevos · ${r.created.playersReused} reutilizados · ${r.created.games} juegos`);
        }
        setImp(null);
        load();
        window.location.href = `/leagues/${r.leagueId}`;
      } else {
        setImpErr('la importación no devolvió liga');
      }
    } catch (e) { setImpErr((e as Error).message); }
    setImpBusy(false);
  };

  const doDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!delLg || !delPass) return;
    setDelBusy(true);
    setDelErr('');
    try {
      await api.deleteLeague(delLg.id, delPass);
      setMsg(`🗑 Liga «${delLg.name}» eliminada con todos sus equipos y juegos`);
      setDelLg(null);
      setDelPass('');
      load();
    } catch (err) { setDelErr((err as Error).message); }
    setDelBusy(false);
  };

  const openRest = () => {
    setRestOpen(true); setRestFile(''); setRestScan([]); setRestLg(''); setRestPass(''); setRestErr('');
  };
  const pickRestLg = (name: string) => {
    setRestLg(name); setRestScan([]); setRestFile(''); setRestErr('');
    if (!name) return;
    setRestBusy(true);
    void api.backupRestoreScan(name)
      .then((r) => setRestScan(r.files))
      .catch((e) => setRestErr(e.message))
      .finally(() => setRestBusy(false));
  };
  const doRestore = async () => {
    if (!restFile || !restLg || !restPass) return;
    setRestBusy(true); setRestErr('');
    try {
      const r = await api.backupRestoreLeague(restFile, restLg, restPass);
      setRestOpen(false);
      setMsg(`✅ «${r.league}» restaurada — ${r.years.join(', ')} · ${r.teams} equipos · ${r.players} jugadores · ${r.games} juegos`);
      load();
    } catch (e) { setRestErr((e as Error).message); }
    setRestBusy(false);
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      // sin año — la temporada se crea dentro de la liga
      const l = await api.createLeague({ name: name.trim(), sport });
      setName('');
      load();
      window.location.href = `/leagues/${l.id}`; // entrar a crear la primera temporada
    } catch (err) { setError((err as Error).message); }
  };

  return (
    <div>
      <h1>Ligas y torneos
        <span style={{ float: 'right', display: 'flex', gap: 6 }}>
          <button className="secondary" style={{ fontSize: '0.85rem' }} title="Devuelve una liga al estado de un respaldo automático (arregla daños de un import)" onClick={openRest}>🕐 Restaurar</button>
          <button className="secondary" style={{ fontSize: '0.85rem' }} title="Importa .pox.json o el paquete de liga BallStat (.rar/.zip con BallScore Reports + WebBuilder)" onClick={() => fileRef.current?.click()}>📥 Importar</button>
        </span>
      </h1>
      <input ref={fileRef} type="file" accept=".json,.pox,.txt,.rar,.zip,.sbk,.ros" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); e.target.value = ''; }} />
      {error && <p className="pill sched">{error} <button className="secondary" style={{ marginLeft: 8, padding: '0 8px' }} onClick={() => setError('')}>✕</button></p>}
      {msg && <p className="pill" style={{ background: '#dcfce7', color: '#166534' }}>{msg} <button className="secondary" style={{ marginLeft: 8, padding: '0 8px' }} onClick={() => setMsg('')}>✕</button></p>}
      {imp && (
        <div className="modal-back" onClick={() => !impBusy && setImp(null)}>
          <div className="modal-card modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>📥 Importar liga</h3>
              <button onClick={() => setImp(null)}>✕</button>
            </div>
            <p className="muted">{imp.name}</p>
            {impBusy && <p className="muted">Analizando…</p>}
            {impErr && <p style={{ color: '#dc2626', fontSize: '0.88rem' }}>⚠ {impErr}</p>}
            {preview && (
              <div>
                <p>
                  <strong>{preview.league}</strong> — {preview.sport === 'softball' ? '🥎' : '⚾'}<br />
                  {preview.seasons} temporada(s) · {preview.teams} equipos · {preview.players} jugadores · {preview.games} juegos<br />
                  <span className="muted">
                    {preview.gamesWithEvents > 0
                      ? `${preview.gamesWithEvents} juegos con jugada a jugada (boxscores completos)`
                      : 'stats acumuladas — sin jugada a jugada'}
                  </span>
                </p>
                {preview.warnings.length > 0 && (
                  <div style={{ maxHeight: 120, overflow: 'auto', fontSize: '0.8rem' }} className="muted">
                    {preview.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                  </div>
                )}
                {!impBackup && (
                  <div style={{ marginTop: 10, borderTop: '1px solid #e5e7eb', paddingTop: 10 }}>
                    <label className="muted" style={{ fontSize: '0.82rem', display: 'block', marginBottom: 4 }}>
                      Destino — el nombre del archivo puede variar por técnico; elige dónde va
                    </label>
                    <select value={appendTo} onChange={(e) => pickAppend(e.target.value)} style={{ width: '100%' }}>
                      <option value="">➕ Crear liga nueva «{preview.league}»</option>
                      {leagues.map((l) => (
                        <option key={l.id} value={l.id}>📂 Agregar como temporada a «{l.name}»</option>
                      ))}
                    </select>
                    <div style={{ marginTop: 8, fontSize: '0.85rem' }}>
                      <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                        <input type="checkbox" checked={mergeSame} onChange={(e) => setMergeSame(e.target.checked)} />
                        🔗 Fundir jugadores repetidos en varios equipos — queda en el equipo de su <strong>último juego</strong>, con todo sumado
                      </label>
                    </div>
                    {appendTo && (
                      <div style={{ marginTop: 4, fontSize: '0.85rem' }}>
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                          <input type="checkbox" checked={mergeY} onChange={(e) => { setMergeY(e.target.checked); if (e.target.checked) setReplaceY(false); }} />
                          🧩 Fusionar si ese año ya existe — <strong>agrega los juegos sin borrar nada</strong> (salta los repetidos: base partida «2025» + «2025 B»)
                        </label>
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                          <input type="checkbox" checked={replaceY} onChange={(e) => { setReplaceY(e.target.checked); if (e.target.checked) setMergeY(false); }} />
                          ♻️ Reemplazar si ese año ya existe — <strong>borra la temporada anterior</strong>
                        </label>
                        {appendPrev && (
                          <div style={{ marginTop: 8 }}>
                            <p className="muted" style={{ margin: '4px 0', fontSize: '0.8rem' }}>
                              ✓ {appendPrev.matched} jugador(es) ya existen en «{appendPrev.league}»
                              {(preview?.years ?? []).some((y) => appendPrev.existingYears.includes(y)) && (
                                <span style={{ color: mergeY ? '#1d4ed8' : '#b91c1c', fontWeight: 600 }}>
                                  {mergeY
                                    ? ` · 🧩 se agregarán a ${(preview?.years ?? []).filter((y) => appendPrev.existingYears.includes(y))
                                        .map((y) => `la temporada ${y} existente (${appendPrev.existingYearGames?.[y] ?? '?'} juegos)`).join(' y ')} — los repetidos se saltan`
                                    : ` · ⛔ año duplicado — reemplazar BORRARÁ ${(preview?.years ?? []).filter((y) => appendPrev.existingYears.includes(y))
                                        .map((y) => `la temporada ${y} (${appendPrev.existingYearGames?.[y] ?? '?'} juegos)`).join(' y ')} (o marca 🧩 Fusionar)`}
                                </span>
                              )}
                            </p>
                            {appendPrev.multiTeam.length > 0 && (
                              <p className="muted" style={{ margin: '4px 0', fontSize: '0.8rem' }}>
                                🔀 {appendPrev.multiTeam.length} nombre(s) en varios equipos del archivo
                                {mergeSame ? ' — se fusionan en una ficha' : ' — marca 🔗 para fusionarlos'}
                              </p>
                            )}
                            {appendPrev.unmatched.length > 0 && (
                              <div style={{ maxHeight: 320, overflow: 'auto', marginTop: 4 }}>
                                <p className="muted" style={{ margin: '2px 0', fontSize: '0.8rem' }}>
                                  ¿A dónde van estos nombres? (apellido/nombre cambió entre años)
                                </p>
                                {appendPrev.unmatched.map((u) =>
                                  (u.teams.length ? u.teams : ['']).map((t) => {
                                    const key = `${u.name}||${t}`;
                                    return (
                                      <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: '0.85rem' }}>
                                        <span style={{ minWidth: 0, flex: '0 0 30%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                          <strong>{u.name}</strong>{t && <span className="muted"> · {t}</span>}
                                        </span>
                                        →
                                        <select style={{ flex: 1, minWidth: 0 }} value={aliasSel[key] ?? ''}
                                          onChange={(e) => setAliasSel((s) => ({ ...s, [key]: e.target.value }))}>
                                          <option value="">➕ Jugador nuevo</option>
                                          {(aliasSearch[key]?.trim()
                                            ? (appendPrev.roster ?? []).filter((p) => fuzzyMatch(aliasSearch[key], p.name))
                                                .map((p) => ({ id: p.id, name: p.name, team: p.team, why: '' }))
                                            : u.candidates
                                          ).map((c) => (
                                            <option key={c.id} value={c.name}>{c.name} · {c.team}{c.why ? ` — ${c.why}` : ''}</option>
                                          ))}
                                        </select>
                                        <input placeholder="🔎 buscar…" title="Buscar en TODA la liga — por si el candidato no salió solo"
                                          value={aliasSearch[key] ?? ''} style={{ width: 110, fontSize: '0.8rem', padding: '3px 6px' }}
                                          onChange={(e) => setAliasSearch((s) => ({ ...s, [key]: e.target.value }))} />
                                      </div>
                                    );
                                  }),
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setImp(null)} disabled={impBusy}>Cancelar</button>
              <button onClick={doImport} disabled={impBusy || !preview}>{impBusy ? 'Importando…' : 'Importar'}</button>
            </div>
          </div>
        </div>
      )}
      <div className="card">
        <form className="row" onSubmit={create}>
          <input placeholder="Nombre (ej. Liga Municipal, Torneo Apertura)" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 2 }} />
          <div className="sport-toggle">
            <button type="button" className={sport === 'baseball' ? '' : 'secondary'} onClick={() => setSport('baseball')}>⚾</button>
            <button type="button" className={sport === 'softball' ? '' : 'secondary'} onClick={() => setSport('softball')}>🥎</button>
          </div>
          <button type="submit">Crear liga</button>
        </form>
        <p className="muted" style={{ marginBottom: 0, fontSize: '0.8rem' }}>
          La liga no lleva año — adentro creas cada <strong>temporada</strong> (2026, 2027…) y todo queda dividido por ella.
        </p>
      </div>
      {delLg && (
        <div className="modal-back" onClick={() => !delBusy && setDelLg(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>🗑 Borrar liga</h3>
              <button onClick={() => setDelLg(null)}>✕</button>
            </div>
            <p>
              Vas a borrar <strong>{delLg.name}</strong> con <strong>todos</strong> sus equipos,
              jugadores, juegos y estadísticas. <span style={{ color: '#dc2626' }}>No se puede deshacer.</span>
            </p>
            <form onSubmit={doDelete}>
              <label className="muted" style={{ fontSize: '0.85rem' }}>Clave de administrador</label>
              <input type="password" autoFocus value={delPass} onChange={(e) => setDelPass(e.target.value)}
                placeholder="Contraseña de un usuario admin" style={{ width: '100%', marginTop: 4 }} />
              {delErr && <p style={{ color: '#dc2626', fontSize: '0.88rem' }}>⚠ {delErr}</p>}
              <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
                <button type="button" className="secondary" onClick={() => setDelLg(null)} disabled={delBusy}>Cancelar</button>
                <button type="submit" className="danger" disabled={delBusy || !delPass}>{delBusy ? 'Borrando…' : '🗑 Borrar liga'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {restOpen && (
        <div className="modal-back" onClick={() => !restBusy && setRestOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>🕐 Restaurar liga desde respaldo</h3>
              <button onClick={() => setRestOpen(false)}>✕</button>
            </div>
            <p className="muted" style={{ fontSize: '0.85rem' }}>
              Devuelve una liga al estado de un respaldo automático — borra la liga
              actual y la reemplaza por la del archivo (para daños de un import).
            </p>
            <label className="muted" style={{ fontSize: '0.82rem', display: 'block', marginBottom: 4 }}>Liga a restaurar</label>
            <select value={restLg} onChange={(e) => pickRestLg(e.target.value)} style={{ width: '100%' }}>
              <option value="">— elegir liga…</option>
              {leagues.map((l) => <option key={l.id} value={l.name}>{l.name}</option>)}
            </select>
            {restBusy && <p className="muted">Revisando todos los respaldos…</p>}
            {restScan.length > 0 && (
              <div style={{ marginTop: 10, maxHeight: 260, overflow: 'auto' }}>
                <p className="muted" style={{ fontSize: '0.8rem', margin: '4px 0' }}>
                  En qué respaldo está «{restLg}» — elige el de <strong>antes</strong> del daño
                  (el que muestre solo la temporada vigente):
                </p>
                <table style={{ fontSize: '0.85rem' }}>
                  <thead><tr><th></th><th>Respaldo</th><th>Años</th><th>Jug</th><th>Juegos</th></tr></thead>
                  <tbody>
                    {restScan.map((f) => (
                      <tr key={f.file} style={{ cursor: f.found ? 'pointer' : 'default', opacity: f.found ? 1 : 0.45 }}
                        onClick={() => f.found && setRestFile(f.file)}>
                        <td>{f.found && <input type="radio" checked={restFile === f.file} onChange={() => setRestFile(f.file)} />}</td>
                        <td>{f.file.replace(/^auto-/, '').replace('T', ' ').replace(/\.json$/, '').replace(/-(\d\d)$/, ':$1')}
                          {!f.found && <span className="muted"> — no está</span>}</td>
                        <td>{f.found ? f.years.join(', ') : ''}</td>
                        <td>{f.found ? f.players : ''}</td>
                        <td>{f.found ? f.games : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {restFile && (
              <div style={{ marginTop: 10 }}>
                <p style={{ color: '#b91c1c', fontSize: '0.85rem', fontWeight: 600 }}>
                  ⚠ «{restLg}» actual se borrará completa y quedará como en este respaldo.
                  Se hace un respaldo nuevo antes de borrar.
                </p>
                <label className="muted" style={{ fontSize: '0.85rem' }}>Clave de administrador</label>
                <input type="password" value={restPass} onChange={(e) => setRestPass(e.target.value)}
                  placeholder="Contraseña de un usuario admin" style={{ width: '100%', marginTop: 4 }} />
              </div>
            )}
            {restErr && <p style={{ color: '#dc2626', fontSize: '0.88rem' }}>⚠ {restErr}</p>}
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setRestOpen(false)} disabled={restBusy}>Cancelar</button>
              <button className="danger" onClick={doRestore} disabled={restBusy || !restFile || !restPass}>
                {restBusy ? 'Restaurando…' : '🕐 Restaurar liga'}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="card">
        <table>
          <thead><tr><th>Liga / Torneo</th><th>Temporada</th><th>Deporte</th><th>Equipos</th><th>Juegos</th><th /></tr></thead>
          <tbody>
            {leagues.map((l) => {
              const active = l.seasons?.find((s) => s.status === 'ACTIVE');
              return (
                <tr key={l.id}>
                  <td><Link to={`/leagues/${l.id}`}>{l.name}</Link></td>
                  <td>
                    {active ? <strong>{active.year}</strong> : <span className="muted">sin temporada</span>}
                    {l.seasons && l.seasons.length > 1 && <span className="muted"> ·{l.seasons.length} temp.</span>}
                  </td>
                  <td>{l.sport === 'softball' ? '🥎 Softball' : '⚾ Baseball'}</td>
                  <td>{l._count?.teams ?? 0}</td>
                  <td>{l._count?.games ?? 0}</td>
                  <td><Link to={`/leagues/${l.id}`}>Administrar →</Link>{' '}
                    <button className="sm secondary" title="Borrar la liga completa (pide clave de admin)"
                      onClick={() => { setDelLg(l); setDelPass(''); setDelErr(''); }}>🗑</button></td>
                </tr>
              );
            })}
            {leagues.length === 0 && <tr><td colSpan={6} className="muted">Sin ligas aún — crea la primera arriba</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
