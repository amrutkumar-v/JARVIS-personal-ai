import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceRegistry } from './registry.js'
import { EventBus } from './events.js'
import { FileStore } from './files.js'
import { buildHealth } from './health.js'
import { startHttpServer, type RuntimeContext, type RunningHttp } from './http.js'
import { TaskService } from './taskService.js'
import { nullLogger } from './log.js'
import { BACKEND_NAME, BACKEND_PROTOCOL, BACKEND_VERSION } from './version.js'

const TEST_TOKEN = 'test-token'

async function postJson(
  port: number,
  path: string,
  body: unknown,
  token = TEST_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, reject) => {
    const payload = JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let acc = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (acc += c))
        res.on('end', () => {
          let parsed: any = null
          try {
            parsed = JSON.parse(acc)
          } catch {
            parsed = acc
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

async function getJson(
  port: number,
  path: string,
  token = TEST_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let acc = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (acc += c))
        res.on('end', () => {
          let parsed: any = null
          try {
            parsed = JSON.parse(acc)
          } catch {
            parsed = acc
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('Backend Task HTTP Endpoints (Phase C)', () => {
  let tmp: string
  let running: RunningHttp
  let taskService: TaskService

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'jarvis-task-http-'))
    const bus = new EventBus()
    const registry = new DeviceRegistry({
      persistFile: join(tmp, 'devices.json'),
      now: () => Date.now(),
    })
    const files = new FileStore({ dir: join(tmp, 'files'), now: () => Date.now() })

    taskService = new TaskService({
      dataDir: tmp,
      bus,
      log: nullLogger(),
      useMemoryStorage: true,
    })
    await taskService.init()

    const ctx: RuntimeContext = {
      name: BACKEND_NAME,
      version: BACKEND_VERSION,
      protocol: BACKEND_PROTOCOL,
      pid: process.pid,
      startedAt: Date.now(),
      dataDir: tmp,
      registry,
      bus,
      files,
      nativeStatus: () => ({
        supervising: false,
        connected: false,
        reachable: false,
        childRunning: false,
        restarts: 0,
      }),
      assistant: {},
      wake: { browserOnly: true },
      now: () => Date.now(),
      tasks: taskService,
      health: () =>
        buildHealth({
          name: BACKEND_NAME,
          version: BACKEND_VERSION,
          protocol: BACKEND_PROTOCOL,
          pid: process.pid,
          startedAt: Date.now(),
          now: Date.now(),
          native: {
            supervising: false,
            connected: false,
            reachable: false,
            childRunning: false,
            restarts: 0,
          },
          registry,
          assistant: {},
          wake: { browserOnly: true },
          filesCount: 0,
          dataDir: tmp,
        }),
    }

    running = await startHttpServer({
      context: ctx,
      host: '127.0.0.1',
      port: 0, // OS-assigned port
      token: TEST_TOKEN,
      trustedOrigins: ['http://localhost:3000'],
      staticDir: tmp,
      publicDir: tmp,
    })
  })

  afterEach(async () => {
    taskService.stop()
    await running.close()
    await rm(tmp, { recursive: true, force: true })
  })

  it('lists tasks, creates tasks, and retrieves task details', async () => {
    // 1. Initially empty
    const listInitial = await getJson(running.port, '/api/tasks')
    expect(listInitial.status).toBe(200)
    expect(listInitial.body.tasks).toHaveLength(0)

    // 2. Create task
    const createRes = await postJson(running.port, '/api/tasks', {
      title: 'Automated Project Build',
      objective: 'Run project tests and verify results',
      priority: 80,
      tags: ['ci', 'test'],
      subtasks: [
        {
          title: 'Run Tests',
          description: 'Run project vitest suite',
          capability: 'dev.runTests',
          toolId: 'dev.runTests',
          payload: { projectPath: process.cwd() },
          priority: 80,
          dependencies: [],
        },
      ],
    })

    expect(createRes.status).toBe(201)
    expect(createRes.body.ok).toBe(true)
    const task = createRes.body.task
    expect(task.id).toMatch(/^task-/)
    expect(task.title).toBe('Automated Project Build')

    // 3. Get task by ID
    const getRes = await getJson(running.port, `/api/tasks/${task.id}`)
    expect(getRes.status).toBe(200)
    expect(getRes.body.task.id).toBe(task.id)
    expect(getRes.body.task.objective).toBe('Run project tests and verify results')
  })

  it('supports pause, resume, and cancel control actions', async () => {
    // Create task
    const createRes = await postJson(running.port, '/api/tasks', {
      title: 'Controllable Task',
      objective: 'Pause and resume test',
      subtasks: [
        {
          title: 'Pending step',
          description: 'Waiting on dependency',
          capability: 'test',
          toolId: 'test',
          payload: {},
          priority: 50,
          dependencies: ['future-dependency'],
        },
      ],
    })
    const taskId = createRes.body.task.id

    // Pause
    const pauseRes = await postJson(running.port, `/api/tasks/${taskId}/pause`, {})
    expect(pauseRes.status).toBe(200)

    // Resume
    const resumeRes = await postJson(running.port, `/api/tasks/${taskId}/resume`, {})
    expect(resumeRes.status).toBe(200)

    // Cancel
    const cancelRes = await postJson(running.port, `/api/tasks/${taskId}/cancel`, {
      reason: 'User stopped execution',
    })
    expect(cancelRes.status).toBe(200)

    const finalGet = await getJson(running.port, `/api/tasks/${taskId}`)
    expect(finalGet.body.task.state).toBe('CANCELLED')
  })
})
