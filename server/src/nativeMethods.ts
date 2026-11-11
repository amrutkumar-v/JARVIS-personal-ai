/**
 * Server-side mirror of the native agent RPC allowlist.
 *
 * Keep this list in sync with native/src/protocol.ts. The parity test imports
 * the native list directly so a newly added native method cannot become
 * reachable through the backend broker by accident.
 */
export const NATIVE_RPC_METHODS = [
  'system.identity', 'system.ping',
  'filesystem.list', 'filesystem.search', 'filesystem.stat', 'filesystem.read', 'filesystem.write',
  'filesystem.mkdir', 'filesystem.copy', 'filesystem.move', 'filesystem.rename', 'filesystem.delete',
  'app.list', 'app.status', 'app.launch', 'app.close', 'app.refresh',
  'window.list', 'window.status',
  'desktop.screenshot', 'desktop.capabilities', 'desktop.cursor', 'desktop.move', 'desktop.click',
  'desktop.doubleClick', 'desktop.rightClick', 'desktop.scroll', 'desktop.keyPress', 'desktop.hotkey', 'desktop.type',
  'window.focus',
  'web.capabilities', 'web.search', 'web.fetch', 'web.download',
  'clipboard.read', 'clipboard.write',
  'browser.open', 'browser.navigate', 'browser.back', 'browser.forward', 'browser.refresh',
  'browser.click', 'browser.type', 'browser.readPage', 'browser.search', 'browser.screenshot', 'browser.close',
] as const

export type NativeRpcMethod = (typeof NATIVE_RPC_METHODS)[number]
