# Hourly paper step for Windows Task Scheduler. Appends output to logs\live.log and EXITS WITH THE
# ENGINE'S EXIT CODE so Task Scheduler's "Last Run Result" shows failures (0 ok, 1 halted, 2 failed,
# 3 another step was running). Local only: nothing is uploaded, nothing is pushed anywhere.
#
# Production must run from a PINNED release checkout (docs/RUNBOOK.md section 1), e.g.
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\crypto-prod\deploy\run_step.ps1
# The repo root is the parent of this script's folder, so the same file works in any checkout.
param(
    [string]$Uv = $(if ($env:ENGINE_UV) { $env:ENGINE_UV } else { "C:\Users\kilar\AppData\Local\hermes\bin\uv.exe" }),
    [int]$MaxLogMB = 20
)
$ErrorActionPreference = "Continue"
$App = Split-Path -Parent $PSScriptRoot
Set-Location $App
New-Item -ItemType Directory -Force logs | Out-Null
$Log = Join-Path $App "logs\live.log"

# size-based rotation: live.log -> live.log.1 (one generation kept)
if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt $MaxLogMB * 1MB)) {
    Move-Item -Force $Log "$Log.1"
}

$Utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss") + "Z"
"===== $Utc (UTC) =====" | Out-File -Append $Log -Encoding utf8
# --frozen --no-sync: never re-resolve or re-install dependencies in production (uv.lock is the law)
& $Uv run --frozen --no-sync engine live step *>&1 | Out-File -Append $Log -Encoding utf8
$rc = $LASTEXITCODE
"===== exit $rc =====" | Out-File -Append $Log -Encoding utf8
exit $rc
