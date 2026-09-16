import { useCallback, useMemo } from 'react'
import { CanvasHost } from '../CanvasHost'
import type { CanvasFrame } from '../CanvasHost'
import { useThemeColors } from '../useThemeColors'
import { useEnvironmentSnapshot } from '../useEnvironmentSnapshot'
import { hudTelemetry } from '../bridge'
import type { ThemeColors } from '../useThemeColors'
import type { VisualState } from '../types'
import { EnvModuleTag } from '../EnvironmentChrome'

/**
 * Phase 8 — Astra HUD environment.
 *
 * A tactical concentric HUD: rotating segmented rings, tick-and-scan sweep,
 * radar pings, orbital satellites and pointer-driven targeting. The DOM
 * overlay carries ONLY real telemetry (status label, voice state, capability
 * flags, backend phase, device counts) — no fabricated readouts.
 *
 * Visual hierarchy: CORE → ACTIVE STATUS → IMPORTANT DATA → SECONDARY TELEMETRY.
 */

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function stateAccent(c: ThemeColors, state: VisualState): string {
  switch (state) {
    case 'failed':
      return c.error
    case 'recovering':
      return c.warning
    case 'completed':
      return c.success
    default:
      return `hsl(${c.accentH} ${c.accentS}% ${c.accentL}%)`
  }
}

function arcGap(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  start: number,
  span: number,
  width: number,
  style: string,
): void {
  ctx.beginPath()
  ctx.arc(x, y, r, start, start + span)
  ctx.lineWidth = width
  ctx.strokeStyle = style
  ctx.stroke()
}

function drawHud(ctx: CanvasRenderingContext2D, frame: CanvasFrame, c: ThemeColors): void {
  const { w, h, t, drive, pointerX, pointerY } = frame
  if (w === 0 || h === 0) return
  const energy = drive.energy
  const cx = w / 2
  const cy = h / 2
  const base = Math.min(w, h)
  const R = base * 0.3
  const accent = stateAccent(c, drive.state)

  const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, base * 0.75)
  bg.addColorStop(0, '#050810')
  bg.addColorStop(1, '#02040a')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  /* ---- radar pings (periodic) ---- */
  const pingPhase = (t % 3.2) / 3.2
  if (pingPhase > 0.02) {
    const pr = R * 0.34 + pingPhase * R * 1.05
    ctx.globalAlpha = clamp01((1 - pingPhase) * 0.28)
    ctx.strokeStyle = accent
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(cx, cy, pr, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  /* ---- concentric rings ---- */
  ctx.lineWidth = 1
  ctx.strokeStyle = `hsla(${c.accentH} ${c.accentS}% ${c.accentL}% / 0.16)`
  for (const r of [R * 0.34, R * 0.72, R * 1.0]) {
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
  }

  /* ---- tick marks ---- */
  const TICKS = 72
  for (let i = 0; i < TICKS; i++) {
    const a = (i / TICKS) * Math.PI * 2
    const major = i % 6 === 0
    const len = major ? 7 : 3.5
    const pulse = 0.12 + 0.08 * (0.5 + 0.5 * Math.sin(t * 1.8 + i * 0.45))
    const x1 = cx + Math.cos(a) * R
    const y1 = cy + Math.sin(a) * R
    ctx.strokeStyle = `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 12}% / ${clamp01(pulse + energy * 0.08)})`
    ctx.lineWidth = major ? 1.4 : 1
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x1 + Math.cos(a) * len, y1 + Math.sin(a) * len)
    ctx.stroke()
  }

  /* ---- rotating long segments (counter-rotating) ---- */
  const sweepA = t * (0.5 + drive.speed * 0.8) * 0.6
  const sweepB = -t * (0.4 + drive.speed * 0.6)
  arcGap(ctx, cx, cy, R * 0.72, sweepA, Math.PI * 0.9, 2, `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 16}% / 0.5)`)
  arcGap(ctx, cx, cy, R * 1.0, sweepB, Math.PI * 0.42, 2, `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 10}% / 0.36)`)

  /* ---- scanning sweep wedge (radial) ---- */
  const scan = t * (0.5 + drive.speed * 1.1)
  const wedge = Math.PI * 0.16
  const segments = 9
  for (let i = 0; i < segments; i++) {
    const a = scan + (i / segments) * wedge
    const r0 = R * 0.34
    const r1 = R * 1.0
    const g = ctx.createLinearGradient(
      cx + Math.cos(a) * r0,
      cy + Math.sin(a) * r0,
      cx + Math.cos(a) * r1,
      cy + Math.sin(a) * r1,
    )
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 20}% / 0.14)`)
    ctx.strokeStyle = g
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0)
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
    ctx.stroke()
  }

  /* ---- orbital satellites ---- */
  for (let i = 0; i < 6; i++) {
    const dir = i % 2 === 0 ? 1 : -1
    const speed = dir * (0.25 + (i % 3) * 0.12) * drive.speed
    const a = t * speed + (i / 6) * Math.PI * 2
    const r = R * 1.18
    const ox = cx + Math.cos(a) * r
    const oy = cy + Math.sin(a) * r
    ctx.fillStyle = `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 22}% / 0.75)`
    ctx.fillRect(ox - 1.2, oy - 1.2, 2.4, 2.4)
  }

  /* ---- particles drifting inward ---- */
  const MOTES = 40
  for (let i = 0; i < MOTES; i++) {
    const p = ((i / MOTES + t * 0.03 * drive.speed) % 1 + 1) % 1
    const a = (i * 0.681 + p * Math.PI * 2) % (Math.PI * 2)
    const r = R * (0.34 + (1 - p) * 0.82)
    const mx = cx + Math.cos(a) * r
    const my = cy + Math.sin(a) * r
    ctx.globalAlpha = clamp01(0.35 * (1 - p) * (0.5 + energy * 0.5))
    ctx.fillStyle = `hsl(${c.accentH} ${c.accentS}% ${Math.min(94, c.accentL + 20)}%)`
    ctx.beginPath()
    ctx.arc(mx, my, 1, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  /* ---- core orb (reacts to real drive + speech) ---- */
  const speechLift = drive.speaking ? 0.82 + drive.speech * 0.28 : 1
  const corePulse = 1 + Math.sin(t * (1.4 + drive.pulse * 0.5)) * 0.04 * drive.pulse
  const coreR = R * 0.18 * corePulse * speechLift
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(2, coreR))
  core.addColorStop(0, `hsla(${c.accentH} 100% 94% / 0.95)`)
  core.addColorStop(0.6, `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 10}% / 0.9)`)
  core.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = core
  ctx.beginPath()
  ctx.arc(cx, cy, Math.max(2, coreR * 1.6), 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = accent
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
  ctx.stroke()

  /* ---- pointer targeting reticle (interactive) ---- */
  const tx = cx + pointerX * (w / 2 - R * 0.6)
  const ty = cy + pointerY * (h / 2 - R * 0.6)
  const retR = R * 0.1
  ctx.strokeStyle = `hsla(${c.accentH} ${c.accentS}% ${c.accentL + 16}% / 0.5)`
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(tx, ty, retR, 0, Math.PI * 2)
  ctx.stroke()
  const retSpin = t * 1.2
  for (let i = 0; i < 4; i++) {
    const a = retSpin + (i / 4) * Math.PI * 2
    ctx.beginPath()
    ctx.moveTo(tx + Math.cos(a) * retR * 0.94, ty + Math.sin(a) * retR * 0.94)
    ctx.lineTo(tx + Math.cos(a) * retR * 1.12, ty + Math.sin(a) * retR * 1.12)
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.moveTo(tx - retR * 0.3, ty)
  ctx.lineTo(tx + retR * 0.3, ty)
  ctx.moveTo(tx, ty - retR * 0.3)
  ctx.lineTo(tx, ty + retR * 0.3)
  ctx.stroke()
}

export function AstraScene() {
  const colorsRef = useThemeColors()
  const snapshot = useEnvironmentSnapshot('astra')

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, frame: CanvasFrame) => {
      drawHud(ctx, frame, colorsRef.current)
    },
    [colorsRef],
  )

  const telemetry = useMemo(
    () => hudTelemetry(snapshot),
    [snapshot],
  )

  return (
    <div className="astra-scene">
      <CanvasHost draw={draw} className="astra-canvas" />
      <EnvModuleTag moduleId="MOD-A2" label="ASTRA HUD" />
      <div className="astra-overlay" aria-hidden="false">
        <div className="astra-corner astra-corner--tl">
          <span className="astra-kicker">JARVIS</span>
          <span className="astra-status" role="status">
            {snapshot.statusLabel}
          </span>
          <span className="astra-sub">{snapshot.visualState}</span>
        </div>
        <div className="astra-corner astra-corner--tr">
          <span className="astra-kicker">Voice</span>
          <span className="astra-value">{snapshot.voiceState}</span>
          {snapshot.voiceArmed ? <span className="astra-tag">ARMED</span> : null}
        </div>
        <div className="astra-corner astra-corner--bl">
          {telemetry.map((row) => (
            <span key={row.label} className="astra-telem">
              <span className="astra-telem-label">{row.label}</span>
              <span
                className={`astra-telem-value${row.tone === 'ok' ? ' is-ok' : ''}${
                  !row.available ? ' is-na' : ''
                }`}
              >
                {row.value}
              </span>
            </span>
          ))}
        </div>
        <div className="astra-corner astra-corner--br">
          <span className="astra-kicker">Activity</span>
          <span className="astra-value astra-value--wrap">
            {snapshot.lastActivity
              ? `${snapshot.lastActivity.step} \u00b7 ${snapshot.lastActivity.detail}`
              : '\u2014'}
          </span>
        </div>
      </div>
    </div>
  )
}