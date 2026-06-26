import { describe, expect, it } from 'vitest'
import { isoToLocalDatetimeInput, localDatetimeInputToIso } from './datetime'

describe('admin datetime helpers', () => {
  it('converts datetime-local input to backend ISO timestamp', () => {
    expect(localDatetimeInputToIso('2026-08-15T19:00')).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/,
    )
  })

  it('converts ISO timestamps to datetime-local input format', () => {
    expect(isoToLocalDatetimeInput('2026-08-15T23:00:00.000Z')).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:00$/,
    )
  })

  it('returns empty/undefined for missing or invalid values', () => {
    expect(isoToLocalDatetimeInput(undefined)).toBe('')
    expect(isoToLocalDatetimeInput('not-a-date')).toBe('')
    expect(localDatetimeInputToIso('')).toBeUndefined()
    expect(localDatetimeInputToIso('not-a-date')).toBeUndefined()
  })
})
