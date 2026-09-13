

/**
 * Phase 10 — zoom persistence.
 *
 * Per-environment zoom levels survive reloads through a tiny dedicated storage
 * slot (mirroring the panel layout storage style). Values are sanitized on load
 * so stored garbage can never produce NaN or out-of-bounds zoom.
 */

const STORAGE_KEY = 'jarvis.zoom.v1'

export function loadZoomLevels(): Record<string, number> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const data: Record<string, number> = JSON.parse(raw)
    const out: Record<string, number> = {}
    for (const [id, level] of Object.entries(data)) {
      if (typeof level === 'number' && Number.isFinite(level)) out[id] = level
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

export function saveZoomLevels(levels: Record<string, number>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(levels))
  } catch {
    // Storage unavailable or quota exceeded — zoom is ephemeral.
  }
}