import type { SprayPoint } from '../api';

// puesto de cada fildeador en el campo (numeración oficial; 10 = JC softball)
const POS: Record<number, [number, number]> = {
  1: [250, 305], 2: [250, 388], 3: [332, 295], 4: [305, 225], 5: [168, 295],
  6: [195, 225], 7: [118, 100], 8: [250, 66], 9: [382, 100], 10: [222, 128],
};
const POS_NAME: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'JC',
};

const CAT: Record<string, { color: string; label: string }> = {
  '1B': { color: '#f97316', label: 'Sencillo' },
  '2B': { color: '#7c3aed', label: 'Doble' },
  '3B': { color: '#eab308', label: 'Triple' },
  'HR': { color: '#db2777', label: 'Jonrón' },
  OUT: { color: '#94a3b8', label: 'Out / error' },
};
const catOf = (result: string) => CAT[result] ?? CAT.OUT;

// trayectoria del batazo: G=rola ●, L=línea ◆, F=elevado ▲, sin dato ○
const TRAJ_LABEL: Record<string, string> = { G: 'Rolado', L: 'Línea', F: 'Elevado' };

function TrajDot({ x, y, traj, color }: { x: number; y: number; traj?: string | null; color: string }) {
  if (traj === 'L') return <rect x={x - 4.5} y={y - 4.5} width="9" height="9" transform={`rotate(45 ${x} ${y})`} fill={color} fillOpacity="0.85" stroke="#fff" strokeWidth="1" />;
  if (traj === 'F') return <polygon points={`${x},${y - 6} ${x - 5.5},${y + 4} ${x + 5.5},${y + 4}`} fill={color} fillOpacity="0.85" stroke="#fff" strokeWidth="1" />;
  if (traj === 'G') return <circle cx={x} cy={y} r="5" fill={color} fillOpacity="0.85" stroke="#fff" strokeWidth="1" />;
  return <circle cx={x} cy={y} r="5" fill={color} fillOpacity="0.25" stroke={color} strokeWidth="1.5" />;
}

// jitter determinista para que puntos en la misma posición no se encimen
const jit = (i: number, k: number) => ((i * 37 + k * 53) % 17) - 8;

export default function SprayChart({ points, hitsOnly }: { points: SprayPoint[]; hitsOnly?: boolean }) {
  const pts = hitsOnly ? points.filter((p) => CAT[p.result]) : points;
  const tg = pts.filter((p) => p.traj === 'G').length;
  const tl = pts.filter((p) => p.traj === 'L').length;
  const tf = pts.filter((p) => p.traj === 'F').length;
  const tKnown = tg + tl + tf;
  return (
    <div className="spray-wrap">
      <svg viewBox="0 0 500 415" className="spray-svg" role="img" aria-label="Spray chart">
        {/* jardín */}
        <path d="M35 138 A320 320 0 0 1 465 138 L250 375 Z" fill="#7fd4c9" opacity="0.55" />
        {/* líneas de foul */}
        <line x1="250" y1="375" x2="35" y2="138" stroke="#e5e7eb" strokeWidth="2.5" />
        <line x1="250" y1="375" x2="465" y2="138" stroke="#e5e7eb" strokeWidth="2.5" />
        {/* arco del jardín */}
        <path d="M35 138 A320 320 0 0 1 465 138" fill="none" stroke="#e5e7eb" strokeWidth="2.5" />
        {/* cuadro interior */}
        <path d="M250 375 L332 295 L250 215 L168 295 Z" fill="#d9b382" opacity="0.8" stroke="#fff" strokeWidth="1.5" />
        <circle cx="250" cy="305" r="9" fill="#d9b382" stroke="#fff" strokeWidth="1.5" />
        {/* montículo y bases */}
        <circle cx="250" cy="305" r="3" fill="#fff" />
        {([[332, 295], [250, 215], [168, 295]] as const).map(([x, y], i) => (
          <rect key={i} x={x - 5} y={y - 5} width="10" height="10" transform={`rotate(45 ${x} ${y})`} fill="#fff" />
        ))}
        <path d="M244 375 h12 l-2 8 h-8 Z" fill="#fff" />
        {/* posiciones tenues */}
        {Object.entries(POS).map(([n, [x, y]]) => (
          <text key={n} x={x} y={y} textAnchor="middle" dominantBaseline="middle"
            fontSize="13" fontWeight="700" fill="#0f766e" opacity="0.4">{POS_NAME[Number(n)]}</text>
        ))}
        {/* batazos — ubicación fina (sprayDir/sprayDist) si la hay; si no, posición */}
        {pts.map((p, i) => {
          let x: number, y: number;
          if (p.dir != null && p.dist != null) {
            // proyección polar en esta geometría: home=(250,375), muro R=320
            const rad = (p.dir * Math.PI) / 180;
            const r = (Math.min(p.dist, 118) / 100) * 320; // pinchado en el borde si sale del parque
            x = 250 + r * Math.sin(rad); y = 375 - r * Math.cos(rad);
          } else {
            const [bx, by] = POS[p.loc] ?? POS[8];
            x = bx + jit(i, 0); y = by + jit(i, 1);
          }
          return <TrajDot key={i} x={x} y={y} traj={p.traj} color={catOf(p.result).color} />;
        })}
      </svg>
      <div className="spray-legend">
        {Object.values(CAT).map((c) => (
          <span key={c.label} className="spray-leg">
            <span className="spray-dot" style={{ background: c.color }} /> {c.label}
          </span>
        ))}
        <span className="spray-leg muted">{pts.length} batazos localizados</span>
      </div>
      {tKnown > 0 && (
        <div className="spray-legend">
          {(['G', 'L', 'F'] as const).map((t) => (
            <span key={t} className="spray-leg">
              <svg width="12" height="12" viewBox="-6 -6 12 12"><TrajDot x={0} y={0} traj={t} color="#475569" /></svg>
              {' '}{TRAJ_LABEL[t]} {Math.round((pts.filter((p) => p.traj === t).length / tKnown) * 100)}%
            </span>
          ))}
          {pts.length - tKnown > 0 && <span className="spray-leg muted">○ sin dato: {pts.length - tKnown}</span>}
        </div>
      )}
    </div>
  );
}
