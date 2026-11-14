import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { startAgent } from './agent.js'
import { FakeUiaBackend } from './uiaWin32.js'
import { MemoryFsBackend } from './testingBackend.js'
import type { RunningAgent } from './agent.js'
import type { NativeResponse } from './protocol.js'

const ROOT = 'C:\\JARVIS\\workspace'
const TOKEN = 'uia-test-token'

async function rpc(baseUrl: string, method: string, params?: Record<string, unknown>, token = TOKEN): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  }
  return fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

describe('Native Windows Agent — Phase 7: UI Automation (UIA)', () => {
  let agent: RunningAgent
  let fakeUia: FakeUiaBackend

  beforeAll(async () => {
    fakeUia = new FakeUiaBackend()
    agent = await startAgent({
      roots: [ROOT],
      port: 0,
      token: TOKEN,
      backend: new MemoryFsBackend(),
      uia: fakeUia,
    })
  })

  afterAll(async () => {
    await agent.close()
  })

  it('inspects window UI Automation tree through uia.inspect', async () => {
    const res = await rpc(agent.baseUrl, 'uia.inspect', { target: 'Calculator', maxDepth: 3 })
    expect(res.status).toBe(200)

    const json = (await res.json()) as NativeResponse
    expect('result' in json).toBe(true)
    const result = (json as any).result
    expect(result.ok).toBe(true)
    expect(result.target).toBe('Calculator')
    expect(result.root.controlType).toBe('Window')
    expect(result.root.children.length).toBeGreaterThan(0)
    expect(result.root.children.some((c: any) => c.automationId === 'num5Button')).toBe(true)
  })

  it('invokes a control pattern through uia.invoke', async () => {
    const res = await rpc(agent.baseUrl, 'uia.invoke', {
      target: 'Calculator',
      automationId: 'num5Button',
    })
    expect(res.status).toBe(200)

    const json = (await res.json()) as any
    expect(json.result.ok).toBe(true)
    expect(json.result.action).toBe('invoke')
    expect(json.result.message).toContain('num5Button')
    expect(fakeUia.actionLog).toContainEqual({
      action: 'invoke',
      target: 'Calculator',
      selector: { automationId: 'num5Button', name: undefined, controlType: undefined },
    })
  })

  it('sets a control value through uia.setValue', async () => {
    const res = await rpc(agent.baseUrl, 'uia.setValue', {
      target: 'Calculator',
      automationId: 'Display',
      value: '42.5',
    })
    expect(res.status).toBe(200)

    const json = (await res.json()) as any
    expect(json.result.ok).toBe(true)
    expect(json.result.action).toBe('setValue')
    expect(json.result.value).toBe('42.5')
    expect(fakeUia.actionLog).toContainEqual({
      action: 'setValue',
      target: 'Calculator',
      selector: { automationId: 'Display', name: undefined, controlType: undefined },
      value: '42.5',
    })
  })

  it('toggles a control pattern through uia.toggle', async () => {
    const res = await rpc(agent.baseUrl, 'uia.toggle', {
      target: 'Calculator',
      automationId: 'KeepOnTopToggle',
    })
    expect(res.status).toBe(200)

    const json = (await res.json()) as any
    expect(json.result.ok).toBe(true)
    expect(json.result.action).toBe('toggle')
    expect(fakeUia.actionLog).toContainEqual({
      action: 'toggle',
      target: 'Calculator',
      selector: { automationId: 'KeepOnTopToggle', name: undefined, controlType: undefined },
    })
  })
})

