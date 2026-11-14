/**
 * Controlled Specialist Worker Pool & Delegation System (Phase 10).
 *
 * Implements bounded worker delegation under PersistentTaskOrchestrator:
 * - researcher: read-only tools, web search, document intelligence, data analysis.
 * - coder: software development, local test execution, bounded workspace patching.
 * - verifier: test runners, linters, checksum verification, audit operations.
 *
 * Enforces parent-child subtask lineage tracking and structured result aggregation.
 */

import type { SpecialistWorkerRole, Subtask, WorkerConstraint, WorkerLineage } from './types'

export interface WorkerPolicy {
  role: SpecialistWorkerRole
  description: string
  readOnlyOnly: boolean
  allowedToolPatterns: RegExp[]
  deniedToolPatterns: RegExp[]
}

export const SPECIALIST_WORKER_POLICIES: Record<SpecialistWorkerRole, WorkerPolicy> = {
  researcher: {
    role: 'researcher',
    description: 'Knowledge retrieval, document intelligence, web research, and data analysis. Zero filesystem or system mutations.',
    readOnlyOnly: true,
    allowedToolPatterns: [
      /^web\./,
      /^doc\./,
      /^data\./,
      /^browser\.(readPage|search|extractContent|screenshot)$/,
      /^email\.(list|get)$/,
      /^calendar\.(list|conflicts)$/,
      /^git\.(status|diff|log)$/,
      /^filesystem\.(read|list|search|stat)$/,
      /^(read_file_contents|list_directory|search_files|get_file_info)$/,
      /^(perform_calculation|system_info|notes)$/,
    ],
    deniedToolPatterns: [
      /^dev\.patchFile$/,
      /^dev\.gitCheckpoint$/,
      /^filesystem\.(write|delete|move|rename|mkdir|copy)$/,
      /^browser\.(click|type|fillForm|download)$/,
      /^email\.(send|draft)$/,
      /^calendar\.(create|update|delete)$/,
      /^git\.commit$/,
      /^(write_file|delete_file|run_command|execute_shell)$/,
    ],
  },
  coder: {
    role: 'coder',
    description: 'Autonomous software engineering, workspace patching, and test suite execution within approved workspace roots.',
    readOnlyOnly: false,
    allowedToolPatterns: [
      /^dev\./,
      /^filesystem\./,
      /^git\.(status|diff|log)$/,
      /^(read_file_contents|write_file|patch_file|run_command|list_directory)$/,
      /^data\./,
      /^doc\./,
    ],
    deniedToolPatterns: [
      /^email\.send$/,
      /^calendar\.delete$/,
      /^browser\.(click|fillForm)$/,
    ],
  },
  verifier: {
    role: 'verifier',
    description: 'Independent verification, audit analysis, test execution, and checksum confirmation of other workers outputs.',
    readOnlyOnly: true,
    allowedToolPatterns: [
      /^dev\.(runTests|auditProject|gitStatus|inspectProject|generateReport)$/,
      /^filesystem\.(read|list|search|stat)$/,
      /^doc\./,
      /^git\.(status|diff|log)$/,
      /^(read_file_contents|list_directory)$/,
    ],
    deniedToolPatterns: [
      /^dev\.patchFile$/,
      /^filesystem\.(write|delete|move|mkdir)$/,
      /^email\.send$/,
      /^calendar\.delete$/,
      /^git\.commit$/,
      /^(write_file|delete_file|patch_file)$/,
    ],
  },
  general: {
    role: 'general',
    description: 'Standard worker with general operational authority.',
    readOnlyOnly: false,
    allowedToolPatterns: [/.*/],
    deniedToolPatterns: [],
  },
}

export class SpecialistWorker {
  readonly workerId: string
  readonly role: SpecialistWorkerRole
  readonly policy: WorkerPolicy
  private tasksCompleted = 0

  constructor(role: SpecialistWorkerRole, workerId?: string) {
    this.role = role
    this.policy = SPECIALIST_WORKER_POLICIES[role]
    this.workerId = workerId || `worker_${role}_${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * Authorize a proposed tool execution against this worker's assigned role policy.
   */
  authorizeTool(toolId: string, permission?: string): { allowed: boolean; reason?: string } {
    // 1. Check explicit deny patterns first
    for (const pattern of this.policy.deniedToolPatterns) {
      if (pattern.test(toolId)) {
        return {
          allowed: false,
          reason: `Tool "${toolId}" is explicitly forbidden for role "${this.role}" by security policy.`,
        }
      }
    }

    // 2. Check allow patterns
    const allowed = this.policy.allowedToolPatterns.some((pattern) => pattern.test(toolId))
    if (!allowed) {
      return {
        allowed: false,
        reason: `Tool "${toolId}" is not in the allowed capability set for role "${this.role}".`,
      }
    }

    // 3. Check read-only constraint if permission is explicitly specified
    if (this.policy.readOnlyOnly && permission !== undefined && permission !== 'read_only') {
      return {
        allowed: false,
        reason: `Specialist worker "${this.workerId}" (${this.role}) is strictly constrained to read-only tools. Tool "${toolId}" requires "${permission}" permission.`,
      }
    }

    return { allowed: true }
  }

  recordCompletion(): void {
    this.tasksCompleted++
  }

  get completedCount(): number {
    return this.tasksCompleted
  }
}

export interface AggregatedSpecialistResult {
  totalSubtasks: number
  verifiedSubtasks: number
  failedSubtasks: number
  findings: string[]
  codeArtifacts: string[]
  verificationVerdicts: Array<{ subtaskId: string; passed: boolean; evidence: string }>
  summary: string
}

export class SpecialistDelegator {
  private workers = new Map<SpecialistWorkerRole, SpecialistWorker>()

  constructor() {
    this.workers.set('researcher', new SpecialistWorker('researcher'))
    this.workers.set('coder', new SpecialistWorker('coder'))
    this.workers.set('verifier', new SpecialistWorker('verifier'))
    this.workers.set('general', new SpecialistWorker('general'))
  }

  getWorker(role: SpecialistWorkerRole): SpecialistWorker {
    let worker = this.workers.get(role)
    if (!worker) {
      worker = new SpecialistWorker(role)
      this.workers.set(role, worker)
    }
    return worker
  }

  /**
   * Determine optimal specialist worker role based on capability and toolId.
   */
  inferRoleForSubtask(capability: string, toolId: string): SpecialistWorkerRole {
    const combined = `${capability} ${toolId}`.toLowerCase()

    if (
      combined.includes('runtests') ||
      combined.includes('audit') ||
      combined.includes('verify') ||
      combined.includes('inspect')
    ) {
      return 'verifier'
    }

    if (
      combined.includes('dev.') ||
      combined.includes('patch') ||
      combined.includes('write') ||
      combined.includes('compile') ||
      combined.includes('build')
    ) {
      return 'coder'
    }

    if (
      combined.includes('research') ||
      combined.includes('doc.') ||
      combined.includes('data.') ||
      combined.includes('search') ||
      combined.includes('extract') ||
      combined.includes('read')
    ) {
      return 'researcher'
    }

    return 'general'
  }

  /**
   * Annotate a subtask with parent-child lineage and assigned specialist worker.
   */
  delegateSubtask(subtask: Subtask, parentTaskId: string, explicitRole?: SpecialistWorkerRole): Subtask {
    const role = explicitRole || subtask.workerRole || this.inferRoleForSubtask(subtask.capability, subtask.toolId)
    const worker = this.getWorker(role)

    const lineage: WorkerLineage = {
      parentTaskId,
      parentSubtaskId: subtask.id,
      workerId: worker.workerId,
      workerRole: role,
      delegatedAt: Date.now(),
    }

    const constraints: WorkerConstraint = {
      readOnlyOnly: worker.policy.readOnlyOnly,
      allowedTools: worker.policy.allowedToolPatterns.map((p) => p.source),
      disallowedTools: worker.policy.deniedToolPatterns.map((p) => p.source),
    }

    return {
      ...subtask,
      workerRole: role,
      workerId: worker.workerId,
      parentTaskId,
      lineage,
      constraints,
    }
  }

  /**
   * Validate that a delegated subtask is allowed to execute under its assigned worker role.
   */
  validateSubtaskExecution(subtask: Subtask, toolPermission?: string): { allowed: boolean; reason?: string } {
    const role = subtask.workerRole || 'general'
    const worker = this.getWorker(role)
    const targetTool = subtask.toolId || subtask.capability
    return worker.authorizeTool(targetTool, toolPermission)
  }

  /**
   * Aggregate structured results across all specialist worker subtasks.
   */
  aggregateResults(subtasks: Subtask[]): AggregatedSpecialistResult {
    const findings: string[] = []
    const codeArtifacts: string[] = []
    const verificationVerdicts: Array<{ subtaskId: string; passed: boolean; evidence: string }> = []

    let verifiedCount = 0
    let failedCount = 0

    for (const st of subtasks) {
      if (st.state === 'VERIFIED') verifiedCount++
      if (st.state === 'FAILED') failedCount++

      // Aggregate findings from researcher
      if (st.workerRole === 'researcher' && st.observation?.summary) {
        findings.push(st.observation.summary)
      }

      // Aggregate code artifacts from coder
      if (st.workerRole === 'coder' && st.result?.output) {
        const out = typeof st.result.output === 'string' ? st.result.output : JSON.stringify(st.result.output)
        codeArtifacts.push(`[${st.title}] ${out.slice(0, 300)}`)
      }

      // Aggregate verifications from verifier
      if (st.verification) {
        verificationVerdicts.push({
          subtaskId: st.id,
          passed: st.verification.passed,
          evidence: st.verification.evidence,
        })
      }
    }

    const summary = `Specialist execution completed: ${verifiedCount}/${subtasks.length} verified (${failedCount} failed). Findings: ${findings.length}, Artifacts: ${codeArtifacts.length}, Verifications: ${verificationVerdicts.length}.`

    return {
      totalSubtasks: subtasks.length,
      verifiedSubtasks: verifiedCount,
      failedSubtasks: failedCount,
      findings,
      codeArtifacts,
      verificationVerdicts,
      summary,
    }
  }
}
