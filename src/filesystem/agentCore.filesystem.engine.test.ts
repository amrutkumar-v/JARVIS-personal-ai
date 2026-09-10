import { describe, expect, it, beforeEach } from 'vitest'
import { AssistantEngine } from '../engine/AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from '../engine/provider'
import type { EngineOutMessage } from '../engine/contracts'
import { useConversationStore } from '../state/conversation.store'
import { useJarvisStore } from '../state/jarvis.store'
import { FakeFileSystemProvider } from './testing'
import { FileSystemAccessProvider, createFileSystemProvider, createFileSystemTools } from './index'
import { AGENT_LIMITS } from '../engine/limits'

/**
 * Phase 1.1 — filesystem tools through the REAL engine loop (ScriptedProvider
 * + injected FakeFileSystemProvider): multi-step workflows, step failures,
 * repeated-action protection, delete confirmation, honest capability
 * reporting, and the proof that production never binds to the fake.
 */

function stubBrowserStorage(): void {
  const backing = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  ;(globalThis as Record<string, unknown>).window = {
    localStorage,
    setTimeout: (_fn: () => void) => 0,
  }
}

class ScriptedProvider implements AIProvider {
  readonly id = 'scripted'
  readonly label = 'Scripted'
  requests: AIRequest[] = []
  private queue: AIResponse[]

  constructor(script: AIResponse[]) {
    this.queue = [...script]
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    this.requests.push(request)
    const next = this.queue.shift()
    if (!next) return { text: 'No more scripted steps.' }
    return next
  }

  isConfigured(): boolean {
    return true
  }

  isReachable(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

function req(toolId: string, payload: Record<string, unknown> = {}): AIResponse {
  return { text: '', toolRequests: [{ toolId, payload }] }
}

function text(value: string): AIResponse {
  return { text: value }
}

function lastToolMessage(provider: ScriptedProvider, toolId: string): string | undefined {
  for (let i = provider.requests.length - 1; i >= 0; i -= 1) {
    const msg = provider.requests[i].messages.find((m) => m.role === 'tool' && m.toolId === toolId)
    if (msg) return (msg as { content: string }).content
  }
  return undefined
}

async function waitForType(events: EngineOutMessage[], type: EngineOutMessage['type']): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (events.some((m) => m.type === type)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out waiting for event type ${type}`)
}

describe('Filesystem agent (engine-level, scripted provider)', () => {
  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  /* ------------------------------------------------ wiring + proof */

  it('AB — registers all file tools and exposes the injected provider seam', () => {
    const fake = new FakeFileSystemProvider({ 'a.txt': 'x' })
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])], fileSystem: fake })
    const ids = engine.tools.ids().filter((id) => id.startsWith('file.'))
    expect(ids).toEqual([
      'file.status',
      'file.list',
      'file.search',
      'file.stat',
      'file.read',
      'file.mkdir',
      'file.write',
      'file.copy',
      'file.move',
      'file.rename',
      'file.delete',
    ])
    expect(engine.fileSystemProvider).toBe(fake)
    expect((engine.fileSystemProvider as unknown as { testsOnly?: boolean }).testsOnly).toBe(true)
  })

  it('AC/PROOF — production never binds to the fake provider', () => {
    const production = createFileSystemProvider()
    expect(production).not.toBeInstanceOf(FakeFileSystemProvider)
    expect(production instanceof FakeFileSystemProvider).toBe(false)
    expect((production as unknown as { testsOnly?: boolean }).testsOnly).toBeUndefined()
    expect(production).toBeInstanceOf(FileSystemAccessProvider)

    const defaultEngine = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    expect(defaultEngine.fileSystemProvider).toBeInstanceOf(FileSystemAccessProvider)
    expect((defaultEngine.fileSystemProvider as unknown as { testsOnly?: boolean }).testsOnly).toBeUndefined()
  })

  it('reports the honest browser truth when there is no real access', async () => {
    const caps = createFileSystemProvider().capabilities()
    // In the node test env there is no File System Access API: must be honest.
    expect(caps.available).toBe(false)
    expect(caps.hasApi).toBe(false)
    expect(caps.rootGranted).toBe(false)
    expect(caps.reason).toMatch(/File System Access API/i)
    expect(caps.ops.read).toBe(false)
    expect(caps.ops.delete).toBe(false)

    const tool = createFileSystemTools(createFileSystemProvider()).find((t) => t.id === 'file.list')!
    const out = await tool.execute({ query: '', params: {} }, { requestId: 'u' })
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/not available/i)
  })

  it('start() reports fileSystemAvailable honestly per provider', async () => {
    const fake = new FakeFileSystemProvider({ 'a.txt': 'x' })
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])], fileSystem: fake })
    await engine.start()
    expect(useJarvisStore.getState().capabilities.fileSystemAvailable).toBe(true)

    const noApi = new AssistantEngine({ providers: [new ScriptedProvider([])] })
    await noApi.start()
    expect(useJarvisStore.getState().capabilities.fileSystemAvailable).toBe(false)
  })

  /* ------------------------------------------------ multi-step workflow */

  it('Y — runs a verified mkdir → write → move workflow and reports [verified] steps', async () => {
    const fake = new FakeFileSystemProvider()
    const provider = new ScriptedProvider([
      req('file.mkdir', { path: 'notes' }),
      req('file.write', { path: 'notes/todo.txt', content: 'buy milk' }),
      req('file.move', { source: 'notes/todo.txt', destination: 'shopping.txt' }),
      text('Moved your note to the workspace root.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], fileSystem: fake })
    engine.on(() => undefined)

    await engine.process('create a notes folder and move my note to the root')

    expect(fake.treeStrings()).toContain('shopping.txt')
    expect(fake.treeStrings()).not.toContain('notes/todo.txt')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps).toHaveLength(3)
    expect(trace.steps.map((s) => s.status)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED'])
    for (const step of trace.steps) {
      expect(step.verification?.status).toBe('verified')
    }

    const moveMsg = lastToolMessage(provider, 'file.move')
    expect(moveMsg).toContain('[verified]')
    // Memory is never written by filesystem work.
    expect(engine.memoryState.items()).toHaveLength(0)
  })

  it('Z — a failed step is honest and the agent keeps going', async () => {
    const fake = new FakeFileSystemProvider({ 'a.txt': 'x' })
    const provider = new ScriptedProvider([
      req('file.read', { path: 'missing.txt' }),
      text("It isn't there — I'll keep looking."),
    ])
    const engine = new AssistantEngine({ providers: [provider], fileSystem: fake })
    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))

    await engine.process('read missing.txt')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps[0].status).toBe('FAILED')
    expect(trace.steps[0].observation?.errorKind).toBe('tool_failure')
    const readMsg = lastToolMessage(provider, 'file.read')
    expect(readMsg).toMatch(/no such|not found/i)
  })

  /* ------------------------------------------------ repeated action */

  it('AA — identical file writes are blocked by the repeated-action guard', async () => {
    const fake = new FakeFileSystemProvider()
    const write = { path: 'notes.txt', content: 'value', overwrite: true }
    const provider = new ScriptedProvider([
      req('file.write', write),
      req('file.write', write),
      req('file.write', write),
      req('file.write', write),
      text('Done.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], fileSystem: fake })
    engine.on(() => undefined)

    await engine.process('write the note four times')

    const trace = engine.lastRunTrace()
    // 3 genuine executions + 1 blocked duplicate.
    expect(trace.steps).toHaveLength(4)
    expect(trace.steps.slice(0, 3).every((s) => s.status === 'COMPLETED')).toBe(true)
    expect(trace.steps[3].status).toBe('FAILED')
    expect(trace.steps[3].observation?.errorKind).toBe('orchestration_limit')
    expect(trace.steps[3].observation?.summary).toContain('already been executed')
    expect((await fake.readText('notes.txt')).content).toBe('value')
    expect(AGENT_LIMITS.MAX_REPEATED_ACTIONS).toBe(3)
  })

  it('D — missing required args are rejected before any filesystem work', async () => {
    const fake = new FakeFileSystemProvider({ 'a.txt': 'x' })
    const provider = new ScriptedProvider([req('file.stat', {}), text('I need a path.')])
    const engine = new AssistantEngine({ providers: [provider], fileSystem: fake })
    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))

    await engine.process('stat something')

    expect(lastToolMessage(provider, 'file.stat')).toMatch(/Missing required/i)
    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('FAILED')
    expect(trace.steps[0].observation?.errorKind).toBe('invalid_input')
    expect(fake.treeStrings()).toEqual(['a.txt'])
  })

  /* ------------------------------------------------ delete confirmation */

  it('AB — file.delete runs only after explicit user confirmation, then verifies', async () => {
    const fake = new FakeFileSystemProvider({ 'secret.txt': 'do not delete lightly' })
    const provider = new ScriptedProvider([req('file.delete', { path: 'secret.txt' }), text('Deleted as you confirmed.')])
    const engine = new AssistantEngine({ providers: [provider], fileSystem: fake })
    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))

    const pending = engine.process('delete secret.txt')
    await waitForType(events, 'tool-confirm')
    expect(engine.hasPendingConfirmation).toBe(true)

    engine.confirmPending()
    await pending

    expect(fake.treeStrings()).not.toContain('secret.txt')
    const trace = engine.lastRunTrace()
    expect(trace.steps[0].status).toBe('COMPLETED')
    expect(trace.steps[0].verification?.status).toBe('verified')
    expect(lastToolMessage(provider, 'file.delete')).toContain('[verified]')
  })

  it('AB — declining the confirmation leaves the file untouched', async () => {
    const fake = new FakeFileSystemProvider({ 'secret.txt': 'do not delete lightly' })
    const provider = new ScriptedProvider([req('file.delete', { path: 'secret.txt' }), text('Understood, keeping it.')])
    const engine = new AssistantEngine({ providers: [provider], fileSystem: fake })
    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))

    const pending = engine.process('delete secret.txt')
    await waitForType(events, 'tool-confirm')

    engine.cancelPending()
    await pending

    expect(fake.treeStrings()).toContain('secret.txt')
    const deleteMsg = lastToolMessage(provider, 'file.delete')
    expect(deleteMsg).toMatch(/declined|not running|cancel/i)
    expect(engine.hasPendingConfirmation).toBe(false)
    expect(provider.requests.length).toBeGreaterThanOrEqual(2)
  })
})