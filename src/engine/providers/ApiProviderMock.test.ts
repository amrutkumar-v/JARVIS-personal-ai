import { describe, expect, it, beforeEach } from 'vitest'
import { ApiProvider } from '../providers/ApiProviderMock'
import type { AIRequest, AIMessage } from '../provider'

function req(prompt: string, extraMessages: AIMessage[] = []): AIRequest {
  return {
    prompt,
    messages: [{ role: 'user', content: prompt }, ...extraMessages],
    context: [],
    availableTools: ['clock', 'calculator', 'notes', 'system_info'],
    toolDefinitions: [],
    isNewSession: false,
  }
}

describe('ApiProvider (mock)', () => {
  let provider: ApiProvider

  beforeEach(() => {
    provider = new ApiProvider()
  })

  it('labels itself honestly as a dev provider', () => {
    expect(provider.id).toBe('mock')
    expect(provider.isConfigured()).toBe(true)
  })

  it('plans a calculator call for arithmetic, then answers from the result', async () => {
    const round1 = await provider.generate(req('what is 12 + 30'), () => {})
    expect(round1.toolRequests).toEqual([{ toolId: 'calculator', payload: {} }])

    const round2 = await provider.generate(
      req('what is 12 + 30', [
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', toolId: 'calculator', payload: {} }] },
        { role: 'tool', callId: 'c1', toolId: 'calculator', content: '12+30 = 42' },
      ]),
      () => {},
    )
    expect(round2.text).toMatch(/42/)
  })

  it('plans a notes save for "remember"', async () => {
    const res = await provider.generate(req('remember my name is Samantha'), () => {})
    expect(res.toolRequests).toEqual([
      { toolId: 'notes', payload: { action: 'save', text: 'my name is Samantha' } },
    ])
  })

  it('plans a notes recall for a memory question', async () => {
    const res = await provider.generate(req('what is my name'), () => {})
    expect(res.toolRequests).toMatchObject([
      { toolId: 'notes', payload: { action: 'recall' } },
    ])
  })

  it('routes a specific forget to the forget action with a query', async () => {
    const res = await provider.generate(req('forget my name'), () => {})
    expect(res.toolRequests).toEqual([
      { toolId: 'notes', payload: { action: 'forget', query: 'my name' } },
    ])
  })

  it('routes a clear-all request to the clear action', async () => {
    const res = await provider.generate(req('clear all my memories'), () => {})
    expect(res.toolRequests).toEqual([{ toolId: 'notes', payload: { action: 'clear' } }])
  })

  it('routes "forget everything" to clear-all (destructive)', async () => {
    const res = await provider.generate(req('forget everything'), () => {})
    expect(res.toolRequests).toEqual([{ toolId: 'notes', payload: { action: 'clear' } }])
  })

  it('routes a memory listing question to the list action', async () => {
    const res = await provider.generate(req('what do you remember'), () => {})
    expect(res.toolRequests).toMatchObject([{ toolId: 'notes', payload: { action: 'list' } }])
  })

  it('plans the clock tool for time questions', async () => {
    const res = await provider.generate(req('what time is it'), () => {})
    expect(res.toolRequests).toEqual([{ toolId: 'clock', payload: {} }])
  })

  it('never pretends to be a real LLM', async () => {
    const res = await provider.generate(req('who are you really'), () => {})
    expect(res.text.toLowerCase()).toMatch(/dev|development/)
  })

  it('composes the final answer directly from a tool result', async () => {
    const res = await provider.generate(
      req('what time is it', [
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', toolId: 'clock', payload: {} }] },
        { role: 'tool', callId: 'c1', toolId: 'clock', content: 'The local time is 10:24 on Monday, 7 September 2026.' },
      ]),
      () => {},
    )
    expect(res.text).toBe('The local time is 10:24 on Monday, 7 September 2026.')
  })
})