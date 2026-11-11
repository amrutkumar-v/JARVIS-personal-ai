/**
 * Intelligent Error Classification and Recovery (Phase E).
 *
 * Classifies task and subtask execution failures to determine the optimal
 * recovery strategy within bounded recovery budgets.
 */

export type ErrorCategory =
  | 'TRANSIENT_RESOURCE'
  | 'DEPENDENCY_MISSING'
  | 'SYNTAX_LINT_ERROR'
  | 'TEST_FAILURE'
  | 'PERMISSION_DENIED'
  | 'FATAL_UNRECOVERABLE'

export interface ClassifiedError {
  category: ErrorCategory
  message: string
  retryable: boolean
  recommendedAction: 'retry' | 'revert_patch' | 'replan' | 'request_permission' | 'fail'
  delayMs?: number
}

export function classifyTaskError(rawError: unknown): ClassifiedError {
  const message = rawError instanceof Error ? rawError.message : String(rawError ?? 'Unknown error')
  const lower = message.toLowerCase()

  // 1. Permission / Access Denied
  if (
    lower.includes('eacces') ||
    lower.includes('eperm') ||
    lower.includes('permission denied') ||
    lower.includes('access is denied') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden')
  ) {
    return {
      category: 'PERMISSION_DENIED',
      message,
      retryable: false,
      recommendedAction: 'request_permission',
    }
  }

  // 2. Transient resource limits, network drops, or rate limits
  if (
    lower.includes('ebusy') ||
    lower.includes('resource constrained') ||
    lower.includes('timeout') ||
    lower.includes('etimedout') ||
    lower.includes('temporarily unavailable') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('rate limit') ||
    lower.includes('429')
  ) {
    return {
      category: 'TRANSIENT_RESOURCE',
      message,
      retryable: true,
      recommendedAction: 'retry',
      delayMs: 2000,
    }
  }

  // 3. Test failure
  if (
    lower.includes('test failed') ||
    lower.includes('tests failed') ||
    lower.includes('assertionerror') ||
    lower.includes('vitest failed') ||
    lower.includes('jest failed')
  ) {
    return {
      category: 'TEST_FAILURE',
      message,
      retryable: true,
      recommendedAction: 'replan',
    }
  }

  // 4. Syntax / Compile / Typecheck error
  if (
    lower.includes('syntaxerror') ||
    lower.includes('error ts') ||
    lower.includes('cannot find name') ||
    lower.includes('compilation error')
  ) {
    return {
      category: 'SYNTAX_LINT_ERROR',
      message,
      retryable: true,
      recommendedAction: 'revert_patch',
    }
  }

  // 5. Missing dependency
  if (
    lower.includes('not found') ||
    lower.includes('enoent') ||
    lower.includes('module not found') ||
    lower.includes('cannot find module')
  ) {
    return {
      category: 'DEPENDENCY_MISSING',
      message,
      retryable: false,
      recommendedAction: 'replan',
    }
  }

  // Default fatal / unrecoverable
  return {
    category: 'FATAL_UNRECOVERABLE',
    message,
    retryable: false,
    recommendedAction: 'fail',
  }
}

