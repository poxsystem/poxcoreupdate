export interface MicBases { base: 1 | 2 | 3; name: string }
export interface MicCtxData {
  batter?: string;
  pitcher?: string;
  bases?: MicBases[];
}

/**
 * Encabezado de contexto del juego para las pantallas de voz:
 * pitcher que lanza, bateador de turno y mini diamante con los nombres
 * de los corredores en cada base.
 */
export default function MicCtx({ batter, pitcher, bases = [] }: MicCtxData) {
  const onBase = (b: number) => bases.find((r) => r.base === b)?.name;
  return (
    <div className="mic-ctx">
      <div className="mic-ctx-info">
        <div><span className="mic-ctx-tag">P</span> {pitcher ?? '—'}</div>
        <div><span className="mic-ctx-tag bat">Al bate</span> {batter ?? '—'}</div>
      </div>
      <div className="mic-diamond" title="Corredores en base">
        <div className={`mic-base b2${onBase(2) ? ' occ' : ''}`}>
          {onBase(2) && <span className="mic-base-name">{onBase(2)}</span>}
        </div>
        <div className={`mic-base b3${onBase(3) ? ' occ' : ''}`}>
          {onBase(3) && <span className="mic-base-name">{onBase(3)}</span>}
        </div>
        <div className={`mic-base b1${onBase(1) ? ' occ' : ''}`}>
          {onBase(1) && <span className="mic-base-name">{onBase(1)}</span>}
        </div>
      </div>
    </div>
  );
}
