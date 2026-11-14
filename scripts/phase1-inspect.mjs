import { chromium } from 'playwright'
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ARTIFACT_DIR = 'C:/Users/vamru/.gemini/antigravity/brain/26136f32-4d12-42d9-b932-21bf5f8915e8'

async function inspect() {
  console.log('=== PHASE 1: Real Application Layout & Visual Inspection ===')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const page = await context.newPage()

  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  // 1. Full page initial screenshot
  const fullShot = resolve('inspect_1440_initial_full.png')
  await page.screenshot({ path: fullShot })
  console.log(`Saved initial full screenshot: ${fullShot}`)
  copyFileSync(fullShot, resolve(ARTIFACT_DIR, 'inspect_1440_initial_full.png'))

  // 2. Collect bounding rectangles and computed styles of all key visible elements
  const inventory = await page.evaluate(() => {
    const selectors = [
      '.jarvis-shell',
      '.jarvis-topbar',
      '.topbar-left',
      '.topbar-right',
      '.brand',
      '.topbar-context',
      '.clock',
      '.status-chip',
      '.jarvis-taskbar',
      '.taskbar-brand-area',
      '.taskbar-nav-scroll',
      '.taskbar-footer',
      '.jarvis-stage',
      '.core-caption',
      '.core-title',
      '.core-line',
      '.jarvis-dock',
      '.voice-button',
      '.voice-status',
      '.crush-btn',
      '.goal-composer',
      '.dock-hint',
      '.panel-host',
      '.panel-window',
    ]

    const items = []
    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel))
      for (const el of els) {
        const r = el.getBoundingClientRect()
        const cs = window.getComputedStyle(el)
        items.push({
          selector: sel,
          tagName: el.tagName,
          className: el.className,
          title: el.getAttribute('aria-label') || el.innerText?.slice(0, 30)?.replace(/\n/g, ' ') || '',
          rect: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            left: Math.round(r.left),
            right: Math.round(r.right),
          },
          styles: {
            position: cs.position,
            display: cs.display,
            zIndex: cs.zIndex,
            overflow: cs.overflow,
            marginTop: cs.marginTop,
            marginLeft: cs.marginLeft,
            padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
          },
        })
      }
    }

    // Now find any intersection between any pair of visible top-level widgets
    // Exclude parent-child intersections
    const overlaps = []
    const windows = Array.from(document.querySelectorAll('.panel-window'))
    const dockEls = Array.from(document.querySelectorAll('.jarvis-dock > *'))
    const stageEls = Array.from(document.querySelectorAll('.jarvis-stage > *'))
    const topbar = document.querySelector('.jarvis-topbar')
    const taskbar = document.querySelector('.jarvis-taskbar')

    const topWidgets = [
      { name: 'Topbar', el: topbar },
      { name: 'Sidebar', el: taskbar },
      ...windows.map((w) => ({ name: `Panel: ${w.querySelector('.panel-window-label')?.textContent?.trim() || 'Window'}`, el: w })),
      ...dockEls.map((d) => ({ name: `Dock item: ${d.className}`, el: d })),
      ...stageEls.map((s) => ({ name: `Stage item: ${s.className}`, el: s })),
    ].filter((w) => w.el && w.el.getBoundingClientRect().width > 0 && w.el.getBoundingClientRect().height > 0)

    for (let i = 0; i < topWidgets.length; i++) {
      for (let j = i + 1; j < topWidgets.length; j++) {
        const a = topWidgets[i]
        const b = topWidgets[j]
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue

        const ra = a.el.getBoundingClientRect()
        const rb = b.el.getBoundingClientRect()

        const intersects = !(
          ra.right <= rb.left ||
          ra.left >= rb.right ||
          ra.bottom <= rb.top ||
          ra.top >= rb.bottom
        )

        if (intersects) {
          const overlapW = Math.round(Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left))
          const overlapH = Math.round(Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top))
          overlaps.push({
            a: a.name,
            b: b.name,
            overlapWidth: overlapW,
            overlapHeight: overlapH,
            rectA: { x: Math.round(ra.x), y: Math.round(ra.y), w: Math.round(ra.width), h: Math.round(ra.height) },
            rectB: { x: Math.round(rb.x), y: Math.round(rb.y), w: Math.round(rb.width), h: Math.round(rb.height) },
          })
        }
      }
    }

    return { items, overlaps }
  })

  console.log(`\nCollected ${inventory.items.length} component bounding boxes.`)
  console.log(`Detected ${inventory.overlaps.length} intersections/overlaps:`)
  for (const o of inventory.overlaps) {
    console.log(`  OVERLAP: "${o.a}" intersects with "${o.b}" by ${o.overlapWidth}x${o.overlapHeight}px!`)
    console.log(`    A: ${JSON.stringify(o.rectA)}`)
    console.log(`    B: ${JSON.stringify(o.rectB)}`)
  }

  // 3. Capture individual screenshots of each open panel
  const panelElements = await page.locator('.panel-window').all()
  console.log(`\nCapturing screenshots of ${panelElements.length} open panels...`)
  for (let i = 0; i < panelElements.length; i++) {
    const p = panelElements[i]
    const title = (await p.locator('.panel-window-label').innerText()).trim().toLowerCase().replace(/\s+/g, '_')
    const panelShot = resolve(`inspect_panel_${title}.png`)
    await p.screenshot({ path: panelShot })
    console.log(`  Saved panel: ${panelShot}`)
    copyFileSync(panelShot, resolve(ARTIFACT_DIR, `inspect_panel_${title}.png`))
  }

  // 4. Capture screenshot of Dock and Composer
  const dock = page.locator('.jarvis-dock')
  const dockShot = resolve('inspect_dock.png')
  await dock.screenshot({ path: dockShot })
  console.log(`Saved dock screenshot: ${dockShot}`)
  copyFileSync(dockShot, resolve(ARTIFACT_DIR, 'inspect_dock.png'))

  // 5. Capture screenshot of Topbar
  const topbar = page.locator('.jarvis-topbar')
  const topbarShot = resolve('inspect_topbar.png')
  await topbar.screenshot({ path: topbarShot })
  console.log(`Saved topbar screenshot: ${topbarShot}`)
  copyFileSync(topbarShot, resolve(ARTIFACT_DIR, 'inspect_topbar.png'))

  await browser.close()
}

inspect().catch((err) => {
  console.error('Inspection failed:', err)
  process.exit(1)
})

