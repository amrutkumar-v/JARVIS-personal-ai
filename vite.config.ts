import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Production-only strict Content-Security-Policy
const CSP_HEADERS = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' https: http: ws: wss: data: blob:",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

function securityCspPlugin(): Plugin {
  return {
    name: 'jarvis-security-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content: CSP_HEADERS,
            },
            injectTo: 'head-prepend',
          },
        ],
      }
    },
  }
}

/**
 * Server-side AI Proxy and Device Bridge plugin for Vite dev server.
 * Ensures the API key (GEMINI_API_KEY / JARVIS_API_KEY) NEVER reaches the browser.
 */
function jarvisDevApiPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'jarvis-dev-api-proxy',
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = req.url?.split('?')[0] || ''

        // Enable CORS for all /api endpoints
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        // 1. AI Health Check
        if (url === '/api/ai/health' || url === '/api/ai/health/') {
          const geminiKey = process.env.GEMINI_API_KEY?.trim()
          const jarvisKey = env.JARVIS_API_KEY?.trim() || process.env.JARVIS_API_KEY?.trim() || env.OPENAI_API_KEY?.trim()
          const activeKey = geminiKey || jarvisKey

          if (!activeKey) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                status: 'MISCONFIGURED',
                code: 'MISCONFIGURED',
                message: 'No AI API key found in server environment.',
              }),
            )
            return
          }

          const baseUrl =
            geminiKey && !env.VITE_JARVIS_AI_PROXY_TARGET
              ? 'https://generativelanguage.googleapis.com/v1beta/openai'
              : env.VITE_JARVIS_AI_PROXY_TARGET?.trim() || 'https://generativelanguage.googleapis.com/v1beta/openai'
          const model = env.VITE_JARVIS_AI_MODEL?.trim() || 'gemini-3.6-flash'

          try {
            const probeController = new AbortController()
            const timer = setTimeout(() => probeController.abort(), 6000)
            const probeRes = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${activeKey}`,
              },
              body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1,
              }),
              signal: probeController.signal,
            })
            clearTimeout(timer)

            if (probeRes.status === 200) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(
                JSON.stringify({
                  status: 'CONNECTED',
                  code: 'CONNECTED',
                  model,
                  upstream: baseUrl,
                }),
              )
              return
            } else if (probeRes.status === 401 || probeRes.status === 403) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(
                JSON.stringify({
                  status: 'AUTHENTICATION_FAILED',
                  code: 'AUTHENTICATION_FAILED',
                  message: 'The AI service rejected the configured API key.',
                }),
              )
              return
            } else if (probeRes.status === 404) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(
                JSON.stringify({
                  status: 'MODEL_UNAVAILABLE',
                  code: 'MODEL_UNAVAILABLE',
                  message: `Model "${model}" is not available on the upstream AI service.`,
                }),
              )
              return
            } else if (probeRes.status === 429) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(
                JSON.stringify({
                  status: 'RATE_LIMITED',
                  code: 'RATE_LIMITED',
                  message: 'The AI service is currently rate limited.',
                }),
              )
              return
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(
                JSON.stringify({
                  status: 'DISCONNECTED',
                  code: 'DISCONNECTED',
                  message: `Upstream AI service answered with HTTP ${probeRes.status}.`,
                }),
              )
              return
            }
          } catch (err: unknown) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                status: 'NETWORK_ERROR',
                code: 'NETWORK_ERROR',
                message: err instanceof Error ? err.message : 'Cannot reach upstream AI service.',
              }),
            )
            return
          }
        }

        // 2. AI Chat Completions & Embeddings Proxy
        if (url === '/api/ai/chat/completions' || url === '/api/ai/embeddings') {
          const geminiKey = process.env.GEMINI_API_KEY?.trim()
          const jarvisKey = env.JARVIS_API_KEY?.trim() || process.env.JARVIS_API_KEY?.trim() || env.OPENAI_API_KEY?.trim()
          const activeKey = geminiKey || jarvisKey

          if (!activeKey) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({
                error: {
                  message: 'No AI API key is configured on the server.',
                  type: 'misconfigured',
                  code: 'MISCONFIGURED',
                },
              }),
            )
            return
          }

          const defaultBase =
            geminiKey && !env.VITE_JARVIS_AI_PROXY_TARGET
              ? 'https://generativelanguage.googleapis.com/v1beta/openai'
              : env.VITE_JARVIS_AI_PROXY_TARGET?.trim() || 'https://generativelanguage.googleapis.com/v1beta/openai'

          const endpointPath = url === '/api/ai/embeddings' ? '/embeddings' : '/chat/completions'
          const upstreamUrl = `${defaultBase.replace(/\/+$/, '')}${endpointPath}`

          // Read request body safely
          let rawBody = ''
          if ((req as unknown as { body?: unknown }).body) {
            const b = (req as unknown as { body?: unknown }).body
            rawBody = typeof b === 'string' ? b : JSON.stringify(b)
          } else {
            rawBody = await new Promise<string>((resolve, reject) => {
              const chunks: Buffer[] = []
              req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
              req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
              req.on('error', reject)
            })
          }

          let bodyObj: Record<string, unknown> = {}
          try {
            if (rawBody) bodyObj = JSON.parse(rawBody)
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Invalid JSON body.' } }))
            return
          }

          // Inject appropriate default model if not provided or empty
          if (!bodyObj.model) {
            bodyObj.model = url === '/api/ai/embeddings' ? 'gemini-embedding-2-preview' : 'gemini-3.6-flash'
          } else if (bodyObj.model === 'gemini-2.5-flash') {
            bodyObj.model = 'gemini-3.6-flash'
          } else if (bodyObj.model === 'text-embedding-004') {
            bodyObj.model = 'gemini-embedding-2-preview'
          }

          // Execute with retry logic (up to 2 retries on 429/503)
          let lastStatus = 500
          let lastText = ''
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const controller = new AbortController()
              const timeout = setTimeout(() => controller.abort(), 60000)

              const upstreamRes = await fetch(upstreamUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${activeKey}`,
                },
                body: JSON.stringify(bodyObj),
                signal: controller.signal,
              })
              clearTimeout(timeout)

              lastStatus = upstreamRes.status
              lastText = await upstreamRes.text()

              if (upstreamRes.status === 429 || upstreamRes.status === 503) {
                if (attempt < 2) {
                  await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
                  continue
                }
              }

              res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' })
              res.end(lastText)
              return
            } catch (err: unknown) {
              if (attempt < 2) {
                await new Promise((resolve) => setTimeout(resolve, 800))
                continue
              }
              const isAbort = err instanceof Error && err.name === 'AbortError'
              res.writeHead(isAbort ? 504 : 502, { 'Content-Type': 'application/json' })
              res.end(
                JSON.stringify({
                  error: {
                    message: isAbort ? 'AI request timed out.' : 'Failed to reach AI service.',
                    type: isAbort ? 'timeout' : 'network_error',
                    code: isAbort ? 'TIMEOUT' : 'NETWORK_ERROR',
                  },
                }),
              )
              return
            }
          }

          res.writeHead(lastStatus, { 'Content-Type': 'application/json' })
          res.end(lastText)
          return
        }

        next()
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    define: mode !== 'test' ? {
      'import.meta.env.VITE_JARVIS_AI_PROXY_URL': JSON.stringify(env.VITE_JARVIS_AI_PROXY_URL || '/api/ai'),
      'import.meta.env.VITE_JARVIS_AI_MODEL': JSON.stringify(env.VITE_JARVIS_AI_MODEL || 'gemini-3.6-flash'),
    } : {},
    plugins: [react(), securityCspPlugin(), jarvisDevApiPlugin(env)],
    build: {
      target: 'es2022',
      sourcemap: false,
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
    },
  }
})