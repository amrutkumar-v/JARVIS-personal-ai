/**
 * Phase 3.0 — Goal Understanding
 *
 * Classifies a user request into a high-level class and produces a structured
 * understanding (target devices, suggested capabilities, context needs) for
 * the orchestrator. Deterministic: every branch is rule-based and stateless.
 */

import { TRUSTED_DEVICES, TRUSTED_DEVICE_ORDER, resolveDeviceTarget } from '../../device/trusted'
import type { DeviceRecord } from '../../backend/types'

/** High-level classification of a user request. */
export type RequestClass =
  | 'question'
  | 'command'
  | 'multi_step_goal'
  | 'device_operation'
  | 'cross_device_workflow'
  | 'web_research'
  | 'conversation'
  | 'follow_up'
  | 'clarification'
  | 'cancellation'
  | 'confirmation'
  | 'status_request'

/** Structured understanding of a user request. */
export interface RequestUnderstanding {
  /** Primary classification of the request. */
  class: RequestClass
  /** Confidence in the classification (0-1). */
  confidence: number
  /** Canonical trusted device ids derived from the request. */
  targetDevices: string[]
  /** Primary intent verb, when detectable. */
  intent?: string
  /** Extracted entities/parameters. */
  entities: Record<string, unknown>
  /** Whether this request depends on prior task context. */
  requiresContext: boolean
  /** Capabilities suggested to fulfill the request. */
  suggestedCapabilities: string[]
  /** Whether this continues a previous task. */
  isContinuation: boolean
  /** Context reference when this is a follow-up. */
  contextReference?: string
  /** Human-readable explanation of the understanding. */
  explanation: string
}

/** Anchored patterns for short-form classes (avoid substring false positives). */
const CONVERSATION_PATTERNS = [
  /^(hi|hello|hey|good morning|good evening|good afternoon)\b/i,
  /^(how are you|how is it going|what's up)\b/i,
  /^(thanks|thank you|thx)\b/i,
  /^(bye|goodbye|see you)\b/i,
  /^(ok|okay|sure|yeah|yep|nope)\b/i,
]

const CANCELLATION_PATTERNS = [/^(stop|cancel|abort|halt)\b/i, /^never ?mind\b/i]

const CONFIRMATION_PATTERNS = [/^(yes|yeah|yep|confirm|ok|okay|sure|do it|go ahead)\b/i]

const STATUS_PATTERNS = [
  /^(what|which) (devices?|phones?|laptops?|computers?|pcs?) (are|is) (connected|online|available)/i,
  /^(show|list|status of) (devices?|phones?|laptops?)/i,
]

/** Longer phrases used with substring matching for the intentional classes. */
const COMMAND_VERBS = [
  'open', 'close', 'launch', 'start', 'stop', 'restart', 'reboot',
  'create', 'delete', 'remove', 'move', 'copy', 'rename',
  'install', 'uninstall', 'update', 'upgrade',
  'send', 'transfer', 'push', 'notify',
  'turn on', 'turn off', 'enable', 'disable',
  'set', 'change', 'adjust', 'configure',
  'take', 'capture', 'screenshot',
]

const MULTI_STEP_PATTERNS = [
  'and then', 'then', 'after that', 'once done', 'when finished',
  'find and', 'search and', 'get and',
]

const DEVICE_OPERATION_PATTERNS = [
  'on my', 'on victus', 'on dell', 'on s26', 'on s23',
  'on phone', 'on laptop', 'on computer', 'on pc', 'to my',
]

const CROSS_DEVICE_PATTERNS = [
  'send to', 'transfer to', 'push to', 'copy to', 'move to',
  'sync to', 'share to', 'save to',
]

const WEB_RESEARCH_PATTERNS = [
  'search', 'look up', 'find', 'google', 'bing', 'duckduckgo',
  'latest', 'current', 'recent', 'news about', 'documentation for',
  'official site', 'official website',
]

const TRANSFER_VERBS = ['send', 'transfer', 'push', 'share']

const DEICTIC_PATTERNS = [
  /\b(?:it|that|them|those|there|here|this)\b/i,
  /\bthe (?:file|result|document|thing)\b/i,
]

const QUESTION_START = /^(what|why|when|where|who|which|how|is|are|do you|does|did you|can you|could you|would you|will you)\b/i

/** Word-boundary phrase containment (matches trusted.ts semantics). */
function includesPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`)
  return pattern.test(text)
}

/** Substring match against any of the given phrases. */
function matchesAny(text: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => text.includes(p))
}

/**
 * Extract canonical trusted device ids from text. Uses the single source of
 * truth for identity (src/device/trusted.ts) and never fabricates a match.
 */
function extractTargetDevices(text: string, devices: DeviceRecord[]): string[] {
  const lower = text.toLowerCase()
  const found = new Set<string>()

  for (const def of TRUSTED_DEVICES) {
    for (const alias of def.aliases) {
      if (includesPhrase(lower, alias)) {
        const res = resolveDeviceTarget(alias)
        if (res.target) found.add(res.target)
      }
    }
  }

  for (const device of devices) {
    if (includesPhrase(lower, device.id)) {
      const res = resolveDeviceTarget(device.id)
      if (res.target) found.add(res.target)
    }
    if (device.name && includesPhrase(lower, device.name.toLowerCase())) {
      const res = resolveDeviceTarget(device.name)
      if (res.target) found.add(res.target)
    }
  }

  return [...found].sort(
    (a, b) => TRUSTED_DEVICE_ORDER.indexOf(a) - TRUSTED_DEVICE_ORDER.indexOf(b)
  )
}

/** Resolve canonical ids and report anything unresolved/ambiguous. */
function resolveTargets(
  targets: readonly string[]
): { resolved: string[]; ambiguous: string[]; errors: string[] } {
  const resolved: string[] = []
  const ambiguous: string[] = []
  const errors: string[] = []

  for (const target of targets) {
    const res = resolveDeviceTarget(target)
    if (res.target) resolved.push(res.target)
    else if (res.ambiguous) ambiguous.push(target)
    else errors.push(`Unknown device: ${target}`)
  }

  return { resolved, ambiguous, errors }
}

/** Filter the suggested capabilities down to what is actually available. */
function inferRequiredCapabilities(
  suggested: readonly string[],
  available: readonly string[]
): string[] {
  const required = new Set<string>(suggested)
  return Array.from(required).filter((c) => available.includes(c))
}

/** Classify a request into a high-level class. */
function classifyRequestClass(
  text: string,
  devices: DeviceRecord[],
  hasActiveTask: boolean,
  lastTaskContext?: { artifacts?: Array<{ type: string; description: string; value: string }> }
): RequestUnderstanding {
  const lower = text.toLowerCase().trim()

  if (!lower) {
    return {
      class: 'question',
      confidence: 0,
      targetDevices: [],
      entities: {},
      requiresContext: false,
      suggestedCapabilities: [],
      isContinuation: false,
      explanation: 'Empty request.',
    }
  }

  if (CANCELLATION_PATTERNS.some((p) => p.test(lower))) {
    return {
      class: 'cancellation',
      confidence: 0.95,
      targetDevices: [],
      entities: {},
      requiresContext: false,
      suggestedCapabilities: [],
      isContinuation: false,
      explanation: 'User requested cancellation.',
    }
  }

  if (CONFIRMATION_PATTERNS.some((p) => p.test(lower))) {
    return {
      class: 'confirmation',
      confidence: 0.9,
      targetDevices: [],
      entities: {},
      requiresContext: hasActiveTask,
      suggestedCapabilities: [],
      isContinuation: hasActiveTask,
      explanation: 'User confirmed a pending action.',
    }
  }

  if (STATUS_PATTERNS.some((p) => p.test(lower))) {
    return {
      class: 'status_request',
      confidence: 0.9,
      targetDevices: [],
      entities: {},
      requiresContext: false,
      suggestedCapabilities: ['list_devices'],
      isContinuation: false,
      explanation: 'User requested device status.',
    }
  }

  if (CONVERSATION_PATTERNS.some((p) => p.test(lower))) {
    return {
      class: 'conversation',
      confidence: 0.85,
      targetDevices: [],
      entities: {},
      requiresContext: false,
      suggestedCapabilities: [],
      isContinuation: false,
      explanation: 'Conversational greeting or acknowledgment.',
    }
  }

  const targetDevices = extractTargetDevices(lower, devices)

  if (matchesAny(lower, CROSS_DEVICE_PATTERNS) || (targetDevices.length > 0 && matchesAny(lower, TRANSFER_VERBS))) {
    return {
      class: 'cross_device_workflow',
      confidence: 0.85,
      intent: 'transfer',
      targetDevices,
      entities: { action: 'transfer' },
      requiresContext: true,
      suggestedCapabilities: ['device_transfer', 'file_read', 'web_download'],
      isContinuation: hasActiveTask,
      explanation: 'Cross-device file transfer workflow detected.',
    }
  }

  if (matchesAny(lower, DEVICE_OPERATION_PATTERNS) || targetDevices.length > 0) {
    const isWebRelated = matchesAny(lower, WEB_RESEARCH_PATTERNS)
    const movesWebContent = matchesAny(lower, ['save', 'download', 'send', 'transfer'])

    if (isWebRelated && movesWebContent) {
      return {
        class: 'cross_device_workflow',
        confidence: 0.8,
        intent: 'web_to_device',
        targetDevices,
        entities: { action: 'web_to_device' },
        requiresContext: false,
        suggestedCapabilities: ['web_search', 'web_fetch', 'web_download', 'file_write', 'device_transfer'],
        isContinuation: false,
        explanation: 'Web research with device output detected.',
      }
    }

    return {
      class: 'device_operation',
      confidence: 0.8,
      intent: 'device_operation',
      targetDevices,
      entities: {},
      requiresContext: false,
      suggestedCapabilities: ['app_launch', 'file_operation', 'device_notify'],
      isContinuation: false,
      explanation: 'Device-specific operation detected.',
    }
  }

  if (matchesAny(lower, MULTI_STEP_PATTERNS)) {
    return {
      class: 'multi_step_goal',
      confidence: 0.75,
      intent: 'multi_step',
      targetDevices,
      entities: {},
      requiresContext: false,
      suggestedCapabilities: ['web_search', 'web_fetch', 'web_download', 'file_write', 'device_transfer'],
      isContinuation: false,
      explanation: 'Multi-step goal with sequential operations detected.',
    }
  }

  const isQuestionForm = QUESTION_START.test(text.trim()) || text.trim().endsWith('?')
  if (!isQuestionForm && DEICTIC_PATTERNS.some((p) => p.test(lower))) {
    const hasContext = hasActiveTask && (lastTaskContext?.artifacts?.length ?? 0) > 0
    const artifact = lastTaskContext?.artifacts?.[0]
    return {
      class: 'follow_up',
      confidence: hasContext ? 0.75 : 0.6,
      targetDevices: [],
      entities: hasContext && artifact
        ? { reference: 'previous_task_result', description: artifact.description }
        : { reference: 'unresolved_reference' },
      requiresContext: true,
      suggestedCapabilities: [],
      isContinuation: true,
      contextReference: hasContext ? 'previous_task_result' : 'unresolved_reference',
      explanation: hasContext
        ? 'Deictic follow-up referencing the previous task result.'
        : 'Deictic follow-up requiring prior context; no device target fabricated.',
    }
  }

  if (matchesAny(lower, WEB_RESEARCH_PATTERNS)) {
    return {
      class: 'web_research',
      confidence: 0.85,
      intent: 'search',
      targetDevices,
      entities: { query: text },
      requiresContext: false,
      suggestedCapabilities: ['web_search', 'web_fetch'],
      isContinuation: false,
      explanation: 'Web search/research request detected.',
    }
  }

  const verb = COMMAND_VERBS.find((v) => lower.includes(v))
  if (verb) {
    return {
      class: 'command',
      confidence: 0.7,
      intent: verb,
      targetDevices,
      entities: { verb },
      requiresContext: false,
      suggestedCapabilities: [],
      isContinuation: false,
      explanation: 'Direct command detected.',
    }
  }

  if (QUESTION_START.test(text.trim()) || text.trim().endsWith('?')) {
    return {
      class: 'question',
      confidence: 0.8,
      intent: 'question',
      targetDevices: [],
      entities: { query: text },
      requiresContext: false,
      suggestedCapabilities: ['web_search', 'system_info', 'memory_recall'],
      isContinuation: false,
      explanation: 'Question detected.',
    }
  }

  if (hasActiveTask) {
    return {
      class: 'follow_up',
      confidence: 0.7,
      targetDevices,
      entities: { reference: 'active_task_context' },
      requiresContext: true,
      suggestedCapabilities: [],
      isContinuation: true,
      contextReference: 'active_task_context',
      explanation: 'Continuation of the active task detected.',
    }
  }

  return {
    class: 'question',
    confidence: 0.4,
    targetDevices: [],
    entities: { raw: text },
    requiresContext: false,
    suggestedCapabilities: ['web_search'],
    isContinuation: false,
    explanation: 'Unrecognized request, defaulting to question handling.',
  }
}

/**
 * Understand a user request in context (main entry).
 */
export function understandRequest(
  text: string,
  context: {
    devices: DeviceRecord[]
    hasActiveTask: boolean
    lastTaskContext?: {
      artifacts?: Array<{ type: string; description: string; value: string }>
      lastPlan?: { steps?: Array<{ capability: string }> }
    }
    availableCapabilities: string[]
  }
): RequestUnderstanding {
  const understanding = classifyRequestClass(
    text,
    context.devices,
    context.hasActiveTask,
    context.lastTaskContext
  )
  const requiredCapabilities = inferRequiredCapabilities(
    understanding.suggestedCapabilities,
    context.availableCapabilities
  )
  const { resolved } = resolveTargets(understanding.targetDevices)

  return {
    ...understanding,
    suggestedCapabilities: requiredCapabilities,
    targetDevices: resolved.length > 0 ? resolved : understanding.targetDevices,
  }
}