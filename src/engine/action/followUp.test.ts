import { describe, expect, it } from 'vitest'
import {
  resolveFollowUp,
  isPureConfirm,
} from './followUp'
import {
  ExecutionContextStore,
  extractFileArtifacts,
  classifyExecutionOutcome,
  MAX_ARTIFACTS_PER_CONTEXT,
} from './executionContext'
import type { ExecutionContext } from './types'

function ctxWithFiles(files: string[], opts?: { requestedAt?: number }): ExecutionContext {
  return {
    runId: 'run-1',
    requestId: 'req-1',
    executionId: 'exec-1',
    requestedAt: opts?.requestedAt ?? Date.now(),
    requestText: 'list the folder',
    actionKind: 'executable',
    matchedTools: ['file.list'],
    matchedCapabilities: [],
    artifacts: files.map((path, i) => ({
      id: `art-${i}`,
      kind: 'file',
      label: path.split(/[\\/]/).pop() ?? path,
      path,
      summary: 'Listed',
    })),
    executedSteps: 1,
    verifiedSteps: 1,
    refutedSteps: 0,
    unverifiedSteps: 0,
    errors: [],
    outcome: 'completed',
    terminalStatus: 'completed',
  }
}

const now = Date.now()

describe('Phase 2.6 — follow-up resolution', () => {
  it('plays a pure confirmative back as a replay of the previous request', () => {
    const last = ctxWithFiles(['C:/docs/report.pdf'])
    expect(resolveFollowUp('do it', last, now)).toEqual({ kind: 'replay', requestText: 'list the folder' })
    expect(resolveFollowUp('yes', last, now)).toEqual({ kind: 'replay', requestText: 'list the folder' })
    expect(resolveFollowUp('go ahead', last, now)).toEqual({ kind: 'replay', requestText: 'list the folder' })
    expect(resolveFollowUp('ok do it now please', last, now)).toEqual({ kind: 'replay', requestText: 'list the folder' })
  })

  it('asks what the user means when a confirmative has no fresh context', () => {
    expect(resolveFollowUp('do it', undefined, now)).toEqual({ kind: 'ask_what' })
    const stale = ctxWithFiles(['C:/a.txt'], { requestedAt: now - 30 * 60_000 })
    expect(resolveFollowUp('do it', stale, now)).toEqual({ kind: 'ask_what' })
  })

  it('replays the RESOLVED text when the last run was followed up', () => {
    const last = { ...ctxWithFiles(['C:/a.txt']), resolvedText: 'open the PDF (target: "C:/a.txt")' }
    const r = resolveFollowUp('go ahead', last, now)
    expect(r.kind).toBe('replay')
    if (r.kind === 'replay') expect(r.requestText).toBe('open the PDF (target: "C:/a.txt")')
  })

  it('augments a deictic file reference with the only matching artifact', () => {
    const last = ctxWithFiles(['C:/docs/report.pdf', 'C:/notes/scratch.txt'])
    const r = resolveFollowUp('open the pdf', last, now)
    expect(r.kind).toBe('augment')
    if (r.kind === 'augment') {
      expect(r.text).toContain('C:/docs/report.pdf')
      expect(r.text).not.toContain('scratch.txt')
    }
  })

  it('asks which file when several candidates match', () => {
    const last = ctxWithFiles(['C:/a.pdf', 'C:/b.pdf'])
    const r = resolveFollowUp('now open the pdf', last, now)
    expect(r.kind).toBe('ask_which')
    if (r.kind === 'ask_which') expect(r.candidates).toEqual(['a.pdf', 'b.pdf'])
  })

  it('asks what the user means when no artifact can satisfy the reference', () => {
    const last = ctxWithFiles(['C:/a.txt'])
    expect(resolveFollowUp('open the pdf', last, now)).toEqual({ kind: 'ask_what' })
    expect(resolveFollowUp('open it', ctxWithFiles([]), now)).toEqual({ kind: 'ask_what' })
  })

  it('never uses a stale context for deictic references', () => {
    const stale = ctxWithFiles(['C:/a.pdf'], { requestedAt: now - 30 * 60_000 })
    expect(resolveFollowUp('open the pdf', stale, now)).toEqual({ kind: 'ask_what' })
  })

  it('treats a deictic request with NO prior context as a fresh request, not a follow-up', () => {
    expect(resolveFollowUp('open the pdf', undefined, now)).toEqual({ kind: 'none' })
    expect(resolveFollowUp('please send it', undefined, now)).toEqual({ kind: 'none' })
  })

  it('ignores non-follow-up requests', () => {
    const last = ctxWithFiles(['C:/a.pdf'])
    expect(resolveFollowUp('what is 3 * 7', last, now)).toEqual({ kind: 'none' })
    expect(resolveFollowUp('list my downloads', last, now)).toEqual({ kind: 'none' })
  })

  it('ignores deictic refs that carry an explicit location (fresh request)', () => {
    const last = ctxWithFiles(['C:/a.pdf'])
    expect(resolveFollowUp('show the files in Downloads', last, now)).toEqual({ kind: 'none' })
  })
})

describe('Phase 2.6 — isPureConfirm', () => {
  it('recognises confirmatives', () => {
    for (const t of ['yes', 'yeah', 'ok', 'okay', 'do it', 'do that', 'go ahead', 'proceed', 'yes do it', 'okay go ahead please', 'now do it']) {
      expect(isPureConfirm(t), t).toBe(true)
    }
  })

  it('rejects content-ful or ambiguous non-confirms', () => {
    for (const t of ['open the pdf', 'what is the time', 'delete that file', 'sure about that?', 'yes but only once']) {
      expect(isPureConfirm(t), t).toBe(false)
    }
  })
})

describe('Phase 2.6 — execution context store', () => {
  it('begins, commits and retrieves the last context per conversation', () => {
    const store = new ExecutionContextStore()
    const shell = store.begin({ conversationId: 'c1', requestText: 'list the folder' })
    expect(store.lastFor('c1')).toBeUndefined()
    store.commit({
      ...shell,
      outcome: 'completed',
      executedSteps: 1,
      terminalStatus: 'completed',
    })
    const last = store.lastFor('c1')
    expect(last).toBeDefined()
    expect(last?.requestText).toBe('list the folder')
    expect(last?.outcome).toBe('completed')
    expect(store.lastFor('other')).toBeUndefined()
  })

  it('keeps a bounded number of contexts per conversation', () => {
    const store = new ExecutionContextStore()
    for (let i = 0; i < 9; i += 1) {
      const shell = store.begin({ conversationId: 'c1', requestText: `req-${i}` })
      store.commit({ ...shell, outcome: 'completed', terminalStatus: 'completed' })
    }
    const last = store.lastFor('c1')
    expect(last?.requestText).toBe('req-8')
    let count = 0
    let seenFirst = 0
    const bucket = (store as unknown as { byConversation: Map<string, ExecutionContext[]> }).byConversation.get('c1')
    count = bucket?.length ?? 0
    seenFirst = bucket?.[0]?.requestText === 'req-3' ? 1 : 0
    expect(count).toBe(6)
    expect(seenFirst).toBe(1)
  })

  it('expires stale contexts and reports its size', () => {
    const store = new ExecutionContextStore({ ttlMs: 1000 })
    const shell = store.begin({ conversationId: 'c1', requestText: 'old' })
    store.commit({ ...shell, requestedAt: now - 5000, outcome: 'cancelled', terminalStatus: 'cancelled' })
    expect(store.size()).toBe(1)
    store.expire(now)
    expect(store.size()).toBe(0)
    expect(store.lastFor('c1')).toBeUndefined()
  })

  it('extracts bounded file artifacts from tool outputs', () => {
    const artifacts = extractFileArtifacts([
      {
        entries: ['C:/Users/me/a.txt', 'D:/work/b.pdf'],
        result: { path: 'E:/archive.zip' },
        nested: [{ name: 'F:/deep/file.md' }],
      },
      'C:/Users/me/a.txt', // duplicate — ignored
      null,
      { scalar: 42 },
    ])
    expect(artifacts.length).toBe(4)
    expect(artifacts.every((a) => a.kind === 'file')).toBe(true)
    expect(artifacts.map((a) => a.label).sort()).toEqual(
      ['a.txt', 'b.pdf', 'archive.zip', 'file.md'].sort(),
    )
  })

  it('caps extracted artifacts', () => {
    const huge = Array.from({ length: 100 }, (_, i) => ({ path: `C:/tmp/f${i}.txt` }))
    expect(extractFileArtifacts([huge]).length).toBeLessThanOrEqual(MAX_ARTIFACTS_PER_CONTEXT)
  })

  it('classifies outcomes without over-claiming', () => {
    expect(classifyExecutionOutcome({ finalState: 'cancelled', executedSteps: 2, failedSteps: 0, verifiedSteps: 2, refutedSteps: 0, unverifiedSteps: 0 })).toBe('cancelled')
    expect(classifyExecutionOutcome({ finalState: 'failed', executedSteps: 0, failedSteps: 0, verifiedSteps: 0, refutedSteps: 0, unverifiedSteps: 0 })).toBe('failed')
    expect(classifyExecutionOutcome({ finalState: 'completed', executedSteps: 0, failedSteps: 0, verifiedSteps: 0, refutedSteps: 0, unverifiedSteps: 0 })).toBe('completed')
    expect(classifyExecutionOutcome({ finalState: 'completed', executedSteps: 1, failedSteps: 0, verifiedSteps: 1, refutedSteps: 0, unverifiedSteps: 0 })).toBe('completed')
    expect(classifyExecutionOutcome({ finalState: 'completed', executedSteps: 1, failedSteps: 0, verifiedSteps: 0, refutedSteps: 1, unverifiedSteps: 0 })).toBe('unverified')
    expect(classifyExecutionOutcome({ finalState: 'completed', executedSteps: 2, failedSteps: 1, verifiedSteps: 1, refutedSteps: 0, unverifiedSteps: 0 })).toBe('partial')
    expect(classifyExecutionOutcome({ finalState: 'completed', executedSteps: 1, failedSteps: 1, verifiedSteps: 0, refutedSteps: 0, unverifiedSteps: 0 })).toBe('failed')
    expect(classifyExecutionOutcome({ finalState: 'completed', executedSteps: 2, failedSteps: 0, verifiedSteps: 1, refutedSteps: 0, unverifiedSteps: 1 })).toBe('partial')
  })
})

describe('Phase 1 — Extended follow-up actions', () => {
  it('resolves retry_last to replay the previous request', () => {
    const last = ctxWithFiles(['C:/docs/report.pdf'])
    const res1 = resolveFollowUp('retry', last, now)
    expect(res1).toEqual({ kind: 'retry_last', requestText: 'list the folder' })

    const res2 = resolveFollowUp('try again', last, now)
    expect(res2).toEqual({ kind: 'retry_last', requestText: 'list the folder' })

    const res3 = resolveFollowUp('run it again', last, now)
    expect(res3).toEqual({ kind: 'retry_last', requestText: 'list the folder' })
  })

  it('asks what the user means when retry has no fresh context', () => {
    expect(resolveFollowUp('retry', undefined, now)).toEqual({ kind: 'ask_what' })
    const stale = ctxWithFiles(['C:/a.txt'], { requestedAt: now - 30 * 60_000 })
    expect(resolveFollowUp('try again', stale, now)).toEqual({ kind: 'ask_what' })
  })

  it('resolves explain_last targeting the last execution context', () => {
    const last = ctxWithFiles(['C:/docs/report.pdf'])
    const res1 = resolveFollowUp('why did you do that?', last, now)
    expect(res1.kind).toBe('explain_last')
    if (res1.kind === 'explain_last') {
      expect(res1.targetContext.requestText).toBe('list the folder')
    }

    const res2 = resolveFollowUp('explain what you just did', last, now)
    expect(res2.kind).toBe('explain_last')
  })

  it('asks what the user means when explain has no fresh context', () => {
    expect(resolveFollowUp('why did you do that?', undefined, now)).toEqual({ kind: 'ask_what' })
  })

  it('resolves save_last with the primary artifact', () => {
    const last = ctxWithFiles(['C:/docs/report.pdf', 'C:/docs/data.csv'])
    const res = resolveFollowUp('save that', last, now)
    expect(res.kind).toBe('save_last')
    if (res.kind === 'save_last') {
      expect(res.artifact?.path).toBe('C:/docs/report.pdf')
    }
  })

  it('resolves candidate indexing for numeric and ordinal options', () => {
    const last = ctxWithFiles(['C:/docs/opt1.txt', 'C:/docs/opt2.txt', 'C:/docs/opt3.txt'])
    
    // "option 2"
    const res1 = resolveFollowUp('choose option 2', last, now)
    expect(res1).toEqual({ kind: 'candidate_select', index: 1, candidateText: 'C:/docs/opt2.txt' })

    // "What about the second option?"
    const res2 = resolveFollowUp('what about the second option?', last, now)
    expect(res2).toEqual({ kind: 'candidate_select', index: 1, candidateText: 'C:/docs/opt2.txt' })

    // "the first one"
    const res3 = resolveFollowUp('pick the first one', last, now)
    expect(res3).toEqual({ kind: 'candidate_select', index: 0, candidateText: 'C:/docs/opt1.txt' })

    // "do that for option 3"
    const res4 = resolveFollowUp('do that for option 3', last, now)
    expect(res4).toEqual({ kind: 'candidate_select', index: 2, candidateText: 'C:/docs/opt3.txt' })
  })

  it('asks what the user means when candidate selection has no context', () => {
    expect(resolveFollowUp('choose option 2', undefined, now)).toEqual({ kind: 'ask_what' })
  })
})