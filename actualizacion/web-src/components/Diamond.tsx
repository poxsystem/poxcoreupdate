import type { BaseState } from '@poxscore/shared';

interface Props {
  bases: BaseState;
  outs: number;
  /** mapa playerId -> etiqueta corta (ej. "#7") */
  labels: Record<string, string>;
}

/** Diamante SVG con corredores, outs e indicador visual */
export default function Diamond({ bases, outs, labels }: Props) {
  const base = (x: number, y: number, occupied: string | null, key: number) => (
    <g key={key}>
      <rect
        x={x - 13} y={y - 13} width={26} height={26}
        transform={`rotate(45 ${x} ${y})`}
        fill={occupied ? '#e6a800' : '#fff'}
        stroke={occupied ? '#b07c00' : '#999'} strokeWidth={2}
      />
      {occupied && (
        <text x={x} y={y + 26} textAnchor="middle" fontSize={12} fontWeight={700} fill="#333">
          {labels[occupied] ?? '?'}
        </text>
      )}
    </g>
  );

  return (
    <div className="diamond-wrap">
      <svg viewBox="0 0 220 190" width="100%" style={{ maxWidth: 210 }}>
        {/* jardín */}
        <path d="M110 18 A 110 110 0 0 1 202 130 L 110 160 Z" fill="#a5d6a7" transform="rotate(-45 110 130)" opacity={0.35} />
        {/* cuadro */}
        <path d="M110 40 L 175 105 L 110 170 L 45 105 Z" fill="#d7ccc8" />
        <path d="M110 40 L 175 105 L 110 170 L 45 105 Z" fill="none" stroke="#8d6e63" strokeWidth={2} />
        {/* líneas de foul */}
        <line x1={110} y1={170} x2={20} y2={80} stroke="#fff" strokeWidth={2} />
        <line x1={110} y1={170} x2={200} y2={80} stroke="#fff" strokeWidth={2} />
        {base(175, 105, bases[1], 1)}
        {base(110, 40, bases[2], 2)}
        {base(45, 105, bases[3], 3)}
        {/* home */}
        <rect x={97} y={157} width={26} height={26} transform="rotate(45 110 170)" fill="#fff" stroke="#999" strokeWidth={2} />
      </svg>
      <div className="row" style={{ justifyContent: 'center', gap: '0.3rem' }}>
        {[0, 1, 2].map((i) => (
          <span key={i} style={{
            width: 16, height: 16, borderRadius: '50%', display: 'inline-block',
            background: i < outs ? '#c62828' : '#e0e0e0', border: '1px solid #999',
          }} />
        ))}
        <span className="muted" style={{ marginLeft: 6 }}>outs</span>
      </div>
    </div>
  );
}
