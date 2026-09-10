# JARVIS Phase 2.1 — Goal Execution UX & User Control

## 1. Objective

Make the Phase 2.0 goal loop *visible, cancellable and honest* to the user:
live plan states, shared budget + recovery, evidence-based verdict, an
ASK/GOAL composer with Stop, all inside the existing UI — while
`AssistantEngine` remains the sole orchestrator and the UI stays a
display-only layer.

## 2. Scope

- Engine → UI surface: `goalPlan()`, `goalLimitsInfo()` (+ existing
  `taskBudget()`, `taskResult()`).
- Live `GoalPlanView` incl. per-step `GoalStepStatus` from the engine's own
  classifier (`classifyPlanStep`).
- Store mirror `GoalRunSnapshot` + the single refresh path `syncGoalRun`.
- Pure presentation model (`presentGoalRun`) + `GoalComposer` / `GoalPanel`.
- Wiring through `useAssistant` / `JarvisShell` / `App`.
- UI security static scan; docs; native version bump to `2.1.0`.

## 3. Not in scope

The UI never acquires orchestration capability. There is no second agent loop,
no frontend planner/executor, no `AssistantEngine` instantiation in the UI, and
no new shell/network/provider/storage access. Visual actions stay on their
existing transient single-POST rails.

## 4. Engine contract surface

| Getter | Purpose |
| --- | --- |
| `goalPlan()` | live projection of `PlanTracker.current` → `GoalPlanView` (`active`, `goal`, `status`, `steps`) |
| `goalLimitsInfo()` | read-only copy of `GOAL_LIMITS` (`maxTaskSteps: 10`, `maxRecoveryAttempts: 2`) |
| `taskBudget()` | budget/remaining/limit (Phase 2.0, unchanged) |
| `taskResult()` | the only verdict (Phase 2.0, unchanged) |

Each `GoalPlanStepView`: `toolId`, `action` (registry name, else toolId),
`status` (`AgentStepStatus`), `attempts`, `state` (`classifyPlanStep`), and
`evidence` = `verification.message` (unless `not_applicable`) → otherwise
`observation.summary` → otherwise `result.message`. Empty baseline:
`{ active:false, goal:'', status:'CANCELLED', steps:[] }`.

`classifyPlanStep` (`src/engine/goal/evidence.ts`, pure) maps
`PENDING→planned`, `RUNNING/WAITING_CONFIRMATION→executing`,
`CANCELLED→cancelled`, `SKIPPED→blocked`, `COMPLETED` (with a verification
observation → `refuted`, else `unverified`), `FAILED` (`plan_rejected` /
`orchestration_limit` → `blocked`, `user_cancelled` → `cancelled`, else
`failed`); an explicit `verification` observation always wins → `refuted`.

## 5. Real corrections uncovered while building the live plan

- **Pre-flight refusals are now recorded.** `PlanTracker.transitionStatus`
  previously rejected `PENDING→FAILED` and `PENDING→COMPLETED`, so a step
  refused before execution (plan rejection, unknown tool, invalid input,
  permission denied, user decline, budget stop) silently no-opped — the UI
  would have shown nothing for the very refusals it exists to surface. Both
  transitions are now legal.
- **In-flight steps are now visible.** `AssistantEngine.executeToolSteps`
  creates the plan step and marks it `RUNNING` *before* `executeWithRetry`,
  so the panel shows `↻ Running` during execution instead of only finished or
  blocked steps.
- **Cancellation now actually cancels plan steps.** `PlanTracker.cancelRemaining`
  computed the `CANCELLED` transition but never assigned `step.status` — only
  `completedAt` — so pending steps survived a cancel. Now every non-terminal
  step becomes `CANCELLED` while terminal steps are preserved. Found and locked
  by the new focused transition suite (`planTracker.test.ts`).
- **Consecutive rounds no longer collide on call IDs.** `callId` was built
  from `Date.now()` + the per-round index, so two rounds in the same
  millisecond produced the same id and `findOrAddStep` merged the second step
  into the first — a budget-rejected step could silently vanish from the plan
  view. A monotonic `callSeq` on the engine makes ids unique. Surfaced by the
  budget lifecycle test, which passed only when the rounds happened to land on
  different milliseconds.
- **Latent runtime error removed.** The later `findOrAddStep` reassignment
  of `const step` was changed to reuse the earlier binding, eliminating an
  "Assignment to constant variable" path.

## 6. Store mirror

`src/state/goalRun.ts`: `GoalMode` (`'ask' | 'goal'`), `GoalRunSnapshot`
(mode, `GoalPlanView`, budget `{steps, remaining, limit}`, limits, task
verdict, `refreshedAt`), `GoalRunSource`, `GOAL_LIMIT_DEFAULTS`, `EMPTY_GOAL_RUN`,
`buildGoalRunSnapshot(source, mode, now?)`, `syncGoalRun(source, getMode, apply, now?)`.

`src/state/jarvis.store.ts` gains `goalMode` (`'ask'` default), `goalRun`
(`null` default), `setGoalMode`, `setGoalRun`.

Rule: `syncGoalRun` never overwrites `goalMode`; the snapshot is a copy of
engine getters, never a UI derivation.

## 7. Pure presentation model

`src/components/goal/goalView.ts`:

- `STEP_LABELS` + `STEP_SIGNS` for all 8 states with glyphs
  `• ↻ ✓ ✗ ? ⛔ ! –` (text label AND glyph — never color-only).
- `VERDICT_CHIP` per `GoalTaskStatus`; `EMPTY_VERDICT_DETAIL`.
- `stepLine`, `budgetRatio` (clamped 0..1), `budgetText`, `recoveryText`
  (only when recoveries > 0 or refuted/unverified steps exist).
- `presentGoalRun(snapshot)` → `kind: idle | running | finished`,
  `showPlan`, `verdict`, `cancellable`.

Honesty rule: a verdict renders **only** when a task exists and its status is
not `planning`. Live runs render **no** verdict. A completed-but-`unverified`
run renders the hard-coded "Finished — not declared complete" chip — never a
claimed success.

## 8. Components

- `GoalComposer.tsx` — input with ASK/GOAL segmented toggle, Send, Stop,
  Enter submits, Escape clears. Presentation-only: **both** modes call the
  same `submit(text)` → `engine.process(text)`. `busy`, `cancelVisible`,
  `onSubmit`, `onCancel` props.
- `GoalPanel.tsx` — renders `presentGoalRun(useJarvisStore.use.goalRun())`,
  returns `null` when `!showPlan`; header, verdict chip, budget bar+text,
  recovery note, ordered step list; `aria-live="polite"`.

## 9. CSS & layout

`src/App.css`: `.goal-composer` (dock), `.goal-mode` toggle buttons,
`.goal-input`, `.goal-submit`, `.goal-cancel`, `.goal-panel` (absolute,
bottom-centered over the stage, `width:min(620px,94vw), max-height:46vh`),
`.goal-verdict[data-status]` variants, budget track/fill/text, recovery,
`.goal-steps` + per-state tints, 720px responsive block. Panel corrected
during wiring to sit *inside* the stage above the dock (initial
`translateY(calc(100% + 14px))` would have pushed it off-screen).

## 10. Wiring

- `useAssistant.ts`: `syncGoalRun` refresh on **every** engine message and
  once after mount — the panel is empty until the first message (no
  fabricated plan), then live for the whole run.
- `JarvisShell.tsx`: `submit`, `GoalComposer` (busy = `task.active`,
  `cancelVisible` = `task.active`), `GoalPanel` in `.jarvis-stage`;
  previously unused `_task` / `_onCancelTask` destructuring now drives Stop.
- `App.tsx`: passes `submit: assistant.submit` alongside the existing
  provider/model/endpoint labels.

## 11. Voice same path

Spoken goals still run the real `VoiceManager` → `engine.process` →
visual/desktop steps → verification → verdict, then the *same* `syncGoalRun`
mirrors it to the store. The regression test (`src/state/goalRun.test.ts`)
asserts the store `goalRun` carries `status: completed`, step `verified`,
`desktop.calls.click === 1` — progression proof that voice and the Goal panel
share one engine result. (Needed a `payload:` wrapper on the scripted
`toolRequests`; bare args produced "Missing required argument(s)".)

## 12. Security boundary (UI)

`src/components/goal/security.test.ts` (`?raw` scan of `goalRun.ts`,
`goalView.ts`, `GoalComposer.tsx`, `GoalPanel.tsx`) asserts: no
shell/subprocess verbs; no `new AssistantEngine` / `ToolRegistry` /
`from '../engine'`; no `.generate(`/`.execute(`/provider verbs; no desktop
hand verbs (`.click(` etc.); no `fetch`/`WebSocket`/`sendBeacon`; no
localStorage/indexedDB/writeFile; no `console.*` or secret literals; no
`payload`/`arguments`/coordinate keys; no duplicated verdict logic; the honest
unverified copy is hard-coded; the composer imports only react + the store.

## 13. Honesty & anti-hallucination

- Engine-derived verdict only; the UI cannot fabricate `completed`.
- `finishedPlan`/`presentGoalRun` treat `kind:'running'` as verdict-less.
- The unverified disclaimer text is a compile-time constant in the view
  module (asserted by the security test), so it can never be optimized away
  or replaced by a claimed success.

## 14. Accessibility

The panel is a `role="region"` with `aria-live="polite"` (verdict announces
without stealing focus). Every step state renders text + glyph; color and
`data-state` are additive. Budget bar carries a textual `aria-label`.

## 15. Budget display

`budgetRatio` clamps to 0..1 for the fill width while `budgetText` keeps the
engine's real numbers ("8 of 10 steps remaining"); `recoveryText` exposes the
recovery ceiling note only when a run actually spun attempts or hit
refuted/unverified steps.

## 16. Cancellation UX

While a run is active the composer shows **Stop**, wired to the existing
engine cancellation (`cancelVisible = task.active || plan.active`, mapped to
`onCancelTask`). Cancelled steps classify as `cancelled` (`–`) in the panel.

## 17. Empty / idle state

`goalPanel` renders nothing until the store has a real snapshot; the snapshot
itself starts empty (`EMPTY_GOAL_RUN`, `plan.active:false`, no goal, no
verdict). The panel never shows a made-up plan or a stale verdict.

## 18. Data flow

`engine` (single authority) → getters `goalPlan/taskBudget/goalLimitsInfo/
taskResult` → `syncGoalRun` (mount + every engine message) → zustand
`goalRun` → `presentGoalRun` → `GoalPanel`. `GoalComposer` text → `submit` →
`engine.process(text)` → engine decides ASK vs GOAL handling.

## 19. False before (what this phase fixed)

1. Silent plan steps: pre-execution refusals were invisible
   (`PENDING→FAILED/COMPLETED` transitions were illegal).
2. Non-live plan: the tracker only recorded finished/blocked steps, so no
   "running" state could ever appear.
3. Cancellation bug: `PlanTracker.cancelRemaining` never assigned
   `step.status = 'CANCELLED'`, so pending plan steps survived a cancel.
4. Call-id collision: consecutive rounds in the same millisecond produced the
   same `callId`, so `findOrAddStep` merged/hid the second plan step.
5. Stale `const step` reassignment in the execute path (runtime error).
6. `GoalPlanStepState` used a distinct `'running'` string instead of the goal
   vocabulary's `'executing'` — the view now types against `GoalStepStatus`
   directly (the earlier `GoalPlanStepState` type was removed).
7. `goalView` referenced a non-existent `snapshot.goal`.

## 20. Files changed / added

Engine: `src/engine/goal/evidence.ts`, `src/engine/contracts.ts`,
`src/engine/AssistantEngine.ts`, `src/engine/Agent/PlanTracker.ts`
(contracts re-exports `AgentStepStatus`/`AgentPlanStatus` and now
`GoalStepStatus`). Store/state: `src/state/goalRun.ts`, `src/state/jarvis.store.ts`.
View/components: `src/components/goal/goalView.ts`, `GoalComposer.tsx`,
`GoalPanel.tsx`, `src/App.css`. Wiring: `src/hooks/useAssistant.ts`,
`src/components/layout/JarvisShell.tsx`, `src/App.tsx`. Native:
`native/src/protocol.ts` (`2.1.0`). Docs: `docs/agent-architecture.md` §15,
`docs/visual-understanding.md` §11.

## 21. Tests

- Engine: `evidence.test.ts` (plan-step classification via `planStep`
  builder) + `agentCore.goal.engine.test.ts` "Phase 2.1 engine goal UI
  surface" (goalPlan empty/live/finished, evidence chain, goalLimitsInfo
  read-only, cancellation → `['verified']`).
- Lifecycle transitions — NEW `src/engine/agent/planTracker.test.ts`
  (17 tests): the full `PENDING→RUNNING→COMPLETED / FAILED / CANCELLED`
  matrix via `transitionStatus` (incl. `PENDING→FAILED/COMPLETED`
  pre-refusal/execute-time paths, terminal-immutability, same-state no-ops)
  plus `PlanTracker` integration: RUNNING records `startedAt`, completion /
  failure attach results + `completedAt`, `cancelRemaining` preserves terminal
  steps, progress snapshot while ACTIVE + idle baseline, snapshot copy-safety.
- Store ↔ engine wiring — NEW `src/state/goalRun.lifecycle.test.ts`
  (8 tests): drives the REAL loop and asserts the `syncGoalRun` mirror at
  mid-execution (`executing`, plan ACTIVE, engine `planning` placeholder),
  between rounds (verified step while plan still ACTIVE, budget advanced),
  and after the run for COMPLETED (verified), FAILED, blocked on budget
  exhaustion (`['verified','blocked']`, `remaining: 0`), cancellation
  (`['verified']`, task `cancelled`), unverified completion (honest verdict),
  snapshot correctness (engine numbers only, no payloads), per-message store
  synchronization (mode preserved).
- Store/view: `goalRun.test.ts` (store actions; snapshot mirrors engine
  numbers; `syncGoalRun` writes store; voice same-path regression),
  `goalView.test.ts` (labels+glyphs for all states, idle empty, live-run no
  fabricated verdict, engine verdict verbatim, HONESTY unverified run,
  verdict chips, budget clamp/text, recovery text, whole-plan-after-run, no
  payload leak).
- Security: `goal/security.test.ts` (UI boundary scan — 8 assertions).

**Full suite: 78 test files / 977 tests passing.**

## 22. Validation gates

| Gate | Result |
| --- | --- |
| `npm test` (vitest run) | 78 files, 977 passed |
| `npx tsc -b` | clean |
| `npm run lint` (oxlint) | 0 warnings / 0 errors (252 files, 116 rules) |
| `npm run build` (vite) | pass — built in 3.05s (pre-existing >500 kB chunk warning, non-blocking) |
| `npm run native:check` | pass |
| `npm run native:build` | pass |

## 23. Versioning

`NATIVE_AGENT_VERSION` `2.0.0 → 2.1.0` in `native/src/protocol.ts`, regenerated
distribution (`npm run native:build` → dist carries `'2.1.0'`). Wire protocol
unchanged → informational bump only.

## 24. Docs

`docs/agent-architecture.md` §15 (engine surface, corrections, store mirror,
composer/panel, UI security boundary, versioning, testing) and
`docs/visual-understanding.md` §11 (goals as a visible surface over the same
vision rails) added; Phase 2.0 sections untouched.

## 25. Known limitations / deferred

- Settings/keyboard-command overlay for Goal Mode is not added; the composer
  lives in the dock.
- Step evidence can be long; it renders once, truncated by CSS with a `title`
  tooltip (no expansion UI yet).
- Real-provider UI end-to-end is unverified in a headless test (as with the
  rest of the app); covered by fakes.

## 26. Risks & mitigations

- **UI derives verdict** → prohibited structurally: the panel only formats
  store-mirrored engine getters; static scan asserts no verdict logic.
- **Stale plan after a run** → every engine message refreshes the mirror;
  empty baseline covers idle.
- **Mode ambiguity** → the engine owns ASK/GOAL handling; the toggle is
  presentation-only and the store mode is never overwritten by refresh.
- **Unverified looks done** → hard-coded honest copy enforced by the security
  scan.

## 27. What did NOT change

No second agent loop; no planner/executor in the UI; `AssistantEngine`,
`ToolRegistry` and all verification stay in `src/engine`; permission gate,
repeated-action guard, stale-screen gate, task budget and recovery ceiling all
run exactly as before; visual actions keep their transient single-POST privacy;
no new `child_process`/spawn/network/provider/storage surface anywhere.

## 28. Real outcomes vs. plan

- Live plan + per-step states: **done** (engine-projected, `classifyPlanStep`).
- Budget + recovery display: **done** (engine numbers mirrored).
- Verdict honesty (incl. unverified): **done** (verbatim + hard-coded copy).
- Cancel/Stop: **done** (existing engine cancellation surfaced; plan steps now
  genuinely cancelled).
- ASK/GOAL composer + voice same-path: **done**.
- Bonus: five real engine bugs found and fixed (silent refusal steps,
  invisible RUNNING, `cancelRemaining` not assigning CANCELLED, cross-round
  call-id collision, const reassignment).
- Final: 977 tests green, all six gates, version 2.1.0.

## 29. Security review notes

Reviewed the new surface for: secret exposure (none — no `.env`, keys,
tokens, or `console` output in changed files — verified by scan), second
execution path (none — UI scans gate every verb), UI bypass of engine
authority (none — verdict/budget/plan always engine-derived), honest verdict
path (verified against `taskResult()`), cancellation actually stopping the run
(verified via engine cancellation tests), stale versions (native dist and
source both `2.1.0`). `goalPlan()` reads only `this.registry.get().name` for
labels — the same declared-tool surface used at execution time.

## 30. Recommended Phase 2.2

1. **Goal recovery UX** — show a one-line reason per blocked/failed step and a
   real "Retry" that re-submits the goal (still via `engine.process`).
2. **Plan preview** — before the run commits, show the validated plan and ask a
   single confirmation with per-step approval, all through existing gates.
3. **Progress + timing** — expose round/attempt counts and elapsed time from
   engine trace data (never UI-derived).
4. **Real-provider voice UI test** — a manual QA checklist for wake → spoken
   goal → visible plan → cancel.