# Native Windows Agent — Phase 1.2 + 1.3

JARVIS's first true native capability: a small, local **Windows filesystem
agent** that performs REAL operations on the REAL OS — via typed,
allow-listed operations only — surfaced to the web app through the same
`FileSystemProvider` seam the browser provider uses. Anything the agent does
happens inside explicitly configured **allowed roots**, and every capability
report stays honest: when the agent is down, the app says so and never fakes
a file system. Phase 1.3 adds native application control (`app.list` /
`app.status` / `app.launch`) on the same agent — see
[Native Windows Applications (Phase 1.3)](./native-windows-applications.md) —
and Phase 1.4 adds read-only Windows observation (`window.list` /
`window.status` / `desktop.screenshot`) — see
[Native Windows Observation (Phase 1.4)](./native-windows-observation.md) —
and Phase 1.5 adds bounded desktop interaction (`desktop.cursor/move/click/
scroll/key_press/type`, `window.focus`) — see
[Native Windows Desktop Interaction (Phase 1.5)](./native-windows-desktop-interaction.md).
Phase 1.6 adds browser-side **voice input** (wake word + spoken commands
feeding the same engine) �?" see
[Voice Interaction (Phase 1.6)](./voice-interaction.md).
Phase 1.7 adds **visual understanding + closed-loop computer control**
(`desktop.visualInspect` / `desktop.visualClick` / `desktop.visualType`
composing the observation + desktop providers through an optional
`VisionProvider` seam) �?" see
[Visual Understanding (Phase 1.7)](./visual-understanding.md).

Related: [Agent Architecture (Phase 1.0)](./agent-architecture.md),
[File System Agent (Phase 1.1)](./filesystem-agent.md).

## 1. Runtime reality and the architecture choice

JARVIS is a plain browser SPA — no Electron/Tauri, no Chrome extension. The
browser sandbox cannot touch the OS filesystem beyond the user-granted File
System Access directory. For Phase 1.2 we added a **separate local Node.js
process** (the "agent") that the web app talks to:

```
JARVIS Web UI → Agent Core (Phase 1.0) → file.* tools → FileSystemProvider
    → [browser] File System Access API (user-granted directory)
    → [native] NativeWindowsFileSystemProvider
             → JSON-RPC 2.0 over HTTP (127.0.0.1, bearer token)
             → native/src/agent.ts → RealFsBackend → REAL Windows fs
```

Why a separate process instead of bundling Node into Electron/Tauri: the repo
is dependency-light and browser-first; Node is already installed
(devDeps include `@types/node`); the agent uses only Node builtins
(`node:http`, `node:fs`, `node:path`, `node:os`, `node:crypto`) — **zero new
npm dependencies**. The web side keeps one injected provider class.

## 2. Security boundary (never an arbitrary command runner)

The agent is intentionally **not** a shell or a "do anything" service:

- **Typed allow-list only.** `NATIVE_METHODS` in `native/src/protocol.ts`
  allows `system.identity`, `system.ping`, the eleven `filesystem.*`
  operations and (Phase 1.3) `app.list` / `app.status` / `app.launch`. There
  is **no** `system.execute`/shell endpoint — asking for one returns
  `unsupported` (covered by a test).
- **Bearer token by default.** Constant-time comparison; the agent refuses to
  start without one unless `--no-token` is passed explicitly for loopback dev.
  The token is sent only to `127.0.0.1`. `CORS *` is set on the agent so the
  web app can call it, but the token is never exposed to other origins.
- **Allowed roots only.** Roots are absolute paths from config/env/CLI. The
  **default root is the scratch dir `{temp}/jarvis/workspace`** (created at
  startup) — no hard-coded personal paths; personal folders must be granted
  explicitly. Every request resolves inside the selected root.
- **Path safety, three independent layers (defense in depth):**
  1. the broker (`agent.ts`) rejects traversal/absolute/UNC/drive-letter
     escapes before any backend sees the path;
  2. the backend (`paths.ts`) re-validates and normalizes;
  3. realpath containment (`assertInsideRootRealpath`) blocks symlink/junction
     escapes out of the root.
- **Bounds everywhere:** read ≤ 512 KiB, write ≤ 100 k chars, copy ≤ 4 MiB,
  list ≤ 200, search ≤ 100 results / depth 4 / 4 s, body ≤ 1 MiB, request
  timeout 15 s. Never trust a client's "limit" blindly — the agent clamps.
- **No raw OS errors leak** — every failure is a structured
  `NativeErrorCode` envelope.
- The **root may never be deleted/moved/renamed/copied onto**; writes to the
  root itself are rejected.

Limits are declared once in `native/src/limits.ts` and mirrored by the web
side's `FS_LIMITS` contract in the provider.

## 3. Protocol (JSON-RPC 2.0 over loopback HTTP)

`native/src/protocol.ts`:

- Envelope: `{ jsonrpc: '2.0', id, method, params }` → `{ jsonrpc, id, result }`
  or `{ jsonrpc, id, error: { code, message, data? } }`; the response always
  echoes the request `id` (correlation).
- Error codes: `malformed`, `permission_denied`, `not_found`,
  `already_exists`, `invalid_path`, `outside_allowed_root`, `unsupported`,
  `too_large`, `timeout`, `verification_failed`, `io_error`, `native_unavailable`.
- The web bridge maps these to `FileSystemError` kinds
  (`outside_allowed_root`/`permission_denied` → `permission_denied`,
  `already_exists` → `exists`, etc. — never raw text).

## 4. Code map

| Piece | Where | What it is |
| --- | --- | --- |
| Protocol & limits | `native/src/protocol.ts`, `native/src/limits.ts` | typed wire contract, caps |
| Path safety | `native/src/paths.ts` | traversal/name/realpath containment |
| Real backend | `native/src/backend.ts` (`RealFsBackend`) | REAL `fs.promises` operations, bounds, not marked tests-only |
| Test backend | `native/src/testingBackend.ts` (`MemoryFsBackend`) | deterministic in-memory, `testsOnly: true`, **never** production |
| Broker | `native/src/agent.ts` (`startAgent`) | HTTP server: auth, body cap, allow-list, timeout, roots |
| CLI | `native/src/agentMain.ts` | `npm run native:agent` entry, flags/config/env, shutdown |
| Web bridge | `src/native/NativeWindowsFileSystemProvider.ts` | `FileSystemProvider` over the protocol |
| App bootstrap | `src/native/index.ts` | picks native bridge when `VITE_NATIVE_AGENT_URL` set |
| Config example | `native/agent.config.example.json` | roots/token/host/port/apps sample |
| Application control | `docs/native-windows-applications.md` | Phase 1.3: `app.*` allow-list, launch path, verification |

Engine integration needs NO engine changes: the bridge is just another
`FileSystemProvider`, so the Phase 1.0 loop, per-step verification and the
delete-confirmation boundary work unchanged.

## 5. Running and configuring

```sh
npm run native:check   # typecheck the agent (no emit)
npm run native:build    # emit native/dist/
npm run native:agent    # run the agent (first build it)
```

Flags: `--port --host --token --no-token --root --config --print-identity
--help`. Env: `JARVIS_NATIVE_TOKEN`. Precedence: CLI → env → config file →
`--no-token`. The agent prints its identity banner and shuts down on Ctrl+C.

Web side (`.env`):

```
VITE_NATIVE_AGENT_URL=http://127.0.0.1:8765
VITE_NATIVE_AGENT_TOKEN=<same token as the agent>
```

When `VITE_NATIVE_AGENT_URL` is **unset** the app keeps using the browser
File System Access provider — the native bridge is strictly opt-in. Capability
reporting stays honest on both sides: `Settings` shows a **Native Windows
agent: Connected/Unavailable** row and the file system row reads
**Native (local agent)** / **Browser**.

## 6. Real verification

Operations are verified against the REAL operating system state after they run
(matching the Phase 1.0 "never claim it worked unless confirmed" rule): a
`mkdir` is confirmed by a real stat, a `write` by re-reading bytes from disk, a
`move` by destination-present + source-absent, a `delete` by the path being
absent. The live smoke test and the engine integration tests assert the
`[verified]` marker flows end to end, including across the JSON-RPC bridge and
through the explicit delete confirmation.

## 7. Testing

- `native/src/paths.test.ts`, `native/src/backend.test.ts` — path safety and
  REAL operations in an isolated `mkdtemp` temp root (junction-escape test
  skips if the OS denies link creation).
- `native/src/agent.test.ts` — protocol against the in-memory backend on an
  ephemeral port: auth, allow-list, malformed/oversized/timeout envelopes,
  correlation, root-index escape, boundaries.
- `native/src/webBridge.*.test.ts` — the web bridge + engine loop against a
  live local agent, plus disconnect/reconnect/malformed honesty and the proof
  that production never ships fakes; these tests run under vitest.

Tests never touch a developer's real folders: they use the in-memory backend
or an isolated temp directory.

## 8. Explicitly not implemented (Phase 1.2 + 1.3 scope)

- No arbitrary shell/command execution (by design).
- No screenshots, desktop automation, or Android — these remain future seams
  on the same typed method pattern, never raw command passthrough. Application
  control was delivered in Phase 1.3 (`app.list`/`app.status`/`app.launch`,
  see the linked doc) and stays bound to a fixed executable per registered id
  — never arguments, never a shell.
- No remote (non-loopback) exposure; no TLS (loopback + token only).