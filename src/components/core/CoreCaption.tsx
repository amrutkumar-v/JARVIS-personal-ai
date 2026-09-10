import type { CSSProperties } from 'react'
import { APP } from '../../config/app'
import { useJarvisStore } from '../../state/jarvis.store'

/**
 * Overlay caption above the core: wordmark, greeting and the living line
 * (interim speech or the last assistant reply).
 */
export function CoreCaption() {
  const interim = useJarvisStore.use.interimText()
  const lastAssistant = useJarvisStore.use.lastAssistantText()
  const listening = useJarvisStore.use.isRecognizing()

  const line = interim || lastAssistant || APP.coreLine

  return (
    <div className="core-caption">
      <h1 className="core-title">
        {APP.name.split('').map((c, i) => (
          <span key={i} style={{ '--i': i } as CSSProperties}>{c}</span>
        ))}
      </h1>
      <p className={`core-line${listening ? ' is-listening' : ''}`}>
        {listening ? `“${interim || '…'}”` : line}
      </p>
    </div>
  )
}