param([string]$Action, [string]$Title = '', [int]$X = 0, [int]$Y = 0)
$ErrorActionPreference = 'Stop'
# Probe-owned windows only. Refuse input unless the exact window has focus.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ColorpickInput {
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(IntPtr c,string t);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr w);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr w,ref POINT p);
 [DllImport("user32.dll")] public static extern uint SendInput(uint n,INPUT[] a,int s);
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x,y; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSE { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct KEY { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSE mouse; [FieldOffset(0)] public KEY key; }
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION value; }
 public static uint Click() {
  var a=new INPUT[2];a[0].value.mouse.flags=2;a[1].value.mouse.flags=4;
  return SendInput(2,a,Marshal.SizeOf(typeof(INPUT)));
 }
 public static uint Escape() {
  var a=new INPUT[2];a[0].type=1;a[1].type=1;
  a[0].value.key.vk=27;a[1].value.key.vk=27;a[1].value.key.flags=2;
  return SendInput(2,a,Marshal.SizeOf(typeof(INPUT)));
 }
}
'@
[void][ColorpickInput]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
if ($Action -eq 'screens') {
 Add-Type -AssemblyName System.Windows.Forms
 @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  @{device=$_.DeviceName;x=$_.Bounds.X;y=$_.Bounds.Y;width=$_.Bounds.Width;height=$_.Bounds.Height}
 }) | ConvertTo-Json -Compress
 exit
}
if (!$Title.StartsWith('WeftCut colorpick probe overlay ')) { throw 'Input target is not a probe overlay' }
$targetWindow=[ColorpickInput]::FindWindow([IntPtr]::Zero,$Title)
if ($targetWindow -eq [IntPtr]::Zero) { throw 'Probe window not found' }
[void][ColorpickInput]::SetForegroundWindow($targetWindow)
Start-Sleep -Milliseconds 100
if ([ColorpickInput]::GetForegroundWindow() -ne $targetWindow) { throw 'Probe window has no foreground focus' }
if ($Action -eq 'click') {
 $previous=[ColorpickInput+POINT]::new()
 [void][ColorpickInput]::GetCursorPos([ref]$previous)
 $point=[ColorpickInput+POINT]::new();$point.x=$X;$point.y=$Y
 [void][ColorpickInput]::ClientToScreen($targetWindow,[ref]$point)
 [void][ColorpickInput]::SetCursorPos($point.x,$point.y)
 $count=[ColorpickInput]::Click()
 Start-Sleep -Milliseconds 100
 [void][ColorpickInput]::SetCursorPos($previous.x,$previous.y)
} elseif ($Action -eq 'escape') { $count=[ColorpickInput]::Escape() }
else { throw 'Unknown action' }
if ($count -ne 2) { throw "SendInput delivered $count events instead of 2" }
@{action=$Action;sent=$count;target=$Title} | ConvertTo-Json -Compress
