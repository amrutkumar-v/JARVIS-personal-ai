import type { AIProvider, AIRequest, AIResponse, AIMessage } from '../provider'
import type { EngineOutMessage } from '../contracts'
import { ToolRegistry, ClockTool, CalculatorTool, NotesTool, SystemInfoTool } from '../../tools'
import type { Tool } from '../../tools'

/**
 * Local mock provider — a clearly-labelled DEV provider.
 *
 * NOT a real LLM. It is a *planner*: it emits structured `toolRequests` and
 * lets the engine execute them through the registry, then composes the final
 * answer from the tool result the engine feeds back. This exercises the same
 * two-phase tool-calling loop a real model uses, so the voice, conversation,
 * state and permission pipeline is testable end to end offline.
 *
 * Phase 0.4 adds multi-step planning:
 *   "calculate X and remember it"  → calculator → notes save
 *   "what time is it and save it"  → clock → notes save
 * Tool failures are acknowledged in the final answer.
 */

interface Pending {
  tool: Tool
  payload: Record<string, unknown>
}

export class ApiProvider implements AIProvider {
  readonly id = 'mock'
  readonly label = 'Local lab (dev)'

  private registry = new ToolRegistry()
  private greeted = false

  constructor() {
    this.registry.register(new ClockTool())
    this.registry.register(new CalculatorTool())
    this.registry.register(new NotesTool())
    this.registry.register(new SystemInfoTool())
  }

  isConfigured(): boolean {
    return true
  }

  async isReachable(): Promise<boolean> {
    return true
  }

  describe() {
    return { model: 'rule-based dev model (no network)' }
  }

  async generate(request: AIRequest, emit: (m: EngineOutMessage) => void): Promise<AIResponse> {
    if (!this.greeted) {
      this.greeted = true
      emit({ type: 'notice', kind: 'info', text: 'Mock provider — no real AI connected yet.' })
    }

    // Check if there's a tool result from the previous round
    const lastToolResult = this.lastToolResult(request.messages)
    if (lastToolResult) {
      // Round 2+: we have a tool result — decide what to do next
      const next = this.decideNext(request.prompt, request.messages, lastToolResult)
      if (next) {
        return { text: '', toolRequests: [{ toolId: next.tool.id, payload: next.payload }] }
      }
      // No further tools — compose final answer from the tool result
      return { text: this.composeFromResult(request.prompt, lastToolResult, request.messages) }
    }

    // Round 1: plan the first tool call, or fall back to canned chat
    const pending = this.decideFirst(request.prompt)
    if (pending) {
      return { text: '', toolRequests: [{ toolId: pending.tool.id, payload: pending.payload }] }
    }
    return { text: this.canned(request.prompt) }
  }

  /** Most recent `tool` role message the engine pushed back. */
  private lastToolResult(messages: AIMessage[]): { content: string; toolId?: string } | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]
      if (m.role === 'tool') return { content: m.content, toolId: m.toolId }
    }
    return null
  }

  /* ------------------------------------------------ multi-step planning */

  /** Round 2+: decide what to do with the tool result we just got. */
  private decideNext(
    prompt: string,
    _messages: AIMessage[],
    last: { content: string; toolId?: string },
  ): Pending | null {
    const q = prompt.toLowerCase()
    const isMemorize =
      /\b(remember|save|store|keep)\b/i.test(q) ||
      /\b(my|the)\b.*\b(budget|project|result|time)\b/i.test(q)

    const toolId = last.toolId

    // If the last tool was calculator and user wanted to remember the result
    if (toolId === 'calculator' && isMemorize) {
      // Extract the computed value from the calculator result
      const match = last.content.match(/=\s*(-?[\d.]+)/)
      const value = match ? match[1] : 'the result'
      // Extract what to call it (e.g., "my project budget")
      const labelMatch = prompt.match(/as\s+(?:my\s+)?(.+)$/i) || prompt.match(/remember\s+(?:that\s+)?(.+)$/i)
      const label = labelMatch ? labelMatch[1].trim() : 'the result'
      const text = `My ${label} is ${value}`
      const notes = this.registry.get('notes') as Tool
      return { tool: notes, payload: { action: 'save', text } }
    }

    // If the last tool was clock and user wanted to save the time
    if (toolId === 'clock' && isMemorize) {
      const timeMatch = last.content.match(/The local time is (.+)\./)
      const timeStr = timeMatch ? timeMatch[1] : last.content
      const labelMatch = prompt.match(/as\s+(?:my\s+)?(.+)$/i) || prompt.match(/remember\s+(?:that\s+)?(.+)$/i)
      const label = labelMatch ? labelMatch[1].trim() : 'the current time'
      const text = `The time is ${timeStr} (saved as ${label})`
      const notes = this.registry.get('notes') as Tool
      return { tool: notes, payload: { action: 'save', text } }
    }

    // If the last tool failed (e.g., division by zero), don't chain further
    if (last.content.toLowerCase().includes('did not work') || last.content.toLowerCase().includes('failed')) {
      return null
    }

    return null
  }

  /** Round 1: plan the first tool call from the user prompt. */
  private decideFirst(prompt: string): Pending | null {
    const q = prompt.toLowerCase()
    const raw = prompt.trim()

    // Detect "calculate X and remember/save" intent
    const calcMatch = raw.match(/(?:calculate|compute|what is|add|multiply|subtract|divide)\b.+/i)
    const hasMemorize = /\b(remember|save|store|keep)\b/i.test(q) || /\b(my|the)\b.*\b(budget|project|result)\b/i.test(q)

    if (calcMatch && hasMemorize) {
      // Extract the arithmetic expression
      const expr = this.extractArithmetic(raw)
      if (expr) {
        return { tool: this.registry.get('calculator') as Tool, payload: { expression: expr } }
      }
    }

    // Detect "what time is it and save/remember"
    if (/\b(what time|current time)\b/i.test(q) && hasMemorize) {
      return { tool: this.registry.get('clock') as Tool, payload: {} }
    }

    // Memory operations (remember, recall, forget, list, clear)
    const notesIntent =
      /\b(remember|recall|forget)\b/i.test(q) ||
      /\bwhat (do you remember|did (you|i))|what (is|are) my|what do you know|tell me what\b/i.test(q) ||
      /\b(clear|wipe|erase|delete|list|show)\b.*\bmemor/i.test(q) ||
      /\bhow many memor/i.test(q)
    if (notesIntent) {
      return this.decideMemory(q, raw, this.registry.get('notes') as Tool)
    }

    // Calculator - backward compat: empty payload for simple queries
    if (this.registry.get('calculator')?.canRun(raw)) {
      const isMultiStep = calcMatch && hasMemorize
      return { tool: this.registry.get('calculator') as Tool, payload: isMultiStep ? { expression: this.extractArithmetic(raw) } : {} }
    }

    // Clock
    if (this.registry.get('clock')?.canRun(raw)) {
      return { tool: this.registry.get('clock') as Tool, payload: {} }
    }

    // System info
    if (this.registry.get('system_info')?.canRun(raw)) {
      return { tool: this.registry.get('system_info') as Tool, payload: {} }
    }

    return null
  }

  private decideMemory(q: string, raw: string, notes: Tool): Pending {
    const isClearAll =
      /\b(clear|wipe|erase|delete)\b.*\b(memories|memory|everything|all)\b/i.test(q) ||
      /\bforget everything\b|\bforget it all\b/i.test(q)
    const isForget = /\bforget\b/.test(q)
    const isList = /(list|show)\b.*\bmemor|\bhow many memor\b|\bwhat do you remember\b/i.test(q)
    const isRecall = /recall|do you remember|did you write down|what did (you|i)\b/i.test(q) ||
      /\bwhat (is|are) my\b/.test(q) ||
      /\b(what do you know|tell me what)\b/.test(q)

    if (isClearAll) return { tool: notes, payload: { action: 'clear' } }
    if (isForget) return { tool: notes, payload: { action: 'forget', query: raw.replace(/^forget\s+/i, '').trim() } }
    if (isList) return { tool: notes, payload: { action: 'list' } }
    if (isRecall) return { tool: notes, payload: { action: 'recall', query: raw } }
    const fact = raw.replace(/^remember\s+(?:that\s+)?/i, '').trim()
    return { tool: notes, payload: { action: 'save', text: fact || raw } }
  }

  private extractArithmetic(text: string): string {
    const normalized = text
      .replace(/×/g, '*')
      .replace(/÷/g, '/')
      .replace(/\bplus\b/gi, '+')
      .replace(/\bminus\b/gi, '-')
      .replace(/\btimes\b/gi, '*')
      .replace(/\bdivided by\b/gi, '/')
      .replace(/\b([\d.]+)\s*(?:x)\s*([\d.]+)\b/gi, '$1*$2')
      .replace(/[=?]+/g, '')
    const matches = normalized.match(/(?:[\d.()]+\s*[-+*/%^]\s*)+[\d.()]+/g)
    if (!matches || !matches.length) return ''
    return matches.reduce((best, m) => (m.length > best.length ? m : best), '').replace(/\s+/g, '')
  }

  /** Compose a natural final answer from a tool result. */
  private composeFromResult(
    _prompt: string,
    last: { content: string; toolId?: string },
    _messages: AIMessage[],
  ): string {
    const toolId = last.toolId

    // Calculator result
    if (toolId === 'calculator') {
      if (last.content.toLowerCase().includes('did not work') || last.content.toLowerCase().includes('failed')) {
        return `That calculation failed: ${last.content}.`
      }
      // If the user also wanted to remember, the next round would have handled it
      return `The answer is ${last.content}.`
    }

    // Clock result - preserve original format for backward compat
    if (toolId === 'clock') {
      const timePart = last.content.replace('The local time is ', '').replace(/\.$/, '')
      return `The local time is ${timePart}.`
    }

    // Memory/notes result
    if (toolId === 'notes') {
      return last.content
    }

    // System info
    if (toolId === 'system_info') {
      return last.content
    }

    return last.content
  }

  /* ------------------------------------------------ canned chat */
  private greetedOnce = false
  private canned(prompt: string): string {
    const q = prompt.toLowerCase()
    if (/\b(hi|hello|hey)\b/.test(q) && !this.greetedOnce) {
      this.greetedOnce = true
      return 'Hello. I am ready — what can I do for you?'
    }
    if (/who are you|what are you|your name/.test(q)) {
      return 'I am JARVIS — a personal assistant. Right now I am running in dev mode with local tools only, because no AI model is connected.'
    }
    if (/status|what can you do|help|capabilities/.test(q)) {
      return 'I am in local-dev mode, so the local tools I can use right now are the clock, calculations, memory/notes and system info. Ask me for one of those.'
    }
    return 'Right now this is local-dev mode with a development provider, so the only things I can actually do are the built-in local tools: the clock, calculations, memory/notes and system info. No real AI model is connected, so I cannot compose a fresh answer for that request — if you rephrase toward one of those tools, I will try again.'
  }
}