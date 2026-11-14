import { chromium } from 'playwright'
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const RESOLUTIONS = [
  { name: '1080p_FHD', width: 1920, height: 1080 },
  { name: '768p_Laptop', width: 1366, height: 768 },
  { name: '1440p_QHD', width: 2560, height: 1440 },
  { name: '720p_HD', width: 1280, height: 720 },
]

async function main() {
  console.log('Starting Phase 13 Multi-Resolution HUD Viewport Audit...')
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const results = []

  for (const res of RESOLUTIONS) {
    console.log(`\nTesting Viewport: ${res.name} (${res.width}x${res.height})...`)
    const context = await browser.newContext({
      viewport: { width: res.width, height: res.height },
    })
    const page = await context.newPage()

    const consoleErrors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message || String(err))
    })

    try {
      const response = await page.goto('http://localhost:3000', {
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      })
      await page.waitForTimeout(2000)

      const title = await page.title()
      const canvasCount = await page.locator('canvas').count()
      const divCount = await page.locator('div').count()
      
      const screenshotPath = `D:\\JARVIS-Test\\JARVIS-3.1\\hud_${res.name}.png`
      await page.screenshot({ path: screenshotPath, type: 'png' })

      const passed = response?.status() === 200 && consoleErrors.length === 0 && divCount > 5
      console.log(`  Status: ${response?.status()}`)
      console.log(`  Title: "${title}"`)
      console.log(`  Canvas Elements: ${canvasCount} | DOM Elements: ${divCount}`)
      console.log(`  Console Errors: ${consoleErrors.length}`)
      console.log(`  Screenshot Saved: ${screenshotPath}`)
      console.log(`  Audit Result: ${passed ? '[PASS]' : '[FAIL]'}`)

      results.push({
        resolution: `${res.width}x${res.height}`,
        name: res.name,
        httpStatus: response?.status(),
        consoleErrors: consoleErrors.length,
        canvasPresent: canvasCount > 0,
        domElements: divCount,
        passed,
      })
    } catch (err) {
      console.error(`  Error in ${res.name}: ${err.message}`)
      results.push({
        resolution: `${res.width}x${res.height}`,
        name: res.name,
        error: err.message,
        passed: false,
      })
    } finally {
      await context.close()
    }
  }

  await browser.close()

  console.log('\n========================================================================')
  console.log('               HUD MULTI-RESOLUTION AUDIT SUMMARY                       ')
  console.log('========================================================================')
  console.table(results)

  const allPassed = results.every((r) => r.passed)
  console.log(`Final Outcome: ${allPassed ? 'ALL RESOLUTIONS PASSED (4/4)' : 'FAILURES DETECTED'}`)
  process.exit(allPassed ? 0 : 1)
}

main().catch((err) => {
  console.error('Fatal audit failure:', err)
  process.exit(1)
})

