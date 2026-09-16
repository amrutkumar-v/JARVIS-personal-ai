package com.jarvis.companion.model

/**
 * Wire models for the JARVIS phone LAN protocol (Phase 1).
 *
 * This is a thin mirror of the backend's `/phone/` JSON contract
 * (server/src/phoneServer.ts). Everything here is REAL: fields the backend
 * actually sends and accepts. There is deliberately no call/SMS/contact/
 * notification fake in this phase — those capabilities do not exist yet.
 */

/** Device identity this app reports when it checks in. */
object CompanionIdentity {
    const val DEVICE_ID = "s26-ultra"
    /** The exact set of capabilities this build genuinely implements. */
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

/** Command the core queued for this phone to pick up via /phone/poll. */
data class PollCommand(
    val commandId: String,
    val kind: String,
    val deviceId: String,
    val requestId: String,
    val enqueuedAt: Long = 0,
    val expiresAt: Long = 0,
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

/** Generic error envelope used on every phone endpoint. */
data class ApiError(val ok: Boolean, val error: String?)