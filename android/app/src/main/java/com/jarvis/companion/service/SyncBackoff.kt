package com.jarvis.companion.service

/**
 * Pure, deterministic scheduling policy for the sync loop.
 *
 * Kept free of any Android dependency so it is unit-testable on the JVM and so
 * the loop's pacing is explicit: a fixed heartbeat cadence plus a reconnect
 * backoff that tops out at 60 s. The service only needs to decide "how long do
 * I sleep" — this object owns every number.
 */
object SyncBackoff {

    /** Steady-state heartbeat cadence while the network is healthy. */
    const val HEARTBEAT_MS = 10_000L

    private val BACKOFF_SLOTS_MS = longArrayOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 60_000L)

    /**
     * How long to sleep before retrying failure number [attempt] (0-based).
     * Grows 1s → 2s → … → 60s and then stays at 60s until a heartbeat succeeds.
     */
    fun retryDelayMs(attempt: Int): Long {
        if (attempt <= 0) return BACKOFF_SLOTS_MS[0]
        return BACKOFF_SLOTS_MS[attempt.coerceAtMost(BACKOFF_SLOTS_MS.lastIndex)]
    }
}