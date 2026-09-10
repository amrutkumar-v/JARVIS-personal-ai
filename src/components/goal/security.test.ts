import { describe, expect, it } from 'vitest'
import goalRunRaw from '../../state/goalRun.ts?raw'
import goalViewRaw from './goalView.ts?raw'
import composerRaw from './GoalComposer.tsx?raw'
import panelRaw from './GoalPanel.tsx?raw'

/**
 * Phase 2.1 — static security/boundary scan of the GOAL UI surface.
 *
 * The Goal UI is a DISPLAY LAYER, never an orchestration layer:
 *   - it NEVER executes anything (no shell, no child_process, no spawn)
 *   - it NEVER creates or drives the engine (no `new AssistantEngine`, no
 *     `ToolRegistry`, no `.generate(` / `.execute(` / provider calls)
 *   - it NEVER manufactures task results: verdict + budget + plan come only
 *     from engine getters mirrored through the store
 *   - it NEVER persists anything (no localStorage / indexedDB / secrets)
 *   - it NEVER writes secrets/API keys to logs
 *   - typed model input (the composer) only ever travels to the engine's
 *     single `process(text)` entry — never to a tool, provider or file
 */

const UI_FILES: Array<[name: string, src: string]> = [
  ['state/goalRun.ts', goalRunRaw],
  ['goal/goalView.ts', goalViewRaw],
  ['goal/GoalComposer.tsx', composerRaw],
  ['goal/GoalPanel.tsx', panelRaw],
]

describe('Phase 2.1 — goal UI boundary scan (display-only rails)', () => {
  it('never executes shell commands, subprocesses or Windows tooling', () => {
    for (const [file, src] of UI_FILES) {
      expect(src, file).not.toMatch(/child_process|\bexec(Sync)?\b|\bspawn(Sync)?\b|\bpowershell\b|\bcmd(\.exe)?\b/i)
    }
  })

  it('never calls a model, a tool executor or the engine directly', () => {
    for (const [file, src] of UI_FILES) {
      // No runtime engine instantiation / registry reach.
      expect(src, file).not.toMatch(/new AssistantEngine|ToolRegistry|from ['"]\.\.\/engine['"]/)
      // No provider or tool-invocation verbs.
      expect(src, file).not.toMatch(/\.generate\(|\.execute\(|chatCompletion|\.chat\(/i)
      // No desktop hand verbs — the UI can never reach the hands.
      expect(src, file).not.toMatch(/\.click\(|moveMouse|keyPress|keyChord|typeText\(|type\(/i)
    }
  })

  it('never makes network or persistence calls', () => {
    for (const [file, src] of UI_FILES) {
      expect(src, file).not.toMatch(/\bfetch\(|WebSocket|XMLHttpRequest|navigator\.sendBeacon/i)
      expect(src, file).not.toMatch(/localStorage|sessionStorage|indexedDB|writeFile|createWriteStream/i)
    }
  })

  it('never logs or stores secrets', () => {
    for (const [file, src] of UI_FILES) {
      expect(src, file).not.toMatch(/console\.(log|error|warn)|api[_-]?key|Bearer|Authorization/i)
    }
  })

  it('mirrors the engine verbatim — the UI never derives a verdict', () => {
    // The panel formats ONLY what the engine evaluated: verdict text comes from
    // `task.reason`, budget/plan from engine getters. No duplicated verdict
    // logic and no fabricated numbers appear in the display layer.
    expect(goalViewRaw).toMatch(/VERDICT_CHIP/)
    expect(panelRaw).toMatch(/presentGoalRun\(/)
    expect(goalViewRaw).not.toMatch(/status\s*[:=]\s*['"](completed|failed)['"]/)
    expect(goalViewRaw).not.toMatch(/finalState/)
  })

  it('HONESTY: the unverified copy is hard-coded, so a quiet run can never look done', () => {
    // Phase 2.0 rule — `finalState === 'completed'` does NOT imply the goal
    // was achieved. The panel must surface the engine's unverified verdict.
    expect(goalViewRaw).toMatch(/NOT declared complete/i)
    expect(goalViewRaw).toMatch(/not claiming/)
  })

  it('the composer only ever routes text to the single engine entry point', () => {
    // Typed input goes to `submit` → `engine.process(text)`. The mode is
    // presentation-only. No provider, tool or file can receive user text.
    // The composer imports ONLY react + the store — zero engine imports.
    expect(composerRaw).toMatch(/onSubmit\(text\)/)
    expect(composerRaw).toMatch(/setGoalMode\(/)
    expect(composerRaw).toMatch(/from 'react'/)
    expect(composerRaw).toMatch(/from '\.\.\/\.\.\/state\/jarvis\.store'/)
    expect(composerRaw).not.toMatch(/from ['"]\.\.\/\.\.\/engine/i)
    expect(composerRaw).not.toMatch(/onSubmit\(text,\s*somethingElse/)
  })

  it('exposes no tool payload values into the presentation model', () => {
    // goalView only shapes the already-sanitized GoalPlanStepView fields.
    expect(goalViewRaw).not.toMatch(/window_id|"x"\s*:|"y"\s*:/)
    expect(goalViewRaw).not.toMatch(/\.payload|payload\)/)
    expect(goalViewRaw).not.toMatch(/arguments\s*:/)
  })
})