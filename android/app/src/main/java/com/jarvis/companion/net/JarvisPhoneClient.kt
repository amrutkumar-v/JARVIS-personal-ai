package com.jarvis.companion.net

import com.google.gson.Gson
import com.google.gson.JsonParseException
import com.jarvis.companion.model.AckRequest
import com.jarvis.companion.model.AckResponse
import com.jarvis.companion.model.HeartbeatRequest
import com.jarvis.companion.model.PairRequest
import com.jarvis.companion.model.PairResponse
import com.jarvis.companion.model.PhoneEventRequest
import com.jarvis.companion.model.PhoneEventResponse
import com.jarvis.companion.model.PingRequest
import com.jarvis.companion.model.PingResponse
import com.jarvis.companion.model.PollResponse
import com.jarvis.companion.model.StatusRequest
import com.jarvis.companion.model.StatusResponse
import com.jarvis.companion.trust.PairingStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Failure talking to JARVIS Core. Always an [IOException] so every caller can
 * treat transport, HTTP and protocol faults uniformly and no JSON/runtime
 * exception ever escapes a request boundary.
 */
class PhoneCallException(message: String, cause: Throwable? = null) : IOException(message, cause)

/**
 * HTTP client for the JARVIS phone listener (`/phone/` endpoints, LAN only).
 *
 * Everything here is explicit about what it does and who it hits:
 *  - host is the laptop LAN address, e.g. `192.168.1.3:8788`;
 *  - every non-pair call sends the per-device credential as `Authorization:
 *    Bearer <token>` and the device id in the body — the same pairing model as
 *    the backend expects;
 *  - results are strictly typed from the actual `/phone/` responses;
 *  - hardens every call: timeouts, HTTP errors, malformed JSON and unexpected
 *    bodies never escape — they become [PhoneCallException] (an IOException)
 *    or a typed `ok=false` envelope, so the sync loop only ever has to handle
 *    one kind of failure.
 */
class JarvisPhoneClient(private val timeoutMillis: Long = 10_000L) {

    private val gson = Gson()
    private val client = OkHttpClient.Builder()
        .connectTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
        .readTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
        .writeTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
        .build()

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()

        fun baseUrl(host: String): String {
            val h = PairingStore.normalizeHost(host)
            return if (h.startsWith("http://") || h.startsWith("https://")) h else "http://$h"
        }
    }

    /** /phone/pair — exchange a code for a per-device credential token. */
    suspend fun pair(host: String, deviceId: String, code: String): PairResponse = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url("${baseUrl(host)}/phone/pair")
            .post(gson.toJson(PairRequest(device = deviceId, code = code)).toRequestBody(JSON))
            .build()
        call(req) { gson.fromJson(it, PairResponse::class.java) }
    }

    /** /phone/heartbeat — real liveness + telemetry. */
    suspend fun heartbeat(host: String, token: String, deviceId: String, meta: com.jarvis.companion.model.HeartbeatMeta) =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url("${baseUrl(host)}/phone/heartbeat")
                .post(gson.toJson(HeartbeatRequest(id = deviceId, meta = meta)).toRequestBody(JSON))
                .header("authorization", "Bearer $token")
                .build()
            ok(req)
        }

    /** /phone/status — what the backend currently believes about this device. */
    suspend fun status(host: String, token: String, deviceId: String): StatusResponse = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url("${baseUrl(host)}/phone/status")
            .post(gson.toJson(StatusRequest(id = deviceId)).toRequestBody(JSON))
            .header("authorization", "Bearer $token")
            .build()
        call(req) { gson.fromJson(it, StatusResponse::class.java) }
    }

    /** /phone/ping — measurement of the real round-trip to the core. */
    suspend fun ping(host: String, token: String, deviceId: String): Pair<PingResponse, Long> = withContext(Dispatchers.IO) {
        val started = System.currentTimeMillis()
        val req = Request.Builder()
            .url("${baseUrl(host)}/phone/ping")
            .post(gson.toJson(PingRequest(id = deviceId)).toRequestBody(JSON))
            .header("authorization", "Bearer $token")
            .build()
        val rtt = System.currentTimeMillis() - started
        Pair(call(req) { gson.fromJson(it, PingResponse::class.java) }, rtt)
    }

    /** /phone/poll — drain commands the core queued for this phone. */
    suspend fun poll(host: String, token: String, deviceId: String): PollResponse = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url("${baseUrl(host)}/phone/poll")
            .post(gson.toJson(StatusRequest(id = deviceId)).toRequestBody(JSON))
            .header("authorization", "Bearer $token")
            .build()
        call(req) { gson.fromJson(it, PollResponse::class.java) }
    }

    /** /phone/ack — report a concrete result for an executed command. */
    suspend fun ack(host: String, token: String, deviceId: String, commandId: String, ok: Boolean, detail: String?): AckResponse =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url("${baseUrl(host)}/phone/ack")
                .post(gson.toJson(AckRequest(id = deviceId, commandId = commandId, ok = ok, detail = detail)).toRequestBody(JSON))
                .header("authorization", "Bearer $token")
                .build()
            call(req) { gson.fromJson(it, AckResponse::class.java) }
        }

    /**
     * /phone/event — push a REAL device observation (telephony call state the OS
     * reported) into the JARVIS Core event bus. The backend validates the state
     * against its closed vocabulary and fans it out over SSE.
     */
    suspend fun event(host: String, token: String, deviceId: String, event: PhoneEventRequest): PhoneEventResponse =
        withContext(Dispatchers.IO) {
            val req = Request.Builder()
                .url("${baseUrl(host)}/phone/event")
                .post(gson.toJson(event.copy(id = deviceId)).toRequestBody(JSON))
                .header("authorization", "Bearer $token")
                .build()
            call(req) { gson.fromJson(it, PhoneEventResponse::class.java) }
        }

    /** Heartbeat liveness: true only for a 2xx response; never throws. */
    private fun ok(req: Request): Boolean = try {
        client.newCall(req).execute().use { it.isSuccessful }
    } catch (e: IOException) {
        false
    } catch (t: Throwable) {
        false
    }

    /**
     * Execute [req] and parse the body with [parse].
     *
     * Failure contract:
     *  - transport failures (connect/read/write timeouts, refused) become
     *    [PhoneCallException] describing the target;
     *  - non-2xx responses are parsed the same way as 2xx, so the backend's
     *    `{ok:false,error:...}` envelopes come back as typed responses;
     *  - a non-JSON body or a mismatch with the expected type becomes a
     *    [PhoneCallException] — Gson JsonParseException never escapes.
     */
    private inline fun <T> call(req: Request, parse: (String) -> T): T {
        val response = try {
            client.newCall(req).execute()
        } catch (e: IOException) {
            throw PhoneCallException("Cannot reach JARVIS at ${req.url}", e)
        }
        return response.use {
            val code = it.code
            val text = try {
                it.body?.string().orEmpty()
            } catch (e: IOException) {
                throw PhoneCallException("Cannot reach JARVIS at ${req.url}: failed to read the response body", e)
            }
            try {
                if (text.isBlank()) parse("{}") else parse(text)
            } catch (e: JsonParseException) {
                throw PhoneCallException("Malformed JSON from ${req.url} (HTTP $code)", e)
            } catch (e: IOException) {
                throw PhoneCallException("Cannot reach JARVIS at ${req.url}", e)
            } catch (e: RuntimeException) {
                throw PhoneCallException("Unexpected response from ${req.url} (HTTP $code)", e)
            }
        }
    }
}