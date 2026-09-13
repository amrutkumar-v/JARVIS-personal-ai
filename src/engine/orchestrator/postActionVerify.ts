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
  passed: boolean
  message: string
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
    verify: (obs) => {
      const data = obs as Record<string, unknown> | undefined
      const running = data?.running === true
      return {
        passed: running,
        message: running
          ? `${appId || 'Application'} confirmed running.`
          : `${appId || 'Application'} did not start or is not running.`,
      }
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
      const running = data?.running === true
      return {
        passed: !running,
        message: !running
          ? `${appId || 'Application'} confirmed closed.`
          : `${appId || 'Application'} may still be running.`,
      }
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
      const clipText = String(data?.text ?? data?.content ?? '')
      const match = clipText === text
      return {
        passed: match,
        message: match
          ? 'Clipboard matches expected text.'
          : `Clipboard text does not match (got: "${clipText.slice(0, 60)}${clipText.length > 60 ? '...' : ''}").`,
      }
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
      const textLength = Number(data?.textLength ?? 0)
      const hasContent = textLength > 50
      return {
        passed: hasContent,
        message: hasContent
          ? 'Browser page contains search results.'
          : 'Browser page appears empty or has minimal content.',
      }
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
      const textLength = Number(data?.textLength ?? 0)
      const hasContent = textLength > 0
      return {
        passed: hasContent,
        message: hasContent
          ? `Browser page loaded successfully.`
          : 'Browser page appears empty after navigation.',
      }
    },
  }
}

function planDesktopTypeObservation(
  input: Record<string, unknown>,
): PostActionObservation {
  const text = String(input.text ?? '')
  return {
    actionToolId: 'desktop.type',
    observeToolId: 'clipboard.read',
    observeParams: {},
    description: 'Verify typed text via clipboard (Ctrl+A, Ctrl+C)',
    verify: (obs) => {
      const data = obs as Record<string, unknown> | undefined
      const clipText = String(data?.text ?? data?.content ?? '')
      const match = clipText.includes(text)
      return {
        passed: match,
        message: match
          ? 'Typed text verified in clipboard.'
          : `Typed text not found in clipboard (got: "${clipText.slice(0, 60)}${clipText.length > 60 ? '...' : ''}").`,
      }
    },
  }
}
