# File System Agent — Phase 1.1

JARVIS's first real-world capability: a safe, typed, verified filesystem
toolset for the agent loop. This document covers the runtime reality, the
provider architecture, the tools and their permission/verification model, path
safety, bounds, and what is deliberately not implemented.

## 1. Runtime reality (decides everything below)

JARVIS runs as a plain browser SPA (React + Vite) with no native shell, no
Electron/Tauri wrapper and no PWA — there is **no raw OS file system from
JavaScript**. The only genuine browser surface is the **File System Access
API** (`showDirectoryPicker`), Chromium-only, which requires a user gesture and
a secure context, and is sandboxed to the directory the user grants.

Consequence: production code never simulates a file system. If real access is
unavailable, tools say so honestly. The deterministic in-memory provider exists
**strictly for tests** and is never bound in production (a dedicated test
proves this).

## 2. Capability seam

`src/filesystem/provider.ts` — `FileSystemProvider` + `FileSystemCapabilities`.

- Every provider reports, per operation, what the current runtime can actually
  do (`capabilities() → { available, reason?, hasApi, rootGranted, ops }`).
- All paths are relative to the provider root (`''` = root).
- Production default: `FileSystemAccessProvider` (`createFileSystemProvider`)
  over a user-granted directory handle. Without the API or a granted
  directory, every op fails with an honest `unavailable` structured error.
- Engine wiring: `new AssistantEngine({ providers?, fileSystem? })`; the engine
  auto-registers the `file.*` tools against the injected/default provider and
  exposes `engine.fileSystemProvider`. `start()` reports
  `capabilities.fileSystemAvailable` honestly (Settings panel row included).

```
JARVIS Web UI → Agent Core (Phase 1.0) → file.* tools → FileSystemProvider
    → Browser File System Access API (user-granted directory)
    → Native Windows agent (Phase 1.2) implementing the same interface
      (see ./native-windows-agent.md; native application control arrived in
      Phase 1.3 on the same seam: ./native-windows-applications.md)
```

The seam is the extension point for a native/desktop JARVIS: implement
`FileSystemProvider` natively, inject it, done — no engine changes. Phase 1.2
did exactly that: `src/native/NativeWindowsFileSystemProvider` talks to a real
local agent (`native/src/agent.ts`) over JSON-RPC/HTTP and binds real Windows
filesystem operations into the same `file.*` tools and verification pipeline.
The browser provider and the native bridge are interchangeable in the engine,
and only one is wired at a time via `createDefaultAppFileSystemProvider()`.

## 3. Tools

Eleven focused tools (`src/filesystem/FileSystemTools.ts`,
`createFileSystemTools(provider)`), registered under `file.*` following the
existing Tool/registry conventions:

| Tool | Tier | Verifiable |
| --- | --- | --- |
| `file.status` | read_only | — (honest capability report) |
| `file.list` | read_only | — |
| `file.search` | read_only | — |
| `file.stat` | read_only | — |
| `file.read` | read_only | — |
| `file.mkdir` | low_risk | ✅ (directory exists) |
| `file.write` | low_risk | ✅ (file exists; explicit `overwrite: true`) |
| `file.copy` | low_risk | ✅ (destination exists; explicit overwrite) |
| `file.move` | low_risk | ✅ (source gone AND destination exists) |
| `file.rename` | low_risk | ✅ (old gone AND new exists) |
| `file.delete` | **user_confirmation** | ✅ (target absent) |

`file.delete` is treated as high-risk: it goes through the existing
`tool-confirm` approval flow **on every execution**, never runs autonomously,
and is layered with repeated-action protection and post-deletion verification.
The Phase 1.0 permission policy (`high_risk → refused`) is untouched.

## 4. Verification ("never claim it until confirmed")

Writers re-check real provider state after executing (same Phase 1.0 system:
`verify()` + `runToolVerification` + `[verified]/[unverified]/[verification
failed]` suffixes). If the provider cannot confirm, the verifier says so —
never a fake success. Move/rename verify both sides; delete verifies the target
is gone.

## 5. Path safety

`src/filesystem/paths.ts` — all user paths are untrusted. `normalizeSafePath`
accepts `/` or `\`, collapses `.`/empty segments, resolves `''` to the root and
rejects:

- traversal (`..`) — never silently escapes the granted root,
- absolute paths and drive letters (`/etc`, `C:\...`),
- control characters, reserved device names (`CON`, `NUL`, `COM1`, …),
- ambiguous targets (rename/mkdir use `validateSegmentName`: no separators,
  no `.`/`..`, no reserved names).

The production provider re-validates every path even when called directly
(defense in depth).

## 6. Bounds

`src/filesystem/limits.ts` — listings cap at `MAX_LIST_RESULTS` (200), searches
at `MAX_SEARCH_RESULTS` (100) with `MAX_SEARCH_DEPTH` (4) and
`MAX_SEARCH_TIME_MS` (4000); reads cap at `MAX_READ_BYTES` (512 KiB, oversized
reads fail rather than truncate); writes cap at `MAX_WRITE_CHARS` (100k);
copies/moves cap at `MAX_COPY_BYTES` (4 MiB). Searches never scan the whole
computer; `file.read` feeds only a bounded preview into model context.

## 7. Honesty rules

- No fake filesystem operations, ever. No "Moved." for an in-memory change.
- Unavailable providers return structured `unavailable` failures; the model
  reasons over them.
- Failed/confirmed/declined states are always surfaced to the model
  (`[verified]`, `[unverified]`, `[verification failed: …]`, `(tool_failure)`).
- Credential stores, private keys and tokens are never targets of reads.

## 8. Tests

- `paths.test.ts`, `limits.test.ts` — unit safety/bounds.
- `FileSystemTools.test.ts` (scenarios A–X) — every tool against the
  deterministic `FakeFileSystemProvider` (`src/filesystem/testing.ts`,
  test-only), asserting real observed state (in-memory tree) after each op,
  permission tiers, verification outcomes, overwrite/traversal/unavailable
  honesty.
- `agentCore.filesystem.engine.test.ts` (scenarios Y–AD) — the **real** engine
  loop (ScriptedProvider + injected fake): multi-step verified workflow, step
  failure recovery, repeated-action blocking, delete confirmation &
  cancellation, honest capability reporting, start() truth, and the proof that
  production never binds to the fake.

## 9. Explicitly deferred (not implemented)

Unrestricted native file access, the File System Access API browser UI
(showing/wiring the picker in the chat UI), directory moves, Android device
files, WhatsApp/calls/notifications/app-launching, and desktop/OS scripting.

## 10. Recommended next milestone

A native-tier JARVIS (Electron/Tauri or a Windows agent) implementing the same
`FileSystemProvider` interface over the real OS, giving `file.*` tools genuine
local access and unlocking the next capability tier (apps, notifications,
automation) through the same Phase 1.0 contracts.