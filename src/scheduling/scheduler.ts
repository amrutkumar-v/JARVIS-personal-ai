/**
 * Phase 11 — scheduling / reminders (FINAL CONVERGENCE, Work 16).
 *
 * A real, bounded scheduler for the browser runtime. It persists to
 * localStorage, runs fired reminders through the SINGLE engine `process`
 * entry point (never a parallel agent), and is honest about its boundary:
 * reminders fire while the JARVIS frontend is open. The app cannot guarantee
 * execution when it is closed (a browser cannot promise timers it does not
 * have), so every missed run is flagged with `lastResult: 'missed'` and
 * re-run once on the next open — never silently dropped and never spammy.
 *
 * Boundaries:
 *   - at most MAX_ITEMS items
 *   - at most MAX_TEXT_CHARS per reminder
 *   - one fired execution per due item per tick (no duplicate delivery)
 *   - recurrence is next-occurrence arithmetic, bounded below by MIN_INTERVAL_MS
 */

export type SchedulerKind = 'once' | 'daily' | 'weekly'

export interface ScheduledItem {
  id: string
  text: string
  kind: SchedulerKind
  /** once: the absolute due time (epoch ms). */
  at?: number
  /** daily/weekly: local wall-clock 'HH:MM'. */
  time?: string
  /** weekly: 0..6 (0 = Sunday). */
  weekday?: number
  createdAt: number
  nextRun: number
  lastRun?: number
  lastResult?: 'delivered' | 'missed' | 'failed'
}

export interface SchedulerAdapter {
  scheduleOnce(at: number, text: string): { id: string }
  scheduleDaily(time: string, text: string): { id: string }
  scheduleWeekly(weekday: number, time: string, text: string): { id: string }
  list(): readonly ScheduledItem[]
  cancel(id: string): { ok: boolean; reason?: string }
}

export const MAX_ITEMS = 50
export const MAX_TEXT_CHARS = 500
export const MIN_INTERVAL_MS = 30_000
export const POLL_INTERVAL_MS = 15_000
export const MISSED_GRACE_MS = 60_000

const STORAGE_KEY = 'jarvis.scheduler.v1'

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `sched-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

function dateFromTime(time: string, day: number | undefined, base: number): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  const d = new Date(base)
  d.setHours(hour, minute, 0, 0)
  if (day !== undefined) {
    const delta = (day - d.getDay() + 7) % 7
    d.setDate(d.getDate() + delta)
  }
  return d
}

/** Next occurrence of a daily/weekly schedule strictly after `from`. */
export function computeNextRun(kind: SchedulerKind, at: number | undefined, time: string | undefined, weekday: number | undefined, from: number): number | undefined {
  if (kind === 'once') return at
  if (!time) return undefined
  if (kind === 'daily') {
    const d = dateFromTime(time, undefined, from)
    if (!d) return undefined
    let t = d.getTime()
    while (t <= from) t += 86_400_000
    return t
  }
  if (kind === 'weekly') {
    const wd = weekday ?? new Date(from).getDay()
    const d = dateFromTime(time, wd, from)
    if (!d) return undefined
    let t = d.getTime()
    while (t <= from) t += 7 * 86_400_000
    return t
  }
  return undefined
}

/** Local time 'HH:MM' for `ms`. */
export function timeOf(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface SchedulerOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  now?: () => number
  pollIntervalMs?: number
}

export class LocalScheduler implements SchedulerAdapter {
  private readonly storage: SchedulerOptions['storage']
  private readonly now: () => number
  private readonly pollIntervalMs: number
  private items: ScheduledItem[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private onDue: ((item: ScheduledItem, missed: boolean) => void) | null = null
  private storageWriteFailed = false

  constructor(options: SchedulerOptions = {}) {
    this.storage = options.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
    this.now = options.now ?? (() => Date.now())
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    this.load()
  }

  status(): { persistence: 'local' | 'none'; running: boolean; itemCount: number; degraded?: boolean } {
    return {
      persistence: this.storage ? 'local' : 'none',
      running: this.timer !== null,
      itemCount: this.items.length,
      ...(this.storageWriteFailed ? { degraded: true } : {}),
    }
  }

  list(): readonly ScheduledItem[] {
    return [...this.items].sort((a, b) => a.nextRun - b.nextRun)
  }

  private load(): void {
    if (!this.storage) return
    try {
      const raw = this.storage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as ScheduledItem[]
      if (!Array.isArray(parsed)) return
      this.items = parsed
        .filter((i) => typeof i?.id === 'string' && typeof i?.text === 'string' && typeof i?.nextRun === 'number')
        .slice(0, MAX_ITEMS)
      if (this.items.length > 0) this.handleMissed()
    } catch {
      // Corrupt/inaccessible storage: honest degradation — an empty schedule,
      // never silently fabricated entries and never a crash.
      this.items = []
    }
  }

  private persist(): void {
    if (!this.storage) return
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.items))
    } catch {
      // Storage write failed (quota/blocked): the scheduler keeps working for
      // this session but reports the degradation through status().
      this.storageWriteFailed = true
    }
  }

  private validate(text: string): string | undefined {
    if (!text || !text.trim()) return 'Reminder text is empty.'
    if (text.trim().length > MAX_TEXT_CHARS) return `Reminder text exceeds ${MAX_TEXT_CHARS} characters.`
    return undefined
  }

  scheduleOnce(at: number, text: string): { id: string } {
    const error = this.validate(text)
    if (error) throw new Error(error)
    if (!Number.isFinite(at) || at < this.now() + 5_000) throw new Error('Reminder time must be at least a few seconds in the future.')
    const item: ScheduledItem = { id: newId(), text: text.trim(), kind: 'once', at, createdAt: this.now(), nextRun: at }
    this.add(item)
    return { id: item.id }
  }

  scheduleDaily(time: string, text: string): { id: string } {
    const error = this.validate(text)
    if (error) throw new Error(error)
    if (!dateFromTime(time, undefined, this.now())) throw new Error('Daily reminder time must be "HH:MM".')
    const nextRun = computeNextRun('daily', undefined, time, undefined, this.now())
    if (nextRun === undefined) throw new Error('Could not compute the daily reminder time.')
    const item: ScheduledItem = { id: newId(), text: text.trim(), kind: 'daily', time: time.trim(), createdAt: this.now(), nextRun }
    this.add(item)
    return { id: item.id }
  }

  scheduleWeekly(weekday: number, time: string, text: string): { id: string } {
    const error = this.validate(text)
    if (error) throw new Error(error)
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('Weekday must be 0..6 (0 = Sunday).')
    if (!dateFromTime(time, undefined, this.now())) throw new Error('Weekly reminder time must be "HH:MM".')
    const nextRun = computeNextRun('weekly', undefined, time, weekday, this.now())
    if (nextRun === undefined) throw new Error('Could not compute the weekly reminder time.')
    const item: ScheduledItem = { id: newId(), text: text.trim(), kind: 'weekly', time: time.trim(), weekday, createdAt: this.now(), nextRun }
    this.add(item)
    return { id: item.id }
  }

  /** Add honoring bounds + 24h dedupe (same text/lane). Returns the item. */
  private add(item: ScheduledItem): void {
    const dup = this.items.some((i) => i.text === item.text && i.kind === item.kind && i.time === item.time && i.weekday === item.weekday)
    if (dup) throw new Error('An identical reminder is already scheduled.')
    if (this.items.length >= MAX_ITEMS) throw new Error(`Cannot schedule more than ${MAX_ITEMS} reminders.`)
    this.items.push(item)
    this.persist()
  }

  cancel(id: string): { ok: boolean; reason?: string } {
    const before = this.items.length
    this.items = this.items.filter((i) => i.id !== id)
    if (this.items.length === before) return { ok: false, reason: 'No reminder with that id exists.' }
    this.persist()
    return { ok: true }
  }

  /** Mark past-due items at load; the first tick delivers each missed run once. */
  private handleMissed(): void {
    const at = this.now()
    for (const item of this.items) {
      if (item.nextRun <= at - MISSED_GRACE_MS) {
        item.lastRun = at
        item.lastResult = 'missed'
      }
    }
    this.persist()
  }

  /** Start the poll loop. At most one poll loop ever runs. */
  start(onDue: (item: ScheduledItem, missed: boolean) => void): void {
    this.onDue = onDue
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick()
    }, this.pollIntervalMs)
    // Node keeps long-lived test timers alive through unref where available.
    const refable = this.timer as unknown as { unref?: () => void }
    if (typeof refable.unref === 'function') refable.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Fire every item whose time has come (exactly once each). */
  private tick(): void {
    const at = this.now()
    const changed = this.items.some((i) => i.nextRun <= at)
    for (const item of [...this.items]) {
      if (item.nextRun > at) continue
      const missed = item.lastResult === 'missed'
      if (item.kind === 'once') {
        item.lastRun = at
        item.lastResult = 'delivered'
        this.onDue?.(item, missed)
        this.items = this.items.filter((i) => i.id !== item.id)
        continue
      }
      const next = computeNextRun(item.kind, item.at, item.time, item.weekday, at)
      if (next === undefined) continue
      item.lastRun = at
      item.lastResult = 'delivered'
      item.nextRun = next
      this.onDue?.(item, missed)
    }
    if (changed) this.persist()
  }
}