import { useJarvisStore } from '../../state/jarvis.store'

/**
 * Subtle task execution indicator.
 * Shows "Step N of M — Running <Tool>..." when a multi-step task is active.
 * Does not re-render the 3D viewport — separate z-layer and selector.
 */
export function TaskIndicator() {
  const task = useJarvisStore.use.task()

  if (!task?.active) return null

  const pct = task.total > 0 ? Math.min(100, Math.round((task.step / task.total) * 100)) : 0

  return (
    <div className="task-indicator" role="status" aria-live="polite" aria-label={`Task in progress: ${task.label}`}>
      <div className="task-bar">
        <div className="task-progress" style={{ width: `${pct}%` }} />
      </div>
      <div className="task-label">
        <span className="task-step">{task.label}</span>
        {task.total > 0 && <span className="task-count">Step {task.step} of {task.total}</span>}
      </div>
    </div>
  )
}