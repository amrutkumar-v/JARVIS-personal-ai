import { describe, expect, it } from 'vitest'
import { visionRows, devicesRows, filesRows, applicationsRows } from './capabilityData'
import type { Capabilities } from '../../types/capabilities'
import type { BackendUiState } from '../../state/jarvis.store'
import type { CapabilityCatalogItem } from '../../engine/contracts'

const CATALOG: CapabilityCatalogItem[] = [
  { id: 'visual_inspect', name: 'Visually inspect the screen', category: 'vision', description: 'Analyze the current screen to find elements or describe what is shown.' },
  { id: 'list_directory', name: 'List files in a directory', category: 'files', description: 'List the entries of a directory on the local file system.' },
  { id: 'read_file_contents', name: 'Read a file', category: 'files', description: 'Read the text content of a local file.' },
  { id: 'list_applications', name: 'List applications', category: 'application', description: 'List applications known to the native application bridge.' },
  { id: 'open_application', name: 'Open application', category: 'application', description: 'Launch the app identified by its registered app key.' },
  { id: 'observe_desktop', name: 'Observe the desktop', category: 'desktop', description: 'Capture the current screen state for inspection.' },
  { id: 'list_devices', name: 'List companion devices', category: 'device', description: 'List companion phones registered with the backend.' },
]

function caps(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    aiConnected: false,
    aiConfigured: false,
    speechRecognitionAvailable: false,
    speechSynthesisAvailable: false,
    wakeWordAvailable: false,
    voiceInteractionAvailable: false,
    microphoneAvailable: false,
    memoryEnabled: false,
    toolsEnabled: false,
    callingEnabled: false,
    fileSystemAvailable: false,
    nativeAgentAvailable: false,
    nativeApplicationAvailable: false,
    nativeObservationAvailable: false,
    nativeDesktopInteractionAvailable: false,
    visionAvailable: false,
    ocrAvailable: false,
    uiElementDetectionAvailable: false,
    targetLocalizationAvailable: false,
    cameraAvailable: false,
    deviceBridgeAvailable: false,
    webAccessAvailable: false,
    ...overrides,
  }
}

function backend(overrides: Partial<BackendUiState> = {}): BackendUiState {
  return {
    phase: 'idle',
    health: null,
    devices: [],
    lastInboundAt: null,
    lastWake: null,
    ...overrides,
  }
}

describe('capabilityData — vision', () => {
  it('returns 4 rows', () => {
    expect(visionRows(caps())).toHaveLength(4)
  })

  it('reflects capability flags', () => {
    const c = caps({ visionAvailable: true, ocrAvailable: true })
    const rows = visionRows(c)
    expect(rows.find((r) => r.label === 'Vision')!.on).toBe(true)
    expect(rows.find((r) => r.label === 'OCR')!.on).toBe(true)
    expect(rows.find((r) => r.label === 'UI element detection')!.on).toBe(false)
  })
})

describe('capabilityData — devices', () => {
  it('shows device count in detail when connected', () => {
    const b = backend({ phase: 'connected', devices: [{ id: 'a', name: 'PC', online: true, role: 'primary_pc', health: 'ok', capabilities: [] } as any] })
    const rows = devicesRows(caps({ deviceBridgeAvailable: true }), b)
    const bridge = rows.find((r) => r.label === 'Device bridge')!
    expect(bridge.on).toBe(true)
    expect(bridge.detail).toBe('1 device')
  })

  it('shows no detail when disconnected', () => {
    const b = backend({ phase: 'waiting' })
    const rows = devicesRows(caps(), b)
    const bridge = rows.find((r) => r.label === 'Device bridge')!
    expect(bridge.on).toBe(false)
    expect(bridge.detail).toBeUndefined()
  })
})

describe('capabilityData — files', () => {
  it('returns 3 rows', () => {
    expect(filesRows(caps())).toHaveLength(3)
  })

  it('maps flags correctly', () => {
    const c = caps({ nativeAgentAvailable: true, fileSystemAvailable: false, nativeObservationAvailable: true })
    const rows = filesRows(c)
    expect(rows.find((r) => r.label === 'Native agent')!.on).toBe(true)
    expect(rows.find((r) => r.label === 'File system')!.on).toBe(false)
    expect(rows.find((r) => r.label === 'Observation')!.on).toBe(true)
  })
})

describe('capabilityData — applications', () => {
  it('returns 3 rows', () => {
    expect(applicationsRows(caps())).toHaveLength(3)
  })
})

describe('capabilityData — catalog-derived rows (single source)', () => {
  it('files panel derives rows from the registry catalogue when available', () => {
    const rows = filesRows(caps({ fileSystemAvailable: true }), CATALOG)
    const catalogRows = rows.filter((r) => r.catalogId)
    expect(catalogRows.map((r) => r.catalogId)).toEqual(['list_directory', 'read_file_contents'])
    expect(catalogRows[0]?.label).toBe('List files in a directory')
    expect(catalogRows[0]?.on).toBe(true)
    expect(catalogRows[0]?.description?.toLowerCase()).toContain('list')
    expect(rows.map((r) => r.label)).toContain('Native agent')
  })

  it('catalog rows report unavailable when the transport flag is off', () => {
    const rows = filesRows(caps(), CATALOG)
    expect(rows.find((r) => r.catalogId === 'list_directory')?.on).toBe(false)
  })

  it('vision rows gate on the vision provider flag', () => {
    const rows = visionRows(caps({ visionAvailable: true }), CATALOG)
    const inspect = rows.find((r) => r.catalogId === 'visual_inspect')!
    expect(inspect.label).toBe('Visually inspect the screen')
    expect(inspect.on).toBe(true)
  })

  it('applications panel mixes application and desktop catalog rows with their own gates', () => {
    const apps = applicationsRows(
      caps({ nativeApplicationAvailable: true, nativeDesktopInteractionAvailable: true }),
      CATALOG,
    )
    expect(apps.find((r) => r.catalogId === 'open_application')?.on).toBe(true)
    expect(apps.find((r) => r.catalogId === 'observe_desktop')?.on).toBe(true)
    const desktopOff = applicationsRows(caps({ nativeApplicationAvailable: true }), CATALOG)
    expect(desktopOff.find((r) => r.catalogId === 'observe_desktop')?.on).toBe(false)
  })

  it('devices panel derives from the device catalogue', () => {
    const b = backend({ phase: 'connected', devices: [] })
    const rows = devicesRows(caps({ deviceBridgeAvailable: true }), b, CATALOG)
    expect(rows.find((r) => r.catalogId === 'list_devices')?.label).toBe('List companion devices')
    expect(rows.find((r) => r.label === 'Device bridge')?.on).toBe(true)
  })

  it('no catalog means the original transport rows only (backwards compatible)', () => {
    expect(filesRows(caps())).toHaveLength(3)
    expect(visionRows(caps())).toHaveLength(4)
    expect(filesRows(caps()).every((r) => !r.catalogId)).toBe(true)
  })
})
