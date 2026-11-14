import { describe, it, expect } from 'vitest'
import { ArtifactEngine } from './ArtifactEngine'

describe('ArtifactEngine (Workstream R)', () => {
  const engine = new ArtifactEngine()

  it('creates an interactive HTML dashboard with metrics, tables, and grounded citations', () => {
    const dashboard = engine.createHtmlDashboard({
      title: 'JARVIS 2.0 Operational Performance',
      subtitle: 'Real-time telemetry and task execution metrics',
      sections: [
        {
          title: 'Core Engine Metrics',
          description: 'Key performance indicators for background tasks',
          metrics: [
            { label: 'Tasks Executed', value: 142, change: '+12%', trend: 'up' },
            { label: 'Checkpoints Verified', value: 1108, change: '+24%', trend: 'up' },
            { label: 'Failure Honesty Rate', value: '100%', trend: 'neutral' },
          ],
          table: {
            headers: ['Task ID', 'Capability', 'Duration (ms)', 'Status'],
            rows: [
              ['task-001', 'dev.runTests', 1420, 'VERIFIED'],
              ['task-002', 'browser.navigate', 850, 'VERIFIED'],
              ['task-003', 'desktop.screenshot', 320, 'VERIFIED'],
            ],
          },
        },
      ],
      citations: [
        {
          source: 'server/data/tasks/task-001.json',
          section: 'checkpoints',
          lineStart: 12,
          lineEnd: 45,
          textSnippet: 'All 6 test assertions passed with exit code 0.',
          verified: true,
        },
      ],
    })

    expect(dashboard.type).toBe('html_dashboard')
    expect(dashboard.format).toBe('html')
    expect(dashboard.content).toContain('<!DOCTYPE html>')
    expect(dashboard.content).toContain('JARVIS 2.0 Operational Performance')
    expect(dashboard.content).toContain('Tasks Executed')
    expect(dashboard.content).toContain('dev.runTests')
    expect(dashboard.content).toContain('server/data/tasks/task-001.json')
    expect(dashboard.citations.length).toBe(1)
  })

  it('creates a Markdown technical specification with architecture diagrams and grounded evidence', () => {
    const spec = engine.createTechnicalSpec({
      title: 'JARVIS 2.0 Core Architecture Specification',
      overview: 'Universal personal AI operating system orchestrating multi-domain execution.',
      architectureDiagram: 'graph TD\n  User --> AssistantEngine\n  AssistantEngine --> TaskService\n  TaskService --> NativeAgent',
      components: [
        {
          name: 'AssistantEngine',
          responsibility: 'Single cognitive authority for routing, planning, and synthesis.',
          interfaces: ['process(text)', 'submitPersistentTask(options)', 'getPersistentTasks()'],
        },
        {
          name: 'TaskService',
          responsibility: 'Durable background execution daemon with restart recovery and disk checkpoints.',
          interfaces: ['createTask(req)', 'getTask(id)', 'pauseTask(id)', 'resumeTask(id)'],
        },
      ],
      securityConsiderations: [
        'Default-deny on destructive file deletions without explicit user confirmation.',
        'SSRF protection rejecting loopback (127.0.0.1) and private addresses on all web requests.',
        'Zero credential leakage: bearer tokens kept exclusively in server memory.',
      ],
    })

    expect(spec.type).toBe('technical_spec')
    expect(spec.format).toBe('markdown')
    expect(spec.content).toContain('# JARVIS 2.0 Core Architecture Specification')
    expect(spec.content).toContain('```mermaid')
    expect(spec.content).toContain('AssistantEngine')
    expect(spec.content).toContain('TaskService')
    expect(spec.content).toContain('SSRF protection rejecting loopback')
  })

  it('exports tabular data to CSV with RFC-compliant escaping', () => {
    const csv = engine.exportCsv(
      ['Name', 'Category', 'Notes'],
      [
        ['Playwright Automation', 'Browser', 'Reliable Chromium automation, headless & headed'],
        ['DevEngine', 'Code', 'Executes "pytest" and "vitest" tests'],
      ]
    )

    expect(csv.type).toBe('tabular_export')
    expect(csv.format).toBe('csv')
    expect(csv.content).toContain('Name,Category,Notes')
    expect(csv.content).toContain('"Reliable Chromium automation, headless & headed"')
    expect(csv.content).toContain('""pytest""')
  })
})

