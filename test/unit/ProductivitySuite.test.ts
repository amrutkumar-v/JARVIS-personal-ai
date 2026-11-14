/**
 * JARVIS Phase 9: Real Productivity & Service Integrations Acceptance Test Suite
 *
 * Verifies:
 * 1. UniversalIntentRouter routes Email, Calendar, and Git requests to PRODUCTIVITY.
 * 2. Two-phase confirmation protocol (ConfirmationManager) protects mutating actions.
 * 3. EmailProvider (list, get, draft, gated send).
 * 4. CalendarProvider (events, conflict detection, iCal RFC 5545 export/import, gated delete).
 * 5. GitWorkspaceProvider (status, diff, log, gated commit).
 * 6. AssistantEngine registers all 12 productivity tools in its ToolRegistry.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { UniversalIntentRouter } from '../../src/engine/orchestrator/UniversalIntentRouter'
import { ConfirmationManager } from '../../src/engine/productivity/ConfirmationManager'
import {
  LocalCalendarAdapter,
  LocalEmailAdapter,
  LocalGitAdapter,
} from '../../src/engine/productivity/ProductivityAdapters'
import {
  createProductivityTools,
  EmailListTool,
  EmailDraftTool,
  EmailSendTool,
  CalendarListTool,
  CalendarConflictsTool,
  CalendarCreateTool,
  CalendarDeleteTool,
  GitStatusTool,
  GitDiffTool,
  GitCommitTool,
} from '../../src/engine/productivity/ProductivityTools'
import { AssistantEngine } from '../../src/engine/AssistantEngine'

function stubStorage(): void {
  const backing = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  ;(globalThis as Record<string, unknown>).window = {
    localStorage,
    setTimeout: (_fn: () => void) => 0,
    location: { hostname: '127.0.0.1', protocol: 'http:', port: '3000' },
  }
}

describe('JARVIS Phase 9: Productivity & Service Integrations', () => {
  beforeEach(() => {
    stubStorage()
  })

  // --------------------------------------------------------------------------
  // 1. Intent Routing for Productivity Services
  // --------------------------------------------------------------------------
  describe('1. Intent Routing', () => {
    const router = new UniversalIntentRouter()

    it('routes email list requests to PRODUCTIVITY', () => {
      const decision = router.classify('Check my unread emails from the team')
      expect(decision.strategy).toBe('PRODUCTIVITY')
      expect(decision.intent).toBe('email_list')
      expect(decision.suggestedCapabilities).toContain('email.list')
    })

    it('routes email send requests to PRODUCTIVITY', () => {
      const decision = router.classify('Send email to partner@firm.com with Q4 update')
      expect(decision.strategy).toBe('PRODUCTIVITY')
      expect(decision.intent).toBe('email_send')
      expect(decision.suggestedCapabilities).toContain('email.send')
    })

    it('routes calendar schedule queries to PRODUCTIVITY', () => {
      const decision = router.classify('Check my calendar schedule for today')
      expect(decision.strategy).toBe('PRODUCTIVITY')
      expect(decision.intent).toBe('calendar_list')
      expect(decision.suggestedCapabilities).toContain('calendar.list')
    })

    it('routes calendar conflict checks to PRODUCTIVITY', () => {
      const decision = router.classify('Check calendar conflicts for 2 PM')
      expect(decision.strategy).toBe('PRODUCTIVITY')
      expect(decision.intent).toBe('calendar_conflicts')
      expect(decision.suggestedCapabilities).toContain('calendar.conflicts')
    })

    it('routes calendar meeting creation to PRODUCTIVITY', () => {
      const decision = router.classify('Schedule a meeting with engineering team')
      expect(decision.strategy).toBe('PRODUCTIVITY')
      expect(decision.intent).toBe('calendar_create')
      expect(decision.suggestedCapabilities).toContain('calendar.create')
    })

    it('routes git status to PRODUCTIVITY', () => {
      const decision = router.classify('Check git status in my workspace')
      expect(decision.strategy).toBe('PRODUCTIVITY')
      expect(decision.intent).toBe('git_status')
      expect(decision.suggestedCapabilities).toContain('git.status')
    })

    it('routes git commit to PRODUCTIVITY', () => {
      const decision = router.classify('Git commit staged changes with message update tests')
      expect(decision.strategy).toBe('PRODUCTIVITY')
      expect(decision.intent).toBe('git_commit')
      expect(decision.suggestedCapabilities).toContain('git.commit')
    })
  })

  // --------------------------------------------------------------------------
  // 2. Two-Phase Confirmation Protocol
  // --------------------------------------------------------------------------
  describe('2. Confirmation Manager & Safety Protocol', () => {
    it('creates single-use confirmation token with TTL', () => {
      const cm = new ConfirmationManager()
      const req = cm.requestConfirmation('email.send', 'Send email to team', 'team@co.org', { subject: 'Hi' })

      expect(req.requiresConfirmation).toBe(true)
      expect(req.confirmationToken).toBeDefined()
      expect(req.prompt).toContain('Confirmation required for email.send')

      // Token can be verified and consumed
      const verification = cm.verifyAndConsume(req.confirmationToken!, 'email.send')
      expect(verification.valid).toBe(true)
      expect(verification.request?.target).toBe('team@co.org')

      // Token is single-use: second consumption fails
      const reVerify = cm.verifyAndConsume(req.confirmationToken!, 'email.send')
      expect(reVerify.valid).toBe(false)
      expect(reVerify.error).toContain('Invalid or expired')
    })

    it('rejects confirmation token for mismatched action', () => {
      const cm = new ConfirmationManager()
      const req = cm.requestConfirmation('email.send', 'Send email', 'user@co.org', {})

      const verification = cm.verifyAndConsume(req.confirmationToken!, 'calendar.delete')
      expect(verification.valid).toBe(false)
      expect(verification.error).toContain('mismatch')
    })

    it('expires confirmation token after TTL', () => {
      const cm = new ConfirmationManager(1) // 1ms TTL
      const req = cm.requestConfirmation('git.commit', 'Commit changes', 'repo', {})

      // Wait 10ms for expiration
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const verification = cm.verifyAndConsume(req.confirmationToken!, 'git.commit')
          expect(verification.valid).toBe(false)
          resolve()
        }, 15)
      })
    })
  })

  // --------------------------------------------------------------------------
  // 3. Email Integration
  // --------------------------------------------------------------------------
  describe('3. Email Integration', () => {
    let cm: ConfirmationManager
    let email: LocalEmailAdapter

    beforeEach(() => {
      cm = new ConfirmationManager()
      email = new LocalEmailAdapter(cm)
    })

    it('lists and filters emails', async () => {
      const all = await email.listEmails()
      expect(all.length).toBeGreaterThanOrEqual(2)

      const unread = await email.listEmails({ unreadOnly: true })
      expect(unread.every((e) => !e.isRead)).toBe(true)

      const search = await email.listEmails({ query: 'Roadmap' })
      expect(search.length).toBeGreaterThan(0)
      expect(search[0].subject).toContain('Roadmap')
    })

    it('creates draft without requiring confirmation', async () => {
      const draft = await email.createDraft({
        to: ['colleague@co.org'],
        subject: 'Draft Project Specs',
        body: 'Here are the draft specifications.',
      })
      expect(draft.success).toBe(true)
      expect(draft.id).toBeDefined()

      const fetched = await email.getEmail(draft.id)
      expect(fetched?.isDraft).toBe(true)
      expect(fetched?.subject).toBe('Draft Project Specs')
    })

    it('blocks sending email without confirmation token', async () => {
      const res = await email.sendEmail({
        to: ['client@external.com'],
        subject: 'Proposal Review',
        body: 'Please find our proposal attached.',
      })

      expect(res.success).toBe(false)
      expect(res.requiresConfirmation).toBe(true)
      expect(res.prompt).toContain('Confirmation required for email.send')

      // Extract token from confirmation manager
      const pending = cm.listPending()
      expect(pending).toHaveLength(1)
      expect(pending[0].action).toBe('email.send')

      // Provide token to successfully send
      const confirmedRes = await email.sendEmail(
        {
          to: ['client@external.com'],
          subject: 'Proposal Review',
          body: 'Please find our proposal attached.',
        },
        pending[0].id,
      )
      expect(confirmedRes.success).toBe(true)
      expect(confirmedRes.message).toContain('successfully sent')
    })
  })

  // --------------------------------------------------------------------------
  // 4. Calendar Integration with Conflict Detection & iCal
  // --------------------------------------------------------------------------
  describe('4. Calendar Integration', () => {
    let cm: ConfirmationManager
    let calendar: LocalCalendarAdapter

    beforeEach(() => {
      cm = new ConfirmationManager()
      calendar = new LocalCalendarAdapter(cm)
    })

    it('creates events and detects scheduling conflicts', async () => {
      const start = '2026-11-15T14:00:00.000Z'
      const end = '2026-11-15T15:00:00.000Z'

      // 1. Create first meeting
      const ev1 = await calendar.createEvent({
        title: 'Team Sync',
        start,
        end,
      })
      expect(ev1.success).toBe(true)
      expect(ev1.hasConflict).toBe(false)

      // 2. Conflict check for overlapping window (14:30 - 15:30)
      const conflicts = await calendar.detectConflicts(
        '2026-11-15T14:30:00.000Z',
        '2026-11-15T15:30:00.000Z',
      )
      expect(conflicts.length).toBe(1)
      expect(conflicts[0].id).toBe(ev1.id)

      // 3. Create second meeting overlapping with first
      const ev2 = await calendar.createEvent({
        title: 'Client Call',
        start: '2026-11-15T14:30:00.000Z',
        end: '2026-11-15T15:30:00.000Z',
      })
      expect(ev2.success).toBe(true)
      expect(ev2.hasConflict).toBe(true)
      expect(ev2.conflicts).toBeDefined()
    })

    it('requires confirmation before deleting calendar event', async () => {
      const ev = await calendar.createEvent({
        title: 'One-off Sync',
        start: '2026-11-20T10:00:00.000Z',
        end: '2026-11-20T11:00:00.000Z',
      })

      // Attempt deletion without token
      const del1 = await calendar.deleteEvent(ev.id)
      expect(del1.success).toBe(false)
      expect(del1.requiresConfirmation).toBe(true)

      const pending = cm.listPending()
      expect(pending[0].action).toBe('calendar.delete')

      // Confirm deletion with token
      const del2 = await calendar.deleteEvent(ev.id, pending[0].id)
      expect(del2.success).toBe(true)

      const fetched = await calendar.getEvent(ev.id)
      expect(fetched).toBeNull()
    })

    it('exports and imports RFC 5545 iCalendar (.ics) files', async () => {
      const ics = await calendar.exportIcs()
      expect(ics).toContain('BEGIN:VCALENDAR')
      expect(ics).toContain('VERSION:2.0')
      expect(ics).toContain('BEGIN:VEVENT')
      expect(ics).toContain('END:VCALENDAR')

      // Test importing external iCal string
      const externalIcs = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'SUMMARY:External Stakeholder Presentation',
        'DESCRIPTION:Presenting autonomous agent progress',
        'LOCATION:Boardroom 4',
        'DTSTART:20261125T160000Z',
        'DTEND:20261125T170000Z',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n')

      const imported = await calendar.importIcs(externalIcs)
      expect(imported.importedCount).toBe(1)
      expect(imported.events[0].title).toBe('External Stakeholder Presentation')
      expect(imported.events[0].location).toBe('Boardroom 4')
    })
  })

  // --------------------------------------------------------------------------
  // 5. Git Workspace Integration
  // --------------------------------------------------------------------------
  describe('5. Git Workspace Integration', () => {
    let cm: ConfirmationManager
    let git: LocalGitAdapter

    beforeEach(() => {
      cm = new ConfirmationManager()
      git = new LocalGitAdapter(cm, {
        branch: 'feature/ai-integration',
        clean: false,
        staged: ['src/engine/AssistantEngine.ts'],
        modified: ['README.md'],
        untracked: [],
      })
    })

    it('inspects status, diff, and commit log', async () => {
      const status = await git.getStatus()
      expect(status.branch).toBe('feature/ai-integration')
      expect(status.clean).toBe(false)
      expect(status.staged).toContain('src/engine/AssistantEngine.ts')

      const diff = await git.getDiff(undefined, 'src/engine/AssistantEngine.ts')
      expect(diff.diff).toContain('diff --git')

      const log = await git.getLog(undefined, 5)
      expect(log.length).toBeGreaterThan(0)
      expect(log[0].hash).toBeDefined()
    })

    it('requires confirmation to commit changes', async () => {
      const res1 = await git.createCommit('D:/JARVIS', 'feat: Implement productivity integration')
      expect(res1.success).toBe(false)
      expect(res1.requiresConfirmation).toBe(true)

      const pending = cm.listPending()
      expect(pending[0].action).toBe('git.commit')

      const res2 = await git.createCommit(
        'D:/JARVIS',
        'feat: Implement productivity integration',
        pending[0].id,
      )
      expect(res2.success).toBe(true)
      expect(res2.hash).toBeDefined()

      const updatedStatus = await git.getStatus()
      expect(updatedStatus.clean).toBe(true)
    })
  })

  // --------------------------------------------------------------------------
  // 6. AssistantEngine Integration & Tool Discovery
  // --------------------------------------------------------------------------
  describe('6. AssistantEngine Integration', () => {
    it('registers all 12 productivity tools in ToolRegistry', () => {
      const engine = new AssistantEngine()
      const toolIds = engine.tools.ids()

      expect(toolIds).toContain('email.list')
      expect(toolIds).toContain('email.get')
      expect(toolIds).toContain('email.draft')
      expect(toolIds).toContain('email.send')
      expect(toolIds).toContain('calendar.list')
      expect(toolIds).toContain('calendar.conflicts')
      expect(toolIds).toContain('calendar.create')
      expect(toolIds).toContain('calendar.delete')
      expect(toolIds).toContain('git.status')
      expect(toolIds).toContain('git.diff')
      expect(toolIds).toContain('git.log')
      expect(toolIds).toContain('git.commit')

      expect(engine.confirmations).toBeDefined()
      expect(engine.emails).toBeDefined()
      expect(engine.calendars).toBeDefined()
      expect(engine.gitWorkspaces).toBeDefined()
    })

    it('executes email.list tool through engine registry', async () => {
      const engine = new AssistantEngine()
      const tool = engine.tools.get('email.list')
      expect(tool).toBeDefined()

      const res = await tool!.execute({ query: 'list emails', params: { unreadOnly: false } }, { requestId: 'req_1' })
      expect(res.ok).toBe(true)
      expect(res.message).toContain('Retrieved')
    })

    it('executes calendar.conflicts tool through engine registry', async () => {
      const engine = new AssistantEngine()
      const tool = engine.tools.get('calendar.conflicts')
      expect(tool).toBeDefined()

      const res = await tool!.execute(
        {
          query: 'check conflicts',
          params: { start: '2026-11-12T10:00:00Z', end: '2026-11-12T11:00:00Z' },
        },
        { requestId: 'req_2' },
      )
      expect(res.ok).toBe(true)
      expect(res.data).toBeDefined()
    })
  })
})
