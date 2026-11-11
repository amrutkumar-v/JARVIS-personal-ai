import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NATIVE_RPC_METHODS } from './nativeMethods.js'

describe('backend native RPC boundary', () => {
  it('matches the native agent method allowlist exactly and excludes shell execution', async () => {
    const protocol = await readFile(resolve(process.cwd(), 'native/src/protocol.ts'), 'utf8')
    const listBody = protocol.match(/export const NATIVE_METHODS:\s*readonly NativeMethod\[\]\s*=\s*\[([\s\S]*?)\]/)?.[1]
    const nativeMethods = listBody?.match(/'[^']+'/g)?.map((method) => method.slice(1, -1))
    expect(nativeMethods).toBeDefined()
    expect(NATIVE_RPC_METHODS).toEqual(nativeMethods)
    expect(NATIVE_RPC_METHODS).toHaveLength(48)
    expect(NATIVE_RPC_METHODS).not.toContain('exec')
    expect(NATIVE_RPC_METHODS).not.toContain('shell')
    expect(NATIVE_RPC_METHODS).not.toContain('cmd')
    expect(NATIVE_RPC_METHODS).not.toContain('powershell')
    expect(NATIVE_RPC_METHODS).not.toContain('command.run')
  })
})
