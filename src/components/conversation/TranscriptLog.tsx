import { useConversationStore } from '../../state/conversation.store'
import type { ConversationMessage } from '../../conversation/types'

export function TranscriptLog() {
  const messages = useConversationStore((s) => s.conversation.messages)

  return (
    <section className="panel transcript-panel" aria-label="Session transcript">
      <h2 className="panel-title">SESSION LOG</h2>
      {messages.length === 0 ? (
        <p className="panel-empty">Silence so far. Say something.</p>
      ) : (
        <ol className="log-list">
          {messages.slice(-10).map((m) => (
            <LogMessage key={m.id} message={m} />
          ))}
        </ol>
      )}
    </section>
  )
}

function LogMessage({ message }: { message: ConversationMessage }) {
  const actor = message.actor
  return (
    <li className={`log-item log-${actor}`}>
      <span className="log-actor">{actor === 'user' ? 'YOU' : actor === 'assistant' ? 'JARVIS' : 'SYS'}</span>
      <span className="log-text">{message.text}</span>
    </li>
  )
}