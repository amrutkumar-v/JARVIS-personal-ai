# JARVIS 3.1 — Test Environment & Runtime Prerequisites
## Forensic Environment Inventory & Service Topography

**Document Version:** 3.1.0  
**Verification Date:** November 12, 2026  
**Platform:** Windows 11 (OS Build 10.0.26300 x64)  
**Host:** `Amrut`  
**Workspace:** `D:\JARVIS`  
**Dedicated Test Workspace:** `D:\JARVIS-Test\JARVIS-3.1`  
**Branch:** `ui/advanced-hud-polish` (Commit: `7ce486e`)  

---

## 1. Operating System & Toolchain Inventory

| Component | Version / Build | Path / Identifier | Status |
| :--- | :--- | :--- | :--- |
| **Operating System** | Windows 11 (10.0.26300 x64) | Host: `Amrut` | Active |
| **Node.js Runtime** | `v24.19.0` | `node` on system PATH | Active |
| **Python Runtime** | `3.14.0` | `python` on system PATH | Active |
| **Git SCM** | `2.55.0.windows.3` | `git` on system PATH | Active |
| **Microsoft .NET CLR** | `4.0.30319.42000` | UIAutomationClient bridge | Active |
| **Playwright** | `^1.58.0` (Chromium v1254) | `C:\Users\vamru\AppData\Local\ms-playwright\chromium-1254` | Installed & Verified |
| **Chrome Headless Shell**| `158.0.8127.18` (v1254) | `C:\Users\vamru\AppData\Local\ms-playwright\chromium_headless_shell-1254` | Installed & Verified |
| **Ollama Local AI** | Live daemon on port `11434` | Models: `qwen3-coder:latest` (30.5B MoE), `qwen3:8b` (8.2B) | Active |

---

## 2. Active JARVIS Daemons & Service Topography

```
==============================================================================
  JARVIS 3.1 SERVICE RUNTIME STATUS
==============================================================================
  Service                 Port / Socket         PID     Protocol       Status
  --------------------------------------------------------------------------
  Native Windows Agent    http://127.0.0.1:8765  Supervised JSON-RPC 2.0  ONLINE
  Backend Core API        http://127.0.0.1:8787  Live    HTTP / SSE     ONLINE
  React HUD Dev Server    http://localhost:3000  Live    HTTP / Vite    ONLINE
  Ollama Model Daemon     http://127.0.0.1:11434 12684   HTTP / REST    ONLINE
==============================================================================
```

---

## 3. Security & Boundary Configurations

1. **Native Agent Token:** Configured via `JARVIS_NATIVE_TOKEN` and server-side `JARVIS_BACKEND_NATIVE_TOKEN`. Rejects all unauthenticated or non-loopback calls.
2. **Backend Authentication:** Enforces `JARVIS_BACKEND_TOKEN` session cookie validation and `JARVIS_BACKEND_TRUSTED_ORIGINS` CORS checks.
3. **Workspace Confinement:** All test mutations restricted to `D:\JARVIS-Test\JARVIS-3.1`. Real user code and production directories protected from modification.
4. **SSRF Rail:** `assertPublicHost` active in `native/src/web.ts` and `browserInput.ts`, blocking loopback (`127.0.0.1`), RFC 1918 private subnets, and cloud metadata (`169.254.169.254`).
5. **Process Containment:** Windows `taskkill /F /T /PID` registered in `ChildProcessRegistry` for process-tree cleanup.

