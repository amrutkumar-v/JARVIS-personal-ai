import type { Capabilities } from '../../types/capabilities'
import type { CameraUiState, BackendUiState } from '../../state/jarvis.store'

interface Props {
  capabilities: Capabilities
  camera: CameraUiState
  backend?: BackendUiState
}

function chip(label: string, on: boolean, detail?: string): { label: string; on: boolean; detail?: string } {
  return { label, on, detail }
}

/**
 * Phase 2.7 — live runtime connectivity readout. Built ONLY from the engine's
 * real capability probes and the real camera state; never from claims. It lets
 * the user see exactly which real surfaces are connected this session.
 *
 * Phase 2.8 — the CORE chip reflects the backend connection phase, so a
 * dropped stream is visible immediately instead of being silently glossed.
 */
export function ConnectivityStrip({ capabilities, camera, backend }: Props) {
  const backendOn = backend?.phase === 'connected'
  const backendDetail = backend
    ? backend.phase === 'connected'
      ? `${backend.devices.length} device${backend.devices.length === 1 ? '' : 's'}`
      : backend.phase === 'waiting' || backend.phase === 'connecting'
        ? 'reconnecting'
        : backend.phase === 'giving_up'
          ? 'unavailable'
          : undefined
    : undefined

  const items = [
    chip('AI', capabilities.aiConnected, capabilities.aiConfigured ? 'configured' : undefined),
    chip('PC CONTROL', capabilities.nativeAgentAvailable, capabilities.nativeDesktopInteractionAvailable ? 'input+apps' : 'agent'),
    chip('FILES', capabilities.nativeAgentAvailable || capabilities.fileSystemAvailable),
    chip('CORE', backendOn, backendDetail),
    chip(
      'CAMERA',
      camera.available,
      camera.active ? 'live' : camera.permission !== 'unknown' ? camera.permission : undefined,
    ),
    chip('VISION', capabilities.visionAvailable),
    chip('WEB', capabilities.webAccessAvailable),
  ]

  return (
    <div className="connectivity-strip" role="status" aria-label="Runtime connectivity">
      {items.map((item) => (
        <span
          key={item.label}
          className={`connectivity-chip${item.on ? ' is-on' : ''}`}
          title={item.on ? `${item.label} connected` : `${item.label} unavailable`}
        >
          <span className="connectivity-dot" aria-hidden="true" />
          {item.label}
          {item.detail ? <span className="connectivity-detail">{item.detail}</span> : null}
        </span>
      ))}
    </div>
  )
}