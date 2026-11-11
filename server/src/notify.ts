/**
 * Native Windows Background Notifications (Phase C & Phase 10).
 *
 * Sends native Windows notifications when background tasks complete, require
 * user permissions, or encounter failures, using Windows native PowerShell notification APIs.
 * Zero external npm dependencies.
 */

import { spawn } from 'node:child_process'

export interface NotificationPayload {
  title: string
  message: string
  level?: 'info' | 'warn' | 'error' | 'security'
}

export function sendWindowsNotification(payload: NotificationPayload): void {
  if (process.platform !== 'win32') return

  const cleanTitle = payload.title.replace(/["`$]/g, '')
  const cleanMessage = payload.message.replace(/["`$]/g, '')
  const tipIcon =
    payload.level === 'error'
      ? 'Error'
      : payload.level === 'warn' || payload.level === 'security'
        ? 'Warning'
        : 'Info'

  // PowerShell script using System.Windows.Forms.NotifyIcon for reliable, zero-dependency tray notification
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::${tipIcon}
$notify.BalloonTipTitle = "${cleanTitle}"
$notify.BalloonTipText = "${cleanMessage}"
$notify.Visible = $True
$notify.ShowBalloonTip(5000)
Start-Sleep -Milliseconds 500
$notify.Dispose()
`

  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      {
        windowsHide: true,
        stdio: 'ignore',
        detached: true,
      },
    )
    child.unref()
  } catch {
    // Non-blocking fallback; never fail task execution due to notification issues
  }
}

