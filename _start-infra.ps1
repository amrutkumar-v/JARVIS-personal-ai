$ErrorActionPreference = 'Stop'
$logDir = 'D:\JARVIS\_infra'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Start-Agent($name, $nodeArgs) {
  $out = Join-Path $logDir "$name-out.txt"
  $err = Join-Path $logDir "$name-err.txt"
  Remove-Item -LiteralPath $out -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $err -ErrorAction SilentlyContinue
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'node.exe'
  $psi.Arguments = $nodeArgs
  $psi.WorkingDirectory = 'D:\JARVIS'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardInput = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  Start-Sleep -Milliseconds 2000
  if ($p.HasExited) {
    "$name EARLY-EXIT=$($p.ExitCode)"
    '-- stderr --'
    $e = $p.StandardError.ReadToEnd()
    $e
  } else {
    "$name UP PID=$($p.Id)"
    $script:agentPids[$name] = $p.Id
  }
}

$script:agentPids = @{}
Start-Agent 'nativeAgent' 'native/dist/agentMain.js'
Start-Agent 'backend' 'server/dist/index.js'

'PID-MAP: ' + ($agentPids | ConvertTo-Json -Compress)
$pidFile = 'D:\JARVIS\_infra\pids.json'
($agentPids | ConvertTo-Json -Compress) | Set-Content -LiteralPath $pidFile -Encoding UTF8
'PIDFILE-WRITTEN'
