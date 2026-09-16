package com.jarvis.companion.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.jarvis.companion.trust.PairingStore

/**
 * Restarts the sync service after a reboot / update — but ONLY when this phone
 * is already paired. A never-paired phone never starts talking to the LAN.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val store = try {
            PairingStore(context)
        } catch (t: Throwable) {
            return // keystore unavailable; nothing sensible to do at boot.
        }
        if (!store.isPaired()) return

        val service = Intent(context, JarvisSyncService::class.java)
        try {
            context.startForegroundService(service)
        } catch (t: Throwable) {
            // A dataSync foreground start may be refused from the background on
            // some Android 14+ builds; the WorkManager watchdog below keeps
            // retrying, and opening the app resumes the foreground loop.
        }

        // Independently arm the periodic watchdog so a killed service is
        // restarted (or at least re-heartbeat) even if this call above failed.
        SyncWatchdog.schedule(context)
    }
}