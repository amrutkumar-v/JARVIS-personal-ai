import { describe, it, expect } from 'vitest'
import {
  createExecutionState,
  transitionPhase,
  addStep,
  updateStepState,
  buildFinalResult,
  isTerminalPhase,
  canTransitionPhase,
} from './executionState'
import type { AgenticExecutionState } from './executionState'

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
      expect(canTransitionPhase('executing', 'completed')).toBe(false)
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
  })
})
