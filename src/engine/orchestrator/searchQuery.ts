/**
 * Search-query hygiene — separates the SEARCH TERMS from the answer requirement.
 *
 * A user request is rarely just a query: it carries politeness ("please"), the
 * search verb itself ("search for"), and often an explicit instruction about
 * what to DO with the result ("…, then tell me the version", "… and let me
 * know", "… so I can decide"). Only the first part is a search query; sending
 * the rest to a search engine produces worse results and reveals that JARVIS
 * forwarded the raw sentence instead of understanding it.
 *
 * This module is:
 *
 *  - pure and deterministic — no LLM, no context, no network;
 *  - bounded — the result is clipped to `SEARCH_QUERY_MAX_CHARS`, which is also
 *    the web tool's schema limit, so a cleaned query can never be rejected;
 *  - conservative — it only removes well-known leading noise and trailing
 *    ANSWER-REQUIREMENT clauses (a reporting/analysis verb after a conjunction
 *    or comma, a "so I can …" purpose clause, an "and if …" condition). A
 *    query that does not match any of those is returned unchanged apart from
 *    whitespace and edge punctuation, so nothing meaningful is dropped.
 *
 * It is applied in TWO places, deliberately:
 *
 *  1. the deterministic planner, when it derives a `web_search` step from free
 *     text (`extractSearchQuery`), and
 *  2. the `web.search` tool executor, as a backstop for a query the MODEL
 *     produced inside a structured plan — the model is trusted with the plan
 *     shape only, never with the quality of the payload.
 */

/** Mirrors the `web.search` input schema cap (`MAX_QUERY_LEN`). */
export const SEARCH_QUERY_MAX_CHARS = 200

/** Leading address/politeness noise that is never part of a query.
 *
 * NOTE the vocative form: a bare leading "jarvis" is only removed when it is
 * actually used as an address (followed by a comma/colon), because it is also
 * a legitimate search term ("JARVIS AI", "jarvis project docs"). "hey/ok/hi/
 * hello jarvis" is unambiguous and safe to strip. */
const LEAD_NOISE =
  /^(?:(?:hey|ok|okay|hi|hello)\s+jarvis\s*[,:]?\s*|jarvis\s*[,:]\s*|please\s+|kindly\s+|can you\s+|could you\s+|would you\s+|i want you to\s+|i would like you to\s+|i'd like you to\s+|go ahead and\s+)+/i

/** A leading search verb ("search for", "look up", "google", "find me"). */
const LEAD_SEARCH_VERB =
  /^(?:please\s+)?(?:search(?:\s+(?:on\s+)?the\s+(?:web|internet|browser))?(?:\s+(?:for|about))?\s+|look\s+up\s+|google\s+|bing\s+|duckduckgo\s+|find\s+(?:me\s+)?|find\s+out\s+)/i

/** Reporting verbs that need an object pronoun to be an instruction ("tell ME"). */
const REPORT_TO_PRONOUN_SRC =
  'tell|tells?|let|show|give|send|notify|answer|inform|remind|read'

/** Answer-shaping verbs unlikely to be search terms after a conjunction. */
const ANSWER_VERB_SRC =
  'summari[sz]e|explain|describe|compare|answer|categorize|categorise|rank|condense'

/** Any reporting verb, used ONLY after an explicit "then" follow-up marker. */
const ANY_REPORT_VERB_SRC =
  `${REPORT_TO_PRONOUN_SRC}|${ANSWER_VERB_SRC}|report|state|confirm|verify|check|analy[sz]e|decide|recommend|choose|pick|say|write|list|do|run|open|launch|start|install|download|save|copy|create|make|set|go`

/**
 * Trailing instructions about what to do with the result, not what to find.
 *
 * Deliberately narrow where the verb is ambiguous: "and check version" is a
 * plausible part of a real query ("how to install node and check version"), so
 * `check`/`verify`/`analyze` are only treated as a follow-up AFTER an explicit
 * "then". Pronoun forms ("and tell ME") are unambiguous and cut anywhere.
 */
const TAIL_PATTERNS: readonly RegExp[] = [
  // "… and tell me …" / "… but show me …" / "… and let us know …"
  new RegExp(`[\\s,]*\\b(?:and|but)\\s+(?:also\\s+)?(?:then\\s+)?(?:please\\s+)?(?:${REPORT_TO_PRONOUN_SRC})\\s+(?:me|us)\\b[\\s\\S]*$`, 'i'),
  // "…, then tell me the version" / "…, then check …" (explicit follow-up)
  new RegExp(`[\\s,;]*\\bthen\\s+(?:please\\s+)?(?:${ANY_REPORT_VERB_SRC})\\b[\\s\\S]*$`, 'i'),
  // "… and summarize …" / "… and explain …" (answer-shaping, no pronoun)
  new RegExp(`[\\s,]*\\b(?:and|but)\\s+(?:also\\s+)?(?:then\\s+)?(?:please\\s+)?(?:${ANSWER_VERB_SRC})\\b[\\s\\S]*$`, 'i'),
  // "…, tell me the version" (imperative after a comma, no conjunction)
  new RegExp(`\\s*,\\s*(?:then\\s+)?(?:please\\s+)?(?:${REPORT_TO_PRONOUN_SRC})\\s+(?:me|us)\\b[\\s\\S]*$`, 'i'),
  // "… so I can decide" / "so that I know"
  /\s+so\s+(?:that\s+)?(?:i|we)\b[\s\S]*$/i,
  // "… and if it is below 20%, notify me" (conditional follow-up work)
  /\s+\band\s+if\b[\s\S]*$/i,
]

/** Trailing tool chatter that is not a search term. */
const TRAIL_NOISE =
  /\s+(?:in|on|via|through|using)\s+(?:the\s+)?(?:browser|web|internet|google|bing|duckduckgo|search\s+engine)\s*$/i

/** Edge punctuation/quoting produced by cutting a clause. */
const EDGE_NOISE = /^[\s,;:."'\u201c\u201d\u2018\u2019?]+|[\s,;:."'\u201c\u201d\u2018\u2019]+$/g

/**
 * Reduce free text (or a model-supplied payload) to just the search terms.
 * Returns '' when nothing usable remains — callers must treat that as an
 * invalid query rather than searching for the raw sentence.
 */
export function cleanSearchQuery(raw: string): string {
  let q = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (q.length === 0) return ''

  q = q.replace(LEAD_NOISE, '')
  q = q.replace(LEAD_SEARCH_VERB, '')

  for (const pattern of TAIL_PATTERNS) {
    q = q.replace(pattern, '')
  }

  q = q.replace(TRAIL_NOISE, '')
  q = q.replace(EDGE_NOISE, '').trim()

  // A cut that removed everything is a failure, not an empty query: keep the
  // original text (still cleaned of politeness) so the user still gets a search.
  if (q.length === 0) {
    q = (raw ?? '')
      .replace(/\s+/g, ' ')
      .replace(LEAD_NOISE, '')
      .replace(EDGE_NOISE, '')
      .trim()
  }

  return q.slice(0, SEARCH_QUERY_MAX_CHARS).trim()
}
