using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

internal static class OwnedDialogs
{
    private delegate bool Inspect(nint hwnd,nint context);
    [DllImport("user32")]private static extern bool EnumThreadWindows(uint thread,Inspect callback,nint context);
    [DllImport("user32")]private static extern nint GetWindow(nint hwnd,uint command);
    [DllImport("user32",CharSet=CharSet.Unicode)]private static extern int GetClassName(nint hwnd,StringBuilder text,int capacity);
    [DllImport("user32")]private static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32")]private static extern uint GetWindowThreadProcessId(nint hwnd,out uint pid);
    [DllImport("user32",CharSet=CharSet.Unicode)]private static extern bool PostMessage(nint hwnd,uint msg,nint w,nint l);
    private static nint Find(nint owner)
    {
        uint thread=GetWindowThreadProcessId(owner,out uint pid);
        if(pid!=Environment.ProcessId)return 0;
        nint result=0;
        EnumThreadWindows(thread,(h,_)=>{
            var className=new StringBuilder(128);GetClassName(h,className,128);
            if(IsWindowVisible(h) && className.ToString()=="#32770" && GetWindow(h,4)==owner){result=h;return false;}
            return true;
        },0);
        return result;
    }
    internal static async Task<bool> Answer(nint owner,string? export=null)
    {
        return await Task.Run(async ()=>{
            var time=Stopwatch.StartNew();nint hwnd;
            while((hwnd=Find(owner))==0 && time.Elapsed<TimeSpan.FromSeconds(8))await Task.Delay(40);
            if(hwnd==0)return false;
            if(export is null)return PostMessage(hwnd,0x111,7,0); // IDNO in our own close-confirmation dialog.
            try{
                var dialog=AutomationElement.FromHandle(hwnd);
                var combo=dialog.FindFirst(TreeScope.Descendants,new PropertyCondition(AutomationElement.AutomationIdProperty,"FileNameControlHost"));
                var field=combo?.FindFirst(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Edit));
                if(field is null)return false;
                var value=(ValuePattern)field.GetCurrentPattern(ValuePattern.Pattern);
                value.SetValue(export);
                if(value.Current.Value!=export)throw new IOException("Dialog filename did not change to the requested test path.");
                var button=dialog.FindFirst(TreeScope.Descendants,new PropertyCondition(AutomationElement.AutomationIdProperty,"1"));
                if(button is null)return false;
                PostMessage(hwnd,0x111,1,0);
                for(int i=0;i<100 && IsWindowVisible(hwnd);i++)await Task.Delay(50);
                if(IsWindowVisible(hwnd))throw new IOException("File dialog remained open after IDOK; filename="+value.Current.Value);
                hwnd=0;return true;
            }finally{if(hwnd!=0)PostMessage(hwnd,0x111,2,0);}
        });
    }
}
