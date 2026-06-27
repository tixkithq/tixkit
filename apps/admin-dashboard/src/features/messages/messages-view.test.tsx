import { render, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import * as React from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageFormDialog } from './message-form'
import { MessageCampaignDetailPanel } from './messages-view'

if (typeof window === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
  })
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
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

type MessagesAdminApiMock = {
  previewMessageRecipients: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
  getMessage: ReturnType<typeof vi.fn>
  listMessageJobs: ReturnType<typeof vi.fn>
  listMessageDeliveryLogs: ReturnType<typeof vi.fn>
  listMessageProviderEvents: ReturnType<typeof vi.fn>
}

function getAdminApiMock(): MessagesAdminApiMock {
  const globalWithMock = globalThis as typeof globalThis & {
    __messagesAdminApiMock?: MessagesAdminApiMock
  }
  globalWithMock.__messagesAdminApiMock ??= {
    previewMessageRecipients: vi.fn(),
    sendMessage: vi.fn(),
    getMessage: vi.fn(),
    listMessageJobs: vi.fn(),
    listMessageDeliveryLogs: vi.fn(),
    listMessageProviderEvents: vi.fn(),
  }
  return globalWithMock.__messagesAdminApiMock
}

vi.mock('@/lib/api', () => ({
  adminApi: getAdminApiMock(),
}))

const adminApiMock = getAdminApiMock()

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

describe('MessageFormDialog', () => {
  it('renders an API-backed recipient preview before send', async () => {
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
    })

    const view = render(
      <MessageFormDialog
        eventId='evt_1'
        open
        onOpenChange={() => undefined}
      />,
    )

    await waitFor(() => {
      expect(view.getByText('101 recipients')).toBeInTheDocument()
    })
    expect(adminApiMock.previewMessageRecipients).toHaveBeenCalledWith('evt_1', {
      audience: 'all',
      channel: 'email',
      templateKey: 'admin-campaign',
    })
    expect(view.getByText(/Alice Buyer/)).toBeInTheDocument()
    expect(view.getByText(/\+100 more eligible/)).toBeInTheDocument()
    expect(view.getByText(/1 suppressed/)).toBeInTheDocument()
  })
})

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
    })
    adminApiMock.listMessageJobs.mockResolvedValue({
      ok: true,
      data: [{
        eventId: 'evt_1',
        campaignId: 'msg_1',
        channel: 'email',
        job: { id: 'emj_1', status: 'sent', to_email: 'alice@example.test', updated_at: '2026-01-01T00:00:00.000Z' },
      }],
    })
    adminApiMock.listMessageDeliveryLogs.mockResolvedValue({
      ok: true,
      data: [{
        eventId: 'evt_1',
        campaignId: 'msg_1',
        channel: 'email',
        delivery: { id: 'emd_1', status: 'delivered', provider_message_id: 'pm_1', updated_at: '2026-01-01T00:00:00.000Z' },
      }],
    })
    adminApiMock.listMessageProviderEvents.mockResolvedValue({
      ok: true,
      data: [{
        eventId: 'evt_1',
        campaignId: 'msg_1',
        channel: 'email',
        event: { id: 'epe_1', event_type: 'delivered', provider_message_id: 'pm_1', occurred_at: '2026-01-01T00:00:00.000Z' },
      }],
    })

    const view = render(<MessageCampaignDetailPanel eventId='evt_1' campaignId='msg_1' />)

    await waitFor(() => {
      expect(view.getByText('emj_1')).toBeInTheDocument()
    })
    expect(view.getByText('emd_1')).toBeInTheDocument()
    expect(view.getByText('epe_1')).toBeInTheDocument()
    expect(view.getAllByText('delivered').length).toBeGreaterThanOrEqual(2)
  })
})
