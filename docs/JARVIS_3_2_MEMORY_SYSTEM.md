# JARVIS 3.2 — Advanced Personal Memory Specification
## Long-Term Context Continuity, Semantic and Lexical Retrieval, Conflict Resolution, and Privacy Guardrails

**Document Version:** 3.2.0  
**Baseline:** JARVIS 3.1  
**Architecture Layer:** Personal Memory & Context Continuity (`src/memory/`)  
**Target Platform:** Windows 11 Pro  
**Date:** November 12, 2026  
**Status:** **OPERATIONAL & EMPIRICALLY VERIFIED**

---

## 1. Executive Summary

JARVIS 3.2 provides long-term personal memory and context continuity, transforming user interactions from isolated, forgetful turns into a coherent, evolving relationship. Rather than polluting the active context window with every historical utterance, JARVIS implements a selective, grounded memory architecture:
1. Distinguishes current instructions from historical context, user preferences, and project facts.
2. Ingests explicit memory directives (*"Remember that...", "Memorize...", "Set my preference to..."*).
3. Automatically scrubs credentials, API keys, passwords, and tokens before persistence.
4. Performs hybrid retrieval (combining lexical keyword matching, recency weighting, and semantic relevance).
5. Handles memory updates, deprecation, and conflict resolution when newer instructions supersede older facts.
6. Persists memory state to disk, surviving system restarts and browser closures.

---

## 2. Memory Types & Lifecycle Model

```
Incoming User Utterance
   │
   ▼
Memory Detection (shouldAutoCapture & detectMemoryType)
   │
   ├─► Credential & Secret Filter (Reject API keys, passwords, bearer tokens)
   │
   ├─► Conflict & Duplicate Detection
   │     ├─ Exact Match: Update timestamp / recency score
   │     ├─ Direct Conflict (e.g., speech rate fast vs slow): Supersede older entry
   │     └─ Novel Fact: Assign UUID, record provenance and timestamp
   │
   ├─► Categorization
   │     ├─ PREFERENCE: UI theme, speech rate, default editor, working hours
   │     ├─ FACT: User profile, name, tech stack, workspace paths
   │     ├─ PROJECT: Repository roots, build scripts, test runners, recent tasks
   │     └─ EPISODE: Completed workflows, execution outcomes, error resolutions
   │
   └─► Persistence (LocalStorage / server/data/memory/)
```

### 2.1 Supported Memory Categories

| Category | Storage Class | Retention Policy | Example Payload |
|---|---|---|---|
| **Preferences** | `user_preference` | Long-term; updated on explicit user correction. | `{ theme: "dark", editor: "vscode", speechRate: 1.1 }` |
| **User Facts** | `profile_fact` | Long-term; verified against explicit declarations. | `{ name: "Amruth", primaryLang: "TypeScript", os: "Windows 11" }` |
| **Project Context** | `project_context` | Persistent across restarts; records recent task checkpoints. | `{ name: "JARVIS-3.2", rootPath: "D:\\JARVIS-Test\\JARVIS-3.2", lastCommit: "ae534d..." }` |
| **Task Continuity** | `continuity_checkpoint` | Ephemeral / medium-term; linked to PersistentTask IDs. | `{ taskId: "task-17944...", state: "COMPLETED", subtaskIndex: 8 }` |

---

## 3. Privacy, Security & Credential Scrubbing

To prevent sensitive operational credentials from leaking into conversational contexts or persistent memory logs, all memory candidates pass through the Credential Scrubbing Rail (`src/memory/detect.ts`):
- **API Keys:** Patterns matching OpenAI (`sk-[a-zA-Z0-9]{20,}`), GitHub (`ghp_[a-zA-Z0-9]{36}`), AWS access keys (`AKIA[0-9A-Z]{16}`), and generic hex tokens are rejected.
- **Passwords:** Declarations containing `password =`, `pwd:`, or `secret:` are never stored.
- **Private Network Tokens:** Bearer tokens and private keys (`BEGIN PRIVATE KEY`) trigger immediate rejection with a safety warning.

---

## 4. Conflict Resolution & Memory Deletion

When a user updates a fact (*"Actually, change my preferred editor to PyCharm"*):
1. `MemoryManager` identifies the conflicting key or semantic cluster.
2. The superseded memory item is marked with `supersededBy: newMemoryId` and archived to prevent stale retrieval.
3. Explicit deletion directives (*"Forget that I live in Seattle"*) permanently purge matching memory IDs and re-index the memory store.

---

## 5. Verification & Test Evidence

The Memory System is verified by 8 comprehensive automated tests in `src/memory/PersonalMemory.phase3.test.ts`:
- **Test 1:** Explicit memory storage (*"Remember that I prefer dark mode"*).
- **Test 2:** Recall and inspection by keyword and semantic similarity.
- **Test 3:** Memory deletion (*"Forget that I live in Seattle"*).
- **Test 4:** User preference updates and conflict resolution.
- **Test 5:** Project context storage and retrieval across sessions.
- **Test 6:** Credential filtering blocking sensitive tokens.
- **Test 7:** Provenance tracking.
- **Test 8:** Selective context injection (retrieving only context relevant to the active request).

All 8/8 tests pass with 100% assertions satisfied.

