import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { shaderMaterial } from '@react-three/drei'
import * as THREE from 'three'
import { live } from './visual'

/**
 * Simplex noise (Ashima Arts / Stefan Gustavson) — used for organic
 * displacement + shimmer. BSD-licensed, standard in many Three.js examples.
 */
const NOISE_GLSL = `
vec3 mod289(vec3 x){return x - floor(x * (1.0/289.0)) * 289.0;}
vec4 mod289(vec4 x){return x - floor(x * (1.0/289.0)) * 289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`

const EnergyShader = shaderMaterial(
  {
    uTime: 0,
    uActive: 0.2,
    uPulse: 1,
    uColor: new THREE.Color('#4fd8f0'),
  },
  /* vertex */ `
  uniform float uTime;
  uniform float uActive;
  uniform float uPulse;
  varying float vNoise;
  varying float vFresnel;
  varying vec3 vPos;
  ${NOISE_GLSL}
  void main() {
    vec3 p = normalize(position) * 1.35;
    float n1 = snoise(normal * 2.0 + uTime * 0.16) * 0.5 + 0.5;
    float n2 = snoise(normal * 4.0 - uTime * 0.10) * 0.5 + 0.5;
    vNoise = n1 * n2;
    float amp = 0.16 + uActive * 0.20;
    vec3 displaced = p * (1.0 + vNoise * amp * (0.7 + 0.3 * uPulse));
    vec3 worldPos = (modelMatrix * vec4(displaced, 1.0)).xyz;
    vec3 viewDir = normalize(cameraPosition - worldPos);
    vec3 nrm = normalize(normalMatrix * normal);
    vFresnel = pow(1.0 - max(dot(nrm, viewDir), 0.0), 2.2);
    vPos = worldPos;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`,
  /* fragment */ `
  uniform float uTime;
  uniform float uActive;
  uniform float uPulse;
  uniform vec3 uColor;
  varying float vNoise;
  varying float vFresnel;
  varying vec3 vPos;
  ${NOISE_GLSL}
  void main() {
    float swirl = snoise(vPos * 1.2 + vec3(uTime * 0.08)) * 0.5 + 0.5;
    vec3 deep = uColor * (0.16 + 0.42 * uActive);
    vec3 rim = uColor * vFresnel * 1.7;
    vec3 surface = deep + rim + uColor * vNoise * 0.5;
    surface += vec3(1.0) * pow(vFresnel, 5.0) * 0.5 * (0.35 + uActive);
    surface += uColor * swirl * 0.18 * (0.4 + uActive);
    float alpha = 0.5 + vFresnel * 0.5;
    alpha *= 0.55 + uActive * 0.5;
    alpha += vNoise * 0.15;
    gl_FragColor = vec4(surface, clamp(alpha, 0.05, 1.0));
  }
`,
)

/** Central energy orb — the identity of JARVIS. */
export function CoreEnergy() {
  const meshRef = useRef<THREE.Mesh>(null)
  const groupRef = useRef<THREE.Group>(null)
  const targetScale = useRef(1)

  const geometry = useMemo(() => new THREE.IcosahedronGeometry(0.82, 24), [])
  const material = useMemo(
    () =>
      new EnergyShader({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [],
  )

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime
    const mat = meshRef.current?.material as THREE.ShaderMaterial | undefined
    if (mat) {
      mat.uniforms.uTime.value = t
      mat.uniforms.uActive.value = live.active
      mat.uniforms.uPulse.value = live.pulse
      ;(mat.uniforms.uColor.value as THREE.Color).copy(live.color)
    }
    if (groupRef.current) {
      // Breathing scale: gentle base pulse, sharper for active states. During
      // REAL speech the energy expands/shrinks with the bounded amplitude.
      const base = 1 + Math.sin(t * (1.4 + live.active * 2.2)) * 0.02 * (0.4 + live.pulse * 0.25)
      const speechScalar = 0.82 + live.speech * 0.28
      const target = base * speechScalar
      targetScale.current += (target - targetScale.current) * (1 - Math.exp(-dt * 4))
      groupRef.current.scale.setScalar(targetScale.current)
      groupRef.current.rotation.y += dt * live.speed
      groupRef.current.rotation.z += dt * live.speed * 0.21
    }
  })

  return (
    <group ref={groupRef}>
      <mesh ref={meshRef} geometry={geometry} material={material} />
    </group>
  )
}