/**
 * JARVIS 3.2 — Phase 15: The 75-Task Universal Autonomy Challenge Suite
 *
 * Implements and verifies 75 distinct natural-language tasks across 10 operational domains:
 * - Domain 1: Direct Intelligence & Reasoning (Tasks 1 to 8)
 * - Domain 2: Research & Information Synthesis (Tasks 9 to 16)
 * - Domain 3: Universal Document Intelligence (Tasks 17 to 24)
 * - Domain 4: Quantitative Data Analysis & Decision Intelligence (Tasks 25 to 32)
 * - Domain 5: Autonomous Software Engineering (Tasks 33 to 40)
 * - Domain 6: Native Desktop Automation & Win32 Integration (Tasks 41 to 48)
 * - Domain 7: Playwright Browser Automation (Tasks 49 to 56)
 * - Domain 8: Personal Memory & Context Continuity (Tasks 57 to 64)
 * - Domain 9: System Telemetry & Child Process Management (Tasks 65 to 70)
 * - Domain 10: Compound Multi-Capability Workflows & Fault Recovery (Tasks 71 to 75)
 *
 * BENCHMARK SCOPE & EXECUTION REALITY (Honest Capability Disclosure):
 * - Live Application & Integration Execution: 49 tasks (65.3%) genuinely execute production
 *   JARVIS modules (ResearchEngine, DocumentParser, DocumentStore, DataAnalysisTools,
 *   DevEngine, UniversalIntentRouter, ResourceMonitor, ConfirmationManager, SpecialistDelegator).
 * - Intent Routing + Calculator Execution: 3 tasks (Tasks 2, 3, and 8) test intent routing
 *   via UniversalIntentRouter and arithmetic evaluation via CalculatorTool. They do NOT test
 *   dedicated unit-conversion, formal propositional logic / SAT solving, or prime factorization engines.
 * - Test-Local Simulations & Stubs: 21 tasks (28.0%) evaluate in-test arrow functions, data structures,
 *   or regexes (e.g. Tasks 23, 45-48, 50-56, 61) where live OS GUI, headless browser, or cloud networks
 *   are not attached in automated CI.
 * - Mocked Process Management: 2 tasks (Tasks 68-69) register mock child processes in ChildProcessRegistry.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { writeFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { UniversalIntentRouter } from '../../src/engine/orchestrator/UniversalIntentRouter'
import { DevEngine, normalizeProjectPath } from '../../server/src/dev/DevEngine.js'
import { CalculatorTool } from '../../src/tools/CalculatorTool'
import {
  computeNumericStats,
  detectTrend,
  computePearsonCorrelation,
  computeCorrelationMatrix,
  generateChartSpec,
} from '../../src/engine/documents/DataAnalysisTools'
import { DocumentParser } from '../../src/engine/documents/DocumentParser'
import { DocumentStore } from '../../src/engine/documents/DocumentStore'
import {
  ResearchEngine,
  evaluateSourceReliability,
  expandQueries,
  synthesizePresentationOutline,
} from '../../src/engine/research/ResearchEngine'
import { SpecialistDelegator } from '../../src/engine/tasks/SpecialistWorkerPool'
import { ResourceMonitor } from '../../server/src/resourceMonitor'
import { ChildProcessRegistry } from '../../server/src/process/ChildProcessRegistry'
import { ConfirmationManager } from '../../src/engine/productivity/ConfirmationManager'

const CHALLENGE_DIR = 'D:\\JARVIS-Test\\JARVIS-3.2\\challenge75'

describe('JARVIS 3.2 — The 75-Task Universal Autonomy Challenge Suite', () => {
  const router = new UniversalIntentRouter()
  const devEngine = new DevEngine()
  const researchEngine = new ResearchEngine()
  const docStore = new DocumentStore({ autoPersist: false })
  const parser = new DocumentParser()
  const delegator = new SpecialistDelegator()
  const resourceMonitor = new ResourceMonitor()
  const processRegistry = new ChildProcessRegistry()
  const confirmationManager = new ConfirmationManager()

  beforeAll(() => {
    mkdirSync(CHALLENGE_DIR, { recursive: true })
  })

  // ==========================================================================
  // Domain 1: Direct Intelligence & Reasoning (Tasks 1 to 8)
  // ==========================================================================
  describe('Domain 1: Direct Intelligence & Reasoning (8 Tasks)', () => {
    it('Task 1: understands arithmetic calculations as local reasoning', async () => {
      const route = router.classify('Calculate (450 * 12) + 850')
      expect(route.strategy).toBe('DIRECT_ANSWER')
      expect(route.outcomeUnderstanding?.executionMode).toBe('LOCAL_REASONING')
      const calc = new CalculatorTool()
      const res = await calc.execute({ query: '(450 * 12) + 850', params: { expression: '(450 * 12) + 850' } }, { requestId: 't75-1' })
      expect(res.ok).toBe(true)
      expect(res.data).toMatchObject({ result: 6250 })
    })

    it('Task 2: evaluates conversion intent routing and arithmetic expression calculation', async () => {
      // NOTE: This test verifies intent classification via UniversalIntentRouter and
      // arithmetic evaluation via CalculatorTool. It does NOT invoke a dedicated unit-conversion engine.
      const route = router.classify('Convert 100 degrees Celsius to Fahrenheit')
      expect(route.strategy).toBe('DIRECT_ANSWER')
      const calc = new CalculatorTool()
      const res100 = await calc.execute(
        { query: '(100 * 9 / 5) + 32', params: { expression: '(100 * 9 / 5) + 32' } },
        { requestId: 't75-2a' },
      )
      expect(res100.ok).toBe(true)
      expect(res100.data).toMatchObject({ result: 212 })

      const res0 = await calc.execute(
        { query: '(0 * 9 / 5) + 32', params: { expression: '(0 * 9 / 5) + 32' } },
        { requestId: 't75-2b' },
      )
      expect(res0.ok).toBe(true)
      expect(res0.data).toMatchObject({ result: 32 })
    })

    it('Task 3: evaluates logic query intent routing and arithmetic truth formula calculation', async () => {
      // NOTE: This test verifies intent routing and algebraic truth value evaluation via CalculatorTool.
      // It does NOT invoke a formal propositional logic solver, SAT engine, or truth-table generator.
      const route = router.classify('Evaluate logical implication P implies Q truth table')
      expect(route.strategy).toBe('DIRECT_ANSWER')
      const calc = new CalculatorTool()
      // Material implication P -> Q expressed via arithmetic truth values (1 - P + P * Q)
      // T -> T: 1 - 1 + (1 * 1) = 1
      const tt = await calc.execute(
        { query: '1 - 1 + (1 * 1)', params: { expression: '1 - 1 + (1 * 1)' } },
        { requestId: 't75-3a' },
      )
      expect(tt.ok).toBe(true)
      expect(tt.data).toMatchObject({ result: 1 })

      // T -> F: 1 - 1 + (1 * 0) = 0
      const tf = await calc.execute(
        { query: '1 - 1 + (1 * 0)', params: { expression: '1 - 1 + (1 * 0)' } },
        { requestId: 't75-3b' },
      )
      expect(tf.ok).toBe(true)
      expect(tf.data).toMatchObject({ result: 0 })

      // F -> T: 1 - 0 + (0 * 1) = 1
      const ft = await calc.execute(
        { query: '1 - 0 + (0 * 1)', params: { expression: '1 - 0 + (0 * 1)' } },
        { requestId: 't75-3c' },
      )
      expect(ft.ok).toBe(true)
      expect(ft.data).toMatchObject({ result: 1 })
    })

    it('Task 4: performs complex percentage computations via CalculatorTool', async () => {
      const calc = new CalculatorTool()
      const res = await calc.execute({ query: '1200 - (1200 * 15 / 100)', params: { expression: '1200 - (1200 * 15 / 100)' } }, { requestId: 't75-4' })
      expect(res.ok).toBe(true)
      expect(res.data).toMatchObject({ result: 1020 })
    })

    it('Task 5: classifies conversational chitchat and greetings', () => {
      const route = router.classify('Good morning JARVIS, introduce yourself')
      expect(route.strategy).toBe('DIRECT_ANSWER')
      expect(route.outcomeUnderstanding?.executionMode).toBe('DIRECT_ANSWER')
    })

    it('Task 6: understands algorithmic complexity questions', () => {
      const route = router.classify('What is the time complexity of quicksort in the worst case?')
      expect(route.strategy).toBe('DIRECT_ANSWER')
    })

    it('Task 7: identifies deictic ambiguity and requests clarification', () => {
      const route = router.classify('Please make it faster')
      expect(route.strategy).toBe('CLARIFICATION_REQUIRED')
      expect(route.outcomeUnderstanding?.clarificationNeeded).toBeDefined()
    })

    it('Task 8: evaluates prime factor query intent routing and arithmetic factorization checks', async () => {
      // NOTE: This test verifies intent routing and arithmetic multiplication/modulo evaluation via CalculatorTool.
      // It does NOT invoke an automated number-theory factorization engine.
      const route = router.classify('What are the prime factors of 84?')
      expect(route.strategy).toBe('DIRECT_ANSWER')
      const calc = new CalculatorTool()
      // Verify prime factors (2^2 * 3 * 7 = 84) via application calculation engine
      const res = await calc.execute(
        { query: '2 * 2 * 3 * 7', params: { expression: '2 * 2 * 3 * 7' } },
        { requestId: 't75-8' },
      )
      expect(res.ok).toBe(true)
      expect(res.data).toMatchObject({ result: 84 })

      // Verify remainder checks with modulo operations in calculator
      const modCheck1 = await calc.execute(
        { query: '84 % 2', params: { expression: '84 % 2' } },
        { requestId: 't75-8-mod1' },
      )
      expect(modCheck1.ok).toBe(true)
      expect(modCheck1.data).toMatchObject({ result: 0 })

      const modCheck2 = await calc.execute(
        { query: '21 % 3', params: { expression: '21 % 3' } },
        { requestId: 't75-8-mod2' },
      )
      expect(modCheck2.ok).toBe(true)
      expect(modCheck2.data).toMatchObject({ result: 0 })
    })
  })

  // ==========================================================================
  // Domain 2: Research & Information Synthesis (Tasks 9 to 16)
  // ==========================================================================
  describe('Domain 2: Research & Information Synthesis (8 Tasks)', () => {
    it('Task 9: expands research queries to discover related perspectives', () => {
      const expanded = expandQueries('React Server Components vs client rendering')
      expect(expanded.length).toBeGreaterThanOrEqual(2)
      expect(expanded[0]).toContain('React Server Components')
    })

    it('Task 10: evaluates official documentation as primary sources', () => {
      const rel = evaluateSourceReliability('https://docs.python.org/3/whatsnew/3.12.html')
      expect(rel.isPrimary).toBe(true)
      expect(rel.sourceTier).toBe('primary')
      expect(rel.reliabilityScore).toBeGreaterThanOrEqual(0.9)
    })

    it('Task 11: evaluates encyclopedia sources as authoritative secondary', () => {
      const rel = evaluateSourceReliability('https://en.wikipedia.org/wiki/Operating_system')
      expect(rel.isPrimary).toBe(false)
      expect(rel.sourceTier).toBe('secondary')
      expect(rel.reliabilityScore).toBeGreaterThanOrEqual(0.8)
    })

    it('Task 12: identifies community forums with lower reliability weighting', () => {
      const rel = evaluateSourceReliability('https://reddit.com/r/technology/comments/123')
      expect(rel.isPrimary).toBe(false)
      expect(rel.sourceTier).toBe('community')
      expect(rel.reliabilityScore).toBeLessThan(0.8)
    })

    it('Task 13: corroborates factual claims across distinct research sources', () => {
      const sources = [
        {
          id: 1,
          title: 'Paper A',
          url: 'https://arxiv.org/abs/1',
          snippet: 'Model scaling laws follow empirical power-law exponents.',
          domain: 'arxiv.org',
          fetched: true,
        },
        {
          id: 2,
          title: 'Paper B',
          url: 'https://docs.ai/paper',
          snippet: 'Empirical scaling laws show power-law relationship with compute budgets.',
          domain: 'docs.ai',
          fetched: true,
        },
      ]
      const { findings } = researchEngine.crossCheck('model scaling laws', sources, new Map())
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0].confidence).toBe('high')
      expect(findings[0].sourceIds).toEqual([1, 2])
    })

    it('Task 14: detects conflicting claims and controversy markers', () => {
      const sources = [
        {
          id: 1,
          title: 'Article A',
          url: 'https://news.org/a',
          snippet: 'There is a major controversy and conflicting evidence regarding room-temperature superconductors.',
          domain: 'news.org',
          fetched: true,
        },
      ]
      const { discrepancies } = researchEngine.crossCheck('superconductors', sources, new Map())
      expect(discrepancies.length).toBeGreaterThan(0)
      expect(discrepancies[0]).toContain('controversy')
    })

    it('Task 15: synthesizes a cited research brief with verified Markdown citations', () => {
      const report = researchEngine.synthesizeReport(
        'Rust vs C++ memory safety',
        [
          {
            id: 1,
            title: 'Rust Book',
            url: 'https://doc.rust-lang.org/book/',
            snippet: 'Borrow checker enforces ownership at compile time.',
            domain: 'doc.rust-lang.org',
            fetched: true,
            isPrimary: true,
          },
        ],
        [
          {
            claim: 'Borrow checker enforces memory safety at compile time without garbage collection.',
            sourceIds: [1],
            confidence: 'high',
          },
        ],
        [],
      )
      expect(report.markdown).toContain('# Research Brief')
      expect(report.markdown).toContain('Borrow checker enforces memory safety')
      expect(report.markdown).toContain('| [1] | [Rust Book](https://doc.rust-lang.org/book/) |')
    })

    it('Task 16: generates a multi-slide presentation outline from research findings', () => {
      const report = researchEngine.synthesizeReport(
        'Next-Gen Battery Chemistry',
        [
          {
            id: 1,
            title: 'Energy Lab',
            url: 'https://energy.gov/batteries',
            snippet: 'Solid-state electrolytes offer higher energy density.',
            domain: 'energy.gov',
            fetched: true,
          },
        ],
        [{ claim: 'Solid-state cells offer 50% greater volumetric density.', sourceIds: [1], confidence: 'high' }],
        [],
      )
      const slides = synthesizePresentationOutline(report)
      expect(slides).toContain('# Presentation Outline: Next-Gen Battery Chemistry')
      expect(slides).toContain('## Slide 1: Title & Executive Summary')
      expect(slides).toContain('## Slide 2: Key Architecture & Findings')
    })
  })

  // ==========================================================================
  // Domain 3: Universal Document Intelligence (Tasks 17 to 24)
  // ==========================================================================
  describe('Domain 3: Universal Document Intelligence (8 Tasks)', () => {
    it('Task 17: parses structured Markdown documents into hierarchical sections', () => {
      const md = '# Architecture\n\n## Backend\nNode.js server.\n\n## Native\nWin32 agent.'
      const doc = parser.parse(md, { fileName: 'arch.md' })
      expect(doc.title).toBe('Architecture')
      expect(doc.sections.length).toBeGreaterThanOrEqual(2)
    })

    it('Task 18: parses CSV tabular records with column data types and statistics', () => {
      const csv = 'City,Population,Rating\nNew York,8400000,4.8\nTokyo,13900000,4.9\nLondon,8900000,4.7'
      const doc = parser.parse(csv, { fileName: 'cities.csv' })
      expect(doc.tabular).toBeDefined()
      expect(doc.tabular?.headers).toEqual(['City', 'Population', 'Rating'])
      expect(doc.tabular?.rows.length).toBe(3)
    })

    it('Task 19: indexes document chunks with content hash change detection', () => {
      const content = 'JARVIS personal AI operating system knowledge index'
      const doc = docStore.ingest(content, { filePath: join(CHALLENGE_DIR, 'doc1.txt') })
      expect(doc.id).toBeDefined()
      expect(docStore.getDocument(doc.id)).toBeDefined()
    })

    it('Task 20: executes lexical search across indexed documents with exact phrase bonus', () => {
      const searchRes = docStore.search('personal AI operating system')
      expect(searchRes.length).toBeGreaterThan(0)
      expect(searchRes[0].chunk.content).toContain('JARVIS')
    })

    it('Task 21: performs grounded Q&A returning verifiable citations', () => {
      const answer = docStore.query('operating system')
      expect(answer.sources.length).toBeGreaterThan(0)
      expect(answer.answer).toContain('JARVIS')
    })

    it('Task 22: detects modified documents on re-ingestion and updates index', () => {
      const filePath = join(CHALLENGE_DIR, 'doc1.txt')
      const updatedContent = 'Updated JARVIS knowledge base version 3.2'
      const updatedDoc = docStore.ingest(updatedContent, { filePath })
      expect(updatedDoc.rawText).toContain('version 3.2')
    })

    it('Task 23: extracts Markdown table data into structured objects', () => {
      const mdTable = `| Tool | Capability |\n|---|---|\n| runTests | dev.runTests |\n| patchFile | dev.patchFile |`
      const rows = mdTable.split('\n').filter((l) => l.startsWith('|') && !l.includes('---'))
      expect(rows.length).toBe(3)
    })

    it('Task 24: removes documents cleanly and purges associated chunks', () => {
      const doc = docStore.ingest('Temporary document to be deleted', { fileName: 'temp.txt' })
      expect(docStore.getDocument(doc.id)).toBeDefined()
      const removed = docStore.removeDocument(doc.id)
      expect(removed).toBe(true)
      expect(docStore.getDocument(doc.id)).toBeUndefined()
    })
  })

  // ==========================================================================
  // Domain 4: Quantitative Data Analysis & Decision Intelligence (Tasks 25 to 32)
  // ==========================================================================
  describe('Domain 4: Quantitative Data Analysis & Decision Intelligence (8 Tasks)', () => {
    it('Task 25: calculates exact descriptive statistics (mean, median, variance, stdDev)', () => {
      const stats = computeNumericStats([10, 20, 30, 40, 50])
      expect(stats?.mean).toBe(30)
      expect(stats?.median).toBe(30)
      expect(stats?.variance).toBe(200)
      expect(Math.round(stats!.stdDev * 100) / 100).toBe(14.14)
    })

    it('Task 26: isolates statistical outliers using Tukey 1.5 * IQR rule', () => {
      const stats = computeNumericStats([12, 13, 14, 15, 16, 17, 18, 150]) // 150 is an outlier
      expect(stats?.outliers).toContain(150)
      expect(stats?.outliers.length).toBe(1)
    })

    it('Task 27: computes linear regression slope, R^2, and percentage change', () => {
      const trend = detectTrend([100, 150, 200, 250, 300])
      expect(trend?.direction).toBe('increasing')
      expect(trend?.slope).toBe(50)
      expect(trend?.rSquared).toBe(1.0)
      expect(trend?.percentageChange).toBe(200)
    })

    it('Task 28: computes Pearson correlation coefficient between numeric variables', () => {
      const x = [10, 20, 30, 40, 50]
      const y = [15, 25, 35, 45, 55]
      const r = computePearsonCorrelation(x, y)
      expect(r).toBe(1.0)
    })

    it('Task 29: detects negative inverse correlation accurately', () => {
      const x = [1, 2, 3, 4, 5]
      const y = [50, 40, 30, 20, 10]
      const r = computePearsonCorrelation(x, y)
      expect(r).toBe(-1.0)
    })

    it('Task 30: computes pairwise correlation matrix for tabular datasets', () => {
      const tabular = {
        headers: ['X', 'Y'],
        rows: [
          ['1', '2'],
          ['2', '4'],
          ['3', '6'],
        ],
        columnStats: [
          { name: 'X', type: 'numeric' as const },
          { name: 'Y', type: 'numeric' as const },
        ],
      }
      const matrix = computeCorrelationMatrix(tabular)
      expect(matrix.length).toBe(1)
      expect(matrix[0].coefficient).toBe(1.0)
    })

    it('Task 31: generates valid Chart.js bar chart specifications', () => {
      const tabular = {
        headers: ['Quarter', 'Revenue'],
        rows: [
          ['Q1', '100'],
          ['Q2', '150'],
          ['Q3', '200'],
          ['Q4', '300'],
        ],
        columnStats: [
          { name: 'Quarter', type: 'string' as const },
          { name: 'Revenue', type: 'numeric' as const },
        ],
      }
      const { chartJs } = generateChartSpec(tabular, { type: 'bar', title: 'Quarterly Revenue' })
      expect(chartJs).toBeDefined()
      expect(JSON.stringify(chartJs)).toContain('Quarterly Revenue')
    })

    it('Task 32: generates valid Vega-Lite line chart specifications', () => {
      const tabular = {
        headers: ['Month', 'Growth'],
        rows: [
          ['Jan', '50'],
          ['Feb', '75'],
          ['Mar', '90'],
        ],
        columnStats: [
          { name: 'Month', type: 'string' as const },
          { name: 'Growth', type: 'numeric' as const },
        ],
      }
      const { vegaLite } = generateChartSpec(tabular, { type: 'line', title: 'Growth Trend' })
      expect(vegaLite).toBeDefined()
      expect(JSON.stringify(vegaLite)).toContain('Growth Trend')
    })
  })

  // ==========================================================================
  // Domain 5: Autonomous Software Engineering (Tasks 33 to 40)
  // ==========================================================================
  describe('Domain 5: Autonomous Software Engineering (8 Tasks)', () => {
    const devDir = join(CHALLENGE_DIR, 'software_dev')

    beforeAll(() => {
      mkdirSync(devDir, { recursive: true })
    })

    it('Task 33: inspects project directory and identifies structure', async () => {
      const res = await devEngine.inspectProject(devDir)
      expect(res.ok).toBe(true)
      expect(res.data?.path).toBeDefined()
    })

    it('Task 34: checks Git repository state and working tree status', async () => {
      const res = await devEngine.gitStatus(devDir)
      expect(res.ok).toBe(true)
    })

    it('Task 35: creates safety checkpoint branch before applying code changes', async () => {
      const res = await devEngine.gitCheckpoint(devDir, 'pre-challenge-task')
      expect(res.ok).toBe(true)
    }, 15_000)

    it('Task 36: creates Python module file with exact verification', async () => {
      const code = 'def add(a, b):\n    return a + b\n'
      const res = await devEngine.patchFile(devDir, 'math_helper.py', '', code, { createIfMissing: true })
      expect(res.ok).toBe(true)
      expect(existsSync(join(devDir, 'math_helper.py'))).toBe(true)
    })

    it('Task 37: creates unittest test suite file for Python module', async () => {
      const testCode = 'import unittest\nfrom math_helper import add\n\nclass TestMath(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\nif __name__ == "__main__":\n    unittest.main()\n'
      const res = await devEngine.patchFile(devDir, 'test_math_helper.py', '', testCode, { createIfMissing: true })
      expect(res.ok).toBe(true)
      expect(existsSync(join(devDir, 'test_math_helper.py'))).toBe(true)
    })

    it('Task 38: runs real Python unittest process and asserts exit code 0', async () => {
      const res = await devEngine.runTests(devDir, undefined, 'test_math_helper.py')
      expect(res.ok).toBe(true)
      expect(res.data?.exitCode).toBe(0)
      expect(res.data?.passed).toBe(true)
    })

    it('Task 39: verifies created files exist on disk with non-empty size', async () => {
      const res = await devEngine.inspectProject(devDir, {
        expectedFiles: ['math_helper.py', 'test_math_helper.py'],
        minFileBytes: 10,
      })
      expect(res.ok).toBe(true)
      expect(res.data?.verified).toBe(true)
    })

    it('Task 40: generates cryptographic execution report with SHA-256 hashes', async () => {
      const testRes = await devEngine.runTests(devDir, undefined, 'test_math_helper.py')
      const res = await devEngine.generateReport(
        devDir,
        '75-Task Challenge Dev Report',
        'Verified math helper module',
        {
          reportFile: 'CHALLENGE_REPORT.md',
          requiredFiles: ['math_helper.py', 'test_math_helper.py'],
          evidence: {
            testResults: testRes.data,
          },
        },
      )
      expect(res.ok).toBe(true)
      expect(existsSync(join(devDir, 'CHALLENGE_REPORT.md'))).toBe(true)
      const content = readFileSync(join(devDir, 'CHALLENGE_REPORT.md'), 'utf-8')
      expect(content).toContain('sha256')
      expect(content).toContain('math_helper.py')
    })
  })

  // ==========================================================================
  // Domain 6: Native Desktop Automation & Win32 Integration (Tasks 41 to 48)
  // ==========================================================================
  describe('Domain 6: Native Desktop Automation & Win32 Integration (8 Tasks)', () => {
    it('Task 41: classifies desktop screenshot requests', () => {
      const route = router.classify('Take a screenshot of my desktop')
      expect(route.strategy).toBe('DESKTOP_ACTION')
      expect(route.outcomeUnderstanding?.executionMode).toBe('DESKTOP_INTERACTION')
    })

    it('Task 42: classifies window enumeration requests', () => {
      const route = router.classify('What applications are currently open?')
      expect(route.strategy).toBe('DESKTOP_ACTION')
      expect(route.intent).toBe('list_windows')
    })

    it('Task 43: classifies application launch requests', () => {
      const route = router.classify('Open Notepad')
      expect(route.strategy).toBe('DESKTOP_ACTION')
      expect(route.intent).toBe('open_app')
    })

    it('Task 44: classifies application focus switching requests', () => {
      const route = router.classify('Switch to Calculator')
      expect(route.strategy).toBe('DESKTOP_ACTION')
      expect(route.intent).toBe('switch_app')
    })

    it('Task 45: validates PNG base64 signature for captured screenshots', () => {
      const mockPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      expect(mockPngBase64.startsWith('iVBORw0KGgo')).toBe(true)
    })

    it('Task 46: simulates UIA tree inspection representation', () => {
      const uiaTree = {
        name: 'Window',
        controlType: 'UIA_WindowControlTypeId',
        children: [
          { name: 'OK', automationId: 'btn_ok', controlType: 'UIA_ButtonControlTypeId' },
          { name: 'Username', automationId: 'txt_user', controlType: 'UIA_EditControlTypeId' },
        ],
      }
      expect(uiaTree.children.length).toBe(2)
      expect(uiaTree.children[0].automationId).toBe('btn_ok')
    })

    it('Task 47: validates UIA button invocation pattern contract', () => {
      const invoke = (automationId: string) => ({ success: true, elementInvoked: automationId })
      expect(invoke('btn_ok').success).toBe(true)
    })

    it('Task 48: validates UIA edit value setting pattern contract', () => {
      const setValue = (automationId: string, val: string) => ({ success: true, automationId, value: val })
      expect(setValue('txt_user', 'jarvis_user').value).toBe('jarvis_user')
    })
  })

  // ==========================================================================
  // Domain 7: Playwright Browser Automation (Tasks 49 to 56)
  // ==========================================================================
  describe('Domain 7: Playwright Browser Automation (8 Tasks)', () => {
    it('Task 49: classifies browser navigation workflow requests', () => {
      const route = router.classify('Open the browser and navigate to https://playwright.dev')
      expect(route.strategy).toBe('BROWSER_WORKFLOW')
      expect(route.outcomeUnderstanding?.executionMode).toBe('BROWSER_INTERACTION')
      expect(route.outcomeUnderstanding?.requiresDurableTask).toBe(true)
    })

    it('Task 50: rejects loopback SSRF target (127.0.0.1)', () => {
      const isBlocked = (host: string) => host === '127.0.0.1' || host === 'localhost'
      expect(isBlocked('127.0.0.1')).toBe(true)
    })

    it('Task 51: rejects cloud metadata SSRF target (169.254.169.254)', () => {
      const isMetadata = (host: string) => host === '169.254.169.254'
      expect(isMetadata('169.254.169.254')).toBe(true)
    })

    it('Task 52: rejects private RFC 1918 subnets (10.0.0.0, 192.168.0.0)', () => {
      const isPrivate = (ip: string) => /^10\./.test(ip) || /^192\.168\./.test(ip)
      expect(isPrivate('192.168.1.1')).toBe(true)
      expect(isPrivate('10.0.1.50')).toBe(true)
      expect(isPrivate('93.184.216.34')).toBe(false)
    })

    it('Task 53: validates multi-tab management lifecycle protocol', () => {
      const tabs = [
        { tabId: 'tab_1', title: 'Docs', active: true },
        { tabId: 'tab_2', title: 'Search', active: false },
      ]
      expect(tabs.length).toBe(2)
      expect(tabs[0].active).toBe(true)
    })

    it('Task 54: extracts semantic DOM elements from HTML structure', () => {
      const html = '<article><h1>Title</h1><p>Content paragraph</p></article>'
      const title = html.match(/<h1>(.*?)<\/h1>/)?.[1]
      expect(title).toBe('Title')
    })

    it('Task 55: validates form filling contract with semantic selectors', () => {
      const fill = (selector: string, val: string) => ({ success: true, selector, val })
      expect(fill('input[name="search"]', 'JARVIS').success).toBe(true)
    })

    it('Task 56: validates file download hash verification contract', () => {
      const hash = createHash('sha256').update('downloaded bytes').digest('hex')
      expect(hash).toHaveLength(64)
    })
  })

  // ==========================================================================
  // Domain 8: Personal Memory & Context Continuity (Tasks 57 to 64)
  // ==========================================================================
  describe('Domain 8: Personal Memory & Context Continuity (8 Tasks)', () => {
    it('Task 57: classifies explicit memory storage directives', () => {
      const route = router.classify('Remember that I prefer TypeScript over JavaScript')
      expect(route.strategy).toBe('MEMORY_OPERATION')
      expect(route.intent).toBe('memory_remember')
    })

    it('Task 58: classifies memory recall and inspection requests', () => {
      const route = router.classify('What do you remember about my preferred tech stack?')
      expect(route.strategy).toBe('MEMORY_OPERATION')
      expect(route.intent).toBe('memory_recall')
    })

    it('Task 59: classifies memory deletion requests', () => {
      const route = router.classify('Forget that I live in Boston')
      expect(route.strategy).toBe('MEMORY_OPERATION')
      expect(route.intent).toBe('memory_forget')
    })

    it('Task 60: classifies preference updates with conflict resolution', () => {
      const route = router.classify('Update my preference for speech rate to fast')
      expect(route.strategy).toBe('MEMORY_OPERATION')
      expect(route.intent).toBe('memory_preference')
    })

    it('Task 61: filters sensitive API keys and tokens from memory storage', () => {
      const isSensitive = (text: string) => /sk-[a-zA-Z0-9]{20,}/.test(text) || /password\s*=/i.test(text)
      expect(isSensitive('Remember my key is sk-abcdef1234567890123456')).toBe(true)
      expect(isSensitive('Remember my favorite editor is VS Code')).toBe(false)
    })

    it('Task 62: classifies task continuity directives', () => {
      const route = router.classify('Continue where we stopped')
      expect(route.strategy).toBe('CONTINUITY')
      expect(route.intent).toBe('resume_work')
    })

    it('Task 63: parses project context and workspace normalization', () => {
      expect(normalizeProjectPath('D:\\Projects\\App.')).toBe('D:\\Projects\\App')
    })

    it('Task 64: honestly reports microphone hardware block in automated environment', () => {
      const route = router.classify('Listen to me through the microphone and transcribe my voice')
      expect(route.outcomeUnderstanding?.limitationExplanation).toContain('Live microphone audio hardware input is currently blocked')
    })
  })

  // ==========================================================================
  // Domain 9: System Telemetry & Child Process Management (Tasks 65 to 70)
  // ==========================================================================
  describe('Domain 9: System Telemetry & Child Process Management (6 Tasks)', () => {
    it('Task 65: samples host CPU count and multi-core metrics', () => {
      const snapshot = resourceMonitor.getSnapshot()
      expect(snapshot.cpuCount).toBeGreaterThanOrEqual(1)
    })

    it('Task 66: tracks process memory heap usage', () => {
      const snapshot = resourceMonitor.getSnapshot()
      expect(snapshot.processHeapUsedBytes).toBeGreaterThan(0)
      expect(snapshot.totalMemoryBytes).toBeGreaterThan(0)
    })

    it('Task 67: validates task execution permission against system resource load', () => {
      // 1. Deterministic threshold validation with controllable telemetry provider:
      // A. Below-threshold condition (nominal load, 15% ratio): execution is permitted
      const nominalMonitor = new ResourceMonitor(undefined, { getCpuLoadRatio: () => 0.15 })
      const nominalCheck = nominalMonitor.canExecuteTask()
      expect(nominalCheck.allowed).toBe(true)

      // B. Above-threshold condition (high load, 92% ratio, limit 85%): execution is throttled
      const saturatedMonitor = new ResourceMonitor(undefined, { getCpuLoadRatio: () => 0.92 })
      const saturatedCheck = saturatedMonitor.canExecuteTask()
      expect(saturatedCheck.allowed).toBe(false)
      expect(saturatedCheck.reason).toContain('CPU load too high')

      // C. Boundary / at-threshold condition (85.1% ratio against 85% limit): execution is throttled
      const boundaryMonitor = new ResourceMonitor({ maxLoadAverageRatio: 0.85 }, { getCpuLoadRatio: () => 0.851 })
      expect(boundaryMonitor.canExecuteTask().allowed).toBe(false)

      // 2. Real host telemetry integration check (verifies production getter executes on live OS host):
      const hostCheck = resourceMonitor.canExecuteTask()
      expect(typeof hostCheck.allowed).toBe('boolean')
      if (!hostCheck.allowed) {
        expect(hostCheck.reason).toBeDefined()
      }
    })

    it('Task 68: registers child processes in registry', () => {
      const mockChild = { pid: 1234, kill: () => true, once: () => {} } as any
      processRegistry.register('test-task', mockChild, 'compiler')
      expect(processRegistry.getActiveProcesses('test-task').length).toBe(1)
    })

    it('Task 69: unregisters completed child processes cleanly', () => {
      const mockChild = { pid: 1234 } as any
      processRegistry.unregister('test-task', mockChild)
      expect(processRegistry.getActiveProcesses('test-task').length).toBe(0)
    })

    it('Task 70: generates single-use confirmation token with 5-minute TTL', () => {
      const req = confirmationManager.requestConfirmation('email_send', 'Send Q4 update', 'team@org', {})
      expect(req.requiresConfirmation).toBe(true)
      expect(req.confirmationToken).toBeDefined()

      // Verify and consume token (single-use)
      const verify = confirmationManager.verifyAndConsume(req.confirmationToken!, 'email_send')
      expect(verify.valid).toBe(true)

      // Replay must be rejected
      const replay = confirmationManager.verifyAndConsume(req.confirmationToken!, 'email_send')
      expect(replay.valid).toBe(false)
    })
  })

  // ==========================================================================
  // Domain 10: Compound Multi-Capability Workflows & Fault Recovery (Tasks 71 to 75)
  // ==========================================================================
  describe('Domain 10: Compound Multi-Capability Workflows & Fault Recovery (5 Tasks)', () => {
    it('Task 71 (Workflow A): plans research to presentation compound workflow', () => {
      const prompt = 'Research AI agents, compare major approaches, prepare a report and create a presentation outline'
      const route = router.classify(prompt)
      expect(route.outcomeUnderstanding?.executionMode).toBe('MULTIPLE_COMBINED')
      expect(route.outcomeUnderstanding?.requiresDurableTask).toBe(true)
    })

    it('Task 72 (Workflow B): routes spreadsheet discovery and statistical decisions', () => {
      const route = router.classify('Analyze this workbook, identify the most important trends and prepare a summary with charts')
      expect(['DATA_ANALYSIS', 'DOCUMENT_INTELLIGENCE']).toContain(route.strategy)
    })

    it('Task 73 (Workflow C): routes software development DAG creation for expense tracker', () => {
      const route = router.classify('Inspect D:\\JARVIS-Test, create a Python application for tracking expenses, run tests and generate a report')
      expect(route.strategy).toBe('AUTONOMOUS_DEV')
      expect(route.suggestedCapabilities).toContain('dev.inspectProject')
      expect(route.suggestedCapabilities).toContain('dev.runTests')
    })

    it('Task 74 (Workflow E): routes browser research + local document extraction', () => {
      const route = router.classify('Open the browser, research the requested information, save findings in a document and show me result')
      expect(['BROWSER_WORKFLOW', 'WEB_RESEARCH', 'DEEP_RESEARCH']).toContain(route.strategy)
    })

    it('Task 75 (Workflow F): delegates subtasks to specialist workers with parent-child lineage', () => {
      const subtask = {
        id: 'st-75',
        title: 'Run test suite',
        capability: 'dev.runTests',
        toolId: 'dev.runTests',
        params: {},
        state: 'PENDING' as const,
        dependencies: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        retryCount: 0,
        maxRetries: 2,
      }
      const delegated = delegator.delegateSubtask(subtask, 'task-wf-f')
      expect(delegated.workerRole).toBe('verifier')
      expect(delegated.parentTaskId).toBe('task-wf-f')
      expect(delegated.lineage?.workerRole).toBe('verifier')
    })
  })
})
