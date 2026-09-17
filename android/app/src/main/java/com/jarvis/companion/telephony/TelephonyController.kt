package com.jarvis.companion.telephony

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.TelecomManager

/**
 * Real Android telephony actions — the ONLY place a call is ever placed/ended.
 *
 * Every method uses the platform's own telephony APIs and reports the honest
 * outcome:
 *  - `TelecomManager.placeCall` (or the `ACTION_CALL` intent as a fallback)
 *    needs `CALL_PHONE`;
 *  - `TelecomManager.acceptRingingCall` / `endCall` / `rejectCall` need
 *    `ANSWER_PHONE_CALLS` and the API level each one requires. Where the OS
 *    forbids them (older API, non-default dialer restrictions, background
 *    execution limits) the call throws and we return NOT_SUPPORTED /
 *    PERMISSION_REQUIRED — never a fabricated success.
 *
 * A `SecurityException` is mapped to PERMISSION_REQUIRED, any other failure to
 * FAILED, so the backend/HUD always shows a truthful call state.
 */
class TelephonyController(private val context: Context) {

    /** Honest outcome of one telephony action. */
    data class CallActionResult(val ok: Boolean, val state: String, val detail: String)

    /** Place a real outgoing call. */
    fun placeCall(rawNumber: String): CallActionResult {
        if (!TelephonyCapability.hasTelephonyHardware(context)) {
            return CallActionResult(false, "NOT_SUPPORTED", "This device has no telephony hardware.")
        }
        val number = TelephonyCapability.normalizeNumber(rawNumber)
            ?: return CallActionResult(false, "FAILED", "The number is not dialable.")
        if (!TelephonyCapability.canPlaceCall(context)) {
            return CallActionResult(false, "PERMISSION_REQUIRED", "CALL_PHONE is not granted.")
        }
        val uri = Uri.fromParts("tel", number, null)
        return try {
            val telecom = context.getSystemService(TelecomManager::class.java)
            if (telecom != null) {
                telecom.placeCall(uri, Bundle())
            } else {
                context.startActivity(Intent(Intent.ACTION_CALL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            CallActionResult(true, "CALLING", "Android accepted the call request for $number.")
        } catch (e: SecurityException) {
            CallActionResult(false, "PERMISSION_REQUIRED", "Android refused the call: ${e.message ?: "CALL_PHONE is not granted"}")
        } catch (t: Throwable) {
            CallActionResult(false, "FAILED", "Android refused the call: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    /** Answer the currently ringing call, where the OS permits it. */
    fun acceptCall(): CallActionResult {
        if (!TelephonyCapability.hasTelephonyHardware(context)) {
            return CallActionResult(false, "NOT_SUPPORTED", "This device has no telephony hardware.")
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return CallActionResult(false, "NOT_SUPPORTED", "Answering calls requires Android 8.0 or newer.")
        }
        if (!TelephonyCapability.canAcceptCall(context)) {
            return CallActionResult(false, "PERMISSION_REQUIRED", "ANSWER_PHONE_CALLS is not granted.")
        }
        return try {
            val telecom = context.getSystemService(TelecomManager::class.java)
                ?: return CallActionResult(false, "NOT_SUPPORTED", "Telecom service is unavailable on this device.")
            @Suppress("DEPRECATION")
            telecom.acceptRingingCall()
            CallActionResult(true, "CONNECTED", "Android accepted the answer request.")
        } catch (e: SecurityException) {
            // Android 10+ restricts accepting for non-default-dialer apps; that
            // is a real limitation and is reported as such, never worked around.
            CallActionResult(false, "PERMISSION_REQUIRED", "Android refused to answer the call: ${e.message ?: "ANSWER_PHONE_CALLS is not granted"}")
        } catch (t: Throwable) {
            CallActionResult(false, "FAILED", "Android refused to answer the call: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    /**
     * End the active call (API 28+ with ANSWER_PHONE_CALLS).
     *
     * `TelecomManager.endCall()` is marked deprecated in API 34 in favour of the
     * self-managed-call control APIs, which only apply to apps that own the call
     * themselves; for ending a carrier call it remains the platform surface.
     */
    @Suppress("DEPRECATION")
    fun endCall(): CallActionResult {
        if (!TelephonyCapability.hasTelephonyHardware(context)) {
            return CallActionResult(false, "NOT_SUPPORTED", "This device has no telephony hardware.")
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            return CallActionResult(false, "NOT_SUPPORTED", "Ending a call requires Android 9 or newer.")
        }
        if (!TelephonyCapability.canEndCall(context)) {
            return CallActionResult(false, "PERMISSION_REQUIRED", "ANSWER_PHONE_CALLS is not granted.")
        }
        return try {
            val telecom = context.getSystemService(TelecomManager::class.java)
                ?: return CallActionResult(false, "NOT_SUPPORTED", "Telecom service is unavailable on this device.")
            telecom.endCall()
            CallActionResult(true, "ENDED", "Android accepted the hang-up request.")
        } catch (e: SecurityException) {
            CallActionResult(false, "PERMISSION_REQUIRED", "Android refused to end the call: ${e.message ?: "ANSWER_PHONE_CALLS is not granted"}")
        } catch (t: Throwable) {
            CallActionResult(false, "FAILED", "Android refused to end the call: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    /**
     * Reject the ringing call.
     *
     * PLATFORM LIMITATION (verified against the API 34 SDK): `TelecomManager`
     * exposes NO public `rejectCall()` to a non-default-dialer app — the only
     * public call-control surface is `acceptRingingCall()` / `endCall()` /
     * `silenceRinger()`. Ending the ringing call IS the platform's reject path,
     * so that is exactly what happens here, and the result is reported as
     * REJECTED. No SMS decline / voicemail behaviour is claimed, because the
     * app cannot verify it.
     */
    @Suppress("DEPRECATION")
    fun rejectCall(): CallActionResult {
        if (!TelephonyCapability.hasTelephonyHardware(context)) {
            return CallActionResult(false, "NOT_SUPPORTED", "This device has no telephony hardware.")
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            return CallActionResult(false, "NOT_SUPPORTED", "Rejecting a call requires Android 9 or newer.")
        }
        if (!TelephonyCapability.canEndCall(context)) {
            return CallActionResult(false, "PERMISSION_REQUIRED", "ANSWER_PHONE_CALLS is not granted.")
        }
        return try {
            val telecom = context.getSystemService(TelecomManager::class.java)
                ?: return CallActionResult(false, "NOT_SUPPORTED", "Telecom service is unavailable on this device.")
            telecom.endCall()
            CallActionResult(true, "REJECTED", "Android accepted the reject request (ended the ringing call).")
        } catch (e: SecurityException) {
            CallActionResult(false, "PERMISSION_REQUIRED", "Android refused to reject the call: ${e.message ?: "ANSWER_PHONE_CALLS is not granted"}")
        } catch (t: Throwable) {
            CallActionResult(false, "FAILED", "Android refused to reject the call: ${t.message ?: t.javaClass.simpleName}")
        }
    }
}
