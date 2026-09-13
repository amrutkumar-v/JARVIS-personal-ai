import type { PanelId } from '../../panel/types'
import { PANEL_BY_ID, PANEL_DEFINITIONS, TASKBAR_ITEMS } from '../../panel/registry'
import type { VisualEnvironmentId } from '../../environment/types'
import { ENVIRONMENT_BY_ID, ENVIRONMENT_DEFINITIONS } from '../../environment/registry'
import type { JarvisTheme } from '../../themes'
import { JARVIS_THEMES, THEME_META } from '../../themes'
import { normalizeRequest } from './intents'

/**
 * Phase 9 — deterministic self-interaction (UI-control) surface.
 *
 * This module recognises NATURAL-LANGUAGE commands that control JARVIS's OWN
 * interface — panels ("open the core", "hide the devices panel") and
 * environments ("switch to Astra", "next environment"). It is:
 *
 *  - deterministic — pure string parsing, no LLM, no heuristics over context;
 *  - single-source — panel names and environment names come ONLY from the
 *    `panel/registry` and `environment/registry` catalogues (plus a tiny
 *    synonym map); nothing is hard-coded as a parallel list;
 *  - bounded — at most `MAX_UI_CONTROL_COMMANDS` independent commands per turn;
 *  - honest — an unrecognised target is reported as UNKNOWN with the real
 *    catalogue listed, never guessed into an action;
 *  - conservative — it never hijacks ordinary requests. Open/launch phrasing
 *    without a recognised panel OR without a modal suffix falls through to the
 *    normal classifier (so "open the pdf" still tries file/app actions and
 *    camera phrases keep their Phase 2.7 behaviour).
 *
 * This module performs NO execution and touches NO store. It only parses; the
 * engine executes the returned intents through the real panel/environment
 * store actions.
 */

export type PanelControlKind = 'open_panel' | 'close_panel' | 'toggle_panel' | 'focus_panel'
export type EnvironmentControlKind = 'switch_environment' | 'next_environment' | 'previous_environment'
export type ThemeControlKind = 'set_theme' | 'next_theme'
export type UiControlKind = PanelControlKind | EnvironmentControlKind | ThemeControlKind

export interface UiControlIntent {
  kind: UiControlKind
  /** Panel target when kind is a panel command. */
  panelId?: PanelId
  /** Presentation label of the resolved panel (from the panel registry). */
  panelLabel?: string
  /** False when the target looks like a panel request but is not registered. */
  panelKnown: boolean
  /** Environment target when kind is `switch_environment`. */
  environmentId?: VisualEnvironmentId
  /** Presentation label of the resolved environment (from the env registry). */
  environmentLabel?: string
  /** False when the switch target is not a real environment. */
  environmentKnown: boolean
  /** Theme target when kind is `set_theme` (real id from the theme catalogue). */
  themeId?: JarvisTheme
  /** Presentation label of the resolved theme (from the theme catalogue). */
  themeLabel?: string
  /** False when the theme target is not a real theme. */
  themeKnown: boolean
  /** The original (un-normalised) request fragment this intent came from. */
  raw: string
}

/** Hard ceiling on independent UI-control commands recognised in one turn. */
export const MAX_UI_CONTROL_COMMANDS = 2

/* ---------------------------------------------------------------- aliases */

/**
 * Synonym table built from the real registries. `key` is the exact
 * lower-cased phrase matched against normalised text; values are ids.
 * Phrases are sorted longest-first at match time so the most specific alias
 * wins ("camera panel" before "camera").
 */

function buildEnvironmentAliases(): Record<string, VisualEnvironmentId> {
  const aliases: Record<string, VisualEnvironmentId> = {}
  for (const def of ENVIRONMENT_DEFINITIONS) {
    aliases[def.id] = def.id
    aliases[def.label.toLowerCase()] = def.id
  }
  const SYNONYMS: ReadonlyArray<readonly [string, VisualEnvironmentId]> = [
    ['arc reactor', 'arc'],
    ['reactor', 'arc'],
    ['reactor core', 'arc'],
    ['astra', 'astra'],
    ['astra hud', 'astra'],
    ['hud', 'astra'],
    ['control', 'control'],
    ['control panel', 'control'],
    ['control deck', 'control'],
    ['deck', 'control'],
    ['dashboard', 'control'],
    ['space', 'space'],
    ['space station', 'space'],
    ['orbital', 'space'],
    ['tunnel', 'tunnel'],
    ['tunnels', 'tunnel'],
    ['tunnel network', 'tunnel'],
  ]
  for (const [phrase, id] of SYNONYMS) aliases[phrase] = id
  return aliases
}

function buildPanelAliases(): Record<string, PanelId> {
  const aliases: Record<string, PanelId> = {}
  for (const def of PANEL_DEFINITIONS) {
    aliases[def.title.toLowerCase()] = def.id
    aliases[def.id] = def.id
  }
  for (const item of TASKBAR_ITEMS) {
    aliases[item.label.toLowerCase()] = item.id
  }
  const SYNONYMS: ReadonlyArray<readonly [string, PanelId]> = [
    ['core panel', 'core'],
    ['main', 'core'],
    ['main panel', 'core'],
    ['home', 'core'],
    ['home panel', 'core'],
    ['camera panel', 'camera'],
    ['camera view', 'camera'],
    ['camera window', 'camera'],
    ['webcam', 'camera'],
    ['webcam panel', 'camera'],
    ['session', 'conversation'],
    ['session panel', 'conversation'],
    ['chat', 'conversation'],
    ['chat log', 'conversation'],
    ['conversation panel', 'conversation'],
    ['activities', 'activity'],
    ['activity log', 'activity'],
    ['activity panel', 'activity'],
    ['system info', 'system'],
    ['system information', 'system'],
    ['system status', 'system'],
    ['status', 'system'],
    ['diagnostics', 'system'],
    ['system panel', 'system'],
    ['environment selector', 'environments'],
    ['environment picker', 'environments'],
    ['environment panel', 'environments'],
    ['envs', 'environments'],
    ['env switcher', 'environments'],
    ['vision panel', 'vision'],
    ['visual analysis', 'vision'],
    ['devices panel', 'devices'],
    ['connected devices', 'devices'],
    ['files panel', 'files'],
    ['file manager', 'files'],
    ['file browser', 'files'],
    ['apps', 'applications'],
    ['apps panel', 'applications'],
    ['app list', 'applications'],
    ['applications panel', 'applications'],
    ['programs', 'applications'],
    ['installed apps', 'applications'],
  ]
  for (const [phrase, id] of SYNONYMS) aliases[phrase] = id
  return aliases
}

function buildThemeAliases(): Record<string, JarvisTheme> {
  const aliases: Record<string, JarvisTheme> = {}
  for (const theme of JARVIS_THEMES) {
    aliases[theme] = theme
    aliases[THEME_META[theme].label.toLowerCase()] = theme
  }
  const SYNONYMS: ReadonlyArray<readonly [string, JarvisTheme]> = [
    ['classic', 'classic'],
    ['default', 'classic'],
    ['original', 'classic'],
    ['blue', 'classic'],
    ['cyan', 'classic'],
    ['cyber', 'cyber'],
    ['cyberpunk', 'cyber'],
    ['neon', 'cyber'],
    ['magenta', 'cyber'],
    ['pink', 'cyber'],
    ['stealth', 'stealth'],
    ['dark stealth', 'stealth'],
    ['stealthy', 'stealth'],
    ['ninja', 'stealth'],
    ['holographic', 'holographic'],
    ['holo', 'holographic'],
    ['iridescent', 'holographic'],
    ['holo bleed', 'holographic'],
    ['minimal', 'minimal'],
    ['minimalist', 'minimal'],
    ['plain', 'minimal'],
    ['monochrome', 'minimal'],
    ['clean', 'minimal'],
  ]
  for (const [phrase, id] of SYNONYMS) aliases[phrase] = id
  return aliases
}

const ENV_ALIASES: Record<string, VisualEnvironmentId> = buildEnvironmentAliases()
const PANEL_ALIASES: Record<string, PanelId> = buildPanelAliases()
const THEME_ALIASES: Record<string, JarvisTheme> = buildThemeAliases()

/** Phrase ranking: longest alias wins so specific phrases match first. */
const ENV_PHRASES: readonly string[] = Object.keys(ENV_ALIASES).sort((a, b) => b.length - a.length)
const PANEL_PHRASES: readonly string[] = Object.keys(PANEL_ALIASES).sort((a, b) => b.length - a.length)
const THEME_PHRASES: readonly string[] = Object.keys(THEME_ALIASES).sort((a, b) => b.length - a.length)

/* -------------------------------------------------------------- patterns */

const OPEN_VERBS = /\b(?:open|launch|show|display|start|bring\s+up|reveal)\b/
const CLOSE_VERBS = /\b(?:close|hide|dismiss|shut)\b/
const TOGGLE_VERBS = /\bto?gg?le\b/
const FOCUS_VERBS = /\b(?:focus|foreground)\b|\bbring\b[^\n]*\bto\s+(?:the\s+)?front\b/
const ENV_SWITCH_VERBS = /\b(?:switch|go|move|change|set|jump|flip)\b[^\n]*?\b(?:to|into)\b/
const NEXT_ENV = /\b(?:next|go\s+to\s+the\s+next|move\s+to\s+the\s+next)\b[^\n]*\b(?:environment|env|scene|view|display)\b/
const PREV_ENV = /\b(?:previous|prev|back\s+to\s+the\s+(?:previous|last)|go\s+back\s+(?:one\s+)?)\b[^\n]*\b(?:environment|env|scene|view|display)\b/
/** A panel-y modal suffix marks an explicit panel/UI reference (safe to own). */
const MODAL_SUFFIX = /\b(?:panel|view|window|log|selector|picker|manager|browser|status|info|front|hud)\b/

/* ---------------------------------------------------------------- themes */

/** Theme-set verbs: the request must BOTH reference a theme and name a change. */
const THEME_NOUN = /\b(?:theme|appearance|skin|look)\b/
const THEME_SET_VERBS = /\b(?:change|switch|set|make|give|use|apply|turn|cycle)\b/
const NEXT_THEME_PATTERN = /\b(?:next|cycle|rotate)\b[^\n]*\b(?:theme|appearance|skin)\b/

/** Camera is owned by the Phase 2.7 direct-intent surface, so any camera
 * command MUST carry an explicit modal suffix to be claimed here. */
const CAMERA_ID: PanelId = 'camera'

/* ---------------------------------------------------------------- helpers */

function hasPhrase(text: string, phrase: string): boolean {
  return (
    text === phrase ||
    text.startsWith(`${phrase} `) ||
    text.includes(` ${phrase} `) ||
    text.endsWith(` ${phrase}`)
  )
}

function findPhrase<Id extends string>(
  text: string,
  phrases: readonly string[],
  aliasMap: Record<string, Id>,
): { phrase: string; id: Id } | undefined {
  for (const phrase of phrases) {
    if (hasPhrase(text, phrase)) {
      const id = aliasMap[phrase]
      if (id !== undefined) return { phrase, id }
    }
  }
  return undefined
}

function kindFromVerbs(text: string): PanelControlKind | undefined {
  if (TOGGLE_VERBS.test(text)) return 'toggle_panel'
  if (OPEN_VERBS.test(text)) return 'open_panel'
  if (CLOSE_VERBS.test(text)) return 'close_panel'
  if (FOCUS_VERBS.test(text)) return 'focus_panel'
  return undefined
}

/* ------------------------------------------------------------ environment */

function detectEnvironmentIntent(text: string): UiControlIntent | undefined {
  const normalized = normalizeRequest(text)

  if (NEXT_ENV.test(normalized)) {
    return { kind: 'next_environment', panelKnown: true, environmentKnown: true, raw: text }
  }
  if (PREV_ENV.test(normalized)) {
    return { kind: 'previous_environment', panelKnown: true, environmentKnown: true, raw: text }
  }

  // "switch to X", "go into X", "change to X" …
  if (ENV_SWITCH_VERBS.test(normalized)) {
    const hit = findPhrase(normalized, ENV_PHRASES, ENV_ALIASES)
    if (hit) {
      const def = ENVIRONMENT_BY_ID.get(hit.id)
      return {
        kind: 'switch_environment',
        environmentId: hit.id,
        environmentLabel: def?.label,
        environmentKnown: true,
        panelKnown: true,
        raw: text,
      }
    }
    // Explicit environment wording with an unknown target: report honestly.
    if (/\b(?:environment|scene|station|mode)\b/.test(normalized)) {
      return { kind: 'switch_environment', environmentKnown: false, panelKnown: true, raw: text }
    }
  }

  // "astra environment", "the control deck scene" (no switch verb).
  const envHit = findPhrase(normalized, ENV_PHRASES, ENV_ALIASES)
  if (envHit && /\b(?:environment|scene|mode|station)\b/.test(normalized)) {
    const def = ENVIRONMENT_BY_ID.get(envHit.id)
    return {
      kind: 'switch_environment',
      environmentId: envHit.id,
      environmentLabel: def?.label,
      environmentKnown: true,
      panelKnown: true,
      raw: text,
    }
  }

  return undefined
}

/* ---------------------------------------------------------------- themes */

function detectThemeIntent(text: string): UiControlIntent | undefined {
  const normalized = normalizeRequest(text)

  if (NEXT_THEME_PATTERN.test(normalized)) {
    return { kind: 'next_theme', panelKnown: true, environmentKnown: true, themeKnown: true, raw: text }
  }

  if (!THEME_NOUN.test(normalized)) return undefined
  if (!THEME_SET_VERBS.test(normalized)) return undefined

  const hit = findPhrase(normalized, THEME_PHRASES, THEME_ALIASES)
  if (hit) {
    const meta = THEME_META[hit.id]
    return {
      kind: 'set_theme',
      themeId: hit.id,
      themeLabel: meta.label,
      themeKnown: true,
      panelKnown: true,
      environmentKnown: true,
      raw: text,
    }
  }

  // An explicit theme request with an unknown target: surface it honestly
  // instead of guessing a theme.
  return { kind: 'set_theme', themeKnown: false, panelKnown: true, environmentKnown: true, raw: text }
}

/* ---------------------------------------------------------------- panels */

function detectPanelIntent(text: string): UiControlIntent | undefined {
  const normalized = normalizeRequest(text)
  const kind = kindFromVerbs(normalized)
  if (!kind) return undefined

  const hit = findPhrase(normalized, PANEL_PHRASES, PANEL_ALIASES)
  if (hit) {
    // Camera stays with the Phase 2.7 direct-intent surface unless the request
    // explicitly names a modal suffix ("camera panel", "camera view").
    if (hit.id === CAMERA_ID && !MODAL_SUFFIX.test(hit.phrase)) return undefined
    return {
      kind,
      panelId: hit.id,
      panelLabel: PANEL_BY_ID.get(hit.id)?.title,
      panelKnown: true,
      environmentKnown: true,
      raw: text,
    }
  }

  // An unrecognised target with an explicit modal suffix is a panel/UI request
  // that cannot be executed — surface it honestly instead of guessing.
  const rest = normalized.replace(/\b(?:open|launch|show|display|start|close|hide|dismiss|toggle|focus|please|me|us|the)\b/g, ' ').replace(/\s+/g, ' ').trim()
  if (rest.length > 0 && !/^what|^how|^who|^why|^do you/.test(normalized) && MODAL_SUFFIX.test(rest)) {
    return { kind, panelKnown: false, environmentKnown: true, raw: text }
  }

  return undefined
}

/* ---------------------------------------------------------------- public */

/** Detect a single UI-control command, if any. Never performs actions. */
export function detectUiControlIntent(text: string): UiControlIntent | undefined {
  return detectEnvironmentIntent(text) ?? detectThemeIntent(text) ?? detectPanelIntent(text)
}

/**
 * Detect up to `MAX_UI_CONTROL_COMMANDS` independent commands in one turn
 * ("switch to astra and open the core"). Compound splitting is bounded and
 * strict: only `and` / `then` conjunctions are honoured, and any fragment that
 * is not a recognised command aborts the whole compound parse.
 */
export function detectUiControlCommands(text: string): UiControlIntent[] {
  const raw = (text ?? '').trim()
  if (!raw) return []

  const fragments = raw
    .split(/\s+(?:and\s+)?then\s+|\s+and\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, MAX_UI_CONTROL_COMMANDS + 1)

  if (fragments.length === 1) {
    const single = detectUiControlIntent(fragments[0]!)
    return single ? [single] : []
  }

  const intents: UiControlIntent[] = []
  for (const fragment of fragments) {
    const intent = detectUiControlIntent(fragment)
    if (!intent) return []
    intents.push(intent)
  }
  return intents.slice(0, MAX_UI_CONTROL_COMMANDS)
}

/** Real environment labels in registry order (honest unknown-target reply). */
export function environmentChoices(): string[] {
  return ENVIRONMENT_DEFINITIONS.map((d) => d.label)
}

/** Real panel labels in registry order (honest unknown-target reply). */
export function panelChoices(): string[] {
  return PANEL_DEFINITIONS.map((d) => d.title)
}

/** Real theme labels in catalogue order (honest unknown-target reply). */
export function themeChoices(): string[] {
  return JARVIS_THEMES.map((id) => THEME_META[id].label)
}