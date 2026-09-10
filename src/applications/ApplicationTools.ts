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
import { normalizeApplicationId } from './provider'

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
    return /\b(is .* (running|open|started)|status (of|for)|check)\b/i.test(query) &&
      /\b(app|application|program|notepad|court|calendar|browser)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const raw = paramStr(input, 'application_id')
    if (!raw) return { ok: false, message: 'Status for which application? Provide application_id.', data: { kind: 'invalid_input' } }
    const parsed = normalizeApplicationId(raw)
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
    'Launches an approved Windows application by id (from the native agent allow-list). The target is resolved and ' +
    'verified entirely on the native side — the browser never sends an executable path and never uses a shell. ' +
    'Confirmation is only reported after the launched process is observed running.'
  readonly permission: ToolPermission = 'low_risk'
  readonly verifiable = true
  readonly inputSchema: ToolInputSchema = {
    type: 'object',
    properties: {
      application_id: { type: 'string', description: 'Application id from app.list.' },
    },
    required: ['application_id'],
  }

  canRun(query: string): boolean {
    return /\b(launch|open|start|run|wake)\b/i.test(query) &&
      /\b(app|application|program|notepad|plus|court|calendar|browser)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    const raw = paramStr(input, 'application_id')
    if (!raw) return { ok: false, message: 'Launch which application? Provide application_id.', data: { kind: 'invalid_input' } }
    const parsed = normalizeApplicationId(raw)
    if ('error' in parsed) return { ok: false, message: parsed.error, data: { kind: 'invalid_input' } }
    try {
      const result = await this.provider.launch(parsed.id)
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
    const raw = paramStr(input, 'application_id')
    const parsed = raw ? normalizeApplicationId(raw) : undefined
    const id = parsed && 'id' in parsed ? parsed.id : undefined
    if (!id) {
      return Promise.resolve({ ok: false, message: 'No valid application_id to verify.' })
    }
    return this.provider
      .status(id)
      .then((status) =>
        status.running && status.runningVerified
          ? { ok: true, message: `Confirmed "${status.displayName}" is running.`, checks: ['process running'] }
          : {
              ok: false,
              message:
                status.runningVerified
                  ? `Verification failed: "${status.applicationId}" is not running.`
                  : `Verification unavailable: the platform cannot confirm running state for "${status.applicationId}".`,
            },
      )
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Unknown verification failure.'
        return { ok: false, message: `Verification failed: ${message}` }
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
    return /\b(close|quit|exit|kill|shut\s*down|stop)\b/i.test(query) &&
      /\b(app|application|program|notepad|court|calendar|browser)\b/i.test(query)
  }

  async execute(input: ToolInput): Promise<ToolResult> {
    const blocker = availabilityBlocker(this.provider)
    if (blocker) return blocker
    if (!this.provider.close) {
      return { ok: false, message: 'Application close is not supported by the current provider.' }
    }
    const raw = paramStr(input, 'application_id')
    if (!raw) return { ok: false, message: 'Close which application? Provide application_id.', data: { kind: 'invalid_input' } }
    const parsed = normalizeApplicationId(raw)
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
    const raw = paramStr(input, 'application_id')
    const parsed = raw ? normalizeApplicationId(raw) : undefined
    const id = parsed && 'id' in parsed ? parsed.id : undefined
    if (!id) {
      return Promise.resolve({ ok: false, message: 'No valid application_id to verify.' })
    }
    return this.provider
      .status(id)
      .then((status) =>
        !status.running && status.runningVerified
          ? { ok: true, message: `Confirmed "${status.displayName}" is no longer running.`, checks: ['process terminated'] }
          : status.running
            ? { ok: false, message: `Verification failed: "${status.applicationId}" is still running.` }
            : {
                ok: false,
                message: `Verification unavailable: the platform cannot confirm running state for "${status.applicationId}".`,
              },
      )
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Unknown verification failure.'
        return { ok: false, message: `Verification failed: ${message}` }
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