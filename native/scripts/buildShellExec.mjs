// JARVIS Native Windows Agent — build-time compiler for the ShellExec helper.
//
// Finds a .NET Framework csc.exe (Framework64 first, then Framework), compiles
// helpers/ShellExec/ShellExec.cs into dist/shellexec/ShellExec.exe. When no
// csc.exe is available the helper is skipped and a clear message is printed —
// the agent then reports shell-route launches as unlaunchable (honest).
//
// Locate csc via the CSC_PATH env var or the standard Framework install paths.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'helpers', 'ShellExec', 'ShellExec.cs')
const outDir = join(root, 'dist', 'shellexec')
const outExe = join(outDir, 'ShellExec.exe')

const candidates = [
  process.env.CSC_PATH,
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework64\\v2.0.50727\\csc.exe',
].filter((c) => typeof c === 'string' && c.length > 0)

const csc = candidates.find((c) => existsSync(c))
if (!csc) {
  console.error('ShellExec build skipped: csc.exe not found. Set CSC_PATH or install .NET Framework to enable packaged-app shell launches.')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
execFileSync(csc, ['/nologo', '/target:winexe', '/optimize', `/out:${outExe}`, source], { stdio: 'inherit' })
console.log(`ShellExec.exe built -> ${outExe}`)