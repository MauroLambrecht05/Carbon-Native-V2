# test-hmr.ps1 — End-to-end verification of in-process HMR for carbon-mini.
#
# What it does:
#   1. Builds the mini-counter example
#   2. Launches carbon-mini.exe with --dev
#   3. SendInput-clicks the Increment button N times (default 5)
#   4. Screenshots the window into docs/history/paths/hmr-before.png
#   5. Edits counter.tsx (changes the heading text only)
#   6. Re-runs the build (CLI build pipeline writes new bundle.qbc.zst)
#   7. Waits for the runtime's bundle-file watcher to fire + reload
#   8. Screenshots the window into docs/history/paths/hmr-after.png
#   9. Reads the runtime's stderr for the [carbon-mini-hmr] reload timing
#   10. Restores counter.tsx and exits

param(
  [int]$Clicks = 5,
  [string]$ProjectDir = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\examples\mini-counter",
  [string]$RuntimeExe = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\runtimes\mini\target\release\carbon-mini.exe",
  [string]$DocsDir = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\docs\history\paths",
  [int]$ReloadWaitMs = 3000
)

$ErrorActionPreference = "Continue"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Drawing;
public class HmrWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] public static extern uint GetWindowThreadId(IntPtr hWnd, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndAfter, int x, int y, int cx, int cy, uint flags);
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_SHOWWINDOW = 0x0040;
  public static readonly IntPtr HWND_TOP = new IntPtr(0);
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT pt);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, [In] INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  public const uint WM_MOUSEMOVE = 0x0200;
  public const uint WM_LBUTTONDOWN = 0x0201;
  public const uint WM_LBUTTONUP = 0x0202;
  public const int MK_LBUTTON = 0x0001;

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int x, y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx, dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg;
    public ushort wParamL, wParamH;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public INPUTUNION u;
  }
}
"@

$global:HMR_TARGET_PID = 0
$global:HMR_FOUND_HWND = [IntPtr]::Zero

function Find-MiniWindow([int]$targetPid) {
  $global:HMR_TARGET_PID = $targetPid
  $cb = [HmrWin+EnumWindowsProc] {
    param([IntPtr]$h, [IntPtr]$l)
    $wpid = [uint32]0
    [HmrWin]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
    if ($wpid -eq $global:HMR_TARGET_PID -and [HmrWin]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 256
      [HmrWin]::GetWindowTextW($h, $sb, 256) | Out-Null
      $title = $sb.ToString()
      # Only match the actual UI window. Console stubs sometimes carry a
      # path-like title so we must compare exact, not contains.
      if ($title -eq "carbon-mini") {
        # Also require non-trivial client size — Console stubs often
        # report a tiny rect. The UI window is 600x400 logical.
        $r = New-Object HmrWin+RECT
        [HmrWin]::GetClientRect($h, [ref]$r) | Out-Null
        if (($r.right - $r.left) -ge 200 -and ($r.bottom - $r.top) -ge 100) {
          $global:HMR_FOUND_HWND = $h
          return $false
        }
      }
    }
    return $true
  }
  for ($i = 0; $i -lt 200; $i++) {
    $global:HMR_FOUND_HWND = [IntPtr]::Zero
    [HmrWin]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
    if ($global:HMR_FOUND_HWND -ne [IntPtr]::Zero) { return $global:HMR_FOUND_HWND }
    Start-Sleep -Milliseconds 100
  }
  throw "carbon-mini window not found after 20s"
}

function Click-Window([IntPtr]$hwnd, [int]$clientX, [int]$clientY) {
  # PostMessage WM_MOUSEMOVE + WM_LBUTTONDOWN/UP directly to the window.
  # Coordinates are CLIENT (relative to window's client-area origin),
  # packed as LOWORD=x, HIWORD=y in lParam. This bypasses the Windows
  # focus/UIAccess restrictions that block SendInput from a non-foreground
  # PowerShell session — the WM_LBUTTON* messages land in tao's window
  # proc and produce MouseInput events without needing the global focus.
  $lParam = [IntPtr](([int]$clientY -shl 16) -bor ([int]$clientX -band 0xFFFF))
  [HmrWin]::PostMessageW($hwnd, [HmrWin]::WM_MOUSEMOVE, [IntPtr]::Zero, $lParam) | Out-Null
  Start-Sleep -Milliseconds 30
  [HmrWin]::PostMessageW($hwnd, [HmrWin]::WM_LBUTTONDOWN, [IntPtr][HmrWin]::MK_LBUTTON, $lParam) | Out-Null
  Start-Sleep -Milliseconds 30
  [HmrWin]::PostMessageW($hwnd, [HmrWin]::WM_LBUTTONUP, [IntPtr]::Zero, $lParam) | Out-Null
  Start-Sleep -Milliseconds 60
}

function Screenshot-Window([IntPtr]$hwnd, [string]$path) {
  # Briefly mark topmost so the screenshot captures the carbon-mini UI
  # even if other apps are layered above. We restore non-topmost after.
  [HmrWin]::SetWindowPos($hwnd, [HmrWin]::HWND_TOPMOST, 0, 0, 0, 0,
    [HmrWin]::SWP_NOMOVE -bor [HmrWin]::SWP_NOSIZE -bor [HmrWin]::SWP_SHOWWINDOW) | Out-Null
  Start-Sleep -Milliseconds 200

  $rect = New-Object HmrWin+RECT
  [HmrWin]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $w = $rect.right - $rect.left
  $h = $rect.bottom - $rect.top
  if ($w -le 0 -or $h -le 0) { throw "bad window rect" }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($rect.left, $rect.top, 0, 0, (New-Object System.Drawing.Size $w, $h))
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  Write-Host "[hmr-test] saved $path ($w x $h)"

  [HmrWin]::SetWindowPos($hwnd, [HmrWin]::HWND_NOTOPMOST, 0, 0, 0, 0,
    [HmrWin]::SWP_NOMOVE -bor [HmrWin]::SWP_NOSIZE -bor [HmrWin]::SWP_SHOWWINDOW) | Out-Null
}

# ── Step 0: build ──────────────────────────────────────────────────────────
Write-Host "[hmr-test] building project…"
$env:PATH = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\scripts;$env:PATH"
$cliSrc = "C:\Users\mauro\Desktop\electrobun-bench\carbon-native\cli\src\index.ts"
# Use cmd.exe to avoid PowerShell wrapping native stderr lines as ErrorRecords
# (which would make the call appear to fail under StrictMode/Stop).
$buildOut = cmd /c bun "$cliSrc" build "$ProjectDir" 2>&1 | Out-String
Write-Host $buildOut

# ── Step 1: launch carbon-mini --dev ──────────────────────────────────────
Write-Host "[hmr-test] launching carbon-mini --dev…"
$stderrFile = Join-Path $env:TEMP "carbon-mini-hmr-stderr.txt"
$stdoutFile = Join-Path $env:TEMP "carbon-mini-hmr-stdout.txt"
if (Test-Path $stderrFile) { Remove-Item $stderrFile }
if (Test-Path $stdoutFile) { Remove-Item $stdoutFile }
# Enable click-debug so the test can prove the synthetic clicks
# actually reached tao's MouseInput dispatch path. Production-mode
# carbon-mini ignores this env var.
$env:CARBON_MINI_CLICK_DEBUG = "1"
$proc = Start-Process -FilePath $RuntimeExe -ArgumentList @($ProjectDir, "--dev") `
  -RedirectStandardError $stderrFile -RedirectStandardOutput $stdoutFile `
  -PassThru
Remove-Item env:CARBON_MINI_CLICK_DEBUG -ErrorAction SilentlyContinue

# Read original counter.tsx so we can always restore it in finally.
$tsxPath = Join-Path $ProjectDir "counter.tsx"
$origTsx = [System.IO.File]::ReadAllText($tsxPath, [System.Text.Encoding]::UTF8)

try {

$hwnd = Find-MiniWindow $proc.Id
Write-Host "[hmr-test] window handle: $hwnd"

# Make the window topmost briefly so it actually comes to the front,
# then drop topmost flag. SetForegroundWindow alone fails on Win11 if
# another process owns the foreground. The topmost-toggle trick is the
# canonical workaround used by AutoIt et al.
[HmrWin]::ShowWindow($hwnd, 9) | Out-Null  # SW_RESTORE
[HmrWin]::SetWindowPos($hwnd, [HmrWin]::HWND_TOPMOST, 0, 0, 0, 0,
  [HmrWin]::SWP_NOMOVE -bor [HmrWin]::SWP_NOSIZE -bor [HmrWin]::SWP_SHOWWINDOW) | Out-Null
Start-Sleep -Milliseconds 200
[HmrWin]::SetWindowPos($hwnd, [HmrWin]::HWND_NOTOPMOST, 0, 0, 0, 0,
  [HmrWin]::SWP_NOMOVE -bor [HmrWin]::SWP_NOSIZE -bor [HmrWin]::SWP_SHOWWINDOW) | Out-Null
[HmrWin]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 600

# Diagnostics: log the window rect we're about to click into.
$rect0 = New-Object HmrWin+RECT
[HmrWin]::GetWindowRect($hwnd, [ref]$rect0) | Out-Null
Write-Host "[hmr-test] window rect: L=$($rect0.left) T=$($rect0.top) R=$($rect0.right) B=$($rect0.bottom)"
$cli0 = New-Object HmrWin+RECT
[HmrWin]::GetClientRect($hwnd, [ref]$cli0) | Out-Null
Write-Host "[hmr-test] client size: $($cli0.right) x $($cli0.bottom)"

# ── Step 2: click Increment N times ──────────────────────────────────────
# Force topmost during the click sequence so we don't fight any other
# app for the foreground.
[HmrWin]::SetWindowPos($hwnd, [HmrWin]::HWND_TOPMOST, 0, 0, 0, 0,
  [HmrWin]::SWP_NOMOVE -bor [HmrWin]::SWP_NOSIZE -bor [HmrWin]::SWP_SHOWWINDOW) | Out-Null
Start-Sleep -Milliseconds 200
# Increment button center in CLIENT coordinates (independent of window
# position). counter.tsx layout: padding=24, heading=24+, count=20+, button=40,
# all stacked column with gap=12. So button top ≈ 24+30+12+25+12 ≈ 103,
# center ≈ 123. X center = 24 + 90 = 114.
$btnClientX = 114
$btnClientY = 123
Write-Host "[hmr-test] PostMessage-clicking client ($btnClientX, $btnClientY) $Clicks times…"
for ($i = 1; $i -le $Clicks; $i++) {
  Click-Window $hwnd $btnClientX $btnClientY
  Start-Sleep -Milliseconds 100
}
Start-Sleep -Milliseconds 600

# ── Step 3: screenshot before ─────────────────────────────────────────────
Screenshot-Window $hwnd (Join-Path $DocsDir "hmr-before.png")

# ── Step 4: edit counter.tsx ──────────────────────────────────────────────
$editedTsx = $origTsx -replace "carbon-mini counter", "edited! counter"
if ($editedTsx -eq $origTsx) {
  throw "edit replacement did not match"
}
Write-Host "[hmr-test] writing edited counter.tsx…"
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($tsxPath, $editedTsx, $utf8)

# ── Step 5: rebuild ──────────────────────────────────────────────────────
$tBuildStart = [System.Diagnostics.Stopwatch]::StartNew()
Write-Host "[hmr-test] running carbon build (force rebuild)…"
$null = cmd /c bun "$cliSrc" build "$ProjectDir" 2>&1 | Out-String
$buildMs = $tBuildStart.ElapsedMilliseconds
Write-Host "[hmr-test] build took $buildMs ms"

# ── Step 6: wait for reload ──────────────────────────────────────────────
Write-Host "[hmr-test] waiting $ReloadWaitMs ms for runtime to detect + reload…"
Start-Sleep -Milliseconds $ReloadWaitMs

# ── Step 7: screenshot after ─────────────────────────────────────────────
Screenshot-Window $hwnd (Join-Path $DocsDir "hmr-after.png")

# ── Step 8: read stderr for reload timing ────────────────────────────────
$stderr = Get-Content -Raw $stderrFile -ErrorAction SilentlyContinue
Write-Host "[hmr-test] runtime stderr:`n$stderr"

$reloadLines = $stderr -split "`n" | Where-Object { $_ -match "carbon-mini-hmr" }

} finally {
  # ── Step 9: cleanup (always runs) ────────────────────────────────────────
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($tsxPath, $origTsx, $utf8)
  Write-Host "[hmr-test] restored counter.tsx"
  try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch {}
}

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════"
Write-Host " HMR TEST COMPLETE"
Write-Host "═══════════════════════════════════════════════════════════════"
Write-Host " Clicks issued        : $Clicks"
Write-Host " Build (carbon build) : $buildMs ms"
Write-Host " Reload events        : $($reloadLines.Count)"
foreach ($line in $reloadLines) { Write-Host "  $line" }
Write-Host " Before screenshot    : $(Join-Path $DocsDir 'hmr-before.png')"
Write-Host " After screenshot     : $(Join-Path $DocsDir 'hmr-after.png')"
Write-Host "═══════════════════════════════════════════════════════════════"
