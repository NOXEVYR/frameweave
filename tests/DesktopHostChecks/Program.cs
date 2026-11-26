using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Wpf;
using PrismDesktop;

internal static class Program
{
    [DllImport("kernel32")]static extern uint GetCurrentThreadId();
    [DllImport("user32")]static extern nint GetThreadDesktop(uint tid);
    [DllImport("user32",EntryPoint="GetUserObjectInformationW",CharSet=CharSet.Unicode)]static extern bool GetName(nint h,int index,StringBuilder value,int length,out int required);
    [DllImport("user32",EntryPoint="GetUserObjectInformationW")]static extern bool IsInput(nint h,int index,out int input,int length,out int required);

    [STAThread]
    private static int Main(string[] args)
    {
        var desktop=GetThreadDesktop(GetCurrentThreadId());var name=new StringBuilder(260);
        if(args.Length!=1 || !IsInput(desktop,6,out int input,4,out _) || input!=0 ||
            !GetName(desktop,2,name,520,out _) || !name.ToString().StartsWith("QingyuHubCheck",StringComparison.Ordinal))return 2;
        string area=Path.GetFullPath(args[0]);Directory.CreateDirectory(area);
        using var server=new TcpListener(IPAddress.Loopback,0);server.Start();
        int port=((IPEndPoint)server.LocalEndpoint).Port;
        using var stop=new CancellationTokenSource();
        var worker=Task.Run(async ()=>{
            try { while(!stop.IsCancellationRequested)
            {
                var client=await server.AcceptTcpClientAsync(stop.Token);
                _=Task.Run(async ()=>{
                    using(client)
                    {
                        try{
                            var stream=client.GetStream();using var reader=new StreamReader(stream,Encoding.ASCII,leaveOpen:true);
                            var line=await reader.ReadLineAsync()??"";
                            while(!string.IsNullOrEmpty(await reader.ReadLineAsync())){}
                            bool api=line.StartsWith("GET /api/bootstrap ");
                            string body=api?JsonSerializer.Serialize(new {application="PrismCanvas",version="0.11.5",
                                csrf=new string('x',48),settings=new {backend_url="",model_roots=Array.Empty<string>(),comfy_roots=Array.Empty<string>()},presets=Array.Empty<string>(),probeValue="fixture-live-api"}):
                                line.StartsWith("GET / ")? "<html><title>obsolete browser UI</title></html>" : "{}";
                            byte[] bytes=Encoding.UTF8.GetBytes(body);
                            string headers=$"HTTP/1.1 200 OK\r\nContent-Length: {bytes.Length}\r\nContent-Type: {(line.StartsWith("GET / ")?"text/html":"application/json")}\r\nConnection: close\r\n\r\n";
                            await stream.WriteAsync(Encoding.ASCII.GetBytes(headers));await stream.WriteAsync(bytes);
                        }catch(IOException){}
                    }
                });
            }}catch(OperationCanceledException){}
        });
        var app=new Application{ShutdownMode=ShutdownMode.OnExplicitShutdown};
        var checks=new List<string>();int code=1;string? error=null;
        app.Startup+=async (_,_)=>{
            var uri=new Uri($"http://127.0.0.1:{port}/");
            var profile=Path.Combine(area,"private-profile");
            DesktopWindow? window=null;
            try
            {
                void Check(string label,bool passed){if(!passed)throw new InvalidOperationException(label);checks.Add(label);}
                async Task<WebView2> Open()
                {
                    window=new DesktopWindow(uri,profile);window.Show();
                    var time=Stopwatch.StartNew();
                    while(time.Elapsed<TimeSpan.FromSeconds(30))
                    {
                        if(window.Content is not WebView2 view) throw new InvalidOperationException("WebView2 startup failed");
                        if(view.CoreWebView2!=null && await view.ExecuteScriptAsync("document.documentElement?.dataset.nativeHost==='true' && !!document.querySelector('#save-version')")=="true")
                            return view;
                        await Task.Delay(100);
                    }
                    throw new TimeoutException("current client resources did not render");
                }
                var first=await Open();
                Check("WPF desktop window uses the single product name",window!.Title=="棱光");
                Check("bundled local UI overrides old backend HTML and keeps original HTTP origin",!first.Source.ToString().Contains("file:") && first.Source==uri);
                await first.ExecuteScriptAsync("fetch('/api/bootstrap').then(r=>r.json()).then(r=>document.body.dataset.probe=r.probeValue)");
                await Task.Delay(300);
                Check("current client reaches real old-server API route",await first.ExecuteScriptAsync("document.body.dataset.probe")=="\"fixture-live-api\"");
                Check("bundled stylesheet and scripts render",await first.ExecuteScriptAsync("document.styleSheets.length>0 && !!document.querySelector('script[type=module]')")=="true");
                Check("native document flag present only on the app document",await first.ExecuteScriptAsync("document.documentElement.dataset.nativeHost")=="\"true\"");
                Check("save shortcut is not intercepted by browser chrome",!first.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled);
                var owner=new WindowInteropHelper(window).Handle;
                Check("native workspace and WebView share the white startup surface",
                      window.Background is System.Windows.Media.SolidColorBrush brush
                      && brush.Color == System.Windows.Media.Colors.White
                      && first.DefaultBackgroundColor.ToArgb() == System.Drawing.Color.White.ToArgb());
                string saved=Path.Combine(area,"private-export.txt");
                first.CoreWebView2.Profile.DefaultDownloadFolderPath=area;
                Microsoft.Web.WebView2.Core.CoreWebView2DownloadOperation? download=null;
                first.CoreWebView2.DownloadStarting+=(_,e)=>download=e.DownloadOperation;
                var saving=OwnedDialogs.Answer(owner,saved);
                await first.ExecuteScriptAsync("(()=>{const b=new Blob(['fixture-export'],{type:'text/plain'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='fixture-export.txt';document.body.append(a);a.click();a.remove()})()");
                Check("export opens Windows Save As owned by the client",await saving);
                for(int i=0;i<150 && !File.Exists(saved);i++)await Task.Delay(50);
                File.WriteAllText(Path.Combine(area,"download.log"), download==null?"absent":$"{download.State} {download.InterruptReason} {download.BytesReceived} {Path.GetFileName(download.ResultFilePath)}");
                Check("accepted blob download has the original bytes",File.Exists(saved) && File.ReadAllText(saved)=="fixture-export");
                await first.ExecuteScriptAsync("localStorage.setItem('test-only-native-draft','persistent');window.addEventListener('beforeunload',()=>localStorage.setItem('test-only-close','delivered'),{once:true});");
                bool blocked=false;
                first.CoreWebView2.NavigationStarting+=(_,e)=>{if(e.Uri=="data:text/html,denied")blocked=e.Cancel;};
                first.CoreWebView2.Navigate("data:text/html,denied");await Task.Delay(200);
                Check("foreign top-level navigation blocked",blocked && first.Source==uri);
                await first.ExecuteScriptAsync("window.addEventListener('beforeunload', e=>e.preventDefault(),{once:true})");
                var decline=OwnedDialogs.Answer(owner);window.Close();
                Check("unsaved-close confirmation can preserve the current window",await decline && window.IsVisible);
                await Task.Delay(100);
                window.Close();
                for(int i=0;i<60 && window.IsVisible;i++)await Task.Delay(50);
                Check("native close completes through draft guard",!window.IsVisible);
                var second=await Open();
                Check("draft storage and prior close notification survive reopen",await second.ExecuteScriptAsync("localStorage.getItem('test-only-native-draft')==='persistent' && localStorage.getItem('test-only-close')==='delivered'")=="true");
                code=0;
            }
            catch(Exception ex){error=ex.ToString();}
            finally
            {
                File.WriteAllText(Path.Combine(area,"result.json"),JsonSerializer.Serialize(new {checks,error},new JsonSerializerOptions{WriteIndented=true}));
                app.Shutdown();
            }
        };
        app.Run();stop.Cancel();return code;
    }
}
