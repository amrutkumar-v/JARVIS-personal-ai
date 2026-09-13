import type { Tool, ToolCategory, ToolContext, ToolContextId, ToolInput, ToolPermission, ToolResult, ToolVerification } from '../tools/Tool'
import type { ToolInputSchema } from '../engine/provider'
import type { SchedulerAdapter, ScheduledItem } from '../scheduling/scheduler'

/**
 * Scheduling tools (Phase 11 — real reminders).
 *
 *   scheduling.create  low_risk   schedule a one-time / daily / weekly reminder
 *   scheduling.list    read_only  list upcoming scheduled reminders
 *   scheduling.cancel  low_risk   cancel an existing reminder by id
 *
 * Every tool talks to the real LocalScheduler seam; nothing is simulated.
 * `scheduling.create` declares itself verifiable and confirms the reminder
 * exists in the live schedule before reporting success.
 */

export interface SchedulingKinds {
  once?: number
  daily?: string
  weekly?: string
  weekday?: number
}

interface CreateInput {
  text: string
  when?: string
  repeat?: 'once' | 'daily' | 'weekly'
  weekday?: number
}

function isHHMM(value: string | undefined): boolean {
  if (!/^\d{1,2}:\d{2}$/.test(value ?? '')) return false
  const [h, m] = (value as string).split(':').map(Number)
  return h >= 0 && h <= 23 && m >= 0 && m <= 59
}

function parseWhen(when: string | undefined, repeat: string | undefined, weekday: number | undefined): { kind: 'once'; at: number } | { kind: 'daily'; time: string } | { kind: 'weekly'; time: string; weekday: number } | { error: string } {
  if (repeat === 'daily' || repeat === 'weekly') {
    if (!isHHMM(when)) return { error: 'For daily/weekly reminders the time must be "HH:MM", e.g. "19:00".' }
    if (repeat === 'weekly') {
      if (!Number.isInteger(weekday) || weekday === undefined || weekday < 0 || weekday > 6) {
        return { error: 'Weekly reminders need a weekday 0..6 (0 = Sunday, 6 = Saturday).' }
      }
      return { kind: 'weekly', time: when!, weekday }
    }
    return { kind: 'daily', time: when! }
  }
  // One-time: accept an ISO absolute time, or today's wall clock "HH:MM".
  const parsed = when === undefined ? undefined : /^\d{1,2}:\d{2}$/.test(when)
    ? (() => {
        const d = new Date()
        const [h, m] = when.split(':').map(Number)
        d.setHours(h, m, 0, 0)
        return d.getTime()
      })()
    : Date.parse(when)
  if (parsed === undefined || Number.isNaN(parsed)) return { error: 'A one-time reminder needs a time: "HH:MM" today or an ISO date/time.' }
  return { kind: 'once', at: parsed }
}

abstract class SchedulingTool implements Tool {
  readonly category: ToolCategory = 'system'
  readonly requiresPermission: boolean = false
  readonly contexts: ToolContextId[] = ['generic']
  protected readonly scheduler: SchedulerAdapter

  constructor(scheduler: SchedulerAdapter) {
    this.scheduler = scheduler
  }

  abstract readonly id: string
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly permission: ToolPermission
  abstract readonly inputSchema: ToolInputSchema
  abstract canRun(query: string): boolean
  abstract execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult>
}

function reminderLine(item: ScheduledItem): string {
  const when =
    item.kind === 'once'
      ? new Date(item.at ?? item.nextRun).toLocaleString()
      : `${item.kind === 'daily' ? 'daily' : `weekly (day ${item.weekday})`} at ${item.time}`
  const state = item.lastResult === 'missed' ? ' (last run was missed — will re-run)' : ''
  return `- ${item.id}: "${item.text}" — ${when}${state}`
}

/* ---------------------------------------------------------------- create */

export class SchedulingCreateTool extends SchedulingTool {
  readonly id = 'scheduling.create'
  readonly name = 'Schedule a reminder'
  readonly description =
    'Create ONE reminder: one-time (absolute time), daily ("HH:MM"), or weekly (weekday 0..6 + "HH:MM"). ' +
    'The reminder is persisted locally and fires through JARVIS while the app is open. Provide the reminder ' +
    'text, a repeat kind, and a time (or "when"). Seconds are truncated to the minute.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable: boolean = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The reminder text (what JARVIS should do or say).' },
      repeat: { type: 'string', description: 'Repetition kind: "once", "daily", or "weekly" (default "once").' },
      when: { type: 'string', description: 'For once: ISO date/time or today\'s "HH:MM". For daily/weekly: "HH:MM".' },
      weekday: { type: 'number', description: 'Weekly only: 0..6 (0 = Sunday).' },
    },
    required: ['text'],
  }

  canRun(query: string): boolean {
    return /\b(remind me|reminder|remember to|schedule|scheduled)\b/i.test(query) && /(\bat\b|\b\d{1,2}:\d{2}\b|daily|weekly|every)/i.test(query)
  }

  private parse(input: ToolInput): CreateInput {
    const params = input.params as Record<string, unknown>
    const raw: CreateInput = {
      text: typeof params.text === 'string' ? params.text : '',
      when: typeof params.when === 'string' ? params.when : undefined,
      repeat: params.repeat === 'daily' || params.repeat === 'weekly' ? params.repeat : 'once',
      weekday: typeof params.weekday === 'number' ? params.weekday : undefined,
    }
    return raw
  }

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    const c = this.parse(input)
    if (!c.text.trim()) return { ok: false, message: 'A reminder needs text — say what to remind you about.', data: { valid: false, reason: 'missing_text' } }
    const parsed = parseWhen(c.when, c.repeat, c.weekday)
    if ('error' in parsed) return { ok: false, message: parsed.error, data: { valid: false, reason: 'invalid_when' } }
    try {
      if (parsed.kind === 'once') {
        const { id } = this.scheduler.scheduleOnce(parsed.at, c.text)
        return { ok: true, message: `Reminder scheduled: "${c.text}" for ${new Date(parsed.at).toLocaleString()}. It will fire while JARVIS is open.`, data: { id, at: parsed.at, kind: 'once', text: c.text } }
      }
      if (parsed.kind === 'daily') {
        const { id } = this.scheduler.scheduleDaily(parsed.time, c.text)
        return { ok: true, message: `Daily reminder scheduled: "${c.text}" every day at ${parsed.time}.`, data: { id, time: parsed.time, kind: 'daily', text: c.text } }
      }
      const { id } = this.scheduler.scheduleWeekly(parsed.weekday, parsed.time, c.text)
      return { ok: true, message: `Weekly reminder scheduled: "${c.text}" every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][parsed.weekday] ?? parsed.weekday} at ${parsed.time}.`, data: { id, weekday: parsed.weekday, time: parsed.time, kind: 'weekly', text: c.text } }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Could not schedule the reminder.', data: { reason: 'scheduling_failed' } }
    }
  }

  async verify(_input: ToolInput, result: ToolResult): Promise<ToolVerification> {
    if (!result.ok) return { ok: false, checks: [] }
    const id = (result.data as { id?: unknown } | undefined)?.id
    if (typeof id !== 'string') return { ok: false, message: 'Reminder id missing.', checks: [] }
    const exists = this.scheduler.list().some((i) => i.id === id)
    return {
      ok: exists,
      message: exists ? 'Reminder confirmed in the live schedule.' : 'The reminder is not present in the schedule.',
      checks: ['reminder-persisted'],
    }
  }
}

/* ------------------------------------------------------------------ list */

export class SchedulingListTool extends SchedulingTool {
  readonly id = 'scheduling.list'
  readonly name = 'List scheduled reminders'
  readonly description =
    'List all currently scheduled reminders (one-time, daily, weekly), next run time, and any missed-run state.'
  readonly permission: ToolPermission = 'read_only'
  readonly verifiable: boolean = false
  readonly inputSchema: ToolInputSchema = { type: 'object', properties: {}, required: [] }

  canRun(query: string): boolean {
    return /\b(reminder|reminders|scheduled|schedule|when.*remind)\b/i.test(query) && /\b(list|show|what|when)\b/i.test(query)
  }

  async execute(_input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    const items = this.scheduler.list()
    if (items.length === 0) return { ok: true, message: 'No reminders are scheduled right now.', data: { reminders: [] } }
    return {
      ok: true,
      message: `You have ${items.length} scheduled reminder${items.length > 1 ? 's' : ''}:\n${items.map(reminderLine).join('\n')}`,
      data: { reminders: items.map((i) => ({ id: i.id, text: i.text, kind: i.kind, at: i.at, time: i.time, weekday: i.weekday, nextRun: i.nextRun, lastResult: i.lastResult })) },
    }
  }
}

/* ---------------------------------------------------------------- cancel */

export class SchedulingCancelTool extends SchedulingTool {
  readonly id = 'scheduling.cancel'
  readonly name = 'Cancel a reminder'
  readonly description = 'Cancel a scheduled reminder by its id. Returns an honest failure when the id no longer exists.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable: boolean = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: { id: { type: 'string', description: 'The reminder id (from scheduling.list).' } },
    required: ['id'],
  }

  canRun(query: string): boolean {
    return /\b(cancel|remove|delete|forget)\b/i.test(query) && /\b(reminder|reminders|schedule|scheduled)\b/i.test(query)
  }

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    const id = typeof input.params?.id === 'string' ? input.params.id : undefined
    if (!id) return { ok: false, message: 'Cancel a reminder by its id (use scheduling.list first).', data: { rejected: true } }
    const result = this.scheduler.cancel(id)
    return result.ok
      ? { ok: true, message: `Reminder ${id} cancelled.`, data: { cancelled: id } }
      : { ok: false, message: result.reason ?? `No reminder with id ${id} exists.`, data: { reason: 'reminder_not_found' } }
  }

  async verify(_input: ToolInput, result: ToolResult): Promise<ToolVerification> {
    if (!result.ok) return { ok: false, checks: [] }
    const id = typeof result.data === 'object' && result.data !== null ? (result.data as { cancelled?: unknown }).cancelled : undefined
    if (typeof id !== 'string') return { ok: false, checks: [] }
    const gone = !this.scheduler.list().some((i) => i.id === id)
    return { ok: gone, message: gone ? 'Reminder confirmed cancelled.' : 'The reminder is still scheduled.', checks: ['reminder-cancelled'] }
  }
}

/** Register the three scheduling tools for the given real seam. */
export function createSchedulerTools(scheduler: SchedulerAdapter): [SchedulingCreateTool, SchedulingListTool, SchedulingCancelTool] {
  return [new SchedulingCreateTool(scheduler), new SchedulingListTool(scheduler), new SchedulingCancelTool(scheduler)]
}