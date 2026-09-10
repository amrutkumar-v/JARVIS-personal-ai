/**
 * Desktop-interaction bounds (Phase 1.5) — browser-side mirror.
 *
 * These are the SAME bounds enforced by the native agent (see
 * `native/src/desktopLimits.ts`); the bridge and tools re-check them so no
 * caller can bypass the caps by talking to the browser layer directly. A
 * request that would exceed a bound is reported as an honest failure — never
 * silently truncated or injected partially.
 *
 * The per-RUN budgets (mouse / key action ceilings) are enforced by the Web
 * engine per JARVIS run (see `AssistantEngine`), because the native agent is
 * stateless across requests; every individual request is additionally capped
 * by the native limits below.
 */
export const DESKTOP_LIMITS = {
  /** Max mouse actions (move/click/double/right/scroll) per JARVIS run. */
  MAX_MOUSE_ACTIONS_PER_RUN: 50,
  /** Max key actions (keyPress/hotkey/type) per JARVIS run. */
  MAX_KEY_ACTIONS_PER_RUN: 100,
  /** Max keys one hotkey may combine (modifiers included). */
  MAX_HOTKEY_KEYS: 4,
  /** Max characters one `desktop.type` request may inject. */
  MAX_TYPE_TEXT_LENGTH: 2000,
  /** Max |delta| for one scroll request (wheel units). */
  MAX_SCROLL_DELTA: 5000,
  /** Max wall time one desktop action may take (ms). */
  MAX_DESKTOP_ACTION_TIME_MS: 1500,
  /** Max client-relative coordinate (sanity ceiling). */
  MAX_CLIENT_COORDINATE: 10_000,
  /** Max absolute screen coordinate the agent will accept (sanity ceiling). */
  MAX_SCREEN_COORDINATE: 1_000_000,
} as const