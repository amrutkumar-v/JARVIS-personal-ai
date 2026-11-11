# JARVIS Phase 2.8 — Persistent Backend, Phone Bridge & the Trusted Four-Device Ecosystem

## 1. Objective

Make JARVIS a system that is always available: a persistent, single-instance
backend process that survives the browser being closed, supervises the native
Windows agent with a bounded restart/backoff loop, and coordinates a **personal
four-device ecosystem** of two PCs and two phones over the LAN. The assistant
engine stays browser-hosted (audio, wake, camera and TTS are browser APIs); the
backend is the always-on coordinator. No capability counts unless the real
backend is live and confirmed, and nothing is ever claimed for a device that has
not actually reported in.

## 2. Scope

- `server/` — zero-runtime-dependency Node backend (`node:http` + SSE + JSON
  POST): single-instance pid lock, structured logging, backend-supervised
  native agent, a **trusted device registry** with claim/heartbeat TTL and
  persistence, targeted notification/file/inbound endpoints, `/health`,
  `/events` SSE hub, `/phone` companion page, and serving of the built SPA.
- `src/backend/` — browser client: config, bounded reconnect controller, and a
  single `BackendClient` SSE stream + typed POST helpers.
- `src/device/` — the device bridge seam + real backend provider + four real
  tools (`device.list`, `device.status`, `device.notify`, `device.sendFile`),
  natural-language identity resolution and an honest target router, registered
  ONLY while a backend-connected provider exists.
- Engine seams — `InputChannel 'device'`, device capability defaults, catalog
  context + `deviceConnected` note, `deviceBridgeAvailable` capability.
- `useAssistant` — full lifecycle wiring (unchanged contracts).
- UI — a fixed four-device dashboard (`JarvisShell`), CORE chip in
  `ConnectivityStrip`, Persistent backend + Phone bridge rows in
  `SettingsPanel`.
- Windows autostart — `scripts/windows/start-backend-hidden.vbs` + install/un-
  install PowerShell for a LOGON scheduled task (`npm run install:startup`).
- Tests (server: 6 files / 34; frontend: trusted.ts + router +
  DeviceTools.test.ts + DeviceBridge engine suite, net-new 25 in `src/device`),
  docs (§22 + this report), versions, all gates, and a live smoke test against
  the real running backend.

## 3. Not in scope

- No change to where the assistant runs: the engine stays in the browser
  (speech, wake, camera and TTS are already browser-native); the backend never
  executes assistant turns.
- No OS-level push apps yet: phones/Dell bridge through the LAN companion Web
  page (`?device=<trusted id>` claim flow), honestly reporting `online` only
  while their bridge heartbeats. The optional typed Android bridge/notify
  service is declared REQUIRES CONFIGURATION, not built.
- No public internet exposure and no TLS termination. The backend is
  loopback-bound; browser APIs use an HttpOnly SameSite session and exact
  trusted origins, while non-browser API clients use the server-side bearer.
  Public `/health` is reduced to service identity and aggregate status.
- No arbitrary command execution in the backend — same bounded-native-agent
  contract as Phases 1.2–2.6.
- Hand gestures / media device control are NOT implemented and are never faked.

## 4. Backend design (`server/`)

- **Single instance** — `data/backend.pid` is written with a retry window; a
  second process detects it and exits with a clear warning (verified live).
- **Supervision** — the backend spawns the native agent and probes it over
  JSON-RPC; a probe failure triggers a bounded exponential-backoff restart
  (default limit with per-restart counting). Runaway restart loops are
  impossible: the restart count is real and the loop terminates honestly.
- **Trusted registry** (`registry.ts` + `trusted.ts`) — seeds exactly four
  trusted devices in fixed order: `victus-5050` (primary_pc, this PC — online
  from boot because the backend runs there), `dell-laptop` (secondary_pc),
  `s26-ultra` (primary_phone), `s23-fe` (secondary_phone). **Unknown/unpaired
  devices are REFUSED (`403 untrusted_device`) and never added to the
  registry.** A trusted device comes online only when its companion bridge
  claims and then heartbeats it (TTL 40s → honest `offline`/`stale`/`unknown`).
  Claims/heartbeats merge real telemetry (battery, charging, network, activity,
  version, capabilities, connection). The persisted file merges presence ONLY
  for trusted ids and drops everything else.
- **Events** — a tiny pub/sub bus; every `publish` fans out to all live SSE
  clients, and SSE teardown closes every response before the server closes.
- **Health** — `/health` is built from real state: supervision only when the
  child is probed reachable; device counts only from the live registry; wake/
  assistant mirrors only when peers have actually posted them; file count from
  the store.
- **Files** — bounded (25MB) base64 upload with an optional trusted `device`
  target; devices download by id from `/api/files/<id>`; motion to temp file
  then rename.

## 5. Browser client (`src/backend/`)

- `ReconnectController` — a single bounded delayed-schedule state machine over
  `idle / connecting / connected / waiting / giving_up` with exponential
  backoff that respects its ceiling. It gives up honestly instead of looping
  forever, and a successful reconnect resets the attempt counter.
- `BackendClient` — owns the ONE SSE stream, dispatches named events
  (`ready`, `device`, `notify`, `inbound`, `assistant`, `wake`) to registered
  handlers, applies the guarded token to every POST, indexes reconnect
  attempts through the controller, and reads the registry from
  `/api/device/registry`. `register` was replaced by the claim model
  (`claimDevice` / heartbeat with telemetry).

## 6. Device bridge (`src/device/`) — honest delivery rails

- The device surface is lifecycle-bound: the provider is attached only when the
  backend has actually delivered `ready`, and detached the instant the SSE
  stream drops (`onDisconnected`) or gives up (`onGaveUp`). Detach REMOVES every
  device.* tool and capability entry from the registries (dedicated tests), so
  device tools cannot exist — let alone be invoked — while disconnected.
- **Identity** (`trusted.ts`) — the four canonical ids plus natural-language
  defaults: "my computer"/"my pc" → `victus-5050`, "my other laptop"/"dell" →
  `dell-laptop`, "my phone" → `s26-ultra`, "my other phone" → `s23-fe`.
  Resolution is word-boundary phrase matching; ambiguity or an unknown phrase
  returns unresolved so the assistant ASKS instead of guessing.
- **Router** (`router.ts`) — every target is validated against the live
  registry before any request: untrusted ids, offline devices and unreachable
  backends are refused with an honest reason.
- `device.notify` reports `delivered`/`deliveredTo`/`reason` ONLY from the
  backend's response and the route check; a backend with no online listener
  answers honestly and the engine reports that honestly (test-verified).
- `device.status` reads detailed per-device telemetry from the live registry
  (role, online/health, connection, battery, network, agent version).
- `device.list` lists only what the backend registry snapshot contains.
- `device.sendFile` stores a bounded file for a trusted target and notes
  honestly when the target is offline (download on reconnect).

## 7. UI

- `JarvisShell` shows a fixed four-device readout: "TRUSTED DEVICES (n of 4)"
  with role, online dot, connection, battery/charging, network and agent
  version, plus the host note that phones/Dell are online only while their
  bridge heartbeats.
- `ConnectivityStrip` gains a CORE chip driven by the reconnect phase and device
  count — a dropped stream is visible immediately, including the honest
  "unavailable" state after the bounded budget is exhausted.
- `SettingsPanel` gains Persistent backend + Phone bridge rows from the real
  capability snapshot.

## 8. Tests

- Server: `server/src/*.test.ts` — 6 files / 34 tests. The registry suite
  pins the trusted contract: exactly four seeded ids/roles, host online from
  boot while phones/Dell stay offline until claimed, unknown registration
  refused, claim + telemetry merge, heartbeat TTL → offline/stale, and a
  persist/reload that keeps only trusted ids. The HTTP suite covers unpaired
  `403 untrusted_device`, claim→heartbeat→registry round trips, targeted notify
  (delivered exactly to the online trusted id; honest offline/invalid-target
  failures), token protection on claim/heartbeat/notify, files, inbound,
  state/wake reflection in health, and `/phone` substitution.
- Frontend: `reconnect.test.ts` (6) — pure controller including giving-up
  within the budget and reset on success; `BackendClient.test.ts` (6) —
  FakeEventSource-driven ready/connected, named event routing, reconnect →
  recover → give-up, honest unreachable fetch errors, token header on POST,
  and a drop-episode test proving `onDisconnected` fires exactly once per
  episode and clears on a genuine recovery.
- `src/device` (25 tests) — `trusted.test.ts`: the four-identity model, the
  requested default alias mappings, substring non-matching, ambiguity, unknown
  phrases; `router.test.ts` within `trusted.test.ts`: honest routes for
  online/offline/untrusted/broadcast; `DeviceTools.test.ts`: phrase → canonical
  target passed to the backend, unknown/offline refusal BEFORE any backend
  call, ecosystem listing and status; `DeviceBridge.engine.test.ts` (5): no
  device tools without a provider, real registration + catalogue entries with
  one, honest notify failure, `deviceBridgeAvailable` through the real
  capability snapshot, and a strict detach test proving device tools AND
  capability entries vanish when the bridge drops.

## 9. Validation gates (all green at 0.8.0)

1. `npm test` — **109 files / 1271 tests pass** (34 server + new frontend
   identity/router/tool suites + the Phase 2.7/earlier baseline).
2. `npx tsc -b` — clean.
3. `npm run backend:check` (`tsc --noEmit -p server/tsconfig.json`) — clean.
4. `npm run build:backend` (`tsc -p server/tsconfig.build.json`) — clean build.
5. `npm run lint` — 0 warnings / 0 errors (339 files, 116 rules).
6. `npm run build` — clean (includes backend build).
7. `npm run native:check` / `npm run native:build` — clean (native `2.8.0`).

### Live smoke test (real processes)

- Started `npm run backend` — log shows version 0.8.0 / protocol
  `jarvis-backend-2`, native child spawned and probed reachable, HTTP listening
  on 8787.
- A second `npm run backend` instance **exited 1** with the pid-lock message.
- `GET /health` — real snapshot: 4 trusted devices, only `victus-5050` online.
- Pairing: `POST /api/device/claim` with `s26-ultra` → online with telemetry;
  a claim for an unknown id → `403 untrusted_device`; the registry stays 4.
- Targeted notify: delivered to exactly `s26-ultra`; after the TTL lapse the
  same target is honest `delivered:false / device is offline`.
- `/phone?device=s26-ultra` serves with the token substituted and claims on
  `ready`; `/phone` without a target shows the pairing hint.
- File round-trip: base64 upload with a trusted target → `{file:{url,size}}` →
  download returns the exact bytes.
- SSE: a real client received `event: ready` then `event: inbound` with the
  exact device message after `POST /api/inbound`.
- Shut down cleanly; port freed; no orphan node processes.

## 10. Versioning

`NATIVE_AGENT_VERSION` `2.7.0 -> 2.8.0`; `APP.version` `0.7.0 -> 0.8.0`
(`phase 0.7 -> 0.8`); backend `BACKEND_VERSION` `0.8.0`, `BACKEND_PROTOCOL`
`jarvis-backend-2` (the trusted-ecosystem pairing model broke the wire: open
registration is gone, notify/file take trusted targets, `DeviceRecord` gained
platform/role/trusted/telemetry). Native + frontend protocols unchanged
(`jarvis-native-1`/`jarvis-ui-1`).

## 11. Verification matrix

| Feature | Status | Evidence |
| --- | --- | --- |
| Four-device trusted registry (seeded, ordered, unpaired refused) | IMPLEMENTED + VERIFIED | `registry.test.ts`, `http.test.ts` (403) |
| Host PC online from boot; phones/Dell only while bridging | IMPLEMENTED + VERIFIED | `registry.test.ts`, `/health` smoke |
| Claim/heartbeat pairing with telemetry (battery/network/version) | IMPLEMENTED + VERIFIED | claim round trip, `phone.html` `?device=` |
| TTL liveness → honest offline/stale/unknown | IMPLEMENTED + VERIFIED | `registry.test.ts`, smoke (40s) |
| Trusted-only persistence (unknown dropped) | IMPLEMENTED + VERIFIED | persist/reload test |
| Bearer token on EVERY `/api/*` POST | IMPLEMENTED + VERIFIED | `http.test.ts` token suite |
| Natural-language device identity + defaults | IMPLEMENTED + VERIFIED | `trusted.test.ts`, `DeviceTools.test.ts` |
| Target router with honest offline/untrusted refusal | IMPLEMENTED + VERIFIED | `trusted.test.ts`, tool tests |
| `device.list` / `device.status` / `device.notify` / `device.sendFile` | IMPLEMENTED + VERIFIED | engine + tool tests, live SSE |
| Four-device dashboard panel | IMPLEMENTED + VERIFIED | `BackendStatus.tsx`, live health |
| Windows autostart scheduled task | IMPLEMENTED + VERIFIED (logon task created earlier; re-verified at build) | `install-startup.ps1` |
| Backend-supervised native agent + live smoke | IMPLEMENTED + VERIFIED | supervisor tests, smoke |
| Typed Android bridge / notify-sidecar (Kotlin/service) | REQUIRES CONFIGURATION | consent = backend bridge + protocol only; service is a later config task |
| Dell laptop bridge | REQUIRES CONFIGURATION | router + honest states shipped now; Dell running a bridge = later config |
| OS-level push notifications (off-LAN) | NOT SUPPORTED | LAN companion page model; honest offline outside LAN |
| Hand gestures / media-device control | NOT SUPPORTED | explicitly excluded; never faked |
| Unrestricted/native app push outside the browser | NOT SUPPORTED | bounded backend contract holds |

## 12. Limitations

- The companion bridge is a LAN Web page: it claims a TRUSTED id and heartbeats
  only while open and on the same network (or via the PC's LAN IP). Off-LAN
  devices honestly show offline.
- `JARVIS_BACKEND_TOKEN` is required by the loopback backend for non-browser
  clients. Browser pages use an HttpOnly SameSite session cookie; no bearer
  token is embedded in the frontend or companion page.
- SSE + gecko/long-poll absent: very old browsers without `EventSource` will
  show the honest disconnection state via the CORE chip.
- The backend does not do TLS; do not expose it to the public internet.
- The Dell laptop and phones are represented in code and router today; their
  real-world bridges are deployed as a later configuration step (see matrix).

## 13. Final status

The persistent backend is real, supervised, bounded and tested; the frontend
connects, mirrors and recovers honestly; the four-device trusted ecosystem is
seeded, refusal-safe and target-aware; notifications, files, status and inbound
messages flow between the app and trusted devices over the live SSE bridge with
honest offline states throughout; Windows autostart is installed; the live
smoke test passed end to end.

PHASE 2.8 COMPLETE.
