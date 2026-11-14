# JARVIS 3.2 — Reliability, Security & System Hardening Specification
## Fault Tolerance, Crash Recovery, Sandboxing, SSRF Protection, and Default-Deny Security Guardrails

**Document Version:** 3.2.0  
**Baseline:** JARVIS 3.1  
**Architecture Layer:** Reliability & Security (`server/src/dev/DevEngine.ts`, `server/src/tasks/`)  
**Target Platform:** Windows 11 Pro  
**Date:** November 12, 2026  
**Status:** **OPERATIONAL & EMPIRICALLY AUDITED**

---

## 1. Executive Summary

JARVIS 3.2 is engineered to operate reliably and safely across real Windows 11 environments without human micro-management. Because an autonomous personal operating system commands real filesystem mutations, browser sessions, process trees, and desktop interactions, reliability and security are architectural invariants rather than afterthoughts:
1. **Crash Recovery & Decoupling:** Tasks survive browser closure, network disconnects, and backend process restarts via durable disk checkpoints.
2. **Process Management:** Abandoned or cancelled tasks are cleanly reaped using Windows process tree termination (`taskkill /F /T`).
3. **Path Traversal Sandboxing:** All filesystem operations are locked to approved workspace roots; attempts to traverse into `C:\Windows\System32`, UNC paths, or parent directories are blocked.
4. **SSRF Hardening:** Browser automation strictly rejects loopback, link-local, cloud metadata (`169.254.169.254`), and RFC 1918 private subnets.
5. **Command Injection Prevention:** Execution tools spawn arguments via direct argument arrays (`spawnSync`), never concatenating raw shell strings.
6. **Default-Deny Deictic Ambiguity:** Destructive or ambiguous instructions without clear antecedents (*"Delete it"*, *"Fix that"*) trigger targeted clarifying questions rather than blind actions.
7. **Two-Phase Confirmation Tokens:** Irreversible external actions require single-use approval tokens with 5-minute TTLs.

---

## 2. Threat Model & Security Boundaries

```
Untrusted Input (User Prompt / Web DOM / External Email)
   │
   ▼
[Boundary 1: UniversalIntentRouter]
   ├─► Ambiguous Deictic Detector (Default-Deny for "delete it", "run that")
   └─► Capability Limitation Guardrail (Honest reporting of blocked capabilities)
   │
   ▼
[Boundary 2: AssistantEngine & Tool Registry]
   ├─► Two-Phase Confirmation Manager (Single-use token with 5m TTL)
   └─► Credential Scrubbing Rail (Scrub API keys, passwords, bearer tokens)
   │
   ▼
[Boundary 3: DevEngine & Filesystem Sandboxing]
   ├─► Path Normalization & Canonical Root Checking (Reject traversal "..")
   ├─► Blind Overwrite Prevention (Exact target match required for existing files)
   └─► Automatic Safety Checkpoint & .jarvis.bak backup
   │
   ▼
[Boundary 4: Browser Automation Engine]
   ├─► SSRF IP Filter (Block 127.0.0.1, 169.254.169.254, RFC 1918)
   └─► Redirect Destination Validation
   │
   ▼
[Boundary 5: Native Win32 RPC Protocol]
   └─► Exact 62-Method Closed Catalog (Zero arbitrary shell execution)
```

---

## 3. Reliability & Fault Recovery

### 3.1 Restart Recovery Protocol
When `PersistentTaskOrchestrator` initializes:
1. It reads all serialized tasks from `server/data/tasks/`.
2. Tasks in `EXECUTING` state during an abrupt shutdown are marked `RECOVERY_REQUIRED` or restored to the last `VERIFIED` subtask checkpoint.
3. Subtasks already marked `VERIFIED` are never re-executed; execution seamlessly resumes from the first pending subtask.

### 3.2 Bounded Retries & Error Classification
Errors are classified deterministically (`classifyTaskError`):
- **Transient (Network timeout, locked file):** Bounded retry up to 3 attempts with exponential backoff.
- **Permanent (Syntax error, permission denied, invalid argument):** Immediate failure without blind retries, reporting the diagnostic to the user.

### 3.3 Child Process Tree Termination
When a task is cancelled, `ChildProcessRegistry.killProcessTree` terminates the entire Windows process tree (`taskkill /pid <PID> /T /F`), ensuring no orphaned compiler, node, or python processes leak memory or lock files.

---

## 4. Empirical Security Test Evidence

Validated across 10 security tests in `test/acceptance/securityAdversarial.test.ts` and `server/src/dev/DevEngine.security.test.ts`:
- **Vector 1 (Path Traversal):** Rejection of `..\..\Windows\System32\notepad.exe`, `C:\Windows\System32\drivers\etc\hosts`, and UNC network paths.
- **Vector 1b (Blind Overwrite):** Rejection of empty target segments when modifying existing files.
- **Vector 2 (SSRF):** Rejection of `http://127.0.0.1`, `http://localhost`, `http://169.254.169.254`, and private RFC 1918 IPs in browser automation.
- **Vector 3 (Command Injection):** Safe handling of filenames containing shell metacharacters (`; rm -rf`, `& dir`, `| calc.exe`).
- **Vector 4 (Default-Deny Deictic):** Prompt *"Delete that file"* triggers immediate clarification question.
- **Vector 5 (Native RPC Closed Boundary):** Exactly 62 authorized RPC methods; zero arbitrary `shell.exec` or unvalidated command injection endpoints exist.

**Phase 14 Verdict:** Reliability and security rails are fully verified and hardened.

