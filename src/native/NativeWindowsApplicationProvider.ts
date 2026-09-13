import type {
  AppCloseResult,
  AppLaunchResult,
  AppOp,
  AppRefreshResult,
  AppSource,
  AppSpec,
  AppStatus,
  ApplicationCapabilities,
  ApplicationProvider,
} from '../applications'
import type { NativeAgentRpc } from './nativeRpc'
import type {
  NativeAppLaunchResult,
  NativeAppRefreshResult,
  NativeAppSpec,
  NativeAppStatusResult,
} from '../../native/src/protocol'

/** Maps the native agent's wire entries onto the web Capabilities surface. */
function mapSource(source: NativeAppSpec['source']): AppSource {
  return source
}

/**
 * Native Windows application bridge provider (Phase 1.3).
 *
 * Speaks the SHARED `NativeAgentRpc` (same transport + connectivity probe as
 * the filesystem bridge). All launch/status/list decisions stay on the native
 * side (AppRegistry: configured + top-level Start Menu discovery, plain-exe
 * gate, anti-shell-host denylist, bounded verification) — the browser never
 * sees target paths and never constructs a launch. When the agent is
 * unreachable the provider reports `available:false` honestly.
 *
 * The id validation here is the SAME charset as the native agent's
 * `APP_ID_PATTERN`; a local mismatch is impossible by construction, so an
 * invalid id surfaces as a structured `invalid_path` error before any wire
 * call — the failed call never reaches the agent.
 */
export class NativeWindowsApplicationProvider implements ApplicationProvider {
  readonly id = 'native-windows-apps'
  private readonly rpc: NativeAgentRpc

  constructor(rpc: NativeAgentRpc) {
    this.rpc = rpc
  }

  capabilities(): ApplicationCapabilities {
    const connected = this.rpc.knownStatus.connected
    const ops = Object.fromEntries((['list', 'status', 'launch', 'refresh'] as const).map((op) => [op, connected])) as Record<AppOp, boolean>
    const known = this.rpc.knownStatus
    return {
      available: connected,
      reason: connected ? undefined : (known.reason ?? 'The native Windows agent is not available.'),
      ops,
    }
  }

  refreshNativeStatus(): Promise<void> {
    return this.rpc.probe().then(() => undefined)
  }

  async list(): Promise<AppSpec[]> {
    const { applications } = await this.rpc.call<{ applications: NativeAppSpec[] }>('app.list', {})
    return applications.map((e) => ({
      applicationId: e.applicationId,
      name: e.name,
      displayName: e.displayName,
      source: mapSource(e.source),
      enabled: e.enabled,
      launchable: e.launchable,
      launchMechanism: e.launchMechanism,
      aliases: e.aliases,
      processImage: e.processImage,
    }))
  }

  async refresh(): Promise<AppRefreshResult> {
    const res = await this.rpc.call<NativeAppRefreshResult>('app.refresh', {})
    return {
      total: res.total,
      discovered: res.discovered,
      configured: res.configured,
      refreshedAt: res.refreshedAt,
    }
  }

  async status(applicationId: string): Promise<AppStatus> {
    const entry = await this.rpc.call<NativeAppStatusResult>('app.status', { applicationId })
    return {
      applicationId: entry.applicationId,
      name: entry.name,
      displayName: entry.displayName,
      source: mapSource(entry.source),
      enabled: entry.enabled,
      launchable: entry.launchable,
      launchMechanism: entry.launchMechanism,
      aliases: entry.aliases,
      processImage: entry.processImage,
      running: entry.running,
      runningVerified: entry.runningVerified,
    }
  }

  async launch(applicationId: string, options?: { folder?: string }): Promise<AppLaunchResult> {
    const entry = await this.rpc.call<NativeAppLaunchResult>('app.launch', {
      applicationId,
      ...(options?.folder !== undefined ? { folder: options.folder } : {}),
    })
    return {
      applicationId: entry.applicationId,
      started: entry.started,
      pid: entry.pid,
      verified: entry.verified,
      detail: entry.detail,
    }
  }

  async close(applicationId: string): Promise<AppCloseResult> {
    const entry = await this.rpc.call<{
      applicationId: string
      terminated: boolean
      verified: boolean
      detail: string
    }>('app.close', { applicationId })
    return {
      applicationId: entry.applicationId,
      terminated: entry.terminated,
      verified: entry.verified,
      detail: entry.detail,
    }
  }
}

export function isNativeApplicationProvider(provider: ApplicationProvider): provider is NativeWindowsApplicationProvider {
  return provider instanceof NativeWindowsApplicationProvider
}