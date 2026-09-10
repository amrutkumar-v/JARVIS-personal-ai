import type { Tool, ToolContext, ToolInput, ToolResult, ToolPermission, ToolCategory } from './Tool'

/** Real clock tool — reads the system clock and formats it politely. */
export class ClockTool implements Tool {
  readonly id = 'clock'
  readonly category: ToolCategory = 'info'
  readonly name = 'System clock'
  readonly description = 'Returns the current local date and time.'
  readonly permission: ToolPermission = 'read_only'
  readonly requiresPermission = false
  readonly inputSchema = {
    type: 'object' as const,
    properties: {},
    required: [],
  }

  canRun(query: string): boolean {
    return /\b(time|date|what (day|time)|what'?s the (time|date))\b/i.test(query)
  }

  async execute(_input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    const now = new Date()
    const time = now.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    })
    const date = now.toLocaleDateString(undefined, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
    return {
      ok: true,
      message: `The local time is ${time} on ${date}.`,
      data: { time, date: date },
    }
  }
}