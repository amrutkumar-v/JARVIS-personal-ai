/**
 * JARVIS Core — persistent backend identity (Phase 2.8).
 *
 * The backend is the always-on coordinator for everything that can run
 * continuously on the PC: the native agent, the device registry (companion
 * phones/webs), notifications, file transfers, inbound events, structured
 * logs and the health endpoint. It deliberately does NOT host the assistant
 * engine itself, because this project's speech recognition, wake word, TTS
 * and camera surfaces are browser APIs — the engine stays in the browser
 * where those surfaces are real, and reports its runtime state to the
 * backend over `/api/assistant/state`.
 */

export const BACKEND_NAME = 'JARVIS Core'
export const BACKEND_VERSION = '0.9.0'
/** Wire protocol id for the persistent backend HTTP/SSE API. Bumped for the
 * four-device trusted-ecosystem model (claim pairing, trusted ids, targeted
 * notify/file). */
export const BACKEND_PROTOCOL = 'jarvis-backend-2'