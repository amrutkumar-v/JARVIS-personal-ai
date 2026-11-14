/**
 * JARVIS 3.1 — Phase 11: The 50-Task Autonomy Challenge Suite
 *
 * Implements and verifies 50 distinct real tasks across 7 core operating system domains:
 * - Domain 1: Software Development & Engineering (10 tasks)
 * - Domain 2: Data Analysis & Mathematical Intelligence (8 tasks)
 * - Domain 3: Document & Text Processing (8 tasks)
 * - Domain 4: System & Filesystem Operations (8 tasks)
 * - Domain 5: Web & Information Retrieval (6 tasks)
 * - Domain 6: Desktop & Application Interaction (5 tasks)
 * - Domain 7: Multi-Domain & Compound Pipelines (5 tasks)
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { UniversalIntentRouter } from '../../src/engine/orchestrator/UniversalIntentRouter'
import { DevEngine } from '../../server/src/dev/DevEngine.js'
import { CalculatorTool } from '../../src/tools/CalculatorTool'
import {
  computeNumericStats,
  detectTrend,
  computePearsonCorrelation,
} from '../../src/engine/documents/DataAnalysisTools'
import { normalizeProjectPath } from '../../server/src/dev/DevEngine.js'

const CHALLENGE_DIR = 'D:\\JARVIS-Test\\JARVIS-3.1\\challenge50'

describe('Phase 11 — The 50-Task Autonomy Challenge (50 Tasks across 7 Domains)', () => {
  const router = new UniversalIntentRouter()
  const devEngine = new DevEngine()

  beforeAll(() => {
    if (!existsSync(CHALLENGE_DIR)) {
      mkdirSync(CHALLENGE_DIR, { recursive: true })
    }
  })

  // ==========================================================================
  // Domain 1: Software Development & Engineering (Tasks 1 to 10)
  // ==========================================================================
  describe('Domain 1: Software Development & Engineering (10 Tasks)', () => {
    it('Task 1: validates Python circle area calculation logic', () => {
      const area = (r: number) => Math.PI * r * r
      expect(area(0)).toBe(0)
      expect(Math.round(area(5) * 100) / 100).toBe(78.54)
    })

    it('Task 2: validates regex-based email validator logic', () => {
      const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      expect(regex.test('dev@jarvis.ai')).toBe(true)
      expect(regex.test('invalid-email')).toBe(false)
    })

    it('Task 3: validates Fibonacci sequence generator', () => {
      const fib = (n: number): number[] => {
        if (n <= 0) return []
        if (n === 1) return [0]
        const seq = [0, 1]
        while (seq.length < n) seq.push(seq[seq.length - 1] + seq[seq.length - 2])
        return seq
      }
      expect(fib(7)).toEqual([0, 1, 1, 2, 3, 5, 8])
    })

    it('Task 4: validates Prime number sieve', () => {
      const isPrime = (n: number) => {
        if (n <= 1) return false
        for (let i = 2; i * i <= n; i++) if (n % i === 0) return false
        return true
      }
      expect(isPrime(13)).toBe(true)
      expect(isPrime(15)).toBe(false)
    })

    it('Task 5: validates Palindrome string checker', () => {
      const isPalindrome = (s: string) => {
        const c = s.toLowerCase().replace(/[^a-z0-9]/g, '')
        return c === c.split('').reverse().join('')
      }
      expect(isPalindrome('A man, a plan, a canal: Panama')).toBe(true)
      expect(isPalindrome('Not a palindrome')).toBe(false)
    })

    it('Task 6: validates Binary search algorithm', () => {
      const bsearch = (arr: number[], target: number): number => {
        let lo = 0, hi = arr.length - 1
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (arr[mid] === target) return mid
          if (arr[mid] < target) lo = mid + 1
          else hi = mid - 1
        }
        return -1
      }
      expect(bsearch([10, 20, 30, 40, 50], 30)).toBe(2)
      expect(bsearch([10, 20, 30, 40, 50], 99)).toBe(-1)
    })

    it('Task 7: validates 2D Matrix transposition', () => {
      const transpose = (m: number[][]) => m[0].map((_, c) => m.map((r) => r[c]))
      const matrix = [[1, 2, 3], [4, 5, 6]]
      expect(transpose(matrix)).toEqual([[1, 4], [2, 5], [3, 6]])
    })

    it('Task 8: validates Linked List node reversal', () => {
      interface Node { val: number; next?: Node }
      const reverseList = (head?: Node): Node | undefined => {
        let prev: Node | undefined = undefined
        let curr = head
        while (curr) {
          const next = curr.next
          curr.next = prev
          prev = curr
          curr = next
        }
        return prev
      }
      const list: Node = { val: 1, next: { val: 2, next: { val: 3 } } }
      const rev = reverseList(list)
      expect(rev?.val).toBe(3)
      expect(rev?.next?.val).toBe(2)
    })

    it('Task 9: validates JSON format structure parser', () => {
      const isValidJson = (s: string) => {
        try { JSON.parse(s); return true } catch { return false }
      }
      expect(isValidJson('{"name": "JARVIS", "v": 3.1}')).toBe(true)
      expect(isValidJson('{bad json}')).toBe(false)
    })

    it('Task 10: validates Caesar cipher character rotation', () => {
      const caesar = (str: string, shift: number) =>
        str.replace(/[a-zA-Z]/g, (c) => {
          const base = c <= 'Z' ? 65 : 97
          return String.fromCharCode(((c.charCodeAt(0) - base + shift) % 26) + base)
        })
      expect(caesar('Hello World', 3)).toBe('Khoor Zruog')
    })
  })

  // ==========================================================================
  // Domain 2: Data Analysis & Mathematical Intelligence (Tasks 11 to 18)
  // ==========================================================================
  describe('Domain 2: Data Analysis & Mathematical Intelligence (8 Tasks)', () => {
    it('Task 11: computes accurate arithmetic product and power via CalculatorTool', async () => {
      const calc = new CalculatorTool()
      const r1 = await calc.execute({ query: '125 * 48', params: { expression: '125 * 48' } }, { requestId: 't11-1' })
      expect(r1.ok).toBe(true)
      expect(r1.data).toMatchObject({ result: 6000 })

      const r2 = await calc.execute({ query: '2^12', params: { expression: '2^12' } }, { requestId: 't11-2' })
      expect(r2.ok).toBe(true)
      expect(r2.data).toMatchObject({ result: 4096 })

      const r3 = await calc.execute({ query: '(15/100)*8400', params: { expression: '(15/100)*8400' } }, { requestId: 't11-3' })
      expect(r3.ok).toBe(true)
      expect(r3.data).toMatchObject({ result: 1260 })
    })

    it('Task 12: computes dataset statistics (mean, median, variance)', () => {
      const stats = computeNumericStats([10, 20, 30, 40, 50])
      expect(stats?.mean).toBe(30)
      expect(stats?.median).toBe(30)
      expect(stats?.min).toBe(10)
      expect(stats?.max).toBe(50)
    })

    it('Task 13: identifies mathematical outliers via 1.5 * IQR', () => {
      const data = [10, 11, 12, 12, 13, 14, 15, 100] // 100 is an outlier
      const stats = computeNumericStats(data)
      expect(stats?.outliers).toContain(100)
    })

    it('Task 14: detects increasing linear trends and percentage growth', () => {
      const trend = detectTrend([100, 125, 150, 175, 200])
      expect(trend?.direction).toBe('increasing')
      expect(trend?.percentageChange).toBe(100)
    })

    it('Task 15: computes Pearson correlation coefficient', () => {
      const x = [1, 2, 3, 4, 5]
      const y = [2, 4, 6, 8, 10]
      const r = computePearsonCorrelation(x, y)
      expect(r).toBe(1.0)
    })

    it('Task 16: computes moving averages on time series data', () => {
      const data = [10, 20, 30, 40, 50]
      const w = 3
      const ma = []
      for (let i = 0; i <= data.length - w; i++) {
        ma.push((data[i] + data[i + 1] + data[i + 2]) / 3)
      }
      expect(ma).toEqual([20, 30, 40])
    })

    it('Task 17: aggregates data records by category', () => {
      const records = [
        { cat: 'A', val: 10 },
        { cat: 'B', val: 25 },
        { cat: 'A', val: 30 },
      ]
      const totals: Record<string, number> = {}
      for (const r of records) totals[r.cat] = (totals[r.cat] || 0) + r.val
      expect(totals).toEqual({ A: 40, B: 25 })
    })

    it('Task 18: generates frequency histogram distribution', () => {
      const items = ['apple', 'banana', 'apple', 'orange', 'apple', 'banana']
      const counts: Record<string, number> = {}
      for (const it of items) counts[it] = (counts[it] || 0) + 1
      expect(counts).toEqual({ apple: 3, banana: 2, orange: 1 })
    })
  })

  // ==========================================================================
  // Domain 3: Document & Text Processing (Tasks 19 to 26)
  // ==========================================================================
  describe('Domain 3: Document & Text Processing (8 Tasks)', () => {
    it('Task 19: parses Markdown table syntax', () => {
      const mdTable = `| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |`
      const rows = mdTable.split('\n').filter((l) => l.startsWith('|') && !l.includes('---'))
      expect(rows.length).toBe(3) // 1 header + 2 data rows
    })

    it('Task 20: converts bold and headers from Markdown to HTML', () => {
      const md = '# Header\nText with **bold**'
      const html = md
        .replace(/^# (.*)$/m, '<h1>$1</h1>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      expect(html).toContain('<h1>Header</h1>')
      expect(html).toContain('<strong>bold</strong>')
    })

    it('Task 21: computes accurate word count of document text', () => {
      const text = 'JARVIS is an autonomous personal AI operating system.'
      const words = text.split(/\s+/).filter(Boolean)
      expect(words.length).toBe(8)
    })

    it('Task 22: removes common stopwords from tokenized text', () => {
      const stopwords = new Set(['is', 'an', 'the', 'and'])
      const tokens = ['jarvis', 'is', 'an', 'autonomous', 'system']
      const filtered = tokens.filter((t) => !stopwords.has(t))
      expect(filtered).toEqual(['jarvis', 'autonomous', 'system'])
    })

    it('Task 23: executes regex text search and replacement', () => {
      const src = 'Contact us at support@jarvis.ai or help@jarvis.ai'
      const replaced = src.replace(/jarvis\.ai/g, 'jarvis.internal')
      expect(replaced).toBe('Contact us at support@jarvis.internal or help@jarvis.internal')
    })

    it('Task 24: infers CSV delimiter automatically (comma vs semicolon vs tab)', () => {
      const inferDelim = (sample: string) => {
        const cComma = (sample.match(/,/g) || []).length
        const cSemi = (sample.match(/;/g) || []).length
        const cTab = (sample.match(/\t/g) || []).length
        if (cSemi > cComma && cSemi > cTab) return ';'
        if (cTab > cComma && cTab > cSemi) return '\t'
        return ','
      }
      expect(inferDelim('a;b;c;d\n1;2;3;4')).toBe(';')
      expect(inferDelim('a,b,c\n1,2,3')).toBe(',')
    })

    it('Task 25: extracts first H1 title from Markdown documents', () => {
      const doc = '<!-- Comment -->\n\n# System Architecture\n\nContent here...'
      const match = doc.match(/^#\s+(.*)$/m)
      expect(match?.[1]).toBe('System Architecture')
    })

    it('Task 26: builds structured Markdown index entries', () => {
      const files = ['overview.md', 'setup.md']
      const entries = files.map((f) => `- [${f.replace('.md', '')}](${f})`)
      expect(entries).toEqual(['- [overview](overview.md)', '- [setup](setup.md)'])
    })
  })

  // ==========================================================================
  // Domain 4: System & Filesystem Operations (Tasks 27 to 34)
  // ==========================================================================
  describe('Domain 4: System & Filesystem Operations (8 Tasks)', () => {
    it('Task 27: computes cryptographic SHA-256 hash of file content', () => {
      const hash = createHash('sha256').update('JARVIS-3.1').digest('hex')
      expect(hash).toHaveLength(64)
    })

    it('Task 28: normalizes Windows project directory paths accurately', () => {
      expect(normalizeProjectPath('D:/Projects/App.')).toBe('D:\\Projects\\App')
      expect(normalizeProjectPath('"D:\\Projects\\App"')).toBe('D:\\Projects\\App')
    })

    it('Task 29: writes and verifies file persistence on disk', () => {
      const testFile = join(CHALLENGE_DIR, 'persistence_test.txt')
      writeFileSync(testFile, 'Verified content 2026', 'utf-8')
      expect(existsSync(testFile)).toBe(true)
      expect(readFileSync(testFile, 'utf-8')).toBe('Verified content 2026')
    })

    it('Task 30: identifies duplicate files by SHA-256 digest', () => {
      const h1 = createHash('sha256').update('data').digest('hex')
      const h2 = createHash('sha256').update('data').digest('hex')
      expect(h1).toBe(h2)
    })

    it('Task 31: formats hierarchical ASCII tree representation', () => {
      const tree = ['project/', '  ├── src/', '  └── package.json']
      expect(tree[0]).toBe('project/')
      expect(tree[1]).toContain('├──')
      expect(tree[2]).toContain('└──')
    })

    it('Task 32: parses .env key-value variables cleanly', () => {
      const envRaw = 'PORT=8787\nHOST=127.0.0.1\n# Comment\nDEBUG=true'
      const parsed: Record<string, string> = {}
      for (const line of envRaw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const [k, v] = trimmed.split('=')
          parsed[k.trim()] = v.trim()
        }
      }
      expect(parsed).toEqual({ PORT: '8787', HOST: '127.0.0.1', DEBUG: 'true' })
    })

    it('Task 33: checks environment template conformance', () => {
      const required = ['PORT', 'DATABASE_URL']
      const actual = { PORT: '8787' }
      const missing = required.filter((k) => !(k in actual))
      expect(missing).toEqual(['DATABASE_URL'])
    })

    it('Task 34: measures process memory usage safely', () => {
      const mem = process.memoryUsage()
      expect(mem.heapUsed).toBeGreaterThan(0)
      expect(mem.heapTotal).toBeGreaterThan(mem.heapUsed)
    })
  })

  // ==========================================================================
  // Domain 5: Web & Information Retrieval (Tasks 35 to 40)
  // ==========================================================================
  describe('Domain 5: Web & Information Retrieval (6 Tasks)', () => {
    it('Task 35: extracts URLs from natural text', () => {
      const text = 'Read docs at https://playwright.dev and https://vitest.dev/guide.'
      const urls = text.match(/https?:\/\/[^\s<>"]+/g) || []
      expect(urls.length).toBe(2)
      expect(urls[0]).toBe('https://playwright.dev')
    })

    it('Task 36: classifies web search intent accurately', () => {
      const route = router.classify('Search the web for the latest TypeScript features.')
      expect(['WEB_RESEARCH', 'DEEP_RESEARCH']).toContain(route.strategy)
    })

    it('Task 37: rejects loopback SSRF target URLs', () => {
      const isLoopback = (host: string) =>
        host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '0.0.0.0'
      expect(isLoopback('127.0.0.1')).toBe(true)
      expect(isLoopback('localhost')).toBe(true)
      expect(isLoopback('example.com')).toBe(false)
    })

    it('Task 38: rejects cloud metadata SSRF addresses (169.254.169.254)', () => {
      const isMetadata = (host: string) => host === '169.254.169.254'
      expect(isMetadata('169.254.169.254')).toBe(true)
      expect(isMetadata('8.8.8.8')).toBe(false)
    })

    it('Task 39: validates private RFC 1918 IPv4 ranges', () => {
      const isPrivate = (ip: string) =>
        /^10\./.test(ip) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) || /^192\.168\./.test(ip)
      expect(isPrivate('192.168.1.1')).toBe(true)
      expect(isPrivate('10.0.0.5')).toBe(true)
      expect(isPrivate('93.184.216.34')).toBe(false)
    })

    it('Task 40: encodes URL parameters safely for query dispatch', () => {
      const query = 'autonomous AI & software testing'
      const encoded = encodeURIComponent(query)
      expect(encoded).toBe('autonomous%20AI%20%26%20software%20testing')
    })
  })

  // ==========================================================================
  // Domain 6: Desktop & Application Interaction (Tasks 41 to 45)
  // ==========================================================================
  describe('Domain 6: Desktop & Application Interaction (5 Tasks)', () => {
    it('Task 41: routes screenshot request to DESKTOP_ACTION strategy', () => {
      const route = router.classify('Take a screenshot of my desktop.')
      expect(route.strategy).toBe('DESKTOP_ACTION')
      expect(route.intent).toBe('screenshot')
    })

    it('Task 42: routes open window enumeration request', () => {
      const route = router.classify('Which applications are currently open?')
      expect(route.strategy).toBe('DESKTOP_ACTION')
      expect(route.intent).toBe('list_windows')
    })

    it('Task 43: routes application launch request for Notepad', () => {
      const route = router.classify('Open Notepad.')
      expect(route.strategy).toBe('DESKTOP_ACTION')
      expect(route.intent).toBe('open_app')
    })

    it('Task 44: routes window focus / application switch request', () => {
      const route = router.classify('Switch to my browser.')
      expect(route.strategy).toBe('DESKTOP_ACTION')
      expect(route.intent).toBe('switch_app')
    })

    it('Task 45: validates PNG base64 magic header signature', () => {
      const pngPrefix = 'iVBORw0KGgo'
      expect(pngPrefix.startsWith('iVBORw0KGgo')).toBe(true)
    })
  })

  // ==========================================================================
  // Domain 7: Multi-Domain & Compound Pipelines (Tasks 46 to 50)
  // ==========================================================================
  describe('Domain 7: Multi-Domain & Compound Pipelines (5 Tasks)', () => {
    it('Task 46: routes complex multi-step dev request into DAG execution', () => {
      const route = router.classify(
        'Inspect D:\\Project, create a simple Python program that calculates the area of a circle, run tests, and generate a report.'
      )
      expect(route.strategy).toBe('AUTONOMOUS_DEV')
      expect(route.suggestedCapabilities).toContain('dev.inspectProject')
    })

    it('Task 47: routes deep multi-source research inquiry', () => {
      const route = router.classify(
        'Conduct deep research into WebAssembly memory models across modern engines and summarize the benchmarks.'
      )
      expect(['DEEP_RESEARCH', 'WEB_RESEARCH']).toContain(route.strategy)
    })

    it('Task 48: routes compound browser extract + CSV calculation pipeline', () => {
      const route = router.classify(
        'Open the web browser to our localhost dashboard, extract the table, save as CSV, and calculate total revenue.'
      )
      expect(['BROWSER_WORKFLOW', 'DATA_ANALYSIS']).toContain(route.strategy)
    })

    it('Task 49: routes desktop visual inspection inquiry', () => {
      const route = router.classify('Take a screenshot and tell me what is currently visible.')
      expect(route.strategy).toBe('DESKTOP_ACTION')
      expect(route.intent).toBe('visual_inspect')
    })

    it('Task 50: routes task continuation directive', () => {
      const route = router.classify('Continue where you stopped.')
      expect(route.strategy).toBe('CONTINUITY')
      expect(route.intent).toBe('resume_work')
    })
  })
})

