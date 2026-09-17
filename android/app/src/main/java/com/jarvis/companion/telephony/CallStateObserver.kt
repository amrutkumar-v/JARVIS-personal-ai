package com.jarvis.companion.telephony

import android.content.Context
import android.os.Build
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager

/**
 * Real OS call-state observation.
 *
 * Registers Android's own call-state callback (`TelephonyCallback` on API 31+,
 * `PhoneStateListener` below) and reports every genuine transition:
 * `RINGING` → an incoming call is ringing, `CONNECTED` (OFFHOOK) → a call is
 * active, `ENDED` (IDLE) → no call is up. Requires `READ_PHONE_STATE`; without
 * it registration is refused by the OS and `start()` returns false — JARVIS
 * then reports that observation is unavailable rather than inventing states.
 *
 * SCOPE / LIMITATION (deliberate, documented): Android does not expose the
 * incoming caller's number to a non-default-dialer app without the sensitive
 * `READ_CALL_LOG` permission. This observer therefore reports the STATE only.
 * For outgoing calls the number is known from the command that placed it, and
 * the service supplies that context.
 */
class CallStateObserver(
    private val context: Context,
    /** Supplies the direction of the current call ("outgoing" / "incoming" / null). */
    private val directionProvider: () -> String?,
    /** Called with every REAL state change (deduplicated). */
    private val onState: (state: String, direction: String?) -> Unit,
) {
    private var telephonyCallback: TelephonyCallback? = null

    @Suppress("DEPRECATION")
    private var phoneStateListener: PhoneStateListener? = null

    private var lastState: String? = null
    private var started = false

    /** True while real call-state observation is active. */
    val observing: Boolean get() = started

    /** Register the OS callback. Returns false when the permission is missing. */
    fun start(): Boolean {
        if (started) return true
        if (!TelephonyCapability.canObserveCallState(context)) return false
        val manager = context.getSystemService(TelephonyManager::class.java) ?: return false
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val callback = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                    override fun onCallStateChanged(state: Int) = emit(state)
                }
                manager.registerTelephonyCallback(context.mainExecutor, callback)
                telephonyCallback = callback
            } else {
                @Suppress("DEPRECATION")
                val listener = object : PhoneStateListener() {
                    @Deprecated("Deprecated in Java")
                    override fun onCallStateChanged(state: Int, phoneNumber: String?) = emit(state)
                }
                @Suppress("DEPRECATION")
                manager.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
                phoneStateListener = listener
            }
            started = true
            true
        } catch (e: SecurityException) {
            false
        } catch (t: Throwable) {
            false
        }
    }

    /** Unregister the OS callback (never throws). */
    fun stop() {
        if (!started) return
        val manager = context.getSystemService(TelephonyManager::class.java)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                telephonyCallback?.let { manager?.unregisterTelephonyCallback(it) }
            } else {
                @Suppress("DEPRECATION")
                phoneStateListener?.let { manager?.listen(it, PhoneStateListener.LISTEN_NONE) }
            }
        } catch (t: Throwable) {
            // Nothing to report: the OS may already have torn the callback down.
        }
        telephonyCallback = null
        phoneStateListener = null
        started = false
    }

    private fun emit(state: Int) {
        val mapped = when (state) {
            TelephonyManager.CALL_STATE_RINGING -> "RINGING"
            TelephonyManager.CALL_STATE_OFFHOOK -> "CONNECTED"
            TelephonyManager.CALL_STATE_IDLE -> "ENDED"
            else -> return
        }
        if (mapped == lastState) return
        lastState = mapped
        onState(mapped, directionProvider())
    }
}
