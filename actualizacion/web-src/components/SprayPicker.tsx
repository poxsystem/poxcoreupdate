import { useMemo } from 'react';

export interface SprayPick {
  dir: number;   // grados desde CF: -45 línea LF · 0 CF · +45 línea RF · |dir|>45 = foul
  dist: number;  // % del muro por esa dirección (100 = muro, >100 = fuera)
  loc: number;   // posición de fildeo más cercana (1-9, 10=JC) — llena la notación
  x: number; y: number; // punto en el espacio 1000×1000
  foul: boolean;
}

interface Props {
  result: string; // categoría del color: 1B/2B/3B/HR | resto = out
  picked?: { x: number; y: number } | null;
  onPick: (p: SprayPick) => void;
  onClear?: () => void;
}

// geometría del campo (espacio 1000×1000, home plate en 500,850)
const HOME = { x: 500, y: 850 };
const WALL_R = 600;

const CAT_COLOR: Record<string, string> = {
  '1B': '#f97316', '2B': '#7c3aed', '3B': '#eab308', HR: '#db2777',
};
const colorOf = (result: string) => CAT_COLOR[result] ?? '#64748b'; // out/error = gris

// puesto de cada fildeador en el campo (numeración oficial; 10 = JC softball)
const POS: Record<number, [number, number]> = {
  1: [500, 740], 2: [500, 895], 3: [590, 770], 4: [585, 710], 5: [410, 770],
  6: [415, 710], 7: [330, 560], 8: [500, 470], 9: [670, 560], 10: [500, 615],
};

// cuadrícula de la hoja de papel — los círculos del boceto (espacio 1000×1000)
const CIRCLES: [number, number][] = [
  // cuadro interior
  [500, 800], [460, 760], [540, 760], [500, 730], [430, 730], [570, 730], [400, 710], [600, 710], [500, 680],
  // prados medios
  [350, 620], [430, 620], [500, 600], [570, 620], [650, 620],
  [320, 580], [400, 570], [480, 560], [560, 560], [680, 580],
  [300, 530], [380, 520], [460, 510], [540, 510], [620, 520], [700, 530],
  [280, 480], [360, 470], [440, 460], [500, 450], [560, 460], [640, 470], [720, 480],
  [260, 430], [340, 420], [420, 410], [500, 400], [580, 410], [660, 420], [740, 430],
  [250, 380], [330, 370], [410, 360], [500, 350], [590, 360], [670, 370], [750, 380],
  [300, 330], [390, 320], [500, 310], [610, 320], [700, 330],
  // detrás del muro — dirección del jonrón
  [120, 520], [160, 460], [200, 410], [240, 360], [280, 320], [330, 280], [380, 250], [430, 230],
  [500, 220], [570, 230], [620, 250], [670, 280], [720, 320], [760, 360], [800, 410], [840, 460], [880, 520],
  [100, 580], [140, 540], [180, 500], [800, 500], [860, 540], [900, 580],
  // fuera de las líneas de foul
  [80, 600], [120, 640], [160, 680], [200, 720], [240, 760], [280, 800], [320, 830], [360, 860],
  [640, 860], [680, 830], [720, 800], [760, 760], [800, 720], [840, 680], [880, 640], [920, 600],
  [350, 900], [650, 900], [500, 930],
];

function polarOf(x: number, y: number): { dir: number; dist: number } {
  const dx = x - HOME.x, dy = HOME.y - y; // dy positivo = hacia el jardín
  const dir = Math.atan2(dx, dy) * 180 / Math.PI;
  const dist = Math.hypot(dx, dy) / WALL_R * 100;
  return { dir: Math.round(dir), dist: Math.round(dist) };
}

function nearestLoc(x: number, y: number, dir: number): number {
  // detrás del muro → jardinero de esa zona (LF/CF/RF)
  if (polarOf(x, y).dist > 100) return dir < -15 ? 7 : dir > 15 ? 9 : 8;
  let best = 8, bd = Infinity;
  for (const [n, [px, py]] of Object.entries(POS)) {
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bd) { bd = d; best = Number(n); }
  }
  return best;
}

/** Spray sheet emergente: toca el círculo donde cayó el batazo.
 *  El círculo elegido se pinta del color del resultado (hit/HR/out). */
export default function SprayPicker({ result, picked, onPick, onClear }: Props) {
  const color = colorOf(result);
  const items = useMemo(() => CIRCLES.map(([x, y], i) => {
    const { dir, dist } = polarOf(x, y);
    return { i, x, y, dir, dist, foul: Math.abs(dir) > 45, loc: nearestLoc(x, y, dir) };
  }), []);
  return (
    <div className="spray-pick">
      <div className="muted" style={{ fontSize: '0.78rem', display: 'flex', justifyContent: 'space-between' }}>
        <span>🎯 ¿Dónde cayó el batazo? <em>(opcional)</em></span>
        {picked && onClear && <button className="chip chip-ghost" onClick={onClear}>✕ quitar</button>}
      </div>
      <svg viewBox="0 60 1000 880" className="spray-pick-svg">
        {/* líneas de foul */}
        <line x1={HOME.x} y1={HOME.y} x2={500 - WALL_R * Math.SQRT1_2} y2={850 - WALL_R * Math.SQRT1_2} stroke="#94a3b8" strokeWidth="4" />
        <line x1={HOME.x} y1={HOME.y} x2={500 + WALL_R * Math.SQRT1_2} y2={850 - WALL_R * Math.SQRT1_2} stroke="#94a3b8" strokeWidth="4" />
        {/* muro del jardín (doble línea como la hoja) */}
        <path d={`M ${500 - WALL_R * Math.SQRT1_2} ${850 - WALL_R * Math.SQRT1_2} A ${WALL_R} ${WALL_R} 0 0 1 ${500 + WALL_R * Math.SQRT1_2} ${850 - WALL_R * Math.SQRT1_2}`} fill="none" stroke="#94a3b8" strokeWidth="4" />
        <path d={`M ${500 - 582 * Math.SQRT1_2} ${850 - 582 * Math.SQRT1_2} A 582 582 0 0 1 ${500 + 582 * Math.SQRT1_2} ${850 - 582 * Math.SQRT1_2}`} fill="none" stroke="#cbd5e1" strokeWidth="3" />
        {/* arco del cuadro */}
        <path d="M 360 750 A 200 200 0 0 1 640 750" fill="none" stroke="#cbd5e1" strokeWidth="3" />
        {/* diamante */}
        <path d="M500 850 L578 772 L500 694 L422 772 Z" fill="none" stroke="#94a3b8" strokeWidth="3" />
        <circle cx="500" cy="740" r="18" fill="none" stroke="#94a3b8" strokeWidth="3" />
        <rect x="496" y="737" width="8" height="3" fill="#94a3b8" />
        {/* bases + home */}
        {[578, 422].map((bx) => <rect key={bx} x={bx - 4} y="768" width="8" height="8" fill="#94a3b8" transform={`rotate(45 ${bx} 772)`} />)}
        <rect x="496" y="690" width="8" height="8" fill="#94a3b8" transform="rotate(45 500 694)" />
        <circle cx="500" cy="850" r="18" fill="none" stroke="#94a3b8" strokeWidth="3" />
        <rect x="494" y="846" width="12" height="6" fill="#94a3b8" />
        {/* posiciones tenues */}
        {Object.entries(POS).map(([n, [x, y]]) => (
          <text key={n} x={x} y={y} textAnchor="middle" dominantBaseline="middle"
            fontSize="26" fontWeight="700" fill="#0f766e" opacity="0.35">
            {{ 1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'JC' }[Number(n)]}
          </text>
        ))}
        {/* círculos clicables */}
        {items.map((c) => {
          const sel = picked && Math.abs(picked.x - c.x) < 1 && Math.abs(picked.y - c.y) < 1;
          return (
            <circle key={c.i} cx={c.x} cy={c.y} r={sel ? 15 : 12}
              fill={sel ? color : '#fff'} fillOpacity={sel ? 0.9 : 1}
              stroke={sel ? color : c.foul ? '#cbd5e1' : '#475569'} strokeWidth={sel ? 4 : 2.5}
              style={{ cursor: 'pointer' }}
              onClick={() => onPick({ dir: c.dir, dist: c.dist, loc: c.loc, x: c.x, y: c.y, foul: c.foul })} />
          );
        })}
      </svg>
      {picked && (
        <div className="muted" style={{ fontSize: '0.78rem', textAlign: 'center' }}>
          dirección {picked && items.find(c => Math.abs(c.x - picked.x) < 1 && Math.abs(c.y - picked.y) < 1)?.foul ? 'foul · ' : ''}
          {Math.round(items.find(c => Math.abs(c.x - picked.x) < 1)?.dist ?? 0)}% del muro
        </div>
      )}
    </div>
  );
}
