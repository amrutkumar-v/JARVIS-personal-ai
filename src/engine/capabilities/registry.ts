import type { CapabilityDefinition } from './types'

/**
 * Phase 2.3 — CapabilityRegistry (bounded, explicit, deterministic).
 *
 * The registry is the single catalogue of model-addressable capabilities. It is
 * BOUNDED: only definitions explicitly registered here can ever be named by a
 * plan, and registration is strictly an admin/engine action — the model has no
 * access path (no API, no payload, no plan step). It performs NO execution and
 * NO mutation of the engine's tool registry.
 *
 * Lookup order is deterministic: `ids()` / `all()` are sorted, so resolution
 * results never depend on internal map iteration.
 */

/** Minimal structural seam so pure/test callers pass a registry-backed object
 * without ever naming the engine's tool registry class. */
export interface CapabilityRegistryLike {
  get(id: string): CapabilityDefinition | undefined
}

export class CapabilityRegistry implements CapabilityRegistryLike {
  private readonly defs = new Map<string, CapabilityDefinition>()

  /** Explicitly register a capability. Duplicates and empty ids are refused so
   * the catalogue stays deterministic and auditable. */
  register(def: CapabilityDefinition): void {
    if (!def || typeof def.id !== 'string' || def.id.trim() === '') {
      throw new Error('CapabilityRegistry: a capability requires a non-empty id.')
    }
    if (this.defs.has(def.id)) {
      throw new Error(`CapabilityRegistry: capability "${def.id}" is already registered.`)
    }
    if (!Array.isArray(def.tools) || def.tools.length === 0) {
      throw new Error(`CapabilityRegistry: capability "${def.id}" must declare at least one implementation tool.`)
    }
    this.defs.set(def.id, {
      ...def,
      tools: [...def.tools],
      contexts: def.contexts ? [...def.contexts] : [],
    })
  }

  get(id: string): CapabilityDefinition | undefined {
    return this.defs.get(id)
  }

  /** Remove a registered capability (used by removable bridge surfaces so the
   * catalogue stops exposing e.g. device capabilities when the backend drops). */
  unregister(id: string): void {
    this.defs.delete(id)
  }

  has(id: string): boolean {
    return this.defs.has(id)
  }

  ids(): string[] {
    return [...this.defs.keys()].sort()
  }

  /** Deterministic catalogue, sorted by capability id. */
  all(): CapabilityDefinition[] {
    return this.ids().map((id) => this.defs.get(id)!)
  }

  get size(): number {
    return this.defs.size
  }
}