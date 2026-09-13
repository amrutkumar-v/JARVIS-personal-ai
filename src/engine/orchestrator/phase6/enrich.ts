import type {
  Phase6PlanMeta,
  Phase6StepMeta,
  Phase6Precondition,
  Phase6RetryPolicy,
} from './planTypes'
import type { CapabilityRisk } from '../../capabilities/types'

function hashPlanId(goal: string): string {
  let h = 2166136261
  const text = String(goal ?? '')
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

export const DEFAULT_P6_ASSUMPTIONS = [
  'only registered capabilities execute',
  'every step is validated before it runs',
  'permissions, budgets and timeouts are never bypassed',
]

export function buildPhase6PlanMeta(input: {
  goal: string
  requestClass: string
  stepCount: number
  hasDependencies: boolean
}): Phase6PlanMeta {
  const { goal, requestClass, stepCount, hasDependencies } = input
  const goalText = String(goal ?? '')
  const intent =
    requestClass === 'multi_step_goal'
      ? 'achieve the requested multi-step outcome'
      : `perform the requested ${requestClass} operation`
  const constraints: string[] = [
    `at most ${stepCount} plan steps, bounded by goal budgets`,
  ]
  if (hasDependencies) constraints.push('dependent steps only run after their prerequisite completes')
  return {
    planId: `plan-${hashPlanId(goalText)}`,
    goal: goalText,
    intent,
    assumptions: [...DEFAULT_P6_ASSUMPTIONS],
    constraints,
    expectedOutcome: `${
      goalText[0]?.toUpperCase() ?? ''
    }${goalText.slice(1)} — completed with verified evidence where possible`,
    verificationStrategy: 'tool_owned_then_post_action',
    risk: 'low',
  }
}

export function buildPhase6StepMeta(input: {
  capability: string
  description: string
  dependsOn?: number[]
  stepCount: number
  hasDependents: boolean
}): Phase6StepMeta {
  const { capability, description, dependsOn, stepCount, hasDependents } = input
  const meta: Phase6StepMeta = {
    expectedOutcome: description ?? capability,
    verification: 'tool_owned_then_post_action',
    risk: 'low',
    failurePolicy: 'replan',
  }
  if (dependsOn && dependsOn.length > 0) {
    const precondition: Phase6Precondition = {
      kind: 'depends_on_success',
      sources: dependsOn
        .map((d) => (Number.isInteger(d) && d >= 0 && d < stepCount ? d : -1))
        .filter((d) => d >= 0),
    }
    if (precondition.sources.length > 0) {
      meta.precondition = precondition
    }
  }
  void hasDependents
  return meta
}

export function applyResolutionToStepMeta(
  meta: Phase6StepMeta,
  input: {
    risk?: CapabilityRisk
    verifiable: boolean
    retry?: { retryable: boolean; maxRetries: number; backoffMs?: number }
  },
): Phase6StepMeta {
  const next = { ...meta }
  if (input.risk) next.risk = input.risk
  if (input.verifiable && next.verification === 'tool_owned_then_post_action') {
    next.verification = 'tool_owned_then_post_action'
  } else if (!input.verifiable && next.verification === 'tool_owned_then_post_action') {
    next.verification = 'post_action'
  }
  if (input.retry) {
    const policy: Phase6RetryPolicy = {
      retryable: input.retry.retryable,
      maxRetries: input.retry.maxRetries,
      backoffMs: input.retry.backoffMs ?? 80,
    }
    next.retryPolicy = policy
  }
  return next
}