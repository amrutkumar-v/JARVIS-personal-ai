package com.jarvis.companion.telephony

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File
import java.util.Locale
import kotlin.coroutines.resume

/**
 * Speaks a short text out loud on the phone, so the person on the other side
 * of a live call can hear JARVIS.
 *
 * HOW IT WORKS
 *   1. The phone's own Android text-to-speech engine synthesizes the text
 *      into a short WAV in the app cache.
 *   2. That file is played back with `USAGE_VOICE_COMMUNICATION`, which puts
 *      it on the call's audio path.
 *
 * THE HONEST LIMIT — and it is a platform limit, not a bug in this app:
 *   During an active call Android routes call audio to the communication
 *   device (earpiece, wired headset or Bluetooth). The text is therefore only
 *   audible to the other party when the call is on SPEAKERPHONE. This class
 *   reports which of the two happened, so the PC is never told "the other
 *   party heard it" unless that is actually true.
 *
 *   What this app canNOT do is LISTEN to the other party. Since Android 10 a
 *   normal (non-privileged, non-default-dialer) app cannot capture a live
 *   call's far-end audio: the `VOICE_CALL` / `VOICE_DOWNLINK` audio sources
 *   are refused unless the app holds `CAPTURE_AUDIO_OUTPUT`, which is a
 *   signature|privileged permission that is never granted to third-party apps.
 *   The human therefore relays what the other side says.
 *
 * No permission is required to PLAY audio, so this feature adds nothing to the
 * manifest.
 */
class CallSpeaker(private val context: Context) {

    /** The outcome of one speak request. `state` is a wire status word. */
    data class SpeakResult(val ok: Boolean, val state: String, val detail: String)

    private var tts: TextToSpeech? = null
    private var player: MediaPlayer? = null

    @Volatile
    private var ready = false

    /** True once the speech engine is genuinely usable on this device. */
    val available: Boolean get() = ready

    init {
        try {
            // The init callback always runs AFTER this constructor returns, so
            // `tts` is assigned by the time it fires.
            tts = TextToSpeech(context.applicationContext) { status ->
                if (status == TextToSpeech.SUCCESS) {
                    val language = tts?.setLanguage(Locale.US)
                    ready = language != TextToSpeech.LANG_MISSING_DATA && language != TextToSpeech.LANG_NOT_SUPPORTED
                } else {
                    ready = false
                }
            }
        } catch (t: Throwable) {
            // A device without a usable speech engine simply never becomes
            // ready, and the capability is not advertised.
            ready = false
        }
    }

    /**
     * Speak [text] on the phone's loudspeaker. Suspends until playback ends
     * (or fails) and reports exactly what happened.
     */
    suspend fun speak(text: String): SpeakResult {
        val engine = tts
        if (engine == null) {
            return SpeakResult(false, "NOT_SUPPORTED", "This phone has no text-to-speech engine.")
        }
        if (!ready) {
            return SpeakResult(false, "NOT_SUPPORTED", "This phone's text-to-speech engine is not ready yet.")
        }
        val clean = text.trim()
        if (clean.isEmpty()) {
            return SpeakResult(false, "FAILED", "There was nothing to say.")
        }
        if (clean.length > MAX_SPOKEN_CHARS) {
            return SpeakResult(false, "FAILED", "The reply is too long to speak in one call turn (${clean.length} characters).")
        }

        val file = File(context.cacheDir, "jarvis-call-${System.currentTimeMillis()}.wav")
        return try {
            suspendCancellableCoroutine { continuation ->
                var settled = false
                fun settle(result: SpeakResult) {
                    if (settled) return
                    settled = true
                    if (continuation.isActive) continuation.resume(result)
                }

                engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) = Unit

                    override fun onDone(utteranceId: String?) {
                        playFile(file) { ok, detail ->
                            file.delete()
                            settle(SpeakResult(ok, if (ok) "SPOKEN" else "FAILED", detail))
                        }
                    }

                    @Deprecated("Kept for API levels that still call the single-argument overload")
                    override fun onError(utteranceId: String?) {
                        file.delete()
                        settle(SpeakResult(false, "FAILED", "This phone's speech engine could not synthesize the text."))
                    }

                    override fun onError(utteranceId: String?, errorCode: Int) {
                        file.delete()
                        settle(SpeakResult(false, "FAILED", "This phone's speech engine could not synthesize the text."))
                    }
                })

                val utteranceId = engine.synthesizeToFile(clean, Bundle(), file, UTTERANCE_ID)
                if (utteranceId == TextToSpeech.ERROR) {
                    file.delete()
                    settle(SpeakResult(false, "FAILED", "This phone's speech engine refused the text."))
                }
            }
        } catch (t: Throwable) {
            // Cancellation must keep propagating — swallowing it would make a
            // cancelled coroutine look like a failed utterance.
            if (t is CancellationException) throw t
            file.delete()
            SpeakResult(false, "FAILED", "The phone could not speak: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    /** Release the speech engine and any playback. */
    fun shutdown() {
        try {
            player?.release()
        } catch (t: Throwable) {
            // Nothing to release.
        }
        player = null
        try {
            tts?.stop()
            tts?.shutdown()
        } catch (t: Throwable) {
            // Nothing to release.
        }
        tts = null
        ready = false
    }

    private fun playFile(file: File, done: (ok: Boolean, detail: String) -> Unit) {
        try {
            player?.release()
            val media = MediaPlayer()
            player = media
            media.setAudioAttributes(
                AudioAttributes.Builder()
                    // Joins the call's communication audio path, so the output
                    // follows the call's routing (speaker / earpiece / headset).
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            media.setDataSource(file.absolutePath)
            // Prepared ASYNCHRONOUSLY: this runs on the thread that delivered
            // the TTS callback (the main thread), and a blocking prepare() there
            // would stall the UI.
            media.setOnPreparedListener { prepared -> prepared.start() }
            media.setOnCompletionListener {
                done(
                    true,
                    if (speakerphoneLikelyOn()) {
                        "The phone played the text on its loudspeaker during the call."
                    } else {
                        "The phone played the text, but the call is routed to the earpiece or headset, " +
                            "so the other party may not have heard it. Switch the call to speakerphone."
                    },
                )
            }
            media.setOnErrorListener { _, what, extra ->
                done(false, "The phone could not play the audio (what=$what, extra=$extra).")
                true
            }
            media.prepareAsync()
        } catch (t: Throwable) {
            done(false, "The phone could not play the audio: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    /**
     * Best-effort: is the call currently routed to the built-in loudspeaker?
     * Used only to phrase the acknowledgement honestly — never to decide
     * whether the audio was played.
     *
     * `AudioManager.getCommunicationDevice()` is the device a call is routed
     * to (API 31+). There is no `AudioDeviceInfo.isCommunicationDevice` — the
     * active communication device is the only reliable answer.
     */
    private fun speakerphoneLikelyOn(): Boolean {
        val manager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return false
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val communication = manager.communicationDevice
                communication != null && communication.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
            } else {
                @Suppress("DEPRECATION")
                val legacy = manager.isSpeakerphoneOn
                legacy
            }
        } catch (t: Throwable) {
            false
        }
    }

    companion object {
        /** The longest reply the phone will speak in one call turn. */
        const val MAX_SPOKEN_CHARS = 400
        private const val UTTERANCE_ID = "jarvis-call"
    }
}
