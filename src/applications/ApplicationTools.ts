import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolInput,
  ToolPermission,
  ToolResult,
  ToolVerification,
} from '../tools/Tool'
import type { ToolInputSchema } from '../engine/provider'
import { FileSystemError } from '../filesystem'
import type { ApplicationProvider } from './provider'
import { normalizeAppTarget } from './provider'

/**
 * Application tools (Phase 1.3) — focused, typed, verified.
 *
 * Three narrow tools backed by the ApplicationProvider seam:
 *
 *   app.list    read_only  honest list of approved apps (never fake)
 *   app.status  read_only  honest process observation
 *   app.launch  low_risk   verifiable (auto-approvable, like file.write)
 *
 * The provider is OPTIONAL by design: when undefined (browser mode) no app
 * tools exist at all — the engine never fabricates a fake "system". Launch
 * verification reflects REAL provider state: a launch is only ever confirmed
 * after the backend observed the process running.
 */

function appFailure(error: unknown): ToolResult {
  if (error instanceof FileSystemError) {
    return { ok: false, message: error.message, data: { kind: error.kind, applicationId: error.path } }
  }
  const message = error instanceof Error ? error.message : 'Unknown application failure.'
  return { ok: false, message }
}

/** Short-circuit when the application capability is not actually available. */
function availabilityBlocker(provider: ApplicationProvider): ToolResult | null {
  const caps = provider.capabilities()
  if (caps.available) return null
  return {
    ok: false,
    message: `Application control is not available right now: ${caps.reason ?? 'the provider is inactive.'}`,
    data: { available: false, reason: caps.reason },
  }
}

function paramStr(input: ToolInput, key: string): string | undefined {
  const value = input.params?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Shape a free-form app reference (canonical id, slug, alias or display name
 * like "Google Chrome") into an app-id target. The native registry is the
 * authoritative resolver — the web side only ever passes a normalized id
 * shape, never a path. Returns a human reason when nothing is given.
 */
function shapeAppTarget(input: ToolInput, key: string): { id: string } | { error: string } {
  const raw = paramStr(input, key)
  if (!raw || raw.trim().length === 0) return { error: `Provide ${key}.` }
  return { id: normalizeAppTarget(raw) }
}

/* Directory-shaped inputs are about files, not applications. */
const FILE_TARGET = /["'][^"']+["']|\b[A-Za-z]:[\\/]|\b[\w.-]+\.(?:pdf|txt|docx?|md|csv|json|xml|png|jpe?g|gif|zip|mp4|mp3|mov)\b/i
const FILE_NOUN = /\b(file|files|folder|directory|document|documents|sheet|slides|note|notes|downloads?|desktop)\b/i

/* Well-known application names — a STRONG hint that a launch is being asked
 * for. Authoritative resolution still happens in the native registry. */
const HINT_APP_TOKEN = /\b(chrome|google chrome|edge|brave|firefox|vscode|visual studio code|code|visual studio|whatsapp|word|excel|powerpoint|outlook|one ?note|notepad|calculator|paint|paint 3d|explorer|file explorer|settings|task manager|spotify|discord|telegram|steam|slack|obs|terminal|command prompt|control panel|snipping tool|mail|calendar|photos|music|microsoft store|store|wsl|power ?shell)\b/i
const LAUNCH_VERB = /\b(launch|open|start|run|wake)\b/i
const STATUS_VERB = /\b(is .* (running|open|started)|status (of|for)|check|verify)\b/i
const CLOSE_VERB = /\b(close|quit|exit|kill|shut\s*down|stop)\b/i

abstract class AppTool implements Tool {
  readonly category: ToolCategory = 'system'
  readonly verifiable: boolean = false
  readonly requiresPermission: boolean = false
  protected readonly provider: ApplicationProvider

  constructor(provider: ApplicationProvider) {
    this.provider = provider
  }

  abstract readonly id: string
  abstract readonly name: string
  abstract readonly description: string
  abstract readonly permission: ToolPermission
  abstract readonly inputSchema: ToolInputSchema

  abstract canRun(query: string): boolean
  abstract execute(input: ToolInput, ctx: ToolContext): Promise<ToolResult>
}

/* ---------------------------------------------------------------- list */

export class AppListTool extends AppTool {
  readonly id = 'app.list'
  readonly name = 'List applications'
  readonly description =
    'Lists the Windows applications the operator has explicitly approved (configured in the native agent) plus top-level ' +
    'Start Menu shortcuts the agent discovered. Reports name, source and whether the app is launchable. ' +
    'This is an allow-list, not a scan of the whole computer.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = { type: 'object', properties: {}, required: [] }

  canRun(query: string): boolean {
    return /\b(what( applications| apps| programs)? (can|do|you (have|know))|list|show|installed)\b/i.test(query) &&
      /\b(app|apps|application|applications|program|programs|software)\b/i.test(query)
  }

  async execute(): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    try {
      const apps = await this.provider.list()
      if (!apps.length) {
        return { ok: true, message: 'No approved applications are configured yet.', data: { apps: [] } }
      }
      const caps = this.provider.capabilities()
      const launchable = apps.filter((a) => a.launchable)
      return {
        ok: true,
        message: `${apps.length} approved application${apps.length === 1 ? '' : 's'} (${launchable.length} launchable).`,
        data: { apps, ops: caps.ops },
      }
    } catch (error) {
      return appFailure(error)
    }
  }
}

/* ---------------------------------------------------------------- status */

export class AppStatusTool extends AppTool {
  readonly id = 'app.status'
  readonly name = 'Application status'
  readonly description =
    'Reports the honest running state of one approved application by id. `running` is a real process observation; ' +
    '`runningVerified` tells whether the platform can confirm it. Never fabricates an observation.'
  readonly permission: ToolPermission = 'read_only'
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: { application_id: { type: 'string', description: 'Application id from app.list.' } },
    required: ['application_id'],
  }

  canRun(query: string): boolean {
    return STATUS_VERB.test(query) && (HINT_APP_TOKEN.test(query) || /\b(app|application|program|software)\b/i.test(query))
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const parsed = shapeAppTarget(input, 'application_id')
    if ('error' in parsed) return { ok: false, message: parsed.error, data: { kind: 'invalid_input' } }
    try {
      const status = await this.provider.status(parsed.id)
      const state = status.runningVerified
        ? (status.running ? 'running' : 'not running')
        : 'could not be verified (real process observation is unavailable)'
      return { ok: true, message: `"${status.displayName}" (${status.applicationId}): ${state}.`, data: status }
    } catch (error) {
      return appFailure(error)
    }
  }
}

/* ---------------------------------------------------------------- launch */

export class AppLaunchTool extends AppTool {
  readonly id = 'app.launch'
  readonly name = 'Launch application'
  readonly description =
    'Launches an approved Windows application by id (from the native agent allow-list); aliases and names like "Google Chrome" are resolved there too. The target is resolved and ' +
    'verified entirely on the native side — the browser never sends an executable path and never uses a shell. ' +
    'Confirmation is only reported after the launched process is observed running. An optional folder is passed only to folder-capable apps (e.g. File Explorer).'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      application_id: { type: 'string', description: 'Application id from app.list, or a resolvable name/alias.' },
      folder: {
        type: 'string',
        description: 'Optional absolute directory to open the application in (folder-capable apps only).',
      },
    },
    required: ['application_id'],
  }

  canRun(query: string): boolean {
    if (!LAUNCH_VERB.test(query)) return false
    if (HINT_APP_TOKEN.test(query)) return true
    if (FILE_TARGET.test(query) || FILE_NOUN.test(query)) return false
    return /\b(app|application|program|software)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const parsed = shapeAppTarget(input, 'application_id')
    if ('error' in parsed) return { ok: false, message: parsed.error, data: { kind: 'invalid_input' } }
    const folder = paramStr(input, 'folder')
    try {
      const result = await this.provider.launch(parsed.id, folder !== undefined ? { folder } : undefined)
      if (!result.started) {
        return { ok: false, message: `"${result.applicationId}" could not be launched: ${result.detail}`, data: result }
      }
      if (result.verified) {
        return { ok: true, message: `Launched "${result.applicationId}" and confirmed it is running.`, data: result }
      }
      return {
        ok: true,
        message: `Launched "${result.applicationId}", but its running state could not be confirmed: ${result.detail}`,
        data: result,
      }
    } catch (error) {
      return appFailure(error)
    }
  }

  verify(input: ToolInput): Promise<ToolVerification> {
    const parsed = shapeAppTarget(input, 'application_id')
    const id = 'id' in parsed ? parsed.id : undefined
    if (!id) {
      return Promise.resolve({ ok: false, message: 'No valid application_id to verify.' })
    }
    return this.provider
      .status(id)
      .then((status) => {
        if (status.runningVerified && status.running) {
          return { ok: true, message: `Confirmed "${status.displayName}" is running.`, checks: ['process running'] }
        }
        if (status.runningVerified && !status.running) {
          return { ok: false, message: `Verification failed: "${status.applicationId}" is not running.` }
        }
        return {
          ok: false,
          status: 'unverified' as const,
          message: `Verification unavailable: the platform cannot confirm running state for "${status.applicationId}" (not observable).`,
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Unknown verification failure.'
        return { ok: false, status: 'unverified' as const, message: `Verification unavailable: ${message}` }
      })
  }
}

/* ---------------------------------------------------------------- close */

export class AppCloseTool extends AppTool {
  readonly id = 'app.close'
  readonly name = 'Close application'
  readonly description =
    'Closes a running application by its registered application id. The native agent resolves the process and terminates it safely. Verification confirms the process is no longer running.'
  readonly permission: ToolPermission = 'user_confirmation'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      application_id: { type: 'string', description: 'Application id from app.list.' },
    },
    required: ['application_id'],
  }

  canRun(query: string): boolean {
    if (!CLOSE_VERB.test(query)) return false
    if (HINT_APP_TOKEN.test(query)) return true
    if (FILE_TARGET.test(query) || FILE_NOUN.test(query)) return false
    return /\b(app|application|program|software)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    if (!this.provider.close) {
      return { ok: false, message: 'Application close is not supported by the current provider.' }
    }
    const parsed = shapeAppTarget(input, 'application_id')
    if ('error' in parsed) return { ok: false, message: parsed.error, data: { kind: 'invalid_input' } }
    try {
      const result = await this.provider.close(parsed.id)
      if (!result.terminated) {
        return { ok: false, message: result.detail, data: result }
      }
      return {
        ok: true,
        message: result.verified
          ? result.detail
          : `${result.detail} (verification not available)`,
        data: result,
      }
    } catch (error) {
      return appFailure(error)
    }
  }

  verify(input: ToolInput): Promise<ToolVerification> {
    const parsed = shapeAppTarget(input, 'application_id')
    const id = 'id' in parsed ? parsed.id : undefined
    if (!id) {
      return Promise.resolve({ ok: false, message: 'No valid application_id to verify.' })
    }
    return this.provider
      .status(id)
      .then((status) =>
        !status.running && status.runningVerified
          ? { ok: true, message: `Confirmed "${status.displayName}" is no longer running.`, checks: ['process terminated'] }
          : status.running && status.runningVerified
            ? { ok: false, message: `Verification failed: "${status.applicationId}" is still running.` }
            : {
                ok: false,
                status: 'unverified' as const,
                message: `Verification unavailable: the platform cannot confirm running state for "${status.applicationId}".`,
              },
      )
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Unknown verification failure.'
        return { ok: false, status: 'unverified' as const, message: `Verification unavailable: ${message}` }
      })
  }
}

/** All application tools bound to one provider (empty when none supplied). */
export function createApplicationTools(provider: ApplicationProvider | undefined): Tool[] {
  if (!provider) return []
  const tools: Tool[] = [new AppListTool(provider), new AppStatusTool(provider), new AppLaunchTool(provider)]
  if (provider.close) {
    tools.push(new AppCloseTool(provider))
  }
  return tools
}
