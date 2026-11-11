import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, PlayerSearchHit } from '../api';

/** Buscador global de jugadores en el topbar (esquina derecha). */
export default function PlayerSearch() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PlayerSearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();
  const box = useRef<HTMLDivElement>(null);

  // al cambiar de página se limpia y cierra
  useEffect(() => { setQ(''); setHits([]); setOpen(false); }, [loc.pathname]);

  // cerrar al hacer clic fuera
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // búsqueda con debounce
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); setBusy(false); return; }
    setBusy(true);
    const t = setTimeout(() => {
      api.searchPlayers(q.trim())
        .then((r) => { setHits(r); setOpen(true); })
        .catch(() => {})
        .finally(() => setBusy(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const go = (h: PlayerSearchHit) => {
    setOpen(false); setQ('');
    nav(`/players/${h.id}`);
  };

  return (
    <div className="topsearch" ref={box}>
      <input
        type="search"
        placeholder="🔎 Buscar jugador…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => hits.length && setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) go(hits[0]); if (e.key === 'Escape') setOpen(false); }}
      />
      {open && q.trim().length >= 2 && (
        <div className="topsearch-drop">
          {hits.map((h) => (
            <button key={h.id} className="topsearch-hit" onClick={() => go(h)}>
              <span className="pname">
                {h.number != null && <span className="muted">#{h.number} </span>}
                {h.firstName} {h.lastName}
              </span>
              <span className="muted">{h.team ?? '—'}{h.league ? ` · ${h.league}` : ''}{!h.active ? ' · BAJA' : ''}</span>
            </button>
          ))}
          {!hits.length && !busy && <div className="topsearch-hit muted">Sin resultados</div>}
        </div>
      )}
    </div>
  );
}
