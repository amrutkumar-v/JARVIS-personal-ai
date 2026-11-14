/**
 * Streaming TTS Chunk Synthesizer (Phase 6)
 *
 * Buffers streamed LLM response tokens/chunks and synthesizes sentences
 * in FIFO sequence as soon as sentence boundaries are detected, reducing
 * perceived latency from multi-paragraph generation to zero.
 *
 * Supports immediate cancellation / barge-in.
 */

import type { TextToSpeechProvider } from './ttsProvider'

export interface StreamingTtsOptions {
  tts: TextToSpeechProvider
  onSentenceStart?: (sentence: string) => void
  onSentenceEnd?: (sentence: string) => void
  onComplete?: () => void
  volume?: number
}

export class StreamingTts {
  private readonly tts: TextToSpeechProvider
  private readonly options: StreamingTtsOptions
  private buffer = ''
  private queue: string[] = []
  private activeSpeaking = false
  private finishedReceiving = false
  private cancelled = false

  constructor(options: StreamingTtsOptions) {
    this.tts = options.tts
    this.options = options
  }

  get isSpeaking(): boolean {
    return this.activeSpeaking || this.queue.length > 0
  }

  get pendingSentences(): number {
    return this.queue.length
  }

  /**
   * Push an incoming text chunk (e.g. from an LLM token stream).
   */
  pushChunk(chunk: string): void {
    if (this.cancelled) return
    this.buffer += chunk
    this.extractSentences()
  }

  /**
   * Indicate that the incoming token stream has ended.
   */
  finish(): void {
    if (this.cancelled) return
    this.finishedReceiving = true
    const remaining = this.buffer.trim()
    if (remaining) {
      this.queue.push(remaining)
      this.buffer = ''
    }
    this.pumpQueue()
  }

  /**
   * Immediately cancel any pending queue and halt speech (barge-in).
   */
  cancel(): void {
    this.cancelled = true
    this.queue = []
    this.buffer = ''
    this.activeSpeaking = false
    this.tts.stop()
  }

  private extractSentences(): void {
    // Regex matching sentence terminators followed by whitespace or newline
    const sentenceRegex = /([.?!:]+[\s\n]+|[\n\r]{2,})/
    let match: RegExpMatchArray | null

    while ((match = sentenceRegex.exec(this.buffer)) !== null) {
      const splitIdx = match.index! + match[0].length
      const sentence = this.buffer.slice(0, splitIdx).trim()
      this.buffer = this.buffer.slice(splitIdx)
      if (sentence) {
        this.queue.push(sentence)
      }
    }

    this.pumpQueue()
  }

  private pumpQueue(): void {
    if (this.activeSpeaking || this.queue.length === 0 || this.cancelled) {
      if (!this.activeSpeaking && this.queue.length === 0 && this.finishedReceiving) {
        this.options.onComplete?.()
      }
      return
    }

    const nextSentence = this.queue.shift()!
    this.activeSpeaking = true
    this.options.onSentenceStart?.(nextSentence)

    this.tts.speak(nextSentence, {
      volume: this.options.volume ?? 1,
      onDone: (ok) => {
        this.activeSpeaking = false
        this.options.onSentenceEnd?.(nextSentence)
        if (!ok || this.cancelled) {
          // Interrupted
          return
        }
        this.pumpQueue()
      },
    })
  }
}

