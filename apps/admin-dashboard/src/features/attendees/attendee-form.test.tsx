import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AttendeeFormDialog } from './attendee-form';

const adminApiMock = vi.hoisted(() => ({
  updateAttendee: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  adminApi: adminApiMock,
}));

vi.mock('sonner', () => ({
  toast: toastMock,
}));

describe('AttendeeFormDialog', () => {
  beforeEach(() => {
    adminApiMock.updateAttendee.mockReset();
    adminApiMock.updateAttendee.mockResolvedValue({ ok: true, data: {} });
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  it('updates profile fields without exposing or sending lifecycle status', async () => {
    render(
      <AttendeeFormDialog
        attendee={{
          id: 'att_1',
          eventId: 'evt_1',
          eventTitle: 'Launch',
          orderId: 'ord_1',
          ticketId: 'tkt_1',
          ticketTypeName: 'General admission',
          name: 'Ada Lovelace',
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@example.test',
          phone: '+15555550123',
          status: 'active',
          checkInStatus: 'not_checked_in',
          createdAt: '2026-07-16T00:00:00.000Z',
        }}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Grace' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Hopper' } });
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'grace@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+15555550999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(adminApiMock.updateAttendee).toHaveBeenCalledWith('att_1', {
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.test',
        phone: '+15555550999',
      });
    });
    expect(adminApiMock.updateAttendee.mock.calls[0]?.[1]).not.toHaveProperty('status');

    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(adminApiMock.updateAttendee).toHaveBeenLastCalledWith('att_1', {
        firstName: 'Grace',
        lastName: null,
        email: 'grace@example.test',
        phone: null,
      });
    });
  });
});
