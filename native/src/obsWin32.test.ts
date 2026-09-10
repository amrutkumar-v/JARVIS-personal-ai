import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { OBS_LIMITS } from './obsLimits.js'
import { WINDOW_ID_PATTERN, NATIVE_METHODS } from './protocol.js'

/**
 * Phase 1.4 — structural safety invariants for the observation bridge.
 *
 * EYES, NOT HANDS: this module statically locks in the guarantees that make the
 * bridge auditable from source alone — no child_process/exec/tasklist/shell,
 * no way for the bridge to launch or script the desktop, and an ID charset
 * that can never carry a path, pointer or command.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const obsSource = readFileSync(join(__dirname, 'obsWin32.ts'), 'utf8')

describe('obsWin32.ts — no shell, no hands', () => {
  it('never spawns a child process or shell (child_process is absent)', () => {
    expect(obsSource).not.toMatch(/child_process/)
    expect(obsSource).not.toMatch(/\bexec(File)?\(/)
    expect(obsSource).not.toMatch(/\bspawn\(/)
    expect(obsSource).not.toMatch(/powershell|cmd\.exe|wmic|tasklist/)
  })

  it('only ever arms read-only Win32 verbs (no input synthesis or window control)', () => {
    const forbidden = [
      /SendInput/,
      /mouse_event|keybd_event/,
      /SetForegroundWindow|SetWindowPos|MoveWindow|ShowWindow|SetFocus/,
      /PostMessage|SendMessage/,
      /CreateProcess(Ex)?W/,
      /ShellExecute/,
    ]
    for (const pattern of forbidden) {
      expect(obsSource, pattern.toString()).not.toMatch(pattern)
    }
    // The observation verbs we DO call are present.
    expect(obsSource).toMatch(/GetWindowTextW/)
    expect(obsSource).toMatch(/BitBlt/)
    expect(obsSource).toMatch(/EnumWindows/)
    // Phase 1.8 client-area measurement is read-only geometry too.
    expect(obsSource).toMatch(/GetClientRect/)
    expect(obsSource).toMatch(/ClientToScreen/)
  })

  it('defines the observation bounds once, and they are strictly positive', () => {
    expect(OBS_LIMITS.MAX_WINDOWS).toBeGreaterThan(0)
    expect(OBS_LIMITS.MAX_SCREENSHOT_BYTES).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(OBS_LIMITS.MAX_CAPTURE_TIME_MS).toBeGreaterThan(0)
  })
})

describe('window.* wire identity', () => {
  it('limits the id charset to plain decimal digits (no path, pointer or command)', () => {
    for (const bad of ['0x1A2B', 'abc', '12/34', 'C:\\windows', 'cmd.exe', '-1', '1.5', ' 12 ', '12345678901']) {
      expect(WINDOW_ID_PATTERN.test(bad), bad).toBe(false)
    }
    for (const good of ['1', '12', '1234567890']) {
      expect(WINDOW_ID_PATTERN.test(good), good).toBe(true)
    }
  })

  it('adds exactly the observation methods to the allow-list', () => {
    for (const method of ['window.list', 'window.status', 'desktop.screenshot']) {
      expect(NATIVE_METHODS).toContain(method)
    }
    expect(NATIVE_METHODS).not.toContain('desktop.execute')
    expect(NATIVE_METHODS).not.toContain('window.execute')
    expect(NATIVE_METHODS).not.toContain('ui.automate')
    expect(NATIVE_METHODS).not.toContain('system.execute')
  })
})