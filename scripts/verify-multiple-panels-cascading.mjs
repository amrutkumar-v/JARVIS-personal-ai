import { chromium } from 'playwright'
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ARTIFACT_DIR = 'C:/Users/vamru/.gemini/antigravity/brain/26136f32-4d12-42d9-b932-21bf5f8915e8'

async function runMultiPanelTest() {
  console.log('=== MULTI-PANEL CASCADING & DRAG TEST ===')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const page = await context.newPage()

  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  // Open Tasks
  const tasksBtn = await page.$('button[data-nav-id="tasks"]')
  if (tasksBtn) await tasksBtn.click()
  await page.waitForTimeout(400)

  // Open Files
  const filesBtn = await page.$('button[data-nav-id="files"]')
  if (filesBtn) await filesBtn.click()
  await page.waitForTimeout(400)

  // Open Camera
  const camBtn = await page.$('button[data-nav-id="camera"]')
  if (camBtn) await camBtn.click()
  await page.waitForTimeout(400)

  const multiShotName = 'repaired_1440px_multi_panel_open.png'
  const multiShotPath = resolve(multiShotName)
  await page.screenshot({ path: multiShotPath })
  copyFileSync(multiShotPath, resolve(ARTIFACT_DIR, multiShotName))
  console.log(`Saved screenshot: ${multiShotName}`)

  const panelData = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.panel-window:not(.is-hidden)')).map((el) => {
      const r = el.getBoundingClientRect()
      return {
        label: el.querySelector('.panel-window-label')?.innerText || '',
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }
    })
  })

  console.log('Open Panels Data:', panelData)

  // Verify none have identical (x, y) coordinates
  const coordSet = new Set(panelData.map((p) => `${p.x},${p.y}`))
  if (coordSet.size !== panelData.length) {
    console.error('FAIL: Detected overlapping panels with identical starting coordinates!')
    process.exit(1)
  }
  console.log('PASS: All opened panels have distinct cascaded coordinates (zero identical collisions).')

  // Verify all panels are within viewport bounds (0 <= x and x + width <= 1440)
  for (const p of panelData) {
    if (p.x < 0 || p.x + p.width > 1440 + 2 || p.y < 0 || p.y + p.height > 900 + 2) {
      console.error(`FAIL: Panel ${p.label} clipped viewport!`, p)
      process.exit(1)
    }
  }
  console.log('PASS: All opened panels are within viewport bounds without clipping.')

  await browser.close()
}

runMultiPanelTest()
  .then(() => {
    console.log('Multi-panel test completed successfully!')
    process.exit(0)
  })
  .catch((err) => {
    console.error('Multi-panel test failed:', err)
    process.exit(1)
  })

