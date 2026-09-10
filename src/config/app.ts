/* JARVIS global configuration. */

export const APP = {
  name: 'JARVIS',
  version: '0.9.0',
  phase: 0.9,
  /** Short, candidate-aware wink line. */
  coreLine: 'Good evening, sir.',
} as const

export const CAPABILITIES = {
  aiEnabled: false,
  memoryEnabled: true,
  toolsEnabled: true,
  callingEnabled: false,
  computerControlEnabled: false,
} as const