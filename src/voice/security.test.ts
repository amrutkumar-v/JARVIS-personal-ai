import { describe, expect, it } from 'vitest'
import indexRaw from './index.ts?raw'
import normalizationRaw from './normalization.ts?raw'
import typesRaw from './types.ts?raw'
import wakeWordProviderRaw from './wakeWordProvider.ts?raw'
import speechProviderRaw from './speechProvider.ts?raw'
import ttsProviderRaw from './ttsProvider.ts?raw'
import voiceManagerRaw from './voiceManager.ts?raw'
import testingRaw from './testing.ts?raw'

/**
 * Phase 1.6 — static security/boundary scan of the production voice module.
 *
 * The voice layer is an INPUT INTERFACE, not an agent:
 *   - it NEVER executes shell commands or Windows tooling
 *   - it NEVER captures or persists raw audio (the platform recognizer owns
 *     the mic; our code only forwards final TEXT transcripts)
 *   - wake detection is DETERMINISTIC — no LLM is ever involved
 *   - it NEVER reaches into the Agent Core directly (injected callbacks only)
 *   - test fakes are quarantined behind src/voice/testing.ts and are never
 *     re-exported from the public index
 */

const PROD_FILES: Array<[name: string, src: string]> = [
  ['index.ts', indexRaw],
  ['normalization.ts', normalizationRaw],
  ['types.ts', typesRaw],
  ['wakeWordProvider.ts', wakeWordProviderRaw],
  ['speechProvider.ts', speechProviderRaw],
  ['ttsProvider.ts', ttsProviderRaw],
  ['voiceManager.ts', voiceManagerRaw],
]

function read(name: string): string {
  const hit = PROD_FILES.find(([n]) => n === name)
  if (!hit) throw new Error(`unknown voice source: ${name}`)
  return hit[1]
}

describe('Phase 1.6 — voice module boundary scan', () => {
  it('never executes shell commands or Windows tooling', () => {
    for (const [file, src] of PROD_FILES) {
      expect(src, file).not.toMatch(/child_process|\bexecSync\b|\bspawn(Sync)?\b|\bpowershell\b|\bcmd(\.exe)?\b/i)
    }
  })

  it('never captures or persists raw microphone audio', () => {
    for (const [file, src] of PROD_FILES) {
      expect(src, file).not.toMatch(/MediaRecorder|getDisplayMedia|AudioContext|navigator\.mediaDevices/i)
      expect(src, file).not.toMatch(/localStorage|indexedDB/i)
    }
  })

  it('keeps wake detection deterministic — no LLM call anywhere in the module', () => {
    for (const [file, src] of PROD_FILES) {
      expect(src, file).not.toMatch(/generate\(|chatCompletion|\.chat\(|openai|anthropic|completions/i)
    }
    // The actual recognition surface is the platform Web Speech API, not a model.
    expect(read('wakeWordProvider.ts')).not.toMatch(/model/i)
  })

  it('never imports or reaches into the Agent Core', () => {
    for (const [file, src] of PROD_FILES) {
      expect(src, file).not.toMatch(/from ['"](\.\.\/)+engine(\/|')/)
      expect(src, file).not.toMatch(/\bprocess\(/u)
    }
  })

  it('quarantines test fakes — index never re-exports them and every fake is marked', () => {
    const index = read('index.ts')
    expect(index).not.toContain("from './testing'")
    expect(index).not.toMatch(/Fake/)

    expect((testingRaw.match(/testsOnly = true/g) ?? []).length).toBe(3)
  })

  it('exposes the honest capability seam for the UI', () => {
    expect(read('ttsProvider.ts')).toMatch('capabilities()')
    expect(read('speechProvider.ts')).toMatch('capabilities()')
    expect(read('wakeWordProvider.ts')).toMatch('capabilities()')
  })
})