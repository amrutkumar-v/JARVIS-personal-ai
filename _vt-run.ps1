$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath 'D:\JARVIS'
$outLog = 'D:\JARVIS\_vt-native-out.txt'
$errLog = 'D:\JARVIS\_vt-native-err.txt'
Remove-Item -LiteralPath $outLog -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $errLog -ErrorAction SilentlyContinue

$ps = New-Object System.Diagnostics.ProcessStartInfo
$ps.FileName = 'D:\JARVIS\node_modules\typescript\bin\tsc'
# nested helper: use cmd to invoke the .cmd shim detached without conPTY
$ps.FileName = 'D:\JARVIS\node_modules\.bin\vitest.cmd'
$ps.Arguments = 'run native/src/appBackend.test.ts'
$ps.WorkingDirectory = 'D:\JARVIS'
$ps.UseShellExecute = $false
$ps.CreateNoWindow = $true
$ps.RedirectStandardOutput = $true
$ps.RedirectStandardError = $true
$ps.RedirectStandardInput = $false

$p = [System.Diagnostics.Process]::Start($ps)
$so = $p.StandardOutput.ReadToEndAsync()
$se = $p.StandardError.ReadToEndAsync()
if (-not $p.WaitForExit(240000)) { $p.Kill(); 'TIMEOUT-KILL' }
$out = $so.Result
$err = $se.Result
'EXIT=' + $p.ExitCode
Set-Content -LiteralPath $outLog -Value $out -Encoding UTF8
Set-Content -LiteralPath $errLog -Value $err -Encoding UTF8
'--- STDOUT tail ---'
($out -split "`n") | Where-Object { $_ -match '\S' } | Select-Object -Last 40
'--- STDERR tail ---'
($err -split "`n") | Where-Object { $_ -match '\S' } | Select-Object -Last 20