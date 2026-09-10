import type { Tool } from './Tool'
import { toToolDefinition } from './Tool'
import type { ToolDefinition } from '../engine/provider'

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    this.tools.set(tool.id, tool)
  }

  /** Remove a previously registered tool (used by removable bridge surfaces
   * such as the device bridge, so its tools vanish when the backend drops). */
  unregister(id: string): void {
    this.tools.delete(id)
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id)
  }

  all(): Tool[] {
    return [...this.tools.values()]
  }

  ids(): string[] {
    return [...this.tools.keys()]
  }

  /** Provider-ready tool definitions (OpenAI `tools`). */
  definitions(): ToolDefinition[] {
    return this.all().map(toToolDefinition)
  }

  /** First tool whose `canRun` matches the utterance. */
  findForQuery(query: string): Tool | undefined {
    return [...this.tools.values()].find((t) => t.canRun(query))
  }

  get size(): number {
    return this.tools.size
  }
}