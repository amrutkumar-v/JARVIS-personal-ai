import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite'

// https://vite.dev/config/
//
// Dev proxy (server-side key, dev only):
// When VITE_JARVIS_AI_USE_PROXY=true and VITE_JARVIS_AI_PROXY_TARGET is set,
// requests to /api/ai/* are forwarded to the AI endpoint by the Vite dev
// server, which injects the Authorization header from the SERVER's
// JARVIS_API_KEY env var. The key therefore never appears in the browser
// bundle — point JARVIS_AI_PROXY_URL at /api/ai in the client.

// Production-only strict Content-Security-Policy (referenced from external:
// remote media stays behind the local bridge proxy, never loaded directly).
// Dev is deliberately CSP-free: Vite injects react-refresh inline preamble
// scripts and an HMR websocket, which a strict policy would break.
const CSP_HEADERS = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* http://192.168.*",
  "frame-ancestors 'none'",
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_JARVIS_AI_PROXY_TARGET?.trim()
  const serverKey = env.JARVIS_API_KEY?.trim()

  const proxy: Record<string, ProxyOptions> = {}
  if (env.VITE_JARVIS_AI_USE_PROXY === 'true' && target) {
    proxy['/api/ai'] = {
      target,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api\/ai/, ''),
      configure(proxyServer) {
        proxyServer.on('proxyReq', (proxyReq: { setHeader: (k: string, v: string) => void }) => {
          if (serverKey) {
            proxyReq.setHeader('Authorization', `Bearer ${serverKey}`)
          }
        })
      },
    }
  }

  return {
    plugins: [react(), securityCspPlugin()],
    build: {
      target: 'es2022',
      sourcemap: false,
    },
    server: { proxy },
  }
})