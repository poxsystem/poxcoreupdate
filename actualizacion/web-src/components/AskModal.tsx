import { useRef, useState } from 'react';
import { api } from '../api';
import { Link } from 'react-router-dom';

interface Msg { q: string; a: string; filter: string | null; players: { id: string; name: string; team: string; value: number | null; line?: string }[]; stat: string | null }

const EXAMPLES = [
  '¿Quién tiene más dobles entre Ulises Herrera y Juan Colón?',
  '¿Cuánto batea Manuel siendo 4to bate?',
  '¿Cómo batea Pedro con hombres en posición de anotar?',
  '¿Cuánto le batea Colón al pitcher Mendoza?',
  '¿Cómo ha estado Soto en sus últimos 5 juegos?',
  '¿Quién tiene mejor OPS, Alexis o Rafael?',
  '¿Cuánto batea con bases llenas y 2 outs?',
  '¿Cuál es el BABIP de Herrera?',
];

const RATE = ['avg', 'obp', 'slg', 'ops', 'iso', 'babip', 'bbp', 'kp', 'woba'];
const fmtVal = (stat: string | null, v: number) =>
  stat && RATE.includes(stat) ? v.toFixed(3).replace(/^0/, '') : ['era', 'whip'].includes(stat ?? '') ? v.toFixed(2) : stat === 'bbp' || stat === 'kp' ? `${(v * 100).toFixed(1)}%` : String(Math.round(v));

/**
 * Módulo 8 — Asistente de consultas: pregunta en dominicano sobre datos y
 * estadísticas ("quién tiene más 2b entre X e Y") → POST /ai/ask → respuesta
 * con los números reales calculados del acumulado del jugador.
 */
export default function AskModal({ onClose }: { onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const ask = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setQ('');
    try {
      const r = await api.aiAsk(t);
      setMsgs((m) => [...m, { q: t, a: r.answer, filter: r.filter, players: r.players, stat: r.stat }]);
    } catch (e) {
      setMsgs((m) => [...m, { q: t, a: `Error: ${(e as Error).message}`, filter: null, players: [], stat: null }]);
    } finally {
      setBusy(false);
      setTimeout(() => listRef.current?.scrollTo({ top: 99999, behavior: 'smooth' }), 50);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540, width: '95vw' }}>
        <h2>🤖 Pregunta al anotador</h2>
        <p className="muted" style={{ fontSize: '0.82rem', marginTop: '-0.3rem' }}>
          Pregunta sobre jugadores y estadísticas en dominicano:
        </p>
        <div className="ask-examples">
          {EXAMPLES.map((e) => <button key={e} className="ask-chip" onClick={() => ask(e)}>{e}</button>)}
        </div>
        <div className="ask-log" ref={listRef}>
          {msgs.length === 0 && <p className="muted" style={{ textAlign: 'center', marginTop: '1rem' }}>Las respuestas aparecen aquí…</p>}
          {msgs.map((m, i) => (
            <div key={i}>
              <div className="ask-q">{m.q}</div>
              <div className="ask-a">
                {m.filter && <div className="ask-filter">📊 {m.filter}</div>}
                {m.a}
                {m.players.length > 0 && m.players.some((p) => p.value != null || p.line) && (
                  <div className="ask-table">
                    {m.players.map((p) => (
                      <div key={p.id} className="ask-prow">
                        <Link to={`/players/${p.id}`} onClick={onClose}>{p.name}</Link>
                        <span className="muted">{p.team}</span>
                        {p.line && <span className="muted" style={{ fontSize: '0.72rem' }}>{p.line}</span>}
                        {p.value != null && <b>{fmtVal(m.stat, p.value)}</b>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {busy && <div className="ask-a muted">Pensando…</div>}
        </div>
        <div className="row" style={{ gap: '0.4rem', marginTop: '0.5rem' }}>
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus
            onKeyDown={(e) => e.key === 'Enter' && ask(q)}
            placeholder="Ej: ¿quién tiene más triples entre…?" style={{ flex: 1 }} />
          <button onClick={() => ask(q)} disabled={busy || !q.trim()}>Preguntar</button>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.5rem' }}>
          <button className="secondary" onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
