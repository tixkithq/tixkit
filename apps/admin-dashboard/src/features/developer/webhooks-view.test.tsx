import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhooksView } from './webhooks-view';
import { toast } from 'sonner';

const adminApiMock = vi.hoisted(() => ({
  listWebhookEndpoints: vi.fn(),
  listWebhookEvents: vi.fn(),
  replayWebhookEvent: vi.fn(),
  updateWebhookEndpoint: vi.fn(),
}));

const useAdminDataMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    adminApi: adminApiMock,
  };
});

vi.mock('@/hooks/use-admin-data', () => ({
  useAdminData: useAdminDataMock,
}));

vi.mock('./webhook-form', () => ({
  WebhookFormDrawer: ({ open }: { open?: boolean }) =>
    open ? <div data-testid="webhook-form-drawer" /> : null,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const endpoint = {
  id: 'wh_001',
  url: 'https://example.com/webhooks',
  description: 'Production webhook',
  events: ['order.created' as const, 'ticket.issued' as const],
  status: 'active' as const,
  failureCount: 0,
  lastDeliveryAt: '2026-07-01T10:00:00.000Z',
  createdAt: '2026-07-01T09:00:00.000Z',
};

const replayEvent = {
  id: 'whe_001',
  eventId: 'evt_webhook_001',
  deliveryId: 'whd_001',
  endpointId: endpoint.id,
  requestedEndpointId: endpoint.id,
  deliveryKey: 'wh_001:evt_webhook_001',
  eventType: 'order.created',
  status: 'delivered' as const,
  statusCode: 200,
  attemptCount: 1,
  deliveredAt: '2026-07-01T10:01:00.000Z',
  createdAt: '2026-07-01T10:00:30.000Z',
};

function mockLoadedEndpoints() {
  useAdminDataMock.mockReturnValue({
    data: [endpoint],
    loading: false,
    error: undefined,
    refetch: vi.fn(),
  });
}

function openWebhookActions() {
  const trigger = screen.getByRole('button', {
    name: `Webhook actions for ${endpoint.url}`,
  });
  fireEvent.pointerDown(trigger);
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown', code: 'ArrowDown' });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('WebhooksView', () => {
  it('shows a retryable replay-event load error before the true empty state', async () => {
    mockLoadedEndpoints();
    adminApiMock.listWebhookEvents
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'webhook_events_unavailable',
          message: 'Webhook delivery history is unavailable',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: [replayEvent],
      });

    const view = render(<WebhooksView />);

    openWebhookActions();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Replay events' }));

    await waitFor(() => {
      expect(view.getByText('Failed to load webhook events')).toBeInTheDocument();
    });
    expect(view.getByText('Webhook delivery history is unavailable')).toBeInTheDocument();
    expect(
      view.queryByText('No recent webhook events are available to replay for this endpoint.'),
    ).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('Webhook delivery history is unavailable');

    fireEvent.click(view.getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(adminApiMock.listWebhookEvents).toHaveBeenCalledTimes(2);
      expect(view.getByText('order.created')).toBeInTheDocument();
    });
    expect(adminApiMock.listWebhookEvents).toHaveBeenNthCalledWith(1, endpoint.id);
    expect(adminApiMock.listWebhookEvents).toHaveBeenNthCalledWith(2, endpoint.id);
    expect(view.getByText('delivered')).toBeInTheDocument();
  });
});
