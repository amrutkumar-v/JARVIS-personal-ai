import { useState, useMemo, useEffect, useCallback } from 'react'
import { useJarvisStore } from '../../state/jarvis.store'
import type { PersistentTask, Subtask, TaskLifecycleState } from '../../engine/tasks/types'
import { BackendClient } from '../../backend/BackendClient'

interface Props {
  backendClient?: BackendClient | null
  onPauseTask?: (taskId: string) => Promise<boolean>
  onResumeTask?: (taskId: string) => Promise<boolean>
  onCancelTask?: (taskId: string) => Promise<boolean>
  onApproveAction?: (taskId: string, approvalId: string) => Promise<boolean>
  onRejectAction?: (taskId: string, approvalId: string, reason?: string) => Promise<boolean>
}

export function TaskMonitorPanel({
  backendClient,
  onPauseTask,
  onResumeTask,
  onCancelTask,
  onApproveAction,
  onRejectAction,
}: Props) {
  const persistentTasks = useJarvisStore.use.persistentTasks()
  const activeTaskId = useJarvisStore.use.activeTaskId()
  const setActiveTaskId = useJarvisStore((s) => s.setActiveTaskId)
  const setPersistentTasks = useJarvisStore((s) => s.mergePersistentTasks)

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(activeTaskId)
  const [filter, setFilter] = useState<'all' | 'active' | 'completed' | 'failed'>('all')
  const [busyAction, setBusyAction] = useState<string | null>(null)

  // Polling backend /api/tasks periodically as a fallback if SSE isn't active
  useEffect(() => {
    if (!backendClient) return
    let active = true
    const fetchTasks = async () => {
      try {
        const tasks = await backendClient.getTasks()
        if (active && tasks.length > 0) {
          setPersistentTasks(tasks)
        }
      } catch {
        // Silent catch
      }
    }
    fetchTasks()
    const interval = setInterval(fetchTasks, 5000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [backendClient, setPersistentTasks])

  const filteredTasks = useMemo(() => {
    return persistentTasks.filter((t) => {
      if (filter === 'active') {
        return ['EXECUTING', 'QUEUED', 'PLANNING', 'VALIDATING', 'APPROVED', 'OBSERVING', 'VERIFYING', 'WAITING_FOR_PERMISSION', 'PAUSED'].includes(t.state)
      }
      if (filter === 'completed') {
        return t.state === 'COMPLETED'
      }
      if (filter === 'failed') {
        return t.state === 'FAILED' || t.state === 'CANCELLED' || t.state === 'RECOVERY_REQUIRED'
      }
      return true
    })
  }, [persistentTasks, filter])

  const selectedTask = useMemo(() => {
    if (selectedTaskId) {
      const match = persistentTasks.find((t) => t.id === selectedTaskId)
      if (match) return match
    }
    const active = persistentTasks.find((t) => ['EXECUTING', 'QUEUED', 'WAITING_FOR_PERMISSION'].includes(t.state))
    return active || persistentTasks[0] || null
  }, [persistentTasks, selectedTaskId])

  const stats = useMemo(() => {
    const total = persistentTasks.length
    const executing = persistentTasks.filter((t) => t.state === 'EXECUTING' || t.state === 'OBSERVING' || t.state === 'VERIFYING').length
    const queued = persistentTasks.filter((t) => t.state === 'QUEUED' || t.state === 'APPROVED').length
    const waitingPerm = persistentTasks.filter((t) => t.state === 'WAITING_FOR_PERMISSION').length
    const completed = persistentTasks.filter((t) => t.state === 'COMPLETED').length
    const failed = persistentTasks.filter((t) => t.state === 'FAILED' || t.state === 'CANCELLED').length
    return { total, executing, queued, waitingPerm, completed, failed }
  }, [persistentTasks])

  const handlePause = useCallback(async (taskId: string) => {
    setBusyAction('pause')
    try {
      if (onPauseTask) {
        await onPauseTask(taskId)
      } else if (backendClient) {
        await backendClient.pauseTask(taskId)
      }
    } finally {
      setBusyAction(null)
    }
  }, [onPauseTask, backendClient])

  const handleResume = useCallback(async (taskId: string) => {
    setBusyAction('resume')
    try {
      if (onResumeTask) {
        await onResumeTask(taskId)
      } else if (backendClient) {
        await backendClient.resumeTask(taskId)
      }
    } finally {
      setBusyAction(null)
    }
  }, [onResumeTask, backendClient])

  const handleCancel = useCallback(async (taskId: string) => {
    setBusyAction('cancel')
    try {
      if (onCancelTask) {
        await onCancelTask(taskId)
      } else if (backendClient) {
        await backendClient.cancelTask(taskId)
      }
    } finally {
      setBusyAction(null)
    }
  }, [onCancelTask, backendClient])

  const handleApprove = useCallback(async (taskId: string, approvalId: string) => {
    setBusyAction(`approve-${approvalId}`)
    try {
      if (onApproveAction) {
        await onApproveAction(taskId, approvalId)
      } else if (backendClient) {
        await backendClient.approveTask(taskId, approvalId)
      }
    } finally {
      setBusyAction(null)
    }
  }, [onApproveAction, backendClient])

  const handleReject = useCallback(async (taskId: string, approvalId: string) => {
    setBusyAction(`reject-${approvalId}`)
    try {
      if (onRejectAction) {
        await onRejectAction(taskId, approvalId, 'Rejected by operator in Task Monitor')
      } else if (backendClient) {
        await backendClient.rejectTask(taskId, approvalId, 'Rejected by operator in Task Monitor')
      }
    } finally {
      setBusyAction(null)
    }
  }, [onRejectAction, backendClient])

  return (
    <section className="panel task-monitor-panel" aria-label="Task Monitor" style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12, padding: 12, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--hairline)', paddingBottom: 8 }}>
        <h2 className="panel-title" style={{ margin: 0 }}>TASK ORCHESTRATOR</h2>
        <div style={{ display: 'flex', gap: 6, fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
          <span style={{ color: 'var(--text-faint)' }}>ACTIVE: <strong style={{ color: 'var(--executing)' }}>{stats.executing}</strong></span>
          <span style={{ color: 'var(--text-faint)' }}>QUEUED: <strong style={{ color: 'var(--accent)' }}>{stats.queued}</strong></span>
          {stats.waitingPerm > 0 && (
            <span style={{ color: 'var(--warning)', fontWeight: 'bold' }}>APPROVAL: {stats.waitingPerm}</span>
          )}
          <span style={{ color: 'var(--text-faint)' }}>DONE: <strong style={{ color: 'var(--success)' }}>{stats.completed}</strong></span>
        </div>
      </div>

      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 6 }}>
        {(['all', 'active', 'completed', 'failed'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setFilter(tab)}
            style={{
              flex: 1,
              padding: '4px 6px',
              fontSize: '10px',
              fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase',
              background: filter === tab ? 'hsl(var(--accent-h) var(--accent-s) var(--accent-l) / 0.16)' : 'transparent',
              color: filter === tab ? 'var(--accent)' : 'var(--text-faint)',
              border: filter === tab ? '1px solid var(--accent)' : '1px solid var(--hairline)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Main content: Task List + Selected Task Details */}
      {persistentTasks.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '30px 10px', color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
          <p>No persistent tasks registered.</p>
          <p style={{ fontSize: '10px', marginTop: 6 }}>
            Run an autonomous goal or say: <br />
            <code>"JARVIS, fix my ProjectHub project..."</code>
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
          {/* Task selector badges */}
          <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
            {filteredTasks.map((t) => {
              const isSelected = t.id === (selectedTask?.id ?? selectedTaskId)
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setSelectedTaskId(t.id)
                    setActiveTaskId(t.id)
                  }}
                  style={{
                    padding: '4px 8px',
                    borderRadius: 4,
                    fontSize: '10px',
                    fontFamily: 'var(--font-mono)',
                    whiteSpace: 'nowrap',
                    cursor: 'pointer',
                    background: isSelected ? 'hsl(var(--accent-h) var(--accent-s) var(--accent-l) / 0.22)' : 'hsl(var(--accent-h) var(--accent-s) var(--accent-l) / 0.05)',
                    border: isSelected ? '1px solid var(--accent)' : '1px solid var(--hairline)',
                    color: isSelected ? 'var(--text-primary)' : 'var(--text-faint)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <StatePill state={t.state} mini />
                  <span>{t.title.length > 20 ? t.title.slice(0, 20) + '...' : t.title}</span>
                </button>
              )
            })}
          </div>

          {/* Selected Task Detail View */}
          {selectedTask && (
            <TaskDetailView
              task={selectedTask}
              busyAction={busyAction}
              onPause={handlePause}
              onResume={handleResume}
              onCancel={handleCancel}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          )}
        </div>
      )}
    </section>
  )
}

function TaskDetailView({
  task,
  busyAction,
  onPause,
  onResume,
  onCancel,
  onApprove,
  onReject,
}: {
  task: PersistentTask
  busyAction: string | null
  onPause: (taskId: string) => Promise<void>
  onResume: (taskId: string) => Promise<void>
  onCancel: (taskId: string) => Promise<void>
  onApprove: (taskId: string, approvalId: string) => Promise<void>
  onReject: (taskId: string, approvalId: string) => Promise<void>
}) {
  const totalSubtasks = task.subtasks.length
  const verifiedSubtasks = task.subtasks.filter((s) => s.state === 'VERIFIED').length
  const progressPercent = totalSubtasks > 0 ? Math.round((verifiedSubtasks / totalSubtasks) * 100) : 0

  const canPause = ['EXECUTING', 'QUEUED', 'OBSERVING', 'VERIFYING'].includes(task.state)
  const canResume = ['PAUSED', 'RECOVERY_REQUIRED'].includes(task.state)
  const canCancel = ['EXECUTING', 'QUEUED', 'PAUSED', 'WAITING_FOR_PERMISSION', 'OBSERVING', 'VERIFYING'].includes(task.state)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: 'rgba(0,0,0,0.25)', border: '1px solid var(--hairline)', borderRadius: 6, padding: 10 }}>
      {/* Title & State Banner */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
            {task.title}
          </div>
          <div style={{ fontSize: '10px', color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
            ID: <code>{task.id}</code> · Priority: {task.priority} · Recoveries: {task.recoveryCount}/{task.maxRecoveries}
          </div>
        </div>
        <StatePill state={task.state} />
      </div>

      {/* Objective */}
      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.02)', padding: '6px 8px', borderRadius: 4, borderLeft: '2px solid var(--accent)' }}>
        {typeof task.objective === 'string' ? task.objective : String(task.objective ?? '')}
      </div>

      {/* Specialist Worker Summary (Phase 10/11) */}
      {Boolean(task.metadata?.specialistSummary) && (
        <div
          style={{
            fontSize: '10px',
            fontFamily: 'var(--font-mono)',
            background: 'hsl(196 90% 50% / 0.08)',
            border: '1px solid var(--accent)',
            borderRadius: 4,
            padding: '6px 8px',
            color: 'var(--text-primary)',
          }}
        >
          <div style={{ fontWeight: 600, color: 'var(--accent)', marginBottom: 2 }}>SPECIALIST WORKER SYNTHESIS</div>
          <div>{String(task.metadata.specialistSummary)}</div>
        </div>
      )}

      {/* Real Progress Bar */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9.5px', fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', marginBottom: 3 }}>
          <span>VERIFIED PROGRESS</span>
          <span>{verifiedSubtasks} / {totalSubtasks} steps ({progressPercent}%)</span>
        </div>
        <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
          <div
            style={{
              height: '100%',
              width: `${progressPercent}%`,
              background: task.state === 'FAILED' ? 'var(--error)' : progressPercent === 100 ? 'var(--success)' : 'var(--accent)',
              transition: 'width 0.3s ease',
            }}
          />
        </div>
      </div>

      {/* Objective Verification Status & Proof */}
      {task.state === 'COMPLETED' && Boolean(task.metadata?.completionEvidence) && (
        <div
          style={{
            fontSize: '10px',
            fontFamily: 'var(--font-mono)',
            background: 'hsl(142 70% 45% / 0.1)',
            border: '1px solid var(--success)',
            borderRadius: 4,
            padding: '6px 8px',
            color: 'var(--text-primary)',
          }}
        >
          <div style={{ fontWeight: 600, color: 'var(--success)', marginBottom: 2 }}>
            OBJECTIVE VERIFICATION: VERIFIED
          </div>
          {Array.isArray((task.metadata?.completionEvidence as any)?.files) && (task.metadata?.completionEvidence as any).files.length > 0 && (
            <div style={{ color: 'var(--text-secondary)' }}>
              Files on disk: {(task.metadata.completionEvidence as any).files.map((f: any) => `${f.path} (${f.bytes}B)`).join(', ')}
            </div>
          )}
          {Array.isArray((task.metadata?.completionEvidence as any)?.executions) && (task.metadata?.completionEvidence as any).executions.length > 0 && (
            <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>
              Execution verified: {(task.metadata.completionEvidence as any).executions.map((e: any) => `${e.command} (exit ${e.exitCode})`).join(', ')}
            </div>
          )}
        </div>
      )}

      {task.state === 'FAILED' && Boolean(task.error) && (
        <div
          style={{
            fontSize: '10px',
            fontFamily: 'var(--font-mono)',
            background: 'hsl(0 70% 50% / 0.1)',
            border: '1px solid var(--error)',
            borderRadius: 4,
            padding: '6px 8px',
            color: 'var(--error)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>OBJECTIVE VERIFICATION: BLOCKED / FAILED</div>
          <div>{String(task.error)}</div>
        </div>
      )}

      {/* Action Controls */}
      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
        {canPause && (
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => onPause(task.id)}
            style={{
              padding: '4px 10px',
              fontSize: '10px',
              fontFamily: 'var(--font-mono)',
              background: 'transparent',
              color: 'var(--warning)',
              border: '1px solid var(--warning)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {busyAction === 'pause' ? 'PAUSING...' : 'PAUSE'}
          </button>
        )}
        {canResume && (
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => onResume(task.id)}
            style={{
              padding: '4px 10px',
              fontSize: '10px',
              fontFamily: 'var(--font-mono)',
              background: 'var(--accent)',
              color: '#000',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontWeight: 'bold',
            }}
          >
            {busyAction === 'resume' ? 'RESUMING...' : 'RESUME'}
          </button>
        )}
        {canCancel && (
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => onCancel(task.id)}
            style={{
              padding: '4px 10px',
              fontSize: '10px',
              fontFamily: 'var(--font-mono)',
              background: 'transparent',
              color: 'var(--error)',
              border: '1px solid var(--error)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {busyAction === 'cancel' ? 'CANCELLING...' : 'CANCEL'}
          </button>
        )}
      </div>

      {/* Pending Approvals */}
      {task.requiredApprovals.length > 0 && (
        <div style={{ background: 'hsl(38 90% 50% / 0.1)', border: '1px solid var(--warning)', borderRadius: 4, padding: 8 }}>
          <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--warning)', fontFamily: 'var(--font-mono)', marginBottom: 6 }}>
            APPROVAL REQUIRED (DEFAULT-DENY POLICY)
          </div>
          {task.requiredApprovals.map((req) => (
            <div key={req.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
              <div style={{ fontSize: '11px', color: 'var(--text-primary)' }}>{req.description}</div>
              <div style={{ fontSize: '9.5px', fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>
                Action: <code>{req.action}</code> {req.toolId ? `(${req.toolId})` : ''} · Impact: {req.impact}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => onApprove(task.id, req.id)}
                  style={{
                    padding: '3px 8px',
                    fontSize: '9.5px',
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--success)',
                    color: '#000',
                    fontWeight: 'bold',
                    border: 'none',
                    borderRadius: 3,
                    cursor: 'pointer',
                  }}
                >
                  APPROVE
                </button>
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => onReject(task.id, req.id)}
                  style={{
                    padding: '3px 8px',
                    fontSize: '9.5px',
                    fontFamily: 'var(--font-mono)',
                    background: 'transparent',
                    color: 'var(--error)',
                    border: '1px solid var(--error)',
                    borderRadius: 3,
                    cursor: 'pointer',
                  }}
                >
                  REJECT
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Subtasks Execution Checklist */}
      <div>
        <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', marginBottom: 6 }}>
          STRUCTURED SUBTASKS
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {task.subtasks.map((sub, idx) => (
            <SubtaskRow key={sub.id} subtask={sub} index={idx + 1} />
          ))}
        </div>
      </div>

      {/* Checkpoints & Evidence */}
      {task.checkpoints.length > 0 && (
        <div>
          <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', marginBottom: 6 }}>
            VERIFIED CHECKPOINTS ({task.checkpoints.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 120, overflowY: 'auto' }}>
            {task.checkpoints.map((cp) => (
              <div key={cp.checkpointId} style={{ fontSize: '9.5px', fontFamily: 'var(--font-mono)', background: 'rgba(255,255,255,0.02)', padding: '4px 6px', borderRadius: 3, borderLeft: '2px solid var(--success)' }}>
                <div style={{ color: 'var(--success)' }}>✓ Step {cp.subtaskIndex + 1}: {cp.summary}</div>
                <div style={{ color: 'var(--text-faint)' }}>{new Date(cp.timestamp).toLocaleTimeString()} · Hash: {cp.executionStateHash.slice(0, 8)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SubtaskRow({ subtask, index }: { subtask: Subtask; index: number }) {
  const isVerified = subtask.state === 'VERIFIED'
  const isRunning = subtask.state === 'EXECUTING'
  const isFailed = subtask.state === 'FAILED'

  let stateColor = 'var(--text-faint)'
  if (isVerified) stateColor = 'var(--success)'
  if (isRunning) stateColor = 'var(--executing)'
  if (isFailed) stateColor = 'var(--error)'

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        background: isRunning ? 'hsl(196 90% 50% / 0.08)' : 'rgba(255,255,255,0.02)',
        border: isRunning ? '1px solid var(--executing)' : '1px solid rgba(255,255,255,0.05)',
        borderRadius: 4,
        padding: '6px 8px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontSize: '10px' }}>{index}.</span>
          <span>{subtask.title}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {subtask.workerRole && (
            <span
              style={{
                fontSize: '8px',
                fontFamily: 'var(--font-mono)',
                padding: '1px 4px',
                borderRadius: 2,
                background:
                  subtask.workerRole === 'researcher'
                    ? 'hsl(196 90% 50% / 0.15)'
                    : subtask.workerRole === 'coder'
                    ? 'hsl(38 90% 50% / 0.15)'
                    : subtask.workerRole === 'verifier'
                    ? 'hsl(140 70% 50% / 0.15)'
                    : 'rgba(255,255,255,0.06)',
                color:
                  subtask.workerRole === 'researcher'
                    ? 'var(--accent)'
                    : subtask.workerRole === 'coder'
                    ? 'var(--warning)'
                    : subtask.workerRole === 'verifier'
                    ? 'var(--success)'
                    : 'var(--text-faint)',
                border: '1px solid rgba(255,255,255,0.1)',
                textTransform: 'uppercase',
              }}
            >
              {subtask.workerRole}
            </span>
          )}
          <span
            style={{
              fontSize: '8.5px',
              fontFamily: 'var(--font-mono)',
              padding: '1px 5px',
              borderRadius: 3,
              background: `hsl(var(--accent-h) var(--accent-s) var(--accent-l) / 0.1)`,
              color: stateColor,
              border: `1px solid ${stateColor}`,
              fontWeight: 'bold',
            }}
          >
            {subtask.state}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, fontSize: '9px', fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', marginTop: 2 }}>
        <span>Tool: <code>{subtask.capability}</code></span>
        {subtask.dependencies.length > 0 && (
          <span>Depends: {subtask.dependencies.join(', ')}</span>
        )}
      </div>

      {subtask.verification?.evidence && (
        <div style={{ fontSize: '9.5px', color: 'var(--success)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
          Evidence: {subtask.verification.evidence}
        </div>
      )}

      {subtask.result?.error && (
        <div style={{ fontSize: '9.5px', color: 'var(--error)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
          Error: {subtask.result.error}
        </div>
      )}
    </div>
  )
}

function StatePill({ state, mini = false }: { state: TaskLifecycleState; mini?: boolean }) {
  let color = 'var(--accent)'
  let bg = 'hsl(var(--accent-h) var(--accent-s) var(--accent-l) / 0.12)'

  if (state === 'COMPLETED') {
    color = 'var(--success)'
    bg = 'hsl(140 70% 50% / 0.12)'
  } else if (state === 'FAILED' || state === 'CANCELLED') {
    color = 'var(--error)'
    bg = 'hsl(0 70% 50% / 0.12)'
  } else if (state === 'EXECUTING') {
    color = 'var(--executing)'
    bg = 'hsl(196 90% 50% / 0.16)'
  } else if (state === 'PAUSED' || state === 'WAITING_FOR_PERMISSION' || state === 'RECOVERY_REQUIRED') {
    color = 'var(--warning)'
    bg = 'hsl(38 90% 50% / 0.16)'
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: mini ? '1px 4px' : '2px 6px',
        borderRadius: 3,
        fontSize: mini ? '8px' : '9.5px',
        fontFamily: 'var(--font-mono)',
        fontWeight: 'bold',
        color,
        background: bg,
        border: `1px solid ${color}`,
        letterSpacing: '0.04em',
      }}
    >
      {state}
    </span>
  )
}

