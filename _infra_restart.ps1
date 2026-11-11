$ErrorActionPreference = 'Continue'
$infra = 'D:\JARVIS\_infra'
New-Item -ItemType Directory -Path $infra -Force | Out-Null
$rep = Join-Path $infra 'restart.report.txt'
"=== infra restart $(Get-Date -Format o) ===" | Set-Content -LiteralPath $rep -Encoding UTF8

function Start-DetachedNode($name, $scriptPath) {
  $out = Join-Path $infra "$name.out.log"
  $err = Join-Path $infra "$name.err.log"
  Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'C:\Program Files\nodejs\node.exe'
  if(-not (Test-Path -LiteralPath $psi.FileName)) { $psi.FileName = (Get-Command node.exe -ErrorAction Stop).Source }
  $psi.Arguments = "`"$scriptPath`""
  $psi.WorkingDirectory = 'D:\JARVIS'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardInput = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  Start-Sleep -Milliseconds 2500
  $state = "RUNNING" ; if($p.HasExited) { $state = "EXITED($($p.ExitCode))" }
  Add-Content -LiteralPath $rep -Value "$name PID=$($p.Id) state=$state"
  return $p
}

$agent = Start-DetachedNode 'nativeAgent' 'D:\JARVIS\native\dist\agentMain.js'
$backend = Start-DetachedNode 'backend' 'D:\JARVIS\server\dist\index.js'
'INFRA-STARTED'
Start-Sleep -Seconds 4
'--- restart report ---'
Get-Content -Raw -LiteralPath $rep
'--- port listeners ---'
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 8765,8766,8787,3000 } | Select-Object LocalAddress,LocalPort,OwningProcess | Sort-Object LocalPort -Unique | Format-Table -AutoSize
'--- health probes ---'
foreach($u in @('http://127.0.0.1:8765/health','http://127.0.0.1:8787/health','http://127.0.0.1:3000')) {
  try { $r=Invoke-WebRequest -Uri $u -TimeoutSec 4 -UseBasicParsing; "OK $u -> $($r.StatusCode)" }
  catch { "FAIL $u -> $($_.Exception.Message)" }
}
'--- log tails (agent.err / backend.err) ---'
Get-Content -LiteralPath (Join-Path $infra 'nativeAgent.err.log') -Tail 15 -ErrorAction SilentlyContinue
'--- backend.err ---'
Get-Content -LiteralPath (Join-Path $infra 'backend.err.log') -Tail 15 -ErrorAction SilentlyContinue