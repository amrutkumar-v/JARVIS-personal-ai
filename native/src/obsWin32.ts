import * as koffiNS from 'koffi'
import type * as koffiTypes from 'koffi'

/**
 * Node's ESM↔CJS interop only makes a LEAF SUBSET of the koffi addon's named
 * exports statically visible on the namespace; `load` lives on the CJS
 * `module.exports` object reachable via `.default`. Resolve the full runtime
 * surface once so every call below is a real member.
 */
const koffi = (koffiNS as unknown as { default?: typeof koffiNS }).default ?? koffiNS
import { nativeError } from './errors.js'
import { OBS_LIMITS } from './obsLimits.js'
import { encodeBgraPng } from './png.js'
import type { NativeScreenshotResult, NativeWindowStatusResult, NativeWindowSummary } from './protocol.js'
import type { ObservationBackend } from './observation.js'

/**
 * Native Windows Agent — GDI/user32 observation bridge (Phase 1.4).
 *
 * EYES, NOT HANDS: this layer can only READ the desktop. It enumerates
 * top-level windows and captures the primary screen using the Win32 API via
 * koffi FFI — there is no shell, no process-listing utility, no injected
 * command of any kind, and no way to synthesize input or move windows.
 *
 * - koffi is loaded lazily on first use; when it cannot load the bridge
 *   reports `native_unavailable` honestly instead of crashing the agent.
 * - On non-Windows platforms every operation answers `unsupported`.
 * - HWNDs are opaque engine objects in koffi, so handles are declared as
 *   `uint64` (JS BigInt); their decimal string form is the SAFE serialized
 *   window id the caller validates with `WINDOW_ID_PATTERN`.
 * - A screenshot is a bounded, top-down BGRA read through BitBlt + GetDIBits,
 *   PNG-encoded in-process; oversize results are `too_large`, never silently
 *   truncated.
 */

/** Hard ceiling on how many ceilings ... windows we read metadata for in one pass. */
const HARD_ENUMERATION_CAP = 2000

const SM_CXSCREEN = 0
const SM_CYSCREEN = 1
const SRCCOPY = 0x00cc0020
const BI_RGB = 0
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/** Pointer-to-callback type used by EnumWindows (created once, shared). */
function enumCallbackType(): koffiTypes.IKoffiCType {
  const BOOL = koffi.alias('BOOL', 'int')
  const HWND = koffi.alias('HWND', 'uint64')
  const Fn = koffi.pointer(koffi.proto(BOOL, [HWND, 'void *']))
  koffi.alias('WNDENUMPROC', Fn)
  return Fn
}

/** The tiny typed surface of the Win32 calls this bridge needs. */
interface Win32Obs {
  EnumWindows(callback: unknown, lParam: null): void
  enumCbType: koffiTypes.IKoffiCType
  IsWindow(hwnd: bigint): boolean
  GetWindowTextW(hwnd: bigint): string
  IsWindowVisible(hwnd: bigint): boolean
  IsIconic(hwnd: bigint): boolean
  IsZoomed(hwnd: bigint): boolean
  GetWindowRect(hwnd: bigint): { left: number; top: number; right: number; bottom: number } | null
  getClientBounds(hwnd: bigint): { left: number; top: number; right: number; bottom: number } | null
  GetWindowThreadProcessId(hwnd: bigint): number
  GetSystemMetrics(index: number): number
  processImageName(pid: number): string | undefined
  screenSize(): { width: number; height: number }
  captureBgra(width: number, height: number): Buffer
}

let api: Win32Obs | null = null
let apiFailure: Error | null = null

/** Load + declare once; cached. Failures are sticky and honest. */
function getApi(): Win32Obs {
  if (api) return api
  if (apiFailure) throw apiFailure
  if (process.platform !== 'win32') {
    apiFailure = nativeError('unsupported', 'Window observation is only available on Windows.')
    throw apiFailure
  }

  let user32: koffiTypes.IKoffiLib
  let gdi32: koffiTypes.IKoffiLib
  let kernel32: koffiTypes.IKoffiLib
  try {
    user32 = koffi.load('user32.dll')
    gdi32 = koffi.load('gdi32.dll')
    kernel32 = koffi.load('kernel32.dll')
  } catch (error) {
    apiFailure = nativeError('native_unavailable', `The Win32 observation libraries could not be loaded: ${explain(error)}`)
    throw apiFailure
  }

  try {
    const cbType = enumCallbackType()
    // Win32 handle types are all pointer-sized opaque values (BigInt).
    koffi.alias('HDC', 'uint64')
    koffi.alias('HBITMAP', 'uint64')
    koffi.alias('HGDIOBJ', 'uint64')
    koffi.alias('HANDLE', 'uint64')

    const EnumWindowsFn = user32.func('uint EnumWindows(WNDENUMPROC callback, void *lParam)')
    const IsWindowFn = user32.func('BOOL IsWindow(HWND hwnd)')
    const GetWindowTextWFn = user32.func('int GetWindowTextW(HWND hwnd, char16_t *lpString, int nMaxCount)')
    const IsWindowVisibleFn = user32.func('BOOL IsWindowVisible(HWND hwnd)')
    const IsIconicFn = user32.func('BOOL IsIconic(HWND hwnd)')
    const IsZoomedFn = user32.func('BOOL IsZoomed(HWND hwnd)')
    const GetWindowRectFn = user32.func('BOOL GetWindowRect(HWND hwnd, void *rect)')
    const GetWindowThreadProcessIdFn = user32.func('uint GetWindowThreadProcessId(HWND hwnd, uint *processId)')
    const GetSystemMetricsFn = user32.func('int GetSystemMetrics(int nIndex)')
    const GetDCFn = user32.func('HDC GetDC(HWND hwnd)')
    const ReleaseDCFn = user32.func('int ReleaseDC(HWND hwnd, HDC hdc)')
    const CreateCompatibleDCFn = gdi32.func('HDC CreateCompatibleDC(HDC hdc)')
    const SelectObjectFn = gdi32.func('HGDIOBJ SelectObject(HDC hdc, HGDIOBJ h)')
    const CreateCompatibleBitmapFn = gdi32.func('HBITMAP CreateCompatibleBitmap(HDC hdc, int w, int h)')
    const BitBltFn = gdi32.func('BOOL BitBlt(HDC hdcDest, int x, int y, int w, int h, HDC hdcSrc, int x1, int y1, uint rop)')
    const GetDIBitsFn = gdi32.func('int GetDIBits(HDC hdc, HBITMAP hbm, uint start, uint cLines, void *lpvBits, void *lpbi, uint usage)')
    const DeleteObjectFn = gdi32.func('int DeleteObject(HGDIOBJ h)')
    const DeleteDCFn = gdi32.func('int DeleteDC(HDC hdc)')
    const OpenProcessFn = kernel32.func('HANDLE OpenProcess(uint dwDesiredAccess, int bInheritHandle, uint dwProcessId)')
    const QueryFullProcessImageNameFn = kernel32.func(
      'BOOL QueryFullProcessImageNameW(HANDLE hProcess, uint dwFlags, char16_t *lpExeName, uint *lpdwSize)',
    )
    const CloseHandleFn = kernel32.func('BOOL CloseHandle(HANDLE h)')

    const GetClientRectFn = user32.func('BOOL GetClientRect(HWND hwnd, void *rect)')
    const ClientToScreenFn = user32.func('BOOL ClientToScreen(HWND hwnd, void *point)')

    const readWindowText = (hwnd: bigint): string => {
      const title = new Uint16Array(OBS_LIMITS.MAX_WINDOW_TITLE_LENGTH + 1)
      const len = GetWindowTextWFn(hwnd, title, OBS_LIMITS.MAX_WINDOW_TITLE_LENGTH + 1)
      if (typeof len !== 'number' || len <= 0) return ''
      const end = title.indexOf(0)
      const chars = end === -1 ? title.slice(0, len) : title.slice(0, end)
      return Buffer.from(chars.buffer).toString('utf16le').slice(0, OBS_LIMITS.MAX_WINDOW_TITLE_LENGTH)
    }

    const windowRect = (hwnd: bigint): { left: number; top: number; right: number; bottom: number } | null => {
      const rect = new Int32Array(4)
      const ok = GetWindowRectFn(hwnd, rect)
      if (!ok) return null
      return { left: rect[0], top: rect[1], right: rect[2], bottom: rect[3] }
    }

    const clientBounds = (hwnd: bigint): { left: number; top: number; right: number; bottom: number } | null => {
      const rect = new Int32Array(4)
      const okRect = GetClientRectFn(hwnd, rect)
      if (!okRect) return null
      const topLeft = new Int32Array(2)
      topLeft[0] = 0
      topLeft[1] = 0
      const okTl = ClientToScreenFn(hwnd, topLeft)
      if (!okTl) return null
      const bottomRight = new Int32Array(2)
      bottomRight[0] = rect[2]
      bottomRight[1] = rect[3]
      const okBr = ClientToScreenFn(hwnd, bottomRight)
      if (!okBr) return null
      return { left: topLeft[0], top: topLeft[1], right: bottomRight[0], bottom: bottomRight[1] }
    }

    const pidOf = (hwnd: bigint): number => {
      const pid = new Uint32Array(1)
      GetWindowThreadProcessIdFn(hwnd, pid)
      return pid[0]
    }

    const processImageName = (pid: number): string | undefined => {
      if (!Number.isFinite(pid) || pid <= 0) return undefined
      const handle = OpenProcessFn(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
      if (handle == null || handle === 0n) return undefined
      try {
        const size = new Uint32Array(1)
        size[0] = 260
        const exe = new Uint16Array(260)
        const ok = QueryFullProcessImageNameFn(handle, 0, exe, size)
        if (!ok) return undefined
        const used = size[0]
        const chars = used > 0 && used <= exe.length ? exe.slice(0, used) : exe
        const path = Buffer.from(chars.buffer).toString('utf16le')
        const name = path.split('\\').pop() ?? ''
        return name.length > 0 ? name : undefined
      } finally {
        CloseHandleFn(handle)
      }
    }

    const screenSize = (): { width: number; height: number } => ({
      width: GetSystemMetricsFn(SM_CXSCREEN),
      height: GetSystemMetricsFn(SM_CYSCREEN),
    })

    const captureBgra = (width: number, height: number): Buffer => {
      const rowBytes = width * 4
      const bmi = Buffer.alloc(40)
      bmi.writeUInt32LE(40, 0)
      bmi.writeInt32LE(width, 4)
      bmi.writeInt32LE(-height, 8)
      bmi.writeUInt16LE(1, 12)
      bmi.writeUInt16LE(32, 14)
      bmi.writeUInt32LE(BI_RGB, 16)

      const screenDc = GetDCFn(0n)
      if (screenDc == null || screenDc === 0n) throw nativeError('io_error', 'A device context for the screen could not be acquired.')
      const memDc = CreateCompatibleDCFn(screenDc)
      if (memDc == null || memDc === 0n) {
        ReleaseDCFn(0n, screenDc)
        throw nativeError('io_error', 'A compatible device context could not be created.')
      }
      const hbm = CreateCompatibleBitmapFn(screenDc, width, height)
      if (hbm == null || hbm === 0n) {
        DeleteDCFn(memDc)
        ReleaseDCFn(0n, screenDc)
        throw nativeError('io_error', 'A compatible bitmap could not be created.')
      }
      const previous = SelectObjectFn(memDc, hbm)
      try {
        const ok = BitBltFn(memDc, 0, 0, width, height, screenDc, 0, 0, SRCCOPY)
        if (!ok) throw nativeError('io_error', 'The screen capture bit block transfer failed.')
        const raw = Buffer.alloc(rowBytes * height)
        const lines = GetDIBitsFn(memDc, hbm, 0, height, raw, bmi, BI_RGB)
        if (typeof lines !== 'number' || lines !== height) {
          throw nativeError('io_error', `The screen capture could not be read back (${typeof lines === 'number' ? lines : 'unknown'} rows).`)
        }
        return raw
      } finally {
        if (previous) SelectObjectFn(memDc, previous)
        DeleteObjectFn(hbm)
        DeleteDCFn(memDc)
        ReleaseDCFn(0n, screenDc)
      }
    }

    api = {
      enumCbType: cbType,
      EnumWindows(callback, lParam) {
        return EnumWindowsFn(callback, lParam)
      },
      IsWindow(hwnd) {
        return !!IsWindowFn(hwnd)
      },
      GetWindowTextW: readWindowText,
      IsWindowVisible(hwnd) {
        return !!IsWindowVisibleFn(hwnd)
      },
      IsIconic(hwnd) {
        return !!IsIconicFn(hwnd)
      },
      IsZoomed(hwnd) {
        return !!IsZoomedFn(hwnd)
      },
      GetWindowRect: windowRect,
      getClientBounds: clientBounds,
      GetWindowThreadProcessId: pidOf,
      GetSystemMetrics(index) {
        return GetSystemMetricsFn(index)
      },
      processImageName,
      screenSize,
      captureBgra,
    }

    return api
  } catch (error) {
    apiFailure = nativeError('native_unavailable', `The Win32 observation bridge failed to initialize: ${explain(error)}`)
    throw apiFailure
  }
}

function explain(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function readSummary(hwnd: bigint): NativeWindowSummary {
  const title = api!.GetWindowTextW(hwnd)
  const pid = api!.GetWindowThreadProcessId(hwnd)
  return {
    windowId: hwnd.toString(),
    title,
    pid: pid > 0 ? pid : undefined,
    processName: api!.processImageName(pid),
    visible: api!.IsWindowVisible(hwnd),
    minimized: api!.IsIconic(hwnd),
    maximized: api!.IsZoomed(hwnd),
    bounds: api!.GetWindowRect(hwnd) ?? undefined,
    clientBounds: api!.getClientBounds(hwnd) ?? undefined,
  }
}

/** Enumerate top-level windows: visible first, then title — bounded + deterministic. */
export function listWindows(): NativeWindowSummary[] {
  const obs = getApi()
  const collected: NativeWindowSummary[] = []
  const callback = koffi.register(
    (hwnd: bigint) => {
      if (collected.length < HARD_ENUMERATION_CAP) {
        if (obs.IsWindow(hwnd)) collected.push(readSummary(hwnd))
      }
      return 1
    },
    obs.enumCbType,
  )
  try {
    obs.EnumWindows(callback, null)
  } finally {
    koffi.unregister(callback)
  }
  return sortWindows(collected).slice(0, OBS_LIMITS.MAX_WINDOWS)
}

/** Deterministic order: visible windows first, then by title. */
function sortWindows(windows: NativeWindowSummary[]): NativeWindowSummary[] {
  return [...windows].sort((a, b) => {
    if (a.visible !== b.visible) return a.visible ? -1 : 1
    return a.title.localeCompare(b.title)
  })
}

/** Inspect one window by its validated decimal id; disappeared windows are `not_found`. */
export function getWindowStatus(windowId: string): NativeWindowStatusResult {
  const obs = getApi()
  let hwnd: bigint
  try {
    hwnd = BigInt(windowId)
  } catch {
    throw nativeError('malformed', 'Invalid "windowId".')
  }
  if (!obs.IsWindow(hwnd)) {
    throw nativeError('not_found', `Window "${windowId}" no longer exists.`, windowId)
  }
  const summary = readSummary(hwnd)
  return {
    windowId: summary.windowId,
    exists: true,
    title: summary.title,
    pid: summary.pid,
    processName: summary.processName,
    visible: summary.visible,
    minimized: summary.minimized,
    maximized: summary.maximized,
    bounds: summary.bounds,
    clientBounds: summary.clientBounds,
  }
}

/** Capture the ENTIRE primary screen; never crops, never downscales. */
export function captureScreenshot(): NativeScreenshotResult {
  const obs = getApi()
  const started = Date.now()
  const { width, height } = obs.screenSize()
  if (width < 1 || height < 1) {
    throw nativeError('io_error', 'The screen has no measurable size.')
  }
  if (width > OBS_LIMITS.MAX_SCREENSHOT_WIDTH || height > OBS_LIMITS.MAX_SCREENSHOT_HEIGHT) {
    throw nativeError('too_large', `The screen (${width}x${height}) exceeds the supported capture size.`)
  }
  const bgra = obs.captureBgra(width, height)
  // Raw pixels are transient and never shipped — the memory budget is
  // dims-derived; the SHIPPED artifact is bounded by MAX_SCREENSHOT_BYTES.
  if (bgra.length > OBS_LIMITS.MAX_RAW_CAPTURE_BYTES) {
    throw nativeError('too_large', 'The raw capture exceeds the memory budget.')
  }
  const png = encodeBgraPng(width, height, bgra)
  if (png.length > OBS_LIMITS.MAX_SCREENSHOT_BYTES) {
    throw nativeError('too_large', 'The encoded screenshot exceeds the screenshot byte limit.')
  }
  const elapsed = Date.now() - started
  if (elapsed > OBS_LIMITS.MAX_CAPTURE_TIME_MS) {
    throw nativeError('timeout', 'The screen capture took too long.')
  }
  return {
    width,
    height,
    format: 'png',
    bytesLength: png.length,
    bytes: png.toString('base64'),
  }
}

/**
 * The ObservationBackend implementation the PRODUCTION agent wires. Serviceable
 * on any platform: non-Windows answers a structured `unsupported` and a broken
 * FFI load answers `native_unavailable` — observation is never faked.
 */
export class RealObsBackend implements ObservationBackend {
  readonly id = 'real-obs'

  async listWindows(): Promise<NativeWindowSummary[]> {
    return listWindows()
  }

  async getWindowStatus(windowId: string): Promise<NativeWindowStatusResult> {
    return getWindowStatus(windowId)
  }

  async captureScreenshot(): Promise<NativeScreenshotResult> {
    return captureScreenshot()
  }
}