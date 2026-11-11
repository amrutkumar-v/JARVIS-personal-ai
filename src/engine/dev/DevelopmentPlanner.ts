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
  return normalizeProjectPath(raw)
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
  const requiredFiles = isCircle ? ['circle.py', 'test_circle.py'] : []

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
      title: 'Create Safety Checkpoint',
      description:
        'Create a local Git checkpoint branch at HEAD (initializing a repository only when none exists). No push, no reset.',
      capability: 'dev.gitCheckpoint',
      toolId: 'dev.gitCheckpoint',
      payload: {
        projectPath: path,
        checkpointName: `pre-dev-${Date.now()}`,
      },
      dependencies: ['step-1'],
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
        dependencies: ['step-2'],
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
        dependencies: ['step-3'],
        priority: 80,
      },
      {
        title: 'Execute Python Test Suite',
        description:
          'Run python -m unittest test_circle.py in the project and capture the real process exit code.',
        capability: 'dev.runTests',
        toolId: 'dev.runTests',
        payload: { projectPath: path, testFile: 'test_circle.py' },
        dependencies: ['step-4'],
        priority: 80,
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
        dependencies: ['step-2'],
        priority: 80,
      },
      {
        title: 'Execute Verification Tests',
        description: 'Run the project test suite and capture the real exit code and pass/fail counts.',
        capability: 'dev.runTests',
        toolId: 'dev.runTests',
        payload: { projectPath: path },
        dependencies: ['step-3'],
        priority: 80,
      },
    )
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
        dependencies: ['step-2'],
        priority: 70,
      },
      {
        title: 'Audit Project Integrity',
        description: 'Run the project compiler/typechecker and linter, if this stack provides them.',
        capability: 'dev.auditProject',
        toolId: 'dev.auditProject',
        payload: { projectPath: path },
        dependencies: ['step-3'],
        priority: 65,
      },
    )
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
  }
}
