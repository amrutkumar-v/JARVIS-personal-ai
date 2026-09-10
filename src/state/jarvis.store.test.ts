import { describe, expect, it } from 'vitest'
import { useJarvisStore } from '../state/jarvis.store'

describe('jarvis store', () => {
  it('tracks honest capability defaults', () => {
    const caps = useJarvisStore.getState().capabilities
    expect(caps.aiConnected).toBe(false)
    expect(caps.callingEnabled).toBe(false)
    expect(caps.memoryEnabled).toBe(false)
  })

  it('transitions status like the engine drives it', () => {
    const api = useJarvisStore.getState()
    api.setCapabilities({ memoryEnabled: true, toolsEnabled: true })
    api.setStatus('listening')
    expect(useJarvisStore.getState().status).toBe('listening')
    api.setStatus('thinking')
    api.setStatus('speaking')
    api.setStatus('success')
    expect(useJarvisStore.getState().status).toBe('success')
  })

  it('buffers transcript lines of the current exchange', () => {
    const api = useJarvisStore.getState()
    api.setLastUser('hello jarvis')
    api.setLastAssistant('at your service')
    const s = useJarvisStore.getState()
    expect(s.lastUserText).toBe('hello jarvis')
    expect(s.lastAssistantText).toBe('at your service')
  })
})