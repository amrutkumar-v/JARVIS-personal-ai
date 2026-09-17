package com.jarvis.companion.device

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import com.jarvis.companion.BuildConfig
import com.jarvis.companion.model.CompanionIdentity
import com.jarvis.companion.model.HeartbeatMeta
import com.jarvis.companion.telephony.TelephonyCapability

/**
 * Reads REAL battery + network + build state from the device.
 *
 * No permission is needed beyond the ones declared: battery state comes from
 * the system's sticky ACTION_BATTERY_CHANGED broadcast, network from
 * ConnectivityManager (needs ACCESS_NETWORK_STATE only). Every value here is
 * actually read from the OS — there are no fabricated numbers.
 */
object DeviceInfo {

    fun batteryPercent(context: Context): Int {
        val intent = batteryIntent(context) ?: return -1
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level < 0 || scale <= 0) return -1
        return ((level * 100f) / scale).toInt().coerceIn(0, 100)
    }

    fun isCharging(context: Context): Boolean {
        val intent = batteryIntent(context) ?: return false
        val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
        return plugged != 0 || status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
    }

    fun networkLabel(context: Context): String {
        val cm = context.applicationContext
            .getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return "unknown"
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "none"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    }

    fun modelName(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()

    fun appVersion(): String = BuildConfig.VERSION_NAME

    /**
     * Build the exact heartbeat meta this build declares.
     *
     * Capabilities and permissions are computed from the REAL device and
     * runtime-permission state every heartbeat: `call` only appears when the
     * hardware exists, and the permission list contains only granted
     * permissions. JARVIS Core therefore refuses a call with
     * PERMISSION_REQUIRED / NOT_SUPPORTED instead of pretending.
     */
    fun heartbeatMeta(context: Context): HeartbeatMeta = HeartbeatMeta(
        name = modelName(),
        version = appVersion(),
        battery = batteryPercent(context),
        charging = isCharging(context),
        network = networkLabel(context),
        connection = "lan",
        capabilities = CompanionIdentity.CAPABILITIES + TelephonyCapability.callCapabilities(context),
        permissions = TelephonyCapability.grantedPermissions(context),
    )

    private fun batteryIntent(context: Context): Intent? {
        // The sticky broadcast holds the CURRENT battery snapshot and needs no
        // receiver registration, so no permission is required. The flags form
        // is the Android 14 (targetSdk 34) safe variant for a null receiver.
        return try {
            androidx.core.content.ContextCompat.registerReceiver(
                context.applicationContext,
                null,
                IntentFilter(Intent.ACTION_BATTERY_CHANGED),
                Context.RECEIVER_NOT_EXPORTED,
            )
        } catch (t: Throwable) {
            null
        }
    }
}