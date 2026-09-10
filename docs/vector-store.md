# Vectorized Store & Cross-Instance Memory — JARVIS

Phase 0.6D adds a persistent, dimension-aware **vector store** that shares
embeddings across every `MemoryManager` instance and keeps semantic retrieval
hybrid (lexical + vector) with a safe fallback.

## Where the pieces live

```
src/memory/vectorStore.ts     VectorStore abstraction + LocalStorageVectorStore
src/memory/hybridRanking.ts   hybridScoreFromSimilarity() (additive handler)
src/memory/MemoryManager.ts   ownership, persistence metadata, search wiring
src/memory/embeddingManager.ts getProviderId() for provenance tagging
```

## What the vector store is (and is not)

- A **companion, persistent index** keyed by memory id, stored under its own
  localStorage key (default `jarvis.memory.vectors`, configurable below).
- **Not a separate source of truth.** The memory record (`jarvis.memory`) still
  owns the items and their inline embeddings. Every write path in
  `MemoryManager` calls `vectorStore.reconcile(items)` so the index always
  mirrors the record; on `load()` the index is hydrated from the record the
  same way.
- **Shared across instances.** Any `MemoryManager` (another tab, a hot-reload,
  a freshly constructed instance) reads the same persisted entries, so memory
  added in one instance is retrievable semantically in another. No
  process-local-only persistence.
- **Dimension- and provider-aware.** Each entry records `providerId` and
  `dimensions`. `search()` skips entries whose vector length mismatches the
  query — a stale embedding from a different model can never produce a bogus
  cosine score.

## Cross-instance flow

```ts
// Instance A (e.g. a note in tab A)
const a = new MemoryManager(new EmbeddingManager({ provider: realProvider }))
await a.rememberSemantic('I love coffee in the morning')

// Instance B (another tab / new instance, same origin)
const b = new MemoryManager(new EmbeddingManager({ provider: realProvider }))
const hits = await b.search('morning java') // semantic hit via the vector index
```

When an embedding is generated, the item's `metadata` records
`embeddingProvider` and `embeddingDimensions`; those are persisted with the
record and drive the index's provenance/dimension checks.

## Consistency guarantees

| Operation                      | Vector index behavior                                        |
| ------------------------------ | ------------------------------------------------------------ |
| `remember` / `rememberSemantic`| entry added/updated for the new embedding                     |
| `update(content)`              | stale entry dropped immediately, replaced after regeneration  |
| `remove` / `removeMatching`    | entry removed                                                 |
| `clear`                        | all entries removed                                           |
| load (new instance)            | index hydrated from the record; absent rows re-added          |

`reconcile` only persists when something changed, so routine `persist()` calls
do not churn the index blob.

## Hybrid retrieval

`MemoryManager.search()`:

1. Generates a query embedding when **real** embeddings are enabled (the
   deterministic/test provider never drives semantic retrieval — with it, or
   with embeddings off, scoring is lexical-only).
2. Resolves semantic similarity from the **vector store** (`Normalized cosine`,
   same `normalizeSimilarity` mapping as before), falling back to the item's
   inline embedding if the store can't answer.
3. Feeds it into `hybridScoreFromSimilarity()` (semantic + lexical +
   importance + recency). Passing the old `semanticScore()` value into this
   helper reproduces the previous `hybridScore()` exactly, so pre-0.6D
   behavior is unchanged.
4. With embeddings disabled/missing, scoring is **lexical-only** — the same
   graceful degradation as before.

## Failure safety

- Missing storage (first run, SSR, node without localStorage) → empty store,
  `diagnostics().missing === true`, no throw.
- Corrupt JSON or malformed/non-record blobs → invalid entries are discarded
  and the next persist self-heals the blob.
- Degenerate entries (empty vector, `NaN`/`Infinity`, missing fields) are
  skipped on load and never returned by `search`.
- A dimension mismatch between query and entry skips the entry (scanned counts
  compatible entries; `skipped` counts incompatible ones).
- `search()` never returns `NaN`, never mutates stored data, and never drives
  semantic-dedup decisions (duplicates remain `EmbeddingManager`'s concern,
  real providers only).

## Configuring the storage key

| Variable                          | Purpose                                              | Default                 |
| --------------------------------- | ---------------------------------------------------- | ----------------------- |
| `VITE_JARVIS_MEMORY_VECTOR_KEY`   | localStorage key for the vector index                | `jarvis.memory.vectors` |

Follows the existing `VITE_JARVIS_*` convention; see `.env.example`.

## Diagnostics

`MemoryManager.vectorStoreDiagnostics(): VectorDiagnostics` reports, for status
or debug panels:

```
totalEntries, validEntries, providerIds, primaryDimensions,
storageKey, lastSavedAt, missing
```

## Limitations

- **Linear scan** — candidates are ranked with pairwise cosine in memory
  (matching the existing retrieval model). The `VectorStore` interface is the
  seam where a real vector database (or IndexedDB) can slot in later without
  touching `MemoryManager`.
- **Storage** — entries live in `localStorage` (browser-only, same as the
  memory record). Cross-device sync requires a future remote/backing store.
- **Provenance is advisory** — provider/dimension metadata is used for
  filtering and diagnostics; the record remains authoritative.