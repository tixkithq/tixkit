import { describe, expect, it } from 'vitest';
import {
  adminApi,
  normalizeAdminAttendeeListItem,
  normalizeLiveCheckInScanResult,
} from '@/lib/api';

describe('check-in scan normalization', () => {
  it('returns accepted for valid unchecked-in attendee', async () => {
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
    await adminApi.scanTicket({
      eventId: 'evt_demo_001',
      qrPayload: 'tkt_002',
    });
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

  it('normalizes live attendee responses for check-in lookup UI', () => {
    expect(
      normalizeAdminAttendeeListItem({
        id: 'att_live_1',
        eventId: 'evt_1',
        orderId: 'ord_1',
        ticketId: 'tkt_live_1',
        ticketTypeId: 'tt_vip',
        firstName: 'Avery',
        lastName: 'Stone',
        email: 'avery@example.test',
        status: 'confirmed',
        checkedInAt: '2026-06-29T12:04:00.000Z',
        createdAt: '2026-06-29T11:00:00.000Z',
      }),
    ).toMatchObject({
      id: 'att_live_1',
      eventId: 'evt_1',
      orderId: 'ord_1',
      ticketId: 'tkt_live_1',
      ticketTypeName: 'tt_vip',
      name: 'Avery Stone',
      email: 'avery@example.test',
      status: 'active',
      checkInStatus: 'checked_in',
      checkedInAt: '2026-06-29T12:04:00.000Z',
      createdAt: '2026-06-29T11:00:00.000Z',
    });
  });
});
