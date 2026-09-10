# Native Windows Desktop Interaction — Phase 1.5

The fourth native capability on the same local agent as Phases 1.2–1.4:
**desktop interaction** — cursor, mouse clicks, scroll, keystrokes, typing and
window focus — injected into the REAL Windows desktop through bounded Win32 FFI
(`koffi`), behind the same typed loopback protocol and the same provider seam
(`DesktopProvider`) used by every other capability.

This phase is explicitly **HANDS (bounded), NOT AUTONOMY**: each operation is a
single, synchronous, bounded input action that is injected and then honestly
reported — the agent can state exactly what it injected and what it verified,
and it **never claims a semantic effect it cannot see** (a cursor lands where
requested; a window is foreground now; a click's consequence lives on screen).
There is no macro recorder, no UI-automation engine, no `sendkeys`/`cmd`/
PowerShell path, and no way to "run" anything.

Related: [Visual Understanding (Phase 1.7)](./visual-understanding.md),
[Native Windows Observation (Phase 1.4)](./native-windows-observation.md),
[Native Windows Applications (Phase 1.3)](./native-windows-applications.md),
[Native Windows Agent (Phase 1.2)](./native-windows-agent.md),
[File System Agent (Phase 1.1)](./filesystem-agent.md),
[Agent Architecture (Phase 1.0)](./agent-architecture.md).
A spoken voice can drive this surface through the same engine entry point �?"
see [Voice Interaction (Phase 1.6)](./voice-interaction.md).

## 1. What it does

The agent gains eleven typed methods over the same JSON-RPC loopback channel:

| Wire method | Web tool | Meaning | Permission tier |
| --- | --- | --- | --- |
| `desktop.capabilities` | `desktop.capabilities` | virtual desktop + enforced limits | `read_only` |
| `desktop.cursor` | `desktop.cursor` | measured cursor position | `read_only` |
| `desktop.move` | `desktop.move` | move cursor to ABSOLUTE screen coordinates | `low_risk` + `verifiable` |
| `desktop.click` | `desktop.click` | left-click in a window (client-relative) | `low_risk` |
| `desktop.doubleClick` | `desktop.double_click` | double-click in a window | `low_risk` |
| `desktop.rightClick` | `desktop.right_click` | right-click in a window | `low_risk` |
| `desktop.scroll` | `desktop.scroll` | wheel scroll in a window | `low_risk` |
| `desktop.keyPress` | `desktop.key_press` | one allow-listed key | `low_risk` |
| `desktop.hotkey` | `desktop.hotkey` | ≤`MAX_HOTKEY_KEYS` (4) allow-listed keys | `low_risk` |
| `desktop.type` | `desktop.type` | type allow-listed text | `low_risk` |
| `window.focus` | `window.focus` | bring a window to the foreground | `low_risk` + `verifiable` |

- **Coordinates are never mixed.** `desktop.move` / `desktop.cursor` use
  **absolute virtual-desktop screen coordinates** (origin may be negative on
  multi-monitor). `click` / `doubleClick` / `rightClick` / `scroll` **require a
  `windowId`** and use **client-relative** coordinates resolved via
  `GetClientRect` + `ClientToScreen`. The window id goes through
  `normalizeWindowId` before any wire call; a path, pointer or command-looking
  id is blocked locally.
- **Input allow-lists only**: keys are `a–z`, `0–9`, `f1–f12`, `enter`, `tab`,
  `escape`, `space`, `backspace`, `delete`, `home`, `end`, `pageup`, `pagedown`,
  `arrow_*`, `shift`, `control`, `alt`, `capslock` (+ aliases like `esc`/`ctrl`/
  `pgup`). The **WIN key is rejected** (`unsupported`) and never produced.
  Typed text has control characters rejected (tab/newline allowed) and is capped
  at `MAX_TYPE_TEXT_LENGTH` (2000).
- **Honesty over claim.** `desktop.move` verification re-reads the cursor and
  reports `verified:true` only if it landed exactly. `window.focus` reports
  `focused:true` only after a post-attempt foreground re-check. Clicks, keys and
  typing report `injected:true` but their tool messages say the effect is
  "not confirmed — inspect the window," and `verifiable:false` so the engine's
  verification is reported as `not_applicable` rather than invented.
- **Typed text never exists on the web side.** `desktop.type` returns only the
  injected **length**; the tool result/message, the plan, and the run trace all
  carry a redacted placeholder. The engine sanitizes `desktop.type` payloads at
  three recording points (`planTracker.addStep` input,
  `recordRejectedTraceStep`, `tracer.addStep`); the one wire transmission is
  between the agent and its memory backend, which logs the length only.

## 2. Security boundary (bounded, no shell, cancellable)

- **No shell, no utilities.** Input is injected through the user32
  `SendInput` / `SetCursorPos` / `SetForegroundWindow` family only — no `cmd`,
  `PowerShell`, `WScript`, clipboard writing or window-message automation. A
  static source-scan test enforces the file contains no "run a command" or
  automation-tool words.
- **Single, bounded actions.** `MAX_DESKTOP_ACTION_TIME_MS` (1500 ms) bounds each
  synchronous action; every action checks the caller's cancellation signal
  before acting (`cancelled:true` ⇒ nothing was injected). Real `SendInput`
  sequences are down/up pairs; there are **no queued macros**.
- **Strict bounds, single-sourced** in `native/src/desktopLimits.ts` (mirrored
  as `src/desktop/limits.ts`): 4 hotkey keys, 2000 typed chars, ±5000 scroll
  delta, ±10 000 client coordinates, ±1 000 000 screen coordinates, 1500 ms
  action budget. Out-of-bounds input is a structured error before injection.
- **Engine per-run budgets.** Each JARVIS run also budget the affected surfaces:
  `MAX_MOUSE_ACTIONS_PER_RUN` (50) and `MAX_KEY_ACTIONS_PER_RUN` (100, `src/
  desktop/budget.ts`). Counters reset in `process()`; a run that exceeds a
  budget is blocked as `orchestration_limit` — pure, unit-tested helper logic
  (`desktopBudgetBucket`/`desktopBudgetExceeded`/`desktopBudgetLabel`) so the
  engine stays dumb. Today's agent loop caps at 8 steps, so the budgets
  themselves are unreachable by iteration — they exist as a hard backstop and a
  diagnostics surface (`engine.desktopBudget()`); the **repeated-action guard**
  (3 identical actions) binds real loops first and is exercised by the engine
  tests.
- **Structured error mapping.** `window_not_found → not_found`, `window_not_
  interactable → unavailable`, `coordinate_out_of_bounds → invalid_path`,
  `unsupported_key → unsupported`, `invalid_argument → invalid_path`,
  `cancelled → unavailable` (in `src/native/nativeRpc.ts` `mapNativeCode`).
- **Opaque ids, honest failures.** Window ids are decimal strings, never
  pointers; on non-Windows the agent answers `unsupported` and the bridge
  reports `available:false` when the agent is unreachable — desktop interaction
  is never faked.

## 3. Provider seam (web side)

- `src/desktop/provider.ts` — the contract: `DesktopProvider` (`cursor`,
  `moveMouse`, `click`, `doubleClick`, `rightClick`, `scroll`, `keyPress`,
  `hotkey`, `typeText`, `focusWindow`, `capabilities`, optional
  `refreshNativeStatus`), the `DesktopKeyResult`/`DesktopClickResult`/… result
  types, the web-side validators (`normalizeDesktopKey`, `parseDesktopKey`,
  `parseHotkeyKeys`, `parseTypeText`, `parseClientCoord`, `parseScreenCoord`,
  `parseScrollDelta`) and the redaction helper `sanitizeDesktopPayload`.
- `src/desktop/DesktopTools.ts` — `createDesktopTools(provider)` builds the ten
  interactions tools with the exact permission tiers above. With **no provider
  it returns an empty toolset** — browser mode registers no desktop tools and
  fakes nothing.
- `src/native/NativeWindowsDesktopProvider.ts` — the real bridge over the wire
  (snake_case tools ↔ camelCase methods), sharing `NativeAgentRpc` (identity
  probe, error mapping, honest `available:false`). `refreshNativeStatus()` pulls
  the live `virtualScreen` + limits so `capabilities()` reports measured bounds.
- The app bootstrap `createDefaultAppDesktopProvider()` returns the bridge when
  `VITE_NATIVE_AGENT_URL` is set and `undefined` otherwise (asserted by tests —
  the in-memory `FakeDesktopInteractionProvider` is `testsOnly` and never bound).
- `AssistantEngine` takes an optional `desktop` provider; `start()` probes it
  and reports `nativeDesktopInteractionAvailable`; per-run budgets reset in
  `process()`; the Settings panel shows the honest status row.

## 4. How the native input works

`native/src/desktopInput.ts` lazily loads `koffi` and declares a tiny typed
user32 surface: `SendInput` with mouse/keyboard inputs, `SetCursorPos`,
`GetCursorPos`, `SetForegroundWindow` + `GetForegroundWindow`,
`GetClientRect` + `ClientToScreen`, `GetSystemMetrics` (virtual-desktop
bounds), `MapVirtualKeyW` and `VkKeyScanW` for key translation, and
`GetProcessWindowStation` + `GetLastActivePopup` (foreground-eligibility
checks that mirror Windows' restrictions — a window that cannot legally take
focus reports `focused:false` honestly, never a forced success). The
deterministic `MemoryDesktopBackend` (`native/src/testingDesktop.ts`,
`testsOnly:true`) applies the same validation and logs only lengths.

## 5. Running

Identical to Phases 1.2–1.4 (`npm run native:build` + `npm run native:agent`,
or the same loopback port), then set `VITE_NATIVE_AGENT_URL`/
`VITE_NATIVE_AGENT_TOKEN` in the web app. The banner says `desktop interaction
mouse/keyboard/focus (bounded, injected)` only on win32.

## 6. Testing

- `native/src/agent.desktop.test.ts` — deterministic live-bearing backend:
  bounds (keys/counts/scroll/coordinates/type length), allow-list + aliases +
  WIN rejection, client-relative resolution, `focused:false` on rejected focus,
  vanished windows → `not_found`, cancellation before any injection. (32 tests.)
- `native/src/webBridge.desktop.test.ts` — the **web** bridge against a live
  local agent + memory backend: honest caps + limits + virtualScreen, measured
  cursor, absolute-screen move with verification, structured errors
  (`not_found`/`unavailable`/`invalid_path`), injected click/double/right/scroll
  sequences, allow-listed keys, type returning length-only (text absent from
  every JSON), honest focus, agent-down reconnect.
- `src/desktop/DesktopTools.test.ts` — permission tiers, `verifiable` flags,
  no-provider → empty toolset, coordinate/client rules, hotkey + key parsing,
  type redaction, honest "not confirmed" wording, budget helpers.
- `src/desktop/agentCore.desktop.engine.test.ts` — the real agent loop:
  registration seam, browser-mode no-tools proof, bootstrap honesty, `start()`
  capability row, a real `desktop.move` run, typed text redacted in the plan and
  trace (message carries count only), per-run budget tracking + reset, and the
  repeated-action guard blocking the 4th identical move before any budget.
- `src/state/jarvis.store.test.ts` — the `nativeDesktopInteractionAvailable`
  capability row.
- Live smoke on this Windows box (safe subset): identity (1.5.0 / win32) →
  `desktop.capabilities` available with real 1536×864 virtual screen + enforced
  limits → measured cursor → `desktop.move` to (64, 64) injected + verified
  exactly → out-of-bounds move rejected with no injection → cursor restored.
  Three consecutive moves to (300, 300) re-read with the cursor matching
  exactly every time. (A single one-off 1-pixel drift appeared at the screen
  corner (64, 65) on a later independent read — immediate post-move
  verification had matched exactly, and no code path consumes a re-read as if
  it were verification.) Clicks/keys/typed input are covered by the
  deterministic memory-backend tests; a live consent test was intentionally not
  run.

## 7. Explicitly not implemented (Phase 1.5 scope)

- No drag/drop, no mouse-wheel direction flags, no keyboard state queries, no
  focus *stealing* by title search (ids only), no `win`+anything modifiers.
- No window sizing/moving, no OCR/vision on the clicked result, no clipboard
  reads, no "record a macro" or UI-automation engine.
- No server-side run of arbitrary keystroke scripts; no persistence of typed or
  injected input anywhere (logs, traces or disk).
- No execution model change: input injection is synchronous, bounded and
  per-operation-cancellable; the engine still cannot run the agent's keyboard
  outside a JARVIS run.