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

There is no generic "run this" command, no shell, and no way for the model to
add a kind.

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

## 6. Where the code lives

| Concern | Module |
| --- | --- |
| Command queue + payload allow-list (server) | `server/src/phoneCommands.ts` |
| Call endpoints + capability/permission/offline gates | `server/src/http.ts` (`/api/device/call`, `/api/device/call/result`) |
| Device event intake + bus fan-out | `server/src/phoneServer.ts` (`/phone/event`) |
| Real telephony actions (Android) | `android/.../telephony/TelephonyController.kt` |
| Real call-state observation (Android) | `android/.../telephony/CallStateObserver.kt` |
| Real contacts lookup (Android) | `android/.../telephony/ContactsResolver.kt` |
| Capability/permission truth (Android) | `android/.../telephony/TelephonyCapability.kt` |
| Command execution + event push (Android) | `android/.../service/JarvisSyncService.kt` |
| Backend-backed provider (PC) | `src/android/BackendAndroidProvider.ts` |
| Telephony tools + verifier (PC) | `src/android/AndroidCallTools.ts` |
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
| `src/android/AndroidCall.engine.test.ts` | engine integration: no provider ⇒ no tools/capabilities; bound provider ⇒ tools + `phone_call_*`; confirmation then verify; detach removes everything; `callingEnabled` snapshot |
| `android/app/src/test/.../TelephonyCapabilityTest.kt` | dialable-number normalization |
| `android/app/src/test/.../CallProtocolTest.kt` | the exact wire shapes the backend sends/accepts |

## 9. What is NOT claimed

- Answering/rejecting is **not** guaranteed: it depends on the device's Android
  version, the granted permission, and whether the OS allows a non-default
  dialer to control the call. Where it is refused, the phone says so.
- Incoming caller ID is **not** provided (no `READ_CALL_LOG`).
- No call audio is bridged to the PC, no voicemail, no SMS auto-reply, no
  call recording, no call summarization — those were faked before and are
  simply absent now. `phone_call_summarize`, `phone_contacts_search`,
  `phone_sms_send` and `phone_notifications_read` remain declared in the
  capability catalogue with no implementation, so they never reach the model.
- There is no physical-device certification in this repository: the Android
  unit tests and the full server/engine suites pass, but placing an actual call
  requires the built app on a real phone with the permissions granted.
