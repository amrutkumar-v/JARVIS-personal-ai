import { create } from 'zustand'
import type { ConversationMessage, ConversationState } from '../conversation/types'
import { loadConversation, persistConversation, clearStoredConversation } from '../conversation/storage'

interface ConversationSlice {
  conversation: ConversationState
  addMessage: (msg: ConversationMessage) => void
  /** Persist the current thread to local storage (called after writes). */
  flush: () => void
  clearConversation: () => void
}

function initialState(): ConversationState {
  const loaded = loadConversation()
  return {
    id: loaded.id,
    createdAt: loaded.createdAt,
    messages: loaded.messages,
    lastId: loaded.messages.length ? loaded.messages[loaded.messages.length - 1].id : null,
    count: loaded.messages.length,
  }
}

export const useConversationStore = create<ConversationSlice>()((set, get) => ({
  conversation: initialState(),
  addMessage: (msg) =>
    set((s) => {
      const messages = [...s.conversation.messages, msg]
      return {
        conversation: {
          ...s.conversation,
          messages,
          lastId: msg.id,
          count: messages.length,
        },
      }
    }),
  flush: () => {
    const st = get().conversation
    persistConversation({ id: st.id, createdAt: st.createdAt, messages: st.messages })
  },
  clearConversation: () => {
    clearStoredConversation()
    const fresh = loadConversation()
    set({
      conversation: {
        id: fresh.id,
        createdAt: fresh.createdAt,
        messages: [],
        lastId: null,
        count: 0,
      },
    })
  },
}))
