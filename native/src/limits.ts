/**
 * Native Windows Agent — operation bounds (Phase 1.2).
 *
 * The Web FS_LIMITS already bound browser-side tools; this independent,
 * server-side set is the same defense-in-depth contract enforced by the agent,
 * so a malicious or buggy Web client can never bypass caps by talking to the
 * bridge directly.
 */
export const NATIVE_LIMITS = {
  /** Max entries a single list may return. */
  MAX_LIST_RESULTS: 200,
  /** Max matches a single search may return. */
  MAX_SEARCH_RESULTS: 100,
  /** Max directory nesting a recursive search traverses below the root. */
  MAX_SEARCH_DEPTH: 4,
  /** Max bytes a single read may load into memory. */
  MAX_READ_BYTES: 512 * 1024,
  /** Max characters a single write may persist. */
  MAX_WRITE_CHARS: 100_000,
  /** Max bytes a copy/move may transfer in one operation. */
  MAX_COPY_BYTES: 4 * 1024 * 1024,
  /** Max length of a search query. */
  MAX_SEARCH_QUERY_LENGTH: 120,
  /** Max wall time a search may spend walking the tree (ms). */
  MAX_SEARCH_TIME_MS: 4000,
  /** Max wall time a single request may take server-side (ms). */
  REQUEST_TIMEOUT_MS: 15_000,
  /** Max request body bytes accepted. */
  MAX_BODY_BYTES: 1 * 1024 * 1024,
} as const

/**
 * Native Windows Agent — application-control bounds (Phase 1.3).
 *
 * Every bound here exists so application discovery and launching can never
 * become a full-disk scan or an unmanaged process factory. Discovery walks
 * only two well-known Start Menu program folders, is capped by file count,
 * elapsed time and result count, and never recurses arbitrarily deep.
 */
export const APP_LIMITS = {
  /** Max applications returned by `app.list` (discovered + configured). */
  MAX_DISCOVERED_APPS: 60,
  /** Max shortcut/directory entries read during one discovery pass. */
  MAX_DISCOVERY_FILES: 150,
  /** How far below the Start Menu programs root discovery may recurse. */
  MAX_DISCOVERY_DIR_DEPTH: 1,
  /** Max wall time a full discovery pass may take (ms). */
  MAX_DISCOVERY_TIME_MS: 4000,
  /** Max bytes of one shortcut file read for target parsing. */
  MAX_LNK_BYTES: 16 * 1024,
  /** Max application id length (matches APP_ID_PATTERN). */
  MAX_APP_ID_LENGTH: 64,
  /** Max characters of a target path kept from a parsed shortcut. */
  MAX_LNK_TARGET_CHARS: 512,
  /** Max App Paths registry entries honoured in one discovery pass. */
  MAX_APP_PATH_ENTRIES: 180,
  /** Max packaged (Store/MSIX) apps honoured in one discovery pass. */
  MAX_PACKAGED_ENTRIES: 180,
  /** Wall time allowed for one fixed-args `reg query` (ms). */
  REG_QUERY_TIMEOUT_MS: 3000,
  /** Max characters of the validated folder argument to app.launch. */
  MAX_FOLDER_ARG_LENGTH: 512,
  /** Max wall time waiting for the process spawn event (ms). */
  LAUNCH_SPAWN_TIMEOUT_MS: 5000,
  /** Total wall time spent polling the spawned process (ms). */
  PROCESS_VERIFY_TOTAL_MS: 3000,
  /** Gap between process probes (ms). */
  PROCESS_VERIFY_POLL_DELAY_MS: 400,
  /** Per-probe timeout for the tasklist observation (ms). */
  PROCESS_VERIFY_PROBE_TIMEOUT_MS: 2000,
  /**
   * A positive process observation must still hold after this settle window
   * before it may be reported as a VERIFIED launch. A shell/Store activation
   * can flash a process that exits immediately (broken package state, one-shot
   * hand-off); without the settle check that flash was reported as "confirmed
   * running" for an app that was already gone.
   */
  PROCESS_VERIFY_SETTLE_MS: 1200,
} as const

/** Clamp into `1..cap`; anything absent/invalid resolves to cap (never unlimited). */
export function boundedLimit(requested: unknown, cap: number): number {
  const n = Number(requested)
  if (Number.isFinite(n) && n >= 1) return Math.min(Math.floor(n), cap)
  return cap
}

/** Clamp into `0..cap`; anything absent/invalid resolves to fallback. */
export function boundedDepth(requested: unknown, fallback: number, cap: number): number {
  const n = Number(requested)
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.floor(n), cap)
  return fallback
}