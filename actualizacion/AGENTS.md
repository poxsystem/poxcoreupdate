# PoxScore — Contexto para agentes

Sucesor moderno de BallScore/BallStat: anotación y estadísticas de **baseball y softball**, administración de ligas/torneos y estadísticas históricas por año estilo MLB. Funcional end-to-end con MySQL local.

> **Detalle extenso → `docs/dev/HISTORIAL.md`** (el AGENTS.md original completo: importación BallStat, launcher WebView2, IA, installer, audit internals, decisiones por sesión). Léelo cuando el tema toque; no repitas su contenido aquí.
>
> **Regla de mantenimiento**: este archivo solo lleva *convenciones vigentes* (cómo funciona HOY). La crónica de sesión/decisiones va al final de `HISTORIAL.md`. Mantenerlo bajo ~150 líneas.

## Arquitectura

- `shared/` — motor puro TS (`types.ts`, `engine.ts`: `defaultAdvances`, `applyEvent`, `reduceGame`, `computeBoxscore`, `buildSheet`). **Fuente de verdad = stream de `GameEvent`**; el estado se recalcula desde cero → "deshacer" = borrar eventos.
- **Idempotencia (`clientKey`)**: `GameEvent.clientKey` único por juego — POST repetido devuelve `{dup:true}` sin duplicar (cubre cola offline y doble-clic).
- `server/` — Express + Prisma + MySQL. Rutas: `teams`, `games`, `events`, `stats`, `leagues`, `backup`, `publish`, `import`, `auth`, `ai`.
- **`enqueue` por gameId** en `events.ts` serializa escrituras (sin ella, POSTs concurrentes chocan `@@unique([gameId,seq])`). `async-patch.ts` (importado primero) envía rechazos async al error middleware. POST valida tipos/longitudes (string > VARCHAR(191) → 400).
- `web/` — React + Vite + PWA. Cola offline en `localStorage` (`poxscore-outbox`).
- **Auto-reset PWA**: `/api/health` devuelve `build` (bundle servido); el front compara con el suyo y si difieren desregistra SW + borra caches + recarga una vez. El SW no toca `/api/*`.

## Correr en dev

```bash
npm run dev:server   # API :4000 (tsx watch)
npm run dev:web      # App :5173 (proxy /api → :4000)
npm test             # Vitest: shared/test (motor) + web/test (planilla) — 16 casos
npm run build        # shared → server (esbuild bundle dist/index.js) → web
node server/selftest.cjs   # chequeo pre-campo: API, Prisma, BD, disco
```

- MySQL `MySQL80`, base `poxscore`, credenciales en `server/.env` (no commitear).
- **Gotcha Windows**: `query_engine-windows.dll.node` queda bloqueado con node/tsx corriendo — matar antes de `prisma generate`. Nunca dejar `tsx watch` duplicados (EADDRINUSE :4000).
- **Respaldo**: `POST /api/backup/export` (9 tablas, IDs preservados) / `import`; `backup-lib.ts` auto-respalda a `server/backups/auto-*.json` al arrancar, cada 6h, al cerrar juegos y antes de operaciones destructivas (rotación 30). `selftest.cjs` lo invoca `ACTUALIZAR.bat`.

## Modelo y reglas de anotación (vigente)

- `Game.sport`: `baseball` (9 inn) | `softball` (7 inn); `Game.innings` configurable. `LineupEntry.role`: `STARTER|SUB|OUT|REIN`; `batsInOrder:false` = DH/EH. Posiciones: `P C 1B 2B 3B SS LF CF RF JC EH DH`. `Player.active:false` = baja/pasivo (conserva historial). `Player.photo` MediumText base64.
- **Notación**: hits `[TIPO]-[ZONA]` (`1B-8`, `2B-L7`); fly `F8`; errores `E5`; trayectoria `G/L/F` prefijada (`G9`). Legado `H8`/`HF7`/`HL8` se migra al grabar y `repairEventNotation` lo sanea al arrancar. `errorOn/putouts/assists` son **String JSON en BD** — siempre `toEvent()`/`loadEvents` al leer. **Hit+error (`1BE/2BE/3BE`)**: 2 fases en ScorePage — 1ª el hit con su zona completa (`L9`), 2ª el `E#` + base extra → notación `L9-E5` (la zona viaja pegada; `fieldingCredits` la ignora al repartir PO/A — es dirección de batazo, no fildeador).
- **`RHB`** (bola bateada golpea a corredor fair): OUT del corredor + hit sencillo al bateador; **NUNCA es force** (bola muerta). **`LIB`**: avance libre mid-result — sin SB/pitcheo/merecida.
- **`thirdOutIsForce`**: anula carreras solo si el 3er out es forzado real (`outBase ≤ maxForcedBase` de la cadena ocupada); bateador con 1ª por hit que muere estirando = tag (carrera cuenta). Igualado en `applyEvent`, `computeBoxscore` y `computeInningTallies`.
- **Planilla por `order`**: `buildSheet` coloca cada PA en la casilla `order-1` del bateador (misma fuente que stats y columna de nombres); la columna = vuelta del orden en curso; jugador insertado hereda el turno activo. **`swap-order` solo intercambia `order`** (las marcas viajan con el jugador — nunca reordenar seqs).
- **Casillas dirigidas**: `POST /events` acepta `beforeSeq` (inserta recorriendo con offset temporal para no chocar `@@unique`); `DELETE /events/:seq` quirúrgico; `DELETE /events?fromSeq=N` desde un punto. Clic derecho en celda → «Anotar aquí»/«Limpiar celda completa»; Alt+clic = anotar.
- `PUT /games/:id/lineup/:teamId` = **upsert** (preserva filas OUT/historial de subs). `POST /substitute` + `POST /undo-sub`; modo `RL` reingreso lanzador (softball). `POST /games/:id/swap-player` remapea identidad (eventos+lineup+`statLines`+decisiones) **y resincroniza `PlayerSeasonStat`** si el juego está FINAL/`seasonApplied` (gameContrib antes/después + `applySeasonDelta`). `selectPitcher` (ScorePage) ofrece agregar al lineup un lanzador sin fila (`lineupAdd` P/SUB) — sin fila queda "solo en eventos". **`DELETE /games/:id` revierte la contribución en `PlayerSeasonStat`** si el juego ya acumuló (`seasonApplied`) — borrar no deja stats fantasma.
- `Team.lineupTemplate` (`@db.MediumText` — VARCHAR(191) reventaba plantillas). `PlayerSeasonStat.adj` = ajuste manual JSON que `leagueStats`/`aggregateGames` **y la tarjeta `/games/:id/card/:playerId`** aplican (website = foto estática: regenerar para reflejar). `GET /card` devuelve `scope`/`seasonYear`; ConsultaModal/seasonMap prefieren la fila del año del juego y caen a la última de ese scope. **`PUT /games/:id` con `status:FINAL` acumula temporada** (cerrar por vía admin no puede saltarse `accumulateSeason`).

## Funcionalidad (punteros — detalle en HISTORIAL.md)

- **Importación**: `POST /api/import` acepta `.pox.json`, respaldos PoxScore y paquetes BallStat (rar/zip con `BallScore Reports`/`WebBuilder`/`Rosters`); modos append/mergeSeason/replaceSeason, `playerAliases` para reasignar nombres→fichas. `conv-ballstat.ts` + `zip2pox.ts` CLI.
- **Stats**: `statLines` (JSON por juego, juegos sin eventos) y `PlayerSeasonStat` (acumulado por temporada, scope REG/POST separados por `seriesId`). Reportes `POST /stats/report`, SQL libre `/stats/sql`, fusionar duplicados `/fusionar`, edición `PUT /stats/players/:id/season`. **`POST /stats/recalc {year}`** reconstruye los acumulados del año desde los juegos (conserva `adj` — botón ♻️ en la página de liga).
- **Hoja imprimible** (`LeagueReportSheet`/`PrintSheet`: líderes, MVP, reportes): carga su propio dataset — **siempre temporada vigente (ACTIVE) y fase regular**; el toggle/selector de la vista no la afecta. Cierra con ✕/Esc/fondo. **MVP** = `warBat + warPit × 0.75 + min(3.0, tinta × 0.25)` (`MVP_PIT_FACTOR` = descuento de votante MLB: el lanzador acumula WAR más rápido por volumen de juego) — tinta = lideratos ponderados estilo Black Ink/MLB (`pts` por depto en `leaderCats`: 4 AVG·HR·CI·W·ERA·K, 3 R·H·SLG·OPS·IP·SV, 2 2B·OBP·BB·BR·WHIP·CG, 1 3B·HLD·SHO); mismo set que «Líderes 1º», empates cuentan completo (co-líderes). Normal que `warPit` lidere (el as lanza todos los juegos → controla ~5× más PA que un bateador; verificado vs datos).
- **Ligas**: `Season` hija (año, ACTIVE/ENDED, rollover), standings con desempate configurable, divisiones, generador de calendario (normal/triangular), playoffs con `Series`, transfers/bulk-move conservan ID. **Vincular juego a serie = `assignGameSeries`** (games.ts): si ya acumuló (`seasonApplied`) migra su contribución REG↔POST en `PlayerSeasonStat` — también al desvincular/borrar serie. Stats por fase: `GET /leagues/:id/stats?phase=post&round=N` (cada ronda aparte + `post` = total postemporada, estilo MLB).
- **Website**: `GET /leagues/:id/website` genera sitio estático multi-temporada; `/api/publish` sube por FTP/FTPS/SFTP (UI FileZilla en `/publicar`). `Team.blocked`/`Player.blocked` redacta la publicación. El boxscore separa pitcheo por equipo con decisión (G/P/SV/H/BS/JC/SHO) + **Recap** (decisiones con récord **de la fase del juego** — post en playoff, regular en reg — y notas de bateo por equipo) — los `results` de `aggregateGames` llevan `pitSide`/`dec` para eso (juegos viejos lo obtienen al regenerar).
- **En vivo**: `/en-vivo/:id` pública (poll 10s) + `/en-vivo/:id/obs` scorebug transparente OBS (2.5s, flash HR). `LiveMic` push-to-talk, módulos IA M1-M8 (`/ai/*`, fallback sin `OPENAI_API_KEY`).
- **Admin/auditoría**: `/admin` (liga), `AdminGameEdit` corrige juegos FINAL (runBreakdown, swap-player, decisiones). Auth opt-in: sin usuarios = modo abierto; `guard()` por rol; `ADMIN_KEY` en `.env`.
- **Entrega**: `launcher/PoxScoreWin.exe` (WebView2, perfil `%LOCALAPPDATA%\PoxScore\WV2` — su caché puede retener build viejo), `PoxScore.exe` panel, `installer/` + `Instalar.bat`, `actualizacion/` paquete incremental — **`Empaquetar-Actualizacion.bat` lo regenera** (build + espejo de carpetas); estructura y gotchas en `docs/dev/EMPAQUETAR.md`. **Multiplataforma**: los `.bat`/`robocopy`/`PoxScoreWin.exe` son Windows-only — en Mac/Linux el empaquetado NO corre; el código (web+server+shared) sí es idéntico. DMG exige macOS (`hdiutil`, `codesign`, `notarytool`); sin Mac, vía realista = GitHub Actions runner `macos-latest` o `.zip` sin firma; la PWA (`node server/dist/index.js` + Instalar app) ya es multiplataforma sin empaque.

## Pendiente (roadmap corto)

Foto de hoja → jugadas · `current.sb` binario BallStat · líderes globales por temporada · boxscore imprimible por juego · courtesy runner sin quemar sustitución · deshacer tras `seasonApplied` · PA/IP mínimos en líderes · auth multiusuario.
