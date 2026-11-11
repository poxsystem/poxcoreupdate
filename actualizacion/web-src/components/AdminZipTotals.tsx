import { useRef, useState } from 'react';
import { api, type BoxZipTotals, type Player, type Team } from '../api';

const ipTxt = (outs?: number) => (outs == null ? '—' : `${Math.floor(outs / 3)}.${outs % 3}`);

// columnas que PlayerSeasonStat puede guardar (po/a/bf no existen — se omiten)
const FIELDS: { k: string; label: string; group: string; ip?: boolean }[] = [
  { k: 'g', label: 'JJ', group: 'Bateo' }, { k: 'pa', label: 'PA', group: 'Bateo' },
  { k: 'ab', label: 'VB', group: 'Bateo' }, { k: 'r', label: 'CA', group: 'Bateo' },
  { k: 'h', label: 'H', group: 'Bateo' }, { k: 'doubles', label: '2B', group: 'Bateo' },
  { k: 'triples', label: '3B', group: 'Bateo' }, { k: 'hr', label: 'HR', group: 'Bateo' },
  { k: 'rbi', label: 'CI', group: 'Bateo' }, { k: 'bb', label: 'BB', group: 'Bateo' },
  { k: 'k', label: 'SO', group: 'Bateo' }, { k: 'hbp', label: 'GP', group: 'Bateo' },
  { k: 'sac', label: 'SAC', group: 'Bateo' }, { k: 'sf', label: 'SF', group: 'Bateo' },
  { k: 'sb', label: 'BR', group: 'Bateo' },
  { k: 'gp', label: 'JL', group: 'Pitcheo' }, { k: 'gs', label: 'JA', group: 'Pitcheo' },
  { k: 'w', label: 'G', group: 'Pitcheo' }, { k: 'l', label: 'P', group: 'Pitcheo' },
  { k: 'sv', label: 'JS', group: 'Pitcheo' }, { k: 'hld', label: 'HLD', group: 'Pitcheo' },
  { k: 'bs', label: 'JSF', group: 'Pitcheo' }, { k: 'cg', label: 'JC', group: 'Pitcheo' },
  { k: 'sho', label: 'BL', group: 'Pitcheo' }, { k: 'pOuts', label: 'IL', group: 'Pitcheo', ip: true },
  { k: 'pH', label: 'H', group: 'Pitcheo' }, { k: 'pR', label: 'C', group: 'Pitcheo' },
  { k: 'pER', label: 'CL', group: 'Pitcheo' }, { k: 'pBB', label: 'BB', group: 'Pitcheo' },
  { k: 'pK', label: 'SO', group: 'Pitcheo' }, { k: 'pHR', label: 'HR', group: 'Pitcheo' },
  { k: 'pPitches', label: 'LZ', group: 'Pitcheo' },
  { k: 'e', label: 'E', group: 'Fildeo' },
];

/** Totales desde ZIP: agrega todos los .box.txt del zip por jugador y los
 *  compara contra la temporada grabada — para recuperar números finales
 *  cuando los juegos no se importaron completos. */
export default function AdminZipTotals({ leagueId, teams }: { leagueId: string; teams: Team[] }) {
  const zipRef = useRef<HTMLInputElement>(null);
  const [teamId, setTeamId] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [roster, setRoster] = useState<Player[]>([]);
  const [zipData, setZipData] = useState<string | null>(null);
  const [zipName, setZipName] = useState('');
  const [res, setRes] = useState<BoxZipTotals | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');

  const pickTeam = async (id: string) => {
    setTeamId(id); setPlayerId(''); setRoster([]);
    if (!id) return;
    const t = await api.team(id);
    setRoster(t.players.filter((p) => p.active !== false));
  };

  const readZip = async (f: File) => {
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
    setZipData(btoa(bin)); setZipName(f.name);
    setRes(null); setPicked(new Set()); setDone('');
  };

  const analyze = async (pid = playerId) => {
    if (!zipData) return;
    setBusy(true); setErr(''); setDone('');
    try {
      const r = await api.boxscoreZipTotals({ leagueId, playerId: pid || undefined, data: zipData });
      setRes(r);
      setPicked(new Set(r.players.filter((p) => p.suggested).map((p) => p.key)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e)); setRes(null);
    }
    setBusy(false);
  };

  const pickPlayer = (pid: string) => {
    setPlayerId(pid); setDone('');
    if (res) void analyze(pid); // refresca "actual" y las filas sugeridas
  };

  const sumPicked = () => {
    const out: Record<string, number> = {};
    for (const p of res?.players ?? []) {
      if (!picked.has(p.key)) continue;
      for (const [k, v] of Object.entries(p.stats)) out[k] = (out[k] ?? 0) + v;
    }
    return out;
  };

  const apply = async () => {
    if (!res || !playerId) return;
    setBusy(true); setErr(''); setDone('');
    try {
      const nuevo = sumPicked();
      // enviar TODAS las columnas (0 incluido) — los finales SOBRESCRIBEN
      const body: Record<string, number> & { season: number } = { season: res.year };
      for (const f of FIELDS) body[f.k] = nuevo[f.k] ?? 0;
      await api.updatePlayerSeason(playerId, body);
      setRes({ ...res, current: nuevo });
      setDone(`✓ Totales de ${res.year} grabados — ${res.files} juegos del ZIP sumados`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const cur = res?.current ?? {};
  const nuevo = sumPicked();
  const rows = FIELDS.filter((f) => (cur[f.k] ?? 0) !== 0 || (nuevo[f.k] ?? 0) !== 0 || f.k === 'g');
  const pname = roster.find((p) => p.id === playerId);

  return (
    <div>
      <p className="muted">
        Sube un <code>.zip</code> con muchos <code>.box.txt</code> (una temporada completa, ej. 100 juegos)
        → se suman por jugador → eliges equipo y jugador → comparas <b>Actual</b> vs <b>Después</b> →
        <b> Aplicar</b> graba los finales en su temporada. Recupera los números que se pierden
        cuando no se importaron los juegos completos.
      </p>

      <div className="ge-row" style={{ flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.7rem' }}>
        <select value={teamId} onChange={(e) => void pickTeam(e.target.value)}>
          <option value="">— Equipo —</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select value={playerId} onChange={(e) => pickPlayer(e.target.value)} disabled={!roster.length}>
          <option value="">— Jugador —</option>
          {roster.map((p) => (
            <option key={p.id} value={p.id}>{p.firstName === '·' ? '' : `${p.firstName} `}{p.lastName}{p.number ? ` · #${p.number}` : ''}</option>
          ))}
        </select>
        <input ref={zipRef} type="file" accept=".zip" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void readZip(f); e.target.value = ''; }} />
        <button className="secondary icon" onClick={() => zipRef.current?.click()}>
          📦 {zipName || 'Elegir .zip'}
        </button>
        <button className="icon ok" disabled={!zipData || busy} onClick={() => void analyze()}>
          🔍 Analizar ZIP
        </button>
      </div>
      {err && <div className="passerr" style={{ margin: '8px 0' }}>⚠️ {err}</div>}
      {done && <div className="ge-ok" style={{ margin: '8px 0' }}>{done}</div>}

      {res && (
        <>
          <p className="muted" style={{ margin: '4px 0 8px' }}>
            {res.files} juegos leídos · año detectado <b>{res.year}</b>
            {res.skipped.length ? ` · ⚠ ${res.skipped.length} archivos omitidos (${res.skipped.slice(0, 3).join(', ')}${res.skipped.length > 3 ? '…' : ''})` : ''}
          </p>
          <div className="zip-cols">
            <div>
              <h4 style={{ margin: '0 0 6px' }}>Jugadores del ZIP <span className="muted">(marca las filas que son de {pname ? `${pname.firstName === '·' ? '' : `${pname.firstName} `}${pname.lastName}` : 'este jugador'})</span></h4>
              <div className="zip-list">
                <table className="admin-table ge-table">
                  <thead><tr><th></th><th>Nombre en archivo</th><th>Equipo</th><th>JJ</th><th>H/AB</th><th>IP</th></tr></thead>
                  <tbody>
                    {res.players.map((p) => (
                      <tr key={p.key} className={picked.has(p.key) ? 'zip-sel' : ''}>
                        <td><input type="checkbox" checked={picked.has(p.key)}
                          onChange={(e) => setPicked((s) => { const n = new Set(s); e.target.checked ? n.add(p.key) : n.delete(p.key); return n; })} /></td>
                        <td>{p.name}{p.suggested ? ' ✓' : ''}{p.dup && <span className="muted" title="El nombre aparece 2+ veces en un mismo juego — puede ser un homónimo; verifica antes de aplicar"> ⚠️</span>}</td>
                        <td className="muted">{p.team}</td>
                        <td>{p.stats.g ?? 0}</td>
                        <td>{p.stats.h ?? 0}/{p.stats.ab ?? 0}</td>
                        <td>{ipTxt(p.stats.pOuts)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h4 style={{ margin: '0 0 6px' }}>Comparar → Aplicar</h4>
              {!playerId && <p className="muted">Elige equipo y jugador arriba para comparar y aplicar.</p>}
              {playerId && (
                <>
                  <table className="admin-table ge-table zip-cmp">
                    <thead><tr><th></th><th>Actual</th><th>→ Después</th></tr></thead>
                    <tbody>
                      {rows.map((f, ix) => {
                        const diff = (cur[f.k] ?? 0) !== (nuevo[f.k] ?? 0);
                        return (
                          <tr key={f.k} className={diff ? 'zip-diff' : ''}>
                            <td className="muted">{ix === 0 || FIELDS[ix - 1].group !== f.group ? <b>{f.group}</b> : ''} {f.label}</td>
                            <td>{f.ip ? ipTxt(cur[f.k]) : (cur[f.k] ?? 0)}</td>
                            <td><b>{f.ip ? ipTxt(nuevo[f.k]) : (nuevo[f.k] ?? 0)}</b></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <div className="ge-row" style={{ marginTop: '0.6rem' }}>
                    <button className="icon ok" disabled={busy || !picked.size} onClick={() => void apply()}>
                      ✓ Aplicar totales a {pname ? `${pname.firstName === '·' ? '' : `${pname.firstName} `}${pname.lastName}` : 'el jugador'} ({res.year})
                    </button>
                    {!picked.size && <span className="muted">marca al menos una fila del ZIP</span>}
                  </div>
                  {!res.current && <p className="muted" style={{ marginTop: 6 }}>El jugador no tiene temporada {res.year} grabada — Aplicar la crea con estos números.</p>}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
