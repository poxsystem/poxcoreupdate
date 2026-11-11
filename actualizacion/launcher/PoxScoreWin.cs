using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net;
using System.Net.NetworkInformation;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// ============================================================================
// PoxScoreWin — PoxScore como aplicación de escritorio (Windows, LOCAL).
//
// A diferencia de PoxContWin (que apunta a un sitio remoto con token), este
// corre TODO en la misma laptop:
//   · Arranca el servidor Node local (server\dist\index.js, respaldo tsx)
//     si nadie escucha en 4000-4009 — sin tocar nada, igual que PoxScore.exe.
//   · Mientras el servidor sube muestra un splash "Iniciando servidor…";
//     cuando /api/health responde navega a http://localhost:PORT.
//   · Watchdog: si el proceso Node muere, lo reinicia solo (hasta 5 veces).
//   · WebView2 nativo: sin barra de direcciones, sin F12; SÍ conserva el menú
//     contextual (copiar/pegar en campos) y los alert/confirm de la app.
//   · Micrófono concedido automáticamente a localhost (dictado por voz).
//   · window.print() y Ctrl+P → diálogo de impresión de Windows (con
//     "Microsoft Print to PDF" para los reportes/planillas).
//   · window.open (vista pública/OBS) → ventana WebView2 secundaria.
//   · Perfil persistente en %LOCALAPPDATA%\PoxScore\WV2 (cookies/sesión).
//   · Icono en bandeja: Abrir / Recargar / Reiniciar servidor /
//     Iniciar con Windows / acceso directo / Salir.
//   · Instancia única via Mutex. Cerrar la ventana la manda a la bandeja
//     (el servidor sigue corriendo).
//
// El exe vive en launcher\ (busca ..\server) o suelto en la raíz (.\server).
// Compilar: launcher\compilar-win.bat  (csc .NET 4.x + libs\WebView2 embebidas)
// ============================================================================

static class Program
{
    [DllImport("kernel32.dll")] static extern bool SetDllDirectory(string p);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int cmd);

    private static string libsDir;

    // Exe auto-contenido: las 3 DLLs de WebView2 van embebidas como recursos y
    // se extraen a %LOCALAPPDATA%\PoxScore\libs la primera vez.
    private static void prepLibs()
    {
        libsDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "PoxScore", "libs");
        Directory.CreateDirectory(libsDir);
        Assembly asm = Assembly.GetExecutingAssembly();
        string[] names = {
            "Microsoft.Web.WebView2.Core.dll",
            "Microsoft.Web.WebView2.WinForms.dll",
            "WebView2Loader.dll"
        };
        foreach (string n in names)
        {
            string dst = Path.Combine(libsDir, n);
            try
            {
                using (Stream rs = asm.GetManifestResourceStream(n))
                {
                    if (rs == null) continue;
                    byte[] buf = new byte[rs.Length];
                    rs.Read(buf, 0, buf.Length);
                    if (!File.Exists(dst) || new FileInfo(dst).Length != buf.Length)
                        File.WriteAllBytes(dst, buf);
                }
            }
            catch { }
        }
        SetDllDirectory(libsDir);
    }

    private static Assembly resolveLib(object s, ResolveEventArgs e)
    {
        string p = Path.Combine(libsDir, new AssemblyName(e.Name).Name + ".dll");
        return File.Exists(p) ? Assembly.LoadFrom(p) : null;
    }

    [STAThread]
    static void Main()
    {
        // sin auto-proxy WPAD: el primer HttpWebRequest tardaba 1-3s en frío
        WebRequest.DefaultWebProxy = null;
        ServicePointManager.Expect100Continue = false;
        ServicePointManager.UseNagleAlgorithm = false;

        prepLibs();
        AppDomain.CurrentDomain.AssemblyResolve += resolveLib;

        bool created;
        using (Mutex mtx = new Mutex(true, "PoxScore.WinApp", out created))
        {
            if (!created)
            {
                // una sola instancia — traer la ventana existente al frente
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
            Application.Run(new MainForm());
            GC.KeepAlive(mtx);
        }
    }
}

public class MainForm : Form
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const int PortFirst = 4000;
    private const int PortLast = 4009;
    private int currentPort = PortFirst;
    private string AppUrl { get { return "http://localhost:" + currentPort; } }

    private readonly string appDir;   // carpeta del exe (launcher\)
    private readonly string rootDir;  // raíz de la instalación (.. del launcher)
    private readonly string srvDir;   // server\
    private readonly string logPath;

    private WebView2 web;
    private Panel splash, offline;
    private Label splashMsg, offMsg;
    private NotifyIcon tray;
    private System.Windows.Forms.Timer healthT, retryT;

    private Process serverProc;
    private bool startingServer;      // StartServer en curso → no duplicar node
    private bool manualStop;          // el usuario detuvo → no auto-reiniciar
    private bool exiting;
    private int crashCount;
    private DateTime lastCrashAt = DateTime.MinValue;
    private readonly object logLock = new object();
    private bool navigated;           // ya navegamos a la app con server vivo

    public MainForm()
    {
        appDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        rootDir = Directory.GetParent(appDir).FullName;
        srvDir = Directory.Exists(Path.Combine(rootDir, "server"))
            ? Path.Combine(rootDir, "server")
            : Path.Combine(appDir, "server");
        logPath = Path.Combine(appDir, "server.log");

        Text = "PoxScore";
        Width = 1366; Height = 850;
        StartPosition = FormStartPosition.CenterScreen;
        WindowState = FormWindowState.Maximized;
        try { Icon = LoadAppIcon(); } catch { }

        buildUi();
        buildTray();
        Shown += delegate { initWeb(); };
    }

    // ── UI ───────────────────────────────────────────────────────────────────
    private void buildUi()
    {
        web = new WebView2();
        web.Dock = DockStyle.Fill;
        Controls.Add(web);

        splash = overlay(Color.FromArgb(30, 58, 95));
        Label s1 = mkLabel("PoxScore", 34, FontStyle.Bold, Color.White);
        splashMsg = mkLabel("Iniciando…", 13, FontStyle.Regular, Color.FromArgb(190, 205, 225));
        splashMsg.Location = new Point(0, 60);
        splash.Controls.Add(splashMsg); splash.Controls.Add(s1);
        splash.Resize += delegate { centerAll(splash); };
        Controls.Add(splash); splash.BringToFront();

        offline = overlay(Color.FromArgb(245, 245, 247));
        Label o1 = mkLabel("El servidor no responde", 18, FontStyle.Bold, Color.FromArgb(60, 60, 60));
        offMsg = mkLabel("Reintentando automáticamente…\nSi sigue así, el servidor se reiniciará solo.",
                         12, FontStyle.Regular, Color.FromArgb(110, 110, 110));
        offMsg.Location = new Point(0, 50); offMsg.Height = 50;
        Button retry = new Button();
        retry.Text = "Reintentar ahora"; retry.Width = 200; retry.Height = 42;
        retry.BackColor = Color.FromArgb(30, 58, 95); retry.ForeColor = Color.White;
        retry.FlatStyle = FlatStyle.Flat;
        retry.Click += delegate { retryNow(); };
        offline.Controls.Add(retry);
        offline.Controls.Add(offMsg); offline.Controls.Add(o1);
        offline.Resize += delegate { centerAll(offline); };
        offline.Visible = false;
        Controls.Add(offline); offline.BringToFront();

        // watchdog de salud: rápido mientras arranca (250ms), tranquilo ya en línea (2s)
        healthT = new System.Windows.Forms.Timer(); healthT.Interval = 250;
        healthT.Tick += delegate { checkServer(); };
        healthT.Start();

        // reintento de la página cuando la capa offline está visible
        retryT = new System.Windows.Forms.Timer(); retryT.Interval = 4000;
        retryT.Tick += delegate { if (offline.Visible) retryNow(); };
        retryT.Start();
    }

    private void buildTray()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Abrir PoxScore", null, (s, e) => ShowWindow());
        menu.Items.Add("Recargar página", null, (s, e) => { try { if (web.CoreWebView2 != null) web.Reload(); } catch { } });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Reiniciar servidor", null, (s, e) => Task.Run(() =>
        {
            manualStop = false;
            stopNode();
            Thread.Sleep(400);
            try { BeginInvoke((Action)(() => StartServer())); } catch { }
        }));
        var miStartup = new ToolStripMenuItem("Iniciar con Windows") { Checked = IsInStartup(), CheckOnClick = true };
        miStartup.CheckedChanged += (s, e) => SetStartup(miStartup.Checked);
        menu.Items.Add(miStartup);
        menu.Items.Add("Crear acceso directo en el escritorio", null, (s, e) =>
            makeShortcut(Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                "PoxScore.lnk"), Application.ExecutablePath, appDir));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Salir (el servidor sigue)", null, (s, e) => { exiting = true; tray.Visible = false; Application.Exit(); });
        menu.Items.Add("Detener servidor y salir", null, (s, e) =>
        {
            exiting = true; manualStop = true; tray.Visible = false;
            Task.Run(() => { stopNode(); BeginInvoke((Action)(() => Application.Exit())); });
        });

        tray = new NotifyIcon
        {
            Text = "PoxScore",
            Icon = Icon ?? SystemIcons.Application,
            ContextMenuStrip = menu
        };
        tray.DoubleClick += (s, e) => ShowWindow();
    }

    private Panel overlay(Color bg)
    {
        Panel p = new Panel();
        p.Dock = DockStyle.Fill;
        p.BackColor = bg;
        return p;
    }

    private Label mkLabel(string txt, float size, FontStyle style, Color color)
    {
        Label l = new Label();
        l.Text = txt;
        l.Font = new Font(FontFamily.GenericSansSerif, size, style);
        l.ForeColor = color;
        l.AutoSize = true;
        l.TextAlign = ContentAlignment.MiddleCenter;
        return l;
    }

    private void centerAll(Panel p)
    {
        int y = Math.Max(0, (p.Height - p.Controls.Count * 60) / 2);
        foreach (Control c in p.Controls)
        {
            c.Left = Math.Max(0, (p.Width - c.Width) / 2);
            c.Top = y;
            y += c.Height + 14;
        }
    }

    private Icon LoadAppIcon()
    {
        var ico = Path.Combine(appDir, "icon.ico");
        if (File.Exists(ico)) return new Icon(ico);
        return Icon.ExtractAssociatedIcon(Application.ExecutablePath);
    }

    private void makeShortcut(string lnkPath, string target, string workDir)
    {
        try
        {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            object sh = Activator.CreateInstance(t);
            object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod,
                null, sh, new object[] { lnkPath });
            Type lt = lnk.GetType();
            lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
            lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { workDir });
            lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { target + ",0" });
            lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
            LogLine("Acceso directo creado: " + lnkPath);
        }
        catch { }
    }

    // ── servidor local ───────────────────────────────────────────────────────
    private void LogLine(string line)
    {
        try { lock (logLock) File.AppendAllText(logPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + line + "\r\n"); }
        catch { }
    }

    // Puertos 4000-4009 realmente en LISTENING (lectura en memoria, <1ms)
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

    // Puerto donde YA responde un server PoxScore (0 = ninguno vivo)
    private int RunningPort()
    {
        foreach (var p in ListeningPoxPorts())
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + p + "/api/health");
                req.Proxy = null;
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

    private int FreePort()
    {
        var busy = ListeningPoxPorts();
        for (int p = PortFirst; p <= PortLast; p++)
            if (!busy.Contains(p)) return p;
        return PortFirst;
    }

    private void StartServer()
    {
        if (IsDisposed || exiting) return;
        if (InvokeRequired) { try { BeginInvoke((Action)(() => StartServer())); } catch { } return; }
        if (startingServer) return;
        if (serverProc != null && !serverProc.HasExited) return;
        if (RunningPort() > 0) return;               // alguien ya está sirviendo
        startingServer = true;
        try
        {
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
                setSplash("Falta server\\dist\\index.js");
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
            serverProc.EnableRaisingEvents = true;
            serverProc.Exited += (s, e) =>
            {
                try { LogLine("Servidor terminó (code " + proc.ExitCode + ")"); } catch { }
                if (!manualStop && !exiting && !IsDisposed)
                {
                    if ((DateTime.Now - lastCrashAt).TotalSeconds > 60) crashCount = 0;
                    crashCount++;
                    lastCrashAt = DateTime.Now;
                    if (crashCount <= 5)
                    {
                        LogLine("Reinicio automático en 3s (fallo #" + crashCount + ")");
                        Task.Delay(3000).ContinueWith(_ =>
                        {
                            if (!manualStop && !exiting && !IsDisposed)
                                try { BeginInvoke((Action)(() => StartServer())); } catch { }
                        });
                    }
                    else LogLine("Demasiados fallos seguidos — sin reinicio automático. Revisa el log.");
                }
            };
            setSplash("Arrancando Node.js…");
            LogLine("Servidor iniciado en :" + currentPort + " — node " + args);
        }
        catch (Exception ex)
        {
            setSplash("No se pudo iniciar (¿falta Node.js?)");
            LogLine("StartServer falló: " + ex.Message);
        }
        finally { startingServer = false; }
    }

    private void stopNode()
    {
        manualStop = true;
        try
        {
            if (serverProc != null && !serverProc.HasExited)
            {
                var tk = new ProcessStartInfo { FileName = "taskkill", Arguments = "/pid " + serverProc.Id + " /t /f", CreateNoWindow = true, UseShellExecute = false };
                Process.Start(tk).WaitForExit(3000);
            }
        }
        catch { }

        // respaldo: cualquier node.exe de este proyecto
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
        LogLine("Servidor detenido");
    }

    private void setSplash(string msg)
    {
        if (InvokeRequired) { try { BeginInvoke((Action)(() => setSplash(msg))); } catch { } return; }
        splashMsg.Text = msg;
        if (!navigated) { splash.Visible = true; splash.BringToFront(); }
    }

    private void retryNow()
    {
        Task.Run(() =>
        {
            int p = RunningPort();
            try
            {
                BeginInvoke((Action)(() =>
                {
                    if (IsDisposed) return;
                    if (p > 0)
                    {
                        currentPort = p;
                        if (web.CoreWebView2 != null) web.CoreWebView2.Navigate(AppUrl);
                        else navigated = false;
                    }
                    else if (!manualStop) StartServer();
                }));
            }
            catch { }
        });
    }

    // bucle de salud: si nadie escucha → arrancar; cuando responde → navegar/recargar
    private void checkServer()
    {
        int alive = RunningPort();
        if (IsDisposed || exiting) return;

        if (alive > 0)
        {
            currentPort = alive;
            healthT.Interval = 2000;
            if (!navigated && web.CoreWebView2 != null)
            {
                navigated = true;
                setSplash("Abriendo PoxScore…");
                web.CoreWebView2.Navigate(AppUrl);
            }
            else if (offline.Visible && web.CoreWebView2 != null)
            {
                web.Reload();
            }
        }
        else
        {
            navigated = false;
            healthT.Interval = 250;
            bool nuestroVivo = startingServer || (serverProc != null && !serverProc.HasExited);
            if (nuestroVivo)
                setSplash("Esperando al servidor…");
            else if (manualStop)
            {
                setSplash("Servidor detenido");
            }
            else
            {
                setSplash("Arrancando el servidor…");
                StartServer();
            }
        }
    }

    // ── WebView2 ─────────────────────────────────────────────────────────────
    private async void initWeb()
    {
        try
        {
            string udf = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "PoxScore", "WV2");
            var env = await CoreWebView2Environment.CreateAsync(null, udf, null);
            await web.EnsureCoreWebView2Async(env);

            var s = web.CoreWebView2.Settings;
            s.AreDevToolsEnabled = false;              // sin F12
            s.AreDefaultContextMenusEnabled = true;    // copiar/pegar en campos
            s.AreBrowserAcceleratorKeysEnabled = false;// sin Alt+← / Ctrl+W del browser
            s.IsStatusBarEnabled = false;
            s.IsZoomControlEnabled = false;
            s.AreDefaultScriptDialogsEnabled = true;   // alert/confirm de la app funcionan

            web.CoreWebView2.NavigationCompleted += onNav;
            web.CoreWebView2.NewWindowRequested += onNewWindow;
            web.CoreWebView2.DocumentTitleChanged += delegate
            {
                try { Text = web.CoreWebView2.DocumentTitle; } catch { }
            };
            web.CoreWebView2.ProcessFailed += delegate
            {
                try { web.Reload(); } catch { }
            };

            // micrófono/cámara sin preguntar para nuestra app local (dictado por voz)
            web.CoreWebView2.PermissionRequested += delegate(object s2, CoreWebView2PermissionRequestedEventArgs e2)
            {
                if (e2.Uri.StartsWith("http://localhost") || e2.Uri.StartsWith("http://127.0.0.1"))
                {
                    if (e2.PermissionKind == CoreWebView2PermissionKind.Microphone ||
                        e2.PermissionKind == CoreWebView2PermissionKind.Camera ||
                        e2.PermissionKind == CoreWebView2PermissionKind.ClipboardRead)
                        e2.State = CoreWebView2PermissionState.Allow;
                }
            };

            // window.print() y Ctrl+P → diálogo de impresión de Windows
            // (WebView2 no lo atiende solo; además las teclas de acelerador
            //  están desactivadas, así que Ctrl+P hay que mapearlo a mano)
            await web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                "window.print = function(){ window.chrome.webview.postMessage('poxscore:print'); };" +
                "window.addEventListener('keydown', function(ev){" +
                "  if(ev.ctrlKey && (ev.key==='p'||ev.key==='P')){ ev.preventDefault(); window.chrome.webview.postMessage('poxscore:print'); }" +
                "}, true);");
            web.CoreWebView2.WebMessageReceived += delegate(object s2, CoreWebView2WebMessageReceivedEventArgs e2)
            {
                if (e2.TryGetWebMessageAsString() == "poxscore:print")
                {
                    try { web.CoreWebView2.ShowPrintUI(CoreWebView2PrintDialogKind.System); }
                    catch { }
                }
            };

            // arranque: si ya hay servidor navega ya; si no, el health timer lo arranca
            int alive = await Task.Run(() => RunningPort());
            if (alive > 0)
            {
                currentPort = alive;
                navigated = true;
                web.CoreWebView2.Navigate(AppUrl);
            }
            else setSplash("Arrancando el servidor…");
        }
        catch (Exception ex)
        {
            DialogResult r = MessageBox.Show(
                "Esta PC no tiene WebView2 Runtime.\n\n" +
                "Sí = instalar el runtime (recomendado)\n" +
                "No = abrir PoxScore en el navegador\n\n" + ex.Message,
                "PoxScore", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (r == DialogResult.Yes)
                Process.Start("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            else
                try { Process.Start(AppUrl); } catch { }
            exiting = true;
            Close();
        }
    }

    private void onNav(object sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess)
        {
            if (splash.Visible) splash.Visible = false;
            if (offline.Visible) offline.Visible = false;
        }
        else if (navigated || splash.Visible == false)
        {
            // falló la navegación a la app ya cargada → capa de reintento
            offline.Visible = true;
            offline.BringToFront();
        }
    }

    // window.open (vista pública, OBS, impresión de planilla) → ventana propia
    private void onNewWindow(object sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        if (!e.Uri.StartsWith("http")) return;
        var def = e.GetDeferral();
        Task.Run(async delegate
        {
            try
            {
                Form pop = null;
                WebView2 w = null;
                Invoke((MethodInvoker)delegate
                {
                    pop = new Form();
                    pop.Width = 1100; pop.Height = 760;
                    pop.StartPosition = FormStartPosition.CenterScreen;
                    try { pop.Icon = Icon; } catch { }
                    pop.Text = "PoxScore";
                    w = new WebView2();
                    w.Dock = DockStyle.Fill;
                    pop.Controls.Add(w);
                    pop.Show();
                });
                await w.EnsureCoreWebView2Async(web.CoreWebView2.Environment);
                w.CoreWebView2.DocumentTitleChanged += delegate
                {
                    try { pop.Text = w.CoreWebView2.DocumentTitle; } catch { }
                };
                e.NewWindow = w.CoreWebView2;
                e.Handled = true;
            }
            catch { }
            finally { def.Complete(); }
        });
    }

    // ── arranque con Windows ─────────────────────────────────────────────────
    private bool IsInStartup()
    {
        try
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
                return key != null && key.GetValue("PoxScoreWin") != null;
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
                    key.SetValue("PoxScoreWin", "\"" + Application.ExecutablePath + "\"");
                else
                    key.DeleteValue("PoxScoreWin", false);
            }
        }
        catch { }
    }

    private void ShowWindow()
    {
        Show();
        WindowState = FormWindowState.Maximized;
        tray.Visible = false;
        Activate();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // cerrar la ventana → bandeja (el servidor sigue); salir de verdad
        // solo desde el menú del icono
        if (e.CloseReason == CloseReason.UserClosing && !exiting)
        {
            e.Cancel = true;
            Hide();
            tray.Visible = true;
            tray.ShowBalloonTip(2000, "PoxScore", "Sigue corriendo en segundo plano. Doble clic en el icono para volver.", ToolTipIcon.Info);
        }
        base.OnFormClosing(e);
    }
}
