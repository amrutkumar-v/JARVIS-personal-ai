/**
 * Phase 5 — Post-action observation and verification.
 *
 * After executing a tool, observe the environment to verify the effect
 * actually happened. This is DISTINCT from tool-owned verification (which
 * lives in the Tool.verify() method). Post-action observation uses a
 * DIFFERENT tool to observe the state change.
 *
 * Examples:
 *   app.launch("notepad") → observe app.status("notepad") → running?
 *   clipboard.write("hello") → observe clipboard.read() → matches?
 *   app.close("notepad") → observe app.status("notepad") → not running?
 *   browser.search("X") → observe browser.readPage() → has results?
 */

export interface PostActionObservation {
  /** The tool that was executed. */
  actionToolId: string
  /** Optional action(s) that must run BEFORE the observation is read, so the
   * observed state actually reflects the executed action's effect. Example:
   * typing verification must first send select-all + copy to the focused
   * window before the clipboard can be read as evidence. Each entry is a real
   * registered tool executed through the regular rails — never a simulated
   * keystroke and never part of the action itself. */
  preObserve?: { toolId: string; params: Record<string, unknown>; reason: string }[]
  /** The observation tool to use. */
  observeToolId: string
  /** Parameters for the observation tool. */
  observeParams: Record<string, unknown>
  /** How to verify the observation against the expected outcome. */
  verify: (observationResult: unknown) => PostActionVerification
  /** Human-readable description of what we're verifying. */
  description: string
  /** Optional bounded wait (ms) before observing, so asynchronous effects
   * (page navigation, app startup) have time to be observable. This is a real
   * wait for a real effect — never fabricates a result. */
  settleMs?: number
  /** Optional bounded number of observation re-reads (polling) when the first
   * observation does not yet confirm the effect. Each retry re-reads the real
   * environment — used for progressive-loading pages. */
  retries?: number
  /** Delay between retry attempts (ms). */
  retryDelayMs?: number
}

export interface PostActionVerification {
  /** `unverified` means the observation could not answer the question. */
  status: 'verified' | 'failed' | 'unverified'
  /** Compatibility projection: true only for verified success. */
  passed: boolean
  message: string
}

function result(status: PostActionVerification['status'], message: string): PostActionVerification {
  return { status, passed: status === 'verified', message }
}

export interface ActionResult {
  success: boolean
  output: unknown
  summary: string
}

/**
 * Determine whether a tool execution warrants post-action observation.
 * Returns the observation plan, or undefined if no observation is needed.
 */
export function planPostActionObservation(
  toolId: string,
  input: Record<string, unknown>,
  result: ActionResult,
): PostActionObservation | undefined {
  if (!result.success) return undefined

  switch (toolId) {
    case 'app.launch':
      return planAppLaunchObservation(input)
    case 'app.close':
      return planAppCloseObservation(input)
    case 'clipboard.write':
      return planClipboardWriteObservation(input)
    case 'browser.search':
      return planBrowserSearchObservation()
    case 'browser.navigate':
      return planBrowserNavigateObservation(input)
    case 'desktop.type':
      return planDesktopTypeObservation(input)
    default:
      return undefined
  }
}

function planAppLaunchObservation(
  input: Record<string, unknown>,
): PostActionObservation {
  const appId = String(input.application_id ?? input.app_key ?? '')
  return {
    actionToolId: 'app.launch',
    observeToolId: 'app.status',
    observeParams: { application_id: appId },
    description: `Verify ${appId || 'application'} is running after launch`,
    settleMs: 4500,
    retries: 1,
    retryDelayMs: 1500,
    verify: (obs) => {
      const data = obs as Record<string, unknown> | undefined
      const running = data?.running === true
      const runningVerified = data?.runningVerified === true
      if (runningVerified && running) {
        return result('verified', `${appId || 'Application'} confirmed running.`)
      }
      if (runningVerified && !running) {
        return result('failed', `${appId || 'Application'} was not found running after launch (verified check).`)
      }
      return result('unverified', `${appId || 'Application'} launch reported success, but the platform cannot confirm its running state (not observable).`)
    },
  }
}

function planAppCloseObservation(
  input: Record<string, unknown>,
): PostActionObservation {
  const appId = String(input.application_id ?? input.app_key ?? '')
  return {
    actionToolId: 'app.close',
    observeToolId: 'app.status',
    observeParams: { application_id: appId },
    description: `Verify ${appId || 'application'} is not running after close`,
    verify: (obs) => {
      const data = obs as Record<string, unknown> | undefined
      if (data?.runningVerified !== true || typeof data.running !== 'boolean') {
        return result('unverified', `${appId || 'Application'} close could not be verified because its running state was not observable.`)
      }
      return data.running
        ? result('failed', `${appId || 'Application'} may still be running.`)
        : result('verified', `${appId || 'Application'} confirmed closed.`)
    },
  }
}

function planClipboardWriteObservation(
  input: Record<string, unknown>,
): PostActionObservation {
  const text = String(input.text ?? '')
  return {
    actionToolId: 'clipboard.write',
    observeToolId: 'clipboard.read',
    observeParams: {},
    description: 'Verify clipboard contains the written text',
    verify: (obs) => {
      const data = obs as Record<string, unknown> | undefined
      const observedText = typeof data?.text === 'string'
        ? data.text
        : typeof data?.content === 'string'
          ? data.content
          : undefined
      if (observedText === undefined) return result('unverified', 'Clipboard read did not return text, so the write could not be verified.')
      const clipText = observedText
      const match = clipText === text
      return match
        ? result('verified', 'Clipboard matches expected text.')
        : result('failed', `Clipboard text does not match (got: "${clipText.slice(0, 60)}${clipText.length > 60 ? '...' : ''}").`)
    },
  }
}

function planBrowserSearchObservation(): PostActionObservation {
  return {
    actionToolId: 'browser.search',
    observeToolId: 'browser.readPage',
    observeParams: {},
    description: 'Verify browser page has search results',
    settleMs: 1000,
    retries: 4,
    retryDelayMs: 1500,
    verify: (obs) => {
      const data = obs as Record<string, unknown> | undefined
      if (typeof data?.textLength !== 'number' || !Number.isFinite(data.textLength)) {
        return result('unverified', 'Browser observation did not report a readable text length.')
      }
      const textLength = data.textLength
      const hasContent = textLength > 50
      return hasContent
        ? result('verified', 'Browser page contains search results.')
        : result('failed', 'Browser page appears empty or has minimal content.')
    },
  }
}

function planBrowserNavigateObservation(
  input: Record<string, unknown>,
): PostActionObservation {
  const url = String(input.url ?? '')
  return {
    actionToolId: 'browser.navigate',
    observeToolId: 'browser.readPage',
    observeParams: {},
    description: `Verify browser navigated to ${url}`,
    settleMs: 500,
    retries: 3,
    retryDelayMs: 1200,
    verify: (obs) => {
      const data = obs as Record<string, unknown> | undefined
      if (typeof data?.textLength !== 'number' || !Number.isFinite(data.textLength)) {
        return result('unverified', 'Browser observation did not report a readable text length.')
      }
      const textLength = data.textLength
      const hasContent = textLength > 0
      return hasContent
        ? result('verified', 'Browser page loaded successfully.')
        : result('failed', 'Browser page appears empty after navigation.')
    },
  }
}

function planDesktopTypeObservation(
  input: Record<string, unknown>,
): PostActionObservation {
  const text = String(input.text ?? '')
  return {
    actionToolId: 'desktop.type',
    // The clipboard only becomes evidence AFTER select-all + copy run on the
    // focused window. Without these pre-observe actions the read is stale and
    // the verifier either refutes correct typing or confirms nothing.
    preObserve: [
      { toolId: 'desktop.hotkey', params: { keys: ['control', 'a'] }, reason: 'select all text in the focused window' },
      { toolId: 'desktop.hotkey', params: { keys: ['control', 'c'] }, reason: 'copy the selection to the clipboard' },
    ],
    observeToolId: 'clipboard.read',
    observeParams: {},
    description: 'Verify typed text via select-all, copy, and a clipboard read',
    settleMs: 300,
    verify: (obs) => {
      const data = obs as Record<string, unknown> | undefined
      const observedText = typeof data?.text === 'string'
        ? data.text
        : typeof data?.content === 'string'
          ? data.content
          : undefined
      if (observedText === undefined) return result('unverified', 'Clipboard read did not return text, so typing could not be verified.')
      const clipText = observedText
      // An EMPTY clipboard can never confirm typing (the pre-observe copy
      // failed or found nothing) — only a genuine match is evidence.
      const match = text.length > 0 && clipText.includes(text)
      return match
        ? result('verified', 'Typed text confirmed by reading it back from the clipboard after select-all and copy.')
        : result('failed', clipText.length === 0
          ? 'Select-all + copy produced an empty clipboard, so the typed text could not be confirmed.'
          : `Typed text not found in clipboard (got: "${clipText.slice(0, 60)}${clipText.length > 60 ? '...' : ''}").`)
    },
  }
}
