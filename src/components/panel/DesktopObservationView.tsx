import { useCallback, useEffect, useState } from 'react'
import type { ObservationProvider, ScreenshotResult, WindowSummary } from '../../observation'
import type { DesktopProvider } from '../../desktop'

interface Props {
  observation?: ObservationProvider
  desktop?: DesktopProvider
}

/**
 * Native Desktop Observation & Interaction HUD View (Phase 4).
 *
 * Displays live desktop inventory:
 * - Active foreground application and window
 * - Full list of top-level open windows with quick focus/minimize/maximize controls
 * - Real on-demand desktop screenshot capture with verifiable resolution and image preview
 */
export function DesktopObservationView({ observation, desktop }: Props) {
  const [windows, setWindows] = useState<WindowSummary[]>([])
  const [screenshot, setScreenshot] = useState<ScreenshotResult | null>(null)
  const [loadingWindows, setLoadingWindows] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshWindows = useCallback(async () => {
    if (!observation) return
    setLoadingWindows(true)
    try {
      const list = await observation.listWindows()
      setWindows(list.filter((w) => w.visible && !w.minimized && w.title?.trim().length > 0))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to query open windows.')
    } finally {
      setLoadingWindows(false)
    }
  }, [observation])

  const captureScreen = useCallback(async () => {
    if (!observation) return
    setCapturing(true)
    setActionMessage('Capturing desktop screenshot...')
    try {
      const shot = await observation.captureScreenshot()
      setScreenshot(shot)
      setActionMessage(`Captured screenshot (${shot.width}x${shot.height}, ${shot.format.toUpperCase()})`)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to capture screenshot.')
    } finally {
      setCapturing(false)
    }
  }, [observation])

  const handleFocus = useCallback(
    async (windowId: string, title: string) => {
      if (!desktop) return
      try {
        const res = await desktop.focusWindow(windowId)
        setActionMessage(res.focused ? `Focused "${title}"` : `Could not focus "${title}": ${res.detail}`)
        await refreshWindows()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Focus action failed.')
      }
    },
    [desktop, refreshWindows],
  )

  const handleMinimize = useCallback(
    async (windowId: string, title: string) => {
      if (!desktop) return
      try {
        const res = await desktop.minimizeWindow(windowId)
        setActionMessage(res.success ? `Minimized "${title}"` : `Could not minimize "${title}"`)
        await refreshWindows()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Minimize action failed.')
      }
    },
    [desktop, refreshWindows],
  )

  const handleMaximize = useCallback(
    async (windowId: string, title: string) => {
      if (!desktop) return
      try {
        const res = await desktop.maximizeWindow(windowId)
        setActionMessage(res.success ? `Maximized "${title}"` : `Could not maximize "${title}"`)
        await refreshWindows()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Maximize action failed.')
      }
    },
    [desktop, refreshWindows],
  )

  useEffect(() => {
    void refreshWindows()
    const timer = setInterval(() => void refreshWindows(), 4000)
    return () => clearInterval(timer)
  }, [refreshWindows])

  const activeFg = windows.find((w) => w.isForeground)

  return (
    <div className="desktop-observation-view" style={{ padding: '10px 12px', fontSize: '11px', color: 'var(--text-secondary)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <span style={{ fontWeight: 600, letterSpacing: '0.14em', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: '10px' }}>
          DESKTOP OBSERVATION
        </span>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            type="button"
            onClick={() => void refreshWindows()}
            disabled={loadingWindows}
            style={{
              background: 'hsl(var(--accent-h) var(--accent-s) var(--accent-l) / 0.1)',
              border: '1px solid var(--glass-border-medium)',
              color: 'var(--accent)',
              padding: '3px 8px',
              borderRadius: 'var(--radius-xs, 4px)',
              cursor: 'pointer',
              fontSize: '10px',
              fontFamily: 'var(--font-mono)',
              transition: 'all 0.15s ease',
            }}
          >
            {loadingWindows ? 'Scanning...' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={() => void captureScreen()}
            disabled={capturing}
            style={{
              background: 'hsl(42 96% 58% / 0.12)',
              border: '1px solid hsl(42 96% 58% / 0.35)',
              color: 'var(--warning)',
              padding: '3px 8px',
              borderRadius: 'var(--radius-xs, 4px)',
              cursor: 'pointer',
              fontSize: '10px',
              fontFamily: 'var(--font-mono)',
              transition: 'all 0.15s ease',
            }}
          >
            {capturing ? 'Capturing...' : 'Screenshot'}
          </button>
        </div>
      </div>

      {actionMessage && (
        <div style={{ background: 'hsl(145 72% 48% / 0.12)', borderLeft: '2px solid var(--success)', padding: '5px 8px', marginBottom: '8px', fontSize: '10.5px', borderRadius: '0 4px 4px 0', color: 'var(--text-primary)' }}>
          {actionMessage}
        </div>
      )}

      {error && (
        <div style={{ background: 'hsl(0 75% 55% / 0.12)', borderLeft: '2px solid var(--error)', padding: '5px 8px', marginBottom: '8px', fontSize: '10.5px', borderRadius: '0 4px 4px 0', color: 'var(--error)' }}>
          {error}
        </div>
      )}

      {activeFg && (
        <div style={{ background: 'var(--glass-bg-subtle)', border: '1px solid var(--glass-border-subtle)', borderRadius: 'var(--radius-sm, 6px)', padding: '8px', marginBottom: '10px' }}>
          <div style={{ fontSize: '9px', textTransform: 'uppercase', color: 'var(--accent)', letterSpacing: '0.12em', fontFamily: 'var(--font-mono)' }}>Active Foreground Window</div>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginTop: '2px' }}>{activeFg.title}</div>
          <div style={{ color: 'var(--text-faint)', fontSize: '10px', fontFamily: 'var(--font-mono)', marginTop: '2px' }}>Process: {activeFg.processName} · PID: {activeFg.pid}</div>
        </div>
      )}

      {screenshot && (
        <div style={{ background: 'rgba(0, 0, 0, 0.4)', border: '1px solid var(--glass-border-subtle)', borderRadius: 'var(--radius-sm, 6px)', padding: '8px', marginBottom: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
            <span style={{ color: 'var(--warning)', fontSize: '10px', fontFamily: 'var(--font-mono)' }}>Verified Screen Capture</span>
            <span style={{ color: 'var(--text-faint)', fontSize: '9px', fontFamily: 'var(--font-mono)' }}>{screenshot.width}x{screenshot.height} PNG</span>
          </div>
          <img
            src={`data:image/png;base64,${screenshot.bytes}`}
            alt="Desktop Screenshot"
            style={{ width: '100%', maxHeight: '140px', objectFit: 'contain', borderRadius: '4px', border: '1px solid var(--glass-border-faint)' }}
          />
        </div>
      )}

      <div style={{ marginTop: '8px' }}>
        <div style={{ fontSize: '10px', color: '#88aacc', marginBottom: '4px', textTransform: 'uppercase' }}>
          Open Application Windows ({windows.length})
        </div>
        <div style={{ maxHeight: '180px', overflowY: 'auto' }}>
          {windows.map((w) => (
            <div
              key={w.windowId}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '4px 6px',
                marginBottom: '3px',
                background: w.isForeground ? 'rgba(0, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                borderLeft: w.isForeground ? '3px solid #00ffff' : '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '2px',
              }}
            >
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '6px', flex: 1 }}>
                <span style={{ color: '#fff', fontWeight: w.isForeground ? 'bold' : 'normal' }}>{w.title}</span>
                <span style={{ color: '#6688aa', fontSize: '9px', marginLeft: '6px' }}>({w.processName})</span>
              </div>
              <div style={{ display: 'flex', gap: '3px' }}>
                <button
                  type="button"
                  onClick={() => void handleFocus(w.windowId, w.title)}
                  title="Focus Window"
                  style={{ background: 'transparent', border: '1px solid #00ffff', color: '#00ffff', fontSize: '9px', padding: '1px 5px', cursor: 'pointer', borderRadius: '2px' }}
                >
                  Focus
                </button>
                <button
                  type="button"
                  onClick={() => void handleMinimize(w.windowId, w.title)}
                  title="Minimize Window"
                  style={{ background: 'transparent', border: '1px solid #888', color: '#aaa', fontSize: '9px', padding: '1px 4px', cursor: 'pointer', borderRadius: '2px' }}
                >
                  _
                </button>
                <button
                  type="button"
                  onClick={() => void handleMaximize(w.windowId, w.title)}
                  title="Maximize Window"
                  style={{ background: 'transparent', border: '1px solid #888', color: '#aaa', fontSize: '9px', padding: '1px 4px', cursor: 'pointer', borderRadius: '2px' }}
                >
                  []
                </button>
              </div>
            </div>
          ))}
          {windows.length === 0 && !loadingWindows && (
            <div style={{ color: '#6688aa', fontStyle: 'italic', padding: '8px 0' }}>No open windows detected.</div>
          )}
        </div>
      </div>
    </div>
  )
}

