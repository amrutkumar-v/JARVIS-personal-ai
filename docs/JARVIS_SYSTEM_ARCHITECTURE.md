# JARVIS System Architecture Specification
**Universal Personal AI Operating System Architecture**  
**Document Version:** 1.0.0 (Post-Overnight Master Mission)  
**Workspace:** `D:\JARVIS`  
**Operating System Target:** Microsoft Windows 11 (with cross-platform abstraction)

---

## 1. Architectural Foundations & Invariants

JARVIS is designed as an autonomous, persistent, personal AI operating system. It operates on strict foundational invariants that ensure single-point orchestration, deterministic verification, complete process control, and honest state reporting.

```mermaid
flowchart TD
    User([User Natural Language Prompt]) --> HUD[React 19 HUD localhost:3000]
    HUD --> Gateway[TaskGateway / BackendClient]
    Gateway --> Router[UniversalIntentRouter]
    
    subgraph Central_Intelligence ["Central Orchestration & Planning Authority"]
        Router --> Engine[AssistantEngine]
        Engine --> Planner[Deterministic & Development Planners]
        Engine --> DocStore[DocumentStore & Data Analysis Engine]
    end

    subgraph Durable_Backend ["Persistent Background Service (localhost:8787)"]
        Engine --> BackendTaskService[TaskService]
        BackendTaskService --> TaskOrchestrator[PersistentTaskOrchestrator]
        TaskOrchestrator --> TaskStorage[(FileTaskStorage: server/data/tasks)]
        BackendTaskService --> ProcessRegistry[ChildProcessRegistry]
        BackendTaskService --> ResMon[Windows ResourceMonitor]
        BackendTaskService --> DevEngine[DevEngine: Git, Patch, Vitest, Python]
        BackendTaskService --> DesktopEngine[DesktopEngine: Native Win32 RPC Broker]
    end

    subgraph Native_OS ["Native Windows 11 Subsystem (localhost:8765)"]
        DesktopEngine --> NativeAgent[Native Windows Agent]
        NativeAgent --> Win32Obs[Win32 BitBlt & Window Enumeration (EYES)]
        NativeAgent --> Win32Input[user32 SetForegroundWindow & SendInput (HANDS)]
        NativeAgent --> ShellExec[Supervised ShellExec Subprocess]
    end

    ProcessRegistry -->|taskkill /F /T /PID| Win32Processes[Child Process Trees: Python / Node / Batch]
    BackendTaskService -->|SSE EventBus| HUD
```

### Non-Negotiable Invariants
1. **Single Central Orchestration Authority:** `AssistantEngine` (`src/engine/AssistantEngine.ts`) is the single cognitive authority. No competing planners, agent frameworks, or execution branches exist.
2. **Durable Backend Ownership:** `TaskService` (`server/src/taskService.ts`) owns background execution. The React HUD is purely a monitoring and interaction surface; closing or refreshing the browser tab does not terminate or alter running backend tasks.
3. **Strict "Eyes vs. Hands" Separation:**
   - **Observation ("Eyes"):** `NativeWindowsObservationProvider` (`window.list`, `desktop.screenshot`) captures desktop state without injecting input.
   - **Desktop Interaction ("Hands"):** `NativeWindowsDesktopProvider` (`window.focus`, `window.minimize`, `desktop.typeText`) performs window and mouse/keyboard interactions, strictly guarded by permission policies and rate limits.
4. **Guaranteed Windows Process Tree Termination:** Child processes spawned for testing, building, or compilation are tracked in `ChildProcessRegistry` by `taskId`. When a task is cancelled, `taskkill /F /T /PID <pid>` forcefully kills the entire process tree on Windows, eliminating orphaned background processes.
5. **Deterministic Verification & Veracity:** JARVIS never fabricates success. If a tool effect cannot be observed or confirmed, it is flagged as `unverified` or `partial`, never `completed`.

---

## 2. Core Subsystems & Components

### 2.1 Intent Classification & Strategy Routing (`UniversalIntentRouter`)
The intent router operates deterministically before AI calls, categorizing natural language into 11 canonical strategies:
- `DIRECT_ANSWER`: Fact retrieval, mathematical calculations, and code explanations.
- `WEB_RESEARCH`: Current web queries, version checks, and documentation research.
- `AUTONOMOUS_DEV`: Multi-step software engineering (DAG planning, git checkpoints, patching, test execution).
- `DESKTOP_ACTION`: Native Windows interaction (screenshots, window listing, application launch, window manipulation).
- `DATA_ANALYSIS`: Structured tabular data inspection, summary statistics, trend analysis, and chart generation.
- `PRODUCTIVITY`: Deterministic scheduling, alarms, and natural language reminders.
- `CONTINUITY`: Resuming paused or interrupted tasks from persisted checkpoints.
- `TASK_CONTROL`: Pausing, resuming, cancelling, or approving background tasks.
- `LOCAL_KNOWLEDGE`: Grounded Q&A against ingested project documents.
- `BROWSER_WORKFLOW`: Interactive web navigation and scraping.
- `CLARIFICATION_REQUIRED`: Default-deny safety rail for ambiguous destructive requests (e.g., "delete that file").

### 2.2 Persistent Task Orchestration (`PersistentTaskOrchestrator` & `TaskService`)
Background tasks follow a durable lifecycle persisted on disk:
- **Storage:** Checkpoints and logs are saved to `server/data/tasks/<taskId>.json` using atomic file writes.
- **DAG Execution:** Subtasks declare dependency IDs (`step-1`, `step-2`). The orchestrator executes ready tasks, handles retries with backoff, and pauses on critical failures for operator recovery.
- **Restart Recovery:** On server boot, `recoverUnfinishedTasks()` scans the task store. Any task left in `EXECUTING` state during an unexpected restart is restored to `QUEUED` and resumes from its last verified checkpoint.

### 2.3 Process Tree Registry (`ChildProcessRegistry`)
Windows does not propagate POSIX signals (`SIGTERM`/`SIGINT`) to child/grandchild processes. Node's `child.kill()` orphans child test runners.
- **Tracking:** Every spawned process in `DevEngine.runProcess` registers its PID with `ChildProcessRegistry.register(taskId, child)`.
- **Termination:** `killProcessTree(taskId)` executes `taskkill /F /T /PID <pid>`, terminating the entire process hierarchy in a single Win32 syscall.
- **Abort Propagation:** `AbortSignal` instances are wired through `TaskService` down to child process handlers.

### 2.4 System Resource Monitoring (`ResourceMonitor`)
On Windows, `os.loadavg()` hardcodes `[0, 0, 0]`. JARVIS's upgraded `ResourceMonitor`:
- Samples CPU tick counters via `os.cpus()` user/sys/idle deltas across sliding windows to measure real multi-core Windows CPU utilization.
- Monitors system free RAM against `minFreeMemoryBytes` (default 250 MB).
- Tracks Node.js `process.memoryUsage().heapUsed` against `maxProcessHeapBytes` (default 1.5 GB).
- Automatically pauses or throttles background tasks when host resource limits are exceeded.

### 2.5 Document Intelligence & Data Analytics (`DocumentStore` & `DataAnalysisTools`)
- **Multi-Format Ingestion:** Parsers for CSV, TSV, JSON, Markdown, and code files.
- **Deterministic Statistics:** `computeNumericStats` calculates count, sum, mean, median, min, max, variance, standard deviation, quartiles, IQR, and 1.5x IQR outliers without external heavy dependencies.
- **Trend Detection:** Evaluates linear regression slopes, $R^2$ determination coefficients, and percentage changes across sequential rows.
- **Visualization:** Generates validated Chart.js and Vega-Lite JSON specifications for bar, line, scatter, and pie charts.
- **Grounded Q&A:** Semantic and keyword chunk retrieval citing document titles and section hierarchies.

### 2.6 Native Windows 11 Agent (`native/`)
A dedicated background service running on `http://127.0.0.1:8765` communicating via JSON-RPC 2.0 with the backend RPC broker:
- **Display Observation:** Win32 `BitBlt` desktop capture with active monitor DC validation, returning base64 PNG data.
- **Window Enumeration:** `EnumWindows` and `GetWindowTextW` filtering visible, non-minimized windows with active foreground HWND detection via `GetForegroundWindow`.
- **Window Management:** Win32 `ShowWindow` (`SW_MINIMIZE`, `SW_MAXIMIZE`, `SW_RESTORE`) and `SetForegroundWindow`.

---

## 3. Communication & Security Architecture

### 3.1 Network Topology & Protocol Matrix
| Route / Channel | Source | Target | Protocol | Security Control |
| :--- | :--- | :--- | :--- | :--- |
| `http://localhost:3000` | Browser | Vite Dev Server | HTTP | Loopback only |
| `http://127.0.0.1:8787` | HUD / Script | Backend API | HTTP REST / SSE | Local session cookie + CSRF check |
| `http://127.0.0.1:8765` | Backend | Native Agent | JSON-RPC 2.0 | Whitelisted method broker (`nativeMethods.ts`) |
| `http://0.0.0.0:8788` | Mobile Phone | Android Bridge | HTTP REST | Pairing token authentication |

### 3.2 Security Boundaries & Secret Redaction
- **No Node.js Code in Browser:** Backend operations (`fs`, `child_process`, `git`) are completely isolated on the server.
- **Frontend Secret Verification:** `scripts/check-frontend-secrets.mjs` verifies that zero API keys, secrets, or sensitive environment variables leak into frontend production bundles.
- **Path Traversal Protection:** Canonical directory resolution validates that all file reads, writes, and test commands remain inside authorized workspace boundaries.
- **Default-Deny Shell Execution:** Commands with arbitrary shell metacharacters (`&`, `;`, `|`) are strictly rejected. Only allow-listed test runners (`vitest`, `python -m unittest`, `npm test`) are executed.

---

## 4. Verification & Testing Framework

The system is validated by three automated tiers:
1. **Unit & Component Tests (`vitest run`):** 2,500+ unit tests verifying tool behavior, regex parsing, budget enforcement, and state transitions.
2. **Acceptance Suites (`test/acceptance/`):**
   - `autonomousAcceptance.test.ts` (10 tests): Multi-step dev tasks, HUD closure independence, restart recovery.
   - `desktopAutomationAcceptance.test.ts` (8 tests): Native desktop screenshot, window listing, app launch, foreground switching.
   - `masterMissionAcceptance.test.ts` (10 tests): Comprehensive 10-scenario end-to-end integration.
3. **Empirical Live Scripts (`scripts/`):**
   - `universal-acceptance-audit.ts` (28 checks): End-to-end verification against live backend and storage.
   - `verify-phase4-desktop.ts` (7 checks): Real-world verification against the live Windows 11 desktop and running apps.

