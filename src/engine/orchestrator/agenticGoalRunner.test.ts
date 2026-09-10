import { describe, it, expect } from 'vitest'
import { runAgenticGoal, cancelAgenticGoal, buildReport } from './agenticGoalRunner'
import type { AgenticRunnerContext } from './agenticGoalRunner'
import type { OrchestrationRequest } from './types'
import type { OrchestrationPlannedRequest } from './planner'
import type { Tool, ToolInput, ToolContext, ToolResult } from '../../tools/Tool'
import { createExecutionState } from './executionState'

function mockTool(id: string, opts?: {
  ok?: boolean
  message?: string
  data?: unknown
  permission?: string
  verifiable?: boolean
  verifyResult?: { ok: boolean; message?: string }
  properties?: Record<string, unknown>
}): Tool {
  return {
    id,
    category: 'system' as const,
    name: id,
    description: `Mock ${id}`,
    permission: (opts?.permission ?? 'read_only') as Tool['permission'],
    inputSchema: { type: 'object' as const, properties: opts?.properties ?? {} },
    requiresPermission: false,
    verifiable: opts?.verifiable,
    canRun: () => true,
    execute: async (): Promise<ToolResult> => ({
      ok: opts?.ok ?? true,
      message: opts?.message ?? `${id} done`,
      data: opts?.data,
    }),
    verify: opts?.verifyResult
      ? async () => ({ ok: opts!.verifyResult!.ok, message: opts!.verifyResult!.message })
      : undefined,
  }
}

function mockRegistry(tools: Tool[]) {
  const map = new Map(tools.map((t) => [t.id, t]))
  return { get: (id: string) => map.get(id), ids: () => [...map.keys()] }
}

function mockRequest(text: string): OrchestrationRequest {
  return {
    originalText: text,
    requestClass: 'multi_step_goal',
    confidence: 0.9,
    entities: {},
    requiresContext: false,
    isContinuation: false,
    suggestedCapabilities: [],
    targetDevices: [],
    availableCapabilities: [],
    unavailableCapabilities: [],
    targets: [],
    explanation: 'test',
    processedAt: Date.now(),
  }
}

function makeCtx(
  registry: ReturnType<typeof mockRegistry>,
  opts?: { signal?: AbortSignal; available?: (id: string) => boolean; approve?: (id: string) => boolean },
): AgenticRunnerContext {
  const defs = new Map<string, { id: string; tools: string[]; contexts: [] }>()
  for (const id of registry.ids()) {
    defs.set(id, { id, tools: [id], contexts: [] })
  }
  return {
    registry,
    capabilities: { get: (id: string) => defs.get(id) },
    toolCtx: { requestId: 'test-req' } as ToolContext,
    available: opts?.available,
    approve: opts?.approve,
    signal: opts?.signal,
  }
}

describe('Phase 5 — AgenticGoalRunner', () => {
  describe('runAgenticGoal', () => {
    it('empty plan → completed immediately', async () => {
      const plan: OrchestrationPlannedRequest = { goal: 'test', verdict: 'empty', steps: [] }
      const ctx = makeCtx(mockRegistry([]))
      const { state, report } = await runAgenticGoal(mockRequest('test'), plan, ctx)
      expect(state.finalResult?.status).toBe('completed')
      expect(state.steps).toHaveLength(0)
      expect(report).toContain('test')
    })

    it('blocked plan → failed', async () => {
      const plan: OrchestrationPlannedRequest = { goal: 'test', verdict: 'blocked', steps: [], reason: 'no capability' }
      const ctx = makeCtx(mockRegistry([]))
      const { state } = await runAgenticGoal(mockRequest('test'), plan, ctx)
      expect(state.finalResult?.status).toBe('failed')
    })

    it('single step — verified tool → completed', async () => {
      const tool = mockTool('clipboard.read', { ok: true, data: { text: 'hello' } })
      const plan: OrchestrationPlannedRequest = {
        goal: 'read clipboard',
        verdict: 'ok',
        steps: [{ id: 'step-1', capability: 'clipboard.read', description: 'Read clipboard' }],
      }
      const ctx = makeCtx(mockRegistry([tool]))
      const { state } = await runAgenticGoal(mockRequest('read clipboard'), plan, ctx)
      expect(state.steps).toHaveLength(1)
      expect(state.steps[0].state).toBe('executed')
    })

    it('single step — failing tool → failed', async () => {
      const tool = mockTool('app.launch', { ok: false, message: 'launch failed', properties: { application_id: {} } })
      const plan: OrchestrationPlannedRequest = {
        goal: 'launch app',
        verdict: 'ok',
        steps: [{ id: 'step-1', capability: 'app.launch', description: 'Launch', payload: { application_id: 'notepad' } }],
      }
      const ctx = makeCtx(mockRegistry([tool]))
      const { state } = await runAgenticGoal(mockRequest('launch app'), plan, ctx)
      expect(state.steps[0].state).toBe('failed')
      expect(state.finalResult?.status).toBe('failed')
    })

    it('multi-step plan executes sequentially', async () => {
      const t1 = mockTool('app.launch', { ok: true, properties: { application_id: {} } })
      const t1s = mockTool('app.status', { ok: true, data: { running: true } })
      const t2 = mockTool('clipboard.read', { ok: true, data: { text: 'hi' } })
      const plan: OrchestrationPlannedRequest = {
        goal: 'launch and read',
        verdict: 'ok',
        steps: [
          { id: 'step-1', capability: 'app.launch', description: 'Launch', payload: { application_id: 'notepad' } },
          { id: 'step-2', capability: 'clipboard.read', description: 'Read', dependsOn: [0] },
        ],
      }
      const ctx = makeCtx(mockRegistry([t1, t1s, t2]))
      const { state } = await runAgenticGoal(mockRequest('launch and read'), plan, ctx)
      expect(state.steps).toHaveLength(2)
      expect(state.steps[0].state).toBe('verified')
      expect(state.steps[1].state).toBe('executed')
    })

    it('post-action verification runs for app.launch', async () => {
      const launchTool = mockTool('app.launch', { ok: true, properties: { application_id: {} } })
      const statusTool = mockTool('app.status', { ok: true, data: { running: true } })
      const plan: OrchestrationPlannedRequest = {
        goal: 'launch and verify',
        verdict: 'ok',
        steps: [
          { id: 'step-1', capability: 'app.launch', description: 'Launch', payload: { application_id: 'notepad' } },
        ],
      }
      const ctx = makeCtx(mockRegistry([launchTool, statusTool]))
      const { state } = await runAgenticGoal(mockRequest('launch and verify'), plan, ctx)
      expect(state.steps[0].state).toBe('verified')
      expect(state.steps[0].verification?.passed).toBe(true)
    })

    it('post-action verification fails when effect not confirmed', async () => {
      const launchTool = mockTool('app.launch', { ok: true, properties: { application_id: {} } })
      const statusTool = mockTool('app.status', { ok: true, data: { running: false } })
      const plan: OrchestrationPlannedRequest = {
        goal: 'launch and verify',
        verdict: 'ok',
        steps: [
          { id: 'step-1', capability: 'app.launch', description: 'Launch', payload: { application_id: 'notepad' } },
        ],
      }
      const ctx = makeCtx(mockRegistry([launchTool, statusTool]))
      const { state } = await runAgenticGoal(mockRequest('launch and verify'), plan, ctx)
      expect(state.steps[0].state).toBe('verification_failed')
    })

    it('post-action verification runs for clipboard.write', async () => {
      const writeTool = mockTool('clipboard.write', { ok: true, properties: { text: {} } })
      const readTool = mockTool('clipboard.read', { ok: true, data: { text: 'hello world' } })
      const plan: OrchestrationPlannedRequest = {
        goal: 'write and verify',
        verdict: 'ok',
        steps: [
          { id: 'step-1', capability: 'clipboard.write', description: 'Write', payload: { text: 'hello world' } },
        ],
      }
      const ctx = makeCtx(mockRegistry([writeTool, readTool]))
      const { state } = await runAgenticGoal(mockRequest('write and verify'), plan, ctx)
      expect(state.steps[0].state).toBe('verified')
    })

    it('cancellation stops execution', async () => {
      const controller = new AbortController()
      const tool = mockTool('app.launch', { ok: true, properties: { application_id: {} } })
      const plan: OrchestrationPlannedRequest = {
        goal: 'launch',
        verdict: 'ok',
        steps: [
          { id: 'step-1', capability: 'app.launch', description: 'Launch', payload: { application_id: 'notepad' } },
          { id: 'step-2', capability: 'app.launch', description: 'Launch2', payload: { application_id: 'notepad' } },
        ],
      }
      const ctx = makeCtx(mockRegistry([tool]), { signal: controller.signal })
      // Cancel before starting
      controller.abort()
      const { state } = await runAgenticGoal(mockRequest('launch'), plan, ctx)
      expect(state.steps.some((s) => s.state === 'cancelled')).toBe(true)
    })

    it('unregistered tool → step failed', async () => {
      const plan: OrchestrationPlannedRequest = {
        goal: 'do something',
        verdict: 'ok',
        steps: [{ id: 'step-1', capability: 'nonexistent', description: 'Do thing' }],
      }
      const ctx = makeCtx(mockRegistry([]))
      const { state } = await runAgenticGoal(mockRequest('do something'), plan, ctx)
      expect(state.steps[0].state).toBe('failed')
      expect(state.steps[0].error).toContain('not a registered capability')
    })

    it('confirmation-gated tool requires explicit approval (never auto-approved)', async () => {
      const tool = mockTool('app.close', { ok: true, permission: 'user_confirmation', properties: { application_id: {} } })
      const statusTool = mockTool('app.status', { ok: true, data: { running: false } })
      const plan: OrchestrationPlannedRequest = {
        goal: 'close',
        verdict: 'ok',
        steps: [{ id: 'step-1', capability: 'app.close', description: 'Close', payload: { application_id: 'notepad' } }],
      }
      const registry = mockRegistry([tool, statusTool])
      // No approver → blocked honestly.
      const blocked = await runAgenticGoal(mockRequest('close'), plan, makeCtx(registry))
      expect(blocked.state.steps[0].state).toBe('failed')
      expect(blocked.state.steps[0].error).toContain('Requires user confirmation')
      // Explicit grant → executes.
      const approved = await runAgenticGoal(mockRequest('close'), plan, makeCtx(registry, { approve: () => true }))
      expect(approved.state.steps[0].state).toBe('verified')
      expect(approved.state.permissionEvents.some((e) => e.toolId === 'app.close' && e.decision === 'approved')).toBe(true)
    })

    it('report contains all step statuses', async () => {
      const tool = mockTool('clipboard.read', { ok: true, data: { text: 'test' } })
      const plan: OrchestrationPlannedRequest = {
        goal: 'test report',
        verdict: 'ok',
        steps: [{ id: 'step-1', capability: 'clipboard.read', description: 'Read clipboard' }],
      }
      const ctx = makeCtx(mockRegistry([tool]))
      const { report } = await runAgenticGoal(mockRequest('test report'), plan, ctx)
      expect(report).toContain('test report')
      expect(report).toContain('Read clipboard')
    })
  })

  describe('cancelAgenticGoal', () => {
    it('sets phase to cancelled and updates steps', () => {
      const state = createExecutionStateForTest('test')
      cancelAgenticGoal(state)
      expect(state.phase).toBe('cancelled')
      expect(state.finalResult?.status).toBe('cancelled')
    })
  })

  describe('buildReport', () => {
    it('includes goal and step statuses', () => {
      const state = createExecutionStateForTest('my goal')
      state.finalResult = { status: 'completed', summary: 'done', verifiedSteps: 1, failedSteps: 0, totalSteps: 1 }
      const report = buildReport(state)
      expect(report).toContain('my goal')
      expect(report).toContain('COMPLETED')
    })
  })
})

function createExecutionStateForTest(goal: string) {
  return createExecutionState(goal)
}
