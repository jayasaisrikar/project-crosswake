# Hourly paper step for Windows Task Scheduler. Appends output to logs\live.log.
$App = Split-Path -Parent $PSScriptRoot
Set-Location $App
New-Item -ItemType Directory -Force logs | Out-Null
"===== $(Get-Date -Format u) =====" | Out-File -Append logs\live.log -Encoding utf8
& "C:\Users\kilar\AppData\Local\hermes\bin\uv.exe" run engine live step *>&1 | Out-File -Append logs\live.log -Encoding utf8
