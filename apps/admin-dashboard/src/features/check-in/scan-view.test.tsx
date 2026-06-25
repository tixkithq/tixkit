import { describe, expect, it } from 'vitest'
import { adminApi } from '@/lib/api'

describe('Check-in scan result', () => {
  it('returns accepted for valid unchecked-in attendee', async () => {
    // Use a known fixture attendee: att_001 in evt_demo_001 with ticketId tkt_001
    const result = await adminApi.scanTicket({
      eventId: 'evt_demo_001',
      qrPayload: 'tkt_001',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('accepted')
      if (result.data.status === 'accepted') {
        expect(result.data.attendee.name).toBe('Alice Johnson')
      }
    }
  })

  it('returns duplicate for already checked-in attendee', async () => {
    // First scan: accept
    await adminApi.scanTicket({
      eventId: 'evt_demo_001',
      qrPayload: 'tkt_002',
    })
    // Second scan: duplicate
    const result = await adminApi.scanTicket({
      eventId: 'evt_demo_001',
      qrPayload: 'tkt_002',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('duplicate')
    }
  })

  it('returns revoked for refunded attendee', async () => {
    // att_004 in evt_demo_004 has status 'refunded'
    const result = await adminApi.scanTicket({
      eventId: 'evt_demo_004',
      qrPayload: 'tkt_004',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('revoked')
    }
  })

  it('returns invalid for unknown ticket', async () => {
    const result = await adminApi.scanTicket({
      eventId: 'evt_demo_001',
      qrPayload: 'nonexistent_ticket',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('invalid')
    }
  })

  it('includes scannedAt timestamp in all results', async () => {
    const result = await adminApi.scanTicket({
      eventId: 'evt_demo_001',
      qrPayload: 'tkt_001',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.scannedAt).toBeDefined()
      expect(typeof result.data.scannedAt).toBe('string')
    }
  })
})
