import { useCallback, useRef, useState } from 'react'
import { CanvasHost } from '../CanvasHost'
import type { CanvasFrame } from '../CanvasHost'
import { useThemeColors } from '../useThemeColors'

/**
 * Phase 8 — Tunnel environment.
 *
 * A perspective corridor: continuous, procedurally travelling rings receding
 * to a vanishing point, with energy motes flowing past the camera. The REAL
 * drive controls travel speed, brightness and pulse intensity. A small always-
 * present, keyboard-accessible speed control adjusts travel rate on top.
 */

type SpeedLevel = 'slow' | 'normal' | 'fast'

const SPEED_MULTIPLIER: Record<SpeedLevel, number> = {
  slow: 0.5,
  normal: 1,
  fast: 1.7,
}

const SPEED_LABELS: Record<SpeedLevel, string> = {
  slow: 'SLOW',
  normal: 'NOMINAL',
  fast: 'FAST',
}

const RING_COUNT = 26
const RING_SPACING = 0.16
const NEAR_Z = 0.05

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

export function TunnelScene() {
  const colorsRef = useThemeColors()
  const speedRef = useRef<number>(1)
  const [level, setLevel] = useState<SpeedLevel>('normal')

  const chooseSpeed = useCallback((l: SpeedLevel) => {
    speedRef.current = SPEED_MULTIPLIER[l]
    setLevel(l)
  }, [])

  const draw = useCallback((ctx: CanvasRenderingContext2D, frame: CanvasFrame) => {
    const { w, h, t, drive, pointerX, pointerY } = frame
    if (w === 0 || h === 0) return
    const c = colorsRef.current
    const energy = drive.energy

    const cx = w / 2 + pointerX * 26
    const cy = h / 2 + pointerY * 20

    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.85)
    bg.addColorStop(0, '#050810')
    bg.addColorStop(0.6, '#04060c')
    bg.addColorStop(1, '#02040a')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)

    const total = RING_COUNT * RING_SPACING
    const travel = ((t * (0.22 + drive.speed * 0.55) * speedRef.current * RING_SPACING) % total)

    for (let i = 0; i < RING_COUNT; i++) {
      const z = NEAR_Z + ((i * RING_SPACING + travel) % total)
      const scale = 1 / z
      const distort = 1 + Math.sin(z * 6 - t * 2) * 0.015
      const radius = Math.min(w, h) * 0.85 * scale * distort
      const fade = clamp01(1 - (z - NEAR_Z) / total)
      const dim = Math.pow(fade, 1.5) * (0.55 + energy * 0.45)
      const pulseRing = Math.floor(z * 3) % 5 === 0
      const alpha = pulseRing ? 0.12 + dim * 0.4 : 0.04 + dim * 0.16

      ctx.lineWidth = 1 + Math.min(3, scale * 0.02)
      ctx.strokeStyle = `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 8}% / ${clamp01(alpha)})`
      ctx.beginPath()
      ctx.moveTo(cx - radius, cy - radius)
      ctx.lineTo(cx + radius, cy - radius)
      ctx.lineTo(cx + radius, cy + radius)
      ctx.lineTo(cx - radius, cy + radius)
      ctx.closePath()
      ctx.stroke()

      // Diamond cross-brace creates the framework-in-depth feel.
      ctx.beginPath()
      ctx.moveTo(cx, cy - radius * 1.41)
      ctx.lineTo(cx + radius * 1.41, cy)
      ctx.lineTo(cx, cy + radius * 1.41)
      ctx.lineTo(cx - radius * 1.41, cy)
      ctx.closePath()
      ctx.stroke()

      // Corner joints pulse past — the "machinery" moving through the tunnel.
      for (let v = 0; v < 4; v++) {
        const ang = (v / 4) * Math.PI * 2 + Math.PI / 4
        const gx = cx + Math.cos(ang) * radius * 1.41
        const gy = cy + Math.sin(ang) * radius * 1.41
        const j = Math.max(0.5, Math.min(3, (1 / z) * 0.03))
        ctx.fillStyle = `hsla(${c.accentH} ${c.accentS}% ${Math.min(92, c.accentL + 16)}% / ${clamp01(fade * 0.9)})`
        ctx.fillRect(gx - j / 2, gy - j / 2, j, j)
      }
    }

    // Energy motes flowing toward the camera (opinionated but not fabricated).
    const MOTES = 26
    for (let k = 0; k < MOTES; k++) {
      const p = ((k / MOTES + t * (0.14 + drive.speed * 0.2) * speedRef.current) % 1 + 1) % 1
      const z = NEAR_Z + p * total
      const scale = 1 / z
      const radius = Math.min(w, h) * 0.85 * scale
      const ang = (k * 0.38197 + p * Math.PI * 4) % (Math.PI * 2)
      const mx = cx + Math.cos(ang) * radius
      const my = cy + Math.sin(ang) * radius
      const fade = clamp01(1 - p)
      const size = Math.max(0.6, Math.min(3.2, (1 / z) * 0.035))
      ctx.globalAlpha = clamp01(fade * (0.35 + energy * 0.55))
      ctx.fillStyle = `hsl(${c.accentH} ${c.accentS}% ${Math.min(95, c.accentL + 20)}%)`
      ctx.beginPath()
      ctx.arc(mx, my, size, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    // Vanishing-point core — pulses with the real drive.
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(10, Math.min(w, h) * 0.09 * drive.pulse * 0.5))
    core.addColorStop(0, `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 18}% / ${clamp01(0.28 + drive.pulse * 0.18)})`)
    core.addColorStop(1, `hsla(${c.accentH} ${c.accentS}% ${c.accentL}% / 0)`)
    ctx.fillStyle = core
    ctx.fillRect(cx - 60, cy - 60, 120, 120)
  }, [colorsRef])

  return (
    <div className="tunnel-scene">
      <CanvasHost draw={draw} />
      <div className="tunnel-controls" role="group" aria-label="Tunnel travel speed">
        {(['slow', 'normal', 'fast'] as const).map((l) => (
          <button
            key={l}
            type="button"
            className={`tunnel-speed${level === l ? ' is-active' : ''}`}
            aria-pressed={level === l}
            onClick={() => chooseSpeed(l)}
          >
            {SPEED_LABELS[l]}
          </button>
        ))}
      </div>
    </div>
  )
}