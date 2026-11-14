import { readFileSync, writeFileSync } from 'fs'

const cssPath = 'src/App.css'
let css = readFileSync(cssPath, 'utf-8')

// 1. Add topbar-left and sidebar-mobile-toggle after .jarvis-topbar definition
const topbarMarker = `.jarvis-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px clamp(16px, 3vw, 34px);
  border-bottom: 1px solid var(--hairline);
  background: linear-gradient(180deg, rgba(5, 8, 14, 0.82), rgba(5, 8, 14, 0.32));
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}`

const topbarReplacement = `.jarvis-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px clamp(16px, 3vw, 34px);
  border-bottom: 1px solid var(--hairline);
  background: linear-gradient(180deg, rgba(5, 8, 14, 0.82), rgba(5, 8, 14, 0.32));
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  position: relative;
  z-index: 45;
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.sidebar-mobile-toggle {
  display: none;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--hairline);
  background: rgba(6, 10, 18, 0.7);
  color: var(--text-secondary);
  cursor: pointer;
  align-items: center;
  justify-content: center;
  transition: all 0.2s var(--ease-out);
}

.sidebar-mobile-toggle:hover {
  color: var(--accent);
  border-color: var(--accent-soft);
  background: hsl(var(--accent-h) 92% 52% / 0.1);
}`

if (css.includes(topbarMarker)) {
  css = css.replace(topbarMarker, topbarReplacement)
  console.log('1. Replaced topbar styles successfully.')
} else {
  console.warn('1. Topbar marker not found with exact CRLF/LF. Trying regex.')
  css = css.replace(/\.jarvis-topbar\s*\{[\s\S]*?backdrop-filter:\s*blur\(10px\);\s*-webkit-backdrop-filter:\s*blur\(10px\);\s*\}/, topbarReplacement)
  console.log('1. Replaced topbar styles via regex.')
}

// 2. Replace the old taskbar rail with the redesigned sidebar styles
const taskbarBlockRegex = /\/\* ---- Taskbar \(left vertical rail\) ---- \*\/[\s\S]*?\.taskbar-separator\s*\{[\s\S]*?margin:\s*4px 0;\s*\}/

const newSidebarStyles = `/* ---- Taskbar (intelligent left sidebar) ---- */
.jarvis-shell {
  --sidebar-w-expanded: 240px;
  --sidebar-w-collapsed: 64px;
  --sidebar-width: var(--sidebar-w-expanded);
}

.jarvis-shell.is-sidebar-collapsed {
  --sidebar-width: var(--sidebar-w-collapsed);
}

.jarvis-shell.is-sidebar-expanded {
  --sidebar-width: var(--sidebar-w-expanded);
}

.jarvis-taskbar {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: var(--sidebar-width);
  display: flex;
  flex-direction: column;
  padding: 0;
  background: linear-gradient(180deg, rgba(6, 10, 18, 0.96) 0%, rgba(4, 7, 13, 0.94) 100%);
  border-right: 1px solid var(--hairline);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: 4px 0 24px rgba(0, 0, 0, 0.4);
  z-index: 60;
  pointer-events: auto;
  transition: width 0.24s cubic-bezier(0.16, 1, 0.3, 1), transform 0.24s cubic-bezier(0.16, 1, 0.3, 1);
  overflow: visible;
  user-select: none;
}

.jarvis-taskbar::-webkit-scrollbar { display: none; }

/* Brand Area */
.taskbar-brand-area {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid var(--hairline);
  background: rgba(8, 14, 24, 0.4);
  gap: 8px;
  flex-shrink: 0;
}

.taskbar-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  overflow: hidden;
  text-decoration: none;
}

.taskbar-brand-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 12px var(--accent-glow);
  flex-shrink: 0;
}

.taskbar-brand-info {
  display: flex;
  flex-direction: column;
  line-height: 1.1;
  overflow: hidden;
  white-space: nowrap;
}

.taskbar-brand-title {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--text-primary);
}

.taskbar-brand-subtitle {
  font-family: var(--font-mono);
  font-size: 8.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--accent);
  opacity: 0.85;
}

.taskbar-collapse-btn {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-faint);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s var(--ease-out);
  flex-shrink: 0;
}

.taskbar-collapse-btn:hover {
  color: var(--accent);
  border-color: var(--accent-soft);
  background: hsl(var(--accent-h) 92% 52% / 0.1);
}

.taskbar-mobile-close-btn {
  display: none;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--hairline);
  background: transparent;
  color: var(--text-secondary);
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

/* Nav Scroll Area */
.taskbar-nav-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: visible;
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  scrollbar-width: none;
}

.taskbar-nav-scroll::-webkit-scrollbar {
  display: none;
}

.taskbar-nav-group {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.taskbar-section-title {
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: var(--text-faint);
  padding: 4px 10px;
  text-transform: uppercase;
}

.taskbar-section-divider {
  width: 24px;
  height: 1px;
  background: var(--hairline);
  margin: 6px auto;
}

.taskbar-nav-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.taskbar-item-wrapper {
  position: relative;
}

.taskbar-nav-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-body);
  text-align: left;
  cursor: pointer;
  position: relative;
  transition: all 0.18s var(--ease-out);
}

.taskbar-nav-item:hover {
  color: var(--text-primary);
  background: hsl(192 40% 82% / 0.05);
  border-color: var(--hairline);
}

.taskbar-nav-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.taskbar-nav-item.is-active {
  color: var(--text-primary);
  background: hsl(var(--accent-h) 92% 52% / 0.1);
  border-color: hsl(var(--accent-h) 92% 52% / 0.3);
}

.taskbar-nav-item.is-compact {
  width: 42px;
  height: 42px;
  padding: 0;
  justify-content: center;
  margin: 0 auto;
}

.taskbar-nav-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-faint);
  transition: color 0.18s ease;
}

.taskbar-nav-item:hover .taskbar-nav-icon,
.taskbar-nav-item.is-active .taskbar-nav-icon {
  color: var(--accent);
}

.taskbar-nav-details {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.taskbar-nav-label {
  font-family: var(--font-display);
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-primary);
  line-height: 1.2;
}

.taskbar-nav-desc {
  font-family: var(--font-body);
  font-size: 10.5px;
  color: var(--text-faint);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.taskbar-active-pill {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--accent);
  padding: 2px 5px;
  border-radius: 4px;
  background: hsl(var(--accent-h) 92% 52% / 0.14);
  border: 1px solid hsl(var(--accent-h) 92% 52% / 0.3);
  flex-shrink: 0;
}

.taskbar-active-bar {
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent-glow);
}

/* Tooltips in Collapsed Mode */
.taskbar-tooltip {
  position: absolute;
  left: calc(100% + 10px);
  top: 50%;
  transform: translateY(-50%);
  background: rgba(6, 11, 20, 0.96);
  border: 1px solid var(--hairline-strong);
  border-radius: 8px;
  padding: 8px 12px;
  min-width: 170px;
  max-width: 220px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.7), 0 0 1px 1px hsl(var(--accent-h) 92% 52% / 0.2);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  z-index: 100;
  pointer-events: none;
  animation: tooltipFadeIn 0.15s var(--ease-out);
}

@keyframes tooltipFadeIn {
  from {
    opacity: 0;
    transform: translate(-4px, -50%);
  }
  to {
    opacity: 1;
    transform: translate(0, -50%);
  }
}

.tooltip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 3px;
}

.tooltip-section {
  font-family: var(--font-mono);
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--accent);
}

.tooltip-badge {
  font-family: var(--font-mono);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: hsl(145 72% 55%);
  padding: 1px 4px;
  border-radius: 3px;
  background: hsl(145 72% 48% / 0.15);
}

.tooltip-title {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.tooltip-desc {
  font-family: var(--font-body);
  font-size: 10.5px;
  color: var(--text-secondary);
  line-height: 1.3;
}

/* Footer Utilities */
.taskbar-footer {
  border-top: 1px solid var(--hairline);
  background: rgba(8, 14, 24, 0.5);
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}

.taskbar-env-wrapper {
  position: relative;
}

.taskbar-env-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--hairline);
  background: rgba(8, 14, 24, 0.4);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s var(--ease-out);
}

.taskbar-env-btn:hover,
.taskbar-env-btn.is-open {
  border-color: var(--accent-soft);
  color: var(--text-primary);
  background: hsl(var(--accent-h) 92% 52% / 0.08);
}

.taskbar-env-btn.is-compact {
  width: 42px;
  height: 42px;
  padding: 0;
  justify-content: center;
  margin: 0 auto;
}

.taskbar-env-glyph {
  font-size: 14px;
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.taskbar-env-details {
  display: flex;
  flex-direction: column;
  text-align: left;
  min-width: 0;
  flex: 1;
}

.taskbar-env-label {
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.taskbar-env-sublabel {
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-faint);
}

.taskbar-env-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  width: 220px;
  background: rgba(6, 11, 20, 0.98);
  border: 1px solid var(--hairline-strong);
  border-radius: 10px;
  padding: 6px;
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  z-index: 120;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 280px;
  overflow-y: auto;
}

.taskbar-env-popover-header {
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--accent);
  padding: 4px 8px;
  text-transform: uppercase;
  border-bottom: 1px solid var(--hairline);
  margin-bottom: 2px;
}

.taskbar-env-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  width: 100%;
  text-align: left;
  transition: all 0.15s ease;
}

.taskbar-env-item:hover {
  background: hsl(var(--accent-h) 92% 52% / 0.08);
  color: var(--text-primary);
  border-color: var(--accent-soft);
}

.taskbar-env-item.is-active {
  background: hsl(var(--accent-h) 92% 52% / 0.14);
  color: var(--accent);
  border-color: hsl(var(--accent-h) 92% 52% / 0.3);
}

.taskbar-env-item-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.taskbar-env-item-name {
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 600;
  color: inherit;
}

.taskbar-env-item-desc {
  font-family: var(--font-body);
  font-size: 9.5px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.taskbar-env-check {
  font-size: 11px;
  color: var(--accent);
  font-weight: bold;
}

.taskbar-action-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-faint);
  font-family: var(--font-display);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.18s ease;
}

.taskbar-action-btn:hover {
  color: var(--text-primary);
  background: hsl(192 40% 82% / 0.06);
  border-color: var(--hairline);
}

.taskbar-action-btn.is-compact {
  width: 42px;
  height: 42px;
  padding: 0;
  justify-content: center;
  margin: 0 auto;
}

.taskbar-status-bar {
  padding: 4px 10px;
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--text-faint);
  letter-spacing: 0.06em;
  border-top: 1px solid var(--hairline);
  margin-top: 2px;
}`

if (taskbarBlockRegex.test(css)) {
  css = css.replace(taskbarBlockRegex, newSidebarStyles)
  console.log('2. Replaced taskbar styles successfully.')
} else {
  console.error('2. Failed to match taskbar block regex!')
  process.exit(1)
}

// 3. Update panel-host left offset
css = css.replace(
  /\.panel-host\s*\{[\s\S]*?left:\s*56px;/,
  `.panel-host {\n  position: fixed;\n  top: 0;\n  left: var(--sidebar-width);\n  transition: left 0.24s cubic-bezier(0.16, 1, 0.3, 1);`
)
console.log('3. Updated .panel-host styles.')

// 4. Update stage overlay and media queries
const stageMediaRegex = /\/\* ---- Stage overlay adjustments \(keep ArcReactor, CoreCaption, etc\.\) ---- \*\/[\s\S]*?@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\}/

const newStageMedia = `/* ---- Stage overlay adjustments ---- */
.jarvis-stage {
  margin-left: var(--sidebar-width);
  transition: margin-left 0.24s cubic-bezier(0.16, 1, 0.3, 1);
}

/* Mobile drawer backdrop */
.sidebar-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(2, 4, 10, 0.72);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  z-index: 55;
  animation: backdropFadeIn 0.2s ease-out;
}

@keyframes backdropFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (max-width: 768px) {
  .sidebar-mobile-toggle {
    display: inline-flex;
  }

  .jarvis-shell {
    --sidebar-width: 0px !important;
  }

  .panel-host {
    left: 0 !important;
  }

  .jarvis-stage {
    margin-left: 0 !important;
  }

  .jarvis-taskbar {
    width: 260px !important;
    transform: translateX(-100%);
    box-shadow: 8px 0 32px rgba(0, 0, 0, 0.8);
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
}`

if (stageMediaRegex.test(css)) {
  css = css.replace(stageMediaRegex, newStageMedia)
  console.log('4. Replaced stage and responsive media styles successfully.')
} else {
  console.error('4. Failed to match stage media regex!')
  process.exit(1)
}

writeFileSync(cssPath, css, 'utf-8')
console.log('CSS update complete!')

