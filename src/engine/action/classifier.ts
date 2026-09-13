import type { ActionKind, ActionRegistryView } from './types'
import {
  selectToolsForRequest,
  selectCapabilitiesForDomain,
  type ToolMatch,
} from './registry'

/**
 * Phase 2.6 — deterministic request classification (§5).
 *
 * Distinguishes, BEFORE the provider runs, whether a request is informational,
 * executable, unsupported, ambiguous, or a follow-on to an earlier execution.
 * The classifier is pure and bounded (small explicit vocabularies, no huge
 * phrase lists) and it FAILS OPEN: anything it cannot confidently decide is
 * routed to the provider as `informational`/`executable`-passthrough so real
 * models keep full latitude. It NEVER executes tools and NEVER overrides the
 * permission rails.
 *
 * The only requests it deterministically *blocks* are the ones where acting
 * blindly would be dishonest or dangerous:
 *   - `unsupported` — an imperative action whose domain has no connected tool
 *     OR capability (answered honestly, nothing fabricated);
 *   - `ambiguous` — a destructive/state-changing request that points at a
 *     deictic target ("delete that file") with no resolvable reference.
 */

export interface ActionDecision {
  kind: ActionKind
  /** Recognised request domain (files/memory/system/communication/media/device/apps). */
  domain?: string
  matchedTools: ToolMatch[]
  matchedCapabilities: string[]
  reason: string
}

/** Verb-token vocabularies per domain. Bounded and explicit. */
type DomainDef = { domain: string; verbs: readonly string[]; capabilityKeywords: readonly string[] }

const DOMAINS: readonly DomainDef[] = [
  {
    domain: 'files',
    verbs: [
      'list', 'show', 'open', 'read', 'view', 'browse', 'display', 'inspect', 'examine',
      'find', 'search', 'locate', 'look at', 'rename', 'move', 'copy', 'delete', 'remove',
      'mkdir', 'create folder', 'create directory', 'make folder', 'make directory', 'preview',
    ],
    capabilityKeywords: ['file', 'folder', 'directory', 'drive', 'read file', 'write file'],
  },
  {
    domain: 'memory',
    verbs: ['remember', 'recall', 'forget', 'memorize', 'memorise'],
    capabilityKeywords: ['memory', 'note', 'remember', 'recall', 'profile', 'preference'],
  },
  {
    domain: 'system',
    verbs: ['status', 'uptime', 'specs', 'diagnostics', 'system info', 'hardware'],
    capabilityKeywords: ['system', 'device info', 'platform'],
  },
  {
    domain: 'apps',
    verbs: ['launch', 'install', 'uninstall', 'open app', 'open the app', 'quit app', 'run app', 'start app', 'update app'],
    capabilityKeywords: ['application', 'app', 'launch', 'install'],
  },
  {
    domain: 'communication',
    verbs: ['send', 'message', 'text', 'sms', 'email', 'mail', 'call', 'phone', 'dial', 'ring', 'hang up', 'answer', 'reject call', 'end call', 'whatsapp', 'slack', 'discord', 'telegram', 'notify', 'tweet', 'post to'],
    capabilityKeywords: ['message', 'communication', 'email', 'notification', 'call', 'phone', 'sms', 'contact', 'telephony'],
  },
  {
    domain: 'media',
    verbs: ['play', 'pause', 'resume', 'skip', 'shuffle', 'stream', 'song', 'music', 'playlist', 'movie', 'video', 'tv show'],
    capabilityKeywords: ['media', 'music', 'playback', 'audio', 'video'],
  },
  {
    domain: 'device',
    verbs: ['volume', 'brightness', 'bluetooth', 'airplane mode', 'wifi', 'reboot', 'restart', 'shutdown', 'sleep', 'lock', 'mute', 'wallpaper', 'screen', 'battery'],
    capabilityKeywords: ['device', 'settings', 'system control', 'wallpaper'],
  },
]

export function isQuestion(text: string): boolean {
  const t = (text ?? '').trim()
  if (t.length === 0) return false
  if (t.endsWith('?')) return true
  return /^(what|why|when|where|who|which|how|is|are|do you|does|did you|can you|could you|would you|will you)\b/i.test(t)
}

/** True when the text contains an explicit, non-deictic target reference
 * (quoted literal, drive/path or a known file extension). */
export function hasExplicitTarget(text: string): boolean {
  return (
    /["'][^"']{1,200}["']/.test(text) ||
    /\b[A-Za-z]:[\\/]/.test(text) ||
    /(\/Users\/|\/home\/|\/tmp\/|\.\w{1,12}[\\/])/.test(text) ||
    /\b[\w.-]+\.(pdf|txt|docx?|png|jpe?g|gif|zip|md|csv|json|xml|mp4|mp3|mov|avi)\b/i.test(text)
  )
}

/** True when the text names a folder/location ("in Downloads"). */
export function hasLocative(text: string): boolean {
  return /\b(?:in|under|inside|into|within)\s+(?:the\s+)?[A-Za-z0-9._~ -]{2,40}\b/.test(text)
}

const DESTRUCTIVE_VERBS = [
  'delete', 'remove', 'erase', 'wipe', 'rename', 'move', 'overwrite', 'replace',
  'clear', 'shut', 'terminate', 'kill', 'forget', 'cancel', 'undo', 'restore',
  'archive', 'trash', 'empty', 'reset', 'format', 'uninstall', 'close',
]

const DEICTIC_PRONOUN = /\b(?:it|this|that|them|those|these)\b/i

/**
 * True when a request is a destructive/state-changing action whose target is
 * only a deictic pronoun ("delete that file", "remove it", "forget it") with
 * no explicit path/quoted/extension target. Blind execution would be
 * dishonest, so the engine asks for clarification instead.
 */
export function isRiskyDeictic(text: string): boolean {
  const t = (text ?? '').trim()
  if (t.length === 0 || isQuestion(t)) return false
  if (hasExplicitTarget(t)) return false
  const hasVerb = DESTRUCTIVE_VERBS.some((v) => new RegExp(`\\b${v}\\b`, 'i').test(t))
  if (!hasVerb) return false
  return DEICTIC_PRONOUN.test(t)
}

/**
 * Deterministically classify one request against the live registry view.
 * Never throws on malformed text.
 */
export function classifyRequest(text: string, view: ActionRegistryView): ActionDecision {
  const t = (text ?? '').trim()
  if (t.length === 0) {
    return { kind: 'informational', matchedTools: [], matchedCapabilities: [], reason: 'Empty request.' }
  }

  // 1. A registered tool's canRun already understands this request.
  const sel = selectToolsForRequest(view, t)
  if (sel.matched) {
    return {
      kind: 'executable',
      matchedTools: sel.matches,
      matchedCapabilities: [],
      reason: `Registered tool matches: ${sel.matches.map((m) => m.toolId).join(', ')}.`,
    }
  }

  // 2. Recognise the request domain from its verb vocabulary.
  const lower = t.toLowerCase()
  let best: DomainDef | undefined
  let bestScore = 0
  for (const domain of DOMAINS) {
    let score = 0
    for (const verb of domain.verbs) {
      if (verb.includes(' ') ? lower.includes(verb) : new RegExp(`\\b${verb}\\b`, 'i').test(lower)) {
        score += 1
      }
    }
    if (score > bestScore) {
      best = domain
      bestScore = score
    }
  }

  // 2b. Apps-first tie-break: "open WhatsApp", "start Spotify" — the bare launch
  // verb matches BOTH `files` ("open") and `apps` ("open app"/"start app" /
  // "run app"), so files wins by the word count alone. When the request is a
  // bare launch verb (no explicit file/folder target, no file noun) and the
  // apps capability is actually connected, prefer the apps domain: it means
  // "open this application", and the native registry still resolves the name
  // honestly.
  const APPS_DOMAIN = DOMAINS.find((d) => d.domain === 'apps')!
  const BARE_LAUNCH = /\b(open|launch|start|run)\b/i.test(lower)
  const FILE_NOUN = /\b(file|files?|folder|directory|document|documents|sheet|slides?|notes?|backup|archive|downloads?|desktop)\b/i
  const appsBacked = selectCapabilitiesForDomain(view, APPS_DOMAIN.capabilityKeywords).some((capId) => {
    const cap = view.capabilities.find((c) => c.id === capId)
    return cap ? cap.toolIds.some((toolId) => view.tools.some((t) => t.id === toolId)) : false
  })
  if (
    best?.domain === 'files' &&
    bestScore === 1 &&
    BARE_LAUNCH &&
    !hasExplicitTarget(t) &&
    !hasLocative(t) &&
    !FILE_NOUN.test(t) &&
    appsBacked
  ) {
    best = APPS_DOMAIN
    bestScore = 2
  }

  // 3. A question with no tool match is informational (provider answers).
  if (isQuestion(t)) {
    return {
      kind: 'informational',
      domain: best?.domain,
      matchedTools: [],
      matchedCapabilities: best ? selectCapabilitiesForDomain(view, best.capabilityKeywords) : [],
      reason: 'Question, no deterministic tool match — routed to the provider.',
    }
  }

  // 4. No domain recognised → informational passthrough (fail open).
  if (!best) {
    return {
      kind: 'informational',
      matchedTools: [],
      matchedCapabilities: [],
      reason: 'No recognised action domain — routed to the provider.',
    }
  }

  // 5. Domain recognised. Connected only when a matching capability is backed
  // by a registered tool (or the tool itself is registered).
  const matchedCapabilities = selectCapabilitiesForDomain(view, best.capabilityKeywords)
  const backed = matchedCapabilities.some((capId) => {
    const cap = view.capabilities.find((c) => c.id === capId)
    return cap ? cap.toolIds.some((toolId) => view.tools.some((t) => t.id === toolId)) : false
  })
  const hasDomainTool = view.tools.some((t) =>
    best?.capabilityKeywords.some((kw) =>
      kw.includes(' ') ? t.label.toLowerCase().includes(kw) : new RegExp(`\\b${kw}\\b`, 'i').test(t.label),
    ),
  )

  if (backed || hasDomainTool) {
    return {
      kind: 'executable',
      domain: best.domain,
      matchedTools: sel.matches,
      matchedCapabilities,
      reason: `Recognised ${best.domain} request; a connected mechanism exists.`,
    }
  }

  // 6. Imperative action for a domain with NO connected mechanism → honest
  // unsupported (fail closed).
  return {
    kind: 'unsupported',
    domain: best.domain,
    matchedTools: [],
    matchedCapabilities,
    reason: `Recognised ${best.domain} request but no registered tool or backed capability is connected.`,
  }
}