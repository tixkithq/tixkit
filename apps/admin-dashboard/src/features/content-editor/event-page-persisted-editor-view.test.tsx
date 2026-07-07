import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultEventPageDocument, type EventPageBlock } from '@tixkit/content-event-page';
import { EventPagePersistedEditorView } from './event-page-persisted-editor-view';

/**
 * Simulate a block-change postMessage from the iframe edit overlay.
 * The admin editor listens for these and updates its local document state.
 * Origin must match the iframe's preview URL origin for the security check.
 */
const MOCK_IFRAME_ORIGIN = 'https://checkout.test';
function simulateBlockChange(blockId: string, block: EventPageBlock) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'tixkit-event-page-editor', type: 'block-change', blockId, block },
        origin: MOCK_IFRAME_ORIGIN,
      }),
    );
  });
}

function simulateBlockDuplicate(blockId: string, block: EventPageBlock) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'tixkit-event-page-editor', type: 'block-duplicate', blockId, block },
        origin: MOCK_IFRAME_ORIGIN,
      }),
    );
  });
}

/**
 * Wait for the editor to finish loading by waiting for the iframe to appear.
 */
async function waitForEditorLoad() {
  return screen.findByTestId('editor-iframe');
}

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
  mintPreviewToken: vi.fn(),
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

vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => ({
    permissions: [
      'events.read',
      'events.write',
      'tickets.write',
      'orders.read',
      'orders.write',
      'refunds.write',
      'attendees.read',
      'attendees.write',
      'checkins.read',
      'checkins.write',
      'messages.write',
      'reports.read',
      'settings.write',
      'developers.write',
      'billing.write',
    ],
    can: () => true,
    loading: false,
    error: null,
  }),
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

function openEventPageMoreActions() {
  const trigger = screen.getByRole('button', { name: 'More actions' });
  fireEvent.pointerDown(trigger);
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown', code: 'ArrowDown' });
}

function clickEventPageSaveDraft() {
  openEventPageMoreActions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Save draft' }));
}

function clickEventPageViewPublicPage() {
  openEventPageMoreActions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'View public page' }));
}

function clickMobileInsertItem(itemName: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
  const drawer = screen.getByRole('complementary', { name: 'Mobile insert content' });
  fireEvent.click(within(drawer).getByRole('button', { name: itemName }));
}

describe('EventPagePersistedEditorView', () => {
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
    adminApiMock.duplicateContentDocument.mockResolvedValue(
      ok({ ...document, id: 'cdoc_event_page_copy', name: 'All Access Chicago event page Copy' }),
    );
    adminApiMock.archiveContentDocument.mockResolvedValue(ok({ ...document, status: 'archived' }));
    adminApiMock.mintPreviewToken.mockResolvedValue(
      ok({
        token: 'mock-preview-token',
        url: 'https://checkout.test/e/evt_1?edit=1&token=mock-preview-token',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        versionId: 'cver_1',
      }),
    );
  });

  it('loads an existing event page and persists preview, publish, and archive actions', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForEditorLoad();
    // The admin canvas renders an iframe pointing to the checkout edit overlay.
    const canvas = screen.getByTestId('editor-canvas');
    expect(canvas.querySelector('[data-testid="editor-iframe"]')).not.toBeNull();
    expect(screen.queryByTestId('event-page-metadata-bar')).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Editor tools' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Event header' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }));
    expect(screen.getByRole('button', { name: 'Inspector' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Inspector' }));
    expect(screen.getByRole('button', { name: 'Close sidebar' })).toBeInTheDocument();

    const heroBlock = eventPageDocument.blocks.find((b) => b.type === 'hero')!;
    const ticketsBlock = eventPageDocument.blocks.find((b) => b.type === 'tickets')!;
    simulateBlockChange(heroBlock.id, {
      ...heroBlock,
      headline: 'Updated hosted page',
      body: 'Updated page copy for {{event.title}}.',
    });
    simulateBlockChange(ticketsBlock.id, { ...ticketsBlock, ctaLabel: 'Reserve tickets' });
    openEventPageMoreActions();
    expect(screen.getByRole('menuitem', { name: 'Variables' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Variables' }));
    expect(screen.getByText('Merge tags')).toBeInTheDocument();
    expect(screen.getByLabelText('Dynamic value Event name')).toBeInTheDocument();
    expect(screen.getByLabelText('Dynamic value Checkout link')).toBeInTheDocument();
    expect(screen.queryByText('{{event.title}}')).not.toBeInTheDocument();
    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Version history' }));
    expect(screen.getByText('More / History')).toBeInTheDocument();
    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Page details' }));
    expect(screen.getByText('Page / Settings')).toBeInTheDocument();
    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Review blockers' }));
    expect(screen.getByText('Publish blockers')).toBeInTheDocument();
    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open preview' }));

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

    expect(screen.getByTestId('preview-drawer')).toHaveTextContent('Updated page copy');
    // Preview renders the shared event-page surface (parity with checkout public page).
    const previewSurface = screen.getByTestId('preview-surface');
    expect(previewSurface.querySelector('.tixkit-event-page')).not.toBeNull();
    expect(previewSurface.querySelector('.tk-ep-hero')?.getAttribute('data-block-id')).toBe('hero');
    // Raw HTML/text debug output is secondary, not the primary preview UX.
    expect(screen.queryByTestId('preview-html')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'HTML' }));
    expect(screen.getByTestId('preview-html').tagName).toBe('PRE');
    expect(screen.getByTestId('preview-html')).toHaveTextContent('Updated hosted page');

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => {
      expect(adminApiMock.publishContentVersion).toHaveBeenCalledWith('cdoc_event_page', 'cver_2');
    });

    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive page' }));
    await waitFor(() => {
      expect(adminApiMock.archiveContentDocument).toHaveBeenCalledWith('cdoc_event_page');
    });
    await waitFor(() => {
      expect(screen.getByText('Archived event page')).toBeInTheDocument();
    });
  }, 10000);

  it('loads event-page content documents from array and keyed API response shapes', async () => {
    adminApiMock.listContentDocuments.mockResolvedValueOnce(ok([document]));
    const first = render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    expect(await waitForEditorLoad()).toBeInTheDocument();
    expect(adminApiMock.createContentDocument).not.toHaveBeenCalled();
    first.unmount();

    vi.clearAllMocks();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    adminApiMock.getEvent.mockResolvedValue(ok(event));
    adminApiMock.listContentDocuments.mockResolvedValue(ok({ cdoc_event_page: document }));
    adminApiMock.listContentVersions.mockResolvedValue(ok({ items: [version] }));
    adminApiMock.saveContentVersion.mockResolvedValue(ok(savedVersion));
    adminApiMock.mintPreviewToken.mockResolvedValue(
      ok({
        token: 'mock-preview-token',
        url: 'https://checkout.test/e/evt_1?edit=1&token=mock-preview-token',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        versionId: 'cver_1',
      }),
    );

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForEditorLoad();
    expect(adminApiMock.createContentDocument).not.toHaveBeenCalled();
  });

  it('opens the renderer-resolved public page URL and rejects unsafe public paths', async () => {
    const openPage = vi.fn();
    vi.stubGlobal('open', openPage);

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForEditorLoad();
    clickEventPageViewPublicPage();

    expect(openPage).toHaveBeenCalledWith(
      'https://events.example.test/e/evt_1',
      '_blank',
      'noopener,noreferrer',
    );
    expect(screen.getByText('Opened public page')).toBeInTheDocument();

    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Page details' }));
    fireEvent.change(screen.getByLabelText('Public path'), {
      target: { value: 'javascript:alert(1)' },
    });
    clickEventPageViewPublicPage();

    expect(openPage).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText('Public page URL is not available. Set a safe http(s) public path first.'),
    ).toBeInTheDocument();
  });

  it('adds real event-page blocks for every insert rail action', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForEditorLoad();

    clickMobileInsertItem('Text');
    clickMobileInsertItem('Image');
    clickMobileInsertItem('Tickets');
    clickMobileInsertItem('Schedule');
    clickMobileInsertItem('Venue');
    clickMobileInsertItem('Button');

    // Simulate editing the button block label from the iframe.
    const buttonBlock = {
      id: 'button-15',
      type: 'button' as const,
      label: 'Join the list',
      url: '{{event.checkoutUrl}}',
      variant: 'primary' as const,
    };
    simulateBlockChange('button-15', buttonBlock);
    clickEventPageSaveDraft();

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_event_page',
        expect.objectContaining({
          contentJson: expect.objectContaining({
            blocks: expect.arrayContaining([
              expect.objectContaining({
                id: 'rich-text-10',
                type: 'rich_text',
                content: expect.objectContaining({
                  content: expect.arrayContaining([expect.objectContaining({ type: 'paragraph' })]),
                }),
              }),
              expect.objectContaining({
                id: 'image-11',
                type: 'rich_text',
                content: expect.objectContaining({
                  content: expect.arrayContaining([expect.objectContaining({ type: 'image' })]),
                }),
              }),
              expect.objectContaining({
                id: 'tickets-12',
                type: 'tickets',
                ctaLabel: 'Get tickets',
              }),
              expect.objectContaining({
                id: 'schedule-13',
                type: 'schedule',
                items: expect.arrayContaining([
                  expect.objectContaining({ title: 'All Access Chicago' }),
                ]),
              }),
              expect.objectContaining({
                id: 'venue-14',
                type: 'venue_map',
                venueName: 'The Salt Shed',
              }),
              expect.objectContaining({
                id: 'button-15',
                type: 'button',
                label: 'Join the list',
                url: '{{event.checkoutUrl}}',
              }),
            ]),
          }),
          renderedHtml: expect.stringContaining('Join the list'),
        }),
      );
    });
  });

  it('persists edits to the exact duplicate block id sent by the iframe', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForEditorLoad();

    const heroBlock = eventPageDocument.blocks.find((b) => b.type === 'hero')!;
    const duplicateBlock = {
      ...heroBlock,
      id: 'hero-iframe-copy',
      headline: 'Iframe generated copy',
    };
    simulateBlockDuplicate(heroBlock.id, duplicateBlock);
    simulateBlockChange(duplicateBlock.id, {
      ...duplicateBlock,
      headline: 'Edited iframe generated copy',
    });
    clickEventPageSaveDraft();

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_event_page',
        expect.objectContaining({
          contentJson: expect.objectContaining({
            blocks: expect.arrayContaining([
              expect.objectContaining({
                id: 'hero-iframe-copy',
                type: 'hero',
                headline: 'Edited iframe generated copy',
              }),
            ]),
          }),
        }),
      );
    });
  });

  it('requires confirmation before archiving and locks archived event pages', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );

    const editable = render(
      React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }),
    );

    await waitForEditorLoad();
    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive page' }));

    expect(adminApiMock.archiveContentDocument).not.toHaveBeenCalled();
    editable.unmount();

    vi.clearAllMocks();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    adminApiMock.getEvent.mockResolvedValue(ok(event));
    adminApiMock.listContentDocuments.mockResolvedValue(
      ok({ items: [{ ...document, status: 'archived' }] }),
    );
    adminApiMock.listContentVersions.mockResolvedValue(ok({ items: [version] }));
    adminApiMock.mintPreviewToken.mockResolvedValue(
      ok({
        token: 'mock-preview-token',
        url: 'https://checkout.test/e/evt_1?edit=1&token=mock-preview-token',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        versionId: 'cver_1',
      }),
    );

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForEditorLoad();
    // Archived pages lock all editing actions.
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    openEventPageMoreActions();
    expect(screen.getByRole('menuitem', { name: 'Save draft' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Open preview' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'View public page' })).toHaveAttribute(
      'data-disabled',
    );
  });

  it('creates the event-scoped event-page document and initial canonical draft when none exists', async () => {
    adminApiMock.listContentDocuments.mockResolvedValue(ok({ items: [] }));
    adminApiMock.createContentDocument.mockResolvedValue(ok(document));
    adminApiMock.listContentVersions.mockResolvedValue(ok({ items: [] }));
    adminApiMock.saveContentVersion.mockResolvedValue(ok(version));

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForEditorLoad();
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

    await waitForEditorLoad();
    const heroBlock = eventPageDocument.blocks.find((b) => b.type === 'hero')!;
    simulateBlockChange(heroBlock.id, { ...heroBlock, headline: 'Stale hosted page' });
    clickEventPageSaveDraft();
    await waitFor(() => expect(screen.getByText('Saving')).toBeInTheDocument());

    simulateBlockChange(heroBlock.id, { ...heroBlock, headline: 'Fresh hosted page' });
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());

    await act(async () => {
      resolveStaleSave(ok({ ...savedVersion, id: 'cver_stale', subject: 'Stale hosted page' }));
    });

    expect(screen.queryByText('Saved draft v2')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => {
      expect(adminApiMock.publishContentVersion).toHaveBeenCalledWith(
        'cdoc_event_page',
        'cver_fresh',
      );
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

  it('keeps the event-page editor editable after save failure and allows retry', async () => {
    adminApiMock.saveContentVersion
      .mockResolvedValueOnce({
        ok: false,
        error: { message: 'Injected event-page save outage' },
      })
      .mockResolvedValue(ok(savedVersion));

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForEditorLoad();
    const heroBlock = eventPageDocument.blocks.find((b) => b.type === 'hero')!;
    simulateBlockChange(heroBlock.id, { ...heroBlock, headline: 'Retryable hosted page' });
    clickEventPageSaveDraft();

    expect(await screen.findByText('Injected event-page save outage')).toBeInTheDocument();
    expect(screen.getByText('Save failed')).toBeInTheDocument();

    simulateBlockChange(heroBlock.id, { ...heroBlock, headline: 'Recovered hosted page' });
    expect(screen.queryByText('Injected event-page save outage')).not.toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();

    clickEventPageSaveDraft();
    await waitFor(() => {
      expect(screen.getByText('Saved draft v2')).toBeInTheDocument();
    });
    expect(adminApiMock.saveContentVersion).toHaveBeenLastCalledWith(
      'cdoc_event_page',
      expect.objectContaining({ subject: 'Recovered hosted page' }),
    );
  });

  it('saves the latest event-page draft before duplicating the page', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForEditorLoad();
    const heroBlock = eventPageDocument.blocks.find((b) => b.type === 'hero')!;
    simulateBlockChange(heroBlock.id, { ...heroBlock, headline: 'Duplicate-ready hosted page' });

    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate page' }));

    await waitFor(() => {
      expect(adminApiMock.duplicateContentDocument).toHaveBeenCalledWith('cdoc_event_page', {
        name: 'All Access Chicago event page Copy',
      });
    });
    expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
      'cdoc_event_page',
      expect.objectContaining({
        subject: 'Duplicate-ready hosted page',
        contentJson: expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({ type: 'hero', headline: 'Duplicate-ready hosted page' }),
          ]),
        }),
      }),
    );
    const saveCallOrder = adminApiMock.saveContentVersion.mock.invocationCallOrder;
    const duplicateCallOrder = adminApiMock.duplicateContentDocument.mock.invocationCallOrder;
    expect(saveCallOrder[saveCallOrder.length - 1]).toBeLessThan(
      duplicateCallOrder[duplicateCallOrder.length - 1],
    );
    expect(
      screen.getByText('Duplicated event page as All Access Chicago event page Copy'),
    ).toBeInTheDocument();
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

    expect(
      await screen.findByText(
        'Saved event-page draft is not canonical Tixkit TipTap event-page JSON.',
      ),
    ).toBeInTheDocument();
  });
});
