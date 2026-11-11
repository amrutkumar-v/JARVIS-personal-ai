# Implementation Tasks — Phase 1.6 (JARVIS Real Windows Apps + Truthful Response)

Dependency order: T0 → T1 → T2 → T3 → T4 → T5 → T6. Complete one before starting the next.

---

## Task 0: Consume ShellExec exit code for aumid/uri path (Security + Honesty)

**Depends on:** None (root of dependency graph)
**Priority:** high
**Acceptance Criteria AC:** AC-1, NFR-1, NFR-2

### Objective
Eliminate false `started:true` when ShellExecute inside ShellExec.exe fails, by awaiting
ShellExec exit instead of resolving on the `spawn` event for the shell route. This is
the ONLY place we change spawn behavior — the exe path's `spawnDetached` must keep
resolving on `spawn` (detached processes long outlive us).

### File changes

1. **[appBackend.ts](file:///d:/JARVIS/native/src/appBackend.ts)**
   - Add a variant of `spawnProcess` that waits for `exit` and returns exit code.
   - Rename or refactor so the aumid/uri branch uses it.
   - Map ShellExec exit codes:
     - exit 0 → success (current behavior; proceed to reportShellLaunch)
     - exit 3 → `nativeError('io_error', 'Shell activation refused by Windows for "<applicationId>": ShellExecute returned a failure code.')`
     - exit 4 → `nativeError('invalid_path', 'The shell route for "<applicationId>" was rejected by the security gate.')`
     - exit 5 → `nativeError('invalid_argument', 'ShellExec helper reported a usage error for "<applicationId>".')`
     - non-zero others → `nativeError('io_error', 'ShellExec helper exited with unexpected code <code> for "<applicationId>".')`

2. **[appBackend.test.ts](file:///d:/JARVIS/native/src/appBackend.test.ts)** (new tests)
   - Unit mock: fake spawn that emits 'spawn' then 'exit 3'. Assert backend throws a NativeError with code==='io_error'.
   - Unit mock: 'exit 4' → code==='invalid_path'.
   - Unit mock: 'exit 0' → current behavior unchanged (NativeAppLaunchResult returned).
   - Existing exe tests unchanged.

### Test Requirements (TR)

| ID | Type | Assertion |
|----|------|-----------|
| TR-T0-1 | rule | spawnProcess-for-shell with exit 3 throws NativeError code=='io_error' and message contains the applicationId |
| TR-T0-2 | rule | spawnProcess-for-shell with exit 0 returns NativeAppLaunchResult.started === true (no regression) |
| TR-T0-3 | rule | spawnProcess for exe path (spawnDetached) still resolves on spawn event with no wait for exit |

### Status: pending

---

## Task 1: Expand URI scheme allow-list (publisher-owned protocols with ShellExec mirror)

**Depends on:** T0 (no actual code dep but logical; security changes before capability expansion)
**Priority:** high
**Acceptance Criteria AC:** AC-2, NFR-1, NFR-2

### Objective
ALLOWED_URI_SCHEMES = `{ms-settings, mailto, whatsapp, spotify, discord, telegram, zoommtg, zoomus, slack, ms-teams, obs, steam, open}` (12 total; bounded).
Mirror in ShellExec.cs defense in depth.

### File changes

1. **[appRegistry.ts](file:///d:/JARVIS/native/src/appRegistry.ts#L59)**
   - Rewrite `ALLOWED_URI_SCHEMES` line to enumerate all 12 schemes.
   - `isValidUri` logic unchanged (scheme lookup + length + no-space/no-quote checks).

2. **[ShellExec.cs](file:///d:/JARVIS/native/helpers/ShellExec/ShellExec.cs#L52-L67)**
   - Rewrite `IsAllowedUri` from single if to a switch / `string[]` contains with `StringComparer.OrdinalIgnoreCase`.
   - Same semantic: parse scheme (everything before first ':'), case-insensitive match against allow-list array, then length ≤ 260 + no-quote/no-control-char check.

3. **[appRegistry.test.ts](file:///d:/JARVIS/native/src/appRegistry.test.ts)** (new tests)
   - Test: `configured: { openspotify: { mechanism:'uri', uri:'spotify:' } }` → resolves + record.mechanism='uri' + launchable=true.
   - Test: `configured: { bad: { mechanism:'uri', uri:'powershell:' } }` → dropped silently + getRecord undefined.
   - Test: `configured: { bad: { mechanism:'uri', uri:'file:C:\\windows\\system32\\cmd.exe' } }` → dropped.
   - Test: `uri:'whatsapp:send?text=hello%20world'` passes.

### Test Requirements (TR)

| ID | Type | Assertion |
|----|------|-----------|
| TR-T1-1 | rule | `isValidUri('whatsapp:') === true`, `isValidUri('file:') === false`, `isValidUri('powershell: -Command ls') === false` |
| TR-T1-2 | rule | ShellExec.IsAllowedUri (equivalent TypeScript-side test logic) accepts spotify: and rejects javascript: |
| TR-T1-3 | rule | Configured URI entry with a valid new scheme passes buildRecord and is launchable |
| TR-T1-4 | rule | URI entry with an invalid scheme (file:, powershell:, ms-windows-store:) still dropped (fail-closed) |

### Status: pending

---

## Task 2: processImage heuristic for packaged apps + honest 4-state surfacing

**Depends on:** T0, T1
**Priority:** high
**Acceptance Criteria AC:** AC-3, AC-4, NFR-2

### Objective
For auto-discovered packaged (AUMID) apps, bounded inference of processImage so
verification CAN work for common apps, without guessing. Also fix the post-action +
AppLaunchTool.verify() classification so `runningVerified === false` is reported as
"unverifiable" (not "not running").

### File changes

1. **[appRegistry.ts](file:///d:/JARVIS/native/src/appRegistry.ts)**
   - Add `inferPackagedProcessImage(displayName: string, aumid: string): string | undefined` function that:
     1. Extracts the package-family prefix tokens (split '_', first part, split '.', last token).
     2. Takes LAST TOKEN of the publisher dot-name (e.g. from `5319275A.WhatsAppDesktop_cv1...` → `WhatsAppDesktop` last token = WhatsApp; from `Microsoft.WindowsCalculator_8we...` → `WindowsCalculator`).
     3. Only produces a processImage candidate when the candidate token is ≥ 3 chars and matches `/^[A-Za-z][A-Za-z0-9]+$/` (no weird characters).
     4. Otherwise returns `undefined` (no guess, honest unverifiable).
   - Wire into `discoverPackaged()` addRecord call with `processImage: inferPackagedProcessImage(entry.displayName, aumid)`.

2. **[postActionVerify.ts](file:///d:/JARVIS/src/engine/orchestrator/postActionVerify.ts#L79-L99)**
   - planAppLaunchObservation now:
     - `settleMs: 4500` (≈ PROCESS_VERIFY_TOTAL_MS + SETTLE, so observation runs AFTER backend verify window closes, no race)
     - `retries: 1` (one re-poll)
     - `retryDelayMs: 1500`
     - verify function distinguishes:
       - `running === true && runningVerified === true` → passed:true
       - `running === false && runningVerified === true` → passed:false (genuinely refuted)
       - `runningVerified === false` (regardless of running) → passed:true with message noting it's "unverifiable by the platform" (NOT a failure to start). This is the critical semantic fix.

3. **[ApplicationTools.ts](file:///d:/JARVIS/src/applications/ApplicationTools.ts#L224-L247)**
   - AppLaunchTool.verify() mirrors:
     - `running && runningVerified` → ok:true
     - `runningVerified === true && !running` → ok:false "Verification failed: not running"
     - `runningVerified === false` → ok:true **with checks:[] and message explicitly says** `"Verification unavailable: the platform cannot confirm running state — this is not a launch failure."` (NOT ok:false). The tool is "verifiable" in the sense that verification logic runs and produces an honest 4-state result.

### Test Requirements (TR)

| ID | Type | Assertion |
|----|------|-----------|
| TR-T2-1 | rule | inferPackagedProcessImage returns a string for "Microsoft.WindowsCalculator" (from calculator AUMID) and for WhatsAppDesktop-style display names |
| TR-T2-2 | rule | inferPackagedProcessImage returns undefined for gibberish tokens |
| TR-T2-3 | rule | DiscoverPackaged with real reader injects processImage into addRecord (mock test) |
| TR-T2-4 | rule | planAppLaunchObservation verify returns passed:true when runningVerified is false (not a failure) |
| TR-T2-5 | rule | planAppLaunchObservation verify returns passed:false only when `runningVerified===true && running===false` (genuine refutation) |
| TR-T2-6 | rule | AppLaunchTool.verify for status={running:false,runningVerified:false} → ok:true (not false!) with caveat message about "not a launch failure" |

### Status: pending

---

## Task 3: Raise discovery caps + expose truncation count

**Depends on:** T0-T2 (logically, discovery doesn't block T0-T2; but still ordered for clarity)
**Priority:** medium
**Acceptance Criteria AC:** AC-5, NFR-2, NFR-3

### Objective
Raise MAX_DISCOVERED_APPS from 60 → 150, MAX_DISCOVERY_DIR_DEPTH from 1 → 2, expose
a `truncated` count in NativeAppRefreshResult when discovery caps short-circuited entries.

### File changes

1. **[limits.ts](file:///d:/JARVIS/native/src/limits.ts#L42-L46)**
   - `MAX_DISCOVERED_APPS: 150`
   - `MAX_DISCOVERY_DIR_DEPTH: 2`

2. **[protocol.ts](file:///d:/JARVIS/native/src/protocol.ts)** (NativeAppRefreshResult)
   - Add `truncated?: number` field (optional, default undefined = 0).

3. **[appRegistry.ts](file:///d:/JARVIS/native/src/appRegistry.ts)**
   - AppRegistry.refresh() return value includes `truncated?: number`.
   - In each discoverXxx loop: when `!discoversActive()` or `uniqueId !== base` hits the cap, increment a counter.
   - Refresh returns this truncated count when > 0.

4. **[appBackend.ts](file:///d:/JARVIS/native/src/appBackend.ts#L56-L58)**
   - `refresh()` result passes through the truncated field.

5. **Tests** in [appRegistry.test.ts](file:///d:/JARVIS/native/src/appRegistry.test.ts)
   - Mock packaged reader returning > cap entries (e.g. 200 entries) → refresh result truncated > 0, actual records.size === 150.
   - Verify depth=2 scanDir reads subdirectory entries (testingPaths with 2-level tree).

### Test Requirements (TR)

| ID | Type | Assertion |
|----|------|-----------|
| TR-T3-1 | rule | APP_LIMITS.MAX_DISCOVERED_APPS >= 150, depth == 2 |
| TR-T3-2 | rule | Refresh with 200 mock packaged entries returns truncated ≥ 50, records.size capped at 150 |
| TR-T3-3 | rule | NativeAppRefreshResult wire JSON includes truncated when > 0 |

### Status: pending

---

## Task 4: Focused end-to-end web.search + synthesis test

**Depends on:** T0-T3 (can actually be done in parallel; marked dep to keep order simple)
**Priority:** medium
**Acceptance Criteria AC:** FR-6, NFR-2

### Objective
Prove via a bounded test (live if possible, mock otherwise) that `web.search`
→ `web.fetch` → answer synthesis produces a truthful result and
`synthesisUpgradesVerdict` NEVER claims a step as verified when the trace says
unverified. If network unavailable, use a mock; the structural correctness proof
is sufficient.

### File changes

1. **New test** (add to an existing test file; don't create file unless absolutely needed — use `answerSynthesis.test.ts` or `web.test.ts`):
   - Add a unit test: given an execution result with web.search step whose observation has summary containing "Nvidia 616.92 WHQL" / mock text, synthesis produces a reply that contains grounded facts AND the deterministic evidence tail with `[unverified]` when verifier said `unverified` / `[verified]` when verified.
   - WireSearch → fetch pipeline: test `web.test.ts` existing `web.search` result parsing still works (guard existing assertion against regression of new `MAX_FETCH_TEXT_CHARS` bounds).

### Test Requirements (TR)

| ID | Type | Assertion |
|----|------|-----------|
| TR-T4-1 | rule | buildSynthesisFacts produces correct counts for web.search + app.launch steps |
| TR-T4-2 | rule | If any step's verified === 'unverified', fullyVerified === false |
| TR-T4-3 | rule | Synthesis message from mock observation containing real text carries it into the `summary` path of the trace without exceeding `TOOL_SUMMARY_LIMIT` |

### Status: pending

---

## Task 5: Typecheck, build, test run gate

**Depends on:** T0-T4 complete (non-optional)
**Priority:** high
**Acceptance Criteria AC:** AC-6, NFR-2

### Objective
Run and ensure ALL of these exit with 0 BEFORE committing anything:

```bash
# from root
npm test
npm run native:check
npm run build:backend
npm run lint        (optional if oxlint only style — no breakage from T0-T4; skip only if non-zero due to pre-existing issues)
# from native/
node scripts/buildShellExec.mjs   (run; produce warning message if csc not found — do not commit any .exe without actual compilation)
```

### Test Requirements (TR)

| ID | Type | Assertion |
|----|------|-----------|
| TR-T5-1 | rule | `npm test` exits 0 |
| TR-T5-2 | rule | `npm run native:check` exits 0 |
| TR-T5-3 | rule | `npm run build:backend` exits 0 |

### Status: pending

---

## Task 6: Single commit + push

**Depends on:** T0-T5 green
**Priority:** high
**Acceptance Criteria AC:** AC-8, AC-9

### Objective
Create ONE clean checkpoint commit with a descriptive message, then push to
`origin/ui/advanced-hud-polish`.

The commit MUST include:
- All changes in appRegistry.ts / test
- All changes in appBackend.ts / test
- All changes in ShellExec.cs
- All changes in limits.ts
- All changes in protocol.ts (truncated field if added)
- All changes in postActionVerify.ts
- All changes in ApplicationTools.ts / tests
- New test cases added to existing test files
- Spec mode artifacts `.trae/specs/phase16-real-windows-apps-usable-end-to-end/{spec.md,tasks.md}`

The commit MUST NOT include:
- `.audit.txt`
- `e2e.smoke.ts`
- `e2e.live.ts`
- Any `node_modules/` output
- Any accidental `.exe` files unless ShellExec was *actually* recompiled (if it was, then commit the new binary if dist/shellexec/ShellExec.exe is tracked — check `.gitignore` first)

### Test Requirements (TR)

| ID | Type | Assertion |
|----|------|-----------|
| TR-T6-1 | rule | `git status` BEFORE commit shows only tracked modified files + spec artifacts; no audit.txt/e2e*.ts |
| TR-T6-2 | rule | Single commit created (git log -1 shows the new commit; and git rev-list HEAD~1..HEAD count == 1) |
| TR-T6-3 | rule | Either `git push origin ui/advanced-hud-polish` exits 0, OR push failure + commit SHA reported verbatim |

### Status: pending

---

## Evidence / Completion Convention

When each task is completed:
1. Set `Status: completed`
2. Add a `## Completion Evidence:` section under the task heading with:
   - Rule TR pass/fail statuses
   - For rubric TRs, score + rationale with file/line code evidence links

No tasks should be marked `completed` until the implementer self-verification of every TR passes.
