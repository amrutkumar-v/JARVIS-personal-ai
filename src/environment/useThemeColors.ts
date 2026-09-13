import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { useJarvisStore } from '../state/jarvis.store'

/**
 * Phase 8 — theme token bridge for canvas environments.
 * Read the live CSS custom properties once per theme change (rare) and expose
 * them through a mutable ref so animation loops read scalar values instead of
 * parsing styles each frame. Falls back to the classic palette in node/SSR.
 */

export interface ThemeColors {
  accentH: number
  accentS: number
  accentL: number
  warning: string
  success: string
  error: string
  text: string
  textFaint: string
  hairline: string
}

export const DEFAULT_THEME_COLORS: ThemeColors = {
  accentH: 187,
  accentS: 92,
  accentL: 52,
  warning: 'hsl(42 96% 58%)',
  success: 'hsl(145 72% 48%)',
  error: 'hsl(0 75% 55%)',
  text: 'hsl(196 30% 94%)',
  textFaint: 'hsl(196 10% 42%)',
  hairline: 'hsla(192 40% 82% / 0.12)',
}

function readVar(name: string): string | null {
  if (typeof document === 'undefined') return null
  const element = document.querySelector('.jarvis-app') ?? document.documentElement
  const value = getComputedStyle(element).getPropertyValue(name).trim()
  return value.length > 0 ? value : null
}

function numberToken(raw: string | null, fallback: number): number {
  if (raw == null) return fallback
  const n = Number(raw.replace('%', ''))
  return Number.isFinite(n) ? n : fallback
}

function stringToken(raw: string | null, fallback: string): string {
  return raw ?? fallback
}

export function useThemeColors(): MutableRefObject<ThemeColors> {
  const theme = useJarvisStore.use.theme()
  const ref = useRef<ThemeColors>(DEFAULT_THEME_COLORS)

  useEffect(() => {
    ref.current = {
      accentH: numberToken(readVar('--accent-h'), DEFAULT_THEME_COLORS.accentH),
      accentS: numberToken(readVar('--accent-s'), DEFAULT_THEME_COLORS.accentS),
      accentL: numberToken(readVar('--accent-l'), DEFAULT_THEME_COLORS.accentL),
      warning: stringToken(readVar('--warning'), DEFAULT_THEME_COLORS.warning),
      success: stringToken(readVar('--success'), DEFAULT_THEME_COLORS.success),
      error: stringToken(readVar('--error'), DEFAULT_THEME_COLORS.error),
      text: stringToken(readVar('--text-primary'), DEFAULT_THEME_COLORS.text),
      textFaint: stringToken(readVar('--text-faint'), DEFAULT_THEME_COLORS.textFaint),
      hairline: stringToken(readVar('--hairline-strong'), DEFAULT_THEME_COLORS.hairline),
    }
  }, [theme])

  return ref
}