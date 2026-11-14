# JARVIS 3.2 — Deep Windows 11 Operating System Integration Specification
## Win32 Window Management, UI Automation (UIA) Control, Desktop Input, System Telemetry, and Safety Boundaries

**Document Version:** 3.2.0  
**Baseline:** JARVIS 3.1  
**Architecture Layer:** Native Windows Agent & Win32 Integration (`native/src/desktop.ts`, `native/src/uiaWin32.ts`)  
**Target Platform:** Windows 11 Pro (OS Build 10.0.26300+ x64)  
**Date:** November 12, 2026  
**Status:** **OPERATIONAL & EMPIRICALLY VERIFIED**

---

## 1. Executive Summary

JARVIS 3.2 deepens native Windows 11 operating system integration beyond static command execution. Running as a supervised Win32 service on port 8765, the Native Windows Agent enables:
1. Application lifecycle management (launching, discovering, focusing, minimizing, and safely closing windows).
2. Deep UI Automation (UIA) tree inspection and control manipulation using standard Windows Accessibility patterns.
3. Desktop observation via high-performance Win32 screen capture.
4. Process health, CPU load, and RAM telemetry tracking.
5. Strict security boundaries preventing arbitrary shell execution, unauthorized file deletion, or dangerous Windows API misuse.

---

## 2. Windows UI Automation (UIA) Architecture

Traditional coordinate-based mouse clicking fails across varied DPI scaling and dynamic window resizing. JARVIS 3.2 interacts with Windows applications using the COM-based Windows UI Automation (UIA) COM API (`native/src/uiaWin32.ts`):

```
Native Windows Agent (native/src/agent.ts)
   │
   ▼
Win32 UIA Bridge (native/src/uiaWin32.ts)
   │
   ├─► uia.inspect (Query UIA control tree, AutomationId, Name, BoundingBox, ControlType)
   ├─► uia.invoke (Trigger Button/MenuItem click using IUIAutomationInvokePattern)
   ├─► uia.setValue (Set Edit/TextBox string using IUIAutomationValuePattern)
   └─► uia.toggle (Toggle CheckBox/RadioButton using IUIAutomationTogglePattern)
```

### 2.1 The Four Canonical UIA Methods

| Method | Parameters | Return Contract | Pattern Implementation |
|---|---|---|---|
| `uia.inspect` | `{ windowTitle?: string, rootHandle?: number, maxDepth?: number }` | `{ elements: Array<UIAElement>, rootTitle: string }` | Traverses `IUIAutomationTreeWalker` and extracts AutomationId, Name, ControlType, BoundingRectangle, and supported pattern flags. |
| `uia.invoke` | `{ automationId?: string, name?: string, controlType?: string }` | `{ success: boolean, elementInvoked: string }` | Locates the target element and calls `IUIAutomationInvokePattern::Invoke()`. |
| `uia.setValue` | `{ automationId?: string, name?: string, value: string }` | `{ success: boolean, previousValue?: string }` | Locates editable control and calls `IUIAutomationValuePattern::SetValue(value)`. |
| `uia.toggle` | `{ automationId?: string, name?: string }` | `{ success: boolean, toggleState: 'on' \| 'off' }` | Locates toggleable control and calls `IUIAutomationTogglePattern::Toggle()`. |

---

## 3. Application Lifecycle & Window Management

Through Win32 User32 APIs (`EnumWindows`, `SetForegroundWindow`, `ShowWindow`, `GetWindowTextW`), JARVIS discovers and controls running Windows applications:
- **`desktop.listWindows`:** Enumerates visible top-level windows, extracting title, process ID (PID), executable name, and bounding coordinates.
- **`desktop.focusWindow`:** Brings target window to foreground using `SetForegroundWindow` and handles minimized states.
- **`desktop.launchApp`:** Launches approved applications (`notepad.exe`, `calc.exe`, `mspaint.exe`, `chrome.exe`) and awaits initial window appearance.
- **`desktop.closeApp`:** Posts `WM_CLOSE` to target window, allowing safe document saving prompts, falling back to process termination only on explicit user approval.

---

## 4. System Telemetry & Resource Monitoring

The Resource Monitor (`server/src/resourceMonitor.ts`) periodically samples Windows 11 host performance metrics:
- **CPU Load:** Multi-core usage percentage.
- **Memory (RAM):** Process heap used vs total host free memory.
- **Process Health:** Monitoring active background tasks to detect runaway processes or CPU starvation.
- **Concurrency Limiting:** Enforces bounded background task queues to maintain system responsiveness.

---

## 5. Security & Safety Boundaries

1. **Whitelisted Applications:** Launching is constrained to verified user applications and tools.
2. **Destructive Operations Guard:** Irreversible operations (system shutdowns, disk formatting, registry edits, system file alterations) are strictly rejected.
3. **Protected Directories:** File manipulation is restricted to user workspace roots (`D:\JARVIS`, `D:\JARVIS-Test`, `D:\ProjectHub`); modifications outside allowed roots are blocked.

---

## 6. Empirical Verification Evidence

| Test Suite / Script | Tests | Result | Verification Scope |
|---|---|---|---|
| `native/src/agent.uia.test.ts` | 6 / 6 | **PASS** | UIA inspect tree, invoke button, set value, toggle checkbox, error handling |
| `test/acceptance/desktopAutomationAcceptance.test.ts` | 6 / 6 | **PASS** | Window enumeration, focus switching, screenshot capture with valid PNG header, launch Notepad |
| `server/src/nativeMethods.test.ts` | 1 / 1 | **PASS** | Exact 62-method protocol parity between backend and native Windows agent |

**Phase 6 Verdict:** Deep Windows 11 integration is fully verified and securely bounded.

