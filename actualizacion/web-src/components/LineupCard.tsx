import { Game, LineupEntry } from '../api';

/**
 * Tarjeta de alineación imprimible — formato de dugout para entregar al umpire:
 * orden de bateo con posición y número, banca, fecha/estadio/ampáyers.
 * Al abrir se imprime sola (print stylesheet la muestra única en pantalla).
 */
export default function LineupCard({ game, nameOf, onClose }: {
  game: Game;
  nameOf: (id: string | null) => string;
  onClose: () => void;
}) {
  const side = (teamId?: string) =>
    (game.lineups ?? [])
      .filter((l) => l.teamId === teamId && l.role !== 'OUT')
      .sort((a, b) => a.order - b.order);
  const bench = (teamId?: string) =>
    (game.lineups ?? []).filter((l) => l.teamId === teamId && !l.batsInOrder && l.role !== 'OUT');

  const col = (title: string, teamId?: string) => (
    <div className="lc-col">
      <h3>{title}</h3>
      <table>
        <thead><tr><th>#</th><th>Jugador</th><th>Pos</th></tr></thead>
        <tbody>
          {side(teamId).filter((l) => l.batsInOrder).map((l: LineupEntry, i: number) => (
            <tr key={l.id}>
              <td>{i + 1}</td>
              <td>{nameOf(l.playerId)}{l.role === 'SUB' ? ' ⏎' : l.role === 'REIN' ? ' ⟳' : ''}</td>
              <td>{l.position}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {bench(teamId).length > 0 && (
        <>
          <h4>No batean / banca</h4>
          <table>
            <tbody>
              {bench(teamId).map((l) => (
                <tr key={l.id}><td>—</td><td>{nameOf(l.playerId)}</td><td>{l.position}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );

  return (
    <div className="modal-backdrop report-overlay" onClick={onClose}>
      <div className="modal-report lineup-card" onClick={(e) => e.stopPropagation()}>
        <div className="row no-print" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="secondary" onClick={() => window.print()}>🖨 Imprimir</button>
          <button className="secondary" onClick={onClose}>✕ Cerrar</button>
        </div>
        <div className="lc-head">
          <h1>{game.league?.name ?? 'PoxScore'} — Tarjeta de alineación</h1>
          <p>
            {new Date(game.date).toLocaleString()} · {game.innings} entradas · {game.sport}
            {game.stadium ? ` · ${game.stadium}` : ''}
          </p>
          <p className="muted">
            Ampáyer HP: {game.umpireHp ?? '________'} · 1B: {game.umpire1b ?? '____'} · 2B: {game.umpire2b ?? '____'} · 3B: {game.umpire3b ?? '____'}
          </p>
        </div>
        <div className="lc-grid">
          {col(`${game.awayTeam?.name ?? 'Visitante'} (visitante)`, game.awayTeamId)}
          {col(`${game.homeTeam?.name ?? 'Local'} (local)`, game.homeTeamId)}
        </div>
      </div>
    </div>
  );
}
