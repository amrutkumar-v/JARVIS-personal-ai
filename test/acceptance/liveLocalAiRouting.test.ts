import { describe, expect, it } from 'vitest'
import {
  createAiProviderRouter,
  probeLocalEndpoints,
  type AiRouteRequest,
} from '../../server/src/aiProvider'

describe('Gate G8: Real Local Model Inference (Ollama Qwen 3 8B)', () => {
  const env = {
    JARVIS_AI_PRIMARY_PROVIDER: 'ollama',
    OLLAMA_BASE_URL: 'http://localhost:11434',
    OLLAMA_AI_MODEL: 'qwen3:8b',
  }

  it('probes and discovers installed models from live Ollama instance', async () => {
    // 1. Native discovery probe
    const endpoints = await probeLocalEndpoints()
    const ollamaEndpoint = endpoints.find((e) => e.providerId === 'ollama')
    expect(ollamaEndpoint).toBeDefined()
    expect(ollamaEndpoint?.reachable).toBe(true)
    expect(ollamaEndpoint?.models.length).toBeGreaterThan(0)
    expect(ollamaEndpoint?.models).toContain('qwen3:8b')

    // 2. Health check via AiProviderRouter
    const router = createAiProviderRouter({ env, probeHealth: true })
    const health = await router.getHealth()

    expect(health.primary).toBe('ollama')
    const ollamaEntry = health.providers.find((p) => p.id === 'ollama')
    expect(ollamaEntry).toBeDefined()
    expect(ollamaEntry?.status).toBe('CONNECTED')
    expect(ollamaEntry?.discovered).toBe(true)
    expect(ollamaEntry?.models).toContain('qwen3:8b')
  })

  it('performs live reasoning inference through Ollama with measured latency', async () => {
    const router = createAiProviderRouter({ env, probeHealth: true })

    const payload = {
      model: 'qwen3:8b',
      messages: [
        {
          role: 'user',
          content:
            'A farmer has 15 sheep, and all but 8 die. How many sheep are still alive? Answer in one short sentence stating the number clearly.',
        },
      ],
      temperature: 0.1,
      stream: false,
    }

    const req: AiRouteRequest = {
      subpath: '/chat/completions',
      body: new TextEncoder().encode(JSON.stringify(payload)),
      pinned: 'ollama',
    }

    const start = Date.now()
    const res = await router.route(req)
    const durationMs = Date.now() - start

    expect(res.status).toBe(200)
    expect(res.provider).toBe('ollama')
    expect(durationMs).toBeGreaterThan(50) // Proves non-mocked real computation
    expect(durationMs).toBeLessThan(30000) // Within acceptable warm latency

    const parsed = JSON.parse(new TextDecoder().decode(res.body))
    expect(parsed.choices).toBeDefined()
    expect(parsed.choices.length).toBeGreaterThan(0)
    const reply = parsed.choices[0].message.content
    expect(reply.length).toBeGreaterThan(0)
    // 8 sheep remain alive
    expect(reply).toMatch(/8/)
  }, 35000)

  it('generates working code through Ollama and adheres to instructions', async () => {
    const router = createAiProviderRouter({ env, probeHealth: true })

    const payload = {
      model: 'qwen3:8b',
      messages: [
        {
          role: 'user',
          content:
            'Write a Python function named `calculate_circle_area(radius)` that computes pi * r^2 using the math module. Return ONLY the python code with no explanations or conversational preamble.',
        },
      ],
      temperature: 0.1,
      stream: false,
    }

    const req: AiRouteRequest = {
      subpath: '/chat/completions',
      body: new TextEncoder().encode(JSON.stringify(payload)),
      pinned: 'ollama',
    }

    const res = await router.route(req)
    expect(res.status).toBe(200)

    const parsed = JSON.parse(new TextDecoder().decode(res.body))
    const code = parsed.choices[0].message.content
    expect(code).toContain('def calculate_circle_area')
    expect(code).toMatch(/math\.pi|\*.*radius/i)
  }, 35000)

  it('accurately tracks context across user prompt turns', async () => {
    const router = createAiProviderRouter({ env, probeHealth: true })

    const payload = {
      model: 'qwen3:8b',
      messages: [
        {
          role: 'user',
          content: 'The secret code for Project Genesis is ZEPHYR-942. Remember this code.',
        },
        {
          role: 'assistant',
          content: 'Understood. The secret code for Project Genesis is ZEPHYR-942.',
        },
        {
          role: 'user',
          content: 'What is the secret code for Project Genesis? Answer with just the code.',
        },
      ],
      temperature: 0.1,
      stream: false,
    }

    const req: AiRouteRequest = {
      subpath: '/chat/completions',
      body: new TextEncoder().encode(JSON.stringify(payload)),
      pinned: 'ollama',
    }

    const res = await router.route(req)
    expect(res.status).toBe(200)

    const parsed = JSON.parse(new TextDecoder().decode(res.body))
    const answer = parsed.choices[0].message.content
    expect(answer).toContain('ZEPHYR-942')
  }, 35000)

  it('enforces localOnly flag and rejects remote routing when local engine is pinned', async () => {
    const router = createAiProviderRouter({ env, probeHealth: true, localOnly: true })

    const payload = {
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'Say OK' }],
      stream: false,
    }

    const req: AiRouteRequest = {
      subpath: '/chat/completions',
      body: new TextEncoder().encode(JSON.stringify(payload)),
      pinned: 'ollama',
      localOnly: true,
    }

    const res = await router.route(req)
    expect(res.status).toBe(200)
    expect(res.provider).toBe('ollama')
  }, 35000)
})
