/**
 * System Resource Monitor (Phase C Background Execution).
 *
 * Monitors system resources (free RAM, CPU load) to prevent background tasks
 * from overloading the machine or draining excessive resources while idle.
 */

import os from 'node:os'

export interface ResourceLimits {
  /** Minimum free memory in bytes before throttling/pausing tasks (default: 250 MB). */
  minFreeMemoryBytes: number
  /** Maximum 1-minute load average before throttling (default: 80% of core count). */
  maxLoadAverageRatio: number
}

export interface SystemResourceSnapshot {
  totalMemoryBytes: number
  freeMemoryBytes: number
  memoryUsageRatio: number
  cpuCount: number
  loadAverage1m: number
  loadAverageRatio: number
  isResourceConstrained: boolean
  constraintReason?: string
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  minFreeMemoryBytes: 250 * 1024 * 1024, // 250 MB
  maxLoadAverageRatio: 0.85, // 85% of cores
}

export class ResourceMonitor {
  private readonly limits: ResourceLimits

  constructor(limits?: Partial<ResourceLimits>) {
    this.limits = { ...DEFAULT_RESOURCE_LIMITS, ...limits }
  }

  getSnapshot(): SystemResourceSnapshot {
    const totalMemoryBytes = os.totalmem()
    const freeMemoryBytes = os.freemem()
    const memoryUsageRatio = (totalMemoryBytes - freeMemoryBytes) / totalMemoryBytes

    const cpuCount = os.cpus().length || 1
    const loadAvg = os.loadavg()
    const loadAverage1m = loadAvg && loadAvg.length > 0 ? loadAvg[0] : 0
    const loadAverageRatio = loadAverage1m / cpuCount

    let isResourceConstrained = false
    let constraintReason: string | undefined

    if (freeMemoryBytes < this.limits.minFreeMemoryBytes) {
      isResourceConstrained = true
      constraintReason = `Available memory too low (${Math.round(freeMemoryBytes / (1024 * 1024))} MB free, minimum ${Math.round(this.limits.minFreeMemoryBytes / (1024 * 1024))} MB required)`
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

