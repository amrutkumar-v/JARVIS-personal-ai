/**
 * Server-Sent Events hub for the JARVIS Core backend (Phase 2.8).
 *
 * The backend is the always-on coordinator; any client (the browser
 * assistant, the /phone companion page, tests) subscribes with an SSE
 * `GET /events` stream and receives named events published to the bus. The
 * transport is deliberately dependency-free: named SSE events server→client,
 * JSON POST endpoints client→server.
 */

import type { BackendEvent, BackendEventType } from './types.js'

export interface SseClient {
  id: string
  /** Send one named SSE event to this client (never throws). */
  send(event: BackendEventType, data: unknown): void
}

export class EventBus {
  private readonly clients = new Map<string, SseClient>()

  /** Subscribe a client; returns an unsubscribe function. */
  subscribe(client: SseClient): () => void {
    this.clients.set(client.id, client)
    return () => {
      const current = this.clients.get(client.id)
      if (current === client) this.clients.delete(client.id)
    }
  }

  /** Fan an event out to every connected client. */
  publish(event: BackendEvent): void {
    for (const client of this.clients.values()) {
      try {
        client.send(event.type, event.data)
      } catch {
        // A dead client never kills the bus; the connection layer cleans up.
      }
    }
  }

  clientCount(): number {
    return this.clients.size
  }

  close(): void {
    this.clients.clear()
  }
}