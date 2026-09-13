import type { RecoveryFailureKind } from '../../agent/types'

export interface ReplanContext {
  failedStepIndex: number
  capability: string
  failedKind: RecoveryFailureKind
  summary: string
}

export interface PlannedAlternative {
  capability: string
  payload: Record<string, unknown>
  note: string
}

export type AlternativeResolver = (ctx: ReplanContext) => PlannedAlternative | undefined

export interface ReplanDecision {
  action: 'stop' | 'continue'
  reason: string
  corrected?: PlannedAlternative
  replansUsed: number
  maxReplans: number
}

export function replanLimitReached(replansUsed: number, maxReplans: number): boolean {
  return replansUsed >= maxReplans
}

export function decideReplan(input: {
  ctx: ReplanContext
  replansUsed: number
  maxReplans: number
  alternatives?: AlternativeResolver
}): ReplanDecision {
  const { ctx, replansUsed, maxReplans } = input

  if (replanLimitReached(replansUsed, maxReplans)) {
    return {
      action: 'stop',
      reason: `replan limit reached (${maxReplans}): no further corrected attempts allowed`,
      replansUsed,
      maxReplans,
    }
  }

  const resolver = input.alternatives
  if (!resolver) {
    return {
      action: 'stop',
      reason: 'no genuinely supported alternative exists for this failed step; stopping honestly',
      replansUsed,
      maxReplans,
    }
  }

  const corrected = resolver(ctx)
  if (!corrected) {
    return {
      action: 'stop',
      reason: `no genuinely supported alternative exists for "${ctx.capability}" after a ${ctx.failedKind} failure; stopping honestly`,
      replansUsed,
      maxReplans,
    }
  }

  return {
    action: 'continue',
    reason: `replanning step ${ctx.failedStepIndex} to a genuinely supported alternative`,
    corrected,
    replansUsed: replansUsed + 1,
    maxReplans,
  }
}

export function isReplayOf(
  plan: ReadonlyArray<{ capability: string; payload: Record<string, unknown> }>,
  candidate: PlannedAlternative,
): boolean {
  return plan.some(
    (s) =>
      s.capability === candidate.capability &&
      JSON.stringify(s.payload) === JSON.stringify(candidate.payload),
  )
}