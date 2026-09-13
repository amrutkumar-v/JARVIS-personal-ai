/**
 * Phase 3.0 — Capability Discovery
 *
 * Dynamically inspects available capabilities across all connected devices
 * and provides a unified view for the orchestrator.
 */
/** Common interface for capability discovery — satisfied by both AssistantEngine and PersonalAICoreView. */
interface CapabilityDiscoveryEngine {
  capabilityCatalog: () => Array<{ id: string }>
  fileSystem: any
  applications: any
  observation: any
  desktop: any
  vision: any
  camera: any
  deviceProvider: any
  web: any
  clipboard: any
  hasActiveTask?: () => boolean
}

/**
 * Map capability IDs to human-readable names and categories.
 */
const CAPABILITY_METADATA: Record<string, { name: string; category: string }> = {
  // Core
  perform_calculation: { name: 'Calculator', category: 'core' },
  tell_time: { name: 'Clock', category: 'core' },
  system_inquiry: { name: 'System Info', category: 'core' },

  // Memory
  query_memory: { name: 'Recall Memory', category: 'memory' },
  store_memory: { name: 'Store Memory', category: 'memory' },

  // Files
  list_directory: { name: 'List Files', category: 'files' },
  read_file_contents: { name: 'Read File', category: 'files' },
  search_files: { name: 'Search Files', category: 'files' },
  inspect_file: { name: 'Inspect File', category: 'files' },
  create_directory: { name: 'Create Directory', category: 'files' },
  write_to_file: { name: 'Write File', category: 'files' },
  copy_file: { name: 'Copy File', category: 'files' },
  move_file: { name: 'Move File', category: 'files' },
  delete_file: { name: 'Delete File', category: 'files' },

  // Applications
  list_applications: { name: 'List Applications', category: 'applications' },
  application_status: { name: 'Check App Status', category: 'applications' },
  open_application: { name: 'Open Application', category: 'applications' },
  close_application: { name: 'Close Application', category: 'applications' },

  // Desktop/Windows
  list_windows: { name: 'List Windows', category: 'desktop' },
  window_status: { name: 'Window Status', category: 'desktop' },
  observe_desktop: { name: 'Observe Desktop', category: 'desktop' },
  move_cursor: { name: 'Move Cursor', category: 'desktop' },
  click_at: { name: 'Click', category: 'desktop' },
  double_click_at: { name: 'Double Click', category: 'desktop' },
  right_click_at: { name: 'Right Click', category: 'desktop' },
  scroll_at: { name: 'Scroll', category: 'desktop' },
  press_key: { name: 'Press Key', category: 'desktop' },
  press_hotkey: { name: 'Hotkey', category: 'desktop' },
  type_text: { name: 'Type Text', category: 'desktop' },
  focus_window: { name: 'Focus Window', category: 'desktop' },

  // Vision
  visual_inspect: { name: 'Visual Inspect', category: 'vision' },
  visual_click: { name: 'Visual Click', category: 'vision' },
  visual_type: { name: 'Visual Type', category: 'vision' },

  // Device
  list_devices: { name: 'List Devices', category: 'device' },
  send_device_notification: { name: 'Send Notification', category: 'device' },
  transfer_to_device: { name: 'Send File to Device', category: 'device' },

  // Web
  web_search: { name: 'Web Search', category: 'web' },
  web_read_page: { name: 'Read Web Page', category: 'web' },
  web_download: { name: 'Download from Web', category: 'web' },

  // Camera
  camera_capture: { name: 'Camera Capture', category: 'camera' },
}

/**
 * Determine which capabilities are available on a specific device type.
 */
function getCapabilitiesForDeviceType(deviceType: 'pc' | 'phone', providers: {
  fileSystem?: boolean
  applications?: boolean
  observation?: boolean
  desktop?: boolean
  vision?: boolean
  camera?: boolean
  device?: boolean
  web?: boolean
}): string[] {
  const capabilities: string[] = []

  // Core - always available
  capabilities.push('perform_calculation', 'tell_time', 'system_inquiry')

  // Memory - always available (browser localStorage)
  capabilities.push('query_memory', 'store_memory')

  if (deviceType === 'pc') {
    // Files - available if fileSystem provider exists
    if (providers.fileSystem) {
      capabilities.push(
        'list_directory', 'read_file_contents', 'search_files', 'inspect_file',
        'create_directory', 'write_to_file', 'copy_file', 'move_file', 'delete_file'
      )
    }

    // Applications - available if applications provider exists
    if (providers.applications) {
      capabilities.push(
        'list_applications', 'application_status', 'open_application', 'close_application',
      )
    }

    // Observation/Desktop - available if providers exist
    if (providers.observation) {
      capabilities.push('list_windows', 'window_status', 'observe_desktop')
    }
    if (providers.desktop) {
      capabilities.push(
        'move_cursor', 'click_at', 'double_click_at', 'right_click_at',
        'scroll_at', 'press_key', 'press_hotkey', 'type_text', 'focus_window'
      )
    }

    // Vision
    if (providers.vision && providers.observation && providers.desktop) {
      capabilities.push('visual_inspect', 'visual_click', 'visual_type')
    }

    // Camera
    if (providers.camera) {
      capabilities.push('camera_capture')
    }

    // Device bridge
    if (providers.device) {
      capabilities.push('list_devices', 'send_device_notification', 'transfer_to_device')
    }

    // Web
    if (providers.web) {
      capabilities.push('web_search', 'web_read_page', 'web_download')
    }
  } else if (deviceType === 'phone') {
    // Phones only have device bridge capabilities
    if (providers.device) {
      capabilities.push('list_devices', 'send_device_notification', 'transfer_to_device')
    }
  }

  return capabilities
}

/**
 * Get the metadata for a capability.
 */
function getCapabilityMeta(capabilityId: string): { name: string; category: string } {
  return CAPABILITY_METADATA[capabilityId] || { name: capabilityId, category: 'unknown' }
}

/**
 * Discover capabilities across all devices.
 */
export async function discoverCapabilities(
  engine: CapabilityDiscoveryEngine,
  devices: Array<{ id: string; name: string; type: string; online: boolean; platform: string }>
): Promise<{
  devices: Array<{
    deviceId: string
    deviceName: string
    deviceType: 'pc' | 'phone'
    online: boolean
    capabilities: Array<{ id: string; name: string; category: string; available: boolean; reason?: string }>
    categories: string[]
  }>
  globalCapabilities: Array<{ id: string; name: string; category: string; availableOn: string[] }>
  unavailableCapabilities: string[]
  discoveredAt: number
}> {
  const discoveredAt = Date.now()

  // Get provider availability from engine
  const providers = {
    fileSystem: !!engine.fileSystem,
    applications: !!engine.applications,
    observation: !!engine.observation,
    desktop: !!engine.desktop,
    vision: !!engine.vision,
    camera: !!engine.camera,
    device: !!engine.deviceProvider,
    web: !!engine.web,
    clipboard: !!engine.clipboard,
  }

  // Get all registered capabilities from engine
  const registeredCapabilities = engine.capabilityCatalog().map(c => c.id)

  // Build per-device snapshots
  let deviceSnapshots = devices.map(device => {
    const isPc = device.type === 'windows_pc' || device.type === 'desktop'
    const deviceType: 'pc' | 'phone' = isPc ? 'pc' : 'phone'
    const availableCapabilityIds = getCapabilitiesForDeviceType(deviceType, providers)
      .filter(id => registeredCapabilities.includes(id))

    const capabilities = availableCapabilityIds.map(id => {
      const meta = getCapabilityMeta(id)
      return {
        id,
        name: meta.name,
        category: meta.category,
        available: device.online,
        reason: device.online ? undefined : 'Device is offline',
      }
    })

    const categories = Array.from(new Set(
      capabilities.filter(c => c.available).map(c => c.category)
    ))

    return {
      deviceId: device.id,
      deviceName: device.name,
      deviceType,
      online: device.online,
      capabilities,
      categories,
    }
  })

  // Fallback: if we have local capability providers but no online devices,
  // create a default local PC device so local capabilities (applications,
  // desktop, browser, clipboard, etc.) remain available even when the
  // device bridge (backend) is disconnected.
  const hasOnlineDevice = deviceSnapshots.some(d => d.online)
  const hasLocalProviders = providers.applications || providers.desktop || providers.observation || providers.web || providers.clipboard || providers.fileSystem
  if (!hasOnlineDevice && hasLocalProviders && deviceSnapshots.length === 0) {
    // No devices at all from device provider - create default local PC
    const defaultPcId = 'local-pc'
    const defaultPcName = 'This PC'
    const availableCapabilityIds = getCapabilitiesForDeviceType('pc', providers)
      .filter(id => registeredCapabilities.includes(id))

    const capabilities = availableCapabilityIds.map(id => {
      const meta = getCapabilityMeta(id)
      return {
        id,
        name: meta.name,
        category: meta.category,
        available: true,
        reason: undefined,
      }
    })

    const categories = Array.from(new Set(capabilities.map(c => c.category)))

    deviceSnapshots.push({
      deviceId: defaultPcId,
      deviceName: defaultPcName,
      deviceType: 'pc',
      online: true,
      capabilities,
      categories,
    })
  } else if (!hasOnlineDevice && deviceSnapshots.length > 0) {
    // Devices exist but all offline - mark local capabilities as available on first PC device
    const firstPc = deviceSnapshots.find(d => d.deviceType === 'pc')
    if (firstPc) {
      const localCapabilityIds = getCapabilitiesForDeviceType('pc', providers)
        .filter(id => registeredCapabilities.includes(id))
      const existingIds = new Set(firstPc.capabilities.map(c => c.id))
      for (const id of localCapabilityIds) {
        if (!existingIds.has(id)) {
          const meta = getCapabilityMeta(id)
          firstPc.capabilities.push({
            id,
            name: meta.name,
            category: meta.category,
            available: true,
            reason: undefined,
          })
        }
      }
      firstPc.online = true
      firstPc.capabilities.forEach(c => { c.available = true; c.reason = undefined })
      firstPc.categories = Array.from(new Set(firstPc.capabilities.map(c => c.category)))
    }
  }

  // Build global capability view
  const capabilityToDevices = new Map<string, Set<string>>()
  for (const device of deviceSnapshots) {
    for (const cap of device.capabilities) {
      if (cap.available) {
        if (!capabilityToDevices.has(cap.id)) {
          capabilityToDevices.set(cap.id, new Set())
        }
        capabilityToDevices.get(cap.id)!.add(device.deviceId)
      }
    }
  }

  const globalCapabilities = Array.from(capabilityToDevices.entries()).map(([id, devices]) => {
    const meta = getCapabilityMeta(id)
    return {
      id,
      name: meta.name,
      category: meta.category,
      availableOn: Array.from(devices),
    }
  })

  // Find unavailable capabilities (registered but not available on any device)
  const allAvailableCapabilityIds = new Set(globalCapabilities.map(c => c.id))
  const unavailableCapabilities = registeredCapabilities.filter(
    id => !allAvailableCapabilityIds.has(id)
  )

  return {
    devices: deviceSnapshots,
    globalCapabilities,
    unavailableCapabilities,
    discoveredAt,
  }
}

/**
 * Get a human-readable capability summary for a device.
 */
export function getDeviceCapabilitySummary(device: {
  deviceId: string
  deviceName: string
  online: boolean
  capabilities: Array<{ id: string; name: string; category: string; available: boolean }>
}): string {
  if (!device.online) {
    return `${device.deviceName} is offline — no capabilities available.`
  }

  const available = device.capabilities.filter(c => c.available)
  if (available.length === 0) {
    return `${device.deviceName} is online but no capabilities are available.`
  }

  const byCategory = new Map<string, string[]>()
  for (const cap of available) {
    if (!byCategory.has(cap.category)) {
      byCategory.set(cap.category, [])
    }
    byCategory.get(cap.category)!.push(cap.name)
  }

  const parts = Array.from(byCategory.entries()).map(
    ([category, names]) => `${category}: ${names.join(', ')}`
  )

  return `${device.deviceName} capabilities: ${parts.join('; ')}`
}

/**
 * Check if a specific capability is available on any device.
 */
export function isCapabilityAvailable(
  discovery: Awaited<ReturnType<typeof discoverCapabilities>>,
  capabilityId: string
): { available: boolean; devices: string[] } {
  const global = discovery.globalCapabilities.find(c => c.id === capabilityId)
  if (!global) return { available: false, devices: [] }
  return { available: global.availableOn.length > 0, devices: global.availableOn }
}

/**
 * Get all capabilities in a category that are available on a specific device.
 */
export function getAvailableCapabilitiesOnDevice(
  discovery: Awaited<ReturnType<typeof discoverCapabilities>>,
  deviceId: string,
  category?: string
): Array<{ id: string; name: string; category: string }> {
  const device = discovery.devices.find(d => d.deviceId === deviceId)
  if (!device) return []

  return device.capabilities
    .filter(c => c.available && (!category || c.category === category))
    .map(c => ({ id: c.id, name: c.name, category: c.category }))
}