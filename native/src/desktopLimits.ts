/**
 * Native Windows Agent — desktop interaction bounds (Phase 1.5).
 *
 * HANDS, NOT HANDS-OFF: the agent injects REAL input, so every action is
 * bounded and auditable. Each individual request is capped (hotkey length,
 * typed-text length, scroll magnitude, action wall-clock budget); the
 * per-RUN budgets are enforced by the Web engine per JARVIS run because the
 * agent is stateless across requests. When a request would exceed a bound
 * the agent answers with a structured `too_large` error — it NEVER silently
 * truncates or partially injects text, keys or scroll.
 */
export const DESKTOP_LIMITS = {
  /** Max mouse actions (move/click/double/right/scroll) per JARVIS run (Web-side budget). */
  MAX_MOUSE_ACTIONS_PER_RUN: 50,
  /** Max key actions (keyPress/hotkey/type) per JARVIS run (Web-side budget). */
  MAX_KEY_ACTIONS_PER_RUN: 100,
  /** Max keys one hotkey may combine (modifiers included). */
  MAX_HOTKEY_KEYS: 4,
  /** Max characters one `desktop.type` request may inject. */
  MAX_TYPE_TEXT_LENGTH: 2000,
  /** Max |delta| for one scroll request (wheel units). */
  MAX_SCROLL_DELTA: 5000,
  /** Max wall time one desktop action may take (ms). */
  MAX_DESKTOP_ACTION_TIME_MS: 1500,
  /** Max client-relative coordinate (renderer-never-exceeds sanity ceiling). */
  MAX_CLIENT_COORDINATE: 10_000,
  /** Max absolute screen coordinate the agent will accept (sanity ceiling). */
  MAX_SCREEN_COORDINATE: 1_000_000,
} as const