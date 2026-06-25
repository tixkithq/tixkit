import { describe, expect, it } from 'vitest'
import { cn, getPageNumbers, getDisplayNameInitials, sleep } from './utils'

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar')
  })

  it('handles conditional classes', () => {
    const isVisible = true
    expect(cn('base', !isVisible && 'hidden', 'visible')).toBe('base visible')
  })

  it('deduplicates tailwind classes', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4')
  })
})

describe('getPageNumbers', () => {
  it('returns all pages when total is 5 or less', () => {
    expect(getPageNumbers(1, 5)).toEqual([1, 2, 3, 4, 5])
  })

  it('returns pages near the beginning', () => {
    expect(getPageNumbers(1, 10)).toEqual([1, 2, 3, 4, '...', 10])
  })

  it('returns pages near the end', () => {
    const result = getPageNumbers(9, 10)
    expect(result).toContain(1)
    expect(result).toContain('...')
    expect(result).toContain(10)
    expect(result).toContain(7)
    expect(result).toContain(8)
    expect(result).toContain(9)
  })

  it('returns pages in the middle', () => {
    const result = getPageNumbers(5, 10)
    expect(result).toContain(1)
    expect(result).toContain('...')
    expect(result).toContain(4)
    expect(result).toContain(5)
    expect(result).toContain(6)
    expect(result).toContain(10)
  })
})

describe('getDisplayNameInitials', () => {
  it('returns initials for first and last name', () => {
    expect(getDisplayNameInitials('John Doe')).toBe('JD')
  })

  it('returns first two chars for single word', () => {
    expect(getDisplayNameInitials('John')).toBe('JO')
  })

  it('returns ? for empty string', () => {
    expect(getDisplayNameInitials('')).toBe('?')
  })

  it('handles multiple spaces', () => {
    expect(getDisplayNameInitials('  Jane  Marie  Smith  ')).toBe('JS')
  })
})

describe('sleep', () => {
  it('resolves after the specified time', async () => {
    const start = Date.now()
    await sleep(10)
    expect(Date.now() - start).toBeGreaterThanOrEqual(5)
  })
})
