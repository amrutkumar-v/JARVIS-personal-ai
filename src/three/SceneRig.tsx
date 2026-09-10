import { useFrame } from '@react-three/fiber'

/**
 * Subtle cinematic camera parallax. R3F tracks normalized pointer in
 * `state.pointer` — we only read it here; no React state churn.
 */
export function SceneRig() {
  useFrame((state, dt) => {
    const k = 1 - Math.exp(-dt * 2)
    const targetX = state.pointer.x * 0.55
    const targetY = -state.pointer.y * 0.38 + 0.14
    const camera = state.camera
    camera.position.x += (targetX - camera.position.x) * k
    camera.position.y += (targetY - camera.position.y) * k
    camera.position.z = 6.4
    camera.lookAt(0, 0, 0)
  })

  return null
}