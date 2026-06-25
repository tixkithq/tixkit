import { describe, expect, it } from 'vitest'
import { formatCurrency, formatNumber } from '../lib/format'

describe('format utilities', () => {
  it('formats currency from cents', () => {
    expect(formatCurrency(12345, 'USD')).toContain('123.45')
  })

  it('formats grouped numbers', () => {
    expect(formatNumber(1234567)).toBe('1,234,567')
  })
})
