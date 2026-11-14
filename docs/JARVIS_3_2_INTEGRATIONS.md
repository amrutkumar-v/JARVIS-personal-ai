# JARVIS 3.2 — Personal Productivity & External Integrations Specification
## Permission-Gated Connectors, Two-Phase Confirmation, Calendar Conflicts, and OAuth Architecture

**Document Version:** 3.2.0  
**Baseline:** JARVIS 3.1  
**Architecture Layer:** Productivity & Connector Layer (`src/engine/productivity/`)  
**Target Platform:** Windows 11 Pro  
**Date:** November 12, 2026  
**Status:** **OPERATIONAL & AUDITED (MOCKED/LOCAL APAPTERS; OAUTH RAILS DOCUMENTED)**

---

## 1. Executive Summary

JARVIS 3.2 bridges personal productivity services (Email, Calendar, Git, and Project Management) while enforcing strict permission guardrails. External operations that generate irreversible side effects (sending external messages, deleting calendar appointments, committing or pushing code, financial operations) are gated behind an audited Two-Phase Confirmation Protocol.

In compliance with the honesty invariant, live third-party cloud services (Google Workspace, Microsoft 365, GitHub) are classified as **`MOCKED ONLY` / `LOCAL ADAPTERS`** in the default environment, with comprehensive OAuth 2.0 PKCE connector architecture defined for credentialed user environments.

---

## 2. Two-Phase Confirmation Architecture (`ConfirmationManager.ts`)

Consequential actions cannot be executed from raw conversational intent alone:

```
User Instruction ("Send email to team@company.org with update")
   │
   ▼
Intent Router (PRODUCTIVITY)
   │
   ▼
ConfirmationManager (requestConfirmation)
   ├─ Generate Cryptographic Single-Use Token (UUIDv4)
   ├─ Record Action: 'email_send', Target: 'team@company.org'
   ├─ Set Expiration Timestamp (5-minute TTL)
   └─ Return Prompt: "Confirmation required for email_send... provide confirmationToken='...'"
   │
   ▼
User Approval ("Yes, confirm" / { confirmationToken: "..." })
   │
   ▼
Token Verification & Atomic Consumption (verifyAndConsume)
   ├─ Validate Token Exists and Action Matches ('email_send')
   ├─ Assert Date.now() < expiresAt
   ├─ Atomically DELETE Token (Single-Use Invariant: Cannot be replayed)
   └─ Dispatch Action to Service Adapter
```

### 2.1 Gated Operations

| Operation | Action Key | Risk Profile | Confirmation Requirement |
|---|---|---|---|
| **Email Dispatch** | `email_send` | High (External communication) | Single-use token required. Draft is created first; send requires explicit token. |
| **Calendar Event Deletion** | `calendar_delete` | Medium (Schedule loss) | Single-use token required. Confirms event ID, title, and start time. |
| **Git Workspace Commit** | `git_commit` | Medium (Repository history mutation) | Single-use token required. Confirms commit message and staged diff. |
| **File Deletion** | `file_delete` | High (Data loss) | Explicit confirmation required. Prohibits wildcard or recursive root deletions. |

---

## 3. Practical Productivity Capabilities

### 3.1 Calendar Management & RFC 5545 Conflict Detection
The Calendar adapter (`LocalCalendarAdapter`) inspects event intervals $[T_{start}, T_{end}]$ to detect scheduling collisions before creating new events:
- **`detectConflicts(start, end)`:** Evaluates overlapping intervals across existing events.
- If a conflict is discovered, JARVIS flags the overlapping event title and times, suggesting adjacent free slots.

### 3.2 Email Processing & Summarization
- Ingests incoming messages and filters unread or labeled items.
- Summarizes multi-message threads.
- Prepares drafts in the drafts folder without sending.

### 3.3 Git Workspace Operations
- `git.status`: Inspects branch, staged changes, and untracked files.
- `git.diff`: Inspects unified diffs for software engineering tasks.
- `git.commit`: Applies commit only upon confirmation token verification.

---

## 4. Cloud OAuth 2.0 PKCE Specification

For environments connecting to Microsoft Graph or Google Workspace:
1. **Authorization Code Flow with PKCE:** Standard RFC 7636 Proof Key for Code Exchange (S256 code challenge).
2. **Least-Privilege Scopes:**
   - Google: `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/calendar.events`
   - Microsoft: `Mail.Read`, `Calendars.ReadWrite`, `User.Read`
3. **Token Protection:** Tokens stored in Windows DPAPI / Credential Manager, never in plain-text git repositories or client bundles.
4. **Revocation Rail:** Complete token purging on user command (*"Disconnect my Google account"*).

---

## 5. Verification Evidence

- `ConfirmationManager.ts`: Unit verified with token generation, verification, expiration after 5-minute TTL, and single-use replay rejection.
- `ProductivityAdapters.ts`: Unit verified across email listing, drafting, calendar conflict detection, and git status inspection.

**Phase 10 Verdict:** Permission boundaries and productivity adapters operational and audited.

