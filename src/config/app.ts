/* JARVIS global configuration. */

export const APP = {
  name: 'JARVIS',
  version: '0.10.0',
  phase: 0.1, // 0.10 — real Android calling (agents read the version string)
  /** Short, candidate-aware wink line. */
  coreLine: 'Good evening, sir.',
} as const