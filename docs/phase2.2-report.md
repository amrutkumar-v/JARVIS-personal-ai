# JARVIS Phase 2.2 — Stronger Planning: Capabilities, Dependencies & Bounded Recovery

## 1. Objective

Make the Phase 2.0 goal loop *recover deterministically and finitely* when a
plan step fails: capability-aware plan validation, model-declared dependency
gating, and a bounded replan/reobserve engine loop with hard loop guards — all
inside the single existing `AssistantEngine` execution path, with read-only
recovery counters mirrored to the UI.

## 2. Scope

- Capability-aware plan validation (`validatePlan` + `src/engine/agent/capabilities.ts`).
- Engine-enforced declared dependencies (`dependsOn` gate + `PlanTracker`
  dependency recording).
- Deterministic failure classification (`src/engine/goal/recovery.ts`).
- Replan guards + bounded replan budget (`src/engine/goal/replan.ts`, engine
  `applyRecovery` / `stopGoal`).
- Engine → store → UI recovery mirror (`goalRecovery()`, notes, `replaning…`
  badge, recovery text).
- Operational trace events for every capability/recovery decision.
- Static security scan for the new pure modules; docs; native version bump to
  `2.2.0`.

## 3. Not in scope

There is still exactly ONE agent loop, one planner and one executor —
`AssistantEngine.process` → `runGoalEngine` → `executeToolSteps`. No frontend
planner, no second recovery loop, no new shell/network/provider/storage
access, no wire-protocol change, and (crucially) **no reset of budgets,
evidence or trace across replans**.

## 4. Engine contract surface

| Getter | Purpose |
| --- | --- |
| `goalPlan()` | unchanged Phase 2.1 view, each step now may carry `note?` |
| `goalLimitsInfo()` | `{ maxTaskSteps: 10, maxRecoveryAttempts: 2, maxReplans: 3 }` |
| `goalRecovery()` | `{ verificationFailures, maxRecoveryAttempts, replans, maxReplans, active }` |
| `taskBudget()` / `taskResult()` | unchanged Phase 2.0 |
| `lastRunTrace()` | new structured operational events (16.1) |

## 5. Real corrections uncovered while building it

- **Repeated-failure guard double-counted.** `repeatedFailureDetected` began
  `run + 1 >= bound`, and since the engine pushes a failing signature into
  `failureHistory` *before* calling the check, ONE failure could trigger a
  stop. Fixed to `run >= bound` (the history already includes the incoming
  failure) — verified by the `repeatedFailureDetected` unit suite and the
  engine tests (two CONSECUTIVE failures required).
- **The dependency engine tests failed on malformed scripts, not engine bugs.**
  The test helper emitted ONE request per round, so "click, then notes
  dependsOn [0]" became two rounds and notes was validated at index 0 with a
  self-reference, producing a `plan_rejected: dependency "0" is not an
  earlier step` trace and a recovery note overwriting the block note. The
  engine behaved correctly; the fixture now uses a combined `round()`
  helper so dependent + prerequisite share one round.
- **`PlanStepRequest.payload` is optional** — `executeToolSteps` normalizes
  `const input = req.payload ?? {}` so the dependency gate, payload
  signatures and plan `dependsOn` binding all use one canonical input.
- **`goalRecovery().active` lingered after completion.** `replanContext`
  stayed set once the final answer landed, so the `replaning…` badge would
  render on a finished plan. The engine now clears `replanContext` at the
  final-answer and cancel/limit exits (counters persist; only `active`
  reflects a live replan).
- **A non-verifiable dependent completes as `unverified`, not `verified`** —
  the "runs once prerequisite COMPLETED" test asserted the wrong projected
  state.

## 6. Capability selection (pure, advisory)

`src/engine/agent/capabilities.ts` derives capability contexts from a toolId
(actual id + prefix chain), classifies `readOnly` vs `actionable`
(`permissionAtMost` ordering: `read_only` < `low_risk` < `high_risk`),
renders `describeCapability` with schema constraints, a `selectable`
predicate and a sorted `capabilityCatalog`. It never grants anything — the
registers, permission and budget rails stay the backstop.

## 7. Plan validation changes

`validatePlan` verdict codes (checked in order): `reserved` →
`unregistered` → `no_contract` → `undeclared` → `unavailable` →
`dependency` → `budget`. `unavailable` uses `capabilityAvailable(toolId)`
(registered + `canRun()`).

## 8. Dependency gate (engine, same round only)

`roundStepIds` binds each request index to its real plan-step id. A request
with explicit `dependsOn` records those ids on `PlanTracker`
(`setDependencies`, `dependenciesExplicit`); `isReady` requires every
prerequisite COMPLETED, else the step is `SKIPPED` (blocked note +
`step_blocked` event). Implicit sequential order is informational and never
blocks. Edge case: a notes-clear-confirmed request pushes no step id, so a
later `dependsOn` on it resolves undefined → that dependent stays blocked.

## 9. Failure classification (`recovery.ts`)

Pure, total mapping from ONE `RecoveryFailureKind` to a bounded action.
Verification signals dominate (never classified as plain tool failure).
Budget rules: `replan` consumes a replan unit, `reobserve` a recovery unit,
`retry` nothing, `stop` nothing.

## 10. Replan loop guards (`replan.ts`)

Signatures are order-sensitive hashes of `toolId:stableKey(payload)` — never
raw prompts. Guards: `identicalReplan` (the exact failed plan signature may
not repeat; `MAX_IDENTICAL_REPLANS = 1`) and `repeatedFailureDetected`
(the same (tool,payload) failing consecutively beyond
`MAX_IDENTICAL_FAILURES = 2`).

## 11. Engine recovery flow (`applyRecovery`)

Per failed round: record `recovery_classified` for every failure, set the
per-step recovery note, run same-action guard, then prefer a `replan`; a
`reobserve` continuation picks the first recoverable failure. Replans are
accepted only when `replanBudgetRemaining > 0` (ceiling → hard `stopGoal`,
never a silent skip). STOP actions feed back to the loop-top gates — no
hard-stop, no budget charge.

## 12. Hard stop (`stopGoal`)

Triggers ONLY on: replan-budget exhausted, identical-replan repeat, or
same-action loop. It finishes the plan `FAILED`, ends the trace, aborts the
run and returns a notice.

## 13. Per-round hint (`planningContextNote`)

Each replan round's prompt gets only operational facts: which step failed,
the classification `kind → action (reason)`, and remaining step/replan
budget. No chain-of-thought, no raw payloads.

## 14. Operational trace events (Phase 2.2)

`plan_validated`, `plan_rejected`, `capability_selected`, `step_started`,
`verification_attempted`, `verification_result`, `step_failed`,
`step_blocked`, `capability_refused`, `recovery_classified`,
`recovery_attempted`, `replan_accepted`, `replan_requested`,
`repeated_failure_detected` — appended by the run's existing tracer,
never reset mid-run.

## 15. Budget accounting

Replans/reobserves increment engine-only counters (`replansUsed`,
`reobserveAttempts`) that reset with the run and are invisible to the model.
`goalRecovery().verificationFailures` is derived from trace step counts.

## 16. Engine → store mirror

`src/state/goalRun.ts` mirrors `goalRecovery()` verbatim. Nothing is derived
store-side. `goalRecovery.mirror.test.ts` proves: counters after a refuted
step + replan, accumulation across replans (never reset), and clean routes
manufacture no recovery entries.

## 17. Pure presentation model (`goalView.ts`)

`StepViewLine.note`, `replanActive` (from `recovery.active`), and a
`recoveryText` of the form `1 of 2 recovery attempts used · 2 of 3 replans
used`. `EMPTY_BUDGET` yields a zeroed recovery view.

## 18. Components

`GoalPanel` renders the `replaning…` badge (`role="status"`,
`.goal-panel-replanning`) while `replanActive`, and per-step notes
(`.goal-step-note`). No verdict is ever derived in the UI.

## 19. CSS & layout

`src/App.css`: `.goal-panel-replanning` (thinking color) and
`.goal-step-note` (warning color) — presentation only, no logic.

## 20. Honesty & anti-hallucination

Blocked dependents show their true reason; recovery notes state the exact
classification and action; the verdict still comes only from
`evaluateGoalTask`. The engine refuses to repeat identical failing steps and
says so.

## 21. Data flow

`process` → `runGoalEngine` → `validatePlan` → `executeToolSteps` (gates,
execution rails, `failures`) → `applyRecovery` → (replan/reobserve/stop)
→ same loop. `syncGoalRun` copies `goalRecovery()` to the store on every
engine message.

## 22. Files changed / added

- `src/engine/AssistantEngine.ts` — gates, recovery, guards, `goalRecovery()`,
  trace events, hint.
- `src/engine/goal/recovery.ts`, `replan.ts` (+ unit tests) — new.
- `src/engine/agent/capabilities.ts` (+ tests) — new.
- `src/engine/goal/validatePlan.ts` (+ dependency tests).
- `src/engine/agent/PlanTracker.ts` (setDependencies, setNote,
  dependenciesExplicit + tests).
- `src/engine/agent/types.ts` — trace event payloads, `StepFailure`.
- `src/state/goalRun.ts`, `src/components/goal/goalView.ts`,
  `GoalPanel.tsx`, `src/App.css`.
- Tests: `agentCore.recovery.engine.test.ts`, `goalRecovery.mirror.test.ts` (new);
  `security.test.ts` extended to scan the new pure modules.
- `native/src/protocol.ts` — version bump.

## 23. Tests

- Engine recovery (8): replan continuation complete; trace accumulates across
  replans; identical_replan stop; same_action stop across distinct plans;
  replan-ceiling hard stop; dependency blocked never runs; dependency runs on
  verified prerequisite; refuted→reobserve with observation surface.
- Unit: `recovery.test.ts` (9), `replan.test.ts` (5),
  `capabilities.test.ts` (8), `validatePlan`/`planTracker` dep suites.
- Store mirror (3); static security scan.

## 24. Validation gates

`npx tsc -b` clean · `npm run lint` 0 errors · `npx vitest run` 83 files /
1024 tests pass · `npm run build` (vite) built · `npm run native:check` +
`native:build` pass.

## 25. Versioning

`NATIVE_AGENT_VERSION` bumped `2.1.0 → 2.2.0`
(`native/src/protocol.ts`, rebuilt via `npm run native:build`). Wire protocol
unchanged.

## 26. Docs

`docs/agent-architecture.md` §16 added.

## 27. Known limitations / deferred

Reobserve still needs an observation surface attached; `maxReplans` is a
constraint constant (3); dependency enforcement covers only same-round
explicit `dependsOn`; there is no manual user "retry" button yet; replan
hints are per-round engine facts, not a plan editor.

## 28. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Model loops on failures | identical-replan + same-action guards, hard ceiling stop |
| Budgets "reset" to hide work | counters reset only with a run; mirror test locks this |
| Blocked steps look like failures | `SKIPPED` → `blocked` + explicit reason note |
| Recovery module touches runtime | pure functions; static scan bans it |

## 29. Security review notes

`recovery.ts` / `replan.ts` static scan: no shell/network/storage, no
`engine.`/`ToolRegistry`/tool verbs, no secrets/hosts, no prompt embedding in
signatures. `planningContextNote` emits engine facts only.

## 30. Recommended Phase 2.3

1. User-facing **Retry / plan editor** that re-submits a corrected goal via
   `engine.process` (still engine-owned).
2. Plan **preview + one-shot confirmation** before a run commits.
3. Expose per-round **progress/timing** from trace data (never UI-derived).
4. Real-provider **manual QA checklist** for wake → spoken goal → replan →
   visible recovery counters.