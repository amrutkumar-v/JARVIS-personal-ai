/**
 * Phase 2.5 — JARVIS theme catalogue.
 *
 * Themes are STRICTLY presentation: they swap CSS design tokens (accent,
 * surfaces, text hierarchy, glow, Arc-Reactor appearance) and never touch
 * execution, permissions, capabilities or any engine state. The Arc Reactor —
 * the visual identity — exists in every theme. This module is pure data so the
 * store, settings panel and tests all share one source of truth.
 */

export type JarvisTheme = 'classic' | 'cyber' | 'stealth' | 'holographic' | 'minimal'

export const JARVIS_THEMES: readonly JarvisTheme[] = [
  'classic',
  'cyber',
  'stealth',
  'holographic',
  'minimal',
] as const

export const DEFAULT_THEME: JarvisTheme = 'classic'

export interface ThemeMeta {
  id: JarvisTheme
  label: string
  /** Short presenter-facing description shown in the settings picker. */
  description: string
}

export const THEME_META: Record<JarvisTheme, ThemeMeta> = {
  classic: { id: 'classic', label: 'Classic', description: 'The iconic cyan arc reactor on deep midnight.' },
  cyber: { id: 'cyber', label: 'Cyber', description: 'Neon magenta over smoked glass — high energy.' },
  stealth: { id: 'stealth', label: 'Stealth', description: 'Muted gunmetal and low glow for quiet operation.' },
  holographic: { id: 'holographic', label: 'Holographic', description: 'Iridescent teal-violet with soft holo bleed.' },
  minimal: { id: 'minimal', label: 'Minimal', description: 'Stripped-back monochrome; clarity over spectacle.' },
}

export function isJarvisTheme(value: string): value is JarvisTheme {
  return (JARVIS_THEMES as readonly string[]).includes(value)
}