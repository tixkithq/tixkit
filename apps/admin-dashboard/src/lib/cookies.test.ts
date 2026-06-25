import { describe, expect, it, beforeEach } from 'vitest'
import { getCookie, setCookie, removeCookie } from './cookies'

describe('cookies', () => {
  beforeEach(() => {
    document.cookie.split(';').forEach((c) => {
      const name = c.split('=')[0]?.trim()
      if (name) document.cookie = `${name}=; path=/; max-age=0`
    })
  })

  it('setCookie and getCookie round-trip', () => {
    setCookie('test_key', 'test_value')
    expect(getCookie('test_key')).toBe('test_value')
  })

  it('getCookie returns undefined for missing key', () => {
    expect(getCookie('nonexistent')).toBeUndefined()
  })

  it('removeCookie deletes a cookie', () => {
    setCookie('to_remove', 'value')
    expect(getCookie('to_remove')).toBe('value')
    removeCookie('to_remove')
    expect(getCookie('to_remove')).toBeUndefined()
  })

  it('setCookie respects maxAge', () => {
    setCookie('temp_key', 'temp_value', 0)
    expect(getCookie('temp_key')).toBeUndefined()
  })
})
