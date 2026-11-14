/**
 * JARVIS 3.3 — Phase 1: Real Intelligence Benchmark (30 Instructions)
 *
 * Tests 30 previously unused natural-language instructions across 3 domains:
 * - Direct Intelligence (Tasks 1 to 10)
 * - Contextual Understanding (Tasks 11 to 20)
 * - Compound Multi-Capability Requests (Tasks 21 to 30)
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { AssistantEngine } from '../../src/engine/AssistantEngine'
import { UniversalIntentRouter } from '../../src/engine/orchestrator/UniversalIntentRouter'
import { MemoryTaskStorage } from '../../src/engine/tasks/TaskStore'
import { MemoryProjectContextStorage } from '../../src/memory/projectContext'

function stubBrowserStorage(): void {
  const backing = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  ;(globalThis as Record<string, unknown>).window = {
    localStorage,
    setTimeout: (_fn: () => void) => 0,
    location: { hostname: '127.0.0.1', protocol: 'http:', port: '3000' },
  }
}

describe('JARVIS 3.3 — Phase 1: Real Intelligence Benchmark (30 Instructions)', () => {
  let router: UniversalIntentRouter
  let engine: AssistantEngine

  beforeAll(() => {
    stubBrowserStorage()
    const taskStorage = new MemoryTaskStorage()
    const projectStorage = new MemoryProjectContextStorage()
    engine = new AssistantEngine({
      taskStorage,
      projectContextStorage: projectStorage,
    })
    router = engine.universalIntentRouter
  })

  // ==========================================================================
  // Category 1: Direct Intelligence (Prompts 1 to 10)
  // ==========================================================================
  describe('Category 1: Direct Intelligence (10 Prompts)', () => {
    it('Prompt 1: Explaining distributed database locking (optimistic vs pessimistic)', () => {
      const prompt = 'Explain the difference between optimistic and pessimistic locking in distributed databases with transaction isolation examples'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('DIRECT_ANSWER')
      expect(route.outcomeUnderstanding?.userObjective).toContain('locking')
      expect(route.outcomeUnderstanding?.executionMode).toBe('LOCAL_REASONING')
    })

    it('Prompt 2: Solving quadratic algebraic equation with roots', () => {
      const prompt = 'Solve for x: 3x^2 - 14x - 5 = 0 and verify both roots'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('DIRECT_ANSWER')
      expect(route.outcomeUnderstanding?.executionMode).toBe('LOCAL_REASONING')
    })

    it('Prompt 3: Comparing concurrency paradigms in Go vs Rust', () => {
      const prompt = 'Compare message-passing channels with shared-memory mutex concurrency in Go versus Rust'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('DIRECT_ANSWER')
      expect(route.outcomeUnderstanding?.userObjective).toContain('concurrency')
    })

    it('Prompt 4: Explaining zero-knowledge proofs via simple analogy', () => {
      const prompt = 'Explain zero-knowledge proofs like I am 12 years old using the cave analogy'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('DIRECT_ANSWER')
      expect(route.outcomeUnderstanding?.executionMode).toBe('DIRECT_ANSWER')
    })

    it('Prompt 5: Trade-off analysis between B-Trees and LSM-Trees', () => {
      const prompt = 'What are the trade-offs between B-Trees and LSM-Trees in write-heavy storage engines?'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('DIRECT_ANSWER')
    })

    it('Prompt 6: Multi-period compound interest calculation', () => {
      const prompt = 'Calculate the compound interest on $15,000 at 6.5% annual interest compounded monthly for 5 years'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('DIRECT_ANSWER')
      expect(route.outcomeUnderstanding?.executionMode).toBe('LOCAL_REASONING')
    })

    it('Prompt 7: Raft consensus partition fault-tolerance mechanics', () => {
      const prompt = 'How does the Raft consensus algorithm handle leader election failure during network partitions?'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('DIRECT_ANSWER')
    })

    it('Prompt 8: Tail-call optimization concepts and language design', () => {
      const prompt = 'Explain tail-call optimization in recursive functions and why Python does not support it'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('DIRECT_ANSWER')
    })

    it('Prompt 9: Physical velocity unit conversions', () => {
      const prompt = 'Convert 450 kilometers per hour to meters per second and feet per second'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('DIRECT_ANSWER')
      expect(route.outcomeUnderstanding?.executionMode).toBe('LOCAL_REASONING')
    })

    it('Prompt 10: Linux fork() copy-on-write memory paging mechanics', () => {
      const prompt = 'Describe the mechanics of copy-on-write (COW) memory paging in Linux fork() system calls'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('DIRECT_ANSWER')
    })
  })

  // ==========================================================================
  // Category 2: Contextual Understanding & Reference Resolution (Prompts 11 to 20)
  // ==========================================================================
  describe('Category 2: Contextual Understanding (10 Prompts)', () => {
    it('Prompt 11: "Continue the previous task."', () => {
      const prompt = 'Continue the previous task.'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('CONTINUITY')
      expect(route.intent).toBe('resume_work')
    })

    it('Prompt 12: "Make the report shorter and focus only on the security vulnerabilities."', () => {
      const prompt = 'Make the report shorter and focus only on the security vulnerabilities.'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('DIRECT_ANSWER')
      expect(route.outcomeUnderstanding?.userObjective).toBeDefined()
    })

    it('Prompt 13: "Find the problem in that project." (Missing project context guardrail)', () => {
      const prompt = 'Find the problem in that project.'
      const route = router.classify(prompt)
      expect(['CLARIFICATION_REQUIRED', 'AUTONOMOUS_DEV']).toContain(route.strategy)
    })

    it('Prompt 14: "Compare it with the first option." (Pronoun reference without prior options)', () => {
      const prompt = 'Compare it with the first option.'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('CLARIFICATION_REQUIRED')
      expect(route.clarificationQuestion).toBeDefined()
    })

    it('Prompt 15: "Use the other document." (Ambiguous document reference)', () => {
      const prompt = 'Use the other document.'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('CLARIFICATION_REQUIRED')
    })

    it('Prompt 16: "Resume the paused audit."', () => {
      const prompt = 'Resume the paused audit.'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('TASK_CONTROL')
      expect(route.entities.action).toBe('resume')
    })

    it('Prompt 17: "Cancel the current running task."', () => {
      const prompt = 'Cancel the current running task.'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('TASK_CONTROL')
      expect(route.entities.action).toBe('cancel')
    })

    it('Prompt 18: "Show me what happened in the last step."', () => {
      const prompt = 'Show me what happened in the last step.'
      const route = router.classify(prompt)
      expect(['TASK_CONTROL', 'CONTINUITY', 'DIRECT_ANSWER']).toContain(route.strategy)
    })

    it('Prompt 19: "What was the execution status of task-40?"', () => {
      const prompt = 'What was the execution status of task-40?'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('TASK_CONTROL')
      expect(route.entities.action).toBe('status')
    })

    it('Prompt 20: "Delete that file right now." (Deictic default-deny safety)', () => {
      const prompt = 'Delete that file right now.'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('CLARIFICATION_REQUIRED')
      expect(route.clarificationQuestion).toContain('target')
    })
  })

  // ==========================================================================
  // Category 3: Compound Multi-Capability Requests (Prompts 21 to 30)
  // ==========================================================================
  describe('Category 3: Compound Multi-Capability Requests (10 Prompts)', () => {
    it('Prompt 21: Live research on local AI agents with 3-approach comparison and report', () => {
      const prompt = 'Research the current state of local AI agents, compare three approaches, and prepare a concise technical report.'
      const route = router.classify(prompt)
      expect(['DEEP_RESEARCH', 'WEB_RESEARCH', 'MULTIPLE_COMBINED']).toContain(route.strategy)
      expect(route.outcomeUnderstanding?.executionMode).toBe('MULTIPLE_COMBINED')
      expect(route.outcomeUnderstanding?.requiresDurableTask).toBe(true)
    })

    it('Prompt 22: Workbook statistical analysis, anomaly detection, and chart generation', () => {
      const prompt = 'Analyze this quarterly revenue workbook, compute descriptive statistics, detect outliers, and generate a Chart.js visualization.'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('DATA_ANALYSIS')
      expect(route.outcomeUnderstanding?.requiresDurableTask).toBe(true)
    })

    it('Prompt 23: Autonomous software engineering DAG for expense tracker with unittests', () => {
      const prompt = 'Inspect D:\\JARVIS-Test\\JARVIS-3.3, build a Python expense tracker with persistence and unit tests, execute the test suite, and generate a completion report.'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('AUTONOMOUS_DEV')
      expect(route.suggestedCapabilities).toContain('dev.inspectProject')
      expect(route.suggestedCapabilities).toContain('dev.runTests')
      expect(route.suggestedCapabilities).toContain('dev.generateReport')
    })

    it('Prompt 24: Notepad text creation, file persistence, and verification', () => {
      const prompt = 'Launch Notepad, write a brief technical summary of our architecture, save it to D:\\JARVIS-Test\\JARVIS-3.3\\summary.txt, and verify the file exists on disk.'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('DESKTOP_ACTION')
      expect(route.outcomeUnderstanding?.executionMode).toBe('DESKTOP_INTERACTION')
    })

    it('Prompt 25: Browser navigation, heading and link extraction, and screenshot', () => {
      const prompt = 'Open the browser, navigate to https://example.com, extract the main heading and documentation links, and take a screenshot.'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('BROWSER_WORKFLOW')
      expect(route.outcomeUnderstanding?.executionMode).toBe('BROWSER_INTERACTION')
    })

    it('Prompt 26: Personal memory ingestion with key development preferences', () => {
      const prompt = 'Remember that my preferred testing framework is pytest and my default editor is Neovim.'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('MEMORY_OPERATION')
      expect(route.intent).toBe('memory_remember')
    })

    it('Prompt 27: Personal memory recall of stored development preferences', () => {
      const prompt = 'What are my stored preferences regarding development tools and testing frameworks?'
      const route = router.classify(prompt)
      expect(route.strategy).toBe('MEMORY_OPERATION')
      expect(route.intent).toBe('memory_recall')
    })

    it('Prompt 28: Scientific research discrepancy analysis with conflicting claims', () => {
      const prompt = 'Find sources discussing room-temperature superconductors where published claims disagree, explain the discrepancy, and identify which claims have experimental backing.'
      const route = router.classify(prompt)
      expect(['DEEP_RESEARCH', 'WEB_RESEARCH', 'MULTIPLE_COMBINED']).toContain(route.strategy)
    })

    it('Prompt 29: Benchmark execution log comparison across multiple files', () => {
      const prompt = 'Read these benchmark result files in D:\\JARVIS-Test\\JARVIS-3.3, compare their execution times, and identify performance regressions.'
      const route = router.classify(prompt)
      expect(['DOCUMENT_INTELLIGENCE', 'DATA_ANALYSIS']).toContain(route.strategy)
    })

    it('Prompt 30: Audio voice transcription with honest hardware limitation reporting', () => {
      const prompt = 'Listen to my microphone input and transcribe my spoken commands.'
      const route = router.classify(prompt)
      expect(route.outcomeUnderstanding?.limitationExplanation).toContain('Live microphone audio hardware input is currently blocked')
    })
  })
})
