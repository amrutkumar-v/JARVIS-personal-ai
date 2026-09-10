# Semantic Memory & Embeddings — JARVIS

Phase 0.6 (0.6A → 0.6C) adds real semantic embeddings to the long-term memory
architecture for retrieval, backfill, health reporting and conservative
semantic deduplication.

All embedding code lives behind two abstractions so the memory core stays
provider-agnostic:

- `EmbeddingProvider` (`src/memory/embeddings.ts`) — vendor-neutral interface
  for `embed(text)` / `embedBatch(texts)` plus configuration and health.
- `EmbeddingManager` (`src/memory/embeddingManager.ts`) — owns the embedding
  lifecycle: generation, batching, retries, sanitization, health caching,
  backfill statistics and semantic dedup queries.
- `MemoryManager` (`src/memory/MemoryManager.ts`) — the persistence facade the
  tools/UI use. It requests embeddings, stores them inline on each item, and
  exposes `backfillEmbeddings()`, `rememberSemantic()` and
  `getEmbeddingHealth()`.

## Providers

### Deterministic (default, offline)

`DeterministicEmbeddingProvider` (`id: 'deterministic-test'`) is a hash-based
vector generator for development and tests.

> **It provides NO real semantic meaning.** It is always available, never
> requires configuration, and its vectors are only useful for exercising the
> plumbing deterministically. It must never be mistaken for real semantics.

Fresh `EmbeddingManager` instances (and `getDefaultEmbeddingManager()`) use the
deterministic provider until a real provider is configured/injected. When the
deterministic provider is active, `getHealth().fallbackActive === true`.

### Real (production)

`OpenAIEmbeddingProvider` (`id: 'openai-embeddings'`) talks to any
OpenAI-compatible `/embeddings` endpoint (OpenAI, Azure, Ollama, LM Studio,
vLLM, …). See [Configuration](#configuration) below.

In production you should inject the real provider explicitly before running
backfill / remember flows, e.g.:

```ts
import { EmbeddingManager, openAIEmbeddingProvider, getDefaultEmbeddingManager } from '../memory'
getDefaultEmbeddingManager().setProvider(openAIEmbeddingProvider)
```

## Configuration

Copy `.env.example` to `.env.local` and fill placeholders only — never commit a
real key.

| Variable                         | Purpose                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `VITE_JARVIS_EMBEDDING_BASE_URL` | Base URL of an OpenAI-compatible embeddings endpoint.      |
| `VITE_JARVIS_EMBEDDING_PROXY_URL`| Optional same-origin dev proxy path (takes precedence).    |
| `VITE_JARVIS_EMBEDDING_MODEL`    | Model id; defaults to `text-embedding-3-small`.            |
| `VITE_JARVIS_EMBEDDING_DIMENSIONS` | Optional dimension override (auto-derived for common models). |
| `JARVIS_API_KEY`                 | Shared API key used for the embeddings endpoint.           |

If `VITE_JARVIS_EMBEDDING_BASE_URL` is empty the provider falls back to the
general AI base URL (`VITE_JARVIS_AI_BASE_URL`). A missing/empty
`VITE_JARVIS_EMBEDDING_BASE_URL` simply keeps JARVIS on the deterministic
provider — it never crashes the app.

## Provider health

`EmbeddingManager.getHealth(): ProviderHealth` (30 s cache, no blocking probe
per search) reports:

- `status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'`
- `configured` — valid endpoint + model present
- `providerId` / `label` / `model` / `dimensions`
- `fallbackActive` — `true` whenever the deterministic provider is in use
- `lastError` / `lastCheckedAt`

To distinguish the three important states from `MemoryManager.getEmbeddingHealth()`:

| State                              | `enabled` | `realEmbeddingsAvailable` | `fallbackActive` |
| ---------------------------------- | --------- | ------------------------- | ---------------- |
| Real provider configured & healthy | `true`    | `true`                    | `false`          |
| Real provider not configured       | `false`   | `false`                   | `true` ¹         |
| Provider failing at runtime        | `true` ²  | `true` ²                  | `false` ²        |

¹ A fully unconfigured manager reports `enabled:false` and `fallbackActive:true`
(recommend configuring a real provider).
² Configuration is still valid even while a request is failing; failures surface
in `status: 'unhealthy'`/`lastError` and retrieval gracefully degrades to
lexical-only scoring.

## Fallback behavior

- Embedding generation never blocks/breaks normal memory operations. Search
  falls back to lexical + importance + recency weighting (`DEFAULT_HYBRID_CONFIG`)
  whenever the query embedding is unavailable.
- Config errors, missing keys and provider failures are logged and swallowed at
  the embedding boundary — `remember`/`search`/`backfill` keep working.
- Embeddings are persisted inline on each memory item, so a brand-new re-build
  of the semantic layer keeps old data readable (backward compatible).

## Backfill

`MemoryManager.backfillEmbeddings()` computes a valid embedding for every stored
memory that lacks one and persists them immediately. It returns
`BackfillResult`:

```ts
{
  total, alreadyEmbedded, processed, successful, failed, skipped,
  durationMs, errors: Array<{ id, error }>
}
```

Guarantees:

- **Resumable / rerunnable** — items with a valid embedding are skipped on the
  next run.
- **Non-destructive** — memories are never deleted; valid embeddings are never
  overwritten.
- **Partial-failure tolerant** — individual failures are recorded in `errors`
  and never abort the whole operation; re-running heals the failed ids.
- **Malformed-persistence healing** — an empty/non-finite stored embedding is
  treated as absent and refreshed.

Trigger it once after configuring a real provider, e.g.

```ts
const result = await memory.backfillEmbeddings()
console.log(result) // { successful: 42, failed: 0, … }
```

`EmbeddingManager.backfillEmbeddings(items)` exposes the same stats for callers
that manage their own store.

## Semantic deduplication

`MemoryManager.rememberSemantic(content, opts)` (async) guards memory creation:

1. **Exact duplicate** → updates in place (same as `remember()`).
2. **Semantic duplicate** (real provider only) → merges metadata/timestamp into
   the existing memory and reports `deduplicated: { existingId, similarity }`.
3. Otherwise a new memory is created (`created: true`).

Rules enforced by design:

- The **deterministic provider never participates** in semantic-dedup decisions
  (`EmbeddingManager.hasRealEmbeddings()` is `false` for `deterministic-test`,
  so `checkSemanticDuplicate()` short-circuits before any generation). This
  guarantees the fallback can never be mistaken for real meaning.
- The threshold is **conservative** (default `0.95`, configurable via
  `EmbeddingManager.setDeduplicationThreshold()`). Distinct memories are
  always kept; near-verbatim semantic restatements are merged. Memories that
  add genuinely new information simply land below the threshold and are kept.
- Exact/lexical dedup behavior is preserved for all providers.

`notes` tool `remember` action routes through `rememberSemantic`.

## Batching, retries & failure handling

`EmbeddingManager` handles upstream problems without losing valid data:

- **Batching** — `generateEmbeddingsBatch()` chunks by `batchSize` (default 20).
- **Retries** — each batch is retried up to `maxRetries` with linear backoff.
- **Malformed responses** — a vector with the wrong dimensions, empty, or with
  non-finite (`NaN`/`Infinity`) components is treated as a failed embedding and
  never persisted.
- **Count mismatches** — a batch response that doesn't line up 1:1 with the
  input is treated as a structural failure of that batch (retried, then
  reported as failed entries).
- **Partial batch failures** — one bad entry in a batch becomes `undefined`
  while the rest are kept; other chunks are unaffected.
- **Empty results** — empty inputs produce empty outputs; no embedding is
  attached to memories that fail, so data is never corrupted.

## Limitations

- **Scale** — retrieval is an in-memory linear scan with pairwise cosine
  similarity. Fine up to thousands of memories; beyond that a real vector index
  is recommended (the `Store` abstraction allows swapping backing stores).
- **Dimensions** — changing the embedding model's dimensions invalidates stored
  vectors; rerun `backfillEmbeddings()` after clearing/regenerating (older
  mismatched vectors are skipped by cosine scoring and refreshed by backfill).
- **Deterministic provider ≠ semantics** — consistent vectors, no meaning.
  Real retrieval quality requires a real embedding model.
- **Cost/rate limits** — remember flows generate 1 embedding per new memory
  (plus one during the semantic-dedup check). Rate limits surface as failed
  backfill entries and are retried/healed on the next run.