import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssistantEngine } from '../engine'
import type { EngineOutMessage, ToolConfirmationRequest, MemoryConfirmRequest, TaskSnapshot } from '../engine/contracts'
import { BrowserVoiceInput } from '../voice/VoiceInput'
import type { VoiceOutput } from '../voice/VoiceOutput'
import { VoiceManager } from '../voice/voiceManager'
import { BrowserWakeWordProvider } from '../voice/wakeWordProvider'
import { BrowserSpeechToTextProvider } from '../voice/speechProvider'
import { BrowserTextToSpeechProvider } from '../voice/ttsProvider'
import { useJarvisStore } from '../state/jarvis.store'
import { syncGoalRun } from '../state/goalRun'
import { canHear } from '../utils/capabilities'
import { createDefaultAppFileSystemProvider, createDefaultAppApplicationProvider, createDefaultAppObservationProvider, createDefaultAppDesktopProvider, createDefaultAppVisionProvider, createDefaultAppWebProvider, createDefaultAppClipboardProvider, createDefaultAppBrowserProvider } from '../native'
import { BackendClient } from '../backend/BackendClient'
import { getBackendConfig } from '../backend/config'
import type { BackendHealth } from '../backend/types'
import { BackendDeviceProvider } from '../device'
import { WebCameraController } from '../camera'

export type ConfirmationRequest = ToolConfirmationRequest | MemoryConfirmRequest

export type { MemoryConfirmRequest }

/**
 * Central binding between the engine, voice layers and React state.
 * Renders nothing; exposes stable callbacks the UI can drive.
 */
export function useAssistant() {
  const backendClientRef = useRef<BackendClient | null>(null)

const engine = useMemo(
    () => {
      // The engine starts with no device bridge; the real BackendClient and
      // provider are created in the mount effect below and attached via
      // engine.attachDevice once the session is live.
      return new AssistantEngine({
        fileSystem: createDefaultAppFileSystemProvider(),
        applications: createDefaultAppApplicationProvider(),
        observation: createDefaultAppObservationProvider(),
        desktop: createDefaultAppDesktopProvider(),
        vision: createDefaultAppVisionProvider(),
        web: createDefaultAppWebProvider(),
        clipboard: createDefaultAppClipboardProvider(),
        browser: createDefaultAppBrowserProvider(),
      })
    },
    [],
  )

  /* ---- Phase 2.8 — one REAL BackendClient per session (mount-time) ----
   * Created outside render (the compiler needs a pure render), then attached
   * to the engine so the device.* tools exist only while the persistent
   * JARVIS Core backend is actually reachable.
   */
  const deviceProviderRef = useRef<BackendDeviceProvider | null>(null)

  useEffect(() => {
    const client = new BackendClient()
    backendClientRef.current = client
    deviceProviderRef.current = new BackendDeviceProvider(client)
    return () => {
      engine.attachDevice(undefined)
      deviceProviderRef.current = null
      backendClientRef.current = null
    }
  }, [engine])

  const inputRef = useRef<BrowserVoiceInput | null>(null)
  const outputRef = useRef<VoiceOutput | null>(null)
  const voiceManagerRef = useRef<VoiceManager | null>(null)
  // Phase 2.7 — the REAL browser webcam controller (never a mock).
  const cameraRef = useRef<WebCameraController | null>(null)
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null)
  const [task, setTask] = useState<TaskSnapshot>({ active: false, label: '', step: 0, total: 0, status: 'COMPLETED' })

  /* ---- wire engine messages → stores ---- */
  useEffect(() => {
    // Phase 2.1 — the Goal panel mirrors ONLY engine getters. Refreshed on
    // every engine message (and on mount) so live plan/running states, budgets
    // and the final verdict all come from the engine, never from the UI.
    const refreshGoalRun = () =>
      syncGoalRun(
        engine,
        () => useJarvisStore.getState().goalMode,
        (snapshot) => useJarvisStore.getState().setGoalRun(snapshot),
      )

    const off = engine.on((m: EngineOutMessage) => {
      const s = useJarvisStore.getState()
      switch (m.type) {
        case 'status':
          s.setStatus(m.status)
          /* Phase 1.6 — drive the voice session cycle (PROCESSING → SPEAKING → idle). */
          voiceManagerRef.current?.engineStatus(m.status)
          break
        case 'notice':
          s.pushNotice(m.kind, m.text)
          break
        case 'activity':
          if (!m.activity || !m.activity.id) break
          if (m.activity.status === 'running') {
            s.addActivity({
              id: m.activity.id,
              step: m.activity.step,
              status: m.activity.status,
              kind: m.activity.kind,
              detail: m.activity.detail,
              runId: m.activity.runId,
            })
          } else {
            s.finishActivity(m.activity.id, {
              status: m.activity.status,
              detail: m.activity.detail,
            })
          }
          break
        case 'error':
          s.pushNotice('error', m.message)
          break
        case 'transcript':
        case 'tool':
        case 'memory':
          break
        case 'memory-confirm':
          setConfirmation({
            reason: m.reason,
            text: m.text,
            onConfirm: m.onConfirm,
            onCancel: m.onCancel,
          } satisfies MemoryConfirmRequest)
          break
        case 'tool-confirm':
          setConfirmation(m.request)
          break
        case 'task':
          setTask(m.task)
          break
      }
      refreshGoalRun()
    })
    return off
  }, [engine])

  /* ---- Phase 2.7 webcam: one REAL controller wired to the engine + store ---- */
  useEffect(() => {
    const controller = new WebCameraController()
    cameraRef.current = controller
    const unsubscribe = controller.subscribe((status) => {
      useJarvisStore.getState().setCamera({
        available: status.available,
        active: status.active,
        permission: status.permission,
        reason: status.reason,
      })
    })
    // Reflect the REAL initial surface immediately (no optimistic claims).
    useJarvisStore.getState().setCamera({
      available: controller.capabilities().available,
      permission: controller.capabilities().permission,
    })
    engine.attachCamera(controller)
    return () => {
      unsubscribe()
      controller.dispose()
      engine.attachCamera(null)
      cameraRef.current = null
    }
  }, [engine])

  /* ---- Phase 2.8 persistent backend: lifecycle, inbound, mirror ---- */
  useEffect(() => {
    const client = backendClientRef.current
    if (!client) return

    const refreshDevices = (): void => {
      void client.listDevices().then((devices) => {
        useJarvisStore.getState().setBackend({ devices })
      })
    }

    const offReady = client.on('onReady', (health: BackendHealth) => {
      const current = useJarvisStore.getState().backend
      useJarvisStore.getState().setBackend({ phase: 'connected', health, lastInboundAt: current.lastInboundAt })
      // The device surface is REAL only while a live backend has delivered
      // ready: attach the provider (registers device.* tools), then mirror.
      const provider = deviceProviderRef.current
      if (provider) {
        engine.attachDevice(provider)
        useJarvisStore.getState().setCapabilities({ deviceBridgeAvailable: provider.capabilities().available === true })
      }
      refreshDevices()
    })
    const offDevice = client.on('onDevice', () => refreshDevices())
    const offInbound = client.on('onInbound', (message) => {
      const s = useJarvisStore.getState()
      s.setBackend({ lastInboundAt: message.at })
      s.pushNotice('info', `Message from ${message.deviceName || message.deviceId}`)
      void engine.process(message.text, { channel: 'device' })
    })
    const offLost = client.on('onDisconnected', () => {
      // The device bridge is detached the moment the stream drops: no device.*
      // tool may exist against a dead backend.
      engine.attachDevice(undefined)
      useJarvisStore.getState().setBackend({ phase: 'waiting' })
      useJarvisStore.getState().setCapabilities({ deviceBridgeAvailable: false })
    })
    const offGaveUp = client.on('onGaveUp', () => {
      engine.attachDevice(undefined)
      useJarvisStore.getState().setBackend({ phase: 'giving_up' })
      useJarvisStore.getState().setCapabilities({ deviceBridgeAvailable: false })
    })
    client.start()
    return () => {
      offReady()
      offDevice()
      offInbound()
      offLost()
      offGaveUp()
      client.stop()
      useJarvisStore.getState().setBackend({ phase: 'idle', health: null, lastInboundAt: null })
      useJarvisStore.getState().setCapabilities({ deviceBridgeAvailable: false })
    }
  }, [engine])

  /* ---- Phase 2.8 assistant → backend mirror (throttled, real state only) ---- */
  useEffect(() => {
    const client = backendClientRef.current
    if (!client) return
    const throttleMs = getBackendConfig().mirrorThrottleMs
    let lastMirror = 0
    const pushMirror = (): void => {
      const now = Date.now()
      if (now - lastMirror < throttleMs) return
      lastMirror = now
      const s = useJarvisStore.getState()
      void client.mirrorAssistant({
        status: s.status,
        isSpeaking: s.isSpeaking,
        voiceArmed: s.voiceArmed,
        wakeWordEnabled: s.preferences.wakeWordEnabled,
        cameraActive: s.camera.active,
      })
    }
    const unsubscribe = useJarvisStore.subscribe((state, prev) => {
      if (state.status === prev.status && state.isSpeaking === prev.isSpeaking && state.voiceArmed === prev.voiceArmed) return
      pushMirror()
    })
    return unsubscribe
  }, [engine])

  /* ---- startup: create voice layers, attach to engine, start ---- */
  useEffect(() => {
    const input = new BrowserVoiceInput({
      onStart: () => {
        const s = useJarvisStore.getState()
        s.setRecognizing(true)
        s.setInterimText('')
        s.setStatus('listening')
      },
      onInterim: (text) => {
        const s = useJarvisStore.getState()
        s.setInterimText(text)
        if (s.status === 'idle') s.setStatus('listening')
      },
      onFinal: (text) => {
        useJarvisStore.getState().setInterimText(text)
        // Phase 2.5 — voice rides the SAME AssistantEngine path as text; only
        // the channel marker differs (bounded capability-resolution context).
        void engine.process(text, { channel: 'voice' })
      },
      onEnd: () => {
        const s = useJarvisStore.getState()
        s.setRecognizing(false)
        s.setInterimText('')
        if (s.status === 'listening') s.setStatus('idle')
      },
      onError: (message) => {
        const s = useJarvisStore.getState()
        s.setRecognizing(false)
        s.setStatus('error')
        s.pushNotice('error', message)
      },
    })
    // Phase 1.6 — ONE shared TTS stream. The engine speaks final assistant
    // responses through this provider (via the adapter), and the VoiceManager
    // speaks short session phrases through the same provider. No overlap.
    const tts = new BrowserTextToSpeechProvider()
    const adapter: VoiceOutput = {
      speak: (text, onDone, volume) => tts.speak(text, { volume, onDone }),
      stop: () => tts.stop(),
      pickVoice: () => tts.pickVoice(),
      get speaking() {
        return tts.speaking
      },
      get supported() {
        return tts.supported
      },
    }
    const manager = new VoiceManager({
      wake: new BrowserWakeWordProvider(),
      stt: new BrowserSpeechToTextProvider(),
      tts,
      callbacks: {
        submitCommand: (text) => {
          // Phase 2.5 — the wake/voice session feeds the SAME engine entry.
          void engine.process(text, { channel: 'voice' })
        },
        cancelCurrent: () => engine.cancelCurrentTask(),
        onCommand: (text) => {
          const s = useJarvisStore.getState()
          s.setRecognizing(false)
          s.setInterimText(text)
          s.setLastUser(text)
        },
        onStateChange: (state) => {
          const s = useJarvisStore.getState()
          s.setVoiceState(state)
          const armed = state !== 'SLEEPING' && state !== 'CANCELLED' && state !== 'ERROR'
          s.setVoiceArmed(armed)
        },
        onNotice: (kind, text) => {
          useJarvisStore.getState().pushNotice(kind, text)
        },
      },
    })
    inputRef.current = input
    outputRef.current = adapter
    voiceManagerRef.current = manager
    engine.attach(adapter)
    void engine.start()
    // Phase 2.1 — initial goalRun mirror so the panel is empty until the
    // first message arrives (no fabricated plan or verdict).
    syncGoalRun(
      engine,
      () => useJarvisStore.getState().goalMode,
      (snapshot) => useJarvisStore.getState().setGoalRun(snapshot),
    )

    return () => {
      input.abort()
      manager.dispose()
    }
  }, [engine])

  /* ---- public API ---- */
  const submit = useCallback(
    (text: string) => {
      void engine.process(text)
    },
    [engine],
  )

  const startListening = useCallback(() => {
    const s = useJarvisStore.getState()
    const input = inputRef.current
    if (!input) return
    if (!canHear()) {
      s.setStatus('error')
      s.pushNotice('warning', 'Speech recognition is not supported in this browser.')
      return
    }
    if (!s.preferences.voiceEnabled) {
      s.pushNotice('warning', 'Voice input is disabled in settings.')
      return
    }
    // Hold-to-speak and the wake session share one recognizer — end any
    // active wake session before opening the direct mic.
    if (voiceManagerRef.current && s.voiceArmed) {
      voiceManagerRef.current.sleep()
    }
    if (input.isListening) {
      input.stop()
      return
    }
    input.start()
  }, [])

  const stopListening = useCallback(() => {
    inputRef.current?.stop()
  }, [])

/** Phase 2.7 — STOP SPEAKING: interrupts TTS and returns to idle. */
const stopSpeaking = useCallback(() => {
  engine.stopSpeaking()
}, [engine])

/** Phase 1.6 — arm wake-word listening. Must originate from a user gesture. */
const armWake = useCallback(() => {
  const s = useJarvisStore.getState()
  if (!s.preferences.wakeWordEnabled) {
    s.pushNotice('warning', 'Wake word is disabled in settings.')
    return
  }
  if (!s.capabilities.wakeWordAvailable) {
    s.pushNotice('warning', 'Wake word needs speech recognition, which this browser does not provide.')
    return
  }
  const manager = voiceManagerRef.current
  if (!manager) return
  // The wake session and hold-to-speak share one recognizer.
  inputRef.current?.stop()
  s.setRecognizing(false)
  s.setStatus('idle')
  manager.arm()
  // Phase 2.8 — mirror the real wake state to the persistent backend.
  void backendClientRef.current?.wakeEvent('arm')
}, [])

/** Phase 1.6 — disarm the wake session and go back to sleep. */
const disarmWake = useCallback(() => {
  voiceManagerRef.current?.sleep()
  // Phase 2.8 — mirror the real wake state to the persistent backend.
  void backendClientRef.current?.wakeEvent('disarm')
}, [])

  const setVolume = useCallback((v: number) => {
    engine.savePreferences({ volume: v })
  }, [engine])

  const cancelCurrentTask = useCallback(() => {
    engine.cancelCurrentTask()
  }, [engine])

  /** Phase 2.7 — camera surface actions (real getUserMedia under the hood). */
  const toggleCamera = useCallback(async () => {
    const controller = cameraRef.current
    if (!controller) return
    if (controller.capabilities().active) controller.stop()
    else await controller.start()
  }, [])

  const stopCamera = useCallback(() => {
    cameraRef.current?.stop()
  }, [])

  const captureCamera = useCallback(() => {
    return cameraRef.current?.captureFrame() ?? null
  }, [])

  const setCameraVideo = useCallback((element: HTMLVideoElement | null) => {
    cameraRef.current?.setVideoElement(element)
  }, [])

  /**
   * Phase 2.7 — UNIFIED INTERRUPT with distinguishable states:
   *  - SPEAKING        → stop the TTS stream and return to idle.
   *  - waiting_for_confirmation / task → cancel through the engine rails.
   */
  const interrupt = useCallback(() => {
    const s = useJarvisStore.getState()
    if (s.isSpeaking || s.status === 'speaking') {
      engine.stopSpeaking()
      return
    }
    if (s.status === 'waiting_for_confirmation') {
      engine.cancelPending()
      return
    }
    engine.cancelCurrentTask()
  }, [engine])

  const acceptConfirmation = useCallback(() => {
    setConfirmation((current) => {
      void current?.onConfirm?.()
      return null
    })
  }, [])

  const rejectConfirmation = useCallback(() => {
    setConfirmation((current) => {
      current?.onCancel?.()
      return null
    })
  }, [])

  return {
    status: useJarvisStore.use.status(),
    isRecognizing: useJarvisStore.use.isRecognizing(),
    interimText: useJarvisStore.use.interimText(),
    capabilities: useJarvisStore.use.capabilities(),
    preferences: useJarvisStore.use.preferences(),
    profile: useJarvisStore.use.profile(),
    activities: useJarvisStore.use.activities(),
    notices: useJarvisStore.use.notices(),
    isSpeaking: useJarvisStore.use.isSpeaking(),
    voiceState: useJarvisStore.use.voiceState(),
    voiceArmed: useJarvisStore.use.voiceArmed(),
    camera: useJarvisStore.use.camera(),
    backend: useJarvisStore.use.backend(),
    engine,
    confirmation,
    acceptConfirmation,
    rejectConfirmation,
    submit,
    startListening,
    stopListening,
    stopSpeaking,
    armWake,
    disarmWake,
    setVolume,
    cancelCurrentTask,
    toggleCamera,
    stopCamera,
    captureCamera,
    setCameraVideo,
    interrupt,
    task,
  }
}