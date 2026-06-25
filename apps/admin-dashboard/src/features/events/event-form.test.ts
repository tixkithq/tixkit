import { describe, expect, it } from 'vitest'
import { eventSchema } from './event-form'

const validBase = {
  title: 'Test Event',
  startsAt: '2026-08-15T19:00',
  timezone: 'America/New_York',
  currency: 'USD',
}

describe('eventSchema date order refinement', () => {
  it('passes when endsAt is after startsAt', () => {
    const result = eventSchema.safeParse({
      ...validBase,
      endsAt: '2026-08-16T19:00',
    })
    expect(result.success).toBe(true)
  })

  it('passes when endsAt is omitted', () => {
    const result = eventSchema.safeParse(validBase)
    expect(result.success).toBe(true)
  })

  it('fails when endsAt is before startsAt', () => {
    const result = eventSchema.safeParse({
      ...validBase,
      endsAt: '2026-08-14T19:00',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('endsAt'))
      expect(issue).toBeDefined()
      expect(issue?.message).toContain('after start date')
    }
  })

  it('fails when endsAt equals startsAt', () => {
    const result = eventSchema.safeParse({
      ...validBase,
      endsAt: '2026-08-15T19:00',
    })
    expect(result.success).toBe(false)
  })
})
