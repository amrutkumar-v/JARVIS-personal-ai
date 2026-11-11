import { readdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const bundleRoot = resolve('dist')
const sourceFiles = [
  'src/native/nativeAgentEnv.ts',
  'src/backend/config.ts',
]
const forbiddenNames = [
  'JARVIS_NATIVE_TOKEN',
  'JARVIS_BACKEND_NATIVE_TOKEN',
  'JARVIS_BACKEND_TOKEN',
  'VITE_NATIVE_AGENT_TOKEN',
  'VITE_JARVIS_BACKEND_TOKEN',
]
const violations = []

for (const path of sourceFiles) {
  const source = await readFile(resolve(path), 'utf8')
  for (const name of forbiddenNames) {
    if (source.includes(name)) violations.push(`${path} reads or names ${name}`)
  }
}

async function filesUnder(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(path))
    else files.push(path)
  }
  return files
}

let bundleFiles
try {
  bundleFiles = await filesUnder(bundleRoot)
} catch {
  throw new Error('Production frontend bundle is missing; run the production build before the credential scan.')
}

const textFiles = bundleFiles.filter((path) => /\.(?:js|mjs|html|css|json|map)$/i.test(path))
const bundleText = (await Promise.all(textFiles.map((path) => readFile(path, 'utf8')))).join('\n')
for (const name of forbiddenNames) {
  if (bundleText.includes(name)) violations.push(`production frontend bundle contains ${name}`)
}

// Scan configured secret values without printing or otherwise exposing them.
const secretValues = new Map()
for (const envPath of ['.env.local', '.env', '.env.production.local']) {
  let contents
  try {
    contents = await readFile(resolve(envPath), 'utf8')
  } catch {
    continue
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match || !/(?:TOKEN|API_KEY|SECRET|PASSWORD)/i.test(match[1])) continue
    const value = match[2].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted)
    if (value.length >= 8) secretValues.set(match[1], value)
  }
}
for (const [name, value] of secretValues) {
  if (bundleText.includes(value)) violations.push(`production frontend bundle contains a configured value from ${name}`)
}

if (violations.length > 0) {
  throw new Error(`Frontend credential boundary check failed:\n${violations.map((item) => `- ${item}`).join('\n')}`)
}
process.stdout.write(`Frontend credential boundary verified across ${textFiles.length} production artifacts.\n`)
