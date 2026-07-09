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
  listBrands: vi.fn(),
  listTicketTypes: vi.fn(),
  listProducts: vi.fn(),
  listContentDocuments: vi.fn(),
  createContentDocument: vi.fn(),
  listContentVersions: vi.fn(),
  saveContentVersion: vi.fn(),
  previewContent: vi.fn(),
  publishContentVersion: vi.fn(),
  duplicateContentDocument: vi.fn(),
  archiveContentDocument: vi.fn(),
  mintPreviewToken: vi.fn(),
  uploadArtifact: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
}));

const puckDispatchMock = vi.hoisted(() => vi.fn());

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
  let currentOverrides:
    | {
        preview?: (props: { children: React.ReactNode }) => React.ReactNode;
      }
    | undefined;
  let currentData: { root: { props: Record<string, unknown> }; content: MockPuckContent[] } = {
    root: { props: {} },
    content: [],
  };

  function Puck({
    children,
    data,
    iframe,
    onChange,
    onPublish,
    overrides,
    permissions,
    plugins,
  }: {
    children?: React.ReactNode;
    data: { root: { props: Record<string, unknown> }; content: MockPuckContent[] };
    iframe?: { enabled?: boolean };
    onChange?: (data: unknown) => void;
    onPublish?: (data: unknown) => void;
    overrides?: {
      preview?: (props: { children: React.ReactNode }) => React.ReactNode;
    };
    permissions?: { edit?: boolean };
    plugins?: Array<{ name?: string }>;
  }) {
    currentOverrides = overrides;
    currentData = data;
    const changeHeader = () => {
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
          item.type === 'EventHeader' || item.type === 'EventDescription'
            ? {
                ...item,
                props: {
                  ...item.props,
                  ...(item.type === 'EventHeader'
                    ? {
                        title: 'Updated hosted page',
                        description: 'Updated page copy for {{event.title}}.',
                      }
                    : {
                        title: 'Updated hosted page',
                        body: 'Updated page copy for {{event.title}}.',
                      }),
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
        'data-plugins': (plugins ?? [])
          .map((plugin) => plugin.name)
          .filter(Boolean)
          .join(','),
      },
      ReactModule.createElement(
        'button',
        { type: 'button', onClick: changeHeader },
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
  Puck.Preview = () => {
    const nodes = (currentData.content ?? []).map((item) => {
      const key = String(item.props.id ?? item.type);
      if (item.type === 'EventHeader') {
        return ReactModule.createElement(
          'div',
          { key },
          ReactModule.createElement(
            'h1',
            null,
            typeof item.props.title === 'string' ? item.props.title : 'Event',
          ),
        );
      }
      if (item.type === 'Tickets') {
        return ReactModule.createElement(
          'div',
          { key },
          ReactModule.createElement(
            'h2',
            null,
            typeof item.props.title === 'string' ? item.props.title : 'Tickets',
          ),
          ReactModule.createElement('div', null, 'General Admission'),
        );
      }
      if (item.type === 'ResaleTickets') {
        return ReactModule.createElement(
          'h2',
          { key },
          typeof item.props.title === 'string' ? item.props.title : 'Resale tickets',
        );
      }
      if (item.type === 'CheckoutCta') {
        return ReactModule.createElement(
          'button',
          { key, type: 'button' },
          typeof item.props.label === 'string' ? item.props.label : 'Get tickets',
        );
      }
      if (item.type === 'BrandFooter') {
        return ReactModule.createElement(
          'footer',
          { key },
          typeof item.props.label === 'string' && item.props.label
            ? item.props.label
            : 'Powered by Tixkit',
        );
      }
      if (item.type === 'EventDescription') {
        return ReactModule.createElement(
          'h2',
          { key },
          typeof item.props.title === 'string' ? item.props.title : 'Description',
        );
      }
      return ReactModule.createElement('div', { key, 'data-block-type': item.type }, item.type);
    });

    const body = ReactModule.createElement('div', { 'data-testid': 'puck-preview' }, nodes);
    return currentOverrides?.preview ? currentOverrides.preview({ children: body }) : body;
  };
  Puck.Fields = () => ReactModule.createElement('div', { 'data-testid': 'puck-fields' });
  Puck.Outline = () => ReactModule.createElement('div', { 'data-testid': 'puck-outline' });

  function Drawer({ children }: { children?: React.ReactNode }) {
    return ReactModule.createElement(
      'div',
      {
        'data-puck-dnd': 'mock-drawer-void',
        'data-puck-dnd-void': true,
        'data-puck-drawer': true,
      },
      children,
    );
  }

  function Render({
    data,
  }: {
    data: { root?: { props?: { title?: string } }; content?: MockPuckContent[] };
  }) {
    const header = data.content?.find(
      (item) => item.type === 'EventHeader' || item.type === 'EventDescription',
    );
    const heading =
      typeof header?.props.title === 'string'
        ? header.props.title
        : typeof header?.props.title === 'string'
          ? header.props.title
          : typeof data.root?.props?.title === 'string'
            ? data.root.props.title
            : 'Preview';
    return ReactModule.createElement(
      'main',
      { 'data-testid': 'mock-puck-render' },
      ReactModule.createElement('h1', null, heading),
      ReactModule.createElement('h2', null, 'Tickets'),
    );
  }

  function createUsePuck() {
    return <T,>(
      selector: (state: {
        selectedItem: MockPuckContent | null;
        dispatch: (action: unknown) => void;
        appState: {
          data: {
            content: MockPuckContent[];
            root: Record<string, unknown>;
            zones: Record<string, unknown>;
          };
          ui: { isDragging: boolean };
        };
      }) => T,
    ) =>
      selector({
        selectedItem: null,
        dispatch: puckDispatchMock,
        appState: {
          data: {
            content: currentData.content,
            root: currentData.root,
            zones: {},
          },
          ui: { isDragging: false },
        },
      });
  }

  return { Drawer, Puck, Render, createUsePuck };
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
    publicUrl: `/e/${event.id}`,
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
    adminApiMock.listBrands.mockResolvedValue(
      ok([
        {
          id: 'brd_1',
          tenantId: 'tnt_1',
          organizationId: 'org_1',
          name: 'Demo Brand',
          slug: 'demo-brand',
          status: 'active',
          theme: { primaryColor: '#111111' },
          domains: [],
          legalUrls: {
            terms: 'https://example.com/terms',
            privacy: 'https://example.com/privacy',
          },
          whiteLabel: false,
        },
      ]),
    );
    adminApiMock.listTicketTypes.mockResolvedValue(
      ok([
        {
          id: 'tt_ga',
          eventId: 'evt_1',
          name: 'General Admission',
          description: 'Standing room',
          kind: 'paid',
          visibility: 'public',
          status: 'active',
          priceCents: 4500,
          currency: 'USD',
          quantityTotal: 100,
          quantitySold: 12,
          requiresAccessCode: false,
        },
      ]),
    );
    adminApiMock.listProducts.mockResolvedValue(
      ok([
        {
          id: 'prod_parking',
          eventId: 'evt_1',
          name: 'Parking pass',
          description: 'Garage add-on',
          priceCents: 2500,
          currency: 'USD',
          maxPerOrder: 2,
          status: 'active',
          sortOrder: 1,
        },
      ]),
    );
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
    expect(screen.queryByTestId('puck-components')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add page section' }));
    expect(screen.getByTestId('event-page-puck-components')).toBeInTheDocument();
    expect(screen.getByTestId('puck-components')).toBeInTheDocument();
    expect(screen.getByTestId('puck-preview')).toBeInTheDocument();
    expect(screen.getByTestId('editor-public-page-surface')).toBeInTheDocument();
    expect(screen.getByTestId('preview-surface')).toBeInTheDocument();
    expect(screen.getByText('General Admission')).toBeInTheDocument();
    expect(screen.getAllByText('Get tickets').length).toBeGreaterThan(0);
    expect(screen.getByTestId('event-page-inspector')).toBeInTheDocument();
    expect(screen.getByTestId('puck-fields')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Page structure' })).toBeInTheDocument();
    expect(screen.getByTestId('event-page-structure-panel')).toHaveStyle({ width: '320px' });
    expect(screen.getByRole('button', { name: 'Hide page structure panel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close page structure' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resize page structure' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Outline/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Audit/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('event-page-outline')).toBeInTheDocument();
    expect(screen.getByTestId('event-page-document-outline-tree')).toBeInTheDocument();
    expect(screen.queryByTestId('puck-outline')).not.toBeInTheDocument();
    expect(screen.getByText('Event header')).toBeInTheDocument();
    expect(screen.getByText('H1 title')).toBeInTheDocument();
    expect(screen.getByText('Event details row')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getAllByText('H2 title').length).toBeGreaterThan(0);
    expect(screen.getByText('Body copy')).toBeInTheDocument();
    expect(screen.getByText('Extra overlay content')).toBeInTheDocument();
    expect(screen.getByText('No items')).toBeInTheDocument();
    expect(screen.getByText('Ticket list')).toBeInTheDocument();
    expect(screen.queryByTestId('event-page-heading-audit')).not.toBeInTheDocument();
    expect(screen.queryByText('Heading map')).not.toBeInTheDocument();
    const h1TitleButton = screen.getByRole('button', { name: /H1 title/i });
    const brandBadgeButton = screen.getByRole('button', { name: /Brand badge/i });
    const detailsRowButton = screen.getByRole('button', { name: /Event details row/i });
    fireEvent.click(h1TitleButton);
    expect(puckDispatchMock).toHaveBeenCalledWith({
      type: 'setUi',
      ui: { itemSelector: { index: 0 } },
    });
    // Selected inner field is current; parent section is ancestor-highlighted only.
    expect(h1TitleButton).toHaveAttribute('aria-current', 'true');
    expect(h1TitleButton).toHaveAttribute('data-outline-role', 'selected');
    const eventHeaderButton = screen.getByRole('button', { name: /Event header/i });
    expect(eventHeaderButton).toHaveAttribute('data-outline-role', 'ancestor');
    expect(eventHeaderButton).not.toHaveAttribute('aria-current');
    // Sibling inners in the same section stay unhighlighted.
    expect(brandBadgeButton).not.toHaveAttribute('aria-current');
    expect(brandBadgeButton).toHaveAttribute('data-outline-role', 'idle');
    expect(detailsRowButton).not.toHaveAttribute('aria-current');
    expect(detailsRowButton).toHaveAttribute('data-outline-role', 'idle');

    const descriptionIndex = eventPageDocument.editor.data.content.findIndex(
      (item) => item.type === 'EventDescription',
    );
    const descriptionBlock = eventPageDocument.editor.data.content[descriptionIndex];
    const descriptionBlockId =
      typeof descriptionBlock?.props.id === 'string' ? descriptionBlock.props.id : undefined;
    expect(descriptionBlockId).toBeTruthy();
    const h2TitleButton = screen.getByRole('button', { name: /H2 title About this event/i });
    const descriptionButton = screen.getByRole('button', { name: /Description$/i });
    const canvasBlock = window.document.createElement('div');
    const scrollIntoView = vi.fn();
    const dispatchEvent = vi.spyOn(canvasBlock, 'dispatchEvent');
    const frameDocumentQuerySelector = vi.fn((selector: string) =>
      selector === `[data-block-id="${descriptionBlockId}"]` ? canvasBlock : null,
    );
    const originalQuerySelector = window.document.querySelector.bind(window.document);
    const documentQuerySelector = vi
      .spyOn(window.document, 'querySelector')
      .mockImplementation((selector: string) => {
        if (selector === '[data-testid="editor-canvas"] iframe') {
          return {
            contentDocument: {
              defaultView: undefined,
              querySelector: frameDocumentQuerySelector,
            },
            style: {},
          } as unknown as HTMLIFrameElement;
        }
        return originalQuerySelector(selector);
      });
    canvasBlock.scrollIntoView = scrollIntoView;
    puckDispatchMock.mockClear();
    fireEvent.click(h2TitleButton);
    documentQuerySelector.mockRestore();
    expect(puckDispatchMock).toHaveBeenCalledWith({
      type: 'setUi',
      ui: { itemSelector: { index: descriptionIndex } },
    });
    expect(frameDocumentQuerySelector).toHaveBeenCalledWith(
      `[data-block-id="${descriptionBlockId}"]`,
    );
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'nearest',
      inline: 'nearest',
    });
    expect(dispatchEvent).toHaveBeenCalledWith(expect.any(MouseEvent));
    expect(h2TitleButton).toHaveAttribute('aria-current', 'true');
    expect(descriptionButton).toHaveAttribute('data-outline-role', 'ancestor');
    dispatchEvent.mockRestore();

    expect(puck).toHaveAttribute('data-plugins', '');
    expect(screen.queryByRole('complementary', { name: 'Page settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Page settings' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('editor-iframe')).not.toBeInTheDocument();
    expect(adminApiMock.mintPreviewToken).not.toHaveBeenCalled();
    expect(adminApiMock.previewContent).not.toHaveBeenCalled();
    expect(adminApiMock.listBrands).toHaveBeenCalled();
    expect(adminApiMock.listTicketTypes).toHaveBeenCalledWith('evt_1');
    expect(adminApiMock.listProducts).toHaveBeenCalledWith('evt_1');

    fireEvent.click(screen.getByRole('button', { name: 'Close page structure' }));
    expect(screen.queryByTestId('event-page-structure-panel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show page structure panel' }));
    expect(screen.getByTestId('event-page-structure-panel')).toBeInTheDocument();
    expect(screen.getByTestId('event-page-outline')).toBeInTheDocument();
    expect(screen.queryByTestId('event-page-heading-audit')).not.toBeInTheDocument();

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
                expect.objectContaining({ type: 'EventHeader' }),
                expect.objectContaining({ type: 'Tickets' }),
                expect.objectContaining({ type: 'CheckoutCta' }),
                expect.objectContaining({ type: 'BrandFooter' }),
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
                    type: 'EventHeader',
                    props: expect.objectContaining({ title: 'Updated hosted page' }),
                  }),
                  expect.objectContaining({ type: 'Tickets' }),
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

  it('creates the event-scoped event-page document and initial full-chrome Puck draft when none exists', async () => {
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
              content: expect.arrayContaining([
                expect.objectContaining({ type: 'EventHeader' }),
                expect.objectContaining({ type: 'Tickets' }),
                expect.objectContaining({ type: 'ResaleTickets' }),
                expect.objectContaining({ type: 'CheckoutCta' }),
                expect.objectContaining({ type: 'BrandFooter' }),
              ]),
            }),
          }),
        }),
      }),
    );
    expect(lastSavePayload()).not.toHaveProperty('renderedHtml');
  });

  it('migrates legacy block drafts into full-page V2 Puck documents on save', async () => {
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
                content: expect.arrayContaining([
                  expect.objectContaining({
                    type: 'EventDescription',
                    props: expect.objectContaining({ title: 'Legacy hero' }),
                  }),
                ]),
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
