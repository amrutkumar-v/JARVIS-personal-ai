import { describe, it, expect } from 'vitest'
import {
  extractTypeText,
  extractSearchQuery,
  extractWriteText,
  hasWriteIntent,
  JARVIS_WRITTEN_INTRO,
  hasCopyIntent,
  hasClipboardVerifyIntent,
  hasCloseIntent,
  planRequest,
} from './planner'
import type { OrchestrationRequest } from './types'

describe('Phase 5 — planner extensions', () => {
  describe('extractTypeText', () => {
    it('extracts quoted text', () => {
      expect(extractTypeText('type "Hello World"')).toBe('Hello World')
    })
    it('extracts unquoted text', () => {
      expect(extractTypeText('type Hello World')).toBe('Hello World')
    })
    it('extracts text with "and then copy"', () => {
      expect(extractTypeText('type Hello and then copy')).toBe('Hello')
    })
    it('returns undefined for no type verb', () => {
      expect(extractTypeText('open notepad')).toBeUndefined()
    })
  })

  describe('extractWriteText', () => {
    it('extracts an explicit type text', () => {
      expect(extractWriteText('open notepad type "Hello World"')).toBe('Hello World')
    })
    it('extracts the deterministic introduction for "introduce yourself in written format"', () => {
      expect(extractWriteText('Open Notepad and introduce yourself in written format.')).toBe(JARVIS_WRITTEN_INTRO)
    })
    it('returns undefined without a write/intro intent', () => {
      expect(extractWriteText('open notepad')).toBeUndefined()
    })
  })

  describe('hasWriteIntent', () => {
    it('detects an explicit type verb', () => expect(hasWriteIntent('open notepad and type Hello')).toBe(true))
    it('detects a written self-introduction', () => expect(hasWriteIntent('open notepad and introduce yourself in written format')).toBe(true))
    it('rejects a plain open', () => expect(hasWriteIntent('open notepad')).toBe(false))
    it('rejects an intro without written framing', () => expect(hasWriteIntent('introduce yourself')).toBe(false))
  })

  describe('hasCopyIntent', () => {
    it('detects "and copy"', () => expect(hasCopyIntent('type hello and copy')).toBe(true))
    it('detects "copy it"', () => expect(hasCopyIntent('type hello copy it')).toBe(true))
    it('detects "clipboard"', () => expect(hasCopyIntent('type hello clipboard')).toBe(true))
    it('rejects no copy', () => expect(hasCopyIntent('open notepad')).toBe(false))
  })

  describe('hasClipboardVerifyIntent', () => {
    it('detects "verify the clipboard"', () => expect(hasClipboardVerifyIntent('type hello and verify the clipboard')).toBe(true))
    it('rejects no verify', () => expect(hasClipboardVerifyIntent('type hello')).toBe(false))
  })

  describe('hasCloseIntent', () => {
    it('detects "close"', () => expect(hasCloseIntent('close notepad')).toBe(true))
    it('detects "quit"', () => expect(hasCloseIntent('quit notepad')).toBe(true))
    it('rejects no close', () => expect(hasCloseIntent('open notepad')).toBe(false))
  })

  describe('extractSearchQuery', () => {
    it('extracts quoted after "search for"', () => {
      expect(extractSearchQuery('search for "KLE Technology University"')).toBe('KLE Technology University')
    })
    it('extracts quoted after compound preamble', () => {
      expect(extractSearchQuery('open browser and search for "TypeScript docs"')).toBe('TypeScript docs')
    })
    it('extracts quoted from mixed flow', () => {
      expect(extractSearchQuery('open notepad, type "Hello", copy it, and search for "JARVIS AI" in the browser')).toBe('JARVIS AI')
    })
    it('extracts plain query', () => {
      expect(extractSearchQuery('search for TypeScript docs')).toBe('TypeScript docs')
    })
    it('extracts after browser-open preamble without quotes', () => {
      expect(extractSearchQuery('open browser and search for TypeScript docs')).toBe('TypeScript docs')
    })
    it('falls back to the verb-stripped phrase', () => {
      expect(extractSearchQuery('find documentation')).toBe('documentation')
    })
  })

  describe('planRequest compound patterns', () => {
    function makeRequest(text: string, caps: string[] = [], requestClass = 'multi_step_goal' as OrchestrationRequest['requestClass']): OrchestrationRequest {
      return {
        originalText: text,
        requestClass,
        confidence: 0.9,
        entities: {},
        requiresContext: false,
        isContinuation: false,
        suggestedCapabilities: [],
        targetDevices: [],
        availableCapabilities: caps,
        unavailableCapabilities: [],
        targets: [],
        explanation: 'test',
        processedAt: Date.now(),
      }
    }

    it('open notepad, type text, clipboard → 3 steps', () => {
      const req = makeRequest('open notepad type "Hello" and copy clipboard', [
        'open_application', 'type_text', 'clipboard_read',
      ])
      const plan = planRequest(req)
      expect(plan.verdict).toBe('ok')
      expect(plan.steps).toHaveLength(3)
      expect(plan.steps[0].capability).toBe('open_application')
      expect(plan.steps[1].capability).toBe('type_text')
      expect(plan.steps[2].capability).toBe('clipboard_read')
    })

    it('open notepad, type text (no clipboard) → 2 steps', () => {
      const req = makeRequest('open notepad and type "Hello World"', [
        'open_application', 'type_text',
      ])
      const plan = planRequest(req)
      expect(plan.verdict).toBe('ok')
      expect(plan.steps).toHaveLength(2)
      expect(plan.steps[0].capability).toBe('open_application')
      expect(plan.steps[1].capability).toBe('type_text')
    })

    it('browser search → 1 step', () => {
      const req = makeRequest('search for KLE Technology University', [
        'browser_search',
      ])
      const plan = planRequest(req)
      expect(plan.verdict).toBe('ok')
      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0].capability).toBe('browser_search')
    })

    it('open browser + search → 2 steps (when browser_open available, open_application not)', () => {
      const req = makeRequest('open browser and search for TypeScript docs', [
        'browser_open', 'browser_search',
      ])
      const plan = planRequest(req)
      expect(plan.verdict).toBe('ok')
      expect(plan.steps).toHaveLength(2)
      expect(plan.steps[0].capability).toBe('browser_open')
      expect(plan.steps[1].capability).toBe('browser_search')
    })

    it('write X to clipboard → 2 steps (write + read)', () => {
      const req = makeRequest('write "test data" to clipboard', [
        'clipboard_write', 'clipboard_read',
      ])
      const plan = planRequest(req)
      expect(plan.verdict).toBe('ok')
      expect(plan.steps).toHaveLength(2)
      expect(plan.steps[0].capability).toBe('clipboard_write')
      expect(plan.steps[1].capability).toBe('clipboard_read')
    })

    it('close notepad → 1 step', () => {
      const req = makeRequest('close notepad', ['close_application'])
      const plan = planRequest(req)
      expect(plan.verdict).toBe('ok')
      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0].capability).toBe('close_application')
    })

    it('launch notepad + verify running → 2 steps', () => {
      const req = makeRequest('launch notepad and verify it is running', [
        'open_application', 'application_status',
      ])
      const plan = planRequest(req)
      expect(plan.verdict).toBe('ok')
      expect(plan.steps).toHaveLength(2)
      expect(plan.steps[0].capability).toBe('open_application')
      expect(plan.steps[1].capability).toBe('application_status')
      expect(plan.steps[0].payload).toEqual({ application_id: 'notepad' })
    })

    it('mixed flow: open+type+copy+clipboard verify + browser search → 4 steps', () => {
      const req = makeRequest('open notepad, type "Hello mixed flow", copy it, and search for "JARVIS AI" in the browser', [
        'open_application', 'type_text', 'clipboard_read', 'browser_search',
      ])
      const plan = planRequest(req)
      expect(plan.verdict).toBe('ok')
      expect(plan.steps).toHaveLength(4)
      expect(plan.steps.map((s) => s.capability)).toEqual([
        'open_application', 'type_text', 'clipboard_read', 'browser_search',
      ])
      expect(plan.steps[3].payload).toEqual({ query: 'JARVIS AI' })
    })

    it('step payloads contain correct data', () => {
      const req = makeRequest('open notepad and type "Hello World"', [
        'open_application', 'type_text',
      ])
      const plan = planRequest(req)
      expect(plan.steps[0].payload).toEqual({ application_id: 'notepad' })
      expect(plan.steps[1].payload).toEqual({ text: 'Hello World' })
    })

    it('blocked when capabilities unavailable', () => {
      const req = makeRequest('open notepad and type "Hello"', [])
      const plan = planRequest(req)
      expect(plan.verdict).toBe('blocked')
    })

    it('command: open + write intro → 2 steps (open then type the introduction)', () => {
      const req = makeRequest('Open Notepad and introduce yourself in written format.', [
        'open_application', 'type_text',
      ], 'command')
      const plan = planRequest(req)
      expect(plan.verdict).toBe('ok')
      expect(plan.steps).toHaveLength(2)
      expect(plan.steps[0].capability).toBe('open_application')
      expect(plan.steps[0].payload).toEqual({ application_id: 'notepad' })
      expect(plan.steps[1].capability).toBe('type_text')
      expect(plan.steps[1].payload.text).toBe(JARVIS_WRITTEN_INTRO)
      expect(plan.steps[1].dependsOn).toEqual([0])
    })

    it('command: open + write without typing capability → open only with an honest reason', () => {
      const req = makeRequest('Open Notepad and introduce yourself in written format.', [
        'open_application',
      ], 'command')
      const plan = planRequest(req)
      expect(plan.verdict).toBe('ok')
      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0].capability).toBe('open_application')
      expect(plan.reason).toContain('Desktop text input is not available')
    })

    it('command: open + write with neither capability → blocked', () => {
      const req = makeRequest('Open Notepad and introduce yourself in written format.', [], 'command')
      const plan = planRequest(req)
      expect(plan.verdict).toBe('blocked')
      expect(plan.steps).toHaveLength(0)
    })
  })

  describe('real Windows control — phase-hardening deterministic paths', () => {
    function makeRequest(text: string, caps: string[] = [], requestClass = 'command' as OrchestrationRequest['requestClass']): OrchestrationRequest {
      return {
        originalText: text,
        requestClass,
        confidence: 0.9,
        entities: {},
        requiresContext: false,
        isContinuation: false,
        suggestedCapabilities: [],
        targetDevices: [],
        availableCapabilities: caps,
        unavailableCapabilities: [],
        targets: [],
        explanation: 'fixture',
        processedAt: Date.now(),
      }
    }

    it('pure status question "is chrome running?" → single read-only application_status step', () => {
      const plan = planRequest(makeRequest('is chrome running?', ['application_status']))
      expect(plan.verdict).toBe('ok')
      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0].capability).toBe('application_status')
      expect(plan.steps[0].payload).toEqual({ application_id: 'chrome' })
    })

    it('"what applications are open?" → a single real window-enumeration read', () => {
      for (const text of [
        'What applications are open?',
        'Tell me what applications are open',
        'which apps are running?',
        'list the open windows',
      ]) {
        const plan = planRequest(makeRequest(text, ['list_windows', 'open_application'], 'question'))
        expect(plan.verdict, text).toBe('ok')
        expect(plan.steps, text).toHaveLength(1)
        expect(plan.steps[0].capability, text).toBe('list_windows')
      }
    })

    it('the open-app read never hijacks an actionable request that mentions windows', () => {
      const plan = planRequest(
        makeRequest('open notepad and list the windows', ['open_application', 'list_windows'], 'multi_step_goal'),
      )
      // The read route is anchored to a question/list lead-in, so an action
      // request keeps flowing through the action branches.
      expect(plan.steps.map((s) => s.capability)).not.toContain('list_windows')
    })

    it('falls through when window observation is not available', () => {
      const plan = planRequest(makeRequest('What applications are open?', ['open_application'], 'question'))
      expect(plan.verdict).toBe('empty')
    })

    it('status question must not hijack a device battery request', () => {
      const plan = planRequest(makeRequest('check the battery of my S26 Ultra', ['list_devices', 'application_status', 'open_application'], 'device_operation'))
      expect(plan.verdict).toBe('ok')
      expect(plan.steps[0].capability).toBe('list_devices')
    })

    it('compound "launch notepad and verify it is running" → open + status, not a single status', () => {
      const plan = planRequest(makeRequest('launch notepad and verify it is running', ['open_application', 'application_status'], 'multi_step_goal'))
      expect(plan.verdict).toBe('ok')
      expect(plan.steps).toHaveLength(2)
      expect(plan.steps[0].capability).toBe('open_application')
      expect(plan.steps[0].payload).toEqual({ application_id: 'notepad' })
      expect(plan.steps[1].capability).toBe('application_status')
      expect(plan.steps[1].dependsOn).toEqual([0])
    })

    it('"open my downloads folder" → File Explorer on a CURATED folder token, never an app id', () => {
      const plan = planRequest(makeRequest('open my downloads folder', ['open_application']))
      expect(plan.verdict).toBe('ok')
      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0].capability).toBe('open_application')
      expect(plan.steps[0].payload).toEqual({ application_id: 'file-explorer', folder: '{userprofile}\\Downloads' })
    })

    it('"open workspace folder" → the bounded workspace token', () => {
      const plan = planRequest(makeRequest('open my workspace folder', ['open_application']))
      expect(plan.verdict).toBe('ok')
      expect(plan.steps[0].payload).toEqual({ application_id: 'file-explorer', folder: '{workspace}' })
    })

    it('"open the report" (a file) → blocked, never flattened into an app id', () => {
      const plan = planRequest(makeRequest('open the report', ['open_application']))
      expect(plan.verdict).toBe('blocked')
      expect(plan.reason).toMatch(/file or folder/)
      expect(plan.steps).toHaveLength(0)
    })

    it('"close notepad" → a single close_application step', () => {
      const plan = planRequest(makeRequest('close notepad', ['close_application']))
      expect(plan.verdict).toBe('ok')
      expect(plan.steps).toHaveLength(1)
      expect(plan.steps[0].capability).toBe('close_application')
      expect(plan.steps[0].payload).toEqual({ application_id: 'notepad' })
    })

    it('close with close_application unavailable → blocked honestly', () => {
      const plan = planRequest(makeRequest('close notepad', []))
      expect(plan.verdict).toBe('blocked')
      expect(plan.reason).toMatch(/close_application is not available/)
      expect(plan.steps).toHaveLength(0)
    })

    it('"launch notepad and verify it is running" with no status capability → blocked honestly', () => {
      const plan = planRequest(makeRequest('launch notepad and verify it is running', ['open_application'], 'multi_step_goal'))
      expect(plan.verdict).toBe('blocked')
      expect(plan.steps).toHaveLength(0)
    })
  })
})
