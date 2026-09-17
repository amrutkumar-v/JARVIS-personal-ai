import { describe, expect, it } from 'vitest'
import { SEARCH_QUERY_MAX_CHARS, cleanSearchQuery } from './searchQuery'
import { extractSearchQuery } from './planner'

/**
 * Search-query hygiene — the search engine must only ever receive SEARCH TERMS.
 *
 * The live bug these tests pin: "Open Chrome, search for the latest NVIDIA
 * driver version, then tell me the version" was sent to the web provider with
 * the conversational instruction still attached — the answer requirement
 * ("then tell me the version") leaked into the query string.
 */
describe('cleanSearchQuery', () => {
  it('drops a trailing answer-requirement clause (the live regression)', () => {
    expect(cleanSearchQuery('the latest NVIDIA driver version, then tell me the version')).toBe(
      'the latest NVIDIA driver version',
    )
    expect(cleanSearchQuery('nvidia driver version then tell me the version')).toBe('nvidia driver version')
    expect(cleanSearchQuery('nvidia driver version and tell me the version')).toBe('nvidia driver version')
    expect(cleanSearchQuery('nvidia driver version, and then let me know')).toBe('nvidia driver version')
  })

  it('drops purpose and conditional clauses', () => {
    expect(cleanSearchQuery('ryzen 9000 benchmarks so I can decide')).toBe('ryzen 9000 benchmarks')
    expect(cleanSearchQuery('phone battery health and if it is below 20% tell me')).toBe('phone battery health')
  })

  it('drops politeness and the search verb itself', () => {
    expect(cleanSearchQuery('please search for the weather in Hubli')).toBe('the weather in Hubli')
    expect(cleanSearchQuery('can you look up TypeScript 6 release notes')).toBe('TypeScript 6 release notes')
    expect(cleanSearchQuery('Jarvis, google the KLE Tech admission dates')).toBe('the KLE Tech admission dates')
  })

  it('leaves a genuine query untouched', () => {
    expect(cleanSearchQuery('cats and dogs')).toBe('cats and dogs')
    expect(cleanSearchQuery('nvidia and amd gpu comparison')).toBe('nvidia and amd gpu comparison')
    expect(cleanSearchQuery('how to install node and check version')).toBe('how to install node and check version')
    // "jarvis" is a legitimate search term when it is not a vocative.
    expect(cleanSearchQuery('JARVIS AI architecture')).toBe('JARVIS AI architecture')
  })

  it('is bounded to the web tool schema limit', () => {
    const long = 'a'.repeat(SEARCH_QUERY_MAX_CHARS + 50)
    expect(cleanSearchQuery(long)).toHaveLength(SEARCH_QUERY_MAX_CHARS)
  })

  it('never returns an empty query when the input had content', () => {
    expect(cleanSearchQuery('   ')).toBe('')
    expect(cleanSearchQuery('then tell me the version')).not.toBe('')
  })
})

describe('extractSearchQuery — planner extraction is always cleaned', () => {
  it('extracts only the terms from the mission example', () => {
    expect(
      extractSearchQuery('Open Chrome, search for the latest NVIDIA driver version, then tell me the version'),
    ).toBe('the latest NVIDIA driver version')
  })

  it('keeps existing quoted/plain extraction behaviour', () => {
    expect(extractSearchQuery('search for "KLE Technology University"')).toBe('KLE Technology University')
    expect(extractSearchQuery('open browser and search for TypeScript docs')).toBe('TypeScript docs')
    expect(extractSearchQuery('find documentation')).toBe('documentation')
  })

  it('does not leak an answer requirement from the tail of a mixed flow', () => {
    const query = extractSearchQuery(
      'open notepad, type "Hello", copy it, and search for "JARVIS AI" in the browser',
    )
    expect(query).toBe('JARVIS AI')
    expect(query).not.toContain('then')
  })
})
