/**
 * Native Windows Agent — observation bounds (Phase 1.4).
 *
 * Every window/screenshot operation is bounded so observation can never become
 * an inventory dump or an unbounded memory grab. A window list caps its
 * entries, titles cap their length, and a screenshot caps its dimensions,
 * encoded byte size and wall-clock budget. When a real capture would exceed a
 * bound the agent answers with a structured `too_large` error — it NEVER
 * silently truncates or downscales a screenshot.
 */
export const OBS_LIMITS = {
  /** Max windows returned by `window.list` (focused window always kept). */
  MAX_WINDOWS: 64,
  /** Max characters of one window title. */
  MAX_WINDOW_TITLE_LENGTH: 256,
  /** Max screenshot width the agent will capture unbounded (pixels). */
  MAX_SCREENSHOT_WIDTH: 4096,
  /** Max screenshot height the agent will capture unbounded (pixels). */
  MAX_SCREENSHOT_HEIGHT: 4096,
  /** Max encoded screenshot bytes the agent will return (PNG). */
  MAX_SCREENSHOT_BYTES: 3 * 1024 * 1024,
  /**
   * Max TRANSIENT raw BGRA buffer for one capture (dims-derived). The raw
   * pixels are never shipped; only the encoded PNG is bounded by
   * MAX_SCREENSHOT_BYTES above, so this budget only guards memory.
   */
  MAX_RAW_CAPTURE_BYTES: 4096 * 4096 * 4,
  /** Max wall time one screen capture may take (ms). */
  MAX_CAPTURE_TIME_MS: 1500,
  /** Max response body the agent will serialize for one request (bytes). */
  MAX_RPC_RESPONSE_BYTES: 6 * 1024 * 1024,
} as const