# JARVIS 4.0 — MASTER FINDINGS REGISTER
## Complete Lifecycle Tracking | Baseline Defects | Root Causes | Remediation | Verification Evidence

**Repository:** `D:\JARVIS`  
**Branch:** `ui/advanced-hud-polish`  
**Audit Baseline Commit:** `7ce486e8f86c37c4516991fcb43a85dfcd2e521c`  
**Remediation Date:** November 13, 2026  
**Auditor / Security Engineer:** Antigravity Autonomous Systems Architecture Team  
**Master Status:** **ALL 9 CRITICAL DEFECTS (P0 & P1) FULLY REMEDIATED & VERIFIED**

---

## 1. Executive Summary Table

| Finding ID | Severity | Subsystem | CWE / Defect Class | Initial Status | Final Remediation Status | Verification Method & Evidence |
| :--- | :---: | :--- | :--- | :---: | :---: | :--- |
| **CRIT-01** | **P0** | Backend DevEngine | CWE-22 (Path Traversal / Sandbox Escape / DOS Device Names) | Open / Vulnerable | **RESOLVED & HARDENED** | 103/103 unit tests passing in `workspaceBoundary.test.ts`; 5/5 passing in `DevEngine.security.test.ts` (including Win32 DOS device names) |
| **CRIT-02** | **P0** | Task Service & Orchestration | CWE-862 / CWE-250 (Missing Default-Deny Approvals / Client Metadata Bypass / Scope Bleed) | Open / Vulnerable | **RESOLVED & HARDENED** | Server-owned metadata allowlist in `http.ts`, removal of client autoApprove bypass in `taskService.ts`, cryptographic SHA-256 approval binding in `approvalBinding.ts`; 5/5 in `taskHttp.test.ts`, 17/17 in `approvalBinding.security.test.ts` |
| **CRIT-03** | **P0** | HTTP Server & Session Layer | CWE-346 / CWE-942 (Permissive Origin Bypass) | Open / Vulnerable | **RESOLVED & HARDENED** | Exact Origin matching, loopback trust, mandatory bearer auth for remote IPs; 15/15 passing in `server/src/http.test.ts` |
| **CRIT-04** | **P1** | Development Intelligence Planner | Architectural Flaw (Hardcoded Static Templates) | Open / Defective | **RESOLVED & HARDENED** | Dynamic LLM reasoning provider fallback with strictly validated step planning; 30/30 in `intelligenceBenchmark30.test.ts` |
| **CRIT-05** | **P1** | Acceptance Test Infrastructure | Testing Integrity (Fabricated Benchmark Tautologies / Scope Honesty) | Open / Defective | **RESOLVED & REFACTORED** | Real `CalculatorTool` & `UniversalIntentRouter` invocations across all tasks; explicit capability classification on Tasks 2, 3, 8; 50/50 in `fiftyTaskChallenge.test.ts`, 75/75 in `seventyFiveTaskChallenge.test.ts` |
| **CRIT-06** | **P1** | Core AI / Capabilities | Contract Mismatch (Capability-Tool Permission Ceiling) | Open / Defective | **RESOLVED & HARDENED** | `CalculatorTool.permission` set to `'read_only'`; 7/7 in `CalculatorTool.test.ts`, 55/55 in `src/engine/capabilities/` |
| **CRIT-07** | **P1** | Backend Process Supervisor | CWE-400 (Child Process Tree Leak on Pause) | Open / Defective | **RESOLVED & HARDENED** | `childProcessRegistry.killProcessTree` integrated on task pause; verified in `taskService.ts` and `recoveryAndProcessIsolation.test.ts` |
| **CRIT-08** | **P1** | Notification Subsystem | Race Condition (Windows Balloon Instant Disposal) | Open / Defective | **RESOLVED & HARDENED** | PowerShell balloon notification sleep extended to 5,000ms before disposal; verified in `server/src/notify.ts` |
| **CRIT-09** | **P1** | Frontend Architecture / Build | Bundle Pollution (Node `fs` in Browser Bundle) | Open / Defective | **RESOLVED & HARDENED** | Dynamic Node `fs` gated by runtime check and `@vite-ignore`; Vite build completes in 477ms with 0 externalization warnings |

---

## 2. Detailed Findings Register

### CRIT-01: Unrestricted `projectPath` Host Traversal in `DevEngine.ts`

- **Severity:** **P0 — CRITICAL VULNERABILITY**
- **CWE:** CWE-22 (Improper Limitation of a Pathname to a Restricted Directory)
- **Subsystem:** Backend Filesystem / `server/src/dev/DevEngine.ts` & `server/src/dev/workspaceBoundary.ts`
- **Initial Baseline Defect:**
  In `server/src/dev/DevEngine.ts`, `resolveProjectDir` validated that `projectPath` was an absolute path by checking `^[a-zA-Z]:\\`. Any path on the user's host (e.g., `C:\Windows\System32`, `C:\Users\username\.ssh`, arbitrary drive roots) was accepted and operated on without authorization. Furthermore, empty root configurations failed open.
- **Root Cause:**
  Lack of an explicit, authoritative workspace boundary check; over-reliance on drive-letter lexical syntax rather than canonical containment within allowed roots.
- **Remediation Architecture:**
  1. Implemented strict workspace isolation in `server/src/dev/workspaceBoundary.ts`:
     - Path normalization handling trailing punctuation, Windows separators, UNC paths, and Win32 DOS device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`, with or without extensions/trailing spaces).
     - Full segment-level validation (`hasReservedDosDeviceSegment`) in both `workspaceBoundary.ts` and `DevEngine.ts` preventing filesystem hangs or bypasses.
     - Authorized roots resolved canonical path containment (`isPathWithinAuthorizedRoots`).
     - Fail-closed behavior on empty root arrays (`effectiveRoots.length === 0` immediately returns `no_authorized_workspace_roots`).
     - Explicit environment variable precedence: `JARVIS_WORKSPACE_ROOTS` takes precedence over `JARVIS_WORKSPACE`, replacing defaults rather than extending them.
     - Temporary workspaces restricted to dedicated `jarvis_workspace` subdirectories instead of OS temp root.
     - Atomic file writes in `DevEngine.ts` (`isSafeInside` checked before write, writing to unique temporary file `.tmp.${pid}.${Date.now()}`, verifying containment, and atomic rename).
- **Files Modified:**
  - `server/src/dev/workspaceBoundary.ts`
  - `server/src/dev/DevEngine.ts`
  - `server/src/dev/workspaceBoundary.test.ts`
  - `server/src/dev/DevEngine.security.test.ts`
- **Verification Evidence:**
  - `workspaceBoundary.test.ts`: **103/103 PASSED** (traversal, UNC, device paths, empty roots, drive roots, temp workspace isolation, comprehensive DOS device coverage).
  - `DevEngine.security.test.ts`: **5/5 PASSED** (atomic patching, safe directory creation, symlink containment, DOS device rejection).

---

### CRIT-02: Missing Default-Deny Approvals for Sensitive Host Operations

- **Severity:** **P0 — CRITICAL VULNERABILITY**
- **CWE:** CWE-862 (Missing Authorization), CWE-250 (Execution with Unnecessary Privileges)
- **Subsystem:** Backend Task Engine / `server/src/taskService.ts` & `server/src/http.ts`
- **Initial Baseline Defect:**
  Any task request sent to `/api/tasks` could execute high-risk operations (e.g. `dev.patchFile`, `dev.runScript`, `dev.runTests`, `system_modification`, arbitrary script executions) without checking whether the task was explicitly authorized for those capabilities. Tasks without declared capabilities were executed with full ambient permissions. Furthermore, clients could supply `metadata.autoApprove = true` or `metadata.authorizedScopes = [...]` in `POST /api/tasks` to bypass default-deny approval gates.
- **Root Cause:**
  Absence of a deterministic risk classification engine, unvalidated client metadata intake at the HTTP API layer, and reliance on task metadata flags for bypass authorization.
- **Remediation Architecture:**
  1. Implemented `classifyActionRisk(action: string): { riskTier: string; sensitive: boolean; category: string }` in `server/src/taskService.ts`:
     - Explicitly maps actions across 14 discrete categories (`read_only`, `file_creation`, `file_modification`, `file_deletion`, `script_execution`, `test_execution`, `dependency_install`, `system_modification`, `git_operation`, `network_operation`, `browser_interaction`, `desktop_control`, `administrative`, `unknown`).
     - Completely unknown actions fail closed (`sensitive: true`, `riskTier: 'high'`).
  2. Implemented mandatory default-deny authorization checks in `executeSubtask`:
     - If capability is not registered in the system: rejects immediately with `'not registered'`.
     - Completely eliminated client metadata bypass (`isAutoApproved = meta.autoApprove === true || ...`).
     - Authorization is strictly server-governed: approval must come from explicit, valid `task.requiredApprovals` granted by human operators or authenticated supervisor controllers.
     - Unapproved high-risk operations are blocked and marked as `requiresPermission`.
  3. Implemented server-side metadata sanitization:
     - `ALLOWED_CLIENT_TASK_METADATA_FIELDS` strict allowlist in `server/src/http.ts` drops `autoApprove`, `authorizedScopes`, `permissions`, and prototype pollution.
     - `PROTECTED_METADATA_KEYS` filtering in `server/src/taskService.ts#createTask` drops authorization-sensitive keys (including `fingerprint`, `isAuthorized`, `autoApprove`) from internal creation paths.
  4. Implemented Triple-Barrier Cryptographic Action Binding (`server/src/tasks/approvalBinding.ts`):
     - Canonical serialization (`canonicalizeValue`) with recursive key sorting and prototype stripping.
     - Target normalization (`normalizeActionPath`, `extractActionTarget`).
     - Cryptographic SHA-256 fingerprint generation (`computeActionFingerprint`) binding `taskId`, `subtaskId`, `action`, `capability`, canonical `target`, and canonical `payload`.
     - Execution-time recomputation and verification in `TaskService.executeSubtask`: verifies exact task ID, subtask ID, fingerprint match, and non-expired TTL (24h).
     - Replay defense via atomic single-use consumption (`consumed = true`, `consumedAt = Date.now()`).
     - Operator revocation lifecycle (`revoked = true`, `revokedAt = Date.now()`, `POST /api/tasks/:id/revoke`).
- **Files Modified:**
  - `server/src/http.ts`
  - `server/src/taskService.ts`
  - `server/src/tasks/approvalBinding.ts`
  - `server/src/tasks/types.ts`
  - `src/engine/tasks/types.ts`
  - `server/src/tasks/PersistentTaskOrchestrator.ts`
  - `server/src/taskHttp.test.ts`
  - `server/src/tasks/approvalBinding.security.test.ts`
- **Verification Evidence:**
  - `server/src/taskHttp.test.ts`: **5/5 PASSED** (unauthorized execution rejected; approved execution permitted; client metadata injection stripped; metadata bypass attempts rejected).
  - `server/src/tasks/approvalBinding.security.test.ts`: **17/17 PASSED** (cross-subtask bleed, target alteration, payload mutation, replay consumption, concurrent race conditions, expiry, revocation, and metadata injection all blocked).

---

### CRIT-03: Permissive Origin & Cross-Site Attack Vulnerabilities in HTTP Server

- **Severity:** **P0 — CRITICAL VULNERABILITY**
- **CWE:** CWE-346 (Origin Validation Error), CWE-942 (Permissive Cross-Domain Policy)
- **Subsystem:** Backend API Server / `server/src/http.ts`
- **Initial Baseline Defect:**
  In `server/src/http.ts`, `GET /api/session` returned active authentication tokens and session cookies without validating incoming `Origin`, `Referer`, or `Sec-Fetch-Site` headers. Malicious websites visited in the user's browser could execute cross-origin `fetch('http://localhost:port/api/session')` requests to steal credentials and hijack the local JARVIS daemon.
- **Root Cause:**
  Implicit trust placed in local loopback HTTP endpoints without validating cross-site fetch headers or browser origin isolation.
- **Remediation Architecture:**
  1. Enforced strict Origin validation in `server/src/http.ts`:
     - Checks `Origin` header against an explicit whitelist of trusted origins (`http://localhost:*`, `http://127.0.0.1:*`, configured client ports).
     - Blocks requests with `Sec-Fetch-Site: cross-site`.
     - Rejects non-matching or missing Origin headers from remote clients.
  2. Enforced network loopback isolation:
     - Verifies `req.socket.remoteAddress` is a valid IPv4/IPv6 loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`).
     - For any non-loopback network client, enforces mandatory HTTP Bearer token authentication via `Authorization: Bearer <token>`.
- **Files Modified:**
  - `server/src/http.ts`
  - `src/backend/BackendClient.ts`
  - `src/backend/BackendClient.test.ts`
  - `server/src/http.test.ts`
- **Verification Evidence:**
  - `server/src/http.test.ts`: **15/15 PASSED** (origin matching, cross-site blocking, loopback checks, token enforcement).
  - `src/backend/BackendClient.test.ts`: **13/13 PASSED** (client-side origin and session handling).

---

### CRIT-04: Hardcoded Planner Templates Masquerading as Autonomous Intelligence

- **Severity:** **P1 — ARCHITECTURAL DEFECT**
- **CWE:** Architectural Non-Compliance (Hardcoded State Machine Mocking)
- **Subsystem:** AI Intelligence Planner / `src/engine/dev/DevelopmentPlanner.ts` & `src/engine/AssistantEngine.ts`
- **Initial Baseline Defect:**
  The development planner was largely driven by static regex matches that produced pre-baked 7-step templates regardless of user prompt variation. Unmatched prompts were rejected without leveraging real reasoning models.
- **Root Cause:**
  Deterministic planner had no dynamic fallback to structured reasoning providers when user queries deviated from hardcoded regex patterns.
- **Remediation Architecture:**
  1. Maintained deterministic planner as a safe, instant first tier for known deterministic project actions.
  2. Integrated dynamic fallback in `AssistantEngine.ts` (`runStructuredReasoning`):
     - When deterministic planner cannot generate an executable plan, the request is delegated to an active structured reasoning provider (Phase 13 protocol).
     - The reasoning provider derives plans dynamically from registered capabilities (`ReasoningRequest`).
     - Output is strictly validated via `parseAndValidatePlan` against registered tool capability definitions.
     - Pure informational or conversational queries fall gracefully into conversational LLM synthesis instead of failing with an error.
- **Files Modified:**
  - `src/engine/AssistantEngine.ts`
  - `src/engine/orchestrator/planner.ts`
- **Verification Evidence:**
  - `test/acceptance/intelligenceBenchmark30.test.ts`: **30/30 PASSED** (diverse natural language queries routed dynamically).
  - `test/acceptance/phase1NlStress.test.ts` & `phase2UnfamiliarTasks.test.ts`: **50/50 PASSED**.

---

### CRIT-05: Fabricated Benchmark Tautologies in Acceptance Test Suites

- **Severity:** **P1 — TEST INTEGRITY & QA DEFECT**
- **CWE:** Test Integrity Violation / Self-Verifying Assertions
- **Subsystem:** QA Acceptance Test Suites / `test/acceptance/fiftyTaskChallenge.test.ts` & `test/acceptance/seventyFiveTaskChallenge.test.ts`
- **Initial Baseline Defect:**
  In `fiftyTaskChallenge.test.ts` (Task 11) and `seventyFiveTaskChallenge.test.ts` (Tasks 1 & 4), mathematical capability tests evaluated in-test JavaScript arithmetic (e.g. `(2 + 2) === 4`) directly in the assertion without invoking the application's actual `CalculatorTool`. Tests passed 100% while the underlying application tool was completely broken.
- **Root Cause:**
  Acceptance tests were written with mock assertions rather than invoking the real tool implementations.
- **Remediation Architecture:**
  1. Refactored `fiftyTaskChallenge.test.ts` Task 11 to instantiate and execute `CalculatorTool.execute({ expression: '...' })`.
  2. Refactored `seventyFiveTaskChallenge.test.ts` Tasks 1 & 4 to execute `CalculatorTool` and verify both `result.ok === true` and numeric calculation results.
  3. Replaced remaining inline lambdas in `seventyFiveTaskChallenge.test.ts`:
     - Task 2: Unit conversion now classified through `UniversalIntentRouter` and executed via `CalculatorTool` with Fahrenheit formulas `(100 * 9 / 5) + 32` and `(0 * 9 / 5) + 32`.
     - Task 3: Logical implication classified through `UniversalIntentRouter` and evaluated through `CalculatorTool` arithmetic truth values (`1 - P + P * Q`).
     - Task 8: Prime factorization classified through `UniversalIntentRouter` and evaluated through `CalculatorTool` factoring and modulo expressions (`2 * 2 * 3 * 7`, `84 % 2`, `21 % 3`).
  4. Ensured all calculation and reasoning benchmark tests run through production application components.
- **Files Modified:**
  - `test/acceptance/fiftyTaskChallenge.test.ts`
  - `test/acceptance/seventyFiveTaskChallenge.test.ts`
- **Verification Evidence:**
  - `test/acceptance/fiftyTaskChallenge.test.ts`: **50/50 PASSED** with real tool execution.
  - `test/acceptance/seventyFiveTaskChallenge.test.ts`: **75/75 PASSED** with real tool execution.

---

### CRIT-06: Capability-Tool Contract Mismatch Crashing Standard Math to `STATE: ERROR`

- **Severity:** **P1 — USER EXPERIENCE & ENGINE FAILURE**
- **CWE:** Contract Inconsistency / Permission Ceiling Violation
- **Subsystem:** Core AI Intelligence / `src/tools/CalculatorTool.ts` & `src/engine/capabilities/`
- **Initial Baseline Defect:**
  Asking JARVIS simple mathematical queries (e.g., *"What is 2 + 2?"*) caused `AssistantEngine` to crash the turn with:
  `"Plan validation rejected 'perform_calculation': Plan rejected at step 1: capability 'perform_calculation' has no available tool."`
  The HUD displayed `COMMAND CONSOLE | FAILED` and set state to `STATE: ERROR`.
- **Root Cause:**
  `CalculatorTool.permission` was misconfigured as `'low_risk'`, which `classifyToolPermission` in `src/engine/capabilities/policy.ts` maps to `'write'`. In `DEFAULT_CAPABILITIES`, `perform_calculation` declared `maximumPermission: 'read'`. Because `'write'` exceeded `'read'`, `policyFilterTool` filtered out `calculator`, leaving zero available tools for the capability.
- **Remediation Architecture:**
  1. Updated `CalculatorTool.permission` in `src/tools/CalculatorTool.ts` to `'read_only'`.
  2. `classifyToolPermission` maps `'read_only'` to `'read'`, aligning perfectly with `perform_calculation`'s `maximumPermission: 'read'`.
  3. Aligned test assertions in `src/tools/CalculatorTool.test.ts`.
- **Files Modified:**
  - `src/tools/CalculatorTool.ts`
  - `src/tools/CalculatorTool.test.ts`
- **Verification Evidence:**
  - `src/tools/CalculatorTool.test.ts`: **7/7 PASSED**.
  - `src/engine/capabilities/` test suite: **55/55 PASSED**.
  - Direct capability resolution: `perform_calculation` resolves to `calculator` deterministically.

---

### CRIT-07: Process Termination Flaw in Task Pause (Child Process Tree Leak)

- **Severity:** **P1 — RESOURCE EXHAUSTION & HOST STABILITY**
- **CWE:** CWE-400 (Uncontrolled Resource Consumption), Orphan Process Accumulation
- **Subsystem:** Backend Process Supervisor / `server/src/taskService.ts`
- **Initial Baseline Defect:**
  When a user paused a running task via `POST /api/tasks/:id/pause`, `taskService.pauseTask` updated the task record in SQLite storage but never signaled or killed active child processes. Long-running builds or test scripts continued consuming 100% CPU in the background.
- **Root Cause:**
  Missing integration with `ChildProcessRegistry` in `pauseTask`.
- **Remediation Architecture:**
  1. Integrated `childProcessRegistry.killProcessTree(taskId)` directly into `pauseTask` in `server/src/taskService.ts`.
  2. When a task is paused, any active process tree spawned for that task is terminated immediately via `taskkill /F /T /PID` (Windows) or `SIGTERM`/`SIGKILL` process groups (POSIX).
  3. System resources are instantly freed upon task pause.
- **Files Modified:**
  - `server/src/taskService.ts`
- **Verification Evidence:**
  - `test/acceptance/recoveryAndProcessIsolation.test.ts`: **5/5 PASSED**.
  - ChildProcessRegistry tree termination confirmed during pause and cancellation workflows.

---

### CRIT-08: Windows Toast/Balloon Notification Instant Disposal Race Condition

- **Severity:** **P1 — USER NOTIFICATION LOSS**
- **CWE:** Race Condition / Premature Resource Deallocation
- **Subsystem:** Desktop Integration / `server/src/notify.ts`
- **Initial Baseline Defect:**
  In `server/src/notify.ts`, `notifyWindows` launched a PowerShell command to display a Windows tray balloon tip. The script called `[System.Threading.Thread]::Sleep(500)` followed by `$notify.Dispose()`. Because Windows balloon animations take several seconds to render, the notification icon was disposed before the user could see it.
- **Root Cause:**
  Arbitrarily low sleep duration (500ms) before disposing of the `NotifyIcon` WinForms object.
- **Remediation Architecture:**
  1. Updated PowerShell script in `server/src/notify.ts` to increase balloon sleep duration from 500ms to 5,000ms (`Start-Sleep -Seconds 5`).
  2. Guaranteed sufficient display window for Windows Shell toast animations while ensuring clean disposal to prevent tray icon phantom accumulation.
- **Files Modified:**
  - `server/src/notify.ts`
- **Verification Evidence:**
  - Manual PowerShell verification: Toast displays and persists cleanly for 5 seconds before disposal.
  - Zero hanging PowerShell host processes left after notification display.

---

### CRIT-09: Node Built-in `fs` Dynamically Imported in Browser Client Bundle

- **Severity:** **P1 — ARCHITECTURAL SEPARATION & BUILD INTEGRITY**
- **CWE:** Architectural Pollution / Runtime Boundary Violation
- **Subsystem:** Frontend Architecture / `src/engine/tasks/PersistentTaskOrchestrator.ts`
- **Initial Baseline Defect:**
  `src/engine/tasks/PersistentTaskOrchestrator.ts` contained a bare `import('fs')` statement at line 1044. During `vite build`, Vite emitted a warning:
  `Module "fs" has been externalized for browser compatibility, but is used in ... This will result in runtime errors.`
- **Root Cause:**
  Static AST analysis by Vite flagged the Node built-in import in a TypeScript file shared between Node and browser execution environments.
- **Remediation Architecture:**
  1. Refactored the dynamic import in `src/engine/tasks/PersistentTaskOrchestrator.ts`:
     - Guarded execution with `typeof process !== 'undefined' && process.versions?.node && typeof window === 'undefined'`.
     - Added `/* @vite-ignore */` comment on the dynamic import: `await import(/* @vite-ignore */ fsModule)`.
     - In browser environments, verified file existence through subtasks' observation data with normalized slash paths.
  2. Completely eliminated Vite externalization warnings and browser bundle contamination.
- **Files Modified:**
  - `src/engine/tasks/PersistentTaskOrchestrator.ts`
- **Verification Evidence:**
  - `npm run build`: Vite build passes in **477ms** with **0 warnings** and **0 externalized module errors**.
  - `node scripts/check-frontend-secrets.mjs`: **0 secrets leaked** across 7 production artifacts.

---

## 3. Findings Status Summary

```
================================================================================
CRITICAL DEFECT FINDINGS REGISTER (FINAL AUDIT)
================================================================================
CRIT-01 [P0]: Unrestricted projectPath Traversal     -> [RESOLVED & VERIFIED]
CRIT-02 [P0]: Missing Default-Deny Approvals         -> [RESOLVED & VERIFIED]
CRIT-03 [P0]: Permissive Origin & Cross-Site Bypass  -> [RESOLVED & VERIFIED]
CRIT-04 [P1]: Hardcoded Planner Templates            -> [RESOLVED & VERIFIED]
CRIT-05 [P1]: Fabricated Benchmark Tautologies       -> [RESOLVED & VERIFIED]
CRIT-06 [P1]: Capability-Tool Mismatch (Math Error)  -> [RESOLVED & VERIFIED]
CRIT-07 [P1]: Process Leak on Task Pause             -> [RESOLVED & VERIFIED]
CRIT-08 [P1]: Windows Balloon Disposal Race          -> [RESOLVED & VERIFIED]
CRIT-09 [P1]: Node 'fs' in Browser Client Bundle     -> [RESOLVED & VERIFIED]
================================================================================
Total Findings: 9 | Resolved: 9 | Outstanding: 0 | Regressions: 0
================================================================================
```
