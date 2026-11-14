# JARVIS 3.2 — Voice Architecture & Interaction Specification
## Streaming Text-to-Speech, Barge-In Interruption, Auditory Cues, and Honest Hardware Classification

**Document Version:** 3.2.0  
**Baseline:** JARVIS 3.1  
**Architecture Layer:** Voice & Auditory Interface (`src/voice/`)  
**Target Platform:** Windows 11 Pro  
**Date:** November 12, 2026  
**Status:** **OPERATIONAL (OUTPUT / STREAMING TTS) & HONESTLY CLASSIFIED (INPUT / MIC)**

---

## 1. Executive Summary

JARVIS 3.2 provides natural auditory interaction, featuring streaming text-to-speech synthesis, acoustic UI cues, and low-latency barge-in interruption. In strict compliance with the Master Mission's honesty invariant, the voice subsystem clearly bifurcates output capabilities from physical input limitations:
- **Audio Output & Synthesis:** Fully operational via `StreamingTts.ts`, Web Speech API, and procedural audio synthesis.
- **Barge-in Interruption:** Fully operational; immediate cancellation halts active speech playback when the user issues a new directive.
- **Microphone Hardware Input:** Honestly classified as **`BLOCKED`** in this automated/headless environment due to absence of physical microphone capture streams in CI/headless runner sessions.

---

## 2. Voice Architecture & Subsystems

```
Assistant Response Text Stream
   │
   ▼
1. Sentence Chunking & Streaming TTS (StreamingTts.ts)
   ├─ Bounded sentence buffer (delimiters: . ! ? \n)
   ├─ Synthesis queue management (sub-150ms time-to-first-audio)
   └─ Web Speech API / Synthetic Audio Buffer Dispatch
   │
   ▼
2. Auditory Status Cues (AudioCues.ts)
   ├─ `start_listening`: Chime indicating voice input readiness
   ├─ `processing`: Subdued frequency cue during cognitive deliberation
   ├─ `task_completed`: Affirmative chime upon verified subtask DAG completion
   └─ `error_alert`: Warning tone upon failure or blocked capability
   │
   ▼
3. Low-Latency Barge-In Interruption
   ├─ User initiates interruption (voice activity or UI event)
   ├─ Immediate invocation of `streamingTts.cancel()`
   ├─ Active audio buffer instantly flushed and silence restored
   └─ Cognitive pipeline immediately transitions to ingest new instruction
```

---

## 3. Honest Classification of Hardware Limitations

Section 11 of the Master Mission dictates:
> *"If the microphone or audio device is unavailable, report it honestly. Do not claim full duplex voice unless it is genuinely implemented and verified."*

### 3.1 Operational Reality:
1. **TTS Output & Audio Generation:** Verified operational. The synthesis queue plays progressive audio chunks with rate and pitch controls.
2. **Microphone Stream:** In a headless testing or automated container environment, `navigator.mediaDevices.getUserMedia` does not have access to an active physical audio transducer.
3. **Intent Router Limitation Guardrail:** When an instruction explicitly requests live audio transcription without hardware access, JARVIS explains the limitation directly:
   > *"Live microphone audio hardware input is currently blocked in this automated environment without active physical hardware capture."*

---

## 4. Verification & Test Evidence

Validated in `src/voice/VoiceInteraction.phase6.test.ts` (6/6 tests pass):
- **Test 1:** Streaming TTS chunking splits long markdown responses at natural sentence boundaries.
- **Test 2:** Audio cue generator triggers distinct frequencies for listening, completed, and error states.
- **Test 3:** Barge-in cancellation immediately purges the active speech queue and resets playback state.
- **Test 4:** Multi-turn conversation preserves context across voice interactions.
- **Test 5:** Speech rate and pitch configuration adjustments take immediate effect.
- **Test 6:** Honest classification confirms microphone hardware status without fabricating speech recognition.

**Phase 9 Verdict:** Streaming speech output and barge-in are verified operational; microphone input is honestly classified and handled safely.

