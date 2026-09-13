/**
 * Phase 2.5 — unified input channels.
 *
 * EVERY input path (text, voice, visual, and device) feeds the SAME
 * AssistantEngine entry point (`process`). This vocabulary exists so the
 * engine and UI can talk about "where did this request come from" without
 * ever branching execution.
 *
 * `gesture` is REAL and implemented (Phase 10): a gesture is classified and
 * routed through the engine's self-action rails (`runSelfAction`), which is
 * the same single executor — never a parallel loop. It intentionally never
 * reaches `process` (a gesture is a UI intent, not a free-text request).
 *
 * `visual` is REAL: camera capture and vision analysis are reached through
 * `process` (camera intents).
 *
 * `device` is REAL: inbound messages from companion phones arrive through
 * the engine exactly like text.
 *
 * `scheduled` is REAL (Phase 11): due reminders fire through `process` with
 * the same single executor, rights, and verification rails as text. Missed
 * runs are caught up honestly (fired once, marked missed) rather than
 * silently dropped.
 */

export type InputChannel = 'text' | 'voice' | 'visual' | 'gesture' | 'device' | 'scheduled'

/** Which channels are genuinely implemented in the repo today. */
export const INPUT_CHANNEL_READY: Record<InputChannel, boolean> = {
  text: true,
  voice: true,
  visual: true,
  gesture: true,
  device: true,
  scheduled: true,
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