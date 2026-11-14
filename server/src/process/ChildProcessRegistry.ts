/**
 * Child Process Tree Registry & Process Lifecycle Manager.
 *
 * Tracks all background subprocesses spawned by tasks (DevEngine, test runners,
 * compilers, tools) and provides guaranteed process-tree termination on Windows
 * (taskkill /F /T /PID) and Unix (process group SIGKILL).
 *
 * Prevents orphaned background processes when tasks are cancelled or time out.
 */

import { ChildProcess, spawn } from 'node:child_process'

export interface RegisteredProcess {
  taskId: string
  pid: number
  description: string
  startedAt: number
  child: ChildProcess
}

export class ChildProcessRegistry {
  private processes = new Map<string, Set<RegisteredProcess>>()

  /**
   * Associate an active child process with a background taskId.
   */
  register(taskId: string, child: ChildProcess, description = 'subprocess'): void {
    if (!child || !child.pid) return

    let set = this.processes.get(taskId)
    if (!set) {
      set = new Set()
      this.processes.set(taskId, set)
    }

    const entry: RegisteredProcess = {
      taskId,
      pid: child.pid,
      description,
      startedAt: Date.now(),
      child,
    }

    set.add(entry)

    // Automatically remove when process terminates naturally
    const cleanup = () => {
      set?.delete(entry)
      if (set && set.size === 0) {
        this.processes.delete(taskId)
      }
    }

    child.once('exit', cleanup)
    child.once('close', cleanup)
    child.once('error', cleanup)
  }

  /**
   * Unregister a child process if manually completed.
   */
  unregister(taskId: string, child: ChildProcess): void {
    const set = this.processes.get(taskId)
    if (!set) return

    for (const entry of Array.from(set)) {
      if (entry.child === child || entry.pid === child.pid) {
        set.delete(entry)
      }
    }

    if (set.size === 0) {
      this.processes.delete(taskId)
    }
  }

  /**
   * Terminate all child processes and grandchild trees associated with a taskId.
   * On Windows, uses taskkill /F /T /PID <pid> to guarantee no orphaned leaf processes.
   */
  async killProcessTree(taskId: string): Promise<number> {
    const set = this.processes.get(taskId)
    if (!set || set.size === 0) return 0

    const entries = Array.from(set)
    this.processes.delete(taskId)

    await Promise.all(
      entries.map(async (entry) => {
        await this.killChildTree(entry.child)
      })
    )

    return entries.length
  }

  /**
   * Terminate a single child process and its entire process tree.
   */
  async killChildTree(child: ChildProcess): Promise<void> {
    if (!child || !child.pid || child.killed) return

    const pid = child.pid

    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.once('close', () => resolve())
        killer.once('error', () => {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
          resolve()
        })
      })
    } else {
      try {
        // Attempt process group termination on Unix if detached
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Get all currently tracked active processes.
   */
  getActiveProcesses(taskId?: string): RegisteredProcess[] {
    if (taskId) {
      const set = this.processes.get(taskId)
      return set ? Array.from(set) : []
    }

    const all: RegisteredProcess[] = []
    for (const set of this.processes.values()) {
      all.push(...Array.from(set))
    }
    return all
  }
}

export const childProcessRegistry = new ChildProcessRegistry()

