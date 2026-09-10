export interface Capabilities {
  /** Configured AI provider is reachable enough to answer. */
  aiConnected: boolean
  /** A configured REAL AI provider is dialled in (mock provider ≠ AI). */
  aiConfigured: boolean
  /** Real speech recognition surface is available. */
  speechRecognitionAvailable: boolean
  /** Real speech synthesis surface is available. */
  speechSynthesisAvailable: boolean
  /** A user-gesture-armed wake-word listener can run (Phase 1.6). */
  wakeWordAvailable: boolean
  /** Voice interaction is usable (hearing and/or speaking), Phase 1.6. */
  voiceInteractionAvailable: boolean
  /** Microphone will actually be captured. */
  microphoneAvailable: boolean
  /** Persistent long-term memory store is active. */
  memoryEnabled: boolean
  /** Tool execution runtime is active. */
  toolsEnabled: boolean
  /** Voice calling is wired (Phase 0: false). */
  callingEnabled: boolean
  /** A real filesystem capability surface exists (File System Access API). */
  fileSystemAvailable: boolean
  /** A real local native Windows agent is reachable (Phase 1.2). */
  nativeAgentAvailable: boolean
  /** The native agent's approved application control is live (Phase 1.3). */
  nativeApplicationAvailable: boolean
  /** Read-only Windows observation (windows + desktop) is live (Phase 1.4). */
  nativeObservationAvailable: boolean
  /** Bounded Windows desktop input injection is live (Phase 1.5). */
  nativeDesktopInteractionAvailable: boolean
  /** A real VisionProvider is configured and analyses screenshots (Phase 1.7). */
  visionAvailable: boolean
  /** The configured vision provider can read text (OCR) (Phase 1.7). */
  ocrAvailable: boolean
  /** The configured vision provider can segment UI elements (Phase 1.7). */
  uiElementDetectionAvailable: boolean
  /** The configuration resolves a target instruction onto detected elements. */
  targetLocalizationAvailable: boolean
  /** A real browser webcam surface is present (Phase 2.7). */
  cameraAvailable: boolean
  /** The JARVIS Core persistent backend and its device bridge are reachable (Phase 2.8). */
  deviceBridgeAvailable: boolean
  /** The native Windows agent provides bounded web access (search/fetch/download) (Phase 2.9). */
  webAccessAvailable: boolean
}