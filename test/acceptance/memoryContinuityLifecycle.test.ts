import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { MemoryManager } from '../../src/memory/MemoryManager'
import {
  ProjectContextStore,
  type ProjectContextStorage,
  type ProjectContext,
} from '../../src/memory/projectContext'

const TEST_DIR = path.resolve('D:/JARVIS-Test/JARVIS-3.3/memory_test')
const DISK_MEMORY_FILE = path.join(TEST_DIR, 'disk_memory_store.json')
const DISK_PROJECT_FILE = path.join(TEST_DIR, 'disk_project_contexts.json')

class DiskProjectContextStorage implements ProjectContextStorage {
  constructor(private filePath: string) {}

  load(): Record<string, ProjectContext> {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8')
        return JSON.parse(content) as Record<string, ProjectContext>
      }
    } catch (err) {
      console.warn('Error reading project context storage file:', err)
    }
    return {}
  }

  save(data: Record<string, ProjectContext>): boolean {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8')
      return true
    } catch (err) {
      console.warn('Error writing project context storage file:', err)
      return false
    }
  }
}

function setupDiskLocalStorage(filePath: string) {
  const readDisk = (): Record<string, string> => {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      }
    } catch {}
    return {}
  }

  const writeDisk = (data: Record<string, string>) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
  }

  ;(globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (k: string) => {
        const data = readDisk()
        return data[k] ?? null
      },
      setItem: (k: string, v: string) => {
        const data = readDisk()
        data[k] = v
        writeDisk(data)
      },
      removeItem: (k: string) => {
        const data = readDisk()
        delete data[k]
        writeDisk(data)
      },
      clear: () => {
        writeDisk({})
      },
    },
    setTimeout: (_fn: () => void) => 0,
  }
}

describe('Gate G7: Persistent Memory Validation Across Restarts', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true })
    setupDiskLocalStorage(DISK_MEMORY_FILE)
  })

  afterEach(() => {
    // Keep test files intact for forensic inspection in D:\JARVIS-Test\JARVIS-3.3\memory_test
  })

  it('executes the full 10-step memory continuity and cross-project isolation lifecycle', () => {
    if (fs.existsSync(DISK_MEMORY_FILE)) fs.unlinkSync(DISK_MEMORY_FILE)
    if (fs.existsSync(DISK_PROJECT_FILE)) fs.unlinkSync(DISK_PROJECT_FILE)

    // -------------------------------------------------------------
    // Step 1: Store non-sensitive preference
    // -------------------------------------------------------------
    let manager1: MemoryManager | null = new MemoryManager()
    const prefItem = manager1.remember(
      'User prefers pytest with verbose output for Python backend services',
      {
        type: 'PREFERENCE',
        source: 'user',
        importance: 0.8,
      },
    )

    manager1.updatePreferences({
      animationIntensity: 'low',
      providerId: 'local',
      volume: 0.85,
    })

    expect(prefItem.id).toBeDefined()
    expect(prefItem.content).toContain('pytest with verbose output')
    expect(prefItem.type).toBe('PREFERENCE')

    // -------------------------------------------------------------
    // Step 2: Retrieve it through memory manager
    // -------------------------------------------------------------
    const retrieved1 = manager1.get(prefItem.id)
    expect(retrieved1).not.toBeNull()
    expect(retrieved1?.content).toBe(prefItem.content)
    const snapshot1 = manager1.snapshot()
    expect(snapshot1.preferences.animationIntensity).toBe('low')
    expect(snapshot1.preferences.providerId).toBe('local')
    expect(snapshot1.preferences.volume).toBe(0.85)

    // Verify physical persistence on disk
    expect(fs.existsSync(DISK_MEMORY_FILE)).toBe(true)
    const diskRaw1 = JSON.parse(fs.readFileSync(DISK_MEMORY_FILE, 'utf-8'))
    expect(diskRaw1['jarvis.memory']).toBeDefined()
    const memoryRecord1 = JSON.parse(diskRaw1['jarvis.memory'])
    expect(memoryRecord1.items.length).toBe(1)
    expect(memoryRecord1.items[0].id).toBe(prefItem.id)
    expect(memoryRecord1.preferences.providerId).toBe('local')

    // -------------------------------------------------------------
    // Step 3: Restart / reload from disk storage
    // -------------------------------------------------------------
    // Simulate process termination and fresh boot
    manager1 = null

    // -------------------------------------------------------------
    // Step 4: Retrieve again (persistence verification across restart)
    // -------------------------------------------------------------
    let manager2: MemoryManager | null = new MemoryManager()
    const retrieved2 = manager2.get(prefItem.id)
    expect(retrieved2).not.toBeNull()
    expect(retrieved2?.id).toBe(prefItem.id)
    expect(retrieved2?.content).toBe(
      'User prefers pytest with verbose output for Python backend services',
    )
    expect(retrieved2?.type).toBe('PREFERENCE')
    expect(retrieved2?.importance).toBe(0.8)

    const snapshot2 = manager2.snapshot()
    expect(snapshot2.preferences.animationIntensity).toBe('low')
    expect(snapshot2.preferences.providerId).toBe('local')
    expect(snapshot2.preferences.volume).toBe(0.85)

    // -------------------------------------------------------------
    // Step 5: Update preference
    // -------------------------------------------------------------
    const updatedItem = manager2.update(prefItem.id, {
      content: 'User prefers pytest with coverage and verbose output for all Python test suites',
      importance: 0.9,
    })
    expect(updatedItem).not.toBeNull()
    expect(updatedItem?.content).toBe(
      'User prefers pytest with coverage and verbose output for all Python test suites',
    )
    expect(updatedItem?.importance).toBe(0.9)

    manager2.updatePreferences({
      volume: 0.6,
      reducedMotion: true,
    })

    // -------------------------------------------------------------
    // Step 6: Verify new value across another restart
    // -------------------------------------------------------------
    manager2 = null
    let manager3: MemoryManager | null = new MemoryManager()

    const retrieved3 = manager3.get(prefItem.id)
    expect(retrieved3).not.toBeNull()
    expect(retrieved3?.content).toBe(
      'User prefers pytest with coverage and verbose output for all Python test suites',
    )
    expect(retrieved3?.importance).toBe(0.9)

    const snapshot3 = manager3.snapshot()
    expect(snapshot3.preferences.volume).toBe(0.6)
    expect(snapshot3.preferences.reducedMotion).toBe(true)

    // -------------------------------------------------------------
    // Step 7: Delete memory
    // -------------------------------------------------------------
    const removeSuccess = manager3.remove(prefItem.id)
    expect(removeSuccess).toBe(true)
    expect(manager3.get(prefItem.id)).toBeNull()
    expect(manager3.count).toBe(0)

    // -------------------------------------------------------------
    // Step 8: Verify deletion (zero residue across fresh restart)
    // -------------------------------------------------------------
    manager3 = null
    const manager4 = new MemoryManager()
    expect(manager4.get(prefItem.id)).toBeNull()
    expect(manager4.count).toBe(0)
    expect(manager4.items()).toEqual([])

    // Check physical file on disk has zero residue of the memory item
    const diskRawPostDelete = JSON.parse(fs.readFileSync(DISK_MEMORY_FILE, 'utf-8'))
    const memoryRecordPostDelete = JSON.parse(diskRawPostDelete['jarvis.memory'])
    expect(memoryRecordPostDelete.items.length).toBe(0)
    expect(JSON.stringify(memoryRecordPostDelete)).not.toContain('pytest')

    // -------------------------------------------------------------
    // Step 9: Isolate two synthetic project contexts (ProjectAlpha vs ProjectBeta)
    // -------------------------------------------------------------
    const diskStorage = new DiskProjectContextStorage(DISK_PROJECT_FILE)
    let projectStore1: ProjectContextStore | null = new ProjectContextStore(diskStorage)

    projectStore1.recordTaskRun({
      projectIdOrName: 'ProjectAlpha',
      rootPath: 'D:/repos/ProjectAlpha',
      taskId: 'task-alpha-001',
      taskTitle: 'Implement TypeScript JWT Authentication Service',
      status: 'COMPLETED',
      checkpointSummary: 'JWT token signing and validation middleware completed',
      stack: {
        languages: ['TypeScript', 'Node.js'],
        frameworks: ['Express', 'Vitest'],
        testRunner: 'vitest',
        packageManager: 'npm',
        hasGit: true,
        defaultBranch: 'main',
      },
    })

    projectStore1.recordTaskRun({
      projectIdOrName: 'ProjectBeta',
      rootPath: 'D:/repos/ProjectBeta',
      taskId: 'task-beta-001',
      taskTitle: 'Build Python Async Data Ingestion Pipeline',
      status: 'IN_PROGRESS',
      checkpointSummary: 'FastAPI and async Kafka consumer scaffolded',
      stack: {
        languages: ['Python'],
        frameworks: ['FastAPI', 'Pydantic'],
        testRunner: 'pytest',
        packageManager: 'uv',
        hasGit: true,
        defaultBranch: 'develop',
      },
    })

    // Verify physical persistence on disk for project contexts
    expect(fs.existsSync(DISK_PROJECT_FILE)).toBe(true)

    // -------------------------------------------------------------
    // Step 10: Verify zero cross-project contamination
    // -------------------------------------------------------------
    // Simulate process restart for ProjectContextStore
    projectStore1 = null
    const projectStore2 = new ProjectContextStore(
      new DiskProjectContextStorage(DISK_PROJECT_FILE),
    )

    const alpha = projectStore2.find('ProjectAlpha')
    expect(alpha).not.toBeNull()
    expect(alpha?.name).toBe('ProjectAlpha')
    expect(alpha?.rootPath).toBe('D:/repos/ProjectAlpha')
    expect(alpha?.stack?.languages).toContain('TypeScript')
    expect(alpha?.stack?.languages).not.toContain('Python')
    expect(alpha?.stack?.testRunner).toBe('vitest')
    expect(alpha?.lastActiveTaskId).toBe('task-alpha-001')
    expect(alpha?.lastCheckpointSummary).toContain('JWT token signing')
    expect(alpha?.history?.[0]?.taskId).toBe('task-alpha-001')

    const beta = projectStore2.find('ProjectBeta')
    expect(beta).not.toBeNull()
    expect(beta?.name).toBe('ProjectBeta')
    expect(beta?.rootPath).toBe('D:/repos/ProjectBeta')
    expect(beta?.stack?.languages).toContain('Python')
    expect(beta?.stack?.languages).not.toContain('TypeScript')
    expect(beta?.stack?.testRunner).toBe('pytest')
    expect(beta?.lastActiveTaskId).toBe('task-beta-001')
    expect(beta?.lastCheckpointSummary).toContain('FastAPI and async Kafka')
    expect(beta?.history?.[0]?.taskId).toBe('task-beta-001')

    // Strict boundary verification: query by path
    const alphaByPath = projectStore2.find('D:/repos/ProjectAlpha')
    expect(alphaByPath?.projectId).toBe(alpha?.projectId)
    expect(alphaByPath?.stack?.languages).toEqual(['TypeScript', 'Node.js'])

    const betaByPath = projectStore2.find('D:/repos/ProjectBeta')
    expect(betaByPath?.projectId).toBe(beta?.projectId)
    expect(betaByPath?.stack?.languages).toEqual(['Python'])

    // Remove Alpha, verify Beta is completely unaffected
    const removedAlpha = projectStore2.remove(alpha!.projectId)
    expect(removedAlpha).toBe(true)
    expect(projectStore2.find('ProjectAlpha')).toBeNull()

    const betaStillIntact = projectStore2.find('ProjectBeta')
    expect(betaStillIntact).not.toBeNull()
    expect(betaStillIntact?.stack?.testRunner).toBe('pytest')

    // Verify raw disk representation after Alpha removal
    const diskProjectRaw = JSON.parse(fs.readFileSync(DISK_PROJECT_FILE, 'utf-8'))
    expect(diskProjectRaw[alpha!.projectId]).toBeUndefined()
    expect(diskProjectRaw[beta!.projectId]).toBeDefined()
  })

  it('strictly rejects sensitive high-risk credentials from being remembered', () => {
    const memory = new MemoryManager()
    expect(() => {
      memory.remember('Here is my OpenAI API key: sk-live-1234567890abcdef1234567890abcdef', {
        type: 'FACT',
      })
    }).toThrow(/credential/i)

    expect(() => {
      memory.remember('My AWS secret access key is wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', {
        type: 'FACT',
      })
    }).toThrow(/credential/i)
  })
})
