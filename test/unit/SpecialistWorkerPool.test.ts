/**
 * JARVIS Phase 10: Controlled Specialist Worker Pool & Lineage Test Suite
 *
 * Verifies:
 * 1. Specialist worker roles (researcher, coder, verifier) with strict capability boundaries.
 * 2. Parent-child subtask lineage tracking (parentTaskId, workerId, workerRole).
 * 3. Security gate enforcement in PersistentTaskOrchestrator preventing privilege escalation.
 * 4. Structured result aggregation across specialist workers.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  SpecialistDelegator,
  SpecialistWorker,
} from '../../src/engine/tasks/SpecialistWorkerPool'
import { PersistentTaskOrchestrator } from '../../src/engine/tasks/PersistentTaskOrchestrator'
import type { Subtask } from '../../src/engine/tasks/types'

describe('JARVIS Phase 10: Controlled Specialist Workers', () => {
  // --------------------------------------------------------------------------
  // 1. Role Capabilities & Security Boundary Tests
  // --------------------------------------------------------------------------
  describe('1. Specialist Worker Boundaries', () => {
    it('researcher allows read-only tools and rejects mutations', () => {
      const researcher = new SpecialistWorker('researcher')

      // Allowed read-only tools
      expect(researcher.authorizeTool('web.search', 'read_only').allowed).toBe(true)
      expect(researcher.authorizeTool('doc.analyze', 'read_only').allowed).toBe(true)
      expect(researcher.authorizeTool('data.analyze', 'read_only').allowed).toBe(true)
      expect(researcher.authorizeTool('browser.readPage', 'read_only').allowed).toBe(true)
      expect(researcher.authorizeTool('read_file_contents', 'read_only').allowed).toBe(true)

      // Strictly denied mutating tools
      const patchAuth = researcher.authorizeTool('dev.patchFile', 'low_risk')
      expect(patchAuth.allowed).toBe(false)
      expect(patchAuth.reason).toMatch(/forbidden|constrained/i)

      const docMutationAuth = researcher.authorizeTool('doc.analyze', 'low_risk')
      expect(docMutationAuth.allowed).toBe(false)
      expect(docMutationAuth.reason).toContain('strictly constrained to read-only')

      const emailSendAuth = researcher.authorizeTool('email.send', 'high_risk')
      expect(emailSendAuth.allowed).toBe(false)

      const deleteAuth = researcher.authorizeTool('delete_file', 'high_risk')
      expect(deleteAuth.allowed).toBe(false)
    })

    it('coder allows development tools and rejects external actions', () => {
      const coder = new SpecialistWorker('coder')

      // Allowed dev tools
      expect(coder.authorizeTool('dev.patchFile', 'low_risk').allowed).toBe(true)
      expect(coder.authorizeTool('dev.runTests', 'low_risk').allowed).toBe(true)
      expect(coder.authorizeTool('filesystem.write', 'low_risk').allowed).toBe(true)

      // Forbidden external actions
      const emailAuth = coder.authorizeTool('email.send', 'high_risk')
      expect(emailAuth.allowed).toBe(false)
      expect(emailAuth.reason).toContain('explicitly forbidden')

      const calDeleteAuth = coder.authorizeTool('calendar.delete', 'high_risk')
      expect(calDeleteAuth.allowed).toBe(false)
    })

    it('verifier allows test execution/auditing and rejects file editing', () => {
      const verifier = new SpecialistWorker('verifier')

      // Allowed verification tools
      expect(verifier.authorizeTool('dev.runTests', 'read_only').allowed).toBe(true)
      expect(verifier.authorizeTool('dev.auditProject', 'read_only').allowed).toBe(true)
      expect(verifier.authorizeTool('dev.gitStatus', 'read_only').allowed).toBe(true)

      // Strictly denied editing/mutating tools
      const patchAuth = verifier.authorizeTool('dev.patchFile', 'low_risk')
      expect(patchAuth.allowed).toBe(false)

      const writeAuth = verifier.authorizeTool('write_file', 'low_risk')
      expect(writeAuth.allowed).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // 2. Lineage Tracking & Subtask Delegation
  // --------------------------------------------------------------------------
  describe('2. Lineage Tracking', () => {
    it('delegates subtask with lineage and constraints', () => {
      const delegator = new SpecialistDelegator()
      const rawSubtask: Subtask = {
        id: 'st_1',
        taskId: 'task_parent',
        stepIndex: 0,
        title: 'Research algorithms',
        description: 'Read papers and document findings',
        capability: 'web.search',
        toolId: 'web.search',
        payload: { query: 'transformer architecture' },
        priority: 1,
        dependencies: [],
        state: 'PENDING',
        retries: 0,
        maxRetries: 2,
      }

      const delegated = delegator.delegateSubtask(rawSubtask, 'task_parent')
      expect(delegated.workerRole).toBe('researcher')
      expect(delegated.workerId).toBeDefined()
      expect(delegated.parentTaskId).toBe('task_parent')
      expect(delegated.lineage).toBeDefined()
      expect(delegated.lineage?.workerRole).toBe('researcher')
      expect(delegated.lineage?.parentTaskId).toBe('task_parent')
      expect(delegated.constraints?.readOnlyOnly).toBe(true)
    })

    it('infers coder role for development subtasks', () => {
      const delegator = new SpecialistDelegator()
      const role = delegator.inferRoleForSubtask('dev.patchFile', 'dev.patchFile')
      expect(role).toBe('coder')
    })

    it('infers verifier role for test execution and audit subtasks', () => {
      const delegator = new SpecialistDelegator()
      const role = delegator.inferRoleForSubtask('dev.runTests', 'dev.runTests')
      expect(role).toBe('verifier')
    })
  })

  // --------------------------------------------------------------------------
  // 3. Orchestrator Execution & Security Gate
  // --------------------------------------------------------------------------
  describe('3. Orchestrator Integration & Boundary Enforcement', () => {
    it('executes multi-specialist subtasks and aggregates results on completion', async () => {
      const orchestrator = new PersistentTaskOrchestrator()
      let researcherExecuted = false
      let coderExecuted = false
      let verifierExecuted = false

      orchestrator.setExecutor(async (subtask) => {
        if (subtask.workerRole === 'researcher') {
          researcherExecuted = true
          return {
            success: true,
            output: { facts: ['Fact A', 'Fact B'] },
            observation: { kind: 'research', summary: 'Found 2 key facts' },
            verification: { passed: true, evidence: 'Verified findings from 2 sources.' },
          }
        }
        if (subtask.workerRole === 'coder') {
          coderExecuted = true
          return {
            success: true,
            output: 'Generated area.py',
            verification: { passed: true, evidence: 'Code written successfully.' },
          }
        }
        if (subtask.workerRole === 'verifier') {
          verifierExecuted = true
          return {
            success: true,
            output: { testsPassed: 4 },
            verification: { passed: true, evidence: 'All 4 automated tests passed with exit code 0.' },
          }
        }
        return { success: false, error: 'Unknown worker' }
      })

      const task = await orchestrator.createTask({
        title: 'Multi-specialist mission',
        objective: 'Research, code, and verify',
        subtasks: [
          {
            title: 'Research algorithms',
            description: 'Read specs',
            capability: 'doc.analyze',
            toolId: 'doc.analyze',
            payload: {},
            dependencies: [],
          },
          {
            title: 'Implement code',
            description: 'Write program',
            capability: 'dev.patchFile',
            toolId: 'dev.patchFile',
            payload: {},
            dependencies: ['step-1'],
          },
          {
            title: 'Verify tests',
            description: 'Run test suite',
            capability: 'dev.runTests',
            toolId: 'dev.runTests',
            payload: {},
            dependencies: ['step-2'],
          },
        ],
      })

      await orchestrator.queueTask(task.id)
      await orchestrator.tick()

      const finished = await orchestrator.getTask(task.id)
      if (finished?.state !== 'COMPLETED') {
        console.error('Task error:', finished?.error, finished?.subtasks.map((s) => ({ title: s.title, state: s.state, error: s.result?.error })))
      }
      expect(finished?.state).toBe('COMPLETED')
      expect(researcherExecuted).toBe(true)
      expect(coderExecuted).toBe(true)
      expect(verifierExecuted).toBe(true)

      // Subtasks have assigned roles and lineage
      expect(finished?.subtasks[0].workerRole).toBe('researcher')
      expect(finished?.subtasks[1].workerRole).toBe('coder')
      expect(finished?.subtasks[2].workerRole).toBe('verifier')

      // Metadata contains structured specialist summary
      expect(finished?.metadata.specialistSummary).toBeDefined()
      expect(String(finished?.metadata.specialistSummary)).toContain('3/3 verified')
    })

    it('blocks subtask if specialist worker role policy is violated', async () => {
      const orchestrator = new PersistentTaskOrchestrator()

      orchestrator.setExecutor(async () => {
        return { success: true, verification: { passed: true, evidence: 'Ran tool' } }
      })

      // Create a task where a researcher role is explicitly assigned to a mutating tool
      const task = await orchestrator.createTask({
        title: 'Privilege escalation attempt',
        objective: 'Researcher trying to patch system files',
        subtasks: [
          {
            title: 'Researcher unauthorized patch',
            description: 'Researcher attempting to modify files',
            capability: 'dev.patchFile',
            toolId: 'dev.patchFile',
            payload: {},
            dependencies: [],
          },
        ],
      })

      // Manually set workerRole to researcher to simulate rogue subtask assignment
      task.subtasks[0].workerRole = 'researcher'
      await orchestrator.getStore().saveTask(task)

      await orchestrator.queueTask(task.id)
      await orchestrator.tick()

      const resultTask = await orchestrator.getTask(task.id)
      expect(resultTask?.state).toBe('FAILED')
      expect(resultTask?.subtasks[0].state).toBe('FAILED')
      expect(resultTask?.subtasks[0].result?.error).toMatch(/forbidden|constrained/i)
    })
  })
})
