import { describe, expect, it } from 'vitest'
import { MemoryManager } from './MemoryManager'
import { detectMemoryType, looksLikeCredential, looksLikeHighRiskCredential } from './detect'

describe('Phase 3 — Persistent Personal Memory & Continuity', () => {
  describe('Multi-Category Memory Classification', () => {
    it('classifies PREFERENCE statements', () => {
      const inputs = [
        'I prefer dark mode in all editors',
        'My favorite programming language is TypeScript',
        'I like concise replies and minimal commentary',
      ]
      for (const text of inputs) {
        expect(detectMemoryType(text), `Failed for: ${text}`).toBe('PREFERENCE')
      }
    })

    it('classifies PROJECT_DECISION statements', () => {
      const inputs = [
        'Architecture decision: we chose to use Vitest for acceptance testing',
        'We decided to keep AssistantEngine as the single central cognitive authority',
        'Our tech stack is React 19, TypeScript, and Vite',
      ]
      for (const text of inputs) {
        expect(detectMemoryType(text), `Failed for: ${text}`).toBe('PROJECT_DECISION')
      }
    })

    it('classifies WORKFLOW statements', () => {
      const inputs = [
        'Our test procedure workflow is to run npm test before committing',
        'Steps to build the project include running build:backend and build:engine',
        'Every time we deploy we run audit checks first',
      ]
      for (const text of inputs) {
        expect(detectMemoryType(text), `Failed for: ${text}`).toBe('WORKFLOW')
      }
    })

    it('classifies REFERENCE statements', () => {
      const inputs = [
        'The API documentation is at https://api.jarvis.internal/docs',
        'Our project repository is at D:/JARVIS',
        'The staging endpoint is https://staging.example.com',
      ]
      for (const text of inputs) {
        expect(detectMemoryType(text), `Failed for: ${text}`).toBe('REFERENCE')
      }
    })

    it('classifies FACT and PROFILE statements', () => {
      expect(detectMemoryType('My name is Samantha')).toBe('PROFILE')
      expect(detectMemoryType('I work at Google DeepMind')).toBe('FACT')
      expect(detectMemoryType('I live in Seattle')).toBe('FACT')
    })
  })

  describe('User Control: Save, Search, Inspect, Correct, Forget', () => {
    it('stores and retrieves memories with rich multi-category labels', async () => {
      const memory = new MemoryManager()
      memory.clear()

      // Save PREFERENCE
      const pref = memory.remember('I prefer dark mode in all IDEs', {
        type: detectMemoryType('I prefer dark mode in all IDEs'),
        source: 'user',
      })
      expect(pref.type).toBe('PREFERENCE')

      // Save PROJECT_DECISION
      const dec = memory.remember('Architecture decision: we decided to use Vite for client bundling', {
        type: detectMemoryType('Architecture decision: we decided to use Vite for client bundling'),
        source: 'user',
      })
      expect(dec.type).toBe('PROJECT_DECISION')

      // Save WORKFLOW
      const wf = memory.remember('Our workflow is to run tests before committing code', {
        type: detectMemoryType('Our workflow is to run tests before committing code'),
        source: 'user',
      })
      expect(wf.type).toBe('WORKFLOW')

      // Inspect: list all
      const all = memory.all()
      expect(all.length).toBe(3)
      expect(all.some((m) => m.type === 'PREFERENCE')).toBe(true)
      expect(all.some((m) => m.type === 'PROJECT_DECISION')).toBe(true)
      expect(all.some((m) => m.type === 'WORKFLOW')).toBe(true)

      // Search: recall relevant
      const searchRes = await memory.search('dark mode', { limit: 5 })
      expect(searchRes.length).toBeGreaterThan(0)
      expect(searchRes[0].item.content).toContain('dark mode')
      expect(searchRes[0].item.type).toBe('PREFERENCE')

      // Correct: update memory
      const corrected = memory.remember('I prefer light mode during daytime and dark mode at night', {
        type: 'PREFERENCE',
        source: 'user',
      })
      expect(corrected.content).toContain('light mode during daytime')

      // Forget: remove matching
      const removed = memory.removeMatching('dark mode')
      expect(removed).toBeGreaterThanOrEqual(1)

      const remaining = memory.all()
      expect(remaining.some((m) => m.content === 'I prefer dark mode in all IDEs')).toBe(false)
    })
  })

  describe('Security & Credential Rejection Safety', () => {
    it('refuses to memorize passwords, API keys, and bearer tokens', () => {
      const dangerousInputs = [
        'Remember that my password is SuperSecretPassword123!',
        'My API key is sk-proj-1234567890abcdef1234567890abcdef',
        'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        'Client secret is abcdef1234567890abcdef1234567890',
        'Database connection string is postgres://user:secretpass@localhost:5432/db',
      ]

      for (const dangerous of dangerousInputs) {
        expect(looksLikeCredential(dangerous), `Should detect credential in: ${dangerous}`).toBe(true)
        expect(looksLikeHighRiskCredential(dangerous), `Should detect high risk in: ${dangerous}`).toBe(true)

        const memory = new MemoryManager()
        expect(() => {
          memory.remember(dangerous, { type: 'FACT' })
        }).toThrow(/credential/i)
      }
    })

    it('allows benign technical sentences containing common words', () => {
      const benignInputs = [
        'We implemented token-based rate limiting',
        'The security team kept the incident report secret until remediation was complete',
        'The key finding was that latency decreased by 40%',
      ]

      for (const benign of benignInputs) {
        expect(looksLikeHighRiskCredential(benign), `False positive on: ${benign}`).toBe(false)
        const memory = new MemoryManager()
        expect(() => {
          memory.remember(benign, { type: 'FACT' })
        }).not.toThrow()
      }
    })
  })
})

