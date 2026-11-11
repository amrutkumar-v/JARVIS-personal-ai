const store = new Map<string, string>()
const storage = {
  getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string): void => void store.set(k, String(v)),
  removeItem: (k: string): void => void store.delete(k),
}
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: storage,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  setTimeout,
  clearTimeout,
}
;(globalThis as unknown as { localStorage: unknown }).localStorage = storage

const { readNativeAgentEnv } = await import('./src/native/nativeAgentEnv')
console.log('ENV:', JSON.stringify(readNativeAgentEnv()))

const native = await import('./src/native')
const app = native.createDefaultAppApplicationProvider()
const obs = native.createDefaultAppObservationProvider()
const web = native.createDefaultAppWebProvider()
console.log('app/obs/web:', app ? 'P' : '-', obs ? 'P' : '-', web ? 'P' : '-')

const apps = app ? await app.list() : []
console.log('app count:', apps.length)
const known = apps.filter((a) => ['notepad', 'calculator', 'google-chrome'].includes(a.applicationId))
console.log('key apps:', known.map((a) => `${a.applicationId}:launchable=${a.launchable}`).join(','))
console.log('app caps after probe:', app ? JSON.stringify(app.capabilities()) : 'n/a')

const wins = obs ? await obs.list() : []
console.log('open windows:', wins.length)

if (web) {
  const search = await web.search({ query: 'nvidia geforce latest driver version 2026' })
  console.log('search:', JSON.stringify({ provider: search.provider, hits: search.results.length, first: search.results[0]?.title, q: search.query }))
}