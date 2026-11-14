import { chromium } from 'playwright'
import { copyFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ARTIFACT_DIR = 'C:/Users/vamru/.gemini/antigravity/brain/26136f32-4d12-42d9-b932-21bf5f8915e8'

const VIEWPORTS = [
  { name: '1440px_desktop', width: 1440, height: 900, isMobile: false },
  { name: '1024px_laptop', width: 1024, height: 768, isMobile: false },
  { name: '768px_tablet', width: 768, height: 1024, isMobile: true },
  { name: '390px_mobile', width: 390, height: 844, isMobile: true },
]

async function runVerification() {
  console.log('=== MULTI-RESOLUTION REAL BROWSER LAYOUT VERIFICATION ===')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const results = {
    timestamp: new Date().toISOString(),
    viewports: {},
    allPassed: true,
  }

  for (const vp of VIEWPORTS) {
    console.log(`\n--- Testing Viewport: ${vp.name} (${vp.width}x${vp.height}) ---`)
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
    })
    const page = await context.newPage()

    // Clear layout storage so we test pure initial launch state
    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      localStorage.clear()
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)

    // Capture Default Screenshot
    const defaultShotName = `repaired_${vp.name}_default.png`
    const defaultShotPath = resolve(defaultShotName)
    await page.screenshot({ path: defaultShotPath })
    copyFileSync(defaultShotPath, resolve(ARTIFACT_DIR, defaultShotName))
    console.log(`Saved screenshot: ${defaultShotName}`)

    // Check Geometry of key layout components
    const layoutMetrics = await page.evaluate(() => {
      const getMetrics = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          selector: sel,
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
          visible: r.width > 0 && r.height > 0 && window.getComputedStyle(el).display !== 'none',
        }
      }

      const cards = Array.from(document.querySelectorAll('.dashboard-glass-card')).map((el) => {
        const r = el.getBoundingClientRect()
        return {
          title: el.querySelector('.dashboard-card-title')?.innerText || '',
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        }
      })

      const openPanels = Array.from(document.querySelectorAll('.panel-window:not(.is-hidden)')).map((el) => {
        const r = el.getBoundingClientRect()
        return {
          title: el.querySelector('.panel-window-label')?.innerText || '',
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        }
      })

      return {
        topbar: getMetrics('.jarvis-topbar'),
        sidebar: getMetrics('.jarvis-taskbar'),
        stage: getMetrics('.jarvis-stage'),
        hero: getMetrics('.dashboard-hero'),
        dock: getMetrics('.jarvis-dock'),
        dockBar: getMetrics('.jarvis-dock-bar'),
        cardsGrid: getMetrics('.dashboard-cards-grid'),
        cards,
        openPanels,
      }
    })

    // Geometric checks
    const checks = []

    // 1. Topbar check
    if (layoutMetrics.topbar) {
      checks.push({
        name: 'Topbar Height & Position',
        passed: layoutMetrics.topbar.y === 0 && layoutMetrics.topbar.height >= 40 && layoutMetrics.topbar.height <= 60,
        details: `y=${layoutMetrics.topbar.y}, h=${layoutMetrics.topbar.height}`,
      })
    }

    // 2. Dock Height check (must be streamlined < 90px, not 303px!)
    if (layoutMetrics.dock) {
      checks.push({
        name: 'Dock Streamlined Height (< 90px)',
        passed: layoutMetrics.dock.height <= 90,
        details: `Actual dock height: ${layoutMetrics.dock.height}px`,
      })
    }

    // 3. No auxiliary panels open on initial launch
    checks.push({
      name: 'Pristine Launch (0 Auxiliary Panels Open)',
      passed: layoutMetrics.openPanels.length === 0,
      details: `Open panels on launch: ${layoutMetrics.openPanels.length}`,
    })

    // 4. Cards grid visibility & within viewport
    if (layoutMetrics.cardsGrid) {
      const withinViewport =
        layoutMetrics.cardsGrid.x >= 0 &&
        layoutMetrics.cardsGrid.x + layoutMetrics.cardsGrid.width <= vp.width + 2
      checks.push({
        name: 'Dashboard Cards Within Viewport Bounds',
        passed: withinViewport,
        details: `x=${layoutMetrics.cardsGrid.x}, w=${layoutMetrics.cardsGrid.width}, vp.width=${vp.width}`,
      })
    }

    // 5. Test opening Tasks Panel
    console.log('Testing interactive panel opening (Tasks)...')
    if (vp.isMobile) {
      // In mobile mode, open mobile sidebar drawer first
      const toggle = await page.$('.sidebar-mobile-toggle')
      if (toggle) {
        await toggle.click()
        await page.waitForTimeout(400)
      }
    }

    // Click Tasks navigation item
    const tasksNavBtn = await page.$('button[data-nav-id="tasks"]')
    if (tasksNavBtn) {
      await tasksNavBtn.click()
      await page.waitForTimeout(600)
    }

    // Capture screenshot with panel open
    const panelShotName = `repaired_${vp.name}_with_panel.png`
    const panelShotPath = resolve(panelShotName)
    await page.screenshot({ path: panelShotPath })
    copyFileSync(panelShotPath, resolve(ARTIFACT_DIR, panelShotName))
    console.log(`Saved screenshot: ${panelShotName}`)

    // Check Task panel bounds
    const panelMetrics = await page.evaluate(() => {
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

    if (panelMetrics) {
      const noClipping =
        panelMetrics.x >= 0 &&
        panelMetrics.x + panelMetrics.width <= vp.width + 4 &&
        panelMetrics.y >= 0
      checks.push({
        name: 'Opened Tool Window Clamped Inside Workspace (No Clipping)',
        passed: noClipping,
        details: `Panel rect: (${panelMetrics.x}, ${panelMetrics.y}, ${panelMetrics.width}x${panelMetrics.height}) in viewport ${vp.width}x${vp.height}`,
      })
    }

    const vpPassed = checks.every((c) => c.passed)
    if (!vpPassed) results.allPassed = false

    results.viewports[vp.name] = {
      viewport: vp,
      metrics: layoutMetrics,
      checks,
      passed: vpPassed,
    }

    for (const c of checks) {
      console.log(`  [${c.passed ? 'PASS' : 'FAIL'}] ${c.name}: ${c.details}`)
    }

    await context.close()
  }

  await browser.close()

  writeFileSync('layout_verification_results.json', JSON.stringify(results, null, 2))
  console.log('\n=== ALL VIEWPORTS TESTED. Summary saved to layout_verification_results.json ===')
  return results
}

runVerification()
  .then((r) => {
    if (!r.allPassed) {
      console.error('Verification had failures!')
      process.exit(1)
    }
    console.log('All layout verification checks PASSED!')
    process.exit(0)
  })
  .catch((err) => {
    console.error('Verification failed with error:', err)
    process.exit(1)
  })

