# JARVIS Phase 2.4 — Capability Intelligence & Personalization

## 1. Objective

Keep the single existing goal loop but make capability → implementation
selection *intelligent*: the model still only NAMES a capability, and the
ENGINE now picks the concrete registered tool using deterministic, safety-first
ranking informed by application-owned risk/permission metadata, verification
preferences, runtime context, and a bounded reliability history — never by
model preference, scores exposure, or a second executor.

## 2. Scope

- App-owned capability metadata: required `risk`/`destructive`, optional
  `requiresConfirmation`, `preferredVerification`, `maximumPermission` ceiling.
- Pure policy layer (`policy.ts`): permission-order, risk mapping, ceiling +
  strict-verification filtering, device mapping, confirmation obligation.
- Pure deterministic ranking (`rank.ts`): lexicographic context → risk →
  verification → reliability (weak) → declared preference → tool id.
- Bounded, content-free reliability history (`reliability.ts`), recorded after
  executed steps, persistent across runs, clamped counters.
- Resolver rewrite: device-scope hard filter, policy drop reporting, ranked
  selection with readable rationale and new ok-payload fields.
- Engine wiring: capability confirmation gate, cross-run reliability store,
  `capabilityContext()`, `capabilityMeta` preview projection, new trace events.
- Surface: `capabilityMeta` chip (risk + confirm) in `GoalPanel`.
- Static security scan extended to the three new pure modules; docs; native
  version bump to `2.4.0`.

## 3. Not in scope

Still exactly ONE agent loop (`AssistantEngine.process` → `runGoalEngine` →
`executeToolSteps`). No Android/network tool implementations (architectural
seams only), no model authority over any capability/tool/permission/policy, no
second planner, no shell access, no wire-protocol change, no frontend-derived
verdict, and no capability that can register a tool, grant a permission or
bypass a rail.

## 4. Engine contract surface

| Getter | Purpose |
| --- | --- |
| `goalPlan()` | unchanged; steps may now carry `capability` AND `capabilityMeta` (risk, permission, verification, requires-confirmation) |
| `capabilityCatalog()` | unchanged; definitions now expose Risk/Destructive/RequiresConfirmation/Verification preference |
| `capabilityReliabilitySnapshot` | read-only bounded reliability index (content-free, cross-run) |
| `registerCapability(def)` | admin/extension seam only — still unreachable by the model |
| `availableTools` / `toolDefinitions` | unchanged, but definitions now carry the enriched metadata |
| `lastRunTrace()` | new lifecycle events (§11) |

## 5. Real corrections uncovered while building it

- **`CapabilityReliability` needed one home.** The reliability types initially
  lived only in `reliability.ts`, while `CapabilitySelectionConstraints` and
  `index.ts` referenced them from `types.ts` → duplicate/undefined export errors
  under `tsc`. Moved the interfaces into `types.ts` and re-exported through
  `reliability.ts`.
- **`verificationCompatible` was never consumed by the engine.** Grep proved the
  enforcement gap; the design moved strict verification into `policy.ts`
  `policyFilterTool` (drops non-verifiable tools when required) instead of extra
  engine logic.
- **The ranker is only safe when its keys are bounded.** Using free-text
  arithmetic would leak model-relevant signals; the lexicographic comparator
  stays numeric over bounded enums/indices only.
- **The confirmation gate had to reuse, not reinvent.** It mounts on the
  existing `tool-confirm`/`awaiting`/`confirmPending`/`cancelPending`
  machinery; a refusal is a `permission_denied` failure (existing error kind),
  surfaced via trace events, and is NEVER counted as reliability.
- **`observe_desktop` ceiling needed `device_control` (not `read`).** A `read`
  ceiling would have dropped `desktop.screenshot` (user_confirmation →
  device_control); defaults were aligned with what the declared tools can do.
- **`tsc -b` caught real payload drift.** The `describe`-scoped security block
  matched `payload`/`random` inside doc comments; wording scrubbed so the pure
  files keep passing the static scan.

## 6. Risk metadata & permission ceilings

`CapabilityDefinition` gained REQUIRED app-owned `risk` (`read_only|low|medium|
high`) + `destructive`, and optional `requiresConfirmation`,
`preferredVerification`, `maximumPermission`. Defaults: every existing entry now
carries `risk`/`destructive`/`maximumPermission`; `delete_file` is
high/destructive/`requiresConfirmation`/`device_control`; read-only capabilities
are capped at `read`, action ones at `medium`, write ones at `write` from their
legacy tier. `toCapabilityDefinition` exposes only Risk / Destructive /
RequiresConfirmation / Verification preference — never ceilings, ceilings-wise
scores, reliability or secrets.

## 7. Pure policy layer (`policy.ts`)

`CAPABILITY_PERMISSION_ORDER` (`read<write<external_communication<
device_control|financial<destructive`); `permissionClassAtMost`;
`classifyToolPermission` (tier→class); `CAPABILITY_RISK_ORDER`/`riskRank`/
`classifyToolRisk`/`riskFromLevel`; `effectiveVerificationPreference`
(`strong`→strong, `weak|none|undefined`→normal); `toolVerificationStrength`;
`requiresCapabilityConfirmation`; `deviceContextId` (phone/tablet/mobile→
android; desktop/pc/laptop/windows→desktop; unknown→unscoped);
`verificationRequired`; `policyFilterTool` — ceiling drop + strict-verification
drop, each with a readable reason. All deterministic and application-owned.

## 8. Deterministic ranking (`rank.ts`)

`rankCapabilityCandidates` best-first orders candidates with
`[context, risk, verification, reliability, declared preference, tool id]` —
ascending lexicographic keys. `contextMatchScore` only ranks on active/available
application and visual-mode signals (device scope is a hard filter elsewhere);
`verificationKey` is neutral for `normal`/`weak` preferences so the declared
application order is preserved by default; ties break on tool id
(`localeCompare`) for determinism.

## 9. Automatic verification preference

Def defaults keep Phase 2.3 order (neutral verification key). An explicit
`preferredVerification: 'strong'` (or legacy `verification: 'strong'`, or
`constraints.preferVerifiable: true`) automatically prefers tools that can
self-verify — evidence-aware selection without any model input.

## 10. Bounded reliability history (`reliability.ts`)

Immutable `recordReliability` writes `capability::tool` entries; counters clamp
at `MAX_RELIABILITY_COUNTER = 100_000`; `reliabilityScore` defaults to 0.5
(indifference), verified successes weight ×2, sequence smoothed. Only EXECUTED
steps are recorded (`verified_success` when verification passed, `success` on
completed, `failure` otherwise); refusals/cancellations are never counted.
Content-free by construction: ids + counts only. Persistent per engine instance
across runs.

## 11. Trace events (Phase 2.4)

`capability_ranked` (best-first ranked implementations), `policy_filtered`
(candidate id + reason dropped by app-owned policy), `confirmation_required`,
`confirmation_refused`. All are id/class-level facts — no scores, no reasoning.

## 12. Safer fallback & honest drops

Fallback is still bounded by the declared `tools` list, but the winner is the
best RANKED survivor. `policyDropped` reports every candidate the application
policy excluded (with reason), `ranked` exposes the full ordering, and the
reason string explains risk/permission/ranking/fallback/verification notes.
Nothing survives → honest `capability_unavailable`.

## 13. Confirmation gate (engine)

When app policy sets `requiresConfirmation`, the capability step pauses on the
existing `tool-confirm` flow BEFORE the permission gate; the user must
`confirmPending()`. Refusal → step FAILS (`permission_denied`), emits
`confirmation_required` + `confirmation_refused` (+ `step_failed`), is excluded
from reliability, and the run continues like any other refusal. The model can
never toggle confirmation.

## 14. Plan validation changes

`validatePlan` gained a 7th argument `capabilityOptions`
(`{ capabilityContext, requireVerification, reliability, preferVerifiable }`).
`PlanStepResolution` now carries `permission`, `risk`, `verificationPreference`,
`requiresConfirmation`, `ranked`, `policyDropped`; the executor copies them
(guarding every optional field) onto tracker steps as `capabilityMeta`.

## 15. Engine wiring

- `private capabilityReliability` (cross-run), `capabilityContext()` from REAL
  engine state (device/app availability, interaction mode), and the
  `capabilityReliabilitySnapshot` getter.
- `capabilityRanked` / per-drop `policyFiltered` trace events emitted per
  capability step.
- Per-step `capabilityMeta` computed at the top of each tool request
  (defaults: risk `low`, permission `write`, verification `normal`).
- Confirmation gate, then the permission gate, budgets, dedupe, verification —
  all unchanged on the concrete tool.
- Reliability recorded after execution; `findOrAddStep`/`goalPlan()` carry
  `capabilityMeta`.

## 16. Surface plumbing & store mirror

`AgentStep.capabilityMeta?` (`PlanTracker.addStep`) → `GoalPlanStepView
.capabilityMeta?` (`goalPlan()`) → `StepViewLine.capabilityMeta?` (`stepLine`) →
`GoalPanel` chip (`risk:xxx` + ` confirm` when required, monospace, risk-colored,
always with a full `title`). `state/goalRun.ts` mirrors `goalPlan()` verbatim —
no change needed; `goalRun()` still mirrors recovery identically.

## 17. Hard guarantees

- Exactly one `AssistantEngine` loop remains the only executor.
- The model never creates capabilities, tools, permissions, ceilings, risk,
  fallbacks or policies — the application owns them all.
- Ranking is deterministic and model-immune; `ToolRegistry` remains the final
  execution authority; verification stays mandatory; refusals never count as
  reliability.
- No CoT/scores exposed; the frontend never derives a verdict.

## 18. Security boundary

The three new modules join `PROD_FILES` in `src/engine/goal/security.test.ts`:
no tool/engine/registry calls, no I/O, no logging, no secrets/hosts, no
`ToolRegistry`/`AssistantEngine` literals, bounded (non-`random`) ranking, and
content-free reliability. The pure layer decides only who is ALLOWED; enforcement
stays on the existing rails.

## 19. Tests & validation gates

- New pure suites: `reliability.test.ts` (8) — immutability, outcome counters,
  independence, clamping, scores (indifference/success/failure/verified), and
  content-free shape; `policy.test.ts` (11) — order/queries, tier→class/risk
  mapping, legacy tier mapping, verification preferences, confirm obligation,
  device mapping, strict verification, ceiling drops; `rank.test.ts` (12) —
  context matching, declared-order neutrality, risk ordering,
  preferVerifiable/strong-preference reorder, reliability tie-break and its
  strict ceiling, tool-id determinism, explainability annotations.
- `resolve.test.ts` extended (+8) — preview fields, ranked ordering, device
  hard-filter, ceiling drops reported, strict-verification drops, context
  requiresVerification, confirmation flag surfacing, fallback rationale.
- Engine integration `agentCore.capabilities.engine.test.ts` (+4) — confirmation
  refusal (blocked/failed step, no reliability, trace events), confirmation
  allow (verified step, `capabilityMeta`, recorded reliability), cross-run
  reliability persistence, `capability_ranked` + `policy_filtered` events.
- `security.test.ts` extended (Phase 2.4 block + PROD_FILES).

Result: `npx tsc -b` clean · `npm run lint` 0 errors · `npx vitest run` 89
files / 1100 tests pass (baseline 86 / 1056) · `npm run build` built ·
`npm run native:check` + `native:build` pass.

## 20. Versioning, docs, limitations, next steps

`NATIVE_AGENT_VERSION` bumped `2.3.0 → 2.4.0` (`native/src/protocol.ts`), wire
protocol unchanged. `docs/agent-architecture.md` §18 added. Limitations:
reliability is per-instance (not persisted to disk); no Android tools exist, so
device scoping is validated only for `android` seams; preview chip is fixed at
plan-report time (confirmed on-device later without a second loop). Natural next
steps: persisting reliability, a plan-time capability preview before committing
a run, and real-device QA for the device-scoped seams.