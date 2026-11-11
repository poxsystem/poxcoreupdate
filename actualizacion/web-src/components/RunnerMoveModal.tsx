import { useState } from 'react';
import type { Advance, AdvanceTo, BaseState } from '@poxscore/shared';

interface Props {
  bases: BaseState;
  /** mapa playerId -> etiqueta corta ("#22 Reyes") */
  labels: Record<string, string>;
  onConfirm: (result: string, advances: Advance[], notation: string | null) => void;
  onCancel: () => void;
}

// motivos del movimiento — resultado mid-play que se graba
const REASONS: { r: string; label: string; hint: string }[] = [
  { r: 'SB', label: 'Robo', hint: 'se estafó la base' },
  { r: 'CS', label: 'Out robando', hint: 'lo atraparon' },
  { r: 'WP', label: 'Wild pitch', hint: 'pitcheo suelto' },
  { r: 'PB', label: 'Passed ball', hint: 'se le fue al receptor' },
  { r: 'BK', label: 'Balk', hint: 'ilegal del lanzador' },
  { r: 'PK', label: 'Pickoff', hint: 'tiro del pitcher/ receptor' },
  { r: 'DI', label: 'Indiferencia', hint: 'la defensa lo dejó' },
  { r: 'DE', label: 'Error', hint: 'avanzó por error defensivo — elige E# abajo' },
  { r: 'T', label: 'Tiro', hint: 'avanzó por el tiro a otra base (ej. 7 al 2, 8 al 3)' },
  { r: 'LIB', label: 'Libre', hint: 'avanzó sin jugada — nadie lo provocó ni lo detuvo' },
];

/**
 * EN BASE — movimiento de corredores sin batazo.
 * Toca la base ocupada para elegir corredor, luego la base destino (u
 * "Anota"/"Out"), y abajo el motivo del movimiento.
 */
export default function RunnerMoveModal({ bases, labels, onConfirm, onCancel }: Props) {
  // destino elegido por corredor (por defecto se queda en su base)
  const [moves, setMoves] = useState<Record<string, AdvanceTo>>(() => {
    const m: Record<string, AdvanceTo> = {};
    for (const b of [1, 2, 3] as const) if (bases[b]) m[bases[b]!] = b;
    return m;
  });
  const [selPid, setSelPid] = useState<string | null>(null);
  const [notation, setNotation] = useState('');
  // avance por tiro: guante que tira y guante que recibe ("7-2" = del left al receptor)
  const [throwFrom, setThrowFrom] = useState<number | null>(null);
  const [throwTo, setThrowTo] = useState<number | null>(null);
  // motivo sugerido: si algún destino es OUT arranca en CS, si hay avance en SB
  const [reason, setReason] = useState<string>(() =>
    Object.values(moves).some((t) => t === 'OUT') ? 'CS' : 'SB');

  const runners = ([1, 2, 3] as const)
    .map((b) => ({ base: b, pid: bases[b]! }))
    .filter((r) => r.pid);

  const moved = Object.entries(moves).filter(([pid, to]) => {
    const from = runners.find((r) => r.pid === pid)?.base;
    return from !== to;
  });

  const pick = (pid: string) => setSelPid(pid === selPid ? null : pid);
  // ¿la base destino queda ocupada por OTRO corredor? → prohibido: el engine
  // sobrescribe el slot y el otro desaparecería del campo (corrupción de estado)
  const baseTaken = (b: AdvanceTo) =>
    Object.entries(moves).some(([pid, to]) => pid !== selPid && to === b);
  const moveTo = (to: AdvanceTo) => {
    if (!selPid || (typeof to === 'number' && baseTaken(to))) return;
    const from = runners.find((r) => r.pid === selPid)?.base;
    setMoves((m) => ({ ...m, [selPid]: from === to ? from! : to }));
    setSelPid(null);
    if (to === 'OUT') setReason('CS');
  };

  const confirm = () => {
    // solo los que se movieron — los que se quedan no van en el evento
    const not = reason === 'T'
      ? (throwFrom && throwTo ? `${throwFrom}-${throwTo}` : notation || null)
      : notation || null;
    onConfirm(reason, moved.map(([playerId, to]) => ({ playerId, to })), not);
  };

  // coordenadas del diamante (viewBox 220x190, igual que Diamond.tsx)
  const pos: Record<number, [number, number]> = { 1: [175, 105], 2: [110, 40], 3: [45, 105] };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>En base — movimiento de corredores</h2>
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Toca al corredor y luego su destino. Termina eligiendo el motivo.
        </p>
        <svg viewBox="0 0 220 190" width="100%" style={{ maxWidth: 280, display: 'block', margin: '0 auto' }}>
          <path d="M110 40 L 175 105 L 110 170 L 45 105 Z" fill="#d7ccc8" />
          <path d="M110 40 L 175 105 L 110 170 L 45 105 Z" fill="none" stroke="#8d6e63" strokeWidth={2} />
          {([1, 2, 3] as const).map((b) => {
            const [x, y] = pos[b];
            const pid = bases[b];
            const sel = pid && pid === selPid;
            return (
              <g key={b} onClick={() => (pid ? pick(pid) : selPid && moveTo(b))} style={{ cursor: 'pointer' }}>
                <rect x={x - 16} y={y - 16} width={32} height={32} transform={`rotate(45 ${x} ${y})`}
                  fill={pid ? (sel ? '#2e7d32' : '#e6a800') : '#fff'}
                  stroke={sel ? '#1b5e20' : pid ? '#b07c00' : '#999'} strokeWidth={sel ? 3 : 2} />
                <text x={x} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill={pid ? '#fff' : '#999'}>
                  {b}ª
                </text>
                {pid && (
                  <text x={x} y={y + 30} textAnchor="middle" fontSize={11} fontWeight={700} fill="#333">
                    {labels[pid] ?? '?'}
                  </text>
                )}
              </g>
            );
          })}
          {/* home */}
          <g onClick={() => selPid && moveTo('HOME')} style={{ cursor: selPid ? 'pointer' : 'default' }}>
            <rect x={94} y={154} width={32} height={32} transform="rotate(45 110 170)"
              fill={selPid ? '#1e88e5' : '#fff'} stroke="#999" strokeWidth={2} />
            <text x={110} y={174} textAnchor="middle" fontSize={10} fontWeight={700} fill={selPid ? '#fff' : '#999'}>home</text>
          </g>
        </svg>
        {selPid && (
          <div className="row" style={{ justifyContent: 'center', gap: '0.4rem', marginTop: '0.3rem' }}>
            <strong>{labels[selPid]}</strong>
            {[1, 2, 3].map((b) => <button key={b} className="secondary sm" disabled={baseTaken(b as AdvanceTo)} onClick={() => moveTo(b as AdvanceTo)}>a {b}ª</button>)}
            <button className="secondary sm" onClick={() => moveTo('HOME')}>🏠 anota</button>
            <button className="danger" style={{ padding: '0.2rem 0.6rem' }} onClick={() => moveTo('OUT')}>✖ out</button>
          </div>
        )}
        {/* resumen de movimientos */}
        <div style={{ fontSize: '0.85rem', margin: '0.5rem 0', minHeight: '1.2rem' }}>
          {moved.length === 0
            ? <span className="muted">Sin movimientos aún</span>
            : moved.map(([pid, to]) => {
                const from = runners.find((r) => r.pid === pid)?.base;
                return <div key={pid}><strong>{labels[pid]}</strong>: {from}ª → {to === 'HOME' ? 'anota' : to === 'OUT' ? 'OUT' : `${to}ª`}</div>;
              })}
        </div>
        {/* motivo */}
        <div className="section-label">¿Por qué se movieron?</div>
        <div className="traj-chips" style={{ flexWrap: 'wrap' }}>
          {REASONS.map((r) => (
            <button key={r.r} title={r.hint} className={`chip chip-traj${reason === r.r ? ' sel' : ''}`}
              onClick={() => setReason(r.r)}>
              {r.label}
            </button>
          ))}
        </div>
        {reason === 'T' && (
          <>
            <div className="section-label">Tiro de…</div>
            <div className="traj-chips" style={{ flexWrap: 'wrap' }}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <button key={n} className={`chip chip-traj${throwFrom === n ? ' sel' : ''}`}
                  onClick={() => setThrowFrom(n)}>
                  {n}
                </button>
              ))}
            </div>
            <div className="section-label" style={{ marginTop: '0.4rem' }}>…a</div>
            <div className="traj-chips" style={{ flexWrap: 'wrap' }}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <button key={n} className={`chip chip-traj${throwTo === n ? ' sel' : ''}`}
                  onClick={() => setThrowTo(n)}>
                  {n}
                </button>
              ))}
            </div>
            <p className="muted" style={{ fontSize: '0.78rem', marginTop: '0.3rem' }}>
              {throwFrom && throwTo ? `Tiro ${throwFrom}-${throwTo}` : 'Ej.: del left (7) al receptor (2) → 7-2'}
            </p>
          </>
        )}
        {reason === 'DE' && (
          <div className="traj-chips" style={{ flexWrap: 'wrap', marginTop: '0.4rem' }}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <button key={n} className={`chip chip-traj${notation === `E${n}` ? ' sel' : ''}`}
                onClick={() => setNotation(`E${n}`)}>
                E{n}
              </button>
            ))}
          </div>
        )}
        <input placeholder="Combinación defensiva (opcional — ej. 2-6, 1-4-3)"
          value={notation} onChange={(e) => setNotation(e.target.value)}
          style={{ width: '100%', marginTop: '0.5rem', fontSize: '0.85rem' }} />
        <div className="row" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
          <button className="secondary" onClick={onCancel}>Cancelar</button>
          <button className="big" disabled={moved.length === 0 || (reason === 'DE' && !/E-?\d/.test(notation))} onClick={confirm}>Confirmar</button>
        </div>
      </div>
    </div>
  );
}
