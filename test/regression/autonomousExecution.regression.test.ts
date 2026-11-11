/**
 * Regression coverage for the autonomous execution failure classes that
 * previously produced false COMPLETED states:
 *  - path punctuation leaking into a project directory;
 *  - an unregistered capability reported as a mock success;
 *  - blind file overwrites / path escape;
 *  - arbitrary shell test commands;
 *  - reports claiming completion without real evidence;
 *  - development requests being planned as application_status.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DevEngine } from '../../server/src/dev/DevEngine.js'
import { TaskService } from '../../server/src/taskService.js'
import { EventBus } from '../../server/src/events.js'
import { nullLogger } from '../../server/src/log.js'
import {
  buildDevelopmentPlan,
  extractProjectPath,
  normalizeProjectPath,
} from '../../src/engine/dev/DevelopmentPlanner'

describe('Autonomous execution regression guards', () => {
  const scratchDir = join(process.cwd(), '.freebuff', 'test-regression-scratch')

  beforeEach(() => {
    mkdirSync(scratchDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(scratchDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup failures on locked test artifacts.
    }
  })

  it('strips sentence punctuation so a natural-language path is usable', () => {
    expect(extractProjectPath('Inspect D:\\JARVIS-Test. Create a program.')).toBe('D:\\JARVIS-Test')
    expect(normalizeProjectPath('  "D:/JARVIS-Test."  ')).toBe('D:\\JARVIS-Test')
    // A bare drive root is not a project path.
    expect(normalizeProjectPath('D:\\')).toBeUndefined()
  })

  it('never plans application_status for a development objective', () => {
    const plan = buildDevelopmentPlan(
      'Inspect D:\\JARVIS-Test. Create a Python circle area program, test it, verify the results, and generate a report.',
      'D:\\JARVIS-Test',
      'JARVIS-Test',
    )
    const capabilities = plan.subtasks.map((s) => s.capability)
    expect(capabilities).not.toContain('application_status')
    expect(capabilities).toEqual([
      'dev.inspectProject',
      'dev.gitStatus',
      'dev.gitCheckpoint',
      'dev.patchFile',
      'dev.patchFile',
      'dev.runTests',
      'dev.inspectProject',
      'dev.generateReport',
    ])
    // Every dependency must point at an earlier step.
    const ids = plan.subtasks.map((_, index) => `step-${index + 1}`)
    plan.subtasks.forEach((subtask, index) => {
      for (const dependency of subtask.dependencies) {
        expect(ids.indexOf(dependency)).toBeGreaterThanOrEqual(0)
        expect(ids.indexOf(dependency)).toBeLessThan(index)
      }
    })
  })

  it('fails honestly when an inspected directory does not exist and does not create it', async () => {
    const missing = join(scratchDir, 'does-not-exist')
    const engine = new DevEngine()
    const res = await engine.execute('dev.inspectProject', { projectPath: missing })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('does not exist')
    expect(existsSync(missing)).toBe(false)
  })

  it('refuses to modify a file outside the project root', async () => {
    const engine = new DevEngine()
    const res = await engine.execute('dev.patchFile', {
      projectPath: scratchDir,
      filePath: '..\\outside.txt',
      target: '',
      replacement: 'owned',
      createIfMissing: true,
    })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('outside the project')
    expect(existsSync(join(scratchDir, '..', 'outside.txt'))).toBe(false)
  })

  it('refuses to overwrite an existing file without an exact target', async () => {
    const file = join(scratchDir, 'keep.txt')
    writeFileSync(file, 'user content', 'utf-8')
    const engine = new DevEngine()
    const res = await engine.execute('dev.patchFile', {
      projectPath: scratchDir,
      filePath: 'keep.txt',
      target: '',
      replacement: 'destroyed',
      createIfMissing: true,
    })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('Blind overwrites are forbidden')
  })

  it('rejects test commands containing shell metacharacters', async () => {
    const engine = new DevEngine()
    const res = await engine.execute('dev.runTests', {
      projectPath: scratchDir,
      testCommand: 'npm test && echo pwned',
    })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('shell metacharacters')
  })

  it('does not claim a verified report without files and test evidence', async () => {
    const engine = new DevEngine()
    const res = await engine.execute('dev.generateReport', {
      projectPath: scratchDir,
      requiredFiles: ['circle.py'],
    })
    expect(res.ok).toBe(false)
    const data = res.data as Record<string, unknown>
    expect(data.verified).toBe(false)
    expect(data.testVerified).toBe(false)
    expect(data.requiredFilesVerified).toBe(false)
  })

  it('fails an unregistered capability instead of fabricating success', async () => {
    const service = new TaskService({
      dataDir: join(scratchDir, 'tasks'),
      bus: new EventBus(),
      log: nullLogger(),
      useMemoryStorage: true,
    })
    await service.init()

    const task = await service.createTask({
      title: 'Unregistered capability regression',
      objective: 'Must not complete through a mock fallback',
      subtasks: [
        {
          title: 'Run a tool that does not exist',
          description: 'No executor is registered for this capability',
          capability: 'system.doesNotExist',
          dependencies: [],
        },
      ],
    })

    const startTime = Date.now()
    while (Date.now() - startTime < 8_000) {
      const current = await service.getTask(task.id)
      if (current && (current.state === 'RECOVERY_REQUIRED' || current.state === 'FAILED' || current.state === 'COMPLETED')) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const finalTask = await service.getTask(task.id)
    expect(finalTask).not.toBeNull()
    expect(finalTask!.state).not.toBe('COMPLETED')
    expect(finalTask!.state).toBe('RECOVERY_REQUIRED')
    expect(finalTask!.subtasks[0].verification?.passed).not.toBe(true)
    expect(finalTask!.subtasks[0].result?.error).toContain('not registered')
    expect(finalTask!.subtasks[0].result?.success).toBe(false)

    await service.stop()
  }, 15_000)
})
