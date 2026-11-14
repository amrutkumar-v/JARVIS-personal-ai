/**
 * Productivity Adapters (Phase 9).
 *
 * In-memory and service-backed adapters for Email, Calendar (with iCalendar / RFC 5545
 * and conflict detection), and Git workspace operations with structured confirmation gates.
 */

import type {
  CalendarEvent,
  CalendarEventInput,
  CalendarFilter,
  CalendarProvider,
  EmailDraft,
  EmailFilter,
  EmailMessage,
  EmailProvider,
  GitCommitLog,
  GitStatusSummary,
  GitWorkspaceProvider,
} from './types'
import { ConfirmationManager } from './ConfirmationManager'

/* ============================================================================
 * Local Email Adapter
 * ========================================================================= */

export class LocalEmailAdapter implements EmailProvider {
  readonly id = 'local-email'
  private emails = new Map<string, EmailMessage>()
  private drafts = new Map<string, EmailMessage>()
  private readonly confirmationManager: ConfirmationManager

  constructor(confirmationManager: ConfirmationManager, initialEmails?: EmailMessage[]) {
    this.confirmationManager = confirmationManager
    if (initialEmails && initialEmails.length > 0) {
      for (const email of initialEmails) {
        this.emails.set(email.id, email)
      }
    } else {
      // Seed default sample emails for immediate utility
      this.seedDefaults()
    }
  }

  private seedDefaults(): void {
    const defaultEmails: EmailMessage[] = [
      {
        id: 'msg_1',
        from: 'team@company.org',
        to: ['user@company.org'],
        subject: 'Q4 Project Roadmap Kickoff',
        body: 'Welcome to Q4 planning. Please review the attached objectives and milestone timeline.',
        date: new Date(Date.now() - 3600_000 * 4).toISOString(),
        isRead: false,
        isDraft: false,
        labels: ['inbox', 'work'],
      },
      {
        id: 'msg_2',
        from: 'updates@github.com',
        to: ['user@company.org'],
        subject: '[GitHub] Security Alert: dependencies updated',
        body: 'Automated PR merged for security vulnerability fix in core dependencies.',
        date: new Date(Date.now() - 3600_000 * 24).toISOString(),
        isRead: true,
        isDraft: false,
        labels: ['notifications'],
      },
    ]
    for (const em of defaultEmails) {
      this.emails.set(em.id, em)
    }
  }

  async listEmails(filter?: EmailFilter): Promise<EmailMessage[]> {
    let result = Array.from(this.emails.values())

    if (filter?.unreadOnly) {
      result = result.filter((e) => !e.isRead)
    }

    if (filter?.label) {
      const targetLabel = filter.label.toLowerCase()
      result = result.filter((e) => e.labels.some((l) => l.toLowerCase() === targetLabel))
    }

    if (filter?.query) {
      const q = filter.query.toLowerCase()
      result = result.filter(
        (e) =>
          e.subject.toLowerCase().includes(q) ||
          e.body.toLowerCase().includes(q) ||
          e.from.toLowerCase().includes(q),
      )
    }

    if (filter?.fromDate) {
      const fromTime = new Date(filter.fromDate).getTime()
      if (!Number.isNaN(fromTime)) {
        result = result.filter((e) => new Date(e.date).getTime() >= fromTime)
      }
    }

    result.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

    if (filter?.maxResults && filter.maxResults > 0) {
      result = result.slice(0, filter.maxResults)
    }

    return result
  }

  async getEmail(id: string): Promise<EmailMessage | null> {
    const email = this.emails.get(id) || this.drafts.get(id)
    if (!email) return null
    if (!email.isRead && this.emails.has(id)) {
      email.isRead = true
    }
    return { ...email }
  }

  async createDraft(draft: EmailDraft): Promise<{ success: boolean; id: string; message: string }> {
    const id = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const draftMsg: EmailMessage = {
      id,
      from: 'me@local',
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      body: draft.body,
      isHtml: draft.isHtml,
      date: new Date().toISOString(),
      isRead: true,
      isDraft: true,
      labels: ['drafts'],
    }
    this.drafts.set(id, draftMsg)
    return {
      success: true,
      id,
      message: `Draft created: "${draft.subject}" to [${draft.to.join(', ')}].`,
    }
  }

  async sendEmail(
    draftIdOrData: string | EmailDraft,
    confirmationToken?: string,
  ): Promise<{ success: boolean; id: string; message: string; requiresConfirmation?: boolean; prompt?: string }> {
    let toSend: EmailDraft
    let draftId: string | undefined

    if (typeof draftIdOrData === 'string') {
      const existing = this.drafts.get(draftIdOrData)
      if (!existing) {
        throw new Error(`Draft "${draftIdOrData}" not found.`)
      }
      toSend = {
        to: existing.to,
        cc: existing.cc,
        bcc: existing.bcc,
        subject: existing.subject,
        body: existing.body,
        isHtml: existing.isHtml,
      }
      draftId = draftIdOrData
    } else {
      toSend = draftIdOrData
    }

    // Safety Gate: External action confirmation check
    if (!confirmationToken) {
      const cnf = this.confirmationManager.requestConfirmation(
        'email.send',
        `Send email to ${toSend.to.join(', ')}: "${toSend.subject}"`,
        toSend.to.join(', '),
        { draftId, ...toSend },
      )
      return {
        success: false,
        id: draftId || '',
        message: cnf.prompt || 'Confirmation required.',
        requiresConfirmation: true,
        prompt: cnf.prompt,
      }
    }

    const verification = this.confirmationManager.verifyAndConsume(confirmationToken, 'email.send')
    if (!verification.valid) {
      throw new Error(`Email send rejected: ${verification.error}`)
    }

    // Successfully verified: dispatch/send email
    const id = `sent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const sentMsg: EmailMessage = {
      id,
      from: 'me@local',
      to: toSend.to,
      cc: toSend.cc,
      bcc: toSend.bcc,
      subject: toSend.subject,
      body: toSend.body,
      isHtml: toSend.isHtml,
      date: new Date().toISOString(),
      isRead: true,
      isDraft: false,
      labels: ['sent'],
    }

    this.emails.set(id, sentMsg)
    if (draftId) {
      this.drafts.delete(draftId)
    }

    return {
      success: true,
      id,
      message: `Email successfully sent to ${toSend.to.join(', ')}: "${toSend.subject}".`,
    }
  }
}

/* ============================================================================
 * Local Calendar Adapter with Conflict Detection & iCal Support
 * ========================================================================= */

export class LocalCalendarAdapter implements CalendarProvider {
  readonly id = 'local-calendar'
  private events = new Map<string, CalendarEvent>()
  private readonly confirmationManager: ConfirmationManager

  constructor(confirmationManager: ConfirmationManager, initialEvents?: CalendarEvent[]) {
    this.confirmationManager = confirmationManager
    if (initialEvents && initialEvents.length > 0) {
      for (const ev of initialEvents) {
        this.events.set(ev.id, ev)
      }
    } else {
      this.seedDefaults()
    }
  }

  private seedDefaults(): void {
    const today = new Date()
    today.setHours(10, 0, 0, 0)
    const endToday = new Date(today.getTime() + 3600_000)

    const defaultEvents: CalendarEvent[] = [
      {
        id: 'cal_event_1',
        title: 'Architecture Review',
        description: 'Review system design and modular specifications.',
        location: 'Virtual Room A',
        start: today.toISOString(),
        end: endToday.toISOString(),
        attendees: ['alice@company.org', 'bob@company.org'],
        status: 'confirmed',
      },
    ]
    for (const ev of defaultEvents) {
      this.events.set(ev.id, ev)
    }
  }

  async detectConflicts(start: string, end: string, excludeId?: string): Promise<CalendarEvent[]> {
    const targetStart = new Date(start).getTime()
    const targetEnd = new Date(end).getTime()
    if (Number.isNaN(targetStart) || Number.isNaN(targetEnd)) {
      throw new Error('Invalid start or end date format.')
    }
    if (targetEnd <= targetStart) {
      throw new Error('End time must be after start time.')
    }

    const conflicts: CalendarEvent[] = []
    for (const ev of this.events.values()) {
      if (excludeId && ev.id === excludeId) continue
      if (ev.status === 'cancelled') continue

      const evStart = new Date(ev.start).getTime()
      const evEnd = new Date(ev.end).getTime()

      // Overlap condition: startA < endB && endA > startB
      if (targetStart < evEnd && targetEnd > evStart) {
        conflicts.push({ ...ev })
      }
    }
    return conflicts
  }

  async listEvents(filter?: CalendarFilter): Promise<CalendarEvent[]> {
    let result = Array.from(this.events.values())

    if (filter?.startFrom) {
      const fromTime = new Date(filter.startFrom).getTime()
      result = result.filter((e) => new Date(e.end).getTime() >= fromTime)
    }

    if (filter?.endBefore) {
      const beforeTime = new Date(filter.endBefore).getTime()
      result = result.filter((e) => new Date(e.start).getTime() <= beforeTime)
    }

    if (filter?.query) {
      const q = filter.query.toLowerCase()
      result = result.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          (e.description && e.description.toLowerCase().includes(q)) ||
          (e.location && e.location.toLowerCase().includes(q)),
      )
    }

    result.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

    if (filter?.maxResults && filter.maxResults > 0) {
      result = result.slice(0, filter.maxResults)
    }

    return result
  }

  async getEvent(id: string): Promise<CalendarEvent | null> {
    const ev = this.events.get(id)
    return ev ? { ...ev } : null
  }

  async createEvent(
    input: CalendarEventInput,
  ): Promise<{ success: boolean; id: string; event: CalendarEvent; hasConflict: boolean; conflicts?: CalendarEvent[] }> {
    const conflicts = await this.detectConflicts(input.start, input.end)
    const id = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const newEvent: CalendarEvent = {
      id,
      title: input.title,
      description: input.description,
      location: input.location,
      start: input.start,
      end: input.end,
      allDay: input.allDay,
      attendees: input.attendees,
      status: 'confirmed',
    }
    this.events.set(id, newEvent)

    return {
      success: true,
      id,
      event: newEvent,
      hasConflict: conflicts.length > 0,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    }
  }

  async updateEvent(
    id: string,
    updates: Partial<CalendarEventInput>,
  ): Promise<{ success: boolean; id: string; event: CalendarEvent; hasConflict: boolean; conflicts?: CalendarEvent[] }> {
    const existing = this.events.get(id)
    if (!existing) {
      throw new Error(`Event "${id}" not found.`)
    }

    const start = updates.start ?? existing.start
    const end = updates.end ?? existing.end
    const conflicts = await this.detectConflicts(start, end, id)

    const updated: CalendarEvent = {
      ...existing,
      ...updates,
      start,
      end,
    }
    this.events.set(id, updated)

    return {
      success: true,
      id,
      event: updated,
      hasConflict: conflicts.length > 0,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    }
  }

  async deleteEvent(
    id: string,
    confirmationToken?: string,
  ): Promise<{ success: boolean; message: string; requiresConfirmation?: boolean; prompt?: string }> {
    const existing = this.events.get(id)
    if (!existing) {
      throw new Error(`Event "${id}" not found.`)
    }

    // Safety Gate: Deletion requires explicit confirmation
    if (!confirmationToken) {
      const cnf = this.confirmationManager.requestConfirmation(
        'calendar.delete',
        `Delete event "${existing.title}" on ${existing.start}`,
        id,
        { id, title: existing.title, start: existing.start },
      )
      return {
        success: false,
        message: cnf.prompt || 'Confirmation required.',
        requiresConfirmation: true,
        prompt: cnf.prompt,
      }
    }

    const verification = this.confirmationManager.verifyAndConsume(confirmationToken, 'calendar.delete')
    if (!verification.valid) {
      throw new Error(`Calendar event deletion rejected: ${verification.error}`)
    }

    this.events.delete(id)
    return {
      success: true,
      message: `Event "${existing.title}" successfully deleted.`,
    }
  }

  /**
   * Export all events to standard RFC 5545 iCalendar (.ics) format.
   */
  async exportIcs(): Promise<string> {
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//JARVIS AI//Personal AI Operating System//EN',
      'CALSCALE:GREGORIAN',
    ]

    for (const ev of this.events.values()) {
      lines.push('BEGIN:VEVENT')
      lines.push(`UID:${ev.id}`)
      lines.push(`SUMMARY:${ev.title}`)
      if (ev.description) lines.push(`DESCRIPTION:${ev.description.replace(/\n/g, '\\n')}`)
      if (ev.location) lines.push(`LOCATION:${ev.location}`)
      lines.push(`DTSTART:${ev.start.replace(/[-:]/g, '').split('.')[0]}Z`)
      lines.push(`DTEND:${ev.end.replace(/[-:]/g, '').split('.')[0]}Z`)
      if (ev.attendees && ev.attendees.length > 0) {
        for (const att of ev.attendees) {
          lines.push(`ATTENDEE;CN=${att}:mailto:${att}`)
        }
      }
      lines.push('STATUS:CONFIRMED')
      lines.push('END:VEVENT')
    }

    lines.push('END:VCALENDAR')
    return lines.join('\r\n')
  }

  /**
   * Import events from standard iCalendar (.ics) format.
   */
  async importIcs(icsContent: string): Promise<{ importedCount: number; events: CalendarEvent[] }> {
    const imported: CalendarEvent[] = []
    const veventBlocks = icsContent.split('BEGIN:VEVENT').slice(1)

    for (const block of veventBlocks) {
      const summaryMatch = block.match(/SUMMARY:(.*?)(\r?\n|$)/)
      const dtStartMatch = block.match(/DTSTART:(.*?)(\r?\n|$)/)
      const dtEndMatch = block.match(/DTEND:(.*?)(\r?\n|$)/)
      const descMatch = block.match(/DESCRIPTION:(.*?)(\r?\n|$)/)
      const locMatch = block.match(/LOCATION:(.*?)(\r?\n|$)/)

      if (summaryMatch && dtStartMatch) {
        const title = summaryMatch[1].trim()
        const rawStart = dtStartMatch[1].trim()
        const rawEnd = dtEndMatch ? dtEndMatch[1].trim() : rawStart

        const parseIcsDate = (str: string): string => {
          // Format: 20261112T100000Z
          if (str.length >= 15 && str.includes('T')) {
            const y = str.slice(0, 4)
            const m = str.slice(4, 6)
            const d = str.slice(6, 8)
            const h = str.slice(9, 11)
            const min = str.slice(11, 13)
            const s = str.slice(13, 15)
            return `${y}-${m}-${d}T${h}:${min}:${s}Z`
          }
          return new Date().toISOString()
        }

        const ev: CalendarEvent = {
          id: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          title,
          description: descMatch ? descMatch[1].trim().replace(/\\n/g, '\n') : undefined,
          location: locMatch ? locMatch[1].trim() : undefined,
          start: parseIcsDate(rawStart),
          end: parseIcsDate(rawEnd),
          status: 'confirmed',
        }
        this.events.set(ev.id, ev)
        imported.push(ev)
      }
    }

    return { importedCount: imported.length, events: imported }
  }
}

/* ============================================================================
 * Local Git Workspace Adapter with Mutation Safety Gate
 * ========================================================================= */

export class LocalGitAdapter implements GitWorkspaceProvider {
  readonly id = 'local-git'
  private readonly confirmationManager: ConfirmationManager
  private statusState: GitStatusSummary = {
    branch: 'main',
    clean: true,
    staged: [],
    modified: [],
    untracked: [],
  }
  private logs: GitCommitLog[] = [
    {
      hash: '7ce486e8f86c37c4516991fcb43a85dfcd2e521c',
      author: 'JARVIS Engineering <jarvis@system.ai>',
      date: new Date().toISOString(),
      message: 'feat: Universal intelligence and personal memory evolution',
    },
  ]

  constructor(confirmationManager: ConfirmationManager, initialStatus?: GitStatusSummary) {
    this.confirmationManager = confirmationManager
    if (initialStatus) {
      this.statusState = initialStatus
    }
  }

  async getStatus(_repoPath?: string): Promise<GitStatusSummary> {
    return { ...this.statusState }
  }

  async getDiff(_repoPath?: string, filePath?: string): Promise<{ diff: string }> {
    if (this.statusState.clean) {
      return { diff: '' }
    }
    const target = filePath ? `a/${filePath} b/${filePath}` : 'working tree'
    return {
      diff: `diff --git ${target}\n--- a/${filePath || 'file'}\n+++ b/${filePath || 'file'}\n@@ -1,3 +1,4 @@\n+ // Autonomous changes verified by JARVIS\n`,
    }
  }

  async getLog(_repoPath?: string, maxCount: number = 10): Promise<GitCommitLog[]> {
    return this.logs.slice(0, maxCount)
  }

  async createCommit(
    repoPath: string,
    message: string,
    confirmationToken?: string,
  ): Promise<{ success: boolean; hash: string; message: string; requiresConfirmation?: boolean; prompt?: string }> {
    if (!message || typeof message !== 'string') {
      throw new Error('Commit message is required.')
    }

    // Safety Gate: Git commits modify history and require confirmation
    if (!confirmationToken) {
      const cnf = this.confirmationManager.requestConfirmation(
        'git.commit',
        `Commit staged changes with message: "${message}"`,
        repoPath || 'current repository',
        { repoPath, message },
      )
      return {
        success: false,
        hash: '',
        message: cnf.prompt || 'Confirmation required.',
        requiresConfirmation: true,
        prompt: cnf.prompt,
      }
    }

    const verification = this.confirmationManager.verifyAndConsume(confirmationToken, 'git.commit')
    if (!verification.valid) {
      throw new Error(`Git commit rejected: ${verification.error}`)
    }

    const hash = Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10)
    const newLog: GitCommitLog = {
      hash,
      author: 'JARVIS <jarvis@local>',
      date: new Date().toISOString(),
      message,
    }
    this.logs.unshift(newLog)
    this.statusState.clean = true
    this.statusState.staged = []
    this.statusState.modified = []

    return {
      success: true,
      hash,
      message: `[${this.statusState.branch} ${hash.slice(0, 7)}] ${message}`,
    }
  }

  async createBranch(_repoPath: string, branchName: string): Promise<{ success: boolean; branch: string }> {
    if (!branchName) throw new Error('Branch name is required.')
    this.statusState.branch = branchName
    return { success: true, branch: branchName }
  }

  async switchBranch(_repoPath: string, branchName: string): Promise<{ success: boolean; branch: string }> {
    if (!branchName) throw new Error('Branch name is required.')
    this.statusState.branch = branchName
    return { success: true, branch: branchName }
  }
}

