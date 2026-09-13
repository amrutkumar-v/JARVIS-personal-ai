package com.jarvis.companion.telephony

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import com.jarvis.companion.model.CallEvent
import com.jarvis.companion.model.CallState
import com.jarvis.companion.service.JarvisBridgeService
import java.util.UUID

class CallReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return

        if (action == TelephonyManager.ACTION_PHONE_STATE_CHANGED) {
            val stateStr = intent.getStringExtra(TelephonyManager.EXTRA_STATE)
            val incomingNumber = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER) ?: ""

            val contactName = if (incomingNumber.isNotBlank()) {
                ContactsResolver.resolveContactName(context, incomingNumber)
            } else null

            val isSpam = isLikelySpam(incomingNumber)

            when (stateStr) {
                TelephonyManager.EXTRA_STATE_RINGING -> {
                    val event = CallEvent(
                        eventId = UUID.randomUUID().toString(),
                        state = CallState.RINGING,
                        phoneNumber = incomingNumber,
                        contactName = contactName,
                        isSpam = isSpam,
                        callType = "INCOMING"
                    )
                    CallManager.updateCallState(CallState.RINGING, incomingNumber, contactName, isSpam)
                    JarvisBridgeService.notifyCallEvent(context, event)
                }
                TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                    val event = CallEvent(
                        eventId = UUID.randomUUID().toString(),
                        state = CallState.ACTIVE,
                        phoneNumber = incomingNumber,
                        contactName = contactName,
                        callType = "ACTIVE"
                    )
                    CallManager.updateCallState(CallState.ACTIVE, incomingNumber, contactName)
                    JarvisBridgeService.notifyCallEvent(context, event)
                }
                TelephonyManager.EXTRA_STATE_IDLE -> {
                    val event = CallEvent(
                        eventId = UUID.randomUUID().toString(),
                        state = CallState.DISCONNECTED,
                        phoneNumber = incomingNumber,
                        contactName = contactName,
                        callType = "ENDED"
                    )
                    CallManager.updateCallState(CallState.DISCONNECTED, incomingNumber, contactName)
                    JarvisBridgeService.notifyCallEvent(context, event)
                }
            }
        } else if (action == Intent.ACTION_NEW_OUTGOING_CALL) {
            @Suppress("DEPRECATION")
            val outgoingNumber = intent.getStringExtra(Intent.EXTRA_PHONE_NUMBER) ?: ""
            val contactName = ContactsResolver.resolveContactName(context, outgoingNumber)
            val event = CallEvent(
                eventId = UUID.randomUUID().toString(),
                state = CallState.DIALING,
                phoneNumber = outgoingNumber,
                contactName = contactName,
                callType = "OUTGOING"
            )
            CallManager.updateCallState(CallState.DIALING, outgoingNumber, contactName)
            JarvisBridgeService.notifyCallEvent(context, event)
        }
    }

    private fun isLikelySpam(number: String): Boolean {
        if (number.isBlank()) return false
        // Spam heuristics: repetitive numbers, known telemarketer prefixes
        val digits = number.replace(Regex("[^0-9]"), "")
        if (digits.startsWith("800") || digits.startsWith("888") || digits.startsWith("877") || digits.startsWith("866")) {
            return true
        }
        if (digits.length >= 10 && digits.substring(3).toSet().size <= 2) {
            return true // repeated patterns like 555-0000
        }
        return false
    }
}
