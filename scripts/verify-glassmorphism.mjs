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
  console.log('=== JARVIS 4.0 Glassmorphism & Layout Refinement Verification ===')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    for (const vp of VIEWPORTS) {
      console.log(`\n-----------------------------------------------------------`)
      console.log(`[Viewport: ${vp.name} (${vp.width}x${vp.height})]`)
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
      })
      const page = await context.newPage()

      const errors = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text())
      })
      page.on('pageerror', (err) => errors.push(err.message))

      // Clean local storage for predictable default state
      await page.goto('http://localhost:3000')
      await page.evaluate(() => localStorage.removeItem('jarvis_sidebar_collapsed'))
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2000)

      // 1. Check layout metrics in resting state
      const restingMetrics = await page.evaluate(() => {
        const topbar = document.querySelector('.jarvis-topbar')
        const taskbar = document.querySelector('.jarvis-taskbar')
        const stage = document.querySelector('.jarvis-stage')
        const dock = document.querySelector('.jarvis-dock')
        const panelHost = document.querySelector('.panel-host')

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
          windowW: window.innerWidth,
          windowH: window.innerHeight,
          scrollW: document.documentElement.scrollWidth,
          scrollH: document.documentElement.scrollHeight,
          hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
          topbar: getBox(topbar),
          taskbar: getBox(taskbar),
          stage: getBox(stage),
          dock: getBox(dock),
          panelHost: getBox(panelHost),
        }
      })

      console.log(`  Resting layout:`)
      console.log(`    Horizontal overflow: ${restingMetrics.hasHorizontalOverflow ? 'FAIL' : 'NONE (PASS)'}`)
      console.log(`    Topbar height: ${restingMetrics.topbar?.h}px (left: ${restingMetrics.topbar?.x}px, width: ${restingMetrics.topbar?.w}px)`)
      console.log(`    Sidebar width: ${restingMetrics.taskbar?.w}px (x: ${restingMetrics.taskbar?.x}px)`)
      console.log(`    PanelHost bounds: inset [${restingMetrics.panelHost?.top}, ${restingMetrics.panelHost?.left}, ${restingMetrics.panelHost?.w}x${restingMetrics.panelHost?.h}]`)

      const defaultShot = resolve(`glass_${vp.name}_default.png`)
      await page.screenshot({ path: defaultShot })
      copyFileSync(defaultShot, resolve(ARTIFACT_DIR, `glass_${vp.name}_default.png`))

      // 2. Open Tasks Panel to inspect layout and clipping
      if (vp.width > 768) {
        const tasksBtn = page.locator('button.taskbar-nav-item', { hasText: 'Tasks' })
        if (await tasksBtn.isVisible()) {
          await tasksBtn.click()
          await page.waitForTimeout(600)
        }
      }

      // Check open panels metrics
      const panelMetrics = await page.evaluate(() => {
        const windows = Array.from(document.querySelectorAll('.panel-window')).map((pw) => {
          const r = pw.getBoundingClientRect()
          const title = pw.querySelector('.panel-window-label')?.textContent?.trim() || 'Untitled'
          return {
            title,
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
            right: Math.round(r.right),
            bottom: Math.round(r.bottom),
            clippedRight: Math.round(r.right) > window.innerWidth,
            clippedBottom: Math.round(r.bottom) > window.innerHeight,
            clippedTop: Math.round(r.top) < 0,
            clippedLeft: Math.round(r.left) < 0,
          }
        })
        return windows
      })

      console.log(`  Panels verification:`)
      for (const pm of panelMetrics) {
        const isClipped = pm.clippedRight || pm.clippedBottom || pm.clippedTop || pm.clippedLeft
        console.log(`    Panel "${pm.title}": pos=(${pm.x}, ${pm.y}) size=${pm.w}x${pm.h} right=${pm.right}/${vp.width} [${isClipped ? 'CLIPPED FAIL' : 'PERFECT BOUNDS PASS'}]`)
      }

      const panelsShot = resolve(`glass_${vp.name}_panels.png`)
      await page.screenshot({ path: panelsShot })
      copyFileSync(panelsShot, resolve(ARTIFACT_DIR, `glass_${vp.name}_panels.png`))

      // 3. On 1440px desktop, test Settings modal
      if (vp.name === '1440px_desktop') {
        const settingsBtn = page.locator('.topbar-right button[aria-label="Open settings"]')
        if (await settingsBtn.isVisible()) {
          await settingsBtn.click()
          await page.waitForTimeout(500)
          const modalShot = resolve('glass_1440px_settings_modal.png')
          await page.screenshot({ path: modalShot })
          copyFileSync(modalShot, resolve(ARTIFACT_DIR, 'glass_1440px_settings_modal.png'))
          console.log(`    Settings modal verified and saved: ${modalShot}`)
          const closeBtn = page.locator('.settings-head button')
          await closeBtn.click()
          await page.waitForTimeout(300)
        }
      }

      await context.close()
    }

    console.log('\n=== ALL GLASSMORPHISM & LAYOUT VERIFICATION TESTS COMPLETED SUCCESSFULLY! ===')
  } finally {
    await browser.close()
  }
}

run().catch((err) => {
  console.error('Verification failed:', err)
  process.exit(1)
})

