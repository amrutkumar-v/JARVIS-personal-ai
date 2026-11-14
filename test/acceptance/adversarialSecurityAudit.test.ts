import { describe, expect, it, beforeEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import { DevEngine } from '../../server/src/dev/DevEngine'
import { PersistentTaskOrchestrator } from '../../server/src/tasks/PersistentTaskOrchestrator'
import { MemoryTaskStorage, TaskStore } from '../../server/src/tasks/TaskStore'
import { FakeBrowserBackend } from '../../native/src/browserInput'
import { MemoryManager } from '../../src/memory/MemoryManager'
import { createAiProviderRouter } from '../../server/src/aiProvider'

const SANDBOX_DIR = path.resolve('D:/JARVIS-Test/JARVIS-3.3/security_sandbox')

describe('Gate G11: Security, SSRF & Permission Adversarial Validation', () => {
  beforeEach(() => {
    fs.mkdirSync(SANDBOX_DIR, { recursive: true })
  })

  describe('Path Traversal & Project Jail Escapes', () => {
    it('strictly rejects path traversal escaping project boundary in patchFile', async () => {
      const engine = new DevEngine()
      const traversalAttacks = [
        '../outside.txt',
        '../../escape.txt',
        '../../../Windows/System32/drivers/etc/hosts',
        '..\\..\\Windows\\win.ini',
        'C:/Windows/System32/notepad.exe',
      ]

      for (const attackPath of traversalAttacks) {
        const res = await engine.execute('dev.patchFile', {
          projectPath: SANDBOX_DIR,
          filePath: attackPath,
          target: 'old',
          replacement: 'new',
        })
        expect(res.ok).toBe(false)
        expect(res.error).toBe('invalid_file_path')
        expect(res.message).toMatch(/Refusing to modify a path outside the project/i)
      }
    })

    it('refuses to inspect or write reports outside the designated project root', async () => {
      const engine = new DevEngine()
      const res = await engine.execute('dev.generateReport', {
        projectPath: SANDBOX_DIR,
        reportFile: '../../unauthorized_report.md',
        changes: [],
        verifiedFiles: [],
      })
      expect(res.ok).toBe(false)
      expect(res.error).toBe('invalid_report_path')
      expect(fs.existsSync(path.resolve(SANDBOX_DIR, '../../unauthorized_report.md'))).toBe(false)
    })
  })

  describe('Single-Use Approval Token Replay Protection', () => {
    it('strictly prevents replay attacks on approval tokens', async () => {
      const store = new TaskStore(new MemoryTaskStorage())
      const orchestrator = new PersistentTaskOrchestrator({ store })

      const task = await orchestrator.createTask({
        title: 'Sensitive Deployment Task',
        objective: 'Deploy to production environment',
        subtasks: [
          {
            title: 'Delete legacy staging container',
            capability: 'container.destroy',
            dependencies: [],
            requiresPermission: {
              action: 'container.destroy',
              description: 'Destroy staging container',
              impact: 'Irreversible container removal',
              toolId: 'container.destroy',
            },
          },
        ],
      })

      // Add a required approval with unique ID
      const approvalId = 'approval-tok-secure-999'
      task.requiredApprovals = [
        {
          id: approvalId,
          action: 'container.destroy',
          description: 'Destroy staging container',
          impact: 'Irreversible container removal',
          createdAt: Date.now(),
        },
      ]
      task.state = 'WAITING_FOR_PERMISSION'
      await store.saveTask(task)

      // 1. Initial valid approval
      const firstApproval = await orchestrator.approveAction(task.id, approvalId)
      expect(firstApproval).toBe(true)

      const approvedTask = await store.getTask(task.id)
      expect(approvedTask?.requiredApprovals[0].granted).toBe(true)

      // 2. Replay attack: attempt to reuse the exact same approvalId
      const replayAttempt = await orchestrator.approveAction(task.id, approvalId)
      expect(replayAttempt).toBe(false) // Strictly denied

      // 3. Replay attack: attempt to reject an already approved token
      const rejectReplayAttempt = await orchestrator.rejectAction(task.id, approvalId)
      expect(rejectReplayAttempt).toBe(false) // Strictly denied
    })
  })

  describe('Browser SSRF & Cloud Metadata Defense', () => {
    it('blocks all internal networks, cloud metadata, and local file URIs', async () => {
      const browser = new FakeBrowserBackend()
      const hostileTargets = [
        'http://169.254.169.254/latest/meta-data/',
        'http://169.254.169.254/computeMetadata/v1/',
        'http://127.0.0.1:8080/admin',
        'http://localhost:3000',
        'http://0.0.0.0:80',
        'http://10.0.0.1/internal-api',
        'http://172.16.0.1/dashboard',
        'http://192.168.1.1/setup',
        'file:///C:/Windows/win.ini',
        'ftp://anonymous@ftp.example.com',
        'https://user:password@external.com',
      ]

      for (const target of hostileTargets) {
        await expect(browser.navigate(target), `Failed to block: ${target}`).rejects.toThrow()
      }
    })

    it('allows benign public internet HTTPS domains', async () => {
      const browser = new FakeBrowserBackend()
      const benignTargets = [
        'https://example.com',
        'https://github.com',
        'https://developer.mozilla.org',
        'https://en.wikipedia.org/wiki/Main_Page',
      ]

      for (const target of benignTargets) {
        const res = await browser.navigate(target)
        expect(res.success).toBe(true)
        expect(res.verified).toBe(true)
      }
    })
  })

  describe('Credential Protection & Zero Leakage in Health / Memory', () => {
    it('rejects credential storage across multiple API key formats', () => {
      const memory = new MemoryManager()
      const credentials = [
        'OpenAI: sk-proj-1234567890abcdef1234567890abcdef',
        'GitHub: ghp_1234567890abcdef1234567890abcdef',
        'AWS Secret: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.do_not_leak',
      ]

      for (const cred of credentials) {
        expect(() => {
          memory.remember(`Store this secret: ${cred}`, { type: 'FACT' })
        }).toThrow(/credential/i)
      }
    })

    it('proves AiProvider health reports never expose secret keys', async () => {
      const secretKey = 'super-secret-production-ai-key-do-not-leak'
      const router = createAiProviderRouter({
        env: {
          JARVIS_AI_PRIMARY_PROVIDER: 'openai',
          OPENAI_API_KEY: secretKey,
        },
        probeHealth: false,
      })

      const health = await router.getHealth()
      const serializedHealth = JSON.stringify(health)

      // Strict verification: the secret key must NEVER appear anywhere in the health JSON
      expect(serializedHealth).not.toContain(secretKey)
      expect(serializedHealth).not.toMatch(/api_key|keyEnv|key:/i)
    })
  })
})
