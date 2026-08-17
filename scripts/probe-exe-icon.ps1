# Sample the real embedded icon of an exe: center pixel + opaque coverage.
param([string]$ExePath)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IconProbe2 {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int ExtractIconExW(string file, int index, IntPtr[] large, IntPtr[] small, int n);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr hIcon);
}
'@
$large = New-Object IntPtr[] 1
$small = New-Object IntPtr[] 1
$n = [IconProbe2]::ExtractIconExW($ExePath, 0, $large, $small, 1)
if ($n -le 0) { Write-Host "no icons extracted"; exit 1 }
$h = if ($large[0] -ne [IntPtr]::Zero) { $large[0] } else { $small[0] }
$icon = [System.Drawing.Icon]::FromHandle($h)
$bmp = $icon.ToBitmap()
$W = $bmp.Width; $H = $bmp.Height
$opaque = 0; $sr = 0; $sg = 0; $sb = 0; $total = 0
for ($y = 0; $y -lt $H; $y += [math]::Max(1, [int]($H / 24))) {
  for ($x = 0; $x -lt $W; $x += [math]::Max(1, [int]($W / 24))) {
    $p = $bmp.GetPixel($x, $y)
    $total++
    if ($p.A -gt 128) { $opaque++; $sr += $p.R; $sg += $p.G; $sb += $p.B }
  }
}
$c = $bmp.GetPixel([int]($W / 2), [int]($H / 2))
$avg = if ($opaque -gt 0) { "avg r=$([math]::Round($sr/$opaque)) g=$([math]::Round($sg/$opaque)) b=$([math]::Round($sb/$opaque))" } else { "avg none" }
Write-Host "size=${W}x${H} center(r=$($c.R) g=$($c.G) b=$($c.B) a=$($c.A)) opaquePct=$([math]::Round(100*$opaque/$total)) $avg"
$bmp.Dispose()
$icon.Dispose()
[IconProbe2]::DestroyIcon($h) | Out-Null
if ($large[0] -ne [IntPtr]::Zero) { [IconProbe2]::DestroyIcon($large[0]) | Out-Null }
if ($small[0] -ne [IntPtr]::Zero) { [IconProbe2]::DestroyIcon($small[0]) | Out-Null }
