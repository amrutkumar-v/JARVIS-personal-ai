/**
 * Phase 5 — Agentic Goal Runner.
 *
 * The central closed-loop orchestrator:
 *   Goal → Plan → Permission Gate → Execute → Observe → Verify → Replan → Report
 *
 * Reuses ALL existing Phase 2.x/3.x infrastructure:
 *   - validatePlan (strict pre-flight)
 *   - decidePermission (Phase 3 permission rails)
 *   - runToolOnce (tool execution with timeout)
 *   - runToolVerification (tool-owned verification)
 *   - classifyObservation (structured observation)
 *   - classifyRecovery (recovery action mapping)
 *   - shouldRetry (bounded retry)
 *   - planPostActionObservation (cross-tool verification)
 *
 * This module is a FOCUSED composition layer. It does not replace the existing
 * executeOrchestrated or process() — it wraps them in a verified loop.
 */

import type { ToolContext, ToolInput } from '../../tools/Tool'
import type { OrchestrationRequest } from './types'
import type { OrchestrationPlannedRequest } from './planner'
import type { PlanStepRequest } from '../goal/validatePlan'
import { validatePlan } from '../goal/validatePlan'
import type { ToolLookup } from '../goal/validatePlan'
import { decidePermission } from '../agent/permissions'
import { runToolOnce } from '../agent/runTool'
import { runToolVerification } from '../agent/verification'
import { classifyObservation } from '../agent/observations'
import { classifyRecovery } from '../goal/recovery'
import { shouldRetry } from '../agent/retry'
import { planPostActionObservation } from './postActionVerify'
import {
  createExecutionState,
  transitionPhase,
  addStep,
  updateStepState,
  buildFinalResult,
} from './executionState'
import type { AgenticExecutionState, StepState } from './executionState'
import type { CapabilityRegistryLike } from '../capabilities'

/** Maximum recovery attempts before stopping. */
const MAX_RECOVERIES = 2
/** Maximum retries per step (from tool retry policy). */
const MAX_STEP_RETRIES = 2

export interface AgenticRunnerContext {
  /** Lookup registered tools. */
  registry: ToolLookup
  /** Lookup capabilities. */
  capabilities: CapabilityRegistryLike
  /** Tool execution context (requestId, signal, etc). */
  toolCtx: ToolContext
  /** Check if a tool is available in this environment. */
  available?: (toolId: string) => boolean
  /**
   * Explicit human/permission grant for confirmation-gated tools. This is the
   * ONLY way a `user_confirmation`-level tool may proceed in the deterministic
   * runner. Absent an approver (or when it returns false) the step is blocked —
   * the Phase 3 permission rails stay authoritative: never execute-before-permission.
   */
  approve?: (toolId: string, input: Record<string, unknown>) => boolean
  /** Cancel signal. */
  signal?: AbortSignal
}

export interface AgenticRunResult {
  state: AgenticExecutionState
  report: string
}

/**
 * Run a single tool step with retry, permission check, execution, and
 * observation. Returns the updated step state.
 */
async function executeStep(
  step: StepState,
  ctx: AgenticRunnerContext,
  state: AgenticExecutionState,
): Promise<void> {
  const tool = ctx.registry.get(step.toolId)
  if (!tool) {
    updateStepState(step, 'failed')
    step.error = `Tool "${step.toolId}" is not registered.`
    return
  }

  // Permission check
  const permission = decidePermission(tool, ctx.toolCtx.requestId, step.input)
  if (permission.kind === 'denied') {
    updateStepState(step, 'failed')
    step.error = permission.reason
    return
  }
  if (permission.kind === 'confirm') {
    // Deterministic runner never auto-approves. Only an explicit external grant
    // (ctx.approve, e.g. a user/UI approval) may proceed; otherwise the step is
    // blocked and an honest PERMISSION_DENIED-style failure is recorded.
    const approved = ctx.approve?.(tool.id, step.input) === true
    if (approved) {
      state.permissionEvents.push({ toolId: tool.id, decision: 'approved', at: Date.now() })
    } else {
      step.state = 'permission_pending'
      updateStepState(step, 'failed')
      step.error = `Requires user confirmation: ${permission.reason}`
      step.errorKind = 'permission_denied'
      return
    }
  }

  // Execute with retry
  updateStepState(step, 'executing')
  let lastError: string | undefined
  let lastErrorKind: string | undefined
  for (let attempt = 0; attempt <= MAX_STEP_RETRIES; attempt++) {
    if (ctx.signal?.aborted) {
      updateStepState(step, 'cancelled')
      step.error = 'Cancelled.'
      return
    }

    const input: ToolInput = { query: step.description, params: step.input }
    const result = await runToolOnce(tool, input, ctx.toolCtx, tool.timeoutMs)

    if (result.success) {
      step.result = { success: true, summary: result.summary, output: result.output }

      // Tool-owned verification
      const verification = await runToolVerification(tool, input, result, ctx.toolCtx)

      // Observation classification
      const observation = classifyObservation(result, verification)
      step.observation = { kind: observation.kind, summary: observation.summary, data: observation.data }

      if (verification.status === 'verified') {
        step.verification = { passed: true, message: verification.message }
        updateStepState(step, 'executed')
      } else if (verification.status === 'failed') {
        step.verification = { passed: false, message: verification.message }
        updateStepState(step, 'executed')
      } else {
        updateStepState(step, 'executed')
      }
      return
    }

    lastError = result.summary
    lastErrorKind = result.errorKind
    const retryDecision = shouldRetry(result.errorKind, attempt, tool.retry)
    if (!retryDecision.shouldRetry) break
    await new Promise((r) => setTimeout(r, retryDecision.backoffMs))
  }

  updateStepState(step, 'failed')
  step.error = lastError ?? 'Tool execution failed.'
  step.errorKind = lastErrorKind ?? 'tool_failure'
}

/**
 * Observe and verify a step's effect using cross-tool observation.
 * Returns true if verification passed (or no observation needed).
 */
async function observeAndVerify(
  step: StepState,
  ctx: AgenticRunnerContext,
): Promise<boolean> {
  const observation = planPostActionObservation(step.toolId, step.input, step.result!)
  if (!observation) return true

  updateStepState(step, 'observing')

  const observeTool = ctx.registry.get(observation.observeToolId)
  if (!observeTool) {
    // No observation tool available — treat as unverified but not a failure
    updateStepState(step, 'observed')
    step.observation = {
      kind: 'partial',
      summary: `Observed via ${observation.observeToolId} — tool unavailable.`,
    }
    return false
  }

  const input: ToolInput = { query: observation.description, params: observation.observeParams }

  // Bounded settle so an asynchronous effect (page nav, app startup) is
  // actually observable before we read the environment. Never fabricates.
  if (observation.settleMs && observation.settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, observation.settleMs))
  }

  const retries = Math.max(0, Math.floor(observation.retries ?? 0))
  let lastRun: { ok: boolean; result?: ToolExecutionResult } | undefined
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await runToolOnce(observeTool, input, ctx.toolCtx, observeTool.timeoutMs)
    lastRun = { ok: result.success, result }
    if (!result.success) break
    const verification = observation.verify(result.output)
    if (verification.passed || attempt === retries) {
      step.verification = verification
      updateStepState(step, verification.passed ? 'verified' : 'verification_failed')
      step.observation = {
        kind: verification.passed ? 'success' : 'verification',
        summary: verification.message,
        data: result.output,
      }
      return verification.passed
    }
    if (observation.retryDelayMs && observation.retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, observation.retryDelayMs))
    }
  }

  // No observation succeeded at all.
  const final = lastRun
  updateStepState(step, 'observed')
  step.observation = {
    kind: 'partial',
    summary: final && !final.ok ? `Observation failed: ${final.result?.summary ?? 'unknown error'}` : `Observation did not confirm the effect.`,
  }
  return false
}

/**
 * Execute a full agentic goal: plan → validate → execute → observe → verify
 * → recover/replan → report.
 */
export async function runAgenticGoal(
  request: OrchestrationRequest,
  plan: OrchestrationPlannedRequest,
  ctx: AgenticRunnerContext,
): Promise<AgenticRunResult> {
  const state = createExecutionState(request.originalText, MAX_RECOVERIES)

  // Phase: thinking → planning
  transitionPhase(state, 'planning', `Plan: ${plan.verdict}, ${plan.steps.length} steps`)

  if (plan.verdict !== 'ok' || plan.steps.length === 0) {
    transitionPhase(state, plan.verdict === 'blocked' ? 'failed' : 'completed', plan.reason)
    buildFinalResult(state)
    return { state, report: buildReport(state) }
  }

  // Create step states (before validation so rejected steps are queryable)
  for (const step of plan.steps) {
    addStep(state, {
      toolId: step.capability,
      capability: step.capability,
      description: step.description,
      input: step.payload ?? {},
    })
  }

  // Validate the plan
  const stepRequests: PlanStepRequest[] = plan.steps.map((s) => ({
    toolId: s.capability,
    capability: s.capability,
    payload: s.payload ?? {},
    dependsOn: s.dependsOn && s.dependsOn.length > 0 ? [...s.dependsOn] : undefined,
  }))

  const validation: PlanValidation = validatePlan(
    stepRequests,
    ctx.registry as ToolLookup,
    0,
    10,
    ctx.available,
    ctx.capabilities,
  )

  const rejected = validation.verdicts.filter((v) => !v.ok)
  if (rejected.length > 0) {
    for (const verdict of rejected) {
      const st = state.steps[verdict.stepIndex]
      if (st) {
        updateStepState(st, 'failed')
        st.error = verdict.reason
      }
    }
    state.steps.forEach((st, idx) => {
      const verdict = validation.verdicts[idx]
      if (st.state === 'planned' && verdict && !verdict.ok) return
      if (st.state === 'planned') {
        updateStepState(st, 'skipped')
        st.error = 'Plan aborted due to a rejected step.'
      }
    })
    transitionPhase(state, 'failed', `Plan validation rejected: ${rejected[0].reason}`)
    buildFinalResult(state)
    return { state, report: buildReport(state) }
  }

  // Map validated step index → concrete registered tool. validatePlan resolves
  // capability steps to their deterministic implementation (e.g. `open_application`
  // → `app.launch`); plain-tool steps use the named toolId as-is.
  const resolvedToolIds = new Map<number, string>()
  if (validation.resolutions) {
    for (const res of validation.resolutions) {
      resolvedToolIds.set(res.stepIndex, res.toolId)
      const st = state.steps[res.stepIndex]
      if (st) st.toolId = res.toolId
    }
  }

  // Phase: planning → executing
  transitionPhase(state, 'executing')

  // Execute steps sequentially with observation
  let recoveryCount = 0
  for (let i = 0; i < state.steps.length; i++) {
    const step = state.steps[i]

    // Check cancellation
    if (ctx.signal?.aborted || state.phase === 'cancelled') {
      updateStepState(step, 'cancelled')
      continue
    }

    // Check step dependencies
    if (step.dependsOn) {
      const deps = step.dependsOn
      const allResolved = deps.every((depIdx) => {
        const dep = state.steps[depIdx]
        return dep && (dep.state === 'verified' || dep.state === 'observed' || dep.state === 'executed')
      })
      if (!allResolved) {
        updateStepState(step, 'skipped')
        step.error = 'Dependency not satisfied.'
        continue
      }
    }

    // Execute the step
    await executeStep(step, ctx, state)

    // If step failed, classify recovery honestly. A deterministic planner cannot
    // produce a genuinely different plan for the same text, so 'replan' here
    // means: record the recovery, keep the failed step failed, and (if budget
    // remains) continue with the remaining steps. It is NEVER a fake success.
    if (step.state === 'failed') {
      const recovery = classifyRecovery({
        errorKind: step.errorKind ?? 'tool_failure',
        retryable: false,
      })

      if (recovery.action === 'stop') {
        transitionPhase(state, 'failed', `Step ${i + 1} failed: ${step.error ?? recovery.reason}`)
        break
      }

      if (recoveryCount >= state.maxRecoveries) {
        transitionPhase(state, 'failed', `Step ${i + 1} failed after exhausting recovery budget: ${step.error ?? recovery.reason}`)
        break
      }

      recoveryCount++
      state.recoveryAttempts = recoveryCount
      step.recoveryAction = recovery.action
      transitionPhase(state, 'replanning', `Step ${i + 1} failed (${recovery.kind}); continuing with remaining steps`)
      continue
    }

    // If step executed successfully, observe and verify
    if (step.state === 'executed') {
      transitionPhase(state, 'observing', `Observing step ${i + 1}`)
      const verified = await observeAndVerify(step, ctx)

      if (!verified && recoveryCount < state.maxRecoveries) {
        transitionPhase(state, 'recovering', `Verification failed for step ${i + 1}`)
        recoveryCount++
        state.recoveryAttempts = recoveryCount
        transitionPhase(state, 'replanning', 'Attempting to continue despite verification failure')
      }
    }
  }

  // Phase: → completed/failed
  const hasFailed = state.steps.some(
    (s) => s.state === 'failed' || s.state === 'verification_failed',
  )
  const allVerified = state.steps.every(
    (s) => s.state === 'verified' || s.state === 'skipped',
  )

  if (hasFailed && !allVerified) {
    transitionPhase(state, 'failed', 'Some steps failed or were not verified.')
  } else if (state.phase !== 'cancelled') {
    transitionPhase(state, 'completed')
  }

  buildFinalResult(state)
  return { state, report: buildReport(state) }
}

/** Cancel a running agentic goal. */
export function cancelAgenticGoal(state: AgenticExecutionState): void {
  transitionPhase(state, 'cancelled', 'User cancelled.')
  for (const step of state.steps) {
    if (step.state !== 'verified' && step.state !== 'failed' && step.state !== 'skipped') {
      updateStepState(step, 'cancelled')
    }
  }
  buildFinalResult(state)
}

/** Build a human-readable execution report. */
export function buildReport(state: AgenticExecutionState): string {
  const lines: string[] = []
  lines.push(`**Goal:** ${state.goal}`)
  lines.push('')

  for (const step of state.steps) {
    const icon =
      step.state === 'verified' ? '[VERIFIED]' :
      step.state === 'observation_failed' || step.state === 'verification_failed' ? '[UNVERIFIED]' :
      step.state === 'failed' ? '[FAILED]' :
      step.state === 'cancelled' ? '[CANCELLED]' :
      step.state === 'skipped' ? '[SKIPPED]' :
      '[EXECUTED]'
    lines.push(`${icon} ${step.description}`)
    if (step.error) lines.push(`  Error: ${step.error}`)
    if (step.verification) lines.push(`  Verification: ${step.verification.message}`)
  }

  lines.push('')
  if (state.finalResult) {
    lines.push(`**Result:** ${state.finalResult.status.toUpperCase()} — ${state.finalResult.summary}`)
  }

  return lines.join('\n')
}
