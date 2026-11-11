$ErrorActionPreference = 'Continue'
# ---------- 1) recreate threads-pool vitest config (children-free) ----------
$cfg = 'D:\JARVIS\_vtFinal.config.ts'
@'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    root: 'D:/JARVIS',
    pool: 'threads',
    poolOptions: { threads: { singleThread: true, maxThreads: 1, minThreads: 1, useAtomics: false, isolate: false } },
    reporters: ['default'],
    outputFile: { 'json': 'D:/JARVIS/_vtFinal-result.json' },
    watch: false
  }
})
'@ | Set-Content -LiteralPath $cfg -Encoding UTF8
'CFG-WROTE=' + (Test-Path -LiteralPath $cfg)

# ---------- 2) focused vitest run (no child processes) ----------
$out='D:\JARVIS\_vtFinal-out.txt'; $err='D:\JARVIS\_vtFinal-err.txt'
Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath 'D:\JARVIS\_vtFinal-result.json' -Force -ErrorAction SilentlyContinue
$ok = $true
& 'C:\Program Files\nodejs\node.exe' 'D:\JARVIS\node_modules\vitest\dist\cli.js' run --config $cfg 'native/src/appBackend.test.ts' 1>$out 2>$err
$vtExit = $LASTEXITCODE
'VITEST-EXIT=' + $vtExit
'--- stdout: Test Files / Tests totals ---'
Get-Content -LiteralPath $out | Select-String -Pattern 'Test Files|Tests |appBackend|✓|×|passed|failed' | Select-Object -Last 10
'--- stderr tail ---'
(Get-Content -LiteralPath $err | Select-Object -Last 6)
'--- JSON result ---'
if(Test-Path -LiteralPath 'D:\JARVIS\_vtFinal-result.json'){
  $j = Get-Content -Raw -LiteralPath 'D:\JARVIS\_vtFinal-result.json' | ConvertFrom-Json
  'SUCCESS=' + $j.success
  'PASSED=' + $j.numPassedTests
  'FAILED=' + $j.numFailedTests
  'TOTAL=' + $j.numTotalTests
} else { 'NO-JSON' }

# ---------- 3) restart real infra (detached) ----------
$infra = 'D:\JARVIS\_infra'
New-Item -ItemType Directory -Path $infra -Force | Out-Null
function Start-NodeDetached($name, $entryAbs, $workingDir) {
  $o = Join-Path $infra "$name.out.log"
  $e = Join-Path $infra "$name.err.log"
  Remove-Item -LiteralPath $o,$e -Force -ErrorAction SilentlyContinue
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'C:\Program Files\nodejs\node.exe'
  if(-not (Test-Path -LiteralPath $psi.FileName)) { $psi.FileName = (Get-Command node.exe -ErrorAction Stop).Source }
  $psi.Arguments = '"' + $entryAbs + '"'
  $psi.WorkingDirectory = $workingDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  Start-Sleep -Milliseconds 1200
  if($p.HasExited){ "[$name] EARLY-EXIT=$($p.ExitCode)" } else { "[$name] PID=$($p.Id)" }
}
# native agent (port 8765)
Start-NodeDetached 'nativeAgent' 'D:\JARVIS\native\dist\agentMain.js' 'D:\JARVIS'
# backend (port 8787)
Start-NodeDetached 'backend' 'D:\JARVIS\server\dist\index.js' 'D:\JARVIS'
Start-Sleep -Seconds 3
'--- listeners ---'
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 8765,8766,8787,3000 } | Select-Object LocalPort,OwningProcess | Sort-Object LocalPort -Unique | Format-Table -AutoSize
'--- health probes ---'
foreach($u in @('http://127.0.0.1:8765/health','http://127.0.0.1:8787/health')){
  try { $r=Invoke-WebRequest -Uri $u -TimeoutSec 4 -UseBasicParsing; "OK $u -> $($r.StatusCode)" }
  catch { "FAIL $u -> $($_.Exception.Message)" }
}
'--- agent/backend log tails ---'
Get-Content -LiteralPath (Join-Path $infra 'nativeAgent.err.log') -Tail 10 -ErrorAction SilentlyContinue
Get-Content -LiteralPath (Join-Path $infra 'backend.err.log') -Tail 10 -ErrorAction SilentlyContinue