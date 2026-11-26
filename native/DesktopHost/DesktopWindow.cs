using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace PrismDesktop;

internal sealed class DesktopWindow : Window
{
    private enum DwmAttribute { UseImmersiveDarkMode = 20, CaptionColor = 35, TextColor = 36 }

    [DllImport("dwmapi.dll", ExactSpelling=true)]
    private static extern int DwmSetWindowAttribute(nint hwnd, DwmAttribute attribute, in int value, int size);

    private readonly Uri origin;
    private readonly string profile;
    private readonly WebView2 view = new();
    private readonly HashSet<CoreWebView2DownloadOperation> downloads = new();
    private readonly Assembly assembly = typeof(DesktopWindow).Assembly;
    private readonly Dictionary<string,string> assets;
    private bool closeAccepted, checkingClose, documentLoaded, closed;
    private const string Headers = "Cache-Control: no-store\r\nX-Frame-Options: DENY\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-src http://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'\r\n";

    internal DesktopWindow(Uri origin, string profile)
    {
        this.origin = origin; this.profile = profile;
        Title = "棱光"; Background = Brushes.White;
        Foreground = new SolidColorBrush(Color.FromRgb(31,43,85));
        view.DefaultBackgroundColor = System.Drawing.Color.White;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Width = Math.Min(1500, SystemParameters.WorkArea.Width);
        Height = Math.Min(960, SystemParameters.WorkArea.Height);
        Icon = BitmapFrame.Create(new Uri("pack://application:,,,/PrismDesktop;component/frameweave.ico"));
        Content = view;
        assets = assembly.GetManifestResourceNames().Where(n => n.StartsWith("Prism.Ui/", StringComparison.Ordinal))
            .ToDictionary(n => "/" + n["Prism.Ui/".Length..].Replace('\\','/'), n => n, StringComparer.Ordinal);
        Loaded += async (_,_) => await InitializeAsync();
        Closing += CheckClosing;
        Closed += (_,_) => {
            closed = true;
            SystemParameters.StaticPropertyChanged -= OnSystemSettingChanged;
            view.Dispose();
        };
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        ApplyCaptionColors();
        SystemParameters.StaticPropertyChanged += OnSystemSettingChanged;
    }

    private void OnSystemSettingChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(SystemParameters.HighContrast)) ApplyCaptionColors();
    }

    private void ApplyCaptionColors()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000)) return;
        var hwnd = new WindowInteropHelper(this).Handle;
        int light = 0;
        int background = SystemParameters.HighContrast ? -1 : System.Drawing.ColorTranslator.ToWin32(System.Drawing.Color.White);
        int text = SystemParameters.HighContrast ? -1 : System.Drawing.ColorTranslator.ToWin32(System.Drawing.Color.FromArgb(31, 43, 85));
        DwmSetWindowAttribute(hwnd, DwmAttribute.UseImmersiveDarkMode, in light, sizeof(int));
        DwmSetWindowAttribute(hwnd, DwmAttribute.CaptionColor, in background, sizeof(int));
        DwmSetWindowAttribute(hwnd, DwmAttribute.TextColor, in text, sizeof(int));
    }

    private async Task InitializeAsync()
    {
        try
        {
            using var handler = new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false };
            using var probe = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(6), MaxResponseContentBufferSize = 65536 };
            using var response = await probe.GetAsync(new Uri(origin,"/api/bootstrap"));
            if (!response.IsSuccessStatusCode || response.Content.Headers.ContentType?.MediaType != "application/json")
                throw new IOException("工作区服务未能连接。");
            using var doc = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync());
            var boot = doc.RootElement;
            bool current = boot.TryGetProperty("application",out var app) && app.GetString()=="PrismCanvas";
            bool legacy = !boot.TryGetProperty("application",out _) && boot.TryGetProperty("version",out var version) && version.GetString()=="0.8.0";
            if ((!current && !legacy) || !boot.TryGetProperty("csrf",out var token) || token.GetString()?.Length is not (>=40 and <=64))
                throw new IOException("端口上的服务与棱光不匹配。");
            if (closed) return;
            var env = await CoreWebView2Environment.CreateAsync(null,profile);
            if (closed) return;
            await view.EnsureCoreWebView2Async(env);
            if (closed) return;
            var core=view.CoreWebView2;
            core.Settings.AreHostObjectsAllowed=false;
            core.Settings.IsWebMessageEnabled=false;
            core.Settings.IsStatusBarEnabled=false;
            core.Settings.AreBrowserAcceleratorKeysEnabled=false;
            core.Settings.IsGeneralAutofillEnabled=false;
            core.Settings.IsPasswordAutosaveEnabled=false;
            core.AddWebResourceRequestedFilter(origin.AbsoluteUri+"*",CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += ServeClient;
            core.NavigationStarting += (_,eventArgs) => {
                if (!Uri.TryCreate(eventArgs.Uri,UriKind.Absolute,out var target) || !IsOrigin(target)
                    || target.AbsolutePath is not ("/" or "/index.html")) eventArgs.Cancel=true;
            };
            core.NewWindowRequested += (_,request) => {
                request.Handled=true;
                if (request.IsUserInitiated && Uri.TryCreate(request.Uri,UriKind.Absolute,out var target)
                    && target.Scheme is "http" or "https" && target.UserInfo.Length==0 && !target.IsLoopback)
                {
                    try { Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute=true }); }
                    catch (Win32Exception) { MessageBox.Show(this,"系统未能打开这个链接。","棱光"); }
                }
            };
            core.PermissionRequested += (_,e) => {
                if(!e.IsUserInitiated || !Uri.TryCreate(e.Uri,UriKind.Absolute,out var requester) || !IsOrigin(requester))
                    e.State=CoreWebView2PermissionState.Deny;
            };
            core.DownloadStarting += SaveDownload;
            core.WindowCloseRequested += (_,_) => Close();
            core.DOMContentLoaded += (_,_) => documentLoaded=true;
            await core.AddScriptToExecuteOnDocumentCreatedAsync(
                "if(window===window.top){const mark=()=>{document.documentElement.dataset.nativeHost='true'};" +
                "if(document.documentElement)mark();else document.addEventListener('DOMContentLoaded',mark,{once:true});}");
            core.Navigate(origin.AbsoluteUri);
        }
        catch (Exception) when (closed) {}
        catch (Exception ex)
        {
            view.Dispose();
            var message = ex is WebView2RuntimeNotFoundException ? "请安装 Microsoft Edge WebView2 Runtime，然后重新打开棱光。" :
                "无法连接或显示本地工作区。请确认本机服务仍在运行，然后重新打开棱光。";
            Content = new TextBlock { Text=message, Margin=new Thickness(32), TextWrapping=TextWrapping.Wrap };
        }
    }

    private bool IsOrigin(Uri uri) => uri.Scheme==origin.Scheme && uri.Host==origin.Host && uri.Port==origin.Port && uri.UserInfo.Length==0;
    private void ServeClient(object? sender,CoreWebView2WebResourceRequestedEventArgs e)
    {
        var uri=new Uri(e.Request.Uri);
        if(!IsOrigin(uri) || e.Request.Method!="GET")return;
        string path=uri.AbsolutePath=="/" ? "/index.html" : uri.AbsolutePath;
        if(!assets.TryGetValue(path,out string? resource))return;
        string type=Path.GetExtension(path) switch {".html"=>"text/html; charset=utf-8",".js" or ".mjs"=>"text/javascript; charset=utf-8",
            ".css"=>"text/css; charset=utf-8",".svg"=>"image/svg+xml",".png"=>"image/png",".webp"=>"image/webp",".json"=>"application/json",_=>"application/octet-stream"};
        e.Response=view.CoreWebView2.Environment.CreateWebResourceResponse(assembly.GetManifestResourceStream(resource),200,"OK",Headers+"Content-Type: "+type+"\r\n");
    }

    private void SaveDownload(object? sender,CoreWebView2DownloadStartingEventArgs e)
    {
        var operation=e.DownloadOperation;
        e.Handled=true;
        var pending=e.GetDeferral();
        Dispatcher.BeginInvoke(() => {
            try
            {
                var dialog=new Microsoft.Win32.SaveFileDialog{FileName=Path.GetFileName(e.ResultFilePath),OverwritePrompt=true,AddExtension=false};
                if(closed || dialog.ShowDialog(this)!=true){e.Cancel=true;return;}
                e.ResultFilePath=dialog.FileName;
                downloads.Add(operation);
                operation.StateChanged+=(_,_)=>{if(operation.State!=CoreWebView2DownloadState.InProgress)downloads.Remove(operation);};
            }
            finally { pending.Complete(); }
        });
    }

    private async void CheckClosing(object? sender,CancelEventArgs e)
    {
        if(closeAccepted || !documentLoaded)return;
        e.Cancel=true;
        if(checkingClose)return;
        checkingClose=true;
        try
        {
            string ready=await view.ExecuteScriptAsync("window.dispatchEvent(new Event('beforeunload',{cancelable:true}))").WaitAsync(TimeSpan.FromSeconds(5));
            if((ready!="true" || downloads.Count>0) && !ConfirmClose())return;
        }
        catch(Exception){if(!ConfirmClose())return;}
        finally{checkingClose=false;}
        closeAccepted=true;
        _ = Dispatcher.BeginInvoke(Close);
    }
    private bool ConfirmClose()=>MessageBox.Show(this,"可能有未保存的编辑或尚未完成的下载。确认关闭棱光窗口？","棱光",MessageBoxButton.YesNo,MessageBoxImage.Question,MessageBoxResult.No)==MessageBoxResult.Yes;
}
