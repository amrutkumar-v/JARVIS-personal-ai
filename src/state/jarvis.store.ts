import { create } from 'zustand'
import { createSelectors } from './createSelectors'
import type { JarvisStatus } from '../engine/types'
import type { Capabilities } from '../types/capabilities'
import type { Profile, UserPreferences } from '../memory/MemoryManager'
import type { TaskSnapshot } from '../engine/agent/types'
import type { VoiceState } from '../voice/types'
import type { GoalMode, GoalRunSnapshot } from './goalRun'
import type { JarvisTheme } from '../themes'
import { DEFAULT_THEME } from '../themes'
import type { CameraPermissionState } from '../camera'
import type { BackendHealth, DeviceRecord } from '../backend/types'
import type { ReconnectPhase } from '../backend/reconnect'
import type { CapabilityCatalogItem } from '../engine/contracts'
import type { GestureIntent, GesturePhase, GestureTrackingQuality } from '../gesture'

export interface Notice {
  id: number
  kind: 'info' | 'success' | 'warning' | 'error'
  text: string
  timedOut?: boolean
}

export interface CapabilityDelta extends Partial<Capabilities> {}

/**
 * Phase 2.7 — live webcam state, mirrored from the REAL CameraController.
 * Never optimistic: `active` only becomes true after getUserMedia succeeds.
 */
export interface CameraUiState {
  available: boolean
  active: boolean
  permission: CameraPermissionState
  reason?: string
}

/**
 * Phase 2.8 — persistent JARVIS Core backend mirror, fed ONLY from the real
 * BackendClient lifecycle: `phase` reflects the actual SSE stream state and
 * `devices` is the live registry snapshot. Never optimistic.
 */
export interface BackendUiState {
  /** Backend connection lifecycle phase (SSE stream). */
  phase: ReconnectPhase
  /** Last /health payload received from the backend (null until ready). */
  health: BackendHealth | null
  /** Live companion-device registry snapshot. */
  devices: DeviceRecord[]
  /** Last inbound (device → JARVIS) message time. */
  lastInboundAt: number | null
  /**
   * Last `wake` event the backend actually published (arm/disarm/wake). Mirrored
   * from the real SSE frame — the wake registry is never assumed to be armed.
   */
  lastWake: { event: string; at: number } | null
}

/**
 * Phase 11 — live scheduled reminders, mirrored from the REAL LocalScheduler.
 * Empty until the scheduler (and the app) exists; never optimistic.
 */
export interface ScheduledUiItem {
  id: string
  text: string
  kind: 'once' | 'daily' | 'weekly'
  at?: number
  time?: string
  weekday?: number
  nextRun: number
  lastResult?: string
}

/**
 * Phase 10 — live hand-gesture state, mirrored from the REAL GestureController.
 * Every value reflects the actual tracker/gate output — never optimistic.
 */
export interface GestureUiState {
  /** Feature toggled ON (user intent). */
  active: boolean
  /** Local MediaPipe model finished loading. */
  modelReady: boolean
  /** Honest failure reason when the controller could not start. */
  error?: string
  /** Hands observed in the current frame. */
  hands: number
  quality: GestureTrackingQuality
  phase: GesturePhase
  lastGesture: GestureIntent | null
}

export interface JarvisState {
  /* ---------- Capabilities ---------- */
  capabilities: Capabilities
  /** Live registered capability catalogue, aired by the engine (Phase 9).
   * The single source the capability panels derive their rows from. */
  capCatalog: CapabilityCatalogItem[]

  /* ---------- Status ---------- */
  status: JarvisStatus

  /* ---------- Voice state ---------- */
  isRecognizing: boolean
  isSpeaking: boolean
  /** Live (partial) transcript while listening. */
  interimText: string
  /** Voice session state (Phase 1.6 wake/command machine). */
  voiceState: VoiceState
  /** Wake listener is armed (user gesture required to arm). */
  voiceArmed: boolean

  /* ---------- Conversation ---------- */
  lastUserText: string | null
  lastAssistantText: string | null

  /* ---------- Comfort / memory ---------- */
  profile: Profile
  preferences: UserPreferences

  /* ---------- Activity ---------- */
  activities: ActivityEntry[]

  /* ---------- Task execution (agent orchestration) ---------- */
  task: TaskSnapshot | null

  /* ---------- Goal mode & goal run (Phase 2.1 UI mirror) ---------- */
  goalMode: GoalMode
  goalRun: GoalRunSnapshot | null

  /* ---------- Webcam (Phase 2.7 live state) ---------- */
  camera: CameraUiState

  /* ---------- Hand gestures (Phase 10 live mirror) ---------- */
  gesture: GestureUiState

  /* ---------- Persistent backend (Phase 2.8 live mirror) ---------- */
  backend: BackendUiState

  /* ---------- Scheduled reminders (Phase 11 live mirror) ---------- */
  schedule: ScheduledUiItem[]

  /* ---------- Notices (transient user-facing errors/warnings) ---------- */
  notices: Notice[]

  /* ---------- Presentation (Phase 2.5) ---------- */
  /** UI theme — presentation only, never reaches execution logic. */
  theme: JarvisTheme
  /** Demo Mode — presentation only. It may enlarge the Arc Reactor and declutter
   * the UI, but it can never fake execution, verification or permissions. */
  demoMode: boolean

  /* ---------- Store actions ---------- */
  setCapabilities(patch: CapabilityDelta): void
  setCapCatalog(capabilities: CapabilityCatalogItem[]): void
  setStatus(status: JarvisStatus): void
  setRecognizing(active: boolean): void
  setIsSpeaking(active: boolean): void
  setInterimText(text: string): void
  setVoiceState(state: VoiceState): void
  setVoiceArmed(armed: boolean): void
  setLastUser(text: string | null): void
  setLastAssistant(text: string | null): void
  setPreferences(patch: Partial<UserPreferences>): void
  setProfile(patch: Partial<Profile>): void
  pushNotice(kind: Notice['kind'], text: string): void
  dismissNotice(id: number): void
  clearNotices(): void
  addActivity(input: Omit<ActivityEntry, 'id' | 'startedAt'> & { id?: string }): void
  finishActivity(id: string, patch: { status?: ActivityEntry['status']; detail?: string }): void
  clearActivities(): void
  setTask(task: TaskSnapshot | null): void
  clearTask(): void
  setGoalMode(mode: GoalMode): void
  setGoalRun(snapshot: GoalRunSnapshot | null): void
  resetRun(): void
  setCamera(patch: Partial<CameraUiState>): void
  setBackend(patch: Partial<BackendUiState>): void
  setSchedule(items: readonly ScheduledUiItem[]): void
  setGesture(patch: Partial<GestureUiState>): void
  setTheme(theme: JarvisTheme): void
  setDemoMode(enabled: boolean): void
}

export interface ActivityEntry {
  id: string
  step: string
  status: 'pending' | 'running' | 'success' | 'error' | 'rejected'
  kind: 'input' | 'think' | 'tool' | 'output' | 'memory'
  detail: string
  startedAt: number
  runId?: string
}

const DEFAULT_CAPABILITIES: Capabilities = {
  aiConnected: false,
  aiConfigured: false,
  aiStatus: 'DISCONNECTED',
  aiStatusMessage: '',
  speechRecognitionAvailable: false,
  speechSynthesisAvailable: false,
  wakeWordAvailable: false,
  voiceInteractionAvailable: false,
  microphoneAvailable: false,
  memoryEnabled: false,
  toolsEnabled: false,
  callingEnabled: false,
  fileSystemAvailable: false,
  nativeAgentAvailable: false,
  nativeApplicationAvailable: false,
  nativeObservationAvailable: false,
  nativeDesktopInteractionAvailable: false,
  visionAvailable: false,
  ocrAvailable: false,
  uiElementDetectionAvailable: false,
  targetLocalizationAvailable: false,
  cameraAvailable: false,
  deviceBridgeAvailable: false,
  webAccessAvailable: false,
}

const DEFAULT_CAMERA: CameraUiState = {
  available: false,
  active: false,
  permission: 'unknown',
}

const DEFAULT_BACKEND: BackendUiState = {
  phase: 'idle',
  health: null,
  devices: [],
  lastInboundAt: null,
  lastWake: null,
}

const DEFAULT_GESTURE: GestureUiState = {
  active: false,
  modelReady: false,
  hands: 0,
  quality: 'none',
  phase: 'unknown',
  lastGesture: null,
}

const DEFAULT_PREFERENCES: UserPreferences = {
  voiceEnabled: true,
  volume: 0.9,
  animationIntensity: 'high',
  reducedMotion: false,
  providerId: 'mock',
  autoMemorize: false,
  wakeWordEnabled: false,
}

const DEFAULT_PROFILE: Profile = {
  name: 'Operator',
  createdAt: new Date(0).toISOString(),
  version: '0.1.0',
}

const rawStore = create<JarvisState>()((set, get) => ({
  capabilities: { ...DEFAULT_CAPABILITIES },
  capCatalog: [],
  status: 'idle',
  isRecognizing: false,
  isSpeaking: false,
  interimText: '',
  voiceState: 'SLEEPING',
  voiceArmed: false,
  lastUserText: null,
  lastAssistantText: null,
  profile: { ...DEFAULT_PROFILE },
  preferences: { ...DEFAULT_PREFERENCES },
  activities: [],

  task: null,

  goalMode: 'ask',
  goalRun: null,

  camera: { ...DEFAULT_CAMERA },

  gesture: { ...DEFAULT_GESTURE },

  backend: { ...DEFAULT_BACKEND },

  schedule: [],

  notices: [],

  theme: DEFAULT_THEME,
  demoMode: false,

  setCapabilities: (patch) =>
    set({ capabilities: { ...get().capabilities, ...patch } }),

  setCapCatalog: (capabilities) => set({ capCatalog: capabilities }),

  setStatus: (status) => set({ status }),

  setRecognizing: (active) => set({ isRecognizing: active }),
  setIsSpeaking: (active) => set({ isSpeaking: active }),
  setInterimText: (text) => set({ interimText: text }),
  setVoiceState: (state) => set({ voiceState: state }),
  setVoiceArmed: (armed) => set({ voiceArmed: armed }),

  setLastUser: (text) => set({ lastUserText: text }),
  setLastAssistant: (text) => set({ lastAssistantText: text }),

  setPreferences: (patch) =>
    set({ preferences: { ...get().preferences, ...patch } }),
  setProfile: (patch) => set({ profile: { ...get().profile, ...patch } }),

  pushNotice: (kind, text) => {
    const id = Date.now() + Math.random()
    set({ notices: [...get().notices, { id, kind, text }] })
    window.setTimeout(() => get().dismissNotice(id), 6000)
  },
  dismissNotice: (id) => set({ notices: get().notices.filter((n) => n.id !== id) }),
  clearNotices: () => set({ notices: [] }),

  addActivity: (input) => {
    const entry: ActivityEntry = {
      ...input,
      id:
        input.id ??
        `activity-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      startedAt: Date.now(),
    }
    set({ activities: [entry, ...get().activities].slice(0, 40) })
  },
  finishActivity: (id, patch) =>
    set({
      activities: get().activities.map((a) =>
        a.id === id ? { ...a, ...patch } : a,
      ),
    }),
  clearActivities: () => set({ activities: [] }),

  setTask: (task) => set({ task }),
  clearTask: () => set({ task: null }),
  setGoalMode: (mode) => set({ goalMode: mode }),
  setGoalRun: (snapshot) => set({ goalRun: snapshot }),

  setCamera: (patch) => set({ camera: { ...get().camera, ...patch } }),
  setBackend: (patch) => set({ backend: { ...get().backend, ...patch } }),
  setSchedule: (items) => set({ schedule: [...items] }),
  setGesture: (patch) => set({ gesture: { ...get().gesture, ...patch } }),

  setTheme: (theme) => set({ theme }),
  setDemoMode: (enabled) => set({ demoMode: enabled }),

  resetRun: () => {
    set({
      status: 'idle',
      isRecognizing: false,
      isSpeaking: false,
      lastUserText: null,
      lastAssistantText: null,
      activities: [],
    })
  },
}))

export const useJarvisStore = createSelectors(rawStore)
export { useJarvisStore as useJarvis }