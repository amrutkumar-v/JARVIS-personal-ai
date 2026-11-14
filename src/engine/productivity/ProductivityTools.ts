/**
 * Productivity Tools (Phase 9).
 *
 * Exposes verifiable tools for Email, Calendar, and Git operations
 * to AssistantEngine's ToolRegistry.
 */

import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolContextId,
  ToolInput,
  ToolPermission,
  ToolResult,
  ToolVerification,
} from '../../tools/Tool'
import type { ToolInputSchema } from '../provider'
import type { CalendarProvider, EmailProvider, GitWorkspaceProvider } from './types'

export interface ProductivityProviders {
  email: EmailProvider
  calendar: CalendarProvider
  git: GitWorkspaceProvider
}

abstract class ProductivityTool implements Tool {
  readonly category: ToolCategory = 'communication'
  readonly verifiable: boolean = false
  readonly requiresPermission: boolean = false
  readonly contexts: ToolContextId[] = ['generic']

  abstract readonly id: string
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly permission: ToolPermission
  abstract readonly inputSchema: ToolInputSchema

  abstract canRun(query: string): boolean
  abstract execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult>
}

/* ============================================================================
 * Email Tools
 * ========================================================================= */

export class EmailListTool extends ProductivityTool {
  readonly id = 'email.list'
  readonly name = 'List emails'
  readonly description = 'List, search, or filter emails from the inbox, unread, or specific labels.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search keywords in subject, sender, or body' },
      unreadOnly: { type: 'boolean', description: 'Filter only unread messages' },
      label: { type: 'string', description: 'Filter by label (inbox, sent, drafts, work)' },
      maxResults: { type: 'number', description: 'Max number of emails to retrieve' },
    },
    required: [],
  }

  private readonly email: EmailProvider

  constructor(email: EmailProvider) {
    super()
    this.email = email
  }

  canRun(query: string): boolean {
    return /\b(emails|inbox|unread\s*emails|list\s*emails|check\s*email|search\s*emails)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    try {
      const filter = {
        query: input.params?.query as string | undefined,
        unreadOnly: Boolean(input.params?.unreadOnly),
        label: input.params?.label as string | undefined,
        maxResults: input.params?.maxResults ? Number(input.params?.maxResults) : 10,
      }
      const emails = await this.email.listEmails(filter)
      return {
        ok: true,
        message: `Retrieved ${emails.length} email(s).`,
        data: { count: emails.length, emails },
      }
    } catch (err) {
      return { ok: false, message: `Failed to list emails: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

export class EmailGetTool extends ProductivityTool {
  readonly id = 'email.get'
  readonly name = 'Get email details'
  readonly description = 'Get full content, headers, and body of a specific email by ID.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Email message ID' },
    },
    required: ['id'],
  }

  private readonly email: EmailProvider

  constructor(email: EmailProvider) {
    super()
    this.email = email
  }

  canRun(query: string): boolean {
    return /\b(read\s*email|get\s*email|open\s*email|view\s*email)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const id = String(input.params?.id || '')
    if (!id) return { ok: false, message: 'Missing required "id" parameter.' }
    try {
      const email = await this.email.getEmail(id)
      if (!email) return { ok: false, message: `Email "${id}" not found.` }
      return {
        ok: true,
        message: `Email from ${email.from}: "${email.subject}" (${email.date})`,
        data: email,
      }
    } catch (err) {
      return { ok: false, message: `Failed to retrieve email: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

export class EmailDraftTool extends ProductivityTool {
  readonly id = 'email.draft'
  readonly name = 'Draft an email'
  readonly description = 'Create an email draft safely without sending. Does not require confirmation.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      to: { type: 'array', description: 'Recipient email addresses' },
      subject: { type: 'string', description: 'Subject line' },
      body: { type: 'string', description: 'Email body text' },
      cc: { type: 'array', description: 'Carbon copy recipient addresses' },
    },
    required: ['to', 'subject', 'body'],
  }

  private readonly email: EmailProvider

  constructor(email: EmailProvider) {
    super()
    this.email = email
  }

  canRun(query: string): boolean {
    return /\b(draft\s*email|compose\s*email|write\s*email|prepare\s*email)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const to = Array.isArray(input.params?.to) ? (input.params.to as string[]) : [String(input.params?.to || '')]
    const subject = String(input.params?.subject || '')
    const body = String(input.params?.body || '')
    if (!to[0] || !subject || !body) {
      return { ok: false, message: 'Missing required parameters: "to", "subject", or "body".' }
    }
    try {
      const res = await this.email.createDraft({
        to,
        subject,
        body,
        cc: Array.isArray(input.params?.cc) ? (input.params.cc as string[]) : undefined,
      })
      return {
        ok: true,
        message: res.message,
        data: res,
      }
    } catch (err) {
      return { ok: false, message: `Failed to create draft: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  verify(_input?: ToolInput, result?: ToolResult): Promise<ToolVerification> {
    const data = result?.data as { success?: boolean; id?: string } | undefined
    if (data?.success && data.id) {
      return Promise.resolve({ ok: true, message: `Draft "${data.id}" verified.`, checks: ['draft_saved'] })
    }
    return Promise.resolve({ ok: false, message: 'Draft verification failed.', checks: ['draft_saved'] })
  }
}

export class EmailSendTool extends ProductivityTool {
  readonly id = 'email.send'
  readonly name = 'Send email (requires confirmation)'
  readonly description = 'Send an email to external recipients. Strictly requires explicit two-phase confirmation.'
  readonly permission: ToolPermission = 'high_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      draftId: { type: 'string', description: 'Existing draft ID to send' },
      to: { type: 'array', description: 'Recipient addresses' },
      subject: { type: 'string', description: 'Subject line' },
      body: { type: 'string', description: 'Body text' },
      confirmationToken: { type: 'string', description: 'Confirmation token from previous request' },
    },
    required: [],
  }

  private readonly email: EmailProvider

  constructor(email: EmailProvider) {
    super()
    this.email = email
  }

  canRun(query: string): boolean {
    return /\b(send\s*email|dispatch\s*email|mail\s*to)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const confirmationToken = input.params?.confirmationToken as string | undefined
    const draftId = input.params?.draftId as string | undefined
    const to = Array.isArray(input.params?.to) ? (input.params.to as string[]) : input.params?.to ? [String(input.params.to)] : []
    const subject = String(input.params?.subject || '')
    const body = String(input.params?.body || '')

    try {
      const target = draftId || { to, subject, body }
      const res = await this.email.sendEmail(target, confirmationToken)
      return {
        ok: res.success,
        message: res.message,
        data: res,
      }
    } catch (err) {
      return { ok: false, message: `Email send blocked: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  verify(_input?: ToolInput, result?: ToolResult): Promise<ToolVerification> {
    const data = result?.data as { success?: boolean; id?: string } | undefined
    if (data?.success) {
      return Promise.resolve({ ok: true, message: `Email confirmed sent (ID: ${data.id}).`, checks: ['email_sent'] })
    }
    return Promise.resolve({ ok: false, message: 'Email send was not completed.', checks: ['email_sent'] })
  }
}

/* ============================================================================
 * Calendar Tools
 * ========================================================================= */

export class CalendarListTool extends ProductivityTool {
  readonly id = 'calendar.list'
  readonly name = 'List calendar events'
  readonly description = 'List, filter, or query calendar events across time ranges.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      startFrom: { type: 'string', description: 'Start date filter (ISO string)' },
      endBefore: { type: 'string', description: 'End date filter (ISO string)' },
      query: { type: 'string', description: 'Search event title, description, location' },
      maxResults: { type: 'number', description: 'Max events to return' },
    },
    required: [],
  }

  private readonly calendar: CalendarProvider

  constructor(calendar: CalendarProvider) {
    super()
    this.calendar = calendar
  }

  canRun(query: string): boolean {
    return /\b(calendar|schedule|events|upcoming\s*meetings|check\s*calendar|list\s*events)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    try {
      const filter = {
        startFrom: input.params?.startFrom as string | undefined,
        endBefore: input.params?.endBefore as string | undefined,
        query: input.params?.query as string | undefined,
        maxResults: input.params?.maxResults ? Number(input.params?.maxResults) : 20,
      }
      const events = await this.calendar.listEvents(filter)
      return {
        ok: true,
        message: `Found ${events.length} calendar event(s).`,
        data: { count: events.length, events },
      }
    } catch (err) {
      return { ok: false, message: `Failed to list events: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

export class CalendarConflictsTool extends ProductivityTool {
  readonly id = 'calendar.conflicts'
  readonly name = 'Detect calendar conflicts'
  readonly description = 'Detect scheduling conflicts for a prospective event time window.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      start: { type: 'string', description: 'Prospective start time (ISO string)' },
      end: { type: 'string', description: 'Prospective end time (ISO string)' },
      excludeId: { type: 'string', description: 'Optional event ID to exclude from conflict check' },
    },
    required: ['start', 'end'],
  }

  private readonly calendar: CalendarProvider

  constructor(calendar: CalendarProvider) {
    super()
    this.calendar = calendar
  }

  canRun(query: string): boolean {
    return /\b(conflict|conflicts|scheduling\s*conflict|overlap|available\s*slot)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const start = String(input.params?.start || '')
    const end = String(input.params?.end || '')
    if (!start || !end) return { ok: false, message: 'Missing "start" or "end" parameter.' }
    try {
      const conflicts = await this.calendar.detectConflicts(start, end, input.params?.excludeId as string | undefined)
      return {
        ok: true,
        message: conflicts.length === 0 ? 'No conflicts detected for this time window.' : `Detected ${conflicts.length} conflict(s).`,
        data: { hasConflict: conflicts.length > 0, conflicts },
      }
    } catch (err) {
      return { ok: false, message: `Conflict check failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

export class CalendarCreateTool extends ProductivityTool {
  readonly id = 'calendar.create'
  readonly name = 'Create calendar event'
  readonly description = 'Schedule a new calendar event with automatic conflict detection.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Event title' },
      start: { type: 'string', description: 'Start time (ISO string)' },
      end: { type: 'string', description: 'End time (ISO string)' },
      description: { type: 'string', description: 'Event description' },
      location: { type: 'string', description: 'Event location' },
      attendees: { type: 'array', description: 'List of attendee email addresses' },
    },
    required: ['title', 'start', 'end'],
  }

  private readonly calendar: CalendarProvider

  constructor(calendar: CalendarProvider) {
    super()
    this.calendar = calendar
  }

  canRun(query: string): boolean {
    return /\b(schedule\s*event|create\s*event|schedule\s*meeting|add\s*to\s*calendar|book\s*meeting)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const title = String(input.params?.title || '')
    const start = String(input.params?.start || '')
    const end = String(input.params?.end || '')
    if (!title || !start || !end) {
      return { ok: false, message: 'Missing required parameters: "title", "start", or "end".' }
    }
    try {
      const res = await this.calendar.createEvent({
        title,
        start,
        end,
        description: input.params?.description as string | undefined,
        location: input.params?.location as string | undefined,
        attendees: Array.isArray(input.params?.attendees) ? (input.params.attendees as string[]) : undefined,
      })
      const conflictMsg = res.hasConflict ? ' (Note: scheduling conflict detected with existing event)' : ''
      return {
        ok: true,
        message: `Created event "${title}" on ${start}${conflictMsg}.`,
        data: res,
      }
    } catch (err) {
      return { ok: false, message: `Failed to create event: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  verify(_input?: ToolInput, result?: ToolResult): Promise<ToolVerification> {
    const data = result?.data as { success?: boolean; id?: string } | undefined
    if (data?.success && data.id) {
      return Promise.resolve({ ok: true, message: `Event confirmed created (ID: ${data.id}).`, checks: ['event_saved'] })
    }
    return Promise.resolve({ ok: false, message: 'Event creation verification failed.', checks: ['event_saved'] })
  }
}

export class CalendarDeleteTool extends ProductivityTool {
  readonly id = 'calendar.delete'
  readonly name = 'Delete calendar event (requires confirmation)'
  readonly description = 'Delete a calendar event. Requires two-phase confirmation.'
  readonly permission: ToolPermission = 'high_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Event ID to delete' },
      confirmationToken: { type: 'string', description: 'Confirmation token from previous request' },
    },
    required: ['id'],
  }

  private readonly calendar: CalendarProvider

  constructor(calendar: CalendarProvider) {
    super()
    this.calendar = calendar
  }

  canRun(query: string): boolean {
    return /\b(delete\s*event|cancel\s*meeting|remove\s*event|cancel\s*event)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const id = String(input.params?.id || '')
    const confirmationToken = input.params?.confirmationToken as string | undefined
    if (!id) return { ok: false, message: 'Missing required "id" parameter.' }
    try {
      const res = await this.calendar.deleteEvent(id, confirmationToken)
      return {
        ok: res.success,
        message: res.message,
        data: res,
      }
    } catch (err) {
      return { ok: false, message: `Calendar deletion blocked: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  verify(_input?: ToolInput, result?: ToolResult): Promise<ToolVerification> {
    const data = result?.data as { success?: boolean } | undefined
    if (data?.success) {
      return Promise.resolve({ ok: true, message: 'Event confirmed deleted.', checks: ['event_deleted'] })
    }
    return Promise.resolve({ ok: false, message: 'Event deletion could not be confirmed.', checks: ['event_deleted'] })
  }
}

/* ============================================================================
 * Git Workspace Tools
 * ========================================================================= */

export class GitStatusTool extends ProductivityTool {
  readonly id = 'git.status'
  readonly name = 'Git repository status'
  readonly description = 'Inspect branch, staged, modified, and untracked files in the workspace.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Repository directory path' },
    },
    required: [],
  }

  private readonly git: GitWorkspaceProvider

  constructor(git: GitWorkspaceProvider) {
    super()
    this.git = git
  }

  canRun(query: string): boolean {
    return /\b(git\s*status|git\s*state|git\s*changes|git\s*working\s*tree)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    try {
      const status = await this.git.getStatus(input.params?.repoPath as string | undefined)
      return {
        ok: true,
        message: `Branch "${status.branch}": ${status.clean ? 'clean' : `${status.modified.length + status.staged.length} changed file(s)`}.`,
        data: status,
      }
    } catch (err) {
      return { ok: false, message: `Git status failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

export class GitDiffTool extends ProductivityTool {
  readonly id = 'git.diff'
  readonly name = 'Git diff'
  readonly description = 'Inspect unstaged or staged git diff for workspace files.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      filePath: { type: 'string', description: 'Optional specific file path' },
    },
    required: [],
  }

  private readonly git: GitWorkspaceProvider

  constructor(git: GitWorkspaceProvider) {
    super()
    this.git = git
  }

  canRun(query: string): boolean {
    return /\b(git\s*diff|show\s*diff|code\s*diff|changes\s*diff)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    try {
      const res = await this.git.getDiff(
        input.params?.repoPath as string | undefined,
        input.params?.filePath as string | undefined,
      )
      return {
        ok: true,
        message: res.diff ? `Diff (${res.diff.length} chars).` : 'Working tree clean, no differences.',
        data: res,
      }
    } catch (err) {
      return { ok: false, message: `Git diff failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

export class GitLogTool extends ProductivityTool {
  readonly id = 'git.log'
  readonly name = 'Git commit history'
  readonly description = 'Inspect commit history and recent commits.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      maxCount: { type: 'number', description: 'Number of commits to return' },
    },
    required: [],
  }

  private readonly git: GitWorkspaceProvider

  constructor(git: GitWorkspaceProvider) {
    super()
    this.git = git
  }

  canRun(query: string): boolean {
    return /\b(git\s*log|commit\s*history|recent\s*commits|git\s*history)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    try {
      const logs = await this.git.getLog(
        input.params?.repoPath as string | undefined,
        input.params?.maxCount ? Number(input.params?.maxCount) : 10,
      )
      return {
        ok: true,
        message: `Retrieved ${logs.length} commit(s).`,
        data: { count: logs.length, commits: logs },
      }
    } catch (err) {
      return { ok: false, message: `Git log failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

export class GitCommitTool extends ProductivityTool {
  readonly id = 'git.commit'
  readonly name = 'Git commit (requires confirmation)'
  readonly description = 'Commit staged changes to the repository. Requires explicit two-phase confirmation.'
  readonly permission: ToolPermission = 'high_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      repoPath: { type: 'string' },
      message: { type: 'string', description: 'Commit message' },
      confirmationToken: { type: 'string', description: 'Confirmation token from previous request' },
    },
    required: ['message'],
  }

  private readonly git: GitWorkspaceProvider

  constructor(git: GitWorkspaceProvider) {
    super()
    this.git = git
  }

  canRun(query: string): boolean {
    return /\b(git\s*commit|commit\s*changes|create\s*commit)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const repoPath = String(input.params?.repoPath || '')
    const message = String(input.params?.message || '')
    const confirmationToken = input.params?.confirmationToken as string | undefined

    if (!message) return { ok: false, message: 'Missing required "message" parameter.' }
    try {
      const res = await this.git.createCommit(repoPath, message, confirmationToken)
      return {
        ok: res.success,
        message: res.message,
        data: res,
      }
    } catch (err) {
      return { ok: false, message: `Git commit blocked: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  verify(_input?: ToolInput, result?: ToolResult): Promise<ToolVerification> {
    const data = result?.data as { success?: boolean; hash?: string } | undefined
    if (data?.success && data.hash) {
      return Promise.resolve({ ok: true, message: `Commit verified (Hash: ${data.hash}).`, checks: ['commit_recorded'] })
    }
    return Promise.resolve({ ok: false, message: 'Commit verification failed.', checks: ['commit_recorded'] })
  }
}

/**
 * Factory for creating all productivity suite tools.
 */
export function createProductivityTools(providers: ProductivityProviders): Tool[] {
  return [
    new EmailListTool(providers.email),
    new EmailGetTool(providers.email),
    new EmailDraftTool(providers.email),
    new EmailSendTool(providers.email),
    new CalendarListTool(providers.calendar),
    new CalendarConflictsTool(providers.calendar),
    new CalendarCreateTool(providers.calendar),
    new CalendarDeleteTool(providers.calendar),
    new GitStatusTool(providers.git),
    new GitDiffTool(providers.git),
    new GitLogTool(providers.git),
    new GitCommitTool(providers.git),
  ]
}
