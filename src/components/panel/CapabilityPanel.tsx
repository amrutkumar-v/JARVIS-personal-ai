import type { CapabilityRow } from './capabilityData'

interface Props {
  title: string
  rows: CapabilityRow[]
}

export function CapabilityPanel({ title, rows }: Props) {
  return (
    <section className="panel capability-panel" aria-label={title}>
      <h2 className="panel-title">{title}</h2>
      <ul className="cap-list">
        {rows.map((r) => (
          <li key={r.label} className="cap-row">
            <span className="cap-label" title={r.description}>
              <span
                className={`connectivity-dot${r.on ? ' is-on' : ''}`}
                aria-hidden="true"
              />
              {r.label}
            </span>
            <span className="cap-value" data-tone={r.on ? 'on' : 'off'}>
              {r.detail ?? (r.on ? 'ready' : 'unavailable')}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
