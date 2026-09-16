package com.jarvis.companion.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** Pure JVM tests for the WorkManager watchdog's declared schedule. */
class WatchdogPolicyTest {

    @Test
    fun `watchdog uses a unique work name`() {
        assertEquals("jarvis_sync_watchdog", WatchdogPolicy.UNIQUE_NAME)
        assertFalse(WatchdogPolicy.UNIQUE_NAME.isBlank())
    }

    @Test
    fun `watchdog runs every fifteen minutes`() {
        assertEquals(15L, WatchdogPolicy.INTERVAL_MIN)
    }
}