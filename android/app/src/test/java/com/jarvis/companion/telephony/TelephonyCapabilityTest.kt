package com.jarvis.companion.telephony

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pure unit tests for the number normalization applied BEFORE any value reaches
 * `TelecomManager`. The app must never hand a non-dialable string to the OS, and
 * must never invent a number it was not given.
 */
class TelephonyCapabilityTest {

    @Test
    fun keepsPlainDigits() {
        assertEquals("5550199", TelephonyCapability.normalizeNumber("5550199"))
    }

    @Test
    fun keepsInternationalPrefixAndStripsFormatting() {
        assertEquals("+919876543210", TelephonyCapability.normalizeNumber("+91 98765-43210"))
        assertEquals("+15550199", TelephonyCapability.normalizeNumber("+1 (555) 019-9"))
    }

    @Test
    fun stripsFormattingWithoutPrefix() {
        assertEquals("5550199", TelephonyCapability.normalizeNumber("(555) 019-9"))
    }

    @Test
    fun rejectsValuesWithLetters() {
        // A contact NAME must be resolved through ContactsResolver, never dialled.
        assertNull(TelephonyCapability.normalizeNumber("Dad"))
        assertNull(TelephonyCapability.normalizeNumber("1-800-FLOWERS"))
    }

    @Test
    fun rejectsTooShortOrTooLong() {
        assertNull(TelephonyCapability.normalizeNumber(""))
        assertNull(TelephonyCapability.normalizeNumber("12"))
        assertNull(TelephonyCapability.normalizeNumber("1".repeat(21)))
    }

    @Test
    fun rejectsBlankInput() {
        assertNull(TelephonyCapability.normalizeNumber("   "))
    }

    @Test
    fun reportsOnlyTheFourImplementedPermissionLabels() {
        assertEquals(
            listOf("CALL_PHONE", "ANSWER_PHONE_CALLS", "READ_PHONE_STATE", "READ_CONTACTS"),
            TelephonyCapability.REPORTED_PERMISSIONS,
        )
    }
}
