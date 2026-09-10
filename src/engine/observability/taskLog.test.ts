import { describe, expect, it } from 'vitest'
import { InMemoryTaskLog, createTaskId } from './taskLog'

describe('observability/taskLog', () => {
  it('records entries in order and returns the same bound', () => {
    const log = new InMemoryTaskLog()
    log.record({
      taskId: 'task-1',
      startedAt: 'a',
      finishedAt: 'b',
      goal: 'open notes',
      autonomy: 'assisted',
      resolutions: [{ capability: 'open_notes', toolId: 'notes' }],
      steps: [{ capability: 'open_notes', toolId: 'notes', status: 'success' }],
      failures: [],
      verdict: 'completed',
    })
    log.record({
      taskId: 'task-2',
      startedAt: 'c',
      finishedAt: 'd',
      goal: 'delete a file',
      autonomy: 'safe_automation',
      resolutions: [],
      steps: [{ capability: 'delete_file', toolId: 'file.delete', status: 'skipped' }],
      failures: [{ toolId: 'file.delete', errorKind: 'permission_denied', summary: 'refused' }],
      verdict: 'blocked',
      reason: 'Confirmation required.',
    })
    const entries = log.entries()
    expect(entries).toHaveLength(2)
    expect(entries[0].taskId).toBe('task-1')
    expect(entries[0].verdict).toBe('completed')
    expect(entries[1].failures[0].errorKind).toBe('permission_denied')
    expect(entries[1].reason).toBe('Confirmation required.')
  })

  it('is bounded to the most recent entries', () => {
    const log = new InMemoryTaskLog(2)
    for (let i = 0; i < 5; i += 1) {
      log.record({
        taskId: `task-${i}`,
        startedAt: '',
        finishedAt: '',
        goal: 'g',
        autonomy: 'assisted',
        resolutions: [],
        steps: [],
        failures: [],
        verdict: 'completed',
      })
    }
    const ids = log.entries().map((e) => e.taskId)
    expect(ids).toEqual(['task-3', 'task-4'])
  })

  it('generates distinct task ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createTaskId()))
    expect(ids.size).toBe(50)
  })
})