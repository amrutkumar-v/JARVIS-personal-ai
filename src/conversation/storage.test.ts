import { describe, expect, it, beforeEach } from 'vitest'
import {
  persistConversation,
  loadConversation,
  clearStoredConversation,
} from '../conversation/storage'
import type { ConversationMessage, PersistedConversation } from '../conversation/types'

function stubBrowserStorage(): void {
  const backing = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  }
  ;(globalThis as Record<string, unknown>).window = {
    localStorage,
    setTimeout: (_fn: () => void) => 0,
  }
}

function msg(id: string, actor: ConversationMessage['actor'], text: string): ConversationMessage {
  return { id, actor, text, createdAt: new Date().toISOString() }
}

describe('conversation persistence (local storage)', () => {
  beforeEach(() => stubBrowserStorage())

  it('loads a fresh conversation when nothing is stored', () => {
    const conv = loadConversation()
    expect(conv.messages).toEqual([])
    expect(conv.id).toBeTruthy()
    expect(conv.createdAt).toBeTruthy()
  })

  it('persists and reloads messages in order', () => {
    const source: PersistedConversation = {
      id: 'conv-1',
      createdAt: new Date().toISOString(),
      messages: [msg('u1', 'user', 'hello'), msg('a1', 'assistant', 'hi')],
    }
    const saved = persistConversation(source)
    expect(saved.messages).toHaveLength(2)

    const loaded = loadConversation()
    expect(loaded.id).toBe('conv-1')
    expect(loaded.messages.map((m) => m.text)).toEqual(['hello', 'hi'])
  })

  it('trims to the configured limit, oldest first', () => {
    const source: PersistedConversation = {
      id: 'conv-2',
      createdAt: new Date().toISOString(),
      messages: [msg('m1', 'user', 'one'), msg('m2', 'user', 'two'), msg('m3', 'user', 'three')],
    }
    const saved = persistConversation(source, { limit: 2 })
    expect(saved.messages.map((m) => m.text)).toEqual(['two', 'three'])
  })

  it('drops malformed entries on load', () => {
    const source: PersistedConversation = {
      id: 'conv-3',
      createdAt: new Date().toISOString(),
      messages: [msg('ok', 'user', 'fine'), { id: 'x', actor: 'bot', text: 42 } as unknown as ConversationMessage],
    }
    const saved = persistConversation(source)
    expect(saved.messages).toHaveLength(2)

    const loaded = loadConversation()
    expect(loaded.messages).toHaveLength(1)
    expect(loaded.messages[0].text).toBe('fine')
  })

  it('clears stored history', () => {
    persistConversation({
      id: 'conv-4',
      createdAt: new Date().toISOString(),
      messages: [msg('u1', 'user', 'hello')],
    })
    clearStoredConversation()
    expect(loadConversation().messages).toEqual([])
  })
})