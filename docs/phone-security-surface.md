# Local control surfaces and phone pairing

This note records the current source-level authentication surface. Live
deployment and Windows Firewall state must be checked independently.

## Backend listener — port 8787 by default

The backend binds to loopback and refuses startup without a non-empty
`JARVIS_BACKEND_TOKEN`. Every `/api/*` route and `/events` requires either that
server-side bearer or a backend-issued HttpOnly, SameSite browser session.
Browser origins are matched against the explicit `JARVIS_BACKEND_TRUSTED_ORIGINS`
list; wildcard CORS is not used. Public `/health` returns only service name,
version, protocol, and aggregate status. Detailed health and static frontend
resources remain readable; the static frontend contains no server bearer
credential. The `/phone` page also uses the browser session rather than an
embedded bearer token.

## Phone listener — port 8788 by default

The phone listener is a separate HTTP server. It binds to `0.0.0.0` by default
when phone support is enabled, so every active network interface can reach it.
It accepts POST only and exposes exactly these seven routes:

| Route | Protection and effect |
| --- | --- |
| `/phone/pair` | No bearer token. Requires a current one-time code for a trusted device id. |
| `/phone/heartbeat` | Per-device bearer credential; updates that device's bounded telemetry. |
| `/phone/ping` | Per-device credential; returns a reachability response. |
| `/phone/status` | Per-device credential; returns the server's record for that device. |
| `/phone/poll` | Per-device credential; returns commands queued for that device. |
| `/phone/ack` | Per-device credential; acknowledges a queued command. |
| `/phone/event` | Per-device credential; accepts only `call.state` with a bounded call-state value. |

Pairing codes are six digits, expire after ten minutes, and are consumed after
one successful claim. Six failed attempts exhaust the session. The phone id
must be in the trusted-device allow-list. Pairing issues a random 32-byte device
credential; only its SHA-256 hash is stored. Every protected request must carry
that credential and the matching device id, compared in constant time. Bodies
are capped at 64 KiB. Other paths and methods are refused. The phone server
does not add CORS headers.

Pairing and device credentials protect the routes from unauthenticated callers
after pairing, but the listener uses plain HTTP. A LAN observer can potentially
capture a pairing response or device credential and replay it. The default
`0.0.0.0` bind is a real network exposure, not a security control.

### Live Windows firewall observation (2026-09-27)

`netsh advfirewall show allprofiles` reported Domain, Private, and Public
profiles enabled with inbound traffic blocked by default. The active rule
`JARVIS Phone Listener (TCP 8788)` is enabled for inbound TCP 8788 on the
Private profile only. Its remote address is `Any`, so any host on a network
classified as Private can reach the listener; application pairing and
per-device credentials remain the next checks. This observation applies only
to the inspected host and must be repeated on other installations. The phone
listener does not use TLS. The pairing code is shown in the local backend log;
protect access to that machine and its logs.

## Scope

The phone surface contains no shell or arbitrary command route. Its command
queue is tied to an already-paired device and bounded phone capabilities; the
phone executes supported actions through Android APIs. Keep the main backend
loopback-bound.
