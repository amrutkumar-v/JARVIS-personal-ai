import { describe, expect, it } from 'vitest'
import appBackendRaw from '../../native/src/appBackend.ts?raw'
import buildShellExecRaw from '../../native/scripts/buildShellExec.mjs?raw'
import nativePkgRaw from '../../native/package.json?raw'
import pkgRaw from '../../package.json?raw'

/**
 * Phase 1 — build wiring for the native Windows agent.
 *
 * The `aumid` launch mechanism (Notepad) and the `uri` mechanism (Settings)
 * run a small compiled helper, `native/dist/shellexec/ShellExec.exe`, which is
 * the fail-closed gateway in front of `ShellExecute`.
 *
 * That helper is produced by `native/scripts/buildShellExec.mjs`. The root
 * `native:build` script used to run `tsc` only, so on any clean checkout or CI
 * build the helper was simply absent — and every packaged-app launch failed at
 * spawn time with ENOENT while every line of code still looked correct.
 *
 * These assertions pin the wiring so the two cannot drift apart again.
 */
const pkg = JSON.parse(pkgRaw) as { scripts: Record<string, string> }
const nativePkg = JSON.parse(nativePkgRaw) as { scripts: Record<string, string> }

describe('Phase 1 — native build wiring (aumid/uri launches need ShellExec.exe)', () => {
  it('root native:build compiles TypeScript AND builds the ShellExec helper', () => {
    const script = pkg.scripts['native:build']
    expect(script).toBeDefined()
    expect(script).toContain('tsc -p native/tsconfig.build.json')
    // Without this step the helper is missing and aumid/uri launches break.
    expect(script).toContain('buildShellExec.mjs')
  })

  it('uses the same helper build step as native/package.json build', () => {
    expect(pkg.scripts['native:build']).toContain('buildShellExec.mjs')
    expect(nativePkg.scripts.build).toContain('buildShellExec.mjs')
  })

  it('the helper build step is fail-soft and honest, never silently missing', () => {
    // When csc.exe is unavailable the operator must be told, not left guessing.
    expect(buildShellExecRaw).toMatch(/csc\.exe not found/i)
    // The helper is written exactly where the runtime resolves it.
    expect(buildShellExecRaw).toMatch(/'shellexec'/)
    expect(buildShellExecRaw).toMatch(/'ShellExec\.exe'/)
  })

  it('the runtime resolves the helper from the compiled dist location', () => {
    expect(appBackendRaw).toMatch(/'shellexec',\s*'ShellExec\.exe'/)
  })

  it('process launch never goes through a shell interpreter', () => {
    // The structural guarantee that no shell host can interpose a user string.
    expect(appBackendRaw).toMatch(/shell:\s*false/)
  })
})