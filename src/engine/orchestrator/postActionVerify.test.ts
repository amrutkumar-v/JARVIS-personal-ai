import { describe, it, expect } from 'vitest'
import { planPostActionObservation } from './postActionVerify'

describe('Phase 5 — postActionVerify', () => {
  describe('planPostActionObservation', () => {
    it('returns undefined for failed actions', () => {
      expect(planPostActionObservation('app.launch', {}, { success: false, output: null, summary: 'fail' })).toBeUndefined()
    })
    it('plans app.launch → app.status observation', () => {
      const obs = planPostActionObservation('app.launch', { application_id: 'notepad' }, { success: true, output: { started: true }, summary: 'ok' })
      expect(obs).toBeDefined()
      expect(obs!.observeToolId).toBe('app.status')
      expect(obs!.observeParams).toEqual({ application_id: 'notepad' })
    })
    it('app.launch verification passes when running', () => {
      const obs = planPostActionObservation('app.launch', { application_id: 'notepad' }, { success: true, output: null, summary: 'ok' })
      expect(obs!.verify({ running: true }).passed).toBe(true)
    })
    it('app.launch verification fails when not running', () => {
      const obs = planPostActionObservation('app.launch', { application_id: 'notepad' }, { success: true, output: null, summary: 'ok' })
      expect(obs!.verify({ running: false }).passed).toBe(false)
    })
    it('plans app.close → app.status observation', () => {
      const obs = planPostActionObservation('app.close', { application_id: 'notepad' }, { success: true, output: null, summary: 'ok' })
      expect(obs).toBeDefined()
      expect(obs!.observeToolId).toBe('app.status')
    })
    it('app.close verification passes when not running', () => {
      const obs = planPostActionObservation('app.close', { application_id: 'notepad' }, { success: true, output: null, summary: 'ok' })
      expect(obs!.verify({ running: false }).passed).toBe(true)
    })
    it('app.close verification fails when still running', () => {
      const obs = planPostActionObservation('app.close', { application_id: 'notepad' }, { success: true, output: null, summary: 'ok' })
      expect(obs!.verify({ running: true }).passed).toBe(false)
    })
    it('plans clipboard.write → clipboard.read observation', () => {
      const obs = planPostActionObservation('clipboard.write', { text: 'hello' }, { success: true, output: null, summary: 'ok' })
      expect(obs).toBeDefined()
      expect(obs!.observeToolId).toBe('clipboard.read')
    })
    it('clipboard.write verification passes on match', () => {
      const obs = planPostActionObservation('clipboard.write', { text: 'hello' }, { success: true, output: null, summary: 'ok' })
      expect(obs!.verify({ text: 'hello' }).passed).toBe(true)
    })
    it('clipboard.write verification fails on mismatch', () => {
      const obs = planPostActionObservation('clipboard.write', { text: 'hello' }, { success: true, output: null, summary: 'ok' })
      expect(obs!.verify({ text: 'world' }).passed).toBe(false)
    })
    it('plans browser.search → browser.readPage observation', () => {
      const obs = planPostActionObservation('browser.search', { query: 'test' }, { success: true, output: null, summary: 'ok' })
      expect(obs).toBeDefined()
      expect(obs!.observeToolId).toBe('browser.readPage')
    })
    it('browser.search verification passes with content', () => {
      const obs = planPostActionObservation('browser.search', { query: 'test' }, { success: true, output: null, summary: 'ok' })
      expect(obs!.verify({ textLength: 100 }).passed).toBe(true)
    })
    it('browser.search verification fails with empty page', () => {
      const obs = planPostActionObservation('browser.search', { query: 'test' }, { success: true, output: null, summary: 'ok' })
      expect(obs!.verify({ textLength: 2 }).passed).toBe(false)
    })
    it('plans browser.navigate → browser.readPage observation', () => {
      const obs = planPostActionObservation('browser.navigate', { url: 'https://example.com' }, { success: true, output: null, summary: 'ok' })
      expect(obs).toBeDefined()
      expect(obs!.observeToolId).toBe('browser.readPage')
    })
    it('returns undefined for unknown tool', () => {
      expect(planPostActionObservation('unknown.tool', {}, { success: true, output: null, summary: 'ok' })).toBeUndefined()
    })
    it('returns undefined for clipboard.read (read-only, no cross-tool verification)', () => {
      expect(planPostActionObservation('clipboard.read', {}, { success: true, output: null, summary: 'ok' })).toBeUndefined()
    })
  })
})
