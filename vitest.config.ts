import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.ts'

export default defineConfig(async (environment) => {
  const baseConfig = typeof viteConfig === 'function'
    ? await viteConfig(environment)
    : viteConfig

  // Vitest 4+ removed poolOptions; choose the supported pool directly.
  return mergeConfig(baseConfig, defineConfig({
    test: {
      pool: 'forks',
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/cypress/**',
        '**/.{idea,git,cache,output,temp}/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      ],
    },
  }))
})
