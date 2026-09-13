package com.jarvis.companion.notifications

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.jarvis.companion.model.PhoneNotification
import com.jarvis.companion.service.JarvisBridgeService
import java.util.UUID

class NotificationBridgeService : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        super.onNotificationPosted(sbn)
        sbn ?: return

        // Skip our own companion app notifications
        if (sbn.packageName == packageName) return

        val extras = sbn.notification.extras ?: return
        val title = extras.getString(Notification.EXTRA_TITLE) ?: ""
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""

        if (title.isBlank() && text.isBlank()) return

        val pm = packageManager
        val appName = try {
            val appInfo = pm.getApplicationInfo(sbn.packageName, 0)
            pm.getApplicationLabel(appInfo).toString()
        } catch (e: Exception) {
            sbn.packageName
        }

        val notificationItem = PhoneNotification(
            id = sbn.id.toString(),
            packageName = sbn.packageName,
            appName = appName,
            title = title,
            content = text,
            timestamp = sbn.postTime
        )

        JarvisBridgeService.notifyPhoneNotification(applicationContext, notificationItem)
    }
}
