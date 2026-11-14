/**
 * Cryptographic Action Binding & Approval Verification
 *
 * Implements server-enforced, deterministic binding between high-risk task actions
 * and explicit operator approvals.
 *
 * Each approval is cryptographically bound to:
 * - Task ID
 * - Subtask ID
 * - Canonical capability and action/tool ID
 * - Canonical target resource (path, file, URL)
 * - Deterministically canonicalized argument payload
 * - Server-computed SHA-256 fingerprint
 * - Timestamp, TTL expiry, and operator resolution state
 */

import { createHash } from 'node:crypto'
import type { TaskApproval } from './types.js'

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

/**
 * Normalizes file and resource paths for deterministic fingerprinting across Windows and POSIX.
 */
export function normalizeActionPath(p?: unknown): string {
  if (typeof p !== 'string' || !p.trim()) return ''
  return p.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '')
}

/**
 * Extracts the canonical target/resource from an action payload.
 */
export function extractActionTarget(payload?: Record<string, unknown>): string {
  if (!payload || typeof payload !== 'object') return ''
  const cand =
    payload.projectPath ??
    payload.filePath ??
    payload.path ??
    payload.target ??
    payload.url ??
    payload.file ??
    ''
  return typeof cand === 'string' ? normalizeActionPath(cand) : ''
}

/**
 * Recursively sorts object keys and strips prototype pollution for deterministic canonical serialization.
 */
export function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue)
  }
  const rawObj = value as Record<string, unknown>
  const sortedKeys = Object.keys(rawObj)
    .filter((k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype')
    .sort()
  const result: Record<string, unknown> = {}
  for (const key of sortedKeys) {
    const val = rawObj[key]
    if (val !== undefined) {
      if (typeof val === 'string' && (key.toLowerCase().includes('path') || key === 'target' || key === 'file')) {
        result[key] = normalizeActionPath(val)
      } else {
        result[key] = canonicalizeValue(val)
      }
    }
  }
  return result
}

export interface ActionFingerprintParams {
  taskId: string
  subtaskId: string
  action: string
  capability?: string
  target?: string
  payload?: Record<string, unknown>
}

/**
 * Computes a deterministic SHA-256 fingerprint for an action and its full context.
 * Never trust client-supplied fingerprints; the server must always compute this.
 */
export function computeActionFingerprint(params: ActionFingerprintParams): string {
  const target = params.target || extractActionTarget(params.payload)
  const canonical = {
    taskId: params.taskId || '',
    subtaskId: params.subtaskId || '',
    action: (params.action || '').trim().toLowerCase(),
    capability: (params.capability || '').trim().toLowerCase(),
    target: normalizeActionPath(target),
    payload: canonicalizeValue(params.payload || {}),
  }
  const canonicalJson = JSON.stringify(canonical)
  return createHash('sha256').update(canonicalJson).digest('hex')
}

export interface ApprovalVerificationResult {
  valid: boolean
  approval?: TaskApproval
  reason?:
    | 'missing'
    | 'task_mismatch'
    | 'subtask_mismatch'
    | 'action_mismatch'
    | 'target_mismatch'
    | 'fingerprint_mismatch'
    | 'not_granted'
    | 'rejected'
    | 'revoked'
    | 'consumed'
    | 'expired'
}

/**
 * Verifies that a valid, operator-granted approval exists for this exact action immediately before execution.
 * Checks task binding, subtask binding, capability, target, fingerprint, expiry, revocation, and consumption.
 */
export function verifyApprovalForAction(
  approvals: TaskApproval[],
  params: ActionFingerprintParams,
  now = Date.now(),
): ApprovalVerificationResult {
  if (!approvals || !Array.isArray(approvals) || approvals.length === 0) {
    return { valid: false, reason: 'missing' }
  }

  const expectedFingerprint = computeActionFingerprint(params)
  const target = normalizeActionPath(params.target || extractActionTarget(params.payload))

  // Find candidate approvals bound to this specific task and subtask (or matching legacy ID)
  const candidates = approvals.filter(
    (a) =>
      (!a.taskId || a.taskId === params.taskId) &&
      (!a.subtaskId || a.subtaskId === params.subtaskId || a.id === params.subtaskId)
  )

  if (candidates.length === 0) {
    return { valid: false, reason: 'missing' }
  }

  // Iterate to find any candidate that satisfies all security criteria
  for (const candidate of candidates) {
    // 1. Task binding check
    if (candidate.taskId && candidate.taskId !== params.taskId) continue

    // 2. Subtask binding check (a grant for subtask-1 must not authorize subtask-2)
    if (candidate.subtaskId && candidate.subtaskId !== params.subtaskId && candidate.id !== params.subtaskId) continue

    // 3. Revocation check
    if (candidate.revoked === true) continue

    // 4. One-time consumption check (cannot reuse already-executed approval)
    if (candidate.consumed === true) continue

    // 5. Operator decision check
    if (candidate.granted === false) continue
    if (candidate.granted !== true) continue

    // 6. Expiry check
    if (candidate.expiresAt && candidate.expiresAt <= now) continue
    if (candidate.resolvedAt && (now - candidate.resolvedAt) > APPROVAL_TTL_MS) continue

    // 7. Cryptographic Fingerprint matching
    if (candidate.fingerprint) {
      if (candidate.fingerprint !== expectedFingerprint) continue
    } else {
      // If legacy approval lacked fingerprint, require exact target and payload identity
      if (candidate.target && target && normalizeActionPath(candidate.target) !== target) continue
    }

    return { valid: true, approval: candidate }
  }

  // If no candidate was valid, determine and return the most specific failure reason
  const candidate = candidates[candidates.length - 1]
  if (candidate.taskId && candidate.taskId !== params.taskId) {
    return { valid: false, approval: candidate, reason: 'task_mismatch' }
  }
  if (candidate.subtaskId && candidate.subtaskId !== params.subtaskId) {
    return { valid: false, approval: candidate, reason: 'subtask_mismatch' }
  }
  if (candidate.revoked === true) {
    return { valid: false, approval: candidate, reason: 'revoked' }
  }
  if (candidate.consumed === true) {
    return { valid: false, approval: candidate, reason: 'consumed' }
  }
  if (candidate.granted === false) {
    return { valid: false, approval: candidate, reason: 'rejected' }
  }
  if (candidate.granted !== true) {
    return { valid: false, approval: candidate, reason: 'not_granted' }
  }
  if ((candidate.expiresAt && candidate.expiresAt <= now) || (candidate.resolvedAt && (now - candidate.resolvedAt) > APPROVAL_TTL_MS)) {
    return { valid: false, approval: candidate, reason: 'expired' }
  }
  if (candidate.fingerprint && candidate.fingerprint !== expectedFingerprint) {
    return { valid: false, approval: candidate, reason: 'fingerprint_mismatch' }
  }
  if (candidate.target && target && normalizeActionPath(candidate.target) !== target) {
    return { valid: false, approval: candidate, reason: 'target_mismatch' }
  }

  return { valid: false, approval: candidate, reason: 'action_mismatch' }
}
