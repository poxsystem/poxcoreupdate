using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

// PoxScore — lanzador del servidor (v2, limpio y rápido).
// Al abrirlo: detecta el servidor al instante (escaneo en memoria de puertos
// LISTENING, sin HTTP cuando no hay nadie escuchando); si está apagado lo
// arranca solo, y en cuanto /api/health responde (verde) abre la app.
// El panel solo muestra el ESTADO — las acciones administrativas quedan en
// el menú del icono de bandeja (clic derecho).

public class PoxScoreControl : Form
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const int PortFirst = 4000;
    private const int PortLast = 4009;
    private const int PollStartingMs = 200;   // chequeo veloz mientras arranca (casi gratis: solo escaneo de listeners)
    private const int PollOnlineMs = 4000;    // vigilancia tranquila cuando ya está en línea
    private const int PollStoppedMs = 1500;   // el usuario lo detuvo a propósito
    private int currentPort = PortFirst;
    private string HealthUrl { get { return "http://127.0.0.1:" + currentPort + "/api/health"; } }
    private string AppUrl { get { return "http://localhost:" + currentPort; } }

    private readonly string appDir;   // carpeta del exe (launcher\)
    private readonly string rootDir;  // raíz del proyecto (.. del launcher)
    private readonly string srvDir;   // server\
    private readonly string logPath;
    private Process serverProc;
    private bool checking;
    private bool startingServer;      // StartServer en curso → no duplicar node
    private bool manualStop;          // parada del usuario → no auto-reiniciar
    private int crashCount;
    private DateTime lastCrashAt = DateTime.MinValue;
    private readonly object logLock = new object();
    private readonly Icon appIcon;

    private Label dotLabel;
    private Label statusLabel;
    private Label urlLabel;
    private Label msgLabel;
    private Button btnOpen;
    private NotifyIcon tray;
    private Timer timer;
    private bool ejBusy;
    private bool appLaunched;         // la app ya se abrió en su navegador
    private DateTime lastOpenAt = DateTime.MinValue; // último lanzamiento del navegador
    private DateTime hidePanelAt = DateTime.MinValue; // cuándo esconder el panel a la bandeja

    public PoxScoreControl(bool autoStart)
    {
        appDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        rootDir = Directory.GetParent(appDir).FullName;
        // exe en launcher\ → ..\server · exe suelto en la raíz → .\server
        srvDir = Directory.Exists(Path.Combine(rootDir, "server"))
            ? Path.Combine(rootDir, "server")
            : Path.Combine(appDir, "server");
        logPath = Path.Combine(appDir, "server.log");
        appIcon = LoadAppIcon();

        Text = "PoxScore";
        ClientSize = new Size(340, 160);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        Icon = appIcon;
        BackColor = Color.White;

        var title = new Label
        {
            Text = "PoxScore",
            Font = new Font("Segoe UI", 17, FontStyle.Bold),
            ForeColor = Color.FromArgb(30, 58, 95),
            AutoSize = true,
            Left = 20, Top = 12
        };

        urlLabel = new Label
        {
            Text = AppUrl,
            Font = new Font("Segoe UI", 8.5f),
            ForeColor = Color.Gray,
            AutoSize = true,
            Left = 21, Top = 44
        };

        dotLabel = new Label
        {
            Text = "●",
            Font = new Font("Segoe UI", 22, FontStyle.Bold),
            ForeColor = Color.FromArgb(217, 119, 6),   // ámbar — arrancando
            AutoSize = true,
            Left = 16, Top = 62
        };

        statusLabel = new Label
        {
            Text = "Conectando...",
            Font = new Font("Segoe UI", 11, FontStyle.Bold),
            ForeColor = Color.FromArgb(51, 65, 85),
            AutoSize = true,
            Left = 54, Top = 66
        };

        msgLabel = new Label
        {
            Text = "Buscando el servidor",
            Font = new Font("Segoe UI", 8),
            ForeColor = Color.Gray,
            AutoSize = true,
            Left = 55, Top = 88
        };

        btnOpen = new Button
        {
            Text = "Abrir PoxScore",
            Font = new Font("Segoe UI", 9, FontStyle.Bold),
            Left = 20, Top = 112, Width = 300, Height = 34,
            BackColor = Color.FromArgb(30, 58, 95),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            Enabled = false
        };
        btnOpen.Click += (s, e) => Task.Run(() => OpenApp(false));

        Controls.AddRange(new Control[] { title, urlLabel, dotLabel, statusLabel, msgLabel, btnOpen });

        // ── Menú de bandeja: toda la administración vive aquí ──────────
        var menu = new ContextMenuStrip();
        menu.Items.Add("Abrir PoxScore", null, (s, e) => Task.Run(() => OpenApp(false)));
        menu.Items.Add("Abrir en otra ventana", null, (s, e) => Task.Run(() => OpenApp(true)));
        menu.Items.Add(new ToolStripSeparator());
        var miStartStop = new ToolStripMenuItem("Detener servidor", null, (s, e) => Task.Run(() => StopServer()));
        var miRestart = new ToolStripMenuItem("Reiniciar servidor", null, (s, e) => Task.Run(() => { StopServer(); System.Threading.Thread.Sleep(400); manualStop = false; BeginInvoke((Action)(() => StartServer())); }));
        var miLog = new ToolStripMenuItem("Ver log del servidor", null, (s, e) =>
        {
            try { Process.Start(File.Exists(logPath) ? logPath : appDir); } catch { }
        });
        menu.Items.Add(miStartStop);
        menu.Items.Add(miRestart);
        menu.Items.Add(miLog);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Cargar datos ejemplo", null, (s, e) => CargarEjemplo());
        menu.Items.Add("Borrar datos ejemplo", null, (s, e) => BorrarEjemplo());
        menu.Items.Add(new ToolStripSeparator());
        var miStartup = new ToolStripMenuItem("Iniciar con Windows") { Checked = IsInStartup(), CheckOnClick = true };
        miStartup.CheckedChanged += (s, e) => SetStartup(miStartup.Checked);
        menu.Items.Add(miStartup);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Mostrar panel", null, (s, e) => ShowWindow());
        menu.Items.Add("Salir (el servidor sigue)", null, (s, e) => { tray.Visible = false; Application.Exit(); });
        menu.Items.Add("Detener servidor y salir", null, (s, e) =>
        {
            tray.Visible = false;
            Task.Run(() => { StopServer(); BeginInvoke((Action)(() => Application.Exit())); });
        });

        tray = new NotifyIcon
        {
            Text = "PoxScore",
            Icon = appIcon ?? SystemIcons.Application,
            ContextMenuStrip = menu
        };
        tray.DoubleClick += (s, e) => ShowWindow();

        timer = new Timer { Interval = PollStartingMs };
        timer.Tick += async (s, e) => await CheckHealth();
        timer.Start();

        Load += async (s, e) =>
        {
            if (autoStart) WindowState = FormWindowState.Minimized;
            // primer chequeo YA: sin nadie escuchando tarda <1ms (RunningPort
            // solo mira listeners TCP) y StartServer sale enseguida
            await CheckHealth();
        };
    }

    private enum St { Connecting, Starting, Online, Stopped }
    private St lastState = (St)(-1);

    private void SetStatus(St st)
    {
        if (st == lastState && st != St.Online) { /* solo repintar si cambia */ }
        lastState = st;
        switch (st)
        {
            case St.Connecting:
                dotLabel.ForeColor = Color.FromArgb(217, 119, 6);
                statusLabel.Text = "Conectando...";
                msgLabel.Text = "Buscando el servidor";
                break;
            case St.Starting:
                dotLabel.ForeColor = Color.FromArgb(217, 119, 6);
                statusLabel.Text = "Iniciando servidor...";
                if (msgLabel.Text != "Abriendo la aplicación...") msgLabel.Text = "Arrancando Node.js";
                break;
            case St.Online:
                dotLabel.ForeColor = Color.FromArgb(22, 163, 74);
                statusLabel.Text = "Servidor en línea";
                statusLabel.ForeColor = Color.FromArgb(22, 163, 74);
                break;
            case St.Stopped:
                dotLabel.ForeColor = Color.FromArgb(220, 38, 38);
                statusLabel.Text = "Servidor detenido";
                statusLabel.ForeColor = Color.FromArgb(51, 65, 85);
                msgLabel.Text = "Reinicia desde el icono de la bandeja";
                break;
        }
        if (st != St.Online) statusLabel.ForeColor = Color.FromArgb(51, 65, 85);
        urlLabel.Text = AppUrl;
        btnOpen.Enabled = st == St.Online;
        tray.Text = st == St.Online ? "PoxScore — en línea :" + currentPort : "PoxScore — " + statusLabel.Text;
    }

    private void SetMsg(string t) { msgLabel.Text = t; }

    private void HideToTray()
    {
        Hide();
        tray.Visible = true;
    }

    private Icon LoadAppIcon()
    {
        try
        {
            var ico = Path.Combine(appDir, "icon.ico");
            if (File.Exists(ico)) return new Icon(ico);
            var png = Path.Combine(appDir, "icon.png");
            if (File.Exists(png))
            {
                using (var bmp = new Bitmap(png))
                {
                    var h = bmp.GetHicon();
                    var ic = (Icon)Icon.FromHandle(h).Clone();
                    DestroyIcon(h);                 // sin esto se fugaba un HICON por llamada
                    return ic;
                }
            }
            return Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch { return null; }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr hIcon);

    private void LogLine(string line)
    {
        try { lock (logLock) File.AppendAllText(logPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + line + "\r\n"); }
        catch { }
    }

    // ── Puertos ──────────────────────────────────────────────────────────
    // Puertos 4000-4009 realmente en LISTENING (lectura en memoria del kernel,
    // <1ms) — sin HTTP y sin timeout cuando el servidor está apagado.
    private static HashSet<int> ListeningPoxPorts()
    {
        var set = new HashSet<int>();
        try
        {
            foreach (var ep in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
                if (ep.Port >= PortFirst && ep.Port <= PortLast) set.Add(ep.Port);
        }
        catch { }
        return set;
    }

    // Puerto donde YA responde un server PoxScore (0 = ninguno vivo).
    private int RunningPort()
    {
        foreach (var p in ListeningPoxPorts())
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + p + "/api/health");
                req.Proxy = null;                    // sin WPAD: el 1er request con auto-proxy tardaba 1-3s
                req.KeepAlive = false;
                req.Timeout = 300;
                req.ReadWriteTimeout = 300;
                using (var res = (HttpWebResponse)req.GetResponse())
                    if (res.StatusCode == HttpStatusCode.OK) return p;
            }
            catch { }
        }
        return 0;
    }

    // Primer puerto libre para arrancar (nada escuchando ahí).
    private int FreePort()
    {
        var busy = ListeningPoxPorts();
        for (int p = PortFirst; p <= PortLast; p++)
            if (!busy.Contains(p)) return p;
        return PortFirst; // sin libres — el server reportará el error en el log
    }

    private void StartServer()
    {
        if (IsDisposed) return;
        if (InvokeRequired) { try { BeginInvoke((Action)(() => StartServer())); } catch { } return; }
        if (startingServer) return;
        if (serverProc != null && !serverProc.HasExited) return;
        if (RunningPort() > 0) return;               // alguien ya está sirviendo
        startingServer = true;
        try
        {
            // producción: server\dist\index.js · respaldo dev: tsx src\index.ts
            var distEntry = File.Exists(Path.Combine(srvDir, "dist", "index.js"))
                ? Path.Combine(srvDir, "dist", "index.js")
                : Path.Combine(appDir, "server", "dist", "index.js");
            var tsxCli = File.Exists(Path.Combine(rootDir, "node_modules", "tsx", "dist", "cli.mjs"))
                ? Path.Combine(rootDir, "node_modules", "tsx", "dist", "cli.mjs")
                : Path.Combine(appDir, "node_modules", "tsx", "dist", "cli.mjs");
            string args;
            if (File.Exists(distEntry)) args = "\"" + distEntry + "\"";
            else if (File.Exists(tsxCli)) args = "\"" + tsxCli + "\" src\\index.ts";
            else
            {
                SetStatus(St.Stopped);
                SetMsg("Falta server\\dist\\index.js");
                LogLine("No se encontró el servidor (dist\\index.js ni tsx)");
                return;
            }
            manualStop = false;
            currentPort = FreePort();
            var workDir = File.Exists(distEntry) ? Directory.GetParent(distEntry).Parent.FullName : srvDir;
            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = args,
                WorkingDirectory = workDir,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            psi.EnvironmentVariables["PORT"] = currentPort.ToString();
            var prev = serverProc;
            serverProc = Process.Start(psi);
            if (prev != null) try { prev.Dispose(); } catch { }
            var proc = serverProc;
            serverProc.OutputDataReceived += (s, e) => { if (e.Data != null) LogLine(e.Data); };
            serverProc.ErrorDataReceived += (s, e) => { if (e.Data != null) LogLine(e.Data); };
            serverProc.BeginOutputReadLine();
            serverProc.BeginErrorReadLine();
            // auto-reinicio si el proceso muere sin que el usuario lo detenga
            serverProc.EnableRaisingEvents = true;
            serverProc.Exited += (s, e) =>
            {
                try { LogLine("Servidor terminó (code " + proc.ExitCode + ")"); } catch { }
                if (!manualStop && !IsDisposed)
                {
                    if ((DateTime.Now - lastCrashAt).TotalSeconds > 60) crashCount = 0;
                    crashCount++;
                    lastCrashAt = DateTime.Now;
                    if (crashCount <= 5)
                    {
                        LogLine("Reinicio automático en 3s (fallo #" + crashCount + ")");
                        Task.Delay(3000).ContinueWith(_ =>
                        {
                            if (!manualStop && !IsDisposed)
                                try { BeginInvoke((Action)(() => StartServer())); } catch { }
                        });
                    }
                    else LogLine("Demasiados fallos seguidos — sin reinicio automático. Revisa el log.");
                }
            };
            SetStatus(St.Starting);
            LogLine("Servidor iniciado en :" + currentPort + " — node " + args);
        }
        catch (Exception ex)
        {
            SetStatus(St.Stopped);
            SetMsg("No se pudo iniciar (¿falta Node.js?)");
            LogLine("StartServer falló: " + ex.Message);
        }
        finally { startingServer = false; }
    }

    private void StopServer()
    {
        manualStop = true;
        try
        {
            if (serverProc != null && !serverProc.HasExited)
            {
                // matar el arbol completo (node puede haber generado hijos)
                var tk = new ProcessStartInfo { FileName = "taskkill", Arguments = "/pid " + serverProc.Id + " /t /f", CreateNoWindow = true, UseShellExecute = false };
                Process.Start(tk).WaitForExit(3000);
            }
        }
        catch { }

        // respaldo: cualquier node.exe cuya línea de comandos sea de este proyecto
        try
        {
            using (var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'node.exe'"))
            {
                foreach (ManagementObject proc in searcher.Get())
                {
                    var cmd = (proc["CommandLine"] as string ?? "").ToLowerInvariant().Replace('/', '\\');
                    bool esPoxscore = cmd.IndexOf("poxscore", StringComparison.Ordinal) >= 0 &&
                        (cmd.IndexOf("server\\dist\\index.js", StringComparison.Ordinal) >= 0 ||
                         cmd.IndexOf("src\\index.ts", StringComparison.Ordinal) >= 0 ||
                         cmd.IndexOf("launcher.mjs", StringComparison.Ordinal) >= 0);
                    if (esPoxscore)
                    {
                        try { Process.GetProcessById(Convert.ToInt32(proc["ProcessId"])).Kill(); } catch { }
                    }
                }
            }
        }
        catch { }

        // cierra la ventana dedicada de la app (la del perfil propio) —
        // sin servidor quedaría muerta mostrando errores de conexión
        CloseAppWindow();

        LogLine("Servidor detenido");
    }

    private async Task CheckHealth()
    {
        if (checking) return;
        checking = true;
        int alive = await Task.Run(() => RunningPort());
        checking = false;

        if (IsDisposed) return;
        bool ok = alive > 0;
        if (ok) currentPort = alive;

        if (ok)
        {
            timer.Interval = PollOnlineMs;
            SetStatus(St.Online);
            // al ponerse verde: abrir la app UNA vez y esconder el panel
            if (!appLaunched)
            {
                appLaunched = true;
                SetMsg("Abriendo la aplicación...");
                Task.Run(() => OpenApp(false));
                Task.Delay(1800).ContinueWith(_ =>
                {
                    if (!IsDisposed)
                        try { BeginInvoke((Action)(() => { if (!IsDisposed && Visible) HideToTray(); })); } catch { }
                });
            }
            else if (msgLabel.Text == "Abriendo la aplicación...") SetMsg("Aplicación abierta");
        }
        else
        {
            appLaunched = false;
            bool nuestroVivo = startingServer || (serverProc != null && !serverProc.HasExited);
            if (nuestroVivo)
            {
                timer.Interval = PollStartingMs;
                SetStatus(St.Starting);
            }
            else if (manualStop)
            {
                timer.Interval = PollStoppedMs;
                SetStatus(St.Stopped);
            }
            else
            {
                // nadie escucha y no hay proceso nuestro → arrancarlo ya
                timer.Interval = PollStartingMs;
                SetStatus(St.Starting);
                StartServer();
            }
        }
    }

    // ===================== NAVEGADOR PROPIO (LibreWolf) =====================
    // Abre la app en modo --kiosk: pantalla completa, sin barras ni pestañas —
    // se siente como una app de escritorio. Perfil propio en browser\perfil
    // con incógnito permanente, micrófono concedido y diálogo de impresión
    // normal (para elegir en qué impresora/PDF imprimir).
    // Si LibreWolf no está, cae al navegador por defecto (comportamiento viejo).

    private string FindLibreWolf()
    {
        // 1) portable junto a la instalación: <raíz>\browser\...\librewolf.exe
        try
        {
            var bd = Path.Combine(rootDir, "browser");
            if (Directory.Exists(bd))
            {
                var hits = Directory.GetFiles(bd, "librewolf.exe", SearchOption.AllDirectories);
                if (hits.Length > 0) return hits[0];
            }
        }
        catch { }
        // 2) instalado en el sistema
        var cands = new string[]
        {
            Path.Combine(Environment.GetEnvironmentVariable("ProgramFiles") ?? @"C:\Program Files", "LibreWolf", "librewolf.exe"),
            Path.Combine(Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? @"C:\Program Files (x86)", "LibreWolf", "librewolf.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "LibreWolf", "librewolf.exe"),
        };
        foreach (var c in cands) if (File.Exists(c)) return c;
        return null;
    }

    // Perfil dedicado: se reescribe user.js en cada arranque (idempotente).
    private string EnsureBrowserProfile()
    {
        var prof = Path.Combine(rootDir, "browser", "perfil");
        Directory.CreateDirectory(prof);
        File.WriteAllText(Path.Combine(prof, "user.js"),
            "// PoxScore — perfil dedicado (lo regenera el launcher, no editar)\r\n" +
            "user_pref(\"browser.privatebrowsing.autostart\", true);\r\n" +      // incógnito permanente
            "user_pref(\"browser.shell.checkDefaultBrowser\", false);\r\n" +
            "user_pref(\"browser.aboutwelcome.enabled\", false);\r\n" +
            "user_pref(\"browser.rights.3.shown\", true);\r\n" +
            "user_pref(\"trailhead.firstrun.didSeeAboutWelcome\", true);\r\n" +
            "user_pref(\"browser.sessionstore.resume_from_crash\", false);\r\n" +
            "user_pref(\"browser.tabs.warnOnClose\", false);\r\n" +
            "user_pref(\"signon.rememberSignons\", false);\r\n" +
            "user_pref(\"media.navigator.permission.disabled\", true);\r\n" +   // micrófono sin preguntar
            "user_pref(\"permissions.default.microphone\", 1);\r\n" +
            "user_pref(\"media.webspeech.synth.enabled\", true);\r\n" +         // TTS del narrador
            "user_pref(\"media.autoplay.default\", 0);\r\n" +                   // audio sin bloqueo
            "user_pref(\"media.autoplay.blocking_policy\", 0);\r\n" +
            "user_pref(\"print.always_print_silent\", false);\r\n" +            // diálogo → elegir impresora
            "user_pref(\"print.show_print_progress\", true);\r\n" +
            "user_pref(\"dom.security.https_only_mode\", false);\r\n" +         // la app es http://localhost
            "user_pref(\"dom.security.https_only_mode.upgrade_local\", false);\r\n" +
            "user_pref(\"privacy.resistFingerprinting.letterboxing\", false);\r\n" +
            "user_pref(\"browser.tabs.drawInTitlebar\", false);\r\n" +       // barra de título NATIVA
            "user_pref(\"browser.tabs.inTitlebar\", 0);\r\n" +               // (min/max/cerrar visibles)
            "user_pref(\"browser.tabs.autohide\", true);\r\n" +               // sin barra de pestañas (1 sola)
            "user_pref(\"toolkit.legacyUserProfileCustomizations.stylesheets\", true);\r\n" + // userChrome.css
            "user_pref(\"app.update.auto\", false);\r\n" +
            "user_pref(\"datareporting.policy.dataSubmissionEnabled\", false);\r\n");
        // oculta las barras del navegador (pestañas/direcciones/marcadores) —
        // la ventana queda solo con el contenido + la barra de título de Windows
        var chromeDir = Path.Combine(prof, "chrome");
        Directory.CreateDirectory(chromeDir);
        File.WriteAllText(Path.Combine(chromeDir, "userChrome.css"),
            "/* PoxScore — ventana tipo app: sin barras del navegador, con título nativo */\r\n" +
            "#navigator-toolbox { visibility: collapse !important; }\r\n");
        // abrir maximizada (xulstore guarda el estado de la ventana)
        File.WriteAllText(Path.Combine(prof, "xulstore.json"),
            "{\"chrome://browser/content/browser.xhtml\":{\"main-window\":{\"sizemode\":\"maximized\"}}}");
        return prof;
    }

    // Edge/Chrome en modo --app: misma ventana "tipo app" (sin barras, con — ▢ ✕)
    // pero CON Web Speech API → la voz funciona sin clave OpenAI.
    // LibreWolf no tiene SpeechRecognition (siempre requiere Whisper+clave).
    private string FindChromium()
    {
        var pf = Environment.GetEnvironmentVariable("ProgramFiles") ?? @"C:\Program Files";
        var pf86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? @"C:\Program Files (x86)";
        var la = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var cands = new string[]
        {
            Path.Combine(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(pf, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(pf86, "Google", "Chrome", "Application", "chrome.exe"),
            Path.Combine(la, "Google", "Chrome", "Application", "chrome.exe"),
        };
        foreach (var c in cands) if (File.Exists(c)) return c;
        return null;
    }

    // ── Una sola ventana de la app ─────────────────────────────────────
    // Antes de abrir otra ventana busca una ya abierta y la trae al frente:
    //   · Chromium --app con el perfil dedicado (cr-perfil en su cmdline)
    //   · LibreWolf con browser\perfil
    //   · cualquier navegador conocido con "PoxScore" en el título
    //     (respaldo: navegador por defecto, donde no hay perfil propio)
    // Sin esto cada clic en "Abrir"/auto-apertura/doble instancia del
    // launcher levantaba otra ventana — a veces 3 o 4 a la vez.
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    private static readonly string[] BrowserNames =
        { "msedge", "chrome", "librewolf", "firefox", "opera", "brave", "vivaldi" };

    // Cierra la ventana de la app abierta con perfil dedicado (Chromium
    // --app o LibreWolf) — se llama al DETENER el servidor para que no
    // quede una ventana muerta mostrando errores de conexión.
    private void CloseAppWindow()
    {
        try
        {
            var pids = new List<int>();
            using (var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'msedge.exe' OR Name = 'chrome.exe' OR Name = 'librewolf.exe'"))
            {
                foreach (ManagementObject proc in searcher.Get())
                {
                    var cmd = (proc["CommandLine"] as string ?? "").ToLowerInvariant().Replace('/', '\\');
                    if (cmd.IndexOf("cr-perfil", StringComparison.Ordinal) >= 0 ||
                        cmd.IndexOf("browser\\perfil", StringComparison.Ordinal) >= 0)
                        pids.Add(Convert.ToInt32(proc["ProcessId"]));
                }
            }
            foreach (var id in pids)
            {
                try
                {
                    var p = Process.GetProcessById(id);
                    if (p.MainWindowHandle != IntPtr.Zero) p.CloseMainWindow();
                }
                catch { }
            }
        }
        catch { }
    }

    // ¿Hay ALGÚN navegador corriendo? (barato — evita la consulta WMI cuando
    // ni siquiera hay un browser abierto, que era ~500-1500ms de regalo)
    private static bool AnyBrowserRunning()
    {
        foreach (var p in Process.GetProcesses())
        {
            try { if (Array.IndexOf(BrowserNames, p.ProcessName.ToLowerInvariant()) >= 0) return true; }
            catch { }
            finally { p.Dispose(); }
        }
        return false;
    }

    private bool FocusAppWindow()
    {
        try
        {
            // 1) pase rápido sin WMI: cualquier navegador con "PoxScore" en el título
            foreach (var p in Process.GetProcesses())
            {
                try
                {
                    if (Array.IndexOf(BrowserNames, p.ProcessName.ToLowerInvariant()) < 0) continue;
                    if ((p.MainWindowTitle ?? "").ToLowerInvariant().IndexOf("poxscore", StringComparison.Ordinal) < 0) continue;
                    if (p.MainWindowHandle != IntPtr.Zero)
                    {
                        ShowWindowAsync(p.MainWindowHandle, 9); // SW_RESTORE
                        SetForegroundWindow(p.MainWindowHandle);
                        return true;
                    }
                }
                catch { }
                finally { p.Dispose(); }
            }

            // 2) perfil dedicado (por línea de comandos, via WMI) — SOLO si
            //    hay algún navegador corriendo. Si no hay ni un browser, WMI
            //    sería tiempo perdido; si lo hay, puede ser el cr-perfil/
            //    browser\perfil que abrió una instancia anterior del launcher.
            if (!AnyBrowserRunning()) return false;
            var pids = new HashSet<int>();
            try
            {
                using (var searcher = new ManagementObjectSearcher(
                    "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'msedge.exe' OR Name = 'chrome.exe' OR Name = 'librewolf.exe'"))
                {
                    foreach (ManagementObject proc in searcher.Get())
                    {
                        var cmd = (proc["CommandLine"] as string ?? "").ToLowerInvariant().Replace('/', '\\');
                        if (cmd.IndexOf("cr-perfil", StringComparison.Ordinal) >= 0 ||
                            cmd.IndexOf("browser\\perfil", StringComparison.Ordinal) >= 0)
                            pids.Add(Convert.ToInt32(proc["ProcessId"]));
                    }
                }
            }
            catch { }

            // 3) perfil dedicado vivo pero sin ventana todavía (apenas
            //    arrancando): espera corta a que aparezca en vez de abrir otra
            foreach (var id in pids)
            {
                try
                {
                    var p = Process.GetProcessById(id);
                    for (int i = 0; i < 10; i++)
                    {
                        p.Refresh();
                        if (p.MainWindowHandle != IntPtr.Zero)
                        {
                            ShowWindowAsync(p.MainWindowHandle, 9);
                            SetForegroundWindow(p.MainWindowHandle);
                            return true;
                        }
                        System.Threading.Thread.Sleep(200);
                    }
                }
                catch { }
            }
        }
        catch { }
        return false;
    }

    // forceNew: el usuario pidió expresamente OTRA ventana (menú bandeja)
    private void OpenApp(bool forceNew)
    {
        try
        {
            // anti ráfaga: si hace <8s lanzamos el navegador (clic repetido
            // mientras la ventana aún no aparece), no lanzar otro
            if (!forceNew && (DateTime.Now - lastOpenAt).TotalSeconds < 8)
                return;
            // si la app ya está abierta, solo traer su ventana al frente
            if (!forceNew && FocusAppWindow())
                return;
            lastOpenAt = DateTime.Now;
            // 1) Edge/Chrome --app (mic/voz completo sin depender de OpenAI)
            var cr = FindChromium();
            if (cr != null)
            {
                var prof = Path.Combine(rootDir, "browser", "cr-perfil");
                try { Directory.CreateDirectory(prof); } catch { }
                Process.Start(new ProcessStartInfo
                {
                    FileName = cr,
                    // --app: ventana sin barras con título nativo · perfil dedicado
                    // (persiste permisos de mic y ajustes) · sin first-run ni
                    // chequeo de navegador default. El permiso de mic se pide
                    // una vez y queda guardado en el perfil.
                    Arguments = "--user-data-dir=\"" + prof + "\" --app=\"" + AppUrl + "\" --no-first-run --no-default-browser-check",
                    UseShellExecute = false
                });
                LogLine("App abierta en modo app (Chromium) en :" + currentPort);
                return;
            }
            // 2) LibreWolf portable (sin Speech API → la voz necesita clave OpenAI)
            var lw = FindLibreWolf();
            if (lw != null)
            {
                var prof = EnsureBrowserProfile();
                Process.Start(new ProcessStartInfo
                {
                    FileName = lw,
                    // -no-remote: no delegar en un LibreWolf ya abierto (perdería el perfil).
                    // Ventana tipo app: sin barras (userChrome.css) pero CON la barra
                    // de título de Windows → botones minimizar/maximizar/cerrar.
                    // OJO: -width/-height NO existen en Windows (son args X11) — se
                    // comían la URL y quedaba página en blanco. Maximizada via xulstore.
                    Arguments = "-no-remote -profile \"" + prof + "\" -new-window \"" + AppUrl + "\"",
                    UseShellExecute = false
                });
                LogLine("App abierta en LibreWolf (ventana app) en :" + currentPort);
            }
            else
            {
                Process.Start(AppUrl);
                LogLine("LibreWolf no encontrado — abriendo navegador normal. Para el navegador propio corre launcher\\BAJAR-NAVEGADOR.bat");
            }
        }
        catch (Exception ex)
        {
            LogLine("No se pudo abrir la app: " + ex.Message);
            try { Process.Start(AppUrl); } catch { }
        }
    }

    // ============================ DATOS EJEMPLO ============================
    // cargar/borrar de "Liga Ejemplo" — scripts node corridos desde server\
    // (se invocan desde el menú de bandeja; ya no hay chequeo automático
    //  en el arranque, que lanzaba un node extra y frenaba el inicio)
    private void CargarEjemplo()
    {
        if (ejBusy) return;
        if (MessageBox.Show("Cargar Liga Ejemplo (6 equipos, 3 temporadas, playoffs, traspasos)?\nTarda un minuto aprox.", "PoxScore", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
            return;
        RunEjemploCmd("..\\node_modules\\tsx\\dist\\cli.mjs src\\sim-example.ts", "Cargando Liga Ejemplo...");
    }

    private void BorrarEjemplo()
    {
        if (ejBusy) return;
        if (MessageBox.Show("Borrar la Liga Ejemplo y TODOS sus datos (juegos, jugadores, estadisticas)?\nNo se puede deshacer.", "PoxScore", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
            return;
        RunEjemploCmd("..\\installer\\ejemplo-admin.mjs delete", "Borrando datos ejemplo...");
    }

    private void RunEjemploCmd(string nodeArgs, string msg)
    {
        ejBusy = true;
        SetMsg(msg);
        Task.Factory.StartNew(() =>
        {
            string out2 = RunNodeOut(nodeArgs, 300000);
            BeginInvoke((Action)(() =>
            {
                ejBusy = false;
                bool okOut = out2 != null && out2.IndexOf("error", StringComparison.OrdinalIgnoreCase) < 0;
                SetMsg(okOut ? "Datos ejemplo listos" : "Ejemplo terminó con errores — ver log");
                if (tray.Visible)
                    tray.ShowBalloonTip(3000, "PoxScore", okOut ? "Datos ejemplo listos." : "El comando terminó con errores — revisa launcher\\server.log", ToolTipIcon.Info);
                LogLine("ejemplo: " + nodeArgs + " -> " + out2);
            }));
        });
    }

    private string RunNodeOut(string args, int timeoutMs)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = args,
                WorkingDirectory = srvDir,
                UseShellExecute = false,
                RedirectStandardOutput = true, RedirectStandardError = true,
                CreateNoWindow = true,
                StandardOutputEncoding = System.Text.Encoding.UTF8
            };
            var p = Process.Start(psi);
            var tOut = p.StandardOutput.ReadToEndAsync();
            var tErr = p.StandardError.ReadToEndAsync();
            p.WaitForExit(timeoutMs);
            if (!p.HasExited) { try { p.Kill(); } catch { } return "timeout"; }
            return tOut.Result + tErr.Result;
        }
        catch (Exception ex) { return "error: " + ex.Message; }
    }

    private bool IsInStartup()
    {
        try
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
                return key != null && key.GetValue("PoxScore") != null;
        }
        catch { return false; }
    }

    private void SetStartup(bool enable)
    {
        try
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey, true))
            {
                if (enable)
                    key.SetValue("PoxScore", "\"" + Application.ExecutablePath + "\" --auto");
                else
                    key.DeleteValue("PoxScore", false);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("No se pudo configurar el arranque:\n" + ex.Message, "PoxScore", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void ShowWindow()
    {
        Show();
        WindowState = FormWindowState.Normal;
        tray.Visible = false;
        Activate();
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (WindowState == FormWindowState.Minimized)
            HideToTray();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            HideToTray();
            tray.ShowBalloonTip(2000, "PoxScore", "El servidor sigue corriendo. Doble clic en el icono para volver.", ToolTipIcon.Info);
        }
        base.OnFormClosing(e);
    }

    [STAThread]
    public static void Main(string[] args)
    {
        // rendimiento en frío: sin auto-proxy WPAD (el primer HttpWebRequest
        // tardaba 1-3s resolviendo el proxy del sistema) y sin Nagle/100-continue
        WebRequest.DefaultWebProxy = null;
        ServicePointManager.Expect100Continue = false;
        ServicePointManager.UseNagleAlgorithm = false;
        ServicePointManager.DefaultConnectionLimit = 8;

        // una sola instancia del panel — un segundo arranque solo intenta
        // traer la ventana existente al frente (si está en bandeja, el
        // icono sigue ahí; no se abre otro panel ni otra ventana de app)
        bool created;
        using (var mutex = new System.Threading.Mutex(true, "PoxScore.Control", out created))
        {
            if (!created)
            {
                try
                {
                    foreach (var p in Process.GetProcessesByName(
                        Path.GetFileNameWithoutExtension(Application.ExecutablePath)))
                    {
                        if (p.Id != Process.GetCurrentProcess().Id && p.MainWindowHandle != IntPtr.Zero)
                        {
                            ShowWindowAsync(p.MainWindowHandle, 9);
                            SetForegroundWindow(p.MainWindowHandle);
                            break;
                        }
                    }
                }
                catch { }
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            bool auto = args.Length > 0 && args[0] == "--auto";
            Application.Run(new PoxScoreControl(auto));
        }
    }
}
