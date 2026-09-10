# Memory Lifecycle, Episodes & Controlled Context — JARVIS

Phase 0.7 adds three cooperating mechanisms to long-term memory:

1. **Consolidation (lifecycle)** — an honest, deterministic forgetting safety
   net that moves stale/over-capacity memories into a recoverable archive
   instead of silently deleting them.
2. **Episodes (session grouping)** — each conversation session is tagged so
   memories can be grouped, counted and inspected per session, and so context
   assembly can keep the current session salient.
3. **Controlled context manager** — the engine's memory snippet is now built by
   a token-aware retrieval manager that enforces the long-promised 800-token
   cap on the prompt rather than dumping top-N memories.

Together with Phase 0.6D's vector store, retrieval is now: rank by hybrid
score (lexical + real embeddings) → select by token budget.

## Where the pieces live

```
src/memory/lifecycle.ts        pure lifecycle rules + LifecycleConfig/deafults
src/memory/episodes.ts         Episode model + metadata tagging helpers
src/memory/contextManager.ts   MemoryContextManager + token budgeting
src/memory/context.ts          backward-compatible buildMemoryContext facade
src/memory/MemoryManager.ts    RECORD_VERSION 4, runLifecycle/restore/expunge/
                               beginEpisode/endEpisode/episodes API
src/engine/AssistantEngine.ts  auto-capture safety net, episode wiring,
                               savePreferences/saveProfile reconciliation
src/memory/detect.ts           shouldAutoCapture + question/command guards
src/components/layout/SettingsPanel.tsx  archive UI, embed health, toggles
```

## Consolidation rules (deterministic, recoverable)

Lifecycle decisions are **pure functions of time and importance**. Embeddings
never participate — a vector can never make a memory "important" or
"forgettable".

| Rule | Trigger | Protected from |
| ---- | ------- | -------------- |
| Stale | older than `forgetAfterDays` (365) **and** importance ≤ `importanceFloor` (0.5) | importance ≥ `protectImportance` (0.8) |
| Overflow | active items beyond `maxItems` (optional) | lowest-importance excess first; protected items only touched if everything is protected |

- **Archiving is recoverable.** Archived items keep all fields (including their
  embedding) and move to `record.archive` with `archivedAt` + `archivedReason`.
  `restoreMemory(id)` moves one back and re-hydrates its vector; the vector
  index reconciles automatically either way.
- **Never destroys.** Only `expungeArchived()` (explicit UI intent) or the
  confirmed clear-all flow permanently deletes archive entries.
- **Interval-gated.** `isLifecycleDue()` checks `intervalMs` (7 days) against
  `record.lifecycle.lastRunAt`; `start()` and every `process()` auto-consolidate
  only when due. `consolidateMemory()` forces a run.

Runtime defaults come from `defaultLifecycleConfig()`, which reads optional
`VITE_JARVIS_MEMORY_LIFECYCLE_ENABLED` (default true) and
`VITE_JARVIS_MEMORY_FORGET_AFTER_DAYS` (default 365).

## Episodes

`beginEpisode(conversationId)` tags every new memory written during that
session with `metadata.episodeId` and keeps a persisted `episodes` registry
(`startedAt`, optional `endedAt`, live `itemCount`). `endEpisode()` closes the
session; `episodes()` recomputes counts from the active set, and
`episodeMemories(id)` filters them. The active episode is transient per
instance; the registry survives reloads.

## Controlled context manager

`MemoryContextManager.build()` is the seam `engine/context.ts` reserved for a
"proper retrieval/summarization context manager":

1. Ask the injected `search` (the MemoryManager hybrid search) for a candidate
   pool larger than the final cap (`max(limit, min(24, limit*4))`).
2. `selectMemoryWithinBudget()` greedily picks the best-scoring items that fit
   `maxTokens` (800) and `limit` (6), estimating tokens as `ceil(chars/4)` per
   rendered line. Items that overrun the budget are skipped, not "first N".
3. Optionally prefer the current episode's memories under token pressure
   (`preferEpisodeId`); results are re-sorted to original rank order.
4. Returns the compact tagged snippet (and the selected ranked list) the engine
   injects into the prompt.

`buildMemoryContext(...)` keeps its historical signature and behavior for
existing callers; the token budgeting is now actually enforced.

## Auto-capture safety net (opt-in)

`preferences.autoMemorize` (default **off**) enables deterministic capture of
obvious personal facts. Every guard in `shouldAutoCapture()` must pass:

- not an explicit memory command (left to the memory tool),
- not a question,
- a durable fact (existing `isDurableFact()` heuristics),
- not credential-like (existing `looksLikeCredential()`).

Captured items are stored via `rememberSemantic` with `source: 'inferred'` and
are tagged with the active episode, so they are honest about their origin and
visibly recoverable in the settings panel.

## Preferences/profile reconciliation

`MemoryManager` is the source of truth for long-term `preferences`/`profile`.
`engine.savePreferences()` / `engine.saveProfile()` write through the memory
record and then mirror to the zustand store; `start()` mirrors the persisted
snapshot back so the UI and engine agree after reloads. All settings writes in
the app now route through this single path.

## Record format

`RECORD_VERSION = 4`; migration from v3 adds `archive`, `episodes` and
`lifecycle`, and `UserPreferences.autoMemorize` (default false), validating
each entry defensively on load.

## Verification summary

- `npm run test` — 209 tests across 17 files (new: lifecycle, episodes,
  contextManager; extended: detect, AssistantEngine).
- `npx tsc -p tsconfig.app.json --noEmit` — clean.
- `npm run lint` (oxlint) — 0 warnings / 0 errors.
- `npm run build` — succeeds (only the pre-existing >500 kB chunk warning).

Phase 0.8 builds on this: see [`docs/episode-recall.md`](episode-recall.md)
for episode-aware context selection and the session/archive recall surfaces.
Phase 0.9 adds the retrieval-based conversation-window context manager that
builds the provider prompt transcript; see
[`docs/conversation-context.md`](conversation-context.md).
Phase 1.0 details how the agent core executes tools and feeds memory writes
back into this lifecycle; see [`docs/agent-architecture.md`](agent-architecture.md).