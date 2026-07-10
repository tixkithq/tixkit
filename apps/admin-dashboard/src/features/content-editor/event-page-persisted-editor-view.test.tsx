import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  updateContentDocument: vi.fn(),
  listContentVersions: vi.fn(),
  saveContentVersion: vi.fn(),
  previewContent: vi.fn(),
  publishContentVersion: vi.fn(),
  duplicateContentDocument: vi.fn(),
  archiveContentDocument: vi.fn(),
  uploadArtifact: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
}));

const puckDispatchMock = vi.hoisted(() => vi.fn());
const puckSelectionMock = vi.hoisted(() => ({ index: null as number | null }));
const permissionCanMock = vi.hoisted(() => vi.fn((_permission?: string) => true));

vi.mock('@/lib/api', () => ({
  adminApi: adminApiMock,
}));

vi.mock('sonner', () => ({
  toast: toastMock,
}));

vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => ({
    permissions: ['events.read', 'events.write'],
    can: permissionCanMock,
    loading: false,
    error: null,
  }),
}));

vi.mock('@puckeditor/core', async () => {
  const ReactModule = await import('react');
  let currentOverrides:
    | {
        drawerItem?: (props: { children: React.ReactNode; name: string }) => React.ReactNode;
        preview?: (props: { children: React.ReactNode }) => React.ReactNode;
      }
    | undefined;
  let currentData: {
    root: { props: Record<string, unknown> };
    content: MockPuckContent[];
  } = {
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
    data: {
      root: { props: Record<string, unknown> };
      content: MockPuckContent[];
    };
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
      ReactModule.createElement(
        'button',
        {
          type: 'button',
          onClick: () =>
            onChange?.({
              ...data,
              root: {
                props: {
                  ...data.root.props,
                  category: '',
                  tags: '',
                  coverImageUrl: '',
                  socialImageUrl: '',
                  title: '',
                  description: '',
                },
              },
            }),
        },
        'Mock clear discovery',
      ),
      children,
    );
  }

  Puck.Components = () => {
    const customEmbed = currentOverrides?.drawerItem?.({
      children: 'Custom embed',
      name: 'CustomEmbed',
    });
    return ReactModule.createElement('div', { 'data-testid': 'puck-components' }, customEmbed);
  };
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
  function MockFields() {
    const [expanded, setExpanded] = ReactModule.useState(true);
    return ReactModule.createElement(
      'div',
      { 'data-testid': 'puck-fields', className: '_PuckFields_test' },
      ReactModule.createElement(
        'div',
        { className: '_PuckFields-field_test' },
        ReactModule.createElement(
          'div',
          {
            'data-field-section': 'Layout',
            'data-section-expanded': String(expanded),
          },
          ReactModule.createElement(
            'button',
            {
              'aria-expanded': expanded,
              onClick: () => setExpanded((value) => !value),
              type: 'button',
            },
            'Layout',
          ),
        ),
      ),
      ReactModule.createElement(
        'div',
        { className: '_PuckFields-field_test' },
        ReactModule.createElement('label', null, 'Alignment'),
      ),
      ReactModule.createElement(
        'div',
        { className: '_PuckFields-field_test' },
        ReactModule.createElement('label', null, 'Background color'),
      ),
    );
  }
  Puck.Fields = MockFields;
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
    data: {
      root?: { props?: { title?: string } };
      content?: MockPuckContent[];
    };
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
    const descriptionHeading = data.content?.find((item) => item.type === 'EventDescription')?.props
      .title;
    return ReactModule.createElement(
      'main',
      { 'data-testid': 'mock-puck-render' },
      ReactModule.createElement('h1', null, heading),
      typeof descriptionHeading === 'string'
        ? ReactModule.createElement('p', null, descriptionHeading)
        : null,
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
          ui: {
            isDragging: boolean;
            itemSelector: { index: number } | null;
          };
        };
      }) => T,
    ) =>
      selector({
        selectedItem:
          puckSelectionMock.index === null
            ? null
            : (currentData.content[puckSelectionMock.index] ?? null),
        dispatch: puckDispatchMock,
        appState: {
          data: {
            content: currentData.content,
            root: currentData.root,
            zones: {},
          },
          ui: {
            isDragging: false,
            itemSelector:
              puckSelectionMock.index === null ? null : { index: puckSelectionMock.index },
          },
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
    puckSelectionMock.index = null;
    permissionCanMock.mockReturnValue(true);
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
    adminApiMock.updateContentDocument.mockResolvedValue(
      ok({ ...document, name: 'Renamed event page' }),
    );
    adminApiMock.previewContent.mockResolvedValue(
      ok({
        channel: 'event_page',
        output: { puckData: eventPageDocument.editor.data },
        validation: { valid: true, severity: 'warning', issues: [] },
      }),
    );
    adminApiMock.publishContentVersion.mockResolvedValue(
      ok({
        document: {
          ...document,
          status: 'published',
          publishedVersionId: 'cver_2',
        },
        version: { ...savedVersion, status: 'published' },
      }),
    );
    adminApiMock.duplicateContentDocument.mockResolvedValue(
      ok({
        ...document,
        id: 'cdoc_event_page_copy',
        name: 'All Access Chicago event page Copy',
      }),
    );
    adminApiMock.archiveContentDocument.mockResolvedValue(ok({ ...document, status: 'archived' }));
  });

  it('renders the admin-hosted Puck editor without preview-token or postMessage editing', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    const puck = await waitForPuckEditor();
    expect(puck).toHaveAttribute('data-iframe-enabled', 'true');
    expect(screen.queryByTestId('puck-components')).not.toBeInTheDocument();
    const navigator = screen.getByTestId('event-page-navigator-panel');
    fireEvent.click(within(navigator).getByRole('button', { name: /^Add$/ }));
    expect(screen.getByTestId('event-page-puck-components')).toBeInTheDocument();
    const sectionSearch = screen.getByRole('searchbox', {
      name: 'Search page sections',
    });
    expect(sectionSearch).toBeInTheDocument();
    expect(screen.getByTestId('puck-components')).toBeInTheDocument();
    fireEvent.change(sectionSearch, { target: { value: 'not a section' } });
    expect(screen.getByRole('status')).toHaveTextContent('No sections match “not a section”.');
    fireEvent.click(within(navigator).getByRole('button', { name: /^Sections$/ }));
    expect(screen.getByTestId('puck-preview')).toBeInTheDocument();
    expect(screen.getByTestId('editor-public-page-surface')).toBeInTheDocument();
    expect(screen.getByTestId('preview-surface')).toBeInTheDocument();
    expect(screen.getByText('General Admission')).toBeInTheDocument();
    expect(screen.getAllByText('Get tickets').length).toBeGreaterThan(0);
    expect(screen.getByTestId('event-page-inspector')).toBeInTheDocument();
    expect(screen.getByTestId('puck-fields')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Page builder' })).toBeInTheDocument();
    expect(screen.getByTestId('event-page-navigator-panel')).toHaveStyle({
      width: '288px',
    });
    expect(screen.getByRole('button', { name: 'Page builder' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close page builder' })).toBeInTheDocument();
    const resizeHandle = screen.getByRole('slider', {
      name: 'Resize page builder',
    });
    expect(resizeHandle).toHaveValue('288');
    fireEvent.keyDown(resizeHandle, { key: 'ArrowRight' });
    expect(resizeHandle).toHaveValue('300');
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
    expect(screen.queryByText('Extra overlay content')).not.toBeInTheDocument();
    expect(screen.queryByText('No items')).not.toBeInTheDocument();
    expect(screen.getByText('Ticket list')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move Event header down' }));
    expect(puckDispatchMock).toHaveBeenCalledWith({
      type: 'reorder',
      sourceIndex: 0,
      destinationIndex: 1,
      destinationZone: 'root:default-zone',
    });
    expect(screen.queryByTestId('event-page-heading-audit')).not.toBeInTheDocument();
    expect(screen.queryByText('Heading map')).not.toBeInTheDocument();
    const h1TitleButton = screen.getByRole('button', { name: /H1 title/i });
    const brandBadgeButton = screen.getByRole('button', {
      name: /Brand badge/i,
    });
    const detailsRowButton = screen.getByRole('button', {
      name: /Event details row/i,
    });
    fireEvent.click(h1TitleButton);
    expect(puckDispatchMock).toHaveBeenCalledWith({
      type: 'setUi',
      ui: { itemSelector: { index: 0 } },
    });
    // Selected inner field is current; parent section is ancestor-highlighted only.
    expect(h1TitleButton).toHaveAttribute('aria-current', 'true');
    expect(h1TitleButton).toHaveAttribute('data-outline-role', 'selected');
    const eventHeaderButton = screen.getByRole('button', {
      name: 'Event header',
    });
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
    const escapedDescriptionTitleTargetId = `${descriptionBlockId}\\:title`;
    const h2TitleButton = screen.getByRole('button', {
      name: /H2 title About this event/i,
    });
    const descriptionButton = screen.getByRole('button', {
      name: 'Description',
    });
    const canvasBlock = window.document.createElement('div');
    const scrollIntoView = vi.fn();
    const frameDocumentQuerySelector = vi.fn((selector: string) =>
      selector === `[data-event-page-outline-target="${escapedDescriptionTitleTargetId}"]` ||
      selector === `[data-event-page-outline-target="${descriptionBlockId}:title"]`
        ? canvasBlock
        : null,
    );
    const frameDocumentQuerySelectorAll = vi.fn(() => []);
    const originalQuerySelector = window.document.querySelector.bind(window.document);
    const documentQuerySelector = vi
      .spyOn(window.document, 'querySelector')
      .mockImplementation((selector: string) => {
        if (selector === '[data-testid="editor-canvas"] iframe') {
          return {
            contentDocument: {
              defaultView: undefined,
              querySelector: frameDocumentQuerySelector,
              querySelectorAll: frameDocumentQuerySelectorAll,
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
      expect.stringMatching(/data-event-page-outline-target=.*title/),
    );
    expect(canvasBlock).toHaveAttribute('data-event-page-outline-selected', 'true');
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'nearest',
      inline: 'nearest',
    });
    expect(h2TitleButton).toHaveAttribute('aria-current', 'true');
    expect(descriptionButton).toHaveAttribute('data-outline-role', 'ancestor');

    expect(puck).toHaveAttribute('data-plugins', '');
    expect(screen.queryByRole('complementary', { name: 'Page settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Page settings' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('editor-iframe')).not.toBeInTheDocument();
    expect(adminApiMock.previewContent).not.toHaveBeenCalled();
    expect(adminApiMock.listBrands).toHaveBeenCalled();
    expect(adminApiMock.listTicketTypes).toHaveBeenCalledWith('evt_1');
    expect(adminApiMock.listProducts).toHaveBeenCalledWith('evt_1');

    fireEvent.click(screen.getByRole('button', { name: 'Close page builder' }));
    expect(screen.queryByTestId('event-page-navigator-panel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Page builder' }));
    expect(screen.getByTestId('event-page-navigator-panel')).toBeInTheDocument();
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
            block: {
              type: 'hero',
              id: 'hero',
              headline: 'Legacy postMessage edit',
            },
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
  }, 15_000);

  it('removes custom embeds from every insertion path without settings permission', async () => {
    permissionCanMock.mockImplementation((permission?: string) => permission !== 'settings.write');

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    const navigator = screen.getByTestId('event-page-navigator-panel');
    fireEvent.click(within(navigator).getByRole('button', { name: /^Add$/ }));

    const componentLibrary = screen.getByTestId('event-page-puck-components');
    expect(componentLibrary.querySelector('[data-event-page-drawer-hidden]')).toBeInTheDocument();
    expect(
      within(componentLibrary).queryByRole('button', {
        name: 'Add Custom embed',
      }),
    ).not.toBeInTheDocument();
    expect(within(componentLibrary).queryByText('Custom embed')).not.toBeInTheDocument();
    expect(componentLibrary.querySelector('[draggable="true"]')).toBeNull();
    expect(puckDispatchMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'insert',
        componentType: 'CustomEmbed',
      }),
    );
  });

  it('makes settings searchable and keeps field groups genuinely collapsible', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    const inspector = screen.getByTestId('event-page-inspector');
    expect(within(inspector).getByText(/Adjust the page theme/)).toBeInTheDocument();
    expect(
      within(inspector).queryByRole('navigation', {
        name: 'Settings sections',
      }),
    ).not.toBeInTheDocument();
    const jumpToGroup = within(inspector).getByRole('combobox', {
      name: 'Jump to setting group',
    });
    expect(within(jumpToGroup).getByRole('option', { name: 'Layout' })).toBeInTheDocument();
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    fireEvent.change(jumpToGroup, { target: { value: 'Layout' } });
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start',
    });
    const layout = within(inspector).getByRole('button', { name: 'Layout' });
    const controlledSettingIds = layout.getAttribute('aria-controls')?.split(' ') ?? [];
    expect(controlledSettingIds).toHaveLength(2);
    for (const id of controlledSettingIds) {
      const setting = window.document.getElementById(id);
      expect(setting).toHaveAttribute('aria-labelledby', layout.id);
      expect(setting).toHaveAttribute('data-settings-group', 'Layout');
    }
    fireEvent.click(layout);
    await waitFor(() => expect(layout).toHaveAttribute('aria-expanded', 'false'));
    expect(
      within(inspector).getByText('Alignment').closest('[data-settings-filter-hidden]'),
    ).not.toBeNull();

    fireEvent.change(within(inspector).getByRole('searchbox', { name: 'Search settings' }), {
      target: { value: 'alignment' },
    });
    await waitFor(() => {
      expect(
        within(inspector).getByText('Alignment').closest('[data-settings-filter-hidden]'),
      ).toBeNull();
      expect(
        within(inspector).getByText('Background color').closest('[data-settings-filter-hidden]'),
      ).not.toBeNull();
    });
  });

  it('round-trips between selected-section and page settings scopes', async () => {
    puckSelectionMock.index = 0;
    const view = render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    const inspector = screen.getByTestId('event-page-inspector');
    const sectionScope = within(inspector).getByRole('button', {
      name: 'This section',
    });
    const pageScope = within(inspector).getByRole('button', {
      name: 'Page styles',
    });
    expect(sectionScope).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(pageScope);
    expect(puckDispatchMock).toHaveBeenCalledWith({
      type: 'setUi',
      ui: { itemSelector: null },
      recordHistory: false,
    });

    puckSelectionMock.index = null;
    view.rerender(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));
    expect(pageScope).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(sectionScope);
    expect(puckDispatchMock).toHaveBeenCalledWith({
      type: 'setUi',
      ui: { itemSelector: { index: 0 } },
      recordHistory: false,
    });
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
                root: {
                  props: expect.objectContaining({
                    title: 'Updated hosted page',
                  }),
                },
                content: expect.arrayContaining([
                  expect.objectContaining({
                    type: 'EventHeader',
                    props: expect.objectContaining({
                      title: 'Updated hosted page',
                    }),
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

  it('keeps nested overlay selections anchored to their owning root section', async () => {
    const nestedDocument = structuredClone(eventPageDocument);
    const descriptionIndex = nestedDocument.editor.data.content.findIndex(
      (item) => item.type === 'EventDescription',
    );
    const description = nestedDocument.editor.data.content[descriptionIndex];
    if (!description) throw new Error('Expected the default event description block');
    (description.props as Record<string, unknown>).imageOverlay = [
      {
        type: 'RichText',
        props: {
          id: 'nested-rich-text',
          body: 'Nested event story',
        },
      },
    ];
    adminApiMock.listContentVersions.mockResolvedValue(
      ok({ items: [{ ...version, contentJson: nestedDocument }] }),
    );

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    puckDispatchMock.mockClear();
    fireEvent.click(
      within(screen.getByTestId('event-page-outline')).getByRole('button', {
        name: /^Rich text$/,
      }),
    );

    expect(puckDispatchMock).toHaveBeenCalledWith({
      type: 'setUi',
      ui: { itemSelector: { index: descriptionIndex } },
    });
  });

  it('previews unsaved changes without creating a content version', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    await screen.findByText('Saved');
    adminApiMock.saveContentVersion.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Mock Puck change' }));
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();

    const header = screen.getByLabelText('Editor header');
    fireEvent.click(within(header).getByRole('button', { name: 'Preview' }));

    expect(screen.getByTestId('preview-mode-public-page-surface')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Updated hosted page' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'mobile preview' }));
    expect(screen.getByTestId('preview-mode-public-page-surface')).toHaveStyle({
      width: '390px',
      maxWidth: '100%',
    });
    expect(adminApiMock.saveContentVersion).not.toHaveBeenCalled();
  });

  it('provides a direct mobile escape from the JSON view', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'View page JSON' }));
    expect(screen.getByRole('main', { name: 'Event page JSON' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to editor' }));
    expect(screen.getByTestId('puck-editor')).toBeInTheDocument();
  });

  it('publishes by saving the current Puck draft before publish', async () => {
    let resolvePublish: ((value: ReturnType<typeof ok>) => void) | undefined;
    adminApiMock.publishContentVersion.mockReturnValue(
      new Promise((resolve) => {
        resolvePublish = resolve;
      }),
    );
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Mock Puck change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect(screen.getByTestId('publish-review-drawer')).toBeInTheDocument();
    expect(screen.getByText('Review and publish')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Review and publish' })).toHaveAttribute(
      'aria-modal',
      'true',
    );
    expect(screen.getByText('New draft v2')).toBeInTheDocument();
    expect(screen.getByTestId('puck-editor').closest('[inert]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Publish now' }));

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
    const publishButton = screen.getByRole('button', { name: 'Publishing…' });
    expect(publishButton).toBeDisabled();
    expect(
      within(screen.getByLabelText('Editor header')).getByRole('button', {
        name: 'Publish',
      }),
    ).toBeDisabled();
    fireEvent.click(publishButton);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Review and publish' }), {
      key: 'Escape',
    });
    expect(screen.getByTestId('publish-review-drawer')).toBeInTheDocument();
    expect(adminApiMock.publishContentVersion).toHaveBeenCalledTimes(1);
    resolvePublish?.(
      ok({
        document: {
          ...document,
          status: 'published',
          publishedVersionId: 'cver_2',
        },
        version: { ...savedVersion, status: 'published' },
      }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId('publish-review-drawer')).not.toBeInTheDocument();
    });
  });

  it('traps focus in mobile editor panels and restores the invoking tool', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    const mobileTools = screen.getByRole('navigation', {
      name: 'Event page tools',
    });
    const sectionsTool = within(mobileTools).getByRole('button', {
      name: 'Sections',
    });
    sectionsTool.focus();
    fireEvent.click(sectionsTool);

    const panel = screen.getByRole('dialog', { name: 'Sections panel' });
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('editor-canvas').querySelector('[inert]')).not.toBeNull();
    await waitFor(() => {
      expect(panel).toContainElement(window.document.activeElement as HTMLElement);
    });
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(panel).not.toBeInTheDocument());
    expect(sectionsTool).toHaveFocus();

    fireEvent.click(sectionsTool);
    const reopenedPanel = screen.getByRole('dialog', {
      name: 'Sections panel',
    });
    fireEvent.click(
      within(reopenedPanel).getByRole('button', {
        name: 'Event header',
      }),
    );
    expect(reopenedPanel).not.toBeInTheDocument();

    const addTool = within(mobileTools).getByRole('button', { name: 'Add' });
    fireEvent.click(addTool);
    const addPanel = screen.getByRole('dialog', { name: 'Add sections panel' });
    expect(addPanel).toHaveAttribute('aria-modal', 'false');
    expect(addPanel).toHaveClass('top-[34%]');
    expect(screen.getByTestId('editor-canvas').querySelector('[inert]')).toBeNull();
    await waitFor(() => {
      expect(
        within(addPanel).getByRole('searchbox', {
          name: 'Search page sections',
        }),
      ).toHaveFocus();
    });
    fireEvent.click(within(addPanel).getByRole('button', { name: 'Close page builder' }));
    fireEvent.click(within(mobileTools).getByRole('button', { name: 'Settings' }));
    const settingsPanel = screen.getByRole('dialog', {
      name: 'Settings panel',
    });
    expect(settingsPanel).toHaveClass('top-[10%]');
    expect(settingsPanel).toHaveAttribute('aria-modal', 'true');
  });

  it('keeps the saved status when publishing the saved draft fails', async () => {
    adminApiMock.publishContentVersion.mockResolvedValue({
      ok: false,
      error: { message: 'Publish service unavailable' },
    });
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish now' }));

    expect((await screen.findAllByText('Publish service unavailable')).length).toBeGreaterThan(0);
    expect(within(screen.getByLabelText('Editor header')).getByText('Saved')).toBeInTheDocument();
    expect(screen.queryByText('Save failed')).not.toBeInTheDocument();
    expect(screen.getByTestId('publish-review-drawer')).toBeInTheDocument();
  });

  it('reuses the saved draft when retrying a failed publish', async () => {
    adminApiMock.publishContentVersion
      .mockResolvedValueOnce({
        ok: false,
        error: { message: 'Publish service unavailable' },
      })
      .mockResolvedValueOnce(
        ok({
          document: {
            ...document,
            status: 'published',
            publishedVersionId: 'cver_2',
          },
          version: { ...savedVersion, status: 'published' },
        }),
      );
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish now' }));
    await screen.findAllByText('Publish service unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Publish now' }));

    await waitFor(() => {
      expect(adminApiMock.publishContentVersion).toHaveBeenCalledTimes(2);
    });
    expect(adminApiMock.saveContentVersion).toHaveBeenCalledTimes(1);
  });

  it('keeps publish blockers visible and returns directly to the invalid block', async () => {
    const invalidDocument = structuredClone(eventPageDocument);
    const invalidIndex = invalidDocument.editor.data.content.length;
    invalidDocument.editor.data.content.push({
      type: 'Media',
      props: {
        id: 'invalid-media',
        imageUrl: 'javascript:alert(1)',
        imageAlt: '',
      },
    });
    adminApiMock.listContentVersions.mockResolvedValue(
      ok({ items: [{ ...version, contentJson: invalidDocument }] }),
    );

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const review = screen.getByTestId('publish-review-drawer');
    expect(within(review).getByText(/publish blocker/)).toBeInTheDocument();
    expect(within(review).getByRole('button', { name: 'Publish now' })).toBeDisabled();

    puckDispatchMock.mockClear();
    fireEvent.click(within(review).getAllByRole('button', { name: 'Edit issue' })[0]!);
    await waitFor(() => {
      expect(puckDispatchMock).toHaveBeenCalledWith({
        type: 'setUi',
        ui: { itemSelector: { index: invalidIndex } },
      });
    });
    expect(screen.queryByTestId('publish-review-drawer')).not.toBeInTheDocument();
    expect(screen.getByTestId('editor-canvas').querySelector('[inert]')).toBeNull();
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

  it('renames the content document without changing page content', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'All Access Chicago event page',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Rename event page' });
    fireEvent.change(within(dialog).getByLabelText('Document name'), {
      target: { value: 'Renamed event page' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));

    await waitFor(() => {
      expect(adminApiMock.updateContentDocument).toHaveBeenCalledWith('cdoc_event_page', {
        name: 'Renamed event page',
      });
    });
    expect(screen.getByRole('button', { name: 'Renamed event page' })).toBeInTheDocument();
    expect(adminApiMock.saveContentVersion).not.toHaveBeenCalled();
  });

  it('lists saved versions and previews a historical snapshot without replacing the draft', async () => {
    const historicalDocument = structuredClone(eventPageDocument);
    const historicalHeader = historicalDocument.editor.data.content.find(
      (block) => block.type === 'EventDescription',
    );
    if (historicalHeader) historicalHeader.props.title = 'Historical page';
    adminApiMock.listContentVersions.mockResolvedValue(
      ok({
        items: [{ ...version, contentJson: historicalDocument }, savedVersion],
      }),
    );
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Version history' }));
    const history = screen.getByRole('dialog', { name: 'Version history' });
    expect(within(history).getAllByText('Version 2').length).toBeGreaterThan(0);
    expect(within(history).getAllByText('Version 1').length).toBeGreaterThan(0);
    const previewButtons = within(history).getAllByRole('button', {
      name: 'Preview',
    });
    fireEvent.click(previewButtons[1]!);

    expect(screen.getByTestId('preview-mode-public-page-surface')).toBeInTheDocument();
    expect(screen.getByText('Historical page')).toBeInTheDocument();
    expect(adminApiMock.saveContentVersion).not.toHaveBeenCalled();
  });

  it('compares and restores a historical version as a new draft', async () => {
    const historicalDocument = structuredClone(eventPageDocument);
    const description = historicalDocument.editor.data.content.find(
      (block) => block.type === 'EventDescription',
    );
    if (description) description.props.title = 'Restored description';
    adminApiMock.listContentDocuments.mockResolvedValue(
      ok({ items: [{ ...document, currentDraftVersionId: 'cver_2' }] }),
    );
    adminApiMock.listContentVersions.mockResolvedValue(
      ok({
        items: [{ ...version, contentJson: historicalDocument }, savedVersion],
      }),
    );
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Version history' }));
    const history = screen.getByRole('dialog', { name: 'Version history' });
    fireEvent.click(within(history).getAllByText('Compare with current draft')[1]!);
    expect(
      within(history).getAllByText((_, element) => element?.tagName === 'PRE')[2],
    ).toHaveTextContent('Restored description');
    fireEvent.click(within(history).getAllByRole('button', { name: 'Restore' })[1]!);

    expect(screen.queryByRole('dialog', { name: 'Version history' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Restored description').length).toBeGreaterThan(0);
    expect(screen.getByText('Restored version 1 as a new draft')).toBeInTheDocument();
  });

  it('shows invalid historical-version errors inside version history', async () => {
    adminApiMock.listContentVersions.mockResolvedValue(
      ok({
        items: [
          version,
          {
            ...version,
            id: 'cver_invalid',
            versionNumber: 0,
            contentJson: { invalid: true },
          },
        ],
      }),
    );
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Version history' }));
    const history = screen.getByRole('dialog', { name: 'Version history' });
    fireEvent.click(within(history).getAllByRole('button', { name: 'Preview' })[1]!);

    expect(within(history).getByRole('alert')).toHaveTextContent(
      'Version 0 is not a valid event page.',
    );
  });

  it('keeps save failures retryable and clears the failed state after a successful retry', async () => {
    adminApiMock.saveContentVersion
      .mockResolvedValueOnce({
        ok: false,
        error: { message: 'Draft save unavailable' },
      })
      .mockResolvedValue(ok(savedVersion));
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Mock Puck change' }));
    clickSaveDraft();
    expect((await screen.findAllByText('Draft save unavailable')).length).toBeGreaterThan(0);
    expect(
      within(screen.getByLabelText('Editor header')).getByText('Save failed'),
    ).toBeInTheDocument();

    clickSaveDraft();
    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledTimes(2);
    });
    expect(within(screen.getByLabelText('Editor header')).getByText('Saved')).toBeInTheDocument();
    expect(screen.queryByText('Draft save unavailable')).not.toBeInTheDocument();
  });

  it('autosaves a settled canvas edit after the debounce window', async () => {
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Mock Puck change' }));

    await waitFor(() => expect(adminApiMock.saveContentVersion).toHaveBeenCalledTimes(1), {
      timeout: 2500,
    });
    expect(lastSavePayload()).toEqual(expect.objectContaining({ subject: 'Updated hosted page' }));
  });

  it('persists cleared optional discovery metadata instead of restoring stale values', async () => {
    const documentWithDiscovery = structuredClone(eventPageDocument);
    documentWithDiscovery.settings.discovery = {
      ...documentWithDiscovery.settings.discovery,
      category: 'Concert',
      tags: ['music', 'nightlife'],
      coverImageUrl: 'https://assets.example.test/cover.png',
      socialImageUrl: 'https://assets.example.test/social.png',
    };
    adminApiMock.listContentVersions.mockResolvedValue(
      ok({ items: [{ ...version, contentJson: documentWithDiscovery }] }),
    );
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Mock clear discovery' }));
    clickSaveDraft();
    await waitFor(() => expect(adminApiMock.saveContentVersion).toHaveBeenCalled());

    expect(lastSavePayload()?.contentJson.settings.discovery).toEqual(
      expect.objectContaining({
        category: undefined,
        tags: [],
        coverImageUrl: undefined,
        socialImageUrl: undefined,
      }),
    );
  });

  it('reports duplicate and archive failures without mislabeling the saved draft', async () => {
    adminApiMock.duplicateContentDocument.mockResolvedValue({
      ok: false,
      error: { message: 'Duplicate unavailable' },
    });
    adminApiMock.archiveContentDocument.mockResolvedValue({
      ok: false,
      error: { message: 'Archive unavailable' },
    });
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    await waitForPuckEditor();
    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate page' }));
    expect((await screen.findAllByText('Duplicate unavailable')).length).toBeGreaterThan(0);
    expect(within(screen.getByLabelText('Editor header')).getByText('Saved')).toBeInTheDocument();

    openEventPageMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive page' }));
    expect((await screen.findAllByText('Archive unavailable')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Save failed')).not.toBeInTheDocument();
  });

  it('recovers from an initial editor load failure through Retry', async () => {
    adminApiMock.getEvent
      .mockResolvedValueOnce({
        ok: false,
        error: { message: 'Event temporarily unavailable' },
      })
      .mockResolvedValue(ok(event));
    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    expect(await screen.findByText('Event temporarily unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitForPuckEditor();
    expect(adminApiMock.getEvent).toHaveBeenCalledTimes(2);
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

  it('migrates legacy block drafts into full-page V2 Puck documents without Hero blocks on save', async () => {
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
                {
                  id: 'hero-legacy',
                  type: 'hero',
                  headline: 'Legacy hero',
                  body: 'Legacy copy',
                },
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
                    type: 'EventHeader',
                  }),
                  expect.objectContaining({
                    type: 'EventDescription',
                  }),
                ]),
              }),
            }),
          }),
        }),
      );
    });
    expect(JSON.stringify(lastSavePayload())).not.toContain('hero-legacy');
    expect(JSON.stringify(lastSavePayload())).not.toContain('Legacy hero');
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
    fireEvent.click(screen.getByRole('button', { name: 'Mock Puck publish' }));
    expect(adminApiMock.saveContentVersion).not.toHaveBeenCalled();
    expect(adminApiMock.publishContentVersion).not.toHaveBeenCalled();

    openEventPageMoreActions();
    expect(screen.getByRole('menuitem', { name: 'Save draft' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Preview current draft' })).toHaveAttribute(
      'data-disabled',
    );
    expect(screen.getByRole('menuitem', { name: 'Duplicate page' })).toHaveAttribute(
      'data-disabled',
    );
  });

  it('gates every mutation for users without events.write', async () => {
    permissionCanMock.mockReturnValue(false);

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    const puck = await waitForPuckEditor();
    expect(puck).toHaveAttribute('data-editable', 'false');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    openEventPageMoreActions();
    expect(screen.getByRole('menuitem', { name: 'Save draft' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Duplicate page' })).toHaveAttribute(
      'data-disabled',
    );
    expect(screen.getByRole('menuitem', { name: 'Archive page' })).toHaveAttribute('data-disabled');
  });

  it('does not create missing content for users without events.write', async () => {
    permissionCanMock.mockReturnValue(false);
    adminApiMock.listContentDocuments.mockResolvedValue(ok({ items: [] }));

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    expect(await screen.findByText('Unable to load editor')).toBeInTheDocument();
    expect(
      screen.getByText('No event page exists yet, and you do not have permission to create one.'),
    ).toBeInTheDocument();
    expect(adminApiMock.createContentDocument).not.toHaveBeenCalled();
    expect(adminApiMock.saveContentVersion).not.toHaveBeenCalled();
  });

  it('does not offer retry for terminal API authorization failures', async () => {
    adminApiMock.getEvent.mockResolvedValue({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Access denied', status: 403 },
    });

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to event' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('does not present missing supporting event data as a valid empty preview', async () => {
    adminApiMock.listTicketTypes.mockResolvedValue({
      ok: false,
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Ticket catalog unavailable',
        status: 503,
      },
    });

    render(React.createElement(EventPagePersistedEditorView, { eventId: 'evt_1' }));

    expect(await screen.findByText('Ticket catalog unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('puck-editor')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
