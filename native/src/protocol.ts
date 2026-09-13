/**
 * Native Windows Agent — wire protocol (Phase 1.2 + 1.5).
 *
 * The agent is a JSON-RPC 2.0-flavoured endpoint bound to 127.0.0.1. Every
 * request is a POST to the agent root with a typed envelope; every response is
 * a JSON envelope with the request `id` echoed back (correlation). Only the
 * methods in NATIVE_METHODS are accepted — an arbitrary "run a command" method
 * does not exist and never will. Unknown method names are rejected with a
 * structured `unsupported` error.
 */

export const NATIVE_PROTOCOL = 'jarvis-native-1'
export const NATIVE_AGENT_VERSION = '2.9.1'
export const NATIVE_DEFAULT_PORT = 8765
export const NATIVE_DEFAULT_HOST = '127.0.0.1'

export type NativeMethod =
  | 'system.identity'
  | 'system.ping'
  | 'filesystem.list'
  | 'filesystem.search'
  | 'filesystem.stat'
  | 'filesystem.read'
  | 'filesystem.write'
  | 'filesystem.mkdir'
  | 'filesystem.copy'
  | 'filesystem.move'
  | 'filesystem.rename'
  | 'filesystem.delete'
  | 'app.list'
  | 'app.status'
  | 'app.launch'
  | 'app.close'
  | 'app.refresh'
  | 'window.list'
  | 'window.status'
  | 'desktop.screenshot'
  | 'desktop.capabilities'
  | 'desktop.cursor'
  | 'desktop.move'
  | 'desktop.click'
  | 'desktop.doubleClick'
  | 'desktop.rightClick'
  | 'desktop.scroll'
  | 'desktop.keyPress'
  | 'desktop.hotkey'
  | 'desktop.type'
  | 'window.focus'
  | 'web.capabilities'
  | 'web.search'
  | 'web.fetch'
  | 'web.download'
  | 'clipboard.read'
  | 'clipboard.write'
  | 'browser.open'
  | 'browser.navigate'
  | 'browser.back'
  | 'browser.forward'
  | 'browser.refresh'
  | 'browser.click'
  | 'browser.type'
  | 'browser.readPage'
  | 'browser.search'
  | 'browser.screenshot'
  | 'browser.close'

/** Allow-list: the ONLY methods the agent will ever dispatch. */
export const NATIVE_METHODS: readonly NativeMethod[] = [
  'system.identity',
  'system.ping',
  'filesystem.list',
  'filesystem.search',
  'filesystem.stat',
  'filesystem.read',
  'filesystem.write',
  'filesystem.mkdir',
  'filesystem.copy',
  'filesystem.move',
  'filesystem.rename',
  'filesystem.delete',
  'app.list',
  'app.status',
  'app.launch',
  'app.close',
  'app.refresh',
  'window.list',
  'window.status',
  'desktop.screenshot',
  'desktop.capabilities',
  'desktop.cursor',
  'desktop.move',
  'desktop.click',
  'desktop.doubleClick',
  'desktop.rightClick',
  'desktop.scroll',
  'desktop.keyPress',
  'desktop.hotkey',
  'desktop.type',
  'window.focus',
  'web.capabilities',
  'web.search',
  'web.fetch',
  'web.download',
  'clipboard.read',
  'clipboard.write',
  'browser.open',
  'browser.navigate',
  'browser.back',
  'browser.forward',
  'browser.refresh',
  'browser.click',
  'browser.type',
  'browser.readPage',
  'browser.search',
  'browser.screenshot',
  'browser.close',
]

/**
 * Structured error codes. The Web bridge maps these onto the Web
 * `FileSystemError` kinds; unknown codes degrade to `io`/`unavailable` — never
 * a raw OS error leaking into the model.
 */
export type NativeErrorCode =
  /** Request blob / envelope could not be parsed. */
  | 'malformed'
  /** Agent reachable but its backend is not usable (bridge broken). */
  | 'native_unavailable'
  /** Token rejected or an OS access check failed. */
  | 'permission_denied'
  | 'not_found'
  | 'already_exists'
  | 'invalid_path'
  /** Operation resolved outside the configured allowed roots. */
  | 'outside_allowed_root'
  /** Method not in the allow-list, or not supported by the backend. */
  | 'unsupported'
  /** The target window no longer exists (window-targeted input / focus). */
  | 'window_not_found'
  /** The target window exists but cannot receive the input right now. */
  | 'window_not_interactable'
  /** A coordinate is outside the accepted bounds. */
  | 'coordinate_out_of_bounds'
  /** A requested key is not in the desktop key allow-list. */
  | 'unsupported_key'
  /** A parameter failed shape/type validation. */
  | 'invalid_argument'
  /** The caller requested the action be skipped before it ran. */
  | 'cancelled'
  | 'too_large'
  | 'timeout'
  /** A change did not hold after execution (verification phase). */
  | 'verification_failed'
  | 'io_error'
  /** The request's browser origin is not in the agent's CORS allow-list. */
  | 'origin_denied'
  /** A claimed application name matched more than one registered application. */
  | 'ambiguous'

export interface NativeRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Record<string, unknown>
}

export interface NativeSuccess<T = unknown> {
  jsonrpc: '2.0'
  id: string | number | null
  result: T
}

export interface NativeFailure {
  jsonrpc: '2.0'
  id: string | number | null
  error: {
    code: NativeErrorCode
    message: string
    /** Safe, structured detail (never raw OS error strings with paths). */
    data?: { path?: string; reason?: string }
  }
}

export type NativeResponse = NativeSuccess | NativeFailure

/** Safe machine/diagnostic identity (never credentials or user names). */
export interface NativeIdentity {
  protocol: string
  version: string
  platform: string
  arch: string
  node: string
  connected: true
  /** Resolved absolute allowed roots the agent may operate inside. */
  roots: string[]
  /** Whether a bearer token is required. */
  tokenRequired: boolean
}

/* ------------------------------------------------------------------ apps */

/** Application id charset: a dashboard-style id, never a path. */
export const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * One wire-safe application entry (Phase 1.3). `target` paths are an internal
 * agent-side concern and never leave the agent — the model only ever reasons
 * over `applicationId`.
 */
export interface NativeAppSpec {
  applicationId: string
  name: string
  displayName: string
  /** Where the entry came from. */
  source: 'configured' | 'discovered' | 'appPaths' | 'packaged' | 'system'
  /** Explicit allow-list flag; disabled apps never launch. */
  enabled: boolean
  /** True when the agent can actually start the resolved target. */
  launchable: boolean
  /**
   * How the agent starts this application. `exe` spawns a real executable;
   * `aumid` routes a packaged/Store app through `explorer.exe
   * shell:AppsFolder\<aumid>`; `uri` routes a safe URI (e.g. `ms-settings:`)
   * through `explorer.exe`. Never built from user text — always validated.
   */
  launchMechanism?: 'exe' | 'aumid' | 'uri'
  /** Extra names the registry can resolve for this application (never targets). */
  aliases?: string[]
  /**
   * Actual process-image name (basename without `.exe`) used for running-state
   * observation. Absent when the platform cannot observe the app's process
   * (e.g. packaged/Store apps observed only through a host process).
   */
  processImage?: string
}

export interface NativeAppRefreshResult {
  /** Total records after the refresh (configured + discovered). */
  total: number
  /** Count of discovered entries alive after the refresh. */
  discovered: number
  /** Count of configured entries. */
  configured: number
  /** Wall-clock time the refresh finished. */
  refreshedAt: number
}

export interface NativeAppStatusResult extends NativeAppSpec {
  /** Honest process observation; `runningVerified: false` when unmeasurable. */
  running: boolean
  runningVerified: boolean
}

export interface NativeAppLaunchResult {
  applicationId: string
  started: boolean
  /** Spawned process id, when known. */
  pid?: number
  /** True only when the process was observed alive within the verify window. */
  verified: boolean
  /** Provider-safe explanation (never a raw OS error). */
  detail: string
}

/* --------------------------------------------------------------- observe */

/**
 * Window id charset (Phase 1.4): a decimal serialization of the HWND. It is an
 * OPAQUE identifier — never a memory address, never an OS path, never valid
 * across sessions. The engine validates with `WINDOW_ID_PATTERN` before any
 * backend is consulted; a window that has closed is simply `not_found`.
 */
export const WINDOW_ID_PATTERN = /^\d{1,10}$/
export const MAX_WINDOW_ID_LENGTH = 10

/** One wire-safe top-level window summary — observation only, never a path. */
export interface NativeWindowSummary {
  /** Opaque decimal window id (validated by WINDOW_ID_PATTERN). */
  windowId: string
  title: string
  /** Owning process id, when observable. */
  pid?: number
  /** Executable NAME only (never a path). */
  processName?: string
  visible: boolean
  minimized: boolean
  maximized: boolean
  /** Window bounds (screen pixels); absent when the OS does not report them. */
  bounds?: { left: number; top: number; right: number; bottom: number }
  /** Client-area bounds in screen coordinates; measured via GetClientRect + ClientToScreen. */
  clientBounds?: { left: number; top: number; right: number; bottom: number }
}

export interface NativeWindowStatusResult {
  windowId: string
  /** True when the window still exists right now (verify target). */
  exists: boolean
  title: string
  pid?: number
  processName?: string
  visible: boolean
  minimized: boolean
  maximized: boolean
  bounds?: { left: number; top: number; right: number; bottom: number }
  /** Client-area bounds in screen coordinates; measured via GetClientRect + ClientToScreen. */
  clientBounds?: { left: number; top: number; right: number; bottom: number }
}

export interface NativeScreenshotResult {
  width: number
  height: number
  format: 'png'
  /** Encoded bytes; MUST be bounded, transient and never persisted/logged. */
  bytesLength: number
  bytes: string
}

/* ----------------------------------------------------------- desktop in */

/**
 * Desktop interaction results (Phase 1.5). These are the honest wire
 * contracts for real injected input: the agent states what it INJECTED and
 * what it could VERIFY, and it never claims semantic success it cannot see.
 * `cancelled: true` means the caller revoked the action before it ran and
 * NOTHING was injected (single-action semantics — there are no queued inputs).
 */
export interface NativeDesktopLimitsResult {
  maxHotkeyKeys: number
  maxTypeTextLength: number
  maxScrollDelta: number
  maxDesktopActionTimeMs: number
  maxClientCoordinate: number
  maxScreenCoordinate: number
}

export interface NativeDesktopCapabilitiesResult {
  /** Whether input can be injected on this host right now. */
  available: boolean
  /** Whether the Win32 input/foreground API family is present. */
  hasApi: boolean
  /** Provider-safe reason when unavailable (never a raw OS error string). */
  reason?: string
  /** Virtual-desktop bounds (screen pixels; origin may be negative). */
  virtualScreen?: { left: number; top: number; width: number; height: number }
  /** The bounded input parameters the agent enforces. */
  limits: NativeDesktopLimitsResult
}

/** Current cursor position (virtual-desktop screen coordinates). */
export interface NativeCursorResult {
  x: number
  y: number
  /** True when the position was read from the OS rather than estimated. */
  measured: boolean
}

export interface NativeDesktopMoveResult {
  /** Virtual-desktop screen coordinates the cursor was moved to. */
  x: number
  y: number
  /** True only when a post-move read of GetCursorPos matches the target. */
  verified: boolean
  /** True when the caller cancelled the action before it ran. */
  cancelled: boolean
}

export interface NativeDesktopClickResult {
  windowId: string
  /** Client-relative coordinates the action was targeted at. */
  x: number
  y: number
  /** True when the click sequence was actually injected. */
  injected: boolean
  /** True when the caller cancelled the action before it ran. */
  cancelled: boolean
}

export interface NativeDesktopScrollResult extends NativeDesktopClickResult {
  /** Signed wheel units actually injected (always bounded by the limits). */
  delta: number
}

/** Result of a key / hotkey / typed-text injection (no length or content ). */
export interface NativeDesktopActionResult {
  /** True when the input bytes were actually injected. */
  injected: boolean
  /** True when the caller cancelled the action before it ran. */
  cancelled: boolean
}

export interface NativeDesktopFocusResult {
  windowId: string
  /** True only when the target is the foreground window right now. */
  focused: boolean
  /** Provider-safe explanation of the post-attempt state. */
  detail: string
}

/* ------------------------------------------------------------------ web */

/**
 * Web capability surface (Phase 2.9). The agent is the ONLY place real
 * outbound HTTP runs: the browser never fetches arbitrary pages directly
 * (CORS + it would bypass the SSRF/time/size bounds). `web.*` methods are
 * read-only external communication — content returned is UNTRUSTED DATA, never
 * instructions (the Web bridge and engine frame it as such).
 */
export interface NativeWebCapabilitiesResult {
  /** Whether the web backend is wired in this agent build. */
  search: boolean
  /** Whether page fetching/extraction is available. */
  fetch: boolean
  /** Whether bounded downloads are available. */
  download: boolean
}

/** ONE search hit, wire-safe. Snippet text is untrusted web content (DATA). */
export interface NativeSearchResultItem {
  title: string
  /** Absolute http(s) result url (redirect-decoded agent-side). */
  url: string
  /** Untrusted extractive snippet — never rendered as instructions. */
  snippet: string
}

export interface NativeSearchResponse {
  /** The query actually searched (post-trim). */
  query: string
  /** Provider label, e.g. "duckduckgo". Never faked. */
  provider: string
  /** Wall-clock the search was served. */
  servedAt: number
  results: NativeSearchResultItem[]
  /** Honest freshness statement. When not directly verifiable, says so. */
  freshness: { detectable: boolean; note: string }
}

export interface NativeFetchResponse {
  /** Requested url. */
  url: string
  /** Final url after any followed redirects. */
  finalUrl: string
  status: number
  contentType?: string
  /** Page <title> when the document provided one. */
  title?: string
  /**
   * Extracted, bounded, readable text of the document. THIS IS UNTRUSTED
   * DATA — never a source of instructions.
   */
  text: string
  /** Characters of tail truncated away because the text exceeded the cap. */
  truncatedChars: number
  bytes: number
  fetchedAt: number
}

export interface NativeDownloadResponse {
  url: string
  finalUrl: string
  status: number
  contentType?: string
  /** Bounded raw (decoded) text payload. UNTRUSTED DATA. */
  content: string
  /** True when the payload was capped before the stream ended. */
  truncated: boolean
  size: number
  fetchedAt: number
}

/* ----------------------------------------------------------- clipboard */

export interface NativeClipboardReadResult {
  success: boolean
  /** The clipboard text content (UTF-16 on Windows). */
  text: string
  /** Byte length of the UTF-16 text read. */
  byteLength: number
  /** True when the read was verified. */
  verified: boolean
}

export interface NativeClipboardWriteResult {
  success: boolean
  /** Byte length of the UTF-16 text written. */
  byteLength: number
  /** True when the write was verified by reading back. */
  verified: boolean
}

/* ----------------------------------------------------------- app close */

export interface NativeAppCloseResult {
  applicationId: string
  terminated: boolean
  /** True when the process was confirmed not running. */
  verified: boolean
  /** Provider-safe explanation. */
  detail: string
}

/* ------------------------------------------------------------ browser */

export interface NativeBrowserOpenResult {
  success: boolean
  url: string
}

export interface NativeBrowserNavResult {
  success: boolean
  url: string
  title: string
  verified: boolean
}

export interface NativeBrowserActionResult {
  success: boolean
  url: string
  title: string
}

export interface NativeBrowserTypeResult {
  success: boolean
  verified: boolean
}

export interface NativeBrowserReadPageResult {
  success: boolean
  title: string
  url: string
  text: string
}

export interface NativeBrowserSearchResult {
  success: boolean
  url: string
  title: string
  results: Array<{ title: string; url: string; snippet: string }>
}

export interface NativeBrowserScreenshotResult {
  success: boolean
  width: number
  height: number
  bytes: string
  format: 'png'
}