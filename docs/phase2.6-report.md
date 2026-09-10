# JARVIS Phase 2.6 — Real Action Execution

## 1. Objective

Give JARVIS the first deterministic *action* layer: classify every request
BEFORE the provider runs, refuse honestly what this environment cannot do,
escalate blind/destructive deictic requests to clarification, resolve
conversational follow-ups against what really ran last time, and commit a
bounded, honest execution record per run — all while preserving every Phase
0–2.5 security rail and passing all six gates at version 2.6.0.

## 2. Scope

- New PURE module `src/engine/action/` (types, errors, registry view,
  classifier, policy, execution context, follow-up resolution, user-facing
  messages) that NEVER executes tools and NEVER touches the engine, tool
  registry, I/O or secrets (covered by the `security.test.ts` PROD_FILES
  boundary scan).
- Engine integration in `AssistantEngine.process()`: the action layer sits
  between the direct-intent branch and the provider — unsupported requests are
  answered deterministically ("isn't connected… so I won't pretend it worked"),
  ambiguous or risky-deictic requests are clarified ("I didn't act because your
  request was ambiguous…"), everything else keeps its full planning/execution
  rails with an added engine-derived mechanism HINT (matched tool ids +
  capability ids) in the model context.
- Bounded per-conversation execution context (`ExecutionContextStore`): 6
  contexts/conversation, 24 artifacts/context, 15-minute TTL, in-memory only.
  Outcome classification never over-claims — refuted/unverified steps can never
  produce a plain `completed` verdict.
- Follow-up resolution: pure confirmatives (`do it`, `go ahead`, `ok do it now
  please`) replay the previous request; deictic references (`open the pdf`)
  resolve to a concrete path from the last run's real artifacts (one candidate)
  or "which one?" (several); stale context is never used; a deictic request
  with no prior context is treated as a fresh request, not a follow-up.
- Honest mock-provider copy refresh (local/dev tools wording, no stale
  "development stand-in" claims).
- New tests (unit + engine integration), the PROD_FILES whitelist entry for the
  new module, all six gates, version bump `2.5.0 -> 2.6.0` /
  `0.5.0 -> 0.6.0`, architecture doc §20, this report.

## 3. Not in scope

- No new real tools/capabilities: the action layer ROUTES; actual capability
  (native agent, vision, apps, desktop) additions are later phases.
- No plan/task changes, no permission/confirmation/validation/recovery/
  verification rail changes — existing rails are used, never replaced.
- No persistence of execution context (in-memory only, TTL-bounded).
- No UI changes beyond the read-only execution view behind
  `lastExecutionContext()`.

## 4. Engine contract surface

- `AssistantEngine.actionView()` — pure registry projection for the classifier.
- `answerDeterministically(domain, outcome, text?, candidates?)` — settles the
  run with an honest reply (refused/clarified), nothing executed.
- `completeExecutionContext()` — in `finally`: derives real step counts,
  error entries (cap 12) and file artifacts from the trace, classifies the
  outcome, commits via `fillExecutionContext` (which now records the real
  executed/verified/refuted/unverified counts).
- `lastExecutionContext(conversationId?)` — read-only public context getter.
- `actionHint` injected as a system message in `buildMessages` after the
  interaction hint — informational only.

## 5. Real corrections uncovered while building it

- Deictic follow-up detection fired on "please send it" with NO prior context,
  which broke the scripted two-round tool loop: a deictic reference is only a
  follow-up when something ran before it, so `resolveFollowUp` now returns
  `none` when there is no last context.
- The confirmative matcher under-matched "ok do it now please" and
  over-matched filler: FILLER no longer contains `go` (so "go ahead" survives
  token stripping) and wrapped confirmatives are resolved by stripping
  leading/trailing fillers and matching a core confirm set.
- The committed execution record always showed `executedSteps: 0` because the
  computed counts were never passed into the commit — `ExecutionRunFacts` now
  carries the real counts and `fillExecutionContext` stores them.
- Path extraction from tool output greedily swallowed spaces across array
  entries (one artifact per joined list); the path regex now excludes
  whitespace so each real path is its own artifact.

## 6. Honesty guarantees (preserved and extended)

- Unsupported = "isn't connected in this environment, so I won't pretend it
  worked"; unverified = admitted; cancelled/failed = terminal; Demo Mode never
  reaches the engine.
- Failed-closed only for clear, imperative, unconnected domains and for
  destructive deictic targets; everything else fails OPEN to the provider.
- The execution record never overstates: verified/refuted/unverified counts
  come from the real trace, and refuted/unverified steps can never yield a
  plain `completed` outcome.
- No secrets, payloads, raw exceptions or chain-of-thought in records or
  phrasing.

## 7. Templates & phrase handling

`action/messages.ts`: `unsupportedMessage`, `clarificationMessage` (with
candidate lists), `actionHintMessage`, `actionKindLabel`, `executionErrorLabel`.
`action/errors.ts`: bounded `EXECUTION_ERROR_PHRASES` + `makeExecutionError`
(cap 240 chars, safe message, no stack traces), plus the
`AgentErrorKind -> ExecutionErrorKind` mapping.

## 8. Deterministic request classification

`classifyRequest`: 1) any registered tool's `canRun` match → `executable`;
2) bounded verb vocabulary per domain (files/memory/system/apps/communication/
media/device); 3) questions without a tool match → `informational`;
4) no domain → `informational` (fail open); 5) recognised domain with a backed
capability or domain tool → `executable`; 6) imperative request in an
unconnected domain → `unsupported`. `isRiskyDeictic` guards destructive verbs +
deictic pronouns without an explicit target; `hasExplicitTarget` (paths, quotes,
extensions) and `hasLocative` (in Downloads) bound it so concrete requests are
never blocked.

## 9. Execution policy

`action/policy.ts`: `read_only`/`low_risk` → safe; `user_confirmation`/
`high_risk` → confirmation_required; an unconnected capability/domain →
blocked with a reason. Used as advisory routing; the engine's real permission
rails are unchanged.

## 10. Follow-up resolution

`followUp.ts`: pure confirmatives replay the prior request (or its
`resolvedText`), deictic refs augment to `(target: "C:/…")` or `ask_which`,
unresolvable refs → `ask_what`, no prior context for a deictic ref → `none`,
stale (> 15 min) → `ask_what`. Guarantee: it never guesses.

## 11. Execution context store

`executionContext.ts`: `begin`/`commit`/`lastFor`/`isStale`/`expire`/`size`,
bounded constants (`MAX_CONTEXTS_PER_CONVERSATION 6`,
`MAX_ARTIFACTS_PER_CONTEXT 24`, `EXECUTION_CONTEXT_TTL_MS 15 min`),
`extractFileArtifacts` (bounded, deduped), `classifyExecutionOutcome`
(no over-claiming), `fillExecutionContext`.

## 12. Deterministic answers (no execution)

`unsupported` → run settles, reply "…isn't connected… I won't pretend it
worked", nothing runs, context outcome `refused`. `ambiguous`/risky-deictic →
reply "I didn't act because your request was ambiguous: …", nothing runs,
context outcome `clarified`. Explicit destructive targets are NEVER over-blocked.

## 13. Post-run records (real facts only)

After every run `completeExecutionContext` reads the executed trace and stores
real counts, terminal status, matched tool/capability ids, error entries
(capped) and file artifacts extracted from tool output — no payloads/secrets —
then commits; `lastExecutionContext()` exposes it read-only.

## 14. Mock provider honesty refresh

`ApiProviderMock.canned()` now says: ready — what can I do for you?; who-are-you
"running in dev mode with local tools only, because no AI model is connected";
status lists clock/calculations/memory-notes/system info; catch-all honest
"local-dev mode — no connected capability for that yet". Removed the stale
"development core is online" / "development stand-in" copy.

## 15. Refunded / retired local tricks

Nothing from the deterministic layer executes tools by passthrough of
`canRun`; the previous accidental ambiguity of follow-up detection on
context-less deictic requests and the always-zero executed-steps record are
fixed (see §5).

## 16. Versioning

`NATIVE_AGENT_VERSION` `2.5.0 -> 2.6.0`; `APP.version` `0.5.0 -> 0.6.0`
(`APP.phase` `0.5 -> 0.6`); `NATIVE_PROTOCOL` unchanged (`jarvis-native-1`).

## 17. Tests & validation gates

Six gates all green:
1. `npm test` — 95 files / **1175 tests pass** (57 new Phase 2.6 tests across
   `action.test.ts`, `followUp.test.ts`, `AssistantEngine.execution.test.ts`).
2. `npx tsc -b` — clean.
3. `npm run lint` — 0 warnings / 0 errors (296 files, 116 rules).
4. `npm run build` — builds clean.
5. `npm run native:check` — clean.
6. `npm run native:build` — clean.

## 18. Security boundary

The new `src/engine/action/*` files are added to the `PROD_FILES` whitelist in
`goal/security.test.ts`: they never execute tools, never reach the engine or
tool registry, never do I/O/network/storage, never log, never hold secrets or
URLs. The engine's existing permission/confirmation/validation/recovery/
verification rails are untouched and are used by the action layer, never
bypassed.

## 19. Limitations

- Verb-domain classification is a bounded vocabulary; novel imperative phrasings
  in unconnected domains fail OPEN to the provider (which may honestly decline).
- Execution context lives only in memory for 15 minutes; it does not survive
  reloads and cannot be restored across sessions.
- The engine-derived `actionHint` is informational; a real model decides the
  final tool call through the normal rails.

## 20. Final status

PHASE 2.6 COMPLETE.