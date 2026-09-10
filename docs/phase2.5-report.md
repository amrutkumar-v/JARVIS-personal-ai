# JARVIS Phase 2.5 — Interactive JARVIS & Software Interaction

## 1. Objective

Turn JARVIS into a *conversable* operator: richer, always-honest real-time
status; deterministic capability discovery ("what can you do?"); input-channel
awareness end-to-end (voice riding the SAME engine loop); a DOM Arc Reactor
centerpiece; a pure presentation theme system with five themes and a
presentation-only Demo Mode; better assistant-style phrasing for refusals,
unverified results and unavailable seams — all while preserving every Phase
0–2.4 security rail and passing all six gates at version 2.5.0.

## 2. Scope

- Extended `JarvisStatus` superset and honest engine emissions: understanding /
  planning / executing / observing / verifying / waiting_for_confirmation /
  cancelled / failed, with terminal honesty in `applyResponse` (no optimistic
  success, no TTS on cancelled/failed).
- Closed input-channel vocabulary (`text | voice | visual | gesture`) with
  explicit `ready: false` for the reserved visual + gesture seams; voice and
  text both enter `AssistantEngine.process(text, { channel })`.
- Pure capability-discovery module (`src/engine/interaction/intents.ts`) with a
  small, explicit meta-command set answered ONLY from the live registered
  catalog + honest connection state; plus a catalog-derived interaction hint in
  the model context.
- DOM Arc Reactor (`ArcReactor.tsx` + pure `arcReactorModel.ts`), driven only
  by real engine status and real TTS state; speech pulse bounded for safe
  motion; reduced-motion support.
- Theme system (`src/themes.ts`): classic / cyber / stealth / holographic /
  minimal as CSS design-token overrides; `theme`/`demoMode` store state isolated
  from engine state; settings-panel picker; Demo Mode that only enlarges the
  reactor — never execution.
- Honest consumer updates: StatusChip labels, `visual.ts` PARAMS (complete over
  the superset + `speech` channel), voice manager engine-status mapping, theme
  CSS blocks and responsive additions.
- Tests, six gates, version bump `2.4.0 → 2.5.0`, architecture doc §19, this
  report.

## 3. Not in scope

Still exactly ONE agent loop. No Android/network tool implementations (seams
only), no fake vision/gesture handling (both report `ready: false`), no dozens
of hard-coded phrase→action mappings (only the explicit meta-command set, which
only READS the catalog), no model authority, no shell access, no wire-protocol
change, no engine participation in themes or Demo Mode.

## 4. Engine contract surface

| Surface | Change |
| --- | --- |
| `process(text, opts?)` | `opts.channel?: InputChannel` (default text); honours the current run's channel marker |
| `capabilityContext()` | `interactionMode` now derived from the active channel (`channelInteractionMode`) |
| `catalogEnvironment()` | new honest connection report (native agent / observation / desktop / vision) |
| `buildInteractionHint()` | new catalog-derived system hint injected into `buildMessages` |
| status emissions | `understanding`/`planning`/`observing`/`verifying`/`waiting_for_confirmation`/`cancelled`/`failed` on the real transitions |
| `applyResponse` | keeps `cancelled`/`failed` terminal; no TTS for those |
| `JarvisStatus` | superset extended (see §5) with all consumers updated |

## 5. Real corrections uncovered while building it

- **Exhaustive status consumers would have broken tsc.** Growing the
  `JarvisStatus` union immediately surfaced `StatusChip LABELS` (incomplete
  record). Extending the union before updating the exhaustive consumers was
  deliberate: tsc turned the migration into a checklist. `visual.ts` `PARAMS`
  and the voice manager were both updated to the superset.
- **`@layer` would have silently disabled the themes.** Theme overrides placed
  inside `@layer jarvis-themes` would LOSE the variable cascade to the unlayered
  `:root` tokens. Fix: theme blocks sit after `:root` in source order at equal
  specificity — the cascade picks them up and all `var(--…)` consumers follow.
- **Capability discovery needed one vocabulary.** `categoryLabel` and the engine
  hint fell out of alignment with the real category strings in `defaults.ts`
  (`application|data|desktop|files|system|vision`). The report groups and hint
  now read from those actual values so no category can render as "Other".
- **`stream/Privacy` tests were unaffected, but one engine test asserted the old
  status.** The deliberate `thinking → understanding` change required updating
  `AssistantEngine.test.ts` (planning round assertions) and widening a terminal
  set to include `failed`.

## 6. Honesty guarantees (behaviour the phase must preserve)

- Unverified result → "I performed the action, but I couldn't verify the result."
- Requested-but-refused → "I didn't perform it."
- Unavailable seam → "…can't … not available / not connected" — never implied
  as working.
- Cancelled/failed runs stay terminal; the UI shows only real engine state
  (no chain-of-thought, no scores, no raw tool args).
- Voice uses the same engine path; gesture/visual report `ready: false`; speech
  animation runs only while genuine TTS emits.

## 7. Templates & phrase handling

No assistant-template system was added. JARVIS answers through the provider with
the existing, structured, reality-constrained assistant profile; the small
explicit meta-command path (§4/§8) is the only deterministic branch and it only
reads the live catalog. Refusal / unverified / unavailable phrasing stays a
provider-presentation concern constrained by the honesty rules above — the
engine never emits optimistic claims and its terminal states are exact.

## 8. Deterministic capability discovery

`detectDirectIntent` matches an explicit, bounded phrase set for the two
meta-intents (`capabilities`, `help`). When matched, the engine — WITHOUT
invoking the provider — renders `capabilityCatalogReply(...)` from the live
`capabilityCatalog()` + `catalogEnvironment()`, emits it as an assistant
transcript, records an activity, ends the run `completed` and speaks it. The
reply groups capabilities by category and appends honest notes when the native
agent or vision provider is not connected. Natural-language actions never route
through this module — they keep flowing through planning/execution.

## 9. Input channels & the single loop

`InputChannel = 'text' | 'voice' | 'visual' | 'gesture'`; `INPUT_CHANNEL_READY`
is `{ text: true, voice: true, visual: false, gesture: false }`. The wake/voice
session (`BrowserVoiceInput.onFinal`, `VoiceManager.submitCommand`) and the goal
composer all reach the SAME `engine.process`. The channel enriches
`capabilityContext().interactionMode`; it is a bounded resolution-context signal,
never a different executor or a bypass.

## 10. Real-time status model

Engine emits: `understanding` (request in), `planning` (reasoning round),
`executing` (tool batch), `observing` (digest), `verifying` (final), plus the
Phase 2.4 confirm gates → `waiting_for_confirmation`, cancel →
`cancelled`, unrecoverable → `failed`, and `speaking` only from real TTS.
`thinking`/`success`/`warning`/`error` stay as compatibility/auxiliary statuses.
`setStatus` is private and typed to the superset; every consumer (StatusChip,
Three PARAMS, status driver, voice manager, AR model) maps the full union.

## 11. Arc Reactor (DOM)

`arcReactorPresentation(status, isSpeaking)` (pure) → bounded `variant` +
`label` + `speaking`. The component renders core orb, three deltoid rings, halo,
label and a 5-bar speech wave **rendered only while genuinely speaking**. Status
variants tint/rotate state (attention / success / error / cancelled); Demo Mode
adds `is-demo` (larger) and the theme sets accent tokens. `ARC_REACTOR_SPEECH_BOUNDS`
keep the pulse (0.82–1.18 scale range) safe; reduced-motion removes animation.
The 3D layer remains behind as the ambience; the reactor is the DOM identity.

## 12. Themes

`src/themes.ts` — `classic | cyber | stealth | holographic | minimal`, each with
label + description (pure data). The store holds `theme` + `demoMode`; the
settings panel renders a swatch picker (per-theme accent preview) and the
Demo-mode switch. Theme blocks in `index.css` override tokens (accent hue/
saturation/lightness, surfaces, hairlines, text) on `.jarvis-app[data-theme]`.

## 13. Demo Mode

Presentation-only: enlarges the Arc Reactor and idle-pulses it via CSS. It
cannot — by construction — bypass permissions, confirmation, ToolRegistry or
capability resolution, because the engine has NO notion of `demoMode`. The store
test verifies toggling it leaves `status`/`capabilities` untouched.

## 14. Responsive / accessibility

- Theme picker + reactor scale with `clamp()`; stage centers the reactor.
- Status chip extended with all new states and cancelled/failed borders.
- Reduced-motion kills reactor/ring/wave animation and keeps geometry readable.
- ArcReactor carries `role="status"` + an `aria-label` computed from the real
  presentation model.

## 15. Refunded / retired local tricks

- No `thinking` mislabel for user-visible reasoning: `planning` is explicit.
- No `@layer` theme wrapper (would break the cascade — see §5).
- No hard-coded capability/action answer keys — the catalog IS the source of
  truth.

## 16. Versioning

`NATIVE_AGENT_VERSION` bumped `2.4.0 → 2.5.0` (`native/src/protocol.ts`); wire
protocol unchanged (no transport/JSON-RPC surface change). `APP.phase/version`
aligned to `0.5.0`.

## 17. Tests & validation gates

New: `interaction/intents.test.ts` (8: normalization, intent detection
positive/negative, honest grouping, unavailable-seam notes, rendering);
`components/core/arcReactorModel.test.ts` (5: full status mapping, speaking only
on real speech, bounded pulse, theme catalogue); `state/jarvis.store.presentation.test.ts`
(3: defaults, presentation-only mutation, engine decoupling). Existing engine/
core suites cover the status transitions and direct capability path.

Updated: `AssistantEngine.test.ts` (planning/understanding assertions, terminal
set includes `failed`), StatusChip PARAMS/voice/visual/Tests structural updates.

Result: `npx tsc -b` clean · `npm run lint` 0 errors · `npm test` 92 files /
1118 tests pass (baseline 89 / 1100) · `npm run build` built · `npm run
native:check` + `native:build` pass.

## 18. Security boundary

Capability discovery is a READ-ONLY, I/O-free, provider-free branch: it builds
text from the already-catalogued capabilities and connection flags, records an
activity + transcript, and never touches registry/tools/permissions/budgets.
Demo Mode and themes never reach the engine. All Phase 2.4 pure-layer,
execution-rail and UI-display-only guarantees are unchanged; the static
`security.test.ts` PROD_FILES set still passes with the new pure modules.

## 19. Limitations

- Visual + gesture channels are reserved and report `ready: false`; nothing
  sends them to the engine yet.
- The interaction hint is guidance only; a model that names an unlisted
  capability still gets the existing resolution rails and refusal framing.
- Speech reactivity is deterministic (bounded pulse), not audio-sampled — no
  microphone-level analysis exists or is claimed.
- Themes take effect immediately (non-persisted); a persisted-preference
  follow-up would write through the existing preferences surface.

## 20. Final status

PHASE 2.5 COMPLETE. Interactive JARVIS now talks about what it can really do,
reports what it genuinely does, and stays honest when it cannot.