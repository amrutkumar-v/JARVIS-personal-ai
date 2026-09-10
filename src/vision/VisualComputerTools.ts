import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolInput,
  ToolPermission,
  ToolResult,
  ToolVerification,
} from '../tools/Tool'
import type { ToolInputSchema } from '../engine/provider'
import { FileSystemError } from '../filesystem'
import { normalizeWindowId } from '../observation'
import type { ObservationProvider, ScreenshotResult, WindowBounds, WindowStatus } from '../observation'
import type { DesktopProvider } from '../desktop'
import { VISUAL_LIMITS } from './limits'
import type { VisionProvider } from './provider'
import type { VisionAnalysisResult, VisualElementType } from './types'
import { VISUAL_ELEMENT_TYPES } from './types'
import { chooseClickPoint, clipVisualElements, resolveClickPoint } from './bounds'
import { resolveVisualTarget } from './localize'
import { resolveClientPoint } from './coords'
import { verifyVisualTransition } from './verification'
import { classifyStaleness, type StalenessCause } from './staleness'

/**
 * Visual computer tools (Phase 1.7) — EYES BEFORE HANDS.
 *
 * Three narrow tools that compose the EXISTING providers — the vision layer
 * decides WHERE, the observation layer sees, the desktop layer ACTS exactly
 * as it always does (same permission tiers, same budgets, same cancellation,
 * same verification rails):
 *
 *   desktop.visualInspect  read_only   bounded redacted element inventory
 *   desktop.visualClick    low_risk    resolve target → locate → click → re-observe
 *   desktop.visualType     low_risk    resolve input → click to focus → typeText (redacted)
 *
 * Safety contract:
 *   - tools exist ONLY when vision + observation + desktop are all provided;
 *     browser/app mode supplies none, so no tool is ever fabricated.
 *   - a target that is ambiguous or not found REFUSES the action — nothing is
 *     ever injected on a guess.
 *   - typed text never appears in any message/result (a length only).
 *   - screenshot bytes + raw OCR never enter a payload, plan, or trace.
 *   - every injected action is re-observed; the closed-loop verdict is carried
 *     on the result and turned into verified/unverified/failed by the EXISTING
 *     engine verifier (no new engine status).
 */
const VISUAL_TOOL_TIMEOUT_MS = VISUAL_LIMITS.MAX_VISUAL_ANALYSIS_MS * 2 + 2000

function visualFailure(error: unknown): ToolResult {
  if (error instanceof FileSystemError) {
    return { ok: false, message: error.message, data: { kind: error.kind, windowId: error.path } }
  }
  const message = error instanceof Error ? error.message : 'Unknown visual analysis failure.'
  return { ok: false, message }
}

function analysisNotCompleted(error: unknown): ToolResult | null {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return { ok: false, message: 'The visual analysis was cancelled or exceeded its time bound; no action was taken.' }
  }
  return null
}

function userCancelled(signal: AbortSignal | undefined): ToolResult | null {
  if (signal?.aborted) {
    return { ok: false, message: 'The visual action was cancelled before it was injected.', data: { kind: 'user_cancelled' } }
  }
  return null
}

/** Conservative refusal when the observation the decision rested on changed. */
function staleRefusal(cause: StalenessCause, windowId: string): ToolResult {
  const message =
    cause === 'window_closed'
      ? `Window ${windowId} closed before the action could be injected. Nothing was injected — re-run desktop.visualInspect on a live window.`
      : cause === 'window_changed'
        ? `Window ${windowId} moved or resized after analysis, so the target coordinates are no longer safe. Nothing was injected — re-run desktop.visualInspect for a fresh observation.`
        : `The screen changed between analysis and injection, so the target may have moved. Nothing was injected — re-run desktop.visualInspect for a fresh observation.`
  return { ok: false, message, data: { kind: 'stale_observation', cause, windowId } }
}

function availabilityBlocker(
  vision: VisionProvider | undefined,
  observation: ObservationProvider | undefined,
  desktop: DesktopProvider | undefined,
): ToolResult | null {
  if (!vision || !observation || !desktop) {
    return {
      ok: false,
      message: 'Visual understanding is unavailable until a real VisionProvider is configured.',
      data: { available: false },
    }
  }
  const vc = vision.capabilities()
  if (!vc.visionAvailable || !vc.uiElementDetectionAvailable || !vc.targetLocalizationAvailable) {
    return {
      ok: false,
      message: `Visual understanding is not available right now: ${vc.reason ?? 'the provider is inactive.'}`,
      data: { available: false, reason: vc.reason },
    }
  }
  const oc = observation.capabilities()
  if (!oc.available || !oc.canCaptureScreenshots) {
    return {
      ok: false,
      message: `Screenshot observation is not available right now: ${oc.reason ?? 'the provider is inactive.'}`,
      data: { available: false, reason: oc.reason },
    }
  }
  const dc = desktop.capabilities()
  if (!dc.available) {
    return {
      ok: false,
      message: `Desktop interaction is not available right now: ${dc.reason ?? 'the provider is inactive.'}`,
      data: { available: false, reason: dc.reason },
    }
  }
  return null
}

function paramStr(input: ToolInput, key: string): string | undefined {
  const value = input.params?.[key]
  return typeof value === 'string' ? value : undefined
}

function targetParam(input: ToolInput): { target: string } | { error: string } {
  const raw = paramStr(input, 'target')
  if (!raw) return { error: 'This action needs a visual target to resolve. Provide target.' }
  const target = raw.trim()
  if (!target) return { error: 'The visual target must not be empty.' }
  if (target.length > VISUAL_LIMITS.MAX_VISUAL_TEXT_LENGTH) {
    return { error: `The visual target is limited to ${VISUAL_LIMITS.MAX_VISUAL_TEXT_LENGTH} characters.` }
  }
  return { target }
}

function windowParam(input: ToolInput): { id: string } | { error: string } {
  const raw = paramStr(input, 'window_id')
  if (!raw) return { error: 'This action needs a window. Provide window_id.' }
  return normalizeWindowId(raw)
}

function expectedTypeParam(input: ToolInput): { type?: VisualElementType } | { error: string } {
  const raw = paramStr(input, 'expected_type')
  if (raw === undefined) return {}
  if (!(VISUAL_ELEMENT_TYPES as readonly string[]).includes(raw)) {
    return { error: `expected_type must be one of: ${VISUAL_ELEMENT_TYPES.join(', ')}.` }
  }
  return { type: raw as VisualElementType }
}

function confidenceParam(input: ToolInput): { threshold?: number } | { error: string } {
  const raw = input.params?.['confidence_threshold']
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    return { error: 'confidence_threshold must be a number in [0, 1].' }
  }
  return { threshold: raw }
}

function expectedAfterParam(input: ToolInput): string {
  const raw = paramStr(input, 'expected_after')
  return typeof raw === 'string' ? raw.trim() : ''
}

type VisionWatch = {
  vision: VisionProvider
  observation: ObservationProvider
  ctxSignal: AbortSignal | undefined
}

/**
 * Combine the engine run signal (user/engine cancellation) with a hard
 * analysis timeout so an in-flight network call is ALWAYS cancelled when the
 * run dies or the analysis exceeds its bound. Callers MUST dispose.
 */
function analysisSignal(ctxSignal: AbortSignal | undefined): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VISUAL_LIMITS.MAX_VISUAL_ANALYSIS_MS)
  let listener: (() => void) | undefined
  if (ctxSignal) {
    if (ctxSignal.aborted) controller.abort()
    else {
      listener = () => controller.abort()
      ctxSignal.addEventListener('abort', listener, { once: true })
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      if (listener) ctxSignal?.removeEventListener('abort', listener)
    },
  }
}

/** Capture + analyse once, bounded by MAX_VISUAL_ANALYSIS_MS + cancellation. */
async function analyzeOnce(watch: VisionWatch): Promise<{
  analysis?: VisionAnalysisResult
  shot?: ScreenshotResult
  failure?: ToolResult
}> {
  const cancelled = userCancelled(watch.ctxSignal)
  if (cancelled) return { failure: cancelled }
  const scope = analysisSignal(watch.ctxSignal)
  try {
    const screenshot = await watch.observation.captureScreenshot()
    const analysis = await watch.vision.analyzeScreenshot(screenshot, { signal: scope.signal })
    return { analysis, shot: screenshot }
  } catch (error) {
    const notDone = analysisNotCompleted(error)
    if (notDone) return { failure: notDone }
    return { failure: visualFailure(error) }
  } finally {
    scope.dispose()
  }
}

function restingLabel(element: { id: string; type: VisualElementType; label?: string }): string {
  return element.label ?? `element ${element.id}`
}

/** The measured surface for a window: exact client area when available, else the outer frame. */
function windowSurface(status: WindowStatus): WindowBounds | undefined {
  return status.clientBounds ?? status.bounds
}

/**
 * Scope filter (Phase 1.8 multi-window): keep only elements whose click point
 * lands INSIDE the selected window's measured surface. The screenshot covers
 * the whole virtual desktop — a model may "see" other windows — but an action
 * must never target a point outside the window scope, and an inventory scoped
 * to the window must not list foreign elements.
 */
function scopedInventory(
  elements: VisionAnalysisResult['elements'],
  surface: WindowBounds | undefined,
): VisionAnalysisResult['elements'] {
  if (!surface) return []
  return elements.filter((e) => {
    const point = chooseClickPoint(e.bounds)
    return point.x >= surface.left && point.x < surface.right && point.y >= surface.top && point.y < surface.bottom
  })
}

abstract class VisualTool implements Tool {
  readonly category: ToolCategory = 'system'
  readonly verifiable: boolean = false
  readonly requiresPermission: boolean = false
  readonly timeoutMs: number = VISUAL_TOOL_TIMEOUT_MS
  protected readonly vision: VisionProvider
  protected readonly observation: ObservationProvider
  protected readonly desktop: DesktopProvider

  constructor(vision: VisionProvider, observation: ObservationProvider, desktop: DesktopProvider) {
    this.vision = vision
    this.observation = observation
    this.desktop = desktop
  }

  abstract readonly id: string
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly permission: ToolPermission
  abstract readonly inputSchema: ToolInputSchema

  abstract canRun(query: string): boolean
  abstract execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult>
}

/** Post-action verdict → existing engine verification rail (never new statuses). */
function transitionVerifier(
  _input: ToolInput,
  result: ToolResult,
): ToolVerification | Promise<ToolVerification> {
  const data = result.data as
    | { verdict?: { verdict: string; message: string } }
    | undefined
  const verdict = data?.verdict
  if (!verdict) {
    // No re-observation happened (resolution failed / no post-state) → the
    // action either did not run or ran without confirmation. Throw so the
    // engine records 'unverified' (never a fabricated confirmation).
    return Promise.reject(new Error('No post-action visual state was available; the outcome could not be confirmed.'))
  }
  if (verdict.verdict === 'verified') {
    return Promise.resolve({
      ok: true,
      message: verdict.message,
      checks: ['expected after'],
    })
  }
  if (verdict.verdict === 'refuted') {
    return Promise.resolve({ ok: false, message: verdict.message })
  }
  return Promise.reject(new Error(`The action ran but the outcome was not confirmed: ${verdict.message}`))
}

/* ---------------------------------------------------------------- inspect */

export class VisualInspectTool extends VisualTool {
  readonly id = 'desktop.visualInspect'
  readonly name = 'Inspect the screen'
  readonly description =
    'Analyses the current desktop image (via the observation screenshots) and reports the recognisable UI elements ' +
    'present: id, type, label, bounds and confidence. Text is never dumped — only concise element labels — and ' +
    'screenshot bytes are never returned or stored. When window_id is supplied the inventory is scoped to that ' +
    "window's measured area (elements from other windows are excluded). Use this to learn what the agent can " +
    'actually see before acting.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      window_id: { type: 'string', description: 'Optional window id from window.list to scope the inventory to.' },
    },
    required: [],
  }

  canRun(query: string): boolean {
    return /\b(inspect|scan|analyse|analyze|see|look at|what('| i)?s on)\b/i.test(query) &&
      /\b(screen|desktop|window|ui|interface|app)\b/i.test(query)
  }

  async execute(_input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.vision, this.observation, this.desktop)
    if (blocker) return blocker

    let scope: { surface: WindowBounds; status: WindowStatus } | undefined
    if (_input.params?.window_id !== undefined) {
      const winParam = windowParam(_input)
      if ('error' in winParam) {
        return { ok: false, message: winParam.error, data: { kind: 'invalid_input' } }
      }
      try {
        const status = await this.observation.getWindowStatus(winParam.id)
        if (!status.exists) {
          return { ok: false, message: `Window ${winParam.id} no longer exists.`, data: { kind: 'tool_failure' } }
        }
        const surface = windowSurface(status)
        if (!surface) {
          return {
            ok: false,
            message: `Window ${winParam.id} has no measured bounds; its elements cannot be scoped.`,
            data: { kind: 'tool_failure' },
          }
        }
        scope = { surface, status }
      } catch (error) {
        return visualFailure(error)
      }
    }

    const watch: VisionWatch = { vision: this.vision, observation: this.observation, ctxSignal: ctx?.signal }
    const first = await analyzeOnce(watch)
    if (first.failure) return first.failure
    const analysis = first.analysis as VisionAnalysisResult
    const inScope = scope ? scopedInventory(analysis.elements, scope.surface) : analysis.elements
    const clipped = clipVisualElements(inScope)
    // Bounded, redacted inventory: structural facts only, never text dumps.
    const inventory = clipped.map((e) => ({ id: e.id, type: e.type, label: e.label, bounds: e.bounds, confidence: e.confidence }))
    const summary = inventory.map((e) => `${e.id}:${e.type}:${e.label ?? '-'}`).join(', ')
    return {
      ok: true,
      message: `Detected ${inventory.length} visual elements: ${summary}.`,
      data: {
        providerId: analysis.providerId,
        modelId: analysis.modelId,
        viewport: analysis.viewport,
        scopedTo: scope?.status.windowId,
        elements: inventory,
      },
    }
  }
}

/* ------------------------------------------------------------------- click */

export class VisualClickTool extends VisualTool {
  readonly id = 'desktop.visualClick'
  readonly name = 'Click a visual target'
  readonly description =
    'Finds a UI element by its label or visible text on the current desktop (desktop.visualInspect can list them), ' +
    'converts its centre to window-client coordinates, and injects ONE left click via the existing desktop provider. ' +
    'If the target is ambiguous or not found the action is refused — nothing is clicked on a guess. The screen is ' +
    're-observed after the click: when expected_after is supplied, the resulting visible state is verified.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Element label or visible text to click (from desktop.visualInspect).' },
      window_id: { type: 'string', description: 'Window id from window.list.' },
      expected_type: {
        type: 'string',
        description: 'Optional element type filter (button, input, link, checkbox, …).',
      },
      confidence_threshold: { type: 'number', description: 'Optional minimum provider confidence in [0, 1].' },
      expected_after: {
        type: 'string',
        description: 'Optional element that should be visible AFTER the click, to verify the effect.',
      },
    },
    required: ['target', 'window_id'],
  }

  canRun(query: string): boolean {
    return /\bclick\b/i.test(query) && /\b(button|field|input|icon|link|on screen|on the|it|that|element)\b/i.test(query)
  }

  async execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
    return resolveThenAct({
      vision: this.vision,
      observation: this.observation,
      desktop: this.desktop,
      input,
      ctx,
      mode: 'click',
    })
  }

  verify(input: ToolInput, result: ToolResult): Promise<ToolVerification> {
    return Promise.resolve(transitionVerifier(input, result))
  }
}

/* -------------------------------------------------------------------- type */

export class VisualTypeTool extends VisualTool {
  readonly id = 'desktop.visualType'
  readonly name = 'Type into a visual target'
  readonly description =
    'Finds an input field by label or visible text on the current desktop, converts its centre to window-client ' +
    'coordinates, clicks it to focus (via the existing desktop provider), and injects bounded text. Only the ' +
    'character COUNT is ever reported — the text itself is never echoed back, recorded, or logged. The screen is ' +
    're-observed after typing when expected_after is supplied.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Element label or visible text of the input field.' },
      window_id: { type: 'string', description: 'Window id from window.list.' },
      text: { type: 'string', description: 'Text to type (the tool never echoes it back).' },
      confidence_threshold: { type: 'number', description: 'Optional minimum provider confidence in [0, 1].' },
      expected_after: {
        type: 'string',
        description: 'Optional element that should be visible AFTER typing, to verify the effect.',
      },
    },
    required: ['target', 'window_id', 'text'],
  }

  canRun(query: string): boolean {
    return /\b(type|enter|write|fill|paste into)\b/i.test(query) &&
      /\b(into|in|field|box|input|search|bar)\b/i.test(query)
  }

  async execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
    return resolveThenAct({
      vision: this.vision,
      observation: this.observation,
      desktop: this.desktop,
      input,
      ctx,
      mode: 'type',
      text: paramStr(input, 'text'),
    })
  }

  verify(input: ToolInput, result: ToolResult): Promise<ToolVerification> {
    return Promise.resolve(transitionVerifier(input, result))
  }
}

/* ------------------------------------------------------------- shared flow */

/**
 * Shared closed-loop pipeline: analyse → resolve → validate → convert →
 * stale-gate → inject (one desktop action) → re-observe → verdict.
 *
 * The vision layer only ever decides WHERE; the desktop provider performs the
 * real input exactly as `desktop.*` tools do, so every existing rail
 * (permission auto-run, cancellation, budgets, repeated-action guard) still
 * applies at the engine level.
 */
async function resolveThenAct(opts: {
  vision: VisionProvider
  observation: ObservationProvider
  desktop: DesktopProvider
  input: ToolInput
  ctx: ToolContext
  mode: 'click' | 'type'
  text?: string
}): Promise<ToolResult> {
  const { input, mode } = opts
  const blocker = availabilityBlocker(opts.vision, opts.observation, opts.desktop)
  if (blocker) return blocker

  const target = targetParam(input)
  if ('error' in target) return { ok: false, message: target.error, data: { kind: 'invalid_input' } }
  const win = windowParam(input)
  if ('error' in win) return { ok: false, message: win.error, data: { kind: 'invalid_input' } }
  const type = expectedTypeParam(input)
  if ('error' in type) return { ok: false, message: type.error, data: { kind: 'invalid_input' } }
  const conf = confidenceParam(input)
  if ('error' in conf) return { ok: false, message: conf.error, data: { kind: 'invalid_input' } }
  if (mode === 'type') {
    const rawText = paramStr(input, 'text')
    if (typeof rawText !== 'string' || rawText.length === 0) {
      return { ok: false, message: 'Text to type must be a non-empty string.', data: { kind: 'invalid_input' } }
    }
  }
  const expectedAfter = expectedAfterParam(input)

  const watch: VisionWatch = { vision: opts.vision, observation: opts.observation, ctxSignal: opts.ctx?.signal }

  // 1. See.
  const first = await analyzeOnce(watch)
  if (first.failure) return first.failure
  const analysis = first.analysis as VisionAnalysisResult
  const decisionShot = first.shot as ScreenshotResult

  // 2. Resolve (deterministic; refuses to guess).
  const resolved = resolveVisualTarget(target.target, analysis.elements, {
    expected_type: type.type,
    confidence_threshold: conf.threshold,
  })
  if (resolved.status === 'not_found') {
    return {
      ok: false,
      message: `No visual element matched "${target.target}". Nothing was injected.`,
      data: { resolution: 'not_found', target: target.target },
    }
  }
  if (resolved.status === 'ambiguous') {
    const candidates = resolved.candidates.map((c) => ({ id: c.id, type: c.type, label: c.label }))
    return {
      ok: false,
      message: `The visual target "${target.target}" is ambiguous (${resolved.candidates.length} candidates). Nothing was injected — please be more specific.`,
      data: { resolution: 'ambiguous', candidates, target: target.target },
    }
  }
  const element = resolved.element

  // 3. Validate the element footprint against the analysed viewport.
  const point = resolveClickPoint(element, analysis.viewport)
  if ('error' in point) {
    return { ok: false, message: point.error, data: { resolution: 'found', id: element.id, kind: 'invalid_input' } }
  }

  // 4. Convert viewport → screen → client using measured surfaces only.
  let windowStatus
  try {
    windowStatus = await opts.observation.getWindowStatus(win.id)
  } catch (error) {
    return visualFailure(error)
  }
  if (!windowStatus.exists) {
    return { ok: false, message: `Window ${win.id} no longer exists.`, data: { kind: 'tool_failure' } }
  }
  // Phase 1.8: the measured clientBounds give the EXACT client surface; the
  // scope guard refuses any resolved point that falls outside it (a target
  // that belongs to another window on the virtual desktop). Without client
  // bounds the documented frame approximation on `bounds` applies, and the
  // same membership check refuses out-of-window targets.
  const surface = windowSurface(windowStatus)
  if (!surface) {
    return {
      ok: false,
      message: `Window ${win.id} has no measured bounds; the visual target cannot be reliably located.`,
      data: { kind: 'tool_failure' },
    }
  }
  const virtualScreen = opts.desktop.capabilities().virtualScreen
  if (!virtualScreen) {
    return { ok: false, message: 'The desktop virtual screen is unknown; coordinates cannot be converted.', data: { kind: 'tool_failure' } }
  }
  const client = resolveClientPoint(analysis.viewport, virtualScreen, surface, point.point.x, point.point.y, windowStatus.clientBounds)
  if ('error' in client) {
    return { ok: false, message: client.error, data: { kind: 'invalid_input', windowScope: win.id } }
  }

  // 5. Stale-observation gate (Phase 1.9): NEVER inject on an observation that
  // may no longer be current. Re-verify BOTH identities the decision rested on
  // — the window geometry used for conversion, then the pixels the inventory
  // came from. Both comparisons are exact; any mismatch is a conservative
  // refusal that tells the model to re-observe (never a guess, never
  // time-based).
  const gateCancelled = userCancelled(watch.ctxSignal)
  if (gateCancelled) return gateCancelled
  let freshWindow: WindowStatus
  try {
    freshWindow = await opts.observation.getWindowStatus(win.id)
  } catch (error) {
    if (error instanceof FileSystemError && error.kind === 'not_found') {
      return staleRefusal('window_closed', win.id)
    }
    return visualFailure(error)
  }
  const shotCancelled = userCancelled(watch.ctxSignal)
  if (shotCancelled) return shotCancelled
  let freshShot: ScreenshotResult
  try {
    freshShot = await opts.observation.captureScreenshot()
  } catch (error) {
    return visualFailure(error)
  }
  const staleCause = classifyStaleness(windowStatus, freshWindow, decisionShot, freshShot)
  if (staleCause) return staleRefusal(staleCause, win.id)

  // 6. Cancel check + inject EXACTLY ONE desktop action (eyes never act twice).
  const cancelled = userCancelled(watch.ctxSignal)
  if (cancelled) return cancelled
  let injectedLength: number | undefined
  try {
    const clickResult = await opts.desktop.click(win.id, client.client.x, client.client.y)
    if (clickResult.cancelled) {
      return { ok: false, message: 'The visual click was cancelled before it was injected.', data: clickResult }
    }
    if (mode === 'type') {
      const typed = await opts.desktop.typeText(paramStr(input, 'text') as string)
      if (typed.cancelled) {
        return { ok: false, message: 'The visual typing was cancelled before it was injected.', data: typed }
      }
      injectedLength = typed.length
    }
  } catch (error) {
    return visualFailure(error)
  }

  // 7. Re-observe and close the loop with a verdict.
  const second = await analyzeOnce(watch)
  const verdict = second.analysis
    ? verifyVisualTransition({ expectedAfter, elements: second.analysis.elements })
    : { verdict: 'unverified' as const, message: 'No post-action visual state was available; the outcome could not be confirmed.' }

  const label = restingLabel(element)
  const injected = { windowId: win.id, x: client.client.x, y: client.client.y }
  const baseData = {
    resolution: { status: 'found' as const, element: { id: element.id, type: element.type, label: element.label } },
    injected,
    verdict,
  }

  if (mode === 'click') {
    return {
      ok: true,
      message: `Injected a visual click targeting "${label}" at client (${injected.x}, ${injected.y}) in window ${win.id}.`,
      data: baseData,
    }
  }
  return {
    ok: true,
    message: `Injected ${injectedLength} characters into the field "${label}" in window ${win.id}.`,
    data: { ...baseData, length: injectedLength },
  }
}

/** All visual tools bound to one provider triple (empty when any is missing). */
export function createVisualComputerTools(
  vision: VisionProvider | undefined,
  observation: ObservationProvider | undefined,
  desktop: DesktopProvider | undefined,
): Tool[] {
  if (!vision || !observation || !desktop) return []
  return [
    new VisualInspectTool(vision, observation, desktop),
    new VisualClickTool(vision, observation, desktop),
    new VisualTypeTool(vision, observation, desktop),
  ]
}