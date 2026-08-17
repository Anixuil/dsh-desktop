# Read the LIVE taskbar icon (WM_GETICON ICON_BIG) of a window by process id.
param([int]$TargetPid)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WinIcon {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int max);
  public const uint WM_GETICON = 0x007F;
  public const uint ICON_BIG = 1;
  public const uint SMTO_ABORTIFHUNG = 0x0002;
}
'@
$target = [uint32]$TargetPid
$windows = New-Object System.Collections.Generic.List[System.IntPtr]
$cb = [WinIcon+EnumWindowsProc]{ param($h, $l)
  $wpid = [uint32]0
  [WinIcon]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
  if ($wpid -eq $target) { $windows.Add($h) }
  return $true
}
[WinIcon]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
Write-Host "windows for pid $TargetPid : $($windows.Count)"
foreach ($h in $windows) {
  $sb = New-Object System.Text.StringBuilder 256
  [WinIcon]::GetWindowTextW($h, $sb, 256) | Out-Null
  $vis = [WinIcon]::IsWindowVisible($h)
  $res = [IntPtr]::Zero
  [WinIcon]::SendMessageTimeout($h, [WinIcon]::WM_GETICON, [WinIcon]::ICON_BIG, [IntPtr]::Zero, [WinIcon]::SMTO_ABORTIFHUNG, 500, [ref]$res) | Out-Null
  $hIcon = $res
  if ($hIcon -eq [IntPtr]::Zero) {
    Write-Host "hwnd=$h title='$($sb.ToString())' visible=$vis -> no big icon"
    continue
  }
  $icon = [System.Drawing.Icon]::FromHandle($hIcon)
  $bmp = $icon.ToBitmap()
  $W = $bmp.Width; $H = $bmp.Height
  $opaque = 0; $sr = 0; $sg = 0; $sb = 0; $total = 0
  for ($y = 0; $y -lt $H; $y += [math]::Max(1, [int]($H / 24))) {
    for ($x = 0; $x -lt $W; $x += [math]::Max(1, [int]($W / 24))) {
      $p = $bmp.GetPixel($x, $y); $total++
      if ($p.A -gt 128) { $opaque++; $sr += $p.R; $sg += $p.G; $sb += $p.B }
    }
  }
  $c = $bmp.GetPixel([int]($W / 2), [int]($H / 2))
  $avg = if ($opaque -gt 0) { "avg r=$([math]::Round($sr/$opaque)) g=$([math]::Round($sg/$opaque)) b=$([math]::Round($sb/$opaque))" } else { "avg none" }
  Write-Host "hwnd=$h title='$($sb.ToString())' visible=$vis size=${W}x${H} center(r=$($c.R) g=$($c.G) b=$($c.B) a=$($c.A)) opaquePct=$([math]::Round(100*$opaque/$total)) $avg"
  $bmp.Dispose()
  $icon.Dispose()
}

