# JARVIS 3.2 — Remaining Engineering Roadmap
## Strategic Evolution Plan for JARVIS 3.3 and Beyond

**Document Version:** 3.2.0  
**Target Platform:** Windows 11 Pro  
**Workspace:** `D:\JARVIS`  
**Git Branch:** `ui/advanced-hud-polish`  
**Author:** Principal Engineering Organization  

---

## 1. Overview & Strategic Trajectory

JARVIS 3.2 has established a hardened, unified, and empirically verified foundation for an autonomous personal AI operating system. All core operational domains—intent routing, research synthesis, document intelligence, software engineering, desktop automation, browser control, personal memory, and tabular analytics—are live and operational under a single cognitive authority (`AssistantEngine.ts`).

The next frontier of engineering focuses on unblocking physical hardware constraints, connecting authenticated cloud ecosystems, incorporating local computer vision for desktop interaction, and scaling specialist worker workloads.

---

## 2. Priority Roadmap Milestones

### Milestone 1: Hardware Voice Bridging & Whisper On-Device ASR
- **Current Status:** `BLOCKED` (No physical microphone attached to the current host).
- **Target:** Full hands-free voice bidirectional conversation loop.
- **Implementation Strategy:**
  1. Add a Win32 audio device listener that monitors Windows Multimedia (`winmm.dll`) device arrival/removal notifications.
  2. Implement an optional virtual audio cable input bridge for software-routed audio sources.
  3. Integrate local `whisper.cpp` / faster-whisper on-device speech-to-text pipeline running alongside Ollama, bypassing external speech API dependencies.
  4. Preserve the existing streaming TTS and barge-in cancellation engine in `StreamingTts.ts`.
- **Target Release:** JARVIS 3.3

### Milestone 2: Cloud OAuth Production Connectors
- **Current Status:** `MOCKED ONLY` (Calendar and Email adapters tested with in-memory models).
- **Target:** Production bi-directional synchronization with Google Workspace (Calendar, Gmail) and Microsoft 365 (Graph API).
- **Implementation Strategy:**
  1. Provide a secure local loopback OAuth callback listener (`http://127.0.0.1:8788/auth/callback`).
  2. Implement Proof Key for Code Exchange (PKCE) flow for secure client authentication without embedding client secrets in source code.
  3. Store encrypted refresh tokens in the Windows Credential Manager (`wincred`) via native agent bindings.
  4. Enforce two-phase confirmation with single-use tokens before dispatching emails or modifying existing calendar events.
- **Target Release:** JARVIS 3.3

### Milestone 3: Local Multimodal Desktop Vision (VLM)
- **Current Status:** `LIVE VERIFIED` for Win32 UIA accessibility tree and desktop screen capture; visual element clicking relies on coordinate calculations.
- **Target:** Semantic visual grounding for applications that lack accessible UIA trees (e.g. game engines, legacy Win32 apps, virtualized remote desktops).
- **Implementation Strategy:**
  1. Deploy a quantized local vision-language model (e.g., `qwen2.5-vl:7b` or `minicpm-v`) via Ollama.
  2. Provide a screenshot grounding tool in `DesktopEngine` that maps natural language descriptions (*"click the green submit button on the right"*) to exact screen $(x, y)$ coordinates.
  3. Combine UIA metadata with visual bounding boxes for hybrid verification.
- **Target Release:** JARVIS 3.4

### Milestone 4: Fine-Tuned DAG Planning & Self-Healing Models
- **Current Status:** `AUTOMATED TESTED` (Algorithmic DAG planning via `DevelopmentPlanner.ts` and `OutcomeUnderstanding`).
- **Target:** Low-latency, specialized local models tuned specifically for JARVIS task topologies and dynamic error recovery.
- **Implementation Strategy:**
  1. Curate a dataset of verified JARVIS execution traces, subtask DAGs, and failure-recovery episodes.
  2. Fine-tune a compact 3B–7B parameter model using LoRA specifically for JSON tool dispatch and topological step generation.
  3. Enable sub-second planning latency on local GPU hardware while preserving `AssistantEngine.ts` as the single validation authority.
- **Target Release:** JARVIS 3.4

### Milestone 5: Bounded Swarm Isolation & Distributed Execution
- **Current Status:** `AUTOMATED TESTED` (`SpecialistWorkerPool.ts` runs bounded in-process workers).
- **Target:** Containerized / sandboxed execution of specialist workers with CPU, memory, and filesystem quotas.
- **Implementation Strategy:**
  1. Leverage Windows Sandbox or lightweight Docker containers for specialist coder workers modifying unfamiliar codebases.
  2. Assign isolated virtual network interfaces to browser workers to enforce strict egress firewall policies per task.
  3. Maintain strict JSON-RPC message contracts back to `AssistantEngine.ts`.
- **Target Release:** JARVIS 3.5

---

## 3. Engineering Constraints & Invariants

All future milestones must strictly adhere to the established JARVIS 3.2 architectural invariants:

1. **Single Cognitive Authority Invariant:** `AssistantEngine.ts` must remain the sole planner and orchestrator. New capabilities must expose tools or services, never competing planners.
2. **Strict Verification First:** No capability may be classified as `LIVE VERIFIED` or `AUTOMATED TESTED` without automated test suites verifying real process execution or live API handshakes.
3. **Zero Repository Destruction:** All automated operations must continue to honor working tree boundaries, utilize safety checkpoint branches, and prevent blind overwrites.
4. **Credential Isolation:** Raw secrets and tokens must never enter personal memory stores, logs, or client-facing responses.

