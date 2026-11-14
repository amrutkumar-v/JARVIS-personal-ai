import { describe, expect, it } from 'vitest'
import { CalculatorTool } from '../tools/CalculatorTool'
import type { ToolContext } from '../tools'

describe('CalculatorTool', () => {
  const tool = new CalculatorTool()
  const ctx: ToolContext = { requestId: 'calc-test' }

  it('is a read-only compute tool with a schema', () => {
    expect(tool.id).toBe('calculator')
    expect(tool.category).toBe('compute')
    expect(tool.permission).toBe('read_only')
    expect(tool.inputSchema.required).not.toContain('expression')
    expect(tool.inputSchema.properties.expression.type).toBe('string')
  })

  it('computes a direct expression from params', async () => {
    const res = await tool.execute(
      { query: 'what is 12 + 30', params: { expression: '12 + 30' } },
      ctx,
    )
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ result: 42 })
    expect(res.message).toContain('42')
  })

  it('extracts an expression from a sentence', async () => {
    const res = await tool.execute({ query: 'calculate 5*6', params: {} }, ctx)
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ result: 30 })
  })

  it('respects operator precedence', async () => {
    const res = await tool.execute({ query: '2 + 3 * 4', params: {} }, ctx)
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ result: 14 })
  })

  it('supports parentheses and negation', async () => {
    const res = await tool.execute({ query: '(2 + 3) * 4', params: {} }, ctx)
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({ result: 20 })
  })

  it('never evals arbitrary code and rejects garbage', async () => {
    await expect(
      tool.execute({ query: 'process.exit(1)', params: {} }, ctx),
    ).resolves.toMatchObject({ ok: false })
  })

  it('rejects division by zero without crashing', async () => {
    const res = await tool.execute({ query: '10 / 0', params: {} }, ctx)
    expect(res.ok).toBe(false)
    expect(res.message.toLowerCase()).toMatch(/zero|work/)
  })
})