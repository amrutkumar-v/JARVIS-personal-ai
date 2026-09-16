package com.jarvis.companion.service

import android.content.Context
import android.content.Intent
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.jarvis.companion.device.DeviceInfo
import com.jarvis.companion.model.CompanionIdentity
import com.jarvis.companion.net.JarvisPhoneClient
import com.jarvis.companion.trust.PairingStore
import java.util.concurrent.TimeUnit

/**
 * Pure (JVM-testable) policy for the watchdog schedule.
 */
object WatchdogPolicy {
    const val UNIQUE_NAME = "jarvis_sync_watchdog"
    const val INTERVAL_MIN = 15L
}

/**
 * Scheduled safety net: the OS may kill the foreground sync service (Samsung
 * Adaptive Battery, Doze, app standby, crashes). This periodic worker re-opens
 * it; if Android refuses a background dataSync foreground start, the worker
 * still sends a direct heartbeat so the device stays honestly reachable.
 */
class SyncWatchdogWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val store = try {
            PairingStore(applicationContext)
        } catch (t: Throwable) {
            return Result.failure()
        }
        if (!store.isPaired()) return Result.success()

        startForegroundIfNeeded()
        heartbeatDirectly(store)
        return Result.success()
    }

    private fun startForegroundIfNeeded() {
        val service = Intent(applicationContext, JarvisSyncService::class.java)
        try {
            applicationContext.startForegroundService(service)
        } catch (t: Throwable) {
            // Background dataSync FGS start is refused on API 31+; the direct
            // heartbeat below keeps us present, and opening the app resumes
            // the full foreground loop.
        }
    }

    private suspend fun heartbeatDirectly(store: PairingStore) {
        val host = store.lastHost ?: return
        val deviceId = store.deviceId ?: CompanionIdentity.DEVICE_ID
        val token = store.token ?: return
        try {
            JarvisPhoneClient().heartbeat(host, token, deviceId, DeviceInfo.heartbeatMeta(applicationContext))
        } catch (t: Throwable) {
            // next periodic run will retry.
        }
    }
}

object SyncWatchdog {

    /** Schedule a unique periodic retry worker; reuses/updates the existing one. */
    fun schedule(context: Context) {
        val request = PeriodicWorkRequestBuilder<SyncWatchdogWorker>(
            WatchdogPolicy.INTERVAL_MIN,
            TimeUnit.MINUTES,
        )
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
            )
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            WatchdogPolicy.UNIQUE_NAME,
            ExistingPeriodicWorkPolicy.UPDATE,
            request,
        )
    }

    /** Cancel the watchdog (only valid after the user forgets this JARVIS). */
    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(WatchdogPolicy.UNIQUE_NAME)
    }
}