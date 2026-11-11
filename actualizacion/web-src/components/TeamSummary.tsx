import { useMemo } from 'react';
import { computeBoxscore, isMidResult, type GameEvent } from '@poxscore/shared';
import type { Game, LineupEntry, Player } from '../api';

interface Props {
  game: Game;
  events: GameEvent[];
  players: Map<string, Player>;
  onClose: () => void;
}

const ipOf = (outs: number) => `${Math.floor(outs / 3)}.${outs % 3}`;
const avgOf = (h: number, ab: number) => (ab ? (h / ab).toFixed(3).replace(/^0/, '') : '.000');

/**
 * Resumen rápido del juego (Shift+L), estilo el reporte de BallScore:
 * línea ofensiva de cada jugador + estado de entrada/salida + línea de sus lanzadores.
 */
export default function TeamSummary({ game, events, players, onClose }: Props) {
  const box = useMemo(() => computeBoxscore(events, game.innings), [events, game.innings, game.ghostRunner]);
  // bateadores enfrentados por lanzador
  const bfOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const ev of events) {
      if (ev.pitcherId && !isMidResult(ev.result)) m.set(ev.pitcherId, (m.get(ev.pitcherId) ?? 0) + 1);
    }
    return m;
  }, [events]);

  const nameOf = (pid: string) => {
    const p = players.get(pid);
    return p ? `${p.number ? `#${p.number} ` : ''}${p.firstName} ${p.lastName}` : '?';
  };

  const statusOf = (l: LineupEntry) => {
    const half = l.subInHalf === 'TOP' ? '▲' : '▼';
    if (l.role === 'REIN') return `↺ reingresa ${l.subInInning}${half}`;
    if (l.role === 'SUB') return `↳ entra ${l.subInInning}${half}`;
    if (!l.active) return 'salió';
    return 'titular';
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Resumen del juego</h2>
          <span className="muted">Shift+L para cerrar</span>
        </div>
        {(['away', 'home'] as const).map((side) => {
          const tid = side === 'away' ? game.awayTeamId : game.homeTeamId;
          const team = side === 'away' ? game.awayTeam : game.homeTeam;
          const entries = (game.lineups ?? [])
            .filter((l) => l.teamId === tid)
            .sort((a, b) => a.order - b.order || (a.role === 'STARTER' ? -1 : 1));
          const teamIds = new Set([
            ...entries.map((l) => l.playerId),
            ...(team?.players ?? []).map((p) => p.id),
          ]);
          const pitchers = Object.values(box.pitchers).filter((p) => teamIds.has(p.playerId));
          return (
            <div key={side} style={{ marginTop: '0.9rem' }}>
              <div className="section-label">{team?.name}</div>
              <table className="summary-table">
                <thead>
                  <tr><th>Jugador</th><th>Pos</th><th>Estado</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>CI</th><th>BB</th><th>K</th><th>BR</th><th>AVG</th></tr>
                </thead>
                <tbody>
                  {entries.filter((l) => l.batsInOrder !== false).map((l) => {
                    const s = box[side][l.playerId];
                    return (
                      <tr key={l.id} className={!l.active ? 'sub-out' : ''}>
                        <td>{nameOf(l.playerId)}{l.player && l.player.teamId !== tid && <span className="pill ref-pill">REF</span>}</td>
                        <td>{l.position}</td>
                        <td className="muted">{statusOf(l)}</td>
                        <td>{s?.pa ?? 0}</td><td>{s?.ab ?? 0}</td><td>{s?.r ?? 0}</td><td>{s?.h ?? 0}</td>
                        <td>{s?.rbi ?? 0}</td><td>{s?.bb ?? 0}</td><td>{s?.k ?? 0}</td><td>{s?.sb ?? 0}</td>
                        <td>{avgOf(s?.h ?? 0, s?.ab ?? 0)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {pitchers.length > 0 && (
                <table className="summary-table" style={{ marginTop: '0.4rem' }}>
                  <thead>
                    <tr><th>Lanzador</th><th>IP</th><th>H</th><th>C</th><th>CL</th><th>BB</th><th>K</th><th>HR</th><th>BF</th><th>Pit</th></tr>
                  </thead>
                  <tbody>
                    {pitchers.map((p) => (
                      <tr key={p.playerId}>
                        <td>{nameOf(p.playerId)}</td>
                        <td>{ipOf(p.outs)}</td><td>{p.h}</td><td>{p.r}</td><td>{p.er}</td><td>{p.bb}</td><td>{p.k}</td><td>{p.hr}</td>
                        <td>{bfOf.get(p.playerId) ?? 0}</td><td>{p.pitches}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="muted" style={{ fontSize: '0.82rem', marginTop: '0.3rem' }}>
                Dejados en base: <strong>{box.lob[side]}</strong>
              </div>
            </div>
          );
        })}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.8rem' }}>
          <button onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}
