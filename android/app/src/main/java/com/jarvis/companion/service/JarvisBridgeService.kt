package com.jarvis.companion.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.jarvis.companion.model.*
import com.jarvis.companion.telephony.CallManager
import com.jarvis.companion.telephony.ContactsResolver
import kotlinx.coroutines.*
import okhttp3.*
import java.util.concurrent.TimeUnit

class JarvisBridgeService : Service() {

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()
    private val gson = Gson()

    private var serverUrl = "http://localhost:3000"
    private var isConnected = false

    companion object {
        private const val CHANNEL_ID = "jarvis_bridge_channel"
        private const val NOTIFICATION_ID = 1001

        private var instance: JarvisBridgeService? = null

        fun notifyCallEvent(context: Context, event: CallEvent) {
            instance?.sendEvent("CALL_STATE", event)
        }

        fun notifyPhoneNotification(context: Context, notification: PhoneNotification) {
            instance?.sendEvent("NOTIFICATION", notification)
        }

        fun updateServerUrl(url: String) {
            instance?.apply {
                serverUrl = url
                reconnect()
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildForegroundNotification("Connecting to JARVIS..."))

        serviceScope.launch {
            connectToJarvis()
            startHeartbeatLoop()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val targetUrl = intent?.getStringExtra("SERVER_URL")
        if (!targetUrl.isNullOrBlank()) {
            serverUrl = targetUrl
            reconnect()
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        instance = null
        serviceScope.cancel()
        webSocket?.close(1000, "Service destroyed")
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "JARVIS Companion Bridge",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps active link with JARVIS PC Core"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun buildForegroundNotification(statusText: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("JARVIS Companion Active")
            .setContentText(statusText)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
    }

    private fun connectToJarvis() {
        try {
            val wsUrl = serverUrl.replace("http://", "ws://").replace("https://", "wss://") + "/api/device/ws"
            val request = Request.Builder().url(wsUrl).build()

            webSocket = client.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(ws: WebSocket, response: Response) {
                    isConnected = true
                    updateNotification("Connected to JARVIS PC")
                    sendDeviceRegistration()
                }

                override fun onMessage(ws: WebSocket, text: String) {
                    handleIncomingMessage(text)
                }

                override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                    isConnected = false
                    updateNotification("Disconnecting from JARVIS...")
                }

                override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                    isConnected = false
                    updateNotification("Reconnecting to JARVIS...")
                    serviceScope.launch {
                        delay(5000)
                        connectToJarvis()
                    }
                }
            })
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun reconnect() {
        webSocket?.cancel()
        serviceScope.launch {
            delay(1000)
            connectToJarvis()
        }
    }

    private fun updateNotification(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager?.notify(NOTIFICATION_ID, buildForegroundNotification(text))
    }

    private fun handleIncomingMessage(jsonText: String) {
        try {
            val command = gson.fromJson(jsonText, CommandMessage::class.java)
            when (command.action) {
                "DIAL" -> {
                    val number = command.targetNumber ?: ""
                    val ok = CallManager.dial(applicationContext, number)
                    sendResponse(command.commandId, ok, if (ok) "Dialing $number" else "Failed to dial")
                }
                "ANSWER" -> {
                    val ok = CallManager.answerCall(applicationContext)
                    sendResponse(command.commandId, ok, if (ok) "Call answered" else "Failed to answer call")
                }
                "REJECT", "END_CALL" -> {
                    val ok = CallManager.endCall(applicationContext)
                    sendResponse(command.commandId, ok, if (ok) "Call ended" else "Failed to end call")
                }
                "SEND_SMS" -> {
                    val number = command.targetNumber ?: ""
                    val msg = command.messageText ?: ""
                    val ok = CallManager.sendSms(applicationContext, number, msg)
                    sendResponse(command.commandId, ok, if (ok) "SMS sent" else "Failed to send SMS")
                }
                "QUERY_CONTACTS" -> {
                    val query = command.targetNumber ?: ""
                    val contacts = ContactsResolver.searchContacts(applicationContext, query)
                    sendResponse(command.commandId, true, "Found ${contacts.size} contacts", contacts)
                }
                else -> {
                    sendResponse(command.commandId, false, "Unknown action: ${command.action}")
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun sendEvent(eventType: String, data: Any) {
        val msg = JsonObject().apply {
            addProperty("type", eventType)
            add("payload", gson.toJsonTree(data))
        }
        val sent = webSocket?.send(msg.toString()) ?: false
        if (!sent) {
            // Post via HTTP fallback
            serviceScope.launch {
                postHttpEvent(msg.toString())
            }
        }
    }

    private suspend fun postHttpEvent(jsonBody: String) {
        withContext(Dispatchers.IO) {
            try {
                val httpUrl = "$serverUrl/api/device/events"
                val body = RequestBody.create(MediaType.parse("application/json"), jsonBody)
                val req = Request.Builder().url(httpUrl).post(body).build()
                client.newCall(req).execute().close()
            } catch (e: Exception) {
                // Ignore transient network errors
            }
        }
    }

    private fun sendResponse(commandId: String, success: Boolean, message: String, data: Any? = null) {
        val resp = CommandResponse(commandId, success, message, data)
        sendEvent("COMMAND_RESPONSE", resp)
    }

    private fun sendDeviceRegistration() {
        val status = getDeviceStatus()
        sendEvent("DEVICE_STATUS", status)
    }

    private fun getDeviceStatus(): DeviceStatus {
        val batteryFilter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        val batteryIntent = registerReceiver(null, batteryFilter)
        val level = batteryIntent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = batteryIntent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val percent = if (level >= 0 && scale > 0) (level * 100) / scale else 100
        val plugged = batteryIntent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val isCharging = plugged != 0

        return DeviceStatus(
            deviceId = "android-" + Build.SERIAL.hashCode().toString(),
            deviceName = "${Build.MANUFACTURER} ${Build.MODEL}",
            androidVersion = Build.VERSION.RELEASE,
            batteryPercent = percent,
            isCharging = isCharging,
            bridgeConnected = isConnected,
            activeCall = CallManager.currentActiveCall
        )
    }

    private suspend fun startHeartbeatLoop() {
        while (isActive) {
            delay(30000)
            if (isConnected) {
                sendDeviceRegistration()
            }
        }
    }
}
