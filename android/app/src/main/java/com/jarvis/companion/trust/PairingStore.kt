package com.jarvis.companion.trust

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Stores the JARVIS pairing credential for THIS phone.
 *
 * The token is a secret equivalent to a password for the phone's only
 * identity on the backend: it is stored in EncryptedSharedPreferences backed
 * by an Android Keystore AES256-GCM master key, never in plain SharedPreferences,
 * never in logs, and never sent anywhere except to the backend it was issued by.
 *
 * The app deliberately stores NOTHING else — no backend token, no AI provider
 * keys, no other secrets exist in this build.
 */
class PairingStore(context: Context) {

    private val prefs: SharedPreferences = create(context)

    /** True when a credential exists (the user paired this phone at least once). */
    fun isPaired(): Boolean = token != null && deviceId != null

    val token: String?
        get() = prefs.getString(KEY_TOKEN, null)

    val deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)

    /** Last host the phone successfully paired/heartbeated with: `host[:port]`. */
    val lastHost: String?
        get() = prefs.getString(KEY_HOST, null)

    val lastPairedAtMillis: Long
        get() = prefs.getLong(KEY_PAIRED_AT, 0L)

    /** Save the freshly-issued credential after a successful /phone/pair. */
    fun saveCredential(host: String, deviceId: String, token: String) {
        prefs.edit()
            .putString(KEY_HOST, normalizeHost(host))
            .putString(KEY_DEVICE_ID, deviceId)
            .putString(KEY_TOKEN, token)
            .putLong(KEY_PAIRED_AT, System.currentTimeMillis())
            .apply()
    }

    /** Remove the credential (app-level "forget this JARVIS" action). */
    fun clear() {
        prefs.edit().remove(KEY_TOKEN).remove(KEY_DEVICE_ID).remove(KEY_PAIRED_AT).apply()
    }

    companion object {
        private const val FILE = "jarvis_pairing"
        private const val KEY_TOKEN = "device_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_HOST = "last_host"
        private const val KEY_PAIRED_AT = "paired_at_ms"

        fun normalizeHost(input: String): String {
            var host = input.trim().trimEnd('/')
            if (host.startsWith("http://")) host = host.removePrefix("http://")
            if (host.startsWith("https://")) host = host.removePrefix("https://")
            if (host.isNotEmpty() && host.indexOf(':') == -1) host = "$host:8788"
            return host
        }

        private fun create(context: Context): SharedPreferences {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            return EncryptedSharedPreferences.create(
                context,
                FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }
    }
}