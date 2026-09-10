/**
 * Visual-understanding capability module (Phase 1.7) — EYES.
 *
 * Turns a TRANSIENT screenshot into bounded, structured UI elements and lets
 * the agent resolve an instruction onto exactly one of them before the EXISTING
 * desktop layer acts. The provider seam decides what is REAL:
 *  - a configured real VisionProvider → real analysis (OCR + segmentation)
 *  - otherwise → NO provider, NO visual tools, every visual capability honest
 *    'unavailable' (browser/app startup cannot "fake vision").
 *
 * The deterministic fake used by tests lives in ./testing.ts and is
 * intentionally NOT exported here so production code can never bind to it.
 */
export * from './types'
export * from './limits'
export {
  type VisionCapabilities,
  type VisionAnalysisOptions,
  type VisionProvider,
  VISION_UNAVAILABLE_MESSAGE,
  unavailableVisionCapabilities,
} from './provider'
export * from './bounds'
export * from './coords'
export * from './localize'
export * from './verification'
export * from './sanitize'
export { visualBudgetBucket, visualBudgetExceeded, visualBudgetLabel } from './budget'
export type { VisualBudgetBucket } from './budget'
export { createVisualComputerTools } from './VisualComputerTools'
export { RemoteVisionProvider, RemoteVisionError, VISION_PROMPT, createVisionProviderFromConfig } from './remoteProvider'
export type { RemoteVisionErrorKind, RemoteVisionProviderOptions } from './remoteProvider'