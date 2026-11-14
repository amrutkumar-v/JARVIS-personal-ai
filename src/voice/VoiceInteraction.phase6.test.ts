import { describe, expect, it, vi } from 'vitest'
import { StreamingTts } from './StreamingTts'
import { AudioCues } from './AudioCues'
import { VoiceManager } from './voiceManager'
import { FakeSpeechToTextProvider, FakeTextToSpeechProvider, FakeWakeWordProvider } from './testing'

describe('Phase 6 — Voice-First Interaction', () => {
  describe('StreamingTts', () => {
    it('buffers incoming tokens and speaks sentences sequentially as boundaries arrive', () => {
      const fakeTts = new FakeTextToSpeechProvider()
      const spokenSentences: string[] = []
      const completedSentences: string[] = []
      let completeFired = false

      const streaming = new StreamingTts({
        tts: fakeTts,
        onSentenceStart: (s) => spokenSentences.push(s),
        onSentenceEnd: (s) => completedSentences.push(s),
        onComplete: () => {
          completeFired = true
        },
      })

      // Push tokens for sentence 1
      streaming.pushChunk('Good ')
      streaming.pushChunk('morning. ')
      expect(spokenSentences).toEqual(['Good morning.'])
      expect(streaming.isSpeaking).toBe(true)

      // Sentence 1 completes
      fakeTts.finishLast()
      expect(completedSentences).toEqual(['Good morning.'])

      // Push sentence 2 across chunks
      streaming.pushChunk('I found ')
      streaming.pushChunk('three files! ')
      expect(spokenSentences).toEqual(['Good morning.', 'I found three files!'])

      fakeTts.finishLast()
      expect(completedSentences).toEqual(['Good morning.', 'I found three files!'])

      // Push trailing text without terminator, then finish()
      streaming.pushChunk('All tasks completed successfully')
      streaming.finish()

      expect(spokenSentences).toEqual([
        'Good morning.',
        'I found three files!',
        'All tasks completed successfully',
      ])

      fakeTts.finishLast()
      expect(completeFired).toBe(true)
      expect(streaming.isSpeaking).toBe(false)
    })

    it('cancels immediately on barge-in / cancellation', () => {
      const fakeTts = new FakeTextToSpeechProvider()
      const spokenSentences: string[] = []

      const streaming = new StreamingTts({
        tts: fakeTts,
        onSentenceStart: (s) => spokenSentences.push(s),
      })

      streaming.pushChunk('Sentence one. Sentence two. Sentence three. ')
      expect(spokenSentences).toEqual(['Sentence one.'])
      expect(streaming.pendingSentences).toBe(2)

      // Barge-in: user cancels
      streaming.cancel()

      expect(fakeTts.stopCalls).toBe(1)
      expect(streaming.pendingSentences).toBe(0)
      expect(streaming.isSpeaking).toBe(false)

      // Further chunks after cancel are ignored
      streaming.pushChunk('Sentence four.')
      expect(spokenSentences).toEqual(['Sentence one.'])
    })
  })

  describe('AudioCues', () => {
    it('runs safely in headless / non-audio environment without throwing', () => {
      const cues = new AudioCues({ context: null })
      expect(cues.isSupported).toBe(false)

      // None of these should throw
      expect(() => cues.play('wake')).not.toThrow()
      expect(() => cues.play('recognize')).not.toThrow()
      expect(() => cues.play('complete')).not.toThrow()
      expect(() => cues.play('error')).not.toThrow()
      expect(() => cues.play('interrupt')).not.toThrow()
    })

    it('synthesizes procedural tones with AudioContext when provided', () => {
      const createdOscillators: any[] = []
      const createdGains: any[] = []

      const mockCtx: any = {
        state: 'running',
        currentTime: 10.0,
        destination: {},
        createOscillator: () => {
          const osc = {
            type: 'sine',
            frequency: { setValueAtTime: vi.fn() },
            connect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
          }
          createdOscillators.push(osc)
          return osc
        },
        createGain: () => {
          const gain = {
            gain: {
              setValueAtTime: vi.fn(),
              linearRampToValueAtTime: vi.fn(),
              exponentialRampToValueAtTime: vi.fn(),
            },
            connect: vi.fn(),
          }
          createdGains.push(gain)
          return gain
        },
      }

      const cues = new AudioCues({ context: mockCtx, volume: 0.5 })
      expect(cues.isSupported).toBe(true)

      cues.play('wake')
      // Arpeggio creates 3 tones
      expect(createdOscillators.length).toBe(3)
      expect(createdGains.length).toBe(3)

      cues.play('recognize')
      expect(createdOscillators.length).toBe(4)

      cues.play('complete')
      expect(createdOscillators.length).toBe(6)

      cues.play('error')
      expect(createdOscillators.length).toBe(8)

      cues.play('interrupt')
      expect(createdOscillators.length).toBe(9)
    })

    it('respects setEnabled and setVolume', () => {
      const mockOsc = {
        type: 'sine',
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }
      const mockGain = {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      }

      const mockCtx: any = {
        currentTime: 0,
        destination: {},
        createOscillator: vi.fn(() => mockOsc),
        createGain: vi.fn(() => mockGain),
      }

      const cues = new AudioCues({ context: mockCtx, enabled: false })
      cues.play('wake')
      expect(mockCtx.createOscillator).not.toHaveBeenCalled()

      cues.setEnabled(true)
      cues.play('recognize')
      expect(mockCtx.createOscillator).toHaveBeenCalled()
    })
  })

  describe('VoiceManager Barge-in & Interim Transcripts', () => {
    it('handles interim transcripts and performs barge-in when user speaks during SPEAKING state', () => {
      const wake = new FakeWakeWordProvider()
      const stt = new FakeSpeechToTextProvider()
      const tts = new FakeTextToSpeechProvider()

      const submitted: string[] = []
      const interim: string[] = []
      let interrupted = false

      const vm = new VoiceManager({
        wake,
        stt,
        tts,
        callbacks: {
          submitCommand: (cmd) => submitted.push(cmd),
          cancelCurrent: vi.fn(),
          onInterimTranscript: (txt) => interim.push(txt),
          onInterrupt: () => {
            interrupted = true
          },
        },
      })

      // Arm session
      vm.arm()
      expect(vm.state).toBe('LISTENING_FOR_WAKE')

      // Trigger wake word
      wake.emitWake({ phrase: 'hey jarvis' })
      expect(vm.state).toBe('AWAKE')
      // Complete wake phrase TTS
      tts.finishLast()
      expect(vm.state).toBe('LISTENING_FOR_COMMAND')

      // User speaks a command
      stt.emitTranscript('What is the weather today?')
      expect(submitted).toEqual(['What is the weather today?'])
      expect(vm.state).toBe('PROCESSING')

      // Engine transitions to speaking response
      vm.engineStatus('speaking')
      expect(vm.state).toBe('SPEAKING')

      // Assistant is speaking. Now user interrupts with new speech (barge-in!)
      stt.emitInterimTranscript('Wait, stop and')
      expect(interim).toEqual(['Wait, stop and'])
      expect(interrupted).toBe(true)
      expect(tts.stopCalls).toBe(1)
      expect(vm.state).toBe('LISTENING_FOR_COMMAND')

      // Final transcript follows after barge-in
      stt.emitTranscript('Never mind, show my calendar')
      expect(submitted).toEqual(['What is the weather today?', 'Never mind, show my calendar'])
      expect(vm.state).toBe('PROCESSING')

      vm.dispose()
    })
  })
})
