import { describe, expect, it } from 'vitest'
import { runToolOnce } from './runTool'
import type { Tool, ToolContext, ToolInput, ToolResult } from '../../tools/Tool'

const ctx: ToolContext = { requestId: 'r1', memory: {} as never }

interface RejectionHook {
  events: unknown[]
  dispose: () => void
}

/** Track unhandled rejections via the runtime's process hooks (no node types). */
function trackUnhandledRejections(): RejectionHook {
  const events: unknown[] = []
  const hook = (reason: unknown) => events.push(reason)
  interface Proc {
    on: (event: string, handler: (reason: unknown) => void) => void
    off: (event: string, handler: (reason: unknown) => void) => void
  }
  const proc = (globalThis as unknown as { process?: Proc }).process
  proc?.on('unhandledRejection', hook)
  return { events, dispose: () => proc?.off('unhandledRejection', hook) }
}

const input: ToolInput = { query: 'q', params: {} }

function baseTool(executeImpl: (input: ToolInput) => Promise<ToolResult>): Tool {
  return {
    id: 'fake',
    category: 'info',
    name: 'Fake',
    description: 'fake',
    permission: 'read_only',
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission: false,
    canRun: () => true,
    execute: executeImpl,
  }
}

describe('runToolOnce', () => {
  it('reports a successful execution with its summary', async () => {
    const tool = baseTool(async () => ({ ok: true, message: 'done work' }))
    const result = await runToolOnce(tool, input, ctx)
    expect(result.success).toBe(true)
    expect(result.summary).toBe('done work')
    expect(result.attempts).toBe(1)
  })

  it('reports a failed execution as a tool_failure with the message', async () => {
    const tool = baseTool(async () => ({ ok: false, message: 'nope' }))
    const result = await runToolOnce(tool, input, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toBe('nope')
    expect(result.errorKind).toBe('tool_failure')
  })

  it('reports a thrown execution as a tool_failure, never leaking nothing', async () => {
    const tool = baseTool(async () => {
      throw new Error('exploded')
    })
    const result = await runToolOnce(tool, input, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toBe('exploded')
    expect(result.summary).toContain('exploded')
  })

  it('bounds a slow tool with the timeout and classifies it as a timeout', async () => {
    const tool = baseTool(
      () => new Promise<ToolResult>(() => undefined), // never settles
    )
    const result = await runToolOnce(tool, input, ctx, 10)
    expect(result.success).toBe(false)
    expect(result.errorKind).toBe('timeout')
  })

  it('never leaves an unhandled rejection when a tool rejects AFTER the timeout fired', async () => {
    const track = trackUnhandledRejections()
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const tool = baseTool(async () => {
        await gate
        throw new Error('late failure after the timeout')
      })

      const result = await runToolOnce(tool, input, ctx, 10)
      expect(result.errorKind).toBe('timeout')

      release()
      await gate.catch(() => undefined)
      // Give the rejected late promise time to settle on the event loop.
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(track.events).toEqual([])
    } finally {
      track.dispose()
    }
  })
})