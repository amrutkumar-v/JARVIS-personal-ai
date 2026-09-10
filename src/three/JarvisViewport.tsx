import { Component, Suspense, useMemo, type ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { supportsWebGL } from '../utils/webgl'
import { CoreScene } from './CoreScene'

class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.warn('[scene] render failed', error)
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function SceneFallback() {
  return (
    <div className="jarvis-scene-fallback" role="status">
      <div className="fallback-orb" aria-hidden="true" />
      <p>Rendering engine unavailable on this device. The core stays offline.</p>
    </div>
  )
}

/**
 * Full-viewport WebGL viewport hosting the JARVIS core.
 * Gracefully degrades when WebGL is missing or the scene crashes.
 */
export function JarvisViewport() {
  const ok = useMemo(() => supportsWebGL(), [])

  if (!ok) {
    return <SceneFallback />
  }

  return (
    <div className="jarvis-scene" aria-hidden="true">
      <SceneBoundary fallback={<SceneFallback />}>
        <Canvas
          dpr={[1, 1.6]}
          camera={{ position: [0, 0.14, 6.4], fov: 42, near: 0.1, far: 40 }}
          gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
          onCreated={(state) => {
            state.gl.setClearColor(0x000000, 0)
          }}
        >
          <Suspense fallback={null}>
            <CoreScene />
          </Suspense>
        </Canvas>
      </SceneBoundary>
    </div>
  )
}