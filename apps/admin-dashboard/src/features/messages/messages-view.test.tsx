import { fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventMessagesView } from '@/features/events/event-messages-view';
import { MessageFormDialog } from './message-form';
import { MessageCampaignDetailPanel, MessagesView } from './messages-view';

if (typeof window === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
  });
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

afterEach(() => {
  document.body.innerHTML = '';
  for (const mock of Object.values(adminApiMock)) {
    mock.mockReset();
  }
});

type MessagesAdminApiMock = {
  listEvents: ReturnType<typeof vi.fn>;
  getEvent: ReturnType<typeof vi.fn>;
  listContentDocuments: ReturnType<typeof vi.fn>;
  listMessages: ReturnType<typeof vi.fn>;
  previewMessageRecipients: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  getMessage: ReturnType<typeof vi.fn>;
  listMessageJobs: ReturnType<typeof vi.fn>;
  listMessageDeliveryLogs: ReturnType<typeof vi.fn>;
  listMessageProviderEvents: ReturnType<typeof vi.fn>;
};

function getAdminApiMock(): MessagesAdminApiMock {
  const globalWithMock = globalThis as typeof globalThis & {
    messagesAdminApiMock?: MessagesAdminApiMock;
  };
  globalWithMock.messagesAdminApiMock ??= {
    listEvents: vi.fn(),
    getEvent: vi.fn(),
    listContentDocuments: vi.fn(),
    listMessages: vi.fn(),
    previewMessageRecipients: vi.fn(),
    sendMessage: vi.fn(),
    getMessage: vi.fn(),
    listMessageJobs: vi.fn(),
    listMessageDeliveryLogs: vi.fn(),
    listMessageProviderEvents: vi.fn(),
  };
  return globalWithMock.messagesAdminApiMock;
}

vi.mock('@/lib/api', () => ({
  adminApi: getAdminApiMock(),
}));

const adminApiMock = getAdminApiMock();

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    defaultValue,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) => (
    <select
      value={value ?? defaultValue}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: ({ placeholder }: { placeholder?: string }) =>
    placeholder ? (
      <option value="" disabled>
        {placeholder}
      </option>
    ) : null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function contentDocument(
  overrides: Partial<{
    id: string;
    channel: 'email' | 'sms';
    key: string;
    name: string;
    eventId?: string;
    status: 'draft' | 'published' | 'archived';
    publishedVersionId?: string;
  }> = {},
) {
  const channel = overrides.channel ?? 'email';
  const id = overrides.id ?? `cdoc_${channel}`;
  return {
    id,
    tenantId: 'tnt_1',
    organizationId: 'org_1',
    brandId: 'brd_1',
    eventId: overrides.eventId ?? 'evt_1',
    channel,
    key: overrides.key ?? `${channel}-reminder`,
    name: overrides.name ?? `${channel === 'email' ? 'Email' : 'SMS'} reminder`,
    status: overrides.status ?? 'published',
    locale: 'en',
    publishedVersionId: overrides.publishedVersionId ?? `cver_${channel}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function mockContentDocuments(input?: {
  email?: ReturnType<typeof contentDocument>[];
  sms?: ReturnType<typeof contentDocument>[];
  brandEmail?: ReturnType<typeof contentDocument>[];
  brandSms?: ReturnType<typeof contentDocument>[];
}) {
  const email = input?.email ?? [
    contentDocument({ channel: 'email', key: 'door-reminder-email', name: 'Door reminder email' }),
  ];
  const sms = input?.sms ?? [
    contentDocument({ channel: 'sms', key: 'door-reminder-sms', name: 'Door reminder SMS' }),
  ];
  const brandEmail = input?.brandEmail ?? [];
  const brandSms = input?.brandSms ?? [];
  adminApiMock.getEvent.mockResolvedValue({
    ok: true,
    data: { id: 'evt_1', title: 'Demo Event', brandId: 'brd_1' },
  });
  adminApiMock.listContentDocuments.mockImplementation(
    (request?: { channel?: 'email' | 'sms'; eventId?: string; brandId?: string }) => {
      const items =
        request?.channel === 'sms'
          ? request.eventId
            ? sms
            : brandSms
          : request?.eventId
            ? email
            : brandEmail;
      return Promise.resolve({ ok: true, data: { items, nextCursor: null, hasMore: false } });
    },
  );
}

function messageCampaign(
  overrides: Partial<{
    id: string;
    eventId: string;
    name: string;
    channel: 'email' | 'sms';
    status: 'draft' | 'scheduled' | 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';
    audience: 'all_attendees' | 'checked_in' | 'not_checked_in' | 'specific';
    audienceKey: string;
    audienceAttendeeIds: string[];
    audienceLabel: string;
    queuedCount: number;
    sentCount: number;
    deliveredCount: number;
    failedCount: number;
    suppressedCount: number;
    createdAt: string;
  }> = {},
) {
  return {
    id: overrides.id ?? 'msg_1',
    eventId: overrides.eventId ?? 'evt_1',
    name: overrides.name ?? 'checked-in-campaign',
    channel: overrides.channel ?? 'email',
    status: overrides.status ?? 'queued',
    audience: overrides.audience ?? 'all_attendees',
    audienceKey: overrides.audienceKey ?? 'all',
    audienceAttendeeIds: overrides.audienceAttendeeIds ?? [],
    audienceLabel: overrides.audienceLabel ?? 'All attendees',
    queuedCount: overrides.queuedCount ?? 2,
    sentCount: overrides.sentCount ?? 0,
    deliveredCount: overrides.deliveredCount ?? 0,
    failedCount: overrides.failedCount ?? 0,
    suppressedCount: overrides.suppressedCount ?? 0,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

describe('MessageFormDialog', () => {
  it('renders an API-backed recipient preview before send', async () => {
    mockContentDocuments();
    adminApiMock.previewMessageRecipients.mockResolvedValue({
      ok: true,
      data: {
        audience: 'all_attendees',
        audienceCount: 102,
        eligibleCount: 101,
        suppressedRecipients: 1,
        consentExclusions: 1,
        skippedRecipients: 0,
        recipients: [
          {
            id: 'att_1',
            name: 'Alice Buyer',
            email: 'alice@example.test',
            status: 'confirmed',
          },
        ],
      },
    });

    const view = render(<MessageFormDialog eventId="evt_1" open onOpenChange={() => undefined} />);

    await waitFor(() => {
      expect(view.getByText('101 recipients')).toBeInTheDocument();
    });
    expect(adminApiMock.previewMessageRecipients).toHaveBeenCalledWith('evt_1', {
      audience: 'all',
      channel: 'email',
    });
    expect(view.getByText(/Alice Buyer/)).toBeInTheDocument();
    expect(view.getByText(/\+100 more eligible/)).toBeInTheDocument();
    expect(view.getByText(/1 suppressed/)).toBeInTheDocument();
  });

  it('blocks sending when the recipient preview has no eligible recipients', async () => {
    mockContentDocuments();
    adminApiMock.previewMessageRecipients.mockResolvedValue({
      ok: true,
      data: {
        audience: 'not_checked_in',
        audienceCount: 3,
        eligibleCount: 0,
        suppressedRecipients: 2,
        consentExclusions: 2,
        skippedRecipients: 1,
        recipients: [],
      },
    });

    const view = render(<MessageFormDialog eventId="evt_1" open onOpenChange={() => undefined} />);

    await waitFor(() => {
      expect(
        view.getByText('No eligible recipients match this channel and audience.'),
      ).toBeInTheDocument();
    });
    const sendButton = view.getByRole('button', { name: 'Send Campaign' });
    expect(sendButton).toBeDisabled();

    fireEvent.change(view.getByLabelText('Message'), { target: { value: 'Doors open at 7.' } });
    fireEvent.submit(sendButton.closest('form')!);

    expect(adminApiMock.sendMessage).not.toHaveBeenCalled();
  });

  it('recovers from recipient preview transport failures without leaving send enabled', async () => {
    mockContentDocuments();
    adminApiMock.previewMessageRecipients.mockRejectedValue(new Error('Preview network failed'));

    const view = render(<MessageFormDialog eventId="evt_1" open onOpenChange={() => undefined} />);

    await waitFor(() => {
      expect(view.getByText('Preview network failed')).toBeInTheDocument();
    });
    expect(view.getByText('Unavailable')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Send Campaign' })).toBeDisabled();
  });

  it('sends the selected published email template key', async () => {
    mockContentDocuments();
    adminApiMock.previewMessageRecipients.mockResolvedValue({
      ok: true,
      data: {
        audience: 'all_attendees',
        audienceCount: 2,
        eligibleCount: 2,
        suppressedRecipients: 0,
        consentExclusions: 0,
        skippedRecipients: 0,
        recipients: [],
      },
    });
    adminApiMock.sendMessage.mockResolvedValue({
      ok: true,
      data: {
        id: 'msg_1',
        eventId: 'evt_1',
        name: 'door-reminder-email',
        emailTemplateKey: 'door-reminder-email',
        channel: 'email',
        status: 'queued',
        audience: 'all_attendees',
        audienceKey: 'all',
        audienceAttendeeIds: [],
        audienceLabel: 'All attendees',
        queuedCount: 2,
        sentCount: 0,
        deliveredCount: 0,
        failedCount: 0,
        suppressedCount: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const view = render(<MessageFormDialog eventId="evt_1" open onOpenChange={() => undefined} />);

    await waitFor(() => {
      expect(view.getByText('2 recipients')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(adminApiMock.listContentDocuments).toHaveBeenCalled();
    });

    fireEvent.change(view.getByLabelText('Message'), { target: { value: 'Doors open at 7.' } });
    fireEvent.submit(view.getByRole('button', { name: 'Send Campaign' }).closest('form')!);

    await waitFor(() => {
      expect(adminApiMock.sendMessage).toHaveBeenCalledWith('evt_1', {
        channel: 'email',
        emailTemplateKey: 'door-reminder-email',
        smsTemplateKey: undefined,
        audience: 'all',
        variables: { body: 'Doors open at 7.' },
      });
    });
  });

  it('disables send and links to the email editor when no published email template exists', async () => {
    mockContentDocuments({ email: [], sms: [] });
    adminApiMock.previewMessageRecipients.mockResolvedValue({
      ok: true,
      data: {
        audience: 'all_attendees',
        audienceCount: 2,
        eligibleCount: 2,
        suppressedRecipients: 0,
        consentExclusions: 0,
        skippedRecipients: 0,
        recipients: [],
      },
    });

    const view = render(<MessageFormDialog eventId="evt_1" open onOpenChange={() => undefined} />);

    await waitFor(() => {
      expect(
        view.getAllByText('Publish an email template before sending email campaigns.')[0],
      ).toBeInTheDocument();
    });
    expect(view.getByRole('link', { name: 'Create/edit email template' })).toHaveAttribute(
      'href',
      '/events/evt_1/content/email',
    );

    fireEvent.change(view.getByLabelText('Message'), { target: { value: 'Doors open at 7.' } });
    expect(view.getByRole('button', { name: 'Send Campaign' })).toBeDisabled();
    expect(adminApiMock.sendMessage).not.toHaveBeenCalled();
  });
});

describe('EventMessagesView', () => {
  it('renders persisted audience labels after campaign reload', async () => {
    adminApiMock.listMessages.mockResolvedValue({
      ok: true,
      data: [
        messageCampaign({
          audienceLabel: 'Custom audience (2 attendees)',
          audienceKey: 'specific',
          audienceAttendeeIds: ['att_1', 'att_2'],
        }),
      ],
    });

    const view = render(<EventMessagesView eventId="evt_1" />);

    await waitFor(() => {
      expect(view.getByText('checked-in-campaign')).toBeInTheDocument();
    });
    expect(view.getByText('Custom audience (2 attendees) · 2 queued')).toBeInTheDocument();
  });

  it('uses a mobile-safe campaign card layout for long campaign metadata', async () => {
    const longName =
      'Very long campaign name for mobile operations staff reviewing narrow message cards';
    const longAudience =
      'Custom audience with a long persisted label for multiple attendee segments and suppressions';
    adminApiMock.listMessages.mockResolvedValue({
      ok: true,
      data: [
        messageCampaign({
          name: longName,
          audienceLabel: longAudience,
          status: 'scheduled',
        }),
      ],
    });

    const view = render(<EventMessagesView eventId="evt_1" />);

    await waitFor(() => {
      expect(view.getByText(longName)).toBeInTheDocument();
    });
    expect(view.getByText(longName)).toHaveClass('break-words');
    expect(view.getByText(`${longAudience} · 2 queued`)).toHaveClass('break-words');
    expect(view.getByText('scheduled')).toHaveClass('shrink-0');
    expect(view.getByRole('button', { name: 'Details' })).toHaveClass('shrink-0');
    expect(
      view.container.querySelector('.flex-col.items-start.justify-between.gap-3'),
    ).toBeInTheDocument();
    expect(view.container.querySelectorAll('.min-w-0').length).toBeGreaterThanOrEqual(1);
  });
});

describe('MessagesView', () => {
  it('shows a retryable event-load error instead of the select-event empty state', async () => {
    adminApiMock.listEvents
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'events_unavailable',
          message: 'Events unavailable',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [{ id: 'evt_1', title: 'Demo Event' }],
          nextCursor: null,
          hasMore: false,
        },
      });
    adminApiMock.listMessages.mockResolvedValue({
      ok: true,
      data: [],
    });

    const view = render(<MessagesView />);

    await waitFor(() => {
      expect(view.getByText('Failed to load events')).toBeInTheDocument();
    });
    expect(view.getByText('Events unavailable')).toBeInTheDocument();
    expect(
      view.queryByText('Choose an event to view and create message campaigns for its attendees.'),
    ).not.toBeInTheDocument();
    expect(view.getAllByRole('button', { name: 'New campaign' })[0]).toBeDisabled();

    fireEvent.click(view.getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(adminApiMock.listEvents).toHaveBeenCalledTimes(2);
      expect(view.getByText('Demo Event')).toBeInTheDocument();
    });

    fireEvent.change(view.container.querySelector('select')!, { target: { value: 'evt_1' } });

    await waitFor(() => {
      expect(adminApiMock.listMessages).toHaveBeenCalledWith('evt_1');
    });
    expect(view.getAllByRole('button', { name: 'New campaign' })[0]).not.toBeDisabled();
  });

  it('uses the same mobile-safe campaign card layout in the global messages view', async () => {
    const longName =
      'Very long global campaign name for administrators checking campaigns from a phone';
    const longAudience = 'Custom audience label with enough words to wrap inside a mobile card';
    adminApiMock.listEvents.mockResolvedValue({
      ok: true,
      data: {
        items: [{ id: 'evt_1', title: 'Demo Event' }],
        nextCursor: null,
        hasMore: false,
      },
    });
    adminApiMock.listMessages.mockResolvedValue({
      ok: true,
      data: [messageCampaign({ name: longName, audienceLabel: longAudience })],
    });

    const view = render(<MessagesView />);

    await waitFor(() => {
      expect(adminApiMock.listEvents).toHaveBeenCalled();
    });
    fireEvent.change(view.container.querySelector('select')!, { target: { value: 'evt_1' } });

    await waitFor(() => {
      expect(view.getByText(longName)).toBeInTheDocument();
    });
    expect(view.getByText(longName)).toHaveClass('break-words');
    expect(view.getByText(`${longAudience} · 2 queued`)).toHaveClass('break-words');
    expect(view.getByRole('button', { name: 'Details' })).toHaveClass('shrink-0');
    expect(
      view.container.querySelector('.flex-col.items-start.justify-between.gap-3'),
    ).toBeInTheDocument();
  });
});

describe('MessageCampaignDetailPanel', () => {
  it('renders job, delivery-log, and provider-event records', async () => {
    adminApiMock.getMessage.mockResolvedValue({
      ok: true,
      data: {
        id: 'msg_1',
        eventId: 'evt_1',
        name: 'admin-campaign',
        channel: 'email',
        status: 'sent',
        audience: 'all_attendees',
        audienceKey: 'all',
        audienceAttendeeIds: [],
        audienceLabel: 'All attendees',
        queuedCount: 1,
        sentCount: 1,
        deliveredCount: 1,
        failedCount: 0,
        suppressedCount: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        templateKey: 'admin-campaign',
        queuedEmailJobs: 1,
        queuedSmsJobs: 0,
        suppressedRecipients: 0,
        consentExclusions: 0,
        skippedRecipients: 0,
        emailJobs: [],
        smsJobs: [],
        emailDeliveries: [],
        smsDeliveries: [],
      },
    });
    adminApiMock.listMessageJobs.mockResolvedValue({
      ok: true,
      data: [
        {
          eventId: 'evt_1',
          campaignId: 'msg_1',
          channel: 'email',
          job: {
            id: 'emj_1',
            status: 'sent',
            recipient: 'a***@example.test',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
    });
    adminApiMock.listMessageDeliveryLogs.mockResolvedValue({
      ok: true,
      data: [
        {
          eventId: 'evt_1',
          campaignId: 'msg_1',
          channel: 'email',
          delivery: {
            id: 'emd_1',
            status: 'delivered',
            provider_message_id: 'pm_1',
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
    });
    adminApiMock.listMessageProviderEvents.mockResolvedValue({
      ok: true,
      data: [
        {
          eventId: 'evt_1',
          campaignId: 'msg_1',
          channel: 'email',
          event: {
            id: 'epe_1',
            event_type: 'delivered',
            provider_message_id: 'pm_1',
            occurred_at: '2026-01-01T00:00:00.000Z',
          },
        },
      ],
    });

    const view = render(<MessageCampaignDetailPanel eventId="evt_1" campaignId="msg_1" />);

    await waitFor(() => {
      expect(view.getByText('emj_1')).toBeInTheDocument();
    });
    expect(view.getByText('emd_1')).toBeInTheDocument();
    expect(view.getByText('epe_1')).toBeInTheDocument();
    expect(view.getAllByText('delivered').length).toBeGreaterThanOrEqual(2);
  });

  it('retries a failed jobs table without reloading other campaign detail tables', async () => {
    adminApiMock.getMessage.mockResolvedValue({
      ok: true,
      data: {
        id: 'msg_1',
        eventId: 'evt_1',
        name: 'admin-campaign',
        channel: 'email',
        status: 'sent',
        audience: 'all_attendees',
        audienceKey: 'all',
        audienceAttendeeIds: [],
        audienceLabel: 'All attendees',
        queuedCount: 1,
        sentCount: 1,
        deliveredCount: 0,
        failedCount: 0,
        suppressedCount: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        templateKey: 'admin-campaign',
        queuedEmailJobs: 1,
        queuedSmsJobs: 0,
        suppressedRecipients: 0,
        consentExclusions: 0,
        skippedRecipients: 0,
        emailJobs: [],
        smsJobs: [],
        emailDeliveries: [],
        smsDeliveries: [],
      },
    });
    adminApiMock.listMessageJobs
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'jobs_unavailable',
          message: 'Jobs unavailable',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: [
          {
            eventId: 'evt_1',
            campaignId: 'msg_1',
            channel: 'email',
            job: {
              id: 'emj_retry',
              status: 'queued',
              recipient: 'b***@example.test',
              updated_at: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
      });
    adminApiMock.listMessageDeliveryLogs.mockResolvedValue({
      ok: true,
      data: [],
    });
    adminApiMock.listMessageProviderEvents.mockResolvedValue({
      ok: true,
      data: [],
    });

    const view = render(<MessageCampaignDetailPanel eventId="evt_1" campaignId="msg_1" />);

    await waitFor(() => {
      expect(view.getByText('Jobs unavailable')).toBeInTheDocument();
    });
    expect(view.getByText('Delivery logs')).toBeInTheDocument();
    expect(view.getByText('Provider events')).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(adminApiMock.listMessageJobs).toHaveBeenCalledTimes(2);
      expect(view.getByText('emj_retry')).toBeInTheDocument();
    });
    expect(adminApiMock.getMessage).toHaveBeenCalledTimes(1);
    expect(adminApiMock.listMessageDeliveryLogs).toHaveBeenCalledTimes(1);
    expect(adminApiMock.listMessageProviderEvents).toHaveBeenCalledTimes(1);
  });
});
