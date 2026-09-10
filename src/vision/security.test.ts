import { describe, expect, it } from 'vitest'
import budgetRaw from './budget.ts?raw'
import boundsRaw from './bounds.ts?raw'
import coordsRaw from './coords.ts?raw'
import indexRaw from './index.ts?raw'
import limitsRaw from './limits.ts?raw'
import localizeRaw from './localize.ts?raw'
import providerRaw from './provider.ts?raw'
import remoteProviderRaw from './remoteProvider.ts?raw'
import sanitizeRaw from './sanitize.ts?raw'
import stalenessRaw from './staleness.ts?raw'
import testingRaw from './testing.ts?raw'
import typesRaw from './types.ts?raw'
import verificationRaw from './verification.ts?raw'
import visualComputerToolsRaw from './VisualComputerTools.ts?raw'

/**
 * Phase 1.7/1.8 — static security/boundary scan of the visual-understanding
 * module.
 *
 * The visual layer is a COMPUTER-CONTROL seam (EYES BEFORE HANDS), so it must
 * be the MOST bounded surface in the codebase:
 *   - it NEVER executes shell commands / Windows tooling
 *   - it NEVER captures or persists raw screenshots or pixel data
 *     (the observation provider owns capture; the vision module only READS
 *     the bounded element list a provider chooses to hand back)
 *   - it calls an AI model ONLY through the single real provider adapter
 *     (remoteProvider.ts — the ONE network call in the whole module); every
 *     other file delegates analysis to an injected provider
 *   - it NEVER reaches into the Agent Core (injected providers only)
 *   - it NEVER writes user text to storage — sanitize redacts typed text
 *     before it can reach the trace
 *   - screenshot bytes are TRANSIT ONLY (data URI in the request body of the
 *     configured endpoint) and the API key exists ONLY in the Authorization
 *     header — never logged, never persisted
 *   - test fakes are quarantined behind src/vision/testing.ts and are never
 *     re-exported from the public index
 */

const PROD_FILES: Array<[name: string, src: string]> = [
  ['index.ts', indexRaw],
  ['types.ts', typesRaw],
  ['limits.ts', limitsRaw],
  ['provider.ts', providerRaw],
  ['remoteProvider.ts', remoteProviderRaw],
  ['bounds.ts', boundsRaw],
  ['coords.ts', coordsRaw],
  ['localize.ts', localizeRaw],
  ['verification.ts', verificationRaw],
  ['sanitize.ts', sanitizeRaw],
  ['budget.ts', budgetRaw],
  ['staleness.ts', stalenessRaw],
  ['VisualComputerTools.ts', visualComputerToolsRaw],
]

const NON_PROVIDER_FILES = PROD_FILES.filter(([name]) => name !== 'remoteProvider.ts')

describe('Phase 1.8 — visual module boundary scan', () => {
  it('never executes shell commands or Windows tooling', () => {
    for (const [file, src] of PROD_FILES) {
      expect(src, file).not.toMatch(/child_process|\bexecSync\b|\bspawn(Sync)?\b|\bpowershell\b|\bcmd(\.exe)?\b/i)
    }
  })

  it('never captures or persists raw pixels on its own', () => {
    for (const [file, src] of PROD_FILES) {
      // No screen-capture APIs, no camera, no media devices.
      expect(src, file).not.toMatch(/CanvasCapture|getDisplayMedia|navigator\.mediaDevices|SendInput|GetDIBits/i)
      // No persistence of visual payloads and no local secret storage.
      expect(src, file).not.toMatch(/localStorage|indexedDB/i)
    }
  })

  it('only remoteProvider.ts may call an AI model — it is the ONE real provider adapter', () => {
    // Every other module delegates analysis to the injected provider.
    for (const [file, src] of NON_PROVIDER_FILES) {
      expect(src, file).not.toMatch(/\.generate\(|chatCompletion|\.chat\(|openai|anthropic|completions|\.fetch\(/i)
    }
    // The real provider is authoritative: it performs exactly one HTTP call
    // to the configured OpenAI-compatible /chat/completions surface.
    expect(remoteProviderRaw).toMatch(/chat\/completions/)
    expect(remoteProviderRaw).toMatch(/fetchImpl\(/)
  })

  it('the real provider builds its endpoint from CONFIG — never a hard-coded host', () => {
    // The only URL material in the module is the configured base URL; the
    // path is a fixed suffix (or already-present endpoint), so a misdeploy can
    // never silently send pixels to an arbitrary host baked into the bundle.
    expect(remoteProviderRaw).toMatch(/baseUrl/)
    expect(remoteProviderRaw).toMatch(/import\.meta\.env/)
    expect(remoteProviderRaw).not.toMatch(/https?:\/\/[a-z0-9.-]+\.(com|ai|dev|net)/i)
  })

  it('screenshot bytes travel ONLY as a data URI inside the request body', () => {
    // The base64 pixels appear exactly in the image_url payload; they are
    // never written to files, databases, or the console.
    expect(remoteProviderRaw).toMatch(/data:image\/png;base64/)
    expect(remoteProviderRaw).toMatch(/image_url/)
    expect(remoteProviderRaw).not.toMatch(/console\.(log|error|warn)/)
    expect(remoteProviderRaw).not.toMatch(/writeFile|appendFile|createWriteStream|localStorage|indexedDB/i)
  })

  it('the API key exists ONLY in the Authorization header', () => {
    expect(remoteProviderRaw).toMatch(/Authorization/)
    expect(remoteProviderRaw).toMatch(/Bearer/)
    expect(remoteProviderRaw).not.toMatch(/key.*(console|log|localStorage|indexedDB|sessionStorage)/i)
  })

  it('returns an honest UNAVAILABLE state when not configured', () => {
    expect(remoteProviderRaw).toMatch(/configured/)
    expect(remoteProviderRaw).toMatch(/capabilities\(\)/)
  })

  it('never reaches into the Agent Core (only the shared tool-contract type)', () => {
    for (const [file, src] of PROD_FILES) {
      // No import from the core engine module or its runtime internals.
      expect(src, file).not.toMatch(/from ['"](\.\.\/)+engine['"]/)
      expect(src, file).not.toMatch(/from ['"](\.\.\/)+engine\/(?!provider)['"]/)
      expect(src, file).not.toMatch(/\bprocess\(/u)
    }
    // The ONE permitted shared import is the type-only tool-contract schema.
    expect(visualComputerToolsRaw).toMatch("from '../engine/provider'")
  })

  it('always redacts typed text via sanitize — no raw text in payloads after the wall', () => {
    expect(sanitizeRaw).toContain('visualType')
    expect(sanitizeRaw).toMatch(/redacted/)
    // The tools module never writes a raw `text` field into a trace payload.
    expect(visualComputerToolsRaw).not.toMatch(/text:\s*params\.text/)
  })

  it('enforces finite, bounded geometry — no blind coordinate scaling, no unbounded arrays', () => {
    expect(coordsRaw).toMatch(/matches exactly|does not match|client area/)
    expect(limitsRaw).toMatch('MAX_VISUAL_ELEMENTS')
    expect(limitsRaw).toMatch('MAX_TARGET_CANDIDATES')
    expect(boundsRaw).toMatch(/isFinite/)
    expect(remoteProviderRaw).toMatch(/MAX_VISUAL_ELEMENTS/)
  })

  it('verification never lies — refuted/unverified are distinct and unverified is not completion', () => {
    expect(verificationRaw).toMatch(/refuted/)
    expect(verificationRaw).toMatch(/unverified/)
  })

  it('offers an honest capability seam for the UI', () => {
    expect(providerRaw).toMatch('capabilities()')
  })

  it('quarantines test fakes — index never re-exports them and every fake is marked', () => {
    const index = read('index.ts')
    expect(index).not.toContain("from './testing'")
    expect(index).not.toMatch(/Fake/)

    // Exactly one tests-only fake lives in testing.ts and is clearly marked.
    expect((testingRaw.match(/testsOnly = true/g) ?? []).length).toBe(1)
  })
})

describe('Phase 1.9 — model-output boundary + stale-observation scans', () => {
  it('the staleness module itself stays inert: pure comparisons only', () => {
    // It must be importable into the standard PROD scans (already in
    // PROD_FILES) — no I/O, no injection, no engine reach.
    expect(stalenessRaw).toMatch(/classifyStaleness/)
    expect(stalenessRaw).not.toMatch(/fetch|child_process|FileSystem|\.click\(|moveMouse|keyPress/i)
  })

  it('THE decisive model-output rail — vision tools accept NO raw coordinates or commands', () => {
    // Screenshot analysis is UNTRUSTED data. The only way vision output can
    // influence the desktop is a LABEL (target) resolved against an inventory:
    // there is NO x/y/command/shell/key/shortcut parameter anywhere in the
    // visual tool schemas, so a corrupt/malicious model result can never name
    // an arbitrary surface point, key chord or hidden tool.
    for (const paramName of ['x', 'y', 'coords', 'command', 'shell', 'key', 'hotkey', 'shortcut']) {
      expect(visualComputerToolsRaw, paramName).not.toMatch(new RegExp(`'${paramName}':`))
      expect(visualComputerToolsRaw, paramName).not.toMatch(new RegExp(`'${paramName}',`))
    }
  })

  it('vision drives EXACTLY ONE click + bounded text — never raw mouse/key verbs', () => {
    // The eyes may ask the hands for exactly the two verbs the design allows.
    expect(visualComputerToolsRaw).toMatch(/opts\.desktop\.click\(/)
    expect(visualComputerToolsRaw).toMatch(/opts\.desktop\.typeText\(/)
    // And nothing else from the desktop surface (no free-form cursor or chord).
    expect(visualComputerToolsRaw).not.toMatch(/(moveMouse|doubleClick|rightClick|keyPress|hotkey|keyChord|scroll)\(/)
  })

  it('every visual injection passes the stale-observation gate before acting', () => {
    expect(visualComputerToolsRaw).toMatch(/classifyStaleness/)
    expect(visualComputerToolsRaw).toMatch(/'stale_observation'/)
    expect(visualComputerToolsRaw).toMatch(/Nothing was injected/)
  })
})

function read(name: string): string {
  const hit = PROD_FILES.find(([n]) => n === name)
  if (!hit) throw new Error(`unknown vision source: ${name}`)
  return hit[1]
}