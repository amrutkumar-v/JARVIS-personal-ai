import type { PanelDefinition, PanelId } from './types'
import { ENVIRONMENT_DEFINITIONS } from '../environment/registry'

export const PANEL_DEFINITIONS: readonly PanelDefinition[] = [
  {
    id: 'core',
    title: 'JARVIS Core',
    icon: '\u25c9',
    defaultOpen: false,
    defaultPlacement: 'top',
    defaultSize: { w: 320, h: 340 },
    minSize: { w: 240, h: 200 },
    keepMounted: false,
    order: 0,
  },
  {
    id: 'camera',
    title: 'Camera',
    icon: '\u25ce',
    defaultOpen: true,
    defaultPlacement: 'left',
    defaultSize: { w: 260, h: 280 },
    minSize: { w: 180, h: 160 },
    keepMounted: true,
    order: 1,
  },
  {
    id: 'conversation',
    title: 'Session Log',
    icon: '\u25a4',
    defaultOpen: true,
    defaultPlacement: 'right',
    defaultSize: { w: 268, h: 360 },
    minSize: { w: 200, h: 200 },
    keepMounted: false,
    order: 2,
  },
  {
    id: 'activity',
    title: 'Activity',
    icon: '\u26a1',
    defaultOpen: true,
    defaultPlacement: 'right',
    defaultSize: { w: 268, h: 260 },
    minSize: { w: 200, h: 160 },
    keepMounted: false,
    order: 3,
  },
  {
    id: 'system',
    title: 'System',
    icon: '\u25d0',
    defaultOpen: true,
    defaultPlacement: 'left',
    defaultSize: { w: 280, h: 120 },
    minSize: { w: 200, h: 80 },
    keepMounted: false,
    order: 4,
  },
  {
    id: 'environments',
    title: 'Environments',
    icon: '\u2606',
    defaultOpen: false,
    defaultPlacement: 'floating',
    defaultSize: { w: 240, h: 200 },
    minSize: { w: 180, h: 140 },
    keepMounted: false,
    order: 5,
  },
  {
    id: 'vision',
    title: 'Vision',
    icon: '\u25c3',
    defaultOpen: false,
    defaultPlacement: 'floating',
    defaultSize: { w: 240, h: 180 },
    minSize: { w: 180, h: 120 },
    keepMounted: false,
    order: 6,
  },
  {
    id: 'devices',
    title: 'Devices',
    icon: '\u2b22',
    defaultOpen: false,
    defaultPlacement: 'floating',
    defaultSize: { w: 260, h: 160 },
    minSize: { w: 200, h: 100 },
    keepMounted: false,
    order: 7,
  },
  {
    id: 'files',
    title: 'Files',
    icon: '\u2b1a',
    defaultOpen: false,
    defaultPlacement: 'floating',
    defaultSize: { w: 240, h: 160 },
    minSize: { w: 180, h: 100 },
    keepMounted: false,
    order: 8,
  },
  {
    id: 'applications',
    title: 'Applications',
    icon: '\u2b1c',
    defaultOpen: false,
    defaultPlacement: 'floating',
    defaultSize: { w: 240, h: 160 },
    minSize: { w: 180, h: 100 },
    keepMounted: false,
    order: 9,
  },
] as const

export const PANEL_BY_ID = new Map<PanelId, PanelDefinition>(
  PANEL_DEFINITIONS.map((d) => [d.id, d]),
)

export interface TaskbarEntry {
  id: PanelId
  label: string
  icon: string
  kind: 'module' | 'capability'
}

export const TASKBAR_ITEMS: readonly TaskbarEntry[] = [
  { id: 'core', label: 'Core', icon: '\u25c9', kind: 'module' },
  { id: 'camera', label: 'Camera', icon: '\u25ce', kind: 'module' },
  { id: 'conversation', label: 'Session', icon: '\u25a4', kind: 'module' },
  { id: 'activity', label: 'Activity', icon: '\u26a1', kind: 'module' },
  { id: 'vision', label: 'Vision', icon: '\u25c3', kind: 'capability' },
  { id: 'devices', label: 'Devices', icon: '\u2b22', kind: 'capability' },
  { id: 'files', label: 'Files', icon: '\u2b1a', kind: 'capability' },
  { id: 'applications', label: 'Apps', icon: '\u2b1c', kind: 'capability' },
  { id: 'system', label: 'System', icon: '\u25d0', kind: 'module' },
  { id: 'environments', label: 'Environments', icon: '\u2606', kind: 'module' },
] as const

export interface EnvironmentEntry {
  id: string
  label: string
  status: 'active' | 'planned'
}

/** Phase 8 — all environments are live; single source is the environment registry. */
export const ENVIRONMENTS: readonly EnvironmentEntry[] = ENVIRONMENT_DEFINITIONS.map(
  (d) => ({ id: d.id, label: d.label, status: 'active' as const }),
)
