import { useState } from 'react';

// Coordenadas del campo (mismo viewBox 500×415 que SprayChart)
const POS_XY: Record<string, [number, number]> = {
  P: [250, 305], C: [250, 388], '1B': [332, 295], '2B': [305, 225], '3B': [168, 295],
  SS: [195, 225], LF: [118, 100], CF: [250, 66], RF: [382, 100], JC: [222, 128],
};

/** Posiciones que paran en el terreno (el resto del lineup activo va al panel lateral: EH/DH/banca) */
export const FIELD_POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'JC'];

interface Entry { playerId: string; position: string; order: number; }

interface Props {
  lineup: Entry[];                            // entradas activas del equipo que defiende
  labelOf: (pid: string) => string;           // "#22 Reyes" etc.
  softball?: boolean;                         // incluye JC
  defMap: Record<string, string>;             // posición → playerId
  onChange: (m: Record<string, string>) => void;
}

export default function DefenseBoard({ lineup, labelOf, softball, defMap, onChange }: Props) {
  const [sel, setSel] = useState<string | null>(null);
  const spots = softball ? FIELD_POSITIONS : FIELD_POSITIONS.filter((p) => p !== 'JC');
  const onField = new Set(Object.values(defMap));
  const bench = lineup.filter((l) => !onField.has(l.playerId));
  const posOf = (pid: string) => Object.keys(defMap).find((k) => defMap[k] === pid);

  // mueve pid a toPos; si había alguien ahí, toma el puesto que dejó pid (intercambio) o va a la banca
  const move = (pid: string, toPos: string) => {
    const m = { ...defMap };
    const fromPos = posOf(pid);
    const displaced = m[toPos];
    if (fromPos) delete m[fromPos];
    m[toPos] = pid;
    if (displaced && displaced !== pid && fromPos) m[fromPos] = displaced;
    onChange(m);
  };

  const clickPos = (pos: string) => {
    if (sel) { move(sel, pos); setSel(null); }
  };

  const clickChip = (pid: string) => {
    if (!sel) { setSel(pid); return; }
    if (sel === pid) { setSel(null); return; }
    // tocar otro jugador = intercambiar puestos (o banca↔campo)
    const m = { ...defMap };
    const posSel = posOf(sel);
    const posPid = posOf(pid);
    if (posSel) m[posSel] = pid;
    if (posPid) m[posPid] = sel;
    onChange(m);
    setSel(null);
  };

  return (
    <div className="def-board-wrap">
      <div className="def-board">
        <svg viewBox="0 0 500 415" className="def-svg" role="img" aria-label="Terreno de juego">
          <path d="M35 138 A320 320 0 0 1 465 138 L250 375 Z" fill="#4e9a51" opacity="0.5" />
          <line x1="250" y1="375" x2="35" y2="138" stroke="#e5e7eb" strokeWidth="2.5" />
          <line x1="250" y1="375" x2="465" y2="138" stroke="#e5e7eb" strokeWidth="2.5" />
          <path d="M35 138 A320 320 0 0 1 465 138" fill="none" stroke="#e5e7eb" strokeWidth="2.5" />
          <path d="M250 375 L332 295 L250 215 L168 295 Z" fill="#d9b382" opacity="0.8" stroke="#fff" strokeWidth="1.5" />
          <circle cx="250" cy="305" r="9" fill="#d9b382" stroke="#fff" strokeWidth="1.5" />
          <circle cx="250" cy="305" r="3" fill="#fff" />
          {([[332, 295], [250, 215], [168, 295]] as const).map(([x, y], i) => (
            <rect key={i} x={x - 5} y={y - 5} width="10" height="10" transform={`rotate(45 ${x} ${y})`} fill="#fff" />
          ))}
          <path d="M244 375 h12 l-2 8 h-8 Z" fill="#fff" />
        </svg>
        {spots.map((pos) => {
          const [x, y] = POS_XY[pos];
          const pid = defMap[pos];
          return pid ? (
            <button key={pos} type="button"
              className={`def-chip${sel === pid ? ' sel' : ''}`}
              style={{ left: `${(x / 500) * 100}%`, top: `${(y / 415) * 100}%` }}
              onClick={() => clickChip(pid)} title={`${pos} — ${labelOf(pid)}`}>
              <span className="def-pos">{pos}</span>
              <span className="def-name">{labelOf(pid)}</span>
            </button>
          ) : (
            <button key={pos} type="button"
              className={`def-spot${sel ? ' target' : ''}`}
              style={{ left: `${(x / 500) * 100}%`, top: `${(y / 415) * 100}%` }}
              onClick={() => clickPos(pos)} title={`${pos} — libre`}>
              {pos}
            </button>
          );
        })}
      </div>
      <div className="def-side">
        <div className="section-label">Designados / banca</div>
        {bench.map((l) => (
          <button key={l.playerId} type="button"
            className={`def-chip side${sel === l.playerId ? ' sel' : ''}`}
            onClick={() => clickChip(l.playerId)}>
            <span className="def-pos">{l.order < 50 ? `#${l.order}` : (l.position || '—')}</span>
            <span className="def-name">{labelOf(l.playerId)}{l.position && l.position !== '—' ? ` · ${l.position}` : ''}</span>
          </button>
        ))}
        {!bench.length && <p className="muted" style={{ fontSize: '0.78rem' }}>Todo el lineup está en el terreno.</p>}
        <p className="muted" style={{ fontSize: '0.75rem', marginTop: '0.6rem' }}>
          Toca un jugador y luego la posición destino — o toca a otro jugador para intercambiar.
          Los errores y fildeo se cargan a quien ocupe cada posición.
        </p>
      </div>
    </div>
  );
}
