import { useEffect, useMemo, useState } from 'react'
import { useJarvisStore } from '../state/jarvis.store'
import { buildEnvironmentSnapshot } from './bridge'
import type { EnvironmentSnapshot } from './bridge'
import type { VisualEnvironmentId } from './types'

/**
 * Live store mirror → the honest `EnvironmentSnapshot` environments render.
 *
 * Store fields are read through stable selectors. `now` (used for staleness
 * decisions) comes from a 1s ticking clock so the React Compiler never sees
 * an impure call (Date.now) during render, yet stale-state readouts still
 * age honestly without fake telemetry.
 */
export function useEnvironmentSnapshot(
  environmentId: VisualEnvironmentId,
): EnvironmentSnapshot {
  const status = useJarvisStore.use.status()
  const isSpeaking = useJarvisStore.use.isSpeaking()
  const goalRun = useJarvisStore.use.goalRun()
  const backend = useJarvisStore.use.backend()
  const camera = useJarvisStore.use.camera()
  const capabilities = useJarvisStore.use.capabilities()
  const task = useJarvisStore.use.task()
  const voiceState = useJarvisStore.use.voiceState()
  const voiceArmed = useJarvisStore.use.voiceArmed()
  const providerId = useJarvisStore.use.preferences().providerId
  const activities = useJarvisStore.use.activities()

  const [now, setNow] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const snapshot = useMemo(
    () =>
      buildEnvironmentSnapshot(
        {
          environmentId,
          status,
          isSpeaking,
          goalRun,
          backend,
          camera,
          capabilities,
          task,
          voiceState,
          voiceArmed,
          providerId,
          activities: activities.slice(0, 3).map((a) => ({
            step: a.step,
            detail: a.detail,
            status: a.status,
          })),
        },
        now,
      ),
    [
      now,
      environmentId,
      status,
      isSpeaking,
      goalRun,
      backend,
      camera,
      capabilities,
      task,
      voiceState,
      voiceArmed,
      providerId,
      activities,
    ],
  )

  return snapshot
}