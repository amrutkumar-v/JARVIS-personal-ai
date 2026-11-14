import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { ChildProcessRegistry } from './ChildProcessRegistry.js'

describe('ChildProcessRegistry', () => {
  it('registers and unregisters child processes', () => {
    const registry = new ChildProcessRegistry()
    const child = spawn(process.platform === 'win32' ? 'cmd.exe' : 'sh', {
      windowsHide: true,
    })

    registry.register('task-123', child, 'test-cmd')
    expect(registry.getActiveProcesses('task-123')).toHaveLength(1)
    expect(registry.getActiveProcesses('task-123')[0].pid).toBe(child.pid)

    registry.unregister('task-123', child)
    expect(registry.getActiveProcesses('task-123')).toHaveLength(0)

    try {
      child.kill()
    } catch {
      // ignore
    }
  })

  it('automatically unregisters child processes on exit', async () => {
    const registry = new ChildProcessRegistry()
    const cmd = process.platform === 'win32' ? 'cmd.exe' : 'sh'
    const args = process.platform === 'win32' ? ['/c', 'exit 0'] : ['-c', 'exit 0']
    const child = spawn(cmd, args, { windowsHide: true })

    registry.register('task-auto', child, 'exit-cmd')
    expect(registry.getActiveProcesses('task-auto')).toHaveLength(1)

    await new Promise((resolve) => child.once('close', resolve))
    expect(registry.getActiveProcesses('task-auto')).toHaveLength(0)
  })

  it('forcefully terminates a process tree for a taskId', async () => {
    const registry = new ChildProcessRegistry()
    // Spawn a long-running process
    const cmd = process.platform === 'win32' ? 'cmd.exe' : 'sh'
    const args = process.platform === 'win32' ? ['/c', 'ping -n 10 127.0.0.1 > nul'] : ['-c', 'sleep 10']
    const child = spawn(cmd, args, { windowsHide: true })

    registry.register('task-to-kill', child, 'long-ping')
    expect(registry.getActiveProcesses('task-to-kill')).toHaveLength(1)

    const killedCount = await registry.killProcessTree('task-to-kill')
    expect(killedCount).toBe(1)
    expect(registry.getActiveProcesses('task-to-kill')).toHaveLength(0)
  })
})

