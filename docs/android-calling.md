# Real Android Calling (Phase 10)

JARVIS can place, answer, reject and end **real** phone calls on the paired
Android companion, and it reports the **real** call state the phone observed.
Nothing in this path is simulated.

This document describes what was built, the exact honesty contract, and — just
as importantly — what is *not* possible on Android and is therefore reported as
a limitation instead of being faked.

## 1. Why this replaced the old module

An earlier `src/android/AndroidBridge.ts` + `AndroidTools.ts` pair *claimed* to
implement calling. It was dead code (never registered with the engine) that:

- hard-coded six fake contacts,
- invented a device ("Google Pixel 8 Pro") that is **not** one of the four
  trusted JARVIS devices,
- transitioned a call to `ACTIVE` with a `setTimeout`,
- claimed "PC audio bridge is active",
- POSTed to `/api/device/call/*` endpoints that never existed,
- fabricated notifications and a "spam filter".

It has been **deleted**. The replacement is backend-mediated, OS-executed and
verified.

## 2. End-to-end flow

```
USER ("Call Dad")
  → AssistantEngine plan step: capability phone_call_dial → tool call.dial
  → confirmation gate (tool tier `user_confirmation`)         ← nothing queued before this
  → POST /api/device/call { action: 'dial', contact: 'Dad' }
       ├─ device trusted?           no → 400 invalid_target
       ├─ platform === android?     no → 400 not_a_phone
       ├─ device online?            no → DEVICE_OFFLINE   (nothing queued)
       ├─ reports `call`?           no → NOT_SUPPORTED    (nothing queued)
       ├─ reports CALL_PHONE?       no → PERMISSION_REQUIRED (nothing queued)
       └─ enqueue call.dial (payload allow-list: number, contactName)
  → SSE `call` event: CALL_REQUESTED
  → phone /phone/poll drains the command
  → TelephonyController.placeCall(number)  → TelecomManager (Android OS)
  → phone /phone/ack { ok, detail }        ← the authoritative result
  → phone /phone/event { kind: 'call.state', state: 'CALLING' | 'RINGING' | … }
  → SSE `call` event → browser → BackendAndroidProvider.ingestCallEvent
  → tool verify() resolves ONLY from that event → step VERIFIED
```

If the event never arrives, verification fails and the step is **not** reported
as a success — the honest "unverified/failed" rails already exist in the engine.

## 2b. The conversational call (`call.converse` → `call.conclude`)

This is the flow for *"call Dad and ask whether he can come at 5 pm, then hang
up"*. The engine plans it, the user confirms it once, and every step is
verified against a real observation:

```
USER ("call Dad and ask whether he can come at 5 pm today")
  → confirmation gate (tool tier `user_confirmation`)   ← nothing queued before this
  → POST /api/device/call { action: 'dial', contact: 'Dad' }
  → phone dials; phone pushes call.state CONNECTED       ← the tool waits for this
  → POST /api/device/call { action: 'speak', text: "Hi, this is JARVIS, Amrut's
                             personal assistant, calling on Amrut's behalf." }
  → phone acknowledges: "SPOKEN: …"                       ← the tool waits for THIS
  → POST /api/device/call { action: 'speak', text: "Amrut asked me to ask you:
                             whether you can come to the house at 5 pm today" }
  → phone acknowledges again
  → the call is left OPEN, and the exchange is written to memory as an OPEN record

USER ("he said yes, come at 5 pm")
  → POST /api/device/call { action: 'speak', text: "Thanks for your time.
                             I'll pass that on to Amrut. Goodbye." }
  → POST /api/device/call { action: 'hangup' }
  → phone pushes call.state ENDED                        ← the tool waits for this
  → the memory record becomes the CLOSED summary (asked / said / relayed answer)
  → `call.summarize` reads it back
```

The split into two tools is deliberate and is a **platform limit**, not a design
choice. See §5b.

## 3. The closed command vocabulary

`server/src/phoneCommands.ts` is the only way JARVIS can ask a phone to do
anything. It is a **closed allow-list**, and each kind declares the exact
payload fields it accepts; anything else is dropped before it reaches a device:

| kind | payload fields | Android execution |
| --- | --- | --- |
| `ping` | — | round-trip echo |
| `call.dial` | `number`, `contactName` | `TelecomManager.placeCall` / `ACTION_CALL` |
| `call.answer` | — | `TelecomManager.acceptRingingCall` |
| `call.reject` | `reason` | `TelecomManager.endCall` on the ringing call |
| `call.hangup` | — | `TelecomManager.endCall` |
| `call.speak` | `text` | `TextToSpeech` → `MediaPlayer` on the call's audio path |

There is no generic "run this" command, no shell, and no way for the model to
add a kind. `call.speak` carries a spoken sentence, so it has its own longer
field bound (400 characters) while every other kind stays at 120.

## 4. The call-state vocabulary

Reported by the phone from Android's own callback and validated by the backend
before it is published:

`CALL_REQUESTED` · `CALLING` · `RINGING` · `CONNECTED` · `ENDED` · `FAILED` ·
`REJECTED` · `CANCELLED` · `PERMISSION_REQUIRED` · `NOT_SUPPORTED` ·
`DEVICE_OFFLINE`

`/phone/event` accepts exactly one event kind (`call.state`) and rejects any
state outside this set, so a device can never inject an arbitrary shape into
the JARVIS Core bus.

## 5. Android permissions and platform limits

| Action | Permission | API floor | Honest failure when unavailable |
| --- | --- | --- | --- |
| Place a call | `CALL_PHONE` | 23 (`placeCall`) | `PERMISSION_REQUIRED` |
| Answer | `ANSWER_PHONE_CALLS` | 26 | `PERMISSION_REQUIRED` / `NOT_SUPPORTED` |
| End | `ANSWER_PHONE_CALLS` | 28 | `PERMISSION_REQUIRED` / `NOT_SUPPORTED` |
| Reject | `ANSWER_PHONE_CALLS` | 28 | `PERMISSION_REQUIRED` / `NOT_SUPPORTED` |
| Observe call state | `READ_PHONE_STATE` | 26 | observation reported unavailable |
| Resolve a contact name | `READ_CONTACTS` | — | `PERMISSION_REQUIRED` |

Verified against the API 34 SDK:

- **There is no public `TelecomManager.rejectCall()`.** A non-default-dialer app
  has only `acceptRingingCall()` / `endCall()` / `silenceRinger()`. Ending the
  ringing call *is* the reject path, and it is reported as `REJECTED`.
- `endCall()` is marked deprecated in API 34 in favour of the self-managed-call
  APIs, which only apply to apps that own the call; it remains the platform
  surface for a carrier call.
- Android 10+ restricts answering/rejecting for non-default-dialer apps in the
  background. When the OS refuses, the `SecurityException` is mapped to
  `PERMISSION_REQUIRED` and reported — never worked around.
- **Incoming caller number is NOT available** to a non-default-dialer app
  without the sensitive `READ_CALL_LOG` permission, which this build does not
  request. Incoming calls are therefore reported as **state only** (the HUD
  shows the ringing state, and `contactName`/`number` appear only when they are
  genuinely known — e.g. for a call this app placed).

## 5b. What JARVIS can and cannot do ON a call

| Capability | Status | Why |
| --- | --- | --- |
| JARVIS **talks** on the call | **SUPPORTED** | The phone's own `TextToSpeech` synthesizes the text and a `MediaPlayer` plays it with `USAGE_VOICE_COMMUNICATION`, which puts it on the call's audio path. Verified by the phone's own acknowledgement (`SPOKEN: …`). |
| The other party **hears** it | **ONLY ON SPEAKERPHONE** | During a call Android routes call audio to the communication device (earpiece / wired headset / Bluetooth). The phone checks whether the built-in speaker is the active communication device and says so in the acknowledgement, so the PC is never told "they heard it" when that is untrue. |
| JARVIS **hears** the other party | **NOT POSSIBLE ON ANDROID** | Since Android 10 a normal app cannot capture a live call's far-end audio: the `VOICE_CALL` / `VOICE_DOWNLINK` `AudioSource`s are refused unless the app holds `CAPTURE_AUDIO_OUTPUT`, a `signature|privileged` permission that is never granted to a third-party app. `MediaProjection` + `AudioPlaybackCapture` captures *playback*, not the call. Becoming the default dialer does not grant call-audio capture either. |
| Therefore the **reply** | **RELAYED BY THE HUMAN** | The human answers the phone, and either speaks the answer to the PC (the voice session picks it up) or types it. JARVIS records it and folds it into the call summary. This is the closest legitimate arrangement on a normal phone, and it is reported honestly rather than simulated. |

There is no path — short of a privileged/OEM-signed app or a second device with
a microphone near the speaker — that lets this companion app hear the other
party, so no such path is claimed here.

## 6. Where the code lives

| Concern | Module |
| --- | --- |
| Command queue + payload allow-list (server) | `server/src/phoneCommands.ts` |
| Call endpoints + capability/permission/offline gates | `server/src/http.ts` (`/api/device/call`, `/api/device/call/result`) |
| Device event intake + bus fan-out | `server/src/phoneServer.ts` (`/phone/event`) |
| Real telephony actions (Android) | `android/.../telephony/TelephonyController.kt` |
| Speaking on a live call (Android) | `android/.../telephony/CallSpeaker.kt` |
| Real call-state observation (Android) | `android/.../telephony/CallStateObserver.kt` |
| Real contacts lookup (Android) | `android/.../telephony/ContactsResolver.kt` |
| Capability/permission truth (Android) | `android/.../telephony/TelephonyCapability.kt` |
| Command execution + event push (Android) | `android/.../service/JarvisSyncService.kt` |
| Backend-backed provider (PC) | `src/android/BackendAndroidProvider.ts` |
| Telephony tools + verifier (PC) | `src/android/AndroidCallTools.ts` |
| Conversational call (open / close / summarize) | `src/android/AndroidCallConversationTools.ts` |
| Engine seam + capability cluster | `src/engine/AssistantEngine.ts` (`attachAndroid`) |

## 7. Confirmation

Placing a call is `user_confirmation` at the **tool** tier, which is the single
confirmation gate — it applies whether the model names the capability
(`phone_call_dial`) or the tool (`call.dial`) directly. The capability's
`maximumPermission` is `device_control` so the high-tier implementation is
allowed to represent it at all. The prompt shows what will happen, which tool,
the arguments (contact/number) and why (the user's own words) — the engine's
existing `decidePermission` copy.

Cancelling the confirmation queues **nothing**: the plan step is `blocked`, no
command reaches the phone, and no reliability credit is recorded.

## 8. Tests

| Suite | What it pins |
| --- | --- |
| `server/src/phoneCommands.test.ts` | the closed vocabulary, per-kind payload allow-list, field bounds, delivery only when online, per-device pending cap, single-ack semantics, TTL |
| `server/src/phoneServer.test.ts` | `/phone/event` needs the credential, real state published verbatim on the bus, queued `call.dial` payload intact |
| `server/src/phone.integration.test.ts` | full flow (queue → poll → event → ack → verified result) plus every refusal: offline, no capability, missing permission, bad action/target/number, untrusted/non-phone device, unknown call id, invalid event kind/state |
| `src/android/AndroidCallTools.test.ts` | tool-level honesty (each refusal state + engine recovery code), verification only from a real event, missing event ⇒ failure |
| `src/android/AndroidCall.engine.test.ts` | engine integration: no provider ⇒ no tools/capabilities; bound provider ⇒ tools + `phone_call_*`; confirmation then verify; detach removes everything; `callingEnabled` snapshot; **the conversational call: plan → confirm → dial → introduce → ask → leave open, and close → hang up → record** |
| `src/android/AndroidCallConversation.test.ts` | the conversational tools in isolation: the exact spoken lines, every refusal (no brief, no target, offline, no `CALL_PHONE`, phone cannot speak, never connects, phone refuses to speak), the open/closed memory record, and the summary |
| `src/android/BackendAndroidProvider.test.ts` | the live-call view derived only from real observations (ENDED wins over an older CONNECTED; a synthetic CALL_REQUESTED does not hide a live call) |
| `android/app/src/test/.../TelephonyCapabilityTest.kt` | dialable-number normalization |
| `android/app/src/test/.../CallProtocolTest.kt` | the exact wire shapes the backend sends/accepts |

## 9. What is NOT claimed

- Answering/rejecting is **not** guaranteed: it depends on the device's Android
  version, the granted permission, and whether the OS allows a non-default
  dialer to control the call. Where it is refused, the phone says so.
- Incoming caller ID is **not** provided (no `READ_CALL_LOG`).
- JARVIS **cannot hear** the other party on the call — Android does not allow a
  normal app to capture live call audio (§5b). It talks; the human relays the
  reply. The other party hears JARVIS only when the call is on speakerphone, and
  the phone's acknowledgement says which of the two happened.
- No call audio is bridged to the PC, no voicemail, no SMS auto-reply, and no
  call recording — those were faked before and are simply absent now.
  `phone_call_summarize` is now **backed by a real tool** (`call.summarize`,
  which reads the call records JARVIS itself saved); `phone_contacts_search`,
  `phone_sms_send` and `phone_notifications_read` remain declared in the
  capability catalogue with no implementation, so they never reach the model.
- There is no physical-device certification in this repository: the Android
  unit tests and the full server/engine suites pass, but placing an actual call
  requires the built app on a real phone with the permissions granted.
