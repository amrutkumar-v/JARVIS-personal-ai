import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AssistantEngine } from '../engine'
import type { EngineOutMessage, ToolConfirmationRequest, MemoryConfirmRequest, TaskSnapshot } from '../engine/contracts'
import { BrowserVoiceInput } from '../voice/VoiceInput'
import type { VoiceOutput } from '../voice/VoiceOutput'
import { VoiceManager } from '../voice/voiceManager'
import { VoiceDiagnostics } from '../voice/diagnostics'
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
import { BackendDeviceProvider, useDeviceStore } from '../device'
import { BackendAndroidProvider } from '../android'
import { WebCameraController } from '../camera'
import { GestureController, createMediaPipeTracker, GESTURE_ACTION_MAP } from '../gesture'
import { LocalScheduler } from '../scheduling/scheduler'
import type { ScheduledItem } from '../scheduling/scheduler'

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

  /* ---- Phase 10 — one REAL Android telephony provider per session ----
   * Created alongside the device bridge and attached to the engine so the
   * call.* tools exist only while the persistent JARVIS Core backend is
   * reachable. Real call-state events the phone pushes are fed straight into
   * it, so verification can only ever succeed from a genuine OS observation.
   */
  const androidProviderRef = useRef<BackendAndroidProvider | null>(null)

  /* ---- Phase 11 reminders: one REAL LocalScheduler per session ----
   * Attached to the engine so scheduling.* tools exist; due reminders fire
   * through the SAME single engine entry point as text/voice/device. Missed
   * runs are caught up honestly (fired once, marked missed). The scheduler
   * only runs while the app is open — there is no background OS timer.
   */
  useEffect(() => {
    const scheduler = new LocalScheduler()
    engine.attachScheduling(scheduler)
    const refreshScheduled = () => {
      useJarvisStore.getState().setSchedule(engine.scheduledItems())
    }
    scheduler.start((item: ScheduledItem, missed: boolean) => {
      const s = useJarvisStore.getState()
      s.pushNotice(missed ? 'warning' : 'info', missed ? `Missed then re-run: "${item.text}"` : `Reminder: "${item.text}"`)
      refreshScheduled()
      void engine.process(item.text, { channel: 'scheduled' })
    })
    refreshScheduled()
    return () => {
      scheduler.stop()
      engine.attachScheduling(undefined)
      useJarvisStore.getState().setSchedule([])
    }
  }, [engine])

  useEffect(() => {
    const client = new BackendClient()
    backendClientRef.current = client
    deviceProviderRef.current = new BackendDeviceProvider(client)
    androidProviderRef.current = new BackendAndroidProvider(client, {
      records: () => [...useDeviceStore.getState().devices.values()],
    })
    return () => {
      engine.attachDevice(undefined)
      engine.attachAndroid(undefined)
      deviceProviderRef.current = null
      androidProviderRef.current = null
      backendClientRef.current = null
    }
  }, [engine])

  const inputRef = useRef<BrowserVoiceInput | null>(null)
  const outputRef = useRef<VoiceOutput | null>(null)
  const voiceManagerRef = useRef<VoiceManager | null>(null)
  const voiceDiagRef = useRef<VoiceDiagnostics | null>(null)
  // Phase 2.7 — the REAL browser webcam controller (never a mock).
  const cameraRef = useRef<WebCameraController | null>(null)
  // Phase 10 — the REAL hand-gesture controller (never a mock).
  const gestureRef = useRef<GestureController | null>(null)
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null)
  const [task, setTask] = useState<TaskSnapshot>({ active: false, label: '', step: 0, total: 0, status: 'COMPLETED' })

  /* ---- wire engine messages → stores ---- */
  useEffect(() => {
    // Phase 2.1 — the Goal panel mirrors ONLY engine getters. Refreshed on
    // every engine message (and on mount) so live plan/running states, budgets
    // and the final verdict all come from the engine, never from the UI.
    const refreshGoalRun = () => {
      syncGoalRun(
        engine,
        () => useJarvisStore.getState().goalMode,
        (snapshot) => useJarvisStore.getState().setGoalRun(snapshot),
      )
      // Phase 11 — keep the live reminder list mirrored (real engine state).
      useJarvisStore.getState().setSchedule(engine.scheduledItems())
    }

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
        case 'capabilities':
          useJarvisStore.getState().setCapCatalog(m.capabilities)
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
          useJarvisStore.getState().setTask(m.task)
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

  /* ---- Phase 10 hand gestures: one REAL controller wired to the camera + engine ---- */
  useEffect(() => {
    const camera = cameraRef.current
    if (!camera) return
    let mounted = true
    let lastCameraActive = camera.capabilities().active
    const controller = new GestureController({
      camera,
      trackerFactory: () => createMediaPipeTracker(),
      videoHost: typeof document !== 'undefined' ? document.body : null,
      onIntent: (intent) => {
        // Gesture → command → the SAME normalized engine action surface
        // voice + UI already reach; recognition ≠ action, the engine verifies.
        engine.runSelfAction(GESTURE_ACTION_MAP[intent.gesture])
      },
      onStatus: (status) => {
        if (!mounted) return
        useJarvisStore.getState().setGesture({
          active: status.active,
          modelReady: status.modelReady,
          hands: status.hands,
          quality: status.quality,
          phase: status.phase,
          lastGesture: status.lastGesture,
          error: status.error,
        })
      },
    })
    gestureRef.current = controller
    useJarvisStore.getState().setGesture({
      modelReady: false,
      error: undefined,
    })

    // Gestures are ON BY DEFAULT — there is no separate toggle. The controller
    // runs on the SAME camera stream the operator already controls: it starts
    // the moment the camera becomes active and stops the moment it is released.
    // Starting the camera is itself a user action, so this never triggers an
    // autoplay-permission prompt on load.
    const syncToCamera = (active: boolean): void => {
      if (lastCameraActive === active) return
      lastCameraActive = active
      if (!mounted) return
      if (active) void controller.start()
      else controller.stop()
    }
    const unsubCamera = useJarvisStore.subscribe((s) => {
      syncToCamera(s.camera.active)
    })
    syncToCamera(lastCameraActive)

    return () => {
      mounted = false
      unsubCamera()
      gestureRef.current = null
      controller.dispose()
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
      // Phase 10 — the calling surface is attached on the SAME real connection.
      const androidProvider = androidProviderRef.current
      if (androidProvider) {
        engine.attachAndroid(androidProvider)
      }
      refreshDevices()
    })
    const offDevice = client.on('onDevice', () => refreshDevices())
    // Phase 10 — REAL call-state observations the phone pushes are fed into the
    // provider (verification) and surfaced honestly in the UI.
    const offCall = client.on('onCall', (event) => {
      const androidProvider = androidProviderRef.current
      if (!androidProvider) return
      androidProvider.ingestCallEvent(event)
      if (event.state === 'RINGING' && event.direction === 'incoming') {
        const who = event.contactName || event.number || 'an unknown number'
        useJarvisStore.getState().pushNotice('info', `Incoming call from ${who}`)
      } else if (event.state === 'FAILED') {
        useJarvisStore.getState().pushNotice('warning', `Call failed${event.reason ? `: ${event.reason}` : '.'}`)
      }
    })
    const offInbound = client.on('onInbound', (message) => {
      const s = useJarvisStore.getState()
      s.setBackend({ lastInboundAt: message.at })
      s.pushNotice('info', `Message from ${message.deviceName || message.deviceId}`)
      void engine.process(message.text, { channel: 'device' })
    })
    const offLost = client.on('onDisconnected', () => {
      // The device bridge is detached the moment the stream drops: no device.*
      // or call.* tool may exist against a dead backend.
      engine.attachDevice(undefined)
      engine.attachAndroid(undefined)
      useJarvisStore.getState().setBackend({ phase: 'waiting' })
      useJarvisStore.getState().setCapabilities({ deviceBridgeAvailable: false })
    })
    const offGaveUp = client.on('onGaveUp', () => {
      engine.attachDevice(undefined)
      engine.attachAndroid(undefined)
      useJarvisStore.getState().setBackend({ phase: 'giving_up' })
      useJarvisStore.getState().setCapabilities({ deviceBridgeAvailable: false })
    })
    client.start()
    return () => {
      offReady()
      offDevice()
      offInbound()
      offCall()
      offLost()
      offGaveUp()
      client.stop()
      useJarvisStore.getState().setBackend({ phase: 'idle', health: null, lastInboundAt: null })
      useJarvisStore.getState().setCapabilities({ deviceBridgeAvailable: false, callingEnabled: false })
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
    // Phase 13 — voice diagnostics feed the runtime readiness/self-test surface.
    const voiceDiag = new VoiceDiagnostics()
    voiceDiagRef.current = voiceDiag
    const manager = new VoiceManager({
      wake: new BrowserWakeWordProvider(),
      stt: new BrowserSpeechToTextProvider(),
      tts,
      diagnostics: voiceDiag,
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
    catalog: useJarvisStore.use.capCatalog(),
    preferences: useJarvisStore.use.preferences(),
    profile: useJarvisStore.use.profile(),
    activities: useJarvisStore.use.activities(),
    notices: useJarvisStore.use.notices(),
    isSpeaking: useJarvisStore.use.isSpeaking(),
    voiceState: useJarvisStore.use.voiceState(),
    voiceArmed: useJarvisStore.use.voiceArmed(),
    camera: useJarvisStore.use.camera(),
    gesture: useJarvisStore.use.gesture(),
    backend: useJarvisStore.use.backend(),
    schedule: useJarvisStore.use.schedule(),
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