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
import type { Phase6PlanMeta, Phase6StepMeta } from './phase6/planTypes'
import { buildPhase6PlanMeta, buildPhase6StepMeta } from './phase6/enrich'

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
  /** Phase 6 — application-decided metadata (expected outcome, verification
   * policy, risk placeholder, failure/retry policy, precondition). Enriched by
   * the engine with the REAL resolved-tool risk/retry before execution. */
  meta?: Phase6StepMeta
}

export type OrchestrationPlanVerdict = 'ok' | 'empty' | 'blocked' | 'clarification'

export interface OrchestrationPlannedRequest {
  goal: string
  verdict: OrchestrationPlanVerdict
  /** Resolved plan steps. Empty when the verdict is not `ok`. */
  steps: OrchestrationPlanStep[]
  /** Human reason for `blocked`/`clarification` verdicts. */
  reason?: string
  /** Phase 6 — bounded goal-level plan metadata (plan id, intent,
   * assumptions, constraints, expected outcome, verification strategy). */
  phase6?: Phase6PlanMeta
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
const TYPE_VERBS = /\b(type|write|enter|input)\b/i
const CLIPBOARD_VERBS = /\b(clipboard|copy(?:ed)?|paste|cut)\b/i
const CLOSE_VERBS = /\b(close|quit|exit|terminate|kill)\b/i
const VERIFY_VERBS = /\b(verify|check|confirm|validate|ensure)\b/i
const INTRO_INTENT = /\bintroduce (?:yourself|me to yourself)\b/i
const INTRO_WRITTEN = /\b(written|typed|in\s+text|as\s+text|in\s+writing)\b/i

/** "is chrome running?" / "are notepad and calc open?" — read-only app-status questions. */
const STATUS_IS_APP = /\b(?:is|are)\s+(?:the\s+)?([a-z0-9][\w .-]{0,48}?)\s+(?:running|open|started|launched|active)$/i
const STATUS_CHECK_APP = /\b(?:check|verify|confirm|status\s+of)\s+(?:the\s+)?([a-z0-9][\w .-]{0,48})\b/i

/** Well-known user folders the native agent may open inside Explorer (bounded, curated). */
const FOLDER_TARGETS: ReadonlyArray<readonly [string, string]> = [
  ['downloads', '{userprofile}\\Downloads'],
  ['documents', '{userprofile}\\Documents'],
  ['document', '{userprofile}\\Documents'],
  ['desktop', '{userprofile}\\Desktop'],
  ['pictures', '{userprofile}\\Pictures'],
  ['picture', '{userprofile}\\Pictures'],
  ['music', '{userprofile}\\Music'],
  ['videos', '{userprofile}\\Videos'],
  ['video', '{userprofile}\\Videos'],
  ['workspace', '{workspace}'],
  ['temp', '{temp}'],
]

/** Nouns that must NEVER be flattened into an application id by the planner. */
const FILE_OR_FOLDER_NOUN = /\b(folder|directory|file|downloads?|documents?|desktop|pictures?|music|videos?|workspace|temp|report|pdf|sheet|slides|notes|backup|archive)\b/i

/** Resolve "open my downloads folder" to a curated, native-expandable folder
 * token (never a raw path, never user-text forwarded as a path). */
export function extractFolderTarget(text: string): { name: string; folder: string } | undefined {
  const t = (text ?? '').replace(/[.!?]+$/g, '').trim()
  if (!OPEN_VERBS.test(t)) return undefined
  const lower = t.toLowerCase()
  for (const [noun, folder] of FOLDER_TARGETS) {
    if (new RegExp(`\\b(?:my\\s+|the\\s+|my\\s+the\\s+)?${noun}(?:\\s+(?:folder|directory|dir))?\\b`, 'i').test(lower)) {
      return { name: noun, folder }
    }
  }
  return undefined
}

/** True when a phrase refers to a file/folder target that must not become an app id. */
export function isFileOrFolderTarget(phrase: string): boolean {
  return FILE_OR_FOLDER_NOUN.test(phrase)
}

/** Extract the application a status question asks about ("chrome", "visual studio code"). */
export function extractStatusTarget(text: string): string | undefined {
  const t = (text ?? '').replace(/[.!?]+$/g, '').trim()
  const isMatch = t.match(STATUS_IS_APP)
  const checkMatch = t.match(STATUS_CHECK_APP)
  const phrase = (isMatch?.[1] ?? checkMatch?.[1] ?? '').trim()
  if (phrase.length === 0 || isFileOrFolderTarget(phrase) || NOT_AN_APP.test(phrase)) return undefined
  return phrase.toLowerCase()
}

/** True when the request also carries an ACTION verb — those are compound
 * requests (launch X and verify, check the battery, type to clipboard) that the
 * command / multi-step branches own. Only a PURE application-status question
 * gets the read-only application_status step. */
function hasStatusBlockingIntent(text: string): boolean {
  return (
    OPEN_VERBS.test(text) ||
    CLOSE_VERBS.test(text) ||
    TYPE_VERBS.test(text) ||
    SEARCH_VERBS.test(text) ||
    DOWNLOAD_VERBS.test(text) ||
    BATTERY_INTENT.test(text) ||
    CLIPBOARD_VERBS.test(text)
  )
}

/** Words that are NOT application names, even after a check/verify lead-in. */
const NOT_AN_APP = /^(it|this|that|them|those|these|you|me|its|there|something|anything)$/i

/** True when the request is a read-only "is X running/status" question. */
export function isStatusRequest(text: string): boolean {
  const t = (text ?? '').replace(/[.!?]+$/g, '').trim()
  if (hasStatusBlockingIntent(t)) return false
  return STATUS_IS_APP.test(t) || STATUS_CHECK_APP.test(t)
}

/**
 * Convert an extracted app phrase ("Google Chrome", "whatsapp") into an
 * app-id-shaped slug. Mirrors the web `normalizeAppTarget` so the payload
 * passes the strict tool input validator and means exactly one thing to the
 * native registry's `resolve()`. Bounded to 64 chars like the id pattern.
 */

/** Mirrors `APP_TARGET_MAX_CHARS` in applications/provider (kept local to avoid an import cycle). */
const APP_ID_SLUG_MAX_CHARS = 64

export function toAppId(phrase: string): string {
  const trimmed = (phrase ?? '').trim()
  const slug =
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, APP_ID_SLUG_MAX_CHARS)
  return slug.length > 0 ? slug : trimmed.toLowerCase().slice(0, APP_ID_SLUG_MAX_CHARS) || ''
}

/** Extract a bounded, schema-valid search query from free text. */
export function extractSearchQuery(text: string): string {
  const clean = (text ?? '').replace(/[.!?]+$/g, '').trim()

  // Quoted query wins first: "search for \"X\"" / "open browser and search for 'X'"
  const quoted = clean.match(/\b(?:search|look up|find|google|bing|duckduckgo)(?:\s+for)?\s+["']([^"']+)["']/i)
  if (quoted?.[1]) return quoted[1].trim()

  // Any 'search for X' / 'look up X' / 'find X' phrase: capture what follows
  // the verb and stop the query at a scheduling conjunction (and/but/so/then).
  const capture = clean.match(
    /\b(?:search|look up|find|google|bing|duckduckgo)(?:\s+(?:for|about))?\s+(.+)$/i,
  )
  if (capture?.[1]) {
    const query = capture[1]
      .split(/\s+(?:and|but|so|,|then|while)\s+(?:also\s+)?(?:search|open|launch|start|type|write|copy|paste|close|quit|exit|verify|check|confirm)\b/i)[0]
      .replace(/\s+in\s+the\s+(?:browser|web|internet)$/i, '')
      .replace(/\s+on\s+the\s+(?:browser|web|internet)$/i, '')
      .trim()
    if (query.length > 0) return query
  }

  // Single-verb phrase: "search for X"
  const simple = clean.match(
    /^(?:please\s+)?(?:search|look up|find|google|bing|duckduckgo)(?:\s+the\s+(?:web|internet|browser))?(?:\s+for)?\s+(.+)$/i,
  )
  if (simple?.[1]) return simple[1].trim()

  // Last resort: strip orchestration prefixes/suffixes and keep what remains.
  const stripped = clean
    .replace(/^(please\s+)?(open|launch|start|run)\s+(the\s+)?(browser|app|application|web)\s+(and|then|,)+\s*/i, '')
    .replace(/^(in|on|via|through)\s+the\s+(browser|web|internet)\s*/i, '')
    .split(/\s+(?:then|while|after that)\s+/)[0]
    .replace(/"+/g, '')
    .trim()
  return stripped.length > 0 ? stripped : clean
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

/** Extract text to type from a type/write/enter verb phrase. */
export function extractTypeText(text: string): string | undefined {
  const t = (text ?? '').replace(/[.!?]+$/g, '').trim()
  // Match quoted text first
  const quotedMatch = t.match(/\b(?:type|write|enter|input)\s+"([^"]+)"/i)
  if (quotedMatch) return quotedMatch[1].trim()
  const singleQuotedMatch = t.match(/\b(?:type|write|enter|input)\s+'([^']+)'/i)
  if (singleQuotedMatch) return singleQuotedMatch[1].trim()
  // Match unquoted text, stopping at conjunctions that indicate next actions
  const unquotedMatch = t.match(/\b(?:type|write|enter|input)\s+(.+?)(?:\s+(?:and\s+(?:then\s+)?)?(?:copy|clipboard|select|verify|close|quit|exit)|\s*$)/i)
  if (unquotedMatch) {
    const extracted = unquotedMatch[1].trim()
    return extracted.length > 0 ? extracted : undefined
  }
  return undefined
}

/** Deterministic self-introduction the assistant can type on request. */
export const JARVIS_WRITTEN_INTRO = [
  'Hello! I am JARVIS, a personal AI assistant running on this device.',
  'I can open and control applications, search the web, work with files, and remember things for you.',
  'This message was typed in written format as you asked.',
].join('\n')

/** True when the text asks to type/write something OR asks for a written
 * self-introduction ("introduce yourself in written format"). */
export function hasWriteIntent(text: string): boolean {
  return TYPE_VERBS.test(text) || (INTRO_INTENT.test(text) && INTRO_WRITTEN.test(text))
}

/** Extract the text a request asks to type, including written self-introduction
 * flows. Returns the explicit type text, else the deterministic introduction. */
export function extractWriteText(text: string): string | undefined {
  const explicit = extractTypeText(text)
  if (explicit) return explicit
  if (INTRO_INTENT.test(text) && INTRO_WRITTEN.test(text)) return JARVIS_WRITTEN_INTRO
  return undefined
}

function typeDescription(text: string): string {
  if (text === JARVIS_WRITTEN_INTRO) return 'the written introduction'
  return `"${text.slice(0, 40)}${text.length > 40 ? '...' : ''}"`
}

/** Detect compound: "type X and copy" or "type X, copy it". */
export function hasCopyIntent(text: string): boolean {
  return /\b(?:and\s+)?(?:copy|clipboard)\b/i.test(text) ||
    /\b(?:copy|clipboard)\s+(?:it|text|everything|all)\b/i.test(text)
}

/** Detect compound: "type X and verify clipboard". */
export function hasClipboardVerifyIntent(text: string): boolean {
  return /\b(?:verify|check|confirm)\s+(?:the\s+)?(?:clipboard|copied)\b/i.test(text) ||
    (TYPE_VERBS.test(text) && CLIPBOARD_VERBS.test(text) && VERIFY_VERBS.test(text))
}

/** Detect close intent for a specific app. */
export function hasCloseIntent(text: string): boolean {
  return CLOSE_VERBS.test(text)
}

/** Extract app name after a close/quit/exit verb. */
export function extractCloseAppName(text: string): string | undefined {
  const t = (text ?? '').replace(/[.!?]+$/g, '').trim()
  const match = t.match(/\b(?:close|quit|exit|terminate|kill)\s+([^,;.]+)/i)
  if (!match) return undefined
  let phrase = match[1].trim().split(APP_SUBSEQUENT)[0].trim()
  phrase = phrase.replace(/^(?:the|a|an)\s+/i, '').trim()
  if (phrase.length === 0) return undefined
  return phrase.toLowerCase()
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
  const plan = planRequestCore(request, context)
  if (plan.verdict !== 'ok' || plan.steps.length === 0) return plan

  // Phase 6 — enrich every step with application-decided metadata and attach
  // bounded goal-level metadata. Both are deterministic and additive.
  const stepCount = plan.steps.length
  // buildPhase6StepMeta always returns meta, so every enriched step provably
  // carries one; the intersection makes that flow-sensitive for the
  // precondition conditioning pass below (no runtime assertion needed).
  const steps: (OrchestrationPlanStep & { meta: Phase6StepMeta })[] = plan.steps.map((step, index) => {
    const hasDependents = plan.steps.some((s) => (s.dependsOn ?? []).includes(index))
    return {
      ...step,
      meta: buildPhase6StepMeta({
        capability: step.capability,
        description: step.description,
        dependsOn: step.dependsOn,
        stepCount,
        hasDependents,
      }),
    }
  })
  const hasDependencies = steps.some((s) => (s.dependsOn ?? []).length > 0)

  // Phase 6 — real conditional branching for dependent steps: a step that types
  // into an application runs ONLY when the launch step reported `started: true`
  // in its result (checked against the observed execution context, never a
  // guess). The depends_on_success dependency is still enforced via dependsOn.
  const stepsAfterConditioning = steps.map((step, _index): OrchestrationPlanStep => {
    const deps = step.dependsOn ?? []
    if (step.capability === 'type_text' && deps.length === 1 && steps[deps[0]]?.capability === 'open_application') {
      return {
        ...step,
        meta: {
          ...(step.meta ?? {}),
          precondition: {
            kind: 'context_matches' as const,
            sources: [...deps],
            source: deps[0],
            path: 'started',
            expect: true,
            note: 'the application must report that it started (output.started === true) before text is typed into it',
          },
        },
      }
    }
    return step
  })

  return {
    ...plan,
    steps: stepsAfterConditioning,
    phase6: buildPhase6PlanMeta({
      goal: plan.goal,
      requestClass: request.requestClass,
      stepCount,
      hasDependencies,
    }),
  }
}

function planRequestCore(
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

  // Read-only application-status questions ("is chrome running?") are answered
  // from real Windows process observation — never from JARVIS's internal state.
  if (isStatusRequest(text)) {
    const app = extractStatusTarget(text)
    if (app && can('application_status')) {
      return {
        goal,
        verdict: 'ok',
        steps: [
          {
            id: 'step-1',
            capability: 'application_status',
            description: `Check whether ${app} is running.`,
            payload: { application_id: toAppId(app) },
            targetDevice: request.targetDevices[0] ?? request.implicitTargetDevice,
          },
        ],
      }
    }
    if (app) {
      return block(`application_status is not available on any online device right now.`)
    }
  }

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
    if (OPEN_VERBS.test(text) && hasWriteIntent(text)) {
      const app = extractAppName(text)
      const writeText = extractWriteText(text)
      if (app && writeText) {
        if (can('open_application') && can('type_text')) {
          return {
            goal,
            verdict: 'ok',
            steps: [
              { id: 'step-1', capability: 'open_application', description: `Launch ${app}.`, payload: { application_id: toAppId(app) }, targetDevice: target },
              { id: 'step-2', capability: 'type_text', description: `Type ${typeDescription(writeText)}.`, payload: { text: writeText }, dependsOn: [0], targetDevice: target },
            ],
          }
        }
        if (can('open_application')) {
          return {
            goal,
            verdict: 'ok',
            steps: [
              { id: 'step-1', capability: 'open_application', description: `Launch ${app}.`, payload: { application_id: toAppId(app) }, targetDevice: target },
            ],
            reason: 'Desktop text input is not available in this environment, so I opened the app without typing the requested text.',
          }
        }
      }
    }
    if (OPEN_VERBS.test(text)) {
      // "open my downloads folder" → open Explorer ON the curated folder.
      // Folders stay out of the application resolution path entirely.
      const folderTarget = extractFolderTarget(text)
      if (folderTarget && can('open_application')) {
        return {
          goal,
          verdict: 'ok',
          steps: [
            {
              id: 'step-1',
              capability: 'open_application',
              description: `Open the ${folderTarget.name} folder in File Explorer.`,
              payload: { application_id: 'file-explorer', folder: folderTarget.folder },
              targetDevice: target,
            },
          ],
        }
      }
      const app = extractAppName(text)
      if (app && isFileOrFolderTarget(app)) {
        // A file/folder target is NOT an application — never fabricate an app id.
        return block(`"${app}" is a file or folder, not an application; I cannot open it with the application launcher.`)
      } else if (app && can('open_application')) {
        return {
          goal,
          verdict: 'ok',
          steps: [
            {
              id: 'step-1',
              capability: 'open_application',
              description: `Launch ${app}.`,
              payload: { application_id: toAppId(app) },
              targetDevice: target,
            },
          ],
        }
      } else if (app) {
        return block('open_application is not available on any online device right now.')
      }
    }
    if (hasCloseIntent(text)) {
      const app = extractCloseAppName(text)
      if (app && isFileOrFolderTarget(app)) {
        return block(`"${app}" is a file or folder, not an application; there is nothing to close.`)
      }
      if (app && can('close_application')) {
        return {
          goal,
          verdict: 'ok',
          steps: [
            {
              id: 'step-1',
              capability: 'close_application',
              description: `Close ${app}.`,
              payload: { application_id: toAppId(app) },
              targetDevice: target,
            },
          ],
        }
      }
      if (app) {
        return block('close_application is not available on any online device right now.')
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
          { id: 'step-1', capability: 'open_application', description: `Launch ${app}.`, payload: { application_id: toAppId(app) }, targetDevice: target },
          { id: 'step-2', capability: 'web_search', description: 'Search the web.', payload: { query }, dependsOn: [0] },
        ],
      }
    }
    if (SEARCH_VERBS.test(text) && DOWNLOAD_VERBS.test(text) && can('web_search') && can('web_download')) {
      const query = extractSearchQuery(text)
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

    // Phase 5 — Compound: "open X, type Y, copy, verify clipboard"
    // Optionally appends a trailing browser.search (mixed multi-capability flow).
    if (OPEN_VERBS.test(text) && hasWriteIntent(text) && CLIPBOARD_VERBS.test(text) && can('open_application') && can('type_text') && can('clipboard_read')) {
      const app = extractAppName(text) ?? 'notepad'
      const typeText = extractWriteText(text)
      if (typeText) {
        const steps: OrchestrationPlanStep[] = [
          { id: 'step-1', capability: 'open_application', description: `Launch ${app}.`, payload: { application_id: toAppId(app) } },
          { id: 'step-2', capability: 'type_text', description: `Type ${typeDescription(typeText)}.`, payload: { text: typeText }, dependsOn: [0] },
          { id: 'step-3', capability: 'clipboard_read', description: 'Read clipboard to verify.', payload: {}, dependsOn: [1] },
        ]
        if (SEARCH_VERBS.test(text) && can('browser_search') && steps.length < ORCHESTRATION_PLAN_LIMITS.maxSteps) {
          const query = extractSearchQuery(text)
          steps.push({ id: `step-${steps.length + 1}`, capability: 'browser_search', description: `Search for "${query.slice(0, 40)}${query.length > 40 ? '...' : ''}".`, payload: { query } })
        }
        return { goal, verdict: 'ok', steps }
      }
    }

    // Phase 5 — Compound: "launch X and (verify|check) it is running"
    if (OPEN_VERBS.test(text) && VERIFY_VERBS.test(text) && can('open_application') && can('application_status')) {
      const app = extractAppName(text)
      if (app) {
        return {
          goal,
          verdict: 'ok',
          steps: [
            { id: 'step-1', capability: 'open_application', description: `Launch ${app}.`, payload: { application_id: toAppId(app) } },
            { id: 'step-2', capability: 'application_status', description: `Verify ${app} is running.`, payload: { application_id: toAppId(app) }, dependsOn: [0] },
          ],
        }
      }
    }

    // Phase 5 — Compound: "open X, type Y" (without clipboard)
    if (OPEN_VERBS.test(text) && hasWriteIntent(text) && can('open_application') && can('type_text')) {
      const app = extractAppName(text) ?? 'notepad'
      const typeText = extractWriteText(text)
      if (typeText) {
        return {
          goal,
          verdict: 'ok',
          steps: [
            { id: 'step-1', capability: 'open_application', description: `Launch ${app}.`, payload: { application_id: toAppId(app) } },
            { id: 'step-2', capability: 'type_text', description: `Type ${typeDescription(typeText)}.`, payload: { text: typeText }, dependsOn: [0] },
          ],
        }
      }
    }

    // Phase 5 — Compound: "open browser, search for X" (browser.open + browser.search)
    // Must come BEFORE the browser_search-only pattern to match compound goals.
    if (OPEN_VERBS.test(text) && SEARCH_VERBS.test(text) && can('browser_open') && can('browser_search')) {
      const query = extractSearchQuery(text)
      return {
        goal,
        verdict: 'ok',
        steps: [
          { id: 'step-1', capability: 'browser_open', description: 'Open browser.', payload: { url: 'about:blank' } },
          { id: 'step-2', capability: 'browser_search', description: `Search for "${query.slice(0, 40)}${query.length > 40 ? '...' : ''}".`, payload: { query }, dependsOn: [0] },
        ],
      }
    }

    // Phase 5 — Compound: "search for X in browser" (browser.search)
    if (SEARCH_VERBS.test(text) && can('browser_search')) {
      const query = extractSearchQuery(text)
      return {
        goal,
        verdict: 'ok',
        steps: [
          { id: 'step-1', capability: 'browser_search', description: `Search for "${query.slice(0, 40)}${query.length > 40 ? '...' : ''}".`, payload: { query } },
        ],
      }
    }

    // Phase 5 — Compound: "write X to clipboard" (clipboard.write + clipboard.read verify)
    if (CLIPBOARD_VERBS.test(text) && can('clipboard_write')) {
      const match = text.match(/\b(?:write|set|put|copy)\s+(?:"([^"]+)"|'([^']+)'|(.+?))\s+(?:to|into|on)\s+(?:the\s+)?clipboard/i)
      if (match) {
        const clipText = (match[1] ?? match[2] ?? match[3] ?? '').trim()
        if (clipText.length > 0) {
          return {
            goal,
            verdict: 'ok',
            steps: [
              { id: 'step-1', capability: 'clipboard_write', description: `Write "${clipText.slice(0, 40)}${clipText.length > 40 ? '...' : ''}" to clipboard.`, payload: { text: clipText } },
              { id: 'step-2', capability: 'clipboard_read', description: 'Read clipboard to verify.', payload: {}, dependsOn: [0] },
            ],
          }
        }
      }
    }

    // Phase 5 — Compound: "close X" (close_application)
    if (CLOSE_VERBS.test(text) && can('close_application')) {
      const app = extractCloseAppName(text)
      if (app) {
        return {
          goal,
          verdict: 'ok',
          steps: [
            { id: 'step-1', capability: 'close_application', description: `Close ${app}.`, payload: { application_id: toAppId(app) } },
          ],
        }
      }
    }

    // Phase 5 — Compound: "launch X, then close X" (app.launch + app.close)
    if (OPEN_VERBS.test(text) && CLOSE_VERBS.test(text) && can('open_application') && can('close_application')) {
      const app = extractCloseAppName(text) ?? extractAppName(text)
      if (app) {
        return {
          goal,
          verdict: 'ok',
          steps: [
            { id: 'step-1', capability: 'open_application', description: `Launch ${app}.`, payload: { application_id: toAppId(app) } },
            { id: 'step-2', capability: 'close_application', description: `Close ${app}.`, payload: { application_id: toAppId(app) }, dependsOn: [0] },
          ],
        }
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