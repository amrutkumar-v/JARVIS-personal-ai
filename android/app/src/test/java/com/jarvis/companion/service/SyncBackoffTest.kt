package com.jarvis.companion.service

import org.junit.Assert.assertEquals
import org.junit.Test

/** Pure JVM tests for the sync loop's pacing policy. */
class SyncBackoffTest {

    @Test
    fun `first retry sleeps a second`() {
        assertEquals(1_000L, SyncBackoff.retryDelayMs(0))
    }

    @Test
    fun `negative attempt behaves like the first`() {
        assertEquals(1_000L, SyncBackoff.retryDelayMs(-1))
    }

    @Test
    fun `backoff grows then caps at sixty seconds`() {
        assertEquals(2_000L, SyncBackoff.retryDelayMs(1))
        assertEquals(4_000L, SyncBackoff.retryDelayMs(2))
        assertEquals(8_000L, SyncBackoff.retryDelayMs(3))
        assertEquals(16_000L, SyncBackoff.retryDelayMs(4))
        assertEquals(30_000L, SyncBackoff.retryDelayMs(5))
        assertEquals(60_000L, SyncBackoff.retryDelayMs(6))
        assertEquals(60_000L, SyncBackoff.retryDelayMs(10))
    }

    @Test
    fun `heartbeat cadence is ten seconds`() {
        assertEquals(10_000L, SyncBackoff.HEARTBEAT_MS)
    }
}