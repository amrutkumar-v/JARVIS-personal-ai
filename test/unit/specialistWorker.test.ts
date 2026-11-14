import { describe, it, expect } from 'vitest'
import {
  SpecialistDelegator,
  SpecialistWorker,
  SPECIALIST_WORKER_POLICIES,
} from '../../src/engine/tasks/SpecialistWorkerPool'
import type { Subtask } from '../../src/engine/tasks/types'

describe('Phase 11 — Specialist Worker Intelligence & Single Cognitive Authority', () => {
  const delegator = new SpecialistDelegator()

  it('1. Correctly infers specialist roles for subtasks based on capability and toolId', () => {
    expect(delegator.inferRoleForSubtask('dev.patchFile', 'dev.patchFile')).toBe('coder')
    expect(delegator.inferRoleForSubtask('dev.runTests', 'dev.runTests')).toBe('verifier')
    expect(delegator.inferRoleForSubtask('dev.auditProject', 'dev.auditProject')).toBe('verifier')
    expect(delegator.inferRoleForSubtask('web_research', 'web.search')).toBe('researcher')
    expect(delegator.inferRoleForSubtask('doc.parse', 'doc.parse')).toBe('researcher')
    expect(delegator.inferRoleForSubtask('system.info', 'system_info')).toBe('general')
  })

  it('2. Enforces strict read-only boundary on researcher worker', () => {
    const researcher = delegator.getWorker('researcher')

    // Allowed tools
    expect(researcher.authorizeTool('web.search').allowed).toBe(true)
    expect(researcher.authorizeTool('doc.summarize').allowed).toBe(true)
    expect(researcher.authorizeTool('browser.readPage').allowed).toBe(true)

    // Denied tools (destructive or mutating)
    const patchCheck = researcher.authorizeTool('dev.patchFile')
    expect(patchCheck.allowed).toBe(false)
    expect(patchCheck.reason).toContain('explicitly forbidden')

    const fileWriteCheck = researcher.authorizeTool('filesystem.write')
    expect(fileWriteCheck.allowed).toBe(false)

    const emailSendCheck = researcher.authorizeTool('email.send')
    expect(emailSendCheck.allowed).toBe(false)
  })

  it('3. Enforces coder boundaries and restricts external communication tools', () => {
    const coder = delegator.getWorker('coder')

    // Allowed
    expect(coder.authorizeTool('dev.patchFile').allowed).toBe(true)
    expect(coder.authorizeTool('dev.runTests').allowed).toBe(true)

    // Denied external communication
    expect(coder.authorizeTool('email.send').allowed).toBe(false)
    expect(coder.authorizeTool('calendar.delete').allowed).toBe(false)
  })

  it('4. Enforces verifier worker is strictly read-only and cannot patch code', () => {
    const verifier = delegator.getWorker('verifier')

    expect(verifier.authorizeTool('dev.runTests').allowed).toBe(true)
    expect(verifier.authorizeTool('dev.auditProject').allowed).toBe(true)
    expect(verifier.authorizeTool('dev.inspectProject').allowed).toBe(true)

    // Mutation forbidden
    expect(verifier.authorizeTool('dev.patchFile').allowed).toBe(false)
    expect(verifier.authorizeTool('filesystem.delete').allowed).toBe(false)
  })

  it('5. Delegates subtask with parent-child lineage while preserving AssistantEngine authority', () => {
    const rawSubtask: Subtask = {
      id: 'subtask-101',
      title: 'Run test suite',
      capability: 'dev.runTests',
      toolId: 'dev.runTests',
      params: { testFile: 'test_circle.py' },
      state: 'PENDING',
      dependencies: ['subtask-100'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      retryCount: 0,
      maxRetries: 3,
    }

    const delegated = delegator.delegateSubtask(rawSubtask, 'parent-task-999')

    expect(delegated.parentTaskId).toBe('parent-task-999')
    expect(delegated.workerRole).toBe('verifier')
    expect(delegated.workerId).toBeDefined()
    expect(delegated.lineage).toBeDefined()
    expect(delegated.lineage?.parentTaskId).toBe('parent-task-999')
    expect(delegated.lineage?.workerRole).toBe('verifier')
    expect(delegated.constraints?.readOnlyOnly).toBe(true)
  })

  it('6. Aggregates structured specialist results without competing task managers', () => {
    const subtasks: Subtask[] = [
      {
        id: 'st-1',
        title: 'Research algorithms',
        capability: 'web_research',
        toolId: 'web.search',
        params: {},
        state: 'VERIFIED',
        dependencies: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        retryCount: 0,
        maxRetries: 1,
        workerRole: 'researcher',
        observation: { summary: 'Identified 3 optimal algorithms' },
      },
      {
        id: 'st-2',
        title: 'Implement circle geometry',
        capability: 'dev.patchFile',
        toolId: 'dev.patchFile',
        params: {},
        state: 'VERIFIED',
        dependencies: ['st-1'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        retryCount: 0,
        maxRetries: 1,
        workerRole: 'coder',
        result: { output: 'Created circle.py' },
      },
      {
        id: 'st-3',
        title: 'Verify unittest suite',
        capability: 'dev.runTests',
        toolId: 'dev.runTests',
        params: {},
        state: 'VERIFIED',
        dependencies: ['st-2'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        retryCount: 0,
        maxRetries: 1,
        workerRole: 'verifier',
        verification: { passed: true, evidence: 'Ran 6 tests in 0.003s. Exit code 0.' },
      },
    ]

    const agg = delegator.aggregateResults(subtasks)
    expect(agg.totalSubtasks).toBe(3)
    expect(agg.verifiedSubtasks).toBe(3)
    expect(agg.failedSubtasks).toBe(0)
    expect(agg.findings).toContain('Identified 3 optimal algorithms')
    expect(agg.codeArtifacts.some((c) => c.includes('circle.py'))).toBe(true)
    expect(agg.verificationVerdicts.length).toBe(1)
    expect(agg.verificationVerdicts[0].passed).toBe(true)
    expect(agg.summary).toContain('3/3 verified')
  })
})

