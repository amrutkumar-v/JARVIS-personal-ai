import { lazy, Suspense } from 'react'

const JarvisViewport = lazy(() =>
  import('../../three/JarvisViewport').then((m) => ({ default: m.JarvisViewport })),
)

/**
 * Phase 8 — Arc Reactor environment.
 *
 * Reuses the existing live 3D core (WebGL) — already driven by the real
 * engine status through the shared visual drive. Lazy-loaded so the WebGL
 * bundle only loads when this environment is actually selected.
 */
export function ArcReactorScene() {
  return (
    <Suspense fallback={null}>
      <JarvisViewport />
    </Suspense>
  )
}