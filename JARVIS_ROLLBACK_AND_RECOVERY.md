# JARVIS 4.0 — Production Rollback & Operational Disaster Recovery Runbook

**Release Candidate:** v4.0.0-RC1  
**Scope:** Local Executive Daemon, Task Orchestrator, Native Bridge & UI  
**Target Repository:** `D:\JARVIS`

---

## 1. Overview & Operational Principles

This runbook defines the emergency operational procedures for JARVIS 4.0 in production environments. Because JARVIS executes autonomous development tasks with local operating system access, operational stability requires clear runbooks for:
- Planned maintenance restarts.
- Unplanned sudden power loss or process kill (`SIGKILL` / `taskkill /F`).
- Stale lock resolution.
- Task pause, cancellation, and manual recovery.
- Reverting to a prior stable release candidate.

---

## 2. Standard Service Management Procedures

### 2.1 Graceful Restart
To restart the JARVIS core daemon without interrupting active tasks:
1. Check active tasks via API:
   ```bash
   curl -s -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:8787/api/tasks?state=EXECUTING,OBSERVING,VERIFYING
   ```
2. If tasks are actively executing, issue a pause command:
   ```bash
   curl -X POST -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:8787/api/tasks/<TASK_ID>/pause
   ```
3. Send `SIGINT` (Ctrl+C or process signal) to the backend daemon process.
4. Verify the process exits with code 0 and releases `server/data/backend.pid`.
5. Restart the daemon:
   ```bash
   npm run backend
   ```
6. The daemon rehydrates paused tasks; issue resume if desired:
   ```bash
   curl -X POST -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:8787/api/tasks/<TASK_ID>/resume
   ```

---

## 3. Disaster Recovery: Hard Crash & Stale Lock Reclamation

### 3.1 Automatic Stale Lock Recovery
When the host experiences an abrupt power cut or the process is forcefully terminated via `taskkill /F`:
1. The lockfile `server/data/backend.pid` remains on disk containing the terminated PID.
2. Upon launching `npm run backend`, the server reads `backend.pid` and queries the operating system (`process.kill(pid, 0)`).
3. If the process is dead, the server logs:
   ```
   [core] Stale lock held by dead pid <PID>; reclaiming lock.
   ```
4. The server automatically updates `backend.pid` with its own PID, rehydrates interrupted tasks from disk checkpoints, and resumes execution.

### 3.2 Manual Lock Clearance (Troubleshooting)
If the backend reports that another instance is alive but you know it is dead:
1. In PowerShell:
   ```powershell
   # Check if PID is running
   Get-Process -Id (Get-Content server\data\backend.pid | ConvertFrom-Json).pid -ErrorAction SilentlyContinue
   ```
2. If no process exists, manually delete the stale lock file:
   ```powershell
   Remove-Item -Force server\data\backend.pid
   ```
3. Restart backend:
   ```powershell
   npm run backend
   ```

---

## 4. In-Flight Task Recovery Runbook

### 4.1 Interrupted Task State Inspection
All tasks are persisted as JSON under `<JARVIS_DATA_DIR>/tasks/<TASK_ID>.json`:
- Check the task lifecycle state:
  ```powershell
  Get-Content server\data\tasks\<TASK_ID>.json | ConvertFrom-Json | Select-Object id, state, recoveryCount
  ```
- Subtasks marked `state: "VERIFIED"` with evidence will **never** be re-executed.
- Subtasks that were mid-execution without verified evidence are automatically set back to `state: "PENDING"` and re-run once dependencies are verified.

### 4.2 Clearing Hung / Orphan Child Processes
JARVIS tracks all spawned child processes in `ChildProcessRegistry`. If a task is cancelled, the entire child process tree is forcefully terminated.
If an external script hangs:
1. Issue HTTP Cancel:
   ```bash
   curl -X POST -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:8787/api/tasks/<TASK_ID>/cancel
   ```
2. If necessary, check for lingering python or test runners:
   ```powershell
   Get-Process python, vitest -ErrorAction SilentlyContinue
   ```

---

## 5. Release Rollback Procedure

If a deployed release candidate exhibits an unforeseen regression:

### 5.1 Step 1: Stop Services
```powershell
# Stop backend and frontend servers
taskkill /F /IM node.exe
```

### 5.2 Step 2: Backup Data Directory
Before performing any code rollback, preserve the sovereign data directory:
```powershell
Copy-Item -Recurse -Force server\data D:\JARVIS-Backups\data-(Get-Date -Format "yyyyMMdd-HHmmss")
```

### 5.3 Step 3: Revert Code to Prior Baseline
```powershell
# Checkout previous stable release candidate commit without clean/reset
git checkout <PRIOR_RELEASE_COMMIT_OR_TAG> -- server/ src/ native/
```

### 5.4 Step 4: Recompile & Verify
```powershell
npm run build
npx vitest run
```

### 5.5 Step 5: Start Production Services
```powershell
npm run backend
npm run preview  # or npm run dev
```

---

## 6. Contact & Escalation Protocol

- **System Diagnostics:** Run `node scripts/doctor.mjs` to produce a full health assessment.
- **Audit Logs:** Located in `server/data/logs/jarvis-backend-<DATE>.log`.
- **Master Verification Evidence:** Reference `docs/release-candidate/JARVIS_FINAL_VERIFICATION_EVIDENCE.json`.

