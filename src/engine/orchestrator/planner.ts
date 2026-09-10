/**
 * Phase 3.0B — deterministic bounded planner.
 *
 * Turns ONE OrchestrationRequest into a small, capability-level plan the
 * EXISTING Phase 2.x execution rails can validate and run. The planner is:
 *
 *  - deterministic — no LLM, no random ordering, no score-based choices;
 *  - bounded — at most ORCHESTRATION_PLAN_LIMITS.maxSteps steps, and only for
 *    classes that genuinely need a device/web call;
 *  - honest — it never invents a capability that is not in
 *    `request.availableCapabilities`, never fabricates a payload the executing
 *    tool would reject, and returns `blocked`/`clarification` verdicts instead
 *    of guessing when nothing concrete can run.
 *
 * Every step names a CAPABILITY id (the orchestrator domain) which
 * `validatePlan` resolves to a registered implementation tool through the
 * normal rails. Explicit device targets survive on each step as `targetDevice`
 * so no silent re-routing can happen between plan and execution.
 */

import type { OrchestrationRequest } from './types'
import type { RequestClass } from './goalUnderstanding'

export interface OrchestrationPlanStep {
  /** Stable within-plan id (`step-1`, `step-2`, …). */
  id: string
  /** The capability id this step runs (resolved to a tool by validatePlan). */
  capability: string
  /** Short honest description of what the step does. */
  description: string
  /** Payload passed to the resolved tool (schema-valid, never invented). */
  payload?: Record<string, unknown>
  /** Same-round dependency (indexes of earlier steps), enforced by the engine. */
  dependsOn?: number[]
  /** Explicit device target preserved from the request, when one exists. */
  targetDevice?: string
}

export type OrchestrationPlanVerdict = 'ok' | 'empty' | 'blocked' | 'clarification'

export interface OrchestrationPlannedRequest {
  goal: string
  verdict: OrchestrationPlanVerdict
  /** Resolved plan steps. Empty when the verdict is not `ok`. */
  steps: OrchestrationPlanStep[]
  /** Human reason for `blocked`/`clarification` verdicts. */
  reason?: string
}

export const ORCHESTRATION_PLAN_LIMITS = {
  /** Hard ceiling for any single orchestrated plan. Bounded by design. */
  maxSteps: 4,
} as const

/** Artifacts the task-context store committed from earlier executions. */
export interface OrchestrationPlanContext {
  /** Most recent committed artifact is first (store unshifts). */
  artifacts?: Array<{ type: string; description: string; value: string }>
}

/* ---------------------------------------------------------------- helpers */

const OPEN_VERBS = /\b(open|launch|start|run)\b/i
const SEARCH_VERBS = /\b(search|look up|find|google|bing|duckduckgo)\b/i
const DOWNLOAD_VERBS = /\b(download|save)\b/i
const BATTERY_INTENT = /\b(battery|charge|health|status of)\b/i
const APP_DEVICE_TARGET = /\s+(?:on|in|at|to)\s+(?:my|the)\s+/i
const APP_SUBSEQUENT = /\s+(?:and|and then|then|so|while)\s+/i

/** Extract a bounded, schema-valid search query from free text. */
export function extractSearchQuery(text: string): string {
  const clean = (text ?? '').replace(/[.!?]+$/g, '').trim()
  const match = clean.match(
    /^(?:please\s+)?(?:search|look up|find|google|bing|duckduckgo)(?:\s+the\s+(?:web|internet))?(?:\s+for)?\s+(.+)$/i,
  )
  return (match ? match[1] : clean).trim()
}

/** Extract a bounded application name after an open/launch/start/run verb. */
export function extractAppName(text: string): string | undefined {
  const t = (text ?? '').replace(/[.!?]+$/g, '').trim()
  const match = t.match(/\b(?:open|launch|start|run)\s+([^,;.]+)/i)
  if (!match) return undefined
  let phrase = match[1]
    .trim()
    .split(APP_DEVICE_TARGET)[0]
    .split(APP_SUBSEQUENT)[0]
    .trim()
  phrase = phrase.replace(/^(?:the|a|an)\s+/i, '').trim()
  phrase = phrase.replace(/^(?:app|application)\s*-?\s*/i, '').trim()
  if (phrase.length === 0) return undefined
  return phrase.toLowerCase()
}

/** Extract a short notification title when a request asks to notify. */
export function extractNotifyTitle(text: string): string | undefined {
  const t = (text ?? '').replace(/[.!?]+$/g, '').trim()
  const match = t.match(
    /\b(?:tell|notify|message|alert)\s+(?:me\s+)?(?:(?:my|the)\s+(?:phone|device|laptop|pc|computer)\s+)?(?:that\s+)?(.+)$/i,
  )
  if (!match) return undefined
  const title = match[1].trim()
  return title.length === 0 ? undefined : title
}

function isUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(value)
}

/** Unicode-safe base64 of a bounded text value for schema-valid transfer payloads. */
function toBase64(value: string): string {
  try {
    return btoa(
      encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
    )
  } catch {
    return value
  }
}

/* ---------------------------------------------------------------- planner */

/**
 * Deterministically derive the bounded plan for one orchestration request.
 * `context` carries the committed task-context artifacts (used ONLY to resolve
 * follow-up requests against real prior results — never guessed).
 */
export function planRequest(
  request: OrchestrationRequest,
  context?: OrchestrationPlanContext,
): OrchestrationPlannedRequest {
  const goal = request.originalText
  const available = new Set(request.availableCapabilities)
  const can = (capability: string): boolean => available.has(capability)
  const text = request.originalText ?? ''

  /** A step can only run while its explicit target is genuinely routable. */
  const targetRoutable = (deviceId: string): boolean => {
    const route = request.targets.find((t) => t.deviceId === deviceId)
    return route ? route.available : true
  }

  const block = (reason: string): OrchestrationPlannedRequest => ({ goal, verdict: 'blocked', steps: [], reason })
  const clarify = (reason: string): OrchestrationPlannedRequest => ({ goal, verdict: 'clarification', steps: [], reason })

  const nonTargetClasses: ReadonlySet<RequestClass> = new Set<RequestClass>([
    'question',
    'conversation',
    'confirmation',
    'cancellation',
  ])
  if (nonTargetClasses.has(request.requestClass)) {
    return { goal, verdict: 'empty', steps: [], reason: 'No capability execution required.' }
  }

  if (request.requestClass === 'status_request') {
    if (!can('list_devices')) {
      return block('No connected capability can list device status right now.')
    }
    return {
      goal,
      verdict: 'ok',
      steps: [
        { id: 'step-1', capability: 'list_devices', description: 'Read the live device registry status.' },
      ],
    }
  }

  if (request.requestClass === 'web_research') {
    if (!can('web_search')) {
      return block('web_search is not available right now (no connected web provider).')
    }
    const query = extractSearchQuery(text)
    return {
      goal,
      verdict: 'ok',
      steps: [
        { id: 'step-1', capability: 'web_search', description: 'Search the web.', payload: { query } },
      ],
    }
  }

  if (request.requestClass === 'device_operation' || request.requestClass === 'command') {
    const target = request.targetDevices[0] ?? request.implicitTargetDevice
    if (target && !targetRoutable(target)) {
      const route = request.targets.find((t) => t.deviceId === target)
      return block(`Target device "${target}" is not routable right now${route?.reason ? `: ${route.reason}` : ''}.`)
    }
    if (OPEN_VERBS.test(text)) {
      const app = extractAppName(text)
      if (app && can('open_application')) {
        return {
          goal,
          verdict: 'ok',
          steps: [
            {
              id: 'step-1',
              capability: 'open_application',
              description: `Launch ${app}.`,
              payload: { application_id: app },
              targetDevice: target,
            },
          ],
        }
      }
      if (app) {
        return block('open_application is not available on any online device right now.')
      }
    }
    if (request.requestClass === 'device_operation' && BATTERY_INTENT.test(text)) {
      if (can('list_devices')) {
        return {
          goal,
          verdict: 'ok',
          steps: [
            {
              id: 'step-1',
              capability: 'list_devices',
              description: 'Read the live device registry (battery/status).',
              targetDevice: target,
            },
          ],
        }
      }
      return block('No connected capability can report device status right now.')
    }
    if (request.requestClass === 'device_operation' && /\b(notify|tell|message)\b/i.test(text)) {
      if (can('send_device_notification')) {
        // device.notify requires BOTH title and message — the planner never
        // emits a payload the executing tool would reject, and never invents a
        // message. Missing text is asked for, not guessed.
        const title = extractNotifyTitle(text)
        if (!title) {
          return clarify('What should the notification say? Please include the message text.')
        }
        return {
          goal,
          verdict: 'ok',
          steps: [
            {
              id: 'step-1',
              capability: 'send_device_notification',
              description: 'Send a short notification to the target device.',
              payload: { title, message: title },
              targetDevice: target,
            },
          ],
        }
      }
      return block('send_device_notification is not available on any online device right now.')
    }
    return block(
      'Recognized a local operation, but no connected capability in this environment can perform it.',
    )
  }

  if (request.requestClass === 'multi_step_goal') {
    const target = request.targetDevices[0] ?? request.implicitTargetDevice
    if (OPEN_VERBS.test(text) && SEARCH_VERBS.test(text) && can('open_application') && can('web_search')) {
      const app = extractAppName(text) ?? 'browser'
      const query = extractSearchQuery(text)
      return {
        goal,
        verdict: 'ok',
        steps: [
          { id: 'step-1', capability: 'open_application', description: `Launch ${app}.`, payload: { application_id: app }, targetDevice: target },
          { id: 'step-2', capability: 'web_search', description: 'Search the web.', payload: { query }, dependsOn: [0] },
        ],
      }
    }
    if (SEARCH_VERBS.test(text) && DOWNLOAD_VERBS.test(text) && can('web_search') && can('web_download')) {
      const query = extractSearchQuery(text)
      // web.download REQUIRES a real `url`, which only exists after a search
      // returns. A two-step search→download plan can embed the URL only when a
      // REAL prior result already committed it (deictic follow-up); without one,
      // the plan runs the search and hands the download back as a follow-up.
      // The planner never emits a payload the executing tool would reject.
      const urlArtifact = context?.artifacts?.find((a) => a.type === 'url' && isUrl(a.value))
      if (urlArtifact) {
        return {
          goal,
          verdict: 'ok',
          steps: [
            { id: 'step-1', capability: 'web_search', description: 'Search the web.', payload: { query } },
            { id: 'step-2', capability: 'web_download', description: 'Download the document.', payload: { url: urlArtifact.value }, dependsOn: [0] },
          ],
        }
      }
      return {
        goal,
        verdict: 'ok',
        steps: [{ id: 'step-1', capability: 'web_search', description: 'Search the web.', payload: { query } }],
        reason: 'The top search result is committed and the download can run as a follow-up.',
      }
    }
    return block('The requested multi-step goal has no fully connected capability sequence right now.')
  }

  if (request.requestClass === 'cross_device_workflow') {
    const target = request.targetDevices[0]
    if (!target) {
      return block('A cross-device workflow needs an explicit target device.')
    }
    if (!targetRoutable(target)) {
      const route = request.targets.find((t) => t.deviceId === target)
      return block(`Target device "${target}" is not routable right now${route?.reason ? `: ${route.reason}` : ''}.`)
    }
    if (can('transfer_to_device')) {
      // device.sendFile requires name AND content. The planner never fabricates
      // a file: only a REAL committed artifact (URL/file from an earlier
      // executed step) can feed the transfer, otherwise it blocks honestly.
      const artifact = context?.artifacts?.[0]
      if (artifact && (artifact.type === 'file' || artifact.type === 'file_ref' || artifact.type === 'url')) {
        return {
          goal,
          verdict: 'ok',
          steps: [
            {
              id: 'step-1',
              capability: 'transfer_to_device',
              description: `Send ${artifact.description} to the target device.`,
              payload: { device: target, name: artifact.description, content: toBase64(artifact.value) },
              targetDevice: target,
            },
          ],
        }
      }
      return block('No committed file content is available to transfer yet — nothing to send.')
    }
    if (can('send_device_notification')) {
      const title = extractNotifyTitle(text)
      if (!title) {
        return block('No transferable file content or notification text is available yet — nothing to send.')
      }
      return {
        goal,
        verdict: 'ok',
        steps: [
          {
            id: 'step-1',
            capability: 'send_device_notification',
            description: 'Notify the target device.',
            payload: { title, message: title },
            targetDevice: target,
          },
        ],
      }
    }
    return block('No transfer/notification capability is connected to any online device.')
  }

  if (request.requestClass === 'follow_up') {
    // Resolve ONLY against a real, committed artifact value — never a guess.
    const artifact = context?.artifacts?.[0]
    if (!artifact || !isUrl(artifact.value) || !can('web_download')) {
      return clarify(
        artifact
          ? 'The referenced result exists but no connected capability can act on it right now.'
          : 'The request refers to a previous result that cannot be resolved — please clarify what to do.',
      )
    }
    return {
      goal,
      verdict: 'ok',
      steps: [
        { id: 'step-1', capability: 'web_download', description: `Download ${artifact.description}.`, payload: { url: artifact.value } },
      ],
    }
  }

  return block(
    request.requiresContext
      ? 'This request needs more context before it can be planned.'
      : 'No deterministic plan exists for this request class in the current environment.',
  )
}