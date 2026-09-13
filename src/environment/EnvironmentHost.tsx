import { useEffect, useRef, useState } from 'react'
import { usePanelLayoutStore } from '../panel/panelStore'
import { sanitizeEnvironmentId } from './registry'
import { pickTransition, resolveTransitionTimings } from './transition'
import type { TransitionKind } from './transition'
import type { VisualEnvironmentId } from './types'
import { ArcReactorScene } from './scenes/ArcReactorScene'
import { AstraScene } from './scenes/AstraScene'
import { ControlScene } from './scenes/ControlScene'
import { SpaceScene } from './scenes/SpaceScene'
import { TunnelScene } from './scenes/TunnelScene'
import { useJarvisStore } from '../state/jarvis.store'
import { useZoomStore } from './zoomStore'

/**
 * Phase 8 — Environment host.
 *
 * Renders the active environment and animates switches through a short
 * themed overlay. The old environment unmounts immediately; the new one
 * mounts behind the still-covered overlay so the swap is visually seamless.
 * With reduced motion the overlay is skipped entirely (instant swap).
 *
 * Phase 10 — the ACTIVE environment's real, store-owned zoom level is applied
 * as a CSS scale on the scene layer (per-environment bounded window; see
 * `zoomStore`). This is the single rendering point of zoom for every
 * environment — scenes themselves stay zoom-agnostic.
 */

interface TransitionState {
  kind: TransitionKind
  /** 'in': covering the outgoing view · 'out': revealing the incoming view. */
  phase: 'in' | 'out'
}

function RenderEnvironment({ id }: { id: VisualEnvironmentId }) {
  switch (id) {
    case 'arc':
      return <ArcReactorScene />
    case 'astra':
      return <AstraScene />
    case 'control':
      return <ControlScene />
    case 'space':
      return <SpaceScene />
    case 'tunnel':
      return <TunnelScene />
    default:
      return null
  }
}

export function EnvironmentHost() {
  const selectedId = usePanelLayoutStore((s) => s.environmentId)
  const reducedMotion = useJarvisStore.use.preferences().reducedMotion

  const [displayId, setDisplayId] = useState<VisualEnvironmentId>(() =>
    sanitizeEnvironmentId(selectedId),
  )
  const [transition, setTransition] = useState<TransitionState | null>(null)

  // Phase 10 — the displayed environment's real zoom level from the store.
  const zoom = useZoomStore((s) => s.zoomByEnvironment[displayId] ?? 1)

  const selectedRef = useRef(displayId)

  useEffect(() => {
    const next = sanitizeEnvironmentId(selectedId)
    if (next === selectedRef.current) return
    selectedRef.current = next

    if (reducedMotion) {
      setDisplayId(next)
      return
    }

    const kind = pickTransition(displayId, next)
    const t = resolveTransitionTimings(kind)
    let cancelled = false
    const timers: number[] = []

    setTransition({ kind, phase: 'in' })
    timers.push(
      window.setTimeout(() => {
        if (cancelled) return
        setDisplayId(next)
        setTransition({ kind, phase: 'out' })
      }, t.inMs + t.holdMs),
    )
    timers.push(
      window.setTimeout(() => {
        if (cancelled) return
        setTransition(null)
      }, t.totalMs),
    )

    return () => {
      cancelled = true
      timers.forEach((timer) => window.clearTimeout(timer))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, reducedMotion])

  const timings = transition ? resolveTransitionTimings(transition.kind) : null

  return (
    <div
      className="jarvis-scene-layer"
      style={{
        transform: `scale(${zoom})`,
        transformOrigin: '50% 50%',
        willChange: 'transform',
        transition: 'transform 200ms ease-out',
      }}
    >
      <RenderEnvironment id={displayId} />
      {transition && timings ? (
        <div
          className={`tr-overlay tr-${transition.kind} tr-${transition.phase}`}
          aria-hidden="true"
          style={{
            ['--tr-duration' as string]: `${transition.phase === 'in' ? timings.inMs : timings.outMs}ms`,
          }}
        />
      ) : null}
    </div>
  )
}