# JARVIS Phase 2.7 — Real Webcam, Camera Surfacing & Unified Interrupt

## 1. Objective

Make the browser webcam a REAL capability, surface every runtime connection
state honestly, and unify the interrupt path so a single STOP button can stop
speech or an in-flight task with a distinct CANCELLING → CANCELLED lifecycle —
all while preserving every Phase 0–2.6 security and honesty rail and passing
all six gates at version 2.7.0. No capability counts unless it is genuinely
invocable from the real UI with the real operation: nothing is faked.

## 2. Scope

- Real webcam module `src/camera/` (types + `WebCameraController` +
  `describeCameraFrame`), driven by the engine via deterministic DIRECT intents
  (`camera_on` / `camera_off` / `camera_see`) — not new LLM tools, so no new
  tool security surface. Camera commands are answered only from real
  stream/permission/vision state.
- Engine interrupt unification: real `stopSpeaking()`, a single
  `cancelCurrentTask()` covering running + pending-confirmation + idle-but-
  speaking states, the `cancelling` status, and `Cancelled after N completed
  step(s).` replies backed by the real executed-step counter.
- UI: `CameraPanel` (live preview + honest states), `ConnectivityStrip`
  (runtime AI / PC CONTROL / FILES / CAMERA / VISION), a single dock STOP
  button (STOP SPEAKING vs STOP TASK), runtime-honest `SettingsPanel` rows,
  and Arc-Reactor/StatusChip mapping for `cancelling`.
- Honest mock copy refresh: the local-dev catch-all no longer claims a
  "connected capability" it does not have.
- New tests (unit + real engine integration), camera PROD_FILES whitelist
  entries, all six gates, version bump `2.6.0 -> 2.7.0` /
  `0.6.0 -> 0.7.0`, architecture doc §21, this report.

## 3. Not in scope

- No changes to the native agent: PC control (filesystem, apps, windows,
  screenshots, input, focus) was already REAL in Phase 2.5/2.6 and is reported
  as such; it is surfaced, not re-implemented.
- No new AI model, no new vision analysis implementation (RemoteVisionProvider
  stays the real seam; camera frames feed it).
- No microphone capture: `getUserMedia` is always `{ video: true,
  audio: false }`.
- No gesture recognition (still a reserved seam).

## 4. Camera surface contract (real, browser-runtime)

- `src/camera/types.ts` — private `CameraController` seam and honest states:
  `CameraPermissionState` (`unknown / granted / denied / in-use /
  incompatible / unavailable`), `CameraCapabilities`, `CameraStartResult`
  (always real `ok`/permission/reason). Pure; joins the `security.test.ts`
  PROD_FILES boundary scan.
- `src/camera/webcam.ts` — `WebCameraController`: real
  `navigator.mediaDevices.getUserMedia`, real `srcObject` binding to the
  preview element, real stream `ended` handling (in-use), real transient PNG
  snapshot via canvas. `classifyCameraError` maps real browser failure names
  onto honest states. Cameras are never started secretly — the browser
  permission prompt is the gate.
- `src/camera/describe.ts` — `describeCameraFrame` reports ONLY elements
  returned by a real vision model (bounded 6); it can never invent.
- `authored` frames are transient and never stored/logged.

## 5. Engine integration

- Direct intents (`camera_on`, `camera_off`, `camera_see`) run in the
  deterministic meta-request branch of `process()`, BEFORE the action layer
  and provider. `handleCameraIntent(kind)` drives the bound controller and
  returns honest replies for every real outcome (no surface, denied, in-use,
  incompatible, already on/off, no-vision, frame failure, analysis failure).
- `attachCamera(controller)` binds the seam; `start()` publishes the real
  `cameraAvailable`; `cameraProvider` keeps the read-only public view.
- The UI's `WebCameraController` lives in `useAssistant`'s effect lifecycle
  (disposed on unmount) and is wired to `setCamera`, the preview node and the
  engine.

## 6. Unified interrupt

- **STOP SPEAKING**: `stopSpeaking()` calls `voiceOutput.stop()`, clears
  `isSpeaking` and returns to idle; it never relabels a run.
- **STOP TASK**: one `cancelCurrentTask()` handles a running task, a pending
  confirmation, and an idle-but-speaking run. It sets `cancelling`, aborts the
  run `AbortController` (blocking tools observe real cancellation), resolves
  any pending confirmation, marks the plan CANCELLED, emits
  `Cancelled after N completed step(s).` from the REAL `executedActions`
  counter, and flips the run terminal to `cancelled`. The loop-top returns the
  same counted message via `handleCancelOrLimit('cancelled')`; cancelled runs
  are never re-labelled success.
- **CANCELLING status**: added to `JarvisStatus`; Arc Reactor maps it to the
  cancelled palette with `CANCELLING` label, StatusChip shows CANCELLING, and
  the UI STOP button stays enabled through it.

## 7. UI wiring

- `CameraPanel` — real preview, verbatim permission/error states, real toggle
  and capture buttons; only visible when the camera seam exists.
- `ConnectivityStrip` — LIVE runtime chips (AI provider, PC CONTROL, FILES,
  CAMERA, VISION) built from registered/available state.
- Unified dock STOP button with `stopLabel` = STOP SPEAKING while speaking,
  else STOP TASK; `canInterrupt` covers every busy status + `cancelling`.
- `SettingsPanel` — "Computer control" reports the real native-agent runtime;
  new "Webcam" row from `cameraAvailable`.
- Mock provider catch-all copy is honest about local-dev tooling; it never
  claims a connected capability for what is absent.

## 8. Tests

- `src/camera/webcam.test.ts` (9) — real error-to-state mapping, honest
  unavailable surface, real stream/start notifications, denied/in-use, real
  transient PNG capture, null when off, track release + preview clear, and
  unsubscription.
- `src/camera/describe.test.ts` (3) — never invents elements, describes only
  returned elements, bounded listing.
- `src/engine/AssistantEngine.cameraAndInterrupt.test.ts` (11) — camera
  commands end-to-end through the engine (incl. honest no-surface/denied no-
  vision and the real frame -> vision -> reply path), STOP SPEAKING against an
  in-flight utterance, and a real mid-run cancel using a scripted provider + a
  gated tool that only completes when the run's AbortController fires; asserts
  CANCELLING → CANCELLED, `Cancelled after 1 completed step`, and that a fresh
  command is fully runnable afterwards.
- `security.test.ts` camera PROD_FILES additions keep `camera/types.ts` in the
  pure boundary scan.

## 9. Validation gates (all green at 2.7.0)

1. `npm test` — 98 files / **1198 tests pass** (26 new Phase 2.7 tests).
2. `npx tsc -b` — clean.
3. `npm run lint` — 0 warnings / 0 errors (305 files, 116 rules).
4. `npm run build` — builds clean.
5. `npm run native:check` — clean.
6. `npm run native:build` — clean.

## 10. Versioning

`NATIVE_AGENT_VERSION` `2.6.0 -> 2.7.0`; `APP.version` `0.6.0 -> 0.7.0`
(`APP.phase` `0.6 -> 0.7`); `NATIVE_PROTOCOL` unchanged (`jarvis-native-1`).

## 11. Limitations

- A webcam needs a secure-context browser tab and an actual camera; the app
  reports `unavailable` honestly otherwise.
- Camera vision replies are bounded to the six most confident elements the
  connected vision model returns — never more.
- RemoteVisionProvider requires `VITE_JARVIS_VISION_BASE_URL` + a model + an
  API key to see anything; without it, camera commands answer honestly.

## 12. Final status

PHASE 2.7 COMPLETE.