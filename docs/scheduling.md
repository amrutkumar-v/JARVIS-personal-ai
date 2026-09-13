# Scheduling — reminders

Real, deterministic, locally-persisted reminders built on the converge-to-one
executor principle: a fired reminder goes through the SAME
`AssistantEngine.process` pathway as text, voice, and device input — it never
starts a second agent loop.

## How it works

- `src/scheduling/scheduler.ts` — `LocalScheduler` (the production seam).
  Persists to `localStorage` under `jarvis.scheduler.v1`. Polls the clock at a
  bounded interval; corrupt storage degrades to an empty schedule without
  crashing.
- `src/scheduling/schedulerTools.ts` — three registered tools that converge
  through the existing capability/tool runtime (see agent-architecture.md):
  `scheduling.create`, `scheduling.list`, `scheduling.cancel`. All three are
  bound to the real scheduler instance through `AssistantEngine.attachScheduling`
  and are unregistered when the seam detaches.
- `src/hooks/useAssistant.ts` — one `LocalScheduler` per session lifecycle:
  attaches to the engine, starts ticking, refreshes the store slice on changes,
  and pushes a notice before feeding each due reminder into the engine with
  channel `'scheduled'`.
- Settings → Reminders lists the live schedule (from the engine getter, pushed
  into the store — never a private mirror).

## Semantics (tested)

- One-time (`at`, or ISO timestamp), daily (`time`), weekly (`time` + weekday 0–6).
- Dedupe: the same reminder text within 24h is not scheduled twice.
- Bounds: max 50 items, max 500 chars per item, one-time reminders at least 5s
  in the future.
- Missed runs: when the app was closed past the grace window, the item is
  marked `missed` at load and delivered exactly ONCE on the next tick with
  `lastResult: 'missed'` surfaced to the UI — no double-fire, no silent drop.
- Honest boundary: the browser cannot guarantee timers when the page is closed,
  so reminders only fire while JARVIS is open. That limitation is stated in the
  UI instead of being papered over.

## Boundaries

The scheduler rejects invalid input with structured `{ reason }` results
(`missing_text`, `invalid_when`, `scheduling_failed`, `reminder_not_found`).
Cancelling an id that no longer exists is an honest failure, `{ reason:
'reminder_not_found' }` — matches the high-risk-tool honesty policy.