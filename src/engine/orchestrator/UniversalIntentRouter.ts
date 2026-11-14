/**
 * Universal Intent & Strategy Router (Phase 1)
 *
 * Grounded central intelligence layer that analyzes natural-language user requests
 * and selects the optimal execution strategy:
 *  - DIRECT_ANSWER: General knowledge, reasoning, explanations, chitchat (streams directly).
 *  - AUTONOMOUS_DEV: Software development, testing, repository maintenance (DAG execution).
 *  - WEB_RESEARCH: Search, current information retrieval, multi-source investigation.
 *  - BROWSER_WORKFLOW: Interactive web browsing, Playwright navigation, form filling.
 *  - DESKTOP_ACTION: Application launch/close, window management, desktop screenshot/input.
 *  - FILE_OPERATION: Local filesystem search, read, write, copy, move.
 *  - DATA_ANALYSIS: Statistical analysis, tabular inspection, chart generation.
 *  - PRODUCTIVITY: Reminders, alarms, calendar planning, scheduled tasks.
 *  - CONTINUITY: Resuming, querying previous task checkpoints.
 *  - TASK_CONTROL: Pausing, resuming, cancelling, or approving background tasks.
 *  - CLARIFICATION_REQUIRED: Targeted question when an intent is ambiguous or risky.
 *
 * Rule: Fails open to DIRECT_ANSWER for open-ended conversation; strictly binds to
 * registered, verifiable capabilities for actionable execution.
 */

import { extractProjectPath, normalizeProjectPath } from '../dev/DevelopmentPlanner'
import { planNaturalSchedulingRequest, type SchedulingIntentPlan } from '../../scheduling/schedulerTools'
import type { RequestClass } from './goalUnderstanding'

export type ExecutionStrategy =
  | 'DIRECT_ANSWER'
  | 'AUTONOMOUS_DEV'
  | 'WEB_RESEARCH'
  | 'DEEP_RESEARCH'
  | 'DOCUMENT_INTELLIGENCE'
  | 'MEMORY_OPERATION'
  | 'MULTIMODAL_REQUEST'
  | 'BROWSER_WORKFLOW'
  | 'DESKTOP_ACTION'
  | 'FILE_OPERATION'
  | 'DATA_ANALYSIS'
  | 'PRODUCTIVITY'
  | 'CONTINUITY'
  | 'TASK_CONTROL'
  | 'CLARIFICATION_REQUIRED'

export type ExecutionMode =
  | 'DIRECT_ANSWER'
  | 'LOCAL_REASONING'
  | 'LOCAL_MODEL_INFERENCE'
  | 'WEB_RESEARCH'
  | 'DOCUMENT_RETRIEVAL'
  | 'BROWSER_INTERACTION'
  | 'DESKTOP_INTERACTION'
  | 'CODE_EXECUTION'
  | 'DATA_ANALYSIS'
  | 'FILE_GENERATION'
  | 'MULTIPLE_COMBINED'

export interface OutcomeUnderstanding {
  userObjective: string
  desiredOutcome: string
  relevantContext: {
    targetPath?: string
    targetApplication?: string
    targetUrl?: string
    isContinuation?: boolean
    entities: Record<string, unknown>
  }
  constraints: string[]
  requiredInformation: string[]
  availableCapabilities: string[]
  potentialRisks: string[]
  verificationRequirements: string[]
  executionMode: ExecutionMode
  requiresDurableTask: boolean
  clarificationNeeded?: string
  limitationExplanation?: string
}

export interface IntentRouteDecision {
  strategy: ExecutionStrategy
  requestClass: RequestClass
  confidence: number
  intent: string
  explanation: string
  entities: Record<string, unknown>
  suggestedCapabilities: string[]
  clarificationQuestion?: string
  devPlan?: {
    projectName?: string
    projectPath?: string
    objective: string
  }
  schedulingPlan?: SchedulingIntentPlan
  continuity?: {
    action: 'resume' | 'status' | 'inspect'
    targetTaskId?: string
  }
  outcomeUnderstanding?: OutcomeUnderstanding
}

export interface RouterContext {
  hasActiveTask?: boolean
  lastActiveProject?: { name: string; rootPath: string }
  availableCapabilities?: string[]
}

/* ------------------------------------------------------------- Anchored Patterns */

const CONTINUITY_PATTERNS = [
  /\bcontinue\s+where\s+(?:you|we)\s+stopped\b/i,
  /\bresume\s+where\s+(?:you|we)\s+(?:left\s+off|stopped)\b/i,
  /\bcontinue\s+(?:the\s+)?previous\s+task\b/i,
  /\bresume\s+(?:the\s+)?previous\s+task\b/i,
  /\b(?:continue|proceed)\s+(?:with\s+)?(?:the\s+)?(?:next\s+)?(?:step|subtask|action)\b/i,
  /\bwhat\s+(?:was|is)\s+(?:the\s+)?(?:status|last\s+error|outcome)\s+(?:of|in)\s+(?:that|the\s+previous)\s+(?:task|project|job)\b/i,
  /\bwhat\s+were\s+you\s+working\s+on\b/i,
  /\bshow\s+previous\s+task\s+status\b/i,
]

const TASK_CONTROL_PATTERNS = [
  /^(?:please\s+)?(?:pause|hold)\s+(?:the\s+|this\s+|that\s+)?(?:current\s+|active\s+|running\s+|paused\s+)*(?:task|job|operation|action|run|process|audit|workflow)\b/i,
  /^(?:please\s+)?resume\s+(?:the\s+|this\s+|that\s+)?(?:current\s+|active\s+|running\s+|paused\s+)*(?:task|job|operation|action|run|process|audit|workflow)\b/i,
  /^(?:please\s+)?(?:cancel|abort|kill)\s+(?:the\s+|this\s+|that\s+)?(?:current\s+|active\s+|running\s+|paused\s+)*(?:task|job|operation|action|run|process|audit|workflow)\b/i,
  /^(?:please\s+)?stop\s+(?:the\s+|this\s+|that\s+)?(?:current\s+|active\s+|running\s+|paused\s+)*(?:task|job|operation|action|run|process|audit|workflow)\b/i,
  /^(?:please\s+)?approve\s+(?:the\s+|this\s+|that\s+)?(?:action|subtask|step|operation|permission)\b/i,
  /^(?:please\s+)?reject\s+(?:the\s+|this\s+|that\s+)?(?:action|subtask|step|operation|permission)\b/i,
  /\b(?:what\s+(?:is|was)|show|check|get)\s+(?:the\s+)?(?:execution\s+)?status\s+of\s+(task-[\w-]+)\b/i,
]

const CHITCHAT_PATTERNS = [
  /^(?:hi|hello|hey|good\s+morning|good\s+evening|good\s+afternoon)\b/i,
  /^(?:how\s+are\s+you|how\s+is\s+it\s+going|what's\s+up)\b/i,
  /^(?:thanks|thank\s+you|thank\s+you\s+so\s+much|thx)\b/i,
  /^(?:bye|goodbye|see\s+you|farewell)\b/i,
  /^(?:who\s+are\s+you|what\s+is\s+your\s+name|introduce\s+yourself)\b/i,
]

const CALCULATION_PATTERNS = [
  /^(?:calculate|compute|evaluate|what\s+is)\s+[\d\s+\-*/().^%]+$/i,
  /^(?:calculate|compute|evaluate|what\s+is)\s+.*(?:percent|percentage|power\s+of|\^|\+|-|\*|\/).*$/i,
  /^[\d\s+\-*/().^%]+$/,
]

const DATA_ANALYSIS_PATTERNS = [
  /\b(?:analyze|analyse|summarize|inspect|profile)\s+(?:the\s+|this\s+)?(?:data|dataset|csv|metrics|sales|records?|dataframe|table|spreadsheet|workbook|excel)\b/i,
  /\b(?:calculate|compute)\s+(?:the\s+)?(?:average|mean|median|correlation|trend|growth)\b/i,
  /\b(?:plot|draw|generate|create)\s+(?:a\s+)?(?:[a-z0-9_-]+\s+)?(?:chart|graph|histogram|scatter\s+plot|heatmap|diagram)\b/i,
  /\b(?:correlation|trend\s+analysis|outlier\s+detection|statistical\s+summary|summary\s+statistics|aggregate)\b/i,
  /\b(?:find\s+the\s+largest\s+csv|top\s+\d+\s+records)\b/i,
]

const DEEP_RESEARCH_PATTERNS = [
  /\b(?:deep\s+research|deep\s+dive|in-depth\s+research|comprehensive\s+research|thorough\s+research|investigate\s+thoroughly)\b/i,
  /\b(?:research\s+comprehensively|conduct\s+(?:a\s+)?deep\s+dive|detailed\s+investigation)\b/i,
  /\b(?:compare\s+in[- ]depth|cross[- ]check\s+sources\s+on)\b/i,
  /\b(?:multi-source\s+investigation|synthesize\s+research\s+report\s+on)\b/i,
  /\b(?:find\s+(?:\w+\s+)?sources\s+about|compare\s+(?:their\s+)?approaches)\b/i,
  /\b(?:research\s+[\w\s-]+\s+(?:and\s+cite|and\s+prepare|and\s+save))\b/i,
  /\bresearch\s+[\w-]+\s+architectures\b/i,
  /\bresearch\s+(?:the\s+)?(?:differences|tradeoffs|performance|options|approaches|pros\s+and\s+cons)\b/i,
  /\bresearch\s+[\w\s-]+\s+and\s+(?:give|provide|summarize|compare)\b/i,
  /\b(?:research\s+and\s+compare|compare\s+performance)\b/i,
  /\bresearch\s+[\w-]+\s+(?:benchmarks|features|mechanisms|engines|performance)\b/i,
  /\b(?:find\s+sources\s+discussing|published\s+claims\s+disagree|explain\s+the\s+discrepancy)\b/i,
]

const DOCUMENT_INTELLIGENCE_PATTERNS = [
  /\b(?:summarize|parse|extract\s+(?:all\s+)?(?:data|text|tables?|sections?)\s+from|analyze|query|inspect|read)\s+(?:the\s+|this\s+)?(?:[\w-]+\s+)*(?:pdf|document|contract|docx|xlsx|spreadsheet|presentation|pptx|report|invoice|receipt|paper|whitepaper|excel)\b/i,
  /\bwhat\s+does\s+(?:the\s+|this\s+)?(?:document|pdf|contract|report|file|paper)\s+say\s+about\b/i,
  /\b(?:read\s+and\s+summarize|extract\s+insights\s+from)\s+(?:the\s+|this\s+)?(?:pdf|document|docx|xlsx|report)\b/i,
  /\b(?:parse|read|inspect|summarize|analyze)\s+[\w\-./\\]+\.(?:pdf|docx|xlsx|pptx)\b/i,
  /\b(?:extract\s+(?:all\s+)?(?:tables?|data|text|sections?)\s+from)\s+[\w\-./\\]+\.(?:pdf|docx|xlsx|pptx|csv)\b/i,
  /\b(?:create\s+(?:a\s+)?structured\s+comparison|compare\s+two\s+documents|document\s+comparison)\b/i,
  /\bread\s+(?:these\s+)?benchmark\s+result\s+files\b/i,
]

const MEMORY_OPERATION_PATTERNS = [
  /^(?:please\s+)?(?:remember|memorize|keep\s+in\s+mind)\s+(?:that\s+)?/i,
  /^(?:what\s+do\s+you\s+remember\s+about|recall\s+(?:what\s+you\s+know\s+about|my)|show\s+(?:my\s+)?memories|list\s+(?:my\s+)?memories)\b/i,
  /^(?:please\s+)?(?:forget|delete\s+memory|erase\s+memory)\s+(?:that\s+|about\s+)?/i,
  /^(?:update|change|set)\s+my\s+preference\s+(?:for|to)\b/i,
  /\b(?:actually|correction|correct)\s+(?:my\s+)?(?:preference|memory)\b/i,
  /\b(?:what\s+(?:is|are)\s+my\s+(?:stored\s+|saved\s+)?preferences?)\b/i,
  /\b(?:show|list|get|view|display)\s+(?:my\s+)?(?:stored\s+|saved\s+)?preferences?\b/i,
  /\b(?:recall|check)\s+(?:my\s+)?(?:stored\s+|saved\s+)?(?:preferences?|settings)\b/i,
]

const MULTIMODAL_REQUEST_PATTERNS = [
  /\b(?:what\s+is\s+in\s+(?:this|the)\s+image|describe\s+(?:this|the)\s+image|analyze\s+(?:this|the)\s+image)\b/i,
  /\b(?:inspect|analyze)\s+(?:this|the)\s+(?:photo|picture|diagram|chart\s+image|graphic)\b/i,
  /\b(?:transcribe\s+(?:this|the)\s+audio|listen\s+to\s+this\s+audio|what\s+is\s+said\s+in\s+this\s+recording)\b/i,
  /\b(?:optical\s+character\s+recognition|ocr\s+this|read\s+text\s+from\s+image)\b/i,
  /\b(?:look\s+at\s+this\s+image|what\s+do\s+you\s+see\s+in\s+this\s+(?:picture|image|screenshot))\b/i,
]

const WEB_RESEARCH_PATTERNS = [
  /\b(?:search\s+(?:for|the\s+web\s+for)|google|duckduckgo|look\s+up)\b/i,
  /\b(?:latest|current|recent|newest)\s+(?:news|updates|release|version|price|information|scores)\b/i,
  /\b(?:what\s+is\s+the\s+latest|who\s+won|current\s+weather|current\s+time\s+in)\b/i,
  /\b(?:compare\s+the\s+best|find\s+me\s+the\s+best|reviews\s+for|documentation\s+for)\b/i,
  /\b(?:research\s+[\w\s-]{3,60})\b/i,
]

const BROWSER_WORKFLOW_PATTERNS = [
  /\b(?:open|launch|start)\s+(?:the\s+)?(?:web\s+)?browser\b/i,
  /\b(?:open|go\s+to|visit|browse\s+to|navigate\s+to)\s+(?:https?:\/\/|www\.|(?:[\w-]+\.)+(?:com|org|io|dev|net|edu|gov|co|ai|app))\b/i,
  /\b(?:fill\s+(?:out\s+)?(?:the\s+)?form|click\s+(?:on\s+)?(?:the\s+)?button|submit\s+the\s+page)\b/i,
  /\b(?:scrape|extract\s+(?:all\s+)?(?:tables?|data)\s+from|read\s+webpage)\b/i,
  /\b(?:navigate|browse|surf)\s+(?:to\s+)?(?:multiple\s+)?(?:web\s+)?(?:pages?|sites?|docs?|documentation)\b/i,
  /\b(?:browser|playwright)\s+(?:workflow|automation|task)\b/i,
  /\b(?:open|launch)\s+(?:the\s+)?browser\s+and\b/i,
  /\b(?:extract\s+text|read\s+page|capture\s+screenshot)\s+from\s+(?:the\s+)?(?:browser|webpage|page)\b/i,
  /\b(?:navigate\s+to\s+.*extract\s+text)\b/i,
  /\b(?:compare\s+sources|extract\s+text.*compare)\b/i,
]

const KNOWN_DESKTOP_APPS = [
  'notepad',
  'calculator',
  'calc',
  'chrome',
  'browser',
  'file explorer',
  'explorer',
  'terminal',
  'cmd',
  'powershell',
  'code',
  'vscode',
  'visual studio code',
  'word',
  'excel',
  'powerpoint',
  'paint',
  'spotify',
  'slack',
  'discord',
  'settings',
  'task manager',
]

const KNOWN_APPS_PATTERN = new RegExp(
  `^(?:open|launch|start|close|quit|kill|stop|switch\\s+to|focus|bring\\s+to\\s+(?:front|foreground))\\s+(?:my\\s+|the\\s+)?(?:${KNOWN_DESKTOP_APPS.join('|')})\\s*[.!]?$`,
  'i'
)

const DESKTOP_ACTION_PATTERNS = [
  KNOWN_APPS_PATTERN,
  /^(?:open|launch|start)\s+(?:my\s+|the\s+)?(?:notepad|calculator|calc|paint)\s*[.!]?$/i,
  /^(?:open|launch|start)\s+(?:the\s+)?([a-z0-9_-]{2,25})\s+(?:app|application)[.!]?$/i,
  /^(?:close|quit|kill|stop)\s+(?:the\s+)?([a-z0-9_-]{2,25})\s+(?:app|application)[.!]?$/i,
  /^(?:switch\s+to|focus|bring\s+to\s+(?:front|foreground))\s+(?:my\s+|the\s+)?([a-z0-9 _-]{2,25})\s*(?:app|application|window)?[.!]?$/i,
  /\b(?:which|what|show|list)\s+(?:applications?|apps|windows)\s+(?:are\s+)?(?:currently\s+)?(?:open|running|active)\b/i,
  /\b(?:list\s+(?:open\s+)?windows|what\s+windows\s+are\s+open|show\s+open\s+apps)\b/i,
  /\b(?:take\s+(?:a\s+)?(?:desktop\s+)?screenshot|capture\s+(?:the\s+)?(?:screen|desktop))\b/i,
  /\b(?:what\s+is\s+(?:currently\s+)?visible\s+on\s+(?:my\s+)?(?:screen|desktop))\b/i,
  /^(?:open|launch)\s+([a-z0-9_-]{2,25})\s+and\s+(?:calculate|compute|type)\b/i,
  /^(?:open|launch|start)\s+(?:the\s+|my\s+)?([a-z0-9_-]{2,25})\s+and\s+([a-z0-9_-]{2,25})\b/i,
  /^(?:launch|open)\s+notepad,\s*write\b/i,
]

const FILE_OPERATION_PATTERNS = [
  /\b(?:list\s+files|show\s+directory|list\s+directory|browse\s+folder)\b/i,
  /\b(?:search\s+for\s+files?|find\s+files?|locate\s+file)\b/i,
  /\b(?:read|inspect|view)\s+(?:the\s+)?file\b/i,
  /\b(?:copy\s+file|move\s+file|rename\s+file)\b/i,
]

const AMBIGUOUS_DEICTIC_PATTERNS = [
  {
    regex: /^(?:please\s+)?open\s+(?:it|that|this|the\s+same)[.!]?$/i,
    intent: 'ambiguous_deictic_instruction',
    question: 'Which specific file, application, or URL would you like me to open?',
  },
  {
    regex: /^(?:please\s+)?(?:delete|remove|destroy|erase)\s+(?:it|that|them|this|(?:the|that|this)\s+file)(?:\s+right\s+now)?[.!]?$/i,
    intent: 'destructive_ambiguity',
    question: "I didn't act on that: Which specific file or target would you like me to delete? Please confirm the exact file path.",
  },
  {
    regex: /^(?:please\s+)?use\s+(?:the\s+)?(?:second|first|last|other|next)\s+(?:one|candidate|option)[.!]?$/i,
    intent: 'ambiguous_deictic_instruction',
    question: 'Which candidate or option would you like to use? Please specify the name or details.',
  },
  {
    regex: /^(?:please\s+)?use\s+(?:the\s+)?(?:other|second|next)\s+document[.!]?$/i,
    intent: 'ambiguous_deictic_instruction',
    question: 'Which specific document would you like me to use? Please specify the target document name.',
  },
  {
    regex: /^(?:please\s+)?compare\s+(?:it|this|that)\s+with\s+(?:the\s+)?(?:first|second|other|next)\s+option[.!]?$/i,
    intent: 'ambiguous_deictic_instruction',
    question: 'Which candidate or option would you like to compare? Please specify the option details.',
  },
  {
    regex: /^(?:please\s+)?find\s+(?:the\s+)?problem\s+in\s+that\s+project[.!]?$/i,
    intent: 'ambiguous_deictic_instruction',
    question: 'Which specific project or repository would you like me to inspect? Please specify the path.',
  },
  {
    regex: /^(?:please\s+)?fix\s+(?:it|that|this)[.!]?$/i,
    intent: 'ambiguous_deictic_instruction',
    question: 'Which error, file, or issue would you like me to fix? Please specify the path or error message.',
  },
  {
    regex: /^(?:please\s+)?make\s+it\s+(?:better|faster|cleaner)[.!]?$/i,
    intent: 'ambiguous_deictic_instruction',
    question: 'What specific improvements would you like to make to the code or document?',
  },
  {
    regex: /^(?:please\s+)?run\s+(?:the\s+)?(?:other|second|next)\s+file[.!]?$/i,
    intent: 'ambiguous_deictic_instruction',
    question: 'Which specific script, test, or file would you like me to run?',
  },
  {
    regex: /^(?:please\s+)?send\s+(?:it|that)\s+now[.!]?$/i,
    intent: 'ambiguous_deictic_instruction',
    question: 'Which message, email, or report would you like me to send, and to whom?',
  },
]

/* ------------------------------------------------------------- Helper Matchers */

function isAutonomousDevRequest(text: string, lower: string): boolean {
  // If the request is an explicit desktop operation like launching Notepad, do not hijack into dev
  if (/^(?:launch|open|start)\s+(?:the\s+|my\s+)?notepad\b/i.test(lower)) {
    return false
  }
  // If the request is reading/comparing benchmark or result files, it is document intelligence / data analysis
  if (/^read\s+these\s+benchmark\s+result\s+files\b/i.test(lower) || /^read\s+.*files\s+in\s+.*compare/i.test(lower)) {
    return false
  }

  // 1. Explicit path with software or creation intent
  const hasDrivePath = /[a-z]:[\\/][\w.-]+/i.test(text)
  const textWithoutPath = text.replace(/[a-z]:[\\/][\w.-]+/gi, '')
  const devKeywords = /\b(python|program|unittest|test|tests|circle|area|script|code|repository|repo|project|codebase|patch|checkpoint|git)\b/i
  if (hasDrivePath && devKeywords.test(textWithoutPath.toLowerCase())) {
    return true
  }

  // 2. Explicit project repair / audit commands
  if (
    lower.startsWith('jarvis, fix ') ||
    lower.startsWith('jarvis, audit ') ||
    lower.startsWith('fix my ') ||
    lower.startsWith('audit my ') ||
    lower.startsWith('inspect my ') ||
    lower.includes('projecthub')
  ) {
    return true
  }

  // 3. Inspection of repository or project
  const mentionsRepo = /\b(repository|repo|project|codebase)\b/i.test(lower)
  if (/^(?:jarvis,\s*)?inspect\b/i.test(lower) && (mentionsRepo || hasDrivePath)) {
    return true
  }

  // 4. "Create a ... program / script / test"
  if (/\bcreate\s+(?:a\s+)?(?:simple\s+)?(?:python|javascript|typescript|c\+\+|rust)?\s*(?:program|script|app|test|module)\b/i.test(lower)) {
    return true
  }

  // 5. Explicit autonomous task trigger
  if (lower.includes('autonomous') && (lower.includes('task') || lower.includes('project') || lower.includes('dev'))) {
    return true
  }

  return false
}

function extractAutonomousDevEntities(text: string, lower: string, context?: RouterContext): {
  projectName?: string
  projectPath?: string
  objective: string
} {
  let projectPath = extractProjectPath(text)
  let projectName: string | undefined

  if (!projectPath) {
    const match = text.match(/(?:fix|audit|improve|inspect)\s+(?:my\s+)?([a-zA-Z0-9_./\\:-]+)(?:\s+(?:project|repository|repo))?/i)
    if (match && match[1]) {
      projectName = match[1].replace(/[.,;:!?]+$/, '').replace(/(?:project|repository|repo)$/i, '').trim()
    }
  }

  if (!projectName && lower.includes('projecthub')) {
    projectName = 'ProjectHub'
    if (!projectPath) projectPath = 'D:\\ProjectHub'
  }

  if (!projectName && !projectPath && context?.lastActiveProject) {
    projectName = context.lastActiveProject.name
    projectPath = context.lastActiveProject.rootPath
  }

  return {
    projectName: projectName || (projectPath ? undefined : 'CurrentProject'),
    projectPath: projectPath ? normalizeProjectPath(projectPath) : undefined,
    objective: text.trim(),
  }
}

/* ------------------------------------------------------------- Router Implementation */

export class UniversalIntentRouter {
  /**
   * Classify a raw user request into an execution strategy with structured outcome understanding.
   */
  classify(text: string, context?: RouterContext): IntentRouteDecision {
    const raw = text ?? ''
    const clean = raw.trim()
    const lower = clean.toLowerCase()

    const rawDecision = this.classifyInternal(clean, lower, context)
    const outcome = buildOutcomeUnderstanding(clean, rawDecision, context)
    return {
      ...rawDecision,
      outcomeUnderstanding: outcome,
    }
  }

  /**
   * Deeply analyze user objective, desired outcome, constraints, capabilities, and verification requirements.
   */
  understandOutcome(text: string, context?: RouterContext): OutcomeUnderstanding {
    return this.classify(text, context).outcomeUnderstanding!
  }

  private classifyInternal(clean: string, lower: string, context?: RouterContext): Omit<IntentRouteDecision, 'outcomeUnderstanding'> {
    if (!clean) {
      return {
        strategy: 'DIRECT_ANSWER',
        requestClass: 'question',
        confidence: 1.0,
        intent: 'empty',
        explanation: 'Empty user prompt.',
        entities: {},
        suggestedCapabilities: [],
      }
    }

    // ------------------------------------------------------------------------
    // 1. Risky Deictic Ambiguity Check (Default-Deny Protection)
    // ------------------------------------------------------------------------
    const deicticMatch = AMBIGUOUS_DEICTIC_PATTERNS.find((p) => p.regex.test(clean))
    if (deicticMatch) {
      return {
        strategy: 'CLARIFICATION_REQUIRED',
        requestClass: 'clarification',
        confidence: 0.95,
        intent: deicticMatch.intent,
        explanation: 'Instruction contains ambiguous deictic reference without antecedent; explicit clarification required.',
        entities: {},
        suggestedCapabilities: [],
        clarificationQuestion: deicticMatch.question,
      }
    }

    // ------------------------------------------------------------------------
    // 2. Continuity Requests ("continue where you stopped", etc.)
    // ------------------------------------------------------------------------
    if (CONTINUITY_PATTERNS.some((p) => p.test(lower))) {
      return {
        strategy: 'CONTINUITY',
        requestClass: 'continuity' as RequestClass,
        confidence: 0.95,
        intent: 'resume_work',
        explanation: 'User requested continuation of the previous task or project.',
        entities: {},
        suggestedCapabilities: ['task_management', 'project_context'],
        continuity: { action: 'resume' },
      }
    }

    // ------------------------------------------------------------------------
    // 3. Task Lifecycle Control ("pause task", "cancel task", "approve", "status of task-...")
    // ------------------------------------------------------------------------
    if (TASK_CONTROL_PATTERNS.some((p) => p.test(lower))) {
      const statusMatch = lower.match(/\b(?:execution\s+)?status\s+of\s+(task-[\w-]+)\b/i)
      const isStatus = Boolean(statusMatch)
      const isResume = !isStatus && /^(?:please\s+)?resume\b/i.test(lower)
      const isPause = !isStatus && !isResume && /^(?:please\s+)?(?:pause|hold)\b/i.test(lower)
      const isCancel = !isStatus && /^(?:please\s+)?(?:cancel|abort|kill|stop)\b/i.test(lower)
      const isApprove = !isStatus && /^(?:please\s+)?approve\b/i.test(lower)
      const action = isStatus ? 'status' : isResume ? 'resume' : isPause ? 'pause' : isCancel ? 'cancel' : isApprove ? 'approve' : 'control'
      return {
        strategy: 'TASK_CONTROL',
        requestClass: 'task_control' as RequestClass,
        confidence: 0.95,
        intent: action,
        explanation: 'User issued task lifecycle control directive.',
        entities: { action, taskId: statusMatch ? statusMatch[1] : undefined },
        suggestedCapabilities: ['task_management'],
      }
    }

    // ------------------------------------------------------------------------
    // 3b. Personal Memory Operations ("remember that...", "show my memories", etc.)
    // ------------------------------------------------------------------------
    if (MEMORY_OPERATION_PATTERNS.some((p) => p.test(clean))) {
      const isRemember = /^(?:please\s+)?(?:remember|memorize|keep\s+in\s+mind)\b/i.test(clean)
      const isRecall = /^(?:what\s+do\s+you\s+remember\s+about|recall\s+|show\s+(?:my\s+)?memories|list\s+(?:my\s+)?memories)/i.test(clean)
      const isForget = /^(?:please\s+)?(?:forget|delete\s+memory|erase\s+memory)\b/i.test(clean)
      const isPref = /\bpreference\b/i.test(clean)

      let operation = 'recall'
      if (isRemember) operation = 'remember'
      else if (isForget) operation = 'forget'
      else if (isPref) operation = 'preference'
      else if (isRecall) operation = 'recall'

      return {
        strategy: 'MEMORY_OPERATION',
        requestClass: 'command',
        confidence: 0.94,
        intent: `memory_${operation}`,
        explanation: `User requested explicit personal memory operation: ${operation}.`,
        entities: { operation, text: clean },
        suggestedCapabilities: ['memory.remember', 'memory.recall', 'memory.list', 'memory.forget'],
      }
    }

    // ------------------------------------------------------------------------
    // 4. Scheduling & Reminders ("remind me at 7 PM...", etc.)
    // ------------------------------------------------------------------------
    const schedulingPlan = planNaturalSchedulingRequest(clean)
    if (schedulingPlan) {
      return {
        strategy: 'PRODUCTIVITY',
        requestClass: 'productivity' as RequestClass,
        confidence: 0.92,
        intent: 'schedule_reminder',
        explanation: 'Natural language scheduling request with deterministic duration/time.',
        entities: schedulingPlan.params,
        suggestedCapabilities: ['schedule_reminder', 'schedule_management'],
        schedulingPlan,
      }
    }

    // ------------------------------------------------------------------------
    // 4b. Productivity Integrations: Email, Calendar, Git
    // ------------------------------------------------------------------------
    if (isProductivityServiceRequest(clean, lower)) {
      const prod = extractProductivityServiceEntities(clean, lower)
      return {
        strategy: 'PRODUCTIVITY',
        requestClass: 'productivity' as RequestClass,
        confidence: 0.93,
        intent: prod.intent,
        explanation: prod.explanation,
        entities: prod.entities,
        suggestedCapabilities: prod.suggestedCapabilities,
      }
    }

    // ------------------------------------------------------------------------
    // 5. Autonomous Software Development & Engineering
    // ------------------------------------------------------------------------
    if (isAutonomousDevRequest(clean, lower)) {
      const devEntities = extractAutonomousDevEntities(clean, lower, context)
      return {
        strategy: 'AUTONOMOUS_DEV',
        requestClass: 'autonomous_dev' as RequestClass,
        confidence: 0.94,
        intent: 'software_development',
        explanation: 'Multi-step autonomous software development objective.',
        entities: {
          projectPath: devEntities.projectPath,
          projectName: devEntities.projectName,
          objective: devEntities.objective,
        },
        suggestedCapabilities: [
          'dev.inspectProject',
          'dev.gitStatus',
          'dev.gitCheckpoint',
          'dev.patchFile',
          'dev.runTests',
          'dev.auditProject',
          'dev.generateReport',
        ],
        devPlan: devEntities,
      }
    }

    // ------------------------------------------------------------------------
    // 5b. Deep Research & Multi-Source Synthesis
    // ------------------------------------------------------------------------
    if (DEEP_RESEARCH_PATTERNS.some((p) => p.test(lower))) {
      return {
        strategy: 'DEEP_RESEARCH',
        requestClass: 'web_research',
        confidence: 0.93,
        intent: 'deep_research',
        explanation: 'Multi-source deep research, cross-checking, and report synthesis request.',
        entities: { query: clean, depth: 'deep' },
        suggestedCapabilities: ['web_search', 'web_fetch', 'doc.summarize'],
      }
    }

    // ------------------------------------------------------------------------
    // 5c. Complete Document Intelligence (PDF, DOCX, XLSX, PPTX, etc.)
    // ------------------------------------------------------------------------
    if (DOCUMENT_INTELLIGENCE_PATTERNS.some((p) => p.test(lower))) {
      const fileMatch = clean.match(/[\w\-./\\]+\.(?:pdf|docx|xlsx|pptx|csv|md|txt)/i)
      return {
        strategy: 'DOCUMENT_INTELLIGENCE',
        requestClass: 'file_operation' as RequestClass,
        confidence: 0.91,
        intent: 'document_intelligence',
        explanation: 'Deep document reading, tabular/section extraction, or document summarization.',
        entities: {
          query: clean,
          filePath: fileMatch ? fileMatch[0] : undefined,
        },
        suggestedCapabilities: ['doc.parse', 'doc.summarize', 'doc.query', 'data.analyze'],
      }
    }

    // ------------------------------------------------------------------------
    // 5d. Multimodal Intelligence (Image, Screenshot, Audio, OCR)
    // ------------------------------------------------------------------------
    if (MULTIMODAL_REQUEST_PATTERNS.some((p) => p.test(lower))) {
      const isAudio = /\b(audio|recording|transcribe|listen)\b/i.test(lower)
      return {
        strategy: 'MULTIMODAL_REQUEST',
        requestClass: 'command',
        confidence: 0.90,
        intent: isAudio ? 'audio_transcription' : 'image_analysis',
        explanation: isAudio ? 'Audio transcription and auditory reasoning request.' : 'Visual inspection, image analysis, or OCR request.',
        entities: { query: clean, mode: isAudio ? 'audio' : 'visual' },
        suggestedCapabilities: isAudio ? ['audio.transcribe'] : ['vision.analyze', 'desktop.screenshot'],
      }
    }

    // ------------------------------------------------------------------------
    // 6. Data Analysis & Chart Generation
    // ------------------------------------------------------------------------
    if (DATA_ANALYSIS_PATTERNS.some((p) => p.test(lower))) {
      return {
        strategy: 'DATA_ANALYSIS',
        requestClass: 'data_analysis' as RequestClass,
        confidence: 0.88,
        intent: 'data_analysis',
        explanation: 'Data inspection, statistical calculation, or chart visualization request.',
        entities: { query: clean },
        suggestedCapabilities: ['data.analyze', 'data.chart', 'doc.summarize', 'doc.parse'],
      }
    }

    // ------------------------------------------------------------------------
    // 7. Interactive Browser Workflows
    // ------------------------------------------------------------------------
    const isDeviceTarget =
      /\b(?:on|to)\s+(?:my\s+|the\s+)?(?:phone|android|mobile|device|victus|dell|microwave|other|untrusted-device|[a-z0-9_-]+phone)\b/i.test(lower) ||
      /\b(?:refresh|sync|ping|list)\s+(?:my\s+)?devices?\b/i.test(lower)

    if (!isDeviceTarget && BROWSER_WORKFLOW_PATTERNS.some((p) => p.test(lower))) {
      const urlMatches = clean.match(/https?:\/\/[^\s"'<>]+/gi) || []
      const isMultiPage = /multiple|compare|and\s+(?:then\s+)?navigate|pages/i.test(lower)
      const isScreenshot = /screenshot/i.test(lower)
      const isExtract = /extract|read/i.test(lower)
      return {
        strategy: 'BROWSER_WORKFLOW',
        requestClass: 'browser_workflow' as RequestClass,
        confidence: 0.88,
        intent: isMultiPage ? 'multi_page_browser' : 'browser_automation',
        explanation: 'Interactive web browsing, website navigation, or form interaction.',
        entities: {
          query: clean,
          urls: urlMatches,
          targetUrl: urlMatches[0],
          isMultiPage,
          isScreenshot,
          isExtract,
        },
        suggestedCapabilities: [
          'browser.open',
          'browser.navigate',
          'browser.readPage',
          'browser.screenshot',
          'browser.close',
        ],
      }
    }

    // ------------------------------------------------------------------------
    // 8. Desktop & Operating System Actions
    // ------------------------------------------------------------------------
    if (!isDeviceTarget && DESKTOP_ACTION_PATTERNS.some((p) => p.test(lower))) {
      const isVisualInspect =
        /tell\s+me\s+what\s+is\s+(?:currently\s+)?visible|what\s+is\s+(?:currently\s+)?visible|describe\s+(?:the\s+)?(?:screen|desktop)/i.test(lower)
      const isScreenshot = !isVisualInspect && /screenshot|screen\s+capture/i.test(lower)
      const isListWindows =
        /(?:which|what|show|list)\s+(?:applications?|apps|windows)\s+(?:are\s+)?(?:currently\s+)?(?:open|running|active)|list\s+(?:open\s+)?windows|what\s+windows\s+are\s+open|show\s+open\s+apps/i.test(lower)
      const isSwitch = /^(?:switch\s+to|focus|bring\s+to\s+(?:front|foreground))/i.test(lower)
      const isMultiStep =
        /^(?:open|launch)\s+([a-z0-9_-]{2,25})\s+and\s+(?:calculate|compute|type|click|run)\b/i.test(lower) ||
        /^(?:launch|open)\s+(?:the\s+|my\s+)?notepad,\s*write\b/i.test(lower) ||
        /^(?:open|launch|start)\s+(?:the\s+|my\s+)?([a-z0-9_-]{2,25})\s+and\s+([a-z0-9_-]{2,25})\b/i.test(lower)
      const isOpen =
        !isMultiStep &&
        (/^(?:open|launch|start)\s+(?:the\s+|my\s+)?([a-z0-9 _-]{2,35})(?:\s+(?:app|application))?[.!]?$/i.test(clean) ||
          KNOWN_APPS_PATTERN.test(clean))
      const isClose =
        /^(?:close|quit|kill|stop)\s+(?:the\s+|my\s+)?([a-z0-9 _-]{2,35})(?:\s+(?:app|application))?[.!]?$/i.test(clean)

      let intent = 'desktop_action'
      const entities: Record<string, unknown> = { text: clean }

      if (isMultiStep) {
        intent = 'multi_step_desktop'
        const calcMatch = lower.match(/calculate\s+(.+)$/i)
        if (calcMatch) entities.calculation = calcMatch[1].replace(/[.!?]+$/, '').trim()
        const appMatch = lower.match(/^(?:open|launch)\s+([a-z0-9_-]{2,25})/i)
        if (appMatch) entities.appName = appMatch[1].trim()
      } else if (isVisualInspect) {
        intent = 'visual_inspect'
      } else if (isScreenshot) {
        intent = 'screenshot'
      } else if (isListWindows) {
        intent = 'list_windows'
      } else if (isSwitch) {
        intent = 'switch_app'
        const match = lower.match(/^(?:switch\s+to|focus|bring\s+to\s+(?:front|foreground))\s+(?:my\s+|the\s+)?([a-z0-9 _-]{2,35})/i)
        if (match) entities.targetApp = match[1].replace(/(?:app|application|window)[.!]?$/i, '').replace(/[.!?]+$/, '').trim()
      } else if (isOpen) {
        intent = 'open_app'
        const match = lower.match(/^(?:open|launch|start)\s+(?:the\s+)?([a-z0-9 _-]{2,35})/i)
        if (match) entities.targetApp = match[1].replace(/(?:app|application)[.!]?$/i, '').replace(/[.!?]+$/, '').trim()
      } else if (isClose) {
        intent = 'close_app'
        const match = lower.match(/^(?:close|quit|kill|stop)\s+(?:the\s+)?([a-z0-9 _-]{2,35})/i)
        if (match) entities.targetApp = match[1].replace(/(?:app|application)[.!]?$/i, '').replace(/[.!?]+$/, '').trim()
      }

      return {
        strategy: 'DESKTOP_ACTION',
        requestClass: 'command',
        confidence: 0.92,
        intent,
        explanation: 'Native desktop interaction, application lifecycle, or window observation.',
        entities,
        suggestedCapabilities:
          intent === 'screenshot' || intent === 'visual_inspect'
            ? ['desktop.screenshot', 'observe_desktop']
            : intent === 'list_windows'
              ? ['window.list', 'list_windows']
              : intent === 'switch_app'
                ? ['window.focus', 'window.list']
                : ['launch_app', 'open_application', 'close_application'],
      }
    }

    // ------------------------------------------------------------------------
    // 9. Filesystem Operations
    // ------------------------------------------------------------------------
    if (FILE_OPERATION_PATTERNS.some((p) => p.test(lower))) {
      return {
        strategy: 'FILE_OPERATION',
        requestClass: 'file_operation' as RequestClass,
        confidence: 0.85,
        intent: 'filesystem',
        explanation: 'Local file exploration, search, or document reading.',
        entities: { text: clean },
        suggestedCapabilities: ['read_file_contents', 'list_directory', 'search_files'],
      }
    }

    // ------------------------------------------------------------------------
    // 10. Web Research & Current Information
    // ------------------------------------------------------------------------
    if (WEB_RESEARCH_PATTERNS.some((p) => p.test(lower))) {
      return {
        strategy: 'WEB_RESEARCH',
        requestClass: 'web_research',
        confidence: 0.86,
        intent: 'web_search',
        explanation: 'Current web information retrieval or research synthesis.',
        entities: { query: clean },
        suggestedCapabilities: ['web_search', 'web_fetch'],
      }
    }

    // ------------------------------------------------------------------------
    // 11. Fast Local Math / Calculation
    // ------------------------------------------------------------------------
    if (CALCULATION_PATTERNS.some((p) => p.test(clean))) {
      return {
        strategy: 'DIRECT_ANSWER',
        requestClass: 'question',
        confidence: 0.95,
        intent: 'calculation',
        explanation: 'Mathematical evaluation query.',
        entities: { expression: clean },
        suggestedCapabilities: ['perform_calculation'],
      }
    }

    // ------------------------------------------------------------------------
    // 12. Conversational Chitchat & Greetings
    // ------------------------------------------------------------------------
    if (CHITCHAT_PATTERNS.some((p) => p.test(lower))) {
      return {
        strategy: 'DIRECT_ANSWER',
        requestClass: 'conversation',
        confidence: 0.92,
        intent: 'conversation',
        explanation: 'Conversational chitchat, greeting, or identity inquiry.',
        entities: {},
        suggestedCapabilities: [],
      }
    }

    // ------------------------------------------------------------------------
    // 13. Default: General Knowledge, Reasoning, Direct Q&A
    // ------------------------------------------------------------------------
    return {
      strategy: 'DIRECT_ANSWER',
      requestClass: 'question',
      confidence: 0.85,
      intent: 'general_inquiry',
      explanation: 'General knowledge, explanation, reasoning, or advice query. Answer directly without task overhead.',
      entities: { query: clean },
      suggestedCapabilities: [],
    }
  }
}

/**
 * Constructs a structured outcome understanding model for the user instruction.
 * Evaluates desired outcomes, constraints, available capabilities, risks, and verification requirements.
 */
function buildOutcomeUnderstanding(
  text: string,
  decision: Omit<IntentRouteDecision, 'outcomeUnderstanding'>,
  context?: RouterContext,
): OutcomeUnderstanding {
  const clean = text.trim()
  const lower = clean.toLowerCase()

  // 1. Context extraction
  const pathMatch = clean.match(/[a-zA-Z]:[\\/][\w.\-\\/]+/i) || clean.match(/(?:^|\s)([\w\-./\\]+\.(?:pdf|docx|xlsx|pptx|csv|md|txt|py|ts|js|json|html))\b/i)
  const targetPath = decision.devPlan?.projectPath || (pathMatch ? pathMatch[1] || pathMatch[0] : undefined)

  const urlMatch = clean.match(/https?:\/\/[^\s<>"]+/i)
  const targetUrl = urlMatch ? urlMatch[0] : undefined

  let targetApplication = typeof decision.entities.app === 'string' ? decision.entities.app : undefined
  if (!targetApplication) {
    const appMatch = lower.match(/\b(notepad|calculator|calc|chrome|edge|browser|paint|terminal|cmd|powershell)\b/i)
    if (appMatch) targetApplication = appMatch[1]
  }

  const isContinuation = decision.strategy === 'CONTINUITY' || /\b(continue|resume|where we left off)\b/i.test(lower)

  // 2. Multi-domain / compound workflow detection
  const hasMultipleActions =
    (/\b(and|then|after that|once done)\b/i.test(lower) &&
      (/\b(research|search|look up)\b/i.test(lower) && /\b(report|presentation|document|summary)\b/i.test(lower))) ||
    (/\b(open browser|browse|web)\b/i.test(lower) && /\b(extract|download|save|calculate)\b/i.test(lower)) ||
    (/\b(inspect|audit|find problem)\b/i.test(lower) && /\b(fix|patch|repair)\b/i.test(lower) && /\b(test|verify)\b/i.test(lower))

  // 3. Execution mode determination
  let executionMode: ExecutionMode = 'DIRECT_ANSWER'
  let desiredOutcome = 'Accurate, direct informational answer or explanation.'
  let requiresDurableTask = false
  const constraints: string[] = []
  const requiredInformation: string[] = []
  const potentialRisks: string[] = []
  const verificationRequirements: string[] = []
  let limitationExplanation: string | undefined

  // Check hardware/capability blocks
  if (/\b(microphone|mic|voice\s*recording|listen\s*to\s*me|speech\s*input)\b/i.test(lower) && !/\b(tts|speak|say)\b/i.test(lower)) {
    limitationExplanation = 'Live microphone audio hardware input is currently blocked in this automated environment without active physical hardware capture.'
  }

  if (hasMultipleActions) {
    executionMode = 'MULTIPLE_COMBINED'
    requiresDurableTask = true
    desiredOutcome = 'End-to-end multi-step workflow execution with verified intermediate and final artifacts.'
    constraints.push('Durable task orchestration required with DAG checkpointing')
    constraints.push('Preserve state across subtask boundaries')
    potentialRisks.push('Cascading subtask failure if earlier stage output is invalid')
    verificationRequirements.push('Verify all composite subtask deliverables independently')
  } else {
    switch (decision.strategy) {
      case 'AUTONOMOUS_DEV':
        executionMode = 'CODE_EXECUTION'
        requiresDurableTask = true
        desiredOutcome = 'Functional software implementation with passing tests, Git checkpoint, and verifiable execution report.'
        constraints.push('Operate strictly within approved workspace root')
        constraints.push('Preserve existing uncommitted changes in workspace')
        constraints.push('Execute non-destructive tests with exit code 0')
        potentialRisks.push('Modifying user code unexpectedly', 'Test suite failure or regression')
        verificationRequirements.push('Automated test suite passes with exit code 0', 'Git checkpoint SHA recorded', 'Report contains valid file hashes')
        break

      case 'DATA_ANALYSIS':
        executionMode = 'DATA_ANALYSIS'
        requiresDurableTask = /\b(chart|plot|outlier|visualization|workbook|revenue)\b/i.test(lower)
        desiredOutcome = 'Comprehensive statistical summary with mean, median, correlation, trend detection, and chart visualization.'
        constraints.push('Do not invent or fabricate dataset values', 'Validate tabular schema prior to aggregation')
        potentialRisks.push('Incorrect statistical inference on sparse or skewed data')
        verificationRequirements.push('Accurate mathematical calculations', 'Chart generated from actual dataset rows')
        break

      case 'BROWSER_WORKFLOW':
        executionMode = 'BROWSER_INTERACTION'
        requiresDurableTask = true
        desiredOutcome = 'Interactive browser automation session with navigated page content, DOM data, or full-page screenshot.'
        constraints.push('Strict SSRF protection: block loopback, link-local, private RFC 1918, and cloud metadata')
        constraints.push('Validate redirected URLs before content extraction')
        potentialRisks.push('SSRF exploitation', 'Navigation timeout on slow or blocked external domains')
        verificationRequirements.push('Target DOM element existence verified', 'HTTP status code 200', 'Screenshot buffer has valid PNG signature')
        break

      case 'DESKTOP_ACTION':
        executionMode = 'DESKTOP_INTERACTION'
        requiresDurableTask = false
        desiredOutcome = 'Win32 application management, UIA control interaction, or desktop screenshot observation.'
        constraints.push('Restrict destructive desktop operations', 'Confirm ambiguous application targets')
        potentialRisks.push('Interacting with incorrect foreground window', 'Unintended keyboard input')
        verificationRequirements.push('Window handle validated', 'Process health verified', 'Screenshot captured successfully')
        break

      case 'DEEP_RESEARCH':
      case 'WEB_RESEARCH':
        executionMode = 'WEB_RESEARCH'
        requiresDurableTask = decision.strategy === 'DEEP_RESEARCH'
        desiredOutcome = 'Synthesized multi-source research report with traceable citations and objective evaluation.'
        constraints.push('Traceable source citations required; never invent URLs or citations')
        constraints.push('Deduplicate overlapping search results')
        potentialRisks.push('Hallucinated citations or unverified secondary sources')
        verificationRequirements.push('All source URLs format-validated', 'Key factual claims supported by extracted text')
        break

      case 'DOCUMENT_INTELLIGENCE':
        executionMode = 'DOCUMENT_RETRIEVAL'
        requiresDurableTask = false
        desiredOutcome = 'Extracted document structure, tabular data, or summarized content with provenance.'
        constraints.push('Preserve source provenance (page, section, table index)')
        potentialRisks.push('Unrecognized document format or corrupted file')
        verificationRequirements.push('Document file exists on disk', 'Parsed content is non-empty')
        break

      case 'MEMORY_OPERATION':
        executionMode = 'DIRECT_ANSWER'
        requiresDurableTask = false
        desiredOutcome = 'Personal memory record updated, retrieved, or deleted in persistent store.'
        constraints.push('Credential and secret filtering on stored memories')
        verificationRequirements.push('Memory operation confirmed in storage')
        break

      case 'PRODUCTIVITY':
        executionMode = 'DIRECT_ANSWER'
        requiresDurableTask = false
        desiredOutcome = 'Productivity action executed (scheduled reminder, calendar event, or email draft).'
        constraints.push('Explicit approval required before sending emails or deleting events')
        potentialRisks.push('Unintended external messaging or event collision')
        verificationRequirements.push('Productivity adapter returns success confirmation')
        break

      case 'CLARIFICATION_REQUIRED':
        executionMode = 'DIRECT_ANSWER'
        requiresDurableTask = false
        desiredOutcome = 'Targeted clarifying question asked to user to resolve ambiguous deictic pronoun or missing target.'
        constraints.push('Do not guess or assume ambiguous intent')
        verificationRequirements.push('Question directly addresses the ambiguity')
        break

      case 'CONTINUITY':
        executionMode = 'DIRECT_ANSWER'
        requiresDurableTask = false
        desiredOutcome = 'Previous project and task checkpoint context restored and summarized.'
        verificationRequirements.push('Task ID and last checkpoint status retrieved')
        break

      case 'TASK_CONTROL':
        executionMode = 'DIRECT_ANSWER'
        requiresDurableTask = false
        desiredOutcome = 'Task lifecycle directive (pause, cancel, approve) applied to persistent task.'
        verificationRequirements.push('Task state transition confirmed')
        break

      case 'MULTIMODAL_REQUEST':
        executionMode = decision.entities.mode === 'audio' ? 'LOCAL_MODEL_INFERENCE' : 'LOCAL_REASONING'
        requiresDurableTask = false
        desiredOutcome = decision.entities.mode === 'audio' ? 'Audio transcript or auditory reasoning' : 'Visual element description or screenshot OCR'
        break

      case 'DIRECT_ANSWER':
      default:
        const isTechnicalOrMathReasoning =
          CALCULATION_PATTERNS.some((p) => p.test(clean)) ||
          /\b(solve\s+for\s+[a-z]|quadratic|\d+x\^2|compound\s+interest|convert\s+\d+\s+(?:km|kilometers|miles|mph|meters|feet)|difference\s+between\s+optimistic\s+and\s+pessimistic|locking\s+in\s+distributed|trade-offs\s+between\s+b-trees|raft\s+consensus|copy-on-write|tail-call\s+optimization)\b/i.test(lower)

        if (isTechnicalOrMathReasoning) {
          executionMode = 'LOCAL_REASONING'
          desiredOutcome = 'Computed mathematical, architectural, or logical reasoning answer.'
          verificationRequirements.push('Logical and mathematical validity verified')
        } else if (CHITCHAT_PATTERNS.some((p) => p.test(lower))) {
          executionMode = 'DIRECT_ANSWER'
          desiredOutcome = 'Conversational greeting or personal AI identity explanation.'
        } else {
          executionMode = 'DIRECT_ANSWER'
          desiredOutcome = 'Direct explanation, reasoning, or answer delivered to user.'
        }
        break
    }
  }

  // Check required information
  if (decision.strategy === 'AUTONOMOUS_DEV' && !targetPath) {
    requiredInformation.push('Project path or directory location')
  }
  if (decision.strategy === 'CLARIFICATION_REQUIRED' && decision.clarificationQuestion) {
    requiredInformation.push(decision.clarificationQuestion)
  }

  // Filter available capabilities from catalog / context
  const availableCapabilities = (context?.availableCapabilities || []).filter((cap) =>
    decision.suggestedCapabilities.includes(cap)
  )

  return {
    userObjective: decision.devPlan?.objective || clean,
    desiredOutcome,
    relevantContext: {
      targetPath,
      targetApplication,
      targetUrl,
      isContinuation,
      entities: decision.entities,
    },
    constraints,
    requiredInformation,
    availableCapabilities: availableCapabilities.length > 0 ? availableCapabilities : decision.suggestedCapabilities,
    potentialRisks,
    verificationRequirements,
    executionMode,
    requiresDurableTask,
    clarificationNeeded: decision.clarificationQuestion,
    limitationExplanation,
  }
}

function isProductivityServiceRequest(_clean: string, lower: string): boolean {
  if (/\b(git\s*(status|diff|log|commit|branch))\b/i.test(lower)) return true
  if (/\b(unread\s*emails?|check\s*(my\s*)?emails?|send\s*(an?\s*)?email|draft\s*(an?\s*)?email|compose\s*(an?\s*)?email|inbox\s*summary|list\s*emails?)\b/i.test(lower)) return true
  if (/\b(calendar\s*conflicts?|schedule\s*(a\s*)?meeting|book\s*(a\s*)?meeting|calendar\s*events?|check\s*(my\s*)?calendar|upcoming\s*meetings?|meeting\s*with)\b/i.test(lower)) return true
  return false
}

function extractProductivityServiceEntities(_clean: string, lower: string): {
  intent: string
  explanation: string
  entities: Record<string, unknown>
  suggestedCapabilities: string[]
} {
  if (/\bgit\b/i.test(lower)) {
    if (/\b(commit)\b/i.test(lower)) {
      return {
        intent: 'git_commit',
        explanation: 'Git workspace commit operation with confirmation.',
        entities: { action: 'commit' },
        suggestedCapabilities: ['git.status', 'git.diff', 'git.commit'],
      }
    }
    return {
      intent: 'git_status',
      explanation: 'Git workspace status, diff, or history inspection.',
      entities: { action: 'status' },
      suggestedCapabilities: ['git.status', 'git.diff', 'git.log'],
    }
  }

  if (/\bemails?\b/i.test(lower) || /\binbox\b/i.test(lower)) {
    if (/\b(send)\b/i.test(lower)) {
      return {
        intent: 'email_send',
        explanation: 'Email dispatch request requiring confirmation.',
        entities: { action: 'send' },
        suggestedCapabilities: ['email.draft', 'email.send'],
      }
    }
    if (/\b(draft|compose|write)\b/i.test(lower)) {
      return {
        intent: 'email_draft',
        explanation: 'Email composition request.',
        entities: { action: 'draft' },
        suggestedCapabilities: ['email.draft'],
      }
    }
    return {
      intent: 'email_list',
      explanation: 'Email list or inbox query.',
      entities: { action: 'list' },
      suggestedCapabilities: ['email.list', 'email.get'],
    }
  }

  // Calendar
  if (/\bconflicts?\b/i.test(lower)) {
    return {
      intent: 'calendar_conflicts',
      explanation: 'Calendar conflict detection request.',
      entities: { action: 'conflicts' },
      suggestedCapabilities: ['calendar.conflicts', 'calendar.list'],
    }
  }
  if (/\b(schedule\s*(a\s*)?meeting|book\s*(a\s*)?meeting|create\s*(a\s*)?event|add\s*(to\s*)?calendar)\b/i.test(lower)) {
    return {
      intent: 'calendar_create',
      explanation: 'Calendar event creation request.',
      entities: { action: 'create' },
      suggestedCapabilities: ['calendar.create', 'calendar.conflicts'],
    }
  }
  return {
    intent: 'calendar_list',
    explanation: 'Calendar schedule inspection.',
    entities: { action: 'list' },
    suggestedCapabilities: ['calendar.list', 'calendar.conflicts'],
  }
}
