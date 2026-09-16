package com.jarvis.companion.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.jarvis.companion.R
import com.jarvis.companion.device.DeviceInfo
import com.jarvis.companion.model.CompanionIdentity
import com.jarvis.companion.model.PollCommand
import com.jarvis.companion.net.JarvisPhoneClient
import com.jarvis.companion.trust.PairingStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.IOException
import kotlin.coroutines.coroutineContext

/**
 * Foreground sync service: keeps the phone honestly present to JARVIS Core.
 *
 * Loop (runs every SyncBackoff.HEARTBEAT_MS while running):
 *   1. send a real heartbeat (battery/network/build + declared capabilities);
 *   2. on success: reset backoff, poll for queued commands, execute `ping`
 *      commands by actually measuring the round-trip to the core and ack the
 *      concrete result;
 *   3. on connection failure: backoff (1s → 2s → … → 60s, SyncBackoff) until a
 *      heartbeat succeeds again. Reconnect is exactly this retry.
 *
 * The UI reads [state] — it never fabricates "connected" claims.
 */
class JarvisSyncService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loopJob: Job? = null
    private val client = JarvisPhoneClient()
    private lateinit var store: PairingStore

    /** Set while the service is allowed to run; cleared in [onDestroy]. */
    @Volatile
    private var active = false

    /** Shared, observable sync state for the activity UI. */
    companion object {
        private const val CHANNEL_ID = "jarvis_sync"
        private const val NOTIFICATION_ID = 2001
        const val EXTRA_FORCE_PROBE = "force_probe"

        private val _state = MutableStateFlow(SyncState())
        val state: StateFlow<SyncState> = _state.asStateFlow()
    }

    override fun onCreate() {
        super.onCreate()
        store = PairingStore(this)
        createChannel()
        startAsForeground(buildNotification("Waiting for the first heartbeat…"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val force = intent?.getBooleanExtra(EXTRA_FORCE_PROBE, false) == true
        if (!store.isPaired()) {
            _state.value = SyncState(connection = "not_paired", lastError = "Pair this phone with a JARVIS laptop first.")
            stopSelf()
            return START_NOT_STICKY
        }
        active = true
        if (loopJob == null) {
            loopJob = scope.launch { runSyncLoop(force) }
        } else if (force) {
            scope.launch { probeNow() }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        active = false
        loopJob?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun runSyncLoop(probeImmediately: Boolean) {
        val host = store.lastHost ?: ""
        val deviceId = store.deviceId ?: CompanionIdentity.DEVICE_ID
        val token = store.token ?: return

        var attempt = 0
        var first = probeImmediately
        while (active && coroutineContext.isActive) {
            val delayMs = if (first) 0L else SyncBackoff.HEARTBEAT_MS
            first = false
            delay(delayMs)

            _state.value = _state.value.copy(connection = "connecting", lastError = null)
            try {
                val sent = client.heartbeat(host, token, deviceId, DeviceInfo.heartbeatMeta(this))
                if (!sent) throw IOException("heartbeat rejected")

                val polled = client.poll(host, token, deviceId)
                if (polled.ok && polled.commands.isNotEmpty()) {
                    executeCommands(host, token, deviceId, polled.commands)
                }

                attempt = 0
                _state.value = _state.value.copy(
                    connection = "connected",
                    lastHeartbeatMs = System.currentTimeMillis(),
                    lastBattery = DeviceInfo.batteryPercent(this),
                )
                updateNotification("Connected — last heartbeat ${android.text.format.DateFormat.getTimeFormat(this).format(System.currentTimeMillis())}")
            } catch (t: Throwable) {
                _state.value = _state.value.copy(
                    connection = "retrying",
                    lastError = t.message ?: t.javaClass.simpleName,
                )
                updateNotification("Reconnecting… (${t.message ?: "no route to host"})")
                delay(SyncBackoff.retryDelayMs(attempt))
                attempt += 1
            }
        }
    }

    private suspend fun executeCommands(host: String, token: String, deviceId: String, commands: List<PollCommand>) {
        for (command in commands) {
            when (command.kind) {
                "ping" -> {
                    // Execute the ping for real: measure the round-trip echo.
                    val (pong, rttMs) = client.ping(host, token, deviceId)
                    val ok = pong.ok && pong.pong
                    client.ack(host, token, deviceId, command.commandId, ok, "pong ${rttMs}ms")
                    _state.value = _state.value.copy(lastPingRttMs = rttMs, lastPingAtMs = System.currentTimeMillis())
                }
            }
        }
    }

    private suspend fun probeNow() {
        val host = store.lastHost ?: return
        val deviceId = store.deviceId ?: CompanionIdentity.DEVICE_ID
        val token = store.token ?: return
        try {
            val sent = client.heartbeat(host, token, deviceId, DeviceInfo.heartbeatMeta(this))
            if (!sent) throw IOException("heartbeat rejected")
            _state.value = _state.value.copy(connection = "connected", lastHeartbeatMs = System.currentTimeMillis(), lastBattery = DeviceInfo.batteryPercent(this))
        } catch (t: Throwable) {
            _state.value = _state.value.copy(connection = "error", lastError = t.message ?: "probe failed")
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW).apply {
                description = getString(R.string.channel_description)
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }
    }

    /**
     * Promote to a foreground service, declaring the dataSync type exactly as
     * the manifest does. OEM builds can still refuse this; the sync loop keeps
     * running either way and the WorkManager watchdog re-promotes later.
     */
    private fun startAsForeground(notification: Notification) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (t: Throwable) {
            // Remain a best-effort background service; a foreground start will
            // succeed next time the app is opened and the service restarts.
        }
    }

    private fun buildNotification(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, buildNotification(text))
    }

    data class SyncState(
        val connection: String = "idle",
        val lastHeartbeatMs: Long = 0,
        val lastBattery: Int = -1,
        val lastPingRttMs: Long = -1,
        val lastPingAtMs: Long = 0,
        val lastError: String? = null,
    )
}