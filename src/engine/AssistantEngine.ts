import type { AIProvider, AIResponse, AIMessage, ToolCallRecord, ToolResultRecord } from './provider'
import { createProviders } from './providers'
import { ProviderError, userFacing } from './providers/ProviderError'
import {
  ToolRegistry,
  ClockTool,
  CalculatorTool,
  NotesTool,
  SystemInfoTool,
} from '../tools'
import type { Tool, ToolContext, ToolInput, ToolRetryPolicy } from '../tools'
import { MemoryManager } from '../memory/MemoryManager'
import type {
  MemoryItem,
  MemoryType,
  Profile,
  UserPreferences,
  EmbeddingHealthSummary,
} from '../memory/MemoryManager'
import { buildMemoryContext } from '../memory/context'
import { DEFAULT_HYBRID_CONFIG } from '../memory/hybridRanking'
import { DEFAULT_MEMORY_CONTEXT_LIMIT } from '../memory/context'
import { getDefaultEmbeddingManager } from '../memory/embeddingManager'
import {
  ConversationContextManager,
} from './conversationContextManager'
import type { ConversationWindowContext } from './conversationContextManager'
import { shouldAutoCapture, detectMemoryType } from '../memory/detect'
import type {
  ArchivedMemory,
  LifecycleReport,
} from '../memory/lifecycle'
import type { Episode } from '../memory/episodes'
import { useJarvisStore } from '../state/jarvis.store'
import { useConversationStore } from '../state/conversation.store'
import { addUserMessage, addAssistantMessage } from '../conversation'
import type { ConversationMessage } from '../conversation/types'
import type { VoiceOutput } from '../voice/VoiceOutput'
import type {
  EngineOutMessage,
  MemoryActivityAction,
  AwaitingConfirmation,
  ToolConfirmationRequest,
  ActivityOut,
  ActivityStatus,
  GoalPlanView,
  GoalPlanStepView,
  GoalPlanRecoveryView,
} from './contracts'
import { canHear, canSpeak } from '../utils/capabilities'
import { buildSystemPrompt } from '../config/personality'
import { createFileSystemProvider, createFileSystemTools } from '../filesystem'
import type { FileSystemProvider } from '../filesystem'
import { createApplicationTools } from '../applications'
import type { ApplicationProvider } from '../applications'
import { createObservationTools } from '../observation'
import type { ObservationProvider } from '../observation'
import { createDesktopTools, sanitizeDesktopPayload, desktopBudgetBucket, desktopBudgetExceeded, desktopBudgetLabel } from '../desktop'
import type { DesktopProvider } from '../desktop'
import { createVisualComputerTools, sanitizeVisionPayload, visualBudgetBucket, visualBudgetExceeded, visualBudgetLabel } from '../vision'
import type { VisionProvider } from '../vision'
import { createDeviceTools } from '../device'
import type { DeviceProvider } from '../device'
import { createAndroidCallTools } from '../android'
import type { AndroidProvider } from '../android'
import { setDeviceProvider as setStoreDeviceProvider } from '../device'
import type { DeviceErrorKind } from '../backend/types'
import { createWebTools } from '../web'
import type { WebProvider } from '../web'
import { createClipboardTools } from '../clipboard'
import type { ClipboardProvider } from '../clipboard'
import { createBrowserTools } from '../browser'
import type { BrowserProvider } from '../browser'
import { createSchedulerTools } from '../scheduling/schedulerTools'
import type { SchedulerAdapter } from '../scheduling/scheduler'
import { CapabilityRegistry, DEFAULT_CAPABILITIES, toCapabilityDefinition, recordReliability } from './capabilities'
import type { CapabilityContext, CapabilityPreview, CapabilityReliabilityIndex } from './capabilities'
import { discoverCapabilities } from './orchestrator/capabilityDiscovery'
import { understandRequest, type RequestClass } from './orchestrator/goalUnderstanding'
import { extractEntitiesFromResult, TaskContextStore } from './orchestrator/taskContext'
import { PersonalAICore } from './orchestrator/orchestrator'
import { planRequest } from './orchestrator/planner'
import { MOCK_PROVIDER_ID, checkAiHealth } from '../config/ai'
import { planPostActionObservation } from './orchestrator/postActionVerify'
import { applyResolutionToStepMeta } from './orchestrator/phase6/enrich'
import type { Phase6StepMeta } from './orchestrator/phase6/planTypes'
import { decideStepReadiness } from './orchestrator/phase6/condition'
import type { StepOutcomeView } from './orchestrator/phase6/condition'
import { ExecutionContext as Phase6ExecutionContext } from './orchestrator/phase6/executionContext'
import { decideReplan } from './orchestrator/phase6/replan'
import type { AlternativeResolver } from './orchestrator/phase6/replan'
import { createExecutionState, transitionPhase, updateStepState, buildFinalResult } from './orchestrator/executionState'
import type { AgenticExecutionState, StepState } from './orchestrator/executionState'
import type { OrchestrationPlanStep, OrchestrationPlannedRequest, OrchestrationPlanContext } from './orchestrator/planner'
import type { OrchestrationExecutionResult, OrchestrationExecutionStatus, OrchestrationStepOutcome, OrchestrationVerificationStatus } from './orchestrator/execution'
import type { OrchestrationRequest, PersonalAICoreView } from './orchestrator/types'
import { isStructuredPlanProvider, reasoningFailureKind } from './reasoning/provider'
import {
  SYNTHESIS_LIMITS,
  buildSynthesisFacts,
  buildSynthesisMessages,
  composeFinalAnswer,
  hasSynthesizableFacts,
  normalizeSynthesisText,
  synthesisUpgradesVerdict,
} from './orchestrator/answerSynthesis'
import type { StructuredPlanProvider } from './reasoning/provider'
import type { ReasoningRequest } from './reasoning/contract'
import { REASONING_PLAN_LIMITS } from './reasoning/contract'
import { buildReasoningRequest } from './reasoning/context'
import { parseAndValidatePlan } from './reasoning/validate'
import { defaultAutonomy, isAutonomyLevel, autonomyAllowsAuto } from './autonomy/policy'
import type { AutonomyLevel } from './autonomy/policy'
import { AUTONOMY_LEVEL_LABELS } from './autonomy/policy'
import { InMemoryTaskLog, createTaskId } from './observability/taskLog'
import type { TaskLog, TaskLogEntry, TaskLogStep, TaskLogFailure } from './observability/taskLog'
import {
  GOAL_LIMITS,
  taskBudgetExceeded,
  taskBudgetRemaining,
  recoveryBudgetExceeded,
  replanBudgetRemaining,
  deadlineReached as goalDeadlineReached,
  validatePlan,
  evaluateGoalTask,
  countRecoveries,
  classifyPlanStep,
  classifyRecovery,
  requestSignature,
  planSignature,
  repeatedFailureDetected,
  REPLAN_LIMITS,
} from './goal'
import type { GoalLimits, GoalTaskResult, PlanStepRequest, PlanVerdictCode, PlanStepResolution, PlanValidation } from './goal'
import type { CapabilityDefinition } from './capabilities'
import type { AIProviderInfo } from './provider'
import {
  PlanTracker,
  decidePermission,
  shouldRetry,
  runToolOnce,
  summarizeToolResult,
  AGENT_LIMITS,
  AgentStateMachine,
  ExecutionTracer,
  evaluateLoopState,
  isRepeatedActionBlocked,
  runToolVerification,
  verificationSuffix,
  verificationPassed,
  classifyObservation,
  validateToolArguments,
} from './agent'
import type { AgentState } from './agent'
import type { JarvisStatus } from './types'
import {
  detectDirectIntent,
  capabilityCatalogReply,
  renderCapabilityCatalogReply,
  normalizeChannel,
  channelInteractionMode,
  categoryLabel,
} from './interaction'
import type { CameraIntent, InputChannel, CatalogEnvironment } from './interaction'
import { detectUiControlCommands, environmentChoices, panelChoices, themeChoices } from './interaction/uiControl'
import type { JarvisTheme } from '../themes'
import { THEME_META, nextTheme } from '../themes'
import type { UiControlIntent } from './interaction/uiControl'
import { executeGestureCommand } from '../gesture/executor'
import type { GestureActionResult, GestureCommand } from '../gesture'
import { usePanelLayoutStore } from '../panel/panelStore'
import { PANEL_BY_ID } from '../panel/registry'
import {
  DEFAULT_ENVIRONMENT,
  isEnvironmentId,
  stepEnvironment,
  environmentLabel,
} from '../environment/registry'
import type { VisualEnvironmentId } from '../environment/types'
import { describeCameraFrame, CAMERA_UNAVAILABLE_MESSAGE } from '../camera'
import type { CameraController } from '../camera'
import type { AgentTrace } from './agent'
import type { AgentErrorKind, AgentStepStatus, ObservationKind, RecoveryAction, RecoveryFailureKind, VerificationStatus } from './agent/types'
import {
  classifyRequest,
  isRiskyDeictic,
  createActionRegistryView,
  resolveFollowUp,
  ExecutionContextStore,
  fillExecutionContext,
  extractFileArtifacts,
  classifyExecutionOutcome,
  makeExecutionError,
  executionKindFromAgent,
  actionHintMessage,
  unsupportedMessage,
  clarificationMessage,
} from './action'
import type {
  ActionKind,
  ActionRegistryView,
  ExecutionContext,
  ExecutionErrorEntry,
  ExecutionOutcome,
  ExecutionRunFacts,
} from './action'

/**
 * JARVIS 0.4 — Multi-step Agent Engine
 *
 * Flow:
 *   USER INPUT
 *     ↓
 *   CONTEXT BUILDER (conversation + memory + tool catalog)
 *     ↓
 *   PROVIDER REASONING (one or more rounds)
 *     ↓
 *   TOOL REQUESTS → PERMISSION GATE → CONFIRMATION (if needed) → EXECUTION
 *     ↓
 *   TOOL RESULTS → SUMMARIZE → FEED BACK TO PROVIDER
 *     ↓
 *   REASON AGAIN → MORE TOOLS OR FINAL RESPONSE
 *     ↓
 *   COMPLETE / CANCEL / LIMIT
 *
 * Safety rails:
 *   - Hard limits on total steps, rounds, wall time
 *   - Per-tool timeout
 *   - Controlled retries only for transient failures
 *   - Explicit confirmation for user_confirmation tools
 *   - Cancellation at any point
 *   - Memory clear-all keeps its dedicated extra gate
 */

const CONTEXT_WINDOW = 8

/** Request classes the mock+local orchestrator interception genuinely plans.
 * Chat/question/follow_up/conversation classes must keep flowing to the
 * provider loop (chat, clock, calculator, notes). */
const ACTIONABLE_ORCHESTRATION_CLASSES: ReadonlySet<RequestClass> = new Set<RequestClass>([
  'command',
  'device_operation',
  'multi_step_goal',
  'cross_device_workflow',
  'web_research',
  'status_request',
])

/**
 * Phase 2.2 — one failed step reported back from executeToolSteps so the
 * recovery layer can classify it and apply a bounded action. Pre-execution
 * rail refusals (orchestration limits, repeated-action blocks, desktop/visual/
 * task budget rails) are deliberately EXCLUDED: they are already honest
 * refusals fed back to the model and the loop-top gates bound runaway.
 */
interface StepFailure {
  toolId: string
  /** Plan-step id when the tracker recorded one for this failure. */
  stepId?: string
  summary: string
  errorKind?: AgentErrorKind
  observationKind?: ObservationKind
  retryable?: boolean
  /** Structured device-error code (Work 11.9), when a device tool failed. */
  deviceCode?: DeviceErrorKind
  /** Plan-validation code, when this failure was a rejected plan step. */
  planCode?: PlanVerdictCode
  /** Sanitized payload used to compute the same-action signature. */
  payload?: Record<string, unknown>
}

/** Extract a structured device-error code from a failed tool's output, if any. */
function deviceFailureCode(output: unknown): DeviceErrorKind | undefined {
  if (typeof output !== 'object' || output === null) return undefined
  const code = (output as { deviceError?: unknown }).deviceError
  if (typeof code !== 'string') return undefined
  return code as DeviceErrorKind
}

/** Phase 6 — honest summary of one orchestrated run (per-step outcome counts,
 * recovery/replan usage and how the run stopped). Never replaces the user-facing
 * result; it is the observable record for tests, the UI and the acceptance
 * report. */
interface Phase6RunSummary {
  planId?: string
  elapsedMs: number
  phase: string
  executedSteps: number
  verifiedSteps: number
  failedSteps: number
  blockedSteps: number
  skippedSteps: number
  cancelledSteps: number
  recoveryAttempts: number
  replanAttempts: number
  replanLimit: number
  stoppedBy:
    | 'cancellation'
    | 'deadline'
    | 'failure'
    | 'recovery_limit'
    | 'replan_limit'
    | 'completed'
    | 'precondition'
}

export class AssistantEngine {
  private available: AIProvider[]
  private provider: AIProvider
  private registry = new ToolRegistry()
  // Phase 2.3 — bounded capability catalogue. The registry maps high-level
  // capabilities (e.g. `open_application`) to REGISTERED implementation tools;
  // it is engine-owned ADMIN state. The model can only NAME a capability, never
  // register, modify or re-map one. Only capabilities with a real registration
  // here are exposed to the provider.
  private capabilities = new CapabilityRegistry()
  // Phase 2.4 — bounded reliability history used ONLY as a weak ranking signal
  // when several implementations can implement one capability. Persists across
  // runs (learning), is content-free and bounded (catalogue × tool keys), and
  // can never override permission, availability, risk, verification, budgets
  // or cancellation — the ranker places it strictly below those objectives.
  private capabilityReliability: CapabilityReliabilityIndex = new Map()
  private fileSystem: FileSystemProvider
  private applications: ApplicationProvider | undefined
  private observation: ObservationProvider | undefined
  private desktop: DesktopProvider | undefined
  private vision: VisionProvider | undefined
  // Phase 2.7 — the browser WEB-CAM surface. OPTIONAL in exactly the same way
  // as the desktop seams: the app binds a real CameraController, otherwise
  // camera commands are answered honestly as unavailable and nothing is faked.
  private camera: CameraController | null = null
  // Phase 2.8 — the device bridge seam. OPTIONAL in the same way as the other
  // seam providers: without a reachable JARVIS Core backend it is absent and
  // no device.* tools are ever registered.
  private device: DeviceProvider | undefined
  // Phase 2.9 — the web capability seam. OPTIONAL in the same way as the other
  // seam providers: without a reachable native Windows agent it is absent and
  // no web.* tools are ever registered.
  private web: WebProvider | undefined
  // Phase 4.0 — the clipboard capability seam. OPTIONAL in the same way as the
  // other seam providers: without a reachable native Windows agent it is absent
  // and no clipboard.* tools are ever registered.
  private clipboard: ClipboardProvider | undefined
  // Phase 4.0 — the browser automation capability seam. OPTIONAL in the same
  // way as the other seam providers: without a reachable native Windows agent
  // or Playwright not installed, it is absent and no browser.* tools are
  // ever registered.
  private browser: BrowserProvider | undefined
  private scheduling: SchedulerAdapter | undefined
  // Phase 10 — the Android companion TELEPHONY seam. OPTIONAL in exactly the
  // same way as the other seams: without a paired phone (or without the
  // backend) no call.* tool is ever registered, so the model can never claim
  // call reach it does not have. Every call still flows through the existing
  // permission, confirmation, budget, cancellation and verification rails.
  private android: AndroidProvider | undefined
  // Phase 3.0 — task context store for follow-up resolution and deictic references.
  private taskContextStore: TaskContextStore
  // Phase 3.0A — one stateless central orchestration core shared across runs.
  private readonly core = new PersonalAICore()
  // Phase 3.0B — dedicated pipeline guard for bridge-executed plans. The full
  // process() turn uses `running`; bridge runs use this flag so "Stop." can
  // cancel an in-flight orchestrated plan through the SAME cancellation rail
  // without ever being mistaken for a provider turn.
  private orchestrationActive = false
  private desktopMouseActions = 0
  private desktopKeyActions = 0
  private visualActions = 0
  // Phase 2.0 — goal-owned counters. The MODEL can never read or reset these;
  // they are engine-only state for the task budget + bounded recovery.
  private taskSteps = 0
  // Phase 2.1 — monotonic tool-call sequence so call IDs are unique across the
  // whole run. `Date.now()` does not tick between rounds and the per-round
  // index resets, which previously let consecutive rounds COLLIDE on
  // `call-…-0` and merge (or hide) plan steps in the tracker.
  private callSeq = 0
  private readonly goalLimits: GoalLimits
  private runAbort: AbortController | null = null
  private memory = new MemoryManager()
  private conversationContext = new ConversationContextManager({ recentCount: CONTEXT_WINDOW })
  private planTracker = new PlanTracker()
  private runState = new AgentStateMachine()
  private tracer = new ExecutionTracer()
  private executedActions: Array<{ toolId: string; input?: Record<string, unknown> }> = []
  /** Phase 6 — last orchestration run summary (inspectable for the UI/tests). */
  private _lastPhase6Run?: Phase6RunSummary

  /** Phase 6 — read-only accessor for the last orchestration run summary. */
  get lastPhase6Run(): Phase6RunSummary | undefined {
    return this._lastPhase6Run
  }
  private voiceOutput: VoiceOutput | null = null
  private listeners = new Set<(m: EngineOutMessage) => void>()
  private running = false
  /** True while process() is running an orchestration plan INLINE (the mock
   * path). Keeps the re-entrancy guard meaningful for concurrent turns while
   * allowing the planner→executor bridge to run within the current turn. */
  private orchestratingInline = false
  private awaiting: AwaitingConfirmation | null = null
  private cancelRequested = false
  private taskDeadline = 0
  // Phase 2.2 — bounded recovery & replan state (engine-only, reset per run).
  // Counters never reset from replanning: trace, evidence and every budget
  // survive every replan, and the loop-top recovery gate still stops a goal
  // that keeps leaving evidence unverified.
  private replansUsed = 0
  // Phase 2.5 — the input channel of the CURRENT run ('text' by default).
  // Mirrors how the request reached the engine (voice/visual are supported
  // seams; gesture is reserved). Only used as a bounded capability-resolution
  // context signal — never as an execution branch.
  private activeInputChannel: InputChannel = 'text'
  private reobserveAttempts = 0
  private failureHistory: string[] = []
  private priorFailedPlanSignature: string | null = null
  private replanContext: {
    toolId: string
    summary: string
    kind: RecoveryFailureKind
    action: RecoveryAction
    reason: string
  } | null = null
  // Phase 2.6 — bounded, conversation-scoped execution-context store. Only the
  // engine commits records; nothing here is provider-viewable chain-of-thought.
  private readonly executionContexts = new ExecutionContextStore()
  /** Phase 2.6 — engine-selected mechanism hint for the CURRENT run (reset per
   * run, injected into the provider messages as informational guidance). */
  private actionHint: string | null = null
  /** Phase 2.6 — run facts captured when the action layer routes ONE request;
   * committed (with real outcome + artifacts) when the run terminates. */
  private actionRun: ExecutionRunFacts | null = null
  // Phase 3.0 — bounded autonomy policy (engine-owned; the model can never
  // raise it). Default `assisted` reproduces pre-Phase-3.0 behavior exactly.
  private autonomyLevel: AutonomyLevel = defaultAutonomy()
  // Phase 3.0 — structured task-execution log (injectable for tests/future sync).
  private taskLog: TaskLog

  constructor(options?: { providers?: AIProvider[]; fileSystem?: FileSystemProvider; applications?: ApplicationProvider; observation?: ObservationProvider; desktop?: DesktopProvider; vision?: VisionProvider; camera?: CameraController | null; device?: DeviceProvider; web?: WebProvider; clipboard?: ClipboardProvider; browser?: BrowserProvider; scheduling?: SchedulerAdapter; android?: AndroidProvider; goalLimits?: Partial<GoalLimits>; capabilities?: CapabilityDefinition[]; autonomyLevel?: AutonomyLevel; taskLog?: TaskLog }) {
    // Phase 1.0 — provider injection seam: tests inject a scripted provider;
    // production defaults to the configured provider stack unchanged.
    const providers = options?.providers && options.providers.length ? [...options.providers] : createProviders()
    this.available = [...providers]
    this.provider = providers[0]
    this.autonomyLevel = options?.autonomyLevel !== undefined && isAutonomyLevel(options.autonomyLevel)
      ? options.autonomyLevel
      : defaultAutonomy()
    this.taskLog = options?.taskLog ?? new InMemoryTaskLog()
    // Phase 2.0 — goal budget limits are ADMIN-configured engine state. They
    // can never be lowered by the model; only engine construction may tune
    // the conservative defaults (see goal/budget.ts for the justification).
    this.goalLimits = { ...GOAL_LIMITS, ...options?.goalLimits }
    // Phase 1.1 — filesystem capability seam: tests inject a deterministic
    // fake provider; production defaults to the real browser File System
    // Access provider (which honestly reports when access is unavailable).
    // Phase 1.2 — the app bootstrap may hand in the native Windows bridge
    // provider instead; both speak the same FileSystemProvider contract.
    this.fileSystem = options?.fileSystem ?? createFileSystemProvider()
    this.registry.register(new ClockTool())
    this.registry.register(new CalculatorTool())
    this.registry.register(new NotesTool())
    this.registry.register(new SystemInfoTool())
    for (const tool of createFileSystemTools(this.fileSystem)) {
      this.registry.register(tool)
    }
    // Phase 1.3 — application capability seam. The provider is OPTIONAL:
    // browser mode supplies none, so the app.* tools are never registered and
    // the model never sees a fabricated application surface.
    this.applications = options?.applications
    for (const tool of createApplicationTools(this.applications)) {
      this.registry.register(tool)
    }
    // Phase 1.4 — observation capability seam (EYES, NOT HANDS). The provider
    // is OPTIONAL in exactly the same way: browser mode supplies none, so the
    // window.list / window.status / desktop.screenshot tools are never
    // registered and the model can never describe a screen it did not see.
    this.observation = options?.observation
    for (const tool of createObservationTools(this.observation)) {
      this.registry.register(tool)
    }
    // Phase 1.5 — desktop-interaction capability seam (HANDS). OPTIONAL in the
    // same way: browser mode supplies none, so the desktop.* / window.focus
    // tools are never registered and the model can never inject input it
    // cannot bound. Real injected input is further framed by per-RUN budgets
    // (see executeToolSteps) and redaction of typed text on traces/plans.
    this.desktop = options?.desktop
    for (const tool of createDesktopTools(this.desktop)) {
      this.registry.register(tool)
    }
    // Phase 1.7 — visual-understanding capability seam (EYES BEFORE HANDS). The
    // provider is OPTIONAL in exactly the same way: browser/app mode supplies
    // none (no real VisionProvider is configured), so the desktop.visual* tools
    // are NEVER registered and the model can never claim to see. When a real
    // provider IS configured, the tools compose the existing observation +
    // desktop providers so every existing rail still applies.
    this.vision = options?.vision
    for (const tool of createVisualComputerTools(this.vision, this.observation, this.desktop)) {
      this.registry.register(tool)
    }
    // Phase 2.7 — the browser camera seam (never fabricated). When absent, the
    // engine answers camera commands honestly as unavailable.
    this.camera = options?.camera ?? null
    // Phase 2.8 — the device bridge seam (never fabricated). When the JARVIS
    // Core backend is unreachable, no device.* tools exist and the model can
    // never claim phone reach it does not have.
    this.syncDevice(options?.device)
    // Phase 10 — the Android companion telephony seam (never fabricated). When
    // no paired phone is reachable, no call.* tools exist and the model can
    // never claim it can place a call.
    this.syncAndroid(options?.android)
    // Phase 2.9 — the web capability seam (never fabricated). When the native
    // Windows agent is unreachable, no web.* tools exist and the model can
    // never claim internet access it does not have.
    this.syncWeb(options?.web)
    // Phase 4.0 — the clipboard capability seam (never fabricated). When the
    // native Windows agent is unreachable, no clipboard.* tools exist and the
    // model can never claim clipboard access it does not have.
    this.syncClipboard(options?.clipboard)
    // Phase 4.0 — the browser automation capability seam (never fabricated).
    // When the native Windows agent is unreachable or Playwright is not
    // installed, no browser.* tools exist and the model can never claim
    // browser access it does not have.
    this.syncBrowser(options?.browser)
    // Phase 11 — the scheduling seam (real reminders). Always present in the
    // browser app (LocalScheduler); tools registered here so the model can
    // act on "remind me at 7 PM". Without a seam, scheduling tools vanish.
    this.syncScheduling(options?.scheduling)
    // Phase 3.0 — task context store for follow-up resolution.
    this.taskContextStore = new TaskContextStore()
    // Phase 2.3 — register the default capability catalogue, but ONLY those
    // capabilities whose declared implementation tool actually registered here.
    // A capability with no real implementation is never exposed, so the model
    // can never be told it can do something this environment cannot do.
    for (const def of DEFAULT_CAPABILITIES) {
      if (def.tools.some((id) => this.registry.get(id) !== undefined) && !this.capabilities.has(def.id)) {
        this.capabilities.register(def)
      }
    }
    // Admin extension seam: explicit capability definitions (e.g. a capability
    // wired to a provider seam whose implementation tool was injected), and a
    // deterministic registry error if one declares NO registered tool.
    for (const def of options?.capabilities ?? []) {
      this.capabilities.register(def)
    }
  }

  /* ------------------------------------------------ capability catalogue */
  /** Phase 2.8 — (mid-session) bind or unbind the real device-bridge provider.
   * Safe to call at any time: it (re)registers device tools and the device
   * capability cluster only while at least one real tool exists, and never
   * duplicates a capability already registered. Without a live provider the
   * device.* tools simply do not exist, so the model can never claim phone
   * reach it does not have. */
  attachDevice(device: DeviceProvider | undefined): void {
    this.syncDevice(device)
    // Phase 2.8 — reflect the REAL bridge state in the capability snapshot.
    useJarvisStore.getState().setCapabilities({ deviceBridgeAvailable: device?.capabilities().available === true })
  }

  private syncDevice(device: DeviceProvider | undefined): void {
    // Phase 2.8 — the device surface is fully (re)built on attach and fully
    // removed on detach, so device.* tools and their capabilities exist ONLY
    // while a real, live provider is bound. Detaching over a running goal is
    // impossible: goals hold their resolved capabilities snapshot, and a
    // mid-run detach leaves the resolution guards intact.
    const deviceCapIds = new Set(
      DEFAULT_CAPABILITIES.filter((d) => d.category === 'device').map((d) => d.id),
    )
    if (this.device) {
      for (const tool of createDeviceTools(this.device)) this.registry.unregister(tool.id)
      for (const id of deviceCapIds) this.capabilities.unregister(id)
    }
    this.device = device
    // Phase 11 (Work 11.2/11.20) — the device store mirrors the real provider so
    // UI hooks reflect the actual bound bridge, never a fabricated registry.
    setStoreDeviceProvider(device)
    if (device) {
      for (const tool of createDeviceTools(device)) this.registry.register(tool)
      for (const def of DEFAULT_CAPABILITIES) {
        if (def.category === 'device' && def.tools.some((id) => this.registry.get(id) !== undefined) && !this.capabilities.has(def.id)) {
          this.capabilities.register(def)
        }
      }
    }
  }

  /** Phase 10 — (mid-session) bind or unbind the REAL Android telephony provider.
   * Safe to call at any time: it (re)registers call.* tools and the calling
   * capability cluster only while a real provider is bound, and never
   * duplicates a capability already registered. Without a live provider the
   * call.* tools simply do not exist, so the model can never claim calling
   * reach it does not have. */
  attachAndroid(android: AndroidProvider | undefined): void {
    this.syncAndroid(android)
    // Reflect the REAL calling surface in the capability snapshot the HUD reads.
    useJarvisStore.getState().setCapabilities({ callingEnabled: android?.capabilities().available === true })
  }

  private syncAndroid(android: AndroidProvider | undefined): void {
    // The calling cluster is identified by its declared implementation tool ids
    // (call.*), so detaching truly removes exactly the call surface.
    const callCapIds = DEFAULT_CAPABILITIES.filter((d) => d.tools.some((id) => id.startsWith('call.'))).map((d) => d.id)
    const callToolIds = new Set(createAndroidCallTools(android).map((tool) => tool.id))
    if (this.android) {
      for (const tool of createAndroidCallTools(this.android)) this.registry.unregister(tool.id)
      for (const id of callCapIds) this.capabilities.unregister(id)
    }
    this.android = android
    if (android) {
      for (const tool of createAndroidCallTools(android)) this.registry.register(tool)
      for (const def of DEFAULT_CAPABILITIES) {
        if (def.tools.some((id) => callToolIds.has(id)) && !this.capabilities.has(def.id)) {
          this.capabilities.register(def)
        }
      }
    }
  }

  /** Phase 2.9 — (mid-session) bind or unbind the real web capability provider.
   * Safe to call at any time: it (re)registers web tools and the web
   * capability cluster only while at least one real tool exists, and never
   * duplicates a capability already registered. Without a live provider the
   * web.* tools simply do not exist, so the model can never claim internet
   * access it does not have. */
  attachWeb(web: WebProvider | undefined): void {
    this.syncWeb(web)
    useJarvisStore.getState().setCapabilities({ webAccessAvailable: web?.capabilities().available === true })
  }

  private syncWeb(web: WebProvider | undefined): void {
    const webCapIds = new Set(
      DEFAULT_CAPABILITIES.filter((d) => d.category === 'web').map((d) => d.id),
    )
    if (this.web) {
      for (const tool of createWebTools(this.web)) this.registry.unregister(tool.id)
      for (const id of webCapIds) this.capabilities.unregister(id)
    }
    this.web = web
    if (web) {
      for (const tool of createWebTools(web)) this.registry.register(tool)
      for (const def of DEFAULT_CAPABILITIES) {
        if (def.category === 'web' && def.tools.some((id) => this.registry.get(id) !== undefined) && !this.capabilities.has(def.id)) {
          this.capabilities.register(def)
        }
      }
    }
  }

  /** Phase 4.0 — (mid-session) bind or unbind the real clipboard provider.
   * Safe to call at any time: it (re)registers clipboard tools and the
   * clipboard capability cluster only while at least one real tool exists.
   * Without a live provider the clipboard.* tools simply do not exist. */
  attachClipboard(clipboard: ClipboardProvider | undefined): void {
    this.syncClipboard(clipboard)
  }

  private syncClipboard(clipboard: ClipboardProvider | undefined): void {
    const capIds = new Set(
      DEFAULT_CAPABILITIES.filter((d) => d.category === 'clipboard').map((d) => d.id),
    )
    if (this.clipboard) {
      for (const tool of createClipboardTools(this.clipboard)) this.registry.unregister(tool.id)
      for (const id of capIds) this.capabilities.unregister(id)
    }
    this.clipboard = clipboard
    if (clipboard) {
      for (const tool of createClipboardTools(clipboard)) this.registry.register(tool)
      for (const def of DEFAULT_CAPABILITIES) {
        if (def.category === 'clipboard' && def.tools.some((id) => this.registry.get(id) !== undefined) && !this.capabilities.has(def.id)) {
          this.capabilities.register(def)
        }
      }
    }
  }

  /** Phase 4.0 — (mid-session) bind or unbind the real browser provider.
   * Safe to call at any time: it (re)registers browser tools and the
   * browser capability cluster only while at least one real tool exists.
   * Without a live provider the browser.* tools simply do not exist. */
  attachBrowser(browser: BrowserProvider | undefined): void {
    this.syncBrowser(browser)
  }

  private syncBrowser(browser: BrowserProvider | undefined): void {
    const capIds = new Set(
      DEFAULT_CAPABILITIES.filter((d) => d.category === 'browser').map((d) => d.id),
    )
    if (this.browser) {
      for (const tool of createBrowserTools(this.browser)) this.registry.unregister(tool.id)
      for (const id of capIds) this.capabilities.unregister(id)
    }
    this.browser = browser
    if (browser) {
      for (const tool of createBrowserTools(browser)) this.registry.register(tool)
      for (const def of DEFAULT_CAPABILITIES) {
        if (def.category === 'browser' && def.tools.some((id) => this.registry.get(id) !== undefined) && !this.capabilities.has(def.id)) {
          this.capabilities.register(def)
        }
      }
    }
  }

  /** Phase 11 — (mid-session) bind or unbind the real scheduler seam.
   * Safe to call at any time: it (re)registers scheduling tools and the
   * scheduling capability cluster only while at least one real tool exists. */
  attachScheduling(scheduling: SchedulerAdapter | undefined): void {
    this.syncScheduling(scheduling)
  }

  private syncScheduling(scheduling: SchedulerAdapter | undefined): void {
    const capIds = new Set(
      DEFAULT_CAPABILITIES.filter((d) => d.category === 'scheduling').map((d) => d.id),
    )
    if (this.scheduling) {
      for (const tool of createSchedulerTools(this.scheduling)) this.registry.unregister(tool.id)
      for (const id of capIds) this.capabilities.unregister(id)
    }
    this.scheduling = scheduling
    if (scheduling) {
      for (const tool of createSchedulerTools(scheduling)) this.registry.register(tool)
      for (const def of DEFAULT_CAPABILITIES) {
        if (def.category === 'scheduling' && def.tools.some((id) => this.registry.get(id) !== undefined) && !this.capabilities.has(def.id)) {
          this.capabilities.register(def)
        }
      }
    }
  }

  /** Phase 2.3 — registered capability definitions the model may name.
   * Snapshot only: the model can never vote to add or change these. */
  capabilityCatalog(): CapabilityDefinition[] {
    return this.capabilities.all()
  }

  /** Phase 11 — the live scheduled reminders (real scheduler state). */
  scheduledItems(): ReadonlyArray<{ id: string; text: string; kind: 'once' | 'daily' | 'weekly'; at?: number; time?: string; weekday?: number; nextRun: number; lastResult?: string }> {
    return this.scheduling?.list() ?? []
  }

  /** Phase 2.3 — admin/extension seam: register an additional capability with
   * the same bounded semantics (throws on duplicate / empty / no tools). The
   * model cannot reach this — engine construction and admin code only. */
  registerCapability(def: CapabilityDefinition): void {
    this.capabilities.register(def)
  }

  /** Phase 3.0 — the engine-owned autonomy policy (never model-controlled). */
  autonomyProfile(): { level: AutonomyLevel; label: string } {
    return { level: this.autonomyLevel, label: AUTONOMY_LEVEL_LABELS[this.autonomyLevel] }
  }

  /** Phase 3.0 — set the autonomy level. Validated; the hard floor (destructive /
   * external / unknown categories) is still never waived at any level. */
  setAutonomyLevel(level: AutonomyLevel): void {
    if (isAutonomyLevel(level)) this.autonomyLevel = level
  }

  /** Phase 3.0 — bounded, content-free structured task-execution log. */
  taskExecutionLog(): readonly TaskLogEntry[] {
    return this.taskLog.entries()
  }

  /** Phase 3.0 — discover capabilities across all connected devices. */
  async discoverCapabilities(): Promise<{
    devices: Array<{
      deviceId: string
      deviceName: string
      deviceType: 'pc' | 'phone'
      online: boolean
      capabilities: Array<{ id: string; name: string; category: string; available: boolean; reason?: string }>
      categories: string[]
    }>
    globalCapabilities: Array<{ id: string; name: string; category: string; availableOn: string[] }>
    unavailableCapabilities: string[]
    discoveredAt: number
  }> {
    const devices = await this.deviceProvider?.refresh() || []
    return await discoverCapabilities(this.buildOrchestratorView(), devices)
  }

  /** Phase 3.0 — understand a user request in context. */
  async understand(text: string): Promise<{
    class: string
    confidence: number
    targetDevices: string[]
    intent?: string
    entities: Record<string, unknown>
    requiresContext: boolean
    suggestedCapabilities: string[]
    isContinuation: boolean
    contextReference?: string
    explanation: string
  }> {
    const context = {
      devices: await this.deviceProvider?.refresh() || [],
      hasActiveTask: this.runState.active,
      lastTaskContext: this.taskContextStore?.getContext(),
      availableCapabilities: this.capabilityCatalog().map(c => c.id),
    }
    const understanding = understandRequest(text, context)
    return {
      ...understanding,
      targetDevices: understanding.targetDevices || [],
    }
  }

  /** Phase 3.0A — central orchestration entry: raw input → OrchestrationRequest.
   * Reuses the Phase 2.x architecture through the Personal AI Core and NEVER
   * executes the goal; Phase 3.0B wires the request into plan/execute. */
  async orchestrate(text: string): Promise<OrchestrationRequest> {
    return this.core.orchestrate(text, this.buildOrchestratorView())
  }

  /** Phase 3.0A — the lazy structural view the core needs. Only presence flags
   * and identity are inspected; providers are never executed through this. */
  private buildOrchestratorView(): PersonalAICoreView {
    return {
      capabilityCatalog: () => this.capabilityCatalog(),
      taskContextStore: this.taskContextStore,
      deviceProvider: this.deviceProvider,
      hasActiveTask: () => this.runState.active,
      fileSystem: this.fileSystem,
      applications: this.applications,
      observation: this.observation,
      desktop: this.desktop,
      vision: this.vision,
      camera: this.camera,
      web: this.web,
      clipboard: this.clipboard,
    }
  }

  /* ------------------------------------------------ Phase 3.0B bridge */

  /** Phase 3.0B — deterministic bounded plan for one orchestration request.
   * Pure composition over the existing planner; reads only committed state
   * (task-context artifacts) and NEVER executes anything. */
  planOrchestrated(
    request: OrchestrationRequest,
    context?: OrchestrationPlanContext,
  ): OrchestrationPlannedRequest {
    return planRequest(request, context ?? this.orchestrationContext())
  }

  /** Phase 3.0B — the committed task-context artifacts (real, never guessed). */
  private orchestrationContext(): OrchestrationPlanContext {
    return { artifacts: this.taskContextStore.getContext().artifacts ?? [] }
  }

  /**
   * Phase 3.0B — execute ONE orchestration request through the EXISTING
   * Phase 2.x rails (validate → execute → observe → verify) and return a
   * structured result. This is the planning→execution BRIDGE: it never runs a
   * second engine and never replaces `process()`. Simple requests get simple
   * answerable results without any capability execution.
   */
  async executeOrchestrated(request: OrchestrationRequest): Promise<OrchestrationExecutionResult> {
    // Cancellation is always reachable — even while the loop or another bridge
    // run is mid-turn — and reuses the existing cancellation mechanism.
    if (request.requestClass === 'cancellation') {
      if (this.running || this.hasPendingConfirmation || this.orchestrationActive) {
        this.cancelCurrentTask()
        const result = this.makeResult(request, 'cancelled', [], 'Cancelled via the existing cancellation rail.')
        this.recordTaskLogFor(request, result)
        return result
      }
      const result = this.makeResult(request, 'completed', [], 'No active task was running to cancel.')
      this.recordTaskLogFor(request, result)
      return result
    }

    if (this.running && !this.orchestratingInline) {
      const result = this.makeResult(request, 'blocked', [], 'Another task is already running through the assistant loop.')
      this.recordTaskLogFor(request, result)
      return result
    }
    if (this.orchestrationActive) {
      const result = this.makeResult(request, 'blocked', [], 'Another orchestrated plan is already executing.')
      this.recordTaskLogFor(request, result)
      return result
    }

    // Confirmation relay: a plain confirmation while the engine awaits one is
    // surfaced honestly — the engine itself still holds the decision.
    if (request.requestClass === 'confirmation') {
      if (this.hasPendingConfirmation) {
        const result = this.makeResult(request, 'requires_confirmation', [], 'The engine is already awaiting an explicit confirmation.')
        this.recordTaskLogFor(request, result)
        return result
      }
      const result = this.makeResult(request, 'completed', [], 'No pending confirmation to resolve.')
      this.recordTaskLogFor(request, result)
      return result
    }

    this.orchestrationActive = true
    this.cancelRequested = false
    try {
      // Plan (deterministic, bounded, composition-only).
      const plan = this.planOrchestrated(request)
      if (plan.verdict === 'clarification') {
        const result = this.makeResult(request, 'requires_clarification', plan.steps, plan.reason)
        this.recordTaskLogFor(request, result)
        return result
      }
      if (plan.verdict === 'blocked') {
        const result = this.makeResult(request, 'blocked', plan.steps, plan.reason)
        this.recordTaskLogFor(request, result)
        return result
      }
      if (plan.verdict === 'empty') {
        const result = this.makeResult(request, 'completed', plan.steps, plan.reason ?? 'No capability execution required.')
        this.recordTaskLogFor(request, result)
        return result
      }
      if (plan.steps.length === 0) {
        const result = this.makeResult(request, 'blocked', plan.steps, 'Planned request produced no executable steps.')
        this.recordTaskLogFor(request, result)
        return result
      }

      const outcome = await this.runValidatedCapabilityPlan(request, plan)
      this.recordTaskLogFor(request, outcome.result, outcome.failures, outcome.resolutions)
      return outcome.result
    } catch (error) {
      const result = this.makeResult(
        request,
        'failed',
        [],
        error instanceof Error ? error.message : 'Unexpected bridge failure.',
      )
      this.recordTaskLogFor(request, result)
      return result
    } finally {
      this.orchestrationActive = false
    }
  }

  /**
   * Phase 13 — run ANY validated all-capability plan (deterministic planner OR
   * strictly-validated structured reasoning output) through the EXISTING
   * Phase 2.x/6 execution rails and return the observed result. `plan.steps`
   * must come from a trusted source only: the deterministic planner, or a plan
   * that already passed `parseAndValidatePlan`. Validation, permissions,
   * confirmation, budgets, observation and verification are all enforced here,
   * exactly as they are for deterministic plans.
   */
  private async runValidatedCapabilityPlan(
    request: OrchestrationRequest,
    plan: OrchestrationPlannedRequest,
  ): Promise<{ result: OrchestrationExecutionResult; failures: StepFailure[]; resolutions: PlanStepResolution[] }> {
    // Untrusted provider-facing steps from the plan (capability-level). The
    // concrete tool is chosen ONLY by validatePlan below, never by the plan.
    const steps: PlanStepRequest[] = plan.steps.map((s) => ({
      toolId: s.capability,
      capability: s.capability,
      payload: s.payload ?? {},
      dependsOn: s.dependsOn && s.dependsOn.length > 0 ? [...s.dependsOn] : undefined,
    }))

    // Pre-flight the whole round with the SAME validator the executor runs, so
    // an invalid or unavailable plan stops BEFORE any side effect.
    const preflight = validatePlan(
      steps,
      this.registry,
      this.taskSteps,
      this.goalLimits.maxTaskSteps,
      (toolId) => this.capabilityAvailable(toolId),
      this.capabilities,
      { capabilityContext: this.capabilityContext(), reliability: this.capabilityReliability },
    )
    const rejected = preflight.verdicts.filter((v) => !v.ok)
    if (rejected.length > 0) {
      const first = rejected[0]
      return {
        result: this.makeResult(
          request,
          'blocked',
          plan.steps,
          `Plan validation rejected "${first.toolId}": ${first.reason}`,
        ),
        failures: [],
        resolutions: [],
      }
    }

    // Prepared run context, mirroring process() reset semantics so budgets,
    // the repeated-action guard and the reproduction guard start clean.
    this.runState.reset()
    // Do NOT recreate the trace when one is already active for this turn: a
    // reasoned plan prefaces execution with its own reasoning lifecycle events
    // (reasoning_requested / reasoning_plan_validated ...) that must survive
    // into the final trace. Re-beginning mid-turn would silently drop them.
    if (!this.tracer.active) this.tracer.begin(plan.goal)
    this.planTracker.start(plan.goal)
    this.runState.transition('understanding')
    this.runState.transition('planning')
    this.executedActions = []

    // EXECUTE through the existing Phase 2.x rails. runPhase6Orchestrated
    // drives the plan ONE STEP PER ROUND through executeToolSteps, so each
    // step gets the same permission/confirmation/budget/verification rails,
    // and Phase 6 adds dependency+precondition gating, typed context input,
    // post-action observation and bounded recovery/replanning on top.
    const { toolResults, failures } = await this.runPhase6Orchestrated(request, plan, steps, preflight)

    // Commit artifacts from executed steps using the existing extractor, so
    // later deictic follow-ups resolve against REAL prior results.
    for (let i = 0; i < plan.steps.length && i < toolResults.length; i += 1) {
      const rec = toolResults[i]
      if (rec.ok) {
        extractEntitiesFromResult(
          plan.steps[i].capability,
          { ok: rec.ok, message: rec.message, data: rec.data },
          this.taskContextStore,
        )
      }
    }

    return {
      result: this.makeResult(
        request,
        'completed',
        plan.steps,
        undefined,
        this.tracer.snapshot(),
        failures,
        preflight.resolutions,
      ),
      failures,
      resolutions: preflight.resolutions ?? [],
    }
  }

  /**
   * Phase 13 — the structured-reasoning gate. Runs between the deterministic
   * planner and the agent loop for reasoning-capable (REAL AI) providers. The
   * AI is NEVER trusted: its output is validated against the registered
   * capability allow-list, and any valid plan still runs through the exact
   * same rails as a deterministic plan. Invalid / unsafe / unavailable output
   * is an honest refusal with NOTHING executed.
   *
   * Returns true when the turn was fully handled (reply emitted or refusal
   * issued); false falls through to the provider loop.
   */
  private async runStructuredReasoning(text: string, request: OrchestrationRequest): Promise<boolean> {
    const provider = this.provider as unknown as StructuredPlanProvider
    const reasoning = buildReasoningRequest(text, this.capabilityCatalog(), (id) => this.registry.get(id))
    if (reasoning.capabilities.length === 0) {
      this.tracer.recordEvent({
        type: 'reasoning_rejected',
        code: 'no_capabilities',
        reason: 'No registered capability is selectable in this environment.',
        at: Date.now(),
      })
      this.replyWithStructuredStop(
        request,
        'blocked',
        'I cannot act on that — no capability is registered in this environment that could perform it.',
      )
      return true
    }
    this.tracer.recordEvent({
      type: 'reasoning_requested',
      capabilities: reasoning.capabilities.length,
      at: Date.now(),
    })

    let raw: unknown
    try {
      raw = await this.reasoningPlanWithWatchdog(provider, reasoning)
    } catch (error) {
      const kind = reasoningFailureKind(error)
      this.tracer.recordEvent({ type: 'reasoning_unavailable', reason: kind, at: Date.now() })
      this.replyWithStructuredStop(
        request,
        'blocked',
        `I could not plan that request (AI planning unavailable: ${kind}) — nothing was executed.`,
      )
      return true
    }

    const validated = parseAndValidatePlan(raw, reasoning.capabilities)
    if (!validated.ok) {
      this.tracer.recordEvent({
        type: 'reasoning_rejected',
        code: validated.code,
        reason: validated.reason,
        at: Date.now(),
      })
      this.replyWithStructuredStop(
        request,
        'blocked',
        `Your request could not be turned into a safe executable plan (${validated.reason}). Nothing was run.`,
      )
      return true
    }
    const plan = validated.plan
    this.tracer.recordEvent({
      type: 'reasoning_plan_validated',
      intent: plan.intent,
      steps: plan.steps.length,
      at: Date.now(),
    })

    if (plan.intent === 'unsupported' || plan.intent === 'reject') {
      this.replyWithStructuredStop(
        request,
        'blocked',
        plan.reason ?? 'I cannot do that — there is no supported capability for it, so I will not attempt it.',
      )
      return true
    }
    if (plan.intent === 'clarification') {
      this.replyWithStructuredStop(request, 'requires_clarification', plan.asking ?? 'Could you clarify what you need?')
      return true
    }

    // intent 'execute' | 'status' — build an orchestrated plan from the STRICT
    // validated steps and run it through the exact same rails as a
    // deterministic plan (validatePlan → permission → confirmation →
    // execution → verification).
    const planned: OrchestrationPlannedRequest = {
      goal: request.originalText,
      verdict: 'ok',
      reason: 'Structured reasoning plan; strictly validated against the registered capabilities.',
      steps: plan.steps.map((s, i) => ({
        id: `step-${i + 1}`,
        capability: s.capabilityId,
        description: s.reason ? `Run ${s.capabilityId} (${s.reason}) via the validated structured plan.` : `Run ${s.capabilityId} via the validated structured plan.`,
        payload: s.arguments,
        dependsOn: i > 0 ? [i - 1] : undefined,
      })),
    }
    const outcome = await this.runValidatedCapabilityPlan(request, planned)
    if (outcome.result.status === 'blocked' && outcome.result.declinedByUser !== true) {
      this.replyWithStructuredStop(request, 'blocked', outcome.result.reason)
      return true
    }
    // A USER-DECLINED confirmation is NOT a generic block: it must keep its
    // declined identity through to the reply ("you declined, so nothing ran",
    // cancelled run state) instead of being re-wrapped as a plan block.
    this.recordTaskLogFor(request, outcome.result, outcome.failures, outcome.resolutions)
    await this.replyWithOrchestratedResult(outcome.result, text)
    return true
  }

  /** Phase 13 — bounded watchdog around one reasoning `plan()` call so the UI
   * never hangs waiting for an AI plan. The signal is handed to the provider,
   * which is expected to abort its transport. */
  private async reasoningPlanWithWatchdog(
    provider: StructuredPlanProvider,
    request: ReasoningRequest,
  ): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REASONING_PLAN_LIMITS.planDeadlineMs)
    try {
      return await provider.plan(request, controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Phase 13 — reply to a validated orchestrated result.
   *
   * The ENGINE's deterministic phrasing is the authoritative statement about
   * what happened and is ALWAYS part of the reply. When a real AI provider is
   * active and the run produced real observations, the model additionally
   * writes a grounded 1-3 sentence answer from that observed record (see
   * `synthesizeOrchestratedAnswer`), and its prose is placed BEFORE the
   * evidence line. The model can therefore enrich the answer, never upgrade
   * it: verification counts, failures and refusals stay exactly as observed. */
  private async replyWithOrchestratedResult(orchResult: OrchestrationExecutionResult, text: string): Promise<void> {
    const finalState = orchResult.status === 'completed' ? 'completed' :
      // A declined confirmation is a user cancellation, not a failure of JARVIS.
      orchResult.status === 'cancelled' || orchResult.declinedByUser === true ? 'cancelled' :
      orchResult.status === 'partial' &&
      orchResult.failedSteps === 0 &&
      orchResult.steps.length > 0 &&
      orchResult.steps.every((s) => s.status === 'success')
        ? 'completed' // read-only answer: the read IS the deliverable
        : 'failed'
    this.runState.finish(finalState)
    this.tracer.end(finalState)
    // Authoritative, engine-owned evidence line (never model-authored).
    const evidence = this.formatOrchestrationResult(orchResult, text)
    const prose = await this.synthesizeOrchestratedAnswer(orchResult)
    const finalText = composeFinalAnswer(prose, evidence)
    const finalAnswer = this.withGoalVeracityNote(finalText, text)
    addAssistantMessage(finalAnswer)
    this.emit({ type: 'transcript', speaker: 'assistant', text: finalAnswer })
    this.fireActivity({ step: 'Replied', kind: 'output', detail: finalAnswer })
    this.applyResponse(finalAnswer)
    this.recordActionRunOutcome(orchResult)
  }

  /**
   * Grounded answer synthesis (see `orchestrator/answerSynthesis`).
   *
   * Asks the ACTIVE provider to write the final answer from the OBSERVED
   * execution record only. Returns null (and the caller keeps the deterministic
   * evidence text alone) when:
   *
   *  - no real AI provider is configured (mock/local-dev mode) — the synthesis
   *    step must never be faked by a canned reply;
   *  - the run produced nothing to talk about (no observation, no failure);
   *  - the provider fails, times out, or returns nothing usable;
   *  - the prose claims more than the record holds (`synthesisUpgradesVerdict`).
   *
   * The call is bounded and TOOL-FREE: no tool definitions are offered, so a
   * response can only ever be text. Whatever it says is appended AFTER the
   * engine's own evidence line and can never replace it.
   */
  private async synthesizeOrchestratedAnswer(orchResult: OrchestrationExecutionResult): Promise<string | null> {
    if (this.provider.id === MOCK_PROVIDER_ID) return null
    const facts = buildSynthesisFacts(orchResult, this.tracer.snapshot())
    if (!hasSynthesizableFacts(facts)) return null
    // Cancellation wins: a cancelled run is never re-narrated as work done.
    if (orchResult.status === 'cancelled' || orchResult.status === 'blocked') return null

    let raw: string | undefined
    try {
      const response = await this.generateWithDeadline(buildSynthesisMessages(facts))
      // A synthesis response is text only: any tool request is ignored outright.
      raw = response?.text
    } catch (error) {
      this.tracer.recordEvent({
        type: 'synthesis_unavailable',
        reason: reasoningFailureKind(error),
        at: Date.now(),
      })
      return null
    }

    const prose = normalizeSynthesisText(raw)
    if (!prose) return null
    if (synthesisUpgradesVerdict(facts, prose)) {
      // The model tried to claim more than was observed — drop it and let the
      // deterministic evidence line stand alone.
      this.tracer.recordEvent({ type: 'synthesis_rejected', reason: 'verdict_upgrade', at: Date.now() })
      return null
    }
    this.tracer.recordEvent({ type: 'synthesis_completed', chars: prose.length, at: Date.now() })
    return prose
  }

  /** One tool-free provider call with a hard deadline. Never streams to the
   * transcript (the prose is part of the single final reply) and never throws:
   * a late rejection is absorbed so it cannot surface as an unhandled error. */
  private async generateWithDeadline(messages: AIMessage[]): Promise<AIResponse | undefined> {
    const call = this.provider.generate(
      {
        prompt: '',
        messages,
        context: [],
        availableTools: [],
        toolDefinitions: [],
        isNewSession: false,
      },
      () => {},
    )
    call.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), SYNTHESIS_LIMITS.deadlineMs)
    })
    try {
      return await Promise.race([call, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Phase 13 — honest stop for a request that never executed: refused
   * (blocked), clarifying, or cancelled. A blocked request MUST NOT show a
   * success chip; only clarification completes normally (the assistant is
   * asking the user). Mirrors the deterministic planner's refusal semantics. */
  private replyWithStructuredStop(
    request: OrchestrationRequest,
    status: 'blocked' | 'requires_clarification' | 'cancelled',
    reason?: string,
  ): void {
    const result = this.makeResult(request, status, [], reason)
    const finalRunState = status === 'blocked' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'completed'
    this.runState.finish(finalRunState)
    this.tracer.end(finalRunState)
    const finalText = this.formatOrchestrationResult(result, request.originalText)
    const finalAnswer = this.withGoalVeracityNote(finalText, request.originalText)
    addAssistantMessage(finalAnswer)
    this.emit({ type: 'transcript', speaker: 'assistant', text: finalAnswer })
    this.fireActivity({ step: 'Replied', kind: 'output', detail: finalAnswer })
    this.applyResponse(finalAnswer)
    if (status === 'blocked' && this.actionRun) {
      this.actionRun.outcome = 'refused'
      this.actionRun.terminalStatus = 'refused'
    }
    this.recordTaskLogFor(request, result)
  }

  /** Phase 3.0 — append one bounded, content-free entry for an orchestration
   * outcome to the task-execution log. Resolutions only include capabilities
   * that really resolved to a tool; steps mirror the executed/refused outcome. */
  private recordTaskLogFor(
    request: OrchestrationRequest,
    result: OrchestrationExecutionResult,
    failures?: StepFailure[],
    resolutions?: PlanStepResolution[],
  ): void {
    const now = new Date().toISOString()
    const steps: TaskLogStep[] = result.steps.map((s) => ({
      capability: s.capability,
      toolId: s.toolId,
      status: s.status,
    }))
    const recordedFailures: TaskLogFailure[] = (failures ?? []).map((f) => ({
      toolId: f.toolId,
      errorKind: f.errorKind,
      summary: f.summary,
    }))
    const recordedResolutions = (resolutions ?? [])
      .map((r) => ({ capability: r.capability, toolId: r.toolId, fallback: r.fallback }))
    this.taskLog.record({
      taskId: createTaskId(),
      startedAt: now,
      finishedAt: now,
      goal: request.originalText,
      autonomy: this.autonomyLevel,
      resolutions: recordedResolutions,
      steps,
      failures: recordedFailures,
      verdict: result.status,
      reason: result.reason,
    })
  }

  /**
   * Build the structured execution result from the OBSERVED trace. The status
   * never claims what did not happen: `completed` requires every executed step
   * to be independently verified; executed-but-unverified or refuted steps
   * yield `partial`; failures without any successful execution yield `failed`;
   * cancellation wins over everything when the run flag or plan tracker stopped.
   */
  private makeResult(
    request: OrchestrationRequest,
    status: OrchestrationExecutionStatus,
    plan: OrchestrationPlanStep[],
    reason?: string,
    trace?: AgentTrace,
    failures?: StepFailure[],
    resolutions?: PlanStepResolution[],
  ): OrchestrationExecutionResult {
    const finishedAt = Date.now()
    const traceSteps = trace?.steps ?? []
    const steps: OrchestrationStepOutcome[] = []
    const observations: Array<{ toolId: string; kind: string; summary: string }> = []
    const verification: Array<{ toolId: string; status: OrchestrationVerificationStatus }> = []
    const outcomes: { success: number; failed: number; skipped: number; verified: number } = {
      success: 0,
      failed: 0,
      skipped: 0,
      verified: 0,
    }

    for (let i = 0; i < plan.length; i += 1) {
      const planned = plan[i]
      const capability = planned.capability
      // Trace steps carry the CONCRETE resolved tool id (e.g. `app.launch` for
      // capability `open_application`), so plans map onto the observed trace via
      // the same capability→tool resolution the executor used.
      const resolvedToolId = resolutions?.find((r) => r.stepIndex === i)?.toolId
      const traceStep = traceSteps.find((s) => s.toolId === (resolvedToolId ?? capability) || s.toolId === capability)
      const obs = traceStep?.observation
      const verified = AssistantEngine.toOrchestrationVerification(traceStep?.verification?.status)

      if (!traceStep || !obs) {
        steps.push({ capability, toolId: capability, status: 'skipped' })
        outcomes.skipped += 1
        continue
      }

      observations.push({ toolId: capability, kind: obs.kind, summary: obs.summary })
      verification.push({ toolId: capability, status: verified })

      // The executor marks BOTH hard failures and refuted executions
      // (observation kind 'verification') FAILED on the trace; never derive
      // success from invocation alone.
      if (obs.kind === 'failure' || obs.kind === 'verification') {
        steps.push({ capability, toolId: capability, status: 'failed', observation: { kind: obs.kind, summary: obs.summary }, verified: false })
        outcomes.failed += 1
      } else {
        const isVerified = verified === 'verified'
        steps.push({ capability, toolId: capability, status: 'success', observation: { kind: obs.kind, summary: obs.summary }, verified: isVerified })
        outcomes.success += 1
        if (isVerified) outcomes.verified += 1
      }
    }

    // A stop that never reached the executor (e.g. plan rejected upfront) keeps
    // the passed verdict; a stop that ran steps is judged by the observed trace.
    let effective = status
    // The USER declining a confirmation is a refusal: nothing ran, so no branch
    // below may upgrade it to a completed/partial verdict.
    const declinedByUser = (failures ?? []).some((f) => f.errorKind === 'user_cancelled')
    if (declinedByUser) {
      effective = 'blocked'
    } else if (traceSteps.length > 0 || (failures?.length ?? 0) > 0) {
      if (this.cancelRequested || this.planTracker.current?.status === 'CANCELLED') {
        effective = 'cancelled'
      } else if (outcomes.failed > 0 && outcomes.success === 0) {
        effective = 'failed'
      } else if (outcomes.success > 0 && (outcomes.verified < outcomes.success || (failures?.length ?? 0) > 0)) {
        effective = 'partial'
      } else if (outcomes.success === 0 && outcomes.failed === 0 && outcomes.skipped > 0 && (failures?.length ?? 0) > 0) {
        effective = 'failed'
      } else {
        effective = 'completed'
      }
    }

    if (effective === 'completed' || effective === 'partial') {
      this.runState.finish('completed')
    } else if (effective === 'failed') {
      this.runState.finish('failed')
    } else if (effective === 'cancelled') {
      this.runState.finish('cancelled')
    }

    let effectiveReason = reason
    if (!effectiveReason && effective === 'partial') {
      const parts: string[] = []
      if (outcomes.verified < outcomes.success) {
        parts.push(`${outcomes.success - outcomes.verified} step(s) executed but were not independently verified.`)
      }
      if (outcomes.failed > 0) parts.push(`${outcomes.failed} step(s) failed.`)
      if (parts.length > 0) effectiveReason = parts.join(' ')
    }
    if (!effectiveReason && effective === 'failed') {
      const failedSummary = steps.find((s) => s.status === 'failed')?.observation?.summary
      if (failedSummary) effectiveReason = failedSummary
    }

    return {
      status: effective,
      goal: request.originalText,
      requestClass: request.requestClass,
      plan,
      steps,
      completedSteps: outcomes.success,
      failedSteps: outcomes.failed,
      skippedSteps: outcomes.skipped,
      verifiedSteps: outcomes.verified,
      unverifiedSteps: outcomes.success - outcomes.verified,
      observations,
      verification,
      targetDevices: request.targetDevices,
      implicitTargetDevice: request.implicitTargetDevice,
      reason: effectiveReason,
      declinedByUser: declinedByUser ? true : undefined,
      requiresUserAction:
        effective === 'requires_confirmation' ||
        effective === 'requires_clarification' ||
        effective === 'blocked' ||
        effective === 'cancelled',
      finishedAt,
    }
  }

  private static toOrchestrationVerification(status: VerificationStatus | undefined): OrchestrationVerificationStatus {
    switch (status) {
      case 'verified':
        return 'verified'
      case 'failed':
        return 'refuted'
      case 'unverified':
      case 'not_applicable':
        return 'unverified'
      default:
        return 'not_requested'
    }
  }

  /* ------------------------------------------------ wiring */
  attach(output: VoiceOutput | null): void {
    this.voiceOutput = output
  }

  on(handler: (m: EngineOutMessage) => void): () => void {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }

  activeProvider(): AIProvider {
    return this.provider
  }

  get providers(): AIProvider[] {
    return this.available
  }

  get tools(): ToolRegistry {
    return this.registry
  }

  /** The filesystem capability seam bound to the registered file tools. */
  get fileSystemProvider(): FileSystemProvider {
    return this.fileSystem
  }

  /** The application capability seam (undefined in browser mode). */
  get applicationProvider(): ApplicationProvider | undefined {
    return this.applications
  }

  /** The observation capability seam (undefined in browser mode). */
  get observationProvider(): ObservationProvider | undefined {
    return this.observation
  }

  /** The desktop-interaction capability seam (undefined in browser mode). */
  get desktopProvider(): DesktopProvider | undefined {
    return this.desktop
  }

  /** The visual-understanding capability seam (undefined unless configured). */
  get visionProvider(): VisionProvider | undefined {
    return this.vision
  }

  /** The browser webcam capability seam (null unless the app binds one). */
  get cameraProvider(): CameraController | null {
    return this.camera
  }

  /** Admin seam binding a real webcam controller (or unbinding at session end). */
  attachCamera(camera: CameraController | null): void {
    this.camera = camera
  }

  /** The device-bridge capability seam (undefined while the backend is down). */
  get deviceProvider(): DeviceProvider | undefined {
    return this.device
  }

  /** The Android telephony seam (undefined while no phone is reachable). */
  get androidProvider(): AndroidProvider | undefined {
    return this.android
  }

  /** The web capability seam (undefined while the native agent is down). */
  get webProvider(): WebProvider | undefined {
    return this.web
  }

  /**
   * Per-run desktop input counters (diagnostics; the budget itself is enforced
   * in executeToolSteps). Mouse bucket = move/click/double/right/scroll; key
   * bucket = key_press/hotkey/type.
   */
  desktopBudget(): { mouse: number; keys: number } {
    return { mouse: this.desktopMouseActions, keys: this.desktopKeyActions }
  }

  /**
   * Per-run visual-action counter (diagnostics; the ceiling itself is enforced
   * in executeToolSteps). Visual actions = inspect/click/type.
   */
  visualBudget(): { actions: number } {
    return { actions: this.visualActions }
  }

  /** Register an additional tool at runtime (Phase 1.0 extension seam). */
  registerTool(tool: Tool): void {
    this.registry.register(tool)
  }

  /** Deterministic record of the last run — steps, observations, verification. */
  lastRunTrace(): AgentTrace {
    const trace = this.tracer.snapshot()
    // Phase 2.0 — attach the evidence-based goal verdict so PLAN vs EXECUTION
    // vs EVIDENCE vs RESULT stay distinguishable on one trace.
    return { ...trace, task: evaluateGoalTask(trace, this.goalLimits) }
  }

  /** Phase 2.0 evidence-based goal verdict of the last run (never a claim). */
  taskResult(): GoalTaskResult {
    return evaluateGoalTask(this.tracer.snapshot(), this.goalLimits)
  }

  /** Phase 2.0 — remaining goal-step budget, mirroring visualBudget(). */
  taskBudget(): { steps: number; remaining: number; limit: number } {
    return {
      steps: this.taskSteps,
      remaining: taskBudgetRemaining(this.taskSteps, this.goalLimits.maxTaskSteps),
      limit: this.goalLimits.maxTaskSteps,
    }
  }

  /**
   * Phase 2.1 — the engine's configured goal limits (read-only; the model can
   * never change these). Only engine construction may tune them.
   */
  goalLimitsInfo(): GoalLimits {
    return { ...this.goalLimits }
  }

  /**
   * Phase 2.2 — bounded recovery counters projected for the UI mirror. The
   * model can never arm these; they are read-only engine budget state.
   * `active` is true while this run is working through a classification that
   * requested a new observation or a replan continuation.
   */
  goalRecovery(): GoalPlanRecoveryView {
    return {
      verificationFailures: countRecoveries(this.tracer.snapshot().steps),
      maxRecoveryAttempts: this.goalLimits.maxRecoveryAttempts,
      replans: this.replansUsed,
      maxReplans: this.goalLimits.maxReplans,
      active: this.replanContext !== null,
    }
  }

  /**
   * Phase 2.1 — UI-safe projection of the current (or last) plan. Exposes only
   * identity, lifecycle state and a safe evidence summary per step; never raw
   * arguments, payloads, screenshots or reasoning. The verdict for the run
   * still comes exclusively from `taskResult()` / `lastRunTrace()`.
   */
  goalPlan(): GoalPlanView {
    const plan = this.planTracker.current
    if (!plan) {
      return { active: false, goal: '', status: 'CANCELLED', steps: [] }
    }
    const steps: GoalPlanStepView[] = plan.steps.map((s) => {
      const classified = classifyPlanStep(s)
      const verification = s.verification
      const observation = s.observation
      const evidence =
        (verification && verification.status !== 'not_applicable' ? verification.message : '') ||
        (observation ? observation.summary : '') ||
        (s.result?.message ?? '')
      return {
        toolId: s.toolId,
        action: this.registry.get(s.toolId)?.name ?? s.toolId,
        status: s.status,
        attempts: s.result?.attempts ?? 0,
        state: classified,
        evidence,
        ...(s.note ? { note: s.note } : {}),
        // Phase 2.3 — surface the capability a step resolved from (if any).
        ...(s.capability ? { capability: s.capability } : {}),
        // Phase 2.4 — UI-safe preview of the capability's resolution metadata
        // (risk, permission, verification preference, confirmation requirement).
        ...(s.capabilityMeta ? { capabilityMeta: s.capabilityMeta } : {}),
      }
    })
    return {
      active: plan.status === 'ACTIVE',
      goal: plan.goal,
      status: plan.status,
      steps,
      recovery: this.goalRecovery(),
    }
  }

  /** True while an observation surface is attached (can re-observe). */
  private canReobserve(): boolean {
    return this.observation !== undefined || this.vision !== undefined
  }

  /** Registry-backed availability: the ToolRegistry is the single authority. */
  private capabilityAvailable(toolId: string): boolean {
    return this.registry.get(toolId) !== undefined
  }

  /**
   * Phase 2.4 — bounded execution context for capability resolution. Filled
   * ONLY from engine-owned state (never the model): which devices/apps are
   * actually attached, and whether the session is voice or text. "desktop" is
   * the host PC (VC Victus) and this app; "phone" is the device-bridge scope
   * for the trusted phones (S26 Ultra / S23 FE) over the JARVIS Core backend.
   * A context signal ranks implementations, it never grants permission.
   */
  private capabilityContext(): CapabilityContext {
    const devices: string[] = []
    if (this.desktop || this.applications) devices.push('desktop')
    if (this.device || this.android) devices.push('phone')
    return {
      availableDevices: devices.length > 0 ? devices : undefined,
      interactionMode: channelInteractionMode(this.activeInputChannel),
      requiresVerification: false,
    }
  }

  /** Phase 2.5 — honest environment report for capability discovery. Only
   * reflects real connection state; never claims a seam that is not attached. */
  private catalogEnvironment(): CatalogEnvironment {
    return {
      applicationConnected: this.applications?.capabilities().available === true,
      observationConnected: this.observation?.capabilities().available === true,
      desktopConnected: this.desktop?.capabilities().available === true,
      visionConnected: this.vision?.capabilities().visionAvailable === true,
      deviceConnected: this.device?.capabilities().available === true,
    }
  }

  /** Phase 2.4 — last-known reliability index (read-only projection). */
  get capabilityReliabilitySnapshot(): CapabilityReliabilityIndex {
    return this.capabilityReliability
  }

  get memoryState(): MemoryManager {
    return this.memory
  }

  aiInfo(): AIProviderInfo {
    if (this.provider.describe) return this.provider.describe()
    return {}
  }

  get hasPendingConfirmation(): boolean {
    return this.awaiting !== null
  }

  /* ------------------------------------------------ lifecycle */
  private nativeProbeTimer: ReturnType<typeof setInterval> | null = null

  /** Bounded re-probe of every native bridge (no-op for browser/granted/test
   * providers). Runs once at startup and again on a slow timer so the panels'
   * backend/native status chips refresh when the agent comes up, restarts, or
   * dies — instead of freezing at first-load state. Each refresh is bounded
   * (probe timeout) and the probe never rejects. */
  private async refreshNativeBridges(): Promise<void> {
    try {
      if (this.fileSystem.refreshNativeStatus) {
        await this.fileSystem.refreshNativeStatus()
      }
      if (this.applications?.refreshNativeStatus) {
        await this.applications.refreshNativeStatus()
      }
      if (this.observation?.refreshNativeStatus) {
        await this.observation.refreshNativeStatus()
      }
      if (this.desktop?.refreshNativeStatus) {
        await this.desktop.refreshNativeStatus()
      }
    } catch {
      // Probing is best-effort; a failing bridge simply stays disconnected
      // until the next tick.
    }
  }

  private startNativeProbeLoop(): void {
    this.stopNativeProbeLoop()
    const intervalMs = 10_000
    this.nativeProbeTimer = setInterval(() => void this.refreshNativeBridges(), intervalMs)
  }

  private stopNativeProbeLoop(): void {
    if (this.nativeProbeTimer) {
      clearInterval(this.nativeProbeTimer)
      this.nativeProbeTimer = null
    }
  }

  /** Release the engine's background resources (e.g. the bridge re-probe loop). */
  dispose(): void {
    this.stopNativeProbeLoop()
  }

  async start(): Promise<void> {
    // MemoryManager is the source of truth for long-term preferences/profile;
    // the store mirrors it so the UI and engine always agree after a reload.
    const snapshot = this.memory.snapshot()
    useJarvisStore.getState().setPreferences(snapshot.preferences)
    useJarvisStore.getState().setProfile(snapshot.profile)
    this.maybeConsolidate()

    // Phase 1.2 → 1.5 — bounded probe of the native bridges, so capability
    // reporting is honest even on first load (no-op for browser/granted/test
    // providers), then keep refreshing on a slow timer so status stays real.
    await this.refreshNativeBridges()
    this.startNativeProbeLoop()
    const fsCaps = this.fileSystem.capabilities()
    // Phase 1.7 — visual capability reporting is HONEST: every flag is false
    // unless a real, available VisionProvider reports it. No fabricated vision.
    const visionCaps = this.vision?.capabilities()
    const caps = {
      speechRecognitionAvailable: canHear(),
      // Phase 11 — microphone truthfulness: the mic row surfaces the SAME
      // real probe as speech recognition (browser recognizer + permission),
      // instead of an always-"off" default.
      microphoneAvailable: canHear(),
      speechSynthesisAvailable: canSpeak(),
      // Phase 1.6 — voice interaction surfaces. Wake-word listening runs on the
      // same recognition surface, so a real recognizer implies wake capability.
      wakeWordAvailable: canHear(),
      voiceInteractionAvailable: canHear() || canSpeak(),
      // Phase 3.0 — truthfulness: the clearly-labelled dev mock provider is NOT
      // an AI service, so it must never count as "AI configured/connected".
      // `aiConfigured`/`aiConnected` are true ONLY for a real configured provider.
      aiConfigured: this.provider.isConfigured() && this.provider.id !== 'mock',
      memoryEnabled: true,
      toolsEnabled: this.registry.size > 0,
      callingEnabled: this.android?.capabilities().available === true,
      fileSystemAvailable: fsCaps.available || fsCaps.hasApi,
      nativeAgentAvailable: this.fileSystem.nativeStatus?.()?.connected === true,
      nativeApplicationAvailable: this.applications?.capabilities().available === true,
      nativeObservationAvailable: this.observation?.capabilities().available === true,
      nativeDesktopInteractionAvailable: this.desktop?.capabilities().available === true,
      visionAvailable: visionCaps?.visionAvailable === true,
      ocrAvailable: visionCaps?.ocrAvailable === true,
      uiElementDetectionAvailable: visionCaps?.uiElementDetectionAvailable === true,
      targetLocalizationAvailable: visionCaps?.targetLocalizationAvailable === true,
      cameraAvailable: this.camera?.capabilities().available === true,
      deviceBridgeAvailable: this.device?.capabilities().available === true,
    }
    useJarvisStore.getState().setCapabilities(caps)

    // Phase 9 — air the LIVE registered capability catalogue to the UI so the
    // capability panels derive their rows from the SAME engine registry the
    // model addresses. A missing entry means the capability is not registered
    // in this environment; the UI never shows a fabricated one.
    this.emit({
      type: 'capabilities',
      capabilities: this.capabilityCatalog().map((def) => ({
        id: def.id,
        name: def.name,
        category: def.category,
        description: def.description,
      })),
    })

    let reachable = false
    let healthStatus: 'CONNECTED' | 'MISCONFIGURED' | 'AUTHENTICATION_FAILED' | 'MODEL_UNAVAILABLE' | 'NETWORK_ERROR' | 'RATE_LIMITED' | 'DISCONNECTED' = 'DISCONNECTED'
    let healthMessage = ''

    if (this.provider.id !== 'mock') {
      try {
        const health = await checkAiHealth()
        healthStatus = health.status
        healthMessage = health.message || ''
        reachable = health.status === 'CONNECTED'
      } catch {
        reachable = await this.provider.isReachable()
        healthStatus = reachable ? 'CONNECTED' : 'NETWORK_ERROR'
      }
    } else {
      healthStatus = 'MISCONFIGURED'
      healthMessage = 'Development mock provider active.'
    }

    useJarvisStore.getState().setCapabilities({
      aiConnected: reachable && this.provider.id !== 'mock',
      aiStatus: healthStatus,
      aiStatusMessage: healthMessage,
    })
    this.emit({ type: 'status', status: 'idle' })

    if (this.provider.id === 'mock') {
      this.emit({
        type: 'notice',
        kind: 'warning',
        text: 'AI service unavailable — development provider active. Configure a real AI in the settings to enable tool-calling intelligence.',
      })
      return
    }
    if (!reachable) {
      const specificNotice =
        healthStatus === 'AUTHENTICATION_FAILED'
          ? 'AI service authentication failed: The API key was rejected by the upstream service.'
          : healthStatus === 'MODEL_UNAVAILABLE'
          ? `AI model unavailable: The configured model is not supported upstream.`
          : healthStatus === 'RATE_LIMITED'
          ? 'AI service rate limit reached upstream. Please wait a moment.'
          : healthStatus === 'MISCONFIGURED'
          ? 'AI service misconfigured: Server environment credentials missing or invalid.'
          : 'AI service unreachable right now. I can still try local tools.'

      this.emit({
        type: 'notice',
        kind: 'warning',
        text: specificNotice,
      })
    }
  }

  /* ------------------------------------------------ cancellation */
  cancelCurrentTask(): void {
    // Phase 3.0B — an in-flight orchestrated plan is also cancellable; the
    // bridge sets `orchestrationActive` while it runs, so the idle guard must
    // not swallow a bridge cancellation.
    if (!this.running && !this.hasPendingConfirmation && !this.orchestrationActive) {
      // Phase 2.7 — a single unified interrupt also stops an idle run that is
      // only speaking (SPEAKING is a terminal-but-voiced state, not a task).
      // The UI prefers the explicit stopSpeaking() path for SPEAKING, but the
      // engine stays safe if this route is called during speech too.
      if (this.voiceOutput && this.runState.state === 'completed' && useJarvisStore.getState().isSpeaking) {
        this.stopSpeaking()
      }
      return
    }
    this.cancelRequested = true
    // Phase 2.7 — surface a DISTINCT cancelling state before the loop's next
    // evaluation point flips the run terminal (CANCELLING → CANCELLED).
    this.setStatus('cancelling')
    // Phase 1.7 — abort any in-flight long-running tool (visual analysis etc.)
    this.runAbort?.abort()

    // If waiting on confirmation, resolve it as cancelled
    if (this.awaiting) {
      this.awaiting.onCancel()
      this.awaiting = null
    }

    // Mark any in-progress plan as cancelled
    this.planTracker.cancelRemaining()
    this.planTracker.finish('CANCELLED')
    this.emitTaskSnapshot()
    const steps = this.executedActions.length
    const notice = `Cancelled after ${steps} completed step${steps === 1 ? '' : 's'}.`
    this.emit({ type: 'notice', kind: 'info', text: notice })
    this.setStatus('cancelled')
  }

  /**
   * Phase 2.7 — STOP SPEAKING. Interrupts any in-flight TTS utterance, clears
   * the speaking flag and returns the UI to idle/listening. Never claims a run
   * finished or failed; it only stops the voice.
   */
  stopSpeaking(): void {
    try {
      this.voiceOutput?.stop()
    } catch {
      // TTS stop never throws the engine into a failure state.
    }
    useJarvisStore.getState().setIsSpeaking(false)
    if (this.runState.state !== 'cancelled' && this.runState.state !== 'failed') {
      this.setStatus('idle')
    }
  }

  /* ------------------------------------------------ memory API (settings UI) */
  memoryItems(): MemoryItem[] {
    return this.memory.items()
  }

  getMemoryCount(): number {
    return this.memory.count
  }

  deleteMemoryItem(id: string): boolean {
    const ok = this.memory.remove(id)
    if (ok) this.fireMemoryActivity('deleted', 'Removed a memory item')
    return ok
  }

  /** Persist preferences through the memory record (authoritative) + mirror. */
  savePreferences(patch: Partial<UserPreferences>): UserPreferences {
    const updated = this.memory.updatePreferences(patch)
    useJarvisStore.getState().setPreferences(updated)
    return updated
  }

  /** Persist profile through the memory record (authoritative) + mirror. */
  saveProfile(patch: Partial<Profile>): Profile {
    const updated = this.memory.updateProfile(patch)
    useJarvisStore.getState().setProfile(updated)
    return updated
  }

  /** Embedding health for the settings UI. */
  getEmbeddingHealth(): EmbeddingHealthSummary {
    return this.memory.getEmbeddingHealth()
  }

  /** Persistent companion vector-index diagnostics (counts, provider, dims). */
  vectorStoreDiagnostics() {
    return this.memory.vectorStoreDiagnostics()
  }

  /* ------------------------------------------------ lifecycle (0.7) */
  /** Recoverable archived memories for the settings UI. */
  archivedMemories(): ArchivedMemory[] {
    return this.memory.archivedItems()
  }

  /** Move an archived memory back into the active set. */
  restoreMemoryItem(id: string): boolean {
    const ok = this.memory.restoreMemory(id)
    if (ok) this.fireMemoryActivity('saved', 'Restored a memory from the archive')
    return ok
  }

  /** Permanently purge archived memories (omit cutoff to purge all). */
  expungeArchived(cutoffIso?: string): number {
    const removed = this.memory.expungeArchived(cutoffIso)
    if (removed > 0) this.fireMemoryActivity('deleted', `${removed} archived memory item(s) purged`)
    return removed
  }

  /** Run lifecycle consolidation now; returns what happened. */
  consolidateMemory(): LifecycleReport {
    const report = this.memory.runLifecycle()
    if (report.archivedCount > 0) {
      this.fireMemoryActivity('archived', `${report.archivedCount} memory item(s) consolidated`)
    }
    return report
  }

  lifecycleInfo(): { lastRunAt?: string } {
    return this.memory.lifecycleInfo()
  }

  /** Currently open session episode (if any). */
  activeEpisode(): Episode | null {
    return this.memory.activeEpisode
  }

  /** Past episodes (newest first) with live item counts. */
  episodes(): Episode[] {
    return this.memory.episodes()
  }

  /** Active memories captured in a specific session episode. */
  episodeMemories(episodeId: string): MemoryItem[] {
    return this.memory.episodeMemories(episodeId)
  }

  /** Run consolidation only when the interval has elapsed (auto safety net). */
  private maybeConsolidate(): void {
    try {
      if (this.memory.isLifecycleDue()) {
        const report = this.memory.runLifecycle()
        if (report.archivedCount > 0) {
          this.fireMemoryActivity('archived', `${report.archivedCount} memory item(s) consolidated`)
        }
      }
    } catch (error) {
      console.warn('[engine] lifecycle consolidation failed:', error)
    }
  }

  /** Clear ALL memory — requires explicit user confirmation via the UI. */
  requestClearAll(): boolean {
    if (this.awaiting) return false
    const perform = (): Promise<void> => this.doClearAll()
    const cancel = (): void => {
      this.awaiting = null
      this.emit({ type: 'notice', kind: 'info', text: 'Clearing memory was cancelled.' })
    }
    this.awaiting = {
      kind: 'clear_all',
      title: 'Clear all memories?',
      description: 'This will permanently delete every stored memory item.',
      why: 'You asked to clear all memories.',
      toolId: 'notes',
      impact: 'All long-term memory (profile, preferences, facts, notes) will be erased.',
      onConfirm: perform,
      onCancel: cancel,
    }
    this.emit({
      type: 'memory-confirm',
      reason: 'clear_all',
      text: 'That will delete all stored memories permanently. Are you sure?',
      onConfirm: perform,
      onCancel: cancel,
    })
    this.setStatus('waiting_for_confirmation')
    return true
  }

  async confirmPending(): Promise<void> {
    const pending = this.awaiting
    if (!pending) return
    this.awaiting = null
    await pending.onConfirm()
  }

  cancelPending(): void {
    const pending = this.awaiting
    if (!pending) return
    this.awaiting = null
    pending.onCancel()
  }

  private async doClearAll(): Promise<void> {
    this.memory.clear()
    // The archive is stored memory too: "clear all" purges it permanently.
    this.memory.expungeArchived()
    this.fireMemoryActivity('cleared', 'All stored memories cleared')
    this.emit({ type: 'notice', kind: 'success', text: 'All memories have been cleared.' })
  }

  /* ------------------------------------------------ interaction entry point */
  async process(text: string, opts?: { channel?: InputChannel }): Promise<void> {
    const clean = (text ?? '').trim()
    if (!clean || this.running) return
    this.running = true
    this.cancelRequested = false
    this.awaiting = null
    // Phase 2.5 — the channel that delivered this request (text default).
    this.activeInputChannel = normalizeChannel(opts?.channel)
    this.taskDeadline = Date.now() + AGENT_LIMITS.MAX_TOTAL_EXECUTION_TIME_MS
    // Phase 1.0 — reset the explicit run state machine + per-run trace.
    this.runState.reset()
    this.executedActions = []
    // Phase 1.5 — per-run desktop input budgets reset with the run.
    this.desktopMouseActions = 0
    this.desktopKeyActions = 0
    // Phase 1.7 — per-run visual-action budget + a run cancellation signal the
    // tools must observe before every real side effect.
    this.visualActions = 0
    // Phase 2.0 — goal-owned counters reset with the run (engine-only).
    this.taskSteps = 0
    // Phase 2.2 — bounded recovery/replan state resets with the run.
    this.replansUsed = 0
    this.reobserveAttempts = 0
    this.failureHistory = []
    this.priorFailedPlanSignature = null
    this.replanContext = null
    this.runAbort = new AbortController()
    this.tracer.begin(clean)
    this.runState.transition('understanding')
    this.actionHint = null
    this.actionRun = null

    try {
      // 1. Record user turn in conversation
      const userMessage = addUserMessage(clean)
      this.emit({
        type: 'transcript',
        speaker: 'user',
        text: clean,
      })
      this.fireActivity({
        step: 'Understanding request',
        kind: 'input',
        detail: `You said: ${clean}`,
      })

      this.setStatus('understanding')
      useJarvisStore.getState().setLastUser(clean)

      // ================ Phase 9 — deterministic UI-control (self-interaction)
      // Recognised commands ("switch to Astra", "open the core", "hide the
      // devices panel") execute the REAL panel/environment store actions and
      // report the actual post-condition — never a guess. Unknown targets are
      // answered with the real catalogue. The parser fails closed, so anything
      // it does not recognise flows unchanged into the normal interaction path.
      const uiIntents = detectUiControlCommands(clean)
      if (uiIntents.length > 0) {
        await this.handleUiControlCommands(uiIntents)
        return
      }

      // Phase 2.5 — deterministic capability discovery. Meta-requests
      // ("what can you do?", "help me") are answered from the LIVE registered
      // catalog without invoking the provider: the reply is built only from
      // real registered capabilities and honest connection state. This is NOT
      // an action-routing layer — natural actions still go through the full
      // planning/execution rails below.
      // Phase 2.7 — camera commands ("turn on the camera", "what do you see?")
      // are ALSO deterministic meta-surface commands: they drive the REAL
      // bound browser camera controller and only report what the actual
      // stream/permission/vision state allows. Nothing is ever faked.
      const direct = detectDirectIntent(clean)
      if (direct !== 'none') {
        if (direct === 'capabilities' || direct === 'help') {
          const reply = renderCapabilityCatalogReply(
            capabilityCatalogReply(this.capabilityCatalog(), this.catalogEnvironment()),
          )
          addAssistantMessage(reply)
          this.emit({
            type: 'transcript',
            speaker: 'assistant',
            text: reply,
          })
          this.fireActivity({
            step: 'Answered',
            kind: 'output',
            detail: reply,
          })
          this.runState.finish('completed')
          this.tracer.end('completed')
          this.applyResponse(reply)
          return
        }
        const reply = await this.handleCameraIntent(direct)
        addAssistantMessage(reply)
        this.emit({
          type: 'transcript',
          speaker: 'assistant',
          text: reply,
        })
        this.fireActivity({
          step: 'Answered',
          kind: 'output',
          detail: reply,
        })
        this.runState.finish('completed')
        this.tracer.end('completed')
        this.applyResponse(reply)
        return
      }

      // ================ Phase 2.6 — deterministic real-action layer =========
      // Classifies the request into informational / executable / unsupported /
      // ambiguous / follow-up, resolves deictic follow-ups ("do it", "now open
      // the PDF") against the last COMMITTED execution context, and refuses to
      // act blindly. It never executes anything itself, never overrides the
      // permission/confirmation/verification rails, and FAILS CLOSED on
      // unsupported or ambiguous requests (honest answers, no fabricated
      // actions) while FAILING OPEN to the provider for everything else.
      const conversationId = useConversationStore.getState().conversation.id
      const actionView = this.actionView()
      const lastExecution = this.executionContexts.lastFor(conversationId)
      const followUp = resolveFollowUp(clean, lastExecution, Date.now())

      let requestText = clean
      if (followUp.kind === 'replay') {
        requestText = lastExecution!.requestText
      } else if (followUp.kind === 'augment') {
        requestText = followUp.text
      }

      const decision = classifyRequest(requestText, actionView)
      let actionKind: ActionKind = decision.kind
      if (followUp.kind === 'ask_which' || followUp.kind === 'ask_what') actionKind = 'ambiguous'
      else if (followUp.kind !== 'none') actionKind = 'follow_up'
      // A destructive/state-changing request whose target is only a deictic
      // pronoun is ambiguous and must be clarified, never executed blindly.
      if (isRiskyDeictic(requestText)) actionKind = 'ambiguous'

      this.actionRun = {
        conversationId,
        requestText: clean,
        resolvedText: requestText !== clean ? requestText : undefined,
        requestedAt: Date.now(),
        actionKind,
        outcome: 'info_answer',
        matchedTools: decision.matchedTools.map((m) => m.toolId),
        matchedCapabilities: decision.matchedCapabilities,
        artifacts: [],
        errors: [],
        executedSteps: 0,
        verifiedSteps: 0,
        refutedSteps: 0,
        unverifiedSteps: 0,
        terminalStatus: 'idle',
      }

      if (actionKind === 'unsupported') {
        return this.answerDeterministically(decision.domain, 'refused')
      }
      if (actionKind === 'ambiguous') {
        const candidates = followUp.kind === 'ask_which' ? (followUp as { candidates: string[] }).candidates : undefined
        return this.answerDeterministically(decision.domain, 'clarified', requestText, candidates)
      }

      // Actionable route: give the provider the engine-selected mechanism hints
      // (registered tools/capabilities matched by the deterministic selector).
      this.actionHint = actionHintMessage(decision.matchedTools, decision.matchedCapabilities)

      // Phase 5 — when no real AI is configured (mock provider active), route
      // executable requests through the deterministic orchestrator IF the planner
      // can produce a valid plan. The mock provider only knows local tools
      // (clock/calculator/notes/system_info) and cannot plan native Windows
      // actions. The orchestrator handles compound patterns (browser_open+search,
      // app_launch+verify, etc.) that the mock provider cannot.
      //
      // Informational requests whose requestClass the planner genuinely
      // understands (open/launch/close/search/device/status) are also routed
      // here so an unavailable capability is answered honestly instead of
      // leaking into the mock provider's canned "local-dev mode" reply.
      // Chat / question / follow_up classes stay with the provider loop.
      if (this.provider.id === 'mock' || isStructuredPlanProvider(this.provider)) {
        const orchRequest = await this.orchestrate(clean)
        const actionable =
          actionKind === 'executable' ||
          (actionKind === 'informational' && ACTIONABLE_ORCHESTRATION_CLASSES.has(orchRequest.requestClass))
        // Phase 13 — the deterministic planner runs FIRST for every provider
        // class, so deterministic commands never depend on an AI being
        // reachable. Only when it cannot produce an executable plan does a
        // reasoning-capable provider get asked for a structured plan.
        if (actionable && orchRequest.requestClass !== 'cancellation' && orchRequest.requestClass !== 'confirmation') {
          const plan = this.planOrchestrated(orchRequest)
          if (plan.verdict === 'ok' && plan.steps.length > 0) {
            this.orchestratingInline = true
            let orchResult: OrchestrationExecutionResult
            try {
              orchResult = await this.executeOrchestrated(orchRequest)
            } finally {
              this.orchestratingInline = false
            }
            await this.replyWithOrchestratedResult(orchResult, clean)
            return
          }
          if (this.provider.id === 'mock') {
            // Phase 5 — a request the planner BLOCKED or wants to clarify. When
            // NO registered tool directly matched (empty matchedTools), NEVER
            // fall through into the mock provider's canned dev-mode reply:
            // answer honestly from the plan's own reason (unavailable native
            // capability). But when a real tool DID match (memory/notes/clock/
            // calculator — tools the planner does not model), fall through to
            // the provider loop, which owns and can genuinely execute them.
            if (
              (plan.verdict === 'blocked' || plan.verdict === 'clarification') &&
              decision.matchedTools.length === 0
            ) {
              const status: OrchestrationExecutionStatus =
                plan.verdict === 'clarification' ? 'requires_clarification' : 'blocked'
              this.replyWithStructuredStop(orchRequest, status, plan.reason)
              return
            }
          } else {
            // Phase 13 — deterministic planner produced no executable plan and
            // the active provider is a REAL reasoning provider. Ask it for a
            // structured plan derived from the ACTUAL registered catalog. The
            // output is strictly validated; any invalidity, unsafety or
            // unavailability is an honest refusal with NOTHING executed.
            const handled = await this.runStructuredReasoning(clean, orchRequest)
            if (handled) return
            // Opt-out (no registered capability): fall through to the agent loop.
          }
        }
      }

      // 1.5 Phase 0.7/0.8 — session episode + automatic consolidation + optional
      // capture safety net. Episode grouping tags this turn's memories with the
      // conversation id; consolidation runs only when the interval has elapsed;
      // auto-capture is opt-in and strictly deterministic (never semantic).
      if (conversationId) this.memory.beginEpisode(conversationId)
      await this.maybeAutoCapture(clean)
      this.maybeConsolidate()

      // 2. Build context & start plan
      const activeEpisodeId = this.memory.activeEpisode?.id
      // Phase 0.9 — retrieval-based conversation window: keeps the recent
      // transcript for continuity and pulls in older, relevant messages under
      // a strict token budget (separate from the 800-token memory budget).
      const windowCtx = await this.conversationContext.build({
        messages: useConversationStore.getState().conversation.messages,
        query: clean,
        excludeIds: [userMessage.id],
        semanticScorer: this.conversationSemanticScorer(),
      })
      const context = this.ensureConversationTurn(windowCtx, clean, userMessage.id)
      const memoryCtx = await buildMemoryContext(
        (q, o) => this.memory.search(q, o),
        () => this.memory.items(),
        clean,
        DEFAULT_MEMORY_CONTEXT_LIMIT,
        DEFAULT_HYBRID_CONFIG,
        activeEpisodeId,
      )

      this.planTracker.start(clean)

      // 3. Initial context for provider
      let messages = this.buildMessages(context, memoryCtx.memories.map((r) => r.item))

      // 4. Multi-step loop
      const finalText = await this.runAgentLoop(messages, clean)

      // 5. Record assistant turn & respond
      // Phase 2.0 — if steps ran but the goal could not be confirmed, the
      // assistant must SAY it did not prove success instead of implying it.
      const finalAnswer = this.withGoalVeracityNote(finalText, clean)
      addAssistantMessage(finalAnswer)
      this.emit({
        type: 'transcript',
        speaker: 'assistant',
        text: finalAnswer,
      })
      this.fireActivity({
        step: 'Replied',
        kind: 'output',
        detail: finalAnswer,
      })

      this.applyResponse(finalAnswer)
    } catch (error) {
      const { message } = userFacing(error)
      this.runState.finish('failed')
      this.tracer.end('failed')
      this.emit({ type: 'error', message })
      this.emit({ type: 'notice', kind: 'error', text: message })
      this.emit({ type: 'status', status: 'failed' })
    } finally {
      // Phase 2.6 — commit the bounded execution record for this turn so
      // follow-ups resolve against what really ran (never guesses).
      this.completeExecutionContext()
      this.running = false
      this.memory.endEpisode()
      if (!this.hasPendingConfirmation) this.clearTask()
    }
  }

  /**
   * Phase 0.7 deterministic auto-capture (opt-in via
   * `preferences.autoMemorize`). Every guard must pass before an utterance is
   * stored with source 'inferred'; see `shouldAutoCapture`. Explicit memory
   * commands are left to the memory tool, and credentials are never captured.
   */
  private async maybeAutoCapture(text: string): Promise<void> {
    try {
      const prefs = this.memory.snapshot().preferences
      if (!prefs.autoMemorize) return
      if (!shouldAutoCapture(text)) return
      const { created } = await this.memory.rememberSemantic(text, {
        type: detectMemoryType(text),
        source: 'inferred',
      })
      if (created) {
        this.fireMemoryActivity('saved', 'Auto-captured an obvious personal fact')
      }
    } catch (error) {
      console.warn('[engine] auto-capture failed:', error)
    }
  }

  /* ------------------------------------------------ multi-step agent loop */

  /**
   * Phase 2.0 — honesty gate on the final answer. When an actionable goal's
   * last step was NOT confirmed, the reply must admit it rather than imply
   * success. Read-only Q&A and verified / failed / cancelled runs keep their
   * existing answers unchanged.
   */
  private withGoalVeracityNote(finalText: string, goal: string): string {
    const trace = this.tracer.snapshot()
    if (trace.finalState !== 'completed') return finalText
    const task = evaluateGoalTask(trace, this.goalLimits)
    if (task.status === 'unverified') {
      if (!task.actionable) return finalText
      return `${finalText}\nI performed those steps toward "${goal}", but I could not verify the expected result — so I am not claiming the goal was achieved.`
    }
    if (task.status === 'partial') {
      if (!task.actionable) return finalText
      return `${finalText}\nI completed part of "${goal}", but I did not fully achieve it — the result is partial, not complete.`
    }
    if (task.status === 'blocked') {
      // Nothing ran (unknown capability / safety rail). Say so deterministically
      // instead of letting the model alone describe what happened.
      return `${finalText}\nNote: that request did not run — the referenced capability or action is not available to me, so I did not perform it.`
    }
    return finalText
  }

  /**
   * Deterministically extract the REAL user-facing application inventory that a
   * read-only open-apps run actually recorded, if any.
   *
   * Grounded ONLY in the on-record observation of a `window.list` step — never
   * in the model, the plan, the raw user sentence, or an installed-app catalog.
   * The inventory text is already deterministically rendered and bounded by
   * `renderRunningApps` (MAX_INVENTORY_CHARS=900 < TOOL_SUMMARY_LIMIT), so
   * splicing the on-record "N user-facing applications observed: …" summary
   * names the real windows without ever inventing one. Returns '' when the run
   * did not actually enumerate an application inventory (single-window status
   * reads, an observation with no countable inventory, or a bounded empty
   * reading) — in which case the caller falls back to its templated text and
   * never pretends to have named anything.
   */
  private openAppsInventoryFromRecord(result: OrchestrationExecutionResult): string {
    for (const step of result.steps) {
      if (step.observation?.kind !== 'informational') continue
      const summary = step.observation.summary ?? ''
      const match = /\b(\d+)\s+user-facing application[s]? observed:\s+([^.!?]+)/i.exec(summary)
      if (match) {
        const count = match[1]
        const inventory = match[2].trim().replace(/[.!?\s]+$/, '')
        return `${count} user-facing application${count === '1' ? '' : 's'} observed: ${inventory}.`
      }
    }
    return ''
  }

  /** Format the orchestration execution result into a user-facing answer. */
  private formatOrchestrationResult(result: OrchestrationExecutionResult, goal: string): string {
    const verifiedNow = result.steps.filter((s) => s.verified === true).length
    const totalSteps = result.steps.length
    // The user declined the confirmation: NOTHING ran, and the answer must say
    // exactly that (never "executed", never "could not verify").
    if (result.declinedByUser === true) {
      return `Stopped before doing anything: you declined the confirmation, so I did not ${goal.replace(/[.!?\s]+$/, '')}.`
    }
    // A read-only run whose answer IS the deliverable (e.g. an
    // application_status read answered from live state). Nothing failed and
    // nothing was refuted — the read returned its result directly, so there is
    // no post-hoc effect left to re-verify. Presented as an answered Q&A, not
    // a failed run.
    const isReadOnlyAnswer =
      result.status === 'partial' &&
      result.failedSteps === 0 &&
      totalSteps > 0 &&
      verifiedNow === 0 &&
      result.steps.every((s) => s.status === 'success')
    if (result.status === 'completed' || isReadOnlyAnswer) {
      if (verifiedNow === totalSteps && totalSteps > 0) {
        return `Done. ${goal} — all ${totalSteps} step${totalSteps === 1 ? '' : 's'} completed and verified.`
      }
      if (isReadOnlyAnswer) {
        const observedApps = this.openAppsInventoryFromRecord(result)
        if (observedApps) {
          return `Done. ${goal} — ${observedApps}`
        }
        return `Done. ${goal} — answered from a live reading (the result was read directly, so there was nothing left to re-verify).`
      }
      if (verifiedNow > 0) {
        const unverifiedTyping = result.steps.some(
          (s) => s.capability === 'type_text' && s.verified !== true,
        )
        const note = unverifiedTyping
          ? ' Typing was executed, but Windows restricts programmatic window focus (UIPI), so the typed text could not be independently verified.'
          : ''
        return `Partially done. ${goal} — ${verifiedNow} of ${totalSteps} step${totalSteps === 1 ? '' : 's'} verified.${note}`
      }
      return `Executed ${goal}, but could not verify the result.`
    }
    if (result.status === 'partial') {
      const unverifiedTyping = result.steps.some(
        (s) => s.capability === 'type_text' && s.verified !== true,
      )
      const note = unverifiedTyping
        ? ' Typing was executed, but Windows restricts programmatic window focus (UIPI), so the typed text could not be independently verified.'
        : ''
      return `Partially done. ${goal} — ${verifiedNow} of ${totalSteps} step${totalSteps === 1 ? '' : 's'} verified.${note}`
    }
    if (result.status === 'blocked') {
      const reason = (result.reason ?? 'the plan was blocked').replace(/[.!?\s]+$/, '')
      return `I cannot ${goal.toLowerCase()}: ${reason}.`
    }
    if (result.status === 'requires_clarification') {
      const reason = (result.reason ?? 'please provide more details').replace(/[.!?\s]+$/, '')
      return `I need clarification to ${goal.toLowerCase()}: ${reason}.`
    }
    if (result.status === 'requires_confirmation') {
      return `This action requires your confirmation before proceeding.`
    }
    if (result.status === 'cancelled') {
      return `Cancelled.`
    }
    const failedReason = (result.reason ?? 'unknown error').replace(/[.!?\s]+$/, '')
    return `I tried to ${goal.toLowerCase()}, but it failed: ${failedReason}.`
  }

/** Record the orchestration outcome in the action run facts for the task log. */
  private recordActionRunOutcome(result: OrchestrationExecutionResult): void {
    if (!this.actionRun) return
    this.actionRun.outcome = result.status === 'completed' ? 'completed' :
      result.status === 'blocked' ? 'refused' :
      result.status === 'cancelled' ? 'cancelled' : 'failed'
    // OrchestrationStepOutcome.status is 'success' | 'failed' | 'skipped'; verified is separate boolean
    this.actionRun.executedSteps = result.steps.filter((s) => s.status === 'success').length
    this.actionRun.verifiedSteps = result.steps.filter((s) => s.verified === true).length
    this.actionRun.refutedSteps = result.steps.filter((s) => s.status === 'failed').length
    this.actionRun.unverifiedSteps = result.steps.filter((s) => s.status === 'success' && s.verified !== true).length
    this.actionRun.terminalStatus = this.actionRun.outcome
    this.actionRun.artifacts = result.steps
      .filter((s) => s.verified === true)
      .map((s) => ({ id: s.toolId, kind: 'result' as const, label: s.capability, summary: s.observation?.summary ?? '' }))
  }

  private async runAgentLoop(
    messages: AIMessage[],
    userText: string,
  ): Promise<string> {
    let round = 0

    while (true) {
      // Phase 1.0 — single bounded-loop evaluation point. `totalSteps` counts
      // ACTUALLY EXECUTED tool calls (not just failed ones), so the step cap
      // is a real ceiling on work — never an uncontrolled loop.
      const verdict = evaluateLoopState({
        round,
        totalSteps: this.executedActions.length,
        deadline: this.taskDeadline,
        now: Date.now(),
        cancelled: this.cancelRequested,
      })
      if (verdict === 'cancelled') return this.handleCancelOrLimit('cancelled')
      if (verdict === 'limit') return this.handleCancelOrLimit('orchestration_limit')

      // Phase 2.0 — bounded recovery. Refuted / unverified steps are counted
      // from the recorded trace by the ENGINE (the model cannot reset them);
      // crossing the ceiling stops the loop before the next action runs.
      if (recoveryBudgetExceeded(countRecoveries(this.tracer.snapshot().steps), this.goalLimits.maxRecoveryAttempts)) {
        this.emit({
          type: 'notice',
          kind: 'warning',
          text: 'Repeated verification failures crossed the recovery limit. Stopping the goal.',
        })
        return this.handleCancelOrLimit('orchestration_limit')
      }

      round += 1

      this.runState.transition('planning')
      this.setStatus('planning')
      this.fireActivity({
        step: 'Planning task',
        kind: 'think',
        detail: `Reasoning step ${round}…`,
      })

      // Phase 2.2 — per-round operational hint (remaining budget + active
      // recovery/replan context). Holds engine facts only, never CoT, and is
      // pushed for the model to construct a bounded, DIFFERENT continuation.
      const hint = this.planningContextNote(userText)
      if (hint) {
        if (this.replanContext) {
          this.tracer.recordEvent({ type: 'replan_requested', at: Date.now() })
        }
        messages.push({ role: 'system', content: hint })
      }

      const response = await this.provider.generate(
        {
          prompt: userText,
          messages,
          context: [],
          availableTools: [...this.registry.ids(), ...this.capabilities.ids()],
          toolDefinitions: [...this.registry.definitions(), ...this.capabilities.all().map(toCapabilityDefinition)],
          isNewSession: round === 1,
        },
        (m) => this.emit(m),
      )

      const requests = response.toolRequests
      if (requests && requests.length) {
        // Execute each requested tool (these become plan steps)
        this.runState.transition('executing')
        const { toolCalls, toolResults, failures } = await this.executeToolSteps(userText, requests)

        // Phase 2.2 — classify round failures and apply a bounded recovery
        // action. Returns a final answer when the goal must stop here.
        const stop = this.applyRecovery(failures, requests)
        if (stop) return stop

        // Feed results back as tool messages
        messages.push({ role: 'assistant', content: '', toolCalls })
        for (const r of toolResults) {
          messages.push({ role: 'tool', callId: r.callId, toolId: r.toolId, content: r.message })
        }

        this.runState.transition('observing')
        // Phase 2.5 — surface the real observation phase: results collected,
        // effects (where possible) checked, before re-planning.
        this.setStatus('observing')
        // Emit task snapshot after each round
        this.emitTaskSnapshot()
        continue
      }

      // No more tool requests — final answer
      const finalText = (response.text ?? '').trim()
      if (!finalText) {
        throw new ProviderError('malformed', 'The provider returned an empty final answer.')
      }

      // Evaluating the final result of the task
      this.runState.transition('verifying')
      this.setStatus('verifying')
      this.planTracker.finish('COMPLETED')
      this.runState.transition('completed')
      this.tracer.end('completed')
      // Phase 2.2 — the replan window closed with the run: counters persist,
      // but `recovery.active` must not claim a live replan on a finished plan.
      this.replanContext = null
      this.emitTaskSnapshot()
      return finalText
    }
  }

  private handleCancelOrLimit(kind: 'cancelled' | 'orchestration_limit'): string {
    const finalState: AgentState = kind === 'cancelled' ? 'cancelled' : 'failed'
    this.planTracker.finish(kind === 'cancelled' ? 'CANCELLED' : 'FAILED')
    this.runState.finish(finalState)
    this.tracer.end(finalState)
    this.replanContext = null
    // Phase 1.7 — stop any in-flight analysis on a safety-limit stop too.
    this.runAbort?.abort()
    this.emitTaskSnapshot()
    if (kind === 'cancelled') {
      // Phase 2.7 — the reply always names how many steps really completed
      // before the stop; it never implies the goal was done.
      const steps = this.executedActions.length
      const message = `Cancelled after ${steps} completed step${steps === 1 ? '' : 's'}.`
      this.emit({ type: 'notice', kind: 'info', text: message })
      return message
    }
    this.emit({
      type: 'notice',
      kind: 'warning',
      text: 'Execution reached its safety limit. I have stopped to prevent runaway execution.',
    })
    return 'I had to stop because the task took too long or used too many steps.'
  }

  /* ------------------------------------------------ Phase 2.2 recovery */

  /**
   * Classify a round's failed steps and apply a BOUNDED recovery action.
   * Returns a final answer string when the goal must stop immediately,
   * otherwise `null` (the round's results are fed back to the model).
   *
   * Budget rules enforced here:
   *  - 'retry'   nothing to do (already handled by the tool's retry policy).
   *  - 'reobserve' mirrors a recovery-attempt counter (budgeted like a
   *    verification attempt by the existing loop-top recovery gate).
   *  - 'replan'  consumes one unit of the replan budget per round; crossing
   *    the ceiling stops the goal (never a silent skip).
   *  - 'stop'    permission/fatal/cancellation/budget — consumes nothing and
   *    issues no recovery; the refusal is already fed back to the model.
   *
   * Two loop guards run ahead of any replan request:
   *  - the SAME (tool, payload) failing consecutively beyond a small bound,
   *  - the model repeating the exact failing plan signature verbatim.
   */
  private applyRecovery(failures: StepFailure[], requests: PlanStepRequest[]): string | null {
    if (failures.length === 0) return null

    const roundSignature = planSignature(requests)
    if (this.priorFailedPlanSignature !== null && this.priorFailedPlanSignature === roundSignature) {
      this.tracer.recordEvent({
        type: 'repeated_failure_detected',
        kind: 'identical_replan',
        repeated: REPLAN_LIMITS.MAX_IDENTICAL_REPLANS,
        at: Date.now(),
      })
      return this.stopGoal(
        'I stopped because the plan repeated the exact failing steps.',
        'The plan repeated the exact failing steps. Stopping the goal.',
      )
    }

    let replanWanted = false
    let chosen: { failure: StepFailure; kind: RecoveryFailureKind; action: RecoveryAction; reason: string } | null = null

    for (const failure of failures) {
      const decision = classifyRecovery({
        errorKind: failure.errorKind,
        observationKind: failure.observationKind,
        retryable: failure.retryable,
        canReobserve: this.canReobserve(),
        budgetExhausted: taskBudgetExceeded(this.taskSteps, this.goalLimits.maxTaskSteps),
        planCode: failure.planCode,
        deviceCode: failure.deviceCode,
      })
      this.tracer.recordEvent({
        type: 'recovery_classified',
        toolId: failure.toolId,
        stepId: failure.stepId,
        kind: decision.kind,
        action: decision.action,
        at: Date.now(),
      })
      if (failure.stepId) {
        this.planTracker.setNote(failure.stepId, `Recovery: ${decision.kind} → ${decision.action}. ${decision.reason}`)
      }

      if (decision.action === 'replan' || decision.action === 'reobserve') {
        // Guard 1 — the SAME (tool, payload) must not keep failing.
        const signature = failure.payload
          ? requestSignature(failure.toolId, failure.payload)
          : failure.toolId
        this.failureHistory.push(signature)
        if (repeatedFailureDetected(this.failureHistory, signature)) {
          this.tracer.recordEvent({
            type: 'repeated_failure_detected',
            kind: 'same_action',
            repeated: REPLAN_LIMITS.MAX_IDENTICAL_FAILURES,
            at: Date.now(),
          })
          return this.stopGoal(
            'I stopped because the same action kept failing in a loop.',
            'The same action failed repeatedly. Stopping the goal.',
          )
        }
      }

      const isBetterChoice =
        decision.action === 'replan' ||
        (decision.action === 'reobserve' && !replanWanted && chosen === null)
      if (isBetterChoice && !chosen) {
        chosen = { failure, kind: decision.kind, action: decision.action, reason: decision.reason }
      }
      if (decision.action === 'replan') replanWanted = true
    }

    // Nothing recoverable this round → the STOP actions recorded above are the
    // whole story; the loop-top gates keep bounding the run.
    if (!chosen) {
      this.priorFailedPlanSignature = roundSignature
      return null
    }

    if (replanWanted) {
      // Guard 2 — the replan ceiling. Crossed → hard stop, never a silent skip.
      if (replanBudgetRemaining(this.replansUsed, this.goalLimits.maxReplans) <= 0) {
        return this.stopGoal(
          'I stopped because the goal exhausted its replan budget.',
          'The goal exhausted its replan budget. Stopping to avoid repeating the same failing steps.',
        )
      }
      this.replansUsed += 1
      this.tracer.recordEvent({ type: 'replan_accepted', at: Date.now() })
      this.setReplanContext(chosen.failure, chosen.kind, chosen.action, chosen.reason)
      // Phase 3.0 — surface the real RECOVERING execution state (bounded replan).
      this.setStatus('recovering')
      this.emit({
        type: 'notice',
        kind: 'info',
        text: 'A step failed — I am requesting one corrected next step; the goal budgets and evidence are preserved.',
      })
      this.priorFailedPlanSignature = roundSignature
      return null
    }

    // A reobserve continuation: look at the world again, then continue.
    this.reobserveAttempts += 1
    this.tracer.recordEvent({
      type: 'recovery_attempted',
      attempt: this.reobserveAttempts,
      limit: this.goalLimits.maxRecoveryAttempts,
      at: Date.now(),
    })
    const failure = chosen.failure
    // Phase 3.0 — surface the real RECOVERING execution state (reobservation).
    this.setStatus('recovering')
    this.setReplanContext(failure, chosen.kind, chosen.action, chosen.reason)
    this.priorFailedPlanSignature = roundSignature
    return null
  }

  /** Hard goal stop for unrecoverable / looped states. */
  private stopGoal(text: string, notice: string): string {
    this.planTracker.finish('FAILED')
    this.runState.finish('failed')
    this.tracer.end('failed')
    this.runAbort?.abort()
    this.emitTaskSnapshot()
    this.emit({ type: 'notice', kind: 'warning', text: notice })
    return text
  }

  /** Operational per-round hint: engine facts only, never chain-of-thought. */
  private planningContextNote(_goal: string): string {
    const remaining = taskBudgetRemaining(this.taskSteps, this.goalLimits.maxTaskSteps)
    const replansLeft = replanBudgetRemaining(this.replansUsed, this.goalLimits.maxReplans)
    const parts: string[] = []
    if (this.replanContext) {
      parts.push(
        `[Engine] A previous step (${this.replanContext.toolId}) failed: ${this.replanContext.summary}. ` +
          `Recovery classification: ${this.replanContext.kind} → ${this.replanContext.action} (${this.replanContext.reason}). ` +
          `Budgets and evidence are preserved — do NOT repeat the exact failing step; construct a bounded, different continuation.`,
      )
    }
    if (remaining < this.goalLimits.maxTaskSteps || replansLeft < this.goalLimits.maxReplans) {
      parts.push(
        `[Engine] Goal budget: ${remaining} step(s) remaining; replans left: ${replansLeft} of ${this.goalLimits.maxReplans}.`,
      )
    }
    return parts.join('\n')
  }

  private setReplanContext(
    failure: StepFailure,
    kind: RecoveryFailureKind,
    action: RecoveryAction,
    reason: string,
  ): void {
    this.replanContext = {
      toolId: failure.toolId,
      summary: failure.summary,
      kind,
      action,
      reason,
    }
  }

  /* ------------------------------------------------ tool execution with gates */
  private async executeToolSteps(
    userText: string,
    requests: PlanStepRequest[],
  ): Promise<{ toolCalls: ToolCallRecord[]; toolResults: ToolResultRecord[]; failures: StepFailure[] }> {
    this.setStatus('executing')
    this.emit({ type: 'status', status: 'executing' })

    const toolCalls: ToolCallRecord[] = []
    const toolResults: ToolResultRecord[] = []
    const failures: StepFailure[] = []

    // Phase 2.0 — plan pre-flight. The provider's requests ARE the plan and
    // are UNTRUSTED: validate the whole round before anything executes. A plan
    // is never permission; rejected steps become `plan_rejected` trace steps
    // and the execution rails below stay the backstop for valid steps.
    // Phase 2.2 — the round is ALSO checked for capability availability and
    // declared dependency sanity; the verdict codes feed recovery mapping.
    const planValidation = validatePlan(
      requests,
      this.registry,
      this.taskSteps,
      this.goalLimits.maxTaskSteps,
      (toolId) => this.capabilityAvailable(toolId),
      this.capabilities,
      // Phase 2.4 — bounded context + reliability history shape deterministic
      // capability resolution; the model cannot set either.
      { capabilityContext: this.capabilityContext(), reliability: this.capabilityReliability },
    )
    const planVerdict = planValidation.verdicts
    // Phase 2.3 — capability steps resolve to concrete registered tools here.
    const planResolutions = new Map<number, PlanStepResolution>(
      (planValidation.resolutions ?? []).map((r) => [r.stepIndex, r]),
    )

    // Phase 2.2 — operational trace events for the whole plan pass.
    const accepted = planVerdict.filter((v) => v.ok).length
    const rejected = planVerdict.length - accepted
    this.tracer.recordEvent({
      type: 'plan_validated',
      ok: rejected === 0,
      accepted,
      rejected,
      at: Date.now(),
    })
    for (const verdict of planVerdict) {
      if (!verdict.ok) {
        this.tracer.recordEvent({
          type: 'plan_rejected',
          toolId: verdict.toolId,
          reason: verdict.reason,
          at: Date.now(),
        })
      }
    }

    // Phase 2.3 — capability lifecycle: requested → resolved(rejected/fallback)
    // for every capability step, surfaced as operational trace events.
    for (const resolution of planValidation.resolutions ?? []) {
      const verdict = planVerdict[resolution.stepIndex]
      this.tracer.recordEvent({ type: 'capability_requested', capability: resolution.capability, at: Date.now() })
      if (!verdict.ok) {
        this.tracer.recordEvent({ type: 'capability_rejected', capability: resolution.capability, code: verdict.code, reason: verdict.reason, at: Date.now() })
        if (verdict.code === 'capability_unavailable') {
          this.tracer.recordEvent({ type: 'capability_unavailable', capability: resolution.capability, at: Date.now() })
        }
        continue
      }
      this.tracer.recordEvent({ type: 'capability_resolved', capability: resolution.capability, toolId: resolution.toolId, fallback: resolution.fallback, at: Date.now() })
      if (resolution.ranked && resolution.ranked.length > 0) {
        // Phase 2.4 — deterministic ranking result (implementations, best-first).
        this.tracer.recordEvent({ type: 'capability_ranked', capability: resolution.capability, toolId: resolution.toolId, ranked: resolution.ranked, at: Date.now() })
      }
      for (const drop of resolution.policyDropped ?? []) {
        // Phase 2.4 — candidates excluded by application-owned policy filters.
        this.tracer.recordEvent({ type: 'policy_filtered', capability: resolution.capability, toolId: drop.toolId, reason: drop.reason, at: Date.now() })
      }
      if (resolution.fallback) {
        this.tracer.recordEvent({ type: 'capability_fallback', capability: resolution.capability, from: resolution.preferred, to: resolution.toolId, at: Date.now() })
      }
      this.tracer.recordEvent({ type: 'tool_selected', toolId: resolution.toolId, capability: resolution.capability, at: Date.now() })
    }

    // Same-round step ids so declared `dependsOn` can bind to real steps.
    const roundStepIds: string[] = []

    for (let idx = 0; idx < requests.length; idx += 1) {
      const req = requests[idx]
      // Phase 2.3 — capability steps execute the CONCRETE resolved tool, while
      // every rail below (permission, budgets, verification, dedupe) runs on
      // that concrete tool, never on the capability name itself.
      const capabilityResolution = planResolutions.get(idx)
      const toolId = capabilityResolution?.toolId ?? req.toolId
      const input = req.payload ?? {}
      // Phase 2.4 — engine-computed, UI-safe preview of the resolved capability
      // (risk, permission class, verification preference, confirmation flag).
      // Carries NO scores, ranking internals or reasoning.
      const capabilityMeta: CapabilityPreview | undefined = capabilityResolution
        ? {
            risk: capabilityResolution.risk ?? 'low',
            permission: capabilityResolution.permission ?? 'write',
            verification: capabilityResolution.verificationPreference ?? 'normal',
            requiresConfirmation: capabilityResolution.requiresConfirmation ?? false,
          }
        : undefined
      if (this.cancelRequested) {
        this.planTracker.cancelRemaining()
        break
      }

      const callId = `call-${Date.now().toString(36)}-${++this.callSeq}`
      const runId = `run-${Date.now().toString(36)}`
      toolCalls.push({ id: callId, toolId, payload: input })

      // Running activity for this step
      this.emitRunningTool(toolId, toolId === 'notes' ? 'memory' : 'tool', runId)

      // Plan-level rejection (Phase 2.0) — reserved params, unregistered
      // tools, undeclared parameters or an over-budget round never execute.
      const verdict = planVerdict[idx]
      if (!verdict.ok) {
        const failResult = this.makeFailure(callId, toolId, verdict.reason, 'plan_rejected')
        toolResults.push(failResult)
        this.finishToolActivity(runId, toolId, 'error', verdict.reason)
        const step = this.findOrAddStep(toolId, input, callId, true)
        roundStepIds.push(step.id)
        this.planTracker.failStep(step.id, {
          message: verdict.reason,
          attempts: 1,
          durationMs: 0,
          errorKind: 'plan_rejected',
        })
        this.planTracker.setNote(step.id, `Plan rejected by the engine: ${verdict.reason}`)
        this.recordRejectedTraceStep(toolId, toolId, input, verdict.reason, 'plan_rejected')
        this.tracer.recordEvent({ type: 'step_failed', stepId: step.id, toolId: toolId, reason: verdict.reason, at: Date.now() })
        failures.push({
          toolId: toolId,
          stepId: step.id,
          summary: verdict.reason,
          errorKind: 'plan_rejected',
          observationKind: 'failure',
          planCode: verdict.code,
          payload: input,
        })
        continue
      }

      const tool = this.registry.get(toolId)
      if (!tool) {
        const failResult = this.makeFailure(callId, toolId, 'Unknown tool.', 'tool_failure')
        toolResults.push(failResult)
        this.finishToolActivity(runId, toolId, 'error', 'Unknown tool.')
        const step = this.findOrAddStep(toolId, input, callId, true)
        roundStepIds.push(step.id)
        this.planTracker.failStep(step.id, {
          message: 'Unknown tool.',
          attempts: 1,
          durationMs: 0,
          errorKind: 'tool_failure',
        })
        this.tracer.recordEvent({ type: 'step_failed', stepId: step.id, toolId: toolId, reason: 'Unknown tool.', at: Date.now() })
        failures.push({
          toolId: toolId,
          stepId: step.id,
          summary: 'Unknown tool.',
          errorKind: 'tool_failure',
          observationKind: 'failure',
          payload: input,
        })
        continue
      }

      // Argument validation (Phase 1.0) — never run a tool with malformed input
      const validation = validateToolArguments(tool, input)
      if (!validation.ok) {
        const failResult = this.makeFailure(callId, toolId, validation.reason, 'invalid_input')
        toolResults.push(failResult)
        this.finishToolActivity(runId, toolId, 'error', validation.reason)
        const step = this.findOrAddStep(toolId, input, callId, true)
        roundStepIds.push(step.id)
        this.planTracker.failStep(step.id, {
          message: validation.reason,
          attempts: 1,
          durationMs: 0,
          errorKind: 'invalid_input',
        })
        this.recordRejectedTraceStep(toolId, tool.name, input, validation.reason, 'invalid_input')
        this.tracer.recordEvent({ type: 'step_failed', stepId: step.id, toolId: toolId, reason: validation.reason, at: Date.now() })
        failures.push({
          toolId: toolId,
          stepId: step.id,
          summary: validation.reason,
          errorKind: 'invalid_input',
          observationKind: 'failure',
          payload: input,
        })
        continue
      }

      // Phase 2.2 — explicit dependency gate. Declared `dependsOn` binds to the
      // same-round step that must COMPLETE first; otherwise the step is SKIPPED
      // with an honest note and never runs.
      if (req.dependsOn !== undefined && req.dependsOn.length > 0) {
        const step = this.findOrAddStep(toolId, input, callId, true)
        roundStepIds.push(step.id)
        const dependencyIds = req.dependsOn.map((dep) => roundStepIds[Number(dep)])
        this.planTracker.setDependencies(step.id, dependencyIds)
        if (!this.planTracker.isReady(step.id)) {
          const reason = `This step was blocked: it depends on an earlier step ("${req.dependsOn.map((d) => requests[Number(d)].toolId).join(', ')}") that did not complete.`
          const failResult = this.makeFailure(callId, toolId, reason, 'orchestration_limit')
          toolResults.push(failResult)
          this.finishToolActivity(runId, toolId, 'error', reason)
          this.planTracker.skipStep(step.id)
          this.planTracker.setNote(step.id, reason)
          this.tracer.recordEvent({ type: 'step_blocked', stepId: step.id, toolId: toolId, reason, at: Date.now() })
          continue
        }
      }

      // Phase 2.4 — capability confirmation gate. When the APPLICATION policy
      // marks a capability `requiresConfirmation`, NO implementation of it may
      // run without explicit user confirmation. The model requests the
      // capability; the APP decides when confirmation is required (never the
      // model). A refusal is never a success: the step FAILS with an honest,
      // structured reason and the run handles it like any other refusal.
      if (capabilityResolution?.requiresConfirmation === true) {
        const allowed = await this.requestToolConfirmation({
          id: callId,
          title: `Confirm capability: ${capabilityResolution.capability}`,
          description: tool.description,
          why: userText,
          toolId: toolId,
          impact: `The capability "${capabilityResolution.capability}" requires your explicit confirmation before it runs "${tool.name}".`,
          payload: input,
        })
        this.tracer.recordEvent({
          type: 'confirmation_required',
          capability: capabilityResolution.capability,
          toolId: toolId,
          at: Date.now(),
        })
        if (!allowed) {
          const reason = `Capability "${capabilityResolution.capability}" was declined: confirmation refused. Nothing ran.`
          this.finishToolActivity(runId, toolId, 'rejected', reason)
          const step = this.findOrAddStep(toolId, input, callId, true, capabilityResolution.capability, capabilityMeta)
          roundStepIds.push(step.id)
          this.planTracker.failStep(step.id, {
            message: reason,
            attempts: 1,
            durationMs: 0,
            errorKind: 'permission_denied',
          })
          this.planTracker.setNote(step.id, reason)
          this.tracer.recordEvent({
            type: 'confirmation_refused',
            capability: capabilityResolution.capability,
            toolId: toolId,
            at: Date.now(),
          })
          this.tracer.recordEvent({ type: 'step_failed', stepId: step.id, toolId: toolId, reason, at: Date.now() })
          failures.push({
            toolId: toolId,
            stepId: step.id,
            summary: reason,
            errorKind: 'permission_denied',
            observationKind: 'failure',
            payload: input,
          })
          continue
        }
        // Confirmation granted → back to a live executing state.
        this.setStatus('executing')
      }

      // Permission gate — Phase 3.0: a bounded, non-destructive, non-external,
      // LOCAL tool that asks for confirmation may auto-run at a raised autonomy
      // level. Destructive/external/unknown categories and every `high_risk`
      // tool (already refused above) are NEVER derated by any autonomy level.
      const decision = decidePermission(tool, userText, input)

      if (decision.kind === 'denied') {
        const failResult = this.makeFailure(callId, toolId, decision.reason, 'permission_denied')
        toolResults.push(failResult)
        this.finishToolActivity(runId, toolId, 'rejected', decision.reason)
        const step = this.findOrAddStep(toolId, input, callId, true)
        roundStepIds.push(step.id)
        this.planTracker.failStep(step.id, {
          message: decision.reason,
          attempts: 1,
          durationMs: 0,
          errorKind: 'permission_denied',
        })
        this.tracer.recordEvent({ type: 'capability_refused', toolId: toolId, reason: decision.reason, at: Date.now() })
        this.tracer.recordEvent({ type: 'step_failed', stepId: step.id, toolId: toolId, reason: decision.reason, at: Date.now() })
        failures.push({
          toolId: toolId,
          stepId: step.id,
          summary: decision.reason,
          errorKind: 'permission_denied',
          observationKind: 'failure',
          payload: input,
        })
        continue
      }

      if (decision.kind === 'confirm' && !autonomyAllowsAuto(this.autonomyLevel, tool)) {
        // Tool requires explicit user confirmation
        const allowed = await this.requestToolConfirmation({
          id: callId,
          title: decision.reason,
          description: tool.description,
          why: decision.why,
          toolId: toolId,
          impact: decision.impact,
          payload: input,
        })
        if (!allowed) {
          // A declined confirmation is a REFUSAL, not a silent no-op: it must be
          // recorded on the trace and as a failure so the run's verdict is an
          // honest refusal. Without this the run finished "completed" with no
          // observation, and the reply claimed the action had been EXECUTED but
          // merely could not be verified — a false statement about what ran.
          const reason = `You declined the confirmation for "${tool.name}", so nothing ran.`
          const failResult = this.makeFailure(callId, toolId, reason, 'user_cancelled')
          toolResults.push(failResult)
          this.finishToolActivity(runId, toolId, 'rejected', reason)
          const step = this.findOrAddStep(toolId, input, callId, true)
          roundStepIds.push(step.id)
          this.planTracker.skipStep(step.id)
          this.planTracker.setNote(step.id, reason)
          this.recordRejectedTraceStep(toolId, tool.name, input, reason, 'user_cancelled')
          this.tracer.recordEvent({ type: 'step_failed', stepId: step.id, toolId: toolId, reason, at: Date.now() })
          failures.push({
            toolId: toolId,
            stepId: step.id,
            summary: reason,
            errorKind: 'user_cancelled',
            observationKind: 'failure',
            payload: input,
          })
          continue
        }
        // Confirmation granted → proceed to execution
        this.setStatus('executing')
      }

      // Special gate: notes clear-all (layered on top of permission)
      if (toolId === 'notes' && String(input.action) === 'clear') {
        const allowed = await this.confirmClearAllFromTool()
        if (!allowed) {
          const failResult = this.makeFailure(callId, toolId, 'Clearing all memory was cancelled by the user.', 'user_cancelled')
          toolResults.push(failResult)
          this.finishToolActivity(runId, toolId, 'rejected', 'Clearing all memory requires confirmation.')
          toolCalls.pop()
          continue
        }
      }

      // Repeated-action guard (Phase 1.0) — same (tool, payload) executed too
      // many times in one run is always blocked before it runs again.
      if (isRepeatedActionBlocked(this.executedActions, tool.id, input)) {
        const reason = `This action (${tool.name}) has already been executed ${AGENT_LIMITS.MAX_REPEATED_ACTIONS} times in this task. I will not repeat it.`
        const failResult = this.makeFailure(callId, toolId, reason, 'orchestration_limit')
        toolResults.push(failResult)
        this.finishToolActivity(runId, toolId, 'error', reason)
        const step = this.findOrAddStep(toolId, input, callId, true)
        roundStepIds.push(step.id)
        this.planTracker.failStep(step.id, {
          message: reason,
          attempts: 1,
          durationMs: 0,
          errorKind: 'orchestration_limit',
        })
        this.recordRejectedTraceStep(toolId, tool.name, input, reason, 'orchestration_limit')
        continue
      }

      // Desktop per-run budget (Phase 1.5) — the agent is stateless across
      // requests, so the ENGINE enforces the mouse/key input ceilings for the
      // whole run. Crossing a ceiling is orchestration-limited BEFORE any
      // input is injected.
      const desktopBucket = desktopBudgetBucket(toolId)
      if (desktopBudgetExceeded(desktopBucket, this.desktopMouseActions, this.desktopKeyActions)) {
        const reason = `Desktop ${desktopBudgetLabel(desktopBucket as 'mouse' | 'keys')} input reached its per-run budget for this task. I will not inject more.`
        const failResult = this.makeFailure(callId, toolId, reason, 'orchestration_limit')
        toolResults.push(failResult)
        this.finishToolActivity(runId, toolId, 'error', reason)
        const step = this.findOrAddStep(toolId, input, callId, true)
        roundStepIds.push(step.id)
        this.planTracker.failStep(step.id, {
          message: reason,
          attempts: 1,
          durationMs: 0,
          errorKind: 'orchestration_limit',
        })
        this.recordRejectedTraceStep(toolId, tool.name, input, reason, 'orchestration_limit')
        continue
      }

      // Visual per-run budget (Phase 1.7) — the same rail as the desktop
      // budgets: the provider is stateless across requests, so the ENGINE
      // enforces the ceiling BEFORE any analysis/click runs.
      if (visualBudgetBucket(toolId) === 'visual' && visualBudgetExceeded(this.visualActions)) {
        const reason = `Visual ${visualBudgetLabel()} reached its per-run budget for this task. I will not analyse or inject more.`
        const failResult = this.makeFailure(callId, toolId, reason, 'orchestration_limit')
        toolResults.push(failResult)
        this.finishToolActivity(runId, toolId, 'error', reason)
        const step = this.findOrAddStep(toolId, input, callId, true)
        roundStepIds.push(step.id)
        this.planTracker.failStep(step.id, {
          message: reason,
          attempts: 1,
          durationMs: 0,
          errorKind: 'orchestration_limit',
        })
        this.recordRejectedTraceStep(toolId, tool.name, input, reason, 'orchestration_limit')
        continue
      }

      // Phase 2.0 — per-goal task budget (the whole goal's executed-step
      // ceiling, separate from the per-round agent step cap, enforced BEFORE
      // this step runs). The engine owns the counter; the model cannot touch
      // it, so crossing the ceiling is an orchestration limit.
      if (taskBudgetExceeded(this.taskSteps, this.goalLimits.maxTaskSteps)) {
        const reason = `This goal reached its task budget (${this.goalLimits.maxTaskSteps} executed steps). I will not run more goal steps.`
        const failResult = this.makeFailure(callId, toolId, reason, 'orchestration_limit')
        toolResults.push(failResult)
        this.finishToolActivity(runId, toolId, 'error', reason)
        const step = this.findOrAddStep(toolId, input, callId, true)
        roundStepIds.push(step.id)
        this.planTracker.failStep(step.id, {
          message: reason,
          attempts: 1,
          durationMs: 0,
          errorKind: 'orchestration_limit',
        })
        this.recordRejectedTraceStep(toolId, tool.name, input, reason, 'orchestration_limit')
        continue
      }

      // Execute with retry + timeout
      // Phase 2.1 — the step is marked RUNNING so the plan view can show live
      // execution state; the same step object is completed/failed below.
      const step = this.findOrAddStep(toolId, input, callId, true, capabilityResolution?.capability, capabilityMeta)
      roundStepIds.push(step.id)
      // Phase 2.2 — a validated capability is selected and starts executing.
      // Phase 2.3 — capability steps note their source capability (e.g.
      // `open_application → open_application`) so a human sees the intent, not
      // only the concrete implementation tool.
      this.tracer.recordEvent({ type: 'capability_selected', toolId: tool.id, at: Date.now() })
      if (capabilityResolution) {
        this.planTracker.setNote(
          step.id,
          `Capability: ${capabilityResolution.capability} → ${tool.name}${capabilityResolution.fallback ? ` (fallback from ${capabilityResolution.preferred})` : ''}`,
        )
      }
      this.planTracker.setStatus(step.id, 'RUNNING')
      this.tracer.recordEvent({ type: 'step_started', stepId: step.id, toolId: tool.id, at: Date.now() })
      const execResult = await this.executeWithRetry(
        tool,
        { query: userText, params: input },
        { requestId: runId, memory: this.memory, signal: this.runAbort?.signal },
        tool.timeoutMs,
        tool.retry,
      )
      // Only a genuinely executed request counts towards the repeat guard + budgets.
      this.executedActions.push({ toolId: tool.id, input: input })
      // Phase 2.0 — the goal's executed-step counter advances only on REAL
      // execution (mirrors the desktop/visual budgets).
      this.taskSteps += 1
      if (desktopBudgetBucket(tool.id) === 'mouse') this.desktopMouseActions += 1
      else if (desktopBudgetBucket(tool.id) === 'keys') this.desktopKeyActions += 1
      if (visualBudgetBucket(tool.id) === 'visual') this.visualActions += 1

      // Verification + structured observation (Phase 1.0)
      this.tracer.recordEvent({ type: 'verification_attempted', stepId: step.id, toolId: tool.id, at: Date.now() })
      const verification = await runToolVerification(
        tool,
        { query: userText, params: input },
        execResult,
        { requestId: runId, memory: this.memory },
      )
      if (verification && verification.status !== 'not_applicable') {
        this.tracer.recordEvent({
          type: 'verification_result',
          stepId: step.id,
          toolId: tool.id,
          status: verification.status,
          at: Date.now(),
        })
      }
      const observation = classifyObservation(execResult, verification)

      // Record step result (verification-refuted steps are recorded as FAILED).
      // The step was created and set RUNNING before execution; `step` above is
      // the same object, so verification/observation/result land on it.
      this.planTracker.setVerification(step.id, verification)
      this.planTracker.setObservation(step.id, observation)

      let traceStatus: AgentStepStatus = 'COMPLETED'
      if (execResult.success && observation.kind !== 'verification') {
        this.planTracker.completeStep(step.id, {
          message: observation.summary,
          value: execResult.output,
          errorKind: undefined,
          attempts: execResult.attempts,
          durationMs: execResult.durationMs,
        })
        this.finishToolActivity(runId, toolId, 'success', observation.summary)
        this.emit({ type: 'tool', toolId: toolId, status: 'success', detail: observation.summary })
      } else if (execResult.success && observation.kind === 'verification') {
        traceStatus = 'FAILED'
        this.planTracker.failStep(step.id, {
          message: observation.summary,
          attempts: execResult.attempts,
          durationMs: execResult.durationMs,
          errorKind: 'tool_failure',
        })
        this.finishToolActivity(runId, toolId, 'error', observation.summary)
        this.emit({ type: 'tool', toolId: toolId, status: 'error', detail: observation.summary })
        this.tracer.recordEvent({ type: 'step_failed', stepId: step.id, toolId: tool.id, reason: observation.summary, at: Date.now() })
        failures.push({
          toolId: toolId,
          stepId: step.id,
          summary: observation.summary,
          errorKind: 'tool_failure',
          observationKind: observation.kind,
          retryable: tool.retry?.retryable === true,
          deviceCode: deviceFailureCode(execResult.output),
          payload: input,
        })
      } else {
        traceStatus = 'FAILED'
        this.planTracker.failStep(step.id, {
          message: execResult.summary,
          attempts: execResult.attempts,
          durationMs: execResult.durationMs,
          errorKind: execResult.errorKind,
        })
        const toolStatus = execResult.errorKind === 'permission_denied' ? 'rejected' : 'error'
        this.finishToolActivity(runId, toolId, toolStatus, execResult.summary)
        this.emit({ type: 'tool', toolId: toolId, status: toolStatus, detail: execResult.summary })
        this.tracer.recordEvent({ type: 'step_failed', stepId: step.id, toolId: tool.id, reason: execResult.summary, at: Date.now() })
        failures.push({
          toolId: toolId,
          stepId: step.id,
          summary: execResult.summary,
          errorKind: execResult.errorKind,
          observationKind: observation.kind,
          retryable: tool.retry?.retryable === true,
          deviceCode: deviceFailureCode(execResult.output),
          payload: input,
        })
      }

      // Build provider-safe tool result record; a verification-refuted action
      // is reported as `ok:false` with an explicit "verification failed" note.
      const suffix = verificationSuffix(verification)
      toolResults.push({
        callId,
        toolId: toolId,
        ok: execResult.success ? verificationPassed(verification) : false,
        message: `${summarizeToolResult(execResult)}${suffix}`.trim(),
        data: execResult.output,
      })

      // Phase 2.4 — record the executed outcome in the bounded reliability
      // history (a WEAK, content-free learning signal for future ranking).
      // Executed steps only; refusals/cancellations never happened, so they
      // are never counted as successes.
      if (capabilityResolution) {
        const outcome =
          traceStatus === 'COMPLETED'
            ? verification && verification.status === 'verified'
              ? 'verified_success'
              : 'success'
            : 'failure'
        this.capabilityReliability = recordReliability(
          this.capabilityReliability,
          capabilityResolution.capability,
          toolId,
          outcome,
        )
      }

      // Record the step on the deterministic per-run trace (Phase 1.0)
      this.tracer.addStep({
        toolId: toolId,
        action: tool.name,
        // Phase 1.5/1.7 — typed text is redacted on the trace; the real payload
        // still went to the backend + the model that requested it. Vision
        // payloads get the same treatment for visualType typed text.
        arguments: sanitizeVisionPayload(toolId, sanitizeDesktopPayload(toolId, input)),
        status: traceStatus,
        observation,
        verification,
      })

      this.maybeFireMemoryActivity(toolId, input, execResult.success)
    }

    return { toolCalls, toolResults, failures }
  }

/* -------------------------------------------- Phase 6 orchestration loop */

  /**
   * Phase 6 — goal-aware, dependency+precondition-gated, observability-driven
   * execution loop. Drives an already-validated plan ONE STEP PER ROUND through
   * the existing executeToolSteps rails so every step keeps the identical
   * permission, capability-confirmation, budget, timeout, retry, verification
   * and observation semantics of any provider-driven goal. On top of that rail
   * it adds, per step:
   *   - dependency + context precondition gating  (decideStepReadiness)
   *   - typed execution-context input resolution (ExecutionContext)
   *   - risk/verification/retry metadata from the REAL resolution
   *   - post-action cross-tool observation when the step's own verification
   *     left the effect unconfirmed, upgrading the trace step in place when the
   *     observation genuinely confirms the effect
   *   - bounded recovery and replanning (classifyRecovery + decideReplan); a
   *     deterministic planner offers no fabricated alternatives, so production
   *     replans honestly stop — the user is told "no genuinely supported
   *     alternative".
   *
   * Result surfaces mirror the one-shot path exactly: `toolResults` has one
   * entry per plan step (ok/fail; skipped/blocked steps carry a failure record
   * with no `failures[]` sidecar so reply semantics are unchanged) and only
   * REAL refusal/refutation failures land in `failures[]`.
   */
  private async runPhase6Orchestrated(
    request: OrchestrationRequest,
    plan: OrchestrationPlannedRequest,
    _steps: PlanStepRequest[],
    preflight: PlanValidation,
  ): Promise<{ toolResults: ToolResultRecord[]; failures: StepFailure[] }> {
    const startedAt = Date.now()
    const state = createExecutionState(request.originalText, this.goalLimits.maxRecoveryAttempts, {
      maxReplans: this.goalLimits.maxReplans,
      deadlineMs: this.goalLimits.totalExecutionMs,
    })
    const ctx = new Phase6ExecutionContext()
    const toolResults: ToolResultRecord[] = []
    const failures: StepFailure[] = []
    const outcomes: Array<{ state: string; note?: string }> = []
    const resolutions = new Map((preflight.resolutions ?? []).map((r) => [r.stepIndex, r]))
    let recoveryCount = 0
    let replanCount = 0
    let stoppedBy: Phase6RunSummary['stoppedBy'] = 'completed'
    let stopReason: string | undefined

    transitionPhase(state, 'planning', `Plan: ${plan.verdict}, ${plan.steps.length} steps`)
    transitionPhase(state, 'executing')

    // Enrich each step's meta with the REAL resolved tool's risk/verification/
    // retry — inferred by the engine, never by the model.
    for (let i = 0; i < plan.steps.length; i += 1) {
      const planned = plan.steps[i]
      const resolution = resolutions.get(i)
      if (planned.meta && resolution) {
        const tool = this.registry.get(resolution.toolId)
        planned.meta = applyResolutionToStepMeta(planned.meta, {
          risk: resolution.risk,
          verifiable: tool?.verifiable === true,
          retry: tool?.retry
            ? { retryable: tool.retry.retryable, maxRetries: tool.retry.maxRetries ?? 0, backoffMs: tool.retry.backoffMs }
            : undefined,
        })
      }
    }

    try {
      for (let i = 0; i < plan.steps.length; i += 1) {
        const planned = plan.steps[i]
        const meta: Phase6StepMeta | undefined = planned.meta

        // Cancellation is always checked at every step boundary.
        if (this.cancelRequested) {
          this.planTracker?.cancelRemaining()
          stoppedBy = 'cancellation'
          stopReason = 'The goal was cancelled by the user.'
          break
        }

        // Wall-clock deadline (bounded by the configured totalExecutionMs).
        if (goalDeadlineReached(startedAt, Date.now() - startedAt, this.goalLimits.totalExecutionMs)) {
          stoppedBy = 'deadline'
          stopReason = `The goal reached its execution time budget (${this.goalLimits.totalExecutionMs} ms).`
          for (let j = i; j < plan.steps.length; j += 1) {
            failures.push({
              toolId: plan.steps[j].capability,
              stepId: plan.steps[j].id,
              summary: stopReason,
              errorKind: 'orchestration_limit',
              observationKind: 'failure',
            })
          }
          break
        }

        // Dependency + precondition gate. A dependency on a failed/skipped step
        // BLOCKS (the step never runs); a context mismatch SKIPS (conditional
        // branching). Both are honest: no side effect, no fake failures sidecar.
        const gate = decideStepReadiness(
          i,
          planned.dependsOn,
          meta?.precondition,
          outcomes.map((o) => ({
            state: o.state as StepOutcomeView['state'],
            note: o.note,
          })),
          (source, path) => ctx.read(source, path),
        )
        if (gate.gate !== 'run') {
          const reason =
            gate.gate === 'block'
              ? `This step was blocked: ${gate.reason}`
              : `This step was skipped: ${gate.reason}`
          const callId = String(this.taskSteps + i + 1)
          toolResults.push(this.makeFailure(callId, planned.capability, reason, 'orchestration_limit'))
          const step = this.findOrAddStep(planned.capability, planned.payload ?? {}, callId, true)
          this.planTracker?.skipStep(step.id)
          this.planTracker?.setNote(step.id, reason)
          if (gate.gate === 'block') {
            this.tracer.recordEvent({
              type: 'step_blocked',
              stepId: step.id,
              toolId: planned.capability,
              reason,
              at: Date.now(),
            })
          } else {
            this.tracer.recordEvent({
              type: 'recovery_classified',
              stepId: step.id,
              toolId: planned.capability,
              kind: 'stale_observation',
              action: 'stop',
              reason,
              at: Date.now(),
            })
          }
          outcomes[i] = { state: gate.gate === 'block' ? 'blocked' : 'skipped', note: reason }
          this.setPhase6StepState(state, i, gate.gate === 'block' ? 'blocked' : 'skipped', planned)
          continue
        }

        outcomes[i] = { state: 'ready' }

        // Build the payload: planned payload + resolved typed context inputs.
        // Context values are bounded JSON-safe and still pass the tool-schema
        // validation inside executeToolSteps (the injection guard).
        const payload: Record<string, unknown> = { ...(planned.payload ?? {}) }
        const contextInputs = meta?.contextInputs
        if (contextInputs && contextInputs.length > 0) {
          const resolved = ctx.resolveInputs(contextInputs)
          if (resolved) {
            for (const [name, value] of Object.entries(resolved)) {
              payload[name] = value
            }
          }
        }

        // Single-step round WITHOUT dependsOn (a one-step round would map
        // dependsOn[0] to itself). The Phase 6 gate above owns dependency
        // semantics.
        const round = await this.executeToolSteps(request.originalText, [
          { toolId: planned.capability, capability: planned.capability, payload },
        ])
        const roundResult = round.toolResults[0]
        if (round.failures.length > 0) failures.push(...round.failures)
        // Some rails refuse WITHOUT a round result (e.g. a declined capability
        // confirmation reports only a failure). Synthesize a matching entry so
        // the plan→toolResults mapping stays 1:1 for the extraction loop.
        if (roundResult) {
          toolResults.push(roundResult)
        } else {
          const first = round.failures[0]
          toolResults.push(
            this.makeFailure(
              first?.stepId ?? String(this.taskSteps + i + 1),
              planned.capability,
              first?.summary ?? 'The step was stopped without executing.',
              first?.errorKind ?? 'tool_failure',
            ),
          )
        }
        const planStepId = roundResult?.callId
          ? this.findOrAddStep(planned.capability, payload, roundResult.callId, false).id
          : undefined

        if (roundResult?.ok && round.failures.length === 0) {
          // The step ran. Its REAL output becomes the typed execution context
          // (bounded: unsafe values are rejected by the context itself), so a
          // later `context_matches` precondition reads the OBSERVED effect.
          ctx.record(i, roundResult.data)
          // Determine its verification from the trace.
          const resolvedToolId = resolutions.get(i)?.toolId ?? planned.capability
          const traceStep = this.tracer
            .snapshot()
            .steps.filter((s) => s.toolId === resolvedToolId && s.observation)
            .pop()
          const verificationStatus = traceStep?.verification?.status

          if (verificationStatus === 'verified') {
            outcomes[i] = { state: 'verified' }
            this.setPhase6StepState(state, i, 'verified', planned)
          } else if (
            verificationStatus === 'unverified' ||
            verificationStatus === undefined ||
            verificationStatus === 'not_applicable'
          ) {
            // Unconfirmed by the tool's own verifier → Phase 6 post-action
            // observation (the plan's verification step, NOT a recovery unit).
            const wantsPostAction =
              meta?.verification === 'post_action' || meta?.verification === 'tool_owned_then_post_action'
            const confirmed = wantsPostAction
              ? await this.phase6Observe(planned, resolvedToolId, payload, roundResult, meta)
              : false
            if (confirmed) {
              outcomes[i] = { state: 'verified' }
              this.setPhase6StepState(state, i, 'verified', planned)
            } else {
              outcomes[i] = { state: 'executed' }
              this.setPhase6StepState(state, i, 'executed', planned)
            }
          } else {
            // The tool's own verifier REFUTED the effect — the step ran but is
            // a real failure (refutation failure) with a failures sidecar.
            outcomes[i] = { state: 'failed', note: `the tool reported the effect was not achieved (${verificationStatus})` }
            this.setPhase6StepState(state, i, 'verification_failed', planned)
          }
          continue
        }

        // Failure path: classify honestly and act within the bounded budgets.
        const failure = round.failures[0] ?? (roundResult as unknown as StepFailure | undefined)
        const recovery = classifyRecovery({
          errorKind: (failure as StepFailure | undefined)?.errorKind ?? 'tool_failure',
          observationKind: (failure as StepFailure | undefined)?.observationKind,
          retryable: (failure as StepFailure | undefined)?.retryable === true,
          canReobserve: true,
          deviceCode: (failure as StepFailure | undefined)?.deviceCode,
        })
        outcomes[i] = { state: 'failed', note: recovery.reason }
        const planStep = this.getPhase6StepState(state, i, planned)
        planStep.error = failure?.summary ?? recovery.reason
        planStep.errorKind = (failure as StepFailure | undefined)?.errorKind ?? recovery.kind
        planStep.recoveryAction = recovery.action
        updateStepState(planStep, 'recovery')
        this.tracer.recordEvent({
          type: 'recovery_classified',
          stepId: planStepId,
          toolId: planned.capability,
          kind: recovery.kind,
          action: recovery.action,
          reason: recovery.reason,
          at: Date.now(),
        })

        // Bounded budgets: a reobserve/replan consumes a unit; exceeding them
        // stops the plan honestly. 'retry' has already been fully consumed by
        // the tool's own retry rail inside executeToolSteps — no silent re-run.
        if (recovery.action === 'stop' || recovery.action === 'retry') {
          stoppedBy = 'failure'
          stopReason =
            recovery.action === 'stop'
              ? `Step ${i + 1} failed: ${recovery.reason}`
              : `Step ${i + 1} failed after exhausting its declared retry policy: ${recovery.reason}`
          break
        }
        if (recovery.action === 'reobserve') {
          if (recoveryCount >= state.maxRecoveries) {
            stoppedBy = 'recovery_limit'
            stopReason = `Step ${i + 1} failed after exhausting the recovery budget: ${recovery.reason}`
            break
          }
          recoveryCount += 1
          // A refuted step cannot be silently upgraded: re-observe to check a
          // stale view. If the observation confirms the effect, the trace step
          // is upgraded in place with real cross-tool evidence.
          const confirmed = await this.phase6Observe(
            planned,
            resolutions.get(i)?.toolId ?? planned.capability,
            payload,
            roundResult,
            meta,
          )
          if (confirmed) {
            planStep.error = undefined
            updateStepState(planStep, 'verified')
            outcomes[i] = { state: 'verified', note: 'confirmed by post-action observation after a refuted tool verifier' }
            continue
          }
          // Still unconfirmed — keep the honest failure and continue (Phase 5
          // parity: remaining steps still run).
          updateStepState(planStep, 'verification_failed')
          continue
        }

        // action === 'replan' — bounded; production finds no genuinely
        // supported alternative and stops honestly.
        if (replanCount >= state.maxReplans) {
          stoppedBy = 'replan_limit'
          stopReason = `Step ${i + 1} failed and the replan limit (${state.maxReplans}) was reached: ${recovery.reason}`
          break
        }
        const replan = decideReplan({
          ctx: {
            failedStepIndex: i,
            capability: planned.capability,
            failedKind: recovery.kind,
            summary: failure?.summary ?? recovery.reason,
          },
          replansUsed: replanCount,
          maxReplans: state.maxReplans,
          alternatives: this.phase6AlternativeResolver,
        })
        replanCount = replan.replansUsed
        state.replanAttempts = replanCount
        if (replan.action === 'continue') {
          this.tracer.recordEvent({ type: 'replan_requested', at: Date.now() })
        } else {
          this.tracer.recordEvent({ type: 'replan_rejected', reason: replan.reason, at: Date.now() })
        }
        if (replan.action === 'continue' && replan.corrected) {
          // A genuinely supported alternative (test-only seam in production).
          const corrected = replan.corrected
          updateStepState(planStep, 'replanned')
          outcomes[i] = { state: 'replanned', note: replan.reason }
          const altRound = await this.executeToolSteps(request.originalText, [
            { toolId: corrected.capability, capability: corrected.capability, payload: corrected.payload },
          ])
          toolResults[i] = altRound.toolResults[0]
          if (altRound.failures.length > 0) failures.push(...altRound.failures)
          if (altRound.toolResults[0]?.ok && altRound.failures.length === 0) {
            // The corrected step ran — its REAL output becomes the typed
            // execution context (same rule as the non-replan success path),
            // so a later `context_matches` precondition reads the observed
            // effect of the CORRECTED step, not the failed original.
            ctx.record(i, altRound.toolResults[0]?.data)
            const resolvedToolId = altRound.toolResults[0]?.toolId ?? corrected.capability
            const confirmed = await this.phase6Observe(
              { ...planned, capability: corrected.capability, payload: corrected.payload },
              resolvedToolId,
              corrected.payload,
              altRound.toolResults[0],
              meta,
            )
            if (confirmed) {
              updateStepState(planStep, 'verified')
              outcomes[i] = { state: 'verified', note: replan.reason }
            } else {
              outcomes[i] = { state: 'executed', note: replan.reason }
            }
          }
          continue
        }
        // No genuinely supported alternative → honest stop.
        stoppedBy = 'replan_limit'
        stopReason = `Step ${i + 1} failed: ${replan.reason}`
        break
      }

      // Mark any steps that never ran (plan stopped) as blocked with a note so
      // the UI surfaces them honestly instead of silently omitting them.
      if (stopReason) {
        for (let j = outcomes.length; j < plan.steps.length; j += 1) {
          const planned = plan.steps[j]
          outcomes[j] = { state: 'blocked', note: stopReason }
          const callId = String(this.taskSteps + j + 1)
          toolResults.push(this.makeFailure(callId, planned.capability, stopReason, 'orchestration_limit'))
          const step = this.findOrAddStep(planned.capability, planned.payload ?? {}, callId, true)
          this.planTracker?.skipStep(step.id)
          this.planTracker?.setNote(step.id, stopReason)
          this.setPhase6StepState(state, j, 'blocked', planned)
          this.tracer.recordEvent({
            type: 'step_blocked',
            stepId: step.id,
            toolId: planned.capability,
            reason: stopReason,
            at: Date.now(),
          })
        }
      }

      // Finalize the run book.
      if (this.cancelRequested) transitionPhase(state, 'cancelled', stopReason ?? 'Cancelled.')
      else if (stoppedBy === 'completed') transitionPhase(state, 'completed')
      else transitionPhase(state, 'failed', stopReason)
      buildFinalResult(state)
    } finally {
      const executedSteps = state.steps.filter(
        (s) => s.state === 'verified' || s.state === 'observed' || s.state === 'executed' ||
          s.state === 'failed' || s.state === 'verification_failed',
      ).length
      const verifiedSteps = state.steps.filter((s) => s.state === 'verified').length
      this._lastPhase6Run = {
        planId: plan.phase6?.planId,
        elapsedMs: Date.now() - startedAt,
        phase: state.phase,
        executedSteps,
        verifiedSteps,
        failedSteps: state.finalResult?.failedSteps ?? 0,
        blockedSteps: state.finalResult?.blockedSteps ?? 0,
        skippedSteps: state.finalResult?.skippedSteps ?? 0,
        cancelledSteps: state.finalResult?.cancelledSteps ?? 0,
        recoveryAttempts: recoveryCount,
        replanAttempts: replanCount,
        replanLimit: state.maxReplans,
        stoppedBy: this.cancelRequested ? 'cancellation' : stoppedBy,
      }
    }

    return { toolResults, failures }
  }

  /** Phase 6 — test-only seam: a genuinely supported alternative resolver. */
  private phase6AlternativeResolver?: AlternativeResolver

  /** Set a replan alternative resolver (used by tests to exercise the bounded
   * corrected-continuation path; production leaves it undefined → honest stop). */
  setPhase6AlternativeResolver(resolver: AlternativeResolver | undefined): void {
    this.phase6AlternativeResolver = resolver
  }

  /** Get or create the run-book StepState for plan index `index`. */
  private getPhase6StepState(
    state: AgenticExecutionState,
    index: number,
    planned: OrchestrationPlanStep,
  ): StepState {
    let step = state.steps.find((s) => s.stepIndex === index)
    if (step) return step
    step = {
      stepIndex: index,
      toolId: planned.capability,
      capability: planned.capability,
      description: planned.description,
      input: planned.payload ?? {},
      state: 'planned',
    } as StepState
    state.steps.push(step as StepState)
    return step as StepState
  }

  private setPhase6StepState(
    state: AgenticExecutionState,
    index: number,
    next: StepState['state'],
    planned: OrchestrationPlanStep,
  ): void {
    updateStepState(this.getPhase6StepState(state, index, planned), next)
  }

  /**
   * Phase 6 — post-action cross-tool observation with a bounded settle window.
   * Uses the SAME planPostActionObservation table as the Phase 5 agentic runner
   * (verify/output loading), executes the observe tool through the regular
   * rails, and when the observation genuinely confirms the effect upgrades the
   * action step's trace verification IN PLACE (additive tracer mutation) so the
   * user-facing result reflects confirmed evidence. Never fabricates: a failed
   * or non-confirming observation leaves the step unverified.
   */
  private async phase6Observe(
    planned: OrchestrationPlanStep,
    resolvedToolId: string,
    payload: Record<string, unknown>,
    roundResult: ToolResultRecord | undefined,
    _meta: Phase6StepMeta | undefined,
  ): Promise<boolean> {
    const observation = planPostActionObservation(resolvedToolId, payload, {
      success: Boolean(roundResult?.ok),
      output: roundResult?.ok ? roundResult.data : null,
      summary: roundResult?.message ?? 'step executed',
    })
    if (!observation) return false
    const observeTool = this.registry.get(observation.observeToolId)
    if (!observeTool) return false
    if (observation.settleMs && observation.settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, observation.settleMs))
    }

    const retries = Math.min(Math.max(0, Math.floor(observation.retries ?? 0)), 2)
    let lastFailed: string | null = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const obsRound = await this.executeToolSteps(planned.description, [
        { toolId: observation.observeToolId, capability: observation.observeToolId, payload: observation.observeParams },
      ])
      const obsResult = obsRound.toolResults[0]
      if (!obsResult?.ok) {
        lastFailed = `observation tool failed: ${obsResult?.message ?? 'unknown error'}`
        break
      }
      const verification = observation.verify(obsResult.data)
      if (verification.passed) {
        this.tracer.updateStepVerification(resolvedToolId, 'COMPLETED', {
          status: 'verified',
          message: verification.message,
        })
        return true
      }
      lastFailed = null
      if (observation.retryDelayMs && observation.retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, observation.retryDelayMs))
      }
    }

    if (lastFailed) {
      // Honest note for the run book: observation tooling failed.
      this.tracer.recordEvent({
        type: 'recovery_classified',
        toolId: resolvedToolId,
        kind: 'stale_observation',
        action: 'reobserve',
        reason: lastFailed,
        at: Date.now(),
      })
    }
    return false
  }
  /* ------------------------------------------------ execution helpers */

  /** Record a pre-execution rejection on the per-run trace (Phase 1.0). */
  private recordRejectedTraceStep(
    toolId: string,
    action: string,
    payload: Record<string, unknown>,
    summary: string,
    errorKind: AgentErrorKind,
  ): void {
    this.tracer.addStep({
      toolId,
      action,
      // Phase 1.5/1.7 — typed text never persists on a rejected trace step either.
      arguments: sanitizeVisionPayload(toolId, sanitizeDesktopPayload(toolId, payload)),
      status: 'FAILED',
      observation: {
        kind: 'failure',
        toolId,
        summary,
        errorKind,
        attempts: 1,
        durationMs: 0,
      },
    })
  }

  private findOrAddStep(
    toolId: string,
    payload: Record<string, unknown>,
    callId: string,
    addIfMissing: boolean,
    capability?: string,
    capabilityMeta?: CapabilityPreview,
  ): { id: string } {
    // Find existing step for this callId
    const plan = this.planTracker.current
    if (plan) {
      const existing = plan.steps.find((s) => s.callId === callId)
      if (existing) return { id: existing.id }
    }
    if (addIfMissing) {
      const step = this.planTracker.addStep({
        toolId,
        // Phase 2.3 — the capability a capability step resolved from.
        capability,
        // Phase 2.4 — UI-safe preview of the resolved capability metadata.
        capabilityMeta,
        // Phase 1.5/1.7 — typed text never persists on a plan (redacted).
        input: sanitizeVisionPayload(toolId, sanitizeDesktopPayload(toolId, payload)),
        requiresConfirmation: false,
        callId,
      })
      return step
    }
    // Should not happen
    return { id: 'step-unknown' }
  }

  private makeFailure(
    callId: string,
    toolId: string,
    message: string,
    _errorKind: AgentErrorKind,
  ): ToolResultRecord {
    return {
      callId,
      toolId,
      ok: false,
      message,
    }
  }

  /** Execute with timeout and controlled retry policy. */
  private async executeWithRetry(
    tool: Tool,
    input: ToolInput,
    ctx: ToolContext,
    timeoutMs?: number,
    retryPolicy?: ToolRetryPolicy,
  ): Promise<{ success: boolean; toolId: string; summary: string; output: unknown; error?: string; errorKind?: AgentErrorKind; durationMs: number; attempts: number }> {
    let attempt = 0
    let lastResult: { success: boolean; toolId: string; summary: string; output: unknown; error?: string; errorKind?: AgentErrorKind; durationMs: number; attempts: number } | null = null

    while (true) {
      const result = await runToolOnce(tool, input, ctx, timeoutMs)

      // Record the attempt
      attempt += 1
      lastResult = {
        ...result,
        attempts: attempt,
      }

      if (result.success) return lastResult

      // Check retry policy
      const retryDecision = shouldRetry(result.errorKind, attempt, retryPolicy)
      if (!retryDecision.shouldRetry) {
        if (attempt > 1) {
          lastResult.summary = `${exhaustedReason(result.errorKind)} ${result.summary}`
        }
        return lastResult
      }

      // Phase 3.0 — surface the real RETRYING execution state.
      this.setStatus('retrying')
      // Brief backoff before retry
      await new Promise((r) => setTimeout(r, retryDecision.backoffMs))
    }
  }

  /** Phase 2.4 — request explicit user confirmation before a tool runs. Wires
   * REAL resolvers into BOTH surfaces the operator can act on: the callbacks
   * shipped inside the emitted `tool-confirm` request (the UI dialog buttons)
   * and `this.awaiting` (engine.confirmPending()/cancelPending()). A
   * confirmation therefore always resumes the run — never a silent no-op.
   * Resolves true when the operator confirms, false when they cancel. */
  private async requestToolConfirmation(opts: {
    id: string
    title: string
    description: string
    why: string
    toolId: string
    impact: string
    payload: Record<string, unknown>
  }): Promise<boolean> {
    let resolver!: (value: boolean) => void
    const promise = new Promise<boolean>((resolve) => {
      resolver = resolve
    })
    const resolveOnce = (value: boolean): void => {
      if (this.awaiting === command) this.awaiting = null
      resolver(value)
    }
    const request: ToolConfirmationRequest = {
      id: opts.id,
      title: opts.title,
      description: opts.description,
      why: opts.why,
      toolId: opts.toolId,
      impact: opts.impact,
      payload: opts.payload,
      onConfirm: async () => resolveOnce(true),
      onCancel: () => resolveOnce(false),
    }
    const command: AwaitingConfirmation = {
      kind: 'tool',
      title: opts.title,
      description: opts.description,
      why: opts.why,
      toolId: opts.toolId,
      impact: opts.impact,
      payload: opts.payload,
      onConfirm: request.onConfirm,
      onCancel: request.onCancel,
    }
    this.awaiting = command
    this.setStatus('waiting_for_confirmation')
    this.emit({ type: 'tool-confirm', request })
    return promise
  }

  /** Ask the UI to confirm a tool-driven clear-all, then wait for the answer. */
  private confirmClearAllFromTool(): Promise<boolean> {
    return new Promise((resolve) => {
      const resolveOnce = (value: boolean): void => {
        this.awaiting = null
        resolve(value)
      }
      this.awaiting = {
        kind: 'clear_all',
        title: 'Clear all memories?',
        description: 'This will permanently delete every stored memory item.',
        why: 'You asked to clear all memories.',
        toolId: 'notes',
        impact: 'All long-term memory (profile, preferences, facts, notes) will be erased.',
        onConfirm: async () => resolveOnce(true),
        onCancel: () => resolveOnce(false),
      }
      this.emit({
        type: 'memory-confirm',
        reason: 'clear_all',
        text: 'That will delete all stored memories permanently. Are you sure?',
        onConfirm: this.awaiting.onConfirm,
        onCancel: this.awaiting.onCancel,
      })
    })
  }

  private maybeFireMemoryActivity(toolId: string, payload: Record<string, unknown>, ok: boolean): void {
    if (toolId !== 'notes' || !ok) return
    const action = String(payload.action ?? '').trim().toLowerCase()
    const normalized: Record<string, string> = {
      save: 'remember',
      search: 'search_memory',
      list: 'list_memory',
    }
    const key = normalized[action] ?? action
    if (key === 'remember') this.fireMemoryActivity('saved', 'Memory saved')
    else if (key === 'recall') this.fireMemoryActivity('recalled', 'Memory recalled')
    else if (key === 'search_memory') this.fireMemoryActivity('searched', 'Memory searched')
    else if (key === 'list_memory') this.fireMemoryActivity('listed', 'Memory listed')
    else if (key === 'episodes') this.fireMemoryActivity('listed', 'Memory sessions listed')
    else if (key === 'episode_memories') this.fireMemoryActivity('recalled', 'Session memories recalled')
    else if (key === 'archive') this.fireMemoryActivity('listed', 'Archived memories listed')
    else if (key === 'restore') this.fireMemoryActivity('saved', 'Archived memory restored')
    else if (key === 'forget') this.fireMemoryActivity('deleted', 'Memory removed')
    else if (key === 'clear') this.fireMemoryActivity('cleared', 'All memories cleared')
  }

  /* ------------------------------------------------ responses */
  private applyResponse(text: string): void {
    useJarvisStore.getState().setLastAssistant(text)

    // Phase 2.5 — terminal honesty: a cancelled or failed run must NOT be
    // re-labelled "success" by the reply stage. The failure/cancellation state
    // stays visible (and nothing is read aloud as a victory).
    if (this.runState.state === 'cancelled') {
      this.setStatus('cancelled')
      return
    }
    if (this.runState.state === 'failed') {
      this.setStatus('failed')
      return
    }

    if (
      this.voiceOutput &&
      this.voiceOutput.speak &&
      useJarvisStore.getState().preferences.voiceEnabled
    ) {
      useJarvisStore.getState().setIsSpeaking(true)
      this.emit({ type: 'status', status: 'speaking' })
      const volume = useJarvisStore.getState().preferences.volume
      this.voiceOutput.speak(text, () => this.settle(), volume)
    } else {
      useJarvisStore.getState().setIsSpeaking(false)
      this.setStatus('success')
    }
  }

  private settle(): void {
    useJarvisStore.getState().setIsSpeaking(false)
    if (this.running) return
    this.emit({ type: 'status', status: 'idle' })
  }

  /* ------------------------------------------------ Phase 2.6 action layer */

  /** Live read-only projection of the tool + capability registries. */
  private actionView(): ActionRegistryView {
    return createActionRegistryView(this.registry.all(), this.capabilities.all())
  }

  /**
   * Phase 2.6 — deterministic engine answer with NO provider round. Used for
   * honest unsupported-capability refusals and ambiguity clarifications. Same
   * outbound pipeline as the meta-request branch; the run completes, but
   * nothing is claimed to have been executed.
   */
  private answerDeterministically(
    domain: string | undefined,
    outcome: ExecutionOutcome,
    originalText?: string,
    candidates?: string[],
  ): void {
    const pending = this.actionRun
    const subject = originalText ?? pending?.requestText ?? 'this request'
    const reply =
      outcome === 'clarified' ? clarificationMessage(subject, candidates) : unsupportedMessage(domain)
    if (pending) pending.outcome = outcome

    addAssistantMessage(reply)
    this.emit({
      type: 'transcript',
      speaker: 'assistant',
      text: reply,
    })
    this.fireActivity({
      step: 'Answered',
      kind: 'output',
      detail: reply,
    })
    // Phase-hardening — UI truthfulness: a REFUSED outcome is never a success
    // (no DONE chip). Only ambiguity clarifications end as a normal completion.
    const refused = outcome === 'refused'
    this.runState.finish(refused ? 'failed' : 'completed')
    this.tracer.end(refused ? 'failed' : 'completed')
    this.applyResponse(reply)
  }

  /**
   * Phase 2.6 — commit the bounded execution record from the tracer + the
   * deterministic route facts of the turn. Only executed/verified/refuted/
   * failed facts and file artifacts are stored — never payloads, secrets,
   * screenshots or chain-of-thought.
   */
  private completeExecutionContext(): void {
    const pending = this.actionRun
    this.actionRun = null
    this.actionHint = null
    if (!pending) return

    const steps = this.tracer.snapshot().steps
    const executedSteps = steps.length
    let failedSteps = 0
    let verifiedSteps = 0
    let refutedSteps = 0
    let unverifiedSteps = 0
    const errors: ExecutionErrorEntry[] = []
    const artifactInputs: unknown[] = []
    for (const step of steps) {
      const observation = step.observation
      if (!observation) continue
      if (observation.kind === 'success') verifiedSteps += 1
      else if (observation.kind === 'verification') refutedSteps += 1
      else if (observation.kind === 'partial') unverifiedSteps += 1
      else if (observation.kind === 'failure') failedSteps += 1
      const kind = executionKindFromAgent(observation.errorKind)
      if (kind) {
        errors.push(makeExecutionError({ kind, toolId: step.toolId, message: observation.summary }))
      }
      if (refutedSteps > 0 && observation.kind === 'verification') {
        errors.push(makeExecutionError({ kind: 'verification_failure', toolId: step.toolId, message: observation.summary }))
      }
      if (observation.data !== undefined) artifactInputs.push(observation.data)
    }

    const outcome =
      pending.outcome === 'refused' || pending.outcome === 'clarified'
        ? pending.outcome
        : classifyExecutionOutcome({
            finalState: this.runState.state,
            executedSteps,
            failedSteps,
            verifiedSteps,
            refutedSteps,
            unverifiedSteps,
          })

    const shell = this.executionContexts.begin({
      conversationId: pending.conversationId,
      requestText: pending.requestText,
      resolvedText: pending.resolvedText,
    })
    this.executionContexts.commit(
      fillExecutionContext(shell, {
        ...pending,
        outcome,
        artifacts: extractFileArtifacts(artifactInputs),
        errors: errors.slice(0, 12),
        executedSteps,
        verifiedSteps,
        refutedSteps,
        unverifiedSteps,
        terminalStatus: this.runState.state,
      }),
    )
  }

  /** Phase 2.6 — last committed execution context (read-only, user-safe). */
  lastExecutionContext(conversationId?: string): ExecutionContext | undefined {
    const id = conversationId ?? useConversationStore.getState().conversation.id
    return this.executionContexts.lastFor(id)
  }

  /* ------------------------------------------------ Phase 2.7 camera surface */

  /**
   * Deterministic camera-command handler. Every branch performs the REAL
   * browser operation through the bound CameraController (and real vision when
   * configured) or honestly says why it cannot. It never fabricates a frame,
   * a permission state or a "look" at anything.
   */
  private async handleCameraIntent(kind: CameraIntent): Promise<string> {
    const camera = this.camera
    if (!camera) {
      return 'I have no webcam surface bound in this build, so I cannot turn a camera on or look through one. I will not pretend to see.'
    }
    const caps = camera.capabilities()
    if (kind === 'camera_on') {
      if (caps.active) return 'The camera is already running.'
      if (!caps.available) {
        return `I cannot turn the camera on: ${CAMERA_UNAVAILABLE_MESSAGE}`
      }
      const result = await camera.start()
      if (result.ok) {
        return 'The camera is on. Ask me "what do you see?" and, when a vision model is configured, I will describe the feed honestly.'
      }
      return result.reason
        ? `I could not start the camera: ${result.reason}`
        : `I could not start the camera — the browser reported permission state "${result.permission}".`
    }

    if (kind === 'camera_off') {
      const wasActive = caps.active
      camera.stop()
      return wasActive ? 'Camera off.' : 'The camera is already off.'
    }

    // camera_see — a real frame first, then (only) a real vision analysis.
    if (!caps.active) {
      const lead = 'The camera is not running, so I have no frame to look at. Ask me to turn the camera on first.'
      if (!this.vision) {
        return `${lead} And even with a camera, no vision model is configured — so I could not honestly describe what it shows.`
      }
      return lead
    }
    let frame
    try {
      frame = await camera.captureFrame()
    } catch {
      return 'Grabbing a camera frame failed, so I cannot look through the feed right now.'
    }
    if (!frame) {
      return 'I could not grab a frame from the active camera feed, so I cannot show or describe anything from it just now.'
    }
    if (!this.vision) {
      return 'I captured a camera frame, but no vision model is configured — so I genuinely cannot tell you what it shows. Configure a vision model to enable "what do you see?".'
    }
    try {
      const analysis = await this.vision.analyzeScreenshot(frame, {
        signal: this.runAbort?.signal,
      })
      return describeCameraFrame(analysis)
    } catch (error) {
      return `I could not analyse the camera frame: ${userFacing(error).message}`
    }
  }

  /* ------------------------------------------------ Phase 9 UI-control surface */

  /** Honest verb label for an unrecognised panel target. */
  private uiControlVerb(kind: UiControlIntent['kind']): string {
    switch (kind) {
      case 'open_panel':
        return 'open'
      case 'close_panel':
        return 'close'
      case 'toggle_panel':
        return 'toggle'
      case 'focus_panel':
        return 'focus'
      case 'switch_environment':
        return 'switch to'
      case 'next_environment':
      case 'previous_environment':
        return 'switch to'
      case 'set_theme':
      case 'next_theme':
        return 'set theme to'
      default:
        return 'interact with'
    }
  }

  /** Live environment id, coerced to a known registry id (never a guess). */
  private currentEnvironmentId(): VisualEnvironmentId {
    const id = usePanelLayoutStore.getState().environmentId
    return isEnvironmentId(id) ? id : DEFAULT_ENVIRONMENT
  }

  /**
   * Phase 9 — deterministic JARVIS self-interaction turn. Executes recognised
   * UI-control commands through the REAL panel/environment store actions (the
   * same surface the taskbar and environment panel use) and reports each
   * result from the post-condition re-read from the store — the engine never
   * asserts a switch, an open or a close that the store did not actually hold.
   * Unknown targets are answered with the real catalogue names.
   */
  private async handleUiControlCommands(intents: UiControlIntent[]): Promise<void> {
    this.runState.transition('executing')
    this.setStatus('executing')

    const results = intents.map((intent) => this.executeUiControlCommand(intent))
    const reply = results.map((r) => r.text).join('\n')
    const allOk = results.every((r) => r.ok)
    const anyOk = results.some((r) => r.ok)

    this.emit({
      type: 'notice',
      kind: allOk ? 'success' : anyOk ? 'warning' : 'info',
      text: reply,
    })

    addAssistantMessage(reply)
    this.emit({
      type: 'transcript',
      speaker: 'assistant',
      text: reply,
    })
    for (const result of results) {
      this.fireActivity({
        step: 'Executed self-action',
        kind: 'tool',
        detail: result.text,
      })
    }
    this.runState.finish('completed')
    this.tracer.end('completed')
    this.setStatus('success')
    this.applyResponse(reply)
  }

  /** Execute ONE UI-control command against the store; verify and report. */
  private executeUiControlCommand(intent: UiControlIntent): { ok: boolean; text: string } {
    const store = usePanelLayoutStore.getState()

    // ---- theme control ----------------------------------------------------
    if (intent.kind === 'next_theme') {
      return this.applyTheme(nextTheme(this.currentThemeId()))
    }
    if (intent.kind === 'set_theme') {
      if (!intent.themeKnown || !intent.themeId) {
        return {
          ok: false,
          text: `I cannot switch to "${intent.raw}": that is not one of my themes. Available: ${themeChoices().join(', ')}.`,
        }
      }
      return this.applyTheme(intent.themeId)
    }

    // ---- environment switching -------------------------------------------
    if (intent.kind === 'switch_environment') {
      if (!intent.environmentKnown || !intent.environmentId) {
        return {
          ok: false,
          text: `I cannot switch to "${intent.raw}": that is not one of my environments. Available: ${environmentChoices().join(', ')}.`,
        }
      }
      const target = intent.environmentId
      if (this.currentEnvironmentId() === target) {
        return { ok: true, text: `You are already in the ${environmentLabel(target)} environment.` }
      }
      store.setEnvironment(target)
      return this.currentEnvironmentId() === target
        ? { ok: true, text: `Switched to ${environmentLabel(target)}.` }
        : { ok: false, text: `I could not switch to ${environmentLabel(target)}.` }
    }

    if (intent.kind === 'next_environment' || intent.kind === 'previous_environment') {
      const current = this.currentEnvironmentId()
      const next = stepEnvironment(current, intent.kind === 'next_environment' ? 1 : -1)
      store.setEnvironment(next)
      return this.currentEnvironmentId() === next
        ? { ok: true, text: `Switched to ${environmentLabel(next)}.` }
        : { ok: false, text: 'I could not switch environments.' }
    }

    // ---- panel control ----------------------------------------------------
    if (!intent.panelKnown || !intent.panelId) {
      return {
        ok: false,
        text: `I cannot ${this.uiControlVerb(intent.kind)} "${intent.raw}": that is not one of my panels. Available: ${panelChoices().join(', ')}.`,
      }
    }
    const id = intent.panelId
    const label = PANEL_BY_ID.get(id)?.title ?? id

    switch (intent.kind) {
      case 'open_panel': {
        if (store.panels[id].open) return { ok: true, text: `The ${label} panel is already open.` }
        store.openPanel(id)
        return usePanelLayoutStore.getState().panels[id].open
          ? { ok: true, text: `Opened the ${label} panel.` }
          : { ok: false, text: `I could not open the ${label} panel.` }
      }
      case 'close_panel': {
        if (!store.panels[id].open) return { ok: true, text: `The ${label} panel is already closed.` }
        store.closePanel(id)
        return !usePanelLayoutStore.getState().panels[id].open
          ? { ok: true, text: `Closed the ${label} panel.` }
          : { ok: false, text: `I could not close the ${label} panel.` }
      }
      case 'toggle_panel': {
        const wasOpen = store.panels[id].open
        store.togglePanel(id)
        const nowOpen = usePanelLayoutStore.getState().panels[id].open
        if (nowOpen === wasOpen) return { ok: false, text: `I could not toggle the ${label} panel.` }
        return nowOpen
          ? { ok: true, text: `Opened the ${label} panel.` }
          : { ok: true, text: `Closed the ${label} panel.` }
      }
      case 'focus_panel': {
        if (!store.panels[id].open) {
          store.openPanel(id)
          if (!usePanelLayoutStore.getState().panels[id].open) {
            return { ok: false, text: `I could not open the ${label} panel to focus it.` }
          }
          store.focusPanel(id)
          return { ok: true, text: `Opened and focused the ${label} panel.` }
        }
        store.focusPanel(id)
        return { ok: true, text: `Focused the ${label} panel.` }
      }
      default:
        return { ok: false, text: 'I could not perform that UI action.' }
    }
  }

  /** Real current theme (the theme store is the single source of truth). */
  private currentThemeId(): JarvisTheme {
    return useJarvisStore.getState().theme
  }

  /** Apply a theme through the REAL store and verify the post-state. */
  private applyTheme(target: JarvisTheme): { ok: boolean; text: string } {
    const label = THEME_META[target].label
    if (useJarvisStore.getState().theme === target) {
      return { ok: true, text: `You are already using the ${label} theme.` }
    }
    useJarvisStore.getState().setTheme(target)
    return useJarvisStore.getState().theme === target
      ? { ok: true, text: `Switched to the ${label} theme.` }
      : { ok: false, text: `I could not switch to the ${label} theme.` }
  }

  /**
   * Phase 10 — deterministic self-command execution with a VERIFIED
   * post-condition (mission #6). Recognition success is never assumed to be
   * action success: the command delegates to the SAME normalized store surface
   * voice + UI already reach, then the result is read back from the store.
   * Emits activity + a notice (success or warning) reflecting the honest
   * outcome.
   */
  runSelfAction(command: GestureCommand): GestureActionResult {
    const result = executeGestureCommand(command, this.currentEnvironmentId())
    if (result.ok) {
      this.fireActivity({
        step: 'Executed gesture self-action',
        kind: 'tool',
        detail: result.detail,
      })
      this.emit({ type: 'notice', kind: 'success', text: result.detail })
    } else {
      this.emit({ type: 'notice', kind: 'warning', text: result.detail })
    }
    return result
  }

  private setStatus(status: JarvisStatus): void {
    useJarvisStore.getState().setStatus(status)
    this.emit({ type: 'status', status })
  }

  /* ------------------------------------------------ messages */
  private buildMessages(context: ConversationMessage[], memories: MemoryItem[]): AIMessage[] {
    const profile = useJarvisStore.getState().profile
    const messages: AIMessage[] = [
      { role: 'system', content: buildSystemPrompt(profile.name, memories) },
    ]

    // Phase 2.5 — compact interaction hint: maps the natural request onto the
    // capabilities ACTUALLY registered in this environment. Guidance only; the
    // concrete capability definitions below remain the contract the provider
    // must draw from, and the stabilisers still validate everything.
    const hint = this.buildInteractionHint()
    if (hint) messages.push({ role: 'system', content: hint })

    // Phase 2.6 — engine-selected mechanism hint for THIS request (registered
    // tools/capabilities the deterministic selector matched). Informational
    // guidance for the provider; execution still needs the full rails.
    if (this.actionHint) messages.push({ role: 'system', content: this.actionHint })

    for (const m of context) {
      if (m.actor === 'user') messages.push({ role: 'user', content: m.text })
      else if (m.actor === 'assistant') messages.push({ role: 'assistant', content: m.text })
      else if (m.actor === 'system') messages.push({ role: 'system', content: m.text })
    }

    return messages
  }

  /**
   * Phase 2.5 — a bounded, plain-language hint of the capabilities the user can
   * really use right now, grouped by category. Built from the live catalog; a
   * missing entry means the capability is not registered/available here.
   */
  private buildInteractionHint(): string {
    const catalog = this.capabilityCatalog()
    if (catalog.length === 0) return ''
    const byCategory = new Map<string, string[]>()
    for (const cap of catalog) {
      const label = categoryLabel(cap.category)
      const list = byCategory.get(label) ?? []
      list.push(cap.id)
      byCategory.set(label, list)
    }
    const lines: string[] = []
    for (const [label, ids] of byCategory) {
      lines.push(`- ${label}: ${ids.join(', ')}`)
    }
    return `The user may ask in natural language for any of the following — map the request to the matching capability id (never invent capabilities not listed here):\n${lines.join('\n')}`
  }

  /* ------------------------------------------------ context */
  /**
   * Phase 0.9 — guarantee the provider sees the current user turn. The
   * conversation window excludes the in-flight user message (it is passed to
   * the provider as the prompt), so when the transcript did not yet contain a
   * user turn to show, the current request is surfaced as the leading message.
   */
  private ensureConversationTurn(
    window: ConversationWindowContext,
    current: string,
    currentId: string,
  ): ConversationMessage[] {
    const messages = window.messages.slice()
    if (!messages.some((m) => m.actor === 'user')) {
      messages.unshift({
        id: currentId,
        actor: 'user',
        text: current,
        createdAt: new Date().toISOString(),
      })
    }
    return messages
  }

  /**
   * Phase 0.9 — semantic scorer for conversation retrieval. Wraps the
   * process-wide EmbeddingManager: real providers participate, the
   * deterministic/test provider never masquerades as semantic understanding,
   * and any failure degrades to lexical-only retrieval. One batched call per
   * turn, race-safe (stateless per invocation).
   */
  private conversationSemanticScorer(): (texts: string[]) => Promise<Array<number[] | undefined>> {
    const embeddings = getDefaultEmbeddingManager()
    return async (texts: string[]): Promise<Array<number[] | undefined>> => {
      if (texts.length === 0 || !embeddings.hasRealEmbeddings()) {
        return texts.map(() => undefined)
      }
      try {
        return await embeddings.generateEmbeddingsBatch(texts)
      } catch (error) {
        console.warn('[engine] conversation semantic retrieval failed:', error)
        return texts.map(() => undefined)
      }
    }
  }

  /* ------------------------------------------------ activity helpers */
  private fireActivity(opts: { step: string; kind: ActivityOut['kind']; detail: string }): void {
    const id = `activity-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const running: ActivityOut = {
      id,
      step: opts.step,
      status: 'running',
      kind: opts.kind,
      detail: opts.detail,
      startedAt: Date.now(),
    }
    this.emit({ type: 'activity', activity: running })
    const final: ActivityOut = { ...running, status: 'success' }
    this.emit({ type: 'activity', activity: final })
  }

  private emitRunningTool(toolId: string, kind: ActivityOut['kind'], runId: string): void {
    const tool = this.registry.get(toolId)
    const label = tool?.name ?? toolId
    this.emit({
      type: 'activity',
      activity: {
        id: `activity-${runId}`,
        step: `Running ${label}`,
        status: 'running',
        kind,
        detail: `Invoking ${label}`,
        startedAt: Date.now(),
        runId,
      },
    })
  }

  private finishToolActivity(
    runId: string,
    toolId: string,
    status: ActivityStatus,
    detail: string,
  ): void {
    const tool = this.registry.get(toolId)
    const label = tool?.name ?? toolId
    const finalStatus = status === 'rejected' ? 'rejected' : status
    this.emit({
      type: 'activity',
      activity: {
        id: `activity-${runId}`,
        step: `${label} ${status === 'rejected' ? 'declined' : finalStatus === 'success' ? 'completed' : 'failed'}`,
        status: finalStatus,
        kind: 'tool',
        detail,
        startedAt: Date.now(),
        runId,
      },
    })
  }

  private fireMemoryActivity(action: MemoryActivityAction, text: string): void {
    this.emit({ type: 'memory', action, scope: 'long-term' })
    this.fireActivity({
      step: `Memory ${action}`,
      kind: 'memory',
      detail: text,
    })
  }

  private emitTaskSnapshot(): void {
    const label = this.currentStepLabel()
    this.emit({
      type: 'task',
      task: this.planTracker.snapshot(label),
    })
  }

  private currentStepLabel(): string {
    const plan = this.planTracker.current
    if (!plan) return 'Task in progress'
    // Find the most recent running or waiting step
    const running = plan.steps.find((s) => s.status === 'RUNNING' || s.status === 'WAITING_CONFIRMATION')
    if (running) {
      const tool = this.registry.get(running.toolId)
      return `Running ${tool?.name ?? running.toolId}`
    }
    return 'Task in progress'
  }

  private clearTask(): void {
    this.emit({ type: 'task', task: { active: false, label: '', step: 0, total: 0, status: 'COMPLETED' } })
  }

  private emit(m: EngineOutMessage): void {
    for (const l of this.listeners) l(m)
  }
}

function exhaustedReason(kind: AgentErrorKind | undefined): string {
  return kind === 'timeout' ? 'The tool timed out on every attempt.' : 'The tool kept failing, so I stopped retrying.'
}

export type { MemoryItem, MemoryType }