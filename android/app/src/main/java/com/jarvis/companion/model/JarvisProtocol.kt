package com.jarvis.companion.model

enum class CallState {
    IDLE,
    RINGING,
    DIALING,
    ACTIVE,
    DISCONNECTED
}

data class CallEvent(
    val eventId: String,
    val state: CallState,
    val phoneNumber: String,
    val contactName: String?,
    val timestamp: Long = System.currentTimeMillis(),
    val durationSeconds: Int = 0,
    val isSpam: Boolean = false,
    val callType: String = "INCOMING" // INCOMING, OUTGOING, MISSED
)

data class ContactItem(
    val id: String,
    val displayName: String,
    val phoneNumber: String,
    val isStarred: Boolean = false
)

data class PhoneNotification(
    val id: String,
    val packageName: String,
    val appName: String,
    val title: String,
    val content: String,
    val timestamp: Long = System.currentTimeMillis()
)

data class DeviceStatus(
    val deviceId: String,
    val deviceName: String,
    val androidVersion: String,
    val batteryPercent: Int,
    val isCharging: Boolean,
    val bridgeConnected: Boolean,
    val activeCall: CallEvent? = null
)

data class CommandMessage(
    val commandId: String,
    val action: String, // "DIAL", "ANSWER", "REJECT", "END_CALL", "QUERY_CONTACTS", "SEND_SMS"
    val targetNumber: String? = null,
    val messageText: String? = null,
    val rejectReason: String? = null
)

data class CommandResponse(
    val commandId: String,
    val success: Boolean,
    val message: String,
    val data: Any? = null
)
