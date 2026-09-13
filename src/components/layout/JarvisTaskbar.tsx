import { useState } from 'react'
import { usePanelLayoutStore } from '../../panel/panelStore'
import { TASKBAR_ITEMS } from '../../panel/registry'
import { useEnvironmentActions } from '../../environment/useEnvironmentActions'
import { ENVIRONMENT_BY_ID, DEFAULT_ENVIRONMENT } from '../../environment/registry'
import { isEnvironmentId } from '../../environment/registry'

interface Props {
  onOpenSettings: () => void
}

export function JarvisTaskbar({ onOpenSettings }: Props) {
  const panels = usePanelLayoutStore((s) => s.panels)
  const togglePanel = usePanelLayoutStore((s) => s.togglePanel)
  const focusPanel = usePanelLayoutStore((s) => s.focusPanel)
  const resetLayout = usePanelLayoutStore((s) => s.resetLayout)
  const environmentId = usePanelLayoutStore((s) => s.environmentId)
  const actions = useEnvironmentActions()
  const [envOpen, setEnvOpen] = useState(false)
  const currentDef = isEnvironmentId(environmentId)
    ? ENVIRONMENT_BY_ID.get(environmentId)
    : ENVIRONMENT_BY_ID.get(DEFAULT_ENVIRONMENT)

  return (
    <nav className="jarvis-taskbar" aria-label="Panel controls">
      <div className="taskbar-brand" aria-hidden="true">
        <span className="taskbar-brand-dot" />
      </div>

      <div className="taskbar-env">
        <button
          type="button"
          className={`taskbar-env-btn${envOpen ? ' is-open' : ''}`}
          aria-expanded={envOpen}
          aria-haspopup="listbox"
          aria-label="Environment"
          onClick={() => setEnvOpen((prev) => !prev)}
        >
          <span aria-hidden="true">{currentDef?.glyph}</span>
          <span className="taskbar-env-label">{currentDef?.label}</span>
        </button>
        {envOpen ? (
          <div className="taskbar-env-popover" role="listbox" aria-label="Environments">
            {Array.from(ENVIRONMENT_BY_ID.values()).map((def) => (
              <button
                key={def.id}
                type="button"
                className={`taskbar-env-item${environmentId === def.id ? ' is-active' : ''}`}
                role="option"
                aria-selected={environmentId === def.id}
                onClick={() => {
                  actions.selectEnvironment(def.id)
                  setEnvOpen(false)
                }}
              >
                <span className="taskbar-env-glyph" aria-hidden="true">
                  {def.glyph}
                </span>
                {def.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {TASKBAR_ITEMS.map((entry) => {
        const open = panels[entry.id]?.open ?? false
        return (
          <button
            key={entry.id}
            type="button"
            className={`taskbar-btn${open ? ' is-open' : ''}`}
            aria-label={`${open ? 'Close' : 'Open'} ${entry.label}`}
            aria-pressed={open}
            onClick={() => {
              togglePanel(entry.id)
              if (!open) focusPanel(entry.id)
            }}
          >
            <span className="taskbar-icon" aria-hidden="true">
              {entry.icon}
            </span>
          </button>
        )
      })}

      <div className="taskbar-separator" aria-hidden="true" />

      <button
        type="button"
        className="taskbar-btn"
        aria-label="Settings"
        onClick={onOpenSettings}
      >
        <span className="taskbar-icon" aria-hidden="true">
          &#x2699;
        </span>
      </button>

      <button
        type="button"
        className="taskbar-btn"
        aria-label="Reset layout"
        onClick={resetLayout}
      >
        <span className="taskbar-icon" aria-hidden="true">
          &#x21bb;
        </span>
      </button>
    </nav>
  )
}
