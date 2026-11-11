import { chromium } from '../native/node_modules/playwright/index.mjs'
import { join } from 'node:path'

async function main() {
  console.log('Launching browser to test http://localhost:3000 ...')
  
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
  })

  const context = await browser.newContext()
  const page = await context.newPage()

  const consoleLogs = []
  const pageErrors = []

  page.on('console', (msg) => {
    consoleLogs.push({ type: msg.type(), text: msg.text(), location: msg.location() })
    console.log(`[BROWSER ${msg.type().toUpperCase()}] ${msg.text()}`)
  })

  page.on('pageerror', (err) => {
    pageErrors.push(err.message || String(err))
    console.error(`[BROWSER PAGEERROR] ${err.message || String(err)}`)
  })

  try {
    const response = await page.goto('http://localhost:3000', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    })

    console.log(`HTTP Status: ${response?.status()}`)
    
    // Wait an extra second for React mounting & 3D canvas / HUD initialization
    await page.waitForTimeout(2000)

    const title = await page.title()
    console.log(`Page Title: ${title}`)

    // Check root content
    const rootHtml = await page.evaluate(() => {
      const root = document.getElementById('root')
      return root ? root.innerHTML.slice(0, 500) : 'NO_ROOT'
    })
    console.log(`Root innerHTML snippet: ${rootHtml}`)

    // Check for any canvas or HUD elements
    const hasCanvas = await page.locator('canvas').count()
    console.log(`Canvas count: ${hasCanvas}`)

    const hasHUD = await page.locator('[data-hud], .hud-container, div').count()
    console.log(`Div count: ${hasHUD}`)

    // Save screenshot to artifacts directory and workspace
    const artifactScreenshotPath = 'C:\\Users\\vamru\\.gemini\\antigravity\\brain\\26136f32-4d12-42d9-b932-21bf5f8915e8\\jarvis-hud-rendered.png'
    const localScreenshotPath = join(process.cwd(), 'jarvis-hud-rendered.png')

    await page.screenshot({ path: artifactScreenshotPath, fullPage: true })
    await page.screenshot({ path: localScreenshotPath, fullPage: true })

    console.log(`Screenshot saved to: ${artifactScreenshotPath}`)
    console.log(`Screenshot saved locally to: ${localScreenshotPath}`)

    console.log(`Total console logs: ${consoleLogs.length}`)
    console.log(`Total page errors: ${pageErrors.length}`)

    if (pageErrors.length > 0) {
      console.error('FAILED: Page encountered errors:', pageErrors)
      process.exit(1)
    }

    console.log('SUCCESS: UI verified and rendered with 0 page errors.')
  } catch (err) {
    console.error('Error during verification:', err)
    process.exit(1)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
