# JARVIS 3.0 — Remaining Engineering Roadmap & Future Evolutions
## Next-Horizon Capabilities, Hardware Integrations, and Architectural Enhancements

**Document Version:** 3.0.0  
**Status:** Living Engineering Plan  
**Target Platform:** Windows 11 (x64 / ARM64)  
**Date:** November 2026  

---

## 1. Executive Direction

With the successful completion of JARVIS 3.0 Phases 0 through 14, the core operating system architecture is completely unified, reliable, and verified. `AssistantEngine` serves as the single cognitive authority; `TaskService` and `PersistentTaskOrchestrator` govern durable background execution; the Native Windows Agent controls OS actions with deep UIAutomation (UIA); and the React HUD provides a clean presentation surface with zero secret leakage.

The next engineering phase will focus on **deeper kernel-level OS integration, multi-cloud OAuth integrations, and direct local GPU acceleration**.

---

## 2. Priority Engineering Tracks

### 2.1 Windows Named Pipes IPC with Kernel ACLs
- **Current State:** Backend Core (`:8787`) and Native Agent (`:8765`) communicate over TCP loopback (`127.0.0.1`) secured by bearer token authentication.
- **Future Architecture:**
  - Transition internal loopback RPC to Windows Named Pipes (`\\.\pipe\jarvis-agent-rpc`).
  - Configure Windows Security Descriptors (ACLs) granting access exclusively to the current logged-in Windows user SID.
  - Eliminates local port exposure and prevents any unauthorized multi-user local process from probing the agent interface.

### 2.2 Cloud Productivity OAuth 2.0 Connectors
- **Current State:** Provider-based adapter framework operates with `LocalEmailAdapter`, `LocalCalendarAdapter` (RFC 5545 `.ics`), and `LocalGitAdapter`.
- **Future Architecture:**
  - Implement PKCE-based OAuth 2.0 flow for Google Workspace (Gmail, Google Calendar) and Microsoft 365 (Graph API, Outlook).
  - Securely store refresh tokens in the Windows Credential Manager (`wincred`) rather than unencrypted JSON files.
  - Enable live multi-calendar synchronization and external mailbox delivery while maintaining the mandatory two-phase confirmation protocol for outgoing mutations.

### 2.3 DirectML & ONNX Runtime Local Hardware Acceleration
- **Current State:** Local AI routing queries external daemons (Ollama, LM Studio, Llama.cpp) over HTTP port `11434`.
- **Future Architecture:**
  - Integrate native Node.js addons for Windows DirectML and ONNX Runtime.
  - Execute small embedding models (e.g. `all-MiniLM-L6-v2`) and fast SLMs (e.g. `Phi-3.5-mini`, `Gemma-2-2B`) directly in-process utilizing Windows 11 NPU (Snapdragon X / Intel Core Ultra) and GPU (NVIDIA / AMD) acceleration without any background daemon dependencies.

### 2.4 Multi-Monitor Desktop Vision & Spatial Coordinate Mapping
- **Current State:** Desktop screenshot captures primary display at 1920x1080 resolution.
- **Future Architecture:**
  - Win32 Virtual Screen capture spanning multi-monitor configurations (`SM_CXVIRTUALSCREEN`, `SM_CYVIRTUALSCREEN`).
  - Spatial coordinate normalization mapping UIAutomation element bounding rectangles to explicit display indices (Display 1, Display 2).
  - Allows seamless cross-monitor window management and element clicking on secondary displays.

### 2.5 Windows Kernel Job Objects Native Driver
- **Current State:** `ChildProcessRegistry` terminates processes and their child trees using `taskkill /F /T /PID <pid>`.
- **Future Architecture:**
  - Package a lightweight native C++ Win32 helper DLL or binary that associates spawned subprocesses with a Windows Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
  - Guarantees immediate kernel-level termination of all child and grandchild processes even if Node.js experiences an abnormal termination or crash.

### 2.6 Full-Duplex Realtime Multimodal Voice
- **Current State:** Streaming STT and queue-chunked sentence TTS with Web Audio procedural sound cues and instant barge-in.
- **Future Architecture:**
  - Implement bidirectional WebRTC / WebSocket streaming for Gemini Live API and OpenAI Realtime API when cloud credentials are provided by the operator.
  - Client-side voice activity detection (VAD) using Silero-VAD WebAssembly for sub-20ms speech pause detection.

---

## 3. Recommended Phased Implementation Schedule

| Phase | Milestone | Primary Focus | Estimated Scope |
| :--- | :--- | :--- | :--- |
| **Phase 15** | **Windows Named Pipes & Credential Manager** | Transition loopback TCP to Windows Named Pipes; store secrets in `wincred` | 2–3 Days |
| **Phase 16** | **Cloud OAuth Connectors** | Implement Google Calendar & Microsoft Graph OAuth PKCE flows | 3–4 Days |
| **Phase 17** | **DirectML In-Process AI** | Embed ONNX Runtime with DirectML for in-process NPU/GPU embedding generation | 4–5 Days |
| **Phase 18** | **Multi-Monitor Vision** | Virtual desktop screen mapping and multi-display window movement | 2–3 Days |
| **Phase 19** | **Kernel Job Object Driver** | Native Win32 Job Object DLL integration for unyielding process containment | 2 Days |

