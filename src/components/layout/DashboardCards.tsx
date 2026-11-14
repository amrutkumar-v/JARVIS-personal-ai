import { usePanelLayoutStore } from '../../panel/panelStore'
import type { CameraUiState, BackendUiState, GestureUiState } from '../../state/jarvis.store'

interface Props {
  status: string
  providerLabel: string
  modelLabel?: string
  endpointLabel?: string
  backend: BackendUiState
  camera: CameraUiState
  gesture: GestureUiState
  task?: {
    active: boolean
    label: string
    step: number
    total: number
    status: string
  }
}

export function DashboardCards({
  status,
  providerLabel,
  modelLabel,
  endpointLabel,
  backend,
  camera,
  gesture,
  task,
}: Props) {
  const openPanel = usePanelLayoutStore((s) => s.openPanel)
  const isConnected = backend.phase === 'connected'

  return (
    <div className="dashboard-cards-grid">
      {/* Card 1: Core Telemetry & Engine */}
      <div className="dashboard-glass-card" onClick={() => openPanel('core')}>
        <div className="dashboard-card-header">
          <div className="dashboard-card-icon-wrap">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </div>
          <div className="dashboard-card-title-group">
            <span className="dashboard-card-category">SYSTEM CORE</span>
            <span className="dashboard-card-title">Neural Engine</span>
          </div>
          <span className={`dashboard-card-status-badge ${isConnected ? 'is-active' : 'is-idle'}`}>
            {isConnected ? 'ONLINE' : 'STANDBY'}
          </span>
        </div>
        <div className="dashboard-card-body">
          <div className="dashboard-stat-row">
            <span className="dashboard-stat-label">Provider</span>
            <span className="dashboard-stat-value">{providerLabel || 'Gemini Pro'}</span>
          </div>
          <div className="dashboard-stat-row">
            <span className="dashboard-stat-label">Model</span>
            <span className="dashboard-stat-value">{modelLabel || 'gemini-2.5-pro'}</span>
          </div>
          <div className="dashboard-stat-row">
            <span className="dashboard-stat-label">Endpoint</span>
            <span className="dashboard-stat-value">{endpointLabel || 'Local Port 8787'}</span>
          </div>
        </div>
        <div className="dashboard-card-footer">
          <span className="dashboard-card-action">Inspect Core &rarr;</span>
        </div>
      </div>

      {/* Card 2: Task Orchestrator */}
      <div className="dashboard-glass-card" onClick={() => openPanel('tasks')}>
        <div className="dashboard-card-header">
          <div className="dashboard-card-icon-wrap">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
          </div>
          <div className="dashboard-card-title-group">
            <span className="dashboard-card-category">AUTONOMOUS</span>
            <span className="dashboard-card-title">Task Orchestrator</span>
          </div>
          <span className={`dashboard-card-status-badge ${task?.active ? 'is-busy' : 'is-idle'}`}>
            {task?.active ? 'RUNNING' : 'STANDBY'}
          </span>
        </div>
        <div className="dashboard-card-body">
          <div className="dashboard-stat-row">
            <span className="dashboard-stat-label">Workflow</span>
            <span className="dashboard-stat-value">{task?.label || 'Idle · Ready'}</span>
          </div>
          <div className="dashboard-stat-row">
            <span className="dashboard-stat-label">Verification</span>
            <span className="dashboard-stat-value">Authoritative Exit-Code Gate</span>
          </div>
          <div className="dashboard-stat-row">
            <span className="dashboard-stat-label">Progress</span>
            <span className="dashboard-stat-value">
              {task?.active ? `Step ${task.step} / ${task.total}` : '100% Verified'}
            </span>
          </div>
        </div>
        <div className="dashboard-card-footer">
          <span className="dashboard-card-action">Open Task Monitor &rarr;</span>
        </div>
      </div>

      {/* Card 3: Peripherals & Vision */}
      <div className="dashboard-glass-card" onClick={() => openPanel('camera')}>
        <div className="dashboard-card-header">
          <div className="dashboard-card-icon-wrap">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </div>
          <div className="dashboard-card-title-group">
            <span className="dashboard-card-category">PERCEPTION</span>
            <span className="dashboard-card-title">Sensors & Vision</span>
          </div>
          <span className={`dashboard-card-status-badge ${camera.active ? 'is-active' : 'is-idle'}`}>
            {camera.active ? 'LIVE' : 'READY'}
          </span>
        </div>
        <div className="dashboard-card-body">
          <div className="dashboard-stat-row">
            <span className="dashboard-stat-label">Camera</span>
            <span className="dashboard-stat-value">{camera.active ? 'Streaming' : 'Available'}</span>
          </div>
          <div className="dashboard-stat-row">
            <span className="dashboard-stat-label">Gestures</span>
            <span className="dashboard-stat-value">{gesture.active ? 'Active' : 'Standby'}</span>
          </div>
          <div className="dashboard-stat-row">
            <span className="dashboard-stat-label">Spatial Frame</span>
            <span className="dashboard-stat-value">WebCam HD Pipeline</span>
          </div>
        </div>
        <div className="dashboard-card-footer">
          <span className="dashboard-card-action">Launch Camera View &rarr;</span>
        </div>
      </div>

      {/* Card 4: Workspace & Activity */}
      <div className="dashboard-glass-card" onClick={() => openPanel('activity')}>
        <div className="dashboard-card-header">
          <div className="dashboard-card-icon-wrap">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          </div>
          <div className="dashboard-card-title-group">
            <span className="dashboard-card-category">OPERATIONS</span>
            <span className="dashboard-card-title">Event Activity</span>
          </div>
          <span className="dashboard-card-status-badge is-active">
            READY
          </span>
        </div>
        <div className="dashboard-card-body">
          <div className="dashboard-stat-row">
            <span className="dashboard-stat-label">Status</span>
            <span className="dashboard-stat-value">{status.toUpperCase()}</span>
          </div>
          <div className="dashboard-stat-row">
            <span className="dashboard-stat-label">Workspace</span>
            <span className="dashboard-stat-value">D:\JARVIS</span>
          </div>
          <div className="dashboard-stat-row">
            <span className="dashboard-stat-label">Telemetry</span>
            <span className="dashboard-stat-value">Real-Time Subprocess Stream</span>
          </div>
        </div>
        <div className="dashboard-card-footer">
          <span className="dashboard-card-action">View Activity Stream &rarr;</span>
        </div>
      </div>
    </div>
  )
}
