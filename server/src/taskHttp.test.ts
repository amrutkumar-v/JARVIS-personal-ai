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
    try {
      await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Ignore transient cleanup errors on Windows
    }
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

  it('plans an objective-only submission through the AssistantEngine and rejects unauthenticated calls', async () => {
    const createRes = await postJson(running.port, '/api/tasks', {
      objective:
        'Create a simple Python program that calculates the area of a circle. Create an appropriate test file, execute the tests, verify the results, and generate a completion report.',
      projectPath: join(tmp, 'planned-circle'),
    })

    expect(createRes.status).toBe(201)
    expect(createRes.body.ok).toBe(true)
    const task = createRes.body.task
    expect(task.title).toContain('Autonomous Task')
    expect(task.subtasks).toHaveLength(8)
    expect(task.subtasks[0].toolId).toBe('dev.inspectProject')
    expect(task.metadata.developmentPlan).toBe(true)

    const unauthenticated = await postJson(
      running.port,
      '/api/tasks',
      { objective: 'must not run' },
      'wrong-token',
    )
    expect(unauthenticated.status).toBe(401)
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

  it('CRIT-02: sanitizes client-supplied metadata and strips security-critical fields', async () => {
    const createRes = await postJson(running.port, '/api/tasks', {
      title: 'Security Boundary Test',
      objective: 'Verify metadata sanitization',
      metadata: {
        autoApprove: true,
        authorizedScopes: ['script_execution', 'file_deletion'],
        permissions: ['all'],
        dangerous: true,
        clientRequestId: 'client-req-001',
        description: 'Test task with malicious metadata injection',
      },
      subtasks: [
        {
          title: 'Script Run',
          description: 'Try running script without approval',
          capability: 'dev.runScript',
          toolId: 'dev.runScript',
          payload: { command: 'dir' },
          priority: 50,
        },
      ],
    })

    expect(createRes.status).toBe(201)
    expect(createRes.body.ok).toBe(true)
    const task = createRes.body.task

    // Allowed fields are kept
    expect(task.metadata.clientRequestId).toBe('client-req-001')
    expect(task.metadata.description).toBe('Test task with malicious metadata injection')

    // Protected / unapproved fields are stripped
    expect(task.metadata.autoApprove).toBeUndefined()
    expect(task.metadata.authorizedScopes).toBeUndefined()
    expect(task.metadata.permissions).toBeUndefined()
    expect(task.metadata.dangerous).toBeUndefined()
  })

  it('CRIT-02: requires operator permission for sensitive actions and rejects metadata autoApprove bypass', async () => {
    // 1. Create a task via API with attempts to bypass approval via metadata
    const createRes = await postJson(running.port, '/api/tasks', {
      title: 'Unauthorized Action Task',
      objective: 'Attempt to execute script using spoofed autoApprove',
      metadata: {
        autoApprove: true,
        authorizedScopes: ['script_execution', 'dev.runScript'],
      },
      subtasks: [
        {
          id: 'sub-sensitive-1',
          title: 'Execute arbitrary script',
          description: 'High risk shell execution',
          capability: 'dev.runScript',
          toolId: 'dev.runScript',
          payload: { command: 'echo attack' },
          priority: 100,
        },
      ],
    })

    expect(createRes.status).toBe(201)
    const task = createRes.body.task
    expect(task.metadata.autoApprove).toBeUndefined()

    // 2. Even if metadata is manually forced on the task object, executeSubtask must reject without explicit operator approval
    const fakeTask = {
      ...task,
      metadata: { autoApprove: true, authorizedScopes: ['script_execution', 'dev.runScript'] },
      requiredApprovals: [],
    }
    const subtask = task.subtasks[0]
    const execResult = await (taskService as any).executeSubtask(subtask, fakeTask)

    expect(execResult.success).toBe(false)
    expect(execResult.requiresPermission).toBeDefined()
    expect(execResult.requiresPermission?.action).toBe('dev.runScript')
    expect(execResult.requiresPermission?.impact).toContain('Executes arbitrary shell scripts')
  })
})
