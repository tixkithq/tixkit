import { describe, expect, it } from 'vitest';
import { adminApi, normalizeLiveCheckInScanResult } from '@/lib/api';

describe('Check-in scan result', () => {
  it('returns accepted for valid unchecked-in attendee', async () => {
    // Use a known fixture attendee: att_001 in evt_demo_001 with ticketId tkt_001
    const result = await adminApi.scanTicket({
      eventId: 'evt_demo_001',
      qrPayload: 'tkt_001',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('accepted');
      if (result.data.status === 'accepted') {
        expect(result.data.attendee?.name).toBe('Alice Johnson');
      }
    }
  });

  it('returns duplicate for already checked-in attendee', async () => {
    // First scan: accept
    await adminApi.scanTicket({
      eventId: 'evt_demo_001',
      qrPayload: 'tkt_002',
    });
    // Second scan: duplicate
    const result = await adminApi.scanTicket({
      eventId: 'evt_demo_001',
      qrPayload: 'tkt_002',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('duplicate');
    }
  });

  it('returns revoked for refunded attendee', async () => {
    // att_004 in evt_demo_004 has status 'refunded'
    const result = await adminApi.scanTicket({
      eventId: 'evt_demo_004',
      qrPayload: 'tkt_004',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('revoked');
    }
  });

  it('returns invalid for unknown ticket', async () => {
    const result = await adminApi.scanTicket({
      eventId: 'evt_demo_001',
      qrPayload: 'nonexistent_ticket',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('invalid');
    }
  });

  it('trims pasted QR payloads before matching tickets', async () => {
    const result = await adminApi.scanTicket({
      eventId: 'evt_demo_002',
      qrPayload: '  tkt_003  ',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe('accepted');
      if (result.data.status === 'accepted') {
        expect(result.data.attendee?.name).toBe('Bob Smith');
      }
    }
  });

  it('includes scannedAt timestamp in all results', async () => {
    const result = await adminApi.scanTicket({
      eventId: 'evt_demo_001',
      qrPayload: 'tkt_001',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.scannedAt).toBeDefined();
      expect(typeof result.data.scannedAt).toBe('string');
    }
  });

  it('normalizes live accepted scan responses for the scanner UI', () => {
    const result = normalizeLiveCheckInScanResult(
      { outcome: 'accepted', ticketId: 'tkt_live_001', message: 'Check-in successful' },
      '2026-06-27T12:00:00.000Z',
    );

    expect(result).toEqual({
      status: 'accepted',
      message: 'Check-in successful',
      scannedAt: '2026-06-27T12:00:00.000Z',
    });
  });

  it('normalizes live duplicate scan responses for the scanner UI', () => {
    const result = normalizeLiveCheckInScanResult(
      { outcome: 'duplicate', ticketId: 'tkt_live_001', message: 'Check-in duplicate' },
      '2026-06-27T12:01:00.000Z',
    );

    expect(result).toEqual({
      status: 'duplicate',
      message: 'Check-in duplicate',
      scannedAt: '2026-06-27T12:01:00.000Z',
    });
  });

  it('normalizes live wrong-list scan responses for the scanner UI', () => {
    const result = normalizeLiveCheckInScanResult(
      {
        outcome: 'wrong_list',
        ticketId: 'tkt_live_001',
        message: 'Ticket is not valid for this list',
      },
      '2026-06-27T12:01:30.000Z',
    );

    expect(result).toEqual({
      status: 'wrong_list',
      message: 'Ticket is not valid for this list',
      scannedAt: '2026-06-27T12:01:30.000Z',
    });
  });

  it('normalizes live not_found scan responses as invalid for the scanner UI', () => {
    const result = normalizeLiveCheckInScanResult(
      { outcome: 'not_found', message: 'Check-in not_found' },
      '2026-06-27T12:02:00.000Z',
    );

    expect(result).toEqual({
      status: 'invalid',
      message: 'Check-in not_found',
      scannedAt: '2026-06-27T12:02:00.000Z',
    });
  });
});
