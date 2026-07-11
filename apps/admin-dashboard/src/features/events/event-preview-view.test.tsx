import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { EventPreviewView } from './event-preview-view';

const acknowledge = vi.hoisted(() => vi.fn());
vi.mock('@/features/content-editor/event-page-persisted-editor-view', async () => {
  const React = await import('react');
  return {
    EventPagePersistedEditorView: ({ onPreviewReady }: { onPreviewReady?: () => void }) => {
      React.useEffect(() => onPreviewReady?.(), [onPreviewReady]);
      return React.createElement('div', { 'data-testid': 'authenticated-event-page-preview' });
    },
  };
});
vi.mock('@/lib/api', () => ({ adminApi: { getEvent: vi.fn(), listTicketTypes: vi.fn(), listProducts: vi.fn(), listCheckoutQuestions: vi.fn(), acknowledgeReadinessStep: acknowledge } }));
vi.mock('@/hooks/use-admin-table-data', () => ({ useAdminQuery: (key: string[]) => {
  if (key[0] === 'getEvent') return { data: { id: 'evt_1', title: 'Preview event', status: 'draft', startsAt: '2027-01-01T18:00:00Z', timezone: 'UTC', currency: 'USD', description: 'Description' }, loading: false };
  if (key[0] === 'listTicketTypes') return { data: [{ id: 'tt_1', name: 'GA', kind: 'paid', priceCents: 2500, currency: 'USD' }], loading: false };
  if (key[0] === 'listProducts') return { data: [], loading: false };
  return { data: [{ id: 'q_1', label: 'Name', required: true }], loading: false };
} }));

describe('EventPreviewView', () => {
  it('marks preview clearly, supports mobile presentation, and explicitly acknowledges review', async () => {
    acknowledge.mockResolvedValue({ ok: true, data: {} });
    render(<EventPreviewView eventId="evt_1" />);
    expect(screen.getByText(/Preview — no real charge/i)).toBeInTheDocument();
    expect(screen.getByText('$25.00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mobile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark preview reviewed' }));
    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith('evt_1', 'preview_review'));
    expect(screen.getByText('Preview marked reviewed.')).toBeInTheDocument();
  });
});
