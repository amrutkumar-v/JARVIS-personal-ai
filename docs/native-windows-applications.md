# Native Windows Applications — Phase 1.3

JARVIS's second native capability, built on the same local agent as Phase 1.2:
an **application control** surface — `app.list`, `app.status`, `app.launch` —
that launches REAL approved programs on the REAL Windows desktop through the
existing typed protocol, surfaced to the agent loop through the same provider
seam (`ApplicationProvider`) used everywhere else. A launch is never reported
as success on the spawn event alone: the agent watches the OS with `tasklist`
over a bounded window and reports `verified` only when it really observes the
process alive.

Related: [Native Windows Agent (Phase 1.2)](./native-windows-agent.md),
[Agent Architecture (Phase 1.0)](./agent-architecture.md),
[File System Agent (Phase 1.1)](./filesystem-agent.md),
[Native Windows Observation (Phase 1.4)](./native-windows-observation.md).

## 1. What it does

The agent gains three typed methods over the same JSON-RPC loopback channel:

| Wire method | Web tool | Meaning | Permission tier |
| --- | --- | --- | --- |
| `app.list` | `app.list` | list approved (and discovered) apps with metadata | `read_only` |
| `app.status` | `app.status` | is the app running? (real `tasklist` observation) | `read_only` |
| `app.launch` | `app.launch` | launch an approved app (detached, no shell) | `low_risk` + `verifiable` |

`app.launch` is **verifiable**: after execution the tool re-checks
`provider.status(id)` and only reports `[verified]` when the app is really
running with a confirmed observation. The verification rail from Phase 1.0
("never claim it worked unless confirmed") therefore applies unchanged.

## 2. Security boundary (the launch path is narrow on purpose)

Launching a program is the most powerful thing JARVIS can do, so the design
keeps the blast radius minimal:

- **Allow-list only.** `app.launch` takes exactly one parameter — a registered
  `applicationId`. It never accepts a path or a command line. Applications come
  from the config file (`applications` map) plus an optional read-only Start
  Menu discovery pass (`discovery: true`); discovered entries are listed but
  only configured apps are guaranteed launchable.
- **Fixed execution.** The backend resolves the allow-listed id to a single
  absolute executable path, verifies it still exists, and starts it with
  `child_process.spawn(target, [], { detached, stdio: 'ignore', windowsHide,
  shell: false })` — Node's CreateProcess path, **no shell, no arguments**.
  `.lnk` targets are resolved with a pure-Node parser (`windowsLnk.ts`), never
  through the shell.
- **No arbitrary command runner.** There is still **no** generic
  `system.execute` / `app.execute` endpoint: asking for one returns
  `unsupported` (unit-tested, and asserted again in the live smoke test). The
  agent can launch a registered app; it cannot interpret a command, a flag, or
  an argument from the model — model input never appears on the command line.
- **Blocklist categories.** A registered target whose file type is a shell
  host — `cmd.exe`, `powershell.exe`, `pwsh.exe`, `wscript.exe`, `cscript.exe`,
  `mshta.exe` (and the `.bat`/`.cmd`/`.ps1`/`.vbs`/`.js` script extensions) —
  is marked **not launchable** and is never started, whether it came from the
  config allow-list or discovery.
- **Bounds.** `appId` ≤ 64 chars and matched against the allow-list pattern;
  launch spawn ≤ 5 s; verification observes over a bounded window
  (`PROCESS_VERIFY_TOTAL_MS`, polled via `tasklist` with its own per-probe
  timeout). All caps live in `native/src/limits.ts`.
- **Honest reporting.** `verified` only when tasklist observed the exact pid
  alive in-window; `unverified` when observation was unavailable; `refuted`
  when observation worked but the process never appeared. A launch is NEVER
  marked success on spawn alone. The web tool turns a non-confirmed launch into
  `[verification failed: ...]` — never fake-success.

## 3. Provider seam (web side)

- `src/applications/provider.ts` — the contract: `ApplicationProvider`
  (`list`, `status`, `launch`, `capabilities`, optional `refreshNativeStatus`),
  `AppSource` (configured / discovered), `AppStatus`, `AppLaunchResult`, id
  normalization (`normalizeApplicationId`).
- `src/applications/ApplicationTools.ts` — `createApplicationTools(provider)`
  builds `app.list` / `app.status` (read-only) and `app.launch` (low-risk +
  verifiable). With no provider, it returns an **empty toolset** — the browser
  mode registers no application tools and fakes nothing.
- `src/native/NativeWindowsApplicationProvider.ts` — the real bridge over the
  protocol, sharing the same `NativeAgentRpc` transport (identity probe +
  error mapping) as the Phase 1.2 filesystem bridge in
  `src/native/NativeWindowsFileSystemProvider.ts`.
- No engine redesign: the tools register through the existing capability map;
  `AssistantEngine.start()` probes the agent and reports
  `nativeApplicationAvailable` honestly in the capability row.

## 4. Running and configuring

Same agent, one more config section (`native/agent.config.example.json`):

```jsonc
{
  "applications": {
    "notepad": { "name": "Notepad", "target": "{windir}\\System32\\notepad.exe" },
    "calculator": { "target": "{windir}\\System32\\calc.exe" },
    "visual-studio-code": { "target": "{userprofile}\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe", "enabled": false }
  },
  "discovery": true
}
```

- Targets go through the same path tokens (`{windir}`, `{userprofile}`,
  `{temp}`, `{workspace}`, `~`); non-absolute or invalid-config entries are
  dropped at startup with a warning. No machine-specific absolute paths are
  committed.
- `enabled: false` = registered but not launchable (still listed, `status`
  works).
- `discovery: true` lists Start Menu shortcuts as `source: "discovered"` so
  `app.list` is useful immediately; discovery never changes launchability
  guarantees.

Run exactly as Phase 1.2. The web app binds the application provider when
`VITE_NATIVE_AGENT_URL` is set; otherwise `nativeApplicationAvailable` is
`false` and **no** application tools exist.

## 5. Testing

- `native/src/appBackend.test.ts` (+ `testingApps.ts`) — launch/verify payload
  paths against a deterministic memory backend; `testingLnk.ts` for the pure
  `.lnk` parser.
- `native/src/appRegistry.test.ts` — allow-list validation, blocklist, id
  dedup/slug rules.
- `native/src/agent.test.ts` — wire-level: `app.*` allow-list, malformed ids,
  error codes, `app.execute` → `unsupported`.
- `native/src/webBridge.appProvider.test.ts` — the web bridge against a live
  local agent + memory backend: launch verification flow, honest status,
  error mapping, agent-down reconnect, and the no-fake proof.
- `src/applications/ApplicationTools.test.ts` — permission tiers,
  list/status/launch scenarios with a deterministic `FakeApplicationProvider`
  (test-only, never exported as production), id validation.
- `src/applications/agentCore.applications.engine.test.ts` — the real agent
  loop end to end: tool registration seam, browser-mode no-tools proof, honest
  capability rows, `status → launch → [verified]`, unverified launch →
  `[verification failed]` (never fake-success), repeated-action guard.
- Live smoke on a real Windows box: identity → list → status → launch Notepad
  → verified + pid → running status → negatives (disabled / missing target /
  unknown id / `system.execute` still `unsupported`), all over real HTTP with
  the bearer token.

## 6. Explicitly not implemented (Phase 1.3 scope)

- No arbitrary command/script execution — never a generic `app.execute`.
- No remote (non-loopback) exposure; no TLS (loopback + token only).
- No `launch with arguments` (no way for the model to put a flag on the command
  line), no window focusing/foregrounding, no desktop automation, no
  screenshots, no app installation. Those remain future seams on the same typed
  method pattern, never raw command passthrough.
- No Android, no iOS — the platform is Windows (the agent always reports its
  real platform and non-win32 launches never verify).