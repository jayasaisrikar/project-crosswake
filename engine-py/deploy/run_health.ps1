# Scheduled health check (e.g. hourly at :20) for Windows Task Scheduler. Local only.
# `engine health --alert` writes logs\health.json and, on FAIL, appends to logs\alerts.log.
# Add -Send to also post a FAIL to Telegram, which only happens if TELEGRAM_BOT_TOKEN and
# TELEGRAM_CHAT_ID are already set for the task's user. No other remote service is contacted.
param(
    [string]$Uv = $(if ($env:ENGINE_UV) { $env:ENGINE_UV } else { "C:\Users\kilar\AppData\Local\hermes\bin\uv.exe" }),
    [switch]$Send
)
$ErrorActionPreference = "Continue"
$App = Split-Path -Parent $PSScriptRoot
Set-Location $App
New-Item -ItemType Directory -Force logs | Out-Null
$Log = Join-Path $App "logs\health.log"
if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 5MB)) { Move-Item -Force $Log "$Log.1" }
$Utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss") + "Z"
"===== $Utc (UTC) =====" | Out-File -Append $Log -Encoding utf8
$extra = @()
if ($Send) { $extra += "--send" }
& $Uv run --frozen --no-sync engine health --alert @extra *>&1 | Out-File -Append $Log -Encoding utf8
$rc = $LASTEXITCODE
if ($rc -ne 0) {
    # visible locally even if Python could not start at all (e.g. broken checkout)
    "[$Utc] engine health exit $rc - see logs\health.log" | Out-File -Append (Join-Path $App "logs\alerts.log") -Encoding utf8
}
exit $rc
