import type { ExecutionArtifact, ExecutionContext, ExecutionOutcome, ActionKind, ExecutionErrorEntry } from './types'

/**
 * Phase 2.6 — bounded, conversation-scoped execution context (§13).
 *
 * Stores the deterministic record of a few recent runs per conversation so
 * follow-ups ("do it", "now open the PDF") resolve against what REALLY
 * happened. In-memory only: nothing here touches storage, and stale contexts
 * expire on read.
 */

export const EXECUTION_CONTEXT_TTL_MS = 15 * 60_000
export const MAX_ARTIFACTS_PER_CONTEXT = 24
export const MAX_CONTEXTS_PER_CONVERSATION = 6

let runCounter = 0
let executionCounter = 0

export function nextRunId(): string {
  runCounter += 1
  return `run-${Date.now().toString(36)}-${runCounter}`
}

export function nextExecutionId(): string {
  executionCounter += 1
  return `exec-${Date.now().toString(36)}-${executionCounter}`
}

interface BeginOptions {
  conversationId?: string
  requestText: string
  resolvedText?: string
}

const PATH_RE = /\b(?:[A-Za-z]:[\\/][^\s"',;]*|[\\/][A-Za-z0-9_.@ -]+[\\/][^\s"',;]*|[^\s]+\.[A-Za-z0-9]{1,8})\b/g

/**
 * Pull bounded file-style artifacts out of structured tool output. Walks only
 * arrays/plain objects and keys that name paths/files; caps the result.
 */
export function extractFileArtifacts(outputs: readonly unknown[]): ExecutionArtifact[] {
  const out: ExecutionArtifact[] = []
  const seen = new Set<string>()
  const visited = new Set<unknown>()
  const push = (path: string, source: string): void => {
    const normalized = path.trim()
    if (!normalized || seen.has(normalized) || out.length >= MAX_ARTIFACTS_PER_CONTEXT) return
    seen.add(normalized)
    out.push({
      id: `art-${out.length + 1}`,
      kind: 'file',
      label: normalized.split(/[\\/]/).pop() ?? normalized,
      path: normalized,
      summary: `Referenced by ${source}`,
    })
  }

  const walk = (value: unknown): void => {
    if (out.length >= MAX_ARTIFACTS_PER_CONTEXT || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      const joined = (value as unknown[]).join(' ')
      for (const match of joined.match(PATH_RE) ?? []) push(match, 'list')
      for (const item of value) walk(item)
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const k = key.toLowerCase()
        if (typeof item === 'string') {
          if (k.includes('path') || k.includes('file') || k === 'name' || k === 'uri') push(item, k)
        } else if (Array.isArray(item)) {
          for (const match of item.join(' ').match(PATH_RE) ?? []) push(match, `entries.${key}`)
        }
        walk(item)
      }
    }
  }

  for (const o of outputs) walk(o)
  return out
}

/** Deterministic terminal-outcome classification for the execution record.
 * Never over-claims: refuted or unverified steps can never produce a plain
 * `completed` verdict. */
export function classifyExecutionOutcome(opts: {
  finalState: string
  executedSteps: number
  failedSteps: number
  verifiedSteps: number
  refutedSteps: number
  unverifiedSteps: number
}): ExecutionOutcome {
  const { finalState, executedSteps, failedSteps, verifiedSteps, refutedSteps, unverifiedSteps } = opts
  if (finalState === 'cancelled') return 'cancelled'
  if (finalState === 'failed') return 'failed'
  if (executedSteps === 0) return 'completed'
  const unproven = (refutedSteps + unverifiedSteps) > 0
  if (failedSteps > 0 && verifiedSteps > 0) return 'partial'
  if (failedSteps > 0) return 'failed'
  if (unproven && verifiedSteps > 0) return 'partial'
  if (unproven) return 'unverified'
  return 'completed'
}

/**
 * In-memory store of recent execution contexts scoped by conversation.
 * Bounded per conversation and TTL-expired on access. The engine commits one
 * record per terminal path (real run, or a deterministic clarification/
 * unsupported/refused answer).
 */
export class ExecutionContextStore {
  private readonly byConversation = new Map<string, ExecutionContext[]>()
  private readonly ttlMs: number

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? EXECUTION_CONTEXT_TTL_MS
  }

  /** Build a fresh, NOT-YET-COMMITTED context shell for a new run. */
  begin(opts: BeginOptions): ExecutionContext {
    return {
      runId: nextRunId(),
      requestId: nextExecutionId(),
      executionId: nextExecutionId(),
      conversationId: opts.conversationId,
      requestedAt: Date.now(),
      requestText: opts.requestText,
      resolvedText: opts.resolvedText,
      actionKind: 'informational',
      matchedTools: [],
      matchedCapabilities: [],
      artifacts: [],
      executedSteps: 0,
      verifiedSteps: 0,
      refutedSteps: 0,
      unverifiedSteps: 0,
      errors: [],
      outcome: 'info_answer',
      terminalStatus: 'idle',
    }
  }

  /** Commit a fully-populated run record (replaces any pending shell). */
  commit(ctx: ExecutionContext): void {
    const key = ctx.conversationId ?? ''
    const bucket = this.byConversation.get(key) ?? []
    bucket.push(ctx)
    while (bucket.length > MAX_CONTEXTS_PER_CONVERSATION) bucket.shift()
    this.byConversation.set(key, bucket)
  }

  /** Most recent committed context for a conversation (may be stale). */
  lastFor(conversationId?: string): ExecutionContext | undefined {
    const bucket = this.byConversation.get(conversationId ?? '')
    if (!bucket || bucket.length === 0) return undefined
    return bucket[bucket.length - 1]
  }

  isStale(ctx: ExecutionContext | undefined, now?: number): boolean {
    if (!ctx) return true
    return (now ?? Date.now()) - ctx.requestedAt > this.ttlMs
  }

  /** Drop expired contexts so memory stays bounded. */
  expire(now?: number): void {
    const at = now ?? Date.now()
    for (const [key, bucket] of this.byConversation) {
      if (bucket.length === 0) {
        this.byConversation.delete(key)
        continue
      }
      this.byConversation.set(key, bucket.filter((c) => at - c.requestedAt <= this.ttlMs))
    }
  }

  size(): number {
    let n = 0
    for (const bucket of this.byConversation.values()) n += bucket.length
    return n
  }
}

/** Re-export for the engine's convenience (bounded error/verification counts). */
export interface ExecutionRunFacts {
  actionKind: ActionKind
  outcome: ExecutionOutcome
  matchedTools: string[]
  matchedCapabilities: string[]
  artifacts: ExecutionArtifact[]
  errors: ExecutionErrorEntry[]
  executedSteps: number
  verifiedSteps: number
  refutedSteps: number
  unverifiedSteps: number
  terminalStatus: string
  requestedAt: number
  conversationId?: string
  requestText: string
  resolvedText?: string
}

/** Fill a begun context shell with real run facts and commit it. */
export function fillExecutionContext(shell: ExecutionContext, facts: ExecutionRunFacts): ExecutionContext {
  return {
    ...shell,
    actionKind: facts.actionKind,
    outcome: facts.outcome,
    matchedTools: facts.matchedTools,
    matchedCapabilities: facts.matchedCapabilities,
    artifacts: facts.artifacts.slice(0, MAX_ARTIFACTS_PER_CONTEXT),
    errors: facts.errors.slice(0, 12),
    executedSteps: facts.executedSteps,
    verifiedSteps: facts.verifiedSteps,
    refutedSteps: facts.refutedSteps,
    unverifiedSteps: facts.unverifiedSteps,
    terminalStatus: facts.terminalStatus,
    conversationId: facts.conversationId ?? shell.conversationId,
    requestText: facts.requestText,
    resolvedText: facts.resolvedText,
  }
}