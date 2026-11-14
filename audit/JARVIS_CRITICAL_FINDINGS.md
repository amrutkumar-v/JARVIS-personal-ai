# JARVIS 4.0 — CRITICAL FINDINGS & DEFECT DOSSIER
## Comprehensive Engineering Audit | Defect Severity Classification: P0 & P1

**Audit Target:** JARVIS 4.0 (`D:\JARVIS`)  
**Git Branch:** `ui/advanced-hud-polish`  
**Git Commit HEAD:** `7ce486e Working`  
**Audit Date:** November 13, 2026  
**Auditor:** Independent Principal Systems & Security Auditor  

---

## 1. Executive Summary of Critical Vulnerabilities & Defects

During the rigorous, evidence-based code and runtime audit of JARVIS 4.0, **nine (9) critical defects** were identified, categorized into **three (3) P0 (Critical Security / Safety Vulnerabilities)** and **six (6) P1 (Major Autonomy, Architectural & Operational Flaws)**.

| Defect ID | Severity | Subsystem | Title | Status |
| :--- | :---: | :--- | :--- | :---: |
| **CRIT-01** | **P0** | DevEngine / Security | Unrestricted `projectPath` Traversal Allowing System-Wide Writes & Code Execution | Confirmed |
| **CRIT-02** | **P0** | TaskService / Security | Missing Default-Deny Approvals for Sensitive Dev Actions (`patchFile`, `runTests`) | Confirmed |
| **CRIT-03** | **P0** | HTTP / Authentication | Session Cookie Handout without CSRF or Origin Enforcement on `GET /api/session` | Confirmed |
| **CRIT-04** | **P1** | DevelopmentPlanner | Hardcoded Deterministic Code Templates & Benchmark Prompt Sniffing | Confirmed |
| **CRIT-05** | **P1** | Testing Infrastructure | Fabricated Autonomy Acceptance Benchmarks with In-Test Helper Tautologies | Confirmed |
| **CRIT-06** | **P1** | Core Conversational Engine | Capability-Tool Mismatch (`perform_calculation`) Crashing Standard Math to `STATE: ERROR` | Confirmed |
| **CRIT-07** | **P1** | Task Lifecycle | Process Termination Flaw in Task Pause (Child Process Leak) | Confirmed |
| **CRIT-08** | **P1** | Notifications | Windows Toast/Balloon Notification Instant Disposal Race Condition | Confirmed |
| **CRIT-09** | **P1** | Frontend Architecture | Node Built-in `fs` Dynamically Imported in Browser Client Bundle | Confirmed |

---

## 2. P0 Defects (Critical Security & Safety Vulnerabilities)

### CRIT-01: Unrestricted `projectPath` Traversal in `DevEngine.ts`
- **Subsystem:** Backend / `server/src/dev/DevEngine.ts` (Lines 54-57, 126-140)
- **Severity:** **P0 — CRITICAL VULNERABILITY**
- **CWE:** CWE-22 (Improper Limitation of a Pathname to a Restricted Directory / Path Traversal)
- **Mechanism:**
  In `server/src/dev/DevEngine.ts`, `resolveProjectDir` validates that `projectPath` is an absolute path using:
  ```typescript
  function isAbsoluteProjectPath(value: string): boolean {
    if (process.platform === 'win32') return /^[a-zA-Z]:\\/.test(value)
    return isAbsolute(value)
  }
  ```
  The function only checks if the string matches an absolute drive pattern (`^[a-zA-Z]:\\`). It enforces **no allowlist, no workspace boundary, and no user confirmation of the target root**. While `isSafeInside(baseDir, candidate)` prevents escaping outside `projectPath`, the caller can set `projectPath` to any directory on the host:
  - `C:\Windows\System32`
  - `C:\Users\<User>\AppData`
  - `C:\Users\<User>\.ssh`
  Once `projectPath` is pointed to a sensitive root, `DevEngine.patchFile` can create or overwrite files in that directory, and `DevEngine.runTests` or `runScript` will execute scripts inside that context.
- **Evidence:**
  Verified during audit via `scratch/run_dev_engine_audit.mjs`. When passing `D:\JARVIS\audit\evidence\test_project`, the engine created directories, wrote files, and spawned subprocesses without any boundary validation against an allowed workspace list.
- **Impact:**
  Arbitrary file creation, modification, and code execution across any directory accessible to the Node.js process user.
- **Remediation:**
  1. Introduce an explicit `ALLOWED_WORKSPACE_ROOTS` configuration in `server/src/config.ts`.
  2. Reject any `projectPath` that does not resolve within the configured workspace roots.
  3. Require explicit operator confirmation via approval workflow before any new project root is registered.

---

### CRIT-02: Missing Default-Deny Approvals for Sensitive Dev Actions
- **Subsystem:** Backend / `server/src/taskService.ts` (Lines 180-192) & `server/src/dev/DevEngine.ts`
- **Severity:** **P0 — HIGH-RISK AUTONOMY DEFECT**
- **CWE:** CWE-862 (Missing Authorization / Dangerous Action Gate)
- **Mechanism:**
  In `server/src/taskService.ts`, permission approval requests are triggered using a simplistic string check:
  ```typescript
  const isSensitive = 
    payload.action?.includes('delete') ||
    payload.action?.includes('destroy') ||
    payload.action?.includes('sensitive') ||
    payload.action?.endsWith('.deleteProbe');
  ```
  Consequently, actions such as `dev.patchFile` (which writes arbitrary code to disk), `dev.createFile`, and `dev.runTests` (which executes arbitrary test scripts via `npx vitest` or `node`) **never match `isSensitive`**. They are executed immediately without operator approval, even if the task was initiated from an untrusted remote or conversational context.
- **Evidence:**
  `run_dev_engine_audit.mjs` executed `dev.patchFile` and `dev.runTests` repeatedly with zero approval prompts or blocked states.
- **Impact:**
  Silent modification of source files and unattended execution of arbitrary commands under the guise of "autonomous development".
- **Remediation:**
  1. Adopt a strict **default-deny** policy for all write and execute operations.
  2. Classify `dev.patchFile`, `dev.createFile`, and `dev.runTests` as `HIGH_RISK` actions requiring explicit approval or explicit per-session policy grants.

---

### CRIT-03: Session Cookie Handout without CSRF or Origin Enforcement
- **Subsystem:** Backend / `server/src/http.ts` (Lines 352-378)
- **Severity:** **P0 — SECURITY VULNERABILITY**
- **CWE:** CWE-352 (Cross-Site Request Forgery / Unvalidated Origin)
- **Mechanism:**
  In `server/src/http.ts`, the endpoint `GET /api/session` issues a session cookie (`jarvis_session`):
  ```typescript
  const rawOrigin = req.headers['origin']
  if (rawOrigin !== undefined) {
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin
    if (!allowedOrigins.has(origin)) {
      sendJson(res, 403, { error: 'origin_not_allowed' })
      return
    }
  }
  ```
  If an attacker sends a request from a tool, curl, or standard link without an `Origin` header (`rawOrigin === undefined`), the entire origin check is bypassed. The server automatically generates a session, sets the cookie, and returns `{ ok: true, session: ... }`.
- **Evidence:**
  Probed live via curl:
  ```powershell
  curl http://127.0.0.1:8787/api/session
  ```
  Returned HTTP 200 with `Set-Cookie: jarvis_session=...` and active session tokens with zero authentication or origin header.
- **Impact:**
  Attackers on the local network or malicious web pages using simple GET navigations can obtain valid session identifiers and interact with unauthenticated endpoints.
- **Remediation:**
  1. Enforce that `GET /api/session` requires either an authenticated token, a pre-shared local secret, or a strict loopback check.
  2. Do not bypass origin checks when `Origin` or `Referer` headers are omitted on cross-origin eligible requests.

---

## 3. P1 Defects (Major Autonomy, Architectural & Operational Flaws)

### CRIT-04: Hardcoded Deterministic Code Templates & Benchmark Sniffing
- **Subsystem:** Autonomous Agent / `server/src/dev/DevelopmentPlanner.ts` (Lines 18-95) & `src/engine/dev/DevelopmentPlanner.ts`
- **Severity:** **P1 — AUTONOMY DECEPTION**
- **Mechanism:**
  The `DevelopmentPlanner` advertises autonomous software development capabilities. In reality, the planning logic consists of **regex pattern matching against specific benchmark strings** and injecting pre-written, hardcoded code templates:
  - If the goal contains `circle` / `circumference`: It injects `CIRCLE_IMPLEMENTATION` and `CIRCLE_TESTS`.
  - If the goal contains `expense` / `tracker`: It injects `EXPENSE_TRACKER_IMPLEMENTATION` and `EXPENSE_TRACKER_TESTS`.
  - If the goal contains `projectHub`: It performs hardcoded string replacement for `calculateProjectMetrics`.
  - For general prompts: It looks for trivial regex matches like `print\((.*?)\)` and injects stubbed code.
- **Evidence:**
  `server/src/dev/DevelopmentPlanner.ts`:
  ```typescript
  const CIRCLE_IMPLEMENTATION = `class Circle {\n  constructor(radius) {\n    if (radius < 0) throw new Error('Radius cannot be negative');\n...`;
  const EXPENSE_TRACKER_IMPLEMENTATION = `class ExpenseTracker {\n...`;
  ```
- **Impact:**
  JARVIS cannot autonomously develop novel software or reason through arbitrary engineering specifications; it relies on hardcoded solutions specifically tailored to pass developer demo benchmarks.
- **Remediation:**
  Integrate `DevelopmentPlanner` with the live LLM provider (`Gemini` / `Ollama`) with strict AST generation, iterative compilation loops, and prompt-driven synthesis, deprecating hardcoded string templates.

---

### CRIT-05: Fabricated Acceptance Benchmarks in Test Suite
- **Subsystem:** Acceptance Testing / `test/acceptance/fiftyTaskChallenge.test.ts` & `seventyFiveTaskChallenge.test.ts`
- **Severity:** **P1 — TEST INTEGRITY VIOLATION**
- **Mechanism:**
  Inspection of the "50 Task Challenge" and "75 Task Challenge" benchmark suites revealed that many tasks claiming to evaluate JARVIS's autonomous intelligence do not call JARVIS, its engine, or any agent subsystem. Instead, the test suite defines **inline JavaScript functions directly inside the test file** and immediately asserts on them:
  ```typescript
  // seventyFiveTaskChallenge.test.ts Line 110
  test('task 12: calculate circle area', () => {
    const area = (r: number) => Math.PI * r * r;
    expect(area(0)).toBe(0);
    expect(area(2)).toBeCloseTo(12.566, 2);
  });
  ```
  The test passes instantly because it is testing JavaScript's built-in math operators, not JARVIS's ability to solve problems.
- **Evidence:**
  Direct code inspection of `test/acceptance/seventyFiveTaskChallenge.test.ts` (Lines 100-350) and `test/acceptance/fiftyTaskChallenge.test.ts`. Over 30 tasks are inline JavaScript lambdas asserting trivial arithmetic, string reversals, and array sorts.
- **Impact:**
  Test metrics claiming "75/75 autonomous tasks passed" are misleading and misrepresent system capabilities.
- **Remediation:**
  Refactor all benchmark tests to route through `AssistantEngine.process()` or `DevEngine.execute()`, verifying real multi-turn agent execution and persistent outputs.

---

### CRIT-06: Capability-Tool Mismatch Crashing Standard Math to `STATE: ERROR`
- **Subsystem:** Core AI Intelligence / `src/engine/capabilities/defaults.ts` & `src/engine/orchestrator/`
- **Severity:** **P1 — USER EXPERIENCE & CONVERSATIONAL FAILURE**
- **Mechanism:**
  When a user asks a simple mathematical or quantitative question (e.g., *"What is 2 + 2? Answer in one word."*):
  1. `UniversalIntentRouter` classifies the intent as requiring `perform_calculation`.
  2. `DEFAULT_CAPABILITIES` defines `perform_calculation` with `tools: ['calculator']`.
  3. The bounded planner creates a plan step calling `perform_calculation`.
  4. `AssistantEngine` runs preflight validation via `validatePlan()`.
  5. `resolveCapability` queries the engine's tool registry for `calculator`.
  6. **No tool named `calculator` is registered in the engine registry** (it only existed as a test mock or desktop application ID).
  7. `validatePlan` rejects the plan with `capability_unavailable`.
  8. The engine fails the turn with:
     `"I cannot what is 2 + 2? answer in one word.: Plan validation rejected "perform_calculation": Plan rejected at step 1: capability "perform_calculation" has no available tool."`
  9. The HUD displays `COMMAND CONSOLE | FAILED` and sets status indicator to `STATE: ERROR`.
- **Evidence:**
  Captured in `D:\JARVIS\audit\evidence\chat_e2e_result.json` and screenshot `ui_e2e_chat_response.png`.
- **Impact:**
  Basic user conversational queries fail catastrophically instead of gracefully answering via the LLM conversational stream without tools.
- **Remediation:**
  1. Register a lightweight, safe math expression evaluator tool in `AssistantEngine` matching `calculator`.
  2. In `AssistantEngine.ts`, when tool planning validation fails for pure informational/conversational queries, fallback gracefully to direct LLM answer synthesis instead of aborting the turn in an error state.

---

### CRIT-07: Process Termination Flaw in Task Pause (Child Process Leak)
- **Subsystem:** Task Execution / `server/src/taskService.ts` (Lines 310-335)
- **Severity:** **P1 — RESOURCE LEAK & OPERATIONAL RELIABILITY**
- **Mechanism:**
  In `taskService.ts`, when an operator cancels a task (`cancelTask`), `childProcessRegistry.killProcessTree(taskId)` is invoked, properly terminating child and grandchild processes on Windows.
  However, when an operator **pauses** a task (`pauseTask`), the task status in storage is updated to `'paused'`, but **no call is made to suspend or kill the active child process tree**. Any long-running compiler, test runner (`vitest`), or build command spawned by the task continues running in the background, consuming CPU and disk I/O.
- **Evidence:**
  Source review of `server/src/taskService.ts`:
  ```typescript
  async pauseTask(taskId: string): Promise<Task | null> {
    const task = await this.storage.getTask(taskId);
    if (!task) return null;
    task.status = 'paused';
    await this.storage.updateTask(task);
    this.broadcastEvent({ type: 'task_updated', task });
    return task;
    // Missing: process suspension or child process signaling!
  }
  ```
- **Impact:**
  Resource exhaustion on host machine; orphan background processes continuing to mutate files while the operator believes the task is paused.
- **Remediation:**
  On Windows, either implement process tree suspension via `NtSuspendProcess` / job objects, or terminate the active step's process tree and record the resumption token so the step re-runs upon unpause.

---

### CRIT-08: Windows Notification Balloon Instant Disposal Race Condition
- **Subsystem:** Desktop Integration / `server/src/notify.ts` (Lines 42-65)
- **Severity:** **P1 — DESKTOP INTEGRATION DEFECT**
- **Mechanism:**
  `sendWindowsNotification()` displays desktop notifications via a spawned PowerShell command:
  ```powershell
  $notify = New-Object System.Windows.Forms.NotifyIcon;
  ...
  $notify.ShowBalloonTip(5000);
  Start-Sleep -Milliseconds 500;
  $notify.Dispose();
  ```
  The script sets the balloon display timeout to 5,000ms (5 seconds), but immediately executes `Start-Sleep -Milliseconds 500` and disposes the notification icon after only 0.5 seconds. On Windows 10/11, the notification tray icon is destroyed before the OS shell can render or animate the toast notification.
- **Evidence:**
  Source inspection of `server/src/notify.ts`. Tested manually: notification disappears instantly within 500ms before user can view or click it.
- **Impact:**
  System alerts and critical task completion notifications are never seen by the user.
- **Remediation:**
  Increase sleep duration to match balloon duration (e.g., 5000ms) or migrate to the modern Windows 10/11 Toast Notification API (`Microsoft.Toolkit.Uwp.Notifications` via PowerShell `[Windows.UI.Notifications]`).

---

### CRIT-09: Node Built-in `fs` Dynamically Imported in Frontend Bundle
- **Subsystem:** Frontend Architecture / `src/engine/tasks/PersistentTaskOrchestrator.ts` (Line 185)
- **Severity:** **P1 — BUILD INTEGRITY & ARCHITECTURAL LEAK**
- **Mechanism:**
  In `src/engine/tasks/PersistentTaskOrchestrator.ts`, the file attempts to support both browser and Node runtimes by doing:
  ```typescript
  const fs = await import('fs');
  ```
  When Vite builds the browser application (`npm run build`), it encounters this Node core import and emits:
  `Module "fs" has been externalized for browser compatibility, imported by "D:/JARVIS/src/engine/tasks/PersistentTaskOrchestrator.ts"`.
  In the browser, any code path calling that method will throw a runtime `TypeError: fs is not defined` or `fs.existsSync is not a function`.
  Conversely, when `AssistantEngine` is run in headless Node tests or CLI, it references `window.localStorage` and throws `ReferenceError: window is not defined`.
- **Evidence:**
  Observed directly in `npm run build` output logs:
  `(!) Module "fs" has been externalized for browser compatibility, imported by "D:/JARVIS/src/engine/tasks/PersistentTaskOrchestrator.ts"`
- **Impact:**
  Runtime crashes if persistent task filesystem storage methods are invoked inside the browser HUD.
- **Remediation:**
  Cleanly decouple storage adapters using dependency injection: provide an `IndexedDBTaskStorage` for browser contexts and `FileTaskStorage` strictly within server/Node contexts. Remove dynamic Node imports from `src/`.

---

## 4. Remediation Priority Matrix

| Defect ID | Severity | Effort | Target Phase | Lead Responsibility |
| :--- | :---: | :---: | :---: | :--- |
| **CRIT-01** (Unrestricted `projectPath`) | P0 | Small | Phase 1 (Immediate) | Backend Security |
| **CRIT-02** (Missing Sensitive Approvals) | P0 | Medium | Phase 1 (Immediate) | Task Engine |
| **CRIT-03** (Session Cookie Origin Bypass) | P0 | Small | Phase 1 (Immediate) | API / HTTP |
| **CRIT-06** (Capability-Tool Mismatch / Math Error) | P1 | Small | Phase 2 (High) | Orchestrator / Capabilities |
| **CRIT-07** (Process Leak on Task Pause) | P1 | Medium | Phase 2 (High) | Backend Process Supervisor |
| **CRIT-04** (Hardcoded Planner Templates) | P1 | Large | Phase 3 (Core) | AI / Dev Intelligence |
| **CRIT-05** (Fabricated Benchmark Tests) | P1 | Medium | Phase 3 (Core) | QA & Verification |
| **CRIT-08** (Notification Disposal Race) | P1 | Small | Phase 4 (Polish) | Desktop Integration |
| **CRIT-09** (Node `fs` in Browser Bundle) | P1 | Medium | Phase 4 (Polish) | Frontend Architecture |

