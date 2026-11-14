/**
 * Native Windows Agent — UI Automation (UIA) Backend (Phase 7).
 *
 * Implements semantic UI Automation tree inspection and pattern control
 * (Invoke, Value, Toggle) over Windows UI Automation (UIAutomationClient).
 */

import { spawn } from 'node:child_process'

export interface UiaElementSummary {
  automationId: string
  name: string
  controlType: string
  className: string
  boundingRect: { x: number; y: number; width: number; height: number }
  isEnabled: boolean
  isKeyboardFocusable: boolean
  supportedPatterns: string[]
  children?: UiaElementSummary[]
}

export interface UiaInspectResult {
  ok: boolean
  target: string
  root: UiaElementSummary | null
  elementCount: number
  error?: string
}

export interface UiaActionResult {
  ok: boolean
  action: 'invoke' | 'setValue' | 'toggle'
  target: string
  message: string
  value?: string
}

export interface UiaSelector {
  automationId?: string
  name?: string
  controlType?: string
  className?: string
}

export interface UiaBackend {
  readonly supported: boolean
  inspect(windowIdOrPid: string, options?: { maxDepth?: number; maxElements?: number }): Promise<UiaInspectResult>
  invoke(windowIdOrPid: string, selector: UiaSelector): Promise<UiaActionResult>
  setValue(windowIdOrPid: string, selector: UiaSelector, value: string): Promise<UiaActionResult>
  toggle(windowIdOrPid: string, selector: UiaSelector): Promise<UiaActionResult>
}

/**
 * Real Windows UI Automation backend using .NET UIAutomationClient.
 */
export class RealUiaBackend implements UiaBackend {
  readonly supported: boolean

  constructor() {
    this.supported = process.platform === 'win32'
  }

  async inspect(windowIdOrPid: string, options: { maxDepth?: number; maxElements?: number } = {}): Promise<UiaInspectResult> {
    if (!this.supported) {
      return { ok: false, target: windowIdOrPid, root: null, elementCount: 0, error: 'UI Automation is only supported on Windows.' }
    }

    const maxDepth = Math.max(1, Math.min(6, options.maxDepth ?? 3))
    const maxElements = Math.max(10, Math.min(200, options.maxElements ?? 60))

    const psScript = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$target = "${windowIdOrPid}"
$element = $null
if ($target -match '^[0-9]+$') {
  $val = [int64]$target
  try {
    $element = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$val)
  } catch {}
  if (-not $element) {
    try {
      $proc = Get-Process -Id $val -ErrorAction SilentlyContinue
      if ($proc -and $proc.MainWindowHandle -ne 0) {
        $element = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
      }
    } catch {}
  }
}
if (-not $element) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $target)
  $element = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
if (-not $element) {
  Write-Output '{"error":"Window target not found"}'
  exit 0
}

function Get-Node($el, $depth, $maxD) {
  if (-not $el -or $depth -gt $maxD) { return $null }
  $rect = $el.Current.BoundingRectangle
  $patterns = @()
  foreach ($p in $el.GetSupportedPatterns()) {
    $patterns += $p.ProgrammaticName.Replace("PatternIdentifiers.Pattern", "")
  }
  $obj = [ordered]@{
    automationId = $el.Current.AutomationId
    name = $el.Current.Name
    controlType = $el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "")
    className = $el.Current.ClassName
    boundingRect = @{
      x = [int]$rect.X
      y = [int]$rect.Y
      width = [int]$rect.Width
      height = [int]$rect.Height
    }
    isEnabled = [bool]$el.Current.IsEnabled
    isKeyboardFocusable = [bool]$el.Current.IsKeyboardFocusable
    supportedPatterns = $patterns
    children = @()
  }
  if ($depth -lt $maxD) {
    $children = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $count = [Math]::Min($children.Count, ${maxElements})
    for ($i = 0; $i -lt $count; $i++) {
      $childNode = Get-Node $children[$i] ($depth + 1) $maxD
      if ($childNode) { $obj.children += $childNode }
    }
  }
  return $obj
}

$tree = Get-Node $element 0 ${maxDepth}
ConvertTo-Json -Depth 8 -Compress $tree
`

    try {
      const output = await this.runPs(psScript)
      const parsed = JSON.parse(output.trim())
      if (parsed.error) {
        return { ok: false, target: windowIdOrPid, root: null, elementCount: 0, error: parsed.error }
      }
      let count = 0
      const countNodes = (node: UiaElementSummary | null): void => {
        if (!node) return
        count++
        if (node.children) {
          for (const c of node.children) countNodes(c)
        }
      }
      countNodes(parsed as UiaElementSummary)
      return {
        ok: true,
        target: windowIdOrPid,
        root: parsed as UiaElementSummary,
        elementCount: count,
      }
    } catch (err) {
      return { ok: false, target: windowIdOrPid, root: null, elementCount: 0, error: (err as Error).message }
    }
  }

  async invoke(windowIdOrPid: string, selector: UiaSelector): Promise<UiaActionResult> {
    return this.performAction(windowIdOrPid, 'invoke', selector)
  }

  async setValue(windowIdOrPid: string, selector: UiaSelector, value: string): Promise<UiaActionResult> {
    return this.performAction(windowIdOrPid, 'setValue', selector, value)
  }

  async toggle(windowIdOrPid: string, selector: UiaSelector): Promise<UiaActionResult> {
    return this.performAction(windowIdOrPid, 'toggle', selector)
  }

  private async performAction(
    windowIdOrPid: string,
    action: 'invoke' | 'setValue' | 'toggle',
    selector: UiaSelector,
    paramValue = '',
  ): Promise<UiaActionResult> {
    if (!this.supported) {
      return { ok: false, action, target: windowIdOrPid, message: 'UI Automation is only supported on Windows.' }
    }

    const autoId = selector.automationId ? `"${selector.automationId}"` : '$null'
    const name = selector.name ? `"${selector.name}"` : '$null'
    const ctrlType = selector.controlType ? `"${selector.controlType}"` : '$null'

    const psScript = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$target = "${windowIdOrPid}"
$element = $null
if ($target -match '^[0-9]+$') {
  $val = [int64]$target
  try { $element = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$val) } catch {}
  if (-not $element) {
    try {
      $proc = Get-Process -Id $val -ErrorAction SilentlyContinue
      if ($proc -and $proc.MainWindowHandle -ne 0) {
        $element = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
      }
    } catch {}
  }
}
if (-not $element) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $target)
  $element = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}
if (-not $element) {
  Write-Output '{"ok":false,"message":"Window target not found"}'
  exit 0
}

$conds = @()
if (${autoId}) { $conds += New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, ${autoId}) }
if (${name}) { $conds += New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, ${name}) }
if (${ctrlType}) {
  $ct = [System.Windows.Automation.ControlType]::ProgrammaticName
  $field = [System.Windows.Automation.ControlType].GetField(${ctrlType})
  if ($field) {
    $conds += New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $field.GetValue($null))
  }
}

$searchCond = [System.Windows.Automation.Condition]::TrueCondition
if ($conds.Count -eq 1) { $searchCond = $conds[0] }
elseif ($conds.Count -gt 1) { $searchCond = New-Object System.Windows.Automation.AndCondition($conds) }

$ctrl = $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $searchCond)
if (-not $ctrl) {
  Write-Output '{"ok":false,"message":"Target control not found matching selector"}'
  exit 0
}

try {
  if ("${action}" -eq "invoke") {
    $inv = $ctrl.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $inv.Invoke()
    Write-Output '{"ok":true,"message":"Control invoked successfully"}'
  } elseif ("${action}" -eq "setValue") {
    $valPat = $ctrl.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $valPat.SetValue("${paramValue}")
    Write-Output '{"ok":true,"message":"Control value set successfully"}'
  } elseif ("${action}" -eq "toggle") {
    $tog = $ctrl.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $tog.Toggle()
    Write-Output '{"ok":true,"message":"Control toggled successfully"}'
  }
} catch {
  Write-Output ('{"ok":false,"message":"' + $_.Exception.Message.Replace('"', '\\"') + '"}')
}
`
    try {
      const output = await this.runPs(psScript)
      const parsed = JSON.parse(output.trim())
      return {
        ok: Boolean(parsed.ok),
        action,
        target: windowIdOrPid,
        message: parsed.message || (parsed.ok ? 'Action executed' : 'Action failed'),
        value: action === 'setValue' ? paramValue : undefined,
      }
    } catch (err) {
      return {
        ok: false,
        action,
        target: windowIdOrPid,
        message: `Action execution error: ${(err as Error).message}`,
      }
    }
  }

  private runPs(script: string, timeoutMs = 8000): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script])
      let stdout = ''
      let stderr = ''
      let timer: NodeJS.Timeout | null = setTimeout(() => {
        timer = null
        proc.kill()
        reject(new Error(`PowerShell UIA command timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      proc.stdout.on('data', (d) => { stdout += d.toString() })
      proc.stderr.on('data', (d) => { stderr += d.toString() })
      proc.on('close', (code) => {
        if (timer) clearTimeout(timer)
        if (code === 0 || stdout.trim().startsWith('{')) {
          resolve(stdout)
        } else {
          reject(new Error(stderr || `PowerShell exited with code ${code}`))
        }
      })
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer)
        reject(err)
      })
    })
  }
}

/**
 * Fake UIA backend for tests and non-Windows environments.
 */
export class FakeUiaBackend implements UiaBackend {
  readonly supported = true
  elements: Map<string, UiaElementSummary> = new Map()
  actionLog: Array<{ action: string; target: string; selector: UiaSelector; value?: string }> = []

  constructor() {
    this.seedDefaultTree()
  }

  private seedDefaultTree(): void {
    const defaultWindow: UiaElementSummary = {
      automationId: 'MainWindow',
      name: 'Calculator',
      controlType: 'Window',
      className: 'ApplicationFrameWindow',
      boundingRect: { x: 100, y: 100, width: 400, height: 600 },
      isEnabled: true,
      isKeyboardFocusable: true,
      supportedPatterns: ['Window'],
      children: [
        {
          automationId: 'HeaderBar',
          name: 'Standard Calculator',
          controlType: 'Header',
          className: 'LandmarkTarget',
          boundingRect: { x: 100, y: 100, width: 400, height: 40 },
          isEnabled: true,
          isKeyboardFocusable: false,
          supportedPatterns: [],
        },
        {
          automationId: 'num5Button',
          name: 'Five',
          controlType: 'Button',
          className: 'Button',
          boundingRect: { x: 180, y: 350, width: 60, height: 40 },
          isEnabled: true,
          isKeyboardFocusable: true,
          supportedPatterns: ['Invoke'],
        },
        {
          automationId: 'plusButton',
          name: 'Plus',
          controlType: 'Button',
          className: 'Button',
          boundingRect: { x: 260, y: 350, width: 60, height: 40 },
          isEnabled: true,
          isKeyboardFocusable: true,
          supportedPatterns: ['Invoke'],
        },
        {
          automationId: 'equalButton',
          name: 'Equals',
          controlType: 'Button',
          className: 'Button',
          boundingRect: { x: 260, y: 450, width: 60, height: 40 },
          isEnabled: true,
          isKeyboardFocusable: true,
          supportedPatterns: ['Invoke'],
        },
        {
          automationId: 'Display',
          name: 'Display is 0',
          controlType: 'Text',
          className: 'TextBlock',
          boundingRect: { x: 100, y: 150, width: 400, height: 80 },
          isEnabled: true,
          isKeyboardFocusable: true,
          supportedPatterns: ['Value'],
        },
        {
          automationId: 'KeepOnTopToggle',
          name: 'Always on top',
          controlType: 'CheckBox',
          className: 'ToggleButton',
          boundingRect: { x: 340, y: 110, width: 30, height: 30 },
          isEnabled: true,
          isKeyboardFocusable: true,
          supportedPatterns: ['Toggle'],
        },
      ],
    }
    this.elements.set('Calculator', defaultWindow)
    this.elements.set('12345', defaultWindow)
  }

  async inspect(windowIdOrPid: string): Promise<UiaInspectResult> {
    const found = this.elements.get(windowIdOrPid) || this.elements.get('Calculator')
    if (!found) {
      return { ok: false, target: windowIdOrPid, root: null, elementCount: 0, error: 'Target not found in fake UIA' }
    }
    return {
      ok: true,
      target: windowIdOrPid,
      root: found,
      elementCount: 6,
    }
  }

  async invoke(windowIdOrPid: string, selector: UiaSelector): Promise<UiaActionResult> {
    this.actionLog.push({ action: 'invoke', target: windowIdOrPid, selector })
    return {
      ok: true,
      action: 'invoke',
      target: windowIdOrPid,
      message: `Control "${selector.automationId || selector.name || 'unnamed'}" invoked successfully.`,
    }
  }

  async setValue(windowIdOrPid: string, selector: UiaSelector, value: string): Promise<UiaActionResult> {
    this.actionLog.push({ action: 'setValue', target: windowIdOrPid, selector, value })
    return {
      ok: true,
      action: 'setValue',
      target: windowIdOrPid,
      message: `Control "${selector.automationId || selector.name || 'unnamed'}" value set to "${value}".`,
      value,
    }
  }

  async toggle(windowIdOrPid: string, selector: UiaSelector): Promise<UiaActionResult> {
    this.actionLog.push({ action: 'toggle', target: windowIdOrPid, selector })
    return {
      ok: true,
      action: 'toggle',
      target: windowIdOrPid,
      message: `Control "${selector.automationId || selector.name || 'unnamed'}" toggled successfully.`,
    }
  }
}

