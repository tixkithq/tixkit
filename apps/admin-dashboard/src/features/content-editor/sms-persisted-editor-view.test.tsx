import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSmsTemplate } from '@tixkit/content-message';
import { SmsPersistedEditorView } from './sms-persisted-editor-view';

const adminApiMock = vi.hoisted(() => ({
  getEvent: vi.fn(),
  listContentDocuments: vi.fn(),
  createContentDocument: vi.fn(),
  listContentVersions: vi.fn(),
  saveContentVersion: vi.fn(),
  previewContent: vi.fn(),
  publishContentVersion: vi.fn(),
  duplicateContentDocument: vi.fn(),
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

const smsDocument = createDefaultSmsTemplate({
  editor: {
    body: 'Hi {{recipient.name}}, {{event.title}} starts {{event.startsAt}}.',
  },
  settings: {
    templateKey: 'event-update',
    locale: 'en',
    category: 'bulk',
    consentCategory: 'marketing',
    segmentLimit: 3,
    estimatedCostPerSegmentCents: 2,
    optOutText: 'Reply STOP to opt out',
  },
  shortLinks: [],
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
  id: 'cdoc_sms',
  tenantId: 'tnt_1',
  organizationId: 'org_1',
  brandId: 'brd_1',
  eventId: 'evt_1',
  channel: 'sms',
  key: 'event-update',
  name: 'All Access Chicago SMS updates',
  status: 'draft',
  locale: 'en',
  currentDraftVersionId: 'cver_1',
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
};

const version = {
  id: 'cver_1',
  documentId: 'cdoc_sms',
  versionNumber: 1,
  status: 'draft',
  schemaVersion: 1,
  contentJson: smsDocument,
  renderedText: smsDocument.editor.body,
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

describe('SmsPersistedEditorView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    adminApiMock.getEvent.mockResolvedValue(ok(event));
    adminApiMock.listContentDocuments.mockResolvedValue(ok({ items: [document] }));
    adminApiMock.listContentVersions.mockResolvedValue(ok({ items: [version] }));
    adminApiMock.saveContentVersion.mockResolvedValue(ok(savedVersion));
    adminApiMock.previewContent.mockResolvedValue(
      ok({
        channel: 'sms',
        output: { text: 'Hi Ada saved. Reply STOP to opt out', segments: 1 },
        validation: { valid: true, severity: 'warning', issues: [] },
      }),
    );
    adminApiMock.publishContentVersion.mockResolvedValue(
      ok({
        document: { ...document, status: 'published', publishedVersionId: 'cver_2' },
        version: { ...savedVersion, status: 'published' },
      }),
    );
    adminApiMock.duplicateContentDocument.mockResolvedValue(
      ok({ ...document, id: 'cdoc_sms_copy', name: 'All Access Chicago SMS updates Copy' }),
    );
    adminApiMock.archiveContentDocument.mockResolvedValue(ok({ ...document, status: 'archived' }));
    adminApiMock.testSendContent.mockResolvedValue(
      ok({
        testSend: {
          id: 'cts_1',
          tenantId: 'tnt_1',
          documentId: 'cdoc_sms',
          versionId: 'cver_2',
          channel: 'sms',
          recipient: '+15550000001',
          status: 'captured',
          renderedText: 'Hi Ada saved. Reply STOP to opt out',
          createdAt: '2026-06-29T00:00:00.000Z',
        },
        output: { text: 'Hi Ada saved. Reply STOP to opt out', segments: 1 },
      }),
    );
  });

  it('loads an existing SMS document and persists preview, publish, and test-send actions', async () => {
    render(React.createElement(SmsPersistedEditorView, { eventId: 'evt_1' }));

    const body = await screen.findByLabelText('SMS body');
    fireEvent.change(body, {
      target: { value: 'Hi {{recipient.name}}, saved update for {{event.title}}.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_sms',
        expect.objectContaining({
          renderedText: 'Hi {{recipient.name}}, saved update for {{event.title}}.',
        }),
      );
      expect(adminApiMock.previewContent).toHaveBeenCalledWith(
        'cdoc_sms',
        expect.objectContaining({ versionId: 'cver_2' }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
    expect(screen.getByTestId('preview-drawer')).toHaveTextContent('Hi Ada saved');

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => {
      expect(adminApiMock.publishContentVersion).toHaveBeenCalledWith('cdoc_sms', 'cver_2');
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Send test' })[0]);
    await waitFor(() => {
      expect(adminApiMock.testSendContent).toHaveBeenCalledWith(
        'cdoc_sms',
        expect.objectContaining({
          versionId: 'cver_2',
          recipient: '+15550000001',
        }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Archive template' }));
    await waitFor(() => {
      expect(adminApiMock.archiveContentDocument).toHaveBeenCalledWith('cdoc_sms');
    });
    expect(screen.getByText('Archived SMS template')).toBeInTheDocument();
  });

  it('loads SMS documents and versions from keyed list responses without crashing', async () => {
    adminApiMock.listContentDocuments.mockResolvedValue(ok({ cdoc_sms: document }));
    adminApiMock.listContentVersions.mockResolvedValue(ok({ cver_1: version }));

    render(React.createElement(SmsPersistedEditorView, { eventId: 'evt_1' }));

    expect(await screen.findByLabelText('SMS body')).toHaveValue(smsDocument.editor.body);
    expect(adminApiMock.createContentDocument).not.toHaveBeenCalled();
    expect(adminApiMock.saveContentVersion).not.toHaveBeenCalled();
  });

  it('adds real SMS body content from insert rail actions', async () => {
    render(React.createElement(SmsPersistedEditorView, { eventId: 'evt_1' }));

    const body = await screen.findByLabelText('SMS body');
    fireEvent.click(screen.getByRole('button', { name: 'Insert Variable' }));
    fireEvent.click(screen.getByRole('button', { name: 'Insert Link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Insert Opt-out' }));

    expect(body).toHaveValue(
      `${smsDocument.editor.body} {{recipient.name}} {{event.checkoutUrl}} Reply STOP to opt out`,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_sms',
        expect.objectContaining({
          renderedText: `${smsDocument.editor.body} {{recipient.name}} {{event.checkoutUrl}} Reply STOP to opt out`,
          contentJson: expect.objectContaining({
            editor: expect.objectContaining({
              body: `${smsDocument.editor.body} {{recipient.name}} {{event.checkoutUrl}} Reply STOP to opt out`,
            }),
          }),
        }),
      );
    });
  });

  it('saves the latest SMS draft before duplicating the template', async () => {
    render(React.createElement(SmsPersistedEditorView, { eventId: 'evt_1' }));

    const body = await screen.findByLabelText('SMS body');
    fireEvent.change(body, { target: { value: 'Duplicate-ready SMS for {{event.title}}.' } });

    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate template' }));

    await waitFor(() => {
      expect(adminApiMock.duplicateContentDocument).toHaveBeenCalledWith('cdoc_sms', {
        name: 'All Access Chicago SMS updates Copy',
      });
    });
    expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
      'cdoc_sms',
      expect.objectContaining({
        renderedText: 'Duplicate-ready SMS for {{event.title}}.',
      }),
    );
    const saveCallOrder = adminApiMock.saveContentVersion.mock.invocationCallOrder;
    const duplicateCallOrder = adminApiMock.duplicateContentDocument.mock.invocationCallOrder;
    expect(saveCallOrder[saveCallOrder.length - 1]).toBeLessThan(
      duplicateCallOrder[duplicateCallOrder.length - 1],
    );
    expect(
      screen.getByText('Duplicated SMS template as All Access Chicago SMS updates Copy'),
    ).toBeInTheDocument();
  });

  it('requires confirmation before archiving and locks archived SMS templates', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );

    const editable = render(React.createElement(SmsPersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByLabelText('SMS body');
    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Archive template' }));

    expect(adminApiMock.archiveContentDocument).not.toHaveBeenCalled();
    editable.unmount();

    vi.clearAllMocks();
    adminApiMock.getEvent.mockResolvedValue(ok(event));
    adminApiMock.listContentDocuments.mockResolvedValue(
      ok({ items: [{ ...document, status: 'archived' }] }),
    );
    adminApiMock.listContentVersions.mockResolvedValue(ok({ items: [version] }));

    render(React.createElement(SmsPersistedEditorView, { eventId: 'evt_1' }));

    expect(await screen.findByLabelText('SMS body')).toBeDisabled();
    expect(screen.getByLabelText('Test recipient')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open preview' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Publish unavailable' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test send unavailable' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('More actions'));
    expect(screen.getByRole('button', { name: 'Duplicate template' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archive template' })).toBeDisabled();
  });

  it('creates the event-scoped SMS document and initial canonical draft when none exists', async () => {
    adminApiMock.listContentDocuments.mockResolvedValue(ok({ items: [] }));
    adminApiMock.createContentDocument.mockResolvedValue(ok(document));
    adminApiMock.listContentVersions.mockResolvedValue(ok({ items: [] }));
    adminApiMock.saveContentVersion.mockResolvedValue(ok(version));

    render(React.createElement(SmsPersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByLabelText('SMS body');
    expect(adminApiMock.createContentDocument).toHaveBeenCalledWith({
      organizationId: 'org_1',
      brandId: 'brd_1',
      eventId: 'evt_1',
      channel: 'sms',
      key: 'event-update',
      name: 'All Access Chicago SMS updates',
      locale: 'en',
    });
    expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
      'cdoc_sms',
      expect.objectContaining({
        contentJson: expect.objectContaining({ schemaVersion: 1 }),
      }),
    );
  });

  it('ignores stale save completions before publishing the latest SMS draft', async () => {
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

    render(React.createElement(SmsPersistedEditorView, { eventId: 'evt_1' }));

    const body = await screen.findByLabelText('SMS body');
    fireEvent.change(body, { target: { value: 'Stale SMS body.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByText('Saving')).toBeInTheDocument());

    fireEvent.change(body, { target: { value: 'Fresh SMS body.' } });
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());

    await act(async () => {
      resolveStaleSave(ok({ ...savedVersion, id: 'cver_stale', renderedText: 'Stale SMS body.' }));
    });

    expect(screen.queryByText('Saved draft v2')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => {
      expect(adminApiMock.publishContentVersion).toHaveBeenCalledWith('cdoc_sms', 'cver_fresh');
    });
    expect(adminApiMock.saveContentVersion).toHaveBeenLastCalledWith(
      'cdoc_sms',
      expect.objectContaining({
        renderedText: 'Fresh SMS body.',
        contentJson: expect.objectContaining({
          editor: expect.objectContaining({ body: 'Fresh SMS body.' }),
        }),
      }),
    );
  });

  it('keeps the SMS editor editable after save failure and allows retry', async () => {
    adminApiMock.saveContentVersion
      .mockResolvedValueOnce({
        ok: false,
        error: { message: 'Injected SMS save outage' },
      })
      .mockResolvedValue(ok(savedVersion));

    render(React.createElement(SmsPersistedEditorView, { eventId: 'evt_1' }));

    const body = await screen.findByLabelText('SMS body');
    fireEvent.change(body, { target: { value: 'Retryable SMS body.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByText('Injected SMS save outage')).toBeInTheDocument();
    expect(screen.getByText('Save failed')).toBeInTheDocument();
    expect(screen.getByLabelText('SMS body')).toHaveValue('Retryable SMS body.');

    fireEvent.change(body, { target: { value: 'Recovered SMS body.' } });
    expect(screen.queryByText('Injected SMS save outage')).not.toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(screen.getByText('Saved draft v2')).toBeInTheDocument();
    });
    expect(adminApiMock.saveContentVersion).toHaveBeenLastCalledWith(
      'cdoc_sms',
      expect.objectContaining({ renderedText: 'Recovered SMS body.' }),
    );
  });
});
