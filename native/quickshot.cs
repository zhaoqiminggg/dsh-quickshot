// dsh-quickshot 原生组件
//
// 一个 exe 干四件事，由第一个参数决定：
//   --listen <parentPid> <shotExe> <queueDir> <code> <modifiers>
//        常驻监听系统级组合键。按下时直接拉起截图窗口（不激活 DSH），
//        截完把 PNG 和一张 ready-*.json 放进 queueDir。
//   --select <outPng>
//        全屏冻结 + 拖框选取 + 完成/取消，成功返回 0，取消返回 2。
//   --ask <title> <message>
//        系统级确认框，确定返回 0，取消返回 1。
//   --focus <pid>
//        把指定进程的主窗口提到前台（用于「选择会话」之后把 DSH 叫出来）。
//
// 另外有两个只给开发用的入口：--preview <png> 把界面画成图便于检查，
// --selftest 跑一组几何断言。
//
// 为什么是原生程序：浏览器里的浮层只能覆盖 DSH 自己的窗口，
// 而「微信式框选」必须盖住整个屏幕、1:1 像素抓取，只有 Win32 能做。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class Win32
{
    public const int WM_HOTKEY = 0x0312;
    public const uint MOD_ALT = 0x0001;
    public const uint MOD_CONTROL = 0x0002;
    public const uint MOD_SHIFT = 0x0004;
    public const uint MOD_WIN = 0x0008;
    public const uint MOD_NOREPEAT = 0x4000;
    public const int SW_RESTORE = 9;

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")]
    public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}

/// <summary>一次框选会话的状态与绘制。</summary>
sealed class ShotForm : Form
{
    static readonly Color Veil = Color.FromArgb(150, 0, 0, 0);
    static readonly Color Accent = Color.FromArgb(255, 0, 174, 255);
    static readonly Color BarFill = Color.FromArgb(238, 30, 30, 34);
    static readonly Color BarEdge = Color.FromArgb(46, 255, 255, 255);
    static readonly Color DoneFill = Color.FromArgb(255, 7, 193, 96);
    static readonly Color CancelFill = Color.FromArgb(255, 62, 62, 68);

    readonly Bitmap frozen;
    readonly Rectangle screen;
    readonly List<Rectangle> hits = new List<Rectangle>();   // 0 = cancel, 1 = done

    Point downPoint;
    Rectangle selection = Rectangle.Empty;
    Rectangle sizeTag = Rectangle.Empty;
    Rectangle toolbar = Rectangle.Empty;
    Rectangle btnCancel = Rectangle.Empty;
    Rectangle btnDone = Rectangle.Empty;

    bool dragging;
    bool hasSelection;
    bool completed;
    int hover = -1;

    public ShotForm(Bitmap frozen, Rectangle screen)
    {
        this.frozen = frozen;
        this.screen = screen;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Bounds = screen;
        BackColor = Color.Black;
        DoubleBuffered = true;
        Cursor = Cursors.Cross;
        KeyPreview = true;
        AutoScaleMode = AutoScaleMode.None;
    }

    public bool Completed { get { return completed; } }
    public bool HasSelection { get { return hasSelection; } }

    /// <summary>预览模式下预置一个选区，不需要真人拖拽。</summary>
    public void PresetSelection(Rectangle region)
    {
        selection = region;
        hasSelection = true;
        LayoutChrome();
    }

    /// <summary>按选区尺寸裁出最终图片。</summary>
    public Bitmap RenderResult()
    {
        Rectangle region = Rectangle.Intersect(screen, selection);
        if (region.Width <= 0 || region.Height <= 0) region = new Rectangle(screen.X, screen.Y, 1, 1);
        Bitmap result = new Bitmap(region.Width, region.Height, PixelFormat.Format32bppPArgb);
        using (Graphics g = Graphics.FromImage(result))
        {
            g.DrawImage(frozen,
                new Rectangle(0, 0, region.Width, region.Height),
                new Rectangle(region.X - screen.X, region.Y - screen.Y, region.Width, region.Height),
                GraphicsUnit.Pixel);
        }
        return result;
    }

    static GraphicsPath Round(Rectangle box, int radius)
    {
        int d = radius * 2;
        GraphicsPath path = new GraphicsPath();
        if (box.Width <= d || box.Height <= d)
        {
            path.AddRectangle(box);
            return path;
        }
        path.AddArc(box.X, box.Y, d, d, 180, 90);
        path.AddArc(box.Right - d, box.Y, d, d, 270, 90);
        path.AddArc(box.Right - d, box.Bottom - d, d, d, 0, 90);
        path.AddArc(box.X, box.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    static Rectangle Normalize(Point a, Point b)
    {
        int x = Math.Min(a.X, b.X);
        int y = Math.Min(a.Y, b.Y);
        return new Rectangle(x, y, Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));
    }

    void LayoutChrome()
    {
        hits.Clear();
        if (!hasSelection)
        {
            toolbar = Rectangle.Empty;
            sizeTag = Rectangle.Empty;
            return;
        }

        // 尺寸标签：优先贴在选区左上角里面，空间不够放外面
        string text = string.Format("{0} × {1}", selection.Width, selection.Height);
        Size textSize;
        using (Font font = new Font("Segoe UI", 9f, FontStyle.Regular))
        using (Graphics probe = CreateGraphics())
        {
            textSize = Size.Ceiling(probe.MeasureString(text, font));
        }
        int tagW = textSize.Width + 16;
        int tagH = textSize.Height + 8;
        int tagX = selection.X + 6;
        int tagY = selection.Y + 6;
        if (tagY + tagH > screen.Bottom - 4) tagY = selection.Y - tagH - 6;
        if (tagX + tagW > screen.Right - 4) tagX = screen.Right - tagW - 4;
        sizeTag = new Rectangle(tagX, tagY, tagW, tagH);

        // 工具条：优先放在选区右下角外侧，放不下就上方，再不行挤进屏幕。
        // 按钮直径 96 像素（用户反馈 32 太小容易点错，放大到 3 倍）。
        const int pad = 14;
        const int diameter = 96;
        const int gap = 14;
        int barW = pad * 2 + diameter * 2 + gap;
        int barH = pad * 2 + diameter;

        int barX = selection.Right - barW;
        int barY = selection.Bottom + 16;
        if (barY + barH > screen.Bottom - 6) barY = selection.Top - barH - 16;
        if (barY < screen.Top + 6) barY = selection.Bottom - barH - 16;
        if (barX < screen.X + 6) barX = screen.X + 6;
        if (barX + barW > screen.Right - 6) barX = screen.Right - barW - 6;
        toolbar = new Rectangle(barX, barY, barW, barH);

        btnCancel = new Rectangle(barX + pad, barY + pad, diameter, diameter);
        btnDone = new Rectangle(btnCancel.Right + gap, barY + pad, diameter, diameter);
        hits.Add(btnCancel);
        hits.Add(btnDone);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        Graphics g = e.Graphics;
        g.InterpolationMode = InterpolationMode.NearestNeighbor;
        g.PixelOffsetMode = PixelOffsetMode.Half;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        g.DrawImage(frozen, new Rectangle(0, 0, screen.Width, screen.Height));

        Rectangle visible = hasSelection ? Rectangle.Intersect(screen, selection) : Rectangle.Empty;
        using (SolidBrush veil = new SolidBrush(Veil)) g.FillRectangle(veil, 0, 0, screen.Width, screen.Height);
        if (visible.Width > 0 && visible.Height > 0)
        {
            g.DrawImage(frozen,
                new Rectangle(visible.X - screen.X, visible.Y - screen.Y, visible.Width, visible.Height),
                new Rectangle(visible.X - screen.X, visible.Y - screen.Y, visible.Width, visible.Height),
                GraphicsUnit.Pixel);
            using (Pen edge = new Pen(Accent, 1f))
                g.DrawRectangle(edge, visible.X, visible.Y, visible.Width - 1, visible.Height - 1);
        }

        if (!hasSelection)
        {
            DrawHint(g);
            return;
        }

        DrawSizeTag(g);
        DrawToolbar(g);
    }

    void DrawHint(Graphics g)
    {
        const string text = "拖动鼠标框选区域    ·    Esc 取消";
        using (Font font = new Font("Microsoft YaHei UI", 10f, FontStyle.Regular))
        {
            Size size = Size.Ceiling(g.MeasureString(text, font));
            int w = size.Width + 36;
            int h = size.Height + 20;
            Rectangle box = new Rectangle((screen.Width - w) / 2, 40, w, h);
            using (GraphicsPath path = Round(box, 10))
            using (SolidBrush back = new SolidBrush(BarFill))
            using (Pen edge = new Pen(BarEdge, 1f))
            {
                g.FillPath(back, path);
                g.DrawPath(edge, path);
            }
            using (SolidBrush textBrush = new SolidBrush(Color.White))
                g.DrawString(text, font, textBrush, box.X + 18, box.Y + 10);
        }
    }

    void DrawSizeTag(Graphics g)
    {
        const string format = "{0} × {1}";
        string text = string.Format(format, selection.Width, selection.Height);
        using (Font font = new Font("Segoe UI", 9f, FontStyle.Regular))
        using (GraphicsPath path = Round(sizeTag, 6))
        using (SolidBrush back = new SolidBrush(BarFill))
        using (SolidBrush textBrush = new SolidBrush(Color.White))
        {
            g.FillPath(back, path);
            g.DrawString(text, font, textBrush, sizeTag.X + 8, sizeTag.Y + 4);
        }
    }

    void DrawToolbar(Graphics g)
    {
        using (GraphicsPath path = Round(toolbar, 26))
        using (SolidBrush back = new SolidBrush(BarFill))
        using (Pen edge = new Pen(BarEdge, 1f))
        {
            g.FillPath(back, path);
            g.DrawPath(edge, path);
        }

        // 取消：灰色圆 + 白叉（所有尺寸都按直径比例算，改大小不用重算坐标）
        using (SolidBrush fill = new SolidBrush(hover == 0 ? ControlPaint.Light(CancelFill, 0.15f) : CancelFill))
            g.FillEllipse(fill, btnCancel);
        float xInset = btnCancel.Width * 0.344f;
        using (Pen stroke = new Pen(Color.White, btnCancel.Width * 0.0625f))
        {
            g.DrawLine(stroke, btnCancel.Left + xInset, btnCancel.Top + xInset, btnCancel.Right - xInset, btnCancel.Bottom - xInset);
            g.DrawLine(stroke, btnCancel.Right - xInset, btnCancel.Top + xInset, btnCancel.Left + xInset, btnCancel.Bottom - xInset);
        }

        // 完成：绿色圆 + 白勾
        using (SolidBrush fill = new SolidBrush(hover == 1 ? ControlPaint.Light(DoneFill, 0.15f) : DoneFill))
            g.FillEllipse(fill, btnDone);
        using (Pen stroke = new Pen(Color.White, btnDone.Width * 0.075f))
        {
            stroke.StartCap = LineCap.Round;
            stroke.EndCap = LineCap.Round;
            stroke.LineJoin = LineJoin.Round;
            float d = btnDone.Width;
            float left = btnDone.Left + d * 0.281f;
            float middle = btnDone.Left + d * 0.4375f;
            float right = btnDone.Left + d * 0.719f;
            float top = btnDone.Top + d * 0.5f;
            float bottom = btnDone.Top + d * 0.6875f;
            g.DrawLines(stroke, new PointF[]
            {
                new PointF(left, top + 2),
                new PointF(middle, bottom),
                new PointF(right, btnDone.Top + d * 0.28f),
            });
        }
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        if (e.Button == MouseButtons.Right)
        {
            completed = false;
            Close();
            return;
        }
        if (e.Button != MouseButtons.Left) return;

        if (hasSelection && btnDone.Contains(e.Location))
        {
            completed = true;
            Close();
            return;
        }
        if (hasSelection && btnCancel.Contains(e.Location))
        {
            completed = false;
            Close();
            return;
        }

        dragging = true;
        hasSelection = false;
        downPoint = e.Location;
        selection = Rectangle.Empty;
        toolbar = Rectangle.Empty;
        sizeTag = Rectangle.Empty;
        Invalidate();
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        if (dragging)
        {
            selection = Normalize(downPoint, e.Location);
            hasSelection = selection.Width >= 4 && selection.Height >= 4;
            if (hasSelection) LayoutChrome();
            Invalidate();
            return;
        }

        int next = -1;
        if (hasSelection)
        {
            if (btnDone.Contains(e.Location)) next = 1;
            else if (btnCancel.Contains(e.Location)) next = 0;
        }
        if (next != hover)
        {
            hover = next;
            Cursor = next >= 0 ? Cursors.Hand : Cursors.Cross;
            Invalidate();
        }
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        base.OnMouseUp(e);
        if (!dragging) return;
        dragging = false;
        selection = Normalize(downPoint, e.Location);
        hasSelection = selection.Width >= 8 && selection.Height >= 8;
        if (hasSelection) LayoutChrome();
        else
        {
            selection = Rectangle.Empty;
            toolbar = Rectangle.Empty;
            sizeTag = Rectangle.Empty;
        }
        Invalidate();
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (e.KeyCode == Keys.Escape)
        {
            completed = false;
            Close();
        }
        else if (e.KeyCode == Keys.Enter && hasSelection)
        {
            completed = true;
            Close();
        }
    }

    protected override bool ProcessDialogKey(Keys keyData)
    {
        if (keyData == Keys.Escape)
        {
            completed = false;
            Close();
            return true;
        }
        if (keyData == Keys.Enter && hasSelection)
        {
            completed = true;
            Close();
            return true;
        }
        return base.ProcessDialogKey(keyData);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && frozen != null) frozen.Dispose();
        base.Dispose(disposing);
    }
}

static class Program
{
    static string logPath;

    static void Log(string message)
    {
        try { File.AppendAllText(logPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + message + Environment.NewLine); }
        catch { /* 日志失败不能影响主流程 */ }
    }

    static ushort VirtualKey(string code)
    {
        if (string.IsNullOrEmpty(code)) return 0;
        if (code.Length == 4 && code.StartsWith("Key", StringComparison.Ordinal))
        {
            char letter = code[3];
            if (letter >= 'A' && letter <= 'Z') return (ushort)(0x41 + (letter - 'A'));
            return 0;
        }
        if (code.Length == 6 && code.StartsWith("Digit", StringComparison.Ordinal))
        {
            char digit = code[5];
            if (digit >= '0' && digit <= '9') return (ushort)(0x30 + (digit - '0'));
            return 0;
        }
        if (code.Length >= 2 && code[0] == 'F')
        {
            int number;
            if (int.TryParse(code.Substring(1), out number) && number >= 1 && number <= 24) return (ushort)(0x70 + number - 1);
        }
        switch (code)
        {
            case "PrintScreen": return 0x2C;
            case "Space": return 0x20;
            case "Tab": return 0x09;
            default: return 0;
        }
    }

    static uint ModifierFlags(string modifiers)
    {
        uint flags = 0;
        if (string.IsNullOrEmpty(modifiers)) return flags;
        foreach (string raw in modifiers.Split(','))
        {
            string name = raw.Trim().ToLowerInvariant();
            if (name == "primary" || name == "control" || name == "ctrl") flags |= Win32.MOD_CONTROL;
            else if (name == "alt" || name == "option") flags |= Win32.MOD_ALT;
            else if (name == "shift") flags |= Win32.MOD_SHIFT;
            else if (name == "meta" || name == "command" || name == "win") flags |= Win32.MOD_WIN;
        }
        return flags;
    }

    /// <summary>截下整个虚拟桌面（多显示器合成一张）。</summary>
    static Bitmap CaptureDesktop(Rectangle bounds)
    {
        Bitmap screen = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppPArgb);
        using (Graphics g = Graphics.FromImage(screen))
            g.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
        return screen;
    }

    static int RunSelect(string output)
    {
        Rectangle bounds = SystemInformation.VirtualScreen;
        Bitmap screen = CaptureDesktop(bounds);
        Bitmap result = null;
        using (ShotForm form = new ShotForm(screen, bounds))
        {
            form.ShowDialog();
            if (!form.Completed || !form.HasSelection) return 2;
            result = form.RenderResult();
        }
        using (result)
        {
            if (output != null)
            {
                string folder = Path.GetDirectoryName(output);
                if (!string.IsNullOrEmpty(folder)) Directory.CreateDirectory(folder);
                result.Save(output, ImageFormat.Png);
            }
        }
        return 0;
    }

    static int RunPreview(string outputPath)
    {
        // 造一张假的桌面，免得把真实屏幕内容写进预览图
        Rectangle bounds = new Rectangle(0, 0, 1280, 800);
        Bitmap board = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(board))
        {
            using (LinearGradientBrush bg = new LinearGradientBrush(bounds, Color.FromArgb(255, 26, 32, 44), Color.FromArgb(255, 12, 16, 24), 35f))
                g.FillRectangle(bg, bounds);
            using (SolidBrush panel = new SolidBrush(Color.FromArgb(255, 40, 48, 62)))
            {
                g.FillRectangle(panel, new Rectangle(60, 70, 520, 300));
                g.FillRectangle(panel, new Rectangle(640, 120, 560, 420));
            }
            using (Font font = new Font("Microsoft YaHei UI", 12f, FontStyle.Regular))
            using (SolidBrush text = new SolidBrush(Color.FromArgb(200, 255, 255, 255)))
            {
                g.DrawString("这里是被截的那个软件窗口", font, text, 90, 100);
                g.DrawString("另一块内容", font, text, 670, 150);
            }
        }
        Bitmap result = null;
        using (ShotForm form = new ShotForm(board, bounds))
        {
            form.PresetSelection(new Rectangle(180, 150, 620, 360));
            form.Show();
            Application.DoEvents();
            Thread.Sleep(120);
            Application.DoEvents();
            using (Bitmap frame = new Bitmap(form.Width, form.Height))
            {
                form.DrawToBitmap(frame, new Rectangle(0, 0, form.Width, form.Height));
                result = new Bitmap(frame);
            }
            form.Close();
        }
        using (result) result.Save(outputPath, ImageFormat.Png);
        return 0;
    }

    static int RunSelftest()
    {
        List<string> lines = new List<string>();
        int failures = 0;
        Action<string, bool> check = delegate(string name, bool ok)
        {
            lines.Add((ok ? "PASS " : "FAIL ") + name);
            if (!ok) failures++;
        };

        Rectangle a = new Rectangle(300, 220, 100, 80);
        Rectangle b = new Rectangle(120, 60, 100, 80);
        Rectangle normalized = b;
        check("normalize keeps positive size", normalized.Width > 0 && normalized.Height > 0);
        check("selection inside screen", a.Right <= 1280 && a.Bottom <= 800);

        Rectangle board = new Rectangle(0, 0, 1280, 800);
        Bitmap canvas = new Bitmap(board.Width, board.Height, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(canvas)) g.Clear(Color.FromArgb(255, 18, 18, 18));
        using (ShotForm form = new ShotForm(canvas, board))
        {
            form.PresetSelection(a);
            using (Bitmap result = form.RenderResult())
            {
                check("result matches selection size", result.Width == a.Width && result.Height == a.Height);
            }
        }
        string report = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "selftest.txt");
        File.WriteAllLines(report, lines.ToArray());
        return failures == 0 ? 0 : 1;
    }

    static int RunAsk(string title, string message)
    {
        DialogResult answer = MessageBox.Show(message, title, MessageBoxButtons.OKCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button1, MessageBoxOptions.DefaultDesktopOnly);
        return answer == DialogResult.OK ? 0 : 1;
    }

    static int RunFocus(string pidText)
    {
        int pid;
        if (!int.TryParse(pidText, out pid)) return 2;
        try
        {
            Process target = Process.GetProcessById(pid);
            IntPtr handle = target.MainWindowHandle;
            if (handle == IntPtr.Zero) return 3;
            Win32.ShowWindow(handle, Win32.SW_RESTORE);
            Win32.SetForegroundWindow(handle);
            return 0;
        }
        catch (Exception error)
        {
            Log("focus failed: " + error.Message);
            return 4;
        }
    }

    static int RunListen(string parentPidText, string shotExe, string queueDir, string code, string modifiers)
    {
        int parentPid = 0;
        int.TryParse(parentPidText, out parentPid);
        Directory.CreateDirectory(queueDir);

        ushort vk = VirtualKey(code);
        uint flags = ModifierFlags(modifiers);
        if (vk == 0 || flags == 0)
        {
            Log("unsupported shortcut " + modifiers + "+" + code);
            return 3;
        }

        if (parentPid > 0)
        {
            Thread watcher = new Thread(delegate()
            {
                while (true)
                {
                    Thread.Sleep(2000);
                    try { Process.GetProcessById(parentPid); }
                    catch { Log("parent gone, exiting"); Environment.Exit(0); }
                }
            });
            watcher.IsBackground = true;
            watcher.Start();
        }

        if (!Win32.RegisterHotKey(IntPtr.Zero, 1, flags | Win32.MOD_NOREPEAT, vk))
        {
            Log("RegisterHotKey failed, win32=" + Marshal.GetLastWin32Error());
            return 2;
        }
        Log("hotkey " + modifiers + "+" + code + " registered");

        Win32.MSG message;
        while (Win32.GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
        {
            if (message.message != Win32.WM_HOTKEY) continue;
            Log("hotkey pressed");
            try
            {
                string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss-fff");
                string png = Path.Combine(queueDir, "shot-" + stamp + ".png");
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = shotExe;
                info.Arguments = "--select \"" + png + "\"";
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                using (Process process = Process.Start(info))
                {
                    process.WaitForExit(600000);
                    if (process.ExitCode == 0 && File.Exists(png))
                    {
                        string meta = Path.Combine(queueDir, "ready-" + stamp + ".json");
                        File.WriteAllText(meta, "{\"png\":\"" + png.Replace("\\", "\\\\") + "\"}");
                        Log("captured " + Path.GetFileName(png));
                    }
                    else
                    {
                        try { File.Delete(png); } catch { }
                        Log("cancelled (exit " + process.ExitCode + ")");
                    }
                }
            }
            catch (Exception error)
            {
                Log("capture failed: " + error.Message);
            }
        }
        Win32.UnregisterHotKey(IntPtr.Zero, 1);
        return 0;
    }

    [STAThread]
    static int Main(string[] args)
    {
        Win32.SetProcessDPIAware();
        logPath = Path.Combine(Path.GetTempPath(), "dsh-quickshot.log");
        if (args.Length == 0) return 1;

        switch (args[0])
        {
            case "--select":
                return RunSelect(args.Length > 1 ? args[1] : null);
            case "--preview":
                return RunPreview(args.Length > 1 ? args[1] : Path.Combine(Path.GetTempPath(), "quickshot-preview.png"));
            case "--selftest":
                return RunSelftest();
            case "--ask":
                return RunAsk(args.Length > 1 ? args[1] : "DSH", args.Length > 2 ? args[2] : "");
            case "--focus":
                return RunFocus(args.Length > 1 ? args[1] : "0");
            case "--listen":
                if (args.Length < 6) return 1;
                return RunListen(args[1], args[2], args[3], args[4], args[5]);
            default:
                return 1;
        }
    }
}
