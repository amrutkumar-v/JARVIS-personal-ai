import { useCallback, useRef } from 'react'
import { CanvasHost } from '../CanvasHost'
import type { CanvasFrame } from '../CanvasHost'
import { useThemeColors } from '../useThemeColors'
import type { ThemeColors } from '../useThemeColors'
import { useEnvironmentSnapshot } from '../useEnvironmentSnapshot'
import { EnvironmentChrome } from '../EnvironmentChrome'

/**
 * Phase 8 — Neural environment.
 *
 * A living synaptic network: randomly placed nodes connected by distance-based
 * edges, with signal pulses travelling along synapses. The REAL engine drive
 * shapes node brightness, connection intensity and pulse speed — no fabricated
 * telemetry.
 */

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

interface Node {
  x: number
  y: number
  r: number
  speed: number
  phase: number
  layer: number
}

interface Edge {
  a: number
  b: number
  len: number
}

interface NetworkField {
  key: string
  nodes: Node[]
  edges: Edge[]
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildNetwork(w: number, h: number, nodeCount: number): { nodes: Node[]; edges: Edge[] } {
  const rnd = mulberry32(9021)
  const cx = w / 2
  const cy = h / 2
  const nodes: Node[] = []
  const edges: Edge[] = []

  nodes.push({ x: cx, y: cy, r: 5, speed: 0.6, phase: 0, layer: 1 })

  for (let i = 1; i < nodeCount; i++) {
    const angle = rnd() * Math.PI * 2
    const dist = 40 + rnd() * Math.min(w, h) * 0.42
    nodes.push({
      x: cx + Math.cos(angle) * dist,
      y: cy + Math.sin(angle) * dist,
      r: 1.8 + rnd() * 3.2,
      speed: 0.15 + rnd() * 0.6,
      phase: rnd() * Math.PI * 2,
      layer: 0.2 + rnd() * 0.8,
    })
  }

  const maxEdgeDist = Math.min(w, h) * 0.32
  for (let i = 0; i < nodeCount; i++) {
    for (let j = i + 1; j < nodeCount; j++) {
      const dx = nodes[i]!.x - nodes[j]!.x
      const dy = nodes[i]!.y - nodes[j]!.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len < maxEdgeDist) {
        edges.push({ a: i, b: j, len })
      }
    }
  }

  return { nodes, edges }
}

function drawNeural(
  ctx: CanvasRenderingContext2D,
  frame: CanvasFrame,
  c: ThemeColors,
  field: NetworkField,
): void {
  const { w, h, t, drive, pointerX, pointerY } = frame
  if (w === 0 || h === 0) return

  const energy = drive.energy
  const speed = drive.speed
  const { nodes, edges } = field
  const cx = w / 2 + pointerX * 8
  const cy = h / 2 + pointerY * 8

  const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.74)
  bg.addColorStop(0, '#060914')
  bg.addColorStop(0.48, '#04070e')
  bg.addColorStop(1, '#020409')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  /* ---- Concentric neural processing rings around cortex ---- */
  const cortexR = Math.min(w, h) * 0.12
  ctx.lineWidth = 1
  ctx.strokeStyle = `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 12}% / ${0.14 + energy * 0.1})`
  ctx.beginPath()
  ctx.arc(cx, cy, cortexR * 0.65, t * 0.35, t * 0.35 + Math.PI * 1.1)
  ctx.stroke()

  ctx.strokeStyle = `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 16}% / ${0.1 + energy * 0.08})`
  ctx.beginPath()
  ctx.arc(cx, cy, cortexR * 1.18, -t * 0.25, -t * 0.25 + Math.PI * 0.85)
  ctx.stroke()

  /* ---- Synaptic edges with layer-based depth ---- */
  for (const edge of edges) {
    const na = nodes[edge.a]!
    const nb = nodes[edge.b]!
    const pax = pointerX * 12 * na.layer
    const pay = pointerY * 12 * na.layer
    const pbx = pointerX * 12 * nb.layer
    const pby = pointerY * 12 * nb.layer

    const ax = na.x + pax
    const ay = na.y + pay
    const bx = nb.x + pbx
    const by = nb.y + pby

    const fade = clamp01(1 - edge.len / (Math.min(w, h) * 0.32))
    const depthWeight = (na.layer + nb.layer) * 0.5
    const pulse = (0.05 + fade * 0.18 + energy * 0.12) * depthWeight
    ctx.strokeStyle = `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 8}% / ${clamp01(pulse)})`
    ctx.lineWidth = 0.5 + fade * 0.7 * depthWeight
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.stroke()
  }

  /* ---- Action potential pulses traveling across synapses ---- */
  const PULSE_COUNT = Math.min(32, edges.length)
  for (let i = 0; i < PULSE_COUNT; i++) {
    const edge = edges[i % edges.length]!
    const na = nodes[edge.a]!
    const nb = nodes[edge.b]!
    const pax = pointerX * 12 * na.layer
    const pay = pointerY * 12 * na.layer
    const pbx = pointerX * 12 * nb.layer
    const pby = pointerY * 12 * nb.layer

    const ax = na.x + pax
    const ay = na.y + pay
    const bx = nb.x + pbx
    const by = nb.y + pby

    const phase = ((i * 0.37 + t * (0.22 + speed * 0.38)) % 1 + 1) % 1
    const px = ax + (bx - ax) * phase
    const py = ay + (by - ay) * phase

    const tailPhase = Math.max(0, phase - 0.08)
    const tx = ax + (bx - ax) * tailPhase
    const ty = ay + (by - ay) * tailPhase

    const fade = clamp01(1 - Math.abs(phase - 0.5) * 2) * (0.35 + energy * 0.55)

    // Trailing pulse stroke
    const grad = ctx.createLinearGradient(tx, ty, px, py)
    grad.addColorStop(0, `hsla(${c.accentH} ${c.accentS}% ${c.accentL}% / 0)`)
    grad.addColorStop(1, `hsla(${c.accentH} ${c.accentS}% 96% / ${fade})`)
    ctx.strokeStyle = grad
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(tx, ty)
    ctx.lineTo(px, py)
    ctx.stroke()

    // Pulse head
    ctx.globalAlpha = fade
    ctx.fillStyle = `hsl(${c.accentH} ${c.accentS}% ${Math.min(96, c.accentL + 24)}%)`
    ctx.beginPath()
    ctx.arc(px, py, 1.2 + fade * 0.8, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  /* ---- Synaptic nodes ---- */
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    const drift = Math.sin(t * n.speed + n.phase) * 3
    const pxOffset = pointerX * 12 * n.layer
    const pyOffset = pointerY * 12 * n.layer
    const nx = n.x + drift + pxOffset
    const ny = n.y + Math.cos(t * n.speed * 0.7 + n.phase) * 2 + pyOffset

    const isCortex = i === 0
    const r = isCortex
      ? n.r * (1.15 + Math.sin(t * 0.8) * 0.1 * drive.pulse)
      : n.r * (0.85 + Math.sin(t * n.speed * 2 + n.phase) * 0.15)
    const nodeAlpha = isCortex ? 0.92 : 0.35 + n.layer * 0.45 + energy * 0.15

    ctx.globalAlpha = clamp01(nodeAlpha)
    const nodeGrad = ctx.createRadialGradient(nx, ny, 0, nx, ny, Math.max(2, r * 2.2))
    nodeGrad.addColorStop(0, `hsla(${c.accentH} ${c.accentS}% ${Math.min(96, c.accentL + 18)}% / 0.95)`)
    nodeGrad.addColorStop(0.5, `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 4}% / 0.7)`)
    nodeGrad.addColorStop(1, `hsla(${c.accentH} ${c.accentS}% ${c.accentL}% / 0)`)
    ctx.fillStyle = nodeGrad
    ctx.beginPath()
    ctx.arc(nx, ny, Math.max(2, r * 2.2), 0, Math.PI * 2)
    ctx.fill()

    ctx.strokeStyle = `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 12}% / ${clamp01(nodeAlpha * 0.8)})`
    ctx.lineWidth = isCortex ? 1.5 : 0.8
    ctx.beginPath()
    ctx.arc(nx, ny, Math.max(1, r), 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  /* ---- Ambient cortex aura ---- */
  const cortexGlow = ctx.createRadialGradient(
    cx, cy, 0,
    cx, cy, Math.min(w, h) * 0.32,
  )
  const gAlpha = 0.1 + energy * 0.08
  cortexGlow.addColorStop(0, `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 12}% / ${gAlpha})`)
  cortexGlow.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = cortexGlow
  ctx.fillRect(0, 0, w, h)

  /* ---- Deep floating synaptic motes ---- */
  const MOTES = 22
  for (let i = 0; i < MOTES; i++) {
    const phase = ((i / MOTES + t * 0.035 * speed) % 1 + 1) % 1
    const angle = i * 2.39996 + phase * Math.PI * 2
    const dist = Math.min(w, h) * 0.36 + phase * Math.min(w, h) * 0.14
    const mx = cx + Math.cos(angle) * dist
    const my = cy + Math.sin(angle) * dist
    const mfade = clamp01((1 - phase) * 0.32 * (0.4 + energy * 0.6))
    ctx.globalAlpha = mfade
    ctx.fillStyle = `hsl(${c.accentH} ${c.accentS}% ${Math.min(95, c.accentL + 18)}%)`
    ctx.beginPath()
    ctx.arc(mx, my, 0.8, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

export function NeuralScene() {
  const colorsRef = useThemeColors()
  const fieldRef = useRef<NetworkField | null>(null)
  const snapshot = useEnvironmentSnapshot('neural')

  const draw = useCallback((ctx: CanvasRenderingContext2D, frame: CanvasFrame) => {
    const { w, h } = frame
    const nodeCount = w * h > 400_000 ? 72 : 52
    const key = `${Math.floor(w / 96)}:${Math.floor(h / 96)}:${nodeCount}`
    if (!fieldRef.current || fieldRef.current.key !== key) {
      fieldRef.current = { key, ...buildNetwork(w, h, nodeCount) }
    }
    drawNeural(ctx, frame, colorsRef.current, fieldRef.current)
  }, [colorsRef])

  return (
    <div className="neural-scene">
      <CanvasHost draw={draw} />
      <EnvironmentChrome
        moduleId="MOD-A6"
        label="NEURAL CORE"
        rows={[
          { k: 'VISUAL', v: snapshot.visualState },
          { k: 'EXEC', v: snapshot.statusLabel },
          {
            k: 'VOICE',
            v: snapshot.voiceArmed ? 'ARMED' : 'STANDBY',
            tone: snapshot.voiceArmed ? 'live' : undefined,
          },
          {
            k: 'BUS',
            v: snapshot.backend.phase === 'connected' ? 'ONLINE' : 'LOCAL',
            tone: snapshot.backend.phase === 'connected' ? 'ok' : 'idle',
          },
        ]}
      />
    </div>
  )
}
