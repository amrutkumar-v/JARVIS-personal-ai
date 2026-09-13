/**
 * Phase 10 — real-time hand gesture control.
 *
 * Public barrel for the feature. Everything a caller (engine, store, HUD,
 * tests) needs is reachable through this module — the tracker, recognizer,
 * gate, cooldown, central mapping, executor and types.
 */
export * from './types'
export * from './config'
export * from './landmarks'
export * from './classifier'
export * from './stateMachine'
export * from './cooldown'
export * from './mapping'
export * from './executor'
export * from './tracker'
export * from './controller'