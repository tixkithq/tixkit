import { describe, expect, it } from 'vitest'
import { adminApi } from '@/lib/api'

describe('API key create/revoke', () => {
  it('listApiKeys returns fixture keys', async () => {
    const result = await adminApi.listApiKeys()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.length).toBeGreaterThan(0)
      expect(result.data[0].id).toBeDefined()
      expect(result.data[0].name).toBeDefined()
      expect(result.data[0].keyPrefix).toBeDefined()
    }
  })

  it('createApiKey returns a new key with the real one-time secret + scopes', async () => {
    const scopes = ['events:read', 'orders:read', 'reports:read']
    const result = await adminApi.createApiKey({
      name: 'Test Key',
      scopes,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.name).toBe('Test Key')
      expect(result.data.id).toBeDefined()
      expect(result.data.keyPrefix).toMatch(/^tk_live_/)
      // The backend returns the full secret exactly once on creation.
      expect(result.data.apiKey).toBeDefined()
      expect(result.data.apiKey).toMatch(/^tk_live_/)
      expect(result.data.scopes).toEqual(scopes)
    }
  })

  it('revokeApiKey deletes the key', async () => {
    // Create a key first
    const createResult = await adminApi.createApiKey({
      name: 'Key to Revoke',
      scopes: ['events:read'],
    })
    expect(createResult.ok).toBe(true)
    if (!createResult.ok) return

    const keyId = createResult.data.id
    const revokeResult = await adminApi.revokeApiKey(keyId)
    expect(revokeResult.ok).toBe(true)
    if (revokeResult.ok) {
      // The key should be returned from the mock
      expect(revokeResult.data.id).toBe(keyId)
      // And no longer in the list
      const listResult = await adminApi.listApiKeys()
      if (listResult.ok) {
        expect(listResult.data.find((k) => k.id === keyId)).toBeUndefined()
      }
    }
  })

  it('revokeApiKey returns error for nonexistent key', async () => {
    const result = await adminApi.revokeApiKey('nonexistent_key')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('not_found')
      expect(result.error.status).toBe(404)
    }
  })
})
