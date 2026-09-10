# Conversation-Window Context Manager — JARVIS

Phase 0.9 replaces the provider-prompt transcript pipeline's "take the last N
messages" recency slice with a **retrieval-based conversation-window context
manager** (`src/engine/conversationContextManager.ts`).

It answers the question the old slice could not: *"many turns ago the user said
something that matters to what they just asked — how do we keep that thread
alive without letting the transcript grow unbounded?"*

## Why conversation-window retrieval exists

The engine needs to hand the provider a bounded, coherent excerpt of the
conversation. A plain recency slice:

- drops older context as soon as it leaves the last `N` messages, even when it
  is directly relevant to the current request;
- has no notion of *relevance* or a token budget — transcripts are
  `slice(-N)`, so a burst of verbose recent messages is always fully copied in;
- cannot distinguish "recent" from "important".

The retrieval window keeps **recency for continuity** and **adds relevance**:
older messages are ranked against the current user request, then everything is
spent against a strict token budget. The old `.slice()` behavior still works
via the backward-compatible `buildContextWindow` (see below).

```
Current request
      ↓
Conversation transcript
      ↓
┌─────────────────────────────┐
│ Recent messages (contiguity)│
│ Lexical relevance           │
│ Semantic relevance (real)   │
└──────────────┬──────────────┘
               ↓
        Hybrid ranking
               ↓
      Deduplicate (disjoint)
               ↓
       Token-budget selection
               ↓
     Provider conversation context
```

## Recent vs retrieved transcript context

- **Recent window** — the newest `recentCount` messages (default `8`, the old
  `CONTEXT_WINDOW`). They give conversational continuity and are always
  preserved, budget permitting. Selection walks newest→oldest and keeps a
  *contiguous newest tail* that fits the budget, so the provider never sees a
  gap in the recent thread.
- **Retrieved context** — transcript messages *older* than the recent window.
  Only the most recent `candidateLimit` (default `40`) older messages are even
  considered (deterministic; bounds matching/embedding work on long
  transcripts). They are ranked against the current request and admitted while
  the budget lasts.

Because the recent window is a suffix of the transcript and retrieval only
considers the prefix before it, the two pools are **disjoint by construction**.

## Lexical + semantic ranking

Each retrieval candidate is scored with the same ingredients the memory system
uses (Phase 0.6A-0.6D):

```
score = (semantic * 0.6 + lexical * 0.4) / 1.0
```

- **Lexical** — token overlap against the request, via `lexicalOverlap`
  (the shared helper extracted into `src/memory/hybridRanking.ts`; memory and
  transcript text are now tokenized and matched identically). Deterministic.
- **Semantic** — cosine similarity between embeddings of the request and the
  candidate. Produced by the injected `semanticScorer`, which the engine wraps
  around the process-wide `EmbeddingManager`:
  - participates **only when `hasRealEmbeddings()` is true** (i.e. a real
    provider, never `deterministic-test`);
  - one batched call per turn (`generateEmbeddingsBatch`), race-safe;
  - a candidate vector is only scored when its dimension matches the query
    vector — **cross-dimension similarity never happens**;
  - `undefined`/failed/malformed embeddings contribute score `0`.
- Ranking is stable and deterministic: highest score first, then most recent,
  then original chronological order.

Result: an earlier "I'm building a presentation about cybersecurity" is pulled
back in when the user later asks "what points should I put in the
presentation?" — even though it is far outside the recent window.

## Deduplication

A message already present in the recent window **cannot be injected a second
time** by retrieval: the recent block is a transcript suffix and retrieval only
ranks the prefix before it, so *no* message is eligible for both pools. The
final context simply concatenates `[retrieved (oldest→newest)] ++
[recent (oldest→newest)]`; every message id appears at most once.

## Token budgeting

The conversation window has its own constant budget — **`MAX_CONVERSATION_CONTEXT_TOKENS`
= 1600** — entirely separate from `MemoryContextManager`'s 800-token memory
snippet (each is spent against its own pool; the engine combines the small
memory snippet with this conversation window when it builds provider
messages).

Costs reuse the memory system's `estimateTokens` (≈ 4 chars/token, plus 1 token
of framing/newline per message). Selection is deterministic and greedy:

- the recent tail consumes budget first (newest messages win);
- remaining budget is spent on the best-ranked retrieved messages;
- a candidate that does not fit is **skipped**, not stretched;
- an individual message larger than the whole budget is **omitted entirely**
  (never truncated, never throws) — a single oversized message cannot push the
  window past its cap.

## Fallback / error behavior

- No semantic provider configured, or provider id `deterministic-test` →
  `hasRealEmbeddings()` is false → the scorer yields no vectors → ranking is
  lexical-only (this is the default, and what all deterministic tests run on).
  The deterministic provider **never** masquerades as semantic understanding.
- Scorer throws, returns a wrong-length result, or returns all-`undefined` →
  caught, logged, lexical-only fallback.
- Empty transcript / single message / no relevant older messages / request with
  no lexical overlap → the recent window is returned (or an empty context when
  there is nothing), **never** an exception.

## Relationship to MemoryContextManager

| | MemoryContextManager (0.7/0.8) | ConversationContextManager (0.9) |
| --- | --- | --- |
| Ranks | stored `MemoryItem`s | transcript `ConversationMessage`s |
| Search input | injected `search` (hybrid, vector store) | injected `semanticScorer` + shared lexical |
| Budget | `MAX_MEMORY_CONTEXT_TOKENS` 800 | `MAX_CONVERSATION_CONTEXT_TOKENS` 1600 |
| Output | tagged memory snippet line(s) | ordered provider transcript |

They are deliberately separate modules sharing only utilities (`estimateTokens`,
`lexicalOverlap`, `cosineSimilarity`). The engine builds the provider prompt as
`system prompt → memory snippet` + the selected conversation messages.

## Files

```
src/engine/conversationContextManager.ts   manager + scoring + selection core
src/engine/context.ts                      backward-compatible buildContextWindow facade
src/engine/AssistantEngine.ts              wired into process() per turn
src/memory/hybridRanking.ts                + lexicalOverlap shared helper
src/engine/conversationContextManager.test.ts
```

## API compatibility

`buildContextWindow(messages, max)` keeps its original synchronous signature and
meaning (a recency slice). An optional third argument `{ maxTokens }` budgets
the slice. The full retrieval pipeline is exposed as
`ConversationContextManager.build()`; the engine uses it, and it is also
re-exported from `src/engine/index.ts`.

## Configuration

No environment variables were added. The budget, window size, candidate cap and
weights are code constants with manager setters (`setRecentCount`,
`setMaxTokens`, `setCandidateLimit`, `setWeights`) so test configuration stays
injectable and deterministic.

## Limitations

- Retrieval candidates are bounded to the most recent `candidateLimit` (40)
  older messages; the deep past of a very long transcript is not scanned.
- Orthogonal real-provider vectors score `0` → normalized similarity `0.5`
  (same convention as `semanticScore` in the memory hybrid), so with a real
  provider, unrelated messages can receive a small baseline boost.
- The window is regenerated fresh each turn; there is no persistent transcript
  index or summarization layer.

## Future improvements

- Summarization of older segments when relevance is ambiguous (the remaining
  "later phases upgrade this" seam is now the summarization direction).
- Persistent transcript embedding index reusing the Phase 0.6D vector store.
- Auto-generated episode/topic titles so the UI can label discussions.
- Tunable recency-vs-relevance decay backed by the hybrid ranking weights.

## Verification summary

- `npm run test` — full suite green (prior 0.6A-0.8 behavior unchanged).
- `npx tsc -p tsconfig.app.json --noEmit` — clean.
- `npm run lint` (oxlint) — 0 warnings / 0 errors.
- `npm run build` — succeeds.

Related docs: [`docs/episode-recall.md`](episode-recall.md),
[`docs/memory-lifecycle.md`](memory-lifecycle.md),
[`docs/vector-store.md`](vector-store.md), [`docs/embeddings.md`](embeddings.md),
[`docs/agent-architecture.md`](agent-architecture.md) (Phase 1.0 agent core).