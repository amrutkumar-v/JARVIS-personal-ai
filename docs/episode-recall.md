# Episode-Aware Context & Session Recall — JARVIS

Phase 0.8 closes the two seams Phase 0.7 intentionally left open:

1. **Episode-aware context pipeline** — the engine now feeds the active session
   episode into the memory-context builder, so under token pressure the
   current conversation's memories stay salient while the 800-token budget is
   still enforced.
2. **Per-episode / archive recall tool** — the memory tool can list sessions,
   show what a session recorded, browse the archive by session, and restore a
   specific archived memory; the settings panel mirrors those surfaces.

All Phase 0.6D vector-store and Phase 0.7 lifecycle/episode guarantees remain
unchanged: the record stays authoritative, recall still goes through the
hybrid (lexical + real-embedding) ranking, archiving stays recoverable, and
deterministic embeddings never drive semantic decisions.

## Where the pieces live

```
src/memory/context.ts                     buildMemoryContext(..., preferEpisodeId?)
src/memory/contextManager.ts              MemoryContextManager already preferred
                                          one episode via selectMemoryWithinBudget
src/engine/AssistantEngine.ts             passes active episode id into the
                                          memory context per user turn; exposes
                                          episodes()/activeEpisode()/episodeMemories()
src/tools/NotesTool.ts                    new actions: episodes, episode_memories,
                                          archive, restore (+ schema, canRun)
src/components/layout/SettingsPanel.tsx   SESSIONS browser + archive session tags
```

## Episode-aware context pipeline

`AssistantEngine.process()` already calls `beginEpisode(conversation.id)` at the
start of each turn (Phase 0.7). Phase 0.8 adds:

```ts
const activeEpisodeId = this.memory.activeEpisode?.id
const memoryCtx = await buildMemoryContext(
  (q, o) => this.memory.search(q, o),
  () => this.memory.items(),
  clean,
  DEFAULT_MEMORY_CONTEXT_LIMIT,
  DEFAULT_HYBRID_CONFIG,
  activeEpisodeId, // Phase 0.8
)
```

`buildMemoryContext` gained an optional trailing `preferEpisodeId` parameter
(**backward compatible** — existing callers omit it and get today's behavior).
It is forwarded into `MemoryContextManager`:

- Candidates are ranked by `search` exactly as before (hybrid lexical +
  real embeddings via the companion vector store).
- `selectMemoryWithinBudget` reorders selection so items tagged with the
  preferred episode are considered first *only when the budget is tight*;
  the returned snippet is re-ordered back to rank order.
- The 800-token cap and 6-item limit are unchanged and still enforced.

So a burst of verbose older memories can no longer crowd out facts the user
just established in this session, without ever exceeding the budget.

## Session recall through the memory tool

New `notes` actions (all `low_risk`, same permission tier as recall):

| action               | params                 | returns                                   |
| -------------------- | ---------------------- | ----------------------------------------- |
| `episodes`           | —                      | session episodes (id, title, itemCount)   |
| `episode_memories`   | `episode_id`           | active memories captured in that session  |
| `archive`            | `episode_id?`          | recoverable archived memories (optional per-session filter) |
| `restore`            | `id`                   | moves one archived memory back to active  |

`archive` reads the archive's persisted `metadata.episodeId` tag, so a session
that was consolidated away can still be recalled by session and restored.
Restoring re-hydrates the item's vector entry (Phase 0.7 `restoreMemory`), so
semantic recall works again for that memory.

## Settings panel surfaces

- **SESSIONS** list: every episode that wrote memories, newest first, with its
  live item count; expanding a session shows that session's memories.
- A "current session" line appears while a conversation is active.
- ARCHIVE rows show the originating session (`from session <id>`).
- All of it is read from the engine's `episodes()` / `activeEpisode()` /
  `episodeMemories()` passthroughs, which read the authoritative `MemoryManager`
  (persisted, cross-instance).

## Persistence implications

- No new storage keys or record-format bump. Episodes were already persisted
  in the record (Phase 0.7). Archive entries already kept `metadata.episodeId`.
- The active episode remains transient per `MemoryManager` instance; the
  session registry survives reloads, so recall works from a fresh engine.

## Interaction with Phase 0.6D and 0.7

- 0.6D vector store: untouched. Recall ranking is the same hybrid search; the
  context manager consumes its output.
- 0.7 lifecycle: unchanged. `archive`/`restore` in the tool delegate to
  `archivedItems()`/`restoreMemory()`, so archive recovery semantics (vector
  re-hydration, provenance) are identical to the UI path.
- 0.7 episodes: the context manager's `preferEpisodeId` seam (already built but
  unwired) is now connected to the live engine session.

## Testing strategy

- `contextManager.test.ts`: manager config routes `preferEpisodeId` into
  selection; a tight budget yields exactly the preferred episode, still under
  the token cap.
- `context.test.ts`: the facade forwards the new parameter end to end — with 7+
  relevant candidates and long lines at the default budget, the preferred
  session's line wins and the other session's is excluded by the budget.
- `NotesTool.test.ts`: episodes list, `episode_memories` filtering (and its
  missing-`episode_id` guard), `archive` per-session filtering, and `restore`
  round-trip.
- `AssistantEngine.test.ts`: process registers a session episode, exposes
  `episodeMemories`, persists across a fresh engine, and keeps sessions distinct
  across conversations.
- Deterministic/mock only; no network, no real providers.

## Limitations / deferred

- The context snippet itself is identical in format (Phase 0.7 `renderMemoryLine`);
  only selection order under pressure is episode-aware.
- The tool's `episodes` labels use session ids (or an optional title); titles
  are not yet auto-generated from conversation content.
- Archived-memory summarization and cross-endpoint embedding-dimension UI
  remain deferred (candidates suggested after 0.7, not part of this milestone).

## Related documentation

- Phase 0.7 lifecycle and the memory-context manager:
  [`docs/memory-lifecycle.md`](memory-lifecycle.md).
- Phase 0.9 retrieval-based conversation-window context (the provider-prompt
  transcript builder that runs alongside the memory snippet):
  [`docs/conversation-context.md`](conversation-context.md).
- Phase 1.0 agent core (how episodes/memory integrate with the execution loop,
  verification and observations): [`docs/agent-architecture.md`](agent-architecture.md).

## Verification summary

- `npm run test` — full suite green.
- `npx tsc -p tsconfig.app.json --noEmit` — clean.
- `npm run lint` (oxlint) — 0 warnings / 0 errors.
- `npm run build` — succeeds.