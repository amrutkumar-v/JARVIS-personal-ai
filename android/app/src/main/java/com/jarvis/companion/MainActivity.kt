package com.jarvis.companion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.jarvis.companion.service.JarvisBridgeService
import com.jarvis.companion.telephony.CallManager

class MainActivity : AppCompatActivity() {

    private lateinit var tvStatus: TextView
    private lateinit var tvCallState: TextView
    private lateinit var tvPermissions: TextView
    private lateinit var etServerUrl: EditText
    private lateinit var btnConnect: Button

    private val requiredPermissions = arrayOf(
        Manifest.permission.READ_PHONE_STATE,
        Manifest.permission.CALL_PHONE,
        Manifest.permission.READ_CONTACTS,
        Manifest.permission.SEND_SMS,
        Manifest.permission.READ_SMS,
        Manifest.permission.RECORD_AUDIO,
        Manifest.permission.MODIFY_AUDIO_SETTINGS
    )

    private val PERMISSION_REQUEST_CODE = 2001

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvStatus = findViewById(R.id.tvStatus)
        tvCallState = findViewById(R.id.tvCallState)
        tvPermissions = findViewById(R.id.tvPermissions)
        etServerUrl = findViewById(R.id.etServerUrl)
        btnConnect = findViewById(R.id.btnConnect)

        etServerUrl.setText("http://10.0.2.2:3000") // default emulator loopback to host

        btnConnect.setOnClickListener {
            val url = etServerUrl.text.toString().trim()
            if (url.isNotEmpty()) {
                startBridgeService(url)
                tvStatus.text = "Status: Connecting to $url..."
            }
        }

        checkAndRequestPermissions()
        checkNotificationListenerPermission()
    }

    override fun onResume() {
        super.onResume()
        updateCallStateDisplay()
    }

    private fun checkAndRequestPermissions() {
        val missing = requiredPermissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (missing.isNotEmpty()) {
            tvPermissions.text = "Permissions: Missing ${missing.size} permissions"
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), PERMISSION_REQUEST_CODE)
        } else {
            tvPermissions.text = "Permissions: All telephony and contact permissions granted"
            startBridgeService(etServerUrl.text.toString().trim())
        }
    }

    private fun checkNotificationListenerPermission() {
        val enabledListeners = Settings.Secure.getString(contentResolver, "enabled_notification_listeners")
        val isEnabled = enabledListeners != null && enabledListeners.contains(packageName)
        if (!isEnabled) {
            Toast.makeText(this, "Enable Notification Access for JARVIS Bridge", Toast.LENGTH_LONG).show()
        }
    }

    private fun startBridgeService(serverUrl: String) {
        val intent = Intent(this, JarvisBridgeService::class.java).apply {
            putExtra("SERVER_URL", serverUrl)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
        tvStatus.text = "Status: Bridge service active"
    }

    private fun updateCallStateDisplay() {
        val activeCall = CallManager.currentActiveCall
        if (activeCall != null) {
            val contactInfo = activeCall.contactName ?: activeCall.phoneNumber
            tvCallState.text = "Active Call: ${activeCall.state} ($contactInfo)"
        } else {
            tvCallState.text = "Active Call: Idle"
        }
    }
}
