# External JARVIS Audit — Integration Map

An evidence-based audit of the external JARVIS reference project
(`https://github.com/adewaskar/jarvis.git`, MIT) against the current JARVIS
codebase (`D:\JARVIS`). The **current codebase is the source of truth**; the
external project is read only for concepts worth transferring. Every claim in
this document is backed by a test that runs with `npm test` or a live
verification performed against the running native agent. See
[Final Implementation Report](./final-implementation-report.md) for the
full honest state of the world.

## 1. Goal

| | Externally | Here |
| --- | --- | --- |
| Execution bridge | `bridge/server.mjs` + `net.mjs` | Native agent `native/` (v2.9.1, protocol `jarvis-native-1`) |
| Observation | system/window observation via bridge | `native/` observation + `src/engine/AssistantEngine` observability |
| UI panels | `ui.mjs`, `panels.mjs`, canvas layering | `src/panel/panelStore` + React panel layer + `CapabilityPanel` |
| Voice | `voice.ts` + `vad.ts` (MicVAD) | `src/voice/*` (Web Speech API, no raw audio) |
| Browser | `chrome.mjs` + "Claude for Chrome" extension | Native agent `web.*` tools (`web.fetch`, browsing) |
| AI provider | `config.ts` provider list (OpenAI + Claude via bridge) | `src/ai/*` provider abstraction (OpenAI-compatible, optional providers) |
| MCP | bridge imported MCP servers | **Designed (not built)** — controlled capability source, below |
| Android | Android companion app (separate repo) | `src/config/android/AndroidProvider` seam + backend device registry (states only) |

## 2. Concept disposition

Legend: **TAKEN** = concept ported into this codebase; **EXISTS** = already
implemented here and not copied; **REJECTED** = evaluated and deliberately not
adopted, with the reason; **DESIGNED** = written up / architected, not shipped
as active code.

### TAKEN

| Concept | Where it landed | Evidence |
| --- | --- | --- |
| TTS un-wedge / keepalive | `src/voice/VoiceOutput.ts` — `resume()` before every `speak()`, plus watchdog `rescue()` (cancel + resume) that fires `onRescued` when Chromium synthesis wedges; surfaced on `TextToSpeechProvider` | `src/voice/ttsProvider.test.ts`, `src/voice/diagnostics.test.ts` |
| Runtime voice health probe | `src/voice/diagnostics.ts` — `VoiceDiagnostics` counters (wake/session/command/speech/engine) + `assessVoiceHealth()`; wired through `voiceManager.ts`, `src/voice/index.ts`, and `src/hooks/useAssistant.ts` | voice suite (71 tests, below) |
| Production CSP | `vite.config.ts` `securityCspPlugin()` — strict CSP meta injected **build-only** (Vite dev injects inline react-refresh/HMR, so dev keeps its own relaxed profile) | build + manual dev run |
| `ui_theme` capability | `src/engine/interaction/uiControl.ts` — `ThemeControlKind` (`set_theme` / `next_theme`), deterministic aliases+synonyms, `detectThemeIntent()`, `themeChoices()`; executed by `AssistantEngine.executeUiControlCommand` against the **real** `useJarvisStore.setTheme`, `currentThemeId()`, `applyTheme()` | `uiControl.test.ts` (29), `AssistantEngine.uiControl.test.ts` (21) |

### EXISTS (verified here, not copied)

| Concept | Here |
| --- | --- |
| Windows execution & app launch | Native agent `app.list` (63 approved apps), `app.launch` / `app.status` / `app.quit`; verified **live** against a real running agent (below) |
| System / process / window observation | Native agent observation surfaces |
| Camera, screen capture, vision | Native agent `camera.*`, `screen.*`, `vision.*` capabilities |
| Voice wake + session machine + barge-in | `src/voice/*` (deterministic wake normalization, session state machine, single-slot queue) |
| Capability registry, honest availability | `AssistantEngine` snapshots capabilities to the store (`setCapabilities`), `CapabilityPanel`, optional-provider tool registration (`createAppTools(provider)` absent ⇒ no tools) |
| LLM output validation & confirmation | `src/engine/reasoning/*` (validated claim/admission grammar), confirmation/exec path |

### REJECTED (with rationale)

| Concept | Why rejected here |
| --- | --- |
| MicVAD / raw-audio capture (`vad.ts`, MediaRecorder) | Directly conflicts with this repo's privacy posture enforced by `src/voice/security.test.ts` (forbids `MediaRecorder`/`AudioContext`/`getDisplayMedia`). Voice already has barge-in + a 30 s watchdog. |
| TTS cloud streaming / explicit voice fallback chain | Only browser `speechSynthesis` exists; cloud TTS would need credentials + a network provider. Honest fallback: single synthesizer, real status surfaced, nothing claimed as multi-engine. |
| speechSynthesis keepalive loop | A periodic pause/resume loop risks wedging the very stream it protects. Watchdog rescue achieves recovery without the loop. |
| "Claude for Chrome" extension bridge | This repo has its own native Windows agent as the browser/desktop actor; a second browser channel would duplicate capability surfaces. |
| Claude Agent SDK as an additional AI provider | Would fit the existing provider seam, but requires a local `claude` CLI login and is not needed by current flows. Left documented, not wired. |
| Copying the external UI/panel visuals | External panels (`panels.mjs`, canvas sprite layering) are presentation; this repo already has a real panel layer + environment/theme system. No visual code copied. |

### DESIGNED (architected and documented, **not** shipped as active features)

| Concept | Design notes |
| --- | --- |
| MCP as a controlled capability source | External bridge surfaced MCP tools into the model directly. Here the requirement is a **controlled capability source**: `McpCapabilitySource` behind the same fog that every tool goes through — strict capability registration/validation, permissions, confirmation, budgets, SSRF/URL gates, verification, default-deny. **No unrestricted backdoor.** Not wired to any server; no MCP servers configured on this machine. |
| Android companion | `src/config/android/AndroidProvider` seam + backend device registry (`/api/device/list`) with honest per-device states (`live`, `lan-bridge`, `stale`). Android device agent = **controlled execution node**, never a second brain; no unauthenticated control. Companion app itself is out of scope of this repo. |
| Calling states | Call state machine (idle/ringing/connecting/active) documented as data model only. Voice channels here are browser Web Speech; no telephony provider is implemented, so no call path is claimed. **Update:** real Android calling has since shipped through the paired companion phone — see [`android-calling.md`](./android-calling.md). |

## 3. Live verification (REAL-DEVICE evidence)

Performed against the running local stack (backend `127.0.0.1:8787`, native
agent `127.0.0.1:8765`; dev agent runs tokenless):

- `system.identity` → protocol `jarvis-native-1`, version `2.9.1`, `tokenRequired: false`.
- `app.list` → 63 approved applications.
- Notepad cycle: `app.launch` verified (pid `24256`) → `app.status` `running=true` → `app.quit` terminated and re-verified `running=false`.

Devices registered in the backend registry (as of the audit):

| Device | Status | Capabilities |
| --- | --- | --- |
| `victus-5050` | online (primary) | filesystem, applications, screen, mouse, keyboard, camera, vision, automation |
| `dell-laptop` | offline | lan-bridge |
| `s26-ultra` | offline (stale, battery 82) | — |
| `s23-fe` | offline | inbound |

## 4. Test evidence for the taken work

```
npx vitest run src/voice                                        # 71 passed
npx vitest run src/engine/interaction/uiControl.test.ts         # 29 passed
npx vitest run src/engine/AssistantEngine.uiControl.test.ts     # 21 passed
npx vitest run src/engine/reasoning src/engine/AssistantEngine.bridge.test.ts src/engine/AssistantEngine.orchestratorRuntime.test.ts
npx tsc --noEmit -p tsconfig.json                               # clean
npx oxlint src/voice src/engine/interaction …                   # 0 warnings / 0 errors
```