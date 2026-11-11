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
      expect(obs!.verify({ running: true, runningVerified: true })).toMatchObject({ status: 'verified', passed: true })
    })
    it('app.launch verification fails when not running', () => {
      const obs = planPostActionObservation('app.launch', { application_id: 'notepad' }, { success: true, output: null, summary: 'ok' })
      expect(obs!.verify({ running: false }).status).toBe('unverified')
      expect(obs!.verify({ running: false, runningVerified: true })).toMatchObject({ status: 'failed', passed: false })
    })
    it('app.launch verification is explicitly unverified when running state cannot be observed', () => {
      const obs = planPostActionObservation('app.launch', { application_id: 'notepad' }, { success: true, output: null, summary: 'ok' })
      expect(obs!.verify({ running: true, runningVerified: false })).toMatchObject({ status: 'unverified', passed: false })
    })
    it('plans app.close → app.status observation', () => {
      const obs = planPostActionObservation('app.close', { application_id: 'notepad' }, { success: true, output: null, summary: 'ok' })
      expect(obs).toBeDefined()
      expect(obs!.observeToolId).toBe('app.status')
    })
    it('app.close verification passes when not running', () => {
      const obs = planPostActionObservation('app.close', { application_id: 'notepad' }, { success: true, output: null, summary: 'ok' })
      expect(obs!.verify({ running: false, runningVerified: true })).toMatchObject({ status: 'verified', passed: true })
    })
    it('app.close verification fails when still running', () => {
      const obs = planPostActionObservation('app.close', { application_id: 'notepad' }, { success: true, output: null, summary: 'ok' })
      expect(obs!.verify({ running: true, runningVerified: true })).toMatchObject({ status: 'failed', passed: false })
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

    // Regression (real-windows execution audit): typing verification used to
    // plan a bare clipboard.read with NO way for the text to reach the
    // clipboard — the verifier's own premise (Ctrl+A, Ctrl+C) never executed.
    it('plans desktop.type → clipboard.read WITH select-all + copy pre-observe actions', () => {
      const obs = planPostActionObservation('desktop.type', { text: 'hello' }, { success: true, output: null, summary: 'ok' })
      expect(obs).toBeDefined()
      expect(obs!.observeToolId).toBe('clipboard.read')
      expect(obs!.preObserve).toEqual([
        { toolId: 'desktop.hotkey', params: { keys: ['control', 'a'] }, reason: 'select all text in the focused window' },
        { toolId: 'desktop.hotkey', params: { keys: ['control', 'c'] }, reason: 'copy the selection to the clipboard' },
      ])
    })
    it('desktop.type verification passes only when the clipboard genuinely contains the typed text', () => {
      const obs = planPostActionObservation('desktop.type', { text: 'hello' }, { success: true, output: null, summary: 'ok' })
      expect(obs!.verify({ text: 'hello world' }).passed).toBe(true)
    })
    it('an EMPTY clipboard can never verify typing (copy failed or found nothing)', () => {
      const obs = planPostActionObservation('desktop.type', { text: 'hello' }, { success: true, output: null, summary: 'ok' })
      // clipboard.read reports { empty: true } (no text) for an empty clipboard.
      expect(obs!.verify({ empty: true })).toMatchObject({ status: 'unverified', passed: false })
      expect(obs!.verify({})).toMatchObject({ status: 'unverified', passed: false })
    })
    it('desktop.type verification fails when the clipboard holds different content', () => {
      const obs = planPostActionObservation('desktop.type', { text: 'hello' }, { success: true, output: null, summary: 'ok' })
      expect(obs!.verify({ text: 'unrelated content' }).passed).toBe(false)
    })
  })
})
