using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

// PoxScore Cliente — para equipos de la red que NO corren el servidor.
// Al abrirlo muestra el estado del servidor (sin tocar nada) y en cuanto
// pasa a verde abre la app automáticamente. La dirección del servidor se
// guarda en servidor.txt junto al .exe ("Cambiar servidor..." en la bandeja).

public class PoxScoreCliente : Form
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string DefaultUrl = "http://localhost:4000";
    private const int PollConnectingMs = 1000;  // mientras no responde (red remota)
    private const int PollOnlineMs = 10000;     // ya en línea

    private readonly string appDir;
    private readonly string cfgPath;
    private string serverUrl;
    private bool checking;
    private bool appOpened;                      // ya se abrió el navegador (una vez)
    private DateTime lastOpenAt = DateTime.MinValue; // último lanzamiento del navegador
    private readonly Icon appIcon;

    private Label dotLabel;
    private Label statusLabel;
    private Label serverLabel;
    private Button btnOpen;
    private NotifyIcon tray;
    private Timer timer;

    public PoxScoreCliente(bool autoStart)
    {
        appDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        cfgPath = Path.Combine(appDir, "servidor.txt");

        serverUrl = LoadServerUrl();
        appIcon = LoadAppIcon();

        Text = "PoxScore";
        ClientSize = new Size(320, 180);
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

        serverLabel = new Label
        {
            Text = serverUrl,
            Font = new Font("Segoe UI", 8.5f),
            ForeColor = Color.Gray,
            AutoSize = true,
            Left = 21, Top = 44
        };

        dotLabel = new Label
        {
            Text = "●",
            Font = new Font("Segoe UI", 20, FontStyle.Bold),
            ForeColor = Color.FromArgb(217, 119, 6),
            AutoSize = true,
            Left = 16, Top = 60
        };

        statusLabel = new Label
        {
            Text = "Conectando...",
            Font = new Font("Segoe UI", 10.5f, FontStyle.Bold),
            ForeColor = Color.FromArgb(51, 65, 85),
            AutoSize = true,
            Left = 50, Top = 66
        };

        btnOpen = new Button
        {
            Text = "Abrir PoxScore",
            Font = new Font("Segoe UI", 9, FontStyle.Bold),
            Left = 20, Top = 108, Width = 280, Height = 34,
            BackColor = Color.FromArgb(30, 58, 95),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            Enabled = false
        };
        btnOpen.Click += (s, e) => Task.Run(() => OpenBrowser(false));

        Controls.AddRange(new Control[] { title, serverLabel, dotLabel, statusLabel, btnOpen });

        var menu = new ContextMenuStrip();
        menu.Items.Add("Abrir PoxScore", null, (s, e) => Task.Run(() => OpenBrowser(false)));
        menu.Items.Add("Abrir en otra ventana", null, (s, e) => Task.Run(() => OpenBrowser(true)));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Cambiar servidor...", null, (s, e) => ChangeServer());
        var miStartup = new ToolStripMenuItem("Abrir con Windows") { Checked = IsInStartup(), CheckOnClick = true };
        miStartup.CheckedChanged += (s, e) => SetStartup(miStartup.Checked);
        menu.Items.Add(miStartup);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Mostrar", null, (s, e) => ShowWindow());
        menu.Items.Add("Salir", null, (s, e) => { tray.Visible = false; Application.Exit(); });

        tray = new NotifyIcon
        {
            Text = "PoxScore",
            Icon = appIcon ?? SystemIcons.Application,
            ContextMenuStrip = menu
        };
        tray.DoubleClick += (s, e) => ShowWindow();

        timer = new Timer { Interval = PollConnectingMs };
        timer.Tick += async (s, e) => await CheckHealth();
        timer.Start();

        Load += async (s, e) =>
        {
            if (autoStart) WindowState = FormWindowState.Minimized;
            await CheckHealth();
        };
    }

    private string LoadServerUrl()
    {
        try
        {
            if (File.Exists(cfgPath))
            {
                var url = File.ReadAllText(cfgPath).Trim();
                if (url.Length > 0) return NormalizeUrl(url);
            }
        }
        catch { }
        try { File.WriteAllText(cfgPath, DefaultUrl); } catch { }
        return DefaultUrl;
    }

    private string NormalizeUrl(string url)
    {
        url = url.Trim();
        if (!url.StartsWith("http://") && !url.StartsWith("https://"))
            url = "http://" + url;
        var uri = new Uri(url);
        if (uri.Port == 80 || uri.Port == -1 && url.IndexOf(':', 7) < 0)
        {
            var b = new UriBuilder(uri) { Port = 4000 };
            url = b.Uri.ToString().TrimEnd('/');
        }
        return url.TrimEnd('/');
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
                    DestroyIcon(h);
                    return ic;
                }
            }
            return Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch { return null; }
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr hIcon);

    // ── Una sola ventana de la app ─────────────────────────────────────
    // Si ya hay un navegador mostrando PoxScore ("PoxScore" en el título
    // de la ventana) solo lo trae al frente — sin esto cada clic en
    // "Abrir PoxScore" abría una pestaña/ventana nueva.
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    private static readonly string[] BrowserNames =
        { "msedge", "chrome", "librewolf", "firefox", "opera", "brave", "vivaldi" };

    private bool FocusAppWindow()
    {
        try
        {
            foreach (var p in Process.GetProcesses())
            {
                try
                {
                    if (Array.IndexOf(BrowserNames, p.ProcessName.ToLowerInvariant()) < 0) continue;
                    if ((p.MainWindowTitle ?? "").ToLowerInvariant().IndexOf("poxscore", StringComparison.Ordinal) < 0) continue;
                    if (p.MainWindowHandle == IntPtr.Zero) continue;
                    ShowWindowAsync(p.MainWindowHandle, 9); // SW_RESTORE
                    SetForegroundWindow(p.MainWindowHandle);
                    return true;
                }
                catch { }
                finally { p.Dispose(); }
            }
        }
        catch { }
        return false;
    }

    // forceNew: el usuario pidió expresamente OTRA ventana (menú bandeja)
    private void OpenBrowser(bool forceNew)
    {
        try
        {
            // anti ráfaga: si hace <8s lanzamos el navegador (clic repetido
            // mientras la ventana aún no aparece), no lanzar otro
            if (!forceNew && (DateTime.Now - lastOpenAt).TotalSeconds < 8)
                return;
            if (!forceNew && FocusAppWindow()) return;
            lastOpenAt = DateTime.Now;
            Process.Start(serverUrl);
        }
        catch { }
    }

    private bool PingServer()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(serverUrl + "/api/health");
            req.Proxy = null;
            req.KeepAlive = false;
            req.Timeout = 1500;
            req.ReadWriteTimeout = 1500;
            using (var res = (HttpWebResponse)req.GetResponse())
                return res.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    private async Task CheckHealth()
    {
        if (checking) return;
        checking = true;
        bool ok = await Task.Run(() => PingServer());
        checking = false;

        if (IsDisposed) return;
        if (ok)
        {
            timer.Interval = PollOnlineMs;
            dotLabel.ForeColor = Color.FromArgb(22, 163, 74);
            statusLabel.Text = "Servidor en línea";
            statusLabel.ForeColor = Color.FromArgb(22, 163, 74);
            btnOpen.Enabled = true;
            tray.Text = "PoxScore — servidor en línea";
            // en cuanto pasa a verde: abrir la app y esconder el panel
            if (!appOpened)
            {
                appOpened = true;
                statusLabel.Text = "Abriendo PoxScore...";
                Task.Run(() => OpenBrowser(false));
                Task.Delay(1500).ContinueWith(_ =>
                {
                    if (!IsDisposed)
                        try { BeginInvoke((Action)(() => { if (!IsDisposed && Visible) { Hide(); tray.Visible = true; } })); } catch { }
                });
            }
        }
        else
        {
            appOpened = false;
            timer.Interval = PollConnectingMs;
            dotLabel.ForeColor = Color.FromArgb(220, 38, 38);
            statusLabel.Text = "Esperando al servidor...";
            statusLabel.ForeColor = Color.FromArgb(51, 65, 85);
            btnOpen.Enabled = false;
            tray.Text = "PoxScore — servidor sin respuesta";
        }
    }

    private void ChangeServer()
    {
        var f = new Form
        {
            Text = "Cambiar servidor",
            ClientSize = new Size(340, 120),
            StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false
        };
        var lbl = new Label { Text = "Direccion del servidor (IP o nombre):", Left = 15, Top = 12, AutoSize = true };
        var tb = new TextBox { Left = 15, Top = 34, Width = 305, Text = serverUrl };
        var ok = new Button { Text = "Guardar", Left = 225, Top = 70, Width = 95, DialogResult = DialogResult.OK };
        f.Controls.AddRange(new Control[] { lbl, tb, ok });
        f.AcceptButton = ok;

        if (f.ShowDialog(this) == DialogResult.OK && tb.Text.Trim().Length > 0)
        {
            serverUrl = NormalizeUrl(tb.Text);
            try { File.WriteAllText(cfgPath, serverUrl); } catch { }
            serverLabel.Text = serverUrl;
            CheckHealth();
        }
    }

    private bool IsInStartup()
    {
        try
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
                return key != null && key.GetValue("PoxScore-Cliente") != null;
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
                    key.SetValue("PoxScore-Cliente", "\"" + Application.ExecutablePath + "\" --auto");
                else
                    key.DeleteValue("PoxScore-Cliente", false);
            }
        }
        catch { }
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
        {
            Hide();
            tray.Visible = true;
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            tray.Visible = true;
        }
        base.OnFormClosing(e);
    }

    [STAThread]
    public static void Main(string[] args)
    {
        // sin auto-proxy WPAD (primer request tardaba 1-3s) ni Nagle/100-continue
        WebRequest.DefaultWebProxy = null;
        ServicePointManager.Expect100Continue = false;
        ServicePointManager.UseNagleAlgorithm = false;

        // una sola instancia — un segundo arranque solo trae la ventana
        // existente al frente (o sale en silencio si está en bandeja)
        bool created;
        using (var mutex = new System.Threading.Mutex(true, "PoxScore.Cliente", out created))
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
            Application.Run(new PoxScoreCliente(auto));
        }
    }
}
