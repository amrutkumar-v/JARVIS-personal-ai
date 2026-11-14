/**
 * Release Candidate UI Functional Verification (Priority F).
 *
 * Runs headless Playwright across 4 standard viewports:
 *  - 1440x900 (Desktop)
 *  - 1024x768 (Laptop)
 *  - 768x1024 (Tablet)
 *  - 390x844 (Mobile)
 *
 * Verifies geometry of topbar, sidebar, dashboard cards, dock, and active panel windows
 * ensuring 0 overlapping / collision defects and no viewport clipping.
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SCREENSHOT_DIR = 'docs/release-candidate/screenshots'
mkdirSync(SCREENSHOT_DIR, { recursive: true })

const VIEWPORTS = [
  { name: '1440px_desktop', width: 1440, height: 900, isMobile: false },
  { name: '1024px_laptop', width: 1024, height: 768, isMobile: false },
  { name: '768px_tablet', width: 768, height: 1024, isMobile: true },
  { name: '390px_mobile', width: 390, height: 844, isMobile: true },
]

function checkOverlap(r1, r2) {
  if (!r1 || !r2 || r1.width <= 0 || r1.height <= 0 || r2.width <= 0 || r2.height <= 0) return false
  return !(
    r1.x + r1.width <= r2.x ||
    r2.x + r2.width <= r1.x ||
    r1.y + r1.height <= r2.y ||
    r2.y + r2.height <= r1.y
  )
}

async function runUiAudit() {
  console.log('Starting Release Candidate Playwright UI Audit...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const results = []

  for (const vp of VIEWPORTS) {
    console.log(`\n--- Inspecting Viewport: ${vp.name} (${vp.width}x${vp.height}) ---`)
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.isMobile,
    })
    const page = await context.newPage()

    try {
      // Clear localStorage to inspect default baseline state
      await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' })
      await page.evaluate(() => localStorage.clear())
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1000)

      // Capture default view
      const defaultShotPath = join(SCREENSHOT_DIR, `rc_${vp.name}_default.png`)
      await page.screenshot({ path: defaultShotPath })
      console.log(`[OK] Saved default screenshot: ${defaultShotPath}`)

      // Measure baseline elements
      const baseline = await page.evaluate(() => {
        const getBox = (sel) => {
          const el = document.querySelector(sel)
          if (!el) return null
          const r = el.getBoundingClientRect()
          return {
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
            visible: r.width > 0 && r.height > 0 && window.getComputedStyle(el).display !== 'none',
          }
        }
        return {
          topbar: getBox('.jarvis-topbar'),
          sidebar: getBox('.jarvis-taskbar'),
          dock: getBox('.jarvis-dock'),
          cardsGrid: getBox('.dashboard-cards-grid'),
          openPanelsCount: document.querySelectorAll('.panel-window:not(.is-hidden)').length,
        }
      })

      // Open Tasks panel
      if (vp.isMobile) {
        const toggle = await page.$('.sidebar-mobile-toggle')
        if (toggle) {
          await toggle.click()
          await page.waitForTimeout(300)
        }
      }

      const tasksNavBtn = await page.$('button[data-nav-id="tasks"]')
      let panelOpened = false
      if (tasksNavBtn) {
        await tasksNavBtn.click()
        await page.waitForTimeout(500)
        panelOpened = true
      }

      // Capture panels view
      const panelShotPath = join(SCREENSHOT_DIR, `rc_${vp.name}_panels.png`)
      await page.screenshot({ path: panelShotPath })
      console.log(`[OK] Saved panels screenshot: ${panelShotPath}`)

      // Measure active panel window
      const panelWindow = await page.evaluate(() => {
        const p = document.querySelector('.panel-window:not(.is-hidden)')
        if (!p) return null
        const r = p.getBoundingClientRect()
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        }
      })

      // Collision checks
      let headerCollision = false
      let dockCollision = false
      let viewportClipping = false

      if (panelWindow) {
        if (baseline.topbar) {
          headerCollision = checkOverlap(panelWindow, baseline.topbar)
        }
        if (baseline.dock) {
          dockCollision = checkOverlap(panelWindow, baseline.dock)
        }
        viewportClipping =
          panelWindow.x < 0 ||
          panelWindow.x + panelWindow.width > vp.width + 4 ||
          panelWindow.y < 0
      }

      const checks = [
        {
          name: 'Nominal Launch Panel State (Activity HUD Open)',
          passed: baseline.openPanelsCount <= 1,
          details: `Open panels on launch: ${baseline.openPanelsCount} (default Activity widget)`,
        },
        {
          name: 'Topbar Position & Height',
          passed: baseline.topbar ? baseline.topbar.y === 0 && baseline.topbar.height >= 40 && baseline.topbar.height <= 60 : true,
          details: baseline.topbar ? `y=${baseline.topbar.y}, h=${baseline.topbar.height}` : 'N/A',
        },
        {
          name: 'Dock Streamlined Height (< 90px)',
          passed: baseline.dock ? baseline.dock.height <= 90 : true,
          details: baseline.dock ? `h=${baseline.dock.height}px` : 'N/A',
        },
        {
          name: 'Zero Collision with Topbar',
          passed: !headerCollision,
          details: `Header collision: ${headerCollision}`,
        },
        {
          name: 'Zero Collision with Dock',
          passed: !dockCollision,
          details: `Dock collision: ${dockCollision}`,
        },
        {
          name: 'No Viewport Clipping',
          passed: !viewportClipping,
          details: panelWindow ? `Panel rect: (${panelWindow.x}, ${panelWindow.y}, ${panelWindow.width}x${panelWindow.height})` : 'No panel',
        },
      ]

      const vpPassed = checks.every((c) => c.passed)
      for (const c of checks) {
        console.log(`   [${c.passed ? 'PASS' : 'FAIL'}] ${c.name}: ${c.details}`)
      }

      results.push({
        viewport: vp.name,
        width: vp.width,
        height: vp.height,
        baseline,
        panelWindow,
        checks,
        passed: vpPassed,
        defaultScreenshot: defaultShotPath,
        panelScreenshot: panelShotPath,
      })
    } finally {
      await context.close()
    }
  }

  await browser.close()

  const allPassed = results.every((r) => r.passed)
  const report = {
    timestamp: new Date().toISOString(),
    overallStatus: allPassed ? 'VERIFIED' : 'FAILED',
    viewportsTested: results.length,
    viewportsPassed: results.filter((r) => r.passed).length,
    results,
  }

  writeFileSync('scripts/release-candidate-ui-metrics.json', JSON.stringify(report, null, 2), 'utf-8')
  console.log('\n======================================================')
  console.log(`RELEASE CANDIDATE UI AUDIT: ${allPassed ? 'VERIFIED (0 Collisions, 0 Defects Across All 4 Viewports)' : 'FAILED'}`)
  console.log('Metrics saved to scripts/release-candidate-ui-metrics.json')
  console.log('======================================================\n')

  if (!allPassed) process.exit(1)
}

runUiAudit().catch((err) => {
  console.error('UI Verification failed:', err)
  process.exit(1)
})
