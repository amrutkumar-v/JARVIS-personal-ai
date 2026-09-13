import type { Tool, ToolCategory, ToolContext, ToolContextId, ToolInput, ToolPermission, ToolResult, ToolVerification } from '../tools/Tool'
import type { ToolInputSchema } from '../engine/provider'
import type { DeviceErrorKind, DeviceRecord } from '../backend/types'
import type { DeviceProvider } from './provider'
import { resolveDeviceTarget, TRUSTED_DEVICE_ORDER } from './trusted'
import { routeDeviceTarget } from './router'

/**
 * Device bridge tools (Phase 2.8) — personal four-device ecosystem.
 *
 *   device.list     read_only        read the real backend registry (trusted four)
 *   device.status   read_only        detailed status of one trusted device / all
 *   device.notify   low_risk         notification for a device or a natural phrase
 *   device.sendFile low_risk         store a bounded file for a device to fetch
 *
 * Targets are resolved in the browser (aliases like "my phone"), but every
 * route is validated against the live registry before it is attempted: an
 * offline device, an unknown id, or an ambiguous phrase comes back as an
 * honest failure with a reason. Nothing is ever claimed optimistically.
 */
const DEVICE_BRIDGE_REASON = 'JARVIS Core backend is not connected, so no companion devices can be reached right now.'

export const ROLE_LABEL: Record<string, string> = {
  primary_pc: 'main PC',
  secondary_pc: 'secondary PC (Dell laptop)',
  primary_phone: 'main phone',
  secondary_phone: 'second phone',
}

function availabilityBlocker(provider: DeviceProvider): ToolResult | null {
  const caps = provider.capabilities()
  if (caps.available) return null
  return {
    ok: false,
    message: `Device bridge is not available right now: ${caps.reason ?? DEVICE_BRIDGE_REASON}`,
    data: { available: false, reason: caps.reason ?? DEVICE_BRIDGE_REASON },
  }
}

function paramStr(input: ToolInput, key: string): string | undefined {
  const value = input.params?.[key]
  return typeof value === 'string' ? value : undefined
}

export interface ResolvedTargetInput {
  deviceId?: string
  error?: string
}

/** Resolve an optional device value to a canonical trusted id (or an honest error). */
export function resolveTargetInput(raw: string | undefined): ResolvedTargetInput {
  if (!raw || !raw.trim()) return {}
  const resolved = resolveDeviceTarget(raw)
  if (resolved.ambiguous) {
    return {
      error: `That phrase matches more than one device (${(resolved.matched ?? []).join(', ')}). Say which one, e.g. "my phone" or "the Dell laptop".`,
    }
  }
  if (!resolved.target) {
    return {
      error:
        'I do not recognise that as one of your four trusted devices (main PC, Dell laptop, S26 Ultra, S23 FE). Say e.g. "my phone", "my computer" or "my other laptop".',
    }
  }
  return { deviceId: resolved.target }
}

abstract class DeviceTool implements Tool {
  readonly category: ToolCategory = 'system'
  readonly verifiable: boolean = false
  readonly requiresPermission: boolean = false
  /** The four-device ecosystem is reachable from both the PC and phone scopes. */
  readonly contexts: ToolContextId[] = ['android', 'desktop']
  protected readonly provider: DeviceProvider

  constructor(provider: DeviceProvider) {
    this.provider = provider
  }

  abstract readonly id: string
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly permission: ToolPermission
  abstract readonly inputSchema: ToolInputSchema

  abstract canRun(query: string): boolean
  abstract execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult>
}

function deviceLine(d: DeviceRecord): string {
  const role = d.role ? ROLE_LABEL[d.role] ?? d.role : undefined
  const bits = [role, d.online ? 'online' : `offline${d.health === 'stale' ? ' (stale)' : ''}`, d.platform, d.connection]
  if (typeof d.battery === 'number') bits.push(`battery ${d.battery}%${d.charging ? ' (charging)' : ''}`)
  if (d.network) bits.push(d.network)
  if (d.version) bits.push(`agent ${d.version}`)
  return `- ${d.name} (${d.id}): ${bits.filter(Boolean).join(' · ')}`
}

/* ---------------------------------------------------------------- list */

export class DeviceListTool extends DeviceTool {
  readonly id = 'device.list'
  readonly name = 'List my devices'
  readonly description =
    'List the four trusted personal devices (main PC, Dell laptop, S26 Ultra, S23 FE) and whether each is online right now, ' +
    'straight from the real JARVIS Core registry. Never estimates reachability.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = { type: 'object', properties: {}, required: [] }

  canRun(query: string): boolean {
    return /\b(device|devices|phone|phones|laptop|pc)\b/i.test(query) && /\b(list|status|online|connected|where|all)\b/i.test(query)
  }

  async execute(_input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    try {
      const devices = await this.provider.refresh()
      const ordered = [...devices].sort((a, b) => TRUSTED_DEVICE_ORDER.indexOf(a.id) - TRUSTED_DEVICE_ORDER.indexOf(b.id))
      const online = ordered.filter((d) => d.online).length
      if (ordered.length === 0) {
        return {
          ok: true,
          message:
            'Your four trusted devices (main PC, Dell laptop, S26 Ultra, S23 FE) are all offline — the JARVIS Core registry cannot be reached right now.',
          data: { devices: [] },
        }
      }
      const lines = ordered.map(deviceLine)
      return {
        ok: true,
        message: `${online} of ${ordered.length} devices online.\n${lines.join('\n')}`,
        data: { devices: ordered, count: ordered.length, online },
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Could not list devices.', data: { deviceError: 'device_unavailable' } }
    }
  }
}

/* ---------------------------------------------------------------- status */

export class DeviceStatusTool extends DeviceTool {
  readonly id = 'device.status'
  readonly name = 'Device status'
  readonly description =
    'Detailed status for one of the four trusted devices (say "my phone" or give a device id) or for all of them: online state, ' +
    'role, connection, battery, network and agent version. Reads the live backend registry; reports stale/offline honestly.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      device: { type: 'string', description: 'Optional: a device id or a natural phrase such as "my phone", "the Dell" or "my computer". Omit for all four.' },
    },
    required: [],
  }

  canRun(query: string): boolean {
    return /\b(status|health|battery|charge|online|offline|reachable|last seen)\b/i.test(query) || /\b(how is|is (my|the)) (phone|pc|laptop)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    try {
      const devices = await this.provider.refresh()
      if (devices.length === 0) {
        return { ok: true, message: 'No device status is available — the JARVIS Core registry cannot be reached right now.', data: { devices: [] } }
      }
      const rawTarget = paramStr(input, 'device')?.trim()
      const resolved = resolveTargetInput(rawTarget)
      if (resolved.error)
        return { ok: false, message: resolved.error, data: { kind: 'invalid_target', deviceError: 'device_not_found' } }

      const ordered = [...devices].sort((a, b) => TRUSTED_DEVICE_ORDER.indexOf(a.id) - TRUSTED_DEVICE_ORDER.indexOf(b.id))
      const focus = resolved.deviceId
        ? ordered.find((d) => d.id === resolved.deviceId)
        : undefined
      if (resolved.deviceId && !focus) {
        return {
          ok: false,
          message: `"${resolved.deviceId}" is not registered with JARVIS Core right now.`,
          data: { deviceId: resolved.deviceId, deviceError: 'device_not_found' },
        }
      }
      const shown = focus ? [focus] : ordered
      const lines = shown.map(deviceLine)
      return { ok: true, message: lines.join('\n'), data: { devices: shown, count: ordered.length, online: ordered.filter((d) => d.online).length } }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Could not read device status.',
        data: { deviceError: 'device_unavailable' },
      }
    }
  }
}

/* ---------------------------------------------------------------- notify */

export class DeviceNotifyTool extends DeviceTool {
  readonly id = 'device.notify'
  readonly name = 'Send a device notification'
  readonly description =
    'Send a short notification to one of your trusted devices (main PC, Dell laptop, S26 Ultra, S23 FE). The device value can be a ' +
    'device id or a natural phrase such as "my phone", "my computer", "my other laptop" or "my other phone". Delivered only while ' +
    'that device actually reports online; an offline or unknown target is refused with an honest reason.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      device: { type: 'string', description: 'Optional target: device id or phrase ("my phone"). Omit to broadcast to every online device.' },
      title: { type: 'string', description: 'Short notification title (<= 120 chars).' },
      message: { type: 'string', description: 'Notification text (<= 2000 chars).' },
    },
    required: ['title', 'message'],
  }

  canRun(query: string): boolean {
    return /\b(notify|notification|alert|remind me on|ping)\b/i.test(query) || /\b(notify|send.*to)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const title = paramStr(input, 'title')?.trim()
    const message = paramStr(input, 'message')?.trim()
    if (!title || !message) {
      return { ok: false, message: 'A notification needs both a title and a message.', data: { kind: 'invalid_input' } }
    }
    const resolved = resolveTargetInput(paramStr(input, 'device'))
    if (resolved.error) return { ok: false, message: resolved.error, data: { kind: 'invalid_target', deviceError: 'device_not_found' } }
    try {
      const devices = await this.provider.refresh()
      const route = routeDeviceTarget(devices, resolved.deviceId)
      if (!route.available) {
        return {
          ok: false,
          message: `The notification was not sent: ${route.reason ?? 'no route to that device right now.'}`,
          data: { delivered: false, reason: route.reason, deviceError: 'device_disconnected' },
        }
      }
      const result = await this.provider.notify({
        device: resolved.deviceId ?? undefined,
        title,
        message,
      })
      if (!result.delivered) {
        return {
          ok: false,
          message: `The notification could not be delivered: ${result.reason ?? 'no online device accepted it.'}`,
          data: { ...result, deviceError: 'device_disconnected' },
        }
      }
      const where = result.deliveredTo.length > 0 ? ` to ${result.deliveredTo.join(', ')}` : ''
      return { ok: true, message: `Notification delivered${where}.`, data: result }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Could not send the notification.', data: { deviceError: 'device_unavailable' } }
    }
  }

  verify(_input: ToolInput, result: ToolResult): ToolVerification {
    const delivered = result.ok === true
    return {
      ok: delivered,
      message: delivered ? 'Delivery confirmed by the backend.' : 'Backend reported no device accepted the notification.',
      checks: ['device-online-accepted'],
    }
  }
}

/* ---------------------------------------------------------------- sendFile */

export class DeviceSendFileTool extends DeviceTool {
  readonly id = 'device.sendFile'
  readonly name = 'Send a file to a device'
  readonly description =
    'Store a bounded text file (<= 25 MB as base64 in the POST body) on the JARVIS Core backend for one of your trusted devices to ' +
    'download. The device value accepts a device id or a natural phrase ("my phone"). The file is stored even if the target is ' +
    'currently offline and will appear when that device comes back.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'File name, e.g. notes.txt.' },
      content: { type: 'string', description: 'File contents as a BASE64 string.' },
      device: { type: 'string', description: 'Optional target: device id or phrase ("my phone"). Omit for any online device.' },
    },
    required: ['name', 'content'],
  }

  canRun(query: string): boolean {
    return /\b(send|transfer|push|give)\b/i.test(query) && /\b(file|files|document|notes)\b/i.test(query) && /\b(phone|device|laptop|pc)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const name = paramStr(input, 'name')?.trim()
    const content = paramStr(input, 'content')
    if (!name || !content) {
      return { ok: false, message: 'A file transfer needs both a file name and base64 content.', data: { kind: 'invalid_input' } }
    }
    const resolved = resolveTargetInput(paramStr(input, 'device'))
    if (resolved.error) return { ok: false, message: resolved.error, data: { kind: 'invalid_target', deviceError: 'device_not_found' } }
    try {
      const devices = await this.provider.refresh()
      const route = routeDeviceTarget(devices, resolved.deviceId)
      if (!route.available && route.deviceId !== 'all' && !resolved.deviceId) {
        return {
          ok: false,
          message: `The file was not stored: ${route.reason ?? 'no route to a device right now.'}`,
          data: { ok: false, deviceError: 'device_disconnected' },
        }
      }
      const result = await this.provider.sendFile(name, content, resolved.deviceId)
      if (!result.ok) {
        return {
          ok: false,
          message: `The file could not be stored for transfer: ${result.error ?? 'unknown failure'}`,
          data: { ...result, deviceError: 'transfer_failed' },
        }
      }
      const file = result.file as { id: string; name: string; size: number; url: string; deviceId?: string }
      const note =
        resolved.deviceId && route.available === false
          ? ` The target (${resolved.deviceId}) is offline, so it will download when it comes back online.`
          : ''
      return {
        ok: true,
        message: `File "${file.name}" (${file.size} bytes) is ready for the device to download.${note}`,
        data: result,
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Could not send the file.', data: { deviceError: 'transfer_failed' } }
    }
  }

  verify(_input: ToolInput, result: ToolResult): ToolVerification {
    return {
      ok: result.ok === true,
      message: result.ok === true ? 'Backend confirmed the file is stored and downloadable.' : 'Backend did not confirm the file.',
      checks: ['backend-stored'],
    }
  }
}

/* ------------------------------------------------------------ openUrl */

export class DeviceOpenUrlTool extends DeviceTool {
  readonly id = 'device.openUrl'
  readonly name = 'Open URL on device'
  readonly description =
    'Open a web URL on a companion phone or web page via the JARVIS Core backend. The target device must be online and trusted. ' +
    'The URL is validated for safety before sending.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      device: { type: 'string', description: 'Target device id or phrase ("my phone").' },
      url: { type: 'string', description: 'The URL to open (http/https only).' },
    },
    required: ['device', 'url'],
  }

  canRun(query: string): boolean {
    return /\b(open|launch|go to)\b/i.test(query) && /\b(url|link|website|page)\b/i.test(query) && /\b(phone|device|laptop|pc)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const url = paramStr(input, 'url')?.trim()
    if (!url) {
      return { ok: false, message: 'A URL is required to open on the device.', data: { kind: 'invalid_input' } }
    }
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, message: 'Only http/https URLs are allowed.', data: { kind: 'invalid_input' } }
      }
    } catch {
      return { ok: false, message: 'Invalid URL format.', data: { kind: 'invalid_input' } }
    }
    const resolved = resolveTargetInput(paramStr(input, 'device'))
    if (resolved.error)
      return { ok: false, message: resolved.error, data: { kind: 'invalid_target', deviceError: 'device_not_found' } }
    try {
      const devices = await this.provider.refresh()
      const route = routeDeviceTarget(devices, resolved.deviceId)
      if (!route.available) {
        return {
          ok: false,
          message: `The open-URL command was not accepted: ${route.reason ?? 'no route to that device right now.'}`,
          data: { success: false, reason: route.reason, deviceError: 'device_disconnected' },
        }
      }
      const result = await this.provider.openUrl(resolved.deviceId!, url)
      if (!result.success) {
        const reason = result.reason ?? result.error ?? 'unknown failure'
        const deviceError: DeviceErrorKind =
          result.error === 'device_offline' || (result.reason ?? '').includes('offline') ? 'device_disconnected' : 'device_unavailable'
        return { ok: false, message: `The open-URL command was not accepted: ${reason}`, data: { ...result, deviceError } }
      }
      return { ok: true, message: `Sent an "open in browser" command to ${resolved.deviceId} for "${url}"; the backend confirmed delivery to the online device.`, data: result }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Could not open the URL on the device.',
        data: { deviceError: 'device_protocol_error' },
      }
    }
  }

  verify(_input: ToolInput, result: ToolResult): ToolVerification {
    return {
      ok: result.ok === true,
      message:
        result.ok === true
          ? 'Backend confirmed the open-URL command was delivered to the online device.'
          : 'Backend reported the open-URL command was not delivered.',
      checks: ['device-open-url-delivered'],
    }
  }
}

/* ------------------------------------------------------------ refresh */

export class DeviceRefreshTool extends DeviceTool {
  readonly id = 'device.refresh'
  readonly name = 'Refresh device state'
  readonly description =
    'Force a refresh of the device registry from the JARVIS Core backend, updating online/offline status and capabilities.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      device: { type: 'string', description: 'Optional specific device id to refresh. Omit to refresh all.' },
    },
    required: [],
  }

  canRun(query: string): boolean {
    return /\b(refresh|update|resync)\b/i.test(query) && /\b(device|devices|phone|phones)\b/i.test(query)
  }

  async execute(_input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    try {
      const devices = await this.provider.refreshDevices()
      const online = devices.filter((d) => d.online).length
      return {
        ok: true,
        message: `Device registry refreshed: ${online} of ${devices.length} devices online.`,
        data: { devices, count: devices.length, online },
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Could not refresh device state.', data: { deviceError: 'device_unavailable' } }
    }
  }
}

/** Bind the device tools to a provider; absent provider => zero tools. */
export function createDeviceTools(provider: DeviceProvider | undefined): Tool[] {
  if (!provider) return []
  return [
    new DeviceListTool(provider),
    new DeviceStatusTool(provider),
    new DeviceNotifyTool(provider),
    new DeviceSendFileTool(provider),
    new DeviceOpenUrlTool(provider),
    new DeviceRefreshTool(provider),
  ]
}