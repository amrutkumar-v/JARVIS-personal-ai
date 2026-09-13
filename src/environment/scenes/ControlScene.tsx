import { useMemo } from 'react'
import { useEnvironmentSnapshot } from '../useEnvironmentSnapshot'
import { useEnvironmentActions } from '../useEnvironmentActions'
import { ENVIRONMENT_DEFINITIONS } from '../registry'
import { controlSections } from '../bridge'
import { usePanelLayoutStore } from '../../panel/panelStore'
import type { PanelId } from '../../panel/types'

/**
 * Phase 8 — Command Control environment.
 *
 * A fully DOM-based command surface: every number/state is REAL telemetry
 * from `controlSections(snapshot)`; the environment chips switch live; the
 * launch buttons open real panels. No simulated values — unavailable hardware
 * rows render literally as "Unavailable".
 */

const QUICK_LAUNCH: Array<{ id: PanelId; label: string; glyph: string }> = [
  { id: 'devices', label: 'Devices', glyph: '\u2b22' },
  { id: 'activity', label: 'Activity', glyph: '\u26a1' },
  { id: 'system', label: 'System', glyph: '\u25d0' },
]

export function ControlScene() {
  const snapshot = useEnvironmentSnapshot('control')
  const actions = useEnvironmentActions()
  const environmentId = usePanelLayoutStore((s) => s.environmentId)

  const sections = useMemo(() => controlSections(snapshot), [snapshot])
  const connected = snapshot.backend.phase === 'connected'

  return (
    <div className="control-scene">
      <header className="control-header">
        <div className="control-heading">
          <span className="control-kicker">COMMAND</span>
          <h2 className="control-title">Control Surface</h2>
        </div>
        <div className="control-status" role="status">
          <span
            className={`control-dot${connected ? ' is-online' : ''}`}
          />
          <span>{snapshot.statusLabel}</span>
        </div>
      </header>

      <div className="control-grid">
        {sections.map((section) => (
          <section
            key={section.title}
            className="control-card"
            aria-label={section.title}
          >
            <h3 className="control-card-title">{section.title}</h3>
            <dl className="control-rows">
              {section.rows.map((row) => (
                <div
                  key={row.label}
                  className={`control-row${
                    row.tone === 'err'
                      ? ' is-bad'
                      : row.tone === 'warn'
                        ? ' is-warn'
                        : ''
                  }`}
                >
                  <dt className="control-row-label">{row.label}</dt>
                  <dd className="control-row-value">
                    {row.available ? row.value : 'Unavailable'}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>

      <footer className="control-footer">
        <div className="control-envs" role="group" aria-label="Environment">
          {ENVIRONMENT_DEFINITIONS.map((def) => {
            const active = def.id === environmentId
            return (
              <button
                key={def.id}
                type="button"
                className={`control-env${active ? ' is-active' : ''}`}
                aria-pressed={active}
                onClick={() => actions.selectEnvironment(def.id)}
              >
                <span className="control-env-glyph" aria-hidden="true">
                  {def.glyph}
                </span>
                {def.label}
              </button>
            )
          })}
        </div>
        <div className="control-launch" role="group" aria-label="Launch panels">
          {QUICK_LAUNCH.map((b) => (
            <button
              key={b.id}
              type="button"
              className="control-launch-btn"
              onClick={() => actions.openPanel(b.id)}
            >
              <span aria-hidden="true">{b.glyph}</span>
              {b.label}
            </button>
          ))}
        </div>
      </footer>
    </div>
  )
}