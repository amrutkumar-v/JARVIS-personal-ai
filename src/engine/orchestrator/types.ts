/**
 * Phase 3.0A — Personal AI Core types (central orchestration surface).
 *
 * The engine turns raw input into a single OrchestrationRequest, reusing the
 * Phase 2.x building blocks (understanding, capability catalog, device
 * routing) through composition. Nothing here executes a goal.
 */

import type { DeviceRecord } from '../../backend/types'
import type { DeviceTransport } from '../../device/router'
import type { RequestClass } from './goalUnderstanding'

/** Routed device target with an honest availability verdict. */
export interface OrchestrationTarget {
  deviceId: string
  transport: DeviceTransport
  available: boolean
  reason?: string
}

/** The result of central orchestration for one piece of raw user input. */
export interface OrchestrationRequest {
  originalText: string
  requestClass: RequestClass
  confidence: number
  intent?: string
  entities: Record<string, unknown>
  requiresContext: boolean
  isContinuation: boolean
  contextReference?: string
  suggestedCapabilities: string[]
  targetDevices: string[]
  availableCapabilities: string[]
  unavailableCapabilities: string[]
  targets: OrchestrationTarget[]
  implicitTargetDevice?: string
  explanation: string
  processedAt: number
}

/** Minimal task-context view passed to the orchestrator. */
export interface OrchestratorTaskContext {
  artifacts?: Array<{ type: string; description: string; value: string }>
  lastPlan?: { steps?: Array<{ capability: string }> }
}

/**
 * The structural view the engine hands to the orchestrator. Only device
 * identity and provider presence flags are inspected by capability discovery;
 * the individual providers are never executed here.
 */
export interface PersonalAICoreView {
  capabilityCatalog(): Array<{ id: string }>
  taskContextStore?: { getContext(): OrchestratorTaskContext }
  deviceProvider:
    | {
        capabilities(): { available: boolean }
        refresh(): Promise<DeviceRecord[]>
      }
    | undefined
  hasActiveTask(): boolean
  fileSystemProvider: unknown
  applicationProvider: unknown
  observationProvider: unknown
  desktopProvider: unknown
  visionProvider: unknown
  cameraProvider: unknown
  webProvider: unknown
}