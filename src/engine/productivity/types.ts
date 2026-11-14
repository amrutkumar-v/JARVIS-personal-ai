/**
 * Productivity & Service Integration Types (Phase 9).
 *
 * Defines typed domain models for Email, Calendar, and Git workspace operations,
 * along with the two-phase confirmation protocol for external / mutating actions.
 */

export interface EmailMessage {
  id: string
  threadId?: string
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  isHtml?: boolean
  date: string
  isRead: boolean
  isDraft: boolean
  labels: string[]
}

export interface EmailFilter {
  query?: string
  unreadOnly?: boolean
  maxResults?: number
  label?: string
  fromDate?: string
}

export interface EmailDraft {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  isHtml?: boolean
}

export interface EmailProvider {
  readonly id: string
  listEmails(filter?: EmailFilter): Promise<EmailMessage[]>
  getEmail(id: string): Promise<EmailMessage | null>
  createDraft(draft: EmailDraft): Promise<{ success: boolean; id: string; message: string }>
  sendEmail(draftIdOrData: string | EmailDraft, confirmationToken?: string): Promise<{ success: boolean; id: string; message: string }>
}

export interface CalendarEvent {
  id: string
  title: string
  description?: string
  location?: string
  start: string // ISO 8601
  end: string // ISO 8601
  allDay?: boolean
  attendees?: string[]
  recurrence?: string
  status?: 'confirmed' | 'tentative' | 'cancelled'
}

export interface CalendarFilter {
  startFrom?: string
  endBefore?: string
  query?: string
  maxResults?: number
}

export interface CalendarEventInput {
  title: string
  description?: string
  location?: string
  start: string
  end: string
  allDay?: boolean
  attendees?: string[]
}

export interface CalendarProvider {
  readonly id: string
  listEvents(filter?: CalendarFilter): Promise<CalendarEvent[]>
  getEvent(id: string): Promise<CalendarEvent | null>
  createEvent(input: CalendarEventInput): Promise<{ success: boolean; id: string; event: CalendarEvent; hasConflict?: boolean }>
  updateEvent(id: string, updates: Partial<CalendarEventInput>): Promise<{ success: boolean; id: string; event: CalendarEvent; hasConflict?: boolean }>
  deleteEvent(id: string, confirmationToken?: string): Promise<{ success: boolean; message: string }>
  detectConflicts(start: string, end: string, excludeId?: string): Promise<CalendarEvent[]>
  exportIcs?(): Promise<string>
  importIcs?(icsContent: string): Promise<{ importedCount: number; events: CalendarEvent[] }>
}

export interface GitCommitLog {
  hash: string
  author: string
  date: string
  message: string
}

export interface GitStatusSummary {
  branch: string
  clean: boolean
  staged: string[]
  modified: string[]
  untracked: string[]
}

export interface GitWorkspaceProvider {
  readonly id: string
  getStatus(repoPath?: string): Promise<GitStatusSummary>
  getDiff(repoPath?: string, filePath?: string): Promise<{ diff: string }>
  getLog(repoPath?: string, maxCount?: number): Promise<GitCommitLog[]>
  createCommit(repoPath: string, message: string, confirmationToken?: string): Promise<{ success: boolean; hash: string; message: string }>
  createBranch(repoPath: string, branchName: string): Promise<{ success: boolean; branch: string }>
  switchBranch(repoPath: string, branchName: string): Promise<{ success: boolean; branch: string }>
}

export interface ConfirmationRequest {
  id: string
  action: 'email.send' | 'calendar.delete' | 'git.commit' | 'git.discard'
  summary: string
  target: string
  payload: Record<string, unknown>
  createdAt: number
  expiresAt: number
}

export interface ConfirmationResult {
  requiresConfirmation: boolean
  confirmationToken?: string
  prompt?: string
  request?: ConfirmationRequest
}

