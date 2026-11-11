# Native Windows Observation — Phase 1.4

JARVIS's third native capability, on the same local agent as Phases 1.2/1.3:
**Windows observation** — `window.list`, `window.status`, `desktop.screenshot` —
that reads the REAL desktop (window inventory, per-window state, the actual
screen pixels) through bounded Win32 FFI (`koffi`), behind the same typed
loopback protocol and the same provider seam (`ObservationProvider`) used by
every other capability.

This phase is explicitly **EYES, NOT HANDS**: it can enumerate and inspect
windows and capture the screen, and it can do *nothing else*. There is no
focus/move/click/type verb, no UI automation, and no generic command surface.
Observation is permissioned and verifiable exactly like the previous phases —
"never claim it worked unless confirmed" applies verbatim.

Related: [Visual Understanding (Phase 1.7)](./visual-understanding.md),
[Native Windows Desktop Interaction (Phase 1.5)](./native-windows-desktop-interaction.md),
[Native Windows Applications (Phase 1.3)](./native-windows-applications.md),
[Native Windows Agent (Phase 1.2)](./native-windows-agent.md),
[File System Agent (Phase 1.1)](./filesystem-agent.md),
[Agent Architecture (Phase 1.0)](./agent-architecture.md).
Spoken commands can drive this surface via the same engine entry point �?"
see [Voice Interaction (Phase 1.6)](./voice-interaction.md).

## 1. What it does

The agent gains three typed methods over the same JSON-RPC loopback channel:

| Wire method | Web tool | Meaning | Permission tier |
| --- | --- | --- | --- |
| `window.list` | `window.list` | top-level windows, deterministically ordered | `read_only` |
| `window.status` | `window.status` | inspect one window (title/process/state/bounds) | `read_only` + `verifiable` |
| `desktop.screenshot` | `desktop.screenshot` | capture the ENTIRE primary screen as a bounded PNG | `user_confirmation` + `verifiable` |

- `window.list` returns up to `MAX_WINDOWS` (64) entries — window id, title,
  owning process **name** (never a path), visible/minimized/maximized state and
  optional bounds — ordered visible-first then by title. A focused window is
  always kept within the cap.
- `window.status` re-inspects the OS for one decimal window id and reports
  `exists` — the tool is **verifiable** against that reality (a window that
  vanished is reported `not_found`, never invented).
- `desktop.screenshot` captures the whole primary screen at real resolution
  (never cropped, never downscaled). It is the only privacy-sensitive surface,
  so it **always requires explicit user confirmation** and its verification is
  a **transport-level structural PNG check** — signature, header geometry
  matching the claim, per-chunk CRC, and a deflate stream that inflates to
  exactly the expected scanline budget. It never claims to *depict* a specific
  screen; that honesty belongs to the FFI bridge.

## 2. Security boundary (read-only, bounded, transient)

- **EYES, NOT HANDS.** The registered method surface is exactly the three tools
  above. Asking for `window.move`, `window.focus` or `desktop.press` returns
  `unsupported` (asserted in unit tests *and* the live smoke). Nothing in the
  bridge can focus, move, click or type, and the observation layer never
  touches any input-synthesis API.
- **No shell, no utilities.** Enumeration is pure `EnumWindows`, process title
  reads are `GetWindowTextW`, capture is `BitBlt` + `GetDIBits`. There is no
  `cmd`/`PowerShell`/`tasklist`/system-tool dependency anywhere — a static
  source-scan test (`obsWin32.test.ts`) enforces that the file contains no
  shell or automation words and no process-inventory tool names.
- **Bounds, single-sourced** in `native/src/obsLimits.ts` (mirrored in
  `src/observation/limits.ts`): 64 windows, 256-char titles, 4096×4096 capture
  size, **3 MiB** for the returned PNG (so its base64 fits under the 6 MiB RPC
  cap), a separate dims-derived transient raw-buffer budget, and a 1.5 s
  capture wall-clock. A capture that would exceed a bound is answered with a
  structured `too_large`/`timeout` — never silently truncated or downscaled.
- **Opaque ids.** A window id is a decimal string (`/^\d{1,10}$/`) derived from
  the platform handle; it is never a pointer, a path or a command, and is
  rejected if it looks like one (before it ever reaches the agent).
- **Transient screenshots.** The PNG exists only as a base64 string in one
  response; it is never written to disk, logged, uploaded or persisted. The
  live smoke test asserts the workspace file-list is unchanged before and after
  a capture.
- **Honest failures.** Non-Windows platforms answer `unsupported`; a failed FFI
  load answers `native_unavailable`; a closed window answers `not_found`. A
  screenshot is never generated from a buffer, a fixture or a fake.

## 3. Provider seam (web side)

- `src/observation/provider.ts` — the contract: `ObservationProvider`
  (`listWindows`, `getWindowStatus`, `captureScreenshot`, `capabilities`,
  optional `refreshNativeStatus`), `WindowSummary`, `WindowStatus`
  (`exists`), `ScreenshotResult`, the shared `WINDOW_ID_PATTERN` +
  `normalizeWindowId`.
- `src/observation/ObservationTools.ts` — `createObservationTools(provider)`
  builds `window.list`, `window.status` (verifiable) and `desktop.screenshot`
  (user-confirmation + verifiable). With **no provider it returns an empty
  toolset** — browser mode registers no observation tools and fakes nothing.
- `src/native/NativeWindowsObservationProvider.ts` — the real bridge over the
  protocol, sharing the same `NativeAgentRpc` transport (identity probe, error
  mapping, honest `available:false` when the agent is down) as the 1.2/1.3
  bridges.
- No engine redesign: `AssistantEngine` takes an optional `observation`
  provider; `start()` probes it and reports `nativeObservationAvailable`
  honestly in the capability row. The app bootstrap
  (`createDefaultAppObservationProvider`) returns the bridge when
  `VITE_NATIVE_AGENT_URL` is set and `undefined` otherwise.

## 4. How the native capture works

`native/src/obsWin32.ts` lazily loads `koffi` (a pinned, MIT-licensed FFI
addon) on first use and declares a tiny typed Win32 surface:
`EnumWindows` (with a shared callback type), `GetWindowTextW`,
`IsWindowVisible/Iconic/Zoomed`, `GetWindowRect`,
`GetWindowThreadProcessId`, `QueryFullProcessImageNameW`, `GetSystemMetrics`,
`GetDC`/`BitBlt`/`GetDIBits`. Handles are opaque `HWND`s declared as `uint64`
(BigInt). Pixels come back as top-down BGRA; `native/src/png.ts` encodes a
real PNG (RGBA, filter 0, CRC-32) with no native encoder dependency.

No configuration is required beyond the Phase 1.2 agent setup — observation
needs no config file section.

## 5. Running

Identical to Phases 1.2/1.3 (`npm run native:build` + `npm run native:agent`,
or just `npm run native:agent` on the same loopback port), then set
`VITE_NATIVE_AGENT_URL` in the web app. The native bearer token stays in the
backend process and browser calls pass through `/api/native/rpc`. On non-Windows the agent itself still starts and answers `unsupported` for
observation — observation is never faked.

## 6. Testing

- `native/src/png.test.ts` — real encoder round-trips: structural integrity,
  inflate-consistent pixel budget, `RangeError` on size mismatch, a large
  gradient capture.
- `native/src/obsWin32.test.ts` — the no-shell / no-hands static source scan
  (no `tasklist`/`PowerShell`/focus/move/adverb-of-hands words), positive
  bounds, window-id charset, and the allow-list of methods that may exist.
- `native/src/testingObs.ts` + `native/src/agent.test.ts` — deterministic
  `MemoryObsBackend`, deterministic ordering, `window.*` allow-list, malformed
  ids, `window.move`/`window.focus`/`desktop.press` → `unsupported`.
- `native/src/webBridge.observation.test.ts` — the **web** bridge against a
  live local agent + memory backend: honest caps, deterministic list, status
  exists, structured `not_found`/`invalid_path`, transient PNG verification,
  agent-down reconnect. (Excluded from `native:check`; runs under vitest.)
- `src/observation/ObservationTools.test.ts` — permission tiers, screenshot
  confirmation + structural verification (incl. tamper refutation), closed-
  window honesty, id validation, no provider → empty toolset.
- `src/observation/agentCore.observation.engine.test.ts` — the real agent loop:
  registration seam, browser-mode no-tools proof, honest capability rows,
  `window.list → window.status → [verified]`, closed-window failure, malformed-
  id blocked before the provider, **strict confirmation gate on
  `desktop.screenshot`** (cancel ⇒ zero captures), repeated-action guard.
- Live smoke on this Windows box: identity (1.4.0 / win32) → unauthenticated
  call rejected (`permission_denied`) → 64 real windows in ≤21 ms with real
  titles/pids → status confirms a real window exists → real 1536×864 capture
  verifies as a structurally valid PNG (90 KB) → no disk artifacts → unsupported
  method + malformed id envelopes.

## 7. Explicitly not implemented (Phase 1.4 scope)

- No focus/move/click/type inside **observation** (those live in the separate
  Phase 1.5 desktop-interaction module); observation itself feeds only the
  read-only `window.list` / `window.status` / `desktop.screenshot` surface.
- No per-window or region capture; no video/streaming; screenshots are a
  single bounded still.
- No semantic "vision" claim: the model receives text metadata and a
  structurally verified PNG; the PNG can be displayed by the UI but is not
  fed to an image model.
- No persistence of any captured pixel anywhere (disk, logs, uploads).
- No remote exposure, TLS or multiplexing beyond the existing loopback +
  bearer-token transport. Non-Windows observation stays `unsupported`.
