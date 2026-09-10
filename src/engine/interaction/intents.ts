import type { CapabilityDefinition } from '../capabilities/types'

/**
 * Phase 2.5 — deterministic capability discovery.
 *
 * These are NOT action-to-tool phrase mappings (natural actions continue to
 * resolve through the existing capability catalogue + provider). This module
 * only recognises a small set of META-requests ("what can you do?", "help me")
 * and answers them from the LIVE registered catalog — never from hard-coded
 * marketing text. It is pure data formatting; it never executes anything and
 * never grants permission.
 */

export type DirectIntent = 'capabilities' | 'help' | 'camera_on' | 'camera_off' | 'camera_see' | 'none'

/** Phase 2.7 — camera surface commands handled deterministically by the engine. */
export type CameraIntent = 'camera_on' | 'camera_off' | 'camera_see'

const DIRECT_GROUPS: ReadonlyArray<{ kind: Exclude<DirectIntent, 'none'>; phrases: readonly string[] }> = [
  {
    kind: 'capabilities',
    phrases: [
      'what can you do',
      'what can you help me with',
      'show me what you can do',
      'what are your capabilities',
      'what are you capable of',
      'what are your abilities',
      'what abilities do you have',
      'list your capabilities',
      'list your abilities',
      'what do you support',
    ],
  },
  {
    kind: 'help',
    phrases: ['help me', 'i need help', 'how can you help me', 'what help can you give', 'help'],
  },
  {
    kind: 'camera_on',
    phrases: [
      'turn on the camera',
      'turn the camera on',
      'start the camera',
      'open the camera',
      'switch on the camera',
      'enable the camera',
      'activate the camera',
      'show me the camera',
      'show the camera',
      'turn on the webcam',
      'turn the webcam on',
      'start the webcam',
    ],
  },
  {
    kind: 'camera_off',
    phrases: [
      'turn off the camera',
      'turn the camera off',
      'stop the camera',
      'close the camera',
      'switch off the camera',
      'disable the camera',
      'hide the camera',
      'turn off the webcam',
      'turn the webcam off',
      'stop the webcam',
    ],
  },
  {
    kind: 'camera_see',
    phrases: [
      'what do you see',
      'what can you see',
      'what are you looking at',
      'what do you see in the camera',
      'look at this',
      'look at this for me',
      'look at the camera',
      'describe what you see',
      'read this',
      'take a photo',
      'take a picture',
      'take a photo of me',
      'take a picture of me',
    ],
  },
]

/** Normalise: lowercase, collapse whitespace, drop terminal punctuation. */
export function normalizeRequest(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Recognise a deterministic meta-request, if any. Small and explicit. */
export function detectDirectIntent(text: string): DirectIntent {
  const normalized = normalizeRequest(text)
  for (const group of DIRECT_GROUPS) {
    for (const phrase of group.phrases) {
      if (normalized === phrase || normalized.startsWith(`${phrase} `) || normalized.endsWith(` ${phrase}`) || normalized.includes(` ${phrase} `)) {
        return group.kind
      }
    }
  }
  return 'none'
}

/** Human category label used for the user-facing catalogue. */
export function categoryLabel(category: string): string {
  switch (category) {
    case 'vision':
      return 'Visual interaction'
    case 'application':
      return 'Application control'
    case 'desktop':
      return 'Desktop control'
    case 'device':
      return 'Device & phone bridge'
    case 'files':
      return 'Files & folders'
    case 'system':
      return 'Knowledge & memory'
    case 'data':
      return 'Quick answers'
    default:
      return 'Other abilities'
  }
}

export interface CatalogEnvironment {
  applicationConnected: boolean
  observationConnected: boolean
  desktopConnected: boolean
  visionConnected: boolean
  deviceConnected: boolean
}

export interface CapabilityCatalogReply {
  title: string
  groups: Array<{ label: string; items: string[] }>
  notes: string[]
}

/** Group a live catalog into the user-facing reply structure. */
export function capabilityCatalogReply(
  catalog: CapabilityDefinition[],
  environment: CatalogEnvironment,
): CapabilityCatalogReply {
  const groups = new Map<string, string[]>()
  for (const cap of catalog) {
    const label = categoryLabel(cap.category)
    const items = groups.get(label) ?? []
    items.push(`- ${cap.name} — ${cap.description}`)
    groups.set(label, items)
  }

  const notes: string[] = []
  if (!environment.desktopConnected && !environment.applicationConnected) {
    notes.push(
      'Application and desktop control need the native agent connection, which is not active right now — so I cannot open apps, move the cursor, click or type yet. I will not pretend those work.',
    )
  } else if (groups.has('Application control') && !environment.applicationConnected) {
    notes.push('Application launching needs the native agent connection, which is not active right now.')
  }
  if (!environment.visionConnected) {
    notes.push(
      'Visual interaction needs a configured vision provider, which is not active right now — I cannot analyse or click on-screen targets yet.',
    )
  }
  if (!environment.deviceConnected) {
    notes.push(
      'The device & phone bridge needs the JARVIS Core backend connection, which is not active right now — I cannot reach companion phones or send them notifications yet.',
    )
  }

  const groupsOut = [...groups.entries()]
    .sort(([a], [b]) => CATEGORY_ORDER[a] - CATEGORY_ORDER[b] || a.localeCompare(b))
    .map(([label, items]) => ({ label, items }))

  return {
    title: 'Here is what I can help you with right now:',
    groups: groupsOut,
    notes,
  }
}

const CATEGORY_ORDER: Record<string, number> = {
  'Quick answers': 0,
  'Knowledge & memory': 1,
  'Files & folders': 2,
  'Application control': 3,
  'Desktop control': 4,
  'Visual interaction': 5,
  'Device & phone bridge': 6,
  'Other abilities': 7,
}

/** Render the reply as JARVIS's spoken/typed answer. */
export function renderCapabilityCatalogReply(reply: CapabilityCatalogReply): string {
  const parts = [reply.title]
  for (const group of reply.groups) {
    parts.push('', group.label.toUpperCase())
    parts.push(...group.items)
  }
  if (reply.notes.length > 0) {
    parts.push('')
    parts.push(...reply.notes)
  }
  return parts.join('\n')
}