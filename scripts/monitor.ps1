# Tau crash monitor: launches the app, watches for exit, and reports the
# exit code. A hard-killed process leaves no WER/panic/exit trace in
# tau.log, but the exit code still tells us a lot:
#   0x00000000         — someone called exit(0) (suspicious; normal close
#                        writes "exit requested" to tau.log first)
#   0x00000065 (101)   — Rust panic (should also appear in tau.log)
#   0xC0000409         — fail-fast / stack overflow
#   0xC0000017         — out of memory (commit failure)
#   0xC0000005         — access violation (would normally produce a WER)
#   0x40010004         — killed via TerminateProcess (task manager, AV, …)
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\monitor.ps1
# The script prints the result and appends one line to monitor-results.txt.

$ErrorActionPreference = "Stop"

$candidates = @(
    "C:\Program Files\Tau\tau.exe",
    "$env:LOCALAPPDATA\Programs\Tau\tau.exe",
    "D:\agents\pi-gui\src-tauri\target\release\tau.exe"
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
    Write-Host "tau.exe not found; checked: $($candidates -join ', ')"
    exit 1
}
Write-Host "Launching: $exe"

$before = Get-CimInstance Win32_OperatingSystem
$started = Get-Date
$p = Start-Process -FilePath $exe -PassThru
Write-Host "PID: $($p.Id)  started: $($started.ToString('HH:mm:ss'))"

# Sample memory while it runs (every 2s, keep the peak).
$peak = 0
while (-not $p.HasExited) {
    Start-Sleep -Milliseconds 2000
    $p.Refresh()
    $mem = [math]::Round($p.WorkingSet64 / 1MB)
    if ($mem -gt $peak) { $peak = $mem }
}

$elapsed = (Get-Date) - $started
$code = $p.ExitCode
$hex = "0x{0:X8}" -f ([uint32]$code)
$after = Get-CimInstance Win32_OperatingSystem

$line = "{0} | exe={1} | ran={2:N1}s | exit={3} ({4}) | peak={5}MB | free-mem-before={6:N0}MB after={7:N0}MB" -f `
    (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $exe, $elapsed.TotalSeconds, $code, $hex, `
    $peak, ($before.FreePhysicalMemory/1KB), ($after.FreePhysicalMemory/1KB)

Write-Host ""
Write-Host "==== RESULT ===="
Write-Host $line
Write-Host ""
if ($code -eq 0) { Write-Host "Exit code 0 — the process exited cleanly (check tau.log for 'exit requested')." }
elseif ($code -eq 101) { Write-Host "Exit code 101 — Rust panic (should be in tau.log as 'panic: ...')." }
else { Write-Host "Non-zero exit — killed or crashed. Check WER/LocalDumps and tau.log." }

$line | Out-File -Append -Encoding utf8 "$PSScriptRoot\monitor-results.txt"
Write-Host "Appended to scripts\monitor-results.txt"
