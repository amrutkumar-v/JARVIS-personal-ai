import { describe, expect, it } from 'vitest'
import { LocalScheduler } from './scheduler'
import { createSchedulerTools } from './schedulerTools'

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
}

const ANY_CTX = { requestId: 'r', memory: undefined as never } as never

function makeTools(nowMs?: number) {
  const scheduler = new LocalScheduler({
    storage: new MemoryStorage(),
    ...(nowMs === undefined ? {} : { now: () => nowMs }),
  })
  const [create, list, cancel] = createSchedulerTools(scheduler)
  return { scheduler, create, list, cancel }
}

describe('scheduling tools (real LocalScheduler)', () => {
  it('registers create/list/cancel with correct ids and permissions', () => {
    const { create, list, cancel } = makeTools()
    expect(create.id).toBe('scheduling.create')
    expect(list.id).toBe('scheduling.list')
    expect(cancel.id).toBe('scheduling.cancel')
    expect(create.permission).toBe('low_risk')
    expect(list.permission).toBe('read_only')
    expect(cancel.permission).toBe('low_risk')
    expect(create.verifiable).toBe(true)
    expect(cancel.verifiable).toBe(true)
    expect(list.verifiable).toBe(false)
  })

  it('create → verify(): reminder really persisted in the live schedule', async () => {
    const now = new Date(2026, 8, 12, 12, 0, 0).getTime()
    const { create, list } = makeTools(now)
    const result = await create.execute(
      { query: 'remind me at 13:00 to call dad', params: { text: 'call dad', when: '13:00', repeat: 'once' } },
      ANY_CTX,
    )
    expect(result.ok).toBe(true)
    const id = (result.data as { id?: unknown }).id
    expect(typeof id).toBe('string')
    expect(await create.verify!({ query: 'x', params: {} }, result)).toMatchObject({ ok: true })
    const listing = await list.execute({ query: 'list reminders', params: {} }, ANY_CTX)
    expect(listing.ok).toBe(true)
    expect(listing.data).toMatchObject({ reminders: [{ text: 'call dad', kind: 'once' }] })
  })

  it('rejects malformed inputs with honest failures (no fabricated scheduling)', async () => {
    const { create } = makeTools()
    const noText = await create.execute({ query: 'remind me', params: { when: '13:00', repeat: 'daily' } }, ANY_CTX)
    expect(noText.ok).toBe(false)
    expect(noText.data).toMatchObject({ reason: 'missing_text' })
    const badWhen = await create.execute({ query: 'remind me daily', params: { text: 'x', repeat: 'daily', when: '25:99' } }, ANY_CTX)
    expect(badWhen.ok).toBe(false)
    expect(badWhen.data).toMatchObject({ reason: 'invalid_when' })
    const badWeekday = await create.execute({ query: 'remind me weekly', params: { text: 'x', repeat: 'weekly', when: '10:00', weekday: 9 } }, ANY_CTX)
    expect(badWeekday.ok).toBe(false)
    expect(await create.verify!({ query: 'x', params: {} }, badWeekday)).toMatchObject({ ok: false })
  })

  it('cancel → verify(): reminder really gone', async () => {
    const now = new Date(2026, 8, 12, 12, 0, 0).getTime()
    const { create, cancel, list } = makeTools(now)
    const created = await create.execute(
      { query: 'remind me tomorrow', params: { text: 'garbage day', when: new Date(now + 86_400_000).toISOString() } },
      ANY_CTX,
    )
    const id = (created.data as { id?: unknown }).id as string
    const cancelled = await cancel.execute({ query: 'cancel, id ' + id, params: { id } }, ANY_CTX)
    expect(cancelled.ok).toBe(true)
    expect(await cancel.verify!({ query: 'x', params: { id } }, cancelled)).toMatchObject({ ok: true })
    const listing = await list.execute({ query: 'list reminders', params: {} }, ANY_CTX)
    expect((listing.data as { reminders: unknown[] }).reminders).toHaveLength(0)
  })

  it('cancel of a missing id is an honest failure and never verifies', async () => {
    const { cancel } = makeTools()
    const res = await cancel.execute({ query: 'cancel aaa', params: { id: 'does-not-exist' } }, ANY_CTX)
    expect(res.ok).toBe(false)
    expect(res.data).toMatchObject({ reason: 'reminder_not_found' })
    expect(await cancel.verify!({ query: 'x', params: {} }, res)).toMatchObject({ ok: false })
  })

  it('dedupe is enforced through the create tool (no double reminders)', async () => {
    const now = new Date(2026, 8, 12, 12, 0, 0).getTime()
    const { create } = makeTools(now)
    const first = await create.execute({ query: 'daily at 08:00', params: { text: 'stretch', repeat: 'daily', when: '08:00' } }, ANY_CTX)
    expect(first.ok).toBe(true)
    const second = await create.execute({ query: 'daily at 08:00', params: { text: 'stretch', repeat: 'daily', when: '08:00' } }, ANY_CTX)
    expect(second.ok).toBe(false)
    expect(second.message).toMatch(/identical/)
  })

  it('scheduler bounds surface honestly (MAX_ITEMS) through the tool', async () => {
    const now = new Date(2026, 8, 12, 12, 0, 0).getTime()
    const { create } = makeTools(now)
    let last: { ok: boolean } | undefined
    for (let i = 0; i < 51; i++) {
      last = await create.execute({ query: 'daily', params: { text: `reminder ${i}`, repeat: 'daily', when: '08:00' } }, ANY_CTX)
    }
    expect(last!.ok).toBe(false)
    expect((last as never as { message: string }).message).toMatch(/more than 50/)
  })
})