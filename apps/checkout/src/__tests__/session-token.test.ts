import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  storeSessionToken,
  getSessionToken,
  clearSessionToken,
} from '../lib/session-token'

// Mock sessionStorage for node environment.
const store = new Map<string, string>()

vi.stubGlobal('sessionStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
  clear: () => store.clear(),
})

vi.stubGlobal('window', {
  sessionStorage: globalThis.sessionStorage,
})

describe('session-token storage', () => {
  beforeEach(() => {
    store.clear()
  })

  it('stores and retrieves a token by sessionId', () => {
    storeSessionToken('cs_123', 'tok_abc')
    expect(getSessionToken('cs_123')).toBe('tok_abc')
  })

  it('returns undefined for unknown sessionId', () => {
    expect(getSessionToken('cs_unknown')).toBeUndefined()
  })

  it('clears a token by sessionId', () => {
    storeSessionToken('cs_456', 'tok_xyz')
    expect(getSessionToken('cs_456')).toBe('tok_xyz')
    clearSessionToken('cs_456')
    expect(getSessionToken('cs_456')).toBeUndefined()
  })

  it('uses a gk:session: prefix for storage keys', () => {
    storeSessionToken('cs_789', 'tok_prefix')
    expect(store.get('gk:session:cs_789')).toBe('tok_prefix')
  })
})
