# Spec: Phase 1.6 — Real Windows App Discovery, Resolution, Launch, Verification, and Truthful Response

| Field | Value |
|-------|-------|
| Root | `D:\JARVIS` |
| Base commit | `72beb34 feat(jarvis): complete phase 1 real agent core` |
| Branch | `ui/advanced-hud-polish` (tracks origin same name) |
| Working-tree prior work (preserve) | `appRegistry.ts`: `packagedAliases()` + wiring into `discoverPackaged`; `appRegistry.test.ts`: WhatsApp-class packaged resolution test |
| Working-tree scratch files (ignore, do not commit) | `.audit.txt`, `e2e.smoke.ts`, `e2e.live.ts` |

## Problem

JARVIS cannot reliably deliver on the core promise of a Windows personal AI assistant:
launching applications and using web search/answer end-to-end in a truthful,
verifiable, default-deny manner. Specifically, the following user-level experiences
are broken today:

| User experience | Current behavior | Desired behavior |
|-----------------|------------------|------------------|
| "Open WhatsApp" from a Store/MSIX install | Either "not registered", or "launched, could not be verified" even when it DID launch — or falsely reports STARTED when ShellExecute actually failed. | Resolve to the real AUMID. Activate through the shell. Report `verified` when the process is observed, `unverifiable` honestly when the process image can't be named, and NEVER `started:true` for an activation ShellExecute rejected. |
| "Open YouTube" or "Open Spotify" via registered URL protocol handler | "Application not registered" because ALLOWED_URI_SCHEMES contains only `ms-settings:`. Same for any third-party PWA / URI protocol. | Allow well-known publisher-owned URI schemes (whatsapp, spotify, discord, telegram, zoom, obs, mailto, slack, ms-teams, etc.) from a hardcoded curated allow-list (NOT arbitrary schemes). Activate and honestly verify as above. |
| "Open <publisher-nested-start-menu-app>" (depth-2 Start Menu) | Silently never discovered (MAX_DISCOVERY_DIR_DEPTH = 1). | Discover publisher folders 1 level deeper. |
| Any app on a system with more than 60 real apps | Packaged apps (enumerated last) silently dropped by the MAX_DISCOVERED_APPS cap. User gets no hint apps were truncated. | Raise cap to a realistic number; expose truncation count in refresh result; warn-log on truncation. |
| "Search the web for Nvidia driver version" answer | Search capability EXISTS (native DuckDuckGo). Answer synthesis EXISTS. But no focused test/end-to-end proof that the search -> synthesize pipeline produces truthful output. | Add bounded, non-certifying end-to-end tests proving the pipeline on the local machine when network is available. If not available, a deterministically-mocked equivalent. |

## Users and goals

**Primary user:** The human owner of this Windows JARVIS installation talking to the UI.

**Secondary user:** Future development agents (OpenCode, Freebuff, and the Trae platform)
treating the codebase as a stable base.

### Non-goals

- NOT redesigning the AppRegistry/RealAppBackend/ShellExec multi-layered architecture. The architecture is sound and we are filling gaps inside it.
- NOT introducing `shell:true` anywhere.
- NOT introducing arbitrary command execution.
- NOT removing the settle window or weakening verification. "Verified" must still mean observed + survived settle.
- NOT inventing a browser-side "resolver" that bypasses the native agent allow-list.
- NOT supporting arbitrary URI schemes (the list stays a curated, reviewable, bounded hard-coded Set with mirror defense-in-depth in ShellExec.cs).
- NOT full certification / signed binaries / installer.
- NOT end-to-end tests on other agents' machines (bounded live tests only).
- NOT changing permissions model, goals model, or verification vocabulary beyond surfacing the 4-state classification (verified / unverifiable / launch failure / app not found) more faithfully.

## Functional Requirements (FR)

### FR-1: ShellActivation result is never silently discarded
- A `shell:AppsFolder\...` or URI activation whose `ShellExecuteEx` returned a failure code MUST be reported as a structured NativeError (NOT as `started:true, verified:false`).
- The exit code of `ShellExec.exe` (0=ok, 3=ShellExecute failed, 4=invalid route, 5=usage) is consumed before reporting results.
- ShellExec.exe exit code is ONLY consumed for the aumid/uri code paths; the exe `spawnDetached` path continues to resolve on `spawn` event (since detached processes long outlive us).

### FR-2: Curated URI scheme allow-list expansion
- `ALLOWED_URI_SCHEMES` is expanded from `{ms-settings}` to a bounded reviewable Set of known publisher-owned protocols.
- Candidates (final list TBD in implementation, but bounded): `whatsapp`, `spotify`, `discord`, `telegram`, `zoommtg`, `zoomus`, `slack`, `ms-teams`, `obs`, `mailto`, `open`.
- Each scheme MUST be mirrored in ShellExec.cs `IsAllowedUri` (defense in depth — ShellExec.cs is the fail-closed gateway).
- Length / charset / no-quote rules still apply.

### FR-3: processImage heuristics for auto-discovered packaged apps, with safe fall-back
- `discoverPackaged()` in AppRegistry makes a bounded best-effort attempt to derive `processImage` from the packaged entry's display name.
- The heuristic is conservative:
  1. Uses package family-name prefix slug tokens only; never invent names.
  2. Does NOT hit the network, does NOT run arbitrary commands.
  3. When the heuristic can't produce a plausible name, `processImage` remains absent → honest `unverifiable` result (today's behavior, no regression).
- If no `processImage` is derivable, `status()` and post-action verification still correctly report `runningVerified=false` — this is preferred over a guess that would produce false-refuted.
- Additionally, `planAppLaunchObservation` (post-action) treats `runningVerified === false` WITHOUT `running === false` as "unverifiable" (not a post-action verification failure).
- AppLaunchTool.verify() matches the same 4-state classification verbatim so `[unverified]` suffix is used for unverifiable cases (instead of `ok:false`).

### FR-4: Discovery caps + truncation visibility
- `MAX_DISCOVERED_APPS: 60 → 150`
- `MAX_DISCOVERY_DIR_DEPTH: 1 → 2`
- `NativeAppRefreshResult` gets an optional integer `truncated?: number` field counting silently-dropped entries (≥ 0; undefined = zero, backward-compat wire).
- AppRegistry refresh reports truncated count when any source had entries remaining after the cap short-circuit.
- Wire spec must serialize truncated count when nonzero.

### FR-5: Truthful 4-state user-visible launch classification
All 4 states MUST be distinguishable in the final message an end-user sees. Mapping:

| Internal state | End-user message pattern | Tool.ok | PostAction passed? |
|---|---|---|---|
| verified launch | `"Launched X and confirmed it is running."` | true | true |
| launched but unverifiable | `"Launched X, but its running state could not be confirmed: <detail>"` | true (ok:true with explicit caveat that verification unavailable IS NOT launch failure) | Not a failure (pass=true OR separate "unverifiable" classification; never false-negative "it didn't launch") |
| launch failure (spawn denied, ShellExecute failed, target missing) | `"X could not be launched: <structured error>"` | false | N/A (action failed) |
| application not found / ambiguous | `"Application X is not registered." / "matches several: …"` | false | N/A (action failed) |

The critical semantics rule: `runningVerified === false` (unobservable) is NOT evidence that the app failed to start. Post-action MUST NOT mark the run as "didn't start" solely because observation is unavailable.

### FR-6: Web search → synthesis pipeline is tested end-to-end in a bounded form
- Either (a) a mocked-native-provider test proving AppLaunchTool classification, web.search routing, and answer synthesis behave correctly; OR (b) if live network is available on the build machine during the test phase, a bounded live test with short timeout that asserts the search provider returns hits without hard-coding answers.
- Synthesis correctness: deterministic verdict string is always appended; the model's prose can never upgrade `verification:'unverified'` to `verified`.

## Non-Functional Requirements (NFR)

### NFR-1: Security — default deny preserved
- All 5 prior audit-documented security properties preserved:
  1. No `shell:true` in any call path.
  2. All routes from TypeScript re-validated in ShellExec.cs.
  3. folderParam root-containment untouched.
  4. Bearer-token timing-safe compare untouched.
  5. SHELL_HOST_BASENAMES blocklist untouched.

### NFR-2: No regression on existing unit tests
- `npm test` root suite must pass.
- `npm run native:check` and `npm run build:backend` typecheck must pass.

### NFR-3: Backward wire compatibility
- New NativeAppRefreshResult.truncated field is optional and numeric; existing consumers ignore unknown JSON keys.
- No existing wire field changes type or semantics.

### NFR-4: Minimal change principle
- Changes touch only: `appBackend.ts`, `appRegistry.ts`, `ShellExec.cs`, `limits.ts`, `ApplicationTools.ts`, `postActionVerify.ts`, `protocol.ts` (for truncated field if needed), and focused test files.
- No refactors of unrelated modules.

## Constraints, dependencies, assumptions

- **C1 (Must NOT touch):** Other agents' uncommitted modifications in `appRegistry.ts` (`packagedAliases()`) and `appRegistry.test.ts` (the WhatsApp-class resolution test). These are valid and valuable additions; we integrate on top of them.
- **C2 (Must NOT commit):** `.audit.txt`, `e2e.live.ts`, `e2e.smoke.ts` are scratch files; add to `.gitignore` if necessary but more simply just don't `git add` them.
- **C3 (ShellExec rebuild):** After modifying ShellExec.cs we MUST re-run `node native/scripts/buildShellExec.mjs` (via `npm run build` inside `native/`). If csc is missing on the build machine, ShellExec.cs source change is still committed with a compile-verified-equivalent check (at minimum, confirm syntax compiles in the script output or at minimum confirm C# syntactic validity via direct `csc /nologo /parse` if available — fallback: the script itself gracefully handles missing CSC and prints a clear warning). We will not fabricate ShellExec.exe changes without the actual compiler.
- **C4 (Git):** Exactly ONE commit on branch `ui/advanced-hud-polish`, pushed to `origin/ui/advanced-hud-polish` at the end. The commit is clean, cohesive, and has a single descriptive message.

## Assumptions

- **A1:** `git push` to origin succeeds. If it fails (network/auth), we report the commit hash and explicit instruction to retry manually; we do NOT retry in a loop.
- **A2:** The `appRegistry.ts` packaged alias additions are the current latest working-tree state; we treat them as valid committed-precursor work even though they're technically uncommitted. If git-status were to revert them, we'd re-apply them from the diff. But they exist now, so we will edit ON TOP of them.

## Open questions (resolved in this doc, no user input needed)

- **Q1:** Should the new URI allow-list include `mailto:`? Yes, mailto is shell-owned and commonly requested; low risk.
- **Q2:** Should ShellExec exit codes 3/4/5 map to specific NativeError codes? Yes: exit 3 → 'io_error' with detail about activation failure; exit 4 → 'invalid_path' (invalid route fail-closed); exit 5 → 'invalid_argument' (usage).
- **Q3:** Should `planAppLaunchObservation` get `settleMs` and retries? Yes: `settleMs=PROCESS_VERIFY_SETTLE_MS+PROCESS_VERIFY_TOTAL_MS≈4500ms`, `retries=1` to match shell activation latency; this ensures the post-action poll happens after the backend verify window closes (not race it).

## Acceptance Criteria

All ACs are `rule` unless noted as `rubric`.

### AC-1 (rule): ShellExec exit code consumed
- Given: aumid/uri launch triggers ShellExec.exe with exit code 3 (ShellExecute failed simulated via mock).
- Then: backend throws a NativeError with code != 'ok' class; `started` is NEVER `true` on any NativeAppLaunchResult in this case.

### AC-2 (rule): URI allow-list expanded with mirror
- `ALLOWED_URI_SCHEMES` contains each new scheme on the TypeScript side.
- ShellExec.cs `IsAllowedUri` accepts each scheme with the same validation semantics: scheme prefix match, length ≤260, no quote/control chars.
- Non-allow-listed schemes (e.g., `file:` `powershell:` `javascript:`) still return false in both.

### AC-3 (rule): 4-state classification distinguishable
- Tool result, backend result, postAction result: in all layers, an end-to-end walk through an aumid app WITHOUT processImage produces a success-with-unverified outcome (ok:true or explicit "verification unavailable") — NOT an ok:false.

### AC-4 (rule): processImage heuristic is bounded and never invents from thin air
- `discoverPackaged` addRecord call sets processImage ONLY from tokens derivable from the real AUMID/displayName/package family data.
- Absent heuristic derivation → processImage stays undefined. No fall-back to "let's use the display name plus .exe".

### AC-5 (rule): Discovery caps raised and truncation visible
- `APP_LIMITS.MAX_DISCOVERED_APPS >= 120`.
- `APP_LIMITS.MAX_DISCOVERY_DIR_DEPTH == 2`.
- `NativeAppRefreshResult` serialization includes `truncated?: number`.

### AC-6 (rule): All existing unit tests pass + new focused tests pass per TR
- `npm test` in repo root (vitest run) exits 0.
- `npm run native:check` exits 0.
- `npm run build:backend` exits 0.

### AC-7 (rubric, 0-2, threshold ≥1): Architecture non-regression
- 2 pts: every change stays within the documented multi-layered architecture boundaries (reg→broker→backend→registry→spawn/ShellExec→verify). No new code paths that bypass a layer.
- 1 pt: one minor layer-skipping shortcut with explicit comment and small blast radius.
- 0 pts: architectural bypass found without justification.

### AC-8 (rubric, 0-2, threshold ≥1): Single cohesive commit
- 2 pts: exactly one commit, message descriptive, diff scope confined to functional + tests.
- 1 pt: multiple commits but still clear, or one commit with an unrelated minor lint fix.
- 0 pts: commits are scattered, or commit message unrelated to content.

### AC-9 (rule): Push to origin/ui/advanced-hud-polish succeeds (or explicit failure reported with hash)
- Either push exit code 0 is observed, OR the final report clearly states the push failure reason + the full commit SHA so the user can retry.
