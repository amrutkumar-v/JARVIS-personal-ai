import { describe, it, expect } from 'vitest'
import {
  createExecutionState,
  transitionPhase,
  addStep,
  updateStepState,
  buildFinalResult,
  isTerminalPhase,
  canTransitionPhase,
  deadlineReached,
  elapsedMs,
} from './executionState'

describe('Phase 5 — executionState', () => {
  describe('isTerminalPhase', () => {
    it('completed is terminal', () => expect(isTerminalPhase('completed')).toBe(true))
    it('failed is terminal', () => expect(isTerminalPhase('failed')).toBe(true))
    it('cancelled is terminal', () => expect(isTerminalPhase('cancelled')).toBe(true))
    it('executing is not terminal', () => expect(isTerminalPhase('executing')).toBe(false))
    it('planning is not terminal', () => expect(isTerminalPhase('planning')).toBe(false))
  })

  describe('canTransitionPhase', () => {
    it('thinking → planning', () => expect(canTransitionPhase('thinking', 'planning')).toBe(true))
    it('planning → executing', () => expect(canTransitionPhase('planning', 'executing')).toBe(true))
    it('executing → observing', () => expect(canTransitionPhase('executing', 'observing')).toBe(true))
    it('observing → verifying', () => expect(canTransitionPhase('observing', 'verifying')).toBe(true))
    it('verifying → completed', () => expect(canTransitionPhase('verifying', 'completed')).toBe(true))
    it('verifying → recovering', () => expect(canTransitionPhase('verifying', 'recovering')).toBe(true))
    it('recovering → replanning', () => expect(canTransitionPhase('recovering', 'replanning')).toBe(true))
    it('replanning → executing', () => expect(canTransitionPhase('replanning', 'executing')).toBe(true))
    it('any non-terminal → cancelled', () => {
      expect(canTransitionPhase('thinking', 'cancelled')).toBe(true)
      expect(canTransitionPhase('executing', 'cancelled')).toBe(true)
      expect(canTransitionPhase('verifying', 'cancelled')).toBe(true)
    })
    it('terminal → anything is false', () => {
      expect(canTransitionPhase('completed', 'executing')).toBe(false)
      expect(canTransitionPhase('failed', 'planning')).toBe(false)
      expect(canTransitionPhase('cancelled', 'executing')).toBe(false)
    })
    it('invalid transitions are false', () => {
      expect(canTransitionPhase('thinking', 'executing')).toBe(false)
      expect(canTransitionPhase('planning', 'observing')).toBe(false)
      expect(canTransitionPhase('executing', 'completed')).toBe(true)
    })
  })

  describe('createExecutionState', () => {
    it('creates state with thinking phase', () => {
      const state = createExecutionState('test goal')
      expect(state.goal).toBe('test goal')
      expect(state.phase).toBe('thinking')
      expect(state.steps).toHaveLength(0)
      expect(state.recoveryAttempts).toBe(0)
      expect(state.maxRecoveries).toBe(2)
      expect(state.phaseLog).toHaveLength(1)
      expect(state.phaseLog[0].phase).toBe('thinking')
    })

    it('accepts Phase 6 replan ceiling and wall-clock deadline', () => {
      const state = createExecutionState('test', 2, { maxReplans: 1, deadlineMs: 500 })
      expect(state.replanAttempts).toBe(0)
      expect(state.maxReplans).toBe(1)
      expect(state.deadlineMs).toBe(500)
    })

    it('deadlineReached enforces the wall-clock ceiling', () => {
      const state = createExecutionState('test', 2, { deadlineMs: 100 })
      expect(state.startedAt).toBeGreaterThan(0)
      const bound = { startedAt: 1_000, deadlineMs: 100 }
      expect(deadlineReached(bound, 999)).toBe(false)
      expect(deadlineReached(bound, 1_099)).toBe(false)
      expect(deadlineReached(bound, 1_101)).toBe(true)
      const unset = { startedAt: 1_000, deadlineMs: 0 }
      expect(deadlineReached(unset, 2_000)).toBe(false)
    })

    it('elapsedMs never goes negative', () => {
      const bound = { startedAt: Date.now() - 30 }
      expect(elapsedMs(bound, Date.now())).toBeGreaterThanOrEqual(30)
      expect(elapsedMs(bound, bound.startedAt - 100)).toBe(0)
    })
  })

  describe('transitionPhase', () => {
    it('transitions and records in log', () => {
      const state = createExecutionState('test')
      expect(transitionPhase(state, 'planning')).toBe(true)
      expect(state.phase).toBe('planning')
      expect(state.phaseLog).toHaveLength(2)
    })
    it('sets completedAt on terminal phase', () => {
      const state = createExecutionState('test')
      transitionPhase(state, 'planning')
      transitionPhase(state, 'completed')
      expect(state.completedAt).toBeDefined()
    })
    it('rejects invalid transitions', () => {
      const state = createExecutionState('test')
      expect(transitionPhase(state, 'executing')).toBe(false)
      expect(state.phase).toBe('thinking')
    })
  })

  describe('addStep + updateStepState', () => {
    it('adds a step in planned state', () => {
      const state = createExecutionState('test')
      const step = addStep(state, { toolId: 'app.launch', description: 'Launch', input: {} })
      expect(step.stepIndex).toBe(0)
      expect(step.state).toBe('planned')
      expect(state.steps).toHaveLength(1)
    })
    it('transitions step through states', () => {
      const state = createExecutionState('test')
      const step = addStep(state, { toolId: 'app.launch', description: 'Launch', input: {} })
      updateStepState(step, 'executing')
      expect(step.state).toBe('executing')
      expect(step.startedAt).toBeDefined()
      updateStepState(step, 'verified')
      expect(step.state).toBe('verified')
      expect(step.completedAt).toBeDefined()
    })
  })

  describe('buildFinalResult', () => {
    it('all verified → completed', () => {
      const state = createExecutionState('test')
      const s1 = addStep(state, { toolId: 'a', description: 'A', input: {} })
      const s2 = addStep(state, { toolId: 'b', description: 'B', input: {} })
      updateStepState(s1, 'verified')
      updateStepState(s2, 'verified')
      buildFinalResult(state)
      expect(state.finalResult?.status).toBe('completed')
      expect(state.finalResult?.verifiedSteps).toBe(2)
    })
    it('some failed → partial', () => {
      const state = createExecutionState('test')
      const s1 = addStep(state, { toolId: 'a', description: 'A', input: {} })
      const s2 = addStep(state, { toolId: 'b', description: 'B', input: {} })
      updateStepState(s1, 'verified')
      updateStepState(s2, 'failed')
      buildFinalResult(state)
      expect(state.finalResult?.status).toBe('partial')
    })
    it('all failed → failed', () => {
      const state = createExecutionState('test')
      const s1 = addStep(state, { toolId: 'a', description: 'A', input: {} })
      updateStepState(s1, 'failed')
      buildFinalResult(state)
      expect(state.finalResult?.status).toBe('failed')
    })
    it('cancelled → cancelled', () => {
      const state = createExecutionState('test')
      state.phase = 'cancelled'
      const s1 = addStep(state, { toolId: 'a', description: 'A', input: {} })
      updateStepState(s1, 'cancelled')
      buildFinalResult(state)
      expect(state.finalResult?.status).toBe('cancelled')
    })

    it('supports Phase 6 pending/ready/blocked step states', () => {
      const state = createExecutionState('test')
      const s = addStep(state, { toolId: 'a', description: 'A', input: {} })
      updateStepState(s, 'pending')
      expect(s.state).toBe('pending')
      updateStepState(s, 'ready')
      expect(s.state).toBe('ready')
      updateStepState(s, 'blocked')
      expect(s.state).toBe('blocked')
      expect(s.completedAt).toBeDefined()
    })

    it('blocked steps with a verified step → partial', () => {
      const state = createExecutionState('test')
      const s1 = addStep(state, { toolId: 'a', description: 'A', input: {} })
      const s2 = addStep(state, { toolId: 'b', description: 'B', input: {} })
      updateStepState(s1, 'verified')
      updateStepState(s2, 'blocked')
      buildFinalResult(state)
      expect(state.finalResult?.status).toBe('partial')
      expect(state.finalResult?.blockedSteps).toBe(1)
      expect(state.finalResult?.verifiedSteps).toBe(1)
    })

    it('blocked steps without success → failed', () => {
      const state = createExecutionState('test')
      const s1 = addStep(state, { toolId: 'a', description: 'A', input: {} })
      updateStepState(s1, 'blocked')
      buildFinalResult(state)
      expect(state.finalResult?.status).toBe('failed')
    })
  })
})
