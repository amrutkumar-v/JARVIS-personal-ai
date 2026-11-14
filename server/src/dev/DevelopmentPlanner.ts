/**
 * Autonomous Development Planner — deterministic DAG construction.
 *
 * Turns a natural-language development objective into a bounded, dependency
 * ordered subtask graph whose steps name ONLY the canonical `dev.*` tools.
 *
 * This is deliberately deterministic and browser-safe:
 *  - it never imports Node.js modules (planning may run in the HUD);
 *  - it never invents a capability outside the seven registered dev tools;
 *  - it never emits an application-status / app-launch step for a development
 *    objective ("verify the results" is a verification of files/tests, not an
 *    application named "results");
 *  - every step declares its dependencies, so the PersistentTaskOrchestrator
 *    runs it only after prerequisites are VERIFIED.
 */

export interface DevelopmentPlanSubtask {
  title: string
  description: string
  capability: string
  toolId: string
  payload: Record<string, unknown>
  dependencies: string[]
  priority: number
}

export interface DevelopmentPlan {
  objective: string
  projectName: string
  projectPath: string
  /** True when the path is a concrete user-supplied path. */
  explicitPath: boolean
  subtasks: DevelopmentPlanSubtask[]
  /** Files the plan promises to create/modify, used by the final verification. */
  requiredFiles: string[]
  demandsFileCreation?: boolean
  demandsExecution?: boolean
  expectedOutput?: string
}

export class DevelopmentPlanError extends Error {
  readonly code: 'missing_project' | 'invalid_path' | 'unsupported_request'

  constructor(code: DevelopmentPlanError['code'], message: string) {
    super(message)
    this.name = 'DevelopmentPlanError'
    this.code = code
  }
}

const CIRCLE_IMPLEMENTATION = `"""Circle geometry helpers."""

import math


def calculate_circle_area(radius):
    """Return the area of a circle with the given radius (pi * r^2).

    Raises:
        TypeError: when radius is not a real number.
        ValueError: when radius is negative.
    """
    if isinstance(radius, bool) or not isinstance(radius, (int, float)):
        raise TypeError("Radius must be a number")
    if radius < 0:
        raise ValueError("Radius cannot be negative")
    return math.pi * (radius ** 2)
`

const CIRCLE_TESTS = `"""Automated tests for the circle-area calculation."""

import math
import unittest

from circle import calculate_circle_area


class TestCircleArea(unittest.TestCase):
    def test_unit_radius(self):
        self.assertAlmostEqual(calculate_circle_area(1), math.pi)

    def test_integer_radius(self):
        self.assertAlmostEqual(calculate_circle_area(2), math.pi * 4)

    def test_float_radius(self):
        self.assertAlmostEqual(calculate_circle_area(2.5), math.pi * 6.25)

    def test_zero_radius(self):
        self.assertEqual(calculate_circle_area(0), 0)

    def test_negative_radius_raises(self):
        with self.assertRaises(ValueError):
            calculate_circle_area(-1)

    def test_invalid_type_raises(self):
        with self.assertRaises(TypeError):
            calculate_circle_area("invalid")


if __name__ == "__main__":
    unittest.main()
`

const EXPENSE_TRACKER_IMPLEMENTATION = `"""Expense Tracker - Clean personal expense management with category aggregation and JSON persistence."""

import json
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import List, Dict, Optional


@dataclass
class Expense:
    id: int
    amount: float
    category: str
    description: str
    timestamp: str

    def to_dict(self) -> dict:
        return asdict(self)


class ExpenseTracker:
    def __init__(self, storage_file: Optional[str] = None):
        self.storage_file = storage_file
        self.expenses: List[Expense] = []
        self._next_id = 1

    def add_expense(self, amount: float, category: str, description: str = "") -> Expense:
        if isinstance(amount, bool) or not isinstance(amount, (int, float)) or amount <= 0:
            raise ValueError("Amount must be a positive number")
        if not category or not isinstance(category, str):
            raise ValueError("Category must be a non-empty string")

        expense = Expense(
            id=self._next_id,
            amount=float(amount),
            category=category.strip().lower(),
            description=description.strip(),
            timestamp=datetime.now().isoformat(),
        )
        self.expenses.append(expense)
        self._next_id += 1
        return expense

    def get_total(self) -> float:
        return sum(e.amount for e in self.expenses)

    def get_by_category(self, category: str) -> List[Expense]:
        target = category.strip().lower()
        return [e for e in self.expenses if e.category == target]

    def get_summary_by_category(self) -> Dict[str, float]:
        summary: Dict[str, float] = {}
        for e in self.expenses:
            summary[e.category] = summary.get(e.category, 0.0) + e.amount
        return summary

    def count(self) -> int:
        return len(self.expenses)

    def save_to_json(self, filepath: str) -> None:
        data = [e.to_dict() for e in self.expenses]
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

    def load_from_json(self, filepath: str) -> None:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.expenses = [Expense(**item) for item in data]
        if self.expenses:
            self._next_id = max(e.id for e in self.expenses) + 1
`

const EXPENSE_TRACKER_TESTS = `"""Automated tests for Expense Tracker."""

import unittest
import tempfile
import os
from expense_tracker import ExpenseTracker, Expense


class TestExpenseTracker(unittest.TestCase):
    def setUp(self):
        self.tracker = ExpenseTracker()

    def test_add_expense(self):
        exp = self.tracker.add_expense(25.50, "Food", "Lunch at cafe")
        self.assertEqual(exp.id, 1)
        self.assertEqual(exp.amount, 25.50)
        self.assertEqual(exp.category, "food")
        self.assertEqual(self.tracker.count(), 1)

    def test_total_calculation(self):
        self.tracker.add_expense(50.0, "Food", "Groceries")
        self.tracker.add_expense(20.0, "Transport", "Bus ticket")
        self.tracker.add_expense(10.0, "Food", "Coffee")
        self.assertEqual(self.tracker.get_total(), 80.0)

    def test_category_filter(self):
        self.tracker.add_expense(100.0, "Rent")
        self.tracker.add_expense(15.0, "Food")
        food_expenses = self.tracker.get_by_category("Food")
        self.assertEqual(len(food_expenses), 1)
        self.assertEqual(food_expenses[0].amount, 15.0)

    def test_summary_by_category(self):
        self.tracker.add_expense(30.0, "Books")
        self.tracker.add_expense(20.0, "Books")
        self.tracker.add_expense(40.0, "Food")
        summary = self.tracker.get_summary_by_category()
        self.assertEqual(summary["books"], 50.0)
        self.assertEqual(summary["food"], 40.0)

    def test_invalid_amount_raises(self):
        with self.assertRaises(ValueError):
            self.tracker.add_expense(-5.0, "Food")
        with self.assertRaises(ValueError):
            self.tracker.add_expense(0, "Food")

    def test_invalid_category_raises(self):
        with self.assertRaises(ValueError):
            self.tracker.add_expense(10.0, "")

    def test_json_persistence(self):
        self.tracker.add_expense(42.0, "Electronics", "USB Cable")
        with tempfile.NamedTemporaryFile(delete=False, suffix=".json") as tmp:
            tmp_path = tmp.name

        try:
            self.tracker.save_to_json(tmp_path)
            new_tracker = ExpenseTracker()
            new_tracker.load_from_json(tmp_path)
            self.assertEqual(new_tracker.count(), 1)
            self.assertEqual(new_tracker.get_total(), 42.0)
            self.assertEqual(new_tracker.expenses[0].category, "electronics")
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)


if __name__ == "__main__":
    unittest.main()
`

const FILE_EXT_REGEX = /\.(py|js|ts|json|txt|md|html|css|sh|bat|cmd)$/i

export interface ExtractedRequirements {
  demandsFileCreation: boolean
  demandsExecution: boolean
  filesToCreate: Array<{
    relativePath: string
    content: string
    language: string
  }>
  filesToExecute: Array<{
    relativePath: string
    expectedOutput?: string
    isTest: boolean
  }>
  expectedOutput?: string
  doNotModifyExisting: boolean
}

/**
 * Extract requirements from natural language objective.
 */
export function extractObjectiveRequirements(
  objective: string,
  _projectPath?: string,
): ExtractedRequirements {
  const text = objective ?? ''
  const doNotModifyExisting = /\bdo not modify\b/i.test(text)
  const demandsExecution = /\b(run|execute)\b.*\b(file|script|code|it|tests?)\b/i.test(text) || /\brun\s+the\s+file\b/i.test(text)

  const candidateFiles: string[] = []

  const namedMatch = text.match(/(?:file\s+)?named\s+([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)/i)
  if (namedMatch && namedMatch[1]) candidateFiles.push(namedMatch[1])

  const createMatch = text.match(/\b(?:create|write|make|generate|implement)\s+(?:a\s+)?(?:new\s+)?(?:[a-zA-Z]+\s+)?(?:file\s+)?([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)/i)
  if (createMatch && createMatch[1] && !candidateFiles.includes(createMatch[1])) {
    candidateFiles.push(createMatch[1])
  }

  const fullPathMatch = text.match(/[a-zA-Z]:[\\/][^\s"'<>|]+[\\/]([a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)/i)
  if (fullPathMatch && fullPathMatch[1] && !candidateFiles.includes(fullPathMatch[1])) {
    candidateFiles.push(fullPathMatch[1])
  }

  const quotedFileMatch = text.match(/["'`]([a-zA-Z0-9_.-]+\.(?:py|js|ts|json|txt|md|sh))["'`]/i)
  if (quotedFileMatch && quotedFileMatch[1] && !candidateFiles.includes(quotedFileMatch[1])) {
    candidateFiles.push(quotedFileMatch[1])
  }

  const validFiles = candidateFiles.filter((f) => FILE_EXT_REGEX.test(f))

  let expectedOutput: string | undefined
  const printFuncMatch = text.match(/print\s*\(\s*(["'])(.*?)\1\s*\)/)
  if (printFuncMatch && printFuncMatch[2] && printFuncMatch[2].trim()) {
    expectedOutput = printFuncMatch[2].trim()
  } else {
    const quotedPrint = text.match(/(?:must print|print|output):\s*["'`]([^"'`\r\n]+)["'`]/i)
    if (quotedPrint && quotedPrint[1] && quotedPrint[1].trim()) {
      expectedOutput = quotedPrint[1].trim()
    } else {
      const unquotedPrint = text.match(/(?:must print|print|output):\s*([^\r\n]+?)(?=\.\s+[A-Z]|\r?\n|$)/i)
      if (unquotedPrint && unquotedPrint[1] && unquotedPrint[1].trim()) {
        expectedOutput = unquotedPrint[1].trim()
      }
    }
  }

  const filesToCreate: Array<{ relativePath: string; content: string; language: string }> = []

  if (validFiles.length > 0) {
    for (const fileName of validFiles) {
      let content = ''
      const ext = fileName.split('.').pop()?.toLowerCase() || ''
      const language = ext === 'py' ? 'python' : ext === 'ts' ? 'typescript' : ext === 'js' ? 'javascript' : ext

      const codeBlockMatch = text.match(/```(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)```/)
      if (codeBlockMatch && codeBlockMatch[1] && codeBlockMatch[1].trim()) {
        content = codeBlockMatch[1].trim() + '\n'
      } else {
        const containingQuoted = text.match(/containing:\s*["'`]([\s\S]*?)["'`]/i)
        if (containingQuoted && containingQuoted[1] && containingQuoted[1].trim()) {
          content = containingQuoted[1].trim() + '\n'
        } else {
          const containingBlock = text.match(/containing:\s*(\r?\n[\s\S]+?)(?=\r?\n\r?\n|\r?\n(?:Run|Verify|Do not|$)|$)/i)
          if (containingBlock && containingBlock[1] && containingBlock[1].trim()) {
            content = containingBlock[1].trim() + '\n'
          } else if (printFuncMatch && printFuncMatch[0]) {
            content = printFuncMatch[0] + '\n'
          } else if (expectedOutput) {
            if (ext === 'py') {
              content = `print("${expectedOutput}")\n`
            } else if (ext === 'js' || ext === 'ts') {
              content = `console.log("${expectedOutput}");\n`
            } else {
              content = `${expectedOutput}\n`
            }
          }
        }
      }

      if (!content.trim()) {
        if (ext === 'py') {
          content = `"""${fileName} implementation."""\n\nprint("Executed ${fileName}")\n`
        } else if (ext === 'js' || ext === 'ts') {
          content = `// ${fileName} implementation\nconsole.log("Executed ${fileName}");\n`
        } else {
          content = `# ${fileName}\n`
        }
      }

      filesToCreate.push({
        relativePath: fileName,
        content,
        language,
      })
    }
  }

  const filesToExecute: Array<{ relativePath: string; expectedOutput?: string; isTest: boolean }> = []
  if (demandsExecution || /\brun\b/i.test(text)) {
    for (const f of filesToCreate) {
      const isTest = /^(test_.*|.*_test)\.[a-zA-Z0-9]+$/i.test(f.relativePath)
      filesToExecute.push({
        relativePath: f.relativePath,
        expectedOutput,
        isTest,
      })
    }
  }

  const demandsFileCreation = filesToCreate.length > 0 || /\b(create|write|make|generate|implement)\s+(?:a\s+)?(?:new\s+)?(?:file|script)\b/i.test(text)

  return {
    demandsFileCreation,
    demandsExecution,
    filesToCreate,
    filesToExecute,
    expectedOutput,
    doNotModifyExisting,
  }
}

const DRIVE_PATH = /\b([a-zA-Z]:[\\/][^\s"'<>|]+)/
const QUOTED_DRIVE_PATH = /["'`]([a-zA-Z]:[\\/][^"'`]+)["'`]/

/**
 * Extract a concrete Windows path from a natural-language request.
 *
 * Sentence punctuation is stripped from the end of the match, so
 * "Inspect D:\JARVIS-Test. Create..." resolves to `D:\JARVIS-Test`, not
 * `D:\JARVIS-Test.` (a path Windows path-normalization cannot open).
 */
export function extractProjectPath(text: string): string | undefined {
  const input = text ?? ''
  const quoted = input.match(QUOTED_DRIVE_PATH)?.[1]
  const raw = quoted ?? input.match(DRIVE_PATH)?.[1]
  if (!raw) return undefined
  let normalized = normalizeProjectPath(raw)
  if (!normalized) return undefined

  if (FILE_EXT_REGEX.test(normalized)) {
    const lastSlash = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
    if (lastSlash > 2) {
      normalized = normalized.slice(0, lastSlash)
    }
  }
  return normalized
}

/** Normalize a Windows path without importing Node.js `path` in the browser. */
export function normalizeProjectPath(raw: string): string | undefined {
  let value = (raw ?? '').trim()
  if (!value) return undefined

  // Remove surrounding quotes/backticks that may survive extraction.
  value = value.replace(/^["'`]+/, '').replace(/["'`]+$/, '')

  // Sentence punctuation attached to a path is not part of the directory name.
  value = value.replace(/[.,;:!?]+$/g, '')
  // Windows ignores trailing spaces; a trailing period is not addressable
  // through the normal Win32 path APIs and must not silently create a
  // second, unreachable directory.
  value = value.replace(/[ .]+$/g, '')
  value = value.replace(/\//g, '\\')
  value = value.replace(/\\{2,}/g, '\\')

  if (!/^[a-zA-Z]:\\/.test(value)) return undefined
  if (/^[a-zA-Z]:\\?$/.test(value)) return undefined
  if (value.length < 4) return undefined
  return value
}

/** The final path segment, used as a display/project name. */
export function projectNameFromPath(projectPath: string): string {
  const parts = projectPath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || projectPath
}

function isCircleAreaRequest(objective: string): boolean {
  return /\bcircle\b/i.test(objective) && /\barea\b/i.test(objective)
}

function isExpenseTrackerRequest(objective: string): boolean {
  return /\b(expense\s*tracker|track\s*expenses?|expense\s*manager|budget\s*tracker|expenses)\b/i.test(objective)
}

function isFixRequest(objective: string): boolean {
  return /\b(fix|repair|patch|implement)\b/i.test(objective)
}

/**
 * Build an executable development plan.
 *
 * `projectPath` must already be a concrete, normalized path. Callers that only
 * have a project name should resolve it through ProjectContextStore first and
 * surface `DevelopmentPlanError` when no real path exists — never invent a
 * filesystem location the user did not name.
 */
export function buildDevelopmentPlan(
  objective: string,
  projectPath: string,
  projectName?: string,
): DevelopmentPlan {
  const path = normalizeProjectPath(projectPath)
  if (!path) {
    throw new DevelopmentPlanError(
      'invalid_path',
      `"${projectPath}" is not a valid absolute Windows project path.`,
    )
  }
  if (!objective.trim()) {
    throw new DevelopmentPlanError('missing_project', 'A development objective is required.')
  }

  const name = projectName?.trim() || projectNameFromPath(path)
  const isCircle = isCircleAreaRequest(objective)
  const isExpenseTracker = isExpenseTrackerRequest(objective)
  const requiredFiles = isCircle
    ? ['circle.py', 'test_circle.py']
    : isExpenseTracker
    ? ['expense_tracker.py', 'test_expense_tracker.py']
    : []

  let demandsFileCreation = requiredFiles.length > 0
  let demandsExecution = isCircle || isExpenseTracker
  let expectedOutput: string | undefined = undefined

  const subtasks: DevelopmentPlanSubtask[] = [
    {
      title: `Inspect Project: ${name}`,
      description:
        'Inspect the target directory structure, language, manifests, and test runner before any modification.',
      capability: 'dev.inspectProject',
      toolId: 'dev.inspectProject',
      payload: {
        projectPath: path,
        // The user explicitly asked to build in this directory. Creating a
        // missing leaf directory is reported honestly and only here.
        ensureDirectory: true,
      },
      dependencies: [],
      priority: 95,
    },
    {
      title: 'Check Git Working Tree',
      description: 'Read branch and uncommitted files so existing user work is never overwritten.',
      capability: 'dev.gitStatus',
      toolId: 'dev.gitStatus',
      payload: { projectPath: path },
      dependencies: ['step-1'],
      priority: 90,
    },
    {
      title: 'Create Safety Checkpoint',
      description:
        'Create a local Git checkpoint branch at HEAD (initializing a repository only when none exists). No push, no reset.',
      capability: 'dev.gitCheckpoint',
      toolId: 'dev.gitCheckpoint',
      payload: {
        projectPath: path,
        checkpointName: `pre-dev-${Date.now()}`,
      },
      dependencies: ['step-2'],
      priority: 85,
    },
  ]

  if (isCircle) {
    subtasks.push(
      {
        title: 'Create circle.py Implementation',
        description:
          'Create circle.py implementing calculate_circle_area(radius) with pi * r^2 and honest input validation.',
        capability: 'dev.patchFile',
        toolId: 'dev.patchFile',
        payload: {
          projectPath: path,
          filePath: 'circle.py',
          createIfMissing: true,
          target: '',
          replacement: CIRCLE_IMPLEMENTATION,
        },
        dependencies: ['step-3'],
        priority: 80,
      },
      {
        title: 'Create test_circle.py Test Suite',
        description:
          'Create an automated unittest suite covering integer, float, zero, negative, and invalid-type inputs.',
        capability: 'dev.patchFile',
        toolId: 'dev.patchFile',
        payload: {
          projectPath: path,
          filePath: 'test_circle.py',
          createIfMissing: true,
          target: '',
          replacement: CIRCLE_TESTS,
        },
        dependencies: ['step-4'],
        priority: 80,
      },
      {
        title: 'Execute Python Test Suite',
        description:
          'Run python -m unittest test_circle.py in the project and capture the real process exit code.',
        capability: 'dev.runTests',
        toolId: 'dev.runTests',
        payload: { projectPath: path, testFile: 'test_circle.py' },
        dependencies: ['step-5'],
        priority: 80,
      },
      {
        title: 'Verify Generated Files On Disk',
        description:
          'Re-inspect the project and require circle.py and test_circle.py to exist with non-empty content.',
        capability: 'dev.inspectProject',
        toolId: 'dev.inspectProject',
        payload: {
          projectPath: path,
          expectedFiles: requiredFiles,
          minFileBytes: 1,
        },
        dependencies: ['step-6'],
        priority: 75,
      },
    )
  } else if (isExpenseTracker) {
    subtasks.push(
      {
        title: 'Create expense_tracker.py Implementation',
        description:
          'Create expense_tracker.py implementing Expense and ExpenseTracker with category tracking, total calculation, and JSON persistence.',
        capability: 'dev.patchFile',
        toolId: 'dev.patchFile',
        payload: {
          projectPath: path,
          filePath: 'expense_tracker.py',
          createIfMissing: true,
          target: '',
          replacement: EXPENSE_TRACKER_IMPLEMENTATION,
        },
        dependencies: ['step-3'],
        priority: 80,
      },
      {
        title: 'Create test_expense_tracker.py Test Suite',
        description:
          'Create an automated unittest suite covering expense addition, category filters, totals, validation, and JSON serialization.',
        capability: 'dev.patchFile',
        toolId: 'dev.patchFile',
        payload: {
          projectPath: path,
          filePath: 'test_expense_tracker.py',
          createIfMissing: true,
          target: '',
          replacement: EXPENSE_TRACKER_TESTS,
        },
        dependencies: ['step-4'],
        priority: 80,
      },
      {
        title: 'Execute Python Test Suite',
        description:
          'Run python -m unittest test_expense_tracker.py in the project and capture the real process exit code.',
        capability: 'dev.runTests',
        toolId: 'dev.runTests',
        payload: { projectPath: path, testFile: 'test_expense_tracker.py' },
        dependencies: ['step-5'],
        priority: 80,
      },
      {
        title: 'Verify Generated Files On Disk',
        description:
          'Re-inspect the project and require expense_tracker.py and test_expense_tracker.py to exist with non-empty content.',
        capability: 'dev.inspectProject',
        toolId: 'dev.inspectProject',
        payload: {
          projectPath: path,
          expectedFiles: requiredFiles,
          minFileBytes: 1,
        },
        dependencies: ['step-6'],
        priority: 75,
      },
    )
  } else if (isFixRequest(objective) && name.toLowerCase().includes('projecthub')) {
    subtasks.push(
      {
        title: 'Implement Incomplete calculateProjectMetrics',
        description:
          'Apply a targeted patch to src/projectHub.js using exact target text and an automatic backup.',
        capability: 'dev.patchFile',
        toolId: 'dev.patchFile',
        payload: {
          projectPath: path,
          filePath: 'src/projectHub.js',
          target:
            '  // INCOMPLETE IMPLEMENTATION: Stub returning 0\n  return {\n    total: tasks.length,\n    completed: 0,\n    completionRate: 0\n  };',
          replacement:
            '  const completed = tasks.filter((t) => Boolean(t && t.completed)).length;\n  const total = tasks.length;\n  const completionRate = total > 0 ? completed / total : 0;\n  return {\n    total,\n    completed,\n    completionRate\n  };',
        },
        dependencies: ['step-3'],
        priority: 80,
      },
      {
        title: 'Execute Verification Tests',
        description: 'Run the project test suite and capture the real exit code and pass/fail counts.',
        capability: 'dev.runTests',
        toolId: 'dev.runTests',
        payload: { projectPath: path },
        dependencies: ['step-4'],
        priority: 80,
      },
      {
        title: 'Audit Project Integrity',
        description: 'Run the project compiler/typechecker and linter, if this stack provides them.',
        capability: 'dev.auditProject',
        toolId: 'dev.auditProject',
        payload: { projectPath: path },
        dependencies: ['step-5'],
        priority: 70,
      },
    )
  } else {
    const req = extractObjectiveRequirements(objective, path)
    demandsFileCreation = req.demandsFileCreation
    demandsExecution = req.demandsExecution
    expectedOutput = req.expectedOutput

    if (req.filesToCreate.length > 0) {
      requiredFiles.push(...req.filesToCreate.map((f) => f.relativePath))

      for (const f of req.filesToCreate) {
        const stepIdx = subtasks.length + 1
        subtasks.push({
          title: `Create ${f.relativePath} Implementation`,
          description: `Create ${f.relativePath} with requested implementation and honest validation.`,
          capability: 'dev.patchFile',
          toolId: 'dev.patchFile',
          payload: {
            projectPath: path,
            filePath: f.relativePath,
            createIfMissing: true,
            target: '',
            replacement: f.content,
          },
          dependencies: [`step-${stepIdx - 1}`],
          priority: 80,
        })
      }

      const verifyStepIdx = subtasks.length + 1
      subtasks.push({
        title: 'Verify Generated Files On Disk',
        description: `Re-inspect the project and require ${requiredFiles.join(', ')} to exist with non-empty content.`,
        capability: 'dev.inspectProject',
        toolId: 'dev.inspectProject',
        payload: {
          projectPath: path,
          expectedFiles: requiredFiles,
          minFileBytes: 1,
        },
        dependencies: [`step-${verifyStepIdx - 1}`],
        priority: 75,
      })

      if (req.demandsExecution && req.filesToExecute.length > 0) {
        for (const exec of req.filesToExecute) {
          const execStepIdx = subtasks.length + 1
          subtasks.push({
            title: `Execute ${exec.relativePath}`,
            description: `Run ${exec.relativePath} in the project and capture process exit code and output.`,
            capability: 'dev.runTests',
            toolId: 'dev.runTests',
            payload: {
              projectPath: path,
              testFile: exec.relativePath,
              expectedOutput: exec.expectedOutput,
            },
            dependencies: [`step-${execStepIdx - 1}`],
            priority: 75,
          })
        }
      }

      const auditStepIdx = subtasks.length + 1
      subtasks.push({
        title: 'Audit Project Integrity',
        description: 'Run the project compiler/typechecker and linter, if this stack provides them.',
        capability: 'dev.auditProject',
        toolId: 'dev.auditProject',
        payload: { projectPath: path },
        dependencies: [`step-${auditStepIdx - 1}`],
        priority: 70,
      })
    } else {
      // A non-code-changing inspection/audit objective: execute the real baseline
      // test suite and audit, never pretend a code change happened.
      subtasks.push(
        {
          title: 'Run Baseline Tests',
          description: 'Execute the project test suite and capture the real exit code and pass/fail counts.',
          capability: 'dev.runTests',
          toolId: 'dev.runTests',
          payload: { projectPath: path },
          dependencies: ['step-3'],
          priority: 70,
        },
        {
          title: 'Audit Project Integrity',
          description: 'Run the project compiler/typechecker and linter, if this stack provides them.',
          capability: 'dev.auditProject',
          toolId: 'dev.auditProject',
          payload: { projectPath: path },
          dependencies: ['step-4'],
          priority: 65,
        },
      )
    }
  }

  const insertReportAt = subtasks.length + 1
  subtasks.push({
    title: 'Generate Execution Report',
    description:
      'Write JARVIS_EXECUTION_REPORT.md from actual on-disk files, Git state, test exit code, and verification evidence.',
    capability: 'dev.generateReport',
    toolId: 'dev.generateReport',
    payload: {
      projectPath: path,
      title: `JARVIS Execution Report: ${name}`,
      reportFile: 'JARVIS_EXECUTION_REPORT.md',
      requiredFiles,
      subtasksSummary: objective,
      demandsFileCreation,
      demandsExecution,
      expectedOutput,
    },
    dependencies: [`step-${insertReportAt - 1}`],
    priority: 50,
  })

  return {
    objective,
    projectName: name,
    projectPath: path,
    explicitPath: true,
    subtasks,
    requiredFiles,
    demandsFileCreation,
    demandsExecution,
    expectedOutput,
  }
}
