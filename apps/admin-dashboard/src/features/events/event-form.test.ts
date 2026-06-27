import { describe, expect, it } from 'vitest'
import { buildEventDatePayload, buildEventUpdatePayload, eventSchema } from './event-form'

const validBase = {
  title: 'Test Event',
  startsAt: '2026-08-15T19:00',
  timezone: 'America/New_York',
  visibility: 'public',
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
      timezone: 'America/New_York',
    })

    expect(payload?.startsAt).toBe('2026-08-15T23:00:00.000Z')
    expect(payload?.endsAt).toBe('2026-08-16T23:00:00.000Z')
  })
})

describe('buildEventUpdatePayload', () => {
  const fullValues = {
    title: 'Updated Event',
    slug: 'updated-event',
    description: '',
    startsAt: '2026-08-15T19:00',
    endsAt: '',
    timezone: 'America/New_York',
    status: 'published' as const,
    visibility: 'private' as const,
    venueName: '',
    address: '',
    city: '',
    region: '',
    postalCode: '',
    country: '',
    capacity: undefined,
    coverImageUrl: '',
    externalUrl: '',
    seoTitle: '',
    seoDescription: '',
    seoImageUrl: '',
    currency: 'USD',
  }

  it('omits unchanged fields from update payloads', () => {
    expect(buildEventUpdatePayload(fullValues, {})).toEqual({})
  })

  it('sends null when nullable detail fields are cleared', () => {
    expect(buildEventUpdatePayload(fullValues, {
      capacity: true,
      coverImageUrl: true,
      externalUrl: true,
      endsAt: true,
      venueName: true,
    })).toMatchObject({
      capacity: null,
      coverImageUrl: null,
      externalUrl: null,
      endsAt: null,
      venue: null,
    })
  })

  it('preserves explicit values for editable detail fields', () => {
    expect(buildEventUpdatePayload({
      ...fullValues,
      description: 'Detailed description',
      endsAt: '2026-08-16T19:00',
      venueName: 'Main Hall',
      address: '1 Market St',
      city: 'New York',
      region: 'NY',
      postalCode: '10001',
      country: 'US',
      capacity: 250,
      coverImageUrl: 'https://example.com/cover.jpg',
      externalUrl: 'https://example.com/event',
      seoTitle: 'SEO title',
      seoDescription: 'SEO description',
      seoImageUrl: 'https://example.com/seo.jpg',
    }, {
      description: true,
      endsAt: true,
      venueName: true,
      address: true,
      city: true,
      region: true,
      postalCode: true,
      country: true,
      capacity: true,
      coverImageUrl: true,
      externalUrl: true,
      seoTitle: true,
      seoDescription: true,
      seoImageUrl: true,
      visibility: true,
      status: true,
    })).toMatchObject({
      description: 'Detailed description',
      endsAt: '2026-08-16T23:00:00.000Z',
      venue: {
        name: 'Main Hall',
        address: '1 Market St',
        city: 'New York',
        region: 'NY',
        postalCode: '10001',
        country: 'US',
      },
      capacity: 250,
      coverImageUrl: 'https://example.com/cover.jpg',
      externalUrl: 'https://example.com/event',
      seo: {
        title: 'SEO title',
        description: 'SEO description',
        imageUrl: 'https://example.com/seo.jpg',
      },
      visibility: 'private',
      status: 'published',
    })
  })
})
