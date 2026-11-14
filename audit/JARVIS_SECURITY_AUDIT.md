# JARVIS 4.0 — COMPREHENSIVE SECURITY & PERMISSIONS AUDIT
## Independent Threat Model | Static Code Analysis | Attack Surface Evaluation

**Audit Target:** JARVIS 4.0 (`D:\JARVIS`)  
**Git Branch:** `ui/advanced-hud-polish`  
**Git Commit HEAD:** `7ce486e Working`  
**Audit Date:** November 13, 2026  
**Security Classification:** Highly Sensitive — Engineering Audit Report  

---

## 1. Executive Summary

A thorough, non-destructive security evaluation of the JARVIS 4.0 architecture, backend services, execution engines, and communication channels was conducted. JARVIS operates as an agentic AI system with extensive host privileges on Windows 11, including arbitrary child process execution, Start Menu application discovery, Win32 window manipulation, and raw filesystem manipulation.

While the project exhibits thoughtful defensive implementations (such as junction/symlink resolution in `isSafeInside` and secret masking in loggers), **critical security design flaws exist in workspace sandboxing, action authorization, and session issuance** that allow an untrusted actor or malicious prompt to modify sensitive host directories and execute commands outside intended project boundaries.

---

## 2. Threat Modeling & Attack Surface

JARVIS exposes five primary attack surfaces:

```
                    ┌───────────────────────────────┐
                    │       User / Attacker         │
                    └───────┬───────────────┬───────┘
                            │               │
               HTTP / REST  │               │ Browser Prompts / Chat
             Port 8787/8788 │               │
                            ▼               ▼
                   ┌─────────────────────────────────┐
                   │   HTTP Server / API Gateway     │
                   │    (server/src/http.ts)         │
                   └────────┬────────────────┬───────┘
                            │                │
            Internal Dispatch│                │ LLM Tool Plan
                            ▼                ▼
                   ┌─────────────────────────────────┐
                   │    TaskService / DevEngine      │
                   │ (server/src/dev/DevEngine.ts)   │
                   └────────┬────────────────┬───────┘
                            │                │
       Filesystem Operations│                │ Child Processes (PowerShell/npx)
                            ▼                ▼
                   ┌─────────────────────────────────┐
                   │  Host Operating System / Win11  │
                   │ (C:\Windows, AppData, Registry) │
                   └─────────────────────────────────┘
```

1. **Loopback REST & SSE API (`127.0.0.1:8787`):** Unauthenticated endpoints and weak origin validation.
2. **Phone Companion Listener (`0.0.0.0:8788`):** Bound to all interfaces (`0.0.0.0`), exposing the system to local network (LAN) scanning and unauthorized connections.
3. **Native WebSocket Bridge (`127.0.0.1:8765`):** High-privilege Win32 agent communication.
4. **Development Engine Execution (`DevEngine.ts`):** Direct disk read/write and process spawning.
5. **Prompt Injection / Indirect Prompt Injection:** Untrusted web search snippets or file contents influencing LLM tool calls.

---

## 3. Deep-Dive Vulnerability Analysis

### 3.1 VULN-SEC-01: Unrestricted `projectPath` Workspace Boundary (CWE-22)
- **CVSS 3.1 Score:** **8.8 (High)** `CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H`
- **Location:** `server/src/dev/DevEngine.ts` (Lines 54-57, 126-140)
- **Vulnerability Details:**
  `DevEngine` implements `resolveProjectDir` to validate project roots:
  ```typescript
  function isAbsoluteProjectPath(value: string): boolean {
    if (process.platform === 'win32') return /^[a-zA-Z]:\\/.test(value)
    return isAbsolute(value)
  }
  ```
  The logic solely confirms that the path is syntactically an absolute Windows path (e.g. `C:\...` or `D:\...`).
  There is **no workspace root restriction, no directory allowlist, and no user confirmation prompt**.
  While `resolveProjectFile` verifies that target files reside inside `projectPath` via `isSafeInside`, an attacker or untrusted script can provide:
  - `projectPath = "C:\\Windows\\System32"`
  - `projectPath = "C:\\Users\\<username>\\.ssh"`
  - `projectPath = "C:\\Users\\<username>\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"`
  Once set, `DevEngine.patchFile` can create or overwrite files in these directories (such as placing a malicious `.bat` or `.vbs` in the Windows Startup folder), and `DevEngine.runTests` will execute commands within that working directory.
- **Remediation Code Snippet:**
  Enforce a hard allowlist of designated workspace roots:
  ```typescript
  const ALLOWED_WORKSPACE_ROOTS = [
    resolve(process.env.JARVIS_WORKSPACE || 'D:\\JARVIS\\workspaces')
  ];

  function isAllowedWorkspace(candidate: string): boolean {
    const realCandidate = resolve(candidate);
    return ALLOWED_WORKSPACE_ROOTS.some(root => isSafeInside(root, realCandidate));
  }
  ```

---

### 3.2 VULN-SEC-02: Missing Default-Deny Authorization on Dangerous Dev Actions (CWE-862)
- **CVSS 3.1 Score:** **8.4 (High)** `CVSS:3.1/AV:L/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:H`
- **Location:** `server/src/taskService.ts` (Lines 180-192)
- **Vulnerability Details:**
  The authorization subsystem gates actions before execution based on an insecure string heuristic:
  ```typescript
  const isSensitive = 
    payload.action?.includes('delete') ||
    payload.action?.includes('destroy') ||
    payload.action?.includes('sensitive') ||
    payload.action?.endsWith('.deleteProbe');
  ```
  Dangerous actions that mutate files or spawn processes:
  - `dev.patchFile` (Arbitrary code writing)
  - `dev.createFile` (Arbitrary file creation)
  - `dev.runTests` (Arbitrary command execution via `npx vitest` / `node`)
  - `dev.runScript` (Direct script execution)
  do **not** contain the substring `'delete'`, `'destroy'`, or `'sensitive'`.
  As a result, they completely bypass the human approval gate (`status: 'pending_approval'`) and run autonomously without operator awareness.
- **Remediation:**
  Invert authorization to a **Default-Deny** model. Any action with side effects (filesystem writes, command execution, network mutations) must explicitly require operator confirmation unless granted via a cryptographically signed session permission policy.

---

### 3.3 VULN-SEC-03: Session Cookie Handout with Origin Bypass (CWE-352 / CWE-346)
- **CVSS 3.1 Score:** **7.5 (High)** `CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:N`
- **Location:** `server/src/http.ts` (Lines 352-378)
- **Vulnerability Details:**
  In `server/src/http.ts`, `GET /api/session` handles incoming requests to establish a session:
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
  The origin check is wrapped entirely in `if (rawOrigin !== undefined)`. When an HTTP request is made without an `Origin` header (such as simple GET requests from scripts, curl, or standard `<a>` / `<img>` / window opens), `rawOrigin` is `undefined`.
  The server skips the origin check entirely, generates a fresh session identifier, sets `Set-Cookie: jarvis_session=...; Path=/; SameSite=Lax`, and returns the full session payload.
- **Remediation:**
  1. For local loopback security, require a pre-shared token generated at backend startup and stored in `.jarvis/auth.token`.
  2. The frontend HUD must read this token or pass it via `Authorization: Bearer <token>` on all API requests.

---

### 3.4 VULN-SEC-04: Command Injection Risk via Unescaped Shell Arguments (CWE-78 / Node DEP0190)
- **CVSS 3.1 Score:** **6.5 (Medium)** `CVSS:3.1/AV:L/AC:L/PR:L/UI:R/S:U/C:H/I:H/A:H`
- **Location:** `server/src/dev/DevEngine.ts` (Lines 220-245)
- **Vulnerability Details:**
  During test execution, `runProcess` invokes `child_process.spawn` on Windows with `shell: true`:
  ```typescript
  const child = spawn(execCmd, args, {
    cwd,
    shell: true,
    windowsHide: true,
    env: processEnv,
  });
  ```
  During live execution, Node.js emitted warning:
  `(node:26532) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.`
  When `shell: true` is enabled on Windows (`cmd.exe`), arguments containing metacharacters (`&`, `|`, `^`, `%`, `"`) can break out of the intended argument string and execute secondary commands.
- **Remediation:**
  1. Set `shell: false` whenever spawning known executables (`node.exe`, `git.exe`, `npx.cmd`).
  2. When spawning batch files (`.cmd`), use `spawn('cmd.exe', ['/d', '/s', '/c', ...])` with explicit argument quoting rules (`quoteWin32Arg`).

---

### 3.5 VULN-SEC-05: Phone Companion Interface Bound to `0.0.0.0` (CWE-1327)
- **CVSS 3.1 Score:** **5.3 (Medium)** `CVSS:3.1/AV:A/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:N`
- **Location:** `server/src/companion.ts` (Lines 80-110)
- **Vulnerability Details:**
  The phone companion server binds to port `8788` on host `0.0.0.0`. While this enables mobile devices on the same Wi-Fi network to connect, it also exposes the companion pairing endpoint to all local network interfaces without TLS/HTTPS encryption.
- **Remediation:**
  1. Provide an option in Settings to bind companion exclusively to `127.0.0.1` unless pairing mode is explicitly activated.
  2. Enforce cryptographic pairing via ECDH / QR code pin before any telemetry or commands can be transmitted over LAN.

---

## 4. Positive Security Controls (Defenses That Work)

The audit noted several robust security implementations already present in the codebase:

1. **Junction & Symlink Resolution (`isSafeInside`):**
   `DevEngine.ts` calls `realpathSync` to resolve symbolic links and Windows directory junctions, preventing attackers from bypassing project boundaries via relative symlinks pointing to parent drives.
2. **Log Sanitization (`Logger.ts`):**
   `Logger.ts` applies regex filters (`SECRET_PATTERNS`) to redact bearer tokens, API keys (Anthropic, Gemini, OpenAI), and passwords before outputting log records to stdout or disk.
3. **Task Child Process Tree Killing (`ChildProcessRegistry.ts`):**
   `ChildProcessRegistry` implements process tree traversal on Windows (`taskkill /F /T /PID <pid>`), ensuring that when a task is canceled, all descendant processes (such as Vitest workers or Python interpreters) are reliably terminated rather than orphaned.
4. **Deterministic Plan Validation (`validatePlan.ts`):**
   The bounded planner in `src/engine/goal/validatePlan.ts` strictly rejects reserved parameters (`stepIndex`, `systemPrompt`, etc.) and prevents untrusted models from spoofing internal engine instructions.

---

## 5. Security Action Plan & Recommendations

```
┌────────────────────────────────────────────────────────────────────────┐
│                        SECURITY ACTION ROADMAP                         │
├──────────────────┬─────────────────────────────┬───────────────────────┤
│ Phase            │ Actions                     │ Target Window         │
├──────────────────┼─────────────────────────────┼───────────────────────┤
│ P0: Lockdown     │ 1. Add ALLOWED_WORKSPACE_ROOTS boundary check in DevEngine.  │ Immediate (24 Hours)  │
│                  │ 2. Require approval for createFile, patchFile, runTests.    │                       │
│                  │ 3. Fix GET /api/session origin check & generate local token.│                       │
├──────────────────┼─────────────────────────────┼───────────────────────┤
│ P1: Hardening    │ 4. Eliminate shell: true in child_process.spawn.            │ Short-Term (1 Week)   │
│                  │ 5. Restrict companion listener 8788 to loopback or PIN gate.│                       │
│                  │ 6. Add CSRF anti-forgery headers on state-mutating routes.   │                       │
├──────────────────┼─────────────────────────────┼───────────────────────┤
│ P2: Verification │ 7. Add automated penetration tests in Vitest suite.         │ Next Sprint           │
│                  │ 8. Audit all native Win32 API calls in native agent.        │                       │
└──────────────────┴─────────────────────────────┴───────────────────────┘
```

