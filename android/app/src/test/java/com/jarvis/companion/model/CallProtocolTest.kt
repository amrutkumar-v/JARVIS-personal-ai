package com.jarvis.companion.model

import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Wire-contract tests for the telephony additions.
 *
 * These assert the EXACT shapes the JARVIS Core backend sends and accepts
 * (server/src/phoneCommands.ts + server/src/http.ts): a polled `call.dial`
 * carries its allow-listed payload, and an outbound `call.state` event carries
 * the validated state vocabulary. A drift here would silently stop real calls
 * from working, so it is pinned.
 */
class CallProtocolTest {

    private val gson = Gson()

    @Test
    fun parsesPolledDialCommandWithPayload() {
        val json = """
            {
              "commandId": "c-1",
              "kind": "call.dial",
              "deviceId": "s26-ultra",
              "requestId": "r-1",
              "enqueuedAt": 1,
              "expiresAt": 2,
              "payload": { "number": "+919876543210", "contactName": "Dad" }
            }
        """.trimIndent()

        val command = gson.fromJson(json, PollCommand::class.java)

        assertEquals("call.dial", command.kind)
        assertEquals("+919876543210", command.payload?.get("number"))
        assertEquals("Dad", command.payload?.get("contactName"))
    }

    @Test
    fun parsesPayloadFreeControlCommand() {
        val json = """
            { "commandId": "c-2", "kind": "call.hangup", "deviceId": "s26-ultra", "requestId": "r-2" }
        """.trimIndent()

        val command = gson.fromJson(json, PollCommand::class.java)

        assertEquals("call.hangup", command.kind)
        assertNull(command.payload)
    }

    @Test
    fun serializesCallStateEventWithDeviceIdInjected() {
        val event = PhoneEventRequest(
            id = "s26-ultra",
            kind = "call.state",
            state = "RINGING",
            direction = "incoming",
            commandId = "c-3",
        )

        val parsed = gson.fromJson(gson.toJson(event), PhoneEventRequest::class.java)

        assertEquals("s26-ultra", parsed.id)
        assertEquals("call.state", parsed.kind)
        assertEquals("RINGING", parsed.state)
        assertEquals("incoming", parsed.direction)
        assertEquals("c-3", parsed.commandId)
    }

    @Test
    fun parsesPhoneEventAck() {
        val json = """
            { "ok": true, "accepted": true, "deviceId": "s26-ultra", "callState": "CONNECTED", "deviceOnline": true }
        """.trimIndent()

        val response = gson.fromJson(json, PhoneEventResponse::class.java)

        assertEquals(true, response.accepted)
        assertEquals("CONNECTED", response.callState)
    }
}
