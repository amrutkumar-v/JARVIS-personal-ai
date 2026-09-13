import { describe, expect, it, beforeEach, vi } from 'vitest'

const localStorageStore = new Map<string, string>()
const mockLocalStorage = {
  getItem: vi.fn((k: string) => localStorageStore.get(k) ?? null),
  setItem: vi.fn((k: string, v: string) => { localStorageStore.set(k, v) }),
  removeItem: vi.fn((k: string) => { localStorageStore.delete(k) }),
  clear: vi.fn(() => { localStorageStore.clear() }),
}

vi.stubGlobal('localStorage', mockLocalStorage)

const { loadLayout, saveLayout, clearLayout } = await import('./storage')

beforeEach(() => {
  localStorageStore.clear()
  mockLocalStorage.getItem.mockClear()
  mockLocalStorage.setItem.mockClear()
  mockLocalStorage.removeItem.mockClear()
})

describe('storage round-trip', () => {
  it('returns null when nothing stored', () => {
    expect(loadLayout()).toBeNull()
  })

  it('saves and loads layout', () => {
    const panels = {
      camera: { open: true, placement: 'left' as const, x: 0, y: 0, w: 200, h: 300, z: 1 },
      core: { open: false, placement: 'top' as const, x: 0, y: 0, w: 300, h: 200, z: 0 },
    } as any
    saveLayout(panels, 'astra')
    const loaded = loadLayout()
    expect(loaded).not.toBeNull()
    expect(loaded!.environmentId).toBe('astra')
    expect(loaded!.panels.camera.open).toBe(true)
    expect(loaded!.panels.camera.placement).toBe('left')
    expect(loaded!.panels.camera.w).toBe(200)
    expect(loaded!.panels.core.open).toBe(false)
  })
})

describe('storage sanitization', () => {
  it('ignores unknown panel ids', () => {
    localStorageStore.set(
      'jarvis.layout.v1',
      JSON.stringify({ v: 1, panels: { unknownPanel: { o: true, p: 'left', x: 0, y: 0, w: 100, h: 100 } } }),
    )
    const loaded = loadLayout()
    expect(loaded).not.toBeNull()
    expect((loaded!.panels as any).unknownPanel).toBeUndefined()
  })

  it('handles invalid placement gracefully', () => {
    localStorageStore.set(
      'jarvis.layout.v1',
      JSON.stringify({ v: 1, panels: { camera: { o: true, p: 'invalid', x: 50, y: 50, w: 200, h: 200 } } }),
    )
    const loaded = loadLayout()
    expect(loaded!.panels.camera.placement).toBe('left')
  })

  it('handles missing version field', () => {
    localStorageStore.set(
      'jarvis.layout.v1',
      JSON.stringify({ panels: { camera: { o: true, p: 'left', x: 0, y: 0, w: 100, h: 100 } } }),
    )
    expect(loadLayout()).toBeNull()
  })

  it('handles corrupt JSON gracefully', () => {
    localStorageStore.set('jarvis.layout.v1', '{invalid json')
    expect(loadLayout()).toBeNull()
  })
})

describe('clearLayout', () => {
  it('removes the storage key', () => {
    localStorageStore.set('jarvis.layout.v1', '{}')
    clearLayout()
    expect(localStorageStore.has('jarvis.layout.v1')).toBe(false)
  })
})
