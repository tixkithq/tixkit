import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultEventPageDocument } from '@tixkit/content-event-page';
import { EventPagePersistedEditorView } from './event-page-persisted-editor-view';

type MockPuckContent = {
  type: string;
  props: Record<string, unknown>;
};

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
    permissions: ['events.read', 'events.write'],
    can: () => true,
    loading: false,
    error: null,
  }),
}));

vi.mock('@puckeditor/core', async () => {
  const ReactModule = await import('react');

  function Puck({
    children,
    data,
    iframe,
    onChange,
    onPublish,
    permissions,
  }: {
    children?: React.ReactNode;
    data: { root: { props: Record<string, unknown> }; content: MockPuckContent[] };
    iframe?: { enabled?: boolean };
    onChange?: (data: unknown) => void;
    onPublish?: (data: unknown) => void;
    permissions?: { edit?: boolean };
  }) {
    const changeHero = () => {
      onChange?.({
        ...data,
        root: {
          props: {
            ...data.root.props,
            title: 'Updated hosted page',
            description: 'Updated page copy for {{event.title}}.',
          },
        },
        content: data.content.map((item) =>
          item.type === 'Hero'
            ? {
                ...item,
                props: {
                  ...item.props,
                  headline: 'Updated hosted page',
                  body: 'Updated page copy for {{event.title}}.',
                },
              }
            : item,
        ),
      });
    };
    return ReactModule.createElement(
      'section',
      {
        'data-testid': 'puck-editor',
        'data-iframe-enabled': String(Boolean(iframe?.enabled)),
        'data-editable': String(permissions?.edit !== false),
      },
      ReactModule.createElement(
        'button',
        { type: 'button', onClick: changeHero },
        'Mock Puck change',
      ),
      ReactModule.createElement(
        'button',
        { type: 'button', onClick: () => onPublish?.(data) },
        'Mock Puck publish',
      ),
      children,
    );
  }

  Puck.Components = () => ReactModule.createElement('div', { 'data-testid': 'puck-components' });
  Puck.Preview = () => ReactModule.createElement('div', { 'data-testid': 'puck-preview' });
  Puck.Fields = () => ReactModule.createElement('div', { 'data-testid': 'puck-fields' });

  function Render({
    data,
  }: {
    data: { root?: { props?: { title?: string } }; content?: MockPuckContent[] };
  }) {
    const hero = data.content?.find((item) => item.type === 'Hero');
    const heading =
      typeof hero?.props.headline === 'string'
        ? hero.props.headline
        : typeof data.root?.props?.title === 'string'
          ? data.root.props.title
          : 'Preview';
    return ReactModule.createElement(
      'main',
      { 'data-testid': 'mock-puck-render' },
      ReactModule.createElement('h1', null, heading),
    );
  }

  return { Puck, Render };
});

const event = {
  id: 'evt_1',
  title: 'All Access Chicago',
  slug: 'all-access-chicago',
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

function createPuckEventPageDocument() {
  return createDefaultEventPageDocument({
    eventId: event.id,
    eventTitle: event.title,
    eventDescription: event.description,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timezone: event.timezone,
    venue: event.venue,
    coverImageUrl: '',
    coverImageAlt: event.title,
    publicUrl: `/e/${event.slug}`,
  });
}

const eventPageDocument = createPuckEventPageDocument();

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
  schemaVersion: 2,
  subject: 'Original hosted page',
  previewText: 'Original event page copy.',
  contentJson: eventPageDocument,
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

async function waitForPuckEditor() {
  return screen.findByTestId('puck-editor');
}

function openEventPageMoreActions() {
  const trigger = screen.getByRole('button', { name: 'More actions' });
  fireEvent.pointerDown(trigger);
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown', code: 'ArrowDown' });
}

function clickSaveDraft() {
  openEventPageMoreActions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Save draft' }));
}

function lastSavePayload() {
  const calls = adminApiMock.saveContentVersion.mock.calls;
  return calls[calls.length - 1]?.[1];
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
        output: { puckData: eventPageDocument.editor.data },
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
        token: 'unused',
        url: 'https://checkout.test/e/evt_1?edit=1&token=unused',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        versionId: 'cver_1',
      }),
    );
  });

  it('renders the admin-hosted Puck editor without preview-token or postMessage editing', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    const puck = await waitForPuckEditor();
    expect(puck).toHaveAttribute('data-iframe-enabled', 'true');
    expect(screen.getByTestId('puck-components')).toBeInTheDocument();
    expect(screen.getByTestId('puck-preview')).toBeInTheDocument();
    expect(screen.getByTestId('puck-fields')).toBeInTheDocument();
    expect(screen.queryByTestId('editor-iframe')).not.toBeInTheDocument();
    expect(adminApiMock.mintPreviewToken).not.toHaveBeenCalled();
    expect(adminApiMock.previewContent).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://checkout.test',
          data: {
            source: 'tixkit-event-page-editor',
            type: 'block-change',
            blockId: 'hero',
            block: { type: 'hero', id: 'hero', headline: 'Legacy postMessage edit' },
          },
        }),
      );
    });

    clickSaveDraft();

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalled();
    });
    expect(lastSavePayload()).toEqual(
      expect.objectContaining({
        contentJson: expect.objectContaining({
          schemaVersion: 2,
          editor: expect.objectContaining({
            provider: '@puckeditor/core',
            data: expect.objectContaining({
              root: expect.objectContaining({ props: expect.any(Object) }),
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: 'Hero',
                  props: expect.objectContaining({ headline: 'All Access Chicago' }),
                }),
              ]),
            }),
          }),
        }),
      }),
    );
    expect(JSON.stringify(lastSavePayload())).not.toContain('Legacy postMessage edit');
  });

  it('saves Puck changes as the V2 event-page document payload without rendered artifacts', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Mock Puck change' }));
    clickSaveDraft();

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_event_page',
        expect.objectContaining({
          subject: 'Updated hosted page',
          previewText: 'Updated page copy for {{event.title}}.',
          contentJson: expect.objectContaining({
            schemaVersion: 2,
            editor: expect.objectContaining({
              provider: '@puckeditor/core',
              data: expect.objectContaining({
                root: { props: expect.objectContaining({ title: 'Updated hosted page' }) },
                content: expect.arrayContaining([
                  expect.objectContaining({
                    type: 'Hero',
                    props: expect.objectContaining({
                      headline: 'Updated hosted page',
                      body: 'Updated page copy for {{event.title}}.',
                    }),
                  }),
                ]),
              }),
            }),
          }),
        }),
      );
    });
    expect(lastSavePayload()).not.toHaveProperty('renderedHtml');
    expect(lastSavePayload()).not.toHaveProperty('renderedText');
  });

  it('publishes by saving the current Puck draft before publish', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Mock Puck change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => {
      expect(adminApiMock.publishContentVersion).toHaveBeenCalledWith('cdoc_event_page', 'cver_2');
    });
    expect(lastSavePayload()).toEqual(
      expect.objectContaining({
        subject: 'Updated hosted page',
        contentJson: expect.objectContaining({
          schemaVersion: 2,
          editor: expect.objectContaining({ provider: '@puckeditor/core' }),
        }),
      }),
    );
  });

  it('archives and duplicates through the persisted content lifecycle', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Mock Puck change' }));
    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate page' }));

    await waitFor(() => {
      expect(adminApiMock.duplicateContentDocument).toHaveBeenCalledWith('cdoc_event_page', {
        name: 'All Access Chicago event page Copy',
      });
    });
    const saveCallOrder = adminApiMock.saveContentVersion.mock.invocationCallOrder;
    const duplicateCallOrder = adminApiMock.duplicateContentDocument.mock.invocationCallOrder;
    expect(saveCallOrder[saveCallOrder.length - 1]).toBeLessThan(
      duplicateCallOrder[duplicateCallOrder.length - 1],
    );

    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive page' }));
    await waitFor(() => {
      expect(adminApiMock.archiveContentDocument).toHaveBeenCalledWith('cdoc_event_page');
    });
  });

  it('creates the event-scoped event-page document and initial content-only Puck draft when none exists', async () => {
    adminApiMock.listContentDocuments.mockResolvedValue(ok({ items: [] }));
    adminApiMock.createContentDocument.mockResolvedValue(ok(document));
    adminApiMock.listContentVersions.mockResolvedValue(ok({ items: [] }));
    adminApiMock.saveContentVersion.mockResolvedValue(ok(version));

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
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
          schemaVersion: 2,
          editor: expect.objectContaining({
            provider: '@puckeditor/core',
            data: expect.objectContaining({
              root: expect.objectContaining({ props: expect.any(Object) }),
              content: expect.not.arrayContaining([
                expect.objectContaining({ type: 'Tickets' }),
                expect.objectContaining({ type: 'ResaleTickets' }),
              ]),
            }),
          }),
        }),
      }),
    );
    expect(lastSavePayload()).not.toHaveProperty('renderedHtml');
  });

  it('migrates legacy block drafts into content-only V2 Puck documents on save', async () => {
    adminApiMock.listContentVersions.mockResolvedValue(
      ok({
        items: [
          {
            ...version,
            schemaVersion: 1,
            contentJson: {
              settings: {
                locale: 'en',
                publicPath: '/e/all-access-chicago',
                discovery: { summary: 'Legacy event page copy.', tags: [] },
              },
              blocks: [
                { id: 'hero-legacy', type: 'hero', headline: 'Legacy hero', body: 'Legacy copy' },
                { id: 'tickets-legacy', type: 'tickets', title: 'Tickets' },
              ],
            },
          },
        ],
      }),
    );

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    clickSaveDraft();

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_event_page',
        expect.objectContaining({
          contentJson: expect.objectContaining({
            schemaVersion: 2,
            editor: expect.objectContaining({
              provider: '@puckeditor/core',
              data: expect.objectContaining({
                content: [
                  expect.objectContaining({
                    type: 'Hero',
                    props: expect.objectContaining({ headline: 'Legacy hero' }),
                  }),
                ],
              }),
            }),
          }),
        }),
      );
    });
    expect(JSON.stringify(lastSavePayload())).not.toContain('tickets-legacy');
  });

  it('locks Puck editing actions for archived event pages', async () => {
    adminApiMock.listContentDocuments.mockResolvedValue(
      ok({ items: [{ ...document, status: 'archived' }] }),
    );

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    const puck = await waitForPuckEditor();
    expect(puck).toHaveAttribute('data-editable', 'false');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    openEventPageMoreActions();
    expect(screen.getByRole('menuitem', { name: 'Save draft' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Open preview' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Duplicate page' })).toHaveAttribute(
      'data-disabled',
    );
  });
});
