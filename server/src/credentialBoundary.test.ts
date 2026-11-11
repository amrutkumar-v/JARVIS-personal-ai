import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('browser credential boundary', () => {
  it('does not read server bearer credentials from Vite environment variables', async () => {
    const nativeConfig = await readFile(resolve(process.cwd(), 'src/native/nativeAgentEnv.ts'), 'utf8')
    const backendConfig = await readFile(resolve(process.cwd(), 'src/backend/config.ts'), 'utf8')
    const browserConfig = `${nativeConfig}\n${backendConfig}`

    expect(browserConfig).not.toMatch(/VITE_NATIVE_AGENT_TOKEN|VITE_JARVIS_BACKEND_TOKEN/)
    expect(browserConfig).not.toMatch(/JARVIS_NATIVE_TOKEN|JARVIS_BACKEND_NATIVE_TOKEN|JARVIS_BACKEND_TOKEN/)
  })
})
