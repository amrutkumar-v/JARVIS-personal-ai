import { describe, expect, it } from 'vitest'
import { UniversalIntentRouter } from './UniversalIntentRouter'

describe('Phase 1 — Universal Intent Router Extensions', () => {
  const router = new UniversalIntentRouter()

  describe('DEEP_RESEARCH Strategy', () => {
    it('classifies in-depth research queries correctly', () => {
      const inputs = [
        'Conduct a deep research on quantum computing error mitigation',
        'Deep dive into solid-state battery chemistry',
        'Please conduct an in-depth research on transformer architectures',
        'Comprehensive research on microservices versus monoliths',
        'Investigate thoroughly the economic impact of carbon capture technologies',
        'Compare in-depth React and Svelte reactive primitives',
      ]

      for (const text of inputs) {
        const res = router.classify(text)
        expect(res.strategy, `Failed for: ${text}`).toBe('DEEP_RESEARCH')
        expect(res.confidence).toBeGreaterThanOrEqual(0.9)
        expect(res.entities.depth).toBe('deep')
        expect(res.suggestedCapabilities).toContain('web_search')
        expect(res.suggestedCapabilities).toContain('web_fetch')
      }
    })
  })

  describe('DOCUMENT_INTELLIGENCE Strategy', () => {
    it('classifies document reading, summarization, and extraction queries', () => {
      const inputs = [
        'Summarize this PDF document',
        'Extract data from invoice.pdf',
        'Parse the spreadsheet budget.xlsx',
        'Analyze the presentation quarterly-results.pptx',
        'What does the contract say about liability and termination?',
        'Read and summarize the report annual-financials.pdf',
      ]

      for (const text of inputs) {
        const res = router.classify(text)
        expect(res.strategy, `Failed for: ${text}`).toBe('DOCUMENT_INTELLIGENCE')
        expect(res.confidence).toBeGreaterThanOrEqual(0.85)
        expect(res.suggestedCapabilities).toContain('doc.parse')
        expect(res.suggestedCapabilities).toContain('doc.summarize')
      }
    })

    it('extracts file path entity when specified in prompt', () => {
      const res = router.classify('Extract all tables from data/reports/annual-report.pdf')
      expect(res.strategy).toBe('DOCUMENT_INTELLIGENCE')
      expect(res.entities.filePath).toBe('data/reports/annual-report.pdf')
    })
  })

  describe('MEMORY_OPERATION Strategy', () => {
    it('classifies explicit memory storage requests', () => {
      const res1 = router.classify('Remember that I prefer dark mode in all editors')
      expect(res1.strategy).toBe('MEMORY_OPERATION')
      expect(res1.intent).toBe('memory_remember')
      expect(res1.entities.operation).toBe('remember')
      expect(res1.suggestedCapabilities).toContain('memory.remember')

      const res2 = router.classify('Please memorize my project directory is D:/Work')
      expect(res2.strategy).toBe('MEMORY_OPERATION')
      expect(res2.intent).toBe('memory_remember')
    })

    it('classifies memory retrieval and inspection requests', () => {
      const res1 = router.classify('What do you remember about my preferred tech stack?')
      expect(res1.strategy).toBe('MEMORY_OPERATION')
      expect(res1.intent).toBe('memory_recall')
      expect(res1.suggestedCapabilities).toContain('memory.recall')

      const res2 = router.classify('Show my memories')
      expect(res2.strategy).toBe('MEMORY_OPERATION')
      expect(res2.intent).toBe('memory_recall')

      const res3 = router.classify('List my memories')
      expect(res3.strategy).toBe('MEMORY_OPERATION')
      expect(res3.intent).toBe('memory_recall')
    })

    it('classifies memory deletion and preference update requests', () => {
      const res1 = router.classify('Forget that I live in Seattle')
      expect(res1.strategy).toBe('MEMORY_OPERATION')
      expect(res1.intent).toBe('memory_forget')
      expect(res1.suggestedCapabilities).toContain('memory.forget')

      const res2 = router.classify('Update my preference for speech rate to fast')
      expect(res2.strategy).toBe('MEMORY_OPERATION')
      expect(res2.intent).toBe('memory_preference')
    })
  })

  describe('MULTIMODAL_REQUEST Strategy', () => {
    it('classifies image and visual reasoning requests', () => {
      const inputs = [
        'What is in this image?',
        'Describe this image for me',
        'Analyze this diagram and explain the data flow',
        'Inspect this photo and read text from image',
      ]

      for (const text of inputs) {
        const res = router.classify(text)
        expect(res.strategy, `Failed for: ${text}`).toBe('MULTIMODAL_REQUEST')
        expect(res.intent).toBe('image_analysis')
        expect(res.entities.mode).toBe('visual')
        expect(res.suggestedCapabilities).toContain('vision.analyze')
      }
    })

    it('classifies audio transcription requests', () => {
      const inputs = [
        'Transcribe this audio recording',
        'Listen to this audio file and summarize what was said',
      ]

      for (const text of inputs) {
        const res = router.classify(text)
        expect(res.strategy, `Failed for: ${text}`).toBe('MULTIMODAL_REQUEST')
        expect(res.intent).toBe('audio_transcription')
        expect(res.entities.mode).toBe('audio')
        expect(res.suggestedCapabilities).toContain('audio.transcribe')
      }
    })
  })

  describe('Safety & Fallback Integrity', () => {
    it('preserves risky deictic deletion protection ahead of new strategies', () => {
      const res = router.classify('delete that file')
      expect(res.strategy).toBe('CLARIFICATION_REQUIRED')
      expect(res.intent).toBe('destructive_ambiguity')
    })

    it('preserves autonomous dev recognition for dev tasks with explicit paths', () => {
      const res = router.classify('Inspect D:/MyProject. Create a python program with unittests.')
      expect(res.strategy).toBe('AUTONOMOUS_DEV')
    })

    it('falls open to DIRECT_ANSWER for general knowledge questions', () => {
      const res = router.classify('Why is the sky blue?')
      expect(res.strategy).toBe('DIRECT_ANSWER')
    })
  })
})

