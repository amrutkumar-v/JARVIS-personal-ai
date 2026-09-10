# Removes the JARVIS Core backend autostart scheduled task (Phase 2.8).
param(
  [string]$TaskName = "JARVIS Core Backend"
)

$ErrorActionPreference = "Stop"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
  Write-Host "No scheduled task named '$TaskName' — nothing to remove."
  exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed scheduled task '$TaskName'. Backend no longer autostarts at logon."