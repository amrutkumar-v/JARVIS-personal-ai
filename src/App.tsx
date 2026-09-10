import { lazy, Suspense } from 'react'
import './App.css'
import { useAssistant } from './hooks/useAssistant'
import { JarvisShell } from './components/layout/JarvisShell'
import { useJarvisStore } from './state/jarvis.store'

const JarvisViewport = lazy(() =>
  import('./three/JarvisViewport').then((m) => ({ default: m.JarvisViewport })),
)

function App() {
  const assistant = useAssistant()
  const theme = useJarvisStore.use.theme()
  const demoMode = useJarvisStore.use.demoMode()

  return (
    <div className={`jarvis-app theme-${theme}${demoMode ? ' is-demo' : ''}`} data-theme={theme}>
      <div className="jarvis-bg" aria-hidden="true">
        <div className="jarvis-grid" />
        <div className="jarvis-vignette" />
      </div>

      <div className="jarvis-scene-layer" aria-hidden="true">
        <Suspense fallback={null}>
          <JarvisViewport />
        </Suspense>
      </div>

      <JarvisShell
        assistant={{
          status: assistant.status,
          isRecognizing: assistant.isRecognizing,
          isSpeaking: assistant.isSpeaking || assistant.status === 'speaking',
          capabilities: assistant.capabilities,
          preferences: assistant.preferences,
          voiceState: assistant.voiceState,
          voiceArmed: assistant.voiceArmed,
          camera: assistant.camera,
          backend: assistant.backend,
          providerLabel: assistant.engine.activeProvider().label,
          modelLabel: assistant.engine.aiInfo().model,
          endpointLabel: assistant.engine.aiInfo().baseUrl,
          submit: assistant.submit,
          startListening: assistant.startListening,
          stopListening: assistant.stopListening,
          armWake: assistant.armWake,
          disarmWake: assistant.disarmWake,
          onToggleCamera: () => void assistant.toggleCamera(),
          onCaptureCamera: () => void assistant.captureCamera(),
          onSetCameraVideo: assistant.setCameraVideo,
          onStopSpeaking: assistant.stopSpeaking,
          onInterrupt: assistant.interrupt,
        }}
        memory={{
          items: () => assistant.engine.memoryItems(),
          count: () => assistant.engine.getMemoryCount(),
          remove: (id) => assistant.engine.deleteMemoryItem(id),
          requestClearAll: () =>
            assistant.engine.hasPendingConfirmation ||
            assistant.engine.requestClearAll(),
          savePreferences: (patch) => assistant.engine.savePreferences(patch),
          getEmbeddingHealth: () => assistant.engine.getEmbeddingHealth(),
          lifecycleInfo: () => assistant.engine.lifecycleInfo(),
          archived: () => assistant.engine.archivedMemories(),
          restore: (id) => assistant.engine.restoreMemoryItem(id),
          expunge: (cutoffIso) => assistant.engine.expungeArchived(cutoffIso),
          consolidate: () => assistant.engine.consolidateMemory(),
          activeEpisode: () => assistant.engine.activeEpisode(),
          episodes: () => assistant.engine.episodes(),
          episodeMemories: (id) => assistant.engine.episodeMemories(id),
        }}
        confirmation={assistant.confirmation}
        onConfirm={assistant.acceptConfirmation}
        onCancel={assistant.rejectConfirmation}
        task={assistant.task}
        onCancelTask={assistant.cancelCurrentTask}
      />
    </div>
  )
}

export default App