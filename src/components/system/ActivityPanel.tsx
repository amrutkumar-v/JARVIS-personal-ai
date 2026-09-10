import { useJarvisStore } from '../../state/jarvis.store'
import type { ActivityEntry } from '../../state/jarvis.store'

export function ActivityPanel() {
  const activities = useJarvisStore.use.activities()

  return (
    <section className="panel activity-panel" aria-label="System activity">
      <h2 className="panel-title">SYSTEM ACTIVITY</h2>
      {activities.length === 0 ? (
        <p className="panel-empty">No operations yet.</p>
      ) : (
        <ul className="activity-list">
          {activities.slice(0, 8).map((a) => (
            <ActivityRow key={a.id} activity={a} />
          ))}
        </ul>
      )}
    </section>
  )
}

function ActivityRow({ activity }: { activity: ActivityEntry }) {
  return (
    <li className="activity-item" data-status={activity.status}>
      <span className="activity-dot" aria-hidden="true" />
      <span className="activity-body">
        <span className="activity-step">{activity.step}</span>
        <span className="activity-detail">{activity.detail}</span>
      </span>
    </li>
  )
}