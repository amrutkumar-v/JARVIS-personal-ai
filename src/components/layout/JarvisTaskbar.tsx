import React, { useState, useCallback, useId } from 'react'
import { usePanelLayoutStore } from '../../panel/panelStore'
import { useEnvironmentActions } from '../../environment/useEnvironmentActions'
import { ENVIRONMENT_BY_ID, DEFAULT_ENVIRONMENT, isEnvironmentId } from '../../environment/registry'
import type { PanelId } from '../../panel/types'
import {
  IconOverview,
  IconAssistant,
  IconTasks,
  IconApplications,
  IconFiles,
  IconCamera,
  IconVision,
  IconActivity,
  IconSystem,
  IconDevices,
  IconEnvironments,
  IconSettings,
  IconResetLayout,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
} from './SidebarIcons'

interface Props {
  onOpenSettings: () => void
  mobileOpen?: boolean
  onCloseMobile?: () => void
  isCollapsed?: boolean
  onToggleCollapse?: (collapsed: boolean) => void
}

interface NavItemDef {
  id: PanelId | 'settings'
  label: string
  description: string
  icon: (props: { size?: number }) => React.ReactElement
  shortcut?: string
}

interface NavSectionDef {
  id: 'main' | 'workspace' | 'system'
  title: string
  items: NavItemDef[]
}

const NAV_SECTIONS: NavSectionDef[] = [
  {
    id: 'main',
    title: 'MAIN',
    items: [
      {
        id: 'core',
        label: 'Overview',
        description: 'Core runtime status & system summary',
        icon: IconOverview,
      },
      {
        id: 'conversation',
        label: 'Assistant',
        description: 'Interactive conversation & session log',
        icon: IconAssistant,
      },
      {
        id: 'tasks',
        label: 'Tasks',
        description: 'Active, queued & completed autonomous workflows',
        icon: IconTasks,
      },
      {
        id: 'applications',
        label: 'Applications',
        description: 'Desktop apps & window observation',
        icon: IconApplications,
      },
    ],
  },
  {
    id: 'workspace',
    title: 'WORKSPACE',
    items: [
      {
        id: 'files',
        label: 'Files',
        description: 'Storage roots, documents & generated artifacts',
        icon: IconFiles,
      },
      {
        id: 'camera',
        label: 'Camera',
        description: 'Live video viewfinder & frame capture',
        icon: IconCamera,
      },
      {
        id: 'vision',
        label: 'Vision',
        description: 'Visual perception & screen inspection',
        icon: IconVision,
      },
      {
        id: 'activity',
        label: 'Activity',
        description: 'Execution timeline & system audit logs',
        icon: IconActivity,
      },
    ],
  },
  {
    id: 'system',
    title: 'SYSTEM',
    items: [
      {
        id: 'system',
        label: 'System Monitor',
        description: 'CPU, memory, connectivity & health telemetry',
        icon: IconSystem,
      },
      {
        id: 'devices',
        label: 'Devices',
        description: 'Hardware topology, presence & phone pairing',
        icon: IconDevices,
      },
      {
        id: 'environments',
        label: 'Environments',
        description: '3D visual HUD themes & backgrounds',
        icon: IconEnvironments,
      },
      {
        id: 'settings',
        label: 'Settings',
        description: 'Preferences, AI models, keys & memory',
        icon: IconSettings,
      },
    ],
  },
]

const SIDEBAR_STORAGE_KEY = 'jarvis_sidebar_collapsed'

export function JarvisTaskbar({
  onOpenSettings,
  mobileOpen = false,
  onCloseMobile,
  isCollapsed: controlledCollapsed,
  onToggleCollapse,
}: Props) {
  const panels = usePanelLayoutStore((s) => s.panels)
  const togglePanel = usePanelLayoutStore((s) => s.togglePanel)
  const focusPanel = usePanelLayoutStore((s) => s.focusPanel)
  const resetLayout = usePanelLayoutStore((s) => s.resetLayout)
  const environmentId = usePanelLayoutStore((s) => s.environmentId)
  const actions = useEnvironmentActions()

  // Collapse state management (defaults to false / expanded on desktop)
  const [internalCollapsed, setInternalCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY)
      if (stored !== null) return stored === 'true'
      return window.innerWidth < 1200
    } catch {
      return false
    }
  })

  const isCollapsed = controlledCollapsed ?? internalCollapsed

  const handleToggleCollapse = useCallback(() => {
    const next = !isCollapsed
    setInternalCollapsed(next)
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next))
    } catch {
      // storage unavailable
    }
    onToggleCollapse?.(next)
  }, [isCollapsed, onToggleCollapse])

  // Environment dropdown popover state
  const [envOpen, setEnvOpen] = useState(false)
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null)
  const envDropdownId = useId()

  const currentDef = isEnvironmentId(environmentId)
    ? ENVIRONMENT_BY_ID.get(environmentId)
    : ENVIRONMENT_BY_ID.get(DEFAULT_ENVIRONMENT)

  const handleItemClick = (id: PanelId | 'settings') => {
    if (id === 'settings') {
      onOpenSettings()
    } else {
      const open = panels[id]?.open ?? false
      togglePanel(id)
      if (!open) focusPanel(id)
    }

    if (mobileOpen && onCloseMobile) {
      onCloseMobile()
    }
  }

  // Count active open panels
  const openPanelCount = Object.values(panels).filter((p) => p.open).length

  return (
    <aside
      className={`jarvis-taskbar ${isCollapsed ? 'is-collapsed' : 'is-expanded'} ${
        mobileOpen ? 'is-mobile-open' : ''
      }`}
      aria-label="Navigation sidebar"
      role="navigation"
    >
      {/* Sidebar Header / Brand */}
      <div className="taskbar-brand-area">
        <div className="taskbar-brand" title="JARVIS Personal AI Operating System">
          <span className="taskbar-brand-dot" aria-hidden="true" />
          {!isCollapsed && (
            <div className="taskbar-brand-info">
              <span className="taskbar-brand-title">JARVIS OS</span>
              <span className="taskbar-brand-subtitle">AI SYSTEM</span>
            </div>
          )}
        </div>

        {/* Desktop Collapse Toggle */}
        <button
          type="button"
          className="taskbar-collapse-btn"
          aria-label={isCollapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
          title={isCollapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
          onClick={handleToggleCollapse}
        >
          {isCollapsed ? <IconChevronRight size={16} /> : <IconChevronLeft size={16} />}
        </button>

        {/* Mobile Close Button */}
        {mobileOpen && (
          <button
            type="button"
            className="taskbar-mobile-close-btn"
            aria-label="Close navigation drawer"
            onClick={onCloseMobile}
          >
            <IconClose size={18} />
          </button>
        )}
      </div>

      {/* Main Navigation Scroll Area */}
      <div className="taskbar-nav-scroll">
        {NAV_SECTIONS.map((section) => (
          <div key={section.id} className="taskbar-nav-group" role="group" aria-label={section.title}>
            {!isCollapsed && <div className="taskbar-section-title">{section.title}</div>}
            {isCollapsed && <div className="taskbar-section-divider" aria-hidden="true" />}

            <div className="taskbar-nav-items">
              {section.items.map((item) => {
                const isPanel = item.id !== 'settings'
                const isOpen = isPanel ? panels[item.id as PanelId]?.open ?? false : false
                const IconComponent = item.icon

                return (
                  <div
                    key={item.id}
                    className="taskbar-item-wrapper"
                    onMouseEnter={() => isCollapsed && setActiveTooltip(item.id)}
                    onMouseLeave={() => isCollapsed && setActiveTooltip(null)}
                  >
                    <button
                      type="button"
                      data-nav-id={item.id}
                      className={`taskbar-nav-item ${isOpen ? 'is-active' : ''} ${
                        isCollapsed ? 'is-compact' : ''
                      }`}
                      aria-label={`${isOpen ? 'Close' : 'Open'} ${item.label}`}
                      aria-pressed={isOpen}
                      onClick={() => handleItemClick(item.id)}
                    >
                      <span className="taskbar-nav-icon" aria-hidden="true">
                        <IconComponent size={18} />
                      </span>

                      {!isCollapsed && (
                        <div className="taskbar-nav-details">
                          <span className="taskbar-nav-label">{item.label}</span>
                          <span className="taskbar-nav-desc">{item.description}</span>
                        </div>
                      )}

                      {!isCollapsed && isOpen && (
                        <span className="taskbar-active-pill" title="Panel currently active">
                          OPEN
                        </span>
                      )}

                      {/* Active indicator bar */}
                      {isOpen && <span className="taskbar-active-bar" aria-hidden="true" />}
                    </button>

                    {/* Collapsed Mode Hover Tooltip */}
                    {isCollapsed && activeTooltip === item.id && (
                      <div className="taskbar-tooltip" role="tooltip">
                        <div className="tooltip-header">
                          <span className="tooltip-section">{section.title}</span>
                          {isOpen && <span className="tooltip-badge">ACTIVE</span>}
                        </div>
                        <div className="tooltip-title">{item.label}</div>
                        <div className="tooltip-desc">{item.description}</div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Sidebar Footer Utilities */}
      <div className="taskbar-footer">
        {/* Environment Selector */}
        <div className="taskbar-env-wrapper">
          <button
            type="button"
            className={`taskbar-env-btn ${envOpen ? 'is-open' : ''} ${isCollapsed ? 'is-compact' : ''}`}
            aria-expanded={envOpen}
            aria-haspopup="listbox"
            aria-controls={envDropdownId}
            aria-label={`Visual Environment: ${currentDef?.label || 'Arc Reactor'}`}
            title={`Theme: ${currentDef?.label || 'Arc Reactor'}`}
            onClick={() => setEnvOpen((prev) => !prev)}
          >
            <span className="taskbar-env-glyph" aria-hidden="true">
              {currentDef?.glyph || '◉'}
            </span>
            {!isCollapsed && (
              <div className="taskbar-env-details">
                <span className="taskbar-env-label">{currentDef?.label || 'Arc Reactor'}</span>
                <span className="taskbar-env-sublabel">3D Environment</span>
              </div>
            )}
          </button>

          {envOpen && (
            <div id={envDropdownId} className="taskbar-env-popover" role="listbox" aria-label="Visual Environments">
              <div className="taskbar-env-popover-header">Visual Environments</div>
              {Array.from(ENVIRONMENT_BY_ID.values()).map((def) => (
                <button
                  key={def.id}
                  type="button"
                  className={`taskbar-env-item ${environmentId === def.id ? 'is-active' : ''}`}
                  role="option"
                  aria-selected={environmentId === def.id}
                  onClick={() => {
                    actions.selectEnvironment(def.id)
                    setEnvOpen(false)
                  }}
                >
                  <span className="taskbar-env-glyph" aria-hidden="true">
                    {def.glyph}
                  </span>
                  <div className="taskbar-env-item-text">
                    <span className="taskbar-env-item-name">{def.label}</span>
                    <span className="taskbar-env-item-desc">{def.description}</span>
                  </div>
                  {environmentId === def.id && <span className="taskbar-env-check">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Reset Layout Button */}
        <button
          type="button"
          className={`taskbar-action-btn ${isCollapsed ? 'is-compact' : ''}`}
          aria-label="Reset window layout to default positions"
          title="Reset Windows Layout"
          onClick={resetLayout}
        >
          <span className="taskbar-action-icon" aria-hidden="true">
            <IconResetLayout size={16} />
          </span>
          {!isCollapsed && <span className="taskbar-action-label">Reset Windows</span>}
        </button>

        {/* Active Panels Counter */}
        {!isCollapsed && (
          <div className="taskbar-status-bar">
            <span className="taskbar-status-text">
              {openPanelCount} {openPanelCount === 1 ? 'window' : 'windows'} open
            </span>
          </div>
        )}
      </div>
    </aside>
  )
}
