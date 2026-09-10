/**
 * Windows observation capability module (Phase 1.4) — EYES, NOT HANDS.
 *
 * Read-only window + desktop sensing surface. The provider seam decides
 * what is REAL:
 *  - native bridge (`src/native`) → the REAL local Windows agent
 *  - browser mode → NO provider (hence NO observation tools at all)
 *
 * The fake in-memory provider used by tests lives in ./testing.ts and is
 * intentionally NOT exported here so production code can never bind to it.
 */
export * from './provider'
export { OBS_LIMITS } from './limits'
export { verifyPngEnvelope } from './pngVerify'
export { createObservationTools, WindowListTool, WindowStatusTool, DesktopScreenshotTool } from './ObservationTools'