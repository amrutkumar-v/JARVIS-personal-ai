import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceRegistry } from '../../server/src/registry.js'
import { EventBus } from '../../server/src/events.js'
import { FileStore } from '../../server/src/files.js'
import { buildHealth } from '../../server/src/health.js'
import { startHttpServer, type RuntimeContext } from '../../server/src/http.js'
import { BACKEND_NAME, BACKEND_PROTOCOL, BACKEND_VERSION } from '../../server/src/version.js'

const BACKEND_TEST_TOKEN = 'native-bridge-backend-test-token'

/**
 * Run bridge integration tests through the real backend RPC broker. The
 * browser-side client receives only a backend URL and fetch adapter; this
 * fixture keeps both test credentials on the server-side path.
 */
export async function startNativeBroker(nativeUrl: string, nativeToken: string) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jarvis-native-broker-'))
  const now = () => Date.now()
  const startedAt = now()
  const registry = new DeviceRegistry({ now })
  const bus = new EventBus()
  const files = new FileStore({ dir: join(dataDir, 'files'), now })
  const assistant: Record<string, unknown> = {}
  const wake = { browserOnly: true as const }
  const nativeStatus = () => ({
    supervising: true,
    connected: true,
    reachable: true,
    childRunning: true,
    restarts: 0,
  })
  const context: RuntimeContext = {
    name: BACKEND_NAME,
    version: BACKEND_VERSION,
    protocol: BACKEND_PROTOCOL,
    pid: process.pid,
    startedAt,
    dataDir,
    registry,
    bus,
    files,
    nativeStatus,
    assistant,
    wake,
    now,
    health: () => buildHealth({
      name: BACKEND_NAME,
      version: BACKEND_VERSION,
      protocol: BACKEND_PROTOCOL,
      pid: process.pid,
      startedAt,
      now: now(),
      native: nativeStatus(),
      registry,
      assistant,
      wake,
      filesCount: files.count(),
      dataDir,
    }),
  }
  const http = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    context,
    token: BACKEND_TEST_TOKEN,
    nativeAgent: { baseUrl: nativeUrl, token: nativeToken },
  })

  const fetchImpl: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('authorization', `Bearer ${BACKEND_TEST_TOKEN}`)
    return fetch(input, { ...init, headers })
  }

  return {
    baseUrl: http.url,
    fetchImpl,
    async close() {
      await http.close()
      bus.close()
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}
