$ErrorActionPreference = 'Continue'
$log = 'D:\JARVIS\_infra\restart.log'
New-Item -ItemType Directory -Path 'D:\JARVIS\_infra' -Force -ErrorAction SilentlyContinue | Out-Null
'=== infra restart: $(Get-Date -Format o) ===' | Add-Content -LiteralPath $log

function StartDetached($name, $file, $args, $wd, $logSuffix) {
  $out = "D:\JARVIS\_infra\$name$logSuffix.out.log"
  $err = "D:\JARVIS\_infra\$name$logSuffix.err.log"
  Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file
  $psi.Arguments = $args
  $psi.WorkingDirectory = $wd
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardInput = $false
  if ($out -eq $err) { $err = "$err-2" }
  $p = [System.Diagnostics.Process]::Start($psi)
  Start-Sleep -Milliseconds 1500
  "$name PID=$($p.Id) exited=$($p.HasExited)" | Add-Content -LiteralPath $log
  $env:("JARVIS_PID_" + $name) = [string]$p.Id
  return $p
}

$agent = StartDetached 'agent' 'D:\JARVIS\node_modules\typescript\bin\tsc' '' 'D:\JARVIS' 'a'
'AGENT-STARTED'
Start-Sleep -Seconds 3
'PATH-ERR-CHECK'
if(Test-Path -LiteralPath 'D:\JARVIS\native\dist\agentMain.js'){ 'agentMain-built=True' } else { 'agentMain-built=False' }