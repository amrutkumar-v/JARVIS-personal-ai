import { useEffect, useState } from 'react'
import { useJarvisStore } from '../../state/jarvis.store'
import type { GestureUiState } from '../../state/jarvis.store'
import { JARVIS_THEMES, THEME_META } from '../../themes'
import type {
  UserPreferences,
  MemoryItem,
  EmbeddingHealthSummary,
} from '../../memory/MemoryManager'
import type { ArchivedMemory, LifecycleReport } from '../../memory/lifecycle'
import { episodeIdOf } from '../../memory/episodes'
import type { Episode } from '../../memory/episodes'
import { checkAiHealth, ROUTED_PROVIDER_IDS, type AiHealthCheckResult, type RoutedProviderId } from '../../config/ai'

type MemoryAPI = {
  items: () => MemoryItem[]
  count: () => number
  remove: (id: string) => boolean
  requestClearAll: () => boolean
  savePreferences: (patch: Partial<UserPreferences>) => UserPreferences
  getEmbeddingHealth: () => EmbeddingHealthSummary
  lifecycleInfo: () => { lastRunAt?: string }
  archived: () => ArchivedMemory[]
  restore: (id: string) => boolean
  expunge: (cutoffIso?: string) => number
  consolidate: () => LifecycleReport
  activeEpisode: () => Episode | null
  episodes: () => Episode[]
  episodeMemories: (id: string) => MemoryItem[]
}

interface Props {
  open: boolean
  onClose: () => void
  providerLabel: string
  modelLabel?: string
  endpointLabel?: string
  memory?: MemoryAPI
  /** Phase 10 — live gesture mirror (read-only status; the controller is never
   * toggled here — gestures follow the camera with no separate switch). */
  gesture?: GestureUiState
}

function PreferenceRate() {
  const opts: UserPreferences['animationIntensity'][] = ['low', 'medium', 'high']
  const intensity = useJarvisStore.use.preferences().animationIntensity
  const set = useJarvisStore((s) => s.setPreferences)
  return (
    <div className="segmented" role="radiogroup" aria-label="Animation intensity">
      {opts.map((level) => (
        <button
          key={level}
          type="button"
          role="radio"
          aria-checked={intensity === level}
          className={intensity === level ? 'is-active' : ''}
          onClick={() => set({ animationIntensity: level })}
        >
          {level}
        </button>
      ))}
    </div>
  )
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" aria-hidden="true" />
    </button>
  )
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatEpisodeLabel(ep: Episode): string {
  return ep.title?.trim() ? ep.title.trim() : `Session ${ep.id.slice(0, 8)}`
}

function MemorySection({ memory }: { memory: MemoryAPI }) {
  // Mounted with a fresh key each time the panel opens, so the lists always
  // reflect the current MemoryManager snapshot.
  const [memories, setMemories] = useState<MemoryItem[]>(() => memory.items())
  const [archived, setArchived] = useState<ArchivedMemory[]>(() => memory.archived())
  const [health, setHealth] = useState<EmbeddingHealthSummary>(() => memory.getEmbeddingHealth())
  const [lifecycle, setLifecycle] = useState<{ lastRunAt?: string }>(() => memory.lifecycleInfo())
  const [episodes, setEpisodes] = useState<Episode[]>(() => memory.episodes())
  const [activeEpisode, setActiveEpisode] = useState<Episode | null>(() => memory.activeEpisode())
  const [expandedEpisode, setExpandedEpisode] = useState<string | null>(null)
  const [episodeItems, setEpisodeItems] = useState<MemoryItem[]>([])
  const autoMemorize = useJarvisStore.use.preferences().autoMemorize

  const refresh = (): void => {
    setMemories(memory.items())
    setArchived(memory.archived())
    setHealth(memory.getEmbeddingHealth())
    setEpisodes(memory.episodes())
    setActiveEpisode(memory.activeEpisode())
  }

  const toggleEpisode = (id: string): void => {
    if (expandedEpisode === id) {
      setExpandedEpisode(null)
      setEpisodeItems([])
      return
    }
    setExpandedEpisode(id)
    setEpisodeItems(memory.episodeMemories(id))
  }

  const remove = (id: string): void => {
    if (memory.remove(id)) refresh()
  }

  const restore = (id: string): void => {
    if (memory.restore(id)) refresh()
  }

  const purgeArchive = (): void => {
    memory.expunge()
    setArchived(memory.archived())
  }

  const consolidate = (): void => {
    const report = memory.consolidate()
    setLifecycle(memory.lifecycleInfo())
    setArchived(memory.archived())
    setMemories(memory.items())
    setHealth(memory.getEmbeddingHealth())
    setEpisodes(memory.episodes())
    setActiveEpisode(memory.activeEpisode())
    if (report.archivedCount > 0) {
      useJarvisStore.getState().pushNotice('info', `${report.archivedCount} memory item(s) consolidated`)
    }
  }

  return (
    <section className="settings-block">
      <div className="settings-block-head">
        <h3>MEMORY</h3>
        <span className="memory-count">{memories.length} item{memories.length === 1 ? '' : 's'}</span>
      </div>

      <div className="setting-row">
        <span>Auto-capture obvious facts</span>
        <Switch
          checked={autoMemorize}
          onChange={(v) => memory.savePreferences({ autoMemorize: v })}
          label="Auto-capture obvious facts"
        />
      </div>

      <div className="setting-row">
        <span>Consolidate memory</span>
        <button type="button" className="btn" onClick={consolidate}>
          Consolidate now
        </button>
      </div>

      {lifecycle.lastRunAt ? (
        <p className="memory-empty">Last consolidation: {formatWhen(lifecycle.lastRunAt)}</p>
      ) : null}

      {memories.length === 0 ? (
        <p className="memory-empty">
          Nothing stored yet. Tell me to remember something durable and it will appear here and stay across reloads.
        </p>
      ) : (
        <ul className="memory-list">
          {memories.map((m) => (
            <li key={m.id} className="memory-item">
              <span className="memory-badge" data-type={m.type}>
                {m.type}
              </span>
              <div className="memory-item-body">
                <p className="memory-item-text">{m.content}</p>
                <p className="memory-item-meta">
                  {formatWhen(m.createdAt)}
                  {m.source ? ` · via ${m.source}` : ''}
                  {m.importance !== undefined ? ` · importance ${m.importance.toFixed(2)}` : ''}
                </p>
              </div>
              <button
                type="button"
                className="icon-button memory-delete"
                onClick={() => remove(m.id)}
                aria-label={`Forget ${m.content}`}
              >
                ⌫
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="setting-row">
        <span>Clear all stored memories</span>
        <button type="button" className="btn is-danger-ghost" onClick={() => memory.requestClearAll()}>
          Clear all
        </button>
      </div>

      {activeEpisode ? (
        <p className="memory-empty">Current session: {formatEpisodeLabel(activeEpisode)} · writes are tagged to it.</p>
      ) : null}

      {episodes.length > 0 ? (
        <>
          <h4 className="settings-subhead">SESSIONS ({episodes.length})</h4>
          <ul className="memory-list">
            {episodes.map((ep) => (
              <li key={ep.id} className="memory-item">
                <button
                  type="button"
                  className="icon-button memory-delete"
                  onClick={() => toggleEpisode(ep.id)}
                  aria-label={expandedEpisode === ep.id ? `Collapse session ${ep.id}` : `Show memories from session ${ep.id}`}
                  title={expandedEpisode === ep.id ? 'Collapse session' : 'Show session memories'}
                >
                  {expandedEpisode === ep.id ? '▾' : '▸'}
                </button>
                <div className="memory-item-body">
                  <p className="memory-item-text">{formatEpisodeLabel(ep)}</p>
                  <p className="memory-item-meta">
                    Started {formatWhen(ep.startedAt)}
                    {ep.endedAt ? ` · ended ${formatWhen(ep.endedAt)}` : ' · active'}
                    {` · ${ep.itemCount} item${ep.itemCount === 1 ? '' : 's'}`}
                  </p>
                </div>
                {expandedEpisode === ep.id && episodeItems.length > 0 ? (
                  <ul className="memory-list memory-list-nested">
                    {episodeItems.map((m) => (
                      <li key={m.id} className="memory-item">
                        <span className="memory-badge" data-type={m.type}>
                          {m.type}
                        </span>
                        <div className="memory-item-body">
                          <p className="memory-item-text">{m.content}</p>
                          <p className="memory-item-meta">
                            {formatWhen(m.createdAt)}
                            {m.source ? ` · via ${m.source}` : ''}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {archived.length > 0 ? (
        <>
          <h4 className="settings-subhead">ARCHIVE ({archived.length})</h4>
          <ul className="memory-list">
            {archived.map((a) => (
              <li key={a.id} className="memory-item">
                <span className="memory-badge" data-type={a.type}>
                  {a.type}
                </span>
                <div className="memory-item-body">
                  <p className="memory-item-text">{a.content}</p>
                  <p className="memory-item-meta">
                    Archived {formatWhen(a.archivedAt)}
                    {episodeIdOf(a) ? ` · from session ${episodeIdOf(a)!.slice(0, 8)}` : ''}
                    {a.archivedReason ? ` · ${a.archivedReason}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  className="icon-button memory-delete"
                  onClick={() => restore(a.id)}
                  aria-label={`Restore ${a.content}`}
                  title="Restore"
                >
                  ↩
                </button>
              </li>
            ))}
          </ul>
          <div className="setting-row">
            <span>Permanently delete archived memories</span>
            <button type="button" className="btn is-danger-ghost" onClick={purgeArchive}>
              Purge archive
            </button>
          </div>
        </>
      ) : null}

      <div className="settings-block-head">
        <h4 className="settings-subhead">EMBEDDINGS</h4>
      </div>
      <ul className="cap-list">
        <li className="cap-row">
          <span className="cap-label">Provider</span>
          <span className="cap-value" data-tone={health.enabled ? 'on' : 'off'}>
            {health.providerLabel ?? '—'}
          </span>
        </li>
        <li className="cap-row">
          <span className="cap-label">Model</span>
          <span className="cap-value" data-tone={health.model ? 'on' : 'off'}>
            {health.model ?? '—'}
          </span>
        </li>
        <li className="cap-row">
          <span className="cap-label">Real embeddings</span>
          <span className="cap-value" data-tone={health.realEmbeddingsAvailable ? 'on' : 'off'}>
            {health.realEmbeddingsAvailable ? `available (${health.dimensions}d)` : 'off — lexical search only'}
          </span>
        </li>
        <li className="cap-row">
          <span className="cap-label">Vector store</span>
          <span className="cap-value" data-tone={health.enabled ? 'on' : 'off'}>
            {health.enabled ? 'on' : 'off'}
          </span>
        </li>
      </ul>
      {health.lastError ? (
        <p className="memory-empty">Embedding error: {health.lastError}</p>
      ) : null}
    </section>
  )
}

function SchedulingSection() {
  const schedule = useJarvisStore.use.schedule()
  return (
    <section className="settings-block">
      <div className="settings-block-head">
        <h3>REMINDERS</h3>
        <span className="memory-count">
          {schedule.length} scheduled
        </span>
      </div>
      {schedule.length === 0 ? (
        <p className="memory-empty">
          No reminders scheduled. Ask JARVIS to "remind me at 7 PM to water the plants". Reminders run while JARVIS
          is open; anything missed is re-run once, honestly marked, on the next open.
        </p>
      ) : (
        <ul className="memory-list">
          {schedule.map((r) => (
            <li key={r.id} className="memory-item">
              <span className="memory-badge">{r.kind.toUpperCase()}</span>
              <div className="memory-item-body">
                <p className="memory-item-text">{r.text}</p>
                <p className="memory-item-meta">
                  next: {new Date(r.nextRun).toLocaleString()}
                  {r.lastResult === 'missed' ? ' · last run was missed — will re-run once' : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="settings-note-inline">
        Reminders are stored locally (browser storage) and fire only while this app is open — the browser cannot
        guarantee timers when it is closed.
      </p>
    </section>
  )
}

function providerDisplayName(id: string): string {
  switch (id) {
    case 'gemini':
      return 'Google Gemini'
    case 'openai':
      return 'OpenAI'
    case 'anthropic':
      return 'Anthropic Claude'
    case 'openrouter':
      return 'OpenRouter'
    case 'local':
      return 'Local (Ollama / LM Studio)'
    case 'legacy':
      return 'Custom / legacy endpoint'
    case 'none':
      return 'None'
    default:
      return id
  }
}

function capabilityLabel(cap: string): string {
  if (cap === 'reasoning') return 'chat'
  return cap
}

/**
 * AI Providers — read-only router status + a provider pin for chat/vision.
 * Routing, keys and failover are strictly server-side; this panel never sees,
 * stores or displays a key. The pin is persisted in preferences only.
 */
function AiProvidersSection({
  open,
  pinned,
  onSelect,
}: {
  open: boolean
  pinned: 'auto' | RoutedProviderId
  onSelect: (pin: 'auto' | RoutedProviderId) => void
}) {
  const [health, setHealth] = useState<AiHealthCheckResult | null>(null)

  useEffect(() => {
    let cancelled = false
    checkAiHealth().then((h) => {
      if (!cancelled) setHealth(h)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  const tone = health
    ? health.status === 'CONNECTED'
      ? 'on'
      : health.status === 'MISCONFIGURED'
        ? 'off'
        : 'dev'
    : 'off'

  return (
    <section className="settings-block">
      <h3>AI PROVIDERS</h3>
      <div className="setting-row">
        <span>Preferred provider</span>
        <select
          className="settings-select"
          aria-label="Preferred AI provider"
          value={pinned}
          onChange={(e) => onSelect(e.target.value as 'auto' | RoutedProviderId)}
        >
          <option value="auto">Auto — server decides (with failover)</option>
          {ROUTED_PROVIDER_IDS.map((id) => (
            <option key={id} value={id}>
              {providerDisplayName(id)}
            </option>
          ))}
        </select>
      </div>
      {health ? (
        <>
          <div className="setting-row">
            <span>Router status</span>
            <span className="cap-value" data-tone={tone}>
              {tone === 'on'
                ? `CONNECTED — active: ${providerDisplayName(health.provider ?? '?')}`
                : `${health.status.replace(/_/g, ' ')}${health.model ? ` · ${health.model}` : ''}`}
            </span>
          </div>
          {health.message ? (
            <p className="settings-note-inline">{health.message}</p>
          ) : null}
          {(health.providers?.length ?? 0) > 0 ? (
            <ul className="cap-list">
              {health.providers?.map((p) => (
                <li key={p.id} className="cap-row">
                  <span className="cap-label">{providerDisplayName(p.id)}</span>
                  <span className="cap-value" data-tone={p.available ? 'on' : 'off'}>
                    {health.provider === p.id ? '● ' : ''}
                    {p.status}
                    {p.model ? ` · ${p.model}` : ''}
                    {p.capabilities?.length ? ` · ${p.capabilities.map(capabilityLabel).join(', ')}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="settings-note-inline">Checking provider health…</p>
      )}
      <p className="settings-note-inline">
        Provider routing, keys and failover are handled server-side. Pinning a provider sends it with each chat
        request; no API key ever reaches this frontend.
      </p>
    </section>
  )
}

export function SettingsPanel({ open, onClose, providerLabel, modelLabel, endpointLabel, memory, gesture }: Props) {
  const prefs = useJarvisStore.use.preferences()
  const caps = useJarvisStore.use.capabilities()
  const setPrefs = useJarvisStore((s) => s.setPreferences)
  const theme = useJarvisStore.use.theme()
  const setTheme = useJarvisStore((s) => s.setTheme)
  const demoMode = useJarvisStore.use.demoMode()
  const setDemoMode = useJarvisStore((s) => s.setDemoMode)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const savePrefs = (patch: Partial<UserPreferences>): void => {
    if (memory) memory.savePreferences(patch)
    else setPrefs(patch)
  }

  const capRows: Array<{ label: string; value: string; tone: 'on' | 'off' | 'dev' | 'planned' }> = [
    {
      label: 'AI engine',
      value: caps.aiConnected
        ? `${providerLabel} (connected)`
        : caps.aiStatus && caps.aiStatus !== 'DISCONNECTED'
        ? `${caps.aiStatus.toLowerCase().replace(/_/g, ' ')}`
        : caps.aiConfigured
        ? 'configured — unreachable'
        : 'none',
      tone: caps.aiConnected ? 'on' : caps.aiConfigured ? 'dev' : 'off',
    },
    { label: 'Model', value: modelLabel ?? '—', tone: modelLabel ? 'on' : 'off' },
    { label: 'Endpoint', value: endpointLabel ?? '—', tone: endpointLabel ? 'on' : 'off' },
    { label: 'Speech input', value: caps.speechRecognitionAvailable ? 'available' : 'unavailable', tone: caps.speechRecognitionAvailable ? 'on' : 'off' },
    { label: 'Speech output', value: caps.speechSynthesisAvailable ? 'available' : 'unavailable', tone: caps.speechSynthesisAvailable ? 'on' : 'off' },
    { label: 'Wake word', value: caps.wakeWordAvailable ? 'available' : 'unavailable', tone: caps.wakeWordAvailable ? 'on' : 'off' },
    { label: 'Voice interaction', value: caps.voiceInteractionAvailable ? 'available' : 'unavailable', tone: caps.voiceInteractionAvailable ? 'on' : 'off' },
    { label: 'Long-term memory', value: caps.memoryEnabled ? 'on' : 'off', tone: caps.memoryEnabled ? 'on' : 'off' },
    { label: 'Tool runtime', value: caps.toolsEnabled ? 'on' : 'off', tone: caps.toolsEnabled ? 'on' : 'off' },
    { label: 'Voice calling', value: 'planned', tone: 'planned' },
    {
      label: 'Persistent backend',
      value: caps.deviceBridgeAvailable ? 'connected' : 'unavailable',
      tone: caps.deviceBridgeAvailable ? 'on' : 'off',
    },
    {
      label: 'Phone bridge',
      value: caps.deviceBridgeAvailable ? 'available' : 'unavailable',
      tone: caps.deviceBridgeAvailable ? 'on' : 'off',
    },
    {
      label: 'Computer control',
      value: caps.nativeAgentAvailable ? 'active' : 'unavailable',
      tone: caps.nativeAgentAvailable ? 'on' : 'off',
    },
    {
      label: 'Native Windows agent',
      value: caps.nativeAgentAvailable ? 'Connected' : 'Unavailable',
      tone: caps.nativeAgentAvailable ? 'on' : 'off',
    },
    {
      label: 'File system',
      value: caps.nativeAgentAvailable ? 'Native (local agent)' : caps.fileSystemAvailable ? 'Browser' : 'Unavailable',
      tone: caps.nativeAgentAvailable ? 'on' : caps.fileSystemAvailable ? 'on' : 'off',
    },
    {
      label: 'Application control',
      value: caps.nativeApplicationAvailable ? 'Native agent' : 'Unavailable',
      tone: caps.nativeApplicationAvailable ? 'on' : 'off',
    },
    {
      label: 'Windows observation',
      value: caps.nativeObservationAvailable ? 'Native agent (read-only)' : 'Unavailable',
      tone: caps.nativeObservationAvailable ? 'on' : 'off',
    },
    {
      label: 'Desktop interaction',
      value: caps.nativeDesktopInteractionAvailable ? 'Native agent (bounded input)' : 'Unavailable',
      tone: caps.nativeDesktopInteractionAvailable ? 'on' : 'off',
    },
    { label: 'Webcam', value: caps.cameraAvailable ? 'available' : 'unavailable', tone: caps.cameraAvailable ? 'on' : 'off' },
    { label: 'Visual understanding', value: caps.visionAvailable ? 'available' : 'unavailable', tone: caps.visionAvailable ? 'on' : 'off' },
    { label: 'OCR (text reading)', value: caps.ocrAvailable ? 'available' : 'unavailable', tone: caps.ocrAvailable ? 'on' : 'off' },
    { label: 'UI element detection', value: caps.uiElementDetectionAvailable ? 'available' : 'unavailable', tone: caps.uiElementDetectionAvailable ? 'on' : 'off' },
    { label: 'Target localization', value: caps.targetLocalizationAvailable ? 'available' : 'unavailable', tone: caps.targetLocalizationAvailable ? 'on' : 'off' },
    { label: 'Web access', value: caps.webAccessAvailable ? 'available' : 'unavailable', tone: caps.webAccessAvailable ? 'on' : 'off' },
  ]

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="JARVIS settings" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>SYSTEM SETTINGS</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>

        <section className="settings-block">
          <h3>APPEARANCE</h3>
          <div className="setting-row setting-row-column">
            <span>Theme</span>
            <div className="theme-grid" role="radiogroup" aria-label="Theme">
              {JARVIS_THEMES.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={theme === t}
                  className={`theme-chip theme-${t}${theme === t ? ' is-active' : ''}`}
                  onClick={() => setTheme(t)}
                  title={THEME_META[t].description}
                >
                  <span className="theme-swatch" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="theme-name">{THEME_META[t].label}</span>
                </button>
              ))}
            </div>
            <p className="settings-note-inline">{THEME_META[theme].description}</p>
          </div>
          <div className="setting-row">
            <span>Demo mode</span>
            <Switch checked={demoMode} onChange={setDemoMode} label="Demo mode" />
          </div>
          <p className="settings-note-inline">
            Demo mode only enlarges the Arc Reactor and declutters the UI for presentations. It never fakes
            execution, verification or permissions.
          </p>
        </section>

        <section className="settings-block">
          <h3>VOICE</h3>
          <div className="setting-row">
            <span>Voice interaction</span>
            <Switch checked={prefs.voiceEnabled} onChange={(v) => savePrefs({ voiceEnabled: v })} label="Voice interaction" />
          </div>
          <div className="setting-row">
            <span>Wake word (say "Wake up, JARVIS")</span>
            <Switch checked={prefs.wakeWordEnabled} onChange={(v) => savePrefs({ wakeWordEnabled: v })} label="Wake word" />
          </div>
          <div className="setting-row">
            <span>Output volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={prefs.volume}
              onChange={(e) => savePrefs({ volume: Number(e.target.value) })}
              aria-label="Output volume"
              className="slider"
            />
            <span className="setting-value">{Math.round(prefs.volume * 100)}%</span>
          </div>
        </section>

        <section className="settings-block">
          <h3>HAND GESTURES</h3>
          <div className="setting-row">
            <span>Status</span>
            <span className="setting-value">
              {gesture?.error
                ? `Unavailable — ${gesture.error}`
                : gesture?.active
                  ? 'Active'
                  : 'Off (turn on the camera) — hand gestures follow the camera stream automatically, with no separate toggle.'}
            </span>
          </div>
          <div className="setting-row">
            <span>Phase</span>
            <span className="setting-value">{gesture?.phase ?? 'unknown'}</span>
          </div>
          <div className="setting-row">
            <span>Hands detected</span>
            <span className="setting-value">{gesture?.hands ?? 0}</span>
          </div>
          <div className="setting-row">
            <span>Tracking quality</span>
            <span className="setting-value">{gesture?.quality ?? 'none'}</span>
          </div>
          <p className="settings-note-inline">
            Hand gestures are ON BY DEFAULT: they run the bundled local
            hand-tracking model on the SAME camera stream the operator controls
            and stop the moment the camera is turned off. No data leaves the
            browser. Zoom In (expand), Zoom Out (contract), Crush (close topmost
            panel), Theme Change (horizontal swipe) are the only supported
            gestures. Mapping lives in src/gesture/mapping.ts.
          </p>
        </section>

        <section className="settings-block">
          <h3>RENDERING</h3>
          <div className="setting-row">
            <span>Animation intensity</span>
            <PreferenceRate />
          </div>
          <div className="setting-row">
            <span>Reduced motion</span>
            <Switch checked={prefs.reducedMotion} onChange={(v) => savePrefs({ reducedMotion: v })} label="Reduced motion" />
          </div>
        </section>

        <AiProvidersSection
          open={open}
          pinned={
            prefs.providerId && (ROUTED_PROVIDER_IDS as readonly string[]).includes(prefs.providerId)
              ? (prefs.providerId as RoutedProviderId)
              : 'auto'
          }
          onSelect={(pin) => savePrefs({ providerId: pin === 'auto' ? 'mock' : pin })}
        />

        {memory ? <MemorySection key={open ? 'open' : 'closed'} memory={memory} /> : null}

        <SchedulingSection />

        <section className="settings-block">
          <h3>CAPABILITIES</h3>
          <ul className="cap-list">
            {capRows.map((c) => (
              <li key={c.label} className="cap-row">
                <span className="cap-label">{c.label}</span>
                <span className="cap-value" data-tone={c.tone}>{c.value}</span>
              </li>
            ))}
          </ul>
        </section>

        <p className="settings-note">
          AI provider: {providerLabel}.
          {caps.aiConnected
            ? ` Connected to real AI endpoint (${caps.aiStatus || 'CONNECTED'}).`
            : caps.aiStatus && caps.aiStatus !== 'DISCONNECTED'
              ? ` AI status: ${caps.aiStatus.replace(/_/g, ' ')}${caps.aiStatusMessage ? ` (${caps.aiStatusMessage})` : ''}.`
              : caps.aiConfigured
                ? ' Configured — the endpoint is currently unreachable, so execution is honestly limited.'
                : ' Development mode: the clearly-labelled mock provider is active because no real AI configuration was found.'}
          {' '}No keys are stored in this frontend.
          {!caps.visionAvailable
            ? ' Visual semantic understanding is unavailable until a real VisionProvider is configured.'
            : ''}
        </p>
      </div>
    </div>
  )
}