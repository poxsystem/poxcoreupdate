import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, Player, PlayerListItem, Team } from '../api';
import { POSITIONS } from '@poxscore/shared';
import PlayerAvatar, { PhotoPicker } from '../components/PlayerAvatar';
import PrintSheet from '../components/PrintSheet';
import { PassModal } from '../components/PassModal';

const emptyForm = { firstName: '', lastName: '', number: '', bats: 'R', throws: 'R', positions: '' };

export default function TeamDetailPage() {
  const { id } = useParams();
  const [team, setTeam] = useState<(Team & { players: Player[] }) | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [formPhoto, setFormPhoto] = useState(''); // foto del jugador nuevo (data URL ya redimensionada)
  const [error, setError] = useState('');
  const [moveId, setMoveId] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set()); // selección para mover por lote
  const [selTo, setSelTo] = useState('');
  const [msg, setMsg] = useState('');
  const [editTeam, setEditTeam] = useState(false);
  const [teamForm, setTeamForm] = useState({ name: '', shortName: '' });
  const [editP, setEditP] = useState<Player | null>(null);
  const [pForm, setPForm] = useState(emptyForm);
  const [savingEdit, setSavingEdit] = useState(false);
  const [printRoster, setPrintRoster] = useState(false);
  const [delP, setDelP] = useState<Player | null>(null); // jugador pendiente de borrar (pide clave)
  const [showPassive, setShowPassive] = useState(false); // sección "Jugadores pasivos"
  const [incOpen, setIncOpen] = useState(false);         // modal incorporar pasivo de otra temporada/equipo
  const [incSearch, setIncSearch] = useState('');
  const [incBusy, setIncBusy] = useState(false);
  const [passivePool, setPassivePool] = useState<PlayerListItem[]>([]);

  const load = () => {
    if (!id) return;
    void api.team(id).then(setTeam).catch((e) => setError(e.message));
    void api.teams().then(setTeams).catch(() => {});
  };
  useEffect(() => { load(); }, [id]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !form.firstName || !form.lastName) return;
    await api.addPlayer(id, {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      number: form.number ? Number(form.number) : undefined,
      bats: form.bats, throws: form.throws,
      positions: form.positions || undefined,
      photo: formPhoto || undefined,
    });
    setForm(emptyForm); setFormPhoto('');
    load();
  };

  const saveTeam = async () => {
    if (!id || !teamForm.name.trim()) return;
    setSavingEdit(true);
    try {
      await api.updateTeam(id, { name: teamForm.name.trim(), shortName: teamForm.shortName.trim() || null });
      setEditTeam(false); load();
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Error'); }
    finally { setSavingEdit(false); }
  };

  const openEditP = (p: Player) => {
    setEditP(p);
    setPForm({ firstName: p.firstName, lastName: p.lastName, number: p.number != null ? String(p.number) : '', bats: p.bats ?? 'R', throws: p.throws ?? 'R', positions: p.positions ?? '' });
  };

  const saveP = async () => {
    if (!id || !editP || !pForm.firstName.trim() || !pForm.lastName.trim()) return;
    setSavingEdit(true);
    try {
      await api.updatePlayer(id, editP.id, {
        firstName: pForm.firstName.trim(), lastName: pForm.lastName.trim(),
        number: pForm.number ? Number(pForm.number) : null,
        bats: pForm.bats, throws: pForm.throws, positions: pForm.positions || null,
      });
      setEditP(null); load();
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Error'); }
    finally { setSavingEdit(false); }
  };

  // transferencia: el jugador conserva su ID → stats e historial lo siguen
  const move = async (pid: string) => {
    if (!id || !moveTo) return;
    await api.updatePlayer(id, pid, { teamId: moveTo });
    setMoveId(null); setMoveTo('');
    load();
  };

  // mover seleccionados por lote (conserva playerId → stats e historial siguen)
  const moveBulk = async () => {
    if (!id || !sel.size || !selTo) return;
    const res = await api.bulkMovePlayers(id, [...sel], selTo);
    setMsg(`${res.moved} jugadores movidos a ${teams.find((t) => t.id === selTo)?.name ?? 'equipo'}`);
    setSel(new Set()); setSelTo('');
    load();
  };
  const toggleSel = (pid: string) =>
    setSel((s) => { const n = new Set(s); if (n.has(pid)) n.delete(pid); else n.add(pid); return n; });

  // baja por lote: solo marca active:false sobre los que TÚ seleccionaste —
  // misma operación del botón ⛔ por fila, nada automático
  const deactivateBulk = async () => {
    if (!id || !sel.size) return;
    if (!confirm(`¿Dar de baja a ${sel.size} jugadores? Pasan a "Jugadores pasivos" conservando sus stats.`)) return;
    for (const pid of sel) await api.updatePlayer(id, pid, { active: false });
    setMsg(`${sel.size} jugadores pasaron a pasivos`);
    setSel(new Set());
    load();
  };

  const toggleActive = async (p: Player) => {
    if (!id) return;
    await api.updatePlayer(id, p.id, { active: !p.active });
    load();
  };

  const savePhoto = async (p: Player, photo: string) => {
    if (!id) return;
    await api.updatePlayer(id, p.id, { photo });
    load();
  };

  const remove = async (password: string) => {
    if (!id || !delP) return;
    await api.deletePlayer(id, delP.id, password);
    load();
  };

  // incorporar una ficha pasiva (de una temporada atrasada u otro equipo):
  // la trae a ESTE equipo y la reactiva de una vez — stats e historial la siguen
  const openInc = () => {
    setIncOpen(true); setIncSearch('');
    api.playerList().then((all) => setPassivePool(
      // solo pasivos de la MISMA liga — traer fichas de otra liga mezclaba torneos
      all.filter((p) => p.active === false && (!team?.leagueId || p.leagueId === team.leagueId)),
    )).catch(() => {});
  };
  const incorporate = async (p: PlayerListItem) => {
    if (!id || !p.teamId || incBusy) return;
    setIncBusy(true);
    try {
      await api.updatePlayer(p.teamId, p.id, { teamId: id, active: true });
      setMsg(`${p.label} reactivado en ${team?.name}`);
      setIncOpen(false); load();
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Error'); }
    finally { setIncBusy(false); }
  };

  // ---- Importar / exportar roster (estilo BallStat "Importar roster") ----
  const csvCell = (v: string | number | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const exportCsv = () => {
    if (!team) return;
    const rows = [
      ['numero', 'nombre', 'apellido', 'batea', 'tira', 'posiciones'],
      ...team.players.map((p) => [p.number ?? '', p.firstName, p.lastName, p.bats ?? '', p.throws ?? '', p.positions ?? '']),
    ];
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `roster-${team.name.replace(/\s+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // parser CSV mínimo con soporte de comillas (posiciones "SS,2B" llevan coma)
  const parseCsvLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  const importCsv = async (file: File) => {
    if (!id) return;
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const players = lines
      .map(parseCsvLine)
      .filter((c) => c.length >= 2 && c[0] && c[1])
      .filter((c) => !/^(num(ero)?|nombre|firstName)$/i.test(c[0]) && !/^(apellido|lastName)$/i.test(c[1])) // omitir encabezado
      .map((c) => {
        // TXT simple: nombre,apellido[,posicion[,posicion…]] — el primer campo NO es número
        if (!/^\d+$/.test(c[0]) && c.length <= 5) {
          const [firstName, lastName, ...pos] = c;
          return { firstName, lastName, positions: pos.join(',') || undefined };
        }
        // CSV completo: numero,nombre,apellido,batea,tira,posiciones
        const [number, firstName, lastName, bats, throws, positions] = c;
        return {
          firstName, lastName, number: number || undefined,
          bats: bats || undefined, throws: throws || undefined, positions: positions || undefined,
        };
      });
    if (!players.length) { setError('El archivo no tiene jugadores válidos (formato: nombre,apellido,posición)'); return; }
    const res = await api.bulkPlayers(id, players);
    setMsg(`Importados ${res.created} jugadores${res.skipped ? ` (${res.skipped} ya existían)` : ''}`);
    load();
  };

  if (!team) return <p>{error || 'Cargando…'}</p>;
  const actives = team.players.filter((p) => p.active);
  const passives = team.players.filter((p) => !p.active);

  return (
    <div>
      <p><Link to="/teams">← Equipos</Link></p>
      <div className="row" style={{ alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>{team.name} {team.shortName && <span className="muted">({team.shortName})</span>}</h1>
        <button className="secondary" title="Editar equipo" onClick={() => { setTeamForm({ name: team.name, shortName: team.shortName ?? '' }); setEditTeam(true); }}>
          ✏️ Editar
        </button>
      </div>

      <div className="card">
        <h2>Agregar jugador</h2>
        <form className="row" onSubmit={add} style={{ alignItems: 'center' }}>
          <PlayerAvatar player={{ photo: formPhoto }} size={44} />
          <PhotoPicker title="Elegir foto (se recorta y redimensiona sola)" onPhoto={setFormPhoto} />
          <input placeholder="Nombre" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
          <input placeholder="Apellido" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
          <input placeholder="#" style={{ width: 60 }} value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />
          <select value={form.bats} onChange={(e) => setForm({ ...form, bats: e.target.value })} title="Batea">
            <option value="R">Bat: D</option><option value="L">Bat: Z</option><option value="S">Bat: A</option>
          </select>
          <select value={form.throws} onChange={(e) => setForm({ ...form, throws: e.target.value })} title="Tira">
            <option value="R">Tira: D</option><option value="L">Tira: Z</option>
          </select>
          <input placeholder="Posiciones (ej. SS,2B)" value={form.positions} onChange={(e) => setForm({ ...form, positions: e.target.value })} list="positions" />
          <datalist id="positions">{POSITIONS.map((p) => <option key={p} value={p} />)}</datalist>
          <button type="submit">Agregar</button>
        </form>
      </div>

      {msg && <div className="flash" onClick={() => setMsg('')}>{msg}</div>}

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Roster ({actives.length} activos)</h2>
          <span className="spacer" />
          <button className="secondary" title="Traer un jugador pasivo de otra temporada/equipo a este roster" onClick={openInc}>＋ Incorporar pasivo</button>
          <button className="secondary" title="Roster en carta vertical 8.5×11 (nombre y posición)" onClick={() => setPrintRoster(true)}>🖨️ Roster PDF</button>
          <button className="secondary" onClick={exportCsv}>⬇ Exportar CSV</button>
          <label className="secondary" style={{ cursor: 'pointer', padding: '0.4rem 0.8rem', border: '1px solid var(--line)', borderRadius: 8 }}>
            ⬆ Importar CSV/TXT
            <input type="file" accept=".csv,.txt,text/csv,text/plain" style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void importCsv(f); e.target.value = ''; }} />
          </label>
        </div>
        <p className="muted" style={{ fontSize: '0.78rem', margin: '0.3rem 0 0.6rem' }}>
          TXT simple: <code>Alexis,Lara,SS</code> (nombre,apellido,posición — o varias: SS,CF) ·
          CSV completo: numero,nombre,apellido,batea,tira,posiciones · una línea = un jugador, se crean todos
        </p>
        {sel.size > 0 && (
          <div className="row" style={{ gap: '0.4rem', marginBottom: '0.5rem', alignItems: 'center' }}>
            <span className="pill sched">{sel.size} seleccionados</span>
            <select value={selTo} onChange={(e) => setSelTo(e.target.value)}>
              <option value="">Mover a…</option>
              {teams.filter((t) => t.id !== id
                && (!team?.leagueId || t.leagueId === team.leagueId)).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <button onClick={moveBulk} disabled={!selTo}>Mover {sel.size} →</button>
            <button className="secondary" onClick={deactivateBulk}>⛔ Dar de baja {sel.size}</button>
            <button className="secondary" onClick={() => setSel(new Set())}>Quitar selección</button>
          </div>
        )}
        <table>
          <thead><tr>
            <th><input type="checkbox" title="Seleccionar todos"
              checked={actives.length > 0 && sel.size === actives.length}
              onChange={(e) => setSel(e.target.checked ? new Set(actives.map((p) => p.id)) : new Set())} /></th>
            <th /><th>#</th><th>Nombre</th><th>Bat</th><th>Tira</th><th>Posiciones</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {actives.map((p) => (
              <tr key={p.id}>
                <td><input type="checkbox" checked={sel.has(p.id)} onChange={() => toggleSel(p.id)} /></td>
                <td style={{ width: 40 }}><PlayerAvatar player={p} size={36} /></td>
                <td>{p.number}</td>
                <td><Link to={`/players/${p.id}`}>{p.firstName} {p.lastName}</Link></td>
                <td>{p.bats}</td>
                <td>{p.throws}</td>
                <td>{p.positions}</td>
                <td><span className="pill live">ACTIVO</span></td>
                <td>
                  <div className="row" style={{ gap: '0.3rem', justifyContent: 'flex-end' }}>
                    <button className="secondary icon" title="Editar jugador" onClick={() => openEditP(p)}>✏️</button>
                    <PhotoPicker title="Subir/cambiar foto" onPhoto={(photo) => savePhoto(p, photo)} />
                    {p.photo && (
                      <button className="secondary icon" title="Quitar foto" onClick={() => savePhoto(p, '')}>🚫</button>
                    )}
                    <button className="secondary icon" title="Mover a otro equipo (conserva stats)" onClick={() => { setMoveId(moveId === p.id ? null : p.id); setMoveTo(''); }}>↔</button>
                    <button className="secondary icon" title="Dar de baja → pasa a Jugadores pasivos" onClick={() => toggleActive(p)}>⛔</button>
                    <button className="danger icon" title="Eliminar registro (pide clave admin)" onClick={() => setDelP(p)}>✕</button>
                  </div>
                  {moveId === p.id && (
                    <div className="row" style={{ gap: '0.3rem', marginTop: '0.4rem', justifyContent: 'flex-end' }}>
                      <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                        <option value="">Mover a…</option>
                        {teams.filter((t) => t.id !== id
                          && (!team?.leagueId || t.leagueId === team.leagueId)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                      <button onClick={() => move(p.id)} disabled={!moveTo}>Confirmar</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {actives.length === 0 && <tr><td colSpan={9} className="muted">Sin jugadores activos</td></tr>}
          </tbody>
        </table>
      </div>

      {passives.length > 0 && (
        <div className="card">
          <div className="row" style={{ alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>🛌 Jugadores pasivos ({passives.length})</h2>
            <span className="spacer" />
            <button className="secondary" onClick={() => setShowPassive(!showPassive)}>{showPassive ? 'Ocultar' : 'Ver'}</button>
          </div>
          <p className="muted" style={{ fontSize: '0.78rem', margin: '0.3rem 0 0' }}>
            Dados de baja o creados por imports de temporadas atrasadas — conservan sus stats y no ocupan puesto en el roster. Puedes reactivarlos aquí.
          </p>
          {showPassive && (
            <table style={{ marginTop: '0.6rem' }}>
              <thead><tr><th /><th>#</th><th>Nombre</th><th>Posiciones</th><th>Estado</th><th /></tr></thead>
              <tbody>
                {passives.map((p) => (
                  <tr key={p.id} className="sub-out">
                    <td style={{ width: 40 }}><PlayerAvatar player={p} size={36} /></td>
                    <td>{p.number}</td>
                    <td><Link to={`/players/${p.id}`}>{p.firstName} {p.lastName}</Link></td>
                    <td>{p.positions}</td>
                    <td><span className="pill final">BAJA</span></td>
                    <td>
                      <div className="row" style={{ gap: '0.3rem', justifyContent: 'flex-end' }}>
                        <button className="secondary icon" title="Editar jugador" onClick={() => openEditP(p)}>✏️</button>
                        <button className="secondary icon" title="Reactivar en este equipo" onClick={() => toggleActive(p)}>✓</button>
                        <button className="danger icon" title="Eliminar registro (pide clave admin)" onClick={() => setDelP(p)}>✕</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {incOpen && (
        <div className="modal-back" onClick={() => !incBusy && setIncOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>＋ Incorporar jugador pasivo</h3>
              <button onClick={() => !incBusy && setIncOpen(false)}>✕</button>
            </div>
            <p className="muted">
              Fichas dadas de baja de esta liga — al elegir una queda <strong>activa en {team.name}</strong> con sus stats e historial intactos.
            </p>
            <input placeholder="🔎 Buscar por nombre…" value={incSearch} onChange={(e) => setIncSearch(e.target.value)} autoFocus style={{ width: '100%' }} />
            <div style={{ maxHeight: 300, overflowY: 'auto', marginTop: '0.5rem' }}>
              {passivePool
                .filter((p) => !incSearch.trim() || p.label.toLowerCase().includes(incSearch.trim().toLowerCase()))
                .map((p) => (
                  <div key={p.id} className="row" style={{ padding: '0.3rem 0.2rem', borderBottom: '1px solid var(--line)', alignItems: 'center' }}>
                    <span>{p.label}</span>
                    <span className="muted" style={{ fontSize: '0.78rem' }}>{p.team}{p.league ? ` · ${p.league}` : ''}</span>
                    <span className="spacer" />
                    <button className="secondary" disabled={incBusy || !p.teamId}
                      onClick={() => incorporate(p)}>{incBusy ? '…' : '→ Traer'}</button>
                  </div>
                ))}
              {passivePool.length === 0 && <p className="muted">No hay jugadores pasivos en esta liga.</p>}
            </div>
          </div>
        </div>
      )}

      {editTeam && (
        <div className="modal-back" onClick={() => !savingEdit && setEditTeam(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>✏️ Editar equipo</h3></div>
            <div className="row" style={{ alignItems: 'center' }}>
              <input placeholder="Nombre del equipo" value={teamForm.name} onChange={(e) => setTeamForm({ ...teamForm, name: e.target.value })} autoFocus />
              <input placeholder="Abrev." value={teamForm.shortName} onChange={(e) => setTeamForm({ ...teamForm, shortName: e.target.value })} style={{ width: 100 }} />
            </div>
            <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setEditTeam(false)} disabled={savingEdit}>Cancelar</button>
              <button onClick={saveTeam} disabled={savingEdit || !teamForm.name.trim()}>{savingEdit ? 'Guardando…' : 'Guardar'}</button>
            </div>
          </div>
        </div>
      )}

      {editP && (
        <div className="modal-back" onClick={() => !savingEdit && setEditP(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>✏️ Editar jugador</h3></div>
            <div className="row" style={{ alignItems: 'center' }}>
              <input placeholder="Nombre" value={pForm.firstName} onChange={(e) => setPForm({ ...pForm, firstName: e.target.value })} autoFocus />
              <input placeholder="Apellido" value={pForm.lastName} onChange={(e) => setPForm({ ...pForm, lastName: e.target.value })} />
            </div>
            <div className="row" style={{ alignItems: 'center', marginTop: '0.5rem' }}>
              <input placeholder="#" style={{ width: 60 }} value={pForm.number} onChange={(e) => setPForm({ ...pForm, number: e.target.value })} />
              <select value={pForm.bats} onChange={(e) => setPForm({ ...pForm, bats: e.target.value })} title="Batea">
                <option value="R">Bat: D</option><option value="L">Bat: Z</option><option value="S">Bat: A</option>
              </select>
              <select value={pForm.throws} onChange={(e) => setPForm({ ...pForm, throws: e.target.value })} title="Tira">
                <option value="R">Tira: D</option><option value="L">Tira: Z</option>
              </select>
              <input placeholder="Posiciones (ej. SS,2B)" value={pForm.positions} onChange={(e) => setPForm({ ...pForm, positions: e.target.value })} list="positions" />
            </div>
            <div className="row" style={{ marginTop: '0.8rem', justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setEditP(null)} disabled={savingEdit}>Cancelar</button>
              <button onClick={saveP} disabled={savingEdit || !pForm.firstName.trim() || !pForm.lastName.trim()}>{savingEdit ? 'Guardando…' : 'Guardar'}</button>
            </div>
          </div>
        </div>
      )}

      {printRoster && (
        <PrintSheet
          title={`Roster — ${team.name}${team.shortName ? ` (${team.shortName})` : ''}`}
          subtitle={`${team.league?.name ?? ''} ${team.league?.year ?? ''} · ${actives.length} jugadores · Generado ${new Date().toLocaleDateString()}`}
          onClose={() => setPrintRoster(false)}>
          <table className="report-table">
            <thead><tr><th style={{ width: '8%' }}>No.</th><th style={{ width: '52%' }}>Nombre</th><th style={{ width: '25%' }}>Posición</th><th style={{ width: '15%' }}>B/T</th></tr></thead>
            <tbody>
              {actives.slice().sort((a, b) => (a.number ?? 999) - (b.number ?? 999) || a.lastName.localeCompare(b.lastName)).map((p) => (
                <tr key={p.id}>
                  <td>{p.number ?? ''}</td>
                  <td>{p.lastName}, {p.firstName}</td>
                  <td>{p.positions ?? '—'}</td>
                  <td>{p.bats === 'L' ? 'Z' : p.bats === 'S' ? 'A' : 'D'}/{p.throws === 'L' ? 'Z' : 'D'}</td>
                </tr>
              ))}
              {!team.players.length && <tr><td colSpan={4}>Roster vacío</td></tr>}
            </tbody>
          </table>
        </PrintSheet>
      )}
      {delP && (
        <PassModal
          title="Borrar jugador"
          message={`Vas a borrar el registro de «${delP.firstName} ${delP.lastName}» (su historial en juegos queda; mejor usar baja para conservarlo en el roster).`}
          onClose={() => setDelP(null)}
          onDone={remove}
        />
      )}
    </div>
  );
}
