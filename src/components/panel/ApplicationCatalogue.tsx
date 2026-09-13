import { useCallback, useEffect, useState } from 'react'
import type { ApplicationProvider, AppSpec } from '../../applications'
import { CapabilityPanel } from './CapabilityPanel'
import type { CapabilityRow } from './capabilityData'

interface Props {
  provider: ApplicationProvider | undefined
}

/**
 * APPLICATION CATALOGUE — debug view inside the APPLICATIONS panel.
 *
 * Renders the REAL registry the engine holds (configured + discovered +
 * appPaths + packaged + system entries) with source, launch mechanism and
 * aliases, plus a RE-SCAN that re-runs native discovery via app.refresh. It
 * is purely presentational: it never launches or mutates anything, and it
 * reports `unavailable` honestly when the native agent is not connected.
 */
export function ApplicationCatalogue({ provider }: Props) {
  const [apps, setApps] = useState<AppSpec[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [stamp, setStamp] = useState<number | null>(null)

  useEffect(() => {
    if (!provider) return
    let cancelled = false
    void (async () => {
      try {
        const list = await provider.list()
        if (cancelled) return
        setApps(list)
        setError(null)
      } catch (cause) {
        if (cancelled) return
        setApps(null)
        setError(cause instanceof Error ? cause.message : 'Failed to list applications.')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [provider])

  const rescan = useCallback(async () => {
    if (!provider?.refresh || busy) return
    setBusy(true)
    try {
      const result = await provider.refresh()
      setStamp(result.refreshedAt)
    } catch {
      // Keep the previous list; re-list below reports any real failure.
    }
    try {
      const list = await provider.list()
      setApps(list)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to list applications.')
    }
    setBusy(false)
  }, [provider, busy])

  if (!provider) {
    return (
      <section className="panel application-catalogue">
        <h2 className="panel-title">APPLICATION CATALOGUE</h2>
        <p className="catalogue-note">The native application bridge is not attached — no applications can be enumerated.</p>
      </section>
    )
  }

  const caps = provider.capabilities()
  if (!caps.available) {
    return (
      <section className="panel application-catalogue">
        <h2 className="panel-title">APPLICATION CATALOGUE</h2>
        <p className="catalogue-error">{caps.reason ?? 'The native application bridge is not connected.'}</p>
      </section>
    )
  }

  const rows: CapabilityRow[] = (apps ?? []).map((a) => ({
    label: a.displayName,
    on: a.launchable && a.enabled,
    detail: [
      a.source,
      a.launchMechanism ?? 'exe',
      a.aliases && a.aliases.length > 0 ? `as ${a.aliases.join(', ')}` : undefined,
      a.enabled ? undefined : 'disabled',
    ]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' · '),
    description: `application_id: ${a.applicationId}`,
  }))

  return (
    <section className="panel application-catalogue">
      <div className="catalogue-head">
        <h2 className="panel-title">APPLICATION CATALOGUE</h2>
        {provider.refresh ? (
          <button
            type="button"
            className="catalogue-refresh"
            onClick={() => void rescan()}
            disabled={busy}
          >
            {busy ? 'RESCANNING…' : 'RE-SCAN'}
          </button>
        ) : null}
      </div>

      {error ? <p className="catalogue-error">{error}</p> : null}
      {!error && apps !== null && apps.length === 0 ? (
        <p className="catalogue-note">
          No approved or discovered applications yet — configure them in the native agent allow-list.
        </p>
      ) : null}
      {!error ? <CapabilityPanel title="REGISTERED APPLICATIONS" rows={rows} /> : null}
      {stamp ? (
        <p className="catalogue-stamp">Re-scanned at {new Date(stamp).toLocaleTimeString()}</p>
      ) : null}
    </section>
  )
}