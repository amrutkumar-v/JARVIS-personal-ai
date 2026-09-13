import type { PanelId, PanelUiState, PanelPlacement } from './types'
import { PANEL_DEFINITIONS } from './registry'
import { defaultPanelState } from './types'

const STORAGE_KEY = 'jarvis.layout.v1'
const STORAGE_VERSION = 1

interface StoredPanel {
  o: boolean
  p: PanelPlacement
  x: number
  y: number
  w: number
  h: number
}

interface StoredLayout {
  v: number
  panels: Record<string, StoredPanel>
  env?: string
}

function serialize(state: Record<PanelId, PanelUiState>): string {
  const panels: Record<string, StoredPanel> = {}
  for (const [id, s] of Object.entries(state)) {
    panels[id] = { o: s.open, p: s.placement, x: s.x, y: s.y, w: s.w, h: s.h }
  }
  return JSON.stringify({ v: STORAGE_VERSION, panels })
}

function hydrate(
  raw: string,
): { panels: Record<PanelId, PanelUiState>; environmentId: string } | null {
  try {
    const data: StoredLayout = JSON.parse(raw)
    if (!data || data.v !== STORAGE_VERSION || !data.panels) return null

    const defaults = new Map<PanelId, PanelUiState>()
    for (let i = 0; i < PANEL_DEFINITIONS.length; i++) {
      defaults.set(PANEL_DEFINITIONS[i]!.id, defaultPanelState(PANEL_DEFINITIONS[i]!, i))
    }

    const panels: Record<string, PanelUiState> = {}
    for (const [id, stored] of Object.entries(data.panels)) {
      const def = defaults.get(id as PanelId)
      if (!def) continue
      const base = defaults.get(id as PanelId)!
      panels[id] = {
        ...base,
        open: typeof stored.o === 'boolean' ? stored.o : base.open,
        placement: ['floating', 'left', 'right', 'top', 'bottom'].includes(stored.p)
          ? stored.p
          : base.placement,
        x: typeof stored.x === 'number' ? stored.x : base.x,
        y: typeof stored.y === 'number' ? stored.y : base.y,
        w: typeof stored.w === 'number' ? stored.w : base.w,
        h: typeof stored.h === 'number' ? stored.h : base.h,
      }
    }

    for (const [id, def] of defaults) {
      if (!panels[id]) panels[id] = def
    }

    return { panels: panels as Record<PanelId, PanelUiState>, environmentId: data.env ?? 'arc' }
  } catch {
    return null
  }
}

export function loadLayout(): {
  panels: Record<PanelId, PanelUiState>
  environmentId: string
} | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return hydrate(raw)
  } catch {
    return null
  }
}

export function saveLayout(
  panels: Record<PanelId, PanelUiState>,
  environmentId: string,
): void {
  try {
    const data = serialize(panels)
    const parsed = JSON.parse(data) as StoredLayout
    parsed.env = environmentId
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed))
  } catch {
    // Storage unavailable or quota exceeded — layout is ephemeral.
  }
}

export function clearLayout(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore.
  }
}
