import type { Phase6ContextInput } from './planTypes'

export type ContextValue =
  | string
  | number
  | boolean
  | null
  | ContextValue[]
  | { [key: string]: ContextValue }

export interface ExecutionContextSnapshot {
  [stepIndex: number]: ContextValue
}

const MAX_DEPTH = 6
const MAX_SIZE = 512

export function isSafeContextValue(value: unknown, depth = 0): value is ContextValue {
  if (value === null) return true
  if (depth > MAX_DEPTH) return false
  const t = typeof value
  if (t === 'string') return (value as string).length <= MAX_SIZE
  if (t === 'number') return Number.isFinite(value)
  if (t === 'boolean') return true
  if (Array.isArray(value)) {
    return value.every((v) => isSafeContextValue(v, depth + 1))
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    if (Object.prototype.hasOwnProperty.call(obj, 'toJSON')) {
      const safe = typeof (obj as { toJSON?: unknown }).toJSON === 'function'
      if (safe) return false
    }
    const entries = Object.entries(obj)
    if (entries.length > MAX_SIZE) return false
    return entries.every(([, v]) => isSafeContextValue(v, depth + 1))
  }
  return false
}

export function readPath(value: ContextValue | undefined, path?: string): ContextValue | undefined {
  if (!path) return value
  const segments = path.split('.').filter(Boolean)
  let current: ContextValue | undefined = value
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined
    }
    current = current[segment]
  }
  return current
}

export class ExecutionContext {
  private readonly values = new Map<number, ContextValue>()

  record(stepIndex: number, value: unknown): boolean {
    if (!Number.isInteger(stepIndex) || stepIndex < 0) return false
    if (!isSafeContextValue(value)) return false
    this.values.set(stepIndex, value)
    return true
  }

  read(stepIndex: number, path?: string): ContextValue | undefined {
    if (!Number.isInteger(stepIndex)) return undefined
    return readPath(this.values.get(stepIndex), path)
  }

  has(stepIndex: number): boolean {
    return Number.isInteger(stepIndex) && this.values.has(stepIndex)
  }

  resolveInputs(
    inputs: Phase6ContextInput[] | undefined,
  ): Record<string, unknown> | undefined {
    if (!inputs || inputs.length === 0) return undefined
    const resolved: Record<string, unknown> = {}
    for (const input of inputs) {
      const value = this.read(input.fromStep, input.path)
      if (value === undefined) continue
      resolved[input.name] = value
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined
  }

  snapshot(): ExecutionContextSnapshot {
    const out: ExecutionContextSnapshot = {}
    for (const [index, value] of this.values) {
      out[index] = structuredCloneSafe(value)
    }
    return out
  }

  clear(): void {
    this.values.clear()
  }
}

function structuredCloneSafe(value: ContextValue): ContextValue {
  return JSON.parse(JSON.stringify(value)) as ContextValue
}