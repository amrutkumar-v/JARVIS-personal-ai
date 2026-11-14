import { readFileSync, writeFileSync } from 'node:fs'

const CSS_PATH = 'src/App.css'
let css = readFileSync(CSS_PATH, 'utf8')
const isCRLF = css.includes('\r\n')
css = css.replace(/\r\n/g, '\n')

// 1. Update .jarvis-topbar and brand
const oldTopbarRegex = /\.jarvis-topbar\s*\{[\s\S]*?z-index:\s*45;\s*\}/
const newTopbar = `.jarvis-topbar {
  height: var(--topbar-height, 54px);
  margin-left: var(--sidebar-width);
  transition: margin-left 0.24s cubic-bezier(0.16, 1, 0.3, 1);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 clamp(16px, 2.5vw, 28px);
  border-bottom: 1px solid var(--glass-border-subtle);
  background: var(--glass-bg-base);
  backdrop-filter: blur(var(--glass-blur-md));
  -webkit-backdrop-filter: blur(var(--glass-blur-md));
  position: relative;
  z-index: var(--z-topbar, 30);
}`

if (oldTopbarRegex.test(css)) {
  css = css.replace(oldTopbarRegex, newTopbar)
  console.log('1. Updated .jarvis-topbar successfully.')
} else {
  console.log('1. Topbar pattern not matched.')
}

// Add topbar-context styles after .brand-phase if not present
if (!css.includes('.topbar-context')) {
  const brandPhaseTarget = '.brand-phase {\n  font-family: var(--font-mono);\n  font-size: 10px;\n  letter-spacing: 0.14em;\n  color: var(--text-faint);\n  padding: 2px 8px;\n  border: 1px solid var(--hairline);\n  border-radius: 999px;\n  text-transform: uppercase;\n}'
  const contextAddition = `

.topbar-context {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--text-faint);
  user-select: none;
}

.topbar-context-sep {
  color: var(--glass-border-medium);
  font-weight: 300;
}

.topbar-context-tag {
  color: var(--text-secondary);
  font-weight: 500;
  font-size: 10px;
}`
  css = css.replace(brandPhaseTarget, brandPhaseTarget + contextAddition)
  console.log('2. Added .topbar-context styling.')
}

// 2. Update .jarvis-dock and stage
const oldDockRegex = /\.jarvis-dock\s*\{[\s\S]*?z-index:\s*60;\s*pointer-events:\s*none;\s*\}/
const newDock = `.jarvis-dock {
  margin-left: var(--sidebar-width);
  transition: margin-left 0.24s cubic-bezier(0.16, 1, 0.3, 1);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 8px 16px calc(14px + env(safe-area-inset-bottom));
  position: relative;
  z-index: var(--z-dock, 60);
  pointer-events: none;
  flex-shrink: 0;
}`

if (oldDockRegex.test(css)) {
  css = css.replace(oldDockRegex, newDock)
  console.log('3. Updated .jarvis-dock successfully.')
} else {
  console.log('3. Dock pattern not matched.')
}

// 3. Update overlay and settings
const oldOverlayRegex = /\.overlay\s*\{[\s\S]*?animation:\s*fadeIn[^\}]*?\}/
const newOverlay = `.overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal, 100);
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(2, 4, 10, 0.74);
  backdrop-filter: blur(var(--glass-blur-sm));
  -webkit-backdrop-filter: blur(var(--glass-blur-sm));
  animation: fadeIn 0.25s var(--ease-out) both;
}`

if (oldOverlayRegex.test(css)) {
  css = css.replace(oldOverlayRegex, newOverlay)
  console.log('4. Updated .overlay successfully.')
}

const oldSettingsRegex = /\.settings\s*\{[\s\S]*?animation:\s*riseIn[^\}]*?\}/
const newSettings = `.settings {
  width: min(520px, 100%);
  max-height: 88vh;
  overflow-y: auto;
  border: 1px solid var(--glass-border-medium);
  border-radius: var(--radius-lg, 14px);
  background: var(--glass-bg-elevated);
  backdrop-filter: blur(var(--glass-blur-lg));
  -webkit-backdrop-filter: blur(var(--glass-blur-lg));
  padding: 22px 24px;
  box-shadow: var(--glass-shadow-lg);
  animation: riseIn 0.3s var(--ease-out) both;
}`

if (oldSettingsRegex.test(css)) {
  css = css.replace(oldSettingsRegex, newSettings)
  console.log('5. Updated .settings modal window successfully.')
}

// 4. Update taskbar styles: brand area height and glass styling
const oldTaskbarRegex = /\.jarvis-taskbar\s*\{[\s\S]*?user-select:\s*none;\s*\}/
const newTaskbar = `.jarvis-taskbar {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: var(--sidebar-width);
  display: flex;
  flex-direction: column;
  padding: 0;
  background: var(--glass-bg-card);
  border-right: 1px solid var(--glass-border-subtle);
  backdrop-filter: blur(var(--glass-blur-lg));
  -webkit-backdrop-filter: blur(var(--glass-blur-lg));
  box-shadow: var(--glass-shadow-md);
  z-index: var(--z-sidebar, 50);
  pointer-events: auto;
  transition: width 0.24s cubic-bezier(0.16, 1, 0.3, 1), transform 0.24s cubic-bezier(0.16, 1, 0.3, 1);
  overflow: visible;
  user-select: none;
}`

if (oldTaskbarRegex.test(css)) {
  css = css.replace(oldTaskbarRegex, newTaskbar)
  console.log('6. Updated .jarvis-taskbar surface successfully.')
}

const oldBrandAreaRegex = /\.taskbar-brand-area\s*\{[\s\S]*?flex-shrink:\s*0;\s*\}/
const newBrandArea = `.taskbar-brand-area {
  height: var(--topbar-height, 54px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid var(--glass-border-subtle);
  background: var(--glass-bg-subtle);
  gap: 8px;
  flex-shrink: 0;
}`

if (oldBrandAreaRegex.test(css)) {
  css = css.replace(oldBrandAreaRegex, newBrandArea)
  console.log('7. Updated .taskbar-brand-area height alignment successfully.')
}

// 5. Update .panel-host and .panel-window
const oldPanelHostRegex = /\.panel-host\s*\{[\s\S]*?pointer-events:\s*none;\s*\}/
const newPanelHost = `.panel-host {
  position: fixed;
  inset: 0;
  z-index: var(--z-panels, 40);
  pointer-events: none;
}`

if (oldPanelHostRegex.test(css)) {
  css = css.replace(oldPanelHostRegex, newPanelHost)
  console.log('8. Updated .panel-host inset bounds successfully.')
}

const oldPanelWindowRegex = /\.panel-window\s*\{[\s\S]*?user-select:\s*none;\s*\}/
const newPanelWindow = `.panel-window {
  position: absolute;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--glass-border-subtle);
  border-radius: var(--radius-md, 10px);
  background: var(--glass-bg-card);
  backdrop-filter: blur(var(--glass-blur-md));
  -webkit-backdrop-filter: blur(var(--glass-blur-md));
  box-shadow: var(--glass-shadow-md);
  overflow: hidden;
  transition: transform 0.22s var(--ease-out), box-shadow 0.22s var(--ease-out), border-color 0.22s var(--ease-out);
  touch-action: none;
  user-select: none;
}`

if (oldPanelWindowRegex.test(css)) {
  css = css.replace(oldPanelWindowRegex, newPanelWindow)
  console.log('9. Updated .panel-window glassmorphism styling successfully.')
}

// 6. Update nested panel styles
const oldFocusedRegex = /\.panel-window\.is-focused\s*\{[\s\S]*?box-shadow:[^\}]*?\}/
const newFocused = `.panel-window.is-focused {
  border-color: var(--glass-border-glow);
  box-shadow: var(--glass-shadow-focused);
}

/* Eliminate nested double containers inside panel windows */
.panel-window .panel {
  border: none !important;
  border-radius: 0 !important;
  background: transparent !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  box-shadow: none !important;
  padding: 12px 14px;
}

.panel-window .panel-title {
  display: none !important;
}`

if (oldFocusedRegex.test(css)) {
  css = css.replace(oldFocusedRegex, newFocused)
  console.log('10. Added nested panel decluttering rules.')
}

// 7. Update mobile media query
const oldMediaRegex = /@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\.taskbar-collapse-btn\s*\{[\s\S]*?display:\s*none;\s*\}\s*\}/
const newMedia = `@media (max-width: 768px) {
  .sidebar-mobile-toggle {
    display: inline-flex;
  }

  .topbar-context {
    display: none;
  }

  .jarvis-shell {
    --sidebar-width: 0px !important;
  }

  .jarvis-topbar {
    margin-left: 0 !important;
  }

  .panel-host {
    inset: 0 !important;
  }

  .jarvis-stage {
    margin-left: 0 !important;
  }

  .jarvis-dock {
    margin-left: 0 !important;
  }

  .jarvis-taskbar {
    width: 260px !important;
    transform: translateX(-100%);
    box-shadow: 8px 0 32px rgba(0, 0, 0, 0.85);
  }

  .jarvis-taskbar.is-mobile-open {
    transform: translateX(0);
  }

  .taskbar-mobile-close-btn {
    display: inline-flex;
  }

  .taskbar-collapse-btn {
    display: none;
  }

  /* Make panels responsive on mobile */
  .panel-window {
    border-radius: var(--radius-sm, 6px);
  }
}`

if (oldMediaRegex.test(css)) {
  css = css.replace(oldMediaRegex, newMedia)
  console.log('11. Updated mobile media queries successfully.')
}

// Convert back to original line endings and save
const finalCss = isCRLF ? css.replace(/\n/g, '\r\n') : css
writeFileSync(CSS_PATH, finalCss, 'utf8')
console.log('Glassmorphism CSS patch written successfully!')

