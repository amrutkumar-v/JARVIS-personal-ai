import type { Capabilities } from '../../types/capabilities'
import type { BackendUiState } from '../../state/jarvis.store'
import type { CapabilityCatalogItem } from '../../engine/contracts'

export interface CapabilityRow {
  label: string
  on: boolean
  detail?: string
  /** Capability id from the engine registry this row is derived from. */
  catalogId?: string
  /** Registry description of the capability (single source, never UI copy). */
  description?: string
}

/**
 * Phase 9 — capability rows derive from the ENGINE's live registered catalogue
 * (the same source the model addresses) where a matching capability exists,
 * falling back to the provider-connectivity rows when the engine has not aired
 * a catalogue yet (older callers / during startup). No capability name or
 * description is hard-coded here twice: catalog-backed rows use the registry
 * name/description verbatim.
 */

function withCatalogRows(
  transport: CapabilityRow[],
  categories: string[],
  catalog: readonly CapabilityCatalogItem[] | undefined,
  on: (item: CapabilityCatalogItem) => boolean,
): CapabilityRow[] {
  if (!catalog || catalog.length === 0) return transport
  const known = new Set(transport.map((r) => r.label.toLowerCase()))
  const derived: CapabilityRow[] = []
  for (const item of catalog) {
    if (!categories.includes(item.category)) continue
    if (known.has(item.name.toLowerCase())) continue
    const active = on(item)
    derived.push({
      label: item.name,
      on: active,
      catalogId: item.id,
      description: item.description,
      detail: active ? 'registered' : 'unavailable',
    })
  }
  return [...derived, ...transport]
}

export function visionRows(
  caps: Capabilities,
  catalog?: readonly CapabilityCatalogItem[],
): CapabilityRow[] {
  const transport: CapabilityRow[] = [
    { label: 'Vision', on: caps.visionAvailable },
    { label: 'OCR', on: caps.ocrAvailable },
    { label: 'UI element detection', on: caps.uiElementDetectionAvailable },
    { label: 'Target localization', on: caps.targetLocalizationAvailable },
  ]
  return withCatalogRows(transport, ['vision'], catalog, () => caps.visionAvailable)
}

export function devicesRows(
  caps: Capabilities,
  backend: BackendUiState,
  catalog?: readonly CapabilityCatalogItem[],
): CapabilityRow[] {
  const connected = backend.phase === 'connected'
  const transport: CapabilityRow[] = [
    { label: 'Device bridge', on: caps.deviceBridgeAvailable, detail: connected ? `${backend.devices.length} device${backend.devices.length === 1 ? '' : 's'}` : undefined },
    { label: 'Webcam', on: caps.cameraAvailable },
    { label: 'Microphone', on: caps.microphoneAvailable },
  ]
  return withCatalogRows(transport, ['device'], catalog, () => caps.deviceBridgeAvailable)
}

export function filesRows(
  caps: Capabilities,
  catalog?: readonly CapabilityCatalogItem[],
): CapabilityRow[] {
  const transport: CapabilityRow[] = [
    { label: 'Native agent', on: caps.nativeAgentAvailable },
    { label: 'File system', on: caps.fileSystemAvailable },
    { label: 'Observation', on: caps.nativeObservationAvailable },
  ]
  return withCatalogRows(transport, ['files'], catalog, () => caps.fileSystemAvailable)
}

export function applicationsRows(
  caps: Capabilities,
  catalog?: readonly CapabilityCatalogItem[],
): CapabilityRow[] {
  const transport: CapabilityRow[] = [
    { label: 'Applications', on: caps.nativeApplicationAvailable },
    { label: 'Desktop input', on: caps.nativeDesktopInteractionAvailable },
    { label: 'PC control', on: caps.nativeAgentAvailable },
  ]
  return withCatalogRows(
    transport,
    ['application', 'desktop'],
    catalog,
    (item) =>
      item.category === 'application'
        ? caps.nativeApplicationAvailable
        : caps.nativeDesktopInteractionAvailable,
  )
}