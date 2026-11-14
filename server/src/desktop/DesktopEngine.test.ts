import { describe, expect, it, vi } from 'vitest'
import { DesktopEngine, verifyDesktopResult } from './DesktopEngine.js'

describe('DesktopEngine (Phase 7 / UIA & Desktop Automation)', () => {
  it('dispatches UIA actions to native RPC correctly', async () => {
    const engine = new DesktopEngine({
      nativeUrl: 'http://127.0.0.1:8765',
      nativeToken: 'test-token',
    })

    const rpcMock = vi.fn().mockResolvedValue({
      kind: 'ok',
      envelope: {
        result: {
          ok: true,
          action: 'invoke',
          target: 'Calculator',
          message: 'Control invoked successfully',
        },
      },
    })

    // Inject mock for callNativeRpc internal call
    ;(engine as any).callNativeRpc = async (method: string, params: Record<string, unknown>) => {
      const res = await rpcMock(method, params)
      return {
        ok: true,
        message: `Native RPC "${method}" executed successfully.`,
        data: res.envelope.result,
      }
    }

    const resInspect = await engine.execute('uia.inspect', { target: 'Calculator', maxDepth: 2 })
    expect(resInspect.ok).toBe(true)
    expect(rpcMock).toHaveBeenCalledWith('uia.inspect', { target: 'Calculator', maxDepth: 2 })

    const resInvoke = await engine.execute('uia.invoke', { target: 'Calculator', automationId: 'num5Button' })
    expect(resInvoke.ok).toBe(true)
    expect(rpcMock).toHaveBeenCalledWith('uia.invoke', { target: 'Calculator', automationId: 'num5Button' })

    const resSetValue = await engine.execute('uia.setValue', { target: 'Calculator', automationId: 'Display', value: '100' })
    expect(resSetValue.ok).toBe(true)
    expect(rpcMock).toHaveBeenCalledWith('uia.setValue', { target: 'Calculator', automationId: 'Display', value: '100' })

    const resToggle = await engine.execute('uia.toggle', { target: 'Calculator', automationId: 'KeepOnTopToggle' })
    expect(resToggle.ok).toBe(true)
    expect(rpcMock).toHaveBeenCalledWith('uia.toggle', { target: 'Calculator', automationId: 'KeepOnTopToggle' })
  })

  it('verifies desktop and browser results accurately', () => {
    // Navigation verification
    expect(verifyDesktopResult('browser.navigate', { ok: true, message: 'Done', data: { verified: true } }).passed).toBe(true)
    expect(verifyDesktopResult('browser.navigate', { ok: true, message: 'Done', data: { verified: false } }).passed).toBe(false)

    // Page read verification
    expect(verifyDesktopResult('browser.readPage', { ok: true, message: 'Done', data: { text: 'Heading' } }).passed).toBe(true)
    expect(verifyDesktopResult('browser.readPage', { ok: true, message: 'Done', data: {} }).passed).toBe(false)

    // Screenshot verification
    expect(verifyDesktopResult('desktop.screenshot', { ok: true, message: 'Done', data: { bytes: 'data:image/png' } }).passed).toBe(true)
    expect(verifyDesktopResult('desktop.screenshot', { ok: true, message: 'Done', data: {} }).passed).toBe(false)

    // Failed action
    expect(verifyDesktopResult('app.launch', { ok: false, message: 'App not found' }).passed).toBe(false)
  })
})

