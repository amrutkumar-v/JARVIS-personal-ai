# Visual Understanding + Closed-Loop Computer Control — Phase 1.9

JARVIS gains an **eyes-before-hands** capability seam: an optional
`VisionProvider` that turns a transient screenshot into structured UI elements,
three narrow `desktop.visual*` tools that **compose the existing observation +
desktop providers**, and a closed loop that re-observes after every injected
action and reports its effect through the **existing engine verification rails**.

Phase 1.9 makes the visual seam **practical for real workflows** without adding
a second agent loop: target resolution is deterministic and refuses to guess,
every injection is guarded against **stale observations** (the window or screen
changing between analysis and injection), and a step is only ever considered
"done" when its effect is re-observed and verified.

This phase does **not** fabricate sight. Until a real `VisionProvider` is
configured the app reports visual understanding as *unavailable*, registers no
visual tools, and the model can never claim it saw anything.

Related: [Agent Architecture (Phase 1.0)](./agent-architecture.md),
[Native Windows Agent (Phase 1.2)](./native-windows-agent.md),
[Native Windows Observation (Phase 1.4)](./native-windows-observation.md),
[Native Windows Desktop Interaction (Phase 1.5)](./native-windows-desktop-interaction.md),
[Voice Interaction (Phase 1.6)](./voice-interaction.md).

## 1. What it does

| Piece | Module | Responsibility |
| --- | --- | --- |
| Contract | `src/vision/types.ts` | `VisualElement`, `VisualBounds`, `VisualViewport`, `VisionAnalysisResult`, `ResolvedVisualTarget`, `VisualTransitionOutcome`, `VISUAL_ELEMENT_TYPES` |
| Provider seam | `src/vision/provider.ts` | `VisionProvider` interface + honest `unavailableVisionCapabilities()` + the exact `VISION_UNAVAILABLE_MESSAGE` surface string |
| Real provider | `src/vision/remoteProvider.ts` | `RemoteVisionProvider` — OpenAI-compatible `/chat/completions` vision adapter, `createVisionProviderFromConfig` factory, `RemoteVisionError` (config/timeout/network/auth/rate_limit/server/malformed) |
| Config | `src/config/vision.ts` | `getVisionConfig()` (reads `VITE_JARVIS_VISION_BASE_URL` + `VITE_JARVIS_VISION_MODEL` + `JARVIS_API_KEY`), `configured = baseUrl && model`, `resetVisionConfigCache()` |
| Limits | `src/vision/limits.ts` | `MAX_VISUAL_ELEMENTS`, `MAX_VISUAL_TEXT_LENGTH`, `MAX_VISUAL_ANALYSIS_MS`, `MAX_VISUAL_ACTIONS_PER_RUN`, `MAX_TARGET_CANDIDATES` |
| Geometry | `src/vision/bounds.ts` / `coords.ts` | finite, positive, in-viewport element bounds; viewport → virtual-screen → client conversion that **refuses** every unprovable step; **exact** client-relative mapping when `clientBounds` are measured (native), documented frame-offset fallback otherwise |
| Resolution | `src/vision/localize.ts` | deterministic target → element tiers; refuses to guess on ambiguity |
| Closed loop | `src/vision/verification.ts` | `verified` / `refuted` / `unverified` verdict after re-observation |
| Redaction | `src/vision/sanitize.ts` | typed text redacted for `desktop.visualType` before any trace/plan write |
| Budget | `src/vision/budget.ts` | per-run visual-action ceiling (`MAX_VISUAL_ACTIONS_PER_RUN`), separate from desktop mouse/key buckets |
| Staleness | `src/vision/staleness.ts` | exact identity checks (window geometry + screenshot bytes) that refuse an injection when the observation is no longer current |
| Tools | `src/vision/VisualComputerTools.ts` | `desktop.visualInspect` / `desktop.visualClick` / `desktop.visualType` — optional `window_id` scoping, exact clientBounds conversion, stale-observation gate before every injection |
| Testing fakes | `src/vision/testing.ts` | `FakeVisionProvider` (`testsOnly = true`), deterministic element seeds sized to the 2x2 fake screenshot |

The engine wires the seam in `src/engine/AssistantEngine.ts` (optional
`vision` option, tool registration, `start()` capability flags, per-run visual
budget gate, redaction composition, and the run-abort signal passed to tools).

## 2. Honesty rules (the whole phase is built around these)

- **No provider, no sight.** Browser/app mode passes `undefined`; the engine
  registers no visual tools and reports every visual capability as `false`.
  The honest surface sentence is exactly:
  `Visual semantic understanding is unavailable until a real VisionProvider is configured.`
- **Never guess.** A target that is *not found* or *ambiguous* refuses the
  action. Nothing is ever clicked or typed on a guess.
- **Never invent an outcome.** If the post-action re-observation cannot be
  performed or `expected_after` was not requested, the outcome is
  `unverified` — the tool and engine say "executed but not confirmed", never
  "done".
- **Fakes are quarantined.** `FakeVisionProvider` lives in `src/vision/testing.ts`,
  sets `testsOnly = true`, and is never re-exported from
  `src/vision/index.ts`. A static `?raw` security scan in
  `src/vision/security.test.ts` enforces this.
- **Single source of truth for capabilities.** `capabilities()` is the only
  capacity report the UI/engine reads; it is never reconstructed or invented
  at the call site.
- **A real provider is bound only when configured.** `src/native/index.ts`
  binds `RemoteVisionProvider` exclusively via
  `createVisionProviderFromConfig()`: no `VITE_JARVIS_VISION_BASE_URL` +
  `VITE_JARVIS_VISION_MODEL`, no provider — same honest `undefined` as
  Phase 1.7. `remoteProvider.ts` is the **only** model-calling file in the
  vision module (enforced by `security.test.ts`).
- **Screenshot bytes are transit-only, data-URI only.** The remote provider
  sends the screenshot exclusively as a `data:image/png;base64,…` `image_url`
  in the request body; the API key travels only in the `Authorization` header.
- **Every parsed element is validated and bounded.** Non-objects, non-finite /
  negative / zero-area / off-viewport boxes, and unknown types are dropped;
  counts are capped at `MAX_VISUAL_ELEMENTS`, text at
  `MAX_VISUAL_TEXT_LENGTH`, confidence clamped to `[0,1]` (default `0.5`).
  A reply with no usable elements is a `malformed` failure — never a guess.

## 3. Run-less data flow (the tool pipeline)

```
model → desktop.visualInspect/visualClick/visualType
   → availability gate (vision + observation + desktop all live)
   → params validated (window decimal id, expected_type allow-list,
                      confidence in [0,1], text non-empty + bounded)
   → (optional window_id) observation.getWindowStatus → scoped inventory
   → analyzeOnce: observation.captureScreenshot()
                  + vision.analyzeScreenshot(screenshot, {
                      signal: run/analysis timeout })   [RemoteVisionProvider:
                      one POST per analysis]
   → resolveVisualTarget (exact label → normalised label → exact text)
   → element centre chosen, footprint validated in the analysed viewport
   → viewport → virtual-screen (must match screenshot dims exactly)
   → window verified live via observation.getWindowStatus
   → screen → client-relative via clientBounds when measured (exact),
     else the documented frame-offset fallback; must land inside the surface
   → STALE-OBSERVATION GATE (click/type only):
        fresh observation.getWindowStatus (exact geometry compare; a closed
        window is detected even when the provider throws not_found)
        fresh observation.captureScreenshot (byte compare against the shot
        the inventory came from)
        any mismatch → refuse with kind 'stale_observation' + re-observe
        instruction — nothing is injected
   → cancel re-check (ctx.signal)  [engine run abort]
   → inject ONE desktop action (click; click + typeText for visualType)
   → re-observe (analyzeOnce again) → verifyVisualTransition
   → verdict carried on data + mapped to the existing engine verifier:
       verified   → engine 'verified'   (step COMPLETED)
       refuted    → engine 'failed'     (step FAILED, "Refuted: …")
       unverified → verifier throws     (step COMPLETED but '[unverified]')
```

Permission, budgets, the repeated-action guard, cancellation and trace
recording all continue to apply at the engine level exactly as with any
`desktop.*` tool: `visualInspect` is `read_only`; `visualClick` / `visualType`
are `low_risk` (auto-run in the same confirmation tier as `desktop.click`).

## 4. Coordinate honesty

- The vision layer reasons in **viewport** pixels (the screenshot). The desktop
  layer acts in **virtual-screen** px (`desktop.move`/`cursor`) or
  **client-relative** px (window-targeted actions). `coords.ts` converts once,
  explicitly:
  - screenshot dimensions must equal the virtual screen dimensions **exactly**
    — a mismatch is rejected, coordinates are never scaled blindly;
  - the resulting point must land **inside** the measured window surface;
  - with `clientBounds` measured (native agent since 1.8.0: `GetClientRect` +
    `ClientToScreen`) the mapping is **exact** — the frame offset is removed and
    the point must fall inside the *client* area, which is what the screenshot
    pixels actually cover (the frame itself is never clickable);
  - without `clientBounds` the client-origin frame offset is the documented
    approximation — the point is still within the window bounds (the target is
    a UI element *inside* the window); a point in the frame is still refused.
- A point that lands in the frame but outside the client area, an
  inverted/non-finite `clientBounds` rectangle, and any conversion whose
  intermediate step is unprovable are all refused with a provider-safe reason.
- Single-window screenshots: a resolved element that lies outside the scoped
  window's surface is refused (a *different* window's element is never clicked).

## 5. Privacy & redaction

- Screenshot bytes are **transit only** — the vision module never captures,
  stores, uploads or logs them; `RemoteVisionProvider` sends them exclusively as
  a `data:image/png;base64,…` `image_url` in a single POST per analysis, and
  only reads the bounded element list back. The API key is used solely for the
  `Authorization` header.
- `desktop.visualInspect` returns **structural facts only** (id, type, label,
  bounds, confidence) — no OCR text dump, no bytes.
- `desktop.visualType` never echoes text: tools report the character **count**,
  and `sanitizeVisionPayload` redacts the `text` field on the trace/plan for
  the `desktop.visualType` id (composed after the desktop sanitizer, so
  `desktop.type` text stays redacted by its own sanitizer).
- The trace never contains the fake test PNG, model text dumps, or typed text
  (asserted in `agentCore.vision.engine.test.ts`).

## 6. Per-run visual budget

The provider is stateless across requests, so the **engine** enforces the
ceiling for the whole run — `MAX_VISUAL_ACTIONS_PER_RUN = 20` visual
actions (inspect/click/type), blocked **before** any analysis/injection as an
`orchestration_limit`, and counted separately from the desktop mouse/key
buckets. `engine.visualBudget()` exposes the counter for tests/UI.

## 7. The real provider (Phase 1.8)

`src/native/index.ts` binds `createDefaultAppVisionProvider()` to
`createVisionProviderFromConfig()`. From env:

```sh
VITE_JARVIS_VISION_BASE_URL=https://api.openai.com/v1   # any OpenAI-compatible /chat/completions
VITE_JARVIS_VISION_MODEL=gpt-4o-mini
JARVIS_API_KEY=sk-…                                      # optional for keyless local endpoints
```

The binding is **config-driven only**: no base URL or no model → no provider →
visual understanding reports unavailable exactly as before. There is no
hardcoded host and no fallback provider in the production path — `remoteProvider.ts`
is the only file authorised to touch a model (static scan enforced).

```ts
import { createVisionProviderFromConfig } from '../vision'

const vision = createVisionProviderFromConfig()   // RemoteVisionProvider | undefined
```

The engine, tools, budgets, privacy rails, verifier mapping and UI reporting
then work unchanged. `RemoteVisionError` kinds: `config`, `timeout`
(surfaces with the standard `TimeoutError` name so the tool layer still
recognises cancellations), `network`, `auth` (401/403), `rate_limit` (429),
`server` (other non-OK), `malformed` (unreadable reply / no usable elements).
Every failure maps onto an honest provider-safe message — an endpoint that
cannot answer aborts the visual action; nothing is injected or invented.

## 8. Practical visual workflows (Phase 1.9)

Phase 1.9 turns the Phase 1.7/1.8 seam into a **usable workflow without adding
any new orchestration**. The `AssistantEngine` remains the single authority for
permissions, budgets, step limits, the repeated-action guard, cancellation,
verification and tracing; the visual tools simply compose those existing rails.

**Workflow shape** — every visual action is: `observe → resolve → permission →
gate → act → re-observe → verify`. A step is **not** considered done when the
injection succeeds; it is done when the re-observation confirms the requested
visible state (`verified`), or honestly fails/leaves it unconfirmed.

**Target resolution** (`src/vision/localize.ts`) is deterministic, priority
ordered, and bounded:

1. exact element **label** match;
2. normalised label (case/space-insensitive);
3. exact **visible text** match;
4. optional filters applied in order: `expected_type` allow-list, then
   `confidence_threshold`, then a spatial `within` box;
5. candidates capped at `MAX_TARGET_CANDIDATES = 10`.

0 candidates → `not_found` refusal; exactly 1 → resolved; more than 1 after
filters → `ambiguous` refusal with a bounded candidate list. The agent is
**never** allowed to silently pick "the highest-confidence" candidate — a
multi-match always refuses and asks for a more specific target.

**Stale-observation protection** (`src/vision/staleness.ts`) — the one new rail.
A click/type decision "this element is HERE" rests on two observable identities:
the window geometry used for coordinate conversion, and the screenshot bytes the
inventory came from. Immediately before injecting, the tool re-checks both:

- a fresh `getWindowStatus` (exact compare of `exists` + `bounds` +
  `clientBounds`; a window that vanished mid-pipeline is detected even when the
  provider surfaces it as a `not_found` error);
- a fresh `captureScreenshot` (exact compare of width/height/format/bytes
  against the decision shot).

Any mismatch refuses the injection with `data.kind === 'stale_observation'` and
a `cause` (`screen_changed` | `window_changed` | `window_closed`), plus a
"re-run desktop.visualInspect" instruction. Both checks are **exact, never time
based and never probabilistic** — a ticking clock or focus ring is a conservative
refusal, not a "close enough". `visualInspect` is read-only and needs no gate.

**Failure behaviour** — when a visual workflow cannot proceed safely it *stops
and explains* rather than guessing. The distinct honest outcomes:

| Situation | Result |
| --- | --- |
| Target not found | refuse, `resolution: 'not_found'`, nothing injected |
| Target ambiguous | refuse with bounded candidates, nothing injected |
| Window moved / resized / closed after analysis | refuse, `stale_observation`, nothing injected |
| Screen changed after analysis | refuse, `stale_observation`, nothing injected |
| Target/footprint outside measured client area | refuse, `invalid_input`, nothing injected |
| Window mismatch / no measured surface | refuse, `tool_failure`, nothing injected |
| Provider unavailable | honest capability refusal |
| Analysis timeout / run cancellation | cancel, nothing injected |
| Malformed / network / auth vision reply | provider-safe failure, nothing injected |
| Visual budget exhausted | engine `orchestration_limit`, nothing runs |
| Repeated identical action | engine repeated-action guard blocks |
| Injection succeeded, effect verified | `verified` (step COMPLETED) |
| Injection succeeded, effect not found | `refuted` (step FAILED) |
| Injection succeeded, no expected state | `unverified` (step COMPLETED, honest) |
| Desktop injection itself failed | provider-safe failure, no fabrication |

When uncertain, the conservative branch is always refusal — never an injection.

**Security boundary.** Screenshot analysis output is **untrusted data**. The
model can only ever influence the desktop through a *label* that is resolved
against the inventory: the visual tools accept no `x`/`y`/`command`/`shell`/`key`
parameters, so a corrupt model result cannot name an arbitrary screen point, key
chord, or hidden tool. The vision layer drives exactly two desktop verbs
(`click` + `typeText`), every injection passes the staleness gate, and no visual
code reaches into the Agent Core. Static scans in `security.test.ts` enforce all
of this. Voice commands route through the same `AssistantEngine` pipeline — there
is no voice-specific execution path that could bypass the gate.

**Versioning.** The native agent protocol version is bumped to `1.9.0`
(`native/src/protocol.ts`); older client-vs-agent mixes keep working because the
version string is informational and the protocol surface is unchanged (a
changed protocol surface would have required a `NATIVE_PROTOCOL` bump instead).

## 9. Testing & validation

`npm test` (full suite), `npx tsc -b`, `npm run lint`, `npm run build`,
`npm run native:check`, `npm run native:build` all pass. Key tests:

- unit: `bounds` / `coords` (incl. dim mismatch + negative origins + exact
  clientBounds mapping + frame-but-outside-client refusal) / `localize`
  (tiers, ambiguity cap, filters) / `verification` / `provider` / `budget` /
  `sanitize`;
- real provider: `remoteProvider.test.ts` (config-driven presence, endpoint
  resolution, data-URI-only bytes, key-only-in-Authorization, element
  bounding/capping, every `RemoteVisionError` kind, abort + timeout);
- tools: `VisualComputerTools.test.ts` (verified/refuted/unverified, ambiguous
  refused, mid-pipeline cancel, scoped `window_id` inspect, exact clientBounds
  injection, frame/other-window refusal);
- engine: `agentCore.vision.engine.test.ts` (wiring, honest caps, closed-loop
  statuses, repeated-action guard, visual-vs-desktop budget separation, trace
  redaction, voice→visual closed loop, REAL `RemoteVisionProvider` through the
  engine with a stubbed fetch — one POST per analysis, endpoint failure aborts
  the action); Phase 1.9 block: stale-screen / window-move / window-close
  refusals with nothing injected, gate-through success, and a voice-driven
  refusal;
- staleness: `staleness.test.ts` (exact byte/geometry compares + cause
  classification) and gate tests in `VisualComputerTools.test.ts` (screen /
  move / resize / close refusals, deterministic pass-through, no post-action
  verification on a refused gate, char-count-only after a guarded `visualType`);
- boundary scan: `security.test.ts` (`?raw` — no shell, no raw capture, only
  `remoteProvider.ts` may call a model, no Agent Core reach-in, fakes
  quarantined; Phase 1.9: staleness module is inert, visual tool schemas accept
  no raw coordinates/commands/keys, vision drives only click + typeText, every
  injection passes the gate).

## 10. Goals run through the same rails (Phase 2.0)

Goal-directed runs (see [`agent-architecture.md`](./agent-architecture.md)
§14) do **not** add a second path to the computer: a goal is just a run whose
steps go through the identical permission gate, validation, repeated-action
guard, visual staleness gate and verification system, then receive an
evidence-based goal verdict (`trace.task`). Visual actions stay private
(transient, redacted, budgeted, single-POST analyses) whether the goal is
spoken, typed, single-shot or multi-step — same shots, same limits, same
unverified honesty rule. Engine-level goal tests (`agentCore.goal.engine.test.ts`)
reuse the visual fakes and end-to-end voice harness to prove the goal loop
composes visual steps, refutations and verdicts without bypassing any rail.

## 11. Goal runs become a visible surface (Phase 2.1)

The user-facing goal UI ([`agent-architecture.md`](./agent-architecture.md) §15)
is a display layer over the same rails: `engine.goalPlan()` mirrors the live
`PlanTracker`, per-step visual effects show their engine-computed state
(`verified` / `refuted` / `unverified` / `failed` from the verbatim
`classifyPlanStep` — the UI cannot invent "looks done"), and the verdict chip
renders the Phase 2.0 `trace.task` text. A completed-but-unverified visual goal
still renders "Finished — not declared complete". The Goal panel consumes only
the store mirror (`syncGoalRun`), never reaches into `VisualComputerTools`,
`RemoteVisionProvider` or the Agent Core, and its static scans
(`src/components/goal/security.test.ts`) enforce the same no-execution / no-
payload / no-verdict-derivation rails as the vision boundary. Visual goals keep
their private transient analyses and single-POST cap whether typed, spoken,
budgeted or cancelled mid-run.