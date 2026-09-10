/** Clip long text to a bounded, safe length with an ellipsis. */
export function clipText(text: string, max: number): string {
  const t = String(text ?? '').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1)}…`
}

/**
 * Tokenize text for lexical matching.
 * Splits on non-word characters, removes trailing 's', filters short tokens.
 */
export function tokenize(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .split(/\W+/u)
    .map((w) => w.replace(/s$/, ''))
    .filter((w) => w.length > 2)
}