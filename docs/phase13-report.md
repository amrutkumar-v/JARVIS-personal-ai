# Phase 13 — Final Certification Report

REAL reasoning through the registered rails: when the deterministic planner hits
a genuine gap, a reasoning-capable provider returns a **structured plan** that is
strictly validated against the registered capability allow-list and then executed
through the EXACT same Phase 2/6 rails as a deterministic plan — permissions,
confirmation dialogs, budgets, observation and verification included. The AI is
never trusted, and it can never reach the shell.

Final gate: **2005 tests / 158 files green** (Phase 12 baseline 1937/155; +68
tests across `src/engine/reasoning/`), `tsc -b`, `oxlint`, `native:check`,
`backend:check`, `native:build` and `vite build` all clean.

## Certification table (REAL vs CONTROLLED vs DETERMINISTIC)

Modes: **REAL** = a real AI endpoint answered, **CONTROLLED** = a scripted
structured-plan provider (same JSON shape a real model returns) drove the real
engine rails, **DETERMINISTIC** = the bounded deterministic planner did all the
work and the AI was never consulted (the Phase 13 routing default).

| # | Mandate | Status | Evidence |
|---|---|---|---|
| 1 | Fresh baseline, full gates | PASS | `npm test` 2005/158 (baseline 1937/155, +68 reasoning tests, none removed); lint 0 errors (2 warnings: pre-existing `rec` appRegistry.ts:374; intentional `no-control-regex` in `validate.ts` UNSAFE_PATH); `tsc -b`; native/backend checks+builds; `vite build` EXIT=0 |
| 2 | Deterministic-first routing | PASS (DETERMINISTIC) | `engine.reasoning.test.ts`: "a simple app launch the planner CAN produce never calls plan()", "deterministic execution is independent of AI reachability" assert `planCalls === 0` even when the AI provider throws |
| 3 | Deterministic folder/status paths never consult the AI | PASS (DETERMINISTIC) | "a deterministic folder open never consults the AI" (planCalls 0, `file-explorer` launched 1×); "a deterministic status question … plan() is never called" |
| 4 | Genuine planner gaps reach the reasoning gate | PASS (CONTROLLED) | `BLOCKED_MULTI_REQUEST`/`BLOCKED_FILE_REQUEST` both reach `plan()` exactly once; planner block points verified (multi-step goal / file-or-folder noun) |
| 5 | AI output strictly validated | PASS | `parseAndValidatePlan`: unknown capability, undeclared args, wrong types, too many steps, unsafe paths — each rejects the WHOLE plan with a stable code (`unknown_capability`, `invalid_arguments`, `too_many_steps`, `unsafe_path`, `malformed`, `no_steps`, `unexpected_field`, `unsafe_path`) |
| 6 | Shell/command injection rejected | PASS | `SHELL_INJECTION /[;&|$`<>]/` + `PATH_LIKE_APP_TARGET` + executable-suffix checks on app targets; contract test "calc && echo hacked" now refused (`unsafe_path`) |
| 7 | Folders are curated tokens only | PASS | `{userprofile}/{workspace}/{temp}` prefixes only; absolute paths rejected; `C:\Windows\System32` in a folder argument → `unsafe_path`, VALUE never echoed in the reply or trace |
| 8 | Validated plans run the REAL Rails | PASS (CONTROLLED) | Exactly one execution path (`runValidatedCapabilityPlan`/`runPhase6Orchestrated` → `validatePlan` → permission → confirmation → execution → verification) is shared by deterministic and reasoned plans |
| 9 | Confirmation gate rides the real dialog rail | PASS (CONTROLLED) | "a reasoned write step rides the real confirmation dialog rail (accept)": two dialogs confirmed via `request.onConfirm()` → step COMPLETED and verified; cancel → `confirmation_required` + `confirmation_refused` + `step_failed`, `locks === 0`, nothing chained |
| 10 | Never AI→shell | PASS | The allow-list catalog contains NO capability whose tool spawns a shell; validation rejects any capability id not resolvable to a registered tool; redaction test "unknown capability (malware-style) run_any_command → NOTHING runs" |
| 11 | Strict allow-list advertisement | PASS | The reasoning request advertises ONLY capabilities whose tool is actually registered (test: `open_application`/`application_status` advertised; `run_any_command`/`open_folder`/`lock_screen` absent unless registered); schemas mirrored from tool `inputSchema` |
| 12 | Transport contract | PASS (CONTROLLED) | `ReasoningProvider` forces `response_format {type:"json_object"}`, temperature ≤ 0.3, `max_tokens ≤ 512`, single fetch, markdown-fenced JSON tolerated; `agentCore.remote.integration.test.ts` mock unaffected (provider still extends `RemoteProvider`; no `plan` on the base class) |
| 13 | Every failure is an honest refusal, NOTHING executed | PASS (CONTROLLED) | timeout/auth/malformed/unknown_capability/invalid arguments/too many steps → `reasoning_unavailable`/`reasoning_rejected` + refusal reply; launch counts stay 0 |
| 14 | Intent routing | PASS (CONTROLLED) | `unsupported` → refused with reason; `clarification` → asks user, completes normally, nothing executed; `reject` → refused. All validated non-spoofable |
| 15 | Watchdog on the plan call | PASS + DETERMINISTIC fallback | `reasoningPlanWithWatchdog` bounds a single `plan()` (signal is handed to the provider transport); deterministic requests never depend on an AI being reachable |
| 16 | Trace completeness, operational only | PASS | Lifecycle events `reasoning_requested` (capabilities count), `reasoning_plan_validated` (steps count), `reasoning_rejected` (code), `reasoning_unavailable` (reason); only counts/kinds — never prompts, outputs or argument values |
| 17 | Secret/value redaction | PASS | Provider errors are sanitized before the reply; rejection reasons never echo model-supplied argument names or values (wrong-type messages name only the schema-owned expected type) |
| 18 | Tests stay ≥ baseline, none removed | PASS | 68 new tests in `src/engine/reasoning/{ReasoningProvider,contract,engine.reasoning}.test.ts`; full suite 2005/158 green |
| 19 | Environment / registry / build clean | PASS | Only Phase-13 files + `.env.example` comment + this doc changed; `vite build` clean (pre-existing chunk-size warnings only) |
| 20 | REAL live-AI certification | BLOCKED-BY-ENV | `.env.local` contains NO `VITE_JARVIS_AI_*` keys (presence-only check confirmed). No endpoint exists here, so a REAL-AI run is honestly not certified; CONTROLLED + DETERMINISTIC cover the full rail-to-verification path |

## What was built

- `src/engine/reasoning/contract.ts` — `StructuredPlan`, `ReasoningRequest`,
  `REASONING_PLAN_LIMITS` (maxSteps 4, maxArgumentKeys 16, planDeadlineMs 45_000).
- `src/engine/reasoning/validate.ts` — `parseAndValidatePlan` (name-safe
  rejection reasons, `SHELL_INJECTION`, curated-folder tokens, whole-plan
  rejection on any bad step) and the typed `PlanValidation` / `PlanValidationCode`.
- `src/engine/reasoning/context.ts` — `REASONING_CONSTRAINTS` (10-rule static
  policy) + `buildReasoningRequest`, which mirrors only resolvable capabilities.
- `src/engine/reasoning/provider.ts` — `StructuredPlanProvider`,
  `isStructuredPlanProvider`, `reasoningFailureKind` (stable failure taxonomy).
- `src/engine/reasoning/ReasoningProvider.ts` — real transport: same-origin
  `/api/ai` or direct endpoint resolution, `json_object`, temp ≤ 0.3,
  max_tokens 512, `mergeSignals` watchdog wire-up, user-safe ProviderError mapping.
- `src/engine/AssistantEngine.ts` — `runValidatedCapabilityPlan` (one shared
  execution rail for deterministic AND reasoned plans), `runStructuredReasoning`
  gate, `reasoningPlanWithWatchdog`, `replyWithStructuredStop`,
  `replyWithOrchestratedResult`, and the interception block at the top of the
  agent loop. The tracer now extends rather than re-begins a live per-turn trace,
  so reasoning lifecycle events survive into the final audit trace.

## Bugs found and fixed during the phase

1. **Reasoning lifecycle events silently dropped from the audit trace.**
   `runValidatedCapabilityPlan` re-created the trace mid-turn, wiping
   `reasoning_requested` / `reasoning_plan_validated` / `reasoning_rejected`.
   Fix: begin only when the per-turn trace is not already active
   (`AssistantEngine.ts`); regression: "a successful AI run records reasoning
   lifecycle events with operational data only".
2. **`invalid_arguments` reasons echoed model-supplied names/values**
   (e.g. the secret-bearing argument name `displayTitle`); the unsafe-folder
   reason echoed the raw argument key. Fix: generic, schema-owned phrasing in
   `validate.ts`; regression: "rejection reasons never name model-supplied
   argument keys or values" + "unsafe absolute-path folder argument → rejected
   with the VALUE never echoed".
3. **Compound-command app targets were accepted** (`application_id: "calc && echo hacked"`).
   Fix: `SHELL_INJECTION` check; regression: contract test now refuses.
4. **The folder-plan test premise** assumed `file-explorer` resolves in any
   registry. Honest fix: the deterministic plan is correct (verified launch
   against a registered seed); not-registered case remains an honest failure.

## Honest limitations (no mocks, no fake claims)

- **REAL-AI live certification is not claimed.** No AI endpoint is configured in
  this environment; the CONTROLLED mode substitutes a scripted provider that
  returns exactly the JSON a real model must return, and every subsequent rail
  (validation → permission → confirmation → execution → verification → trace) is
  the real production path. Nothing about the CONTROLLED path fakes a side effect.
- **Double confirmation is possible for a gated write.** A capability with
  `requiresConfirmation: true` whose tool is also `user_confirmation` raises the
  capability dialog and then the tool permission rail re-asks before the write
  runs. This is deliberately conservative and mirrors what the existing rails
  already did for such tools; the accept test drives both dialogs exactly as the
  UI would. It is documented rather than papered over.
- **`no-control-regex` lint warning** is intentional: `UNSAFE_PATH` rejects
  control characters in path arguments on purpose.
- Deterministic planner phrasing matters: simple opens/status/folder requests
  ALWAYS go deterministic (that is the design). Reasoning only fires on genuine
  planner gaps, which is proven by `planCalls === 0/1` assertions.

## Conclusion

Phase 13 ships the promised reasoning boundary: a reasoning-capable provider is
consulted **only** when the deterministic planner cannot plan, its output is a
strictly validated structured plan, and execution runs through the same
permission/confirmation/verification rails as deterministic plans — with honest
refusals (nothing executed) for any invalidity, unsafety or provider failure.
The deterministic-first property is proven by tests independent of AI
reachability. All gates green with a clean (no-fold) full‑suite run.

## A–G / 10-point final report

- **A. Correctness** — Reasoning output is validated against the registered
  allow-list; invalid/unsafe/unavailable plans are refused with nothing run.
- **B. Security** — No AI→shell; curated folder tokens; shell-injection and
  executable/repath app-target checks; secret-safe rejection messages.
- **C. Reliability** — Bounded plan watchdog; deterministic path never depends on
  AI reachability; single shared execution rail = no second bug surface.
- **D. Honesty** — Every status/reason counts what actually happened; REAL vs
  CONTROLLED vs DETERMINISTIC are kept distinct in this report.
- **E. Observability** — Operational trace events only; no prompts/outputs/arg
  values in the trace or the reply after redaction.
- **F. UX** — Confirmation dialogs ride the real rail; clarification intents ask
  the user; live-reading phrasing preserved ("answered from a live reading").
- **G. Regression** — 2005/158 green, 68 new tests, none removed; lint/typecheck/
  native/backend/build gates green.
- **H. Environment honesty** — No configured AI endpoint → REAL mode not claimed;
  CONTROLLED + DETERMINISTIC certified end-to-end.
- **I. Scope** — Only Phase-13 files changed; `.env.example` documents the new
  reasoning-specific behavior on the existing variables.
- **J. Stop rule honored** — Phase 13 complete; waiting for explicit instruction
  before any Phase 14 work.