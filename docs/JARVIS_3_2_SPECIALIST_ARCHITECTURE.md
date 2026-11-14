# JARVIS 3.2 — Specialist Worker Intelligence Architecture
## Bounded Worker Roles, Least-Privilege Policies, Parent-Child Lineage, and Single Cognitive Authority

**Document Version:** 3.2.0  
**Baseline:** JARVIS 3.1  
**Architecture Layer:** Specialist Delegation & Task Lineage (`src/engine/tasks/SpecialistWorkerPool.ts`)  
**Target Platform:** Windows 11 Pro  
**Date:** November 12, 2026  
**Status:** **OPERATIONAL & EMPIRICALLY VERIFIED**

---

## 1. Executive Summary

JARVIS 3.2 implements a specialist worker model designed to prevent monolithic execution while strictly adhering to the architectural invariant: **Single Cognitive Authority**.

Rather than spawning autonomous multi-agent swarms with conflicting planners, independent task queues, and chaotic racing conditions, JARVIS employs bounded specialist workers (`researcher`, `coder`, `verifier`, and `general`) operating strictly under the central planning and orchestration authority of `AssistantEngine`:
- `AssistantEngine` alone decomposes goals into dependency-ordered DAGs, manages state, enforces permissions, and evaluates terminal success.
- Specialist workers execute bounded subtasks matching their assigned least-privilege capability policy.
- All worker actions are tracked with parent-child lineage and validated before being accepted into the parent task record.

---

## 2. Core Architectural Invariant: Single Cognitive Authority

```
User Instruction
   │
   ▼
AssistantEngine (Sole Cognitive & Planning Authority)
   │
   ├─► UniversalIntentRouter (Outcome Understanding & Strategy)
   │
   ├─► PersistentTaskOrchestrator (Dependency-Ordered DAG Planner)
   │     │
   │     ▼
   ├─► SpecialistDelegator (Bounded Role Assignment & Lineage Tagging)
   │     │
   │     ├─► [Researcher Worker]  ──► Read-only tools (Web, Doc, Data, ReadPage)
   │     ├─► [Coder Worker]       ──► Workspace mutation (dev.patchFile, dev.gitCheckpoint)
   │     └─► [Verifier Worker]    ──► Read-only audit (dev.runTests, dev.inspectProject)
   │
   ▼
Structured Result Aggregation (aggregateResults)
   └─ Validated Findings, Code Artifacts, and Independent Verification Verdicts
```

### Non-Negotiable Rules:
1. **No Competing Planners:** Specialist workers never construct independent plans or spawn unmonitored child tasks.
2. **Strict Tool Policy Enforcement:** Attempted tool calls outside a worker's declared security policy are immediately rejected by `authorizeTool`.
3. **Lineage Traceability:** Every subtask executed by a specialist carries a tamper-evident `lineage` record containing `parentTaskId`, `parentSubtaskId`, `workerId`, `workerRole`, and `delegatedAt`.

---

## 3. Specialist Roles & Least-Privilege Policies

| Role Name | Authority Scope | Allowed Tool Patterns | Denied Tool Patterns | Read-Only Enforcement |
|---|---|---|---|---|
| **`researcher`** | Web search, document intelligence, tabular data analysis, page reading. | `web.*`, `doc.*`, `data.*`, `browser.readPage`, `browser.extractContent`, `filesystem.read` | `dev.patchFile`, `dev.gitCheckpoint`, `filesystem.write`, `filesystem.delete`, `email.send`, `browser.click` | **STRICT (true)** |
| **`coder`** | Software engineering, workspace patching, test execution within approved workspace roots. | `dev.*`, `filesystem.read`, `filesystem.write`, `git.status`, `git.diff`, `git.log` | `email.send`, `calendar.delete`, `browser.fillForm` | False (Workspace bound) |
| **`verifier`** | Independent audit analysis, test execution, checksum confirmation of other workers' code. | `dev.runTests`, `dev.auditProject`, `dev.gitStatus`, `dev.inspectProject`, `dev.generateReport` | `dev.patchFile`, `filesystem.write`, `filesystem.delete`, `email.send`, `git.commit` | **STRICT (true)** |
| **`general`** | Standard subtasks requiring multi-domain coordination. | General tool catalog. | Dangerous / destructive root actions. | Configured by step |

---

## 4. Structured Output Aggregation

When all subtasks of a persistent task complete, the `SpecialistDelegator.aggregateResults(subtasks)` method aggregates the specialist outputs into a unified deliverable:
- **Findings:** Extracted by `researcher` workers from public or local documents.
- **Code Artifacts:** Recorded by `coder` workers with file paths and line counts.
- **Verification Verdicts:** Independent pass/fail confirmations recorded by `verifier` workers with process exit codes and execution evidence.
- **Summary:** Complete accounting of verified vs failed subtasks.

---

## 5. Verification & Test Evidence

Validated in `test/unit/specialistWorker.test.ts` (6/6 tests pass):
- **Test 1:** Role inference correctly maps tools (`dev.patchFile` $\rightarrow$ `coder`, `dev.runTests` $\rightarrow$ `verifier`, `web.search` $\rightarrow$ `researcher`).
- **Test 2:** Researcher worker policy blocks mutation attempts (`dev.patchFile` and `filesystem.write`).
- **Test 3:** Coder worker policy blocks external communication (`email.send`).
- **Test 4:** Verifier worker policy prohibits code modifications.
- **Test 5:** Subtask delegation enriches subtasks with parent-child lineage while preserving `AssistantEngine` authority.
- **Test 6:** Structured aggregation consolidates verified results across multiple specialist workers.

**Phase 11 Verdict:** Specialist worker intelligence is operational, policy-bounded, and maintains single cognitive authority.

