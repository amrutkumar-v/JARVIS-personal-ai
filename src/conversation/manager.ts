import { useConversationStore } from '../state/conversation.store'
import type { ConversationMessage } from './types'

let counter = 0

function nextId(actor: ConversationMessage['actor']): string {
  counter += 1
  return `${actor}-${Date.now().toString(36)}-${counter}`
}

export function createMessage(
  actor: ConversationMessage['actor'],
  text: string,
  extra: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id: extra.id ?? nextId(actor),
    actor,
    text,
    createdAt: extra.createdAt ?? new Date().toISOString(),
    activityId: extra.activityId,
  }
}

export function addUserMessage(text: string): ConversationMessage {
  const msg = createMessage('user', text)
  useConversationStore.getState().addMessage(msg)
  useConversationStore.getState().flush()
  return msg
}

export function addAssistantMessage(text: string): ConversationMessage {
  const msg = createMessage('assistant', text)
  useConversationStore.getState().addMessage(msg)
  useConversationStore.getState().flush()
  return msg
}

export function addSystemMessage(text: string): ConversationMessage {
  const msg = createMessage('system', text)
  useConversationStore.getState().addMessage(msg)
  useConversationStore.getState().flush()
  return msg
}

export function clearConversation(): void {
  useConversationStore.getState().clearConversation()
}

/** Recent messages (newest first) for the UI, capped. */
export function recentMessages(max = 10): ConversationMessage[] {
  const { messages } = useConversationStore.getState().conversation
  return messages.slice(-max).reverse()
}

/** Most recently added non-system message. */
export function lastExchange(): { user?: string; assistant?: string } | null {
  const { messages } = useConversationStore.getState().conversation
  let user: string | undefined
  let assistant: string | undefined
  for (const m of messages) {
    if (m.actor === 'user') user = m.text
    else if (m.actor === 'assistant') assistant = m.text
  }
  if (!user && !assistant) return null
  return { user, assistant }
}