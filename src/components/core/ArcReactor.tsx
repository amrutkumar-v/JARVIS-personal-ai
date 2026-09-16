import { arcReactorPresentation } from './arcReactorModel'
import { useJarvisStore } from '../../state/jarvis.store'

/**
 * Phase 2.5 — the JARVIS Arc Reactor centerpiece (DOM/CSS layer).
 *
 * This is the visual identity that survives EVERY theme. It is driven ONLY by
 * the real engine status (`useJarvisStore.status` / `isSpeaking`); it never
 * synthesises state. Demo Mode enlarges and declutters its surroundings via a
 * class — it never fabricates execution.
 */
export function ArcReactor() {
  const status = useJarvisStore.use.status()
  const isSpeaking = useJarvisStore.use.isSpeaking()
  const demoMode = useJarvisStore.use.demoMode()
  const reducedMotion = useJarvisStore.use.preferences().reducedMotion

  const p = arcReactorPresentation(status, isSpeaking)

  return (
    <div
      className={`arc-reactor arc-${p.variant}${p.speaking ? ' is-speaking' : ''}${demoMode ? ' is-demo' : ''}${reducedMotion ? ' is-reduced' : ''}`}
      data-status={status}
      role="status"
      aria-label={`JARVIS status: ${p.label}${p.speaking ? ', speaking' : ''}`}
    >
      <div className="arc-core" aria-hidden="true">
        <div className="arc-core-inner" />
      </div>
      <div className="arc-ticks" aria-hidden="true" />
      <div className="arc-reticle" aria-hidden="true" />
      <div className="arc-ring arc-ring-a" aria-hidden="true" />
      <div className="arc-ring arc-ring-b" aria-hidden="true" />
      <div className="arc-ring arc-ring-c" aria-hidden="true" />
      <div className="arc-halo" aria-hidden="true" />
      <span className="arc-label">{p.label}</span>
      {p.speaking ? <span className="arc-wave" aria-hidden="true"><i /><i /><i /><i /><i /></span> : null}
    </div>
  )
}