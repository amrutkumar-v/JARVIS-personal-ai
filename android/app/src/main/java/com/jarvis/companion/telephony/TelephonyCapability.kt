package com.jarvis.companion.telephony

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

/**
 * Real telephony capability/permission detection (no simulation).
 *
 * The companion reports to JARVIS Core ONLY what is true right now:
 *  - `call` is added to the capability list only when the device genuinely has
 *    telephony hardware (a Wi-Fi tablet never claims calling);
 *  - the permission list contains only permissions that are actually GRANTED.
 *
 * JARVIS Core turns those two facts into honest refusals:
 * capability present + `CALL_PHONE` granted  → the call is queued;
 * capability present + permission missing    → PERMISSION_REQUIRED;
 * capability absent                          → NOT_SUPPORTED.
 */
object TelephonyCapability {

    /** Labels reported to the backend (they mirror the Android permission names). */
    const val CALL_PHONE = "CALL_PHONE"
    const val ANSWER_PHONE_CALLS = "ANSWER_PHONE_CALLS"
    const val CALL_STATE = "READ_PHONE_STATE"
    const val CONTACTS = "READ_CONTACTS"

    val REPORTED_PERMISSIONS = listOf(CALL_PHONE, ANSWER_PHONE_CALLS, CALL_STATE, CONTACTS)

    /** True when the device has real telephony hardware (not a Wi-Fi-only tablet). */
    fun hasTelephonyHardware(context: Context): Boolean =
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)

    /** The capability labels this device really offers (telephony only with hardware). */
    fun callCapabilities(context: Context): List<String> =
        if (hasTelephonyHardware(context)) listOf("call") else emptyList()

    fun isGranted(context: Context, permission: String): Boolean {
        val androidPermission = when (permission) {
            CALL_PHONE -> Manifest.permission.CALL_PHONE
            ANSWER_PHONE_CALLS -> Manifest.permission.ANSWER_PHONE_CALLS
            CALL_STATE -> Manifest.permission.READ_PHONE_STATE
            CONTACTS -> Manifest.permission.READ_CONTACTS
            else -> return false
        }
        return ContextCompat.checkSelfPermission(context, androidPermission) == PackageManager.PERMISSION_GRANTED
    }

    /** Only the permissions the user has actually granted. */
    fun grantedPermissions(context: Context): List<String> = REPORTED_PERMISSIONS.filter { isGranted(context, it) }

    fun canPlaceCall(context: Context): Boolean = isGranted(context, CALL_PHONE)

    /** Accepting a ringing call needs ANSWER_PHONE_CALLS (API 26+). */
    fun canAcceptCall(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && isGranted(context, ANSWER_PHONE_CALLS)

    /** Ending an active call needs ANSWER_PHONE_CALLS and API 28+. */
    fun canEndCall(context: Context): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && isGranted(context, ANSWER_PHONE_CALLS)

    /**
     * Rejecting a ringing call uses the same public surface as ending one
     * (`TelecomManager.endCall()`, API 28+, ANSWER_PHONE_CALLS) — Android
     * exposes no separate reject API to a non-default-dialer app.
     */
    fun canRejectCall(context: Context): Boolean = canEndCall(context)

    fun canObserveCallState(context: Context): Boolean = isGranted(context, CALL_STATE)

    fun canReadContacts(context: Context): Boolean = isGranted(context, CONTACTS)

    /**
     * Normalize a dialled number: an optional leading `+` followed by digits
     * only, bounded to 3..20 digits. Returns null when the value is not
     * dialable — the caller reports FAILED instead of handing garbage to the OS.
     */
    fun normalizeNumber(raw: String): String? {
        val trimmed = raw.trim().take(40)
        if (trimmed.isEmpty() || trimmed.any { it.isLetter() }) return null
        val plus = trimmed.startsWith("+")
        val digits = trimmed.filter { it.isDigit() }
        if (digits.length < 3 || digits.length > 20) return null
        return if (plus) "+$digits" else digits
    }
}
