/**
 * Observation operation bounds (Phase 1.4) — browser-side mirror.
 *
 * These are the SAME bounds enforced by the native agent (see
 * `native/src/obsLimits.ts`); the bridge and tools re-check them so no caller
 * can bypass the caps by talking to the browser layer directly. A screenshot
 * result that would exceed a bound is reported as an honest `too_large`
 * failure — never silently downscaled or truncated.
 */
export const OBS_LIMITS = {
  /** Max windows `window.list` may return. */
  MAX_WINDOWS: 64,
  /** Max characters of one window title. */
  MAX_WINDOW_TITLE_LENGTH: 256,
  /** Max screenshot dimension the agent will capture (pixels). */
  MAX_SCREENSHOT_WIDTH: 4096,
  /** Max screenshot dimension the agent will capture (pixels). */
  MAX_SCREENSHOT_HEIGHT: 4096,
  /** Max encoded screenshot bytes the agent will return (PNG). */
  MAX_SCREENSHOT_BYTES: 3 * 1024 * 1024,
  /** Max transient raw BGRA capture buffer (dims-derived memory guard). */
  MAX_RAW_CAPTURE_BYTES: 4096 * 4096 * 4,
  /** Max wall time one screen capture may take (ms). */
  MAX_CAPTURE_TIME_MS: 1500,
} as const