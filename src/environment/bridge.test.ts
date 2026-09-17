import { describe, expect, it } from 'vitest'
import {
  buildEnvironmentSnapshot,
  collectHardwareFrom,
  controlSections,
  coreMetrics,
  deviceMetrics,
  formatDuration,
  hudTelemetry,
  isStale,
  systemMetrics,
  taskMetrics,
  timeAgo,
} from './bridge'
import type { BridgeInput, NavigatorLike } from './bridge'
import type { Capabilities } from '../types/capabilities'
import type { BackendUiState, CameraUiState } from '../state/jarvis.store'
import { EMPTY_GOAL_RUN, type GoalRunSnapshot } from '../state/goalRun'

const NOW = 1_000_000_000_000

function caps(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    aiConnected: false,
    aiConfigured: false,
    speechRecognitionAvailable: false,
    speechSynthesisAvailable: false,
    wakeWordAvailable: false,
    voiceInteractionAvailable: false,
    microphoneAvailable: false,
    memoryEnabled: false,
    toolsEnabled: false,
    callingEnabled: false,
    fileSystemAvailable: false,
    nativeAgentAvailable: false,
    nativeApplicationAvailable: false,
    nativeObservationAvailable: false,
    nativeDesktopInteractionAvailable: false,
    visionAvailable: false,
    ocrAvailable: false,
    uiElementDetectionAvailable: false,
    targetLocalizationAvailable: false,
    cameraAvailable: false,
    deviceBridgeAvailable: false,
    webAccessAvailable: false,
    ...overrides,
  }
}

function camera(overrides: Partial<CameraUiState> = {}): CameraUiState {
  return { available: false, active: false, permission: 'unknown', ...overrides }
}

function backend(overrides: Partial<BackendUiState> = {}): BackendUiState {
  return {
    phase: 'idle',
    health: null,
    devices: [],
    lastInboundAt: null,
    lastWake: null,
    ...overrides,
  }
}

function goalRun(overrides: Partial<GoalRunSnapshot> = {}): GoalRunSnapshot {
  return { ...EMPTY_GOAL_RUN, ...overrides }
}

function input(overrides: Partial<BridgeInput> = {}): BridgeInput {
  return {
    environmentId: 'control',
    status: 'idle',
    isSpeaking: false,
    goalRun: null,
    backend: backend(),
    camera: camera(),
    capabilities: caps(),
    task: { active: false, label: '', step: 0, total: 0, status: 'COMPLETED' },
    voiceState: 'SLEEPING',
    voiceArmed: false,
    providerId: 'mock',
    activities: [],
    ...overrides,
  }
}

describe('formatDuration', () => {
  it('formats short durations', () => {
    expect(formatDuration(0)).toBe('<1s')
    expect(formatDuration(500)).toBe('<1s')
    expect(formatDuration(2_500)).toBe('2s')
    expect(formatDuration(61_000)).toBe('1m 01s')
  })

  it('formats hours/minutes', () => {
    expect(formatDuration(3_723_000)).toBe('1h 02m')
    expect(formatDuration(45 * 60_000 + 59_000)).toBe('45m 59s')
  })

  it('returns an em dash for invalid input', () => {
    expect(formatDuration(NaN)).toBe('\u2014')
    expect(formatDuration(-1)).toBe('\u2014')
  })
})

describe('timeAgo', () => {
  it('renders relative labels from a fixed clock', () => {
    expect(timeAgo(NOW - 3_000, NOW)).toBe('just now')
    expect(timeAgo(NOW - 30_000, NOW)).toBe('30s ago')
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe('5m ago')
    expect(timeAgo(NOW - 3 * 3_600_000, NOW)).toBe('3h ago')
    expect(timeAgo(NOW - 2 * 86_400_000, NOW)).toBe('2d ago')
  })

  it('returns an em dash when unknown', () => {
    expect(timeAgo(null, NOW)).toBe('\u2014')
  })
})

describe('isStale', () => {
  it('flags null and old heartbeats as stale', () => {
    expect(isStale(null, NOW)).toBe(true)
    expect(isStale(NOW - 60_000, NOW)).toBe(true)
    expect(isStale(NOW - 10_000, NOW)).toBe(false)
  })

  it('honours a custom threshold', () => {
    expect(isStale(NOW - 30_000, NOW, 60_000)).toBe(false)
    expect(isStale(NOW - 30_000, NOW, 20_000)).toBe(true)
  })
})

describe('collectHardwareFrom', () => {
  const nav: NavigatorLike = {
    platform: 'Win32',
    userAgent: 'ua',
    userAgentData: { platform: 'Windows' },
    hardwareConcurrency: 8,
    deviceMemory: 8,
    onLine: true,
  }

  it('prefers the modern userAgentData platform', () => {
    expect(collectHardwareFrom(nav).platform).toBe('Windows')
  })

  it('falls back to navigator.platform', () => {
    expect(collectHardwareFrom({ platform: 'Win32', onLine: true }).platform).toBe('Win32')
  })

  it('marks unknown fields null/unknown', () => {
    const h = collectHardwareFrom(null)
    expect(h.platform).toBe('unknown')
    expect(h.cores).toBeNull()
    expect(h.deviceMemoryGiB).toBeNull()
    expect(h.online).toBeNull()
  })
})

describe('buildEnvironmentSnapshot', () => {
  it('maps real status to visual state and label', () => {
    const s = buildEnvironmentSnapshot(input({ status: 'planning' }), NOW)
    expect(s.visualState).toBe('planning')
    expect(s.statusLabel).toBe('PLANNING')
  })

  it('honours speaking from either real signal', () => {
    expect(buildEnvironmentSnapshot(input({ isSpeaking: true }), NOW).speaking).toBe(true)
    expect(buildEnvironmentSnapshot(input({ status: 'speaking' }), NOW).speaking).toBe(true)
    expect(buildEnvironmentSnapshot(input(), NOW).speaking).toBe(false)
  })

  it('mirrors provider, environment and voice honestly', () => {
    const s = buildEnvironmentSnapshot(
      input({ environmentId: 'tunnel', voiceState: 'ARM', voiceArmed: true, providerId: 'remote' }),
      NOW,
    )
    expect(s.environmentId).toBe('tunnel')
    expect(s.voiceState).toBe('ARM')
    expect(s.voiceArmed).toBe(true)
    expect(s.providerId).toBe('remote')
  })

  it('counts live devices from the real registry', () => {
    const s = buildEnvironmentSnapshot(
      input({
        backend: backend({
          phase: 'connected',
          devices: [
            { id: 'a', online: true } as never,
            { id: 'b', online: false } as never,
            { id: 'c', online: true } as never,
          ],
        }),
      }),
      NOW,
    )
    expect(s.devicesTotal).toBe(3)
    expect(s.devicesOnline).toBe(2)
  })

  it('records the most recent real activity', () => {
    const s = buildEnvironmentSnapshot(
      input({
        activities: [
          { step: 'run', detail: 'verified', status: 'success' },
          { step: 'old', detail: 'old', status: 'success' },
        ],
      }),
      NOW,
    )
    expect(s.lastActivity?.detail).toBe('verified')
  })

  it('exposes an em-dash duration for a booting backend', () => {
    expect(formatDuration(undefined as never)).toBe('\u2014')
  })
})

describe('systemMetrics', () => {
  it('marks CPU load unavailable (never fabricated)', () => {
    const s = buildEnvironmentSnapshot(input(), NOW)
    const row = systemMetrics(s).find((r) => r.label === 'CPU load')!
    expect(row.available).toBe(false)
    expect(row.value).toBe('Unavailable')
  })

  it('shows real device memory when exposed', () => {
    const s = buildEnvironmentSnapshot(
      input({ hardware: { deviceMemoryGiB: 8 } }),
      NOW,
    )
    const row = systemMetrics(s).find((r) => r.label === 'Memory')!
    expect(row.available).toBe(true)
    expect(row.value).toBe('8 GiB')
  })

  it('shows uptime only when a real health payload exists', () => {
    const s = buildEnvironmentSnapshot(
      input({ backend: backend({ phase: 'connected', health: { uptimeMs: 7_200_000 } as never }) }),
      NOW,
    )
    const row = systemMetrics(s).find((r) => r.label === 'Uptime')!
    expect(row.available).toBe(true)
    expect(row.value).toBe('2h 00m')
  })

  it('reports network offline as an error tone', () => {
    const s = buildEnvironmentSnapshot(input({ hardware: { online: false } }), NOW)
    const row = systemMetrics(s).find((r) => r.label === 'Network')!
    expect(row.tone).toBe('err')
  })
})

describe('coreMetrics', () => {
  it('reflects backend phase tone honestly', () => {
    const connected = buildEnvironmentSnapshot(
      input({ backend: backend({ phase: 'connected' }) }),
      NOW,
    )
    expect(coreMetrics(connected).find((r) => r.label === 'Backend')!.tone).toBe('ok')
    const gaveUp = buildEnvironmentSnapshot(
      input({ backend: backend({ phase: 'giving_up' }) }),
      NOW,
    )
    expect(coreMetrics(gaveUp).find((r) => r.label === 'Backend')!.tone).toBe('err')
  })

  it('flags failed execution status', () => {
    const s = buildEnvironmentSnapshot(input({ status: 'error' }), NOW)
    expect(coreMetrics(s).find((r) => r.label === 'Execution')!.tone).toBe('err')
  })
})

describe('deviceMetrics', () => {
  it('shows a stale heartbeat flag on live-but-stale devices', () => {
    const s = buildEnvironmentSnapshot(
      input({
        backend: backend({
          phase: 'connected',
          devices: [{ id: 'a', online: true, lastHeartbeatAt: NOW - 120_000 } as never],
        }),
      }),
      NOW,
    )
    const row = deviceMetrics(s).find((r) => r.label === 'Connected devices')!
    expect(row.stale).toBe(true)
    expect(row.value).toBe('1/1 online')
  })

  it('reports the real camera surface', () => {
    const s = buildEnvironmentSnapshot(
      input({ camera: camera({ active: true, available: true, permission: 'granted' }) }),
      NOW,
    )
    expect(deviceMetrics(s).find((r) => r.label === 'Camera')!.value).toBe('active')
    expect(deviceMetrics(s).find((r) => r.label === 'Camera permission')!.tone).toBe('ok')
  })
})

describe('taskMetrics', () => {
  it('reflects a real active task', () => {
    const s = buildEnvironmentSnapshot(
      input({ task: { active: true, label: 'build', step: 2, total: 4, status: 'RUNNING' } }),
      NOW,
    )
    const row = taskMetrics(s).find((r) => r.label === 'Active task')!
    expect(row.value).toBe('2/4 RUNNING')
  })

  it('shows the real goal budget', () => {
    const s = buildEnvironmentSnapshot(
      input({ goalRun: goalRun({ plan: { ...EMPTY_GOAL_RUN.plan, active: true }, budget: { steps: 3, remaining: 7, limit: 10 } }) }),
      NOW,
    )
    const row = taskMetrics(s).find((r) => r.label === 'Goal plan')!
    expect(row.value).toBe('7/10 steps left')
  })
})

describe('hudTelemetry', () => {
  it('reports real capability flags', () => {
    const s = buildEnvironmentSnapshot(
      input({
        capabilities: caps({ microphoneAvailable: true, visionAvailable: true }),
        camera: camera({ active: true }),
      }),
      NOW,
    )
    const map = new Map(hudTelemetry(s).map((r) => [r.label, r]))
    expect(map.get('Mic')!.value).toBe('on')
    expect(map.get('Vision')!.value).toBe('on')
    expect(map.get('Camera')!.value).toBe('on')
  })

  it('marks devices unavailable when the backend is down', () => {
    const s = buildEnvironmentSnapshot(input({ backend: backend({ phase: 'idle' }) }), NOW)
    const row = hudTelemetry(s).find((r) => r.label === 'Devices')!
    expect(row.available).toBe(false)
  })
})

describe('controlSections', () => {
  it('returns the four fixed sections', () => {
    const sections = controlSections(buildEnvironmentSnapshot(input(), NOW))
    expect(sections.map((s) => s.title)).toEqual(['System', 'Core', 'Devices', 'Tasks'])
  })

  it('optionally includes the provider row', () => {
    const base = controlSections(buildEnvironmentSnapshot(input(), NOW))
    const withProvider = controlSections(
      buildEnvironmentSnapshot(input({ providerId: 'remote' }), NOW),
      { includeProvider: true },
    )
    expect(base[1]!.rows.find((r) => r.label === 'Provider')).toBeUndefined()
    expect(withProvider[1]!.rows.find((r) => r.label === 'Provider')!.value).toBe('remote')
  })
})