import { useEffect, useRef } from 'react'
import { useJarvisStore } from '../state/jarvis.store'
import { computeDrive } from '../environment/visualState'
import { prefersReducedMotion } from '../utils/capabilities'
import type { EnvironmentDrive } from './types'

/**
 * Phase 8 — full-viewport 2D canvas host.
 *
 * Owns the rAF loop, sizing (ResizeObserver + devicePixelRatio), normalized
 * pointer tracking and the per-frame `EnvironmentDrive` derived from the REAL
 * store snapshot. Motion drives are computed here each frame (animation-local
 * state — never React state), so environment draw callbacks stay cheap and
 * React re-renders are unrelated to the animation rate.
 */

export interface CanvasFrame {
  w: number
  h: number
  dpr: number
  t: number
  dt: number
  /** Normalized pointer position, -1..1 on each axis. */
  pointerX: number
  pointerY: number
  drive: EnvironmentDrive
}

export interface CanvasHostProps {
  draw: (ctx: CanvasRenderingContext2D, frame: CanvasFrame) => void
  className?: string
}

export function CanvasHost({ draw, className }: CanvasHostProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })
  const pointerRef = useRef({ x: 0, y: 0 })
  const drawRef = useRef(draw)

  useEffect(() => {
    drawRef.current = draw
  }, [draw])

  useEffect(() => {
    const root = rootRef.current
    const canvas = canvasRef.current
    if (!root || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let disposed = false
    let raf = 0
    // OS-level motion preference, so the scenes slow down even when the user
    // has not flipped the in-app toggle (the app toggle still wins as an AND).
    let reducedMotion = prefersReducedMotion()
    const motionMedia =
      typeof window !== 'undefined'
        ? window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
        : null
    const onMotionChange = () => {
      reducedMotion = motionMedia?.matches ?? false
    }
    motionMedia?.addEventListener?.('change', onMotionChange)

    const measure = () => {
      const rect = root.getBoundingClientRect()
      const w = Math.max(1, Math.round(rect.width))
      const h = Math.max(1, Math.round(rect.height))
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75)
      sizeRef.current = { w, h, dpr }
      if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr)
      if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr)
    }
    measure()

    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(root)

    const onPointer = (e: PointerEvent) => {
      const rect = root.getBoundingClientRect()
      pointerRef.current = {
        x: rect.width > 0 ? (e.clientX - rect.left) / rect.width * 2 - 1 : 0,
        y: rect.height > 0 ? (e.clientY - rect.top) / rect.height * 2 - 1 : 0,
      }
    }
    window.addEventListener('pointermove', onPointer)

    let last = performance.now()
    const loop = (now: number) => {
      if (disposed) return
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const t = now / 1000
      const { w, h, dpr } = sizeRef.current
      if (w > 0 && h > 0) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, w, h)
        const s = useJarvisStore.getState()
        const drive = computeDrive(
          s.status,
          s.isSpeaking,
          s.goalRun,
          s.backend.phase,
          s.preferences.reducedMotion || reducedMotion,
          t,
        )
        drawRef.current(ctx, {
          w,
          h,
          dpr,
          t,
          dt,
          pointerX: pointerRef.current.x,
          pointerY: pointerRef.current.y,
          drive,
        })
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      observer?.disconnect()
      window.removeEventListener('pointermove', onPointer)
      motionMedia?.removeEventListener?.('change', onMotionChange)
    }
  }, [])

  return (
    <div ref={rootRef} className={`canvas-host${className ? ` ${className}` : ''}`}>
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  )
}