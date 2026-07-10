import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { generateJSON } from '@tiptap/core';
import { StarterKit } from '@react-email/editor/extensions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REACT_EMAIL_EDITOR_PACKAGE, createDefaultEmailTemplate } from '@tixkit/content-email';
import { EmailPersistedEditorView } from './email-persisted-editor-view';
import {
  TixkitMergeTag,
  applyMergeTagPreviewsToEditorContent,
  createEmailSlashCommands,
  emailEditorStarterKitOptions,
  mergeTagCanvasAttributeValue,
  tixkitInlineStyleMarkName,
  tixkitMergeTagMarkName,
  variablePresentation,
} from './email-editor-extensions';

const adminApiMock = vi.hoisted(() => ({
  getEvent: vi.fn(),
  listContentDocuments: vi.fn(),
  createContentDocument: vi.fn(),
  listContentVersions: vi.fn(),
  saveContentVersion: vi.fn(),
  previewContent: vi.fn(),
  publishContentVersion: vi.fn(),
  sendMessage: vi.fn(),
  duplicateContentDocument: vi.fn(),
  archiveContentDocument: vi.fn(),
  testSendContent: vi.fn(),
  uploadArtifact: vi.fn(),
  listBrandEmailSenderIdentities: vi.fn(),
  listBrands: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
}));

const editorMockHelpers = vi.hoisted(() => ({
  textFromHtml(value: string): string {
    return value
      .replace(
        /<span\b[^>]*\bdata-tixkit-merge-tag=["']([^"']+)["'][^>]*>[\s\S]*?<\/span>/gi,
        (_match, key: string) => ` {{${key.trim()}}} `,
      )
      .replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/gi, ' $1 ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  },
  textFromContent(content: unknown): string {
    if (typeof content === 'string') return editorMockHelpers.textFromHtml(content);
    if (!content || typeof content !== 'object') return '';
    return editorMockHelpers.textFromJsonNode(content);
  },
  textFromJsonNode(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const node = value as {
      content?: unknown;
      marks?: unknown;
      text?: unknown;
      type?: unknown;
    };
    if (typeof node.text === 'string') {
      const mergeTagMark = Array.isArray(node.marks)
        ? node.marks.find(
            (mark) =>
              mark &&
              typeof mark === 'object' &&
              (mark as { type?: unknown }).type === 'tixkitMergeTag',
          )
        : undefined;
      const mergeTagKey =
        mergeTagMark && typeof mergeTagMark === 'object'
          ? (mergeTagMark as { attrs?: { key?: unknown } }).attrs?.key
          : undefined;
      return typeof mergeTagKey === 'string' && mergeTagKey.trim()
        ? `{{${mergeTagKey.trim()}}}`
        : node.text;
    }
    if (node.type === 'hardBreak') return '\n';
    if (!Array.isArray(node.content)) return '';
    return node.content
      .map((child) => editorMockHelpers.textFromJsonNode(child))
      .filter(Boolean)
      .join(node.type === 'doc' ? '\n' : '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  },
  escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  },
}));

const editorMockState = vi.hoisted(() => ({
  shellOnlyExport: false,
  exportedHtml: undefined as string | undefined,
  exportedText: undefined as string | undefined,
  exportedJson: undefined as Record<string, unknown> | undefined,
  alignmentCalls: [] as string[],
  slashCommandItems: [] as Array<{ title?: string; description?: string; category?: string }>,
  lastBubbleMenu: undefined as { showDefaultImageMenu?: boolean } | undefined,
  lastTheme: undefined as unknown,
  lastInitialText: '',
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

vi.mock('./email/style-inspector', async () => {
  const ReactModule = await import('react');
  return {
    StyleInspector: () =>
      ReactModule.createElement(
        'aside',
        {
          'aria-label': 'Email style inspector',
          'data-testid': 'native-email-inspector-host',
        },
        ReactModule.createElement('p', null, 'Page style'),
      ),
  };
});

vi.mock('@react-email/editor', async () => {
  const ReactModule = await import('react');

  const EmailEditor = ReactModule.forwardRef(
    (
      {
        bubbleMenu,
        children,
        content,
        editable = true,
        onUploadImage,
        onReady,
        onUpdate,
        slashCommand,
        theme,
      }: {
        bubbleMenu?: { showDefaultImageMenu?: boolean };
        children?: React.ReactNode;
        content?: unknown;
        editable?: boolean;
        onUploadImage?: (file: File) => Promise<{ url: string }>;
        onReady?: (ref: unknown) => void;
        onUpdate?: (ref: unknown) => void;
        slashCommand?: {
          items?: Array<{ title?: string; description?: string; category?: string }>;
        };
        theme?: unknown;
      },
      ref,
    ) => {
      const [value, setValue] = ReactModule.useState(() =>
        editorMockHelpers.textFromContent(content),
      );
      editorMockState.lastInitialText = editorMockHelpers.textFromContent(content);
      const valueRef = ReactModule.useRef(value);
      const onReadyRef = ReactModule.useRef(onReady);
      const onUpdateRef = ReactModule.useRef(onUpdate);
      const didMountRef = ReactModule.useRef(false);
      const editor = ReactModule.useMemo(() => {
        const tr = {
          docChanged: false,
          setNodeMarkup: (
            _position: number,
            _type: unknown,
            attrs: { align?: string; alignment?: string },
          ) => {
            tr.docChanged = true;
            editorMockState.alignmentCalls.push(attrs.align ?? attrs.alignment ?? '');
            return tr;
          },
        };
        return {
          chain() {
            const chainApi = {
              focus: () => chainApi,
              insertContent: (next: unknown) => {
                setValue((current) =>
                  `${current} ${
                    typeof next === 'string'
                      ? editorMockHelpers.textFromHtml(next)
                      : editorMockHelpers.textFromContent(next)
                  }`.trim(),
                );
                return chainApi;
              },
              setImage: (attrs: { src: string; alt?: string }) => {
                setValue((current) => `${current} ${attrs.src} ${attrs.alt ?? ''}`.trim());
                return chainApi;
              },
              setAlignment: (alignment: string) => {
                editorMockState.alignmentCalls.push(alignment);
                return chainApi;
              },
              run: () => true,
            };
            return chainApi;
          },
          commands: {
            setAlignment: (alignment: string) => {
              editorMockState.alignmentCalls.push(alignment);
              return true;
            },
          },
          state: {
            doc: {
              nodesBetween: (
                _from: number,
                _to: number,
                callback: (
                  node: { attrs: Record<string, unknown>; isTextblock: boolean },
                  position: number,
                ) => void,
              ) => callback({ attrs: { alignment: 'left' }, isTextblock: true }, 0),
            },
            selection: {
              $from: {
                before: () => 0,
                depth: 1,
                node: () => ({ attrs: { alignment: 'left' }, isTextblock: true }),
              },
              empty: true,
              from: 0,
              to: 0,
            },
            tr,
          },
          view: {
            dispatch: () => undefined,
            focus: () => undefined,
          },
        };
      }, []);
      const editorRef = ReactModule.useMemo(
        () => ({
          getEmail: async () => ({
            html:
              editorMockState.exportedHtml ??
              (editorMockState.shellOnlyExport
                ? '<!DOCTYPE html><html><body><p><br /></p></body></html>'
                : `<p>${editorMockHelpers.escapeHtml(valueRef.current)}</p>`),
            text:
              editorMockState.exportedText ??
              (editorMockState.shellOnlyExport ? '' : valueRef.current),
          }),
          getEmailHTML: async () => `<p>${editorMockHelpers.escapeHtml(valueRef.current)}</p>`,
          getEmailText: async () => valueRef.current,
          getJSON: () =>
            editorMockState.exportedJson ?? {
              type: 'doc',
              content: valueRef.current
                ? [{ type: 'paragraph', content: [{ type: 'text', text: valueRef.current }] }]
                : [],
            },
          editor,
        }),
        [editor],
      );

      ReactModule.useImperativeHandle(ref, () => editorRef, [editorRef]);
      ReactModule.useEffect(() => {
        valueRef.current = value;
      }, [value]);
      ReactModule.useEffect(() => {
        onReadyRef.current = onReady;
      }, [onReady]);
      ReactModule.useEffect(() => {
        onUpdateRef.current = onUpdate;
      }, [onUpdate]);
      ReactModule.useEffect(() => {
        editorMockState.slashCommandItems = slashCommand?.items ?? [];
      }, [slashCommand]);
      ReactModule.useEffect(() => {
        editorMockState.lastBubbleMenu = bubbleMenu;
      }, [bubbleMenu]);
      ReactModule.useEffect(() => {
        editorMockState.lastTheme = theme;
      }, [theme]);
      ReactModule.useEffect(() => {
        onReadyRef.current?.(editorRef);
      }, [editorRef]);
      ReactModule.useEffect(() => {
        if (!didMountRef.current) {
          didMountRef.current = true;
          return;
        }
        onUpdateRef.current?.(editorRef);
      }, [editorRef, value]);

      return ReactModule.createElement(
        ReactModule.Fragment,
        null,
        ReactModule.createElement(
          'button',
          {
            type: 'button',
            onClick: async () => {
              const upload = await onUploadImage?.(
                new File(['image-bytes'], 'inline-email-image.png', { type: 'image/png' }),
              );
              if (upload?.url) setValue((current) => `${current} ${upload.url}`.trim());
            },
          },
          'Mock image upload',
        ),
        ReactModule.createElement(
          'div',
          {
            'aria-label': 'Email body',
            contentEditable: editable,
            role: 'textbox',
            suppressContentEditableWarning: true,
            onInput: (event: React.FormEvent<HTMLDivElement>) => {
              const nextValue = event.currentTarget.textContent ?? '';
              valueRef.current = nextValue;
              setValue(nextValue);
            },
          },
          value,
        ),
        children,
      );
    },
  );
  EmailEditor.displayName = 'MockEmailEditor';

  return { EmailEditor };
});

const emailDocument = createDefaultEmailTemplate({
  editor: {
    provider: REACT_EMAIL_EDITOR_PACKAGE,
    contentHtml:
      '<h1>{{event.title}}</h1><p>Hi {{recipient.name}}, your tickets are ready.</p><p>Order {{order.id}} - {{order.total}}</p>',
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
      body: 'Order {{order.id}} - {{order.total}} - {{ticket.type}}',
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

const senderIdentity = {
  id: 'bsi_1',
  tenantId: 'tnt_1',
  brandId: 'brd_1',
  email: 'tickets@example.test',
  name: 'Tixkit',
  replyToEmail: 'support@example.test',
  verified: true,
  verifiedAt: '2026-06-29T00:00:00.000Z',
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
};

const brand = {
  id: 'brd_1',
  tenantId: 'tnt_1',
  organizationId: 'org_1',
  name: 'All Access Chicago',
  slug: 'all-access-chicago',
  status: 'active',
  theme: {
    primaryColor: '#111827',
    logoUrl: 'https://assets.example.test/brand/logo.png',
  },
  domains: [],
  whiteLabel: true,
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
};

const secondBrand = {
  ...brand,
  id: 'brd_2',
  name: 'Riverside Presents',
  slug: 'riverside-presents',
  theme: {
    primaryColor: '#0f766e',
    logoUrl: 'https://assets.example.test/riverside/logo.png',
  },
};

const secondBrandSenderIdentity = {
  ...senderIdentity,
  id: 'bsi_2',
  brandId: 'brd_2',
  email: 'riverside@example.test',
  name: 'Riverside Presents',
  replyToEmail: 'hello@riverside.example.test',
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

const brandTemplateDocument = {
  ...document,
  id: 'cdoc_brand_template',
  eventId: undefined,
  key: 'brand-announcement',
  name: 'Brand announcement',
  currentDraftVersionId: 'cver_brand_template',
};

const secondBrandTemplateDocument = {
  ...brandTemplateDocument,
  id: 'cdoc_second_brand_template',
  brandId: 'brd_2',
  key: 'riverside-announcement',
  name: 'Riverside announcement',
  currentDraftVersionId: 'cver_second_brand_template',
};

const brandTemplateEmailDocument = createDefaultEmailTemplate({
  editor: {
    provider: REACT_EMAIL_EDITOR_PACKAGE,
    contentHtml: '<h1>Brand update</h1><p>News for {{recipient.name}}.</p>',
    contentText: 'Brand update\nNews for {{recipient.name}}.',
    contentJson: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Brand update' }] }],
    },
  },
  settings: {
    templateKey: 'brand-announcement',
    subject: 'Brand update for {{recipient.name}}',
    previewText: 'A quick update from {{brand.name}}.',
    locale: 'en',
    category: 'bulk',
    sender: {
      fromEmail: 'other@example.test',
      fromName: 'Other sender',
      replyToEmail: 'other-reply@example.test',
    },
  },
});

const brandTemplateVersion = {
  ...version,
  id: 'cver_brand_template',
  documentId: 'cdoc_brand_template',
  contentJson: brandTemplateEmailDocument,
  subject: brandTemplateEmailDocument.settings.subject,
  previewText: brandTemplateEmailDocument.settings.previewText,
};

function ok<T>(data: T) {
  return { ok: true as const, data };
}

function openEmailMoreActions() {
  const trigger = screen.getByRole('button', { name: 'More actions' });
  fireEvent.pointerDown(trigger);
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown', code: 'ArrowDown' });
}

function clickEmailSaveDraft() {
  openEmailMoreActions();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Save draft' }));
}

function clickMoreAction(name: string) {
  openEmailMoreActions();
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

function closeActiveDialog() {
  const closeButtons = screen.getAllByRole('button', { name: 'Close' });
  fireEvent.click(closeButtons[closeButtons.length - 1]!);
}

async function confirmPublishVersion(buttonName = 'Publish version') {
  fireEvent.click(screen.getByRole('button', { name: 'Publish version' }));
  const dialog = await screen.findByRole('dialog', { name: 'Publish version?' });
  expect(dialog).toBeInTheDocument();
  expect(screen.queryByText('Campaign settings')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Audience')).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'Specific attendees' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Send timing')).not.toBeInTheDocument();
  expect(screen.getByText('Preflight checks')).toBeInTheDocument();
  expect(await screen.findByText('Content analysis complete')).toBeInTheDocument();
  expect(await screen.findByText('No blocking issues found.')).toBeInTheDocument();
  expect(adminApiMock.sendMessage).not.toHaveBeenCalled();
  expect(within(dialog).getByRole('button', { name: buttonName })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Slide to confirm email version publish'), {
    target: { value: '100' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: buttonName }));
}

describe('EmailPersistedEditorView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorMockState.shellOnlyExport = false;
    editorMockState.exportedHtml = undefined;
    editorMockState.exportedText = undefined;
    editorMockState.exportedJson = undefined;
    editorMockState.alignmentCalls = [];
    editorMockState.slashCommandItems = [];
    editorMockState.lastBubbleMenu = undefined;
    editorMockState.lastTheme = undefined;
    editorMockState.lastInitialText = '';
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
    adminApiMock.sendMessage.mockResolvedValue(
      ok({
        id: 'msg_1',
        eventId: 'evt_1',
        name: 'order-confirmed',
        emailTemplateKey: 'order-confirmed',
        channel: 'email',
        status: 'queued',
        audience: 'all_attendees',
        audienceKey: 'all',
        audienceAttendeeIds: [],
        audienceLabel: 'All attendees',
        queuedCount: 1,
        sentCount: 0,
        deliveredCount: 0,
        failedCount: 0,
        suppressedCount: 0,
        createdAt: '2026-06-29T00:00:00.000Z',
      }),
    );
    adminApiMock.duplicateContentDocument.mockResolvedValue(
      ok({ ...document, id: 'cdoc_email_copy', name: 'All Access Chicago email template Copy' }),
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
    adminApiMock.listBrandEmailSenderIdentities.mockResolvedValue(ok([senderIdentity]));
    adminApiMock.listBrands.mockResolvedValue(ok([brand]));
    adminApiMock.uploadArtifact.mockResolvedValue(
      ok({
        artifactId: 'upl_email_image',
        status: 'uploaded',
        scanStatus: 'clean',
        downloadUrl: 'https://api.example.test/v1/public/content-email-images/upl_email_image',
      }),
    );
  });

  it('maps merge tags to friendly preview presentations for canvas chips', () => {
    expect(variablePresentation('event.title')).toEqual({
      label: 'Event name',
      preview: 'Sample Summer Showcase',
      kind: 'event',
    });
    expect(variablePresentation('recipient.name')).toEqual({
      label: 'Attendee name',
      preview: 'Ada Lovelace',
      kind: 'recipient',
    });
    expect(variablePresentation('ticket.type')).toEqual({
      label: 'Ticket type',
      preview: 'General Admission',
      kind: 'ticket',
    });
    expect(variablePresentation('order.total')).toEqual({
      label: 'Order total',
      preview: '$84.00',
      kind: 'order',
    });
    expect(variablePresentation('brand.name')).toEqual({
      label: 'Brand name',
      preview: 'All Access Chicago',
      kind: 'brand',
    });
    expect(variablePresentation('event.publicUrl')).toEqual({
      label: 'Event page',
      preview: 'public event page',
      kind: 'link',
    });
    expect(variablePresentation('review.platform')).toEqual({
      label: 'Review platform',
      preview: 'Google',
      kind: 'system',
    });
    expect(mergeTagCanvasAttributeValue('ticket.qrCodeUrl')).toMatch(/^data:image\/svg\+xml,/);
    expect(
      applyMergeTagPreviewsToEditorContent(
        '<p><img src="{{ticket.qrCodeUrl}}" alt="Ticket QR code"></p>',
      ),
    ).toContain('data-tixkit-merge-attr-src="ticket.qrCodeUrl"');
    const jsonPreview = applyMergeTagPreviewsToEditorContent({
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: {
            src: '{{ticket.qrCodeUrl}}',
            alt: 'Ticket QR code',
          },
        },
      ],
    }) as {
      content: Array<{ attrs: Record<string, unknown> }>;
    };
    expect(jsonPreview.content[0]?.attrs.src).toBe(
      mergeTagCanvasAttributeValue('ticket.qrCodeUrl'),
    );
    expect(jsonPreview.content[0]?.attrs['data-tixkit-merge-attr-src']).toBe('ticket.qrCodeUrl');
  });

  it('configures native email alignment for text, media, body, and layout nodes', () => {
    expect(emailEditorStarterKitOptions.AlignmentAttribute.types).toEqual(
      expect.arrayContaining([
        'body',
        'container',
        'heading',
        'paragraph',
        'button',
        'image',
        'section',
        'columnsColumn',
        'table',
      ]),
    );
  });

  it('parses persisted variable preview chips with their canonical merge tag attrs', () => {
    const json = generateJSON(
      [
        '<p>',
        '<span class="tixkit-email-variable-chip" data-tixkit-merge-tag="event.title" data-variable-key="event.title" data-variable-kind="event" data-variable-label="Event name" data-variable-preview="Sample Summer Showcase">Sample Summer Showcase</span>',
        ' welcomes ',
        '<span class="tixkit-email-variable-chip" data-tixkit-merge-tag="recipient.name" data-variable-key="recipient.name" data-variable-kind="recipient" data-variable-label="Attendee name" data-variable-preview="Ada Lovelace">Ada Lovelace</span>',
        ' with ',
        '<span class="tixkit-email-variable-chip" data-tixkit-merge-tag="ticket.type" data-variable-key="ticket.type" data-variable-kind="ticket" data-variable-label="Ticket type" data-variable-preview="General Admission">General Admission</span>',
        '.</p>',
      ].join(''),
      [StarterKit.configure(emailEditorStarterKitOptions), TixkitMergeTag],
    );
    const markedText: Array<Record<string, unknown>> = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const node = value as {
        content?: unknown;
        marks?: unknown;
        text?: unknown;
      };
      if (typeof node.text === 'string' && Array.isArray(node.marks)) {
        const mark = node.marks.find(
          (candidate) =>
            candidate &&
            typeof candidate === 'object' &&
            (candidate as { type?: unknown }).type === tixkitMergeTagMarkName,
        );
        if (mark && typeof mark === 'object') {
          markedText.push({
            ...(mark as { attrs?: Record<string, unknown> }).attrs,
            text: node.text,
          });
        }
      }
      if (Array.isArray(node.content)) node.content.forEach(visit);
    };
    visit(json);

    expect(markedText).toEqual([
      {
        key: 'event.title',
        kind: 'event',
        label: 'Event name',
        preview: 'Sample Summer Showcase',
        text: 'Sample Summer Showcase',
      },
      {
        key: 'recipient.name',
        kind: 'recipient',
        label: 'Attendee name',
        preview: 'Ada Lovelace',
        text: 'Ada Lovelace',
      },
      {
        key: 'ticket.type',
        kind: 'ticket',
        label: 'Ticket type',
        preview: 'General Admission',
        text: 'General Admission',
      },
    ]);
  });

  it('keeps selection alignment out of the inspector controls', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByTestId('native-email-inspector-host');

    expect(screen.queryByRole('button', { name: 'Align left' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Align center' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Align right' })).not.toBeInTheDocument();
    expect(screen.queryByText('Typography')).not.toBeInTheDocument();
    expect(screen.queryByText('Align')).not.toBeInTheDocument();
  });

  it('builds slash variable commands with friendly labels and canonical inserts', () => {
    const commands = createEmailSlashCommands({
      mergeTags: ['event.title'],
      brandName: 'All Access Chicago',
    });
    const eventName = commands.find(
      (command) => command.category === 'Variables' && command.title === 'Event name',
    );
    const insertContent = vi.fn(() => ({ run: vi.fn(() => true) }));
    const deleteRange = vi.fn(() => ({ insertContent }));
    const focus = vi.fn(() => ({ deleteRange }));
    const editor = { chain: () => ({ focus }) };

    expect(eventName).toMatchObject({
      title: 'Event name',
      description: 'Sample Summer Showcase',
      searchTerms: expect.arrayContaining(['event.title', 'event', 'Event name']),
    });

    eventName?.command({
      editor: editor as unknown as Parameters<
        NonNullable<typeof eventName>['command']
      >[0]['editor'],
      range: { from: 1, to: 14 },
    });

    expect(deleteRange).toHaveBeenCalledWith({ from: 1, to: 14 });
    expect(insertContent).toHaveBeenCalledWith('{{event.title}}');
  });

  it('keeps slash variable command titles unique when labels repeat', () => {
    const commands = createEmailSlashCommands({
      mergeTags: ['recipient.name', 'attendee.name', 'event.title'],
      brandName: 'All Access Chicago',
    }).filter((command) => command.category === 'Variables');

    expect(commands.map((command) => command.title)).toEqual([
      'Attendee name (recipient.name)',
      'Attendee name (attendee.name)',
      'Event name',
    ]);
  });

  it('builds the Ticket QR slash command with a canvas-safe preview image source', () => {
    const commands = createEmailSlashCommands({
      mergeTags: ['ticket.qrCodeUrl'],
      brandName: 'All Access Chicago',
    });
    const ticketQr = commands.find(
      (command) => command.category === 'Tixkit' && command.title === 'Ticket QR',
    );
    const run = vi.fn(() => true);
    const setImage = vi.fn(() => ({ run }));
    const deleteRange = vi.fn(() => ({ setImage }));
    const focus = vi.fn(() => ({ deleteRange }));
    const editor = { chain: () => ({ focus }) };

    ticketQr?.command({
      editor: editor as unknown as Parameters<NonNullable<typeof ticketQr>['command']>[0]['editor'],
      range: { from: 1, to: 14 },
    });

    expect(setImage).toHaveBeenCalledWith({
      src: mergeTagCanvasAttributeValue('ticket.qrCodeUrl'),
      alt: 'Ticket QR code',
      alignment: 'center',
    });
    expect(run).toHaveBeenCalled();
  });

  it('includes Resend-parity slash commands for social links, unsubscribe, HTML, and variables', () => {
    const commands = createEmailSlashCommands({
      mergeTags: ['event.title'],
      brandName: 'All Access Chicago',
    });

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Social Links', category: 'Tixkit' }),
        expect.objectContaining({ title: 'Unsubscribe Footer', category: 'Tixkit' }),
        expect.objectContaining({ title: 'HTML', category: 'Advanced' }),
        expect.objectContaining({ title: 'Variable', category: 'Tixkit' }),
        expect.objectContaining({ title: 'Background hero', category: 'Tixkit' }),
      ]),
    );
  });

  it('builds a background hero with the inherited brand logo and editable section styles', () => {
    const commands = createEmailSlashCommands({
      mergeTags: ['brand.logoUrl', 'event.title'],
      brandName: 'All Access Chicago',
    });
    const hero = commands.find((command) => command.title === 'Background hero');
    const run = vi.fn(() => true);
    const insertContent = vi.fn(() => ({ run }));
    const deleteRange = vi.fn(() => ({ insertContent }));
    const focus = vi.fn(() => ({ deleteRange }));
    const editor = { chain: () => ({ focus }) };

    hero?.command({
      editor: editor as unknown as Parameters<NonNullable<typeof hero>['command']>[0]['editor'],
      range: { from: 1, to: 8 },
    });

    expect(insertContent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'section',
        attrs: expect.objectContaining({ style: expect.stringContaining('min-height: 320px') }),
        content: expect.arrayContaining([
          expect.objectContaining({
            type: 'image',
            attrs: expect.objectContaining({
              src: mergeTagCanvasAttributeValue('brand.logoUrl'),
              alt: 'Brand logo',
            }),
          }),
          expect.objectContaining({
            type: 'paragraph',
            attrs: expect.objectContaining({ style: expect.stringContaining('font-size: 40px') }),
          }),
        ]),
      }),
    );
    expect(run).toHaveBeenCalled();
  });

  it('builds the Social Links slash command with canonical event and brand URLs', () => {
    const commands = createEmailSlashCommands({
      mergeTags: ['event.publicUrl', 'brand.supportUrl'],
      brandName: 'All Access Chicago',
    });
    const socialLinks = commands.find(
      (command) => command.category === 'Tixkit' && command.title === 'Social Links',
    );
    const run = vi.fn(() => true);
    const insertContent = vi.fn(() => ({ run }));
    const deleteRange = vi.fn(() => ({ insertContent }));
    const focus = vi.fn(() => ({ deleteRange }));
    const editor = { chain: () => ({ focus }) };

    socialLinks?.command({
      editor: editor as unknown as Parameters<
        NonNullable<typeof socialLinks>['command']
      >[0]['editor'],
      range: { from: 1, to: 14 },
    });

    expect(insertContent).toHaveBeenCalledWith({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Follow us: ' },
        {
          type: 'text',
          text: 'Event page',
          marks: [{ type: 'link', attrs: { href: '{{event.publicUrl}}' } }],
        },
        { type: 'text', text: ' | ' },
        {
          type: 'text',
          text: 'Support',
          marks: [{ type: 'link', attrs: { href: '{{brand.supportUrl}}' } }],
        },
      ],
    });
    expect(run).toHaveBeenCalled();
  });

  it('passes Tixkit slash commands into the native editor', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByTestId('native-email-inspector-host');

    expect(editorMockState.slashCommandItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'Variables',
          title: 'Event name',
          description: 'Sample Summer Showcase',
        }),
        expect.objectContaining({
          category: 'Tixkit',
          title: 'Ticket QR',
        }),
        expect.objectContaining({
          category: 'Tixkit',
          title: 'Social Links',
        }),
        expect.objectContaining({
          category: 'Tixkit',
          title: 'Unsubscribe Footer',
        }),
      ]),
    );
    expect(editorMockState.slashCommandItems).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ title: '{{event.title}}' })]),
    );
  });

  it('loads an existing email document and persists save, publish, and test-send actions', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    expect(await screen.findByTestId('email-metadata-bar')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Editor tools' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Code' })).toBeInTheDocument();
    expect(screen.getByLabelText('Verified sender')).toHaveValue('bsi_1');
    expect(screen.getByLabelText('Reply-To')).toHaveValue('support@example.test');
    expect(screen.queryByLabelText('Audience')).not.toBeInTheDocument();
    expect(screen.queryByText('Transactional ticket messages')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Send timing')).not.toBeInTheDocument();
    expect(screen.getByTestId('native-email-inspector-host')).toBeInTheDocument();
    expect(editorMockState.lastBubbleMenu).toMatchObject({ showDefaultImageMenu: false });
    expect(screen.getByLabelText('Insert Theme')).toBeInTheDocument();
    expect(screen.getByLabelText('Insert Global CSS')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Insert Theme'));
    expect(screen.getByText('Email theme')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'minimal' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Align left' })).not.toBeInTheDocument();
    expect(screen.queryByText('Typography')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Template key')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Locale')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();
    expect(screen.queryByText('Brand scope')).not.toBeInTheDocument();
    expect(screen.queryByText('Event scope')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Test recipients')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Insert variable'));
    expect(screen.getByRole('button', { name: /Brand name/ })).toHaveTextContent(
      'All Access Chicago',
    );
    clickMoreAction('Version history');
    expect(screen.getByRole('dialog', { name: 'Version history' })).toBeInTheDocument();
    closeActiveDialog();
    clickMoreAction('Details');
    expect(screen.getByRole('dialog', { name: 'Template details' })).toBeInTheDocument();
    expect(screen.getByText('Message purpose')).toBeInTheDocument();
    expect(screen.getByText('Ticket transaction')).toBeInTheDocument();
    expect(screen.getAllByText('All Access Chicago').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Test recipients')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Template key')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Locale')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();
    expect(screen.queryByText('Brand scope')).not.toBeInTheDocument();
    expect(screen.queryByText('Event scope')).not.toBeInTheDocument();
    closeActiveDialog();
    clickMoreAction('View JSON');
    expect(screen.getByRole('dialog', { name: 'Editor JSON' })).toBeInTheDocument();
    closeActiveDialog();
    clickMoreAction('Review blockers');
    expect(await screen.findByRole('dialog', { name: 'Publish version?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    clickMoreAction('Details');
    expect(screen.getByRole('dialog', { name: 'Template details' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Template key')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Locale')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();

    const subject = await screen.findByLabelText('Subject');
    fireEvent.change(subject, {
      target: { value: 'Updated tickets for {{event.title}}' },
    });
    closeActiveDialog();
    const canvas = screen.getByRole('textbox', { name: 'Email body' });
    canvas.textContent =
      'Updated saved email for {{recipient.name}} about {{event.title}} order {{order.id}} {{order.total}} {{ticket.type}}. Manage preferences: {{brand.supportUrl}}. Checkout: {{event.checkoutUrl}}.';
    fireEvent.input(canvas);
    clickEmailSaveDraft();

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({
          subject: 'Updated tickets for {{event.title}}',
          contentJson: expect.objectContaining({
            schemaVersion: 1,
            settings: expect.objectContaining({
              subject: 'Updated tickets for {{event.title}}',
              templateKey: 'order-confirmed',
              locale: 'en',
              category: 'transactional',
            }),
            editor: expect.objectContaining({
              contentJson: expect.objectContaining({ type: 'doc' }),
              contentText:
                'Updated saved email for {{recipient.name}} about {{event.title}} order {{order.id}} {{order.total}} {{ticket.type}}. Manage preferences: {{brand.supportUrl}}. Checkout: {{event.checkoutUrl}}.',
            }),
          }),
          renderedHtml:
            '<p>Updated saved email for {{recipient.name}} about {{event.title}} order {{order.id}} {{order.total}} {{ticket.type}}. Manage preferences: {{brand.supportUrl}}. Checkout: {{event.checkoutUrl}}.</p>',
          renderedText:
            'Updated saved email for {{recipient.name}} about {{event.title}} order {{order.id}} {{order.total}} {{ticket.type}}. Manage preferences: {{brand.supportUrl}}. Checkout: {{event.checkoutUrl}}.',
        }),
      );
    });
    expect(adminApiMock.previewContent).not.toHaveBeenCalled();
    expect(screen.queryByTestId('preview-drawer')).not.toBeInTheDocument();

    await confirmPublishVersion();
    await waitFor(() => {
      expect(adminApiMock.publishContentVersion).toHaveBeenCalledWith('cdoc_email', 'cver_2');
    });
    expect(adminApiMock.sendMessage).not.toHaveBeenCalled();

    clickMoreAction('Send test email');
    expect(screen.getByRole('dialog', { name: 'Send test email' })).toBeInTheDocument();
    expect(screen.getByLabelText('Test recipients')).toHaveValue('ada@example.test');
    fireEvent.change(screen.getByLabelText('Test recipients'), {
      target: { value: 'ada@example.test\ngrace@example.test' },
    });
    fireEvent.keyDown(screen.getByLabelText('Test recipients'), {
      code: 'Enter',
      ctrlKey: true,
      key: 'Enter',
    });
    await waitFor(() => {
      expect(adminApiMock.testSendContent).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({
          versionId: 'cver_2',
          recipient: 'ada@example.test',
        }),
      );
      expect(adminApiMock.testSendContent).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({
          versionId: 'cver_2',
          recipient: 'grace@example.test',
        }),
      );
    });

    clickMoreAction('Archive');
    await waitFor(() => {
      expect(adminApiMock.archiveContentDocument).toHaveBeenCalledWith('cdoc_email');
    });
    expect(screen.getByText('Archived email template')).toBeInTheDocument();
  }, 10000);

  it('falls back to editor JSON when React Email returns shell-only HTML', async () => {
    editorMockState.shellOnlyExport = true;
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    const canvas = await screen.findByRole('textbox', { name: 'Email body' });
    canvas.textContent =
      'Hi {{recipient.name}}, your {{event.title}} tickets are ready. Manage preferences: {{brand.supportUrl}}.';
    fireEvent.input(canvas);
    clickEmailSaveDraft();

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({
          contentJson: expect.objectContaining({
            editor: expect.objectContaining({
              contentHtml:
                '<p>Hi {{recipient.name}}, your {{event.title}} tickets are ready. Manage preferences: {{brand.supportUrl}}.</p>',
              contentText:
                'Hi {{recipient.name}}, your {{event.title}} tickets are ready. Manage preferences: {{brand.supportUrl}}.',
              contentJson: expect.objectContaining({ type: 'doc' }),
            }),
          }),
          renderedHtml:
            '<p>Hi {{recipient.name}}, your {{event.title}} tickets are ready. Manage preferences: {{brand.supportUrl}}.</p>',
          renderedText:
            'Hi {{recipient.name}}, your {{event.title}} tickets are ready. Manage preferences: {{brand.supportUrl}}.',
        }),
      );
    });
  });

  it('does not let a blank editor export overwrite the starter draft', async () => {
    editorMockState.exportedHtml = '<!DOCTYPE html><html><body><p><br /></p></body></html>';
    editorMockState.exportedText = '';
    editorMockState.exportedJson = { type: 'doc', content: [] };
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByRole('textbox', { name: 'Email body' });
    clickEmailSaveDraft();

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({
          contentJson: expect.objectContaining({
            editor: expect.objectContaining({
              contentHtml: emailDocument.editor.contentHtml,
            }),
          }),
          renderedHtml: emailDocument.editor.contentHtml,
        }),
      );
    });
  });

  it('restores seeded lifecycle canvas content when a saved draft body is empty', async () => {
    const emptyEmailDocument = {
      ...emailDocument,
      editor: {
        provider: REACT_EMAIL_EDITOR_PACKAGE,
        contentHtml: '',
        contentText: '',
        contentJson: {
          type: 'doc',
          content: [{ type: 'paragraph' }],
        },
      },
      blocks: [],
    };
    adminApiMock.listContentVersions.mockResolvedValue(
      ok({
        items: [
          {
            ...version,
            contentJson: emptyEmailDocument,
            renderedHtml: '',
            renderedText: '',
          },
        ],
      }),
    );

    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByTestId('native-email-inspector-host');

    expect(editorMockState.lastInitialText).toContain('{{recipient.name}}');
    expect(editorMockState.lastInitialText).toContain('{{event.title}}');
    expect(editorMockState.lastInitialText).toContain('{{order.id}}');
    expect(screen.queryByText(/required fields before publishing/i)).not.toBeInTheDocument();
  });

  it('resets a lifecycle draft back to the Studio default starter content', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    const canvas = await screen.findByRole('textbox', { name: 'Email body' });
    canvas.textContent = 'Bare custom body';
    fireEvent.input(canvas);
    expect(canvas).toHaveTextContent('Bare custom body');

    clickMoreAction('Reset to Studio default');

    let resetCanvas: HTMLElement | undefined;
    await waitFor(() => {
      resetCanvas = screen.getByRole('textbox', { name: 'Email body' });
      expect(resetCanvas).toHaveTextContent('Your tickets are being prepared');
    });
    expect(resetCanvas).toHaveTextContent('Summary');
    expect(resetCanvas).toHaveTextContent('{{order.id}}');
    expect(resetCanvas).not.toHaveTextContent('Bare custom body');
    expect(screen.getByText('Reset to the Studio default for Order confirmed')).toBeInTheDocument();

    clickEmailSaveDraft();

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({
          contentJson: expect.objectContaining({
            editor: expect.objectContaining({
              contentText: expect.stringContaining('Your tickets are being prepared'),
            }),
          }),
          renderedText: expect.stringContaining('Your tickets are being prepared'),
        }),
      );
    });
  }, 10_000);

  it('canonicalizes preview variable and inline style markup before saving', async () => {
    editorMockState.exportedHtml = `<p>Hi <span data-tixkit-inline-style="true" style="color: #0f766e"><span key="recipient.name" kind="recipient" label="Attendee name" preview="Ada Lovelace" class="tixkit-email-variable-chip" data-tixkit-merge-tag="recipient.name" data-variable-key="recipient.name" data-variable-kind="recipient" data-variable-label="Attendee name" data-variable-preview="Ada Lovelace" data-variable-detail="Attendee name - {{recipient.name}}" title="Attendee name: {{recipient.name}}">Ada Lovelace</span></span>.</p><p><img src="${mergeTagCanvasAttributeValue('ticket.qrCodeUrl')}" data-tixkit-merge-attr-src="ticket.qrCodeUrl" alt="Ticket QR code"></p>`;
    editorMockState.exportedText = 'Hi {{recipient.name}}.';
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByRole('textbox', { name: 'Email body' });
    clickEmailSaveDraft();

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({
          renderedHtml:
            '<p>Hi <span style="color: #0f766e"><span>{{recipient.name}}</span></span>.</p><p><img src="{{ticket.qrCodeUrl}}" alt="Ticket QR code"></p>',
          contentJson: expect.objectContaining({
            editor: expect.objectContaining({
              contentHtml:
                '<p>Hi <span style="color: #0f766e"><span>{{recipient.name}}</span></span>.</p><p><img src="{{ticket.qrCodeUrl}}" alt="Ticket QR code"></p>',
              contentText: expect.stringContaining('{{recipient.name}}'),
            }),
          }),
        }),
      );
    });
    const savePayload = adminApiMock.saveContentVersion.mock.calls.at(-1)?.[1];
    expect(savePayload?.renderedHtml).not.toContain('data-tixkit');
    expect(savePayload?.renderedHtml).not.toContain('key="recipient.name"');
    expect(savePayload?.renderedHtml).not.toContain('Ada Lovelace');
    expect(savePayload?.renderedHtml).not.toContain('data:image/svg+xml');
  });

  it('persists inline styles from editor JSON when package HTML drops custom marks', async () => {
    editorMockState.exportedHtml = '<p>Hi {{recipient.name}}.</p>';
    editorMockState.exportedText = 'Hi {{recipient.name}}.';
    editorMockState.exportedJson = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hi ' },
            {
              type: 'text',
              text: 'Ada Lovelace',
              marks: [
                {
                  type: tixkitMergeTagMarkName,
                  attrs: {
                    key: 'recipient.name',
                    kind: 'recipient',
                    label: 'Attendee name',
                    preview: 'Ada Lovelace',
                  },
                },
                {
                  type: tixkitInlineStyleMarkName,
                  attrs: {
                    color: '#0f766e',
                    fontFamily: '"Times New Roman", Times, serif',
                    fontSize: '18px',
                    lineHeight: '140%',
                  },
                },
              ],
            },
            { type: 'text', text: '.' },
          ],
        },
      ],
    };
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByRole('textbox', { name: 'Email body' });
    clickEmailSaveDraft();

    await waitFor(() => {
      const savePayload = adminApiMock.saveContentVersion.mock.calls.at(-1)?.[1];
      expect(savePayload?.renderedHtml).toContain(
        '<span style="color: #0f766e; font-family: &quot;Times New Roman&quot;, Times, serif; font-size: 18px; line-height: 140%">{{recipient.name}}</span>',
      );
      expect(savePayload?.contentJson.editor.contentHtml).toContain(
        '<span style="color: #0f766e; font-family: &quot;Times New Roman&quot;, Times, serif; font-size: 18px; line-height: 140%">{{recipient.name}}</span>',
      );
    });
  });

  it('persists Code mode Global CSS into the saved editor HTML', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByRole('textbox', { name: 'Email body' });
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    const globalCss = await screen.findByLabelText('Global CSS');
    fireEvent.change(globalCss, {
      target: { value: '.ticket-code { letter-spacing: 0.08em; }' },
    });
    clickEmailSaveDraft();

    await waitFor(() => {
      const savePayload = adminApiMock.saveContentVersion.mock.calls.at(-1)?.[1];
      expect(savePayload?.contentJson.editor.globalCss).toBe(
        '.ticket-code { letter-spacing: 0.08em; }',
      );
      expect(savePayload?.renderedHtml).toContain('data-tixkit-global-css="true"');
      expect(savePayload?.renderedHtml).toContain('.ticket-code { letter-spacing: 0.08em; }');
      expect(savePayload?.renderedHtml.match(/data-tixkit-global-css/g)).toHaveLength(1);
    });
  });

  it('loads email content documents from array and keyed API response shapes', async () => {
    adminApiMock.listContentDocuments.mockResolvedValueOnce(ok([document]));
    const first = render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    expect(await screen.findByLabelText('Subject')).toHaveValue(emailDocument.settings.subject);
    expect(adminApiMock.createContentDocument).not.toHaveBeenCalled();
    first.unmount();

    vi.clearAllMocks();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    adminApiMock.getEvent.mockResolvedValue(ok(event));
    adminApiMock.listBrandEmailSenderIdentities.mockResolvedValue(ok([senderIdentity]));
    adminApiMock.listBrands.mockResolvedValue(ok([brand]));
    adminApiMock.listContentDocuments.mockResolvedValue(ok({ cdoc_email: document }));
    adminApiMock.listContentVersions.mockResolvedValue(ok({ items: [version] }));
    adminApiMock.saveContentVersion.mockResolvedValue(ok(savedVersion));

    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    expect(await screen.findByLabelText('Subject')).toHaveValue(emailDocument.settings.subject);
    expect(adminApiMock.createContentDocument).not.toHaveBeenCalled();
  });

  it('requires confirmation before archiving and locks archived email templates', async () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );

    const editable = render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByLabelText('Subject');
    clickMoreAction('Archive');

    expect(adminApiMock.archiveContentDocument).not.toHaveBeenCalled();
    editable.unmount();

    vi.clearAllMocks();
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    adminApiMock.getEvent.mockResolvedValue(ok(event));
    adminApiMock.listBrandEmailSenderIdentities.mockResolvedValue(ok([senderIdentity]));
    adminApiMock.listBrands.mockResolvedValue(ok([brand]));
    adminApiMock.listContentDocuments.mockResolvedValue(
      ok({ items: [{ ...document, status: 'archived' }] }),
    );
    adminApiMock.listContentVersions.mockResolvedValue(ok({ items: [version] }));

    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    expect(await screen.findByLabelText('Subject')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish version' })).toBeDisabled();
    openEmailMoreActions();
    expect(screen.getByRole('menuitem', { name: 'Send test email' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('creates the event-scoped email document and initial canonical draft when none exists', async () => {
    adminApiMock.listContentDocuments.mockResolvedValue(ok({ items: [] }));
    adminApiMock.createContentDocument.mockResolvedValue(ok(document));
    adminApiMock.listContentVersions.mockResolvedValue(ok({ items: [] }));
    adminApiMock.saveContentVersion.mockResolvedValue(ok(version));

    render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(EmailPersistedEditorView, {
          eventId: 'evt_1',
          templateKey: 'review-request',
        }),
      ),
    );

    await screen.findByLabelText('Subject');
    expect(adminApiMock.createContentDocument).toHaveBeenCalledWith({
      organizationId: 'org_1',
      brandId: 'brd_1',
      eventId: 'evt_1',
      channel: 'email',
      key: 'review-request',
      name: 'All Access Chicago Review request',
      locale: 'en',
    });
    expect(adminApiMock.createContentDocument).toHaveBeenCalledTimes(1);
    expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
      'cdoc_email',
      expect.objectContaining({
        contentJson: expect.objectContaining({
          schemaVersion: 1,
          editor: expect.objectContaining({
            provider: '@react-email/editor',
            contentHtml: expect.stringContaining('{{review.platform}}'),
          }),
        }),
        renderedHtml: expect.stringContaining('{{recipient.name}}'),
        renderedText: expect.stringContaining('{{event.title}}'),
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
    clickEmailSaveDraft();
    await waitFor(() => expect(screen.getByText('Saving')).toBeInTheDocument());

    fireEvent.change(subject, { target: { value: 'Fresh email subject' } });
    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());

    await act(async () => {
      resolveStaleSave(ok({ ...savedVersion, id: 'cver_stale', subject: 'Stale email subject' }));
    });

    expect(screen.queryByText('Saved draft v2')).not.toBeInTheDocument();

    await confirmPublishVersion();
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
    clickEmailSaveDraft();

    expect(await screen.findByText('Injected email save outage')).toBeInTheDocument();
    expect(screen.getByText('Save failed')).toBeInTheDocument();
    expect(screen.getByLabelText('Subject')).toHaveValue('Retryable email subject');

    fireEvent.change(subject, { target: { value: 'Recovered email subject' } });
    expect(screen.queryByText('Injected email save outage')).not.toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();

    clickEmailSaveDraft();
    await waitFor(() => {
      expect(screen.getByText('Saved draft v2')).toBeInTheDocument();
    });
    expect(adminApiMock.saveContentVersion).toHaveBeenLastCalledWith(
      'cdoc_email',
      expect.objectContaining({ subject: 'Recovered email subject' }),
    );
  });

  it('enables native editor commands and code mode without the legacy insert rail', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByRole('textbox', { name: 'Email body' });

    expect(screen.queryByRole('button', { name: 'Insert Image' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Insert Components' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(await screen.findByText('Email HTML')).toBeInTheDocument();
    expect(screen.getByText('Editor JSON')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Email HTML code' }), {
      target: {
        value: '<h1>{{event.title}}</h1><p>Edited from code mode for {{recipient.name}}.</p>',
      },
    });
    clickEmailSaveDraft();

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({
          contentJson: expect.objectContaining({
            editor: expect.objectContaining({
              provider: REACT_EMAIL_EDITOR_PACKAGE,
            }),
            settings: expect.objectContaining({ templateKey: 'order-confirmed' }),
          }),
          renderedHtml: expect.stringContaining('Edited from code mode for {{recipient.name}}.'),
        }),
      );
    });
  });

  it('uploads inline email images through tenant-scoped content artifacts', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    const canvas = await screen.findByRole('textbox', { name: 'Email body' });
    fireEvent.click(screen.getByRole('button', { name: 'Mock image upload' }));

    await waitFor(() => {
      expect(adminApiMock.uploadArtifact).toHaveBeenCalledWith({
        purpose: 'content_email_image',
        file: expect.any(File),
        brandId: 'brd_1',
        eventId: 'evt_1',
        metadata: {
          source: 'admin_email_editor',
          contentDocumentId: 'cdoc_email',
          templateKey: 'order-confirmed',
        },
      });
    });
    expect(canvas).toHaveTextContent(
      'https://api.example.test/v1/public/content-email-images/upl_email_image',
    );
  });

  it('reviews the current email export and blocks publish with local validation errors', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    const subject = await screen.findByLabelText('Subject');
    fireEvent.change(subject, { target: { value: '' } });
    const canvas = screen.getByRole('textbox', { name: 'Email body' });
    canvas.textContent = '{{unknown.value}}';
    fireEvent.input(canvas);

    openEmailMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Review blockers' }));

    expect(await screen.findByText('missing_subject')).toBeInTheDocument();
    expect(screen.getByText('unknown_variable')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Publish version?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    openEmailMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send test email' }));
    expect(screen.getByRole('dialog', { name: 'Send test email' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }));

    expect(
      await screen.findByText('Resolve email test-send blockers before sending a test.'),
    ).toBeInTheDocument();
    expect(adminApiMock.testSendContent).not.toHaveBeenCalled();
    expect(adminApiMock.publishContentVersion).not.toHaveBeenCalled();
  });

  it('blocks review when the brand has no verified email sender identity', async () => {
    adminApiMock.listBrandEmailSenderIdentities.mockResolvedValue(ok([]));

    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    expect(await screen.findByLabelText('Verified sender')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Publish version' }));

    expect(
      await screen.findByText('Resolve email review blockers before publishing.'),
    ).toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: 'Publish version?' });
    expect(screen.getAllByText('email_sender_identity_missing').length).toBeGreaterThan(0);
    expect(within(dialog).getByRole('button', { name: 'Publish version' })).toBeDisabled();
    expect(adminApiMock.publishContentVersion).not.toHaveBeenCalled();
    expect(adminApiMock.sendMessage).not.toHaveBeenCalled();
  });

  it('publishes a version without queuing an audience campaign send', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByLabelText('Subject');
    await confirmPublishVersion();

    await waitFor(() => {
      expect(adminApiMock.publishContentVersion).toHaveBeenCalledWith('cdoc_email', 'cver_2');
    });
    expect(adminApiMock.sendMessage).not.toHaveBeenCalled();
    expect(adminApiMock.testSendContent).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Audience')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Send timing')).not.toBeInTheDocument();
    expect(screen.getByText(/Published v2/i)).toBeInTheDocument();
  });

  it('applies a saved brand email template while preserving the verified sender', async () => {
    adminApiMock.listContentDocuments
      .mockResolvedValueOnce(ok({ items: [document] }))
      .mockResolvedValueOnce(ok({ items: [document, brandTemplateDocument] }));
    adminApiMock.listContentVersions
      .mockResolvedValueOnce(ok({ items: [version] }))
      .mockResolvedValueOnce(ok({ items: [brandTemplateVersion] }));

    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByLabelText('Subject');
    clickMoreAction('Switch template');
    expect(await screen.findByRole('dialog', { name: 'Pick a template' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Subject')).toHaveValue('Brand update for {{recipient.name}}');
    });

    clickEmailSaveDraft();

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({
          subject: 'Brand update for {{recipient.name}}',
          previewText: 'A quick update from {{brand.name}}.',
          contentJson: expect.objectContaining({
            settings: expect.objectContaining({
              templateKey: 'brand-announcement',
              subject: 'Brand update for {{recipient.name}}',
              previewText: 'A quick update from {{brand.name}}.',
              category: 'bulk',
              sender: expect.objectContaining({
                fromEmail: 'tickets@example.test',
                replyToEmail: 'support@example.test',
              }),
            }),
            blocks: expect.arrayContaining([
              expect.objectContaining({
                type: 'unsubscribe_footer',
                unsubscribeUrl: '{{brand.supportUrl}}',
              }),
            ]),
          }),
        }),
      );
    });
  });

  it('keeps brand-scoped senders, templates, and assets isolated across brands', async () => {
    adminApiMock.listBrandEmailSenderIdentities.mockResolvedValue(
      ok([secondBrandSenderIdentity, senderIdentity]),
    );
    adminApiMock.listBrands.mockResolvedValue(ok([secondBrand, brand]));
    adminApiMock.listContentDocuments
      .mockResolvedValueOnce(ok({ items: [document] }))
      .mockResolvedValueOnce(
        ok({ items: [document, secondBrandTemplateDocument, brandTemplateDocument] }),
      );

    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    const senderSelect = (await screen.findByLabelText('Verified sender')) as HTMLSelectElement;
    expect(adminApiMock.listBrandEmailSenderIdentities).toHaveBeenCalledWith('brd_1');
    expect(adminApiMock.listContentDocuments).toHaveBeenNthCalledWith(2, {
      brandId: 'brd_1',
      channel: 'email',
      limit: 100,
    });
    expect(senderSelect).toHaveValue('bsi_1');
    expect(Array.from(senderSelect.options).map((option) => option.textContent)).toEqual([
      'Tixkit <tickets@example.test>',
    ]);
    await waitFor(() => {
      expect(editorMockState.lastTheme).toEqual(
        expect.objectContaining({
          styles: expect.objectContaining({
            button: expect.objectContaining({ backgroundColor: '#111827' }),
            h1: expect.objectContaining({ color: '#111827' }),
          }),
        }),
      );
    });
    expect(JSON.stringify(editorMockState.lastTheme)).not.toContain('#0f766e');
    openEmailMoreActions();
    fireEvent.click(screen.getByRole('menuitem', { name: /Theme preset/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Minimal' }));
    await waitFor(() => {
      expect(editorMockState.lastTheme).toEqual(
        expect.objectContaining({
          styles: expect.objectContaining({
            body: expect.objectContaining({ borderRadius: '0px', padding: '24px' }),
            button: expect.objectContaining({ backgroundColor: '#18181b' }),
            h1: expect.objectContaining({ color: '#18181b' }),
          }),
        }),
      );
    });
    expect(
      screen.queryByText(/reseller|admin white-label|white label controls/i),
    ).not.toBeInTheDocument();

    clickMoreAction('Switch template');
    expect(await screen.findByRole('dialog', { name: 'Pick a template' })).toBeInTheDocument();
    expect(screen.getByText('Brand announcement')).toBeInTheDocument();
    expect(screen.queryByText('Riverside announcement')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);

    expect(screen.getByLabelText('Insert variable')).toBeInTheDocument();
  });

  it('inserts the selected variable token into the active email block', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    const canvas = await screen.findByRole('textbox', { name: 'Email body' });
    fireEvent.click(screen.getByLabelText('Insert variable'));
    fireEvent.click(screen.getByRole('button', { name: /Brand name/ }));

    expect(canvas).toHaveTextContent('{{brand.name}}');
    expect(canvas.textContent).not.toContain('{{recipient.name}} {{recipient.name}}');
  });

  it('saves the latest email draft before duplicating the template', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    const subject = await screen.findByLabelText('Subject');
    fireEvent.change(subject, {
      target: { value: 'Duplicate-ready tickets for {{event.title}}' },
    });

    clickMoreAction('Duplicate');

    await waitFor(() => {
      expect(adminApiMock.duplicateContentDocument).toHaveBeenCalledWith('cdoc_email', {
        name: 'All Access Chicago email template Copy',
      });
    });
    expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
      'cdoc_email',
      expect.objectContaining({
        subject: 'Duplicate-ready tickets for {{event.title}}',
      }),
    );
    const saveCallOrder = adminApiMock.saveContentVersion.mock.invocationCallOrder;
    const duplicateCallOrder = adminApiMock.duplicateContentDocument.mock.invocationCallOrder;
    expect(saveCallOrder[saveCallOrder.length - 1]).toBeLessThan(
      duplicateCallOrder[duplicateCallOrder.length - 1],
    );
    expect(
      screen.getByText('Duplicated email template as All Access Chicago email template Copy'),
    ).toBeInTheDocument();
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

    expect(
      await screen.findByText(
        'Saved email draft is not canonical Tixkit React Email template JSON.',
      ),
    ).toBeInTheDocument();
  });
});
