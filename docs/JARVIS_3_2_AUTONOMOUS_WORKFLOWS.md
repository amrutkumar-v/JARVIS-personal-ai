# JARVIS 3.2 — Autonomous Workflow Engine Specification
## Multi-Domain Compound Scenarios, Cross-Capability Chaining, Verification, and Failure Recovery

**Document Version:** 3.2.0  
**Baseline:** JARVIS 3.1  
**Architecture Layer:** Compound Autonomous Workflow Engine (`src/engine/AssistantEngine.ts`)  
**Target Platform:** Windows 11 Pro  
**Date:** November 12, 2026  
**Status:** **OPERATIONAL & EMPIRICALLY AUDITED**

---

## 1. Executive Summary

The true measure of a personal AI operating system is its ability to combine diverse capabilities—web research, browser automation, desktop control, document analysis, and software engineering—into unified, goal-driven workflows. JARVIS 3.2 moves beyond isolated tool calls to execute compound workflows from high-level natural language instructions without requiring the user to navigate the underlying mechanics.

This specification details the architecture, execution traces, and empirical verification of the six canonical workflows (Workflows A through F) specified in Section 15 of the Master Mission.

---

## 2. The Six Canonical Workflows

```
┌────────────────────────────────────────────────────────────────────────┐
│                        COMPOUND WORKFLOW TAXONOMY                      │
├──────────────┬───────────────────────────────────┬─────────────────────┤
│ WORKFLOW     │ DOMAIN COMPOSITION                │ PRIMARY DELIVERABLE │
├──────────────┼───────────────────────────────────┼─────────────────────┤
│ Workflow A   │ Web Research + Synthesis          │ Report & Slides     │
│ Workflow B   │ Spreadsheet + Data Analysis       │ Summary & Charts    │
│ Workflow C   │ Software Dev + Testing            │ Python App & Report │
│ Workflow D   │ Repository Audit + Defect Repair  │ Code Patch & Verify │
│ Workflow E   │ Desktop Control + Real Browser    │ DOM Data & Capture  │
│ Workflow F   │ Durable Task + Background Recovery│ Checkpoint State    │
└──────────────┴───────────────────────────────────┴─────────────────────┘
```

---

## 3. Detailed Execution Traces & Verification

### 3.1 Workflow A — Research to Presentation
- **Instruction:** *"Research the latest developments in AI agents, compare major approaches, prepare a report and create a presentation outline."*
- **Execution Flow:**
  1. `expandQueries` generates 3 multi-query variants to avoid perspective bias.
  2. `searchMultiSource` queries Wikipedia and configured web providers, deduplicating URLs.
  3. `evaluateSourceReliability` tiers primary documentation from secondary and community sources.
  4. `crossCheck` extracts factual sentences and upgrades confidence to `high` when corroborated.
  5. `synthesizeReport` generates a Markdown research brief with traceable citation tables.
  6. `synthesizePresentationOutline` transforms the brief into a 5-slide presentation outline.
- **Verification Evidence:** Validated in `test/unit/researchEngine.test.ts` (Test 4 & 5).

### 3.2 Workflow B — Spreadsheet to Decisions
- **Instruction:** *"Analyze this workbook, identify the most important trends and prepare a summary with charts."*
- **Execution Flow:**
  1. `DocumentParser` parses CSV/XLSX rows, extracting numeric series and column statistics.
  2. `computeNumericStats` calculates mean, median, standard deviation, and identifies 1.5 $\times$ IQR outliers.
  3. `detectTrend` executes linear regression, calculating slope, $R^2$ fit, and percentage change.
  4. `computePearsonCorrelation` evaluates bivariate dependencies across columns.
  5. `generateChartSpec` builds standards-compliant Chart.js / Vega-Lite visual specifications.
  6. Synthesizes an executive summary explaining supported conclusions and caveats.
- **Verification Evidence:** Validated in `test/acceptance/masterMissionAcceptance.test.ts` (Scenario F) and `src/engine/documents/DataAnalysisTools.test.ts`.

### 3.3 Workflow C — Autonomous Software Engineering
- **Instruction:** *"Create a working Python application for tracking expenses, add tests, run it and show me the result."*
- **Execution Flow:**
  1. `DevelopmentPlanner` plans an 8-subtask dependency-ordered DAG in `D:\JARVIS-Test\JARVIS-3.2`.
  2. `dev.inspectProject` discovers workspace; `dev.gitStatus` reads working tree.
  3. `dev.gitCheckpoint` establishes a safety checkpoint branch at HEAD.
  4. `dev.patchFile` writes `expense_tracker.py` (2,352 bytes) and `test_expense_tracker.py` (2,511 bytes).
  5. `dev.runTests` spawns `python -m unittest test_expense_tracker.py` and asserts exit code 0.
  6. `dev.inspectProject` confirms both files exist on disk with non-empty content.
  7. `dev.generateReport` writes `JARVIS_EXECUTION_REPORT.md` with SHA-256 digests.
- **Verification Evidence:** Validated in `test/acceptance/expenseTrackerAcceptance.test.ts` (7/7 Python tests pass in 0.017s, exit code 0).

### 3.4 Workflow D — Existing Project Audit & Repair
- **Instruction:** *"Inspect this project, identify incomplete features and create a prioritized implementation roadmap."*
- **Execution Flow:**
  1. Discovers `D:\ProjectHub`, inspecting package manifests and code structure.
  2. Identifies stubbed function `calculateProjectMetrics` in `src/projectHub.js`.
  3. Applies targeted patch with automatic `.jarvis.bak` backup.
  4. Executes `npm test` verifying that the regression suite passes.
  5. Generates an evidence-backed roadmap and repair log.
- **Verification Evidence:** Validated in `test/acceptance/autonomousAcceptance.test.ts` (Test 1).

### 3.5 Workflow E — Desktop and Browser Coordination
- **Instruction:** *"Open the browser, research the requested information, save the findings in a local document and show me the result."*
- **Execution Flow:**
  1. `desktop.listWindows` discovers active desktop applications.
  2. Native agent launches Playwright Chromium browser (`browser.newTab`).
  3. Navigates to target URL, enforcing strict SSRF blocking against loopback and cloud metadata.
  4. Extracts page DOM text and captures full-page screenshot with verified PNG magic header.
  5. Ingests extracted content into local `DocumentStore` for indexed retrieval.
- **Verification Evidence:** Validated in `test/acceptance/realBrowserPlaywright.test.ts` and `test/acceptance/browserAcceptance.test.ts`.

### 3.6 Workflow F — Long-Running Autonomous Task
- **Instruction:** *"Complete this multi-step task and notify me when the verified result is ready."*
- **Execution Flow:**
  1. Creates durable task record on backend disk (`server/data/tasks/`).
  2. Background execution runs independently of the frontend HUD.
  3. Checkpoints state after every verified subtask.
  4. Survives simulated backend process crashes; resumes from next pending step without repetition.
  5. Forceful process termination (`ChildProcessRegistry.killProcessTree`) cleanly reaps orphaned processes.
- **Verification Evidence:** Validated in `test/acceptance/autonomousAcceptance.test.ts` (Test 2 & 3) and `test/regression/backendTaskOwnership.regression.test.ts`.

---

## 4. Verification Summary

| Scenario | Workflow Domain | Test Suite Reference | Result |
|---|---|---|---|
| **Workflow A** | Research to Presentation | `test/unit/researchEngine.test.ts` | **PASS** |
| **Workflow B** | Spreadsheet to Decisions | `test/acceptance/masterMissionAcceptance.test.ts` | **PASS** |
| **Workflow C** | Autonomous Software Dev | `test/acceptance/expenseTrackerAcceptance.test.ts` | **PASS** |
| **Workflow D** | Existing Project Audit | `test/acceptance/autonomousAcceptance.test.ts` | **PASS** |
| **Workflow E** | Desktop and Browser | `test/acceptance/realBrowserPlaywright.test.ts` | **PASS** |
| **Workflow F** | Long-Running Background Task | `test/acceptance/autonomousAcceptance.test.ts` | **PASS** |

**Phase 13 Verdict:** All six autonomous workflow scenarios are operational, verified with real side effects, and guarded against silent failures.

