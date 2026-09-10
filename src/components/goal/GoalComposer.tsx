import { useState, type KeyboardEvent } from 'react'
import { useJarvisStore } from '../../state/jarvis.store'
import type { GoalMode } from '../../state/goalRun'

interface Props {
  /** True while a goal run is active — input disabled, Stop stays available. */
  busy?: boolean
  cancelVisible: boolean
  onSubmit: (text: string) => void
  onCancel: () => void
}

/**
 * Phase 2.1 — text composer with an explicit ASK/GOAL mode.
 *
 * Presentation-only mode: BOTH modes call the SAME single engine entry point
 * (`submit` → `engine.process(text)`). The mode never reaches the engine, so a
 * mis-click can't change execution semantics — it only tunes the placeholder
 * and how the Goal panel is highlighted.
 */
export function GoalComposer({ busy = false, cancelVisible, onSubmit, onCancel }: Props) {
  const mode = useJarvisStore.use.goalMode()
  const [value, setValue] = useState('')

  const submit = () => {
    const text = value.trim()
    if (!text || busy) return
    useJarvisStore.getState().setLastUser(text)
    onSubmit(text)
    setValue('')
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      setValue('')
    }
  }

  const modeLabel = (m: GoalMode) => (m === 'goal' ? 'GOAL' : 'ASK')

  return (
    <div className="goal-composer">
      <div className="goal-mode" role="group" aria-label="Input mode">
        <button
          type="button"
          className={`goal-mode-btn${mode === 'ask' ? ' is-active' : ''}`}
          aria-pressed={mode === 'ask'}
          onClick={() => useJarvisStore.getState().setGoalMode('ask')}
        >
          ASK
        </button>
        <button
          type="button"
          className={`goal-mode-btn${mode === 'goal' ? ' is-active' : ''}`}
          aria-pressed={mode === 'goal'}
          onClick={() => useJarvisStore.getState().setGoalMode('goal')}
        >
          GOAL
        </button>
      </div>

      <input
        className="goal-input"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        aria-label={modeLabel(mode) === 'GOAL' ? 'Describe the goal' : 'Ask a question'}
        placeholder={mode === 'goal' ? 'Describe the goal…' : 'Ask me something…'}
        disabled={busy}
        enterKeyHint="send"
        autoComplete="off"
        spellCheck={false}
      />

      <button
        type="button"
        className="goal-submit"
        onClick={submit}
        disabled={busy || !value.trim()}
        aria-label="Send message"
      >
        Send
      </button>

      {cancelVisible && (
        <button type="button" className="goal-cancel" onClick={onCancel} aria-label="Stop the running goal">
          Stop
        </button>
      )}
    </div>
  )
}