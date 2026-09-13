import type { CapabilityRisk } from '../../capabilities/types'

export type Phase6VerificationPolicy =
  | 'tool_owned'
  | 'post_action'
  | 'tool_owned_then_post_action'
  | 'none'

export interface Phase6RetryPolicy {
  retryable: boolean
  maxRetries: number
  backoffMs: number
}

export type Phase6FailurePolicy =
  | 'stop'
  | 'continue'
  | 'replan'
  | 'skip_dependents'

export interface Phase6Precondition {
  kind: 'depends_on_success' | 'context_matches'
  sources: number[]
  source?: number
  path?: string
  expect?: unknown
  note?: string
}

export interface Phase6ContextInput {
  name: string
  fromStep: number
  path: string
}

export interface Phase6StepMeta {
  expectedOutcome: string
  verification: Phase6VerificationPolicy
  risk: CapabilityRisk
  retryPolicy?: Phase6RetryPolicy
  failurePolicy: Phase6FailurePolicy
  precondition?: Phase6Precondition
  contextInputs?: Phase6ContextInput[]
}

export interface Phase6PlanMeta {
  planId: string
  goal: string
  intent: string
  assumptions: string[]
  constraints: string[]
  expectedOutcome: string
  verificationStrategy: Phase6VerificationPolicy
  risk: CapabilityRisk
}

export const PHASE6_LIMITS = {
  maxRetries: 3,
  maxBackoffMs: 5000,
  maxContextInputs: 8,
  maxPreconditionSources: 4,
  maxExpectDepth: 6,
} as const

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

export function normalizeRetryPolicy(p: unknown): Phase6RetryPolicy | undefined {
  if (!p || typeof p !== 'object') return undefined
  const raw = p as Record<string, unknown>
  const retryable = raw.retryable === true
  return {
    retryable,
    maxRetries: clampInt(raw.maxRetries, 0, 0, PHASE6_LIMITS.maxRetries),
    backoffMs: clampInt(raw.backoffMs, 80, 0, PHASE6_LIMITS.maxBackoffMs),
  }
}

const VERIFICATION_POLICIES: readonly Phase6VerificationPolicy[] = [
  'tool_owned',
  'post_action',
  'tool_owned_then_post_action',
  'none',
]

const FAILURE_POLICIES: readonly Phase6FailurePolicy[] = [
  'stop',
  'continue',
  'replan',
  'skip_dependents',
]

function sanitizePolicy<T extends string>(
  value: unknown,
  fallback: T,
  allowed: readonly T[],
): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

export function normalizePrecondition(
  p: unknown,
  stepCount: number,
): Phase6Precondition | undefined {
  if (!p || typeof p !== 'object') return undefined
  const raw = p as Record<string, unknown>
  const kind = raw.kind === 'context_matches' ? 'context_matches' : 'depends_on_success'
  const sources = Array.isArray(raw.sources)
    ? raw.sources
        .map((s) => (typeof s === 'number' && Number.isFinite(s) ? Math.floor(s) : -1))
        .filter((s) => s >= 0 && s < stepCount)
        .slice(0, PHASE6_LIMITS.maxPreconditionSources)
    : []
  if (sources.length === 0) return undefined
  const precondition: Phase6Precondition = {
    kind,
    sources,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : undefined,
  }
  if (kind === 'context_matches') {
    const source = typeof raw.source === 'number' ? Math.floor(raw.source) : -1
    if (source < 0 || source >= stepCount) return undefined
    precondition.source = source
    precondition.path = typeof raw.path === 'string' ? raw.path.slice(0, 120) : undefined
    const expect = raw.expect
    precondition.expect = safeExpectValue(expect, 0) ? expect : undefined
    if (precondition.expect === undefined) return undefined
  }
  return precondition
}

function safeExpectValue(value: unknown, depth: number): boolean {
  if (depth > PHASE6_LIMITS.maxExpectDepth) return false
  if (value === null) return true
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return true
  if (Array.isArray(value)) return value.every((v) => safeExpectValue(v, depth + 1))
  if (t === 'object') {
    return Object.values(value as Record<string, unknown>).every((v) => safeExpectValue(v, depth + 1))
  }
  return false
}

export function normalizeContextInputs(
  inputs: unknown,
  stepCount: number,
): Phase6ContextInput[] | undefined {
  if (!Array.isArray(inputs)) return undefined
  const out: Phase6ContextInput[] = []
  for (const raw of inputs) {
    if (out.length >= PHASE6_LIMITS.maxContextInputs) break
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const name = typeof entry.name === 'string' ? entry.name.slice(0, 80) : ''
    const fromStep = typeof entry.fromStep === 'number' ? Math.floor(entry.fromStep) : -1
    const path = typeof entry.path === 'string' ? entry.path.slice(0, 120) : ''
    if (!name || fromStep < 0 || fromStep >= stepCount || !path) continue
    out.push({ name, fromStep, path })
  }
  return out.length > 0 ? out : undefined
}

export function normalizePhase6StepMeta(
  m: unknown,
  stepCount: number,
): Phase6StepMeta | undefined {
  if (!m || typeof m !== 'object') return undefined
  const raw = m as Record<string, unknown>
  const meta: Phase6StepMeta = {
    expectedOutcome:
      typeof raw.expectedOutcome === 'string'
        ? raw.expectedOutcome.slice(0, 300)
        : '',
    verification: sanitizePolicy(raw.verification, 'tool_owned', VERIFICATION_POLICIES),
    risk: sanitizePolicy<CapabilityRisk>(
      raw.risk,
      'low',
      ['read_only', 'low', 'medium', 'high'],
    ),
    failurePolicy: sanitizePolicy(raw.failurePolicy, 'replan', FAILURE_POLICIES),
  }
  const retry = normalizeRetryPolicy(raw.retryPolicy)
  if (retry) meta.retryPolicy = retry
  const precondition = normalizePrecondition(raw.precondition, stepCount)
  if (precondition) meta.precondition = precondition
  const contextInputs = normalizeContextInputs(raw.contextInputs, stepCount)
  if (contextInputs) meta.contextInputs = contextInputs
  return meta
}

export function normalizePhase6PlanMeta(m: Phase6PlanMeta): Phase6PlanMeta {
  return {
    planId: String(m.planId ?? '').slice(0, 64),
    goal: String(m.goal ?? '').slice(0, 300),
    intent: String(m.intent ?? '').slice(0, 200),
    assumptions: Array.isArray(m.assumptions)
      ? m.assumptions.map((a) => String(a).slice(0, 200)).slice(0, 8)
      : [],
    constraints: Array.isArray(m.constraints)
      ? m.constraints.map((c) => String(c).slice(0, 200)).slice(0, 8)
      : [],
    expectedOutcome: String(m.expectedOutcome ?? '').slice(0, 300),
    verificationStrategy: sanitizePolicy(m.verificationStrategy, 'tool_owned', VERIFICATION_POLICIES),
    risk: sanitizePolicy<CapabilityRisk>(
      m.risk,
      'low',
      ['read_only', 'low', 'medium', 'high'],
    ),
  }
}