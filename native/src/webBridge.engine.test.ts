import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { promises as fsp } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { AssistantEngine } from '../../src/engine/AssistantEngine'
import type { AIProvider, AIRequest, AIResponse } from '../../src/engine/provider'
import type { EngineOutMessage } from '../../src/engine/contracts'
import { useConversationStore } from '../../src/state/conversation.store'
import { useJarvisStore } from '../../src/state/jarvis.store'
import { FakeFileSystemProvider } from '../../src/filesystem/testing'
import { FileSystemAccessProvider, createFileSystemProvider } from '../../src/filesystem'
import { startAgent } from './agent.js'
import { MemoryFsBackend } from './testingBackend.js'
import { NativeWindowsFileSystemProvider } from '../../src/native/NativeWindowsFileSystemProvider'
import { startNativeBroker } from '../test-support/startNativeBroker.js'

/**
 * Phase 1.2 — the native Windows bridge through the REAL engine loop (Phase
 * 1.0): honest capability reporting, real tool flows with verification, the
 * delete confirmation boundary, and the proof that production wiring never
 * falls back to fakes. Lives under native/ because it drives a live agent; it
 * is excluded from `native:check` and runs under vitest.
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

async function deadPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })
}

const ROOT = 'C:\\JARVIS\\workspace'
const TOKEN = 'engine-token'

describe('native engine integration — live agent + real filesystem (isolated temp)', () => {
  let agent: Awaited<ReturnType<typeof startAgent>>
  let broker: Awaited<ReturnType<typeof startNativeBroker>>
  let live: NativeWindowsFileSystemProvider

  beforeAll(async () => {
    agent = await startAgent({ roots: [ROOT], token: TOKEN, backend: new MemoryFsBackend(), port: 0 })
    broker = await startNativeBroker(agent.baseUrl, TOKEN)
    live = new NativeWindowsFileSystemProvider({ baseUrl: broker.baseUrl, fetchImpl: broker.fetchImpl })
  })

  afterAll(async () => {
    await broker.close()
    await agent.close()
  })

  beforeEach(() => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
  })

  it('start() reports reachable native capabilities against the live agent', async () => {
    const engine = new AssistantEngine({ providers: [new ScriptedProvider([])], fileSystem: live })
    await engine.start()
    const caps = useJarvisStore.getState().capabilities
    expect(caps.fileSystemAvailable).toBe(true)
    expect(caps.nativeAgentAvailable).toBe(true)
  })

  it('runs a verified mkdir → write workflow through the live bridge', async () => {
    const provider = new ScriptedProvider([
      req('file.mkdir', { path: 'notes' }),
      req('file.write', { path: 'notes/todo.txt', content: 'buy milk' }),
      text('Saved your note.'),
    ])
    const engine = new AssistantEngine({ providers: [provider], fileSystem: live })
    engine.on(() => undefined)

    await engine.process('make a notes folder and save a note')

    const trace = engine.lastRunTrace()
    expect(trace.finalState).toBe('completed')
    expect(trace.steps.map((s) => s.status)).toEqual(['COMPLETED', 'COMPLETED'])
    expect(trace.steps.every((s) => s.verification?.status === 'verified')).toBe(true)
    const mkdirMsg = lastToolMessage(provider, 'file.mkdir')
    expect(mkdirMsg).toContain('[verified]')
    expect(engine.memoryState.items()).toHaveLength(0)
  })

  it('file.delete still demands explicit user confirmation across the bridge', async () => {
    await live.mkdir('notes')
    await live.writeText('notes/secret.txt', 'do not delete lightly')
    const provider = new ScriptedProvider([req('file.delete', { path: 'notes/secret.txt' }), text('Deleted as you confirmed.')])
    const engine = new AssistantEngine({ providers: [provider], fileSystem: live })
    const events: EngineOutMessage[] = []
    engine.on((m) => events.push(m))

    const pending = engine.process('delete the secret file')
    await waitForType(events, 'tool-confirm')
    expect(engine.hasPendingConfirmation).toBe(true)

    engine.confirmPending()
    await pending

    await expect(live.readText('notes/secret.txt')).rejects.toMatchObject({ name: 'FileSystemError', kind: 'not_found' })
    const trace = engine.lastRunTrace()
    expect(trace.steps[0].verification?.status).toBe('verified')
    expect(lastToolMessage(provider, 'file.delete')).toContain('[verified]')
  })
})

describe('native engine integration — offline agent is honest, never fake', () => {
  it('AA — a dead agent port yields honest unavailable caps and tool failures', async () => {
    stubBrowserStorage()
    useConversationStore.getState().clearConversation()
    const dead = await deadPort()
    const broker = await startNativeBroker(`http://127.0.0.1:${dead}`, TOKEN)
    const offline = new NativeWindowsFileSystemProvider({ baseUrl: broker.baseUrl, fetchImpl: broker.fetchImpl, probeTimeoutMs: 500 })
    const provider = new ScriptedProvider([req('file.mkdir', { path: 'notes' }), text("It's not available.")])
    const engine = new AssistantEngine({ providers: [provider], fileSystem: offline })

    try {
      await engine.start()
      const caps = useJarvisStore.getState().capabilities
      expect(caps.fileSystemAvailable).toBe(false)
      expect(caps.nativeAgentAvailable).toBe(false)

      engine.on(() => undefined)
      await engine.process('create a notes folder')

      const trace = engine.lastRunTrace()
      expect(trace.finalState).toBe('completed')
      expect(trace.steps[0].status).toBe('FAILED')
      expect(trace.steps[0].observation?.errorKind).toBe('tool_failure')
      expect(lastToolMessage(provider, 'file.mkdir')).toMatch(/not reachable/i)
    } finally {
      await broker.close()
    }
  })

  it('PROOF — production wiring never ships fakes', async () => {
    // Browser default stays the real File System Access provider.
    const production = createFileSystemProvider()
    expect(production).toBeInstanceOf(FileSystemAccessProvider)
    expect(production).not.toBeInstanceOf(FakeFileSystemProvider)
    expect((production as unknown as { testsOnly?: boolean }).testsOnly).toBeUndefined()

    // The agent's default backend performs REAL operations on a temp root.
    const tmp = mkdtempSync(join(tmpdir(), 'jarvis-native-prod-'))
    try {
      const realAgent = await startAgent({ roots: [tmp], token: TOKEN, port: 0 })
      const broker = await startNativeBroker(realAgent.baseUrl, TOKEN)
      try {
        const bridge = new NativeWindowsFileSystemProvider({ baseUrl: broker.baseUrl, fetchImpl: broker.fetchImpl })
        await bridge.refreshNativeStatus()
        await bridge.writeText('real.txt', 'on the real disk')
        const onDisk = await fsp.readFile(join(tmp, 'real.txt'), 'utf8')
        expect(onDisk).toBe('on the real disk')
      } finally {
        await broker.close()
        await realAgent.close()
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }

    // Memory backend is tests-only and must never be the production default.
    expect(new MemoryFsBackend().testsOnly).toBe(true)
  })
})
