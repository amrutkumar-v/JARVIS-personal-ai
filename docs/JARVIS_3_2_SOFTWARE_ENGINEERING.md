# JARVIS 3.2 — Autonomous Software Engineering Specification
## Dynamic Multi-File DAG Planning, Code Generation, Test Execution, Verification, and Reporting

**Document Version:** 3.2.0  
**Baseline:** JARVIS 3.1  
**Architecture Layer:** Autonomous Software Engineering (`server/src/dev/DevEngine.ts`, `DevelopmentPlanner.ts`)  
**Target Platform:** Windows 11 Pro  
**Date:** November 12, 2026  
**Status:** **OPERATIONAL & EMPIRICALLY VERIFIED**

---

## 1. Executive Summary

JARVIS 3.2 provides complete, end-to-end autonomous software engineering capabilities. From a natural-language goal (such as *"Create a working Python application for tracking expenses, add tests, run it and show me the result"*), JARVIS:
1. Discovers and inspects the target workspace directory.
2. Reads the Git working tree to ensure no uncommitted user changes are overwritten.
3. Establishes a local safety checkpoint branch.
4. Generates dependency-ordered implementation files and comprehensive test suites.
5. Spawns real test runner processes (e.g. `python -m unittest`, `npm test`) and captures exit codes.
6. Re-inspects the workspace to verify that all required files exist on disk with valid byte counts.
7. Produces a cryptographic `JARVIS_EXECUTION_REPORT.md` including SHA-256 file digests and raw process execution logs.

All execution runs durably on the Node.js backend under `PersistentTaskOrchestrator`, fully decoupled from the React HUD.

---

## 2. Architecture & The Seven Canonical DevEngine Tools

Autonomous software engineering strictly binds to seven registered, verifiable tools in `server/src/dev/DevEngine.ts`:

```
Natural Language Instruction
   │
   ▼
AssistantEngine & UniversalIntentRouter (AUTONOMOUS_DEV)
   │
   ▼
DevelopmentPlanner (DAG Construction)
   │
   ├─► Step 1: dev.inspectProject (Workspace language, manifests, structure)
   ├─► Step 2: dev.gitStatus (Branch state, untracked/modified files)
   ├─► Step 3: dev.gitCheckpoint (Local branch checkpoint at HEAD)
   ├─► Step 4: dev.patchFile (Implementation file generation / targeted patch)
   ├─► Step 5: dev.patchFile (Automated test suite generation)
   ├─► Step 6: dev.runTests (Real process execution: unittest / vitest / jest)
   ├─► Step 7: dev.inspectProject (Verify created files exist on disk)
   └─► Step 8: dev.generateReport (Cryptographic SHA-256 report generation)
```

| Tool Name | Capability ID | Operational Scope | Safety Enforcement |
|---|---|---|---|
| **Inspect Project** | `dev.inspectProject` | Discovers project structure, language, test runners, and expected files. | Read-only; creates missing target directory only when explicitly instructed. |
| **Git Status** | `dev.gitStatus` | Reads current Git branch, modified files, and untracked files. | Read-only; guarantees existing work is known prior to modification. |
| **Git Checkpoint** | `dev.gitCheckpoint` | Creates a local safety branch `jarvis/checkpoint-*` at HEAD. | Local branch only; zero git reset, zero force push, zero remote mutations. |
| **Patch File** | `dev.patchFile` | Creates new files or applies exact substring replacements. | Automatic `.jarvis.bak` backup created prior to editing; atomic write. |
| **Run Tests** | `dev.runTests` | Spawns test runner (`python -m unittest`, `npm test`) and captures stdout/stderr. | Strict timeout rails (60s); captures real exit code (exit code 0 required). |
| **Audit Project** | `dev.auditProject` | Runs linters, typecheckers, and compilers where available. | Read-only audit; records diagnostics. |
| **Generate Report** | `dev.generateReport` | Writes `JARVIS_EXECUTION_REPORT.md` with SHA-256 digests. | Grounded evidence only; claims zero passes without process exit code 0. |

---

## 3. Real-World Implementations & Verification Evidence

### 3.1 Circle Geometry Calculation (`D:\JARVIS-Test`)
- **Objective:** Create a Python module calculating the area of a circle with comprehensive input validation.
- **Implementation:** `circle.py` (501 bytes) implementing `calculate_circle_area(radius)` with $\pi r^2$ and input validation (rejecting negative radii and booleans).
- **Test Suite:** `test_circle.py` (873 bytes) covering unit radius, integer radius, float radius, zero radius, negative radius exception, and invalid type exception.
- **Test Execution:** `python -m unittest test_circle.py` executed with exit code 0 (6/6 tests passing in 0.003s).
- **Report:** `JARVIS_EXECUTION_REPORT.md` with SHA-256 hashes verified on disk.

### 3.2 Personal Expense Tracker (`D:\JARVIS-Test\JARVIS-3.2`)
- **Objective:** Build a Python application for tracking personal expenses with category filtering, totals, and JSON persistence.
- **Implementation:** `expense_tracker.py` (2,352 bytes) implementing `Expense` dataclass and `ExpenseTracker` with `add_expense`, `get_total`, `get_by_category`, `get_summary_by_category`, and `save_to_json` / `load_from_json`.
- **Test Suite:** `test_expense_tracker.py` (2,511 bytes) covering expense addition, total calculation, category filters, category summaries, invalid amounts, empty category validation, and full JSON round-trip disk serialization.
- **Test Execution:** `python -m unittest test_expense_tracker.py` executed with exit code 0 (7/7 tests passing in 0.017s).
- **Report:** Verified `JARVIS_EXECUTION_REPORT.md` generated with SHA-256 digests (`7591f731...` and `a7442807...`).

### 3.3 ProjectHub Defect Repair (`D:\ProjectHub`)
- **Objective:** Inspect existing Node.js project, identify broken stub in `calculateProjectMetrics`, apply targeted patch, and run test suite.
- **Execution:** Applied targeted patch to `src/projectHub.js`, creating automatic `.jarvis.bak` backup.
- **Test Execution:** Real `npm test` executed with exit code 0 (1/1 tests passing, 0 failing).

---

## 4. HUD Independence & Durable Backend Execution

All autonomous tasks are managed by `PersistentTaskOrchestrator` on the Node.js backend (`server/src/taskService.ts`):
- **Durable Disk Storage:** Tasks and checkpoints are persisted to `server/data/tasks/`.
- **Headless Execution:** Tasks continue executing even if the browser HUD is closed or refreshed.
- **Crash Recovery:** If the backend restarts mid-execution, completed subtasks remain in state `VERIFIED` and execution resumes from the next pending step without re-executing already verified steps.

---

## 5. Verification Summary

| Test Suite | Tests | Result | Verification Scope |
|---|---|---|---|
| `test/acceptance/autonomousAcceptance.test.ts` | 10 / 10 | **PASS** | Circle Python task, ProjectHub patch, HUD independence, restart recovery, permission controls, bounded retries |
| `test/acceptance/expenseTrackerAcceptance.test.ts` | 1 / 1 | **PASS** | Dynamic Expense Tracker DAG, real Python unittests (7/7 pass), JSON disk persistence, SHA-256 report |
| `server/src/dev/DevEngine.security.test.ts` | 5 / 5 | **PASS** | Path traversal blocking, outside-workspace write prevention, dangerous command sanitization |

**Phase 4 Verdict:** Fully operational and empirically verified across Windows 11 host filesystem.

