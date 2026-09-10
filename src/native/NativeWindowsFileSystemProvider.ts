import type {
  FileSystemCapabilities,
  FileSystemNode,
  FileSystemProvider,
  FsListOptions,
  FsOp,
  FsSearchOptions,
  FsTextStats,
  FsWriteOptions,
  NativePlatformStatus,
} from '../filesystem'
import { NativeAgentRpc } from './nativeRpc'
import type { NativeBridgeOptions } from './nativeRpc'

/**
 * Native Windows bridge provider (Phase 1.2). Delegates ALL transport and
 * connectivity state to the shared `NativeAgentRpc`.
 *
 * Implements the SAME `FileSystemProvider` contract the browser provider and
 * tools speak, but over the local native agent's typed JSON-RPC/HTTP protocol
 * (`native/src/agent.ts`). This is a REAL capability: when the agent is
 * reachable, every operation hits the REAL Windows filesystem via
 * `RealFsBackend` — nothing is simulated, and when the agent is unreachable the
 * provider says so honestly with a structured `native_unavailable` failure.
 *
 * Connectivity is re-checked per call (each request is an independent probe),
 * every request is time-bounded, and malformed/unexpected responses never leak
 * — they degrade to `unavailable`/`io` FileSystemError kinds.
 */
export type { NativeBridgeOptions }

function asNode(node: { name: string; path: string; kind: 'file' | 'directory'; size?: number; modifiedAt?: number }): FileSystemNode {
  return { name: node.name, path: node.path, kind: node.kind, size: node.size, modifiedAt: node.modifiedAt }
}

export class NativeWindowsFileSystemProvider implements FileSystemProvider {
  readonly id = 'native-windows'
  private readonly rpc: NativeAgentRpc

  constructor(options: NativeBridgeOptions = {}, rpc?: NativeAgentRpc) {
    this.rpc = rpc ?? new NativeAgentRpc(options)
    // Kick off a bounded connectivity probe; nativeStatus() reflects its result.
    void this.rpc.probe()
  }

  capabilities(): FileSystemCapabilities {
    const connected = this.rpc.knownStatus.connected
    const ops = Object.fromEntries(
      (['status', 'list', 'search', 'stat', 'read', 'mkdir', 'write', 'copy', 'move', 'rename', 'delete'] as const).map(
        (op) => [op, connected],
      ),
    ) as Record<FsOp, boolean>
    const known = this.rpc.knownStatus
    return {
      available: connected,
      reason: connected ? undefined : (known.reason ?? 'The native Windows agent is not available.'),
      // For the native bridge, "hasApi" encodes a currently reachable
      // capability surface: when the agent is down we never claim reachability.
      hasApi: connected,
      rootGranted: connected && (known.roots?.length ?? 0) > 0,
      ops,
    }
  }

  nativeStatus(): NativePlatformStatus | undefined {
    return this.rpc.knownStatus
  }

  async refreshNativeStatus(): Promise<NativePlatformStatus | undefined> {
    return this.rpc.probe()
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.rpc.call<T>(method, params)
  }

  /* ------------------------------------------------ FileSystemProvider ops */

  async list(path: string, options: FsListOptions = {}): Promise<FileSystemNode[]> {
    const params: Record<string, unknown> = { path, depth: options.depth ?? (options.recursive ? 1 : 0), limit: options.limit }
    const nodes = await this.call<Array<{ name: string; path: string; kind: 'file' | 'directory'; size?: number; modifiedAt?: number }>>('filesystem.list', params)
    return nodes.map(asNode)
  }

  async search(query: string, options: FsSearchOptions = {}): Promise<FileSystemNode[]> {
    const params: Record<string, unknown> = {
      query,
      extension: options.extension,
      startPath: options.startPath,
      maxDepth: options.maxDepth,
      limit: options.limit,
    }
    const nodes = await this.call<Array<{ name: string; path: string; kind: 'file' | 'directory'; size?: number; modifiedAt?: number }>>('filesystem.search', params)
    return nodes.map(asNode)
  }

  async stat(path: string): Promise<FileSystemNode> {
    return asNode(await this.call('filesystem.stat', { path }))
  }

  async readText(path: string, options: { maxBytes?: number } = {}): Promise<FsTextStats> {
    return this.call<FsTextStats>('filesystem.read', { path, maxBytes: options.maxBytes })
  }

  async writeText(path: string, content: string, options: FsWriteOptions = {}): Promise<{ bytes: number }> {
    return this.call<{ bytes: number }>('filesystem.write', { path, content, overwrite: options.overwrite === true, maxChars: undefined })
  }

  async mkdir(path: string): Promise<FileSystemNode> {
    return asNode(await this.call('filesystem.mkdir', { path }))
  }

  async copy(source: string, destination: string, options: FsWriteOptions = {}): Promise<void> {
    await this.call('filesystem.copy', { source, destination, overwrite: options.overwrite === true })
  }

  async move(source: string, destination: string, options: FsWriteOptions = {}): Promise<void> {
    await this.call('filesystem.move', { source, destination, overwrite: options.overwrite === true })
  }

  async rename(path: string, newName: string): Promise<void> {
    await this.call('filesystem.rename', { path, newName })
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.call('filesystem.delete', { path, recursive: options.recursive === true })
  }
}

export function isNativeWindowsProvider(provider: FileSystemProvider): provider is NativeWindowsFileSystemProvider {
  return provider instanceof NativeWindowsFileSystemProvider
}