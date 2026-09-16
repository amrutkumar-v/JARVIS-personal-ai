import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAiProviderRouter, resolveLegacyProxy, type AiRouter } from './server/src/aiProvider.ts'

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
 * AI Provider Router and Device Bridge plugin for the Vite dev server.
 *
 * Reuses the SAME self-contained provider router as the production backend
 * (`server/src/aiProvider.ts`), so the dev server and the persistent backend
 * can never drift apart: same provider discovery, same capability routing,
 * same failover rules, same health report. The API keys never reach the
 * browser.
 */
function jarvisDevApiPlugin(env: Record<string, string>): Plugin {
  // Router env = env files (.env.local) overlaid on the shell's env, and the
  // historical single-upstream dev proxy (Gemini default / custom target).
  const mergedEnv: Record<string, string | undefined> = { ...env, ...process.env }
  return {
    name: 'jarvis-dev-api-proxy',
    configureServer(server) {
      const router: AiRouter = createAiProviderRouter({
        env: mergedEnv,
        legacy: resolveLegacyProxy(mergedEnv),
      })

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = req.url?.split('?')[0] || ''

        // Enable CORS for all /api endpoints
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        res.setHeader('Access-Control-Expose-Headers', 'x-jarvis-provider, x-jarvis-provider-model')

        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        // 1. AI Health Check — one rich, secret-free provider report.
        if (url === '/api/ai/health' || url === '/api/ai/health/') {
          const report = await router.getHealth()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(report))
          return
        }

        // 2. AI Chat Completions & Embeddings — routed by the provider router.
        if (url === '/api/ai/chat/completions' || url === '/api/ai/embeddings') {
          const subpath = url === '/api/ai/embeddings' ? '/embeddings' : '/chat/completions'

          // Read the raw request body once (never parsed before the router).
          const chunks: Buffer[] = []
          try {
            for await (const chunk of req) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'Failed to read request body.', code: 'BAD_BODY' } }))
            return
          }
          const body = Buffer.concat(chunks)

          const route = await router.route({
            subpath,
            body,
            pinned: typeof req.headers['x-jarvis-provider'] === 'string' ? req.headers['x-jarvis-provider'] : null,
          })

          if (route.errorCode === 'ai_not_configured') {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'ai_not_configured' }))
            return
          }
          if (route.errorCode === 'ai_upstream_unreachable') {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'ai_upstream_unreachable' }))
            return
          }
          if (route.errorCode === 'ai_upstream_timeout') {
            res.writeHead(504, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'ai_upstream_timeout' }))
            return
          }
          if (route.errorCode === 'unsupported_capability' || route.errorCode === 'provider_not_configured') {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: route.errorCode, message: route.errorMessage }))
            return
          }
          if (route.errorCode === 'invalid_body') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'invalid_body' }))
            return
          }

          if (route.provider !== 'none') res.setHeader('x-jarvis-provider', route.provider)
          if (route.model) res.setHeader('x-jarvis-provider-model', route.model)
          res.writeHead(route.status, { 'Content-Type': route.contentType })
          res.end(Buffer.from(route.body))
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