import { useMemo } from 'react'
import { useJarvisStore } from '../../state/jarvis.store'
import type { DeviceRecord } from '../../backend/types'

/**
 * Phase 8 — Device topology visualization.
 *
 * Renders the JARVIS network as a compact topological diagram:
 *   JARVIS CORE at centre, connected device nodes radiating outward.
 * Every value is REAL — online/offline, battery, latency, last heartbeat.
 * No fabricated status.
 */

interface TopoNode {
  id: string
  name: string
  role: string
  online: boolean
  battery: number | null
  charging: boolean
  latency: string
  lastHeartbeat: string | null
  health: string
}

function roleShort(role: string | undefined): string {
  switch (role) {
    case 'primary_pc': return 'MAIN PC'
    case 'secondary_pc': return 'DUAL PC'
    case 'primary_phone': return 'PHONE'
    case 'secondary_phone': return 'PHONE 2'
    default: return 'NODE'
  }
}

function heartbeatLabel(ts: number | null): string | null {
  if (ts == null) return null
  const diff = Date.now() - ts
  if (diff < 5_000) return 'now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  return `${Math.floor(diff / 3_600_000)}h`
}

// Angles for device placement around the core (top = 0°). Radial placement is
// decorative; every value inside a node is real device data.
function placement(index: number, total: number): { x: number; y: number } {
  if (total <= 1) return { x: 50, y: 20 }
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2
  // Elliptical orbit: wide horizontally, slightly narrower vertically
  const cx = 50
  const cy = 50
  const rx = 39
  const ry = 36
  return {
    x: cx + Math.cos(angle) * rx,
    y: cy + Math.sin(angle) * ry,
  }
}

export function DeviceTopology() {
  const backend = useJarvisStore.use.backend()
  const connected = backend.phase === 'connected'

  const nodes = useMemo<TopoNode[]>(() => {
    return backend.devices.map((d: DeviceRecord) => ({
      id: d.id,
      name: d.name || d.id,
      role: d.role ?? '',
      online: d.online,
      battery: d.battery ?? null,
      charging: d.charging ?? false,
      latency: d.network ?? '',
      lastHeartbeat: heartbeatLabel(d.lastHeartbeatAt),
      health: d.health,
    }))
  }, [backend.devices])

  const onlineCount = nodes.filter((n) => n.online).length
  const totalCount = nodes.length

  return (
    <section className="device-topology" aria-label="Device topology">
      <header className="device-topo-head">
        <span className="device-topo-title">TOPOLOGY</span>
        <span className={`device-topo-core${connected ? ' is-online' : ''}`}>
          <span className="device-topo-dot" aria-hidden="true" />
          CORE
        </span>
        {totalCount > 0 ? (
          <span className="device-topo-count">{onlineCount}/{totalCount}</span>
        ) : null}
      </header>

      <div className="device-topo-graph" role="list" aria-label="Device nodes">
        {/* Connection lines (decorative geometry under the nodes) */}
        <svg className="device-topo-lines" aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none">
          {nodes.map((node, i) => {
            const p = placement(i, nodes.length)
            return (
              <line
                key={`link-${node.id}`}
                x1="50"
                y1="50"
                x2={p.x}
                y2={p.y}
                className={`device-topo-link${node.online ? ' is-online' : ''}`}
              />
            )
          })}
        </svg>

        {/* Central core node */}
        <div className="device-topo-center" aria-hidden="true">
          <div className={`device-topo-core-node${connected ? ' is-online' : ''}`}>
            <span className="device-topo-core-pulse" />
            <span className="device-topo-core-label">J</span>
          </div>
        </div>

        {/* Device nodes */}
        {nodes.map((node, i) => {
          const p = placement(i, nodes.length)
          return (
            <div
              key={node.id}
              className={`device-topo-node${node.online ? ' is-online' : ''}`}
              style={{ left: `${p.x}%`, top: `${p.y}%` }}
              role="listitem"
              aria-label={`${node.name}: ${node.online ? 'online' : 'offline'}`}
            >
              <div className="device-topo-node-dot" aria-hidden="true">
                <span className={`device-topo-node-ring${node.online ? ' is-pulsing' : ''}`} />
              </div>
              <div className="device-topo-node-info">
                <span className="device-topo-node-name">{node.name}</span>
                <span className="device-topo-node-role">{roleShort(node.role)}</span>
                <span className="device-topo-node-status" data-on={node.online}>
                  {node.online ? 'ONLINE' : 'OFFLINE'}
                </span>
                {node.battery != null ? (
                  <span className="device-topo-node-battery">
                    {node.battery}%{node.charging ? ' \u26a1' : ''}
                  </span>
                ) : (
                  <span className="device-topo-node-battery is-na">N/A</span>
                )}
                {node.latency ? (
                  <span className="device-topo-node-latency">{node.latency}</span>
                ) : (
                  <span className="device-topo-node-latency is-na">N/A</span>
                )}
                {node.lastHeartbeat ? (
                  <span className="device-topo-node-hb">{node.lastHeartbeat}</span>
                ) : (
                  <span className="device-topo-node-hb is-na">N/A</span>
                )}
              </div>
            </div>
          )
        })}

        {nodes.length === 0 && (
          <p className="device-topo-empty">
            No devices registered. The device registry appears once the backend
            SSE stream is live.
          </p>
        )}
      </div>
    </section>
  )
}