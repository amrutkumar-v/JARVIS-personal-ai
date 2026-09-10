/**
 * Phase 3.0A — Personal AI Core (central orchestration entry).
 *
 * Composes the Phase 2.x building blocks into one deterministic pass:
 * normalize → capability discovery → task context → understanding →
 * device target resolution → OrchestrationRequest. It never executes a
 * goal; Phase 3.0B wires the request into plan/execute/observe/verify.
 */

import type { DeviceRecord } from '../../backend/types'
import { routeDeviceTarget } from '../../device/router'
import { discoverCapabilities } from './capabilityDiscovery'
import { understandRequest } from './goalUnderstanding'
import type { OrchestrationRequest, OrchestrationTarget, PersonalAICoreView } from './types'

/** Default execution host for implicit local commands (trusted policy). */
const DEFAULT_HOST_DEVICE = 'victus-5050'

export class PersonalAICore {
  /** Turn raw user input into a structured orchestration request. */
  async orchestrate(text: string, view: PersonalAICoreView): Promise<OrchestrationRequest> {
    const originalText = text.trim()

    const devices: DeviceRecord[] = view.deviceProvider
      ? await view.deviceProvider.refresh().catch(() => [])
      : []

    const discovery = await discoverCapabilities(view, devices)
    // Reachable-now capability surface: registered capabilities that are
    // actually available on at least one online device this pass.
    const availableCapabilities = discovery.globalCapabilities.map((c) => c.id)

    const understanding = understandRequest(originalText, {
      devices,
      hasActiveTask: view.hasActiveTask(),
      lastTaskContext: view.taskContextStore?.getContext(),
      availableCapabilities,
    })

    const explicitTargets = understanding.targetDevices
    const targets: OrchestrationTarget[] = explicitTargets.map((id) => routeDeviceTarget(devices, id))

    let implicitTargetDevice: string | undefined
    if (
      (understanding.class === 'command' || understanding.class === 'device_operation') &&
      targets.length === 0
    ) {
      implicitTargetDevice = DEFAULT_HOST_DEVICE
      targets.push(routeDeviceTarget(devices, DEFAULT_HOST_DEVICE))
    }

    return {
      originalText,
      requestClass: understanding.class,
      confidence: understanding.confidence,
      intent: understanding.intent,
      entities: understanding.entities,
      requiresContext: understanding.requiresContext,
      isContinuation: understanding.isContinuation,
      contextReference: understanding.contextReference,
      suggestedCapabilities: understanding.suggestedCapabilities,
      targetDevices: explicitTargets,
      availableCapabilities,
      unavailableCapabilities: discovery.unavailableCapabilities,
      targets,
      implicitTargetDevice,
      explanation: understanding.explanation,
      processedAt: Date.now(),
    }
  }
}