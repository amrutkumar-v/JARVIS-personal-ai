import { describe, expect, it } from 'vitest'
import { LocalScheduler, computeNextRun, timeOf, MAX_ITEMS, MAX_TEXT_CHARS } from './scheduler'

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  dump(): string | null {
    return this.map.get('jarvis.scheduler.v1') ?? null
  }
}

function frozen(ms: number): { now: () => number } {
  return { now: () => ms }
}

/** Deterministic clock: every call returns `base` + (offset in minutes). */
function ticking(base: number, minuteOffset = 0): { now: () => number } {
  let i = 0
  return { now: () => base + (i++ + minuteOffset) * 60_000 }
}

describe('computeNextRun / timeOf', () => {
  it('returns the absolute time for once items', () => {
    expect(computeNextRun('once', 1234, undefined, undefined, 1000)).toBe(1234)
  })

  it('daily: returns the next strict occurrence after `from` (loops across days)', () => {
    // 2026-09-12T01:00 local; request daily 02:30 starting from 02:31.
    const from = new Date(2026, 8, 12, 2, 31, 0).getTime()
    const next = computeNextRun('daily', undefined, '02:30', undefined, from)
    if (next === undefined) throw new Error('no next')
    expect(next).toBe(new Date(2026, 8, 13, 2, 30, 0).getTime())
  })

  it('daily far-future clock still lands strictly after `from`', () => {
    const from = new Date(2031, 0, 1, 0, 0, 0).getTime()
    const next = computeNextRun('daily', undefined, '03:00', undefined, from)
    if (next === undefined) throw new Error('no next')
    expect(next > from).toBe(true)
    expect(timeOf(next)).toBe('03:00')
  })

  it('weekly: next strict occurrence of the requested weekday', () => {
    // 2026-09-12 is a Saturday (getDay 6).
    const from = new Date(2026, 8, 12, 12, 0, 0).getTime()
    const next = computeNextRun('weekly', undefined, '09:00', 0, from) // next Sunday
    expect(next).toBe(new Date(2026, 8, 13, 9, 0, 0).getTime())
    const nextWed = computeNextRun('weekly', undefined, '09:00', 3, from) // next Wednesday
    expect(nextWed).toBe(new Date(2026, 8, 16, 9, 0, 0).getTime())
  })

  it('rejects malformed times', () => {
    expect(computeNextRun('daily', undefined, '25:00', undefined, 0)).toBeUndefined()
    expect(computeNextRun('daily', undefined, 'zz', undefined, 0)).toBeUndefined()
    expect(computeNextRun('weekly', undefined, undefined, 3, 0)).toBeUndefined()
  })
})

describe('LocalScheduler', () => {
  it('schedules once/daily/weekly and lists them sorted by nextRun', () => {
    const storage = new MemoryStorage()
    const now = new Date(2026, 8, 12, 12, 0, 0).getTime()
    const s = new LocalScheduler({ storage, ...frozen(now) })
    s.scheduleOnce(now + 60_000, 'grab milk')
    s.scheduleDaily('08:00', 'morning stretch')
    s.scheduleWeekly(3, '19:30', 'weekly review')
    const list = s.list()
    expect(list).toHaveLength(3)
    expect(list[0].kind).toBe('once')
    expect(list[0].lastResult).toBeUndefined()
    expect(list.every((i) => i.nextRun > now)).toBe(true)
  })

  it('persists across instances (localStorage) and restores missed once items', () => {
    const storage = new MemoryStorage()
    const base = new Date(2026, 8, 12, 12, 0, 0).getTime()
    const first = new LocalScheduler({ storage, ...frozen(base) })
    first.scheduleOnce(base + 60_000, 'pay electric bill')
    first.scheduleDaily('08:00', 'take meds')
    first.scheduleWeekly(5, '10:00', 'garden')

    const restored = new LocalScheduler({ storage, ...frozen(base + 120_000) })
    const list = restored.list()
    expect(list).toHaveLength(3)
    expect(list.some((i) => i.text === 'pay electric bill')).toBe(true)
    expect(list.some((i) => i.text === 'take meds')).toBe(true)
    expect(list.some((i) => i.text === 'garden')).toBe(true)
  })

  it('fires due once without duplicate delivery and removes it', () => {
    const storage = new MemoryStorage()
    const now = new Date(2026, 8, 12, 12, 0, 0).getTime()
    const s = new LocalScheduler({ storage, ...ticking(now) })
    const fired: Array<{ text: string; missed: boolean }> = []
    s.start((item, missed) => fired.push({ text: item.text, missed }))
    const { id } = s.scheduleOnce(now + 60_000, 'post letter')
    s['tick']()
    // second tick must not re-fire (item removed)
    s['tick']()
    expect(fired).toEqual([{ text: 'post letter', missed: false }])
    expect(s.list().some((i) => i.id === id)).toBe(false)
    s.stop()
  })

  it('fires recurring items once and advances nextRun (no refire on same tick)', () => {
    const storage = new MemoryStorage()
    const base = new Date(2026, 8, 12, 12, 0, 0).getTime()
    let current = base
    const s = new LocalScheduler({ storage, now: () => current })
    const fired: string[] = []
    s.start((item) => fired.push(item.text))
    const { id } = s.scheduleDaily('08:00', 'open blinds')
    // nextRun = tomorrow 08:00 (strictly after base). Jump the clock past it.
    const scheduled = s.list()[0].nextRun
    current = scheduled // due exactly now
    s['tick']()
    s['tick']() // nextRun advanced one day → no longer due
    const remaining = s.list().filter((i) => i.id === id)
    expect(fired).toEqual(['open blinds'])
    expect(remaining).toHaveLength(1)
    expect(remaining[0].nextRun).toBe(scheduled + 86_400_000)
    expect(remaining[0].lastResult).toBe('delivered')
    s.stop()
  })

  it('catches up a missed run exactly once with missed=true', () => {
    const storage = new MemoryStorage()
    const base = new Date(2026, 8, 12, 12, 0, 0).getTime()
    const maker = new LocalScheduler({ storage, now: () => base })
    maker.scheduleOnce(base + 60_000, 'legacy once item')
    maker.scheduleDaily('08:00', 'legacy daily item')

    // Restore far later (3+ days) — both are past-due beyond grace. load()
    // must mark each 'missed', and the FIRST tick delivers each exactly once.
    const restoredAt = base + 3 * 86_400_000
    const later = new LocalScheduler({ storage, now: () => restoredAt })
    const fired: Array<{ text: string; missed: boolean }> = []
    later.start((item, missed) => fired.push({ text: item.text, missed }))
    later['tick']()
    later['tick']()
    expect(fired.filter((f) => f.text === 'legacy once item')).toHaveLength(1)
    expect(fired.filter((f) => f.text === 'legacy daily item')).toHaveLength(1)
    const onceFire = fired.find((f) => f.text === 'legacy once item')
    const dailyFire = fired.find((f) => f.text === 'legacy daily item')
    expect(onceFire?.missed).toBe(true)
    expect(dailyFire?.missed).toBe(true)
    later.stop()
  })

  it('bounds: rejects empty/oversized text and too-soon once times', () => {
    const s = new LocalScheduler()
    expect(() => s.scheduleOnce(Date.now() + 60_000, '   ')).toThrow(/empty/)
    expect(() => s.scheduleDaily('08:00', 'x'.repeat(MAX_TEXT_CHARS + 1))).toThrow(/exceeds/)
    expect(() => s.scheduleOnce(Date.now() + 10, 'too soon')).toThrow(/future/)
  })

  it('bounds: enforces MAX_ITEMS and 24h dedupe', () => {
    const storage = new MemoryStorage()
    const now = new Date(2026, 8, 12, 12, 0, 0).getTime()
    const s = new LocalScheduler({ storage, ...ticking(now) })
    for (let i = 0; i < MAX_ITEMS; i++) s.scheduleDaily('08:00', `task ${i}`)
    expect(() => s.scheduleDaily('09:00', 'overflow')).toThrow(/more than/)
    expect(() => s.scheduleDaily('08:00', 'task 0')).toThrow(/identical/)
  })

  it('cancel: removes a real id, honest failure for unknown id, verified by list', () => {
    const now = new Date(2026, 8, 12, 12, 0, 0).getTime()
    const s = new LocalScheduler({ ...ticking(now) })
    const { id } = s.scheduleOnce(now + 60_000, 'delete me')
    expect(s.cancel('nope')).toEqual({ ok: false, reason: expect.any(String) })
    expect(s.cancel(id)).toEqual({ ok: true })
    expect(s.list().some((i) => i.id === id)).toBe(false)
  })

  it('degrades honestly on corrupt storage (empty list, no crash)', () => {
    const storage = new MemoryStorage()
    storage.setItem('jarvis.scheduler.v1', '{not json!!')
    const s = new LocalScheduler({ storage, now: () => Date.now() })
    expect(s.list()).toHaveLength(0)
    expect(s.status().persistence).toBe('local')
  })

  it('stop() clears the poll loop; a stopped scheduler never fires', () => {
    const now = new Date(2026, 8, 12, 12, 0, 0).getTime()
    const s = new LocalScheduler({ ...frozen(now) })
    const fired: string[] = []
    s.start((item) => fired.push(item.text))
    s.stop()
    s.scheduleOnce(now + 60_000, 'will not run')
    expect(fired).toEqual([])
    expect(s.status().running).toBe(false)
  })
})