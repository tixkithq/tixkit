import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REACT_EMAIL_EDITOR_PACKAGE, createDefaultEmailTemplate } from '@tixkit/content-email';
import { EmailPersistedEditorView } from './email-persisted-editor-view';

const adminApiMock = vi.hoisted(() => ({
  getEvent: vi.fn(),
  listContentDocuments: vi.fn(),
  createContentDocument: vi.fn(),
  listContentVersions: vi.fn(),
  saveContentVersion: vi.fn(),
  previewContent: vi.fn(),
  publishContentVersion: vi.fn(),
  archiveContentDocument: vi.fn(),
  testSendContent: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  adminApi: adminApiMock,
}));

vi.mock('sonner', () => ({
  toast: toastMock,
}));

const emailDocument = createDefaultEmailTemplate({
  editor: {
    provider: REACT_EMAIL_EDITOR_PACKAGE,
    contentHtml: '<h1>{{event.title}}</h1><p>Hi {{recipient.name}}, your tickets are ready.</p>',
  },
  settings: {
    templateKey: 'order-confirmed',
    subject: 'Your {{event.title}} tickets are ready',
    previewText: 'Everything you need before arrival.',
    locale: 'en',
    category: 'transactional',
    sender: {
      fromEmail: 'tickets@example.test',
      fromName: 'Tixkit',
      replyToEmail: 'support@example.test',
    },
  },
  blocks: [
    {
      type: 'event_hero',
      headline: '{{event.title}}',
      body: 'Hi {{recipient.name}}, your order is confirmed.',
      ctaLabel: 'View tickets',
      ctaUrl: '{{event.checkoutUrl}}',
    },
    {
      type: 'ticket_summary',
      title: 'Ticket summary',
      body: '{{ticket.type}} - {{order.total}}',
    },
    {
      type: 'unsubscribe_footer',
      body: 'You are receiving this because you purchased tickets with {{brand.name}}.',
      unsubscribeUrl: '{{brand.supportUrl}}',
    },
  ],
});

const event = {
  id: 'evt_1',
  title: 'All Access Chicago',
  startsAt: '2026-07-17 19:00',
  status: 'draft',
  visibility: 'public',
  seo: {},
  currency: 'USD',
  grossSalesCents: 0,
  ticketsSold: 0,
  checkIns: 0,
  updatedAt: '2026-06-29T00:00:00.000Z',
  organizationId: 'org_1',
  brandId: 'brd_1',
};

const document = {
  id: 'cdoc_email',
  tenantId: 'tnt_1',
  organizationId: 'org_1',
  brandId: 'brd_1',
  eventId: 'evt_1',
  channel: 'email',
  key: 'order-confirmed',
  name: 'All Access Chicago email template',
  status: 'draft',
  locale: 'en',
  currentDraftVersionId: 'cver_1',
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
};

const version = {
  id: 'cver_1',
  documentId: 'cdoc_email',
  versionNumber: 1,
  status: 'draft',
  schemaVersion: 1,
  subject: emailDocument.settings.subject,
  previewText: emailDocument.settings.previewText,
  contentJson: emailDocument,
  renderedHtml: emailDocument.editor.contentHtml,
  renderedText: 'Hi Ada Lovelace, your order is confirmed.',
  variables: [],
  validation: { valid: true, severity: 'warning', issues: [] },
  createdBy: 'usr_1',
  createdAt: '2026-06-29T00:00:00.000Z',
};

const savedVersion = {
  ...version,
  id: 'cver_2',
  versionNumber: 2,
};

function ok<T>(data: T) {
  return { ok: true as const, data };
}

describe('EmailPersistedEditorView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminApiMock.getEvent.mockResolvedValue(ok(event));
    adminApiMock.listContentDocuments.mockResolvedValue(ok({ items: [document] }));
    adminApiMock.listContentVersions.mockResolvedValue(ok({ items: [version] }));
    adminApiMock.saveContentVersion.mockResolvedValue(ok(savedVersion));
    adminApiMock.previewContent.mockResolvedValue(
      ok({
        channel: 'email',
        output: {
          subject: 'Updated tickets for All Access Chicago',
          html: '<h1>Updated</h1>',
          text: 'Updated saved email for Ada Lovelace.',
        },
        validation: { valid: true, severity: 'warning', issues: [] },
      }),
    );
    adminApiMock.publishContentVersion.mockResolvedValue(
      ok({
        document: { ...document, status: 'published', publishedVersionId: 'cver_2' },
        version: { ...savedVersion, status: 'published' },
      }),
    );
    adminApiMock.archiveContentDocument.mockResolvedValue(ok({ ...document, status: 'archived' }));
    adminApiMock.testSendContent.mockResolvedValue(
      ok({
        testSend: {
          id: 'cts_1',
          tenantId: 'tnt_1',
          documentId: 'cdoc_email',
          versionId: 'cver_2',
          channel: 'email',
          recipient: 'ada@example.test',
          status: 'captured',
          renderedSubject: 'Updated tickets for All Access Chicago',
          renderedText: 'Updated saved email for Ada Lovelace.',
          createdAt: '2026-06-29T00:00:00.000Z',
        },
        output: {
          subject: 'Updated tickets for All Access Chicago',
          text: 'Updated saved email for Ada Lovelace.',
        },
      }),
    );
  });

  it('loads an existing email document and persists preview, publish, and test-send actions', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    const subject = await screen.findByLabelText('Subject');
    fireEvent.change(subject, {
      target: { value: 'Updated tickets for {{event.title}}' },
    });
    fireEvent.change(screen.getByLabelText('Email body'), {
      target: { value: 'Updated saved email for {{recipient.name}}.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({
          subject: 'Updated tickets for {{event.title}}',
          contentJson: expect.objectContaining({
            schemaVersion: 1,
            settings: expect.objectContaining({
              subject: 'Updated tickets for {{event.title}}',
            }),
          }),
          renderedHtml: '<h1>{{event.title}}</h1><p>Updated saved email for {{recipient.name}}.</p>',
        }),
      );
      expect(adminApiMock.previewContent).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({ versionId: 'cver_2' }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
    expect(screen.getByTestId('preview-drawer')).toHaveTextContent('Updated saved email');

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => {
      expect(adminApiMock.publishContentVersion).toHaveBeenCalledWith('cdoc_email', 'cver_2');
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Send test' })[0]);
    await waitFor(() => {
      expect(adminApiMock.testSendContent).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({
          versionId: 'cver_2',
          recipient: 'ada@example.test',
        }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Archive template' }));
    await waitFor(() => {
      expect(adminApiMock.archiveContentDocument).toHaveBeenCalledWith('cdoc_email');
    });
    expect(screen.getByText('Archived email template')).toBeInTheDocument();
  });

  it('creates the event-scoped email document and initial canonical draft when none exists', async () => {
    adminApiMock.listContentDocuments.mockResolvedValue(ok({ items: [] }));
    adminApiMock.createContentDocument.mockResolvedValue(ok(document));
    adminApiMock.listContentVersions.mockResolvedValue(ok({ items: [] }));
    adminApiMock.saveContentVersion.mockResolvedValue(ok(version));

    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByLabelText('Subject');
    expect(adminApiMock.createContentDocument).toHaveBeenCalledWith({
      organizationId: 'org_1',
      brandId: 'brd_1',
      eventId: 'evt_1',
      channel: 'email',
      key: 'order-confirmed',
      name: 'All Access Chicago email template',
      locale: 'en',
    });
    expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
      'cdoc_email',
      expect.objectContaining({
        contentJson: expect.objectContaining({
          schemaVersion: 1,
          editor: expect.objectContaining({ provider: '@react-email/editor' }),
        }),
      }),
    );
  });

  it('ignores stale save completions before publishing the latest email draft', async () => {
    let resolveStaleSave: (value: unknown) => void;
    adminApiMock.saveContentVersion
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStaleSave = resolve;
        }),
      )
      .mockResolvedValue(ok({ ...savedVersion, id: 'cver_fresh', versionNumber: 3 }));
    adminApiMock.publishContentVersion.mockResolvedValue(
      ok({
        document: { ...document, status: 'published', publishedVersionId: 'cver_fresh' },
        version: { ...savedVersion, id: 'cver_fresh', versionNumber: 3, status: 'published' },
      }),
    );

    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    const subject = await screen.findByLabelText('Subject');
    fireEvent.change(subject, { target: { value: 'Stale email subject' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByText('Saving')).toBeInTheDocument());

    fireEvent.change(subject, { target: { value: 'Fresh email subject' } });
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());

    await act(async () => {
      resolveStaleSave(ok({ ...savedVersion, id: 'cver_stale', subject: 'Stale email subject' }));
    });

    expect(screen.queryByText('Saved draft v2')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => {
      expect(adminApiMock.publishContentVersion).toHaveBeenCalledWith('cdoc_email', 'cver_fresh');
    });
    expect(adminApiMock.saveContentVersion).toHaveBeenLastCalledWith(
      'cdoc_email',
      expect.objectContaining({
        subject: 'Fresh email subject',
        contentJson: expect.objectContaining({
          settings: expect.objectContaining({ subject: 'Fresh email subject' }),
        }),
      }),
    );
  });

  it('keeps the email editor editable after save failure and allows retry', async () => {
    adminApiMock.saveContentVersion
      .mockResolvedValueOnce({
        ok: false,
        error: { message: 'Injected email save outage' },
      })
      .mockResolvedValue(ok(savedVersion));

    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    const subject = await screen.findByLabelText('Subject');
    fireEvent.change(subject, { target: { value: 'Retryable email subject' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByText('Injected email save outage')).toBeInTheDocument();
    expect(screen.getByText('Save failed')).toBeInTheDocument();
    expect(screen.getByLabelText('Subject')).toHaveValue('Retryable email subject');

    fireEvent.change(subject, { target: { value: 'Recovered email subject' } });
    expect(screen.queryByText('Injected email save outage')).not.toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(screen.getByText('Saved draft v2')).toBeInTheDocument();
    });
    expect(adminApiMock.saveContentVersion).toHaveBeenLastCalledWith(
      'cdoc_email',
      expect.objectContaining({ subject: 'Recovered email subject' }),
    );
  });

  it('fails closed when the saved draft is not canonical React Email JSON', async () => {
    adminApiMock.listContentVersions.mockResolvedValue(
      ok({
        items: [
          {
            ...version,
            contentJson: { editor: { provider: 'legacy-html-editor' } },
          },
        ],
      }),
    );

    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    expect(await screen.findByText('Saved email draft is not canonical Tixkit React Email template JSON.')).toBeInTheDocument();
  });
});
