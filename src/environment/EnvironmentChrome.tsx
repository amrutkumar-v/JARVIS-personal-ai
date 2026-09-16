import type { MetricTone } from './bridge'

/**
 * Shared HUD design language for all six environments.
 *
 * The language comes from two small primitives:
 *  - `EnvModuleTag`  — a compact "MOD-xx · NAME" tag that every environment
 *    carries (a static module marker, never telemetry).
 *  - `EnvironmentChrome` — the full chrome frame (corner brackets + module
 *    header + bottom status readouts) for the canvas environments that had no
 *    DOM overlay. Every readout value is the REAL snapshot value — execution
 *    label, visual state, device/star counts, voice state — nothing fabricated.
 *
 * The chrome is passive (pointer-events off) and hidden on small screens so it
 * never obstructs interaction or crowds the phone HUD.
 */

export type EnvReadoutTone = MetricTone | 'live'

export interface EnvReadout {
  k: string
  v: string
  tone?: EnvReadoutTone
}

export interface EnvChromeProps {
  moduleId: string
  label: string
  rows: EnvReadout[]
}

export function EnvModuleTag({ moduleId, label }: { moduleId: string; label: string }) {
  return (
    <span className="env-module-tag" aria-hidden="true">
      <span className="env-module-tag-id">{moduleId}</span>
      <span className="env-module-tag-label">{label}</span>
    </span>
  )
}

export function EnvReadouts({ rows }: { rows: EnvReadout[] }) {
  // Deliberately not `role="status"`: the snapshot ticks every second, so a
  // live region would announce readouts on every tick. The real telemetry is
  // already carried by the StatusChip and the Control environment.
  return (
    <div className="env-chrome-readouts">
      {rows.map((r) => (
        <span key={r.k} className={`env-chrome-readout${r.tone ? ` tone-${r.tone}` : ''}`}>
          <span className="env-chrome-k">{r.k}</span>
          <span className="env-chrome-v">{r.v}</span>
        </span>
      ))}
    </div>
  )
}

export function EnvironmentChrome({ moduleId, label, rows }: EnvChromeProps) {
  return (
    <div className="env-chrome" aria-hidden="true">
      <span className="env-chrome-bracket br-tl" aria-hidden="true" />
      <span className="env-chrome-bracket br-tr" aria-hidden="true" />
      <span className="env-chrome-bracket br-bl" aria-hidden="true" />
      <span className="env-chrome-bracket br-br" aria-hidden="true" />
      <EnvModuleTag moduleId={moduleId} label={label} />
      <EnvReadouts rows={rows} />
    </div>
  )
}