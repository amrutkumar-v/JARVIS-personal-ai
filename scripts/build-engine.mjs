/**
 * Build the headless AssistantEngine bundle used by the persistent backend
 * TaskService (server/dist/engine.mjs).
 *
 * The source is browser-safe, but the bundle runs inside Node. Bundling keeps
 * the backend independent of the Vite dev server and lets TaskService import a
 * single self-contained ESM file with a file:// URL on Windows.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { rolldown } from 'rolldown'

const root = process.cwd()
const output = join(root, 'server', 'dist', 'engine.mjs')

mkdirSync(dirname(output), { recursive: true })

const bundle = await rolldown({
  input: join(root, 'src', 'engine', 'AssistantEngine.ts'),
  platform: 'node',
})

try {
  await bundle.write({
    file: output,
    format: 'esm',
  })
  console.log(`Built ${output}`)
} finally {
  await bundle.close()
}
