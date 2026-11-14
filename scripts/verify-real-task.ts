/**
 * Live End-to-End Real-World Autonomous Verification Script (JARVIS 4.0).
 *
 * Tests the exact user task that previously failed in production:
 * "Create D:\JARVIS-Test\hello_jarvis.py containing:
 *  print("Hello! JARVIS 4.0 autonomous execution is working.")
 *  Run the file, verify its output, and report the exact path and execution result.
 *  Do not modify existing project files."
 */

import { existsSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { TaskService } from '../server/src/taskService.js'
import { EventBus } from '../server/src/events.js'
import { nullLogger } from '../server/src/log.js'

async function runLiveVerification() {
  console.log('=== JARVIS 4.0 LIVE REAL-WORLD AUTONOMOUS VERIFICATION ===\n')

  const targetDir = 'D:\\JARVIS-Test'
  const targetFile = join(targetDir, 'hello_jarvis.py')

  // Clean any previous hello_jarvis.py to ensure 100% clean test
  if (existsSync(targetFile)) {
    rmSync(targetFile, { force: true })
  }
  console.log(`Pre-condition check: ${targetFile} exists: ${existsSync(targetFile)}`)

  const bus = new EventBus()
  const taskService = new TaskService({
    dataDir: join(process.cwd(), 'server', 'data'),
    bus,
    log: nullLogger(),
    useMemoryStorage: true,
  })

  await taskService.init()

  const objective =
    'Create D:\\JARVIS-Test\\hello_jarvis.py containing: print("Hello! JARVIS 4.0 autonomous execution is working."). Run the file, verify its output, and report the exact path and execution result. Do not modify existing project files.'

  console.log(`Submitting task with objective:\n"${objective}"\n`)

  const task = await taskService.createTask({
    title: 'Autonomous Execution Task: hello_jarvis.py',
    objective,
    projectPath: targetDir,
  })

  console.log(`Task created: ID=${task.id}, Subtasks=${task.subtasks.length}`)
  task.subtasks.forEach((s, i) => {
    console.log(`  Step ${i + 1}: [${s.capability}] ${s.title}`)
  })

  console.log('\nExecuting task pipeline...')

  // Wait for task completion
  let settled = await taskService.getTask(task.id)
  let waitCount = 0
  while (settled && settled.state !== 'COMPLETED' && settled.state !== 'FAILED' && waitCount < 60) {
    await new Promise((r) => setTimeout(r, 250))
    settled = await taskService.getTask(task.id)
    waitCount++
  }

  console.log(`\nTask Settled State: ${settled?.state}`)
  console.log(`Error (if any): ${settled?.error || 'None'}`)

  // Verify on disk
  const fileExists = existsSync(targetFile)
  console.log(`\nAffirmative On-Disk Verification:`)
  console.log(`  ${targetFile} exists on disk: ${fileExists}`)

  if (fileExists) {
    const size = statSync(targetFile).size
    const content = readFileSync(targetFile, 'utf-8')
    console.log(`  File size: ${size} bytes`)
    console.log(`  File content:\n---\n${content.trim()}\n---`)
  }

  const reportPath = join(targetDir, 'JARVIS_EXECUTION_REPORT.md')
  if (existsSync(reportPath)) {
    const reportContent = readFileSync(reportPath, 'utf-8')
    console.log(`\nExecution Report Snippet (Section 8):\n`)
    const sec8 = reportContent.split('## 8. Final Objective Verification')[1]
    console.log(sec8 ? sec8.trim() : 'Section 8 missing!')
  }

  const completionEvidence = (settled?.metadata as any)?.completionEvidence
  console.log('\nTask Completion Evidence in Metadata:')
  console.log(JSON.stringify(completionEvidence, null, 2))

  if (settled?.state === 'COMPLETED' && fileExists) {
    console.log('\n>>> SUCCESS: Task completed with affirmative physical and process evidence! <<<')
  } else {
    console.error('\n>>> FAILURE: Task did not meet acceptance criteria! <<<')
    process.exit(1)
  }
}

runLiveVerification().catch((err) => {
  console.error('Fatal error during verification:', err)
  process.exit(1)
})
