import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { deviceTier } from '../utils/capabilities'
import { useJarvisStore } from '../state/jarvis.store'
import { live } from './visual'

interface FieldSpec {
  radiusMin: number
  radiusMax: number
  countBase: number
  size: number
  speed: number
  dir: 1 | -1
}

const SHELL: FieldSpec = {
  radiusMin: 2.7,
  radiusMax: 4.7,
  countBase: 700,
  size: 0.028,
  speed: 0.05,
  dir: -1,
}

const SPARKS: FieldSpec = {
  radiusMin: 1.15,
  radiusMax: 2.7,
  countBase: 420,
  size: 0.02,
  speed: -0.09,
  dir: 1,
}

function makePositions(spec: FieldSpec, count: number): Float32Array {
  const pos = new Float32Array(count * 3)
  for (let i = 0; i < count; i += 1) {
    // Stable-ish random on a sphere shell.
    const u = Math.random()
    const v = Math.random()
    const theta = 2 * Math.PI * u
    const phi = Math.acos(2 * v - 1)
    const r = spec.radiusMin + Math.random() * (spec.radiusMax - spec.radiusMin)
    const sinPhi = Math.sin(phi)
    pos[i * 3] = r * sinPhi * Math.cos(theta)
    pos[i * 3 + 1] = r * sinPhi * Math.sin(theta)
    pos[i * 3 + 2] = r * Math.cos(phi)
  }
  return pos
}

function tierFactor(): number {
  const tier = deviceTier()
  if (tier === 'high') return 1
  if (tier === 'medium') return 0.62
  return 0.4
}

function ParticleField({ spec }: { spec: FieldSpec }) {
  const pointsRef = useRef<THREE.Points>(null)
  const materialRef = useRef<THREE.PointsMaterial>(null)

  const { positions } = useMemo(() => {
    const intensity = useJarvisStore.getState().preferences.animationIntensity
    const base = tierFactor() * (intensity === 'high' ? 1 : intensity === 'medium' ? 0.7 : 0.45)
    const count = Math.round(spec.countBase * base)
    return { positions: makePositions(spec, count) }
  }, [spec])

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return g
  }, [positions])

  useFrame((state, dt) => {
    if (pointsRef.current) {
      pointsRef.current.rotation.y += dt * spec.speed * (1 + live.active * 3)
      pointsRef.current.rotation.x += dt * spec.speed * spec.dir * 0.35 * live.active
    }
    if (materialRef.current) {
      const targetOpacity = 0.16 + live.active * 0.5
      materialRef.current.opacity += (targetOpacity - materialRef.current.opacity) * (1 - Math.exp(-dt * 3))
      ;(materialRef.current.color as THREE.Color).lerp(live.color, 1 - Math.exp(-dt * 1.8))
    }
    void state
  })

  return (
    <points ref={pointsRef} geometry={geometry}>
      <pointsMaterial
        ref={materialRef}
        color="#9fdbea"
        size={spec.size}
        sizeAttenuation
        transparent
        opacity={0.16}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  )
}

/** Two softly-lit particle shells: an outer fog and an inner spark field. */
export function CoreParticles() {
  return (
    <group>
      <ParticleField spec={SHELL} />
      <ParticleField spec={SPARKS} />
    </group>
  )
}