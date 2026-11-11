import { Router } from 'express';
import AdmZip from 'adm-zip';
import { validatePox, previewPox, importPox, appendPreview } from '../import/pox.js';
import { detectBallstat, convertBallstat, convertBallstatPackage, isBallstatPackage } from '../import/ballstat.js';
import { isBackupFile, importBackup } from '../backup-lib.js';
import { parseBoxFile, bestMatches, bestTeam, fileNameParts, matchScore, normName, type PlayerLite } from '../import/boxfile.js';
import { prisma } from '../prisma.js';

const router = Router();

/**
 * POST /api/import[?dry=1]
 * body: { name?: string; data: unknown; encoding?: 'base64' }
 *   data = JSON parseado o texto (.pox.json) | base64 (.rar/.zip de BallStat).
 * dry=1 → solo valida y devuelve la vista previa; sin dry → inserta la liga.
 */
router.post('/', async (req, res) => {
  try {
    const dry = req.query.dry === '1';
    const { name, data, encoding, appendToLeagueId, mergeSameName, replaceSeason, mergeSeason, playerAliases } = req.body as {
      name?: string; data?: unknown; encoding?: string;
      appendToLeagueId?: string; mergeSameName?: boolean; replaceSeason?: boolean; mergeSeason?: boolean;
      playerAliases?: { from: string; fromTeam?: string; to: string }[];
    };
    if (data == null) { res.status(400).json({ error: 'falta "data" (contenido del archivo)' }); return; }

    let raw: unknown = data;
    let convWarnings: string[] = [];
    // paquete BallStat (.rar/.zip en base64) → extraer + convertir carpeta
    if (encoding === 'base64' && isBallstatPackage(name ?? '')) {
      const r = await convertBallstatPackage(name ?? 'liga.zip', Buffer.from(String(data), 'base64'));
      raw = r.file;
      convWarnings = r.warnings;
    } else if (typeof data === 'string') {
      try {
        raw = JSON.parse(data);
      } catch {
        if (detectBallstat(name ?? '', data)) {
          raw = convertBallstat(name ?? '', data); // .sbk suelto → 501 explicado
        } else {
          res.status(400).json({ error: 'el archivo no es JSON ni un formato reconocido (.pox.json / .rar / .zip)' });
          return;
        }
      }
    }

    // un respaldo PoxScore (Backup/Restaurar) también se puede cargar desde 📥 Importar
    if (isBackupFile(raw)) {
      if (dry) {
        const b = raw as Record<string, unknown[]>;
        res.json({
          ok: true,
          preview: {
            league: 'Respaldo PoxScore', sport: 'baseball',
            seasons: (b.seasons ?? []).length, teams: (b.teams ?? []).length,
            players: (b.players ?? []).length, games: (b.games ?? []).length,
            gamesWithEvents: 0, warnings: ['Es un respaldo completo — restaura todas las tablas sin duplicar.'],
          },
          backup: true,
        });
        return;
      }
      const { imported } = await importBackup(raw);
      res.json({ ok: true, backup: true, imported });
      return;
    }

    const { file, errors, warnings } = validatePox(raw);
    warnings.push(...convWarnings);
    if (!file) {
      // diagnóstico: lista las claves del archivo para saber qué formato trae
      const keys = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? Object.keys(raw as object).slice(0, 14).join(', ')
        : typeof raw;
      res.status(422).json({ error: `${errors.join(' · ')} — claves del archivo: ${keys}`, errors, warnings });
      return;
    }
    if (dry) {
      // ¿el nombre del archivo dice otro año que los juegos? (ej. "…2025.rar" pero
      // detectado como 2026) — un anexo con reemplazar borraría la temporada equivocada
      const fileYear = /(?:19|20)\d{2}/.exec(name ?? '')?.[0];
      const seasonYears = [...new Set(file.seasons.map((s) => s.year))];
      if (fileYear && !seasonYears.includes(Number(fileYear))) {
        warnings.unshift(`el archivo se llama "${name}" pero sus juegos se detectaron como temporada ${seasonYears.join('/')} — verifica el año antes de anexar o reemplazar`);
      }
      // con liga destino → nombres sin match + sugerencias (el usuario decide a dónde van)
      const append = appendToLeagueId ? await appendPreview(file, appendToLeagueId) : undefined;
      res.json({ ok: true, preview: previewPox(file, warnings), append });
      return;
    }

    const result = await importPox(file, warnings, { appendToLeagueId, mergeSameName, replaceSeason, mergeSeason, playerAliases });
    res.json({ ok: true, ...result });
  } catch (e) {
    const err = e as Error & { status?: number; leagueId?: string };
    res.status(err.status ?? 500).json({ error: err.message, leagueId: err.leagueId });
  }
});

/**
 * POST /api/import/boxscore — UN juego desde ".box.txt" de BallScore.
 * Solo admin (el router ya va tras guard('admin')).
 *
 * body: { leagueId, name?, data (texto RTF/TXT o base64), dry?,
 *         awayTeamId?, homeTeamId?, seasonId?,
 *         overrides?: { "equipo|NOMBRE": playerId | "NEW" | "SKIP" } }
 * dry → vista previa con matches propuestos (equipos y jugadores por nombre).
 * sin dry → crea el Game FINAL + statLines + acumulado de temporada.
 */
router.post('/boxscore', async (req, res) => {
  try {
    const { leagueId, seasonId, name, data, dry, awayTeamId, homeTeamId, overrides, newNames } = req.body as {
      leagueId?: string; seasonId?: string; name?: string; data?: string;
      dry?: boolean; awayTeamId?: string; homeTeamId?: string;
      overrides?: Record<string, string>;
      /** clave normName(equipo)|nombre → nombre COMPLETO a usar al crear la ficha
       *  (el box solo trae apellido; el admin escribe "Willy Ramos") */
      newNames?: Record<string, string>;
    };
    if (!leagueId || !data) return res.status(400).json({ error: 'leagueId y data requeridos' });
    const league = await prisma.league.findUnique({ where: { id: leagueId }, include: { teams: { include: { players: true } } } });
    if (!league) return res.status(404).json({ error: 'Liga no encontrada' });

    const txt = /^[A-Za-z0-9+/=\r\n]+$/.test(data.slice(0, 400)) && data.length > 200 && !data.includes('{\\rtf') && !data.trimStart().startsWith('{')
      ? Buffer.from(data, 'base64').toString('utf8')
      : data;
    const box = parseBoxFile(txt, name);
    if (!box) return res.status(422).json({ error: 'No se reconoció el archivo — no parece un box score de BallScore (.box.txt)' });

    // equipos del archivo ↔ equipos de la liga
    const teamNames = [...new Set([box.away, box.home, ...box.rows.map((r) => r.team)].filter(Boolean))];
    const teamMatch = new Map<string, { id: string; name: string } | null>();
    for (const tn of teamNames) {
      const t = awayTeamId && tn === box.away ? league.teams.find((x) => x.id === awayTeamId)
        : homeTeamId && tn === box.home ? league.teams.find((x) => x.id === homeTeamId)
        : bestTeam(tn, league.teams);
      teamMatch.set(tn, t ? { id: t.id, name: t.name } : null);
    }
    const awayT = awayTeamId ? league.teams.find((t) => t.id === awayTeamId) : bestTeam(box.away, league.teams);
    const homeT = homeTeamId ? league.teams.find((t) => t.id === homeTeamId) : bestTeam(box.home, league.teams);

    // jugadores: match por nombre dentro del equipo asignado, con fallback
    // liga-wide — un traspasado ya no está en el roster del equipo del archivo
    const allPlayers = league.teams.flatMap((t) =>
      t.players.map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName, teamId: t.id, teamName: t.name })));
    const teamOf = new Map(allPlayers.map((p) => [p.id, p.teamName]));
    const ov = overrides ?? {};
    const preview = box.rows.map((r) => {
      const tm = teamMatch.get(r.team);
      // fila parcial de las notas no trae equipo → se cruza con toda la liga
      const roster = (r.team
        ? (league.teams.find((t) => t.id === tm?.id)?.players ?? [])
        : allPlayers) as PlayerLite[];
      const inTeam = new Set(roster.map((p) => p.id));
      let cands = [
        ...bestMatches(r.name, roster).map((c) => ({ ...c, team: tm?.name ?? '', sameTeam: true })),
        ...bestMatches(r.name, allPlayers).filter((c) => !inTeam.has(c.playerId))
          .map((c) => ({ ...c, team: teamOf.get(c.playerId) ?? '', sameTeam: false })),
      ].sort((a, b) => b.score - a.score || Number(b.sameTeam) - Number(a.sameTeam)).slice(0, 5)
        .map((c) => ({ ...c, name: c.name.replace(/^·\s*/, '') })); // placeholder de apellido solo
      // «P» a secas = el lanzador bateando sin nombre anotado — sugiere los
      // pitchers que el mismo archivo anotó para ese equipo; si el equipo
      // tiene UN SOLO pitcher, el "P" es casi seguro él → score 80 auto-asigna
      if (r.noName && r.team) {
        const pits = box.rows.filter((x) => x !== r && x.section === 'pit' && x.team === r.team);
        const solo = /^p$/i.test(r.name.trim()) && pits.length === 1 ? 80 : 0;
        const sug = pits
          .flatMap((x) => bestMatches(x.name, allPlayers))
          .filter((c) => c.score >= 60 || solo)
          .map((c) => ({ ...c, score: Math.max(c.score, solo || 50), team: teamOf.get(c.playerId) ?? '', sameTeam: true }));
        cands = [...sug, ...cands]
          .sort((a, b) => b.score - a.score).slice(0, 5);
      }
      const best = cands[0];
      const key = `${normName(r.team)}|${r.name}`;
      const o = ov[key];
      // apellido sin nombre + 2+ candidatos empatados = adivinanza — se marca
      // para que el admin confirme en vez de auto-asignar callado
      const surnameOnly = !fileNameParts(r.name).first;
      const ambiguous = !!best && surnameOnly && cands.filter((c) => c.score === best.score).length > 1;
      // filas parciales/sin nombre/ambiguas piden match más fuerte para auto-asignar
      const autoOk = best && !ambiguous && best.score >= (r.partial || r.noName ? 78 : 60);
      return {
        key, file: r.name, teamFile: r.team, section: r.section, pos: r.pos, dec: r.dec,
        stats: r.stats, partial: r.partial, noName: r.noName, ambiguous,
        matchId: o && o !== 'NEW' && o !== 'SKIP' ? o : (autoOk ? best.playerId : null),
        matchName: autoOk ? best.name : null,
        matchScore: best?.score ?? 0,
        matchTeam: autoOk ? best.team : null,
        moved: !!(autoOk && !best.sameTeam), // matcheó pero hoy juega en OTRO equipo (traspasado)
        candidates: cands,
        action: o === 'SKIP' ? 'skip' : o === 'NEW' ? 'new' : (o ? 'picked' : (autoOk ? 'auto' : (r.noName || r.partial ? 'skip' : 'new'))),
      };
    });

    if (dry) {
      // posible duplicado: mismo marcador/equipos cerca de la fecha
      const dup = awayT && homeT ? await prisma.game.findFirst({
        where: {
          leagueId, awayTeamId: awayT.id, homeTeamId: homeT.id, status: 'FINAL',
          OR: [{ fScoreAway: box.scoreAway, fScoreHome: box.scoreHome }],
          ...(box.dateIso ? { date: { gte: new Date(box.dateIso + 'T00:00:00'), lt: new Date(box.dateIso + 'T23:59:59') } } : {}),
        },
      }) : null;
      return res.json({
        ok: true, dry: true,
        box: { dateIso: box.dateIso, away: box.away, home: box.home, scoreAway: box.scoreAway, scoreHome: box.scoreHome, innings: box.innings, wp: box.wp, lp: box.lp, sv: box.sv },
        awayTeam: { file: box.away, teamId: awayT?.id ?? null, name: awayT?.name ?? null },
        homeTeam: { file: box.home, teamId: homeT?.id ?? null, name: homeT?.name ?? null },
        teams: [...teamMatch.entries()].map(([file, m]) => ({ file, teamId: m?.id ?? null, name: m?.name ?? null })),
        players: preview,
        // roster completo de la liga para la búsqueda manual del admin
        roster: allPlayers.map((p) => ({
          id: p.id, team: p.teamName,
          name: `${p.firstName === '·' ? '' : p.firstName + ' '}${p.lastName}`.trim(),
        })),
        dupGameId: dup?.id ?? null,
        warnings: box.warnings,
      });
    }

    if (!awayT || !homeT) return res.status(400).json({ error: 'Asigna los dos equipos de la liga antes de importar' });

    // resolución de jugadores: matched | NEW (crear en el equipo) | SKIP
    const season = seasonId
      ? await prisma.season.findUnique({ where: { id: seasonId } })
      : await prisma.season.findFirst({ where: { leagueId, status: 'ACTIVE' } });
    const seasonYear = season?.year ?? league.year;

    let created = 0;
    const resolvePlayer = async (r: { name: string; team: string; noName?: boolean }, teamId: string): Promise<string | null> => {
      const roster = league.teams.find((t) => t.id === teamId)?.players ?? [];
      const o = ov[`${normName(r.team)}|${r.name}`];
      if (o === 'SKIP') return null;
      if (o && o !== 'NEW') return o;
      if (r.noName) return null; // «P» sin nombre nunca auto-matchea ni crea jugador
      const best = bestMatches(r.name, roster as PlayerLite[])[0];
      if (best && best.score >= 60) return best.playerId;
      // traspasado: buscar en toda la liga (la línea igual queda con el equipo del archivo)
      const wide = bestMatches(r.name, allPlayers as PlayerLite[])[0];
      if (wide && wide.score >= 60) return wide.playerId;
      // crear: "LARA, Pedro" → firstName Pedro, lastName LARA
      // si el admin escribió el nombre completo (newNames) se usa ese —
      // el box solo trae apellido y la ficha quedaría sin nombre de pila
      const nn = newNames?.[`${normName(r.team)}|${r.name}`]?.trim();
      const parts = fileNameParts(nn || r.name);
      const title = (s: string) => s.toLowerCase().replace(/(^|\s|[,'-])\S/g, (c) => c.toUpperCase());
      const p = await prisma.player.create({
        data: {
          teamId,
          firstName: parts.first ? title(parts.first) : '—',
          lastName: parts.last ? title(parts.last) : title(parts.first) || r.name,
          active: true,
        },
      });
      created++;
      (league.teams.find((t) => t.id === teamId)?.players as PlayerLite[]).push({ id: p.id, firstName: p.firstName, lastName: p.lastName });
      return p.id;
    };

    // merge bateo+pitcheo+fildeo del mismo jugador en UNA línea statLine
    const merged = new Map<string, Record<string, unknown>>(); // playerId|teamId → line
    const skipped: string[] = [];
    for (const r of box.rows) {
      const tm = teamMatch.get(r.team);
      // fila parcial de las notas no trae equipo — si el admin eligió un
      // jugador, la línea se le anota a su equipo actual en la liga
      let teamId = r.team === box.away ? awayT.id : r.team === box.home ? homeT.id : tm?.id;
      const oRow = ov[`${normName(r.team)}|${r.name}`];
      if (!teamId && oRow && oRow !== 'NEW' && oRow !== 'SKIP') {
        teamId = allPlayers.find((p) => p.id === oRow)?.teamId;
      }
      if (!teamId) { skipped.push(`${r.name} (${r.team || 'solo en notas'})`); continue; }
      const pid = await resolvePlayer(r, teamId);
      if (!pid) { skipped.push(r.name); continue; }
      const k = `${pid}|${teamId}`;
      const line = (merged.get(k) ?? { playerId: pid, teamId, g: 1 }) as Record<string, unknown>;
      for (const [sk, sv2] of Object.entries(r.stats)) {
        if (sk === 'pOuts') line[sk] = (Number(line[sk]) || 0) + sv2; // outs ya convertidos
        else line[sk] = (Number(line[sk]) || 0) + sv2;
      }
      if (r.pos && !line.pos) line.pos = r.pos;
      if (r.dec === 'W') line.w = 1; if (r.dec === 'L') line.l = 1;
      if (r.dec === 'S') line.sv = 1; if (r.dec === 'H') line.hld = 1; if (r.dec === 'BS') line.bs = 1;
      merged.set(k, line);
    }
    // PA derivado si el box no lo trae
    for (const line of merged.values()) {
      if (line.pa == null) {
        line.pa = Number(line.ab ?? 0) + Number(line.bb ?? 0) + Number(line.hbp ?? 0) + Number(line.sac ?? 0) + Number(line.sf ?? 0);
      }
    }
    const statLines = [...merged.values()];

    // decisiones por nombre de archivo → jugador del juego
    const inGame = (nm?: string) => {
      if (!nm) return null;
      const roster = [...(awayT.players ?? []), ...(homeT.players ?? []), ...allPlayers] as PlayerLite[];
      const b = bestMatches(nm, roster)[0];
      return b && b.score >= 60 ? b.playerId : null;
    };
    const wpId = inGame(box.wp) ?? (statLines.find((l) => l.w)?.playerId as string | undefined) ?? null;
    const lpId = inGame(box.lp) ?? (statLines.find((l) => l.l)?.playerId as string | undefined) ?? null;
    const svId = inGame(box.sv) ?? (statLines.find((l) => l.sv)?.playerId as string | undefined) ?? null;

    const date = box.dateIso ? new Date(box.dateIso + 'T12:00:00') : new Date();
    const game = await prisma.game.create({
      data: {
        date, status: 'FINAL', sport: league.sport, innings: box.innings || league.innings || 9,
        leagueId, seasonId: season?.id ?? null,
        awayTeamId: awayT.id, homeTeamId: homeT.id,
        fScoreAway: box.scoreAway, fScoreHome: box.scoreHome,
        endedAt: date,
        wpId, lpId, svId,
        statLines: JSON.parse(JSON.stringify(statLines)),
        seasonApplied: true, // el acumulado se hace abajo línea por línea
        note: `Importado de box score BallScore${name ? ` (${name})` : ''}`,
      },
    });

    // acumulado de temporada (los números suman al jugador y al equipo)
    // po/a/bf van en la línea pero no existen en PlayerSeasonStat — se filtran
    for (const line of statLines) {
      const data: Record<string, number> = {};
      for (const [k, v] of Object.entries(line)) {
        if (typeof v !== 'number' || ['playerId', 'teamId', 'pos', 'po', 'a', 'bf'].includes(k)) continue;
        data[k] = v;
      }
      await prisma.playerSeasonStat.upsert({
        where: { playerId_season_scope: { playerId: line.playerId as string, season: seasonYear, scope: 'REG' } },
        create: { playerId: line.playerId as string, season: seasonYear, scope: 'REG', ...data },
        update: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { increment: v }])),
      });
    }

    res.json({
      ok: true, gameId: game.id,
      players: statLines.length, created,
      skipped, warnings: box.warnings,
    });
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

/**
 * POST /api/import/boxscore/zip-totals — ZIP de .box.txt → totales por jugador.
 * Solo lectura (nunca escribe): agrega las filas de TODOS los juegos del zip
 * por (equipo del archivo · nombre) y devuelve los acumulados — el front los
 * compara contra el PlayerSeasonStat actual y, si el admin confirma, aplica
 * con PUT /stats/players/:id/season. Sirve para recuperar los números finales
 * que se pierden cuando no se pueden importar los juegos completos.
 *
 * body: { leagueId, playerId?, data (base64 del .zip) }
 * → { ok, files, skipped[], year,
 *     players: [{ key, name, team, suggested, stats:{g,…} }],
 *     current?: {…} (PlayerSeasonStat REG del jugador en ese año) }
 */
router.post('/boxscore/zip-totals', async (req, res) => {
  try {
    const { leagueId, playerId, data } = req.body as { leagueId?: string; playerId?: string; data?: string };
    if (!data || typeof data !== 'string') return res.status(400).json({ error: 'falta data (base64 del .zip)' });

    let zip: AdmZip;
    try { zip = new AdmZip(Buffer.from(data, 'base64')); }
    catch { return res.status(400).json({ error: 'el archivo no es un .zip válido' }); }
    const entries = zip.getEntries().filter((e) => !e.isDirectory && /\.box\.txt$/i.test(e.entryName));
    if (!entries.length) return res.status(422).json({ error: 'el .zip no trae archivos .box.txt' });

    const DEC_STAT = { W: 'w', L: 'l', S: 'sv', H: 'hld', BS: 'bs' } as const;
    const groups = new Map<string, { name: string; team: string; baseKey: string; dup: boolean; files: Set<number>; pitFiles: Set<number>; stats: Record<string, number> }>();
    const years = new Map<number, number>();
    const skipped: string[] = [];
    let files = 0;

    entries.forEach((en, fi) => {
      const buf = en.getData();
      // Windows-1252 (Latin-1) es lo habitual en BallScore — UTF-8 estricto
      // primero y fallback 1252 para los acentos (igual que el front).
      let txt: string;
      try { txt = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch { txt = new TextDecoder('windows-1252').decode(buf); }
      const box = parseBoxFile(txt, en.entryName.split(/[\\/]/).pop());
      if (!box) { skipped.push(en.entryName); return; }
      files++;
      if (box.dateIso) {
        const y = Number(box.dateIso.slice(0, 4));
        if (y > 1900 && y < 2200) years.set(y, (years.get(y) ?? 0) + 1);
      }
      // homónimos dentro de UN archivo: una 2da fila de bateo con la misma
      // clave = otra persona («Castillo» y «Castillo p» bateando ambos) —
      // se separa en su propio grupo «|#N» para no inflar los números del 1ro.
      // 1ra pasada: las filas de bateo fijan la identidad (con su posición).
      const ord = new Map<string, number>();
      const rowKey = new Map<(typeof box.rows)[number], string>();
      const batPos = new Map<string, { key: string; pos: string }[]>();
      for (const r of box.rows) {
        if (r.section !== 'bat') continue;
        const baseKey = `${normName(r.team)}|${normName(r.name)}`;
        const n = (ord.get(baseKey) ?? 0) + 1;
        ord.set(baseKey, n);
        const key = n > 1 ? `${baseKey}|#${n}` : baseKey;
        rowKey.set(r, key);
        const arr = batPos.get(baseKey) ?? [];
        arr.push({ key, pos: r.pos ?? '' });
        batPos.set(baseKey, arr);
      }
      for (const r of box.rows) {
        const baseKey = `${normName(r.team)}|${normName(r.name)}`;
        let key = rowKey.get(r) ?? baseKey;
        // pitcheo de un homónimo: va al que bateó con posición P
        if (r.section === 'pit' && !rowKey.has(r)) {
          const bats = batPos.get(baseKey) ?? [];
          if (bats.length > 1) key = (bats.find((b) => /(^|-)P(-|$)/i.test(b.pos)) ?? bats[0]).key;
        }
        const g = groups.get(key) ?? { name: r.name + (key !== baseKey ? ` (${key.split('|#')[1]})` : ''), team: r.team, baseKey, dup: key !== baseKey, files: new Set<number>(), pitFiles: new Set<number>(), stats: {} };
        g.files.add(fi); // una fila bat+pit+fld en el mismo juego = 1 juego
        if (r.section === 'pit') g.pitFiles.add(fi); // gp = juegos donde lanzó
        // PA derivado si el box no lo trae (igual que el import por juego)
        const rs = r.section === 'bat' && r.stats.pa == null
          ? { ...r.stats, pa: (r.stats.ab ?? 0) + (r.stats.bb ?? 0) + (r.stats.hbp ?? 0) + (r.stats.sac ?? 0) + (r.stats.sf ?? 0) }
          : r.stats;
        for (const [k, v] of Object.entries(rs)) {
          if (typeof v === 'number' && Number.isFinite(v)) g.stats[k] = (g.stats[k] ?? 0) + v;
        }
        const dk = r.dec ? DEC_STAT[r.dec] : undefined;
        if (dk) g.stats[dk] = (g.stats[dk] ?? 0) + 1;
        groups.set(key, g);
      }
    });
    if (!files) return res.status(422).json({ error: `ningún archivo se reconoció como box score (${skipped.length} omitidos)` });

    const year = [...years.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      ?? (leagueId ? (await prisma.league.findUnique({ where: { id: leagueId }, select: { year: true } }))?.year : undefined)
      ?? new Date().getFullYear();

    // jugador seleccionado → su acumulado grabado + filas del zip sugeridas
    let current: Record<string, number> | null = null;
    const suggested = new Set<string>();
    if (playerId) {
      const p = await prisma.player.findUnique({ where: { id: playerId } });
      if (p) {
        const row = await prisma.playerSeasonStat.findUnique({
          where: { playerId_season_scope: { playerId, season: year, scope: 'REG' } },
        });
        if (row) {
          const { id: _i, playerId: _p, season: _s, scope: _sc, adj: _a, ...rest } = row;
          current = rest;
        }
        const lite: PlayerLite = { id: p.id, firstName: p.firstName, lastName: p.lastName };
        for (const [key, g] of groups) if (matchScore(g.name, lite) >= 60) suggested.add(key);
      }
    }

    // el grupo base de un homónimo también se marca — sus filas de
    // pitcheo/fildeo pudieron pertenecer al otro (ambiguo por nombre)
    for (const [key, g] of groups) {
      if (key.includes('|#')) {
        const base = groups.get(g.baseKey);
        if (base) base.dup = true;
      }
    }

    const players = [...groups.entries()]
      .map(([key, g]) => ({
        key, name: g.name, team: g.team, suggested: suggested.has(key), dup: g.dup,
        stats: { g: g.files.size, gp: g.pitFiles.size, ...g.stats },
      }))
      .sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.team.localeCompare(b.team) || a.name.localeCompare(b.name));

    res.json({ ok: true, files, skipped, year, players, current });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export default router;
