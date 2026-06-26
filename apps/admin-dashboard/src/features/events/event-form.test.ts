import { describe, expect, it } from 'vitest'
import { buildEventDatePayload, eventSchema } from './event-form'

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

describe('buildEventDatePayload', () => {
  it('converts datetime-local form values to backend ISO timestamps', () => {
    const payload = buildEventDatePayload({
      startsAt: '2026-08-15T19:00',
      endsAt: '2026-08-16T19:00',
    })

    expect(payload?.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/)
    expect(payload?.endsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/)
    expect(payload?.startsAt).not.toBe('2026-08-15T19:00')
  })
})
