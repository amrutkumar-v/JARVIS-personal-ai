# JARVIS 2.0 — Security & Trust Boundary Audit
## Security Architecture, Rail Enforcement, and Vulnerability Defenses

---

## 1. Executive Security Summary

JARVIS 2.0 is designed for autonomous execution on a local Windows 11 workstation. Because an autonomous agent possesses the ability to read and write files, execute compilers, automate web browsers, and manipulate desktop applications, the security model operates on a principle of **Strict Default-Deny, Compartmentalized Privilege, and Zero Credential Leakage**.

A comprehensive security audit confirmed that all critical trust boundaries are fully enforced across both static build artifacts and live execution runtimes.

---

## 2. Threat Vector Audits & Defense Implementations

### 2.1 Credential Boundary & Zero Frontend Leakage
- **Threat:** API keys, native agent bearer tokens, or session credentials accidentally bundled into client-side JavaScript or exposed to browser storage.
- **Enforced Defense:**
  - Build script `scripts/check-frontend-secrets.mjs` scans all 7 Vite production bundles (`dist/index.html`, `dist/assets/*.js`) against sensitive environment variable patterns:
    * `JARVIS_NATIVE_TOKEN`
    * `JARVIS_BACKEND_NATIVE_TOKEN`
    * `JARVIS_BACKEND_TOKEN`
    * `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`
  - Build pipeline hard-fails with exit code 1 if any pattern is detected.
  - The native agent bearer token is injected strictly server-side by the backend HTTP proxy (`server/src/index.ts`). The React HUD connects to the backend using an `httpOnly`, SameSite session cookie.
- **Audit Result:** **PASS**. Zero secret tokens found in production bundles.

### 2.2 Server-Side Request Forgery (SSRF) & Inaccessible Host Blocking
- **Threat:** Autonomous browser or web-fetch tools manipulated into accessing cloud metadata services (`http://169.254.169.254`), local backend endpoints (`http://127.0.0.1:8787`), or internal network routers (RFC 1918 addresses).
- **Enforced Defense:**
  - `native/src/web.ts` and `native/src/browserInput.ts` enforce `assertPublicHost(hostname, dnsLookup)` on all `web.*` and `browser.*` navigation requests.
  - Rejects:
    * Loopback: `127.0.0.0/8`, `::1`, `localhost`
    * RFC 1918 Private: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
    * Link-Local & AWS/GCP Metadata: `169.254.0.0/16`, `fe80::/10`
    * Carrier-Grade NAT & Multicast: `100.64.0.0/10`, `224.0.0.0/4`, `ff00::/8`
  - Both IP literals (`http://127.0.0.1:8787`) and DNS hostnames resolving to private IPs (`http://localtest.me`) are immediately rejected with `permission_denied` before any network connection or browser page navigation occurs.
- **Audit Result:** **PASS**. All loopback, local, and metadata navigation attempts are blocked.

### 2.3 Shell Injection & Command Execution Safety
- **Threat:** Arbitrary shell execution via command chaining operators (`;`, `&&`, `||`, `|`, `` ` ``, `$()`).
- **Enforced Defense:**
  - `server/src/dev/DevEngine.ts` strictly validates test commands before spawning subprocesses.
  - Commands containing shell operators are rejected with error `test_command_rejected`:
    `Refusing test command with shell metacharacters: <command>`
  - Allowed test runners are restricted to a strict whitelist:
    `pytest`, `python -m unittest`, `npm test`, `npx vitest run`.
  - Process creation uses `child_process.spawn` with explicit argument arrays, preventing Windows cmd.exe command concatenation escapes.
- **Audit Result:** **PASS**. Shell injection payloads strictly refused.

### 2.4 Path Traversal & Root Confinement
- **Threat:** Directory traversal attacks (`../../Windows/System32`) to read or overwrite critical operating system files.
- **Enforced Defense:**
  - `native/src/paths.ts` normalizes all relative and absolute paths against configured allowed roots (`outside_allowed_root`).
  - Path escapes outside the designated workspace root are rejected at the native broker level before filesystem drivers execute.
- **Audit Result:** **PASS**. Path traversal escapes trapped and refused.

### 2.5 Destructive Action Protection & User Confirmation
- **Threat:** Autonomous deletion or irreversible destruction of user data without consent.
- **Enforced Defense:**
  - High-risk operations (e.g. `file.delete`, permanent process termination) require explicit user approval.
  - The `PersistentTaskOrchestrator` automatically transitions subtasks requiring confirmation to `WAITING_FOR_PERMISSION`.
  - Execution halts until the operator approves via the HUD. A rejection transitions the task to `FAILED` without taking destructive action.
- **Audit Result:** **PASS**. Default-deny applied to all destructive verbs.

### 2.6 Orphan Process Prevention & Resource Bounds
- **Threat:** Runaway child processes or browser contexts consuming host CPU/RAM indefinitely after a task is cancelled.
- **Enforced Defense:**
  - `server/src/process/ChildProcessRegistry.ts` registers every spawned process by PID and taskId.
  - Task cancellation triggers `taskkill /F /T /PID <pid>`, terminating the entire process tree down to all descendants.
  - `server/src/resourceMonitor.ts` samples host CPU ticks and heap memory, preventing new heavy tasks when system memory is constrained.
- **Audit Result:** **PASS**. Full process trees terminated cleanly on task cancellation.

---

## 3. Summary of Automated Security Test Suites

| Security Test Suite | Location | Tests Run | Result | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **Frontend Credential Boundary** | `scripts/check-frontend-secrets.mjs` | 7 Bundles | **PASS** | Zero secret tokens in client bundles |
| **SSRF Gate & Host Blocking** | `scripts/universal-acceptance-audit.ts` | 3 Scenarios | **PASS** | `Blocked: true` on 127.0.0.1, localhost, 169.254.169.254 |
| **DevEngine Shell Security** | `server/src/dev/DevEngine.security.test.ts` | 6 Tests | **PASS** | Shell metacharacters rejected |
| **Native Agent Path & Origin** | `native/src/agent.origin.test.ts` | 8 Tests | **PASS** | Non-loopback origins refused |
| **ChildProcess Tree Termination**| `server/src/process/ChildProcessRegistry.test.ts` | 4 Tests | **PASS** | Recursive tree cleanup verified |

