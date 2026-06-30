import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminApi,
  normalizeAdminAttendeeListItem,
  normalizeLiveCheckInScanResult,
} from '@/lib/api';
import { EventCheckInView } from '@/features/events/event-check-in-view';

afterEach(() => {
  vi.restoreAllMocks();
});

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
        status: 'active',
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

  it('renders normalized live attendee rows in manual lookup', async () => {
    vi.spyOn(adminApi, 'getEvent').mockResolvedValue({
      ok: true,
      data: {
        id: 'evt_1',
        title: 'Spring Gala',
        slug: 'spring-gala',
        status: 'published',
        startsAt: '2026-07-01T19:00:00.000Z',
        endsAt: '2026-07-01T23:00:00.000Z',
        timezone: 'America/New_York',
        venueName: 'Main Hall',
        city: 'New York',
        visibility: 'public',
        seo: {},
        currency: 'USD',
        resalePolicy: { enabled: false, maxMultiplier: 1 },
        grossSalesCents: 250000,
        ticketsSold: 25,
        capacity: 100,
        checkIns: 10,
        updatedAt: '2026-06-29T12:00:00.000Z',
      },
    });
    vi.spyOn(adminApi, 'listCheckInLists').mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'cil_1',
          eventId: 'evt_1',
          name: 'Main Door',
          ticketTypeIds: ['tt_1'],
          status: 'active',
        },
      ],
    });
    vi.spyOn(adminApi, 'listAttendees').mockResolvedValue({
      ok: true,
      data: {
        items: [
          normalizeAdminAttendeeListItem({
            id: 'att_live_1',
            eventId: 'evt_1',
            orderId: 'ord_1',
            ticketId: 'tkt_live_1',
            ticketTypeId: 'tt_vip',
            firstName: 'Avery',
            lastName: 'Stone',
            email: 'avery@example.test',
            status: 'active',
            checkedInAt: '2026-06-29T12:04:00.000Z',
            createdAt: '2026-06-29T11:00:00.000Z',
          }),
        ],
        total: 1,
      },
    });

    render(<EventCheckInView eventId="evt_1" />);

    expect(await screen.findByText('Avery Stone')).toBeInTheDocument();
    expect(screen.getByText('tt_vip')).toBeInTheDocument();
    expect(screen.getByText('Checked in')).toBeInTheDocument();

    const manualSearch = screen.getByPlaceholderText('Search by name, email, or ticket ID');
    fireEvent.change(manualSearch, { target: { value: 'avery' } });

    expect(await screen.findByText('Avery Stone')).toBeInTheDocument();
  });

  it('updates the visible checked-in summary after an accepted scan', async () => {
    vi.spyOn(adminApi, 'getEvent').mockResolvedValue({
      ok: true,
      data: {
        id: 'evt_1',
        title: 'Spring Gala',
        slug: 'spring-gala',
        status: 'published',
        startsAt: '2026-07-01T19:00:00.000Z',
        endsAt: '2026-07-01T23:00:00.000Z',
        timezone: 'America/New_York',
        venueName: 'Main Hall',
        city: 'New York',
        visibility: 'public',
        seo: {},
        currency: 'USD',
        resalePolicy: { enabled: false, maxMultiplier: 1 },
        grossSalesCents: 250000,
        ticketsSold: 25,
        capacity: 100,
        checkIns: 10,
        updatedAt: '2026-06-29T12:00:00.000Z',
      },
    });
    vi.spyOn(adminApi, 'listCheckInLists').mockResolvedValue({
      ok: true,
      data: [
        {
          id: 'cil_1',
          eventId: 'evt_1',
          name: 'Main Door',
          ticketTypeIds: ['tt_1'],
          status: 'active',
        },
      ],
    });
    vi.spyOn(adminApi, 'listAttendees').mockResolvedValue({
      ok: true,
      data: { items: [], total: 0 },
    });
    vi.spyOn(adminApi, 'scanTicket').mockResolvedValue({
      ok: true,
      data: {
        status: 'accepted',
        message: 'Check-in successful',
        scannedAt: '2026-06-29T12:05:00.000Z',
      },
    });

    render(<EventCheckInView eventId="evt_1" />);

    const checkedInLabel = await screen.findByText('Checked In');
    expect(checkedInLabel.nextElementSibling).toHaveTextContent('10');

    const scannerInput = await screen.findByPlaceholderText('Enter QR code or ticket ID');
    await waitFor(() => {
      expect(scannerInput).not.toBeDisabled();
    });
    fireEvent.change(scannerInput, { target: { value: 'signed-ticket-payload' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));

    await waitFor(() => {
      expect(checkedInLabel.nextElementSibling).toHaveTextContent('11');
    });
    expect(adminApi.scanTicket).toHaveBeenCalledWith({
      eventId: 'evt_1',
      checkInListId: 'cil_1',
      qrPayload: 'signed-ticket-payload',
      scannedAt: expect.any(String),
    });
  });
});
