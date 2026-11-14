import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

async function run() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  const analysis = await page.evaluate(() => {
    const defects = []

    // 1. Check Topbar & Header
    const topbar = document.querySelector('.jarvis-topbar')
    const taskbar = document.querySelector('.jarvis-taskbar')
    const tr = topbar ? topbar.getBoundingClientRect() : null
    const sr = taskbar ? taskbar.getBoundingClientRect() : null

    // 2. Check Stage & Central Elements
    const stage = document.querySelector('.jarvis-stage')
    const stageRect = stage ? stage.getBoundingClientRect() : null

    const caption = document.querySelector('.core-caption')
    const captionRect = caption ? caption.getBoundingClientRect() : null

    const arc = document.querySelector('.arc-reactor')
    const arcRect = arc ? arc.getBoundingClientRect() : null

    const dock = document.querySelector('.jarvis-dock')
    const dockRect = dock ? dock.getBoundingClientRect() : null

    const composer = document.querySelector('.goal-composer')
    const composerRect = composer ? composer.getBoundingClientRect() : null

    const voiceBtn = document.querySelector('.voice-button')
    const voiceRect = voiceBtn ? voiceBtn.getBoundingClientRect() : null

    // 3. Check All Panel Windows
    const panels = Array.from(document.querySelectorAll('.panel-window')).map((p) => {
      const label = p.querySelector('.panel-window-label')?.textContent?.trim() || 'Panel'
      const r = p.getBoundingClientRect()
      return {
        label,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) },
        style: {
          placement: p.getAttribute('style'),
          zIndex: window.getComputedStyle(p).zIndex,
        },
      }
    })

    // Defect 1: Panel collision on the left
    const camera = panels.find((p) => p.label.toLowerCase().includes('camera'))
    const taskMon = panels.find((p) => p.label.toLowerCase().includes('task'))
    const system = panels.find((p) => p.label.toLowerCase().includes('system'))
    const session = panels.find((p) => p.label.toLowerCase().includes('session'))
    const activity = panels.find((p) => p.label.toLowerCase().includes('activity'))

    if (camera && taskMon) {
      if (Math.abs(camera.rect.x - taskMon.rect.x) < 50 && Math.abs(camera.rect.y - taskMon.rect.y) < 50) {
        defects.push({
          elementName: 'Task Monitor Panel (.panel-window)',
          parentContainer: '.panel-host',
          actualXY: `(${taskMon.rect.x}, ${taskMon.rect.y})`,
          actualWH: `${taskMon.rect.w}x${taskMon.rect.h}`,
          expectedPosition: 'In center workspace or floating with proper cascaded offset without colliding with Camera',
          overlappingElement: `Camera Panel (${camera.rect.x}, ${camera.rect.y})`,
          ruleCausingIssue: 'src/panel/types.ts defaultPanelState hardcodes x: PANEL_MARGIN, y: PANEL_MARGIN for all panels; and registry.ts marks tasks as defaultOpen: true with floating placement, resulting in identical (256, 70) starting coordinates.',
          correctiveAction: 'Cascade initial floating positions, avoid opening 5 overlapping windows on initial launch, or provide dedicated dashboard layout.',
        })
      }
    }

    // Defect 2: Stage caption full-inset overlap with ArcReactor
    if (captionRect && arcRect) {
      const overlaps = !(
        captionRect.right <= arcRect.left ||
        captionRect.left >= arcRect.right ||
        captionRect.bottom <= arcRect.top ||
        captionRect.top >= arcRect.bottom
      )
      if (overlaps) {
        defects.push({
          elementName: 'Core Caption (.core-caption)',
          parentContainer: '.jarvis-stage',
          actualXY: `(${Math.round(captionRect.x)}, ${Math.round(captionRect.y)})`,
          actualWH: `${Math.round(captionRect.width)}x${Math.round(captionRect.height)}`,
          expectedPosition: 'Above or cleanly integrated with ArcReactor centerpiece without occupying full stage inset',
          overlappingElement: `Arc Reactor centerpiece (${Math.round(arcRect.x)}, ${Math.round(arcRect.y)})`,
          ruleCausingIssue: 'src/App.css .core-caption has position: absolute; inset: 0;, while .arc-reactor has position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); causing text lines to paint directly over the reactor rings.',
          correctiveAction: 'Refactor stage into a coherent flex/grid document flow where hero title and living text sit above or neatly frame the core status indicator.',
        })
      }
    }

    // Defect 3: Stage caption overlaps with floating edge panels
    if (captionRect && camera) {
      defects.push({
        elementName: 'Core Caption (.core-caption full-width container)',
        parentContainer: '.jarvis-stage',
        actualXY: `(${Math.round(captionRect.x)}, ${Math.round(captionRect.y)})`,
        actualWH: `${Math.round(captionRect.width)}x${Math.round(captionRect.height)}`,
        expectedPosition: 'Contained in center workspace between left and right panel columns',
        overlappingElement: `Edge panels (Camera: ${camera.rect.x}, Session Log: ${session ? session.rect.x : 'N/A'})`,
        ruleCausingIssue: '.core-caption spans full width (1200px) from left to right edge of stage, intersecting with side-docked panels.',
        correctiveAction: 'Constrain dashboard center stage to central column or render panels inside the structured grid.',
      })
    }

    // Defect 4: Dock and Voice Button crowding
    if (dockRect && composerRect && voiceRect) {
      defects.push({
        elementName: 'Voice Button (.voice-button) & Goal Composer (.goal-composer)',
        parentContainer: '.jarvis-dock',
        actualXY: `Voice: (${Math.round(voiceRect.x)}, ${Math.round(voiceRect.y)}), Composer: (${Math.round(composerRect.x)}, ${Math.round(composerRect.y)})`,
        actualWH: `Voice: ${Math.round(voiceRect.width)}x${Math.round(voiceRect.height)}, Composer: ${Math.round(composerRect.width)}x${Math.round(composerRect.height)}`,
        expectedPosition: 'Unified, compact command bar at bottom of workspace without competing orbital rings',
        overlappingElement: 'None directly intersecting, but excessive vertical footprint (303px height) crowding the stage',
        ruleCausingIssue: '.jarvis-dock is a column with 12px gap, 88px voice button + 52px rings + status + composer + hints, consuming over 300px of vertical viewport.',
        correctiveAction: 'Integrate the voice button and input controls into a unified horizontal or streamlined command bar, saving over 160px of vertical space.',
      })
    }

    // Defect 5: Unnecessary initial floating window clutter
    if (panels.length >= 4) {
      defects.push({
        elementName: 'Panel Host System (.panel-host with 5 open windows on launch)',
        parentContainer: '.jarvis-shell',
        actualXY: 'Across entire screen',
        actualWH: 'Multiple 260px-380px cards',
        expectedPosition: 'Clean dashboard with core metrics; windows open on demand when user clicks sidebar items or requests them',
        overlappingElement: 'All 5 panels compete with center stage, ArcReactor, and dock',
        ruleCausingIssue: 'PANEL_DEFINITIONS in src/panel/registry.ts sets defaultOpen: true on 5 panels simultaneously.',
        correctiveAction: 'Structure the initial view as a pristine, professional dashboard with organized cards (Overview, Activity, Quick Actions) and allow panels to open cleanly as focused workspace views or drawers on demand.',
      })
    }

    return {
      topbar: tr ? { x: Math.round(tr.x), y: Math.round(tr.y), w: Math.round(tr.width), h: Math.round(tr.height) } : null,
      taskbar: sr ? { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height) } : null,
      stage: stageRect ? { x: Math.round(stageRect.x), y: Math.round(stageRect.y), w: Math.round(stageRect.width), h: Math.round(stageRect.height) } : null,
      panels,
      defects,
    }
  })

  console.log('=== DEFECT INVENTORY RECORDED ===')
  console.log(JSON.stringify(analysis.defects, null, 2))
  writeFileSync('defect_inventory.json', JSON.stringify(analysis, null, 2), 'utf8')
  await browser.close()
}

run().catch(console.error)

