import type { Tool, ToolContext, ToolInput, ToolResult, ToolPermission, ToolCategory } from './Tool'
import type { MemoryItem, MemoryType } from '../memory/MemoryManager'
import { classifyFact, isMemorableInput, looksLikeCredential, normalizeFact } from '../memory/detect'
import { episodeIdOf } from '../memory/episodes'

export type MemoryAction =
  | 'remember'
  | 'recall'
  | 'search_memory'
  | 'list_memory'
  | 'forget'
  | 'clear'
  | 'save'
  | 'search'
  | 'list'
  | 'episodes'
  | 'episode_memories'
  | 'archive'
  | 'restore'

const ACTION_ALIASES: Record<string, MemoryAction> = {
  save: 'remember',
  search: 'search_memory',
  list: 'list_memory',
}

const ALLOWED_TYPES: MemoryType[] = ['PROFILE', 'PREFERENCE', 'FACT', 'NOTE']

function parseType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined
  const up = raw.toUpperCase()
  return ALLOWED_TYPES.includes(up as MemoryType) ? (up as MemoryType) : undefined
}

/**
 * JARVIS memory tool — structured long-term memory through MemoryManager.
 *
 * The LLM chooses when to remember / recall / search / list / forget / clear.
 * Performs structured operations; the engine gates destructive "clear"
 * behind user confirmation. Recall uses hybrid relevance (semantic
 * embeddings when a real provider is configured, lexical otherwise).
 * Remember runs semantic-aware deduplication (real providers only) behind
 * the deterministic lexical/exact match.
 */
export class NotesTool implements Tool {
  readonly id = 'notes'
  readonly category: ToolCategory = 'memory'
  readonly name = 'Personal memory'
  readonly description =
    'Structured long-term memory. action "remember" stores a durable fact (optionally with a type: PROFILE|PREFERENCE|FACT|NOTE and importance 0..1); ' +
    '"recall" retrieves the most relevant stored memories for a query (deterministic local relevance, not semantic memory); ' +
    '"search_memory" is an alias of recall with a min-relevance and limit; ' +
    '"list_memory" returns all stored memories (optionally filtered by type); ' +
    '"episodes" lists the conversation sessions that wrote memories; ' +
    '"episode_memories" returns the active memories captured in a given session (episode_id); ' +
    '"archive" lists recoverable archived memories (optionally filtered by episode_id for recalling what a session produced); ' +
    '"restore" moves one archived memory (id) back into the active set; ' +
    '"forget" removes memories whose stored content matches a query term; ' +
    '"clear" deletes ALL stored memories (requires user confirmation in the UI).'
  readonly permission: ToolPermission = 'low_risk'
  readonly requiresPermission = false
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        description:
          'One of: remember | recall | search_memory | list_memory | episodes | episode_memories | archive | restore | forget | clear.',
      },
      text: {
        type: 'string',
        description: 'Content to store when action is "remember".',
      },
      type: {
        type: 'string',
        description: 'Memory type when remembering: PROFILE | PREFERENCE | FACT | NOTE (optional).',
      },
      importance: {
        type: 'number',
        description: 'Relevance weight 0..1 (optional, defaults to auto).',
      },
      query: {
        type: 'string',
        description: 'Keywords to search for when recalling/forgetting.',
      },
      episode_id: {
        type: 'string',
        description: 'Session episode id for episode_memories / archive filtering.',
      },
      id: {
        type: 'string',
        description: 'Archived memory id to restore when action is "restore".',
      },
    },
    required: ['action'],
  }

  canRun(query: string): boolean {
    return /\b(remember|recall|forget|memory|memor(?:y|ies)|session|episode|archive|archived|restore|what do you know|what (?:is|are) my)\b/i.test(query)
  }

  async execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult> {
    const memory = ctx.memory
    if (!memory) {
      return { ok: false, message: 'The memory store is not available right now.' }
    }

    const action = ACTION_ALIASES[String(input.params.action ?? '').trim().toLowerCase()] ?? String(input.params.action ?? '').trim().toLowerCase()
    if (!action || !['remember', 'recall', 'search_memory', 'list_memory', 'episodes', 'episode_memories', 'archive', 'restore', 'forget', 'clear'].includes(action)) {
      return {
        ok: false,
        message: 'Unknown memory action. Use remember, recall, search_memory, list_memory, episodes, episode_memories, archive, restore, forget or clear.',
      }
    }

    if (action === 'remember') {
      return this.doRemember(memory, input)
    }
    if (action === 'recall' || action === 'search_memory') {
      return this.doRecall(memory, input, action)
    }
    if (action === 'list_memory') {
      return this.doList(memory, input)
    }
    if (action === 'episodes') {
      return this.doEpisodes(memory)
    }
    if (action === 'episode_memories') {
      return this.doEpisodeMemories(memory, input)
    }
    if (action === 'archive') {
      return this.doArchive(memory, input)
    }
    if (action === 'restore') {
      return this.doRestore(memory, input)
    }
    if (action === 'forget') {
      return this.doForget(memory, input)
    }
    return this.doClear(memory)
  }

  private async doRemember(
    memory: NonNullable<ToolContext['memory']>,
    input: ToolInput,
  ): Promise<ToolResult> {
    const raw = String(input.params.text ?? input.query ?? '').trim()
    if (!isMemorableInput(raw)) {
      return { ok: false, message: 'Nothing durable to remember in that.' }
    }

    const explicitType = parseType(input.params.type)
    const draft = classifyFact(normalizeFact(raw))
    const type = explicitType ?? draft.type
    const importance = Number.isFinite(Number(input.params.importance)) ? Number(input.params.importance) : draft.importance

    if (looksLikeCredential(raw)) {
      return {
        ok: false,
        message:
          'I cannot store what looks like a password, API key, token or other credential in memory.',
      }
    }

    const result = await memory.rememberSemantic(draft.content, { type, importance, source: 'user' })
    if (result.deduplicated) {
      return {
        ok: true,
        message: `Already on file — that matches an existing memory (${type.toLowerCase()}): "${result.item.content}".`,
        data: { item: result.item, deduplicated: result.deduplicated },
      }
    }
    if (!result.created) {
      return {
        ok: true,
        message: `Updated existing ${type.toLowerCase()} memory — "${result.item.content}".`,
        data: { item: result.item },
      }
    }
    return {
      ok: true,
      message: `Remembered — ${type.toLowerCase()}: "${result.item.content}".`,
      data: { item: result.item },
    }
  }

  private async doRecall(memory: NonNullable<ToolContext['memory']>, input: ToolInput, action: string): Promise<ToolResult> {
    const query = String(input.params.query ?? input.query ?? '').trim()
    const opts: { limit?: number; minScore?: number } = {}
    if (action === 'search_memory') {
      const limit = Number(input.params.limit)
      if (Number.isFinite(limit) && limit > 0) opts.limit = Math.min(20, Math.floor(limit))
      const minScore = Number(input.params.min_score ?? input.params.minScore)
      if (Number.isFinite(minScore) && minScore > 0) opts.minScore = minScore
    }
    const hits = await memory.search(query, opts)
    if (!hits.length) {
      return {
        ok: true,
        message: 'Nothing stored matches that. Ask me to remember it first.',
        data: { notes: [] },
      }
    }
    const excerpt = hits.slice(0, 3).map((h) => `"${h.item.content}"`).join(', ')
    return {
      ok: true,
      message: `On file: ${excerpt}.`,
      data: { items: hits.map((h) => ({ ...h.item, _score: h.score })) },
    }
  }

  private doList(memory: NonNullable<ToolContext['memory']>, input: ToolInput): ToolResult {
    const type = parseType(input.params.type)
    const all = memory.items()
    const items = type ? all.filter((m) => m.type === type) : all
    if (!items.length) {
      return { ok: true, message: 'Nothing stored in memory yet.', data: { items: [] } }
    }
    return {
      ok: true,
      message: `${items.length} saved item(s).`,
      data: { items },
    }
  }

  /** Session episodes that wrote memories, newest first, with live counts. */
  private doEpisodes(memory: NonNullable<ToolContext['memory']>): ToolResult {
    const episodes = memory.episodes()
    if (!episodes.length) {
      return { ok: true, message: 'No sessions have recorded memories yet.', data: { episodes: [] } }
    }
    const excerpt = episodes
      .slice(0, 3)
      .map((e) => `${formatEpisode(e.id, e.title)} (${e.itemCount} item${e.itemCount === 1 ? '' : 's'})`)
      .join(', ')
    return {
      ok: true,
      message: `${episodes.length} session${episodes.length === 1 ? '' : 's'}: ${excerpt}.`,
      data: { episodes },
    }
  }

  /** Active memories captured within a specific session episode. */
  private doEpisodeMemories(memory: NonNullable<ToolContext['memory']>, input: ToolInput): ToolResult {
    const id = String(input.params.episode_id ?? input.params.episodeId ?? '').trim()
    if (!id) {
      return { ok: false, message: 'Which session? Provide the episode_id to recall.' }
    }
    const items = memory.episodeMemories(id)
    if (!items.length) {
      return { ok: true, message: 'Nothing active was stored in that session.', data: { episodeId: id, items: [] } }
    }
    const excerpt = items
      .slice(0, 3)
      .map((m) => `"${m.content}"`)
      .join(', ')
    return {
      ok: true,
      message: `${items.length} memory item(s) from that session: ${excerpt}.`,
      data: { episodeId: id, items },
    }
  }

  /** Recoverable archived memories; optionally narrowed to one session. */
  private doArchive(memory: NonNullable<ToolContext['memory']>, input: ToolInput): ToolResult {
    const id = String(input.params.episode_id ?? input.params.episodeId ?? '').trim()
    const all = memory.archivedItems()
    const items = id ? all.filter((a) => episodeIdOf(a) === id) : all
    if (!items.length) {
      return {
        ok: true,
        message: id
          ? 'No archived memories from that session.'
          : 'The archive is empty — nothing has been consolidated away yet.',
        data: { items: [] },
      }
    }
    const excerpt = items
      .slice(0, 3)
      .map((a) => `"${a.content}"`)
      .join(', ')
    return {
      ok: true,
      message: `${items.length} archived item${items.length === 1 ? '' : 's'}: ${excerpt}.`,
      data: { items },
    }
  }

  /** Restore a single archived memory back into the active set (recoverable). */
  private doRestore(memory: NonNullable<ToolContext['memory']>, input: ToolInput): ToolResult {
    const id = String(input.params.id ?? '').trim()
    if (!id) {
      return { ok: false, message: 'Restore which archived memory? Provide its id.' }
    }
    if (!memory.restoreMemory(id)) {
      return { ok: false, message: 'No archived memory has that id.' }
    }
    return { ok: true, message: 'Restored that memory from the archive.', data: { restoredId: id } }
  }

  private doForget(memory: NonNullable<ToolContext['memory']>, input: ToolInput): ToolResult {
    const query = String(input.params.query ?? input.query ?? '').trim()
    if (!query) {
      return { ok: false, message: 'Forget what? Provide the memory to remove.' }
    }
    const removed = memory.removeMatching(query)
    if (!removed) {
      return { ok: true, message: 'Nothing stored matched that, so nothing was removed.' }
    }
    return { ok: true, message: `Removed ${removed} matching memory item(s).` }
  }

  private doClear(memory: NonNullable<ToolContext['memory']>): ToolResult {
    memory.clear()
    return { ok: true, message: 'All memories have been cleared.' }
  }
}

export type { MemoryItem }

/** Compact, token-safe label for a session episode in tool responses. */
function formatEpisode(id: string, title?: string): string {
  return title?.trim() ? title.trim() : `session ${id.slice(0, 8)}`
}
