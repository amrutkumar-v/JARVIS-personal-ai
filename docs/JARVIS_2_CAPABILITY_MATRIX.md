# JARVIS 2.0 — Capability & Tool Matrix
## Comprehensive Inventory of Supported Capabilities, Tools, and Rails

---

## 1. Overview & Permission Model

JARVIS 2.0 enforces a multi-tiered permission and risk model:

- **`read_only`:** Passive observation, file reading, system status, search, and page reading. Completely non-destructive.
- **`low_risk`:** Standard operations that alter state safely (file creation, app launch, window focus, browser navigation, element click). Verifiable post-action observation required.
- **`action` / `medium`:** Modifying existing files, patching code, running tests, or updating system configurations.
- **`sensitive_action` / `high_risk`:** Destructive actions (permanent file deletion, process tree termination, overwriting critical files). Requires explicit user approval through the HUD.
- **`device_control`:** Hardware, webcam, and system audio control.

---

## 2. Master Capability Matrix

| Category | Capability ID | Tool ID | Risk Level | Permission | Verifiable | Verification Mode | Execution Seam |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Development** | `inspect_project` | `dev.inspectProject` | `read_only` | `read` | Yes | Git status & file inventory | Backend `DevEngine` |
| **Development** | `git_status` | `dev.gitStatus` | `read_only` | `read` | Yes | Git working tree hash check | Backend `DevEngine` |
| **Development** | `git_checkpoint` | `dev.gitCheckpoint` | `low_risk` | `write` | Yes | Commit hash / ref verification | Backend `DevEngine` |
| **Development** | `patch_file` | `dev.patchFile` | `action` | `write` | Yes | SHA-256 pre/post file comparison | Backend `DevEngine` |
| **Development** | `run_project_tests`| `dev.runTests` | `action` | `write` | Yes | Exit code 0 & test summary regex | Backend `DevEngine` / `CPR` |
| **Development** | `audit_project` | `dev.auditProject` | `read_only` | `read` | Yes | AST / lint / security scan | Backend `DevEngine` |
| **Development** | `generate_project_report` | `dev.generateReport` | `read_only` | `read` | Yes | Evidence completeness & hashes | Backend `DevEngine` |
| **Desktop** | `launch_app` | `desktop.launchApp` | `low_risk` | `write` | Yes | Process status & window list | Native Agent `app.launch` |
| **Desktop** | `close_app` | `desktop.closeApp` | `low_risk` | `write` | Yes | Process termination verification | Native Agent `app.close` |
| **Desktop** | `focus_window` | `desktop.focusWindow` | `low_risk` | `write` | Yes | Foreground window PID/title match | Native Agent `window.focus` |
| **Desktop** | `minimize_window` | `window.minimize` | `low_risk` | `write` | Yes | Window state query (minimized) | Native Agent `window.minimize`|
| **Desktop** | `maximize_window` | `window.maximize` | `low_risk` | `write` | Yes | Window state query (maximized) | Native Agent `window.maximize`|
| **Desktop** | `restore_window` | `window.restore` | `low_risk` | `write` | Yes | Window state query (normal) | Native Agent `window.restore` |
| **Desktop** | `list_windows` | `desktop.listWindows` | `read_only` | `read` | Yes | Win32 top-level window array | Native Agent `window.list` |
| **Desktop** | `desktop_screenshot`| `desktop.screenshot` | `read_only` | `read` | Yes | PNG base64 byte array & geometry | Native Agent `desktop.screenshot`|
| **Desktop** | `type_text` | `desktop.type` | `low_risk` | `write` | Yes | Target window input echo | Native Agent `desktop.type` |
| **Desktop** | `calculate` | `desktop.calculate` | `read_only` | `read` | Yes | Mathematical evaluation & input echo | Backend `DesktopEngine` |
| **Browser** | `browser_open` | `browser.open` | `low_risk` | `write` | Yes | Target URL observation | Native Agent / Playwright |
| **Browser** | `browser_navigate` | `browser.navigate` | `low_risk` | `write` | Yes | Document location & title check | Native Agent / Playwright |
| **Browser** | `browser_back` | `browser.back` | `low_risk` | `write` | Yes | History state verification | Native Agent / Playwright |
| **Browser** | `browser_forward` | `browser.forward` | `low_risk` | `write` | Yes | History state verification | Native Agent / Playwright |
| **Browser** | `browser_refresh` | `browser.refresh` | `low_risk` | `write` | Yes | DOM content reload check | Native Agent / Playwright |
| **Browser** | `browser_click` | `browser.click` | `low_risk` | `write` | Yes | Post-click DOM/URL transition | Native Agent / Playwright |
| **Browser** | `browser_type` | `browser.type` | `low_risk` | `write` | Yes | Input value match check | Native Agent / Playwright |
| **Browser** | `browser_read_page` | `browser.readPage` | `read_only` | `read` | Yes | Non-empty text content bounded | Native Agent / Playwright |
| **Browser** | `browser_search` | `browser.search` | `read_only` | `read` | Yes | DuckDuckGo search results array | Native Agent / Playwright |
| **Browser** | `browser_screenshot`| `browser.screenshot` | `read_only` | `read` | Yes | Viewport PNG base64 capture | Native Agent / Playwright |
| **Browser** | `browser_close` | `browser.close` | `low_risk` | `write` | Yes | Context/process termination | Native Agent / Playwright |
| **Web** | `web_search` | `web.search` | `read_only` | `read` | Yes | Search query response parsing | Native Agent `web.search` |
| **Web** | `web_fetch` | `web.fetch` | `read_only` | `read` | Yes | HTML text extraction & length | Native Agent `web.fetch` |
| **Web** | `web_download` | `web.download` | `action` | `write` | Yes | File existence and byte count | Native Agent `web.download` |
| **Vision** | `visual_inspect` | `desktop.visualInspect` | `read_only` | `read` | Yes | Detected bounding box array | Vision Provider / Native Obs |
| **Vision** | `visual_click` | `desktop.visualClick` | `low_risk` | `write` | Yes | Closed-loop `verifyVisualTransition`| Vision / Desktop Provider |
| **Vision** | `visual_type` | `desktop.visualType` | `low_risk` | `write` | Yes | Focused element text verification | Vision / Desktop Provider |
| **Documents** | `doc_parse` | `doc.parse` | `read_only` | `read` | Yes | Structured `ParsedDocument` tree | Backend `DocumentParser` |
| **Documents** | `doc_summarize` | `doc.summarize` | `read_only` | `read` | Yes | Grounded section summaries | Backend `DocumentChunker` |
| **Data** | `data_analyze` | `data.analyze` | `read_only` | `read` | Yes | Statistical metrics (mean, stdDev, IQR)| Backend `DataAnalysisTools` |
| **Data** | `data_chart` | `data.chart` | `read_only` | `read` | Yes | Valid Chart.js / Vega-Lite schema | Backend `DataAnalysisTools` |
| **Artifacts** | `artifact_dashboard`| `artifact.dashboard` | `read_only` | `read` | Yes | Valid HTML / CSS / DOM structure | Backend `ArtifactEngine` |
| **Artifacts** | `artifact_spec` | `artifact.spec` | `read_only` | `read` | Yes | Markdown spec with Mermaid diagram | Backend `ArtifactEngine` |
| **Artifacts** | `artifact_export` | `artifact.exportCsv` | `read_only` | `read` | Yes | RFC-compliant CSV line parsing | Backend `ArtifactEngine` |
| **System** | `system_info` | `system.info` | `read_only` | `read` | Yes | Platform, architecture, CPU count | Native Agent `system.identity` |
| **System** | `system_ping` | `system.ping` | `read_only` | `read` | Yes | IPC roundtrip latency check | Native Agent `system.ping` |
| **Clipboard** | `read_clipboard` | `clipboard.read` | `read_only` | `read` | Yes | Clipboard text retrieval | Native Agent `clipboard.read` |
| **Clipboard** | `write_clipboard` | `clipboard.write` | `low_risk` | `write` | Yes | Clipboard content verification | Native Agent `clipboard.write`|
| **Productivity** | `schedule_reminder`| `schedule.create` | `low_risk` | `write` | Yes | Scheduler store registration | AssistantEngine Scheduler |

---

## 3. Tool Verification Contract

Every verifiable tool must provide a deterministic `verify` handler matching the following signature:

```typescript
verify(input: ToolInput, result: ToolResult, context: ToolContext): Promise<ToolVerification>
```

A tool result is only promoted to `VERIFIED` when:
1. `result.ok === true`
2. `verification.passed === true`
3. `typeof verification.evidence === 'string' && verification.evidence.trim().length > 0`

If verification fails or is absent on a verifiable tool, the `PersistentTaskOrchestrator` flags the step as unproven, enters deterministic recovery, and refuses to mark the overall task as `COMPLETED`.

