// PoxScore Launcher — icono en bandeja de sistema que levanta el servidor
// y abre la app en el navegador. Menú: Abrir / Iniciar / Parar / Reiniciar / Salir.
//
// Usa tray_windows_release.exe (del paquete systray) con su protocolo JSON por
// stdin/stdout directamente — el wrapper npm tiene un bug que vacía el icono.
import { spawn, spawnSync, exec, execFile, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildIcon } from './icon.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const TRAY_BIN = path.join(DIR, 'node_modules', 'systray', 'traybin',
  process.platform === 'win32' ? 'tray_windows_release.exe' : 'tray_linux_release');
const PORT = Number(process.env.PORT ?? 4000);
const APP_URL = `http://localhost:${PORT}`;
const LOG = path.join(DIR, 'server.log');
const ICON_PATH = path.join(DIR, 'icon.png');

if (!fs.existsSync(ICON_PATH)) fs.writeFileSync(ICON_PATH, buildIcon());

// ── Una sola instancia del launcher ────────────────────────────────────
// pidfile + verificación de la línea de comandos (que sea ESTE launcher,
// no un pid reciclado). También cede si PoxScore.exe (panel) ya corre —
// son dos frontales del mismo servidor.
const PIDFILE = path.join(DIR, 'launcher.pid');
(function claimInstance() {
  try {
    const task = spawnSync('tasklist', ['/FI', 'IMAGENAME eq PoxScore.exe', '/NH'],
      { windowsHide: true, encoding: 'utf8' });
    if (/PoxScore\.exe/i.test(task.stdout || '')) process.exit(0);
    if (fs.existsSync(PIDFILE)) {
      const pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
      if (pid && pid !== process.pid) {
        const q = spawnSync('powershell',
          ['-NoProfile', '-NonInteractive', '-Command',
           `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
          { windowsHide: true, encoding: 'utf8' });
        if (/launcher\.mjs/i.test(q.stdout || '')) process.exit(0); // otra viva
      }
    }
  } catch {}
  try { fs.writeFileSync(PIDFILE, String(process.pid)); } catch {}
  process.on('exit', () => { try { fs.unlinkSync(PIDFILE); } catch {} });
})();

let server = null;
let starting = false;
let quitting = false;
let intentionalStop = false;   // parada manual — no reiniciar
let crashCount = 0;
let lastCrashAt = 0;

function log(line) {
  fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`);
}

function health() {
  return new Promise((resolve) => {
    const req = http.get(`${APP_URL}/api/health`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// navegador propio: LibreWolf portable en <raíz>\browser o instalado →
// la app abre en --kiosk (pantalla completa sin barras) con perfil dedicado:
// incógnito permanente, micrófono concedido, diálogo de impresión normal.
function findLibreWolf() {
  const bd = path.join(ROOT, 'browser');
  try {
    const stack = [bd];
    while (stack.length) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name.toLowerCase() === 'librewolf.exe') return p;
      }
    }
  } catch {}
  for (const c of [
    'C:\\Program Files\\LibreWolf\\librewolf.exe',
    'C:\\Program Files (x86)\\LibreWolf\\librewolf.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'LibreWolf', 'librewolf.exe'),
  ]) if (fs.existsSync(c)) return c;
  return null;
}

function ensureBrowserProfile() {
  const prof = path.join(ROOT, 'browser', 'perfil');
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'user.js'), [
    '// PoxScore — perfil dedicado (lo regenera el launcher, no editar)',
    'user_pref("browser.privatebrowsing.autostart", true);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("browser.rights.3.shown", true);',
    'user_pref("trailhead.firstrun.didSeeAboutWelcome", true);',
    'user_pref("browser.sessionstore.resume_from_crash", false);',
    'user_pref("browser.tabs.warnOnClose", false);',
    'user_pref("signon.rememberSignons", false);',
    'user_pref("media.navigator.permission.disabled", true);',
    'user_pref("permissions.default.microphone", 1);',
    'user_pref("media.webspeech.synth.enabled", true);',
    'user_pref("media.autoplay.default", 0);',
    'user_pref("media.autoplay.blocking_policy", 0);',
    'user_pref("print.always_print_silent", false);',
    'user_pref("print.show_print_progress", true);',
    'user_pref("dom.security.https_only_mode", false);',
    'user_pref("dom.security.https_only_mode.upgrade_local", false);',
    'user_pref("privacy.resistFingerprinting.letterboxing", false);',
    'user_pref("browser.tabs.drawInTitlebar", false);',        // barra de título NATIVA (min/max/cerrar)
    'user_pref("browser.tabs.inTitlebar", 0);',
    'user_pref("browser.tabs.autohide", true);',               // sin barra de pestañas (1 sola)
    'user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);', // userChrome.css
    'user_pref("app.update.auto", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    '',
  ].join('\r\n'));
  // oculta las barras del navegador — la ventana queda solo con el contenido
  // + la barra de título de Windows (botones minimizar/maximizar/cerrar)
  const chromeDir = path.join(prof, 'chrome');
  fs.mkdirSync(chromeDir, { recursive: true });
  fs.writeFileSync(path.join(chromeDir, 'userChrome.css'), [
    '/* PoxScore — ventana tipo app: sin barras del navegador, con título nativo */',
    '#navigator-toolbox { visibility: collapse !important; }',
    '',
  ].join('\r\n'));
  // abrir maximizada (xulstore guarda el estado de la ventana)
  fs.writeFileSync(path.join(prof, 'xulstore.json'),
    JSON.stringify({ 'chrome://browser/content/browser.xhtml': { 'main-window': { sizemode: 'maximized' } } }));
  return prof;
}

// Edge/Chrome en modo --app: misma ventana "tipo app" pero CON Web Speech API
// (la voz funciona sin clave OpenAI — LibreWolf no tiene SpeechRecognition).
function findChromium() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const la = process.env.LOCALAPPDATA || '';
  const cands = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return cands.find((c) => fs.existsSync(c)) || null;
}

// ── Una sola ventana de la app ──────────────────────────────────────────
// Si ya hay una ventana de la app abierta (Chromium --app con cr-perfil,
// LibreWolf con browser\perfil, o cualquier navegador con "PoxScore" en el
// título) solo la trae al frente — sin esto cada clic en "Abrir PoxScore"
// o auto-apertura levantaba otra ventana (a veces 3-4 a la vez).
function focusAppWindow() {
  const ps = [
    `$own = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe' or Name='librewolf.exe'" |`,
    ` Where-Object { $_.CommandLine -match 'cr-perfil|browser.perfil' } |`,
    ` ForEach-Object { $_.ProcessId })`,
    `$sig = '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);` +
      `[DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr h, int s);'`,
    `$t = Add-Type -MemberDefinition $sig -Name W32 -Namespace Pox -PassThru`,
    `$w = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and`,
    ` (($own -contains $_.Id) -or ($_.MainWindowTitle -match '(?i)poxscore' -and`,
    ` $_.ProcessName -match '^(msedge|chrome|librewolf|firefox|opera|brave|vivaldi)$')) } | Select-Object -First 1`,
    `if ($w) { $t::ShowWindowAsync($w.MainWindowHandle, 9) | Out-Null; $t::SetForegroundWindow($w.MainWindowHandle) | Out-Null; exit 0 }`,
    `exit 1`,
  ].join('\r\n');
  try {
    const r = spawnSync('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true, timeout: 15000 });
    return r.status === 0;
  } catch { return false; }
}

let lastOpenAt = 0;

function openBrowser(forceNew = false) {
  if (!forceNew) {
    // anti ráfaga: si hace <8s lanzamos el navegador (clic repetido mientras
    // la ventana aún no aparece), no lanzar otro
    if (Date.now() - lastOpenAt < 8000) { log('La app se está abriendo — espera'); return; }
    if (focusAppWindow()) { log('La app ya estaba abierta — ventana al frente'); return; }
  }
  lastOpenAt = Date.now();
  const cr = findChromium();
  if (cr) {
    // --app: ventana sin barras con título nativo · perfil dedicado (persisten
    // permisos/ajustes) · fake-ui auto-concede el micrófono · sin first-run
    const prof = path.join(ROOT, 'browser', 'cr-perfil');
    try { fs.mkdirSync(prof, { recursive: true }); } catch { }
    execFile(cr, ['--user-data-dir=' + prof, '--app=' + APP_URL, '--no-first-run', '--no-default-browser-check'], { windowsHide: true });
    return;
  }
  const lw = findLibreWolf();
  if (lw) {
    const prof = ensureBrowserProfile();
    // -no-remote: no delegar en un LibreWolf ya abierto (perdería el perfil).
    // Ventana tipo app: sin barras (userChrome.css) pero CON la barra de
    // título de Windows → botones minimizar/maximizar/cerrar.
    // OJO: -width/-height NO existen en Windows — se comían la URL y quedaba
    // página en blanco. Maximizada via xulstore.json del perfil.
    execFile(lw, ['-no-remote', '-profile', prof, '-new-window', APP_URL], { windowsHide: true });
  } else {
    exec(`start "" "${APP_URL}"`, { windowsHide: true });
  }
}

function startServer() {
  if (server || starting) return;
  starting = true;
  const distEntry = path.join(SERVER_DIR, 'dist', 'index.js');
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  let args;
  if (fs.existsSync(distEntry)) args = [distEntry];
  else if (fs.existsSync(tsxCli)) args = [tsxCli, path.join('src', 'index.ts')];
  else {
    log('ERROR: no se encontró server/dist/index.js ni tsx');
    starting = false;
    return;
  }
  log(`Iniciando servidor: node ${args.join(' ')}`);
  server = spawn(process.execPath, args, {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT) },
    windowsHide: true,
  });
  server.stdout.on('data', (d) => log(d.toString().trimEnd()));
  server.stderr.on('data', (d) => log(d.toString().trimEnd()));
  server.on('error', (e) => {
    log(`ERROR al iniciar servidor: ${e.message}`);
    server = null;
    starting = false;
    refreshMenu();
  });
  server.on('exit', (code) => {
    log(`Servidor terminó (code ${code})`);
    server = null;
    starting = false;
    refreshMenu();
    // reinicio automático si murió solo (no por Parar/Reiniciar/Salir):
    // un crash ya no deja la app desconectada hasta reinicio manual.
    if (!quitting && !intentionalStop) {
      const now = Date.now();
      crashCount = now - lastCrashAt > 60000 ? 1 : crashCount + 1; // >1 min sano → resetea
      lastCrashAt = now;
      if (crashCount <= 5) {
        log(`Reinicio automático en 3s (fallo #${crashCount})`);
        setTimeout(() => { if (!quitting && !server) startServer(); }, 3000);
      } else {
        log('Demasiados fallos seguidos — sin reinicio automático. Revisa este log.');
      }
    }
    intentionalStop = false;
  });
  refreshMenu();
}

// Cierra la ventana dedicada de la app (Chromium --app / LibreWolf con
// perfil propio) — al parar el servidor quedaría muerta con errores.
function closeAppWindow() {
  const ps = [
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe' or Name='librewolf.exe'" |`,
    ` Where-Object { $_.CommandLine -match 'cr-perfil|browser.perfil' } |`,
    ` ForEach-Object { try { (Get-Process -Id $_.ProcessId -ErrorAction Stop).CloseMainWindow() | Out-Null } catch {} }`,
  ].join('\r\n');
  try {
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 15000 });
  } catch {}
}

function stopServer(closeApp = true) {
  return new Promise((resolve) => {
    if (!server) { if (closeApp) closeAppWindow(); return resolve(); }
    intentionalStop = true;
    const pid = server.pid;
    server = null;
    exec(`taskkill /pid ${pid} /t /f`, { windowsHide: true }, () => {
      if (closeApp) closeAppWindow();
      resolve();
    });
  });
}

// ── Bandeja: protocolo JSON del binario systray ─────────────────────────────
if (!fs.existsSync(TRAY_BIN)) {
  log(`ERROR: falta ${TRAY_BIN} — ejecuta "npm install" en launcher/`);
  process.exit(1);
}
const tray = spawn(TRAY_BIN, [], { windowsHide: true });
tray.on('error', (e) => { log(`ERROR tray: ${e.message}`); process.exit(1); });
const rl = readline.createInterface({ input: tray.stdout });
// cola: el binario ignora comandos que lleguen antes de su "ready"
let trayReady = false;
const trayQueue = [];
const trayWrite = (obj) => {
  if (trayReady) tray.stdin.write(JSON.stringify(obj) + '\n');
  else trayQueue.push(obj);
};
tray.on('exit', () => shutdown());
tray.stderr.on('data', (d) => log(`tray: ${d.toString().trimEnd()}`));

const S = { status: 0, open: 1, openNew: 2, toggle: 3, restart: 4, sep: 5, quit: 6 };
const on = () => !!server;

const MENU = () => ({
  icon: fs.readFileSync(ICON_PATH).toString('base64'),
  title: 'PoxScore',
  tooltip: 'PoxScore',
  items: [
    { title: on() ? '● Servidor activo' : '○ Servidor detenido', tooltip: '', checked: false, enabled: false },
    { title: 'Abrir PoxScore', tooltip: 'Abrir en el navegador', checked: false, enabled: true },
    { title: 'Abrir en otra ventana', tooltip: 'Segunda ventana a propósito (pantalla/OBS)', checked: false, enabled: true },
    { title: on() ? 'Parar servidor' : 'Iniciar servidor', tooltip: '', checked: false, enabled: !starting },
    { title: 'Reiniciar servidor', tooltip: '', checked: false, enabled: on() },
    { title: '──────────────', tooltip: '', checked: false, enabled: false },
    { title: 'Salir', tooltip: 'Parar servidor y cerrar', checked: false, enabled: true },
  ],
});

function refreshMenu() {
  trayWrite({ type: 'update-menu', menu: MENU() });
}

async function shutdown() {
  if (quitting) return;
  quitting = true;
  await stopServer();
  try { tray.kill(); } catch { /* ya muerto */ }
  process.exit(0);
}

rl.on('line', async (line) => {
  let action;
  try { action = JSON.parse(line); } catch { log(`tray> ${line}`); return; }
  if (action.type === 'ready') {
    trayReady = true;
    trayWrite(MENU());
    while (trayQueue.length) tray.stdin.write(JSON.stringify(trayQueue.shift()) + '\n');
    return;
  }
  if (action.type !== 'clicked') return;
  switch (action.seq_id) {
    case S.open:
      if (await health()) { openBrowser(); break; }
      startServer();
      waitAndOpen();
      break;
    case S.openNew:
      if (await health()) { openBrowser(true); break; }
      startServer();
      waitAndOpen();
      break;
    case S.toggle:
      if (server) { await stopServer(true); refreshMenu(); } else startServer();
      break;
    case S.restart:
      await stopServer(false);   // reinicio: la ventana queda y reconecta
      startServer();
      break;
    case S.quit:
      await shutdown();
      break;
  }
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// último recurso: si el proceso muere sin pasar por shutdown(), matar el árbol
process.on('exit', () => {
  if (server) {
    try { execSync(`taskkill /pid ${server.pid} /t /f`, { windowsHide: true }); } catch { }
  }
});

// espera a que la API responda y abre el navegador (máx ~60s)
async function waitAndOpen() {
  for (let i = 0; i < 120; i++) {
    if (await health()) { openBrowser(); return; }
    await new Promise((r) => setTimeout(r, 500));
  }
  log('WARN: el servidor no respondió en 60s');
}

// Arranque automático: servidor → esperar health → abrir navegador
(async () => {
  startServer();
  await waitAndOpen();
})();
