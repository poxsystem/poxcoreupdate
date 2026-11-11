import './async-patch.js'; // PRIMERO: envuelve handlers async antes de que los routers se registren
import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import teamsRouter from './routes/teams.js';
import gamesRouter from './routes/games.js';
import eventsRouter, { repairEventNotation } from './routes/events.js';
import statsRouter, { consolidateStatLineDupes } from './routes/stats.js';
import leaguesRouter from './routes/leagues.js';
import backupRouter from './routes/backup.js';
import publishRouter from './routes/publish.js';
import importRouter from './routes/import.js';
import authRouter from './routes/auth.js';
import aiRouter from './routes/ai.js';
import { guard } from './auth.js';
import { startAutoBackup } from './backup-lib.js';
import { prisma } from './prisma.js';

const app = express();
app.use(cors());
// el import acepta archivos grandes (jugada a jugada de una liga completa)
app.use('/api/import', guard('admin'), express.json({ limit: '60mb' }), importRouter);
app.use(express.json({ limit: '10mb' }));

const APP_VERSION = '2026-11-03.31';

// App compilada (web/dist) — el launcher la sirve en el mismo puerto que la API
const webDist = [
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist'), // tsx/src
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist'), // dist compilado
  path.resolve(process.cwd(), '../web/dist'),
].find((p) => fs.existsSync(path.join(p, 'index.html')));

// id del bundle servido (index-XXXX.js) — el front compara el suyo y se
// auto-recarga si el service worker le entregó un build viejo (PWA)
const webBuildId = () => {
  try {
    return fs.readFileSync(path.join(webDist!, 'index.html'), 'utf8')
      .match(/\/assets\/(index-[^"']+\.js)/)?.[1] ?? '';
  } catch { return ''; }
};

// ¿el cliente Prisma quedó viejo tras una actualización sin `prisma generate`?
// se prueba un campo nuevo del schema — si el cliente no lo conoce, marca la
// bandera y /api/health lo reporta para que la app lo grite en pantalla.
let staleClient = false;

app.get('/api/health', (_req, res) => {
  // IPs LAN de esta PC — el front las usa para armar la URL del scorebug OBS
  // que corre en OTRA máquina de la red (localhost no le sirve)
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  res.json({ ok: true, name: 'PoxScore API', v: APP_VERSION, lan, build: webBuildId(), staleClient });
});
app.use('/api/auth', authRouter);

// Escrituras protegidas por rol SOLO cuando ya existen usuarios (auth opt-in):
// anotador = anotar juegos; admin = organización, stats, respaldo, publicación.
app.use('/api/teams', guard('admin'), teamsRouter);
app.use('/api/games', guard('anotador'), gamesRouter);
app.use('/api/games', guard('anotador'), eventsRouter);
app.use('/api/stats', guard('admin'), statsRouter);
app.use('/api/leagues', guard('admin'), leaguesRouter);
app.use('/api/backup', guard('admin'), backupRouter);
app.use('/api/publish', guard('admin'), publishRouter);
app.use('/api', guard('anotador'), aiRouter); // /ai/* y /games/:id/(validate-play|narrate|insights|share|boxscore-ai)

if (webDist) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist!, 'index.html')));
  console.log(`Sirviendo app web desde ${webDist}`);
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// Express 4 no atrapa errores lanzados dentro de handlers async — sin esto,
// un fallo de Prisma en cualquier ruta mata el proceso entero (Node corta
// por unhandledRejection). Registramos y seguimos sirviendo.
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`PoxScore API en http://localhost:${port}`));

// sondeo post-arranque: una consulta con campos nuevos del schema. Si el
// cliente generado es anterior, salta "Unknown argument" → aviso fuerte en
// el log y la app muestra un banner vía /api/health.
setTimeout(async () => {
  try {
    await prisma.gameEvent.findFirst({ where: { clientKey: '__sondeo__' }, select: { aiVoice: true } });
  } catch (e) {
    if (/Unknown argument/.test(String(e))) {
      staleClient = true;
      console.error('⚠ CLIENTE PRISMA DESACTUALIZADO — el código es más nuevo que node_modules/.prisma. Corre "npx prisma generate" dentro de server/ y reinicia.');
    }
  }
}, 3000);

// respaldo automático a disco: al arrancar, cada 6 h y al cerrar cada juego
startAutoBackup();

// limpieza idempotente: fusiona líneas duplicadas por jugador en Game.statLines
// (residuos de fusiones previas a esta versión o respaldos viejos restaurados)
consolidateStatLineDupes()
  .then((n) => { if (n) console.log(`statLines consolidadas en ${n} juego(s)`); })
  .catch((e) => console.error('consolidateStatLineDupes:', e));

// limpieza idempotente: fechas de juego a medianoche UTC exacta provienen del
// date-input viejo (guardaba "2026-04-15" como 00:00 UTC → en UTC-4/-5 se
// mostraba el día ANTERIOR). Se suben a mediodía UTC — gameDate() ya escribe
// así, esto repara lo guardado con la versión anterior.
prisma.$executeRaw`UPDATE Game SET date = DATE_ADD(date, INTERVAL 12 HOUR)
  WHERE HOUR(date) = 0 AND MINUTE(date) = 0 AND SECOND(date) = 0`
  .then((n) => { if (n) console.log(`fechas de juego normalizadas: ${n}`); })
  .catch((e) => console.error('fix fechas medianoche:', e));

// limpieza idempotente: notaciones malformadas guardadas por versiones viejas
// ("E2-2", "L-E7-7" — el guante duplicado inflaba además PO/asistencias de la
// jugada). Normaliza la notación y recalcula los créditos de fildeo.
repairEventNotation()
  .then((n) => { if (n) console.log(`notaciones de eventos reparadas: ${n}`); })
  .catch((e) => console.error('repairEventNotation:', e));

// sin auto-seed de admin: la app arranca en modo abierto (sin pantalla de
// login); quien quiera usuarios crea el primero en /usuarios
