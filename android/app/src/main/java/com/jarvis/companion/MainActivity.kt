package com.jarvis.companion

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.jarvis.companion.databinding.ActivityMainBinding
import com.jarvis.companion.device.DeviceInfo
import com.jarvis.companion.model.CompanionIdentity
import com.jarvis.companion.net.JarvisPhoneClient
import com.jarvis.companion.service.JarvisSyncService
import com.jarvis.companion.service.JarvisSyncService.SyncState
import com.jarvis.companion.service.SyncWatchdog
import com.jarvis.companion.trust.PairingStore
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * JARVIS Companion — Phase 1 control panel.
 *
 * Pair this phone to a JARVIS laptop once (host + 6-digit code shown in the
 * backend log), then the sync service heartbeats forever: battery, network,
 * build version and the exact capabilities this build implements. The bottom
 * half of the screen is read-only telemetry — no capability is claimed that
 * the app does not actually perform.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var store: PairingStore
    private val client = JarvisPhoneClient()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        store = PairingStore(this)
        requestNotificationPermission()

        binding.etHost.setText(store.lastHost ?: DEFAULT_HOST)
        renderPairedState()

        binding.btnPair.setOnClickListener { pair() }
        binding.btnRefresh.setOnClickListener { probeBackend() }
        binding.btnPing.setOnClickListener { pingBackend() }
        binding.btnForget.setOnClickListener {
            stopService(Intent(this, JarvisSyncService::class.java))
            SyncWatchdog.cancel(this)
            store.clear()
            renderPairedState()
        }

        lifecycleScope.launch {
            JarvisSyncService.state.collect { renderSyncState(it) }
        }
    }

    override fun onResume() {
        super.onResume()
        renderPairedState()
    }

    private fun pair() {
        val hostRaw = binding.etHost.text.toString().trim()
        val code = binding.etCode.text.toString().trim()
        if (hostRaw.isEmpty()) { toast("Enter the laptop IP or hostname"); return }
        if (!code.matches(Regex("\\d{6}"))) { toast("Enter the 6-digit pairing code"); return }

        binding.btnPair.isEnabled = false
        binding.tvStatus.text = "Pairing with core at ${PairingStore.normalizeHost(hostRaw)}…"
        lifecycleScope.launch {
            runCatching { client.pair(hostRaw, CompanionIdentity.DEVICE_ID, code) }
                .onSuccess { response ->
                    if (response.ok && response.token != null && response.device != null) {
                        store.saveCredential(hostRaw, response.device.id, response.token)
                        toast("Paired as ${response.device.name}")
                        SyncWatchdog.schedule(this@MainActivity)
                        startSyncService()
                        requestBatteryOptimizationExemption()
                        renderPairedState()
                    } else {
                        binding.tvStatus.text =
                            "Pairing rejected: ${response.error ?: "unknown"}. Check the code — each code is single-use, so start a NEW pairing session on the laptop."
                    }
                }
                .onFailure { error ->
                    binding.tvStatus.text =
                        "Cannot reach $hostRaw — is the backend running with the phone listener enabled (JARVIS_PHONE_ENABLED=true, port 8788), the laptop firewall open for private networks, and the phone on the same Wi-Fi?"
                    binding.tvStatus.append(" (${error.message})")
                }
                .also { binding.btnPair.isEnabled = true }
        }
    }

    private fun startSyncService() {
        val intent = Intent(this, JarvisSyncService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent) else startService(intent)
    }

    /**
     * Ask for a battery-optimization exemption so the OS keeps the foreground
     * sync loop running; on Samsung "Adaptive Battery" this is what saves the
     * park-adjacent device from being put to sleep mid-charge.
     */
    private fun requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = getSystemService(PowerManager::class.java)
            if (pm?.isIgnoringBatteryOptimizations(packageName) == true) return
            try {
                val intent = Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName"),
                )
                startActivity(intent)
            } catch (t: Throwable) {
                toast("Please allow JARVIS under Battery/Background usage to keep sync alive")
            }
        }
    }

    private fun probeBackend() {
        val token = store.token ?: return renderPairedState()
        val host = store.lastHost ?: return
        lifecycleScope.launch {
            runCatching { client.status(host, token, store.deviceId ?: CompanionIdentity.DEVICE_ID) }
                .onSuccess { response ->
                    val d = response.device
                    if (d != null) {
                        binding.tvBackend.text =
                            "Backend believes: online=${d.online}  health=${d.health ?: "?"}  " +
                                "battery=${d.battery?.let { "$it%" } ?: "?"}  charging=${d.charging ?: false}  " +
                                "net=${d.network ?: "?"}  last-heartbeat=${formatTime(d.lastHeartbeatAt)}" +
                                "\ncapabilities=${d.capabilities?.joinToString(",") ?: "none"}"
                    } else {
                        binding.tvBackend.text = "status: ${response.error ?: "unknown_device"}"
                    }
                }
                .onFailure { error -> binding.tvBackend.text = "status probe failed: ${error.message}" }
        }
    }

    private fun pingBackend() {
        val token = store.token ?: return renderPairedState()
        val host = store.lastHost ?: return
        lifecycleScope.launch {
            runCatching { client.ping(host, token, store.deviceId ?: CompanionIdentity.DEVICE_ID) }
                .onSuccess { (response, rtt) ->
                    if (response.ok && response.pong) {
                        binding.tvPing.text = "Core reachable — pong in ${rtt}ms (server ${formatTime(response.serverAt)})"
                    } else {
                        binding.tvPing.text = "Ping responded, but not a pong: ${response.error ?: "ok=false"}"
                    }
                }
                .onFailure { error -> binding.tvPing.text = "Ping failed: ${error.message}" }
        }
    }

    private fun renderPairedState() {
        val paired = store.isPaired()
        binding.tvPairState.text =
            if (paired) "Paired (${store.deviceId}) since ${formatTime(store.lastPairedAtMillis)}"
            else "Not paired yet"
        binding.btnForget.isEnabled = paired
        binding.btnRefresh.isEnabled = paired
        binding.btnPing.isEnabled = paired
        if (!paired) {
            binding.tvStatus.text =
                "What to do:\n1. On the laptop run this from a terminal:\n   curl -X POST http://127.0.0.1:8787/api/device/pair/begin -H 'content-type: application/json' -d '{\"device\":\"s26-ultra\"}'\n2. It prints a 6-digit code. (Or say \u201cJARVIS, pair the phone.\u201d)\n3. Type the laptop IP + that code here and press Pair.\nThe code expires in 10 minutes and each code works once."
            binding.tvBackend.text = "—"
            binding.tvPing.text = "—"
        }
        renderDevice()
    }

    private fun renderSyncState(state: SyncState) {
        binding.tvService.text = buildString {
            append("sync service: ${state.connection}")
            if (state.lastHeartbeatMs > 0) append(" · last heartbeat ${formatTime(state.lastHeartbeatMs)}")
            if (state.lastBattery >= 0) append(" · ${state.lastBattery}%")
            if (state.lastPingRttMs >= 0) append(" · last ping ${state.lastPingRttMs}ms")
            state.lastError?.let { append("\nerror: $it") }
        }
    }

    private fun renderDevice() {
        val percent = DeviceInfo.batteryPercent(this)
        val charging = DeviceInfo.isCharging(this)
        binding.tvDevice.text =
            "This device: ${DeviceInfo.modelName()} · Android ${Build.VERSION.RELEASE} · app ${DeviceInfo.appVersion()}" +
                "\nBattery: ${if (percent >= 0) "$percent%" else "unknown"}${if (charging) " · charging" else ""} · network: ${DeviceInfo.networkLabel(this)}"
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                ActivityCompat.requestPermissions(this, arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), PERMISSION_NOTIFICATIONS)
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERMISSION_NOTIFICATIONS) {
            toast("Notifications are only used for the ongoing \u201cJARVIS Companion active\u201d service channel")
        }
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_SHORT).show()

    private fun formatTime(epochMs: Long): String =
        if (epochMs <= 0) "never" else SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(epochMs))

    companion object {
        private const val DEFAULT_HOST = "192.168.1.3:8788"
        private const val PERMISSION_NOTIFICATIONS = 3001
    }
}