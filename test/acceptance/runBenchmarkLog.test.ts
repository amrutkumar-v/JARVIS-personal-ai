import { describe, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { UniversalIntentRouter } from '../../src/engine/orchestrator/UniversalIntentRouter'

describe('Intelligence Benchmark 30 Prompts Raw Log', () => {
  it('logs classifications', () => {
    const router = new UniversalIntentRouter()
    const prompts = [
      'Explain the difference between optimistic and pessimistic locking in distributed databases with transaction isolation examples',
      'Solve for x: 3x^2 - 14x - 5 = 0 and verify both roots',
      'Compare message-passing channels with shared-memory mutex concurrency in Go versus Rust',
      'Explain zero-knowledge proofs like I am 12 years old using the cave analogy',
      'What are the trade-offs between B-Trees and LSM-Trees in write-heavy storage engines?',
      'Calculate the compound interest on $15,000 at 6.5% annual interest compounded monthly for 5 years',
      'How does the Raft consensus algorithm handle leader election failure during network partitions?',
      'Explain tail-call optimization in recursive functions and why Python does not support it',
      'Convert 450 kilometers per hour to meters per second and feet per second',
      'Describe the mechanics of copy-on-write (COW) memory paging in Linux fork() system calls',
      'Continue the previous task.',
      'Make the report shorter and focus only on the security vulnerabilities.',
      'Find the problem in that project.',
      'Compare it with the first option.',
      'Use the other document.',
      'Resume the paused audit.',
      'Cancel the current running task.',
      'Show me what happened in the last step.',
      'What was the execution status of task-40?',
      'Delete that file right now.',
      'Research the current state of local AI agents, compare three approaches, and prepare a concise technical report.',
      'Analyze this quarterly revenue workbook, compute descriptive statistics, detect outliers, and generate a Chart.js visualization.',
      'Inspect D:\\JARVIS-Test\\JARVIS-3.3, build a Python expense tracker with persistence and unit tests, execute the test suite, and generate a completion report.',
      'Launch Notepad, write a brief technical summary of our architecture, save it to D:\\JARVIS-Test\\JARVIS-3.3\\summary.txt, and verify the file exists on disk.',
      'Open the browser, navigate to https://example.com, extract the main heading and documentation links, and take a screenshot.',
      'Remember that my preferred testing framework is pytest and my default editor is Neovim.',
      'What are my stored preferences regarding development tools and testing frameworks?',
      'Find sources discussing room-temperature superconductors where published claims disagree, explain the discrepancy, and identify which claims have experimental backing.',
      'Read these benchmark result files in D:\\JARVIS-Test\\JARVIS-3.3, compare their execution times, and identify performance regressions.',
      'Listen to my microphone input and transcribe my spoken commands.',
    ]

    const records = prompts.map((p, idx) => {
      const res = router.classify(p)
      const u = res.outcomeUnderstanding
      return {
        promptNum: idx + 1,
        prompt: p,
        strategy: res.strategy,
        intent: res.intent,
        mode: u?.executionMode ?? 'none',
        confidence: u?.confidence ?? 0,
        durable: u?.requiresDurableTask ?? false,
        clarification: res.clarificationQuestion ?? null,
        limitation: u?.limitationExplanation ?? null,
        suggestedCapabilities: res.suggestedCapabilities ?? [],
      }
    })

    writeFileSync('D:\\JARVIS-Test\\JARVIS-3.3\\benchmark_30_raw.json', JSON.stringify(records, null, 2), 'utf-8')
  })
})
