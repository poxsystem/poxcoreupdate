import type { PitchPoint } from '../api';

// celda (r,c) 0..4 → centro; zona de strike = celdas 1..3 × 1..3
const cx = (c: number) => 140 + (c - 0.5) * 40;   // c0=120 c1=160 … c4=280
const cy = (r: number) => 150 + (r - 0.5) * 60;   // r0=120 r1=180 … r4=360

const COLOR: Record<string, string> = {
  B: '#3b82f6',   // bola azul
  IPL: '#3b82f6',
  S: '#ef4444',   // strike rojo
  F: '#f59e0b',   // foul ámbar
  WP: '#14b8a6', PB: '#14b8a6', BK: '#14b8a6',
};
const LEGEND: [string, string][] = [
  ['Bola', '#3b82f6'], ['Strike', '#ef4444'], ['Foul', '#f59e0b'], ['Suelto', '#14b8a6'],
];
const jit = (i: number, k: number) => ((i * 29 + k * 41) % 15) - 7;

export default function ZoneChart({ points }: { points: PitchPoint[] }) {
  return (
    <div className="spray-wrap">
      <svg viewBox="0 0 400 430" className="spray-svg" role="img" aria-label="Mapa de zona de pitcheos">
        {/* zona de strike 3×3 */}
        <rect x="140" y="150" width="120" height="180" fill="#f8fafc" stroke="#334155" strokeWidth="2" />
        {[1, 2].map((i) => (
          <g key={i} stroke="#94a3b8" strokeWidth="1">
            <line x1={140 + i * 40} y1="150" x2={140 + i * 40} y2="330" />
            <line x1="140" y1={150 + i * 60} x2="260" y2={150 + i * 60} />
          </g>
        ))}
        {/* plato debajo */}
        <path d="M188 372 h24 l6 6 -18 20 -18 -20 Z" fill="#fff" stroke="#94a3b8" />
        {/* pitcheos */}
        {points.map((p, i) => (
          <circle key={i} cx={cx(p.c) + jit(i, 0)} cy={cy(p.r) + jit(i, 1)} r="5"
            fill={COLOR[p.result] ?? '#64748b'} fillOpacity="0.8" stroke="#fff" strokeWidth="1" />
        ))}
      </svg>
      <div className="spray-legend">
        {LEGEND.map(([label, color]) => (
          <span key={label} className="spray-leg"><span className="spray-dot" style={{ background: color }} /> {label}</span>
        ))}
        <span className="spray-leg muted">{points.length} pitcheos localizados</span>
      </div>
    </div>
  );
}
