/**
 * System Resource Monitor (Phase C Background Execution).
 *
 * Monitors system resources (free RAM, CPU load, process heap) to prevent background tasks
 * from overloading the machine or draining excessive resources while idle.
 *
 * Upgraded for Windows: Node's os.loadavg() always returns [0, 0, 0] on Windows.
 * On Win32, CPU utilization is accurately computed by sampling os.cpus() deltas over time.
 */

import os from 'node:os'

export interface ResourceLimits {
  /** Minimum free system memory in bytes before throttling/pausing tasks (default: 250 MB). */
  minFreeMemoryBytes: number
  /** Maximum CPU utilization or load ratio before throttling (default: 0.85 = 85%). */
  maxLoadAverageRatio: number
  /** Maximum process heap in bytes before throttling (default: 1.5 GB). */
  maxProcessHeapBytes?: number
}

export interface SystemResourceSnapshot {
  totalMemoryBytes: number
  freeMemoryBytes: number
  memoryUsageRatio: number
  cpuCount: number
  loadAverage1m: number
  loadAverageRatio: number
  processHeapUsedBytes: number
  processRssBytes: number
  isResourceConstrained: boolean
  constraintReason?: string
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  minFreeMemoryBytes: 250 * 1024 * 1024, // 250 MB
  maxLoadAverageRatio: 0.85, // 85% of cores
  maxProcessHeapBytes: 1536 * 1024 * 1024, // 1.5 GB
}

interface CpuTimesSample {
  idle: number
  total: number
}

export interface CpuTelemetryProvider {
  sampleCpuTimes?: () => CpuTimesSample
  getCpuLoadRatio?: () => number
}

function sampleCpuTimes(): CpuTimesSample {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    const { times } = cpu
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

export class ResourceMonitor {
  private readonly limits: ResourceLimits
  private lastCpuSample: CpuTimesSample
  private lastCpuSampleTime: number
  private cachedCpuRatio: number
  private readonly telemetry?: CpuTelemetryProvider

  constructor(limits?: Partial<ResourceLimits>, telemetry?: CpuTelemetryProvider) {
    const envCpuLimit = process.env.JARVIS_MAX_CPU_LOAD_RATIO
      ? Number(process.env.JARVIS_MAX_CPU_LOAD_RATIO)
      : undefined
    const baseLimits = {
      ...DEFAULT_RESOURCE_LIMITS,
      ...(envCpuLimit && Number.isFinite(envCpuLimit) && envCpuLimit > 0
        ? { maxLoadAverageRatio: envCpuLimit }
        : {}),
      ...limits,
    }
    this.limits = baseLimits
    this.telemetry = telemetry
    this.lastCpuSample = telemetry?.sampleCpuTimes ? telemetry.sampleCpuTimes() : sampleCpuTimes()
    this.lastCpuSampleTime = Date.now()
    this.cachedCpuRatio = telemetry?.getCpuLoadRatio ? telemetry.getCpuLoadRatio() : 0.05 // default nominal baseline until first delta
  }

  getSnapshot(): SystemResourceSnapshot {
    const totalMemoryBytes = os.totalmem()
    const freeMemoryBytes = os.freemem()
    const memoryUsageRatio = (totalMemoryBytes - freeMemoryBytes) / totalMemoryBytes

    const cpuCount = os.cpus().length || 1
    const mem = process.memoryUsage()
    const processHeapUsedBytes = mem.heapUsed
    const processRssBytes = mem.rss

    let loadAverageRatio: number
    let loadAverage1m: number

    if (this.telemetry?.getCpuLoadRatio) {
      this.cachedCpuRatio = Math.max(0, Math.min(1, this.telemetry.getCpuLoadRatio()))
      loadAverageRatio = this.cachedCpuRatio
      loadAverage1m = Math.round(this.cachedCpuRatio * cpuCount * 100) / 100
    } else if (process.platform === 'win32') {
      const now = Date.now()
      const elapsed = now - this.lastCpuSampleTime
      if (elapsed >= 100) {
        const currentSample = this.telemetry?.sampleCpuTimes ? this.telemetry.sampleCpuTimes() : sampleCpuTimes()
        const deltaTotal = currentSample.total - this.lastCpuSample.total
        const deltaIdle = currentSample.idle - this.lastCpuSample.idle
        if (deltaTotal > 0) {
          const busy = Math.max(0, deltaTotal - deltaIdle)
          const instantRatio = Math.max(0, Math.min(1, busy / deltaTotal))
          // Exponential moving average to avoid spurious instantaneous 100ms spikes
          this.cachedCpuRatio = Math.round((this.cachedCpuRatio * 0.6 + instantRatio * 0.4) * 1000) / 1000
        }
        this.lastCpuSample = currentSample
        this.lastCpuSampleTime = now
      }
      loadAverageRatio = this.cachedCpuRatio
      loadAverage1m = Math.round(this.cachedCpuRatio * cpuCount * 100) / 100
    } else {
      const loadAvg = os.loadavg()
      loadAverage1m = loadAvg && loadAvg.length > 0 ? loadAvg[0] : 0
      loadAverageRatio = loadAverage1m / cpuCount
    }

    let isResourceConstrained = false
    let constraintReason: string | undefined

    if (freeMemoryBytes < this.limits.minFreeMemoryBytes) {
      isResourceConstrained = true
      constraintReason = `Available memory too low (${Math.round(freeMemoryBytes / (1024 * 1024))} MB free, minimum ${Math.round(this.limits.minFreeMemoryBytes / (1024 * 1024))} MB required)`
    } else if (this.limits.maxProcessHeapBytes && processHeapUsedBytes > this.limits.maxProcessHeapBytes) {
      isResourceConstrained = true
      constraintReason = `Process heap usage too high (${Math.round(processHeapUsedBytes / (1024 * 1024))} MB used, limit ${Math.round(this.limits.maxProcessHeapBytes / (1024 * 1024))} MB)`
    } else if (loadAverageRatio > this.limits.maxLoadAverageRatio) {
      isResourceConstrained = true
      constraintReason = `CPU load too high (${Math.round(loadAverageRatio * 100)}% load ratio)`
    }

    return {
      totalMemoryBytes,
      freeMemoryBytes,
      memoryUsageRatio,
      cpuCount,
      loadAverage1m,
      loadAverageRatio,
      processHeapUsedBytes,
      processRssBytes,
      isResourceConstrained,
      constraintReason,
    }
  }

  canExecuteTask(): { allowed: boolean; reason?: string } {
    const snapshot = this.getSnapshot()
    if (snapshot.isResourceConstrained) {
      return {
        allowed: false,
        reason: snapshot.constraintReason,
      }
    }
    return { allowed: true }
  }
}
