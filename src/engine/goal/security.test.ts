import { describe, expect, it } from 'vitest'
import budgetRaw from './budget.ts?raw'
import evidenceRaw from './evidence.ts?raw'
import indexRaw from './index.ts?raw'
import recoveryRaw from './recovery.ts?raw'
import replanRaw from './replan.ts?raw'
import typesRaw from './types.ts?raw'
import validatePlanRaw from './validatePlan.ts?raw'
import capabilityDefaultsRaw from '../capabilities/defaults.ts?raw'
import capabilityIndexRaw from '../capabilities/index.ts?raw'
import capabilityRegistryRaw from '../capabilities/registry.ts?raw'
import capabilityResolveRaw from '../capabilities/resolve.ts?raw'
import capabilityTypesRaw from '../capabilities/types.ts?raw'
import capabilityToDefinitionRaw from '../capabilities/toDefinition.ts?raw'
// Phase 2.4 — capability intelligence modules (rank/policy/reliability) join
// the pure scan: deterministic, content-free, app-owned, no execution.
import capabilityRankRaw from '../capabilities/rank.ts?raw'
import capabilityPolicyRaw from '../capabilities/policy.ts?raw'
import capabilityReliabilityRaw from '../capabilities/reliability.ts?raw'
// Phase 2.6 — real-action classification/layer modules join the pure scan:
// deterministic request routing, policies, execution records and follow-up
// resolution NEVER execute tools, touch the engine/registry, do I/O or log.
import actionTypesRaw from '../action/types.ts?raw'
import actionErrorsRaw from '../action/errors.ts?raw'
import actionRegistryRaw from '../action/registry.ts?raw'
import actionPolicyRaw from '../action/policy.ts?raw'
import actionClassifierRaw from '../action/classifier.ts?raw'
import actionExecutionContextRaw from '../action/executionContext.ts?raw'
import actionFollowUpRaw from '../action/followUp.ts?raw'
import actionMessagesRaw from '../action/messages.ts?raw'
// Phase 2.7 — the camera surface contract is PURE data + deterministic
// classification: capability/permission state and start results, never the
// stream, and never engine/tool/registry access, I/O or logging.
import cameraTypesRaw from '../../camera/types.ts?raw'

/**
 * Phase 2.0 — static security/boundary scan of the goal-execution module.
 *
 * The goal layer is the ORCHESTRATION contract between an untrusted model's
 * plans and the existing execution rails, so it must be pure and inert:
 *   - it NEVER executes tools, talkers, providers or the engine
 *     (validatePlan only READS tool schemas; evidence only READS traces)
 *   - it NEVER performs network I/O, shell access or storage
 *   - it NEVER grants permissions, edits budgets or reads recovery counters
 *     from runtime state — budget limits are engine-owned constants
 *   - it NEVER holds typed secrets / screenshots / credentials (no payload
 *     passthrough; verdicts are structured facts and reason strings)
 *   - the ONLY import, `validateToolArguments`, is the existing engine
 *     argument validator (read-only shape checking)
 */

const PROD_FILES: Array<[name: string, src: string]> = [
  ['index.ts', indexRaw],
  ['types.ts', typesRaw],
  ['budget.ts', budgetRaw],
  ['validatePlan.ts', validatePlanRaw],
  ['evidence.ts', evidenceRaw],
  ['recovery.ts', recoveryRaw],
  ['replan.ts', replanRaw],
  // Phase 2.3 — the capabilities layer is PURE data + deterministic selection;
  // it may never execute tools, reach the engine/tool registry, do I/O, or log.
  ['capabilities/types.ts', capabilityTypesRaw],
  ['capabilities/index.ts', capabilityIndexRaw],
  ['capabilities/defaults.ts', capabilityDefaultsRaw],
  ['capabilities/registry.ts', capabilityRegistryRaw],
  ['capabilities/resolve.ts', capabilityResolveRaw],
  ['capabilities/toDefinition.ts', capabilityToDefinitionRaw],
  // Phase 2.4 — pure capability intelligence: ranking, policy and reliability.
  ['capabilities/rank.ts', capabilityRankRaw],
  ['capabilities/policy.ts', capabilityPolicyRaw],
  ['capabilities/reliability.ts', capabilityReliabilityRaw],
  // Phase 2.6 — pure action layer: classification, policy, context records and
  // messages are read-only determinism; they may never execute tools, reach
  // the engine/tool registry, do I/O, or log.
  ['action/types.ts', actionTypesRaw],
  ['action/errors.ts', actionErrorsRaw],
  ['action/registry.ts', actionRegistryRaw],
  ['action/policy.ts', actionPolicyRaw],
  ['action/classifier.ts', actionClassifierRaw],
  ['action/executionContext.ts', actionExecutionContextRaw],
  ['action/followUp.ts', actionFollowUpRaw],
  ['action/messages.ts', actionMessagesRaw],
  // Phase 2.7 — camera surface contract is pure types + deterministic error
  // mapping; it may never touch the stream, the engine, tools, I/O or network.
  ['camera/types.ts', cameraTypesRaw],
]

describe('Phase 2.0 — goal module boundary scan', () => {
  it('never executes shell commands, processes or Windows tooling', () => {
    for (const [file, src] of PROD_FILES) {
      expect(src, file).not.toMatch(/child_process|\bexecSync\b|\bspawn(Sync)?\b|\bpowershell\b|\bcmd(\.exe)?\b|process\.exec/i)
    }
  })

  it('never performs network I/O on its own', () => {
    for (const [file, src] of PROD_FILES) {
      expect(src, file).not.toMatch(/\.fetch\(|WebSocket|XMLHttpRequest|http\.(get|request)\(/i)
    }
  })

  it('never calls tools, providers or the engine — pure evaluators only', () => {
    for (const [file, src] of PROD_FILES) {
      expect(src, file).not.toMatch(/\.generate\(|\.execute\(|\.getDefinition|\bsendInput\b|\bhandleTool\b|refreshNativeStatus/i)
      expect(src, file).not.toMatch(/AssistantEngine|ToolRegistry/)
    }
  })

  it('never persists to storage or logs secrets', () => {
    for (const [file, src] of PROD_FILES) {
      expect(src, file).not.toMatch(/localStorage|indexedDB|writeFile|appendFile|createWriteStream/i)
      expect(src, file).not.toMatch(/console\.(log|error|warn)/)
    }
  })

  it('has no secret/hard-coded host material', () => {
    for (const [file, src] of PROD_FILES) {
      expect(src, file).not.toMatch(/api[_ -]?key|authorization|bearer /i)
      expect(src, file).not.toMatch(/https?:\/\/[a-z0-9.-]+\.(com|ai|dev|net)/i)
    }
  })

  it('treats a plan as untrusted: rejected steps never self-grant anything', () => {
    // Rejection reasons are generated by constants in validatePlan; nothing in
    // the module can flip a verdict by reading runtime engine state.
    expect(validatePlanRaw).toMatch(/RESERVED_PLAN_PARAMETERS/)
    expect(validatePlanRaw).toMatch(/not a registered tool/)
    for (const [file, src] of PROD_FILES) {
      expect(src, file).not.toMatch(/this\.(taskSteps|recoveries|registry)|engine\./)
    }
  })

it('Phase 2.2 recovery/replan modules are pure policy, not executors', () => {
    // classifyRecovery only maps failure facts to actions; it never reads
    // runtime counters or budgets, never logs inputs, and never touches tools.
    expect(recoveryRaw).toMatch(/never rewrites budgets, history or the plan/i)
    expect(recoveryRaw).toMatch(/consumesBudget/)
    expect(replanRaw).toMatch(/MAX_IDENTICAL_REPLANS/)
    expect(replanRaw).toMatch(/MAX_IDENTICAL_FAILURES/)
    for (const [file, src] of [
      ['recovery.ts', recoveryRaw],
      ['replan.ts', replanRaw],
    ] as Array<[string, string]>) {
      // No runtime engine/tool/registry access, no I/O, no secrets, no URLs.
      expect(src, file).not.toMatch(/this\.|engine\.|ToolRegistry|\.execute\(|\.generate\(/)
      expect(src, file).not.toMatch(/localStorage|writeFile|fetch\(|WebSocket|child_process|execSync/)
      expect(src, file).not.toMatch(/api[_ -]?key|authorization|\bbearer\b/i)
      expect(src, file).not.toMatch(/https?:\/\//)
      // Replan signatures derive from stable payloads, never from prompts.
      if (file === 'replan.ts') {
        expect(src).toMatch(/stableKey\(payload\)/)
        expect(src).toMatch(/requestSignature\(/)
      }
    }
  })

  it('Phase 2.4 rank/policy/reliability are pure, content-free and app-owned', () => {
    // The intelligence layer must never touch tools, engines, I/O or secrets,
    // and must never expose provider-raising knobs to the model.
    for (const [file, src] of [
      ['rank.ts', capabilityRankRaw],
      ['policy.ts', capabilityPolicyRaw],
      ['reliability.ts', capabilityReliabilityRaw],
    ] as Array<[string, string]>) {
      expect(src, file).not.toMatch(/ToolRegistry|AssistantEngine/)
      expect(src, file).not.toMatch(/\.execute\(|\.generate\(|forBrute|sendInput|handleTool/)
      expect(src, file).not.toMatch(/this\.|localStorage|indexedDB|writeFile|appendFile|fetch\(|WebSocket|child_process|execSync|console\./)
      expect(src, file).not.toMatch(/api[_ -]?key|authorization|\bbearer\b/i)
      expect(src, file).not.toMatch(/https?:\/\//)
    }
    // Bounded reliability: counters clamp and the store is content-free.
    expect(capabilityReliabilityRaw).toMatch(/MAX_RELIABILITY_COUNTER/)
    expect(capabilityReliabilityRaw).not.toMatch(/payload|screenshot/)
    // Ranking is deterministic: no randomness, no Math.random.
    expect(capabilityRankRaw).toMatch(/localeCompare/)
    expect(capabilityRankRaw).not.toMatch(/Math\.random|random/)
    // Policy ceiling vocabulary stays bounded (never a provider/model grant).
    expect(capabilityPolicyRaw).toMatch(/CAPABILITY_PERMISSION_ORDER/)
  })
})