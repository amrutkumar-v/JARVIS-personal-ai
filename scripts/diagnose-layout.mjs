import { chromium } from 'playwright'
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ARTIFACT_DIR = 'C:/Users/vamru/.gemini/antigravity/brain/26136f32-4d12-42d9-b932-21bf5f8915e8'

const VIEWPORTS = [
  { name: '1440px_desktop', width: 1440, height: 900 },
  { name: '1024px_laptop', width: 1024, height: 768 },
  { name: '768px_tablet', width: 768, height: 1024 },
  { name: '390px_mobile', width: 390, height: 844 },
]

async function run() {
  console.log('=== JARVIS 4.0 Layout & Visual Integration Diagnostics ===')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    for (const vp of VIEWPORTS) {
      console.log(`\n--- Inspecting Viewport: ${vp.name} (${vp.width}x${vp.height}) ---`)
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
      })
      const page = await context.newPage()

      const errors = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text())
      })
      page.on('pageerror', (err) => errors.push(err.message))

      await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2000)

      // Capture initial state
      const diagPath = resolve(`diag_${vp.name}_default.png`)
      await page.screenshot({ path: diagPath })
      console.log(`  Captured: ${diagPath}`)
      copyFileSync(diagPath, resolve(ARTIFACT_DIR, `diag_${vp.name}_default.png`))

      // Check DOM metrics
      const metrics = await page.evaluate(() => {
        const header = document.querySelector('.jarvis-header')
        const taskbar = document.querySelector('.jarvis-taskbar')
        const stage = document.querySelector('.jarvis-stage')
        const dock = document.querySelector('.jarvis-dock')
        const panelHost = document.querySelector('.panel-host')
        const goalComposer = document.querySelector('.goal-composer')

        const getBox = (el) => {
          if (!el) return null
          const r = el.getBoundingClientRect()
          return {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            left: Math.round(r.left),
            right: Math.round(r.right),
          }
        }

        return {
          window: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
          scrollW: document.documentElement.scrollWidth,
          scrollH: document.documentElement.scrollHeight,
          header: getBox(header),
          taskbar: getBox(taskbar),
          stage: getBox(stage),
          dock: getBox(dock),
          panelHost: getBox(panelHost),
          goalComposer: getBox(goalComposer),
        }
      })

      console.log('  Metrics:', JSON.stringify(metrics, null, 2))

      // Now open Tasks and Assistant panels to see how panels position and interact
      const tasksBtn = page.locator('button.taskbar-nav-item', { hasText: 'Tasks' })
      if (await tasksBtn.isVisible()) {
        await tasksBtn.click()
        await page.waitForTimeout(500)
      }

      const panelsPath = resolve(`diag_${vp.name}_with_panels.png`)
      await page.screenshot({ path: panelsPath })
      console.log(`  Captured with panels open: ${panelsPath}`)
      copyFileSync(panelsPath, resolve(ARTIFACT_DIR, `diag_${vp.name}_with_panels.png`))

      const panelMetrics = await page.evaluate(() => {
        const windows = Array.from(document.querySelectorAll('.panel-window')).map((pw) => {
          const r = pw.getBoundingClientRect()
          return {
            title: pw.querySelector('.panel-window-label')?.textContent?.trim(),
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
            transform: pw.style.transform,
          }
        })
        return windows
      })
      console.log('  Open panels metrics:', JSON.stringify(panelMetrics, null, 2))

      await context.close()
    }
  } finally {
    await browser.close()
  }
}

run().catch((err) => {
  console.error('Diagnosis failed:', err)
  process.exit(1)
})

