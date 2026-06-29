import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultEventPageDocument } from '@tixkit/content-event-page';
import { EventPagePersistedEditorView } from './event-page-persisted-editor-view';

const adminApiMock = vi.hoisted(() => ({
  getEvent: vi.fn(),
  listContentDocuments: vi.fn(),
  createContentDocument: vi.fn(),
  listContentVersions: vi.fn(),
  saveContentVersion: vi.fn(),
  previewContent: vi.fn(),
  publishContentVersion: vi.fn(),
  archiveContentDocument: vi.fn(),
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

const event = {
  id: 'evt_1',
  title: 'All Access Chicago',
  description: 'Original event page copy.',
  startsAt: '2026-07-17T19:00:00.000Z',
  endsAt: '2026-07-17T23:00:00.000Z',
  timezone: 'America/Chicago',
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
  venueName: 'The Salt Shed',
  venue: { name: 'The Salt Shed', city: 'Chicago' },
};

const eventPageDocument = createDefaultEventPageDocument({
  eventId: event.id,
  eventTitle: event.title,
  eventDescription: event.description,
  startsAt: event.startsAt,
  endsAt: event.endsAt,
  timezone: event.timezone,
  venue: event.venue,
  checkoutUrl: '{{event.checkoutUrl}}',
  publicUrl: '{{event.publicUrl}}',
});

const document = {
  id: 'cdoc_event_page',
  tenantId: 'tnt_1',
  organizationId: 'org_1',
  brandId: 'brd_1',
  eventId: 'evt_1',
  channel: 'event_page',
  key: 'main',
  name: 'All Access Chicago event page',
  status: 'draft',
  locale: 'en',
  currentDraftVersionId: 'cver_1',
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
};

const version = {
  id: 'cver_1',
  documentId: 'cdoc_event_page',
  versionNumber: 1,
  status: 'draft',
  schemaVersion: 1,
  subject: 'All Access Chicago',
  previewText: 'Original event page copy.',
  contentJson: eventPageDocument,
  renderedHtml: '<main>Original event page copy.</main>',
  renderedText: 'Original event page copy.',
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

describe('EventPagePersistedEditorView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adminApiMock.getEvent.mockResolvedValue(ok(event));
    adminApiMock.listContentDocuments.mockResolvedValue(ok({ items: [document] }));
    adminApiMock.listContentVersions.mockResolvedValue(ok({ items: [version] }));
    adminApiMock.saveContentVersion.mockResolvedValue(ok(savedVersion));
    adminApiMock.previewContent.mockResolvedValue(
      ok({
        channel: 'event_page',
        output: {
          html: '<main><h1>Updated hosted page</h1><p>Updated page copy for Ada.</p></main>',
          text: 'Updated hosted page Updated page copy for Ada.',
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
  });

  it('loads an existing event page and persists preview, publish, and archive actions', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    const headline = await screen.findByLabelText('Page headline');
    fireEvent.change(headline, {
      target: { value: 'Updated hosted page' },
    });
    fireEvent.change(screen.getByLabelText('Page summary'), {
      target: { value: 'Updated page copy for {{event.title}}.' },
    });
    fireEvent.change(screen.getByLabelText('Ticket CTA label'), {
      target: { value: 'Reserve tickets' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_event_page',
        expect.objectContaining({
          subject: 'Updated hosted page',
          previewText: 'Updated page copy for {{event.title}}.',
          contentJson: expect.objectContaining({
            schemaVersion: 1,
            settings: expect.objectContaining({
              ticketCtaLabel: 'Reserve tickets',
            }),
          }),
          renderedHtml: expect.stringContaining('Updated hosted page'),
          renderedText: expect.stringContaining('Updated page copy for All Access Chicago.'),
        }),
      );
      expect(adminApiMock.previewContent).toHaveBeenCalledWith(
        'cdoc_event_page',
        expect.objectContaining({ versionId: 'cver_2' }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
    expect(screen.getByTestId('preview-drawer')).toHaveTextContent('Updated page copy');

    expect(screen.getByRole('button', { name: 'Test send unavailable' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => {
      expect(adminApiMock.publishContentVersion).toHaveBeenCalledWith('cdoc_event_page', 'cver_2');
    });

    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Archive page' }));
    await waitFor(() => {
      expect(adminApiMock.archiveContentDocument).toHaveBeenCalledWith('cdoc_event_page');
    });
    expect(screen.getByText('Archived event page')).toBeInTheDocument();
  });

  it('creates the event-scoped event-page document and initial canonical draft when none exists', async () => {
    adminApiMock.listContentDocuments.mockResolvedValue(ok({ items: [] }));
    adminApiMock.createContentDocument.mockResolvedValue(ok(document));
    adminApiMock.listContentVersions.mockResolvedValue(ok({ items: [] }));
    adminApiMock.saveContentVersion.mockResolvedValue(ok(version));

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByLabelText('Page headline');
    expect(adminApiMock.createContentDocument).toHaveBeenCalledWith({
      organizationId: 'org_1',
      brandId: 'brd_1',
      eventId: 'evt_1',
      channel: 'event_page',
      key: 'main',
      name: 'All Access Chicago event page',
      locale: 'en',
    });
    expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
      'cdoc_event_page',
      expect.objectContaining({
        contentJson: expect.objectContaining({
          schemaVersion: 1,
          editor: expect.objectContaining({ provider: '@tiptap/core' }),
        }),
        renderedHtml: expect.stringContaining('tixkit-event-page'),
      }),
    );
  });

  it('ignores stale save completions before publishing the latest event-page draft', async () => {
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

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    const headline = await screen.findByLabelText('Page headline');
    fireEvent.change(headline, { target: { value: 'Stale hosted page' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByText('Saving')).toBeInTheDocument());

    fireEvent.change(headline, { target: { value: 'Fresh hosted page' } });
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());

    await act(async () => {
      resolveStaleSave(ok({ ...savedVersion, id: 'cver_stale', subject: 'Stale hosted page' }));
    });

    expect(screen.queryByText('Saved draft v2')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => {
      expect(adminApiMock.publishContentVersion).toHaveBeenCalledWith('cdoc_event_page', 'cver_fresh');
    });
    expect(adminApiMock.saveContentVersion).toHaveBeenLastCalledWith(
      'cdoc_event_page',
      expect.objectContaining({
        subject: 'Fresh hosted page',
        contentJson: expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({ type: 'hero', headline: 'Fresh hosted page' }),
          ]),
        }),
      }),
    );
  });

  it('fails closed when the saved draft is not canonical TipTap event-page JSON', async () => {
    adminApiMock.listContentVersions.mockResolvedValue(
      ok({
        items: [
          {
            ...version,
            contentJson: { schemaVersion: 1, editor: { provider: 'legacy-page-builder' } },
          },
        ],
      }),
    );

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    expect(await screen.findByText('Saved event-page draft is not canonical Tixkit TipTap event-page JSON.')).toBeInTheDocument();
  });
});
