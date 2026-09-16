import { lazy, Suspense } from 'react'
import { VisualCoreFallback } from '../../components/core/VisualCoreFallback'
import { EnvModuleTag } from '../EnvironmentChrome'

const JarvisViewport = lazy(() =>
  import('../../three/JarvisViewport').then((m) => ({ default: m.JarvisViewport })),
)

/**
 * Phase 8 — Arc Reactor environment.
 *
 * Reuses the existing live 3D core (WebGL) — already driven by the real
 * engine status through the shared visual drive. Lazy-loaded so the WebGL
 * bundle only loads when this environment is actually selected. While the
 * split chunk is fetching, a HUD-styled loading state is shown (no fake
 * scene). The module tag is a static design-language marker, never telemetry.
 */
export function ArcReactorScene() {
  return (
    <div className="arc-scene">
      <Suspense fallback={<VisualCoreFallback />}>
        <JarvisViewport />
      </Suspense>
      <EnvModuleTag moduleId="MOD-A1" label="ARC REACTOR" />
    </div>
  )
}