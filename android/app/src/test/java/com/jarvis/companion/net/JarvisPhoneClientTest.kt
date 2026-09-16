package com.jarvis.companion.net

import com.jarvis.companion.model.HeartbeatMeta
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import kotlinx.coroutines.runBlocking

/**
 * JVM tests for [JarvisPhoneClient] against a local MockWebServer.
 * Verifies the failure contract: transport/HTTP/JSON faults become
 * [PhoneCallException] (an IOException) and never crash a caller.
 */
class JarvisPhoneClientTest {

    private lateinit var server: MockWebServer

    private val host: String
        get() = server.url("/").let { it.host } + ":" + server.port

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun client(timeoutMs: Long = 10_000L) = JarvisPhoneClient(timeoutMillis = timeoutMs)

    private fun enqueue(json: String, code: Int = 200) {
        server.enqueue(MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(json))
    }

    @Test
    fun `heartbeat returns true on 2xx`() = runBlocking {
        enqueue("""{"ok":true}""")
        val sent = client().heartbeat(host, "tok", "dev", HeartbeatMeta(name = "test"))
        assertTrue(sent)
    }

    @Test
    fun `heartbeat returns false on 5xx`() = runBlocking {
        enqueue("""{"ok":false}""", code = 503)
        val sent = client().heartbeat(host, "tok", "dev", HeartbeatMeta())
        assertFalse(sent)
    }

    @Test
    fun `heartbeat returns false on connection failure instead of throwing`() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val sent = client(timeoutMs = 300L).heartbeat(host, "tok", "dev", HeartbeatMeta())
        assertFalse(sent)
    }

    @Test
    fun `poll parses queued commands`() = runBlocking {
        enqueue(
            """{"ok":true,"serverAt":1789301245064,"commands":[{"commandId":"c-1","kind":"ping","deviceId":"dev","requestId":"r-1","enqueuedAt":1,"expiresAt":2}]}"""
        )
        val polled = client().poll(host, "tok", "dev")
        assertTrue(polled.ok)
        assertEquals(1, polled.commands.size)
        assertEquals("ping", polled.commands[0].kind)
    }

    @Test
    fun `poll throws PhoneCallException on malformed JSON`() = runBlocking {
        enqueue("this is not json")
        val ex = assertThrows(PhoneCallException::class.java) {
            runBlocking { client().poll(host, "tok", "dev") }
        }
        assertTrue(ex.message!!.contains("Malformed JSON"))
    }

    @Test
    fun `poll throws PhoneCallException on non-JSON error page`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>bad gateway</html>"))
        val ex = assertThrows(PhoneCallException::class.java) {
            runBlocking { client().poll(host, "tok", "dev") }
        }
        assertTrue(ex.message!!.contains("HTTP 502"))
    }

    @Test
    fun `poll throws PhoneCallException on connection timeout`() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val ex = assertThrows(PhoneCallException::class.java) {
            runBlocking { client(timeoutMs = 300L).poll(host, "tok", "dev") }
        }
        assertNotNull(ex)
    }

    @Test
    fun `pair surfaces typed ok=false envelope on 401 instead of throwing`() = runBlocking {
        enqueue("""{"ok":false,"error":"bad code"}""", code = 401)
        val response = client().pair(host, "dev", "000000")
        assertFalse(response.ok)
        assertEquals("bad code", response.error)
    }

    @Test
    fun `pair parses a successful credential`() = runBlocking {
        enqueue(
            """{"ok":true,"token":"abc123","device":{"id":"dev","name":"s26-ultra","role":"phone"}}"""
        )
        val response = client().pair(host, "dev", "123456")
        assertTrue(response.ok)
        assertEquals("abc123", response.token)
        assertEquals("s26-ultra", response.device?.name)
    }

    @Test
    fun `ping parses pong and reports a non-negative rtt`() = runBlocking {
        enqueue("""{"ok":true,"pong":true,"serverAt":1789301245064,"deviceId":"dev"}""")
        val (response, rtt) = client().ping(host, "tok", "dev")
        assertTrue(response.ok)
        assertTrue(response.pong)
        assertTrue(rtt >= 0)
    }

    @Test
    fun `status parses the backend view`() = runBlocking {
        enqueue(
            """{"ok":true,"serverAt":1789301245064,"device":{"id":"dev","online":true,"health":"ok","battery":60,"lastHeartbeatAt":1789301245064}}"""
        )
        val response = client().status(host, "tok", "dev")
        assertTrue(response.ok)
        val device = response.device
        assertNotNull(device)
        assertTrue(device!!.online)
        assertEquals(60, device.battery ?: -1)
    }
}