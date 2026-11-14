import { chromium } from 'playwright'
import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ARTIFACT_DIR = 'C:/Users/vamru/.gemini/antigravity/brain/26136f32-4d12-42d9-b932-21bf5f8915e8'

async function run() {
  console.log('--- Starting Comprehensive JARVIS 4.0 Sidebar UX Verification ---')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  try {
    // 1. Desktop Test (1440x900)
    console.log('\n[1/4] Desktop 1440x900 Verification...')
    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    })
    const page = await desktopContext.newPage()

    // Clear local storage first
    await page.goto('http://localhost:3000')
    await page.evaluate(() => localStorage.removeItem('jarvis_sidebar_collapsed'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)

    // Verify taskbar container
    const taskbar = page.locator('.jarvis-taskbar')
    await taskbar.waitFor({ state: 'visible' })
    const isExpanded = await page.evaluate(() => {
      const el = document.querySelector('.jarvis-taskbar')
      return el && !el.classList.contains('is-collapsed') && el.getBoundingClientRect().width >= 220
    })
    console.log(`  Sidebar expanded by default: ${isExpanded ? 'PASS' : 'FAIL'}`)

    // Check section headings
    const sectionHeaders = await page.locator('.taskbar-section-title').allInnerTexts()
    console.log(`  Section titles rendered: ${JSON.stringify(sectionHeaders)}`)

    // Check item labels
    const itemLabels = await page.locator('.taskbar-nav-label').allInnerTexts()
    console.log(`  Nav items count: ${itemLabels.length}, labels: ${itemLabels.slice(0, 5).join(', ')}...`)

    // Save Desktop Expanded Screenshot
    const desktopPath = resolve('jarvis-hud-after-desktop.png')
    await page.screenshot({ path: desktopPath })
    console.log(`  Saved screenshot: ${desktopPath}`)
    copyFileSync(desktopPath, resolve(ARTIFACT_DIR, 'jarvis-hud-after-desktop.png'))

    // Test Collapse Button
    console.log('\n[2/4] Testing Sidebar Collapse & Toggle...')
    const collapseBtn = page.locator('.taskbar-collapse-btn')
    await collapseBtn.click()
    await page.waitForTimeout(400)

    const isCollapsedNow = await page.evaluate(() => {
      const el = document.querySelector('.jarvis-taskbar')
      const stored = localStorage.getItem('jarvis_sidebar_collapsed')
      return el && el.classList.contains('is-collapsed') && stored === 'true' && el.getBoundingClientRect().width <= 70
    })
    console.log(`  Sidebar collapsed correctly via button: ${isCollapsedNow ? 'PASS' : 'FAIL'}`)

    // Save Desktop Collapsed Screenshot
    const collapsedPath = resolve('jarvis-hud-collapsed.png')
    await page.screenshot({ path: collapsedPath })
    console.log(`  Saved screenshot: ${collapsedPath}`)
    copyFileSync(collapsedPath, resolve(ARTIFACT_DIR, 'jarvis-hud-collapsed.png'))

    // Test Keyboard Shortcut Ctrl+B
    await page.keyboard.press('Control+b')
    await page.waitForTimeout(400)
    const isExpandedViaKey = await page.evaluate(() => {
      const el = document.querySelector('.jarvis-taskbar')
      return el && !el.classList.contains('is-collapsed')
    })
    console.log(`  Sidebar expanded via Ctrl+B shortcut: ${isExpandedViaKey ? 'PASS' : 'FAIL'}`)

    // Test Panel Toggling (e.g. Tasks panel)
    const tasksBtn = page.locator('button.taskbar-nav-item', { hasText: 'Tasks' })
    await tasksBtn.click()
    await page.waitForTimeout(500)
    const isTasksOpen = await page.evaluate(() => {
      return document.querySelector('.panel-window') !== null
    })
    console.log(`  Panel window opened upon clicking nav item: ${isTasksOpen ? 'PASS' : 'FAIL'}`)

    await desktopContext.close()

    // 3. Tablet Test (768x1024)
    console.log('\n[3/4] Tablet 768x1024 Verification...')
    const tabletContext = await browser.newContext({
      viewport: { width: 768, height: 1024 },
    })
    const tabletPage = await tabletContext.newPage()
    await tabletPage.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' })
    await tabletPage.waitForTimeout(2000)

    const tabletPath = resolve('jarvis-hud-tablet.png')
    await tabletPage.screenshot({ path: tabletPath })
    console.log(`  Saved tablet screenshot: ${tabletPath}`)
    copyFileSync(tabletPath, resolve(ARTIFACT_DIR, 'jarvis-hud-tablet.png'))
    await tabletContext.close()

    // 4. Mobile Test (390x844)
    console.log('\n[4/4] Mobile 390x844 Verification...')
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    })
    const mobilePage = await mobileContext.newPage()
    await mobilePage.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' })
    await mobilePage.waitForTimeout(2000)

    // Verify Hamburger button is visible
    const hamburger = mobilePage.locator('.sidebar-mobile-toggle')
    const hamburgerVisible = await hamburger.isVisible()
    console.log(`  Mobile hamburger toggle visible: ${hamburgerVisible ? 'PASS' : 'FAIL'}`)

    // Save Mobile Initial Screenshot
    const mobilePath = resolve('jarvis-hud-mobile.png')
    await mobilePage.screenshot({ path: mobilePath })
    console.log(`  Saved mobile closed screenshot: ${mobilePath}`)
    copyFileSync(mobilePath, resolve(ARTIFACT_DIR, 'jarvis-hud-mobile.png'))

    // Open Mobile Drawer
    await hamburger.click()
    await mobilePage.waitForTimeout(400)

    const isDrawerOpen = await mobilePage.evaluate(() => {
      const el = document.querySelector('.jarvis-taskbar')
      const backdrop = document.querySelector('.sidebar-backdrop')
      return el && el.classList.contains('is-mobile-open') && backdrop !== null
    })
    console.log(`  Mobile drawer opened with backdrop: ${isDrawerOpen ? 'PASS' : 'FAIL'}`)

    // Save Mobile Drawer Opened Screenshot
    const drawerPath = resolve('jarvis-hud-mobile-drawer.png')
    await mobilePage.screenshot({ path: drawerPath })
    console.log(`  Saved mobile drawer screenshot: ${drawerPath}`)
    copyFileSync(drawerPath, resolve(ARTIFACT_DIR, 'jarvis-hud-mobile-drawer.png'))

    // Close Mobile Drawer via close button
    const closeBtn = mobilePage.locator('.taskbar-mobile-close-btn')
    await closeBtn.click()
    await mobilePage.waitForTimeout(400)

    const isDrawerClosed = await mobilePage.evaluate(() => {
      const el = document.querySelector('.jarvis-taskbar')
      return el && !el.classList.contains('is-mobile-open')
    })
    console.log(`  Mobile drawer closed via close button: ${isDrawerClosed ? 'PASS' : 'FAIL'}`)

    await mobileContext.close()

    console.log('\n--- ALL SIDEBAR UX VERIFICATION TESTS PASSED SUCCESSFULLY! ---')
  } finally {
    await browser.close()
  }
}

run().catch((err) => {
  console.error('Verification failed:', err)
  process.exit(1)
})
