import { describe, expect, it } from 'vitest'
import { ResourceMonitor } from './resourceMonitor.js'

describe('ResourceMonitor', () => {
  it('computes realistic system resource snapshot on current platform', () => {
    const monitor = new ResourceMonitor()
    const snapshot = monitor.getSnapshot()

    expect(snapshot.totalMemoryBytes).toBeGreaterThan(0)
    expect(snapshot.freeMemoryBytes).toBeGreaterThan(0)
    expect(snapshot.memoryUsageRatio).toBeGreaterThan(0)
    expect(snapshot.memoryUsageRatio).toBeLessThanOrEqual(1)
    expect(snapshot.cpuCount).toBeGreaterThanOrEqual(1)
    expect(snapshot.processHeapUsedBytes).toBeGreaterThan(0)
    expect(snapshot.processRssBytes).toBeGreaterThan(0)

    // Load ratio should be a valid percentage between 0 and 1
    expect(snapshot.loadAverageRatio).toBeGreaterThanOrEqual(0)
    expect(snapshot.loadAverageRatio).toBeLessThanOrEqual(1)
  })

  it('permits task execution under nominal conditions', () => {
    const monitor = new ResourceMonitor()
    const check = monitor.canExecuteTask()
    expect(typeof check.allowed).toBe('boolean')
  })

  it('triggers constraint when memory threshold exceeds available RAM', () => {
    // Artificial constraint: require 1 PB of free RAM
    const constrained = new ResourceMonitor({
      minFreeMemoryBytes: 1024 * 1024 * 1024 * 1024 * 1024,
    })
    const check = constrained.canExecuteTask()
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain('Available memory too low')
  })

  it('triggers constraint when process heap limit is exceeded', () => {
    // Artificial constraint: max 1 byte of process heap
    const constrained = new ResourceMonitor({
      maxProcessHeapBytes: 1,
    })
    const check = constrained.canExecuteTask()
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain('Process heap usage too high')
  })

  it('evaluates controllable CPU telemetry across below-threshold, at-threshold and above-threshold conditions', () => {
    // 1. Below threshold (10% CPU load against default 85% limit) -> allowed
    const nominal = new ResourceMonitor(undefined, { getCpuLoadRatio: () => 0.10 })
    expect(nominal.canExecuteTask().allowed).toBe(true)

    // 2. Above threshold (95% CPU load against default 85% limit) -> throttled
    const saturated = new ResourceMonitor(undefined, { getCpuLoadRatio: () => 0.95 })
    const saturatedCheck = saturated.canExecuteTask()
    expect(saturatedCheck.allowed).toBe(false)
    expect(saturatedCheck.reason).toContain('CPU load too high (95% load ratio)')

    // 3. At boundary / threshold (85.1% CPU load against default 85% limit) -> throttled
    const atBoundary = new ResourceMonitor({ maxLoadAverageRatio: 0.85 }, { getCpuLoadRatio: () => 0.851 })
    expect(atBoundary.canExecuteTask().allowed).toBe(false)
  })
})
