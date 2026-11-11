# JARVIS trust boundaries

## Browser to Windows control

```text
Browser UI
  → loopback backend :8787
  → native RPC broker with a fixed 48-method allow-list
  → native agent :8765
  → bounded Windows providers
```

The browser uses an `HttpOnly`, `SameSite=Strict` session cookie for backend
API access. It never receives `JARVIS_BACKEND_TOKEN` or
`JARVIS_BACKEND_NATIVE_TOKEN`. The backend uses `JARVIS_BACKEND_TOKEN` for
non-browser API clients and `JARVIS_BACKEND_NATIVE_TOKEN` when it authenticates
to the native agent. Those values belong in server-side environment
configuration such as the ignored `.env.local`; they must not use a `VITE_*`
name. The backend validates each native method against the same 48-method
allow-list used by the agent. The agent still enforces its own method allow-list,
origin policy, permissions, and filesystem root confinement.

Port 8787 is loopback-only. Browser CORS origins are exact entries configured
with `JARVIS_BACKEND_TRUSTED_ORIGINS`; the development server is also bound to
loopback. Public `/health` returns only service identity and aggregate status.
Detailed health, device data, event streams, AI routes, and other `/api/*`
routes require the backend bearer or browser session.

## Android companion to the phone listener

```text
Android companion
  → phone listener :8788
  → paired-device credential check and bounded command queue
  → backend / trusted device registry
```

The phone listener binds to `0.0.0.0:8788` by default so an Android device on
the LAN can connect. Pairing uses a short-lived one-time code for an already
trusted device id; subsequent routes require that device's credential. The
phone listener and pairing traffic use plain HTTP. A live Windows check on
2026-09-27 found the firewall enabled for Domain, Private, and Public profiles,
with inbound traffic blocked by default and an enabled JARVIS TCP 8788 allow
rule limited to the Private profile. That rule permits any remote IP while the
Private profile is active; pairing and device credentials remain necessary at
the application layer. This is a host-specific observation, not a guarantee
for another installation. Do not infer that the listener is protected merely
because the backend control port is loopback.

The Android companion does not receive the native agent bearer token or backend
API bearer. Its phone credential is separate and scoped to the trusted phone
routes. Pairing, network isolation, and Windows Firewall are distinct controls.
