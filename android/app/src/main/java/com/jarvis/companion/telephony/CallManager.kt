package com.jarvis.companion.telephony

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.telecom.TelecomManager
import android.telephony.SmsManager
import android.telephony.TelephonyManager
import com.jarvis.companion.model.CallEvent
import com.jarvis.companion.model.CallState
import java.util.UUID

object CallManager {

    var currentActiveCall: CallEvent? = null
        private set

    /**
     * Dials a phone number using TelecomManager or ACTION_CALL intent.
     */
    fun dial(context: Context, phoneNumber: String): Boolean {
        return try {
            val cleanNumber = phoneNumber.replace(Regex("[^0-9+]"), "")
            val intent = Intent(Intent.ACTION_CALL).apply {
                data = Uri.parse("tel:$cleanNumber")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            context.startActivity(intent)

            val contactName = ContactsResolver.resolveContactName(context, cleanNumber)
            currentActiveCall = CallEvent(
                eventId = UUID.randomUUID().toString(),
                state = CallState.DIALING,
                phoneNumber = cleanNumber,
                contactName = contactName,
                callType = "OUTGOING"
            )
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    /**
     * Answers an incoming ringing call.
     */
    fun answerCall(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val telecom = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
            return try {
                telecom?.acceptRingingCall()
                if (currentActiveCall != null) {
                    currentActiveCall = currentActiveCall?.copy(state = CallState.ACTIVE)
                }
                true
            } catch (e: SecurityException) {
                e.printStackTrace()
                false
            }
        }
        return false
    }

    /**
     * Ends or rejects the currently ringing or active call.
     */
    fun endCall(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val telecom = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
            return try {
                val success = telecom?.endCall() ?: false
                currentActiveCall = currentActiveCall?.copy(state = CallState.DISCONNECTED)
                success
            } catch (e: SecurityException) {
                e.printStackTrace()
                false
            }
        }
        return false
    }

    /**
     * Sends an SMS text message.
     */
    fun sendSms(context: Context, phoneNumber: String, message: String): Boolean {
        return try {
            val smsManager: SmsManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                context.getSystemService(SmsManager::class.java)
            } else {
                @Suppress("DEPRECATION")
                SmsManager.getDefault()
            }
            smsManager.sendTextMessage(phoneNumber, null, message, null, null)
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    fun updateCallState(state: CallState, number: String?, contactName: String?, isSpam: Boolean = false) {
        val num = number ?: currentActiveCall?.phoneNumber ?: "Unknown"
        val name = contactName ?: currentActiveCall?.contactName

        if (state == CallState.IDLE || state == CallState.DISCONNECTED) {
            currentActiveCall = currentActiveCall?.copy(state = state)
        } else {
            currentActiveCall = CallEvent(
                eventId = UUID.randomUUID().toString(),
                state = state,
                phoneNumber = num,
                contactName = name,
                isSpam = isSpam
            )
        }
    }
}
