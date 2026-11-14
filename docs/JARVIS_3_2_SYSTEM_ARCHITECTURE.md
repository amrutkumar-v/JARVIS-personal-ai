# JARVIS 3.2 — System Architecture Specification
## Unified Architecture of the Personal AI Operating System

**Document Version:** 3.2.0  
**Target Platform:** Windows 11 Pro (OS 10.0.26300 x64)  
**Workspace:** `D:\JARVIS`  
**Git Branch:** `ui/advanced-hud-polish`  
**Runtime:** Node.js v24.19.0 / TypeScript 5.8 / Vite 6.0 / Vitest 5.0  

---

## 1. Architectural Topology & System Overview

JARVIS 3.2 is structured as a decoupled, multi-tier system governed by a **Single Cognitive Authority**. The architecture separates high-level planning, stateful task persistence, domain-specific execution engines, native operating system bindings, and reactive user interface presentation:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          USER INTERACTION SURFACE                           │
│   React HUD (http://localhost:3000)  │  Voice Audio Cues  │  Terminal CLI   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ HTTP / SSE / JSON-RPC
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SINGLE COGNITIVE AUTHORITY                            │
│                                                                             │
│  ┌────────────────────────┐         ┌────────────────────────────────────┐  │
│  │ UniversalIntentRouter  │ ──────► │         AssistantEngine            │  │
│  │ - OutcomeUnderstanding │         │  - The Sole Cognitive Brain        │  │
│  │ - Ambiguity Guard      │         │  - High-Level Plan Generation      │  │
│  │ - Execution Mode       │         │  - Specialist Delegation           │  │
│  └────────────────────────┘         │  - Recovery & Replanning           │  │
│                                     └─────────────────┬──────────────────┘  │
└───────────────────────────────────────────────────────┼─────────────────────┘
                                                        │
                         ┌──────────────────────────────┴──────────────────────────────┐
                         ▼                                                             ▼
         ┌───────────────────────────────┐                             ┌───────────────────────────────┐
         │      Immediate Execution      │                             │      Durable DAG Execution    │
         │  (Direct answers, quick calc, │                             │  ┌─────────────────────────┐  │
         │   instant memory recall)      │                             │  │PersistentTaskOrchestrator│ │
         └───────────────────────────────┘                             │  └────────────┬────────────┘  │
                                                                       │               │               │
                                                                       │  ┌────────────▼────────────┐  │
                                                                       │  │       TaskService       │  │
                                                                       │  │ - Step Dependency DAG   │  │
                                                                       │  │ - SSE Broadcasts        │  │
                                                                       │  │ - Task State Persistence│  │
                                                                       │  └────────────┬────────────┘  │
                                                                       └───────────────┼───────────────┘
                                                                                       │
    ┌───────────────────────┬───────────────────────────┬──────────────────────────────┴──────────────────────────┐
    ▼                       ▼                           ▼                                                         ▼
┌───────────────┐   ┌───────────────┐           ┌───────────────┐                                         ┌───────────────┐
│   DevEngine   │   │ DesktopEngine │           │ BrowserEngine │                                         │SpecialistPool │
│ - Git Checkpt │   │ - Win32 UIA   │           │ - Playwright  │                                         │ - Researcher  │
│ - Code Gen    │   │ - Window HWND │           │ - Multi-tab   │                                         │ - Coder       │
│ - Unittest    │   │ - Clipboard   │           │ - DOM Extract │                                         │ - Verifier    │
│ - SHA-256 Rep │   │ - Screen Cap  │           │ - SSRF Guard  │                                         │ - General     │
└───────┬───────┘   └───────┬───────┘           └───────┬───────┘                                         └───────┬───────┘
        │                   │                           │                                                         │
        ▼                   ▼                           ▼                                                         ▼
┌───────────────┐   ┌───────────────┐           ┌───────────────┐                                                 │
│ Subprocesses  │   │Native WinAgent│           │ Chromium Host │                                                 │
│ (python.exe,  │   │(127.0.0.1:    │           │ (Headless /   │ ◄───────────────────────────────────────────────┘
│  git.exe)     │   │ 8765)         │           │  Isolated)    │
└───────────────┘   └───────────────┘           └───────────────┘
```

---

## 2. Core Architectural Components

### 2.1 Universal Intent & Outcome Understanding Pipeline
Located in `src/engine/orchestrator/UniversalIntentRouter.ts`, this subsystem translates natural language input into a structured `OutcomeUnderstanding` object before any planner execution:

```typescript
export interface OutcomeUnderstanding {
  userObjective: string
  desiredOutcome: string
  executionMode: 'immediate' | 'plan_and_execute'
  confidence: number
  requiredCapabilities: string[]
  potentialRisks: string[]
  verificationStrategy: string
  suggestedSteps?: string[]
}
```

Key features:
- **Calibrated Intent Routing:** Differentiates `DIRECT_ANSWER`, `WEB_RESEARCH`, `DOCUMENT_QUERY`, `DATA_ANALYSIS`, `SOFTWARE_DEV`, `DESKTOP_ACTION`, and `BROWSER_ACTION`.
- **Deictic Ambiguity Guard:** Automatically halts execution if an instruction contains unresolved demonstrative pronouns (*"delete that"*, *"run this"*, *"open it"*) without explicit context.
- **Dynamic Mode Selection:** Low-latency queries execute immediately; complex, stateful, or multi-step operations are packaged into durable DAG plans.

### 2.2 The Single Cognitive Authority (`AssistantEngine.ts`)
`src/engine/AssistantEngine.ts` is the sole planner and orchestrator of JARVIS:
- **Central Plan Generation:** Generates task DAGs with topological dependency ordering.
- **Unified Tool Dispatch:** All domain engines (`DevEngine`, `DesktopEngine`, `BrowserEngine`, `DocumentEngine`, `DataAnalysisTools`) register their capabilities into `AssistantEngine`'s capability resolver.
- **Recovery & Replanning:** When a subtask fails, `AssistantEngine` assesses the error and initiates self-healing replanning rather than crashing or terminating silently.

### 2.3 Persistent Task Orchestration & Storage
The persistence layer spans `src/engine/tasks/PersistentTaskOrchestrator.ts` and `server/src/taskService.ts`:
- **State Machine:** Governs task lifecycle (`PENDING` $\rightarrow$ `IN_PROGRESS` $\rightarrow$ `VERIFIED` $\rightarrow$ `COMPLETED` / `RECOVERY_REQUIRED` / `FAILED`).
- **Durable Disk Storage:** Persists tasks as JSON/SQLite records in `server/data/tasks/`.
- **EventBus SSE Streaming:** Real-time task updates and subtask state transitions stream to connected clients at `GET /api/events`.

---

## 3. Specialized Domain Execution Engines

### 3.1 Autonomous Software Engineering (`server/src/dev/DevEngine.ts`)
Provides safe, auditable development workflows:
- `inspectProject`: Reads project configuration, dependencies, test frameworks, and top-level directory layout.
- `gitStatus` & `gitCheckpoint`: Inspects working tree cleanliness and creates safety branches (`safety-checkpoint-*`) before applying modifications.
- `patchFile`: Applies surgical edits or creates new source files with strict path traversal containment and byte verification.
- `runTests`: Spawns isolated test processes (`python -m unittest`, `npm test`), enforces strict execution timeouts, captures stderr/stdout, and parses test counters.
- `generateReport`: Assembles cryptographic completion reports (`CHALLENGE_REPORT.md` / `JARVIS_EXECUTION_REPORT.md`) containing SHA-256 hashes of all generated files, test execution metrics, and re-read verification proof.

### 3.2 Native Windows Integration (`server/src/desktop/` & Native Agent)
Integrates deeply with Windows 11 Pro through a dual-channel architecture:
- **Native JSON-RPC Agent (`127.0.0.1:8765`):** Written in native C++/Win32, exposing low-level system services.
- **Win32 UI Automation (UIA):** Traverses the native desktop accessibility tree to find window elements, read text labels, inspect button states, and locate top-level HWNDs.
- **System Clipboard Operations:** Reads and writes Windows clipboard text with high fidelity.
- **Desktop Observation:** Captures full-screen and window-specific screenshots in PNG format with magic header verification.

### 3.3 Advanced Browser Intelligence (`src/engine/browser/PlaywrightBrowserEngine.ts`)
Drives browser automation using real Chromium instances:
- **Multi-Tab Sessions:** Manages independent browser pages with strict cookie and storage isolation.
- **DOM Content Extraction:** Traverses the live DOM to extract clean textual content, links, and forms while discarding navigational clutter.
- **SSRF Isolation Rail:** Enforces `assertPublicHost` on all navigation attempts, unconditionally blocking requests to `127.0.0.1`, `localhost`, `0.0.0.0`, `169.254.169.254`, and private RFC 1918 subnets.

### 3.4 Document & Knowledge Intelligence (`server/src/documents/`)
Manages the user's local document repository:
- **Multi-Format Extraction:** Ingests Markdown, JSON, CSV, plain text, and ZIP archives.
- **Persistent Disk Index:** Maintains a persistent search index at `server/data/index/documents.json` (90,752 bytes).
- **Semantic & Keyword Ranking:** Ranks document passages using token frequency, positional weighting, and heading hierarchy.

### 3.5 Data Analysis & Decision Intelligence (`src/engine/analysis/DataAnalysisTools.ts`)
Performs client-side analytics without external cloud dependencies:
- **Statistical Summaries:** Computes mean, median, standard deviation, min, max, and quantiles.
- **Anomaly Detection:** Employs Interquartile Range (IQR) gating to isolate statistical outliers ($Q_1 - 1.5 \times \text{IQR}$, $Q_3 + 1.5 \times \text{IQR}$).
- **Regression Analysis:** Computes Ordinary Least Squares (OLS) regression slope, intercept, and $R^2$ coefficient of determination.
- **Visualization Specifications:** Emits standards-compliant Chart.js and Vega-Lite configuration objects.

---

## 4. Specialist Worker Pool Architecture

To support parallelized, role-bounded task execution without compromising architectural integrity, JARVIS 3.2 implements `SpecialistWorkerPool.ts`:
- **Subordinate Workers:** Workers (`researcher`, `coder`, `verifier`, `general`) operate under least-privilege tool access policies.
- **Lineage Tracking:** Every subtask executed by a specialist references its parent task ID and root objective.
- **Aggregated Reporting:** Specialists produce structured JSON findings that are validated and synthesized exclusively by `AssistantEngine`.

---

## 5. Security & Isolation Rails

1. **Path Traversal Defense:** All filesystem operations resolve target paths against project boundaries, immediately rejecting relative escapes (`../`, `..\`) with `path_traversal_forbidden`.
2. **SSRF Loopback Defense:** The `assertPublicHost` validation rail prevents web and browser engines from connecting to loopback sockets or cloud metadata services.
3. **Process Containment:** `ChildProcessRegistry` registers all spawned sub-processes and ensures complete tree termination on cancellation via Windows `taskkill /F /T /PID`.
4. **Credential Sanitization:** Personal memory and log streams automatically scrub API keys (`sk-...`) and Bearer tokens, replacing them with redaction placeholders.
5. **Two-Phase Action Authorization:** High-risk actions require single-use authorization tokens that expire immediately upon consumption.

---

## 6. Presentation Surface (React HUD)

The React HUD runs via Vite at `http://localhost:3000`:
- **Real-Time Telemetry:** Connects to `/api/events` via Server-Sent Events (SSE).
- **Responsive Layout:** Audited across 720p, 768p, 1080p, and 1440p viewports with zero layout breakage or console errors.
- **Task Graph Visualization:** Dynamically displays active DAG subtasks, dependencies, completion percentages, and live tool logs.

