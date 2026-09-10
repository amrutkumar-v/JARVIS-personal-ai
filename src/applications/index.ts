/**
 * Application capability module (Phase 1.3 + 4.0) — app.list / app.status /
 * app.launch / app.close over an optional ApplicationProvider. The in-memory
 * provider used by tests lives in ./testing.ts and is intentionally NOT
 * exported here so production code can never bind to it.
 */
export * from './provider'
export {
  createApplicationTools,
  AppListTool,
  AppStatusTool,
  AppLaunchTool,
  AppCloseTool,
} from './ApplicationTools'