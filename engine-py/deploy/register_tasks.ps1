# Registers the two LOCAL scheduled tasks (paper step at :02, health at :20). NOT run automatically:
# review it, then run it yourself from an elevated PowerShell. See docs/RUNBOOK.md section 2.
#
#   powershell -ExecutionPolicy Bypass -File C:\crypto-prod\deploy\register_tasks.ps1 -App C:\crypto-prod
#
# -RunWhetherLoggedOn registers the tasks with a stored password (LogonType Password) so they run
# when nobody is logged on; it prompts for the account password. Without it the tasks use
# LogonType Interactive (only while the user is logged on), which is the current behaviour.
# ExecutionTimeLimit is 30 min, above the engine's own 10-min fetch deadline (feed.step_deadline_s).
param(
    [Parameter(Mandatory = $true)][string]$App,
    [string]$User = "$env:USERDOMAIN\$env:USERNAME",
    [switch]$RunWhetherLoggedOn,
    [switch]$HealthSend
)
$ErrorActionPreference = "Stop"
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew -StartWhenAvailable -WakeToRun -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
$start = (Get-Date).Date
$stepTrig = New-ScheduledTaskTrigger -Once -At $start.AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1)
$healthTrig = New-ScheduledTaskTrigger -Once -At $start.AddMinutes(20) -RepetitionInterval (New-TimeSpan -Hours 1)
$stepAct = New-ScheduledTaskAction -Execute $ps -WorkingDirectory $App `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$App\deploy\run_step.ps1`""
$hArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$App\deploy\run_health.ps1`""
if ($HealthSend) { $hArgs += " -Send" }
$healthAct = New-ScheduledTaskAction -Execute $ps -WorkingDirectory $App -Argument $hArgs

if ($RunWhetherLoggedOn) {
    $cred = Get-Credential -UserName $User -Message "Password for the scheduled tasks (stored by Task Scheduler)"
    $pw = $cred.GetNetworkCredential().Password
    Register-ScheduledTask -TaskName "PaperTradingStep" -Action $stepAct -Trigger $stepTrig -Settings $settings `
        -User $User -Password $pw -RunLevel Limited -Force | Out-Null
    Register-ScheduledTask -TaskName "PaperTradingHealth" -Action $healthAct -Trigger $healthTrig -Settings $settings `
        -User $User -Password $pw -RunLevel Limited -Force | Out-Null
} else {
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName "PaperTradingStep" -Action $stepAct -Trigger $stepTrig -Settings $settings `
        -Principal $principal -Force | Out-Null
    Register-ScheduledTask -TaskName "PaperTradingHealth" -Action $healthAct -Trigger $healthTrig -Settings $settings `
        -Principal $principal -Force | Out-Null
}
Get-ScheduledTask -TaskName "PaperTrading*" | Format-Table TaskName, State
