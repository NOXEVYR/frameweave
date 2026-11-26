using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Runtime.InteropServices;
using System.Windows.Interop;
using System.Text.RegularExpressions;

namespace PrismDesktop;

internal static class Program
{
    [DllImport("user32", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool SetProp(nint hwnd, string name, nint value);
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 3 || !Uri.TryCreate(args[0], UriKind.Absolute, out var origin)
            || origin.Scheme != "http" || origin.Host != "127.0.0.1" || origin.UserInfo.Length != 0
            || origin.PathAndQuery != "/" || origin.Fragment.Length != 0 || !Path.IsPathFullyQualified(args[1])
            || !Regex.IsMatch(args[2], @"\A[0-9a-f]{64}\z"))
            return 2;
        var name = @"Local\PrismCanvas.Desktop." + args[2];
        using var singleton = new Mutex(true, name + ".Owner", out var first);
        if (!first)
        {
            try { using var running = EventWaitHandle.OpenExisting(name + ".Recall"); running.Set(); return 0; }
            catch (WaitHandleCannotBeOpenedException) { return 2; }
        }

        var app = new Application();
        var window = new DesktopWindow(origin, args[1]);
        window.SourceInitialized += (_,_) => SetProp(new WindowInteropHelper(window).Handle, "PrismCanvas.Native."+args[2], 1);
        using var recall = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".Recall");
        var listener = ThreadPool.RegisterWaitForSingleObject(recall, (_, _) => {
            if (!window.Dispatcher.HasShutdownStarted)
                window.Dispatcher.BeginInvoke(() => {
                    if (window.WindowState == WindowState.Minimized) window.WindowState = WindowState.Normal;
                    window.Activate();
                });
        }, null, Timeout.Infinite, false);
        try { return app.Run(window); }
        finally { listener.Unregister(null); }
    }
}
