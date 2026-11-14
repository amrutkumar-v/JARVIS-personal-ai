/**
 * Productivity Action Confirmation Manager (Phase 9).
 *
 * Implements a strict two-phase confirmation protocol for external and
 * destructive actions (e.g., sending emails, deleting calendar events,
 * committing/discarding git changes).
 *
 * Single-use tokens expire after a 5-minute TTL.
 */

import type { ConfirmationRequest, ConfirmationResult } from './types'

export class ConfirmationManager {
  private readonly pendingRequests = new Map<string, ConfirmationRequest>()
  private readonly ttlMs: number

  constructor(ttlMs: number = 5 * 60 * 1000) {
    this.ttlMs = ttlMs
  }

  /**
   * Request confirmation for a dangerous or external-facing operation.
   */
  requestConfirmation(
    action: ConfirmationRequest['action'],
    summary: string,
    target: string,
    payload: Record<string, unknown>,
  ): ConfirmationResult {
    this.cleanupExpired()

    const id = this.generateToken()
    const now = Date.now()
    const request: ConfirmationRequest = {
      id,
      action,
      summary,
      target,
      payload,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    }

    this.pendingRequests.set(id, request)

    return {
      requiresConfirmation: true,
      confirmationToken: id,
      prompt: `Confirmation required for ${action}: ${summary}. To proceed, provide confirmationToken="${id}".`,
      request,
    }
  }

  /**
   * Verify and consume a confirmation token.
   * Single-use: once verified, the token is permanently removed.
   */
  verifyAndConsume(
    token: string,
    expectedAction: ConfirmationRequest['action'],
  ): { valid: boolean; error?: string; request?: ConfirmationRequest } {
    this.cleanupExpired()

    if (!token || typeof token !== 'string') {
      return { valid: false, error: 'Missing confirmation token.' }
    }

    const req = this.pendingRequests.get(token)
    if (!req) {
      return { valid: false, error: 'Invalid or expired confirmation token.' }
    }

    if (req.action !== expectedAction) {
      return {
        valid: false,
        error: `Confirmation token action mismatch: expected "${expectedAction}", got "${req.action}".`,
      }
    }

    if (Date.now() > req.expiresAt) {
      this.pendingRequests.delete(token)
      return { valid: false, error: 'Confirmation token has expired.' }
    }

    // Valid: consume immediately (single-use)
    this.pendingRequests.delete(token)
    return { valid: true, request: req }
  }

  /**
   * List currently pending confirmation requests (active, unexpired).
   */
  listPending(): ConfirmationRequest[] {
    this.cleanupExpired()
    return Array.from(this.pendingRequests.values())
  }

  /**
   * Cancel / revoke a pending confirmation request.
   */
  cancel(token: string): boolean {
    return this.pendingRequests.delete(token)
  }

  /**
   * Clear all pending confirmation requests.
   */
  clear(): void {
    this.pendingRequests.clear()
  }

  private cleanupExpired(): void {
    const now = Date.now()
    for (const [id, req] of this.pendingRequests.entries()) {
      if (now > req.expiresAt) {
        this.pendingRequests.delete(id)
      }
    }
  }

  private generateToken(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return `cnf_${globalThis.crypto.randomUUID().replace(/-/g, '')}`
    }
    const rand = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    return `cnf_${Date.now().toString(36)}_${rand}`
  }
}

