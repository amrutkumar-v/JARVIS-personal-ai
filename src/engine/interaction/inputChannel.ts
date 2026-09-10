/**
 * Phase 2.5 — unified input channels.
 *
 * EVERY input path (text, voice, and a future visual or gesture surface) feeds
 * the SAME AssistantEngine entry point (`process`). This vocabulary exists so
 * the engine and UI can talk about "where did this request come from" without
 * ever branching execution. `gesture` is a RESERVED seam: no gestures are
 * implemented yet, nothing here activates recognition — the phase will supply
 * mappings later, and they will still drive `process`. Phase 2.8 adds
 * `device`, which is REAL: inbound messages from companion phones arrive
 * through the engine exactly like text.
 */

export type InputChannel = 'text' | 'voice' | 'visual' | 'gesture' | 'device'

/** Which channels are genuinely implemented in the repo today. */
export const INPUT_CHANNEL_READY: Record<InputChannel, boolean> = {
  text: true,
  voice: true,
  visual: false,
  gesture: false,
  device: true,
}

/** Resolve a raw channel marker to a safe value (never `undefined`). */
export function normalizeChannel(channel: InputChannel | undefined): InputChannel {
  return channel ?? 'text'
}

/** The capability-resolution interaction mode for a given channel. */
export function channelInteractionMode(channel: InputChannel | undefined): 'text' | 'voice' | 'visual' {
  const c = normalizeChannel(channel)
  if (c === 'voice') return 'voice'
  if (c === 'visual') return 'visual'
  return 'text'
}