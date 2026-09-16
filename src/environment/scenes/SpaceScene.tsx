import { useCallback, useMemo, useRef } from 'react'
import { CanvasHost } from '../CanvasHost'
import type { CanvasFrame } from '../CanvasHost'
import { useThemeColors } from '../useThemeColors'
import { deviceTier } from '../../utils/capabilities'
import { useEnvironmentSnapshot } from '../useEnvironmentSnapshot'
import { EnvironmentChrome } from '../EnvironmentChrome'

/**
 * Phase 8 — Space environment.
 *
 * A deep-space parallax field: three depth layers of procedural stars, slow
 * camera drift, pointer parallax, drifting nebulae and faint energy streaks.
 * Nothing here is fake telemetry — the drive (from the REAL engine state)
 * only shapes brightness, tint intensity and drift speed.
 */

interface Star {
  x: number
  y: number
  z: number
  r: number
  tw: number
  ph: number
}

interface StarField {
  key: string
  stars: Star[]
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

function buildStars(w: number, h: number, count: number): Star[] {
  const rnd = mulberry32(7331)
  const stars: Star[] = []
  for (let i = 0; i < count; i++) {
    stars.push({
      x: rnd() * w,
      y: rnd() * h,
      z: 0.2 + rnd() * 0.8,
      r: 0.35 + rnd() * 1.5,
      tw: 0.8 + rnd() * 2.6,
      ph: rnd() * Math.PI * 2,
    })
  }
  return stars
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

const STAR_COUNT: Record<string, number> = { low: 220, medium: 320, high: 440 }

export function SpaceScene() {
  const colorsRef = useThemeColors()
  const fieldRef = useRef<StarField | null>(null)
  const tier = useMemo(() => deviceTier(), [])
  const snapshot = useEnvironmentSnapshot('space')

  const draw = useCallback((ctx: CanvasRenderingContext2D, frame: CanvasFrame) => {
    const { w, h, t, drive, pointerX, pointerY } = frame
    if (w === 0 || h === 0) return
    const c = colorsRef.current
    const energy = drive.energy

    const bg = ctx.createLinearGradient(0, 0, 0, h)
    bg.addColorStop(0, '#05070e')
    bg.addColorStop(0.52, '#04060c')
    bg.addColorStop(1, '#02040a')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)

    const nebulae: Array<{ x: number; y: number; r: number; phase: number }> = [
      { x: w * 0.22, y: h * 0.3, r: Math.min(w, h) * 0.46, phase: 0 },
      { x: w * 0.8, y: h * 0.6, r: Math.min(w, h) * 0.52, phase: 1.7 },
      { x: w * 0.5, y: h * 0.88, r: Math.min(w, h) * 0.4, phase: 3.1 },
    ]
    for (const n of nebulae) {
      const driftX = Math.sin(t * 0.05 + n.phase) * 22
      const driftY = Math.cos(t * 0.04 + n.phase) * 14
      const glow = ctx.createRadialGradient(
        n.x + driftX,
        n.y + driftY,
        0,
        n.x + driftX,
        n.y + driftY,
        n.r,
      )
      const soft = (0.07 + drive.energy * 0.05).toFixed(3)
      glow.addColorStop(0, `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 14}% / ${soft})`)
      glow.addColorStop(1, `hsla(${c.accentH} ${c.accentS}% ${c.accentL}% / 0)`)
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, w, h)
    }

    const key = `${Math.floor(w / 96)}:${Math.floor(h / 96)}`
    if (!fieldRef.current || fieldRef.current.key !== key) {
      fieldRef.current = { key, stars: buildStars(w, h, STAR_COUNT[tier] ?? 320) }
    }

    for (const s of fieldRef.current.stars) {
      const layer = s.z
      const drift = t * (0.03 + drive.speed * 0.06) * (0.35 + layer)
      let sx = (s.x + drift * 60 + pointerX * 14 * layer) % w
      if (sx < 0) sx += w
      let sy = (s.y + pointerY * 9 * layer) % h
      if (sy < 0) sy += h
      const twinkle = 0.35 + 0.5 * (0.5 + 0.5 * Math.sin(t * s.tw + s.ph))
      ctx.globalAlpha = clamp01(twinkle * (0.5 + energy * 0.5))
      ctx.fillStyle =
        layer > 0.72
          ? `hsla(${c.accentH} ${c.accentS}% ${Math.min(94, c.accentL + 18)}% / 1)`
          : 'rgba(226,235,242,0.9)'
      ctx.beginPath()
      ctx.arc(sx, sy, Math.max(0.4, s.r * (0.6 + 0.4 * layer)), 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1

    // Faint diagonal energy streaks — subtle motion tied to the real drive.
    const streakCount = 5
    ctx.lineWidth = 1
    ctx.strokeStyle = `hsla(${c.accentH} ${c.accentS}% ${c.accentL}% / 0.14)`
    for (let i = 0; i < streakCount; i++) {
      const baseX = ((i + 0.5) * w) / streakCount
      const phase = t * (8 + drive.speed * 18) + i * 1.7
      const y0 = Math.abs(((phase * 60) % (h + 240)) - 120)
      const startX = baseX + Math.sin(t * 0.1 + i) * 40
      ctx.globalAlpha = Math.max(0.02, 0.08 + energy * 0.06)
      ctx.beginPath()
      ctx.moveTo(startX - 14, y0 - 1)
      ctx.lineTo(startX + 14, y0 + 1)
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    /* ---- Observatory reticle markings (subtle quadrant ticks) ---- */
    ctx.strokeStyle = `hsla(${c.accentH} ${c.accentS}% ${c.accentL}% / 0.15)`
    ctx.lineWidth = 1
    const pad = 24
    ctx.beginPath()
    ctx.moveTo(pad, pad + 10)
    ctx.lineTo(pad, pad)
    ctx.lineTo(pad + 10, pad)
    ctx.moveTo(w - pad, h - pad - 10)
    ctx.lineTo(w - pad, h - pad)
    ctx.lineTo(w - pad - 10, h - pad)
    ctx.stroke()
  }, [colorsRef, tier])

  return (
    <div className="space-scene">
      <CanvasHost draw={draw} />
      <EnvironmentChrome
        moduleId="MOD-A4"
        label="DEEP FIELD"
        rows={[
          { k: 'STARS', v: String(STAR_COUNT[tier] ?? 320) },
          { k: 'EXEC', v: snapshot.statusLabel },
          {
            k: 'VOICE',
            v: snapshot.voiceArmed ? 'ARMED' : 'STANDBY',
            tone: snapshot.voiceArmed ? 'live' : undefined,
          },
        ]}
      />
    </div>
  )
}