import { describe, it, expect } from 'vitest'
import { UniversalIntentRouter } from './UniversalIntentRouter'

describe('UniversalIntentRouter', () => {
  const router = new UniversalIntentRouter()

  // --------------------------------------------------------------------------
  // 1. Direct Conversational Answers (Zero-Task Overhead)
  // --------------------------------------------------------------------------
  describe('DIRECT_ANSWER Strategy', () => {
    it('classifies greetings and polite chitchat as DIRECT_ANSWER', () => {
      const inputs = [
        'Hello JARVIS',
        'good morning',
        'hi',
        'hey there',
        'how are you doing today?',
        'who are you?',
        'what is your name?',
        'thank you so much',
        'thanks',
        'goodbye',
      ]
      for (const text of inputs) {
        const res = router.classify(text)
        expect(res.strategy, `Expected DIRECT_ANSWER for "${text}"`).toBe('DIRECT_ANSWER')
      }
    })

    it('classifies general knowledge and explanatory questions as DIRECT_ANSWER', () => {
      const inputs = [
        'What is quantum entanglement?',
        'Explain the difference between TCP and UDP',
        'How does photosynthesis work?',
        'Why is the sky blue?',
        'Can you summarize the plot of Hamlet?',
        'What are the primary principles of clean software architecture?',
        'Explain the theory of general relativity in simple terms',
        'What is the capital of France?',
      ]
      for (const text of inputs) {
        const res = router.classify(text)
        expect(res.strategy, `Expected DIRECT_ANSWER for "${text}"`).toBe('DIRECT_ANSWER')
        expect(res.requestClass).toBe('question')
      }
    })

    it('classifies math and arithmetic calculations as DIRECT_ANSWER', () => {
      const inputs = [
        'calculate 25 * 48 + 120',
        'what is 2 + 2',
        'compute (150 / 3) * 4',
        '100 / 4',
        'evaluate 2^8',
      ]
      for (const text of inputs) {
        const res = router.classify(text)
        expect(res.strategy, `Expected DIRECT_ANSWER for "${text}"`).toBe('DIRECT_ANSWER')
      }
    })

    it('classifies empty or blank prompt as DIRECT_ANSWER', () => {
      expect(router.classify('').strategy).toBe('DIRECT_ANSWER')
      expect(router.classify('   ').strategy).toBe('DIRECT_ANSWER')
    })
  })

  // --------------------------------------------------------------------------
  // 2. Autonomous Software Development
  // --------------------------------------------------------------------------
  describe('AUTONOMOUS_DEV Strategy', () => {
    it('classifies explicit autonomous development prompts', () => {
      const prompt1 = 'JARVIS, fix my ProjectHub project. Audit the repository, identify missing functionality, implement necessary fixes, test everything and ensure the application works correctly.'
      const res1 = router.classify(prompt1)
      expect(res1.strategy).toBe('AUTONOMOUS_DEV')
      expect(res1.devPlan?.projectName).toBe('ProjectHub')
      expect(res1.suggestedCapabilities).toContain('dev.inspectProject')
      expect(res1.suggestedCapabilities).toContain('dev.patchFile')
      expect(res1.suggestedCapabilities).toContain('dev.runTests')

      const prompt2 = 'Inspect D:\\JARVIS-Test. Create a simple Python program that calculates the area of a circle. Create an appropriate test file, execute the tests, verify the results, and generate a completion report.'
      const res2 = router.classify(prompt2)
      expect(res2.strategy).toBe('AUTONOMOUS_DEV')
      expect(res2.devPlan?.projectPath).toContain('JARVIS-Test')

      const prompt3 = 'Inspect my ProjectHub repository, identify one incomplete but safe functionality, implement it, run relevant tests and report the results.'
      const res3 = router.classify(prompt3)
      expect(res3.strategy).toBe('AUTONOMOUS_DEV')

      const prompt4 = 'create a simple python script to parse logs and create unittest'
      const res4 = router.classify(prompt4)
      expect(res4.strategy).toBe('AUTONOMOUS_DEV')

      const prompt5 = 'fix my D:\\MyCoolApp project and run tests'
      const res5 = router.classify(prompt5)
      expect(res5.strategy).toBe('AUTONOMOUS_DEV')
    })
  })

  // --------------------------------------------------------------------------
  // 3. Web Research & Current Information
  // --------------------------------------------------------------------------
  describe('WEB_RESEARCH Strategy', () => {
    it('classifies web queries, news lookups, and comparisons', () => {
      const inputs = [
        'search the web for current price of Bitcoin',
        'search for the latest news on SpaceX Starship',
        'look up recent updates on TypeScript 5.8',
        'what is the latest release of Node.js?',
        'compare the best open-source vector databases in 2026',
        'find me the best mechanical keyboards under $100',
        'current weather in Tokyo',
      ]
      for (const text of inputs) {
        const res = router.classify(text)
        expect(res.strategy, `Expected WEB_RESEARCH for "${text}"`).toBe('WEB_RESEARCH')
        expect(res.suggestedCapabilities).toContain('web_search')
      }
    })
  })

  // --------------------------------------------------------------------------
  // 4. Interactive Browser Workflows
  // --------------------------------------------------------------------------
  describe('BROWSER_WORKFLOW Strategy', () => {
    it('classifies URL navigation and page interaction', () => {
      const inputs = [
        'open https://github.com and check notifications',
        'navigate to www.google.com',
        'go to news.ycombinator.com',
        'fill out the form and submit the page',
        'scrape table from https://example.com/data',
      ]
      for (const text of inputs) {
        const res = router.classify(text)
        expect(res.strategy, `Expected BROWSER_WORKFLOW for "${text}"`).toBe('BROWSER_WORKFLOW')
        expect(res.suggestedCapabilities).toContain('browser.open')
      }
    })
  })

  // --------------------------------------------------------------------------
  // 5. Native Desktop Actions
  // --------------------------------------------------------------------------
  describe('DESKTOP_ACTION Strategy', () => {
    it('classifies desktop app launching, closing, window listing, and screenshot', () => {
      const appInputs = ['open notepad', 'launch chrome', 'start calculator', 'close spotify']
      for (const text of appInputs) {
        const res = router.classify(text)
        expect(res.strategy, `Expected DESKTOP_ACTION for "${text}"`).toBe('DESKTOP_ACTION')
      }

      const winRes = router.classify('list open windows')
      expect(winRes.strategy).toBe('DESKTOP_ACTION')
      expect(winRes.suggestedCapabilities).toContain('list_windows')

      const screenRes = router.classify('take a screenshot')
      expect(screenRes.strategy).toBe('DESKTOP_ACTION')
      expect(screenRes.suggestedCapabilities).toContain('observe_desktop')
    })

    it('classifies all Phase 4 desktop natural language examples', () => {
      // Example A: Screenshot
      const exA = router.classify('Take a screenshot of my desktop.')
      expect(exA.strategy).toBe('DESKTOP_ACTION')
      expect(exA.intent).toBe('screenshot')

      // Example B: Running applications
      const exB = router.classify('Which applications are currently open?')
      expect(exB.strategy).toBe('DESKTOP_ACTION')
      expect(exB.intent).toBe('list_windows')

      // Example C: Open single application
      const exC = router.classify('Open Notepad.')
      expect(exC.strategy).toBe('DESKTOP_ACTION')
      expect(exC.intent).toBe('open_app')
      expect(exC.entities.targetApp).toBe('notepad')

      // Example D: Multi-step desktop task
      const exD = router.classify('Open Calculator and calculate 125 multiplied by 48.')
      expect(exD.strategy).toBe('DESKTOP_ACTION')
      expect(exD.intent).toBe('multi_step_desktop')
      expect(exD.entities.appName).toBe('calculator')
      expect(exD.entities.calculation).toBe('125 multiplied by 48')

      // Example E: Switch application
      const exE = router.classify('Switch to my browser.')
      expect(exE.strategy).toBe('DESKTOP_ACTION')
      expect(exE.intent).toBe('switch_app')
      expect(exE.entities.targetApp).toBe('browser')

      // Example F: Visual inspection
      const exF = router.classify('Take a screenshot and tell me what is currently visible.')
      expect(exF.strategy).toBe('DESKTOP_ACTION')
      expect(exF.intent).toBe('visual_inspect')
    })
  })

  // --------------------------------------------------------------------------
  // 6. Local Filesystem Operations
  // --------------------------------------------------------------------------
  describe('FILE_OPERATION Strategy', () => {
    it('classifies directory and file exploration', () => {
      const inputs = [
        'list files in current folder',
        'show directory contents',
        'search for files named report.pdf',
        'read the file notes.txt',
        'copy file source.txt to dest.txt',
      ]
      for (const text of inputs) {
        const res = router.classify(text)
        expect(res.strategy, `Expected FILE_OPERATION for "${text}"`).toBe('FILE_OPERATION')
        expect(res.suggestedCapabilities.length).toBeGreaterThan(0)
      }
    })
  })

  // --------------------------------------------------------------------------
  // 7. Data Analysis & Visualization
  // --------------------------------------------------------------------------
  describe('DATA_ANALYSIS Strategy', () => {
    it('classifies tabular analysis, statistics, and chart generation', () => {
      const inputs = [
        'analyze the dataset in sales.csv',
        'summarize the metrics',
        'calculate the average revenue',
        'plot a chart of monthly signups',
        'generate a histogram of latency values',
      ]
      for (const text of inputs) {
        const res = router.classify(text)
        expect(res.strategy, `Expected DATA_ANALYSIS for "${text}"`).toBe('DATA_ANALYSIS')
      }
    })
  })

  // --------------------------------------------------------------------------
  // 8. Productivity & Scheduling
  // --------------------------------------------------------------------------
  describe('PRODUCTIVITY Strategy', () => {
    it('classifies natural language reminder and scheduling requests', () => {
      const inputs = [
        'remind me in 10 minutes to take a break',
        'schedule a reminder in 1 hour to submit report',
        'show scheduled reminders',
      ]
      for (const text of inputs) {
        const res = router.classify(text)
        expect(res.strategy, `Expected PRODUCTIVITY for "${text}"`).toBe('PRODUCTIVITY')
        expect(res.schedulingPlan).toBeDefined()
      }
    })
  })

  // --------------------------------------------------------------------------
  // 9. Continuity
  // --------------------------------------------------------------------------
  describe('CONTINUITY Strategy', () => {
    it('classifies requests to resume or query previous work', () => {
      const inputs = [
        'continue where you stopped',
        'resume where we left off',
        'continue the previous task',
        'resume previous task',
        'what were you working on',
        'show previous task status',
      ]
      for (const text of inputs) {
        const res = router.classify(text)
        expect(res.strategy, `Expected CONTINUITY for "${text}"`).toBe('CONTINUITY')
        expect(res.continuity).toBeDefined()
      }
    })
  })

  // --------------------------------------------------------------------------
  // 10. Task Lifecycle Control
  // --------------------------------------------------------------------------
  describe('TASK_CONTROL Strategy', () => {
    it('classifies pause, resume, cancel, approve, and reject commands', () => {
      expect(router.classify('pause the task').strategy).toBe('TASK_CONTROL')
      expect(router.classify('resume the task').strategy).toBe('TASK_CONTROL')
      expect(router.classify('cancel the task').strategy).toBe('TASK_CONTROL')
      expect(router.classify('stop current task').strategy).toBe('TASK_CONTROL')
      expect(router.classify('approve the action').strategy).toBe('TASK_CONTROL')
      expect(router.classify('reject the subtask').strategy).toBe('TASK_CONTROL')
    })
  })

  // --------------------------------------------------------------------------
  // 11. Clarification Required (Safety Guardrails)
  // --------------------------------------------------------------------------
  describe('CLARIFICATION_REQUIRED Strategy (Default-Deny Protection)', () => {
    it('intercepts ambiguous destructive requests', () => {
      const risky = ['delete that', 'delete it', 'remove that', 'destroy this', 'erase the file']
      for (const text of risky) {
        const res = router.classify(text)
        expect(res.strategy, `Expected CLARIFICATION_REQUIRED for "${text}"`).toBe('CLARIFICATION_REQUIRED')
        expect(res.clarificationQuestion).toBeDefined()
      }
    })
  })

  // --------------------------------------------------------------------------
  // 12. Data Analysis & Chart Generation
  // --------------------------------------------------------------------------
  describe('DATA_ANALYSIS Strategy', () => {
    it('classifies dataset statistical analysis and chart generation', () => {
      const dataQueries = [
        'analyze the sales data',
        'calculate the average and trend of metrics',
        'generate a chart of revenue vs month',
        'plot a bar chart of the dataset',
      ]
      for (const query of dataQueries) {
        const res = router.classify(query)
        expect(res.strategy, `Expected DATA_ANALYSIS for "${query}"`).toBe('DATA_ANALYSIS')
        expect(res.suggestedCapabilities).toContain('data.analyze')
      }
    })
  })
})

