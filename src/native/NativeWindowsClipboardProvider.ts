import type {
  ClipboardCapabilities,
  ClipboardProvider,
  ClipboardReadResult,
  ClipboardWriteResult,
} from '../clipboard/provider'
import { NativeAgentRpc } from './nativeRpc'
import type { NativeBridgeOptions } from './nativeRpc'

/**
 * Native Windows bridge provider for clipboard access (Phase 4.0).
 *
 * Delegates all transport and connectivity state to the shared `NativeAgentRpc`.
 * When the native agent is reachable, every operation hits the REAL Windows
 * clipboard via the native agent's clipboard backend — nothing is simulated.
 * When the agent is unreachable the provider says so honestly.
 */
export class NativeWindowsClipboardProvider implements ClipboardProvider {
  readonly id = 'native-windows-clipboard'
  private readonly rpc: NativeAgentRpc

  constructor(options: NativeBridgeOptions = {}, rpc?: NativeAgentRpc) {
    this.rpc = rpc ?? new NativeAgentRpc(options)
    void this.rpc.probe()
  }

  capabilities(): ClipboardCapabilities {
    const connected = this.rpc.knownStatus.connected
    const ops = Object.fromEntries((['read', 'write'] as const).map((op) => [op, connected])) as Record<string, boolean>
    return {
      available: connected,
      reason: connected ? undefined : (this.rpc.knownStatus.reason ?? 'The native Windows agent is not available.'),
      ops: ops as Record<'read' | 'write', boolean>,
    }
  }

  async read(): Promise<ClipboardReadResult> {
    const result = await this.rpc.call<{
      success: boolean
      text: string
      byteLength: number
      verified: boolean
    }>('clipboard.read', {})
    return {
      success: result.success,
      text: result.text,
      byteLength: result.byteLength,
      verified: result.verified,
    }
  }

  async write(text: string): Promise<ClipboardWriteResult> {
    const result = await this.rpc.call<{
      success: boolean
      byteLength: number
      verified: boolean
    }>('clipboard.write', { text })
    return {
      success: result.success,
      byteLength: result.byteLength,
      verified: result.verified,
    }
  }
}
