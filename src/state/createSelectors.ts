import type { StoreApi, UseBoundStore } from 'zustand'

type WithSelectors<S> = S extends { getState: () => infer T }
  ? S & { use: { [K in keyof T]: () => T[K] } }
  : never

/**
 * Zustand v5 helper that exposes stable `useX()` selectors for each state
 * field, avoiding selector object churn and convenience-closure re-renders.
 */
export const createSelectors = <S extends UseBoundStore<StoreApi<object>>>(
  _store: S,
) => {
  const store = _store as WithSelectors<S>
  store.use = {}
  for (const k of Object.keys(store.getState())) {
    ;(store.use as unknown as Record<string, unknown>)[k] = () =>
      store((s) => (s as unknown as Record<string, unknown>)[k])
  }
  return store as unknown as S & {
    use: { [K in keyof ReturnType<S['getState']>]: () => ReturnType<S['getState']>[K] }
  }
}