import { useState } from 'react'
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
  onStopSpeaking: () => void
  onInterrupt: () => void
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
            <CapabilityPanel
              title="APPLICATIONS"
              rows={applicationsRows(assistant.capabilities, assistant.catalog)}
            />
            <ApplicationCatalogue provider={assistant.applicationProvider()} />
          </>
        )
      default:
        return null
    }
  }

  return (
    <div className="jarvis-shell">
      <Header
        status={assistant.status}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <JarvisTaskbar
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <GestureHud gesture={assistant.gesture} />

      <main className="jarvis-stage">
        {environmentId === 'arc' ? (
          <>
            <ArcReactor />
            <CoreTelemetry />
          </>
        ) : null}
        {environmentId === 'arc' || environmentId === 'space' || environmentId === 'tunnel' ? (
          <CoreCaption />
        ) : null}
        <TaskIndicator />
        <GoalPanel />
      </main>

      <PanelHost renderPanel={renderPanel} />

      <footer className="jarvis-dock">
        {!canHear() && !assistant.capabilities.speechSynthesisAvailable ? (
          <p className="dock-warning">
            This browser has no voice support — keyboard and text still work.
          </p>
        ) : null}
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
        <VoiceStatus />
        <CrushButton />
        <GoalComposer
          busy={task?.active ?? false}
          cancelVisible={task?.active ?? false}
          onSubmit={assistant.submit}
          onCancel={onCancelTask ?? (() => {})}
        />
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
      />
    </div>
  )
}
