import type { Tool, ToolContext, ToolInput, ToolResult, ToolPermission, ToolCategory } from './Tool'

/**
 * Safe arithmetic evaluator — a small shunting-yard parser.
 *
 * No `eval`, no remote code. Supports + - * / % ^ and parentheses, so the
 * AI (or the user) can run arithmetic without ever trusting arbitrary code.
 */

type Token =
  | { type: 'num'; value: number }
  | { type: 'op'; op: string }
  | { type: 'paren'; value: '(' | ')' }

function tokenize(expr: string): Token[] {
  const src = expr.replace(/\s+/g, '')
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/[0-9.]/.test(ch)) {
      const m = src.slice(i).match(/^(?:\d+\.?\d*|\.\d+)/)
      if (!m) throw new Error('invalid number')
      tokens.push({ type: 'num', value: Number(m[0]) })
      i += m[0].length
      continue
    }
    if ('+-*/%^'.includes(ch)) {
      tokens.push({ type: 'op', op: ch })
      i += 1
      continue
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch })
      i += 1
      continue
    }
    throw new Error(`unexpected character "${ch}"`)
  }
  return tokens
}

const PRECEDENCE: Record<string, number> = {
  '^': 4,
  '*': 3,
  '/': 3,
  '%': 3,
  '+': 2,
  '-': 2,
}

function apply(op: string, b: number, a: number): number {
  if (op === '+') return a + b
  if (op === '-') return a - b
  if (op === '*') return a * b
  if (op === '/') {
    if (b === 0) throw new Error('division by zero')
    return a / b
  }
  if (op === '%') return a % b
  if (op === '^') {
    if (!Number.isInteger(b) || Math.abs(b) > 128) throw new Error('exponent out of range')
    return Math.pow(a, b)
  }
  throw new Error(`unknown operator "${op}"`)
}

function evaluate(tokens: Token[]): number {
  const values: number[] = []
  const ops: string[] = []

  const popOp = (): void => {
    const op = ops.pop()
    const b = values.pop()
    const a = values.pop()
    if (op === undefined || a === undefined || b === undefined) {
      throw new Error('malformed expression')
    }
    values.push(apply(op, b, a))
  }

  for (const t of tokens) {
    if (t.type === 'num') {
      values.push(t.value)
      continue
    }
    if (t.type === 'paren') {
      if (t.value === '(') {
        ops.push('(')
        continue
      }
      while (ops.length && ops[ops.length - 1] !== '(') popOp()
      if (!ops.length) throw new Error('unbalanced parentheses')
      ops.pop()
      continue
    }
    const prec = PRECEDENCE[t.op]
    const rightAssoc = t.op === '^'
    while (ops.length) {
      const top = ops[ops.length - 1]
      if (top === '(' || PRECEDENCE[top] === undefined) break
      const higher = rightAssoc ? PRECEDENCE[top] > prec : PRECEDENCE[top] >= prec
      if (!higher) break
      popOp()
    }
    ops.push(t.op)
  }
  while (ops.length) {
    if (ops[ops.length - 1] === '(') throw new Error('unbalanced parentheses')
    popOp()
  }

  const result = values[0]
  if (result === undefined) throw new Error('empty expression')
  if (!Number.isFinite(result)) throw new Error('result is not finite (overflow or division by zero)')
  return result
}

function formatResult(value: number): string {
  if (Number.isInteger(value)) return String(value)
  const rounded = Number(value.toPrecision(12))
  if (Number.isInteger(rounded)) return String(rounded)
  return String(rounded)
}

/** Pull the most likely arithmetic expression out of a sentence. */
function extractExpression(query: string): string | null {
  const normalized = query
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/\bplus\b/gi, '+')
    .replace(/\bminus\b/gi, '-')
    .replace(/\btimes\b/gi, '*')
    .replace(/\bdivided by\b/gi, '/')
    .replace(/\b([\d.]+)\s*(?:x)\s*([\d.]+)\b/gi, '$1*$2')
    .replace(/[=?]+/g, '')
  const matches = normalized.match(/(?:[\d.()]+\s*[-+*/%^]\s*)+[\d.()]+/g)
  if (!matches || !matches.length) return null
  return matches.reduce((best, m) => (m.length > best.length ? m : best), '').replace(/\s+/g, '')
}

export class CalculatorTool implements Tool {
  readonly id = 'calculator'
  readonly category: ToolCategory = 'compute'
  readonly name = 'Calculator'
  readonly description =
    'Evaluates a safe arithmetic expression. Pass the expression to compute: + - * / % ^ and parentheses are supported.'
  readonly permission: ToolPermission = 'low_risk'
  readonly requiresPermission = false
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      expression: {
        type: 'string',
        description: 'The arithmetic expression to evaluate, e.g. "123 * 48" or "(2+3)^2". When omitted, the tool extracts the expression from your message.',
      },
    },
    required: [],
  }

  canRun(query: string): boolean {
    return (
      /(?:\d\s*[-+*/^%]\s*\d)/.test(query) ||
      /^(?:calculate|compute)\b/i.test(query) ||
      /\b(?:add|multiply|subtract|divide)\b/i.test(query)
    )
  }

  async execute(input: ToolInput, _ctx: ToolContext): Promise<ToolResult> {
    const raw =
      typeof input.params.expression === 'string' && input.params.expression.trim()
        ? input.params.expression
        : extractExpression(input.query)
    if (!raw) {
      return { ok: false, message: 'I could not find a calculation to perform.' }
    }

    const expr = raw.replace(/[=?]+/g, '').trim()
    try {
      const tokens = tokenize(expr)
      if (!tokens.some((t) => t.type === 'op')) {
        return { ok: false, message: 'That did not look like an arithmetic expression.' }
      }
      const value = evaluate(tokens)
      return {
        ok: true,
        message: `${expr} = ${formatResult(value)}`,
        data: { expression: expr, result: value },
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : 'unknown error'
      return { ok: false, message: `That calculation did not work (${why}).` }
    }
  }
}