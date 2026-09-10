import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { live } from './visual'

interface RingSpec {
  inner: number
  outer: number
  tiltX: number
  tiltY: number
  tiltZ: number
  speed: number
  dir: 1 | -1
  opacity: number
}

const SPECS: RingSpec[] = [
  { inner: 1.42, outer: 1.5,  tiltX: 1.15, tiltY: 0, tiltZ: 0,   speed: 0.16, dir: 1,    opacity: 0.5 },
  { inner: 1.86, outer: 1.92, tiltX: -0.62, tiltY: 0.78, tiltZ: 0, speed: 0.11, dir: -1,  opacity: 0.34 },
  { inner: 2.44, outer: 2.5,  tiltX: 0.42,  tiltY: -0.9, tiltZ: 0.3, speed: 0.07, dir: 1,  opacity: 0.22 },

  /* faint horizon ring */
  { inner: 3.1,  outer: 3.13, tiltX: Math.PI / 2, tiltY: 0, tiltZ: 0, speed: 0.04, dir: 1, opacity: 0.12 },
]

function Ring({ spec }: { spec: RingSpec }) {
  const ref = useRef<THREE.Mesh>(null)
  const geometry = useMemo(
    () => new THREE.RingGeometry(spec.inner, spec.outer, 160),
    [spec],
  )
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#cfe9f2',
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    [],
  )

  useFrame((state, dt) => {
    if (!ref.current) return
    const t = state.clock.elapsedTime
    const boost = 1 + live.active * 2.4
    // Phase-shifted rotation, counter-rotating rings.
    const angle = t * spec.speed * boost * spec.dir
    ref.current.rotation.set(0, 0, angle)
    ref.current.rotation.x = Math.sin(t * 0.05 + spec.tiltX * 3) * 0.06 + spec.tiltX
    ref.current.rotation.y = Math.cos(t * 0.04 + spec.tiltY * 3) * 0.06 + spec.tiltY

    if (ref.current.material instanceof THREE.MeshBasicMaterial) {
      const target = spec.opacity * (0.65 + live.active * 0.6)
      ref.current.material.opacity += (target - ref.current.material.opacity) * (1 - Math.exp(-dt * 3))
      ;(ref.current.material.color as THREE.Color).lerp(live.color, (1 - Math.exp(-dt * 2)) * 0.8)
    }

    void angle
  })

  return <mesh ref={ref} geometry={geometry} material={material} />
}

/** Concentric orbital rings around the core. */
export function CoreRings() {
  return (
    <group>
      {SPECS.map((s, i) => (
        <Ring key={i} spec={s} />
      ))}
    </group>
  )
}