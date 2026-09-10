import { useJarvisStore } from '../../state/jarvis.store'

export function Notices() {
  const notices = useJarvisStore.use.notices()
  const dismiss = useJarvisStore((s) => s.dismissNotice)

  if (notices.length === 0) return null

  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map((n) => (
        <button
          key={n.id}
          type="button"
          className={`notice notice-${n.kind}`}
          onClick={() => dismiss(n.id)}
          aria-label={`Dismiss: ${n.text}`}
        >
          <span className="notice-dot" aria-hidden="true" />
          <span className="notice-text">{n.text}</span>
        </button>
      ))}
    </div>
  )
}