/**
 * Desktop-interaction capability module (Phase 1.5) — HANDS.
 *
 * Mouse / keyboard / window-focus input surface. The provider seam decides
 * what is REAL:
 *  - native bridge (`src/native`) → the REAL local Windows agent (bounded
 *    SendInput / SetForegroundWindow over one shared RPC transport)
 *  - browser mode → NO provider (hence NO desktop tools at all)
 *
 * The fake in-memory provider used by tests lives in ./testing.ts and is
 * intentionally NOT exported here so production code can never bind to it.
 */
export * from './provider'
export { DESKTOP_LIMITS } from './limits'
export { desktopBudgetBucket, desktopBudgetExceeded, desktopBudgetLabel, DESKTOP_BUDGET } from './budget'
export type { DesktopBudgetBucket } from './budget'
export { createDesktopTools, DesktopCursorTool, DesktopMoveTool, DesktopClickTool, DesktopDoubleClickTool, DesktopRightClickTool, DesktopScrollTool, DesktopKeyPressTool, DesktopHotkeyTool, DesktopTypeTool, WindowFocusTool } from './DesktopTools'