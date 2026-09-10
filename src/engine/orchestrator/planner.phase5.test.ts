import { describe, it, expect } from 'vitest'
import {
  extractTypeText,
  extractSearchQuery,
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
    function makeRequest(text: string, caps: string[] = []): OrchestrationRequest {
      return {
        originalText: text,
        requestClass: 'multi_step_goal',
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
  })
})
