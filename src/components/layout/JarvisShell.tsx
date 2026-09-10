import { useState } from 'react'
import { Header } from './Header'
import { CoreCaption } from '../core/CoreCaption'
import { ArcReactor } from '../core/ArcReactor'
import { VoiceButton } from '../voice/VoiceButton'
import { ActivityPanel } from '../system/ActivityPanel'
import { Notices } from '../system/Notices'
import { TranscriptLog } from '../conversation/TranscriptLog'
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
import type { CameraUiState, BackendUiState } from '../../state/jarvis.store'
import { CameraPanel } from '../camera/CameraPanel'
import { ConnectivityStrip } from '../system/ConnectivityStrip'
import { BackendStatus } from '../system/BackendStatus'

interface AssistantAPI {
  status: ReturnType<typeof useJarvisStore.getState>['status']
  isRecognizing: boolean
  isSpeaking: boolean
  capabilities: ReturnType<typeof useJarvisStore.getState>['capabilities']
  preferences: ReturnType<typeof useJarvisStore.getState>['preferences']
  voiceState: ReturnType<typeof useJarvisStore.getState>['voiceState']
  voiceArmed: boolean
  camera: CameraUiState
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

/**
 * App chrome: topbar, caption, dock (primary voice control), side panels.
 * The 3D viewport sits behind everything at its own z-layer.
 */
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

  // Phase 2.7 — unified interrupt surface: the STOP control is live while the
  // engine is mid-flight (understanding→verifying), cancelling, awaiting
  // confirmation, speaking, or driving an active goal task.
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
  const canInterrupt = assistant.isSpeaking || activeStatuses.includes(assistant.status) || (task?.active ?? false)
  const stopLabel = assistant.isSpeaking || assistant.status === 'speaking' ? 'STOP SPEAKING' : 'STOP TASK'

  return (
    <div className="jarvis-shell">
      <Header status={assistant.status} onOpenSettings={() => setSettingsOpen(true)} />

      <main className="jarvis-stage">
        <ConnectivityStrip capabilities={assistant.capabilities} camera={assistant.camera} backend={assistant.backend} />
        <BackendStatus backend={assistant.backend} />
        <CameraPanel
          camera={assistant.camera}
          onToggle={assistant.onToggleCamera}
          onCapture={assistant.onCaptureCamera}
          onSetVideo={assistant.onSetCameraVideo}
        />
        <ArcReactor />
        <CoreCaption />
        <TaskIndicator />
        <GoalPanel />
      </main>

      <footer className="jarvis-dock">
        {!canHear() && !assistant.capabilities.speechSynthesisAvailable ? (
          <p className="dock-warning">This browser has no voice support — keyboard and text still work.</p>
        ) : null}
        <VoiceButton
          isListening={assistant.isRecognizing}
          isSpeaking={assistant.isSpeaking}
          onStart={assistant.startListening}
          onStop={assistant.stopListening}
        />
        {assistant.capabilities.wakeWordAvailable && assistant.preferences.wakeWordEnabled ? (
          <button
            type="button"
            className={`wake-chip${assistant.voiceArmed ? ' is-armed' : ''}`}
            aria-pressed={assistant.voiceArmed}
            aria-label={assistant.voiceArmed ? 'Disarm wake word' : 'Arm wake word'}
            onClick={assistant.voiceArmed ? assistant.disarmWake : assistant.armWake}
          >
            <span className="wake-dot" aria-hidden="true" />
            {assistant.voiceArmed ? assistant.voiceState.replace('_', ' ') : 'WAKE'}
          </button>
        ) : null}
        <GoalComposer
          busy={task?.active ?? false}
          cancelVisible={task?.active ?? false}
          onSubmit={assistant.submit}
          onCancel={onCancelTask ?? (() => {})}
        />
        {canInterrupt ? (
          <button type="button" className="stop-all" onClick={assistant.onInterrupt} aria-label={stopLabel}>
            {stopLabel}
          </button>
        ) : null}
        <p className="dock-hint">Hold to speak · type to ASK or run a GOAL</p>
      </footer>

      <aside className="jarvis-sidebar">
        <ActivityPanel />
        <TranscriptLog />
      </aside>

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