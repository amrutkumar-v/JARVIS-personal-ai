# JARVIS 2.0 — Remaining Engineering Roadmap
## Strategic Evolution Plan Toward a Fully Autonomous Personal AI Operating System

---

## 1. Vision & Horizon Overview

JARVIS 2.0 has successfully established:
- Single cognitive orchestration authority (`AssistantEngine`) with universal intent routing.
- Persistent background task service (`TaskService`) with disk checkpoints and restart recovery.
- Native Windows 11 desktop automation (Win32 window management, application control, and screen capture).
- Full browser automation via Playwright Chromium with strict SSRF immunity.
- Autonomous software engineering (`DevEngine`) with Git safety and isolated test runners.
- Deterministic document intelligence, data analytics, and structured artifact generation.

The roadmap outlines the subsequent milestones to evolve JARVIS from a capable pair-programmer into an omnipresent, self-healing, personal AI operating system.

---

## 2. Phase Breakdown & Engineering Objectives

### Milestone 1: Local Offline Inference & Graceful Degradation (Near-Term)
- **Objective:** Enable 100% offline autonomy when internet connectivity is severed.
- **Architecture:**
  - Dynamic local provider fallback to Ollama / Llama.cpp via `http://localhost:11434`.
  - Intent classification fallback: Small, quantized models (e.g. Llama-3.2-3B or Phi-3.5) execute intent routing and parameter extraction locally.
  - Offline embedding indexing: Vector search over workspace documents and project history using local ONNX embeddings (`all-MiniLM-L6-v2`).

### Milestone 2: Windows UI Automation (UIA) Tree Integration (Near-Term)
- **Objective:** Deep accessibility automation beyond coordinate-based visual clicking.
- **Architecture:**
  - Implement a native Windows UI Automation (UIA) COM provider in `native/src/uiaWin32.ts`.
  - Traverse the accessibility element tree: retrieve element automation IDs, control types (Button, Edit, ComboBox), and bounding rectangles.
  - Enable robust element clicking and typing that is invariant to display scaling, DPI changes, or window repositioning.

### Milestone 3: Real-Time Audio Streaming & Zero-Latency Voice Pipeline (Mid-Term)
- **Objective:** Eliminate turnaround latency for spoken conversational interaction.
- **Architecture:**
  - WebSocket full-duplex audio stream between the React HUD and backend voice daemon.
  - Streaming VAD (Voice Activity Detection) via Silero VAD running in WebAssembly.
  - Integration with local Whisper.cpp for near-instant offline transcription and Piper TTS for natural voice generation.

### Milestone 4: Multi-Project Workspace Topology & Cross-Repo DAGs (Mid-Term)
- **Objective:** Enable tasks spanning multiple interconnected repositories and services.
- **Architecture:**
  - Persistent workspace graph mapping repository interdependencies (e.g. backend API, frontend web app, shared library).
  - Cross-project DAG execution: building a shared module, running dependent service tests, and verifying integration in a single autonomous task.
  - Monorepo and polyrepo change detection with automated dependency graph resolution.

### Milestone 5: Autonomous Scheduled Workflows & Proactive Maintenance (Long-Term)
- **Objective:** Proactive background operation without waiting for user commands.
- **Architecture:**
  - Crontab and event-driven triggers in `TaskService`: e.g. nightly test suite runs, dependency security audits, git remote synchronization.
  - Proactive notification dispatch: delivering concise morning briefings to the HUD and connected phone companion app.
  - Self-healing system daemon: detecting runaway background processes or disk exhaustion and alerting the operator with suggested remediations.

---

## 3. Prioritized Implementation Schedule

| Phase | Milestone | Priority | Risk Profile | Dependencies |
| :--- | :--- | :--- | :--- | :--- |
| **P1** | Local Ollama / Llama.cpp Provider Seam | High | Low | Local model availability |
| **P2** | Windows UIA Tree Inspection | High | Medium | Win32 COM / C++ bridge |
| **P3** | Streaming Low-Latency Voice Pipeline | Medium | Medium | WebAudio / Whisper.cpp |
| **P4** | Cross-Project Workspace Topology | Medium | Low | `DevEngine` multi-root support |
| **P5** | Proactive Background Cron Automation | Low | Low | `TaskService` schedule runner |

