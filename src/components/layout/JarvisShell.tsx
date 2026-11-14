import { useState, useEffect, useCallback } from 'react'
import type { PanelId } from '../../panel/types'
import { Header } from './Header'
import { JarvisTaskbar } from './JarvisTaskbar'
import { CoreCaption } from '../core/CoreCaption'
import { ArcReactor } from '../core/ArcReactor'
import { CoreTelemetry } from '../core/CoreTelemetry'
import { VoiceButton } from '../voice/VoiceButton'
import { Notices } from '../system/Notices'
import { SettingsPanel } from './SettingsPanel'
import { ConfirmDialog } from '../system/ConfirmDialog'
import { TaskIndicator } from '../system/TaskIndicator'
import { GoalComposer } from '../goal/GoalComposer'
import { GoalPanel } from '../goal/GoalPanel'
import type { MemoryItem, UserPreferences, EmbeddingHealthSummary } from '../../memory/MemoryManager'
import type { ArchivedMemory, LifecycleReport } from '../../memory/lifecycle'
import type { Episode } from '../../memory/episodes'
import type { MemoryConfirmRequest, ToolConfirmationRequest } from '../../engine/contracts'
import { canHear } from '../../utils/capabilities'
import { useJarvisStore } from '../../state/jarvis.store'
import type { CameraUiState, BackendUiState, GestureUiState } from '../../state/jarvis.store'
import { PanelHost } from '../panel/PanelHost'
import { BackendStatus } from '../system/BackendStatus'
import { ConnectivityStrip } from '../system/ConnectivityStrip'
import { ActivityPanel } from '../system/ActivityPanel'
import { DeviceTopology } from '../system/DeviceTopology'
import { TranscriptLog } from '../conversation/TranscriptLog'
import { CameraPanel } from '../camera/CameraPanel'
import { GestureHud } from '../gesture/GestureHud'
import { EnvironmentPanel } from '../panel/EnvironmentPanel'
import { CapabilityPanel } from '../panel/CapabilityPanel'
import { ApplicationCatalogue } from '../panel/ApplicationCatalogue'
import { DesktopObservationView } from '../panel/DesktopObservationView'
import { TaskMonitorPanel } from '../panel/TaskMonitorPanel'
import type { ApplicationProvider } from '../../applications'
import {
  visionRows,
  devicesRows,
  filesRows,
  applicationsRows,
} from '../panel/capabilityData'
import { usePanelLayoutStore } from '../../panel/panelStore'
import { dispatchInteraction } from '../../interaction/controller'
import { VoiceStatus } from '../voice/VoiceStatus'
import { CrushButton } from '../system/CrushButton'
import { DashboardCards } from './DashboardCards'

interface AssistantAPI {
  status: ReturnType<typeof useJarvisStore.getState>['status']
  isRecognizing: boolean
  isSpeaking: boolean
  capabilities: ReturnType<typeof useJarvisStore.getState>['capabilities']
  catalog: ReturnType<typeof useJarvisStore.getState>['capCatalog']
  preferences: ReturnType<typeof useJarvisStore.getState>['preferences']
  voiceState: ReturnType<typeof useJarvisStore.getState>['voiceState']
  voiceArmed: boolean
  camera: CameraUiState
  gesture: GestureUiState
  backend: BackendUiState
  providerLabel: string
  modelLabel?: string
  endpointLabel?: string
  submit: (text: string) => void
  startListening: () => void
  stopListening: () => void
  armWake: () => void
  disarmWake: () => void
  onToggleCamera: () => void
  onCaptureCamera: () => void
  onSetCameraVideo: (element: HTMLVideoElement | null) => void
  /** Live getter for the engine's current application provider (may swap). */
  applicationProvider: () => ApplicationProvider | undefined
  observationProvider?: () => any
  desktopProvider?: () => any
  onStopSpeaking: () => void
  onInterrupt: () => void
  backendClient?: any
  onPauseTask?: (taskId: string) => Promise<boolean>
  onResumeTask?: (taskId: string) => Promise<boolean>
  onCancelTask?: (taskId: string) => Promise<boolean>
  onApproveTaskAction?: (taskId: string, approvalId: string) => Promise<boolean>
  onRejectTaskAction?: (taskId: string, approvalId: string, reason?: string) => Promise<boolean>
}

interface Props {
  assistant: AssistantAPI
  memory?: {
    items: () => MemoryItem[]
    count: () => number
    remove: (id: string) => boolean
    requestClearAll: () => boolean
    savePreferences: (patch: Partial<UserPreferences>) => UserPreferences
    getEmbeddingHealth: () => EmbeddingHealthSummary
    lifecycleInfo: () => { lastRunAt?: string }
    archived: () => ArchivedMemory[]
    restore: (id: string) => boolean
    expunge: (cutoffIso?: string) => number
    consolidate: () => LifecycleReport
    activeEpisode: () => Episode | null
    episodes: () => Episode[]
    episodeMemories: (id: string) => MemoryItem[]
  }
  confirmation?: MemoryConfirmRequest | ToolConfirmationRequest | null
  onConfirm?: () => void
  onCancel?: () => void
  task?: {
    active: boolean
    label: string
    step: number
    total: number
    status: string
  }
  onCancelTask?: () => void
}

export function JarvisShell({
  assistant,
  memory,
  confirmation,
  onConfirm,
  onCancel,
  task,
  onCancelTask,
}: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem('jarvis_sidebar_collapsed')
      if (stored !== null) return stored === 'true'
      return window.innerWidth < 1200
    } catch {
      return false
    }
  })

  // Global Ctrl+B / Cmd+B keyboard shortcut to toggle sidebar collapse
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) {
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setIsSidebarCollapsed((prev) => {
          const next = !prev
          try {
            localStorage.setItem('jarvis_sidebar_collapsed', String(next))
          } catch {}
          return next
        })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleToggleSidebarCollapse = useCallback((collapsed: boolean) => {
    setIsSidebarCollapsed(collapsed)
  }, [])

  const environmentId = usePanelLayoutStore((s) => s.environmentId)

  const activeStatuses: Array<ReturnType<typeof useJarvisStore.getState>['status']> = [
    'understanding',
    'planning',
    'executing',
    'observing',
    'verifying',
    'cancelling',
    'speaking',
    'waiting_for_confirmation',
  ]
  const canInterrupt =
    assistant.isSpeaking ||
    activeStatuses.includes(assistant.status) ||
    (task?.active ?? false)
  const stopLabel =
    assistant.isSpeaking || assistant.status === 'speaking'
      ? 'STOP SPEAKING'
      : 'STOP TASK'

  const renderPanel = (id: PanelId) => {
    switch (id) {
      case 'core':
        return <BackendStatus backend={assistant.backend} />
      case 'camera':
        return (
          <CameraPanel
            camera={assistant.camera}
            onToggle={assistant.onToggleCamera}
            onCapture={assistant.onCaptureCamera}
            onSetVideo={assistant.onSetCameraVideo}
          />
        )
      case 'conversation':
        return <TranscriptLog />
      case 'activity':
        return <ActivityPanel />
      case 'system':
        return (
          <ConnectivityStrip
            capabilities={assistant.capabilities}
            camera={assistant.camera}
            backend={assistant.backend}
          />
        )
      case 'environments':
        return <EnvironmentPanel />
      case 'vision':
        return (
          <CapabilityPanel
            title="VISION"
            rows={visionRows(assistant.capabilities, assistant.catalog)}
          />
        )
      case 'devices':
        return (
          <>
            <DeviceTopology />
            <CapabilityPanel
              title="DEVICES"
              rows={devicesRows(assistant.capabilities, assistant.backend, assistant.catalog)}
            />
          </>
        )
      case 'files':
        return (
          <CapabilityPanel
            title="FILES"
            rows={filesRows(assistant.capabilities, assistant.catalog)}
          />
        )
      case 'applications':
        return (
          <>
            <DesktopObservationView
              observation={assistant.observationProvider?.()}
              desktop={assistant.desktopProvider?.()}
            />
            <CapabilityPanel
              title="APPLICATIONS"
              rows={applicationsRows(assistant.capabilities, assistant.catalog)}
            />
            <ApplicationCatalogue provider={assistant.applicationProvider()} />
          </>
        )
      case 'tasks':
        return (
          <TaskMonitorPanel
            backendClient={assistant.backendClient}
            onPauseTask={assistant.onPauseTask}
            onResumeTask={assistant.onResumeTask}
            onCancelTask={assistant.onCancelTask}
            onApproveAction={assistant.onApproveTaskAction}
            onRejectAction={assistant.onRejectTaskAction}
          />
        )
      default:
        return null
    }
  }

  return (
    <div
      className={`jarvis-shell ${
        isSidebarCollapsed ? 'is-sidebar-collapsed' : 'is-sidebar-expanded'
      } ${mobileSidebarOpen ? 'is-mobile-sidebar-open' : ''}`}
    >
      <Header
        status={assistant.status}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleMobileSidebar={() => setMobileSidebarOpen((prev) => !prev)}
      />

      <JarvisTaskbar
        onOpenSettings={() => setSettingsOpen(true)}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={handleToggleSidebarCollapse}
        mobileOpen={mobileSidebarOpen}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />

      {/* Mobile Drawer Backdrop */}
      {mobileSidebarOpen && (
        <div
          className="sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}

      <GestureHud gesture={assistant.gesture} />

      <main className="jarvis-stage">
        <div className="dashboard-hero">
          {environmentId === 'arc' ? (
            <div className="hero-reactor-frame">
              <ArcReactor />
              <CoreTelemetry />
            </div>
          ) : null}
          {environmentId === 'arc' || environmentId === 'space' || environmentId === 'tunnel' ? (
            <CoreCaption />
          ) : null}
        </div>

        <TaskIndicator />
        <GoalPanel />

        <DashboardCards
          status={assistant.status}
          providerLabel={assistant.providerLabel}
          modelLabel={assistant.modelLabel}
          endpointLabel={assistant.endpointLabel}
          backend={assistant.backend}
          camera={assistant.camera}
          gesture={assistant.gesture}
          task={task}
        />
      </main>

      <PanelHost
        renderPanel={renderPanel}
        isSidebarCollapsed={isSidebarCollapsed}
      />

      <footer className="jarvis-dock">
        {!canHear() && !assistant.capabilities.speechSynthesisAvailable ? (
          <p className="dock-warning">
            This browser has no voice support — keyboard and text still work.
          </p>
        ) : null}
        <div className="jarvis-dock-bar">
          <VoiceButton
            isListening={assistant.isRecognizing}
            isSpeaking={assistant.isSpeaking}
            onStart={() => {
              dispatchInteraction({ action: 'listen_start' })
            }}
            onStop={() => {
              dispatchInteraction({ action: 'listen_stop' })
            }}
          />
          <GoalComposer
            busy={task?.active ?? false}
            cancelVisible={task?.active ?? false}
            onSubmit={assistant.submit}
            onCancel={onCancelTask ?? (() => {})}
          />
          <div className="jarvis-dock-controls">
            <VoiceStatus />
            <CrushButton />
          </div>
        </div>
        {canInterrupt ? (
          <button
            type="button"
            className="stop-all"
            onClick={assistant.onInterrupt}
            aria-label={stopLabel}
          >
            {stopLabel}
          </button>
        ) : null}
        <p className="dock-hint">
          Hold to speak · type to ASK or run a GOAL
        </p>
      </footer>

      <Notices />

      <ConfirmDialog
        request={confirmation ?? null}
        onConfirm={onConfirm ?? (() => {})}
        onCancel={onCancel ?? (() => {})}
      />

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        providerLabel={assistant.providerLabel}
        modelLabel={assistant.modelLabel}
        endpointLabel={assistant.endpointLabel}
        memory={memory}
        // The live gesture mirror. Without this the panel always rendered
        // "Off / unknown / 0 hands" even while gestures were tracking.
        gesture={assistant.gesture}
      />
    </div>
  )
}
