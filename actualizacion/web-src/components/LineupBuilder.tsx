import { useEffect, useMemo, useState } from 'react';
import { api, Game, LineupTpl, parseLineupTpls, Player, Team } from '../api';
import { POSITIONS } from '@poxscore/shared';

interface Entry { playerId: string; position: string; batsInOrder: boolean; player: Player }

/** Nombre corto para mostrar */
const pname = (p?: Player) => (p ? `${p.number ? `#${p.number} ` : ''}${p.firstName} ${p.lastName}` : '?');

interface Props {
  game: Game;
  teamId: string;                 // equipo para el que se arma el lineup en este juego
  side: 'away' | 'home';
  onSaved: () => void;
}

/**
 * Editor de alineación estilo "pool": todos los jugadores a la izquierda
 * (con búsqueda por nombre y opción de refuerzo de otro equipo),
 * lineup ordenado a la derecha.
 */
export default function LineupBuilder({ game, teamId, side, onSaved }: Props) {
  const ownTeam = (side === 'away' ? game.awayTeam : game.homeTeam) as (Team & { players?: Player[] }) | undefined;
  const [entries, setEntriesRaw] = useState<Entry[]>([]);
  // ediciones en curso: si el usuario ya tocó el lineup, un reload del juego
  // (ej. al guardar la alineación del OTRO equipo) NO debe pisarlo — bug:
  // "guardar una alineación borra la del contrario"
  const [dirty, setDirty] = useState(false);
  const setEntries = (e: Entry[]) => { setDirty(true); setEntriesRaw(e); };
  const [search, setSearch] = useState('');
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [refTeamId, setRefTeamId] = useState('');
  const [refPlayers, setRefPlayers] = useState<Player[]>([]);
  const [showRef, setShowRef] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // cargar lineup existente (activos, en orden) — solo si no hay ediciones
  // pendientes; al cambiar de equipo/juego se resetea el flag
  useEffect(() => { setDirty(false); }, [teamId, game.id]);
  useEffect(() => {
    if (dirty) return;
    const mine = (game.lineups ?? [])
      .filter((l) => l.teamId === teamId && l.active)
      .sort((a, b) => a.order - b.order);
    setEntriesRaw(mine.map((l) => ({
      playerId: l.playerId,
      position: l.position,
      batsInOrder: l.batsInOrder !== false,
      player: l.player ?? ({ id: l.playerId } as Player),
    })));
  }, [game.lineups, teamId, dirty]);

  useEffect(() => { api.teams().then(setAllTeams).catch(() => {}); }, []);
  useEffect(() => {
    if (refTeamId) api.team(refTeamId).then((t) => setRefPlayers(t.players ?? [])).catch(() => {});
    else setRefPlayers([]);
  }, [refTeamId]);

  const inLineup = useMemo(() => new Set(entries.map((e) => e.playerId)), [entries]);

  const pool: { player: Player; refuerzo: boolean }[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    const match = (p: Player) =>
      !q || `${p.firstName} ${p.lastName} ${p.number ?? ''}`.toLowerCase().includes(q);
    const own = (ownTeam?.players ?? []).filter((p) => p.active && !inLineup.has(p.id) && match(p))
      .map((player) => ({ player, refuerzo: false }));
    const refs = (showRef ? refPlayers : []).filter((p) => p.active && !inLineup.has(p.id) && match(p))
      .map((player) => ({ player, refuerzo: true }));
    return [...own, ...refs];
  }, [ownTeam, refPlayers, inLineup, search, showRef]);

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= entries.length) return;
    const c = [...entries];
    [c[i], c[j]] = [c[j], c[i]];
    setEntries(c);
  };

  const hasPitcher = entries.some((e) => e.position === 'P');

  // ── "Mis Alineaciones": plantillas nombradas del equipo — cada una con su
  // propio id; guardar una ya no borra la anterior (bug viejo: slot único).
  const [tpls, setTpls] = useState<LineupTpl[]>([]);
  const [showTpls, setShowTpls] = useState(false);
  const [tplName, setTplName] = useState('');
  const [loadedTplId, setLoadedTplId] = useState(''); // plantilla cargada — Guardar la sobrescribe
  useEffect(() => { setTpls(parseLineupTpls(ownTeam?.lineupTemplate)); }, [ownTeam?.lineupTemplate]);

  const saveTemplate = async () => {
    try {
      const tpl = entries.map((e) => ({ playerId: e.playerId, position: e.position, batsInOrder: e.batsInOrder }));
      const name = tplName.trim() || undefined;
      const r = await api.saveLineupTemplate(game.id, teamId, tpl, { name, tplId: loadedTplId || undefined });
      setTpls(r.templates);
      if (r.tplId) setLoadedTplId(r.tplId);
      setTplName('');
      setErr(`✓ Alineación guardada (${r.templates.find((t) => t.id === r.tplId)?.name ?? 'nueva'}) — la reutilizas en cualquier juego`);
    } catch (e) { setErr((e as Error).message); }
  };

  const loadTemplate = (tpl: LineupTpl) => {
    const byId = new Map<string, Player>();
    for (const p of [...(ownTeam?.players ?? []), ...refPlayers]) byId.set(p.id, p);
    const loaded = tpl.entries
      .filter((t) => byId.has(t.playerId))
      .map((t) => ({ playerId: t.playerId, position: t.position, batsInOrder: t.batsInOrder !== false, player: byId.get(t.playerId)! }));
    if (loaded.length < tpl.entries.length) setErr(`⚠ ${tpl.entries.length - loaded.length} jugador(es) de la plantilla ya no están en el roster`);
    else setErr('');
    setEntries(loaded);
    setLoadedTplId(tpl.id);
  };

  const delTemplate = async (tplId: string) => {
    try {
      const r = await api.deleteLineupTemplate(game.id, teamId, tplId);
      setTpls(r.templates);
      if (loadedTplId === tplId) setLoadedTplId('');
    } catch (e) { setErr((e as Error).message); }
  };

  const dupTemplate = async (tpl: LineupTpl) => {
    try {
      const r = await api.saveLineupTemplate(game.id, teamId, tpl.entries, { name: `${tpl.name} (copia)` });
      setTpls(r.templates);
    } catch (e) { setErr((e as Error).message); }
  };

  const renTemplate = async (tpl: LineupTpl) => {
    const name = window.prompt('Nombre de la alineación:', tpl.name)?.trim();
    if (!name) return;
    try {
      const r = await api.renameLineupTemplate(game.id, teamId, tpl.id, name);
      setTpls(r.templates);
    } catch (e) { setErr((e as Error).message); }
  };

  const save = async () => {
    if (!hasPitcher) { setErr('⚠️ Define el lanzador abridor: marca a alguien con posición P'); return; }
    setErr('');
    setSaving(true);
    try {
      let order = 0;
      await api.setLineup(game.id, teamId, entries.map((e) => ({
        playerId: e.playerId,
        position: e.position,
        batsInOrder: e.batsInOrder,
        order: e.batsInOrder ? ++order : 99, // los que no batean no ocupan turno
      })));
      setDirty(false); // ya persistió — el próximo reload puede resincronizar
      onSaved();
    } catch (e) { setErr(`✕ No se guardó: ${(e as Error).message}`); }
    finally { setSaving(false); }
  };

  return (
    <div className="card lineup-builder">
      <h2>{ownTeam?.name} — Alineación</h2>
      <div className="lb-grid">
        {/* Pool de jugadores */}
        <div className="lb-pool">
          <input
            className="lb-search"
            placeholder="🔍 Buscar por nombre o #..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="lb-pool-list">
            {pool.map(({ player, refuerzo }) => (
              <button
                key={player.id}
                className={`pool-item ${refuerzo ? 'ref' : ''}`}
                onClick={() => setEntries([...entries, { playerId: player.id, position: 'DH', batsInOrder: true, player }])}
              >
                <span className="pool-num">{player.number ?? '—'}</span>
                <span className="pool-name">{player.firstName} {player.lastName}</span>
                {refuerzo && <span className="pill ref-pill">REF</span>}
                <span className="muted" style={{ fontSize: '0.78rem' }}>{player.positions}</span>
              </button>
            ))}
            {pool.length === 0 && <p className="muted" style={{ padding: '0.5rem' }}>Sin jugadores disponibles</p>}
          </div>
          <div className="lb-ref">
            <label className="row" style={{ gap: '0.4rem' }}>
              <input type="checkbox" checked={showRef} onChange={(e) => setShowRef(e.target.checked)} />
              <strong>Agregar refuerzo</strong>
            </label>
            {showRef && (
              <select value={refTeamId} onChange={(e) => setRefTeamId(e.target.value)} style={{ width: '100%', marginTop: '0.4rem' }}>
                <option value="">— Elige el equipo del refuerzo —</option>
                {allTeams.filter((t) => t.id !== teamId
                  && (!game.leagueId || t.leagueId === game.leagueId)).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            )}
          </div>
        </div>

        {/* Lineup ordenado */}
        <div className="lb-lineup">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted">{entries.filter((e) => e.batsInOrder).length} en el orden</span>
            {!hasPitcher && entries.length > 0 && <span style={{ color: 'var(--red)', fontSize: '0.8rem', fontWeight: 600 }}>⚠ falta lanzador (P)</span>}
            <span className="row" style={{ gap: '0.4rem' }}>
              <button className="secondary" onClick={() => setShowTpls(!showTpls)} title="Alineaciones guardadas del equipo — cargar, duplicar, renombrar">
                📋 Mis alineaciones{tpls.length ? ` (${tpls.length})` : ''}
              </button>
              <input placeholder="Nombre al guardar…" value={tplName} onChange={(e) => setTplName(e.target.value)}
                style={{ width: 130 }} title="Nombre de la alineación (opcional)" />
              <button className="secondary" onClick={saveTemplate} disabled={entries.length === 0}
                title={loadedTplId ? `Sobrescribe la plantilla "${tpls.find((t) => t.id === loadedTplId)?.name ?? 'plantilla'}" — no graba el juego` : 'Guarda como PLANTILLA reutilizable — no graba el juego'}>
                💾 Guardar plantilla
              </button>
              <button onClick={save} disabled={saving || entries.length === 0}
                title="Graba la alineación de ESTE juego">
              {saving ? 'Guardando…' : '✓ Guardar alineación'}
              </button>
            </span>
          </div>
          {showTpls && (
            <div className="card" style={{ margin: '0.4rem 0', padding: '0.6rem 0.8rem', background: 'var(--bg, #f6f8fa)' }}>
              {!tpls.length && <p className="muted" style={{ margin: 0 }}>No hay alineaciones guardadas — arma una y dale 💾 con su nombre.</p>}
              {tpls.map((t) => (
                <div key={t.id} className="row" style={{ justifyContent: 'space-between', padding: '0.25rem 0', borderBottom: '1px solid var(--border, #e2e8f0)' }}>
                  <span>
                    <strong>{t.name}</strong>
                    <span className="muted" style={{ marginLeft: 8, fontSize: '0.78rem' }}>
                      {t.entries.length} jugadores{t.at ? ` · ${new Date(t.at).toLocaleDateString('es')}` : ''}
                      {loadedTplId === t.id ? ' · ✔ cargada' : ''}
                    </span>
                  </span>
                  <span className="row" style={{ gap: '0.3rem' }}>
                    <button className="secondary" style={{ padding: '0.1rem 0.5rem' }} onClick={() => loadTemplate(t)}>⤓ Usar</button>
                    <button className="secondary" style={{ padding: '0.1rem 0.5rem' }} onClick={() => renTemplate(t)} title="Renombrar">✏️</button>
                    <button className="secondary" style={{ padding: '0.1rem 0.5rem' }} onClick={() => dupTemplate(t)} title="Duplicar">⧉</button>
                    <button className="secondary danger" style={{ padding: '0.1rem 0.5rem' }}
                      onClick={() => { if (window.confirm(`¿Borrar la alineación "${t.name}"?`)) void delTemplate(t.id); }} title="Eliminar">🗑</button>
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="lb-entries">
            {entries.map((e, i) => {
              const batNum = entries.slice(0, i + 1).filter((x) => x.batsInOrder).length;
              return (
              <div key={e.playerId} className={`lb-entry ${e.batsInOrder ? '' : 'lb-nobat'}`}>
                <span className="lb-order">{e.batsInOrder ? batNum : '—'}</span>
                <span className="lb-name">
                  {pname(e.player)}
                  {e.player.teamId && e.player.teamId !== teamId && <span className="pill ref-pill">REF</span>}
                  {!e.batsInOrder && <span className="pill" style={{ background: '#fef3c7', color: '#92400e', marginLeft: '0.4rem' }}>solo lanza</span>}
                </span>
                {e.position === 'P' && (
                  <label className="lb-bats" title="¿Batea en el orden?">
                    <input type="checkbox" checked={e.batsInOrder} onChange={(ev) => {
                      const c = [...entries]; c[i] = { ...e, batsInOrder: ev.target.checked }; setEntries(c);
                    }} />
                    batea
                  </label>
                )}
                <select value={e.position} onChange={(ev) => {
                  const c = [...entries]; c[i] = { ...e, position: ev.target.value }; setEntries(c);
                }}>
                  {POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <span className="lb-actions">
                  <button className="icon" onClick={() => move(i, -1)} title="Subir">↑</button>
                  <button className="icon" onClick={() => move(i, 1)} title="Bajar">↓</button>
                  <button className="icon danger" onClick={() => setEntries(entries.filter((_, j) => j !== i))} title="Quitar">✕</button>
                </span>
              </div>
              );
            })}
            {entries.length === 0 && <p className="muted">Toca jugadores de la izquierda para armar el orden de bateo.</p>}
          </div>
          {err && <p style={{ color: 'var(--red)', marginTop: '0.5rem' }}>{err}</p>}
        </div>
      </div>
    </div>
  );
}
