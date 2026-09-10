import type { Tool, ToolContext, ToolInput, ToolResult, ToolPermission, ToolCategory } from './Tool'
import { deviceTier, prefersReducedMotion } from '../utils/capabilities'

/** Safe local device facts — nothing leaves the browser. */
export class SystemInfoTool implements Tool {
  readonly id = 'system_info'
  readonly category: ToolCategory = 'system'
  readonly name = 'System information'
  readonly description =
    'Returns harmless local device details: platform, browser, timezone, screen size and performance tier.'
  readonly permission: ToolPermission = 'read_only'
  readonly requiresPermission = false
  readonly inputSchema = {
    type: 'object' as const,
    properties: {},
    required: [],
  }

  canRun(query: string): boolean {
    return /\b(system|device|platform|browser|screen|specs)\b/i.test(query)
  }

  async execute(_input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined
    const screen =
      typeof window !== 'undefined' && window.screen
        ? { width: window.screen.width, height: window.screen.height }
        : null
    const uaData = (nav as { userAgentData?: { platform?: string } } | undefined)?.userAgentData
    const platform = uaData?.platform ?? nav?.platform ?? 'unknown'
    const memory = (nav as { deviceMemory?: number } | undefined)?.deviceMemory ?? null

    const data = {
      platform,
      browser: nav?.userAgent ?? null,
      language: nav?.language ?? 'en',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'unknown',
      timeZoneOffsetMinutes: -new Date().getTimezoneOffset(),
      hardwareConcurrency: nav?.hardwareConcurrency ?? null,
      deviceMemoryGiB: memory,
      screen,
      reducedMotionRequested: prefersReducedMotion(),
      deviceTier: deviceTier(),
    }

    const parts = [
      `Running on ${platform} (${data.deviceTier} tier)`,
      data.hardwareConcurrency ? `${data.hardwareConcurrency} cores` : 'cores unknown',
      data.screen ? `${data.screen.width} x ${data.screen.height} screen` : 'no display surface',
      `timezone ${data.timeZone}`,
    ]
    return { ok: true, message: parts.join(', ') + '.', data }
  }
}