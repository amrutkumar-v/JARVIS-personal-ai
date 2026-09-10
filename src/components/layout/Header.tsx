import { useEffect, useState } from 'react'
import { APP } from '../../config/app'
import type { JarvisStatus } from '../../engine/types'
import { StatusChip } from '../system/StatusChip'

interface Props {
  status: JarvisStatus
  onOpenSettings: () => void
}

export function Header({ status, onOpenSettings }: Props) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const date = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

  return (
    <header className="jarvis-topbar">
      <div className="brand" aria-label="JARVIS">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">{APP.name}</span>
        <span className="brand-phase">v{APP.version}</span>
      </div>

      <div className="topbar-right">
        <StatusChip status={status} />
        <div className="clock" aria-label={`Local time ${time}`}>
          <span className="clock-time">{time}</span>
          <span className="clock-date">{date}</span>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Open settings"
          onClick={onOpenSettings}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.46V21a2 2 0 1 1-4 0v-.09a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.76.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.46-.97H3a2 2 0 1 1 0-4h.09A1.6 1.6 0 0 0 4.6 9.4a1.6 1.6 0 0 0-.32-1.76l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 .97-1.46V3a2 2 0 1 1 4 0v.09a1.6 1.6 0 0 0 .97 1.46 1.6 1.6 0 0 0 1.76-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.46.97H21a2 2 0 1 1 0 4h-.09a1.6 1.6 0 0 0-1.46.97Z" />
          </svg>
        </button>
      </div>
    </header>
  )
}