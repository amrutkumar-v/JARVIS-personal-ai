import type { Phase6Precondition } from './planTypes'
import type { ContextValue } from './executionContext'

export interface ConditionResult {
  passed: boolean
  reason: string
}

export interface StepOutcomeView {
  state: string
}

export type ContextLookup = (stepIndex: number, path?: string) => ContextValue | undefined

const SUCCESS_STATES: ReadonlySet<string> = new Set([
  'verified',
  'observed',
  'executed',
])

export function evalPrecondition(
  precondition: Phase6Precondition,
  steps: ReadonlyArray<StepOutcomeView>,
  lookup: ContextLookup,
): ConditionResult {
  if (!steps || precondition.sources.length === 0) {
    return { passed: false, reason: 'invalid precondition: no sources' }
  }

  if (precondition.kind === 'depends_on_success') {
    for (const idx of precondition.sources) {
      const step = steps[idx]
      if (!step) {
        return { passed: false, reason: `source step ${idx} is missing` }
      }
      if (!SUCCESS_STATES.has(step.state)) {
        return {
          passed: false,
          reason: `source step ${idx} did not complete (state: ${step.state})`,
        }
      }
    }
    return { passed: true, reason: 'all dependency sources completed' }
  }

  if (precondition.kind === 'context_matches') {
    const source = precondition.source
    if (source === undefined || !steps[source]) {
      return { passed: false, reason: `context source step ${source} is missing` }
    }
    const actual = lookup(source, precondition.path)
    if (!deepEqualValue(actual, precondition.expect)) {
      const got = JSON.stringify(actual ?? null)
      const want = JSON.stringify(precondition.expect)
      return {
        passed: false,
        reason: `context did not match expected value (got ${got}, expected ${want})${
          precondition.note ? `; ${precondition.note}` : ''
        }`,
      }
    }
    return { passed: true, reason: 'context matched expected value' }
  }

  return { passed: false, reason: 'unsupported precondition kind' }
}

export type StepGate = 'run' | 'skip' | 'block'

export interface GateDecision {
  gate: StepGate
  reason: string
}

export function decideStepReadiness(
  _index: number,
  dependsOn: ReadonlyArray<number> | undefined,
  precondition: Phase6Precondition | undefined,
  steps: ReadonlyArray<StepOutcomeView>,
  lookup: ContextLookup,
): GateDecision {
  if (dependsOn && dependsOn.length > 0) {
    for (const depIndex of dependsOn) {
      const dep = steps[depIndex]
      if (!dep) {
        return { gate: 'block', reason: `dependency step ${depIndex} is missing` }
      }
      if (dep.state === 'failed' || dep.state === 'cancelled' || dep.state === 'blocked') {
        return {
          gate: 'block',
          reason: `this step depends on step ${depIndex} which ${dep.state}`,
        }
      }
      if (dep.state === 'skipped') {
        return {
          gate: 'block',
          reason: `this step depends on step ${depIndex} which was skipped`,
        }
      }
      if (dep.state === 'planned' || dep.state === 'pending' || dep.state === 'permission_pending') {
        return { gate: 'block', reason: `dependency step ${depIndex} has not completed` }
      }
    }
  }

  if (precondition) {
    const result = evalPrecondition(precondition, steps, lookup)
    if (!result.passed) {
      return { gate: 'skip', reason: result.reason }
    }
  }

  return { gate: 'run', reason: 'ready to run' }
}

export function deepEqualValue(a: ContextValue | undefined, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return a === b
  const ta = typeof a
  const tb = typeof b
  if (ta !== tb) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqualValue(v, b[i]))
  }
  if (ta === 'object' && tb === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keysA = Object.keys(a as Record<string, unknown>)
    const keysB = Object.keys(b as Record<string, unknown>)
    if (keysA.length !== keysB.length) return false
    return keysA.every((k) =>
      deepEqualValue(
        (a as Record<string, ContextValue>)[k],
        (b as Record<string, unknown>)[k],
      ),
    )
  }
  return false
}