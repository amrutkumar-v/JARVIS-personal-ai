import { usePanelLayoutStore } from '../../panel/panelStore'
import { ENVIRONMENTS } from '../../panel/registry'

export function EnvironmentPanel() {
  const environmentId = usePanelLayoutStore((s) => s.environmentId)
  const setEnvironment = usePanelLayoutStore((s) => s.setEnvironment)

  return (
    <section className="panel env-panel" aria-label="Environments">
      <h2 className="panel-title">ENVIRONMENTS</h2>
      <ul className="env-list">
        {ENVIRONMENTS.map((env) => (
          <li key={env.id}>
            <button
              type="button"
              className={`env-option${environmentId === env.id ? ' is-active' : ''}`}
              disabled={env.status === 'planned'}
              onClick={() => setEnvironment(env.id)}
            >
              <span className="env-dot" aria-hidden="true" />
              <span className="env-label">{env.label}</span>
              {env.status === 'planned' ? (
                <span className="env-badge">PLANNED</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
