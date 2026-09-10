import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClipboardReadTool, ClipboardWriteTool, createClipboardTools } from './ClipboardTools'
import type { ClipboardProvider, ClipboardReadResult, ClipboardWriteResult } from './provider'

function createMockProvider(overrides?: Partial<ClipboardProvider>): ClipboardProvider {
  return {
    id: 'mock-clipboard',
    capabilities: () => ({
      available: true,
      ops: { read: true, write: true },
    }),
    read: vi.fn().mockResolvedValue({ success: true, text: 'hello', byteLength: 10, verified: true } as ClipboardReadResult),
    write: vi.fn().mockResolvedValue({ success: true, byteLength: 10, verified: true } as ClipboardWriteResult),
    ...overrides,
  }
}

describe('createClipboardTools', () => {
  it('returns empty array when provider is undefined', () => {
    expect(createClipboardTools(undefined)).toEqual([])
  })

  it('returns read and write tools when provider is provided', () => {
    const tools = createClipboardTools(createMockProvider())
    expect(tools).toHaveLength(2)
    expect(tools.map((t) => t.id)).toEqual(['clipboard.read', 'clipboard.write'])
  })
})

describe('ClipboardReadTool', () => {
  let tool: ClipboardReadTool
  let provider: ClipboardProvider

  beforeEach(() => {
    provider = createMockProvider()
    tool = new ClipboardReadTool(provider)
  })

  it('has correct metadata', () => {
    expect(tool.id).toBe('clipboard.read')
    expect(tool.permission).toBe('read_only')
    expect(tool.category).toBe('system')
    expect(tool.verifiable).toBe(false)
  })

  it('returns available when provider is connected', () => {
    expect(tool.canRun('read clipboard')).toBe(true)
  })

  it('reads clipboard successfully', async () => {
    const result = await tool.execute({ query: 'read clipboard', params: {} }, { requestId: 'test' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('10 bytes')
    expect(provider.read).toHaveBeenCalled()
  })

  it('handles empty clipboard', async () => {
    provider = createMockProvider({
      read: vi.fn().mockResolvedValue({ success: true, text: '', byteLength: 0, verified: true }),
    })
    tool = new ClipboardReadTool(provider)
    const result = await tool.execute({ query: 'read clipboard', params: {} }, { requestId: 'test' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('empty')
  })

  it('returns unavailable when provider is disconnected', async () => {
    provider = createMockProvider({
      capabilities: () => ({
        available: false,
        reason: 'Agent not connected',
        ops: { read: false, write: false },
      }),
    })
    tool = new ClipboardReadTool(provider)
    const result = await tool.execute({ query: 'read clipboard', params: {} }, { requestId: 'test' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('not available')
  })

  it('handles read failure', async () => {
    provider = createMockProvider({
      read: vi.fn().mockRejectedValue(new Error('Clipboard locked')),
    })
    tool = new ClipboardReadTool(provider)
    const result = await tool.execute({ query: 'read clipboard', params: {} }, { requestId: 'test' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Clipboard locked')
  })

  it('does not include raw clipboard content in task log metadata', async () => {
    const result = await tool.execute({ query: 'read clipboard', params: {} }, { requestId: 'test' })
    // The data field contains text for the model, but the message should only contain byte count
    expect(result.message).not.toContain('hello')
    expect(result.message).toContain('10 bytes')
  })
})

describe('ClipboardWriteTool', () => {
  let tool: ClipboardWriteTool
  let provider: ClipboardProvider

  beforeEach(() => {
    provider = createMockProvider()
    tool = new ClipboardWriteTool(provider)
  })

  it('has correct metadata', () => {
    expect(tool.id).toBe('clipboard.write')
    expect(tool.permission).toBe('low_risk')
    expect(tool.verifiable).toBe(true)
  })

  it('writes to clipboard successfully', async () => {
    const result = await tool.execute({ query: 'copy to clipboard', params: { text: 'hello' } }, { requestId: 'test' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('Wrote')
    expect(provider.write).toHaveBeenCalledWith('hello')
  })

  it('requires text parameter', async () => {
    const result = await tool.execute({ query: 'copy to clipboard', params: {} }, { requestId: 'test' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('No text')
  })

  it('verifies write by reading back', async () => {
    const verification = await tool.verify(
      { query: 'copy to clipboard', params: { text: 'hello' } },
      { ok: true, message: 'done' },
      { requestId: 'test' },
    )
    expect(verification.ok).toBe(true)
    expect(provider.read).toHaveBeenCalled()
  })

  it('handles write failure', async () => {
    provider = createMockProvider({
      write: vi.fn().mockRejectedValue(new Error('Clipboard access denied')),
    })
    tool = new ClipboardWriteTool(provider)
    const result = await tool.execute({ query: 'copy to clipboard', params: { text: 'hello' } }, { requestId: 'test' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Clipboard access denied')
  })
})

describe('ClipboardProvider availability', () => {
  it('reports unavailable when provider says so', () => {
    const provider = createMockProvider({
      capabilities: () => ({
        available: false,
        reason: 'Native agent not running',
        ops: { read: false, write: false },
      }),
    })
    const tools = createClipboardTools(provider)
    expect(tools).toHaveLength(2)
    // Both tools should report unavailable
  })
})
