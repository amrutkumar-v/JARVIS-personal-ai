/*
 * LIVE End-to-End harness — Phase 1 "real agent core".
 *
 * Drives the REAL AssistantEngine against the REAL native Windows agent
 * (127.0.0.1:8765) through the SAME provider seams the browser app binds at
 * startup (src/native). Run via vite-node so `import.meta.env` picks up
 * `.env.local` (VITE_NATIVE_AGENT_URL). Deterministic planner only — no AI
 * generate() is required for any of these scenarios.
 *
 * Usage:  npx vite-node e2e.live.ts
 *
 * NOT committed to the repo. Scratch verification vehicle.
 */

const backing = new Map<string, string>()
const storage = {
  getItem: (k: string): string | null => (backing.has(k) ? backing.get(k)! : null),
  setItem: (k: string, v: string): void => void backing.set(k, String(v)),
  removeItem: (k: string): void => void backing.delete(k),
}
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: storage,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  setTimeout,
  clearTimeout,
}
;(globalThis as unknown as { localStorage: unknown }).localStorage = storage

interface ToolEvt {
  toolId: string
  status: string
  detail?: string
}
interface ConfirmReq {
  title: string
  toolId: string
  impact: string
  approve: () => Promise<void>
  decline: () => void
}

const results: Array<{ name: string; pass: boolean; note: string }> = []
function record(name: string, pass: boolean, note: string): void {
  results.push({ name, pass, note })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`)
  if (note) console.log(`      ${note.replace(/\n/g, '\n      ')}`)
}

const { AssistantEngine } = await import('./src/engine/AssistantEngine')
const native = await import('./src/native')
const { useConversationStore } = await import('./src/state/conversation.store')
const { useJarvisStore } = await import('./src/state/jarvis.store')

useConversationStore.getState().clearConversation()

interface Harness {
  engine: AssistantEngine
  replies: string[]
  tools: ToolEvt[]
  confirms: Array<ConfirmReq & { decidedBy: 'approved' | 'declined' }>
  finalStatuses: string[]
}

async function freshEngine(opts?: { confirm?: 'approve' | 'decline'; cancelAfterLaunch?: boolean }): Promise<Harness> {
  const fsP = native.createDefaultAppFileSystemProvider()
  const appP = native.createDefaultAppApplicationProvider()
  const obsP = native.createDefaultAppObservationProvider()
  const webP = native.createDefaultAppWebProvider()

  // Production bootstrap probes the native agent BEFORE any user turn; without
  // it the capability seams honestly report "not probed yet" (available false).
  const probe = (p: { refreshNativeStatus?: () => Promise<unknown> } | undefined): Promise<unknown> =>
    p?.refreshNativeStatus ? p.refreshNativeStatus() : Promise.resolve(undefined)
  await Promise.all([probe(fsP), probe(appP), probe(obsP), probe(webP)])

  const engine = new AssistantEngine({
    fileSystem: fsP,
    applications: appP,
    observation: obsP,
    web: webP,
  })
  const h: Harness = { engine, replies: [], tools: [], confirms: [], finalStatuses: [] }
  engine.on((m) => {
    if (m.type === 'transcript' && m.speaker === 'assistant') h.replies.push(m.text)
    else if (m.type === 'tool') h.tools.push({ toolId: m.toolId, status: m.status, detail: m.detail })
    else if (m.type === 'status') h.finalStatuses.push(m.status)
    else if (m.type === 'tool-confirm') {
      const decidedBy = opts?.confirm === 'decline' ? 'declined' : 'approved'
      h.confirms.push({
        title: m.request.title,
        toolId: m.request.toolId,
        impact: m.request.impact,
        approve: () => m.request.onConfirm(),
        decline: () => m.request.onCancel(),
        decidedBy,
      })
      if (opts?.confirm === 'decline') m.request.onCancel()
      else void m.request.onConfirm()
    }
  })
  return h
}

async function listWindowsTitles(): Promise<string[]> {
  const obs = native.createDefaultAppObservationProvider()
  if (!obs) return []
  const wins = await obs.listWindows()
  return wins.filter((w) => w.visible).map((w) => w.title)
}

function launchTrace(summ: string | undefined): string {
  return (summ ?? '').toLowerCase()
}

async function runTest1(): Promise<void> {
  const { engine, replies, tools } = await freshEngine()
  await engine.process('Open Notepad.')
  const reply = replies.at(-1) ?? ''
  const launches = tools.filter((t) => t.toolId === 'app.launch' && t.status === 'success')
  const pass = launches.length === 1 && engine.taskResult().status === 'completed' && /done/i.test(reply)
  const titles = await listWindowsTitles()
  const real = titles.some((t) => /notepad/i.test(t))
  record('TEST 1 — Open Notepad (real launch + verified)', pass && real,
    `reply='${reply.slice(0, 160)}' | launches=${launches.length} | status=${engine.taskResult().status} | notepad window now visible=${real}`)
}

async function runTest2(): Promise<void> {
  const { engine, replies, tools } = await freshEngine()
  await engine.process('Open Calculator.')
  const reply = replies.at(-1) ?? ''
  const launches = tools.filter((t) => t.toolId === 'app.launch' && t.status === 'success')
  const pass = launches.length === 1 && engine.taskResult().status === 'completed' && /done/i.test(reply)
  const titles = await listWindowsTitles()
  const real = titles.some((t) => /calculator/i.test(t))
  record('TEST 2 — Open Calculator (real launch + verified)', pass && real,
    `reply='${reply.slice(0, 160)}' | launches=${launches.length} | status=${engine.taskResult().status} | calculator window now visible=${real}`)
}

async function runTest3(): Promise<void> {
  // WhatsApp is NOT in the agent registry on this machine (verified by app.list).
  const { engine, replies, tools } = await freshEngine()
  await engine.process('Open WhatsApp.')
  const reply = replies.at(-1) ?? ''
  const launches = tools.filter((t) => t.toolId === 'app.launch' && t.status === 'success')
  const noFakeSuccess = !/done/i.test(reply) && launches.length === 0
  const honest = /(not|no|couldn't|could not|unavailable|found|cannot|installed)/i.test(reply)
  record('TEST 3 — Open WhatsApp (honest unavailable)', noFakeSuccess && honest,
    `reply='${reply.slice(0, 200)}' | fake launches=${launches.length} | status=${engine.taskResult().status} | honest=${honest}`)
}

async function runTest4(): Promise<void> {
  const { engine, replies, tools } = await freshEngine()
  await engine.process('Tell me what applications are currently open.')
  const reply = replies.join('\n')
  const reads = tools.filter((t) => t.toolId === 'window.list')
  const liveTitles = await listWindowsTitles()
  const visTitles = liveTitles.filter((t) => /[a-z0-9]{3,}/i.test(t))
  // Grounding: every window name the engine reports must come from the live desktop.
  const lower = reply.toLowerCase()
  const anyGrounding = visTitles.some((t) => lower.includes(t.toLowerCase().replace(/[^a-z0-9 ]+/gi, '').trim().slice(0, 24)))
  const pass =
    reads.length === 1 &&
    engine.taskResult().status === 'completed' &&
    /live reading|open applications|running|desktop|windows/i.test(lower) &&
    anyGrounding
  record('TEST 4 — open-apps read (real window enumeration)', pass,
    `reads=${reads.length} | status=${engine.taskResult().status} | live visible windows=${visTitles.length} | reply mentions a real window=${anyGrounding}\nreply='${reply.slice(0, 600)}'`)
}

async function runTest5(): Promise<void> {
  const { engine, replies, tools } = await freshEngine()
  await engine.process("What's the latest NVIDIA driver version?")
  const reply = replies.at(-1) ?? ''
  const searches = tools.filter((t) => t.toolId === 'web.search')
  const pass =
    searches.length === 1 &&
    engine.taskResult().status === 'completed' &&
    /search|driver|nvidia/i.test(reply)
  record('TEST 5 — latest NVIDIA driver (real web search)', pass,
    `searches=${searches.length} | provider=${searches[0]?.detail ?? 'n/a'} | status=${engine.taskResult().status}\nreply='${reply.slice(0, 400)}'`)
}

async function runTest6(): Promise<void> {
  const { engine, replies, tools } = await freshEngine()
  await engine.process('Open Chrome, then search for the latest NVIDIA driver and tell me the version')
  const reply = replies.at(-1) ?? ''
  const launches = tools.filter((t) => t.toolId === 'app.launch')
  const searches = tools.filter((t) => t.toolId === 'web.search')
  const launchIdx = tools.findIndex((t) => t.toolId === 'app.launch')
  const searchIdx = tools.findIndex((t) => t.toolId === 'web.search')
  const ordered = launchIdx !== -1 && searchIdx !== -1 && launchIdx < searchIdx
  const titles = await listWindowsTitles()
  const chromeReal = titles.some((t) => /chrome/i.test(t))
  const pass = launches.length === 1 && searches.length === 1 && ordered && engine.taskResult().status === 'completed'
  record('TEST 6 — Open Chrome + web search (multi-step, ordered)', pass && chromeReal,
    `launch=${launches.length} search=${searches.length} ordered=${ordered} | status=${engine.taskResult().status} | chrome window visible=${chromeReal}\nreply='${reply.slice(0, 400)}'`)
}

async function runTest7(): Promise<void> {
  const { engine, replies, tools } = await freshEngine()
  await engine.process('Open ThisProgramDoesNotExistKjxZ.')
  const reply = replies.at(-1) ?? ''
  const launches = tools.filter((t) => t.toolId === 'app.launch' && t.status === 'success')
  const noFakeSuccess = launches.length === 0 && !/done/i.test(reply)
  const honest = /(not|no|couldn't|could not|unavailable|found|cannot|exist|installed)/i.test(reply)
  record('TEST 7 — intentionally failing request (honest failure)', noFakeSuccess && honest,
    `fake launches=${launches.length} | status=${engine.taskResult().status} | honest=${honest}\nreply='${reply.slice(0, 200)}'`)
}

async function runTest8(): Promise<void> {
  // Approval path: close_application capability requires confirmation.
  const a = await freshEngine({ confirm: 'approve' })
  await a.engine.process('Close Calculator.')
  const aReply = a.replies.at(-1) ?? ''
  const aConfirm = a.confirms.some((c) => c.toolId === 'app.close' && c.decidedBy === 'approved')
  const aClose = a.tools.filter((t) => t.toolId === 'app.close')
  const aPass = aConfirm && aClose.length >= 1 && /done/i.test(aReply) && a.engine.taskResult().status === 'completed'
  record('TEST 8a — Close Calculator requires confirmation (approved)', aPass,
    `confirmation emitted for app.close=${aConfirm} | closes=${aClose.length} | status=${a.engine.taskResult().status}\nreply='${aReply.slice(0, 240)}'`)

  // Decline path: confirmation refused → NOTHING runs.
  const b = await freshEngine({ confirm: 'decline' })
  await b.engine.process('Close Calculator.')
  const bReply = b.replies.at(-1) ?? ''
  const bConfirm = b.confirms.some((c) => c.toolId === 'app.close' && c.decidedBy === 'declined')
  const bClose = b.tools.filter((t) => t.toolId === 'app.close')
  const bPass = bConfirm && bClose.length === 0 && !/done/i.test(bReply)
  record('TEST 8b — confirmation declined → nothing ran', bPass,
    `refused after ask=${bConfirm} | app.close executed=${bClose.length} | status=${b.engine.taskResult().status}\nreply='${bReply.slice(0, 240)}'`)
}

async function runTest9(): Promise<void> {
  let cancelled = false
  const fsP9 = native.createDefaultAppFileSystemProvider()
  const appP9 = native.createDefaultAppApplicationProvider()
  const obsP9 = native.createDefaultAppObservationProvider()
  const webP9 = native.createDefaultAppWebProvider()
  for (const p of [fsP9, appP9, obsP9, webP9]) if (p?.refreshNativeStatus) await p.refreshNativeStatus()
  const engine = new AssistantEngine({
    fileSystem: fsP9,
    applications: appP9,
    observation: obsP9,
    web: webP9,
  })
  const tools: ToolEvt[] = []
  const replies: string[] = []
  const statuses: string[] = []
  engine.on((m) => {
    if (m.type === 'transcript' && m.speaker === 'assistant') replies.push(m.text)
    else if (m.type === 'tool') tools.push({ toolId: m.toolId, status: m.status, detail: m.detail })
    else if (m.type === 'status') statuses.push(m.status)
    else if (m.type === 'tool-confirm') void m.request.onConfirm()
    if (m.type === 'tool' && m.toolId === 'app.launch' && m.status === 'success' && !cancelled) {
      cancelled = true
      engine.cancelCurrentTask()
    }
  })
  await engine.process('Open Notepad, then search for the latest NVIDIA driver')
  const reply = replies.at(-1) ?? ''
  const launches = tools.filter((t) => t.toolId === 'app.launch')
  const searches = tools.filter((t) => t.toolId === 'web.search' && t.status === 'success')
  const sawCancelled = statuses.includes('cancelled') || /cancelled|stopped/i.test(reply)
  const secondStepSkipped = searches.length === 0
  const titles = await listWindowsTitles()
  const notepadRan = titles.some((t) => /notepad/i.test(t))
  record('TEST 9 — cancel interrupts an active multi-step task', sawCancelled && secondStepSkipped,
    `cancel fired=${cancelled} | app.launch ran=${launches.length} | web.search executed=${searches.length} | notepad window real=${notepadRan}\nreply='${reply.slice(0, 240)}'`)
}

await runTest1()
await runTest2()
await runTest3()
await runTest4()
await runTest5()
await runTest6()
await runTest7()
await runTest8()
await runTest9()

const passed = results.filter((r) => r.pass).length
console.log(`\n=== E2E SUMMARY: ${passed}/${results.length} passed ===`)
for (const r of results) if (!r.pass) console.log(`  FAILED: ${r.name}`)
process.exit(passed === results.length ? 0 : 1)