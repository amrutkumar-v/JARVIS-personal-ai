/**
 * Loading state shown while the WebGL JarvisViewport chunk is code-split in.
 *
 * This is a real Suspense fallback, not a fake scene: it tells the user the
 * visual core is still initializing and does not pretend telemetry exists.
 * The spinner is decorative (aria-hidden); the text carries the status.
 */
export function VisualCoreFallback() {
  return (
    <div className="jarvis-scene-fallback" role="status">
      <div className="fallback-orb" aria-hidden="true" />
      <p>INITIALIZING VISUAL CORE…</p>
    </div>
  )
}