import type { BackendUiState } from '../../state/jarvis.store'
import type { DeviceRecord } from '../../backend/types'

interface Props {
  backend: BackendUiState
}

const PHASE_LABEL: Record<string, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  connected: 'Connected',
  waiting: 'Reconnecting…',
  giving_up: 'Unavailable',
}

const ROLE_LABEL: Record<string, string> = {
  primary_pc: 'main PC',
  secondary_pc: 'secondary PC',
  primary_phone: 'main phone',
  secondary_phone: 'second phone',
}

function whenLabel(ts: number | null): string {
  if (ts === null) return '—'
  return new Date(ts).toLocaleTimeString()
}

function deviceSummary(d: DeviceRecord): string {
  const bits: string[] = []
  if (d.online) bits.push('online')
  else bits.push(d.health !== 'ok' ? `offline (${d.health})` : 'offline')
  if (d.connection) bits.push(d.connection)
  if (typeof d.battery === 'number') bits.push(`battery ${d.battery}%${d.charging ? ' 🔌' : ''}`)
  if (d.network) bits.push(d.network)
  if (d.version) bits.push(`agent v${d.version}`)
  if (d.activity) bits.push(d.activity)
  const caps = d.capabilities.length > 0 ? d.capabilities.join(' · ') : undefined
  if (caps) bits.push(caps)
  return bits.join(' · ')
}

/**
 * Phase 2.8 — the always-on JARVIS Core backend readout. Everything on this
 * panel is mirrored from the real SSE stream: the connection phase is the
 * ReconnectController's live phase and the device rows are the backend's
 * registry snapshot. No fabricated states.
 */
export function BackendStatus({ backend }: Props) {
  const { phase, health, devices, lastInboundAt } = backend
  const connected = phase === 'connected'
  const native = health?.native

  return (
    <section className="backend-panel" role="region" aria-label="JARVIS Core backend">
      <div className="backend-panel-head">
        <h4>JARVIS CORE</h4>
        <span className={`phase-badge is-${phase}`} data-tone={connected ? 'on' : 'off'}>
          <span className="connectivity-dot" aria-hidden="true" />
          {PHASE_LABEL[phase] ?? phase}
        </span>
      </div>

      {health ? (
        <ul className="cap-list">
          <li className="cap-row">
            <span className="cap-label">Backend</span>
            <span className="cap-value" data-tone="on">
              {health.name} v{health.version}
            </span>
          </li>
          <li className="cap-row">
            <span className="cap-label">PID</span>
            <span className="cap-value" data-tone="on">
              {health.pid}
            </span>
          </li>
          <li className="cap-row">
            <span className="cap-label">Uptime</span>
            <span className="cap-value" data-tone="on">
              {(health.uptimeMs / 1000).toFixed(0)}s
            </span>
          </li>
          {native ? (
            <li className="cap-row">
              <span className="cap-label">Native agent</span>
              <span className="cap-value" data-tone={native.reachable ? 'on' : 'off'}>
                {native.childRunning ? 'running (backend-supervised)' : native.reachable ? 'reachable' : 'not reachable'}
              </span>
            </li>
          ) : null}
          {health.wake?.browserOnly ? null : (
            <li className="cap-row">
              <span className="cap-label">Wake word</span>
              <span className="cap-value" data-tone="on">
                mirrored to backend
              </span>
            </li>
          )}
          <li className="cap-row">
            <span className="cap-label">Last device message</span>
            <span className="cap-value">{whenLabel(lastInboundAt)}</span>
          </li>
        </ul>
      ) : (
        <p className="memory-empty">
          No health payload yet. The backend mirrors only while its SSE stream is live.
        </p>
      )}

      <h4 className="settings-subhead">TRUSTED DEVICES ({devices.length} of 4)</h4>
      {!health ? (
        <p className="memory-empty">
          No health payload yet. The backend mirrors only while its SSE stream is live.
        </p>
      ) : devices.length === 0 ? (
        <p className="memory-empty">
          Registry not reached yet. Your four trusted devices (main PC, Dell laptop, S26 Ultra, S23 FE) appear here once the JARVIS Core
          status stream is live.
        </p>
      ) : (
        <>
          <p className="memory-empty">
            Main PC (this machine) · Dell laptop · S26 Ultra · S23 FE. Phones/Dell show online only while their companion bridge is
            actively heartbeating.
          </p>
          <ul className="cap-list">
            {devices.map((d) => (
              <li key={d.id} className="cap-row">
                <span className="cap-label">
                  <span className={`connectivity-dot${d.online ? ' is-on' : ''}`} aria-hidden="true" />
                  {d.name || d.id}
                  {d.role && d.role !== 'primary_pc' ? ` · ${ROLE_LABEL[d.role] ?? d.role}` : d.role ? ' · this machine' : ''}
                </span>
                <span className="cap-value" data-tone={d.online ? 'on' : 'off'}>
                  {deviceSummary(d)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}