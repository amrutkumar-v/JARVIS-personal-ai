# JARVIS 4.0 — Universal System Architecture Specification
## Complete Topological & Functional Specification of the Personal AI Operating System

**Document Version:** 4.0.0  
**Target Platform:** Windows 11 Pro (x64)  
**System Architecture:** Microkernel Engine + Supervised Native Daemons + Reactive Frontend  
**Date:** November 12, 2026  

---

## 1. High-Level Component Topology

JARVIS 4.0 is structured as a layered, fault-tolerant operating system architecture composed of 15 coordinated layers. The system cleanly separates cognitive reasoning, deterministic orchestration, native OS control, durable task tracking, and user presentation.

```mermaid
graph TD
    subgraph UI_Layer ["1. Presentation & Interaction Layer"]
        HUD["React HUD Interface (Port 3000)<br/>Vite / Tailwind / Lucide Icons"]
        VoiceIO["Voice & Audio Fabric<br/>Web Speech / Audio Cues"]
    end

    subgraph Core_Engine ["2. Central Intelligence & Orchestration"]
        Router["UniversalIntentRouter<br/>12 Strategies / Confidence / Entities"]
        Engine["AssistantEngine (Core Orchestrator)<br/>Single Authority / State Machine"]
        ActionLayer["Deterministic Action Layer (Phase 2.6)<br/>ExecutionContext Store / Follow-ups"]
        GoalVerifier["Goal Verification & Tracer<br/>Tool Traces / Step Verifiers / TaskResult"]
    end

    subgraph Durable_Tasks ["3. Task Orchestration & Storage"]
        PTO["PersistentTaskOrchestrator<br/>DAG Subtasks / Priorities / Retries"]
        TaskStore["Task & Context Store<br/>Checkpoints / Rollback / SQLite"]
        Workers["Specialist Worker Pool<br/>Dev / Research / Doc / Data"]
    end

    subgraph Native_Bridge ["4. Operating System & Hardware Layer"]
        BackendServer["Backend Core Server (Port 8787)<br/>HTTP / SSE / JSON-RPC 2.0"]
        NativeAgent["Native Windows Agent (Port 8765)<br/>Win32 C++ / UIA / Toolhelp32 / GDI+"]
        ProcRegistry["ChildProcessRegistry<br/>Job Objects / Tree Termination"]
        ResMonitor["ResourceMonitor<br/>CPU Deltas / Memory Limits / Load Throttling"]
    end

    subgraph External_Fabric ["5. Models, Devices & Network"]
        Ollama["Local AI Fabric (Port 11434)<br/>qwen3:8b / qwen3-coder:latest"]
        CloudAI["Cloud AI Fallback Fabric<br/>Gemini / Anthropic / OpenAI"]
        DeviceMesh["Device Command Fabric<br/>Android LAN Bridge / S26 Ultra / S23 FE"]
        BrowserEngine["Playwright Chromium Engine<br/>DevTools / DOM Extraction / SSRF Guard"]
    end

    HUD <-->|HTTP / SSE| BackendServer
    BackendServer <-->|JSON-RPC 2.0| Engine
    Engine --> Router
    Engine --> ActionLayer
    Engine --> GoalVerifier
    Engine <--> PTO
    PTO <--> TaskStore
    PTO --> Workers
    Engine <-->|JSON-RPC 2.0| NativeAgent
    Engine --> Ollama
    Engine -.-> CloudAI
    Engine --> DeviceMesh
    Engine --> BrowserEngine
    NativeAgent --> ProcRegistry
    NativeAgent --> ResMonitor
```

---

## 2. The 15 Architectural Layers

### Layer 1: User Presentation & Multi-Resolution HUD Layer
- **Component:** `src/App.tsx`, `src/components/layout/JarvisShell.tsx`
- **Capabilities:** High-density Glassmorphic interface styled with Tailwind CSS, supporting 1080p, 1440p, and 4K displays. Provides real-time activity pills, streaming transcripts, collapsible telemetry panels, task progress graphs, and native audio visualizers.

### Layer 2: Universal Central Intelligence & Intent Routing
- **Component:** `src/engine/orchestrator/UniversalIntentRouter.ts`
- **Capabilities:** Single-pass deterministic classification into 12 distinct strategies (`DIRECT_ANSWER`, `LOCAL_REASONING`, `AUTONOMOUS_DEV`, `WEB_RESEARCH`, `BROWSER_WORKFLOW`, `DESKTOP_ACTION`, `FILE_OPERATION`, `DATA_ANALYSIS`, `PRODUCTIVITY`, `CONTINUITY`, `TASK_CONTROL`, `CLARIFICATION_REQUIRED`). Evaluates multi-turn context, project roots, and device targets before strategy resolution.

### Layer 3: Single Cognitive Orchestration Authority
- **Component:** `src/engine/AssistantEngine.ts`
- **Capabilities:** The single coordination authority. Holds the authoritative state machine (`idle` -> `understanding` -> `planning` -> `executing` -> `verifying` -> `completed`/`failed`/`cancelled`). Dispatches requests to deterministic handlers, provider tool loops, or durable DAG background tasks without architectural conflicts.

### Layer 4: Persistent Task Orchestrator & Durable DAG Execution
- **Component:** `src/engine/tasks/PersistentTaskOrchestrator.ts`, `server/src/tasks/`
- **Capabilities:** Manages long-running multi-step background missions. Implements Directed Acyclic Graph (DAG) dependency resolution, topological task sorting, priority queues, automated recovery retries (exponential backoff), persistent JSON/SQLite checkpointing, and execution pausing/resumption.

### Layer 5: Native Windows Agent & Desktop Control
- **Component:** `native/src/`, `src/native/`
- **Capabilities:** Supervised child daemon communicating over JSON-RPC 2.0 on `127.0.0.1:8765`. Provides low-level Win32 integration:
  - Process enumeration via `CreateToolhelp32Snapshot`
  - Window management (`SetForegroundWindow`, `ShowWindow`, `GetWindowTextW`)
  - Screen capture via GDI+ and desktop device contexts
  - Windows UI Automation (UIA) tree traversal
  - Synthetic input dispatch via `SendInput` (mouse movements, clicks, keyboard events)

### Layer 6: Multi-Provider AI Inference Fabric
- **Component:** `server/src/aiProvider.ts`, `src/config/ai.ts`
- **Capabilities:** Dynamic provider routing across local Ollama (`qwen3:8b`, `qwen3-coder:latest`) and remote cloud providers (Gemini 2.5 Flash, Claude 3.5 Sonnet, GPT-4o). Supports strict `localOnly` mode enforcing complete air-gapped execution with zero cloud telemetry.

### Layer 7: Personal Memory & Episode-Aware Knowledge Lifecycle
- **Component:** `src/memory/MemoryManager.ts`, `src/memory/episodes.ts`
- **Capabilities:** Hybrid vector/BM25 memory search over user facts, personal preferences, and past operational context. Groups memories by session episodes, supports automatic consolidation, credential and secret redaction (`api_key`, `password`, `bearer`), and requires two-man rule confirmation for clear-all operations.

### Layer 8: Deterministic Action Layer & Execution Context Store
- **Component:** `src/engine/action/`, `src/engine/AssistantEngine.execution.ts`
- **Capabilities:** Tracks committed execution facts across conversation turns. Resolves ambiguous deictic references (`"do it"`, `"now open that PDF"`) against verified historical context. Refuses ungrounded actions honestly and enforces terminal state honesty (`failed` runs never receive `success` labels).

### Layer 9: Autonomous Software Development Engine (DevEngine)
- **Component:** `server/src/dev/DevEngine.ts`, `src/engine/dev/DevelopmentPlanner.ts`
- **Capabilities:** Autonomous repository maintenance:
  - AST-aware multi-language parsing (Python, TypeScript, JavaScript)
  - Isolated file inspection and exact string target patching
  - Automated test runner execution (Python `unittest`/`pytest`, Node `vitest`/`jest`)
  - Automatic git safety checkpoints (`git checkout -b jarvis/checkpoint-...`) before destructive code changes

### Layer 10: Playwright & Interactive Browser Automation Engine
- **Component:** `src/browser/BrowserTools.ts`, `server/src/browser.ts`
- **Capabilities:** Headless and headed Chromium browser driving via Chrome DevTools Protocol (CDP) and Playwright. Performs multi-page navigation, DOM snapshotting, structured table extraction, form interaction, and element clicking with strict SSRF protection (blocking loopback `127.0.0.1`, RFC 1918 subnets, and AWS metadata `169.254.169.254`).

### Layer 11: Visual Computer & Multimodal Inspection Subsystem
- **Component:** `src/vision/VisualComputerTools.ts`, `src/components/panel/DesktopObservationView.tsx`
- **Capabilities:** Desktop observation and OCR analysis. Ingests full-screen PNG captures, calculates element bounding boxes, extracts on-screen text, verifies window foreground presence, and provides visual confirmation of application state transitions.

### Layer 12: Voice & Acoustic Hardware Fabric
- **Component:** `src/voice/VoiceManager.ts`, `src/voice/AudioCues.ts`, `src/voice/StreamingTts.ts`
- **Capabilities:** Voice input and output streaming. Enumerates physical microphone and speaker devices via Windows MMDevice API. Implements honest reporting when hardware is disconnected, real-time WAV audio feedback cues, and low-latency text-to-speech synthesis.

### Layer 13: Cross-Device Command Fabric & LAN Mesh
- **Component:** `src/device/DeviceTools.ts`, `src/engine/agentCore.deviceFabric.test.ts`
- **Capabilities:** Connects authenticated companion devices (e.g., Samsung Galaxy S26 Ultra, S23 FE) over secure local LAN bridge. Supports remote URL opening, file dispatch, device status discovery, and notification delivery with strict trust-boundary validation.

### Layer 14: Document Intelligence & Knowledge Store
- **Component:** `src/engine/documents/DocumentStore.ts`, `src/engine/documents/DocumentTools.ts`
- **Capabilities:** Local ingestion and deep analysis of PDF, DOCX, XLSX, and CSV documents. Performs tabular metric extraction, multi-document cross-comparison, executive summaries, and vector-embedded semantic search.

### Layer 15: Security, Sandbox & Resource Isolation Subsystem
- **Component:** `server/src/resourceMonitor.ts`, `server/src/process/ChildProcessRegistry.ts`
- **Capabilities:** Comprehensive OS-level protection:
  - Windows Job Objects for robust subprocess tree termination
  - Real-time CPU delta tracking and heap memory monitoring
  - Threshold-based throttling (throttling when CPU load ratio exceeds 85%)
  - Default-deny input sanitization against shell injection (`&&`, `||`, `|`, `` ` ``, `$`)
  - Path traversal sandboxing restricting file writes to authorized project roots

---

## 3. Dual-Mode Execution Architecture: Inline vs. Persistent DAG

```mermaid
flowchart TD
    Request["Incoming User Natural-Language Request"] --> Router["UniversalIntentRouter.classify()"]
    Router --> Decision{"Execution Strategy"}

    Decision -->|DESKTOP_ACTION / DIRECT_ANSWER| InlineCheck{"Is Compound or Persistent?"}
    InlineCheck -->|Single Step / Read-Only| InlineExec["Inline Execution (AssistantEngine)<br/>- app.launch / window.list<br/>- Immediate Verification<br/>- Trace Step Appended<br/>- Fast Response (<100ms)"]
    InlineCheck -->|Multi-Step DAG with Calculation| DagExec["Persistent Task (PersistentTaskOrchestrator)<br/>- DAG Subtasks Generated<br/>- Topologically Sorted<br/>- Checkpointed in Storage<br/>- Durable Background Execution"]

    Decision -->|AUTONOMOUS_DEV / DATA_ANALYSIS| DagExec
    Decision -->|CLARIFICATION_REQUIRED| Clarify["Clarification Required (Phase 2.6)<br/>- Default-Deny Execution<br/>- ActionKind: ambiguous<br/>- Emit Targeted Question<br/>- ExecutionContext Committed"]
    Decision -->|BROWSER_WORKFLOW| PlaywrightExec["Browser Automation Pipeline<br/>- SSRF Verification<br/>- Page Navigation / DOM Extract<br/>- Full-page Screenshot Verification"]

    InlineExec --> Result["Final Outcome & Synthesis"]
    DagExec --> Result
    Clarify --> Result
    PlaywrightExec --> Result
```

---

## 4. Security & Safety Boundary Pipeline

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Router as UniversalIntentRouter
    participant Engine as AssistantEngine
    participant Guard as Safety & Security Rails
    participant OS as Windows 11 Native System

    User->>Router: "Delete that file" or "Open calc && echo hacked"
    Router->>Engine: Route Decision (strategy, entities)
    Engine->>Guard: Pre-Execution Validation
    alt Chained Shell Injection Detected
        Guard-->>Engine: REFUSED (Contains chained operators)
        Engine-->>User: "Could not launch: Refused command with chained shell operators."
    else Destructive Deictic Ambiguity Detected
        Guard-->>Engine: REFUSED (Missing explicit target path)
        Engine->>Engine: Record Context (actionKind: ambiguous, outcome: clarified)
        Engine-->>User: "I didn't act on that: Which specific file or target would you like me to delete?"
    else Valid Authorized Request
        Guard-->>Engine: APPROVED
        Engine->>OS: Execute via Win32 / Tool Seam
        OS-->>Engine: Raw OS Observation
        Engine->>Engine: Independent Verification Probe
        Engine-->>User: Verified Truthful Output
    end
```

