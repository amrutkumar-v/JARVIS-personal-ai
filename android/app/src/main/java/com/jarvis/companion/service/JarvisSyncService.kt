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
import com.jarvis.companion.model.PhoneEventRequest
import com.jarvis.companion.model.PollCommand
import com.jarvis.companion.net.JarvisPhoneClient
import com.jarvis.companion.telephony.CallSpeaker
import com.jarvis.companion.telephony.CallStateObserver
import com.jarvis.companion.telephony.ContactsResolver
import com.jarvis.companion.telephony.TelephonyCapability
import com.jarvis.companion.telephony.TelephonyController
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
 * Foreground sync service: keeps the phone honestly present to JARVIS Core and
 * executes the commands the core queues for it.
 *
 * Loop (runs every SyncBackoff.HEARTBEAT_MS while running):
 *   1. send a real heartbeat (battery/network/build + the REAL capability and
 *      permission state computed at that moment);
 *   2. on success: reset backoff, poll for queued commands, execute them, and
 *      ack the concrete result;
 *   3. on connection failure: backoff (1s → 2s → … → 60s, SyncBackoff) until a
 *      heartbeat succeeds again. Reconnect is exactly this retry.
 *
 * Commands executed here (the backend's closed allow-list):
 *   `ping`        — measure the real round-trip echo;
 *   `call.dial`   — resolve a contact (if a name was given) and place a REAL
 *                   call through `TelecomManager`;
 *   `call.answer` — answer the ringing call where the OS permits it;
 *   `call.reject` — reject the ringing call where the OS permits it;
 *   `call.hangup` — end the active call where the OS permits it.
 *
 * Every telephony action is answered with the phone's honest state (including
 * PERMISSION_REQUIRED / NOT_SUPPORTED when the OS refuses) and additionally
 * pushed to the core as a real `call.state` event. The real OS call-state
 * callback runs for the whole service lifetime, so genuine transitions —
 * including INCOMING calls — are reported without being asked for.
 */
class JarvisSyncService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loopJob: Job? = null
    private val client = JarvisPhoneClient()
    private lateinit var store: PairingStore
    private lateinit var telephony: TelephonyController
    private lateinit var speaker: CallSpeaker
    private var observer: CallStateObserver? = null

    /** Set while the service is allowed to run; cleared in [onDestroy]. */
    @Volatile
    private var active = false

    /** Outgoing-call context, so observed states can be attributed honestly. */
    @Volatile
    private var outgoingCommandId: String? = null

    @Volatile
    private var outgoingNumber: String? = null

    @Volatile
    private var outgoingContact: String? = null

    @Volatile
    private var callActive = false

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
        telephony = TelephonyController(this)
        speaker = CallSpeaker(this)
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
        startCallObservation()
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
        observer?.stop()
        observer = null
        speaker.shutdown()
        loopJob?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    /**
     * Register the REAL OS call-state callback. When `READ_PHONE_STATE` is not
     * granted Android refuses registration; that is reported honestly in the UI
     * instead of being hidden.
     */
    private fun startCallObservation() {
        if (observer?.observing == true) return
        val created = CallStateObserver(
            context = this,
            directionProvider = { if (callActive) "outgoing" else "incoming" },
            onState = { state, direction -> onObservedCallState(state, direction) },
        )
        val observing = created.start()
        observer = created
        _state.value = _state.value.copy(callObservation = observing)
        if (!observing) {
            _state.value = _state.value.copy(
                lastError = "Call-state observation is unavailable (READ_PHONE_STATE not granted).",
            )
        }
    }

    private fun onObservedCallState(state: String, direction: String?) {
        if (state == "ENDED") callActive = false
        if (state == "CONNECTED") callActive = true
        _state.value = _state.value.copy(lastCallState = state)
        val commandId = outgoingCommandId
        val contact = outgoingContact
        val number = outgoingNumber
        if (state == "ENDED") {
            outgoingCommandId = null
            outgoingContact = null
            outgoingNumber = null
        }
        scope.launch { pushCallEvent(state, direction, commandId, contact, number, null) }
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
                val sent = client.heartbeat(host, token, deviceId, DeviceInfo.heartbeatMeta(this, speaker.available))
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
                "call.dial" -> executeDial(host, token, deviceId, command)
                "call.answer" -> executeCallControl(host, token, deviceId, command, "answer")
                "call.reject" -> executeCallControl(host, token, deviceId, command, "reject")
                "call.hangup" -> executeCallControl(host, token, deviceId, command, "hangup")
                "call.speak" -> executeSpeak(host, token, deviceId, command)
                else -> {
                    // Unknown kinds are refused, never guessed at.
                    client.ack(host, token, deviceId, command.commandId, false, "unsupported command kind: ${command.kind}")
                }
            }
        }
    }

    /** Resolve the target on the phone and place a REAL call. */
    private suspend fun executeDial(host: String, token: String, deviceId: String, command: PollCommand) {
        val payloadNumber = command.payload?.get("number")?.takeIf { it.isNotBlank() }
        val requestedName = command.payload?.get("contactName")?.takeIf { it.isNotBlank() }
        var resolvedName = requestedName
        var dialNumber = payloadNumber

        if (dialNumber == null && requestedName != null) {
            when (val lookup = ContactsResolver.findNumber(this, requestedName)) {
                is ContactsResolver.ContactLookup.Found -> {
                    dialNumber = lookup.number
                    resolvedName = lookup.name
                }
                is ContactsResolver.ContactLookup.PermissionRequired -> {
                    ackAndReport(host, token, deviceId, command, false, "PERMISSION_REQUIRED: READ_CONTACTS is not granted, so \"$requestedName\" could not be resolved to a number.")
                    return
                }
                is ContactsResolver.ContactLookup.Ambiguous -> {
                    // NEVER guess between several contacts: ack the real choices
                    // and ask. The numbers are shown only by their last four
                    // digits — enough for the user to choose, without spraying
                    // full numbers into the event stream.
                    val choices = lookup.candidates.joinToString("; ") { "${it.name} (…${it.number.takeLast(4)})" }
                    ackAndReport(host, token, deviceId, command, false, "FAILED: \"$requestedName\" matches ${lookup.candidates.size} contacts: $choices. Which one should I call?")
                    return
                }
                is ContactsResolver.ContactLookup.NotFound -> {
                    ackAndReport(host, token, deviceId, command, false, "FAILED: no contact matched \"$requestedName\". Tell me the number, or the exact name as it is saved in Contacts.")
                    return
                }
                is ContactsResolver.ContactLookup.Unavailable -> {
                    ackAndReport(host, token, deviceId, command, false, "FAILED: the contacts provider could not be read.")
                    return
                }
            }
        }

        if (dialNumber == null) {
            ackAndReport(host, token, deviceId, command, false, "FAILED: the command carried neither a number nor a resolvable contact.")
            return
        }

        // Remember the outgoing context BEFORE dialling so the first observed
        // state is attributed to this call.
        outgoingCommandId = command.commandId
        outgoingContact = resolvedName
        outgoingNumber = dialNumber
        callActive = true

        val result = telephony.placeCall(dialNumber)
        if (!result.ok) callActive = false
        client.ack(host, token, deviceId, command.commandId, result.ok, "${result.state}: ${result.detail}")
        _state.value = _state.value.copy(lastCallState = result.state)
        pushCallEvent(
            state = result.state,
            direction = "outgoing",
            commandId = command.commandId,
            contactName = resolvedName,
            number = dialNumber,
            reason = if (result.ok) null else result.detail,
        )
    }

    /** Answer / reject / hang up through the OS, reporting the real outcome. */
    private suspend fun executeCallControl(
        host: String,
        token: String,
        deviceId: String,
        command: PollCommand,
        action: String,
    ) {
        val result = when (action) {
            "answer" -> telephony.acceptCall()
            "reject" -> telephony.rejectCall()
            else -> telephony.endCall()
        }
        if (action == "hangup" && result.ok) callActive = false
        client.ack(host, token, deviceId, command.commandId, result.ok, "${result.state}: ${result.detail}")
        _state.value = _state.value.copy(lastCallState = result.state)
        pushCallEvent(
            state = result.state,
            direction = if (callActive) "outgoing" else null,
            commandId = command.commandId,
            contactName = outgoingContact,
            number = outgoingNumber,
            reason = if (result.ok) null else result.detail,
        )
    }

    /**
     * Speak a reply out loud during a live call.
     *
     * The phone plays the text on its loudspeaker. The other party only hears
     * it when the call is on speakerphone — Android routes call audio to the
     * earpiece otherwise. The acknowledgement says which happened, so the PC
     * never claims the other party heard something it did not.
     */
    private suspend fun executeSpeak(
        host: String,
        token: String,
        deviceId: String,
        command: PollCommand,
    ) {
        val text = command.payload?.get("text")?.trim()?.takeIf { it.isNotEmpty() }
        if (text == null) {
            client.ack(host, token, deviceId, command.commandId, false, "FAILED: the command carried no text to speak.")
            return
        }
        // Never play into an empty room — and never talk into a call that has
        // not been ANSWERED yet. During RINGING the call audio path is not
        // established, so the other party would hear nothing.
        val connected = _state.value.lastCallState == "CONNECTED"
        if (!connected) {
            client.ack(
                host,
                token,
                deviceId,
                command.commandId,
                false,
                "FAILED: no call on this phone is connected, so nothing was spoken.",
            )
            return
        }
        val result = speaker.speak(text)
        // The ack is the authoritative channel here: speaking is not a call
        // state, so no `call.state` event is pushed for it.
        client.ack(host, token, deviceId, command.commandId, result.ok, "${result.state}: ${result.detail}")
        if (!result.ok) {
            _state.value = _state.value.copy(lastError = result.detail)
        }
    }

    /** Ack a command that failed before any OS action was attempted. */
    private suspend fun ackAndReport(
        host: String,
        token: String,
        deviceId: String,
        command: PollCommand,
        ok: Boolean,
        detail: String,
    ) {
        client.ack(host, token, deviceId, command.commandId, ok, detail)
        // The ack keeps its wire format (`STATE: detail`); the pushed EVENT
        // carries the reason without the state prefix so the PC can show the
        // phone's own words (e.g. "which one should I call?" for an ambiguous
        // contact name).
        val state = detail.substringBefore(':')
        val reason = detail.substringAfter(':', detail).trim()
        _state.value = _state.value.copy(lastCallState = state)
        val number = command.payload?.get("number")
        pushCallEvent(state, "outgoing", command.commandId, command.payload?.get("contactName"), number, reason)
    }

    /** Push one REAL call-state observation to the core (best effort, bounded). */
    private suspend fun pushCallEvent(
        state: String,
        direction: String?,
        commandId: String?,
        contactName: String?,
        number: String?,
        reason: String?,
    ) {
        val host = store.lastHost ?: return
        val token = store.token ?: return
        val deviceId = store.deviceId ?: CompanionIdentity.DEVICE_ID
        try {
            client.event(
                host,
                token,
                deviceId,
                PhoneEventRequest(
                    id = deviceId,
                    kind = "call.state",
                    state = state,
                    direction = direction,
                    commandId = commandId,
                    contactName = contactName,
                    number = number,
                    reason = reason?.take(200),
                ),
            )
        } catch (t: Throwable) {
            // The observation channel is best-effort; the ack above is the
            // authoritative result. A dropped event shows up as an unverified
            // call on the PC — never as a fabricated success.
            _state.value = _state.value.copy(lastError = "call event not delivered: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    private suspend fun probeNow() {
        val host = store.lastHost ?: return
        val deviceId = store.deviceId ?: CompanionIdentity.DEVICE_ID
        val token = store.token ?: return
        try {
            val sent = client.heartbeat(host, token, deviceId, DeviceInfo.heartbeatMeta(this, speaker.available))
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
        /** True while the REAL OS call-state callback is registered. */
        val callObservation: Boolean = false,
        /** Newest call state the phone itself observed or produced. */
        val lastCallState: String? = null,
    )
}
