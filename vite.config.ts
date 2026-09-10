import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'

// https://vite.dev/config/
//
// Dev proxy (server-side key, dev only):
// When VITE_JARVIS_AI_USE_PROXY=true and VITE_JARVIS_AI_PROXY_TARGET is set,
// requests to /api/ai/* are forwarded to the AI endpoint by the Vite dev
// server, which injects the Authorization header from the SERVER's
// JARVIS_API_KEY env var. The key therefore never appears in the browser
// bundle — point JARVIS_AI_PROXY_URL at /api/ai in the client.
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
    plugins: [react()],
    build: {
      target: 'es2022',
      sourcemap: false,
    },
    server: { proxy },
  }
})