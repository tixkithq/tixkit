import { describe, expect, it } from 'vitest'
import { buildTicketSalesWindowPayload, ticketSchema } from './ticket-type-form'

const validBase = {
  name: 'General Admission',
  priceCents: 2500,
  currency: 'USD',
}

describe('ticketSchema sales window refinement', () => {
  it('passes when salesEndAt is after salesStartAt', () => {
    const result = ticketSchema.safeParse({
      ...validBase,
      salesStartAt: '2026-08-15T19:00',
      salesEndAt: '2026-08-16T19:00',
    })
    expect(result.success).toBe(true)
  })

  it('passes when sales dates are omitted', () => {
    const result = ticketSchema.safeParse(validBase)
    expect(result.success).toBe(true)
  })

  it('fails when salesEndAt is before salesStartAt', () => {
    const result = ticketSchema.safeParse({
      ...validBase,
      salesStartAt: '2026-08-15T19:00',
      salesEndAt: '2026-08-14T19:00',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes('salesEndAt'),
      )
      expect(issue).toBeDefined()
      expect(issue?.message).toContain('after sales start')
    }
  })

  it('fails when salesEndAt equals salesStartAt', () => {
    const result = ticketSchema.safeParse({
      ...validBase,
      salesStartAt: '2026-08-15T19:00',
      salesEndAt: '2026-08-15T19:00',
    })
    expect(result.success).toBe(false)
  })
})

describe('buildTicketSalesWindowPayload', () => {
  it('converts datetime-local form values to backend ISO timestamps', () => {
    const payload = buildTicketSalesWindowPayload({
      salesStartAt: '2026-08-15T19:00',
      salesEndAt: '2026-08-16T19:00',
    })

    expect(payload.salesStartAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/)
    expect(payload.salesEndAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/)
    expect(payload.salesStartAt).not.toBe('2026-08-15T19:00')
  })
})
