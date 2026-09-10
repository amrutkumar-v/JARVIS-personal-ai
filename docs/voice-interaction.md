# Voice Interaction + "Wake up, JARVIS" — Phase 1.6

JARVIS learns a **voice input interface**: a browser-side wake word, a
deterministic multi-turn wake/command session, and speech-to-text that feeds
into the **exact same `AssistantEngine`** every typed command already uses.

This phase is explicitly **INPUT ONLY**: voice is a *transducer* in front of the
Agent Core — it never plans, never decides, never touches a tool or provider
directly. The engine already knows how to plan, verify and act; the voice layer
just gives it spoken turn-taking (and can hand a spoken command to desktop
control, observation, etc., purely through existing engine entry points).

Related: [Agent Architecture (Phase 1.0)](./agent-architecture.md),
[Native Windows Agent (Phase 1.2)](./native-windows-agent.md),
[Native Windows Observation (Phase 1.4)](./native-windows-observation.md),
[Native Windows Desktop Interaction (Phase 1.5)](./native-windows-desktop-interaction.md),
[Visual Understanding (Phase 1.7)](./visual-understanding.md).

## 1. What it does

| Piece | Module | Responsibility |
| --- | --- | --- |
| Wake phrase | `src/voice/normalization.ts` | **Deterministic** matching of "wake up jarvis" — no LLM, ever |
| Session machine | `src/voice/types.ts` | `SLEEPING → LISTENING_FOR_WAKE → AWAKE → LISTENING_FOR_COMMAND → PROCESSING → SPEAKING → …` cycles |
| Wake word | `src/voice/wakeWordProvider.ts` | Platform Web Speech API recognizer surface (capability-gated) |
| Speech-to-text | `src/voice/speechProvider.ts` | Platform recognizer surface for spoken commands |
| Text-to-speech | `src/voice/ttsProvider.ts` | Platform synthesis surface for phrases + the shared final answer seam |
| Orchestration | `src/voice/voiceManager.ts` | Turn-taking, timeouts, barge-in, engine status feed |
| Testing fakes | `src/voice/testing.ts` | `FakeWakeWordProvider` / `FakeSpeechToTextProvider` / `FakeTextToSpeechProvider` (each `testsOnly = true`) |

A voice session never reaches the engine directly — the `VoiceManager` is
constructed with **injected callbacks only** (`submitCommand(text)`,
`cancelCurrent()`). The security test statically scans the production voice
files for shell words, raw-audio capture, dependency on `localStorage`/
`indexedDB`, LLM calls, and any `../engine` import.

## 2. Wake: deterministic, direct form, and the session cycle

- The canonical wake phrase after normalization is `'wake up jarvis'`.
  Normalization lowercases, strips punctuation, collapses whitespace, and
  resolves "jarvis"/"compare" spelling variants deterministically. Bare
  "Jarvis", "wake up", or "hello jarvis" do **not** match.
- If the transcription is exactly the wake phrase, the manager speaks an ack
  ("I'm awake. What can I do for you?") and enters command listening.
- **Direct form** — "Wake up, JARVIS, open Chrome." — is split deterministically
  (the same normalization used everywhere): the trailing text is submitted as
  the first command, **skipping the ack**.
- The session cycle: `AWAKE → LISTENING_FOR_COMMAND → PROCESSING →
  SPEAKING → LISTENING_FOR_COMMAND`. A spoken command during `SPEAKING`
  **interrupts the shared TTS and starts the new command** (barge-in).
- Two control phrases are consumed by the session *before* any engine call:
  `SLEEP` (`go to sleep` / `sleep` / `stop listening`) returns to `SLEEPING`,
  and `CANCEL` (`stop` / `cancel`) either cancels the in-flight engine run or
  ends an idle session.

## 3. Timeouts and single-slot queuing

- **Command timeout (8 s)**: silence while listening speaks
  "I didn't hear a command." and sleeps (per config, re-arming wake listening).
  A new command before the timeout cancels the stale timer.
- **Session ceiling (30 s)**: the entire awake multi-turn session is bounded by
  a **one-shot timer armed at wake** and *never* reset by activity. A chatty
  user still loses the mic 30 s after waking even if every command timeout keeps
  getting re-armed; the session simply closes silently at the wall clock. It is
  cleared on sleep, cancel, dispose, and input errors.
- **Single queued slot with newest-wins**: while the engine is `PROCESSING`
  (or `SPEAKING`), only one queued command is kept and each new utterance
  supersedes the previous one. When the engine goes idle, the queued command
  (if any) starts immediately.

## 4. One shared TTS, typed and spoken-entry identical

- There is exactly **one** speech output: the `VoiceManager` owns a
  `BrowserTextToSpeechProvider`, and the **same instance** is attached to the
  engine through `VoiceOutput` (`src/voice/VoiceOutput.ts`). Engine lifecycle
  phrases and the final assistant response can therefore never overlap.
- A spoken command reaches the engine through `engine.process(text)` — the same
  entry point and the same user-turn format a typed message would produce. The
  engine test asserts voice and typed input are indistinguishable in the
  provider's messages, while "spoken status" (`engine.lastSpokenText`) is fed
  back into the manager to drive `PROCESSING → SPEAKING → LISTENING_FOR_COMMAND`.

## 5. UI and capability honesty

- New capability rows: **Wake word** (`wakeWordAvailable`, true only where a
  recognition surface exists) and **Voice interaction**
  (`voiceInteractionAvailable`), reported by `AssistantEngine.start()`.
- Wake word starts **disabled** by default (preference `wakeWordEnabled`);
  the dock `WAKE` chip arms the mic only from a user gesture and only when the
  browser supports it. `startListening()` disarms any armed wake session first,
  so the hold-to-speak and wake-word paths never run recognizers at the same
  time.
- Arming is denied honestly when the wake provider or mic permission is
  unavailable — one notice, no auto-retry, back to sleeping.

## 6. Testing

- `src/voice/normalization.test.ts` — canonicalization, variants, direct-form
  split, wake-vs-command classification. (10 tests.)
- `src/voice/voiceStateMachine.test.ts` — full legal-transition table plus
  invalid/illegal transitions. (8 tests.)
- `src/voice/voiceManager.test.ts` — arming/wake, direct form, single-slot
  newest-wins queue, sleep/cancel control phrases, command timeout, the 30 s
  session ceiling under continuous chatter, barge-in during speech, engine
  status feed, permission-denied handling, dispose. (24 tests.)
- `src/voice/agentCore.voice.engine.test.ts` — voice == typed entry, capability
  flags reported honestly per environment, the shared TTS seam, and a
  voice-driven closed-loop desktop run (`window.list → window.focus →
  desktop.move → desktop.click`) with verified / honestly-unconfirmed steps.
  (6 tests.)
- `src/voice/security.test.ts` — static boundary scan: no shell words, no raw
  audio capture or persistence, no LLM in wake detection, no `../engine`
  imports, fakes quarantined with exactly 3 `testsOnly` markers. (6 tests.)
- Repeated-action and per-run budgets are the engine's existing Phase 1.5
  rails; voice adds no new action surface. The `MAX_TOOL_ROUNDS` (5) and
  `MAX_AGENT_STEPS` (8) limits therefore bound spoken runs exactly like typed
  runs.

## 7. Explicitly not implemented (Phase 1.6 scope)

- **No hotword engine**: the "wake word" is the platform's own speech
  recognition with a deterministic exact-phrase matcher; there is no offline
  wake-word model, no audio capture, no persistence of microphone data anywhere.
- **No voice-only planning or tools**: the voice layer never calls an LLM, never
  imports engine internals, and never executes or requests tool work itself.
- **No continuous conversation memory**: a session remembers nothing beyond its
  single-command queue; each command is an independent engine run.
- **No language understanding**: transcription is as-is; classification is
  phrase matching only. Misrecognition is a platform concern surfaced honestly
  (`ERROR` → recoverable to `SLEEPING`/`LISTENING_FOR_WAKE`), never silently
  patched.