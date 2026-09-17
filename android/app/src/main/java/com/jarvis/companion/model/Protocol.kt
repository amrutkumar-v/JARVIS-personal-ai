package com.jarvis.companion.model

/**
 * Wire models for the JARVIS phone LAN protocol.
 *
 * This is a thin mirror of the backend's `/phone/` JSON contract
 * (server/src/phoneServer.ts). Everything here is REAL: fields the backend
 * actually sends and accepts. There is deliberately no call/SMS/contact/
 * notification fake — telephony is added only where this build genuinely
 * implements it through Android OS APIs (see `telephony/`), and the capability
 * list is composed from the REAL device + permission state at heartbeat time.
 */

/** Device identity this app reports when it checks in. */
object CompanionIdentity {
    const val DEVICE_ID = "s26-ultra"

    /**
     * Capabilities this build implements on EVERY device (no hardware needed).
     * Telephony is appended separately and only when the hardware really exists
     * — see `TelephonyCapability.callCapabilities`.
     */
    val CAPABILITIES = listOf("status", "battery", "network", "ping", "heartbeat", "connection")
}

/** Outbound: exchange the pairing code for a per-device credential token. */
data class PairRequest(val device: String, val code: String)

/** Response to PairRequest. token is only ever sent to the phone once. */
data class PairResponse(
    val ok: Boolean,
    val token: String? = null,
    val device: PairDevice? = null,
    val error: String? = null,
)

data class PairDevice(val id: String, val name: String, val role: String?)

/** Telemetry pushed by the phone with every heartbeat. */
data class HeartbeatMeta(
    val name: String? = null,
    val version: String? = null,
    val battery: Int? = null,
    val charging: Boolean? = null,
    val network: String? = null,
    val connection: String? = null,
    val capabilities: List<String>? = null,
    val permissions: List<String>? = null,
)

/** Outbound: the phone reports real liveness + telemetry. */
data class HeartbeatRequest(val id: String, val meta: HeartbeatMeta)

/** Outbound: the phone asks what the backend currently believes about it. */
data class StatusRequest(val id: String)

/** Backend's view of the device, recomputed from heartbeat freshness. */
data class DeviceEnvelope(
    val id: String,
    val name: String? = null,
    val role: String? = null,
    val platform: String? = null,
    val online: Boolean,
    val health: String? = null,
    val battery: Int? = null,
    val charging: Boolean? = null,
    val network: String? = null,
    val connection: String? = null,
    val capabilities: List<String>? = null,
    val lastHeartbeatAt: Long = 0,
)

data class StatusResponse(
    val ok: Boolean,
    val serverAt: Long = 0,
    val device: DeviceEnvelope? = null,
    val error: String? = null,
)

/** Outbound: reachability echo phone → core. */
data class PingRequest(val id: String)

data class PingResponse(
    val ok: Boolean,
    val pong: Boolean = false,
    val serverAt: Long = 0,
    val deviceId: String? = null,
    val error: String? = null,
)

/**
 * Command the core queued for this phone to pick up via /phone/poll.
 *
 * `kind` is one of the backend's closed allow-list: `ping`, `call.dial`,
 * `call.hangup`, `call.answer`, `call.reject`. `payload` carries only the
 * fields that kind declares (e.g. `number`/`contactName` for `call.dial`) and
 * is absent for payload-free kinds.
 */
data class PollCommand(
    val commandId: String,
    val kind: String,
    val deviceId: String,
    val requestId: String,
    val enqueuedAt: Long = 0,
    val expiresAt: Long = 0,
    val payload: Map<String, String>? = null,
)

data class PollResponse(
    val ok: Boolean,
    val serverAt: Long = 0,
    val commands: List<PollCommand> = emptyList(),
    val error: String? = null,
)

/** Outbound: report a concrete result for an executed command. */
data class AckRequest(
    val id: String,
    val commandId: String,
    val ok: Boolean,
    val detail: String? = null,
)

data class AckResponse(
    val ok: Boolean,
    val acknowledged: Boolean = false,
    val commandId: String? = null,
    val error: String? = null,
)

/**
 * Outbound: a REAL device event the phone observed (today: telephony call
 * state straight from the OS call-state callback). The backend validates the
 * state against its closed vocabulary and fans it out over SSE.
 */
data class PhoneEventRequest(
    val id: String,
    val kind: String,
    val state: String,
    val direction: String? = null,
    val commandId: String? = null,
    val contactName: String? = null,
    val number: String? = null,
    val reason: String? = null,
)

data class PhoneEventResponse(
    val ok: Boolean,
    val accepted: Boolean = false,
    val deviceId: String? = null,
    val callState: String? = null,
    val deviceOnline: Boolean = false,
    val error: String? = null,
)

/** Generic error envelope used on every phone endpoint. */
data class ApiError(val ok: Boolean, val error: String?)