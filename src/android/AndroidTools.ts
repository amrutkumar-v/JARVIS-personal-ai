import type { Tool, ToolCategory, ToolContext, ToolContextId, ToolInput, ToolPermission, ToolResult } from '../tools/Tool'
import type { ToolInputSchema } from '../engine/provider'
import { androidBridge } from './AndroidBridge'

abstract class BaseAndroidTool implements Tool {
  readonly category: ToolCategory = 'communication'
  readonly verifiable: boolean = true
  readonly requiresPermission: boolean = false
  readonly contexts: ToolContextId[] = ['android', 'desktop']

  abstract readonly id: string
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly permission: ToolPermission
  abstract readonly inputSchema: ToolInputSchema

  abstract canRun(query: string): boolean
  abstract execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult>
}

export class CallDialTool extends BaseAndroidTool {
  readonly id = 'call.dial'
  readonly name = 'Dial Phone Call'
  readonly description = 'Place a phone call to a contact name or telephone number through the connected companion Android phone.'
  readonly permission: ToolPermission = 'high_risk'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Name of the contact to call (e.g. "Mom", "Alex Johnson") or phone number (e.g. "+1-555-0199").',
      },
    },
    required: ['target'],
  }

  canRun(query: string): boolean {
    const q = (query || '').toLowerCase()
    return /^(?:call|dial|phone|ring)\b/i.test(q) || /\b(?:place a call to|make a phone call to|call up)\b/i.test(q)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const target = (input.params?.target as string) || (input.query as string)
    if (!target || !target.trim()) {
      return { ok: false, message: 'Please specify a contact name or phone number to call.' }
    }

    const cleanTarget = target.replace(/^(?:call|dial|phone|ring)\s+(?:to\s+)?/i, '').trim()
    const res = await androidBridge.dial(cleanTarget)
    return {
      ok: res.success,
      message: res.message,
      data: res.record,
    }
  }
}

export class CallAnswerTool extends BaseAndroidTool {
  readonly id = 'call.answer'
  readonly name = 'Answer Phone Call'
  readonly description = 'Answer an incoming ringing phone call on the connected Android phone.'
  readonly permission: ToolPermission = 'low_risk'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {},
  }

  canRun(query: string): boolean {
    const q = (query || '').toLowerCase()
    return /\b(?:answer(?: the)? call|pick up(?: the phone)?|accept call)\b/i.test(q)
  }

  async execute(): Promise<ToolResult> {
    const res = await androidBridge.answer()
    return {
      ok: res.success,
      message: res.message,
    }
  }
}

export class CallRejectTool extends BaseAndroidTool {
  readonly id = 'call.reject'
  readonly name = 'Reject Phone Call'
  readonly description = 'Reject or decline an incoming phone call, with an optional auto-reply reason or text.'
  readonly permission: ToolPermission = 'low_risk'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Optional message or reason for rejecting the call (e.g. "In a meeting, call back soon").',
      },
    },
  }

  canRun(query: string): boolean {
    const q = (query || '').toLowerCase()
    return /\b(?:reject(?: the)? call|decline(?: the)? call|ignore call|send to voicemail|dismiss call)\b/i.test(q)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const reason = input.params?.reason as string | undefined
    const res = await androidBridge.reject(reason)
    return {
      ok: res.success,
      message: res.message,
    }
  }
}

export class CallEndTool extends BaseAndroidTool {
  readonly id = 'call.end'
  readonly name = 'End Phone Call'
  readonly description = 'Hang up or disconnect the currently active phone call.'
  readonly permission: ToolPermission = 'low_risk'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {},
  }

  canRun(query: string): boolean {
    const q = (query || '').toLowerCase()
    return /\b(?:hang up|end(?: the)? call|disconnect(?: the)? call|stop call|terminate call)\b/i.test(q)
  }

  async execute(): Promise<ToolResult> {
    const res = await androidBridge.endCall()
    return {
      ok: res.success,
      message: res.message,
      data: { durationSeconds: res.durationSeconds },
    }
  }
}

export class CallStatusTool extends BaseAndroidTool {
  readonly id = 'call.status'
  readonly name = 'Check Call Status'
  readonly description = 'Check the current telephony state, active call details, caller ID, and companion phone battery.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {},
  }

  canRun(query: string): boolean {
    const q = (query || '').toLowerCase()
    return /\b(?:call status|who is calling|is the phone ringing|active call|check call|phone status)\b/i.test(q)
  }

  async execute(): Promise<ToolResult> {
    const status = androidBridge.getStatus()
    if (status.activeCall) {
      const party = status.activeCall.contactName || status.activeCall.phoneNumber
      const state = status.activeCall.state
      const dur = `${Math.floor(status.activeCall.durationSeconds / 60)}m ${status.activeCall.durationSeconds % 60}s`
      return {
        ok: true,
        message: `Call with ${party} is currently ${state} (duration: ${dur}). Audio bridge to PC: ${status.audioBridgedToPc ? 'Active' : 'Phone speaker'}. Phone battery: ${status.batteryPercent}%.`,
        data: status,
      }
    }
    return {
      ok: true,
      message: `No active call on ${status.deviceName}. Phone is online (battery ${status.batteryPercent}%).`,
      data: status,
    }
  }
}

export class CallSummarizeTool extends BaseAndroidTool {
  readonly id = 'call.summarize'
  readonly name = 'Summarize Last Call'
  readonly description = 'Generate a concise summary of the last completed phone call and prepare it for memory storage.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {},
  }

  canRun(query: string): boolean {
    const q = (query || '').toLowerCase()
    return /\b(?:summarize (?:the )?last call|summarize call|what was the last call about|call log summary)\b/i.test(q)
  }

  async execute(): Promise<ToolResult> {
    const res = await androidBridge.summarizeLastCall()
    return {
      ok: res.success,
      message: res.summary,
      data: { summary: res.summary },
    }
  }
}

export class ContactsSearchTool extends BaseAndroidTool {
  readonly id = 'contacts.search'
  readonly name = 'Search Phone Contacts'
  readonly description = 'Search contacts on the connected Android phone by name or phone number.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Contact name or keyword to look up.',
      },
    },
    required: ['query'],
  }

  canRun(query: string): boolean {
    const q = (query || '').toLowerCase()
    return /\b(?:contact|contacts|phone number for|lookup contact|search contact)\b/i.test(q)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const q = (input.params?.query as string) || (input.query as string) || ''
    const cleanQ = q.replace(/^(?:find|search|lookup|get)\s+(?:the\s+)?(?:contact|phone number)\s+(?:for\s+)?/i, '').trim()
    const results = androidBridge.searchContacts(cleanQ)

    if (results.length === 0) {
      return {
        ok: true,
        message: `No contacts found matching "${cleanQ}".`,
        data: [],
      }
    }

    const lines = results.map(
      (c) => `- ${c.name}: ${c.phoneNumber}${c.relationship ? ` (${c.relationship})` : ''}${c.isVip ? ' [VIP]' : ''}`
    )
    return {
      ok: true,
      message: `Found ${results.length} contact(s):\n${lines.join('\n')}`,
      data: results,
    }
  }
}

export class PhoneSmsTool extends BaseAndroidTool {
  readonly id = 'phone.sms'
  readonly name = 'Send SMS Message'
  readonly description = 'Send a text / SMS message through the connected Android phone.'
  readonly permission: ToolPermission = 'high_risk'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Recipient contact name or phone number.',
      },
      message: {
        type: 'string',
        description: 'The text message content to send.',
      },
    },
    required: ['target', 'message'],
  }

  canRun(query: string): boolean {
    const q = (query || '').toLowerCase()
    return /\b(?:send (?:an? )?sms|text|send (?:a )?message to)\b/i.test(q)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const target = input.params?.target as string
    const message = input.params?.message as string

    if (!target || !message) {
      return { ok: false, message: 'Both target recipient and message content are required to send an SMS.' }
    }

    const res = await androidBridge.sendSms(target, message)
    return {
      ok: res.success,
      message: res.message,
    }
  }
}

export class PhoneNotificationsTool extends BaseAndroidTool {
  readonly id = 'phone.notifications'
  readonly name = 'Get Phone Notifications'
  readonly description = 'Retrieve recent notifications forwarded from the Android companion device.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of notifications to retrieve (default 5).',
      },
    },
  }

  canRun(query: string): boolean {
    const q = (query || '').toLowerCase()
    return /\b(?:phone notifications|notifications on (?:my )?phone|incoming messages on phone|mobile notifications)\b/i.test(q)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const limit = (input.params?.limit as number) || 5
    const notifs = androidBridge.getNotifications(limit)
    if (notifs.length === 0) {
      return { ok: true, message: 'No recent notifications from your Android phone.', data: [] }
    }

    const lines = notifs.map((n) => `[${n.appName}] ${n.title}: ${n.text}`)
    return {
      ok: true,
      message: `Recent phone notifications (${notifs.length}):\n${lines.join('\n')}`,
      data: notifs,
    }
  }
}

export function createAndroidTools(): Tool[] {
  return [
    new CallDialTool(),
    new CallAnswerTool(),
    new CallRejectTool(),
    new CallEndTool(),
    new CallStatusTool(),
    new CallSummarizeTool(),
    new ContactsSearchTool(),
    new PhoneSmsTool(),
    new PhoneNotificationsTool(),
  ]
}
