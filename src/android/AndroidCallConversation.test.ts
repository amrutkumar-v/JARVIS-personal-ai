import { describe, expect, it, beforeEach } from 'vitest'
import { CallConcludeTool, CallConverseTool, CallSummarizeTool, defaultClosing, defaultIntroduction, defaultQuestion } from './AndroidCallConversationTools'
import { MemoryManager } from '../memory/MemoryManager'
import type { ToolContext } from '../tools'
import type {
  ActiveCall,
  AndroidCallOutcome,
  AndroidCapabilities,
  AndroidCallStateInput,
  AndroidProvider,
} from './provider'
import type { CallAction, CallEventData, CallResultLookup, CallState, DeviceRecord } from '../backend/types'

/**
 * The conversational call: JARVIS dials, introduces itself, asks the question,
 * the human relays the answer, JARVIS closes the call and records it.
 *
 * These tests drive the REAL tools against a fake phone that behaves the way
 * the real companion does — it reports a call state and acknowledges that it
 * played audio — so a green test means the sequence is genuinely wired, not
 * that the tool merely claimed success.
 */

function stubBrowserStorage(): void {
  const backing = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  ;(globalThis as Record<string, unknown>).window = {
    localStorage,
    setTimeout: (_fn: () => void) => 0,
  }
}

class FakePhone implements AndroidProvider {
  capabilitiesResult: AndroidCapabilities = {
    available: true,
    phone: {
      deviceId: 's26-ultra',
      deviceName: "Amrut's S26 Ultra",
      online: true,
      call: true,
      speak: true,
      dialPermission: true,
      callControlPermission: true,
    },
  }
  events: CallEventData[] = []
  spoken: string[] = []
  requests: Array<{ action: CallAction; input: Record<string, unknown> }> = []
  /** The phone reports the call as CONNECTED right after the dial. */
  connectsOnDial = true
  /** The phone reports the call as ENDED right after the hangup. */
  endsOnHangup = true
  /** When set, the phone REFUSES to speak. */
  refuseSpeak = false
  /** When true, the phone never reports the call as connected. */
  neverConnects = false
  private commandSeq = 0

  capabilities(): AndroidCapabilities {
    return this.capabilitiesResult
  }

  refresh(): Promise<DeviceRecord[]> {
    return Promise.resolve([])
  }

  requestCall(
    action: CallAction,
    input: { target?: string; number?: string; reason?: string; text?: string },
  ): Promise<AndroidCallOutcome> {
    this.requests.push({ action, input })
    this.commandSeq += 1
    const commandId = `cmd-${this.commandSeq}`
    if (action === 'dial') {
      if (this.neverConnects) {
        this.events.unshift({ deviceId: 's26-ultra', state: 'CALLING', direction: 'outgoing', commandId, at: Date.now() })
      } else if (this.connectsOnDial) {
        this.events.unshift({ deviceId: 's26-ultra', state: 'CONNECTED', direction: 'outgoing', commandId, at: Date.now() })
      }
      return Promise.resolve({
        ok: true,
        state: 'CALL_REQUESTED',
        message: 'Sent a real dial command.',
        deviceId: 's26-ultra',
        commandId,
        requestId: `req-${this.commandSeq}`,
      })
    }
    if (action === 'speak') {
      if (this.refuseSpeak) {
        return Promise.resolve({
          ok: false,
          state: 'FAILED',
          message: 'The phone refused to speak.',
          deviceId: 's26-ultra',
        })
      }
      this.spoken.push(input.text ?? '')
      return Promise.resolve({
        ok: true,
        state: 'CALL_REQUESTED',
        message: 'Sent the text to the phone.',
        deviceId: 's26-ultra',
        commandId,
        requestId: `req-${this.commandSeq}`,
      })
    }
    if (action === 'hangup') {
      if (this.endsOnHangup) {
        this.events.unshift({ deviceId: 's26-ultra', state: 'ENDED', at: Date.now() })
      }
      return Promise.resolve({
        ok: true,
        state: 'CALL_REQUESTED',
        message: 'Sent a hang-up command.',
        deviceId: 's26-ultra',
        commandId,
        requestId: `req-${this.commandSeq}`,
      })
    }
    return Promise.resolve({
      ok: true,
      state: 'CALL_REQUESTED',
      message: 'Queued.',
      deviceId: 's26-ultra',
      commandId,
      requestId: `req-${this.commandSeq}`,
    })
  }

  callResult(): Promise<CallResultLookup> {
    return Promise.resolve({ ok: true, acknowledged: true, result: true, detail: 'SPOKEN: played on the loudspeaker' })
  }

  recentCallEvents(limit = 10): CallEventData[] {
    return this.events.slice(0, limit)
  }

  activeCall(): ActiveCall | null {
    const live = this.events.find((e) => ['CALLING', 'RINGING', 'CONNECTED'].includes(e.state))
    return live
      ? {
          deviceId: live.deviceId,
          state: live.state,
          direction: live.direction,
          contactName: live.contactName,
          number: live.number,
          at: live.at,
        }
      : null
  }

  async awaitCallState(input: AndroidCallStateInput): Promise<CallEventData | null> {
    const wanted = new Set(input.states)
    const found = this.events.find(
      (e) => e.deviceId === input.deviceId && wanted.has(e.state) && (input.since === undefined || e.at >= input.since - 1_000),
    )
    if (found) return found
    if (input.timeoutMs <= 0) return null
    await new Promise((r) => setTimeout(r, Math.min(input.timeoutMs, 5)))
    return null
  }
}

describe('the conversational call — JARVIS introduces itself and asks', () => {
  let phone: FakePhone
  let memory: MemoryManager
  let ctx: ToolContext

  beforeEach(() => {
    stubBrowserStorage()
    memory = new MemoryManager()
    memory.updateProfile({ name: 'Amrut' })
    phone = new FakePhone()
    ctx = { requestId: 'call-test', memory }
  })

  it('dials, waits for the connection, introduces itself and asks the question', async () => {
    const tool = new CallConverseTool(phone)
    const result = await tool.execute(
      { query: 'call Dad and ask if he can come at 5', params: { target: 'Dad', brief: 'whether you can come to the house at 5 pm today' } },
      ctx,
    )

    expect(result.ok).toBe(true)
    // The real dial was queued.
    expect(phone.requests[0]?.action).toBe('dial')
    expect(phone.requests[0]?.input.target).toBe('Dad')
    // JARVIS introduced itself as the user's assistant, acting on their behalf.
    expect(phone.spoken[0]).toBe("Hi, this is JARVIS, Amrut's personal assistant, calling on Amrut's behalf.")
    // Then it asked exactly what the user asked it to ask.
    expect(phone.spoken[1]).toBe('Amrut asked me to ask you: whether you can come to the house at 5 pm today')
    // The call is left OPEN so the answer can be relayed.
    expect((result.data as { callState: CallState }).callState).toBe('CONNECTED')
    expect(result.message).toContain('still open')
  })

  it('records the open call so the closing step knows what was asked', async () => {
    const tool = new CallConverseTool(phone)
    await tool.execute({ query: 'call Dad', params: { target: 'Dad', brief: 'whether he can come at 5' } }, ctx)
    const items = memory.items()
    expect(items).toHaveLength(1)
    expect(items[0].content).toContain('whether he can come at 5')
    expect((items[0].metadata as { state?: string }).state).toBe('open')
  })

  it('refuses without a brief — it never invents a question', async () => {
    const tool = new CallConverseTool(phone)
    const result = await tool.execute({ query: 'call Dad', params: { target: 'Dad' } }, ctx)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('what to ask')
    expect(phone.requests).toHaveLength(0)
  })

  it('refuses without a target or a number', async () => {
    const tool = new CallConverseTool(phone)
    const result = await tool.execute({ query: 'call someone', params: { brief: 'how are you' } }, ctx)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('who to call')
    expect(phone.requests).toHaveLength(0)
  })

  it('refuses an offline phone honestly and places nothing', async () => {
    phone.capabilitiesResult = {
      available: true,
      phone: {
        deviceId: 's26-ultra',
        deviceName: "Amrut's S26 Ultra",
        online: false,
        call: true,
        speak: true,
        dialPermission: true,
        callControlPermission: true,
      },
    }
    const tool = new CallConverseTool(phone)
    const result = await tool.execute({ query: 'call Dad', params: { target: 'Dad', brief: 'how are you' } }, ctx)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('offline')
    expect(phone.requests).toHaveLength(0)
  })

  it('refuses when the phone has not granted CALL_PHONE', async () => {
    phone.capabilitiesResult = {
      available: true,
      phone: {
        deviceId: 's26-ultra',
        deviceName: "Amrut's S26 Ultra",
        online: true,
        call: true,
        speak: true,
        dialPermission: false,
        callControlPermission: true,
      },
    }
    const tool = new CallConverseTool(phone)
    const result = await tool.execute({ query: 'call Dad', params: { target: 'Dad', brief: 'how are you' } }, ctx)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('CALL_PHONE')
    expect(phone.requests).toHaveLength(0)
  })

  it('refuses when the phone cannot speak on a call', async () => {
    phone.capabilitiesResult = {
      available: true,
      phone: {
        deviceId: 's26-ultra',
        deviceName: "Amrut's S26 Ultra",
        online: true,
        call: true,
        speak: false,
        dialPermission: true,
        callControlPermission: true,
      },
    }
    const tool = new CallConverseTool(phone)
    const result = await tool.execute({ query: 'call Dad', params: { target: 'Dad', brief: 'how are you' } }, ctx)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('cannot speak')
    expect(phone.requests).toHaveLength(0)
  })

  it('is honest when the call never connects — it never claims to have spoken', async () => {
    phone.neverConnects = true
    const tool = new CallConverseTool(phone)
    const result = await tool.execute({ query: 'call Dad', params: { target: 'Dad', brief: 'how are you' } }, ctx)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('did not report the call as connected')
    expect(phone.spoken).toHaveLength(0)
  })

  it('is honest when the phone refuses to speak mid-call', async () => {
    phone.refuseSpeak = true
    const tool = new CallConverseTool(phone)
    const result = await tool.execute({ query: 'call Dad', params: { target: 'Dad', brief: 'how are you' } }, ctx)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('refused to speak')
  })

  it('requires confirmation — a real call is never auto-approved', () => {
    const tool = new CallConverseTool(phone)
    expect(tool.permission).toBe('user_confirmation')
    expect(tool.category).toBe('communication')
    expect(tool.inputSchema.required).toEqual(['brief'])
  })
})

describe('closing the call — hang up and summarize', () => {
  let phone: FakePhone
  let memory: MemoryManager
  let ctx: ToolContext

  beforeEach(async () => {
    stubBrowserStorage()
    memory = new MemoryManager()
    memory.updateProfile({ name: 'Amrut' })
    phone = new FakePhone()
    ctx = { requestId: 'call-test', memory }
    // Open the call first, exactly as the real flow does.
    await new CallConverseTool(phone).execute(
      { query: 'call Dad', params: { target: 'Dad', brief: 'whether he can come at 5 pm today' } },
      ctx,
    )
  })

  it('says the closing line, hangs up for real, and records the exchange', async () => {
    const tool = new CallConcludeTool(phone)
    const result = await tool.execute(
      { query: 'hang up', params: { reply: 'he said yes, come at 5 pm' } },
      ctx,
    )

    expect(result.ok).toBe(true)
    // The closing was actually spoken on the call.
    expect(phone.spoken[phone.spoken.length - 1]).toBe(defaultClosing('Amrut'))
    // The hangup was really queued.
    expect(phone.requests.some((r) => r.action === 'hangup')).toBe(true)
    // The record now carries the whole exchange, including the relayed answer.
    const item = memory.items()[0]
    expect(item.content).toContain('whether he can come at 5 pm today')
    expect(item.content).toContain('he said yes, come at 5 pm')
    expect(item.content).toContain('introduced itself as Amrut')
    expect((item.metadata as { state?: string }).state).toBe('closed')
    expect((item.metadata as { reply?: string }).reply).toBe('he said yes, come at 5 pm')
  })

  it('refuses when there is no open call', async () => {
    const bare = new FakePhone()
    const tool = new CallConcludeTool(bare)
    const result = await tool.execute({ query: 'hang up', params: {} }, ctx)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('no open call')
    expect(bare.requests).toHaveLength(0)
  })

  it('requires confirmation too', () => {
    expect(new CallConcludeTool(phone).permission).toBe('user_confirmation')
  })
})

describe('summarizing the call', () => {
  it('reads back the recorded call', async () => {
    stubBrowserStorage()
    const memory = new MemoryManager()
    memory.updateProfile({ name: 'Amrut' })
    const phone = new FakePhone()
    const ctx = { requestId: 'call-test', memory }
    await new CallConverseTool(phone).execute({ query: 'call Dad', params: { target: 'Dad', brief: 'how are you' } }, ctx)
    await new CallConcludeTool(phone).execute({ query: 'hang up', params: { reply: 'he is fine' } }, ctx)

    const tool = new CallSummarizeTool(phone)
    const result = await tool.execute({ query: 'summarize the last call', params: {} }, ctx)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('Dad')
    expect(result.message).toContain('how are you')
  })

  it('says plainly when there is no call to summarize', async () => {
    stubBrowserStorage()
    const memory = new MemoryManager()
    const phone = new FakePhone()
    const result = await new CallSummarizeTool(phone).execute({ query: 'summarize', params: {} }, { requestId: 'x', memory })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('no call records')
  })
})

describe('the spoken lines', () => {
  it('introduce JARVIS as the user\'s assistant, acting on their behalf', () => {
    expect(defaultIntroduction('Amrut')).toBe("Hi, this is JARVIS, Amrut's personal assistant, calling on Amrut's behalf.")
  })

  it('carry the brief verbatim', () => {
    expect(defaultQuestion('Amrut', 'whether you can come at 5')).toBe('Amrut asked me to ask you: whether you can come at 5')
  })

  it('close politely', () => {
    expect(defaultClosing('Amrut')).toBe("Thanks for your time. I'll pass that on to Amrut. Goodbye.")
  })
})
