import { useEffect, useState } from 'react';
import { api, GameCard, SeasonStat } from '../api';
import type { BatterLine } from '@poxscore/shared';

const f3 = (n: number) => (n ? n.toFixed(3).replace(/^0/, '') : '.000');
const tb = (l: { h: number; doubles: number; triples: number; hr: number }) => l.h + l.doubles + 2 * l.triples + 3 * l.hr;

interface BatRow {
  label: string;
  pa: number; ab: number; r: number; h: number; rbi: number;
  doubles: number; triples: number; hr: number; bb: number; k: number; sb: number;
}

function toRow(label: string, l: BatterLine | SeasonStat | null): BatRow {
  return {
    label,
    pa: l?.pa ?? 0, ab: l?.ab ?? 0, r: l?.r ?? 0, h: l?.h ?? 0, rbi: l?.rbi ?? 0,
    doubles: l?.doubles ?? 0, triples: l?.triples ?? 0, hr: l?.hr ?? 0,
    bb: l?.bb ?? 0, k: l?.k ?? 0, sb: l?.sb ?? 0,
  };
}

function avgOf(r: BatRow) { return r.ab ? r.h / r.ab : 0; }
function slgOf(r: BatRow) { return r.ab ? tb(r) / r.ab : 0; }
function obpOf(r: BatRow) { const d = r.ab + r.bb; return d ? (r.h + r.bb) / d : 0; }

/**
 * Tarjeta del jugador dentro del juego — estilo diálogo "Batting totals" de
 * BallScore: juego actual + cada temporada + totales, con splits del juego.
 */
export default function PlayerCardModal({ gameId, playerId, onClose }: {
  gameId: string; playerId: string; onClose: () => void;
}) {
  const [card, setCard] = useState<GameCard | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.gameCard(gameId, playerId).then(setCard).catch((e) => setErr(e.message));
  }, [gameId, playerId]);

  const p = card?.player;
  const rows: BatRow[] = [];
  if (card?.game.batting) rows.push(toRow('Juego actual', card.game.batting));
  for (const s of card?.seasons ?? []) rows.push(toRow(`${s.scope === 'POST' ? 'Postemporada' : 'Temporada'} ${s.season}`, s));
  if (rows.length > 1) {
    const total = rows.reduce((acc, r) => ({
      label: 'Total', pa: acc.pa + r.pa, ab: acc.ab + r.ab, r: acc.r + r.r,
      h: acc.h + r.h, rbi: acc.rbi + r.rbi, doubles: acc.doubles + r.doubles,
      triples: acc.triples + r.triples, hr: acc.hr + r.hr, bb: acc.bb + r.bb,
      k: acc.k + r.k, sb: acc.sb + r.sb,
    }), toRow('Total', null));
    rows.push(total);
  }

  const pit = card?.game.pitching;
  const sit = card?.game.situational;
  const fld = card?.game.fielding;
  const situCells: [string, { ab: number; h: number } | undefined][] = [
    ['RISP', sit?.risp], ['Bases llenas', sit?.loaded], ['Con 2 outs', sit?.twoOut], ['Abriendo entrada', sit?.leadoff],
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>
          {p ? `${p.number ? `#${p.number} ` : ''}${p.firstName} ${p.lastName}` : 'Cargando…'}
          {p?.team && <span className="muted" style={{ fontSize: '0.85rem', marginLeft: 8 }}>{p.team.name}</span>}
        </h2>
        {err && <p style={{ color: 'var(--red)' }}>{err}</p>}
        {card && (
          <>
            <table className="compact">
              <thead>
                <tr>
                  <th></th><th>AB</th><th>R</th><th>H</th><th>CI</th><th>2B</th><th>3B</th><th>HR</th>
                  <th>BB</th><th>K</th><th>BR</th><th>TB</th><th>PA</th><th>AVG</th><th>OBP</th><th>SLG</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.label} className={i === rows.length - 1 && rows.length > 1 ? 'total-row' : ''}>
                    <td className="muted">{r.label}</td>
                    <td>{r.ab}</td><td>{r.r}</td><td>{r.h}</td><td>{r.rbi}</td>
                    <td>{r.doubles}</td><td>{r.triples}</td><td>{r.hr}</td>
                    <td>{r.bb}</td><td>{r.k}</td><td>{r.sb}</td><td>{tb(r)}</td><td>{r.pa}</td>
                    <td>{f3(avgOf(r))}</td><td>{f3(obpOf(r))}</td><td>{f3(slgOf(r))}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={16} className="muted">Sin turnos al bate aún</td></tr>}
              </tbody>
            </table>

            <div className="row" style={{ gap: '1.2rem', flexWrap: 'wrap', marginTop: '0.7rem', fontSize: '0.85rem' }}>
              {pit && (
                <span>⚾ Juego: IP {Math.floor(pit.outs / 3)}{pit.outs % 3 ? `.${pit.outs % 3}` : ''}
                  {' '}H {pit.h} C {pit.r} CL {pit.er} BB {pit.bb} K {pit.k} Pit {pit.pitches}</span>
              )}
              {fld && (fld.po + fld.a + fld.e) > 0 && (
                <span>🧤 Fildeo: PO {fld.po} A {fld.a} E {fld.e}</span>
              )}
            </div>

            {sit && situCells.some(([, l]) => l && l.ab > 0) && (
              <>
                <div className="section-label" style={{ marginTop: '0.7rem' }}>Situacional (este juego)</div>
                <div className="row" style={{ gap: '1.2rem', flexWrap: 'wrap', fontSize: '0.85rem' }}>
                  {situCells.map(([label, l]) => l && l.ab > 0 && (
                    <span key={label}>{label}: <strong>{l.h}-{l.ab}</strong> ({f3(l.ab ? l.h / l.ab : 0)})</span>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        <div className="row" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
          <button className="secondary" onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
