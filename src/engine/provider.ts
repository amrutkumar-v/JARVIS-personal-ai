import type { ConversationMessage } from '../conversation/types'
import type { EngineOutMessage } from './contracts'

export interface ToolRun {
  id: string
  toolId: string
  status: 'running' | 'success' | 'error' | 'rejected'
  detail?: string
}

/** JSON-schema-flavoured input contract the AI uses to call a tool. */
export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, { type: string; description?: string }>
  required?: string[]
}

/** Serializable tool definition handed to providers (OpenAI `tools`). */
export interface ToolDefinition {
  id: string
  description: string
  parameters: ToolInputSchema
}

/** One assistant tool call captured inside a turn. */
export interface ToolCallRecord {
  id: string
  toolId: string
  payload: Record<string, unknown>
}

/** Result of one executed tool call, fed back to the provider. */
export interface ToolResultRecord {
  callId: string
  toolId: string
  ok: boolean
  message: string
  data?: unknown
}

/** Provider-facing conversation message (multistep tool rounds included). */
export type AIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCallRecord[] }
  | { role: 'tool'; callId: string; toolId: string; content: string }

export interface AIRequest {
  /** Prompt text (user half of the latest exchange). */
  prompt: string
  /** Full provider-ready conversation (system + history + current utterance). */
  messages: AIMessage[]
  /** Recency-window context for the model. */
  context: ConversationMessage[]
  /** Tools the provider may request (namespace:name). */
  availableTools: string[]
  /** Structured tool definitions the provider can call. */
  toolDefinitions: ToolDefinition[]
  /** Signals a fresh session (no relevance needed). */
  isNewSession: boolean
}

export interface AIResponse {
  /** Final text. Empty while the provider requested tool work only. */
  text: string
  /** Structured tool calls the AI requested — the engine executes then loops. */
  toolRequests?: ToolRequest[]
}

export interface ToolRequest {
  toolId: string
  payload: Record<string, unknown>
}

/** Optional, cheap provider facts surfaced in settings. */
export interface AIProviderInfo {
  model?: string
  baseUrl?: string
}

/**
 * A model provider. Implementations live behind this interface so the
 * application stays decoupled from any single AI vendor.
 */
export interface AIProvider {
  readonly id: string
  /** Human label shown in settings. */
  readonly label: string
  /** Sent directly to the transcript. */
  generate(request: AIRequest, emit: (m: EngineOutMessage) => void): Promise<AIResponse>
  /** Whether this provider is configured enough to answer. */
  isConfigured(): boolean
  /** Whether the provider believes it can answer right now. */
  isReachable(): Promise<boolean>
  /** Optional stable info for the settings panel. */
  describe?(): AIProviderInfo
}

export type { EngineOutMessage } from './contracts'