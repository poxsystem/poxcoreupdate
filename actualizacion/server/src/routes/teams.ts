import { Router } from 'express';
import { prisma } from '../prisma.js';
import { adminOk } from '../auth.js';

const r = Router();

// ---- Equipos ----
r.get('/', async (_req, res) => {
  const teams = await prisma.team.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { players: true } }, league: { select: { name: true, year: true } } },
  });
  res.json(teams);
});

r.post('/', async (req, res) => {
  const { name, shortName, color, division, leagueId } = req.body;
  if (!name) return res.status(400).json({ error: 'name requerido' });
  const team = await prisma.team.create({ data: { name, shortName, color, division: division || null, leagueId: leagueId || null } });
  res.status(201).json(team);
});

r.get('/:id', async (req, res) => {
  const team = await prisma.team.findUnique({
    where: { id: req.params.id },
    // alfabético por apellido — al anotar se arma el lineup del pool del
    // roster y el orden por número de camisa lo volvía imposible de buscar
    include: { players: { orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { number: 'asc' }] } },
  });
  if (!team) return res.status(404).json({ error: 'Equipo no encontrado' });
  res.json(team);
});

r.put('/:id', async (req, res) => {
  const { name, shortName, color, division, leagueId, lineupTemplate } = req.body;
  const team = await prisma.team.update({ where: { id: req.params.id }, data: { name, shortName, color, division, leagueId, lineupTemplate } });
  res.json(team);
});

// Excluir/incluir el equipo de la publicación web — el dato queda en el
// sistema y vuelve a verse al reactivar; publicado sale "EQUIPO BLOQUEADO".
r.put('/:id/block', async (req, res) => {
  const { blocked } = req.body as { blocked?: boolean };
  const t = await prisma.team.update({ where: { id: req.params.id }, data: { blocked: !!blocked } });
  res.json(t);
});

// Borrar equipo exige la clave de admin en el body {password} (estilo macOS).
r.delete('/:id', async (req, res) => {
  const auth = await adminOk(String(req.body?.password ?? ''));
  if (!auth.ok) return res.status(auth.code ?? 401).json({ error: auth.error });
  try {
    await prisma.team.delete({ where: { id: req.params.id } });
  } catch {
    return res.status(404).json({ error: 'Equipo no encontrado' });
  }
  res.status(204).end();
});

// ---- Jugadores (roster) ----
r.post('/:id/players', async (req, res) => {
  const { firstName, lastName, number, bats, throws, positions, photo } = req.body;
  if (!firstName || !lastName) return res.status(400).json({ error: 'firstName y lastName requeridos' });
  const player = await prisma.player.create({
    data: {
      teamId: req.params.id,
      firstName, lastName,
      number: number != null ? Number(number) : null,
      bats, throws,
      positions: Array.isArray(positions) ? positions.join(',') : positions,
      photo: photo || null,
    },
  });
  res.status(201).json(player);
});

/**
 * Importación masiva de roster (estilo BallStat "Importar roster").
 * Acepta [{firstName, lastName, number?, bats?, throws?, positions?}] y crea
 * los jugadores que falten — los que ya existen con mismo nombre+apellido se omiten.
 */
r.post('/:id/players/bulk', async (req, res) => {
  const rows = req.body.players as {
    firstName?: string; lastName?: string; number?: number | string | null;
    bats?: string; throws?: string; positions?: string | string[];
  }[] | undefined;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'players[] requerido' });
  const existing = await prisma.player.findMany({ where: { teamId: req.params.id }, select: { firstName: true, lastName: true } });
  const have = new Set(existing.map((p) => `${p.firstName} ${p.lastName}`.toLowerCase()));
  const data = rows
    .filter((p) => p.firstName && p.lastName && !have.has(`${p.firstName} ${p.lastName}`.toLowerCase()))
    .map((p) => ({
      teamId: req.params.id,
      firstName: String(p.firstName).trim(),
      lastName: String(p.lastName).trim(),
      number: p.number != null && p.number !== '' ? Number(p.number) : null,
      bats: p.bats || null,
      throws: p.throws || null,
      positions: Array.isArray(p.positions) ? p.positions.join(',') : p.positions || null,
    }));
  const created = await prisma.player.createMany({ data });
  res.status(201).json({ created: created.count, skipped: rows.length - data.length });
});

r.put('/:id/players/:playerId', async (req, res) => {
  const { firstName, lastName, number, bats, throws, positions, active, teamId, photo } = req.body;
  const player = await prisma.player.update({
    where: { id: req.params.playerId },
    data: {
      firstName, lastName,
      number: number != null ? Number(number) : null,
      bats, throws,
      positions: Array.isArray(positions) ? positions.join(',') : positions,
      active,
      // foto: solo se toca si viene en el body ('' = quitar foto)
      ...(photo !== undefined ? { photo: photo || null } : {}),
      // transferencia: el jugador se mueve de equipo conservando su ID →
      // sus stats, historial y líneas de temporada lo siguen intactos
      teamId: teamId || undefined,
    },
  });
  res.json(player);
});

// mover jugadores por lote (ej. reorganizar roster al iniciar temporada)
r.post('/:id/players/bulk-move', async (req, res) => {
  const { playerIds, toTeamId } = req.body;
  if (!Array.isArray(playerIds) || !playerIds.length || !toTeamId)
    return res.status(400).json({ error: 'playerIds[] y toTeamId requeridos' });
  const target = await prisma.team.findUnique({ where: { id: toTeamId } });
  if (!target) return res.status(404).json({ error: 'Equipo destino no encontrado' });
  const done = await prisma.player.updateMany({
    where: { id: { in: playerIds } },
    data: { teamId: toTeamId },
  });
  res.json({ moved: done.count });
});

// Bloquear/desbloquear publicación del jugador — mismo criterio que el equipo:
// sus datos no se borran; en la página pública su perfil dice "BLOQUEADO".
r.put('/:id/players/:playerId/block', async (req, res) => {
  const { blocked } = req.body as { blocked?: boolean };
  const p = await prisma.player.update({ where: { id: req.params.playerId }, data: { blocked: !!blocked } });
  res.json(p);
});

// Borrar jugador exige la clave de admin en el body {password}.
r.delete('/:id/players/:playerId', async (req, res) => {
  const auth = await adminOk(String(req.body?.password ?? ''));
  if (!auth.ok) return res.status(auth.code ?? 401).json({ error: auth.error });
  try {
    await prisma.player.delete({ where: { id: req.params.playerId } });
  } catch {
    return res.status(404).json({ error: 'Jugador no encontrado' });
  }
  res.status(204).end();
});

export default r;
