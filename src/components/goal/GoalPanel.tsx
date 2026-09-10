import { useJarvisStore } from '../../state/jarvis.store'
import { presentGoalRun } from './goalView'

/**
 * Phase 2.1 — the goal run view: budget, verdict, evidence and the full plan.
 *
 * Presents EXACTLY what the engine computed (via the store mirror) — it never
 * re-derives a verdict. Step states carry a text label AND a glyph so the
 * meaning never depends on color alone. `aria-live` surfaces the verdict to
 * assistive tech without stealing focus.
 */
export function GoalPanel() {
  const snapshot = useJarvisStore.use.goalRun()
  const view = presentGoalRun(snapshot)

  if (!view.showPlan) return null

  return (
    <section
      className={`goal-panel goal-kind-${view.kind}`}
      role="region"
      aria-label="Goal run"
      aria-live="polite"
    >
      <header className="goal-panel-head">
        <span className="goal-panel-title">{view.planLabel}</span>
        {view.replanActive ? (
          <span className="goal-panel-replanning" role="status">
            replanning…
          </span>
        ) : null}
        {view.goal ? (
          <span className="goal-panel-goal" title={view.goal}>
            {view.goal}
          </span>
        ) : null}
      </header>

      {view.verdict ? (
        <div className={`goal-verdict goal-verdict-${view.verdict.status}`} data-status={view.verdict.status}>
          <span className="goal-verdict-title">{view.verdict.title}</span>
          <span className="goal-verdict-detail">{view.verdict.detail}</span>
        </div>
      ) : null}

      <div className="goal-budget" aria-label={view.budgetText} title={view.budgetText}>
        <div className="goal-budget-track">
          <div className="goal-budget-fill" style={{ width: `${Math.round(view.budgetRatio * 100)}%` }} />
        </div>
        <span className="goal-budget-text">{view.budgetText}</span>
      </div>

      {view.recoveryText ? (
        <p className="goal-recovery" role="status">
          {view.recoveryText}
        </p>
      ) : null}

      {view.steps.length > 0 ? (
        <ol className="goal-steps">
          {view.steps.map((line, i) => (
            <li className={`goal-step goal-step-${line.state}`} data-state={line.state} key={`${line.toolId}-${i}`}>
              <span className="goal-step-sign" aria-hidden="true">
                {line.signGlyph}
              </span>
              <span className="goal-step-action">{line.action}</span>
              <span className="goal-step-state">{line.label}</span>
              {line.capability ? (
                <span className="goal-step-capability" title={`Capability: ${line.capability}`}>
                  {line.capability}
                </span>
              ) : null}
              {line.capabilityMeta ? (
                <span
                  className={`goal-step-meta goal-step-meta-risk-${line.capabilityMeta.risk}`}
                  title={`Risk: ${line.capabilityMeta.risk} · Permission: ${line.capabilityMeta.permission} · Verification preference: ${line.capabilityMeta.verification}${line.capabilityMeta.requiresConfirmation ? ' · Requires confirmation' : ''}`}
                >
                  risk:{line.capabilityMeta.risk}
                  {line.capabilityMeta.requiresConfirmation ? ' confirm' : ''}
                </span>
              ) : null}
              {line.attempts > 0 ? (
                <span className="goal-step-attempts">x{line.attempts}</span>
              ) : null}
              {line.evidence ? (
                <span className="goal-step-evidence" title={line.evidence}>
                  {line.evidence}
                </span>
              ) : null}
              {line.note ? (
                <span className="goal-step-note" title={line.note}>
                  {line.note}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}