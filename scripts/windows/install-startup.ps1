# Installs the JARVIS Core backend autostart scheduled task (Phase 2.8).
# Runs the hidden VBS launcher at LOGON for the current user only.
param(
  [string]$TaskName = "JARVIS Core Backend"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $scriptDir "start-backend-hidden.vbs"

if (-not (Test-Path -LiteralPath $vbs)) {
  throw "Launcher not found: $vbs"
}

$wscript = "$env:WINDIR\System32\wscript.exe"
$action = New-ScheduledTaskAction -Execute $wscript -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "Starts the JARVIS Core backend (hidden) at logon." `
  -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName' (runs at logon, hidden)."
Write-Host "To start the backend right now instead:  npm run backend"