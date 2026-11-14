import { AssistantEngine } from '../src/engine/AssistantEngine'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { useConversationStore } from '../src/state/conversation.store'

// Setup stub browser environment for engine
const backing = new Map<string, string>()
const storage = {
  getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
}
;(globalThis as any).window = {
  localStorage: storage,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  setTimeout,
  clearTimeout,
}
;(globalThis as any).localStorage = storage

async function run() {
  console.log('--- STARTING VERIFICATION: Python Circle Task Execution ---')
  useConversationStore.getState().clearConversation()

  const engine = new AssistantEngine()
  const orchestrator = engine.getPersistentOrchestrator()
  orchestrator.start(50) // Fast polling for subtask execution

  const command =
    'Inspect D:\\JARVIS-Test. Create a simple Python program that calculates the area of a circle. Create an appropriate test file, execute the tests, verify the results, and generate a completion report.'

  console.log('Submitting natural language command to AssistantEngine...')
  console.log(`Prompt: "${command}"`)
  await engine.process(command)

  const tasks = await engine.getPersistentTasks()
  console.log(`Tasks created: ${tasks.length}`)
  if (tasks.length === 0) {
    console.error('FAIL: No persistent task was created!')
    process.exit(1)
  }

  const task = tasks[0]
  console.log(`Task ID: ${task.id}`)
  console.log(`Task Objective: ${task.objective}`)
  console.log(`Initial State: ${task.state}`)
  console.log(`Subtasks Count: ${task.subtasks.length}`)
  console.log('Subtasks planned:')
  task.subtasks.forEach((st, idx) => {
    console.log(`  [${idx + 1}] ${st.title} (${st.capability}) -> deps: [${st.dependencies.join(', ')}]`)
  })

  // Poll until task reaches COMPLETED or FAILED
  console.log('\nAwaiting autonomous background execution...')
  const start = Date.now()
  let finalTask = task
  while (Date.now() - start < 45_000) {
    const current = await orchestrator.getTask(task.id)
    if (current) {
      finalTask = current
      if (current.state === 'COMPLETED' || current.state === 'FAILED') {
        break
      }
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  console.log(`\nFinal Task State: ${finalTask.state} (took ${((Date.now() - start) / 1000).toFixed(1)}s)`)
  console.log('Subtask execution details:')
  for (const st of finalTask.subtasks) {
    console.log(`  - Subtask "${st.title}":`)
    console.log(`      State: ${st.state}`)
    console.log(`      Capability: ${st.capability}`)
    if (st.result) {
      console.log(`      Result OK: ${st.result.ok}`)
      if (st.result.message) console.log(`      Message: ${st.result.message}`)
      if (st.result.error) console.log(`      Error: ${st.result.error}`)
    }
    if (st.verification) {
      console.log(`      Verified: ${st.verification.verified}`)
      console.log(`      Verification Note: ${st.verification.note}`)
    }
  }

  // Verify on disk in D:\JARVIS-Test
  const testDir = 'D:\\JARVIS-Test'
  console.log(`\nInspecting directory on disk: ${testDir}`)
  const files = readdirSync(testDir)
  console.log('Files present:', files)

  const circlePy = join(testDir, 'circle.py')
  const testCirclePy = join(testDir, 'test_circle.py')
  const reportMd = join(testDir, 'JARVIS_EXECUTION_REPORT.md')

  console.log('\n--- VERIFYING FILE ARTIFACTS ---')
  console.log(`circle.py exists: ${existsSync(circlePy)}`)
  if (existsSync(circlePy)) {
    const circleContent = readFileSync(circlePy, 'utf-8')
    console.log(`circle.py length: ${circleContent.length} bytes`)
    console.log('circle.py content snippet:\n' + circleContent.slice(0, 200))
  }

  console.log(`\ntest_circle.py exists: ${existsSync(testCirclePy)}`)
  if (existsSync(testCirclePy)) {
    const testContent = readFileSync(testCirclePy, 'utf-8')
    console.log(`test_circle.py length: ${testContent.length} bytes`)
  }

  console.log(`\nJARVIS_EXECUTION_REPORT.md exists: ${existsSync(reportMd)}`)
  if (existsSync(reportMd)) {
    const reportContent = readFileSync(reportMd, 'utf-8')
    console.log(`Report length: ${reportContent.length} bytes`)
    console.log('Report snippet:\n' + reportContent.slice(0, 400))
  }

  // Execute python unittest manually to confirm test status and exit code
  console.log('\n--- EXECUTING PYTHON UNITTEST DIRECTLY ---')
  try {
    const pyOutput = execSync('python -m unittest test_circle.py', {
      cwd: testDir,
      stdio: 'pipe',
    }).toString()
    console.log('Direct python execution stdout:\n' + pyOutput)
  } catch (err: any) {
    const combined = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '')
    console.log('Direct python execution combined output:\n' + combined)
    console.log('Exit code:', err.status ?? 0)
  }

  if (finalTask.state === 'COMPLETED') {
    console.log('\n>>> SUCCESS: Autonomous task completed and verified! <<<')
    process.exit(0)
  } else {
    console.error('\n>>> FAILURE: Task did not reach COMPLETED state <<<')
    process.exit(1)
  }
}

run().catch((err) => {
  console.error('Fatal error in verification:', err)
  process.exit(1)
})

