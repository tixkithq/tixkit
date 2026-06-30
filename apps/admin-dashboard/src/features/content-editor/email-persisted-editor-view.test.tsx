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
  duplicateContentDocument: vi.fn(),
  archiveContentDocument: vi.fn(),
  testSendContent: vi.fn(),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
}));

const editorMockHelpers = vi.hoisted(() => ({
  textFromHtml(value: string): string {
    return value
      .replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/gi, ' $1 ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  },
  textFromContent(content: unknown): string {
    if (typeof content === 'string') return editorMockHelpers.textFromHtml(content);
    if (!content || typeof content !== 'object') return '';
    return JSON.stringify(content);
  },
  escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  },
}));

vi.mock('@/lib/api', () => ({
  adminApi: adminApiMock,
}));

vi.mock('sonner', () => ({
  toast: toastMock,
}));

vi.mock('@react-email/editor', async () => {
  const ReactModule = await import('react');

  const EmailEditor = ReactModule.forwardRef(
    (
      {
        content,
        editable = true,
        onReady,
        onUpdate,
      }: {
        content?: unknown;
        editable?: boolean;
        onReady?: (ref: unknown) => void;
        onUpdate?: (ref: unknown) => void;
      },
      ref,
    ) => {
      const [value, setValue] = ReactModule.useState(() =>
        editorMockHelpers.textFromContent(content),
      );
      const valueRef = ReactModule.useRef(value);
      const onReadyRef = ReactModule.useRef(onReady);
      const onUpdateRef = ReactModule.useRef(onUpdate);
      const didMountRef = ReactModule.useRef(false);
      const editor = ReactModule.useMemo(
        () => ({
          chain() {
            const chainApi = {
              focus: () => chainApi,
              insertContent: (next: string) => {
                setValue((current) => `${current} ${editorMockHelpers.textFromHtml(next)}`.trim());
                return chainApi;
              },
              run: () => true,
            };
            return chainApi;
          },
        }),
        [],
      );
      const editorRef = ReactModule.useMemo(
        () => ({
          getEmail: async () => ({
            html: `<p>${editorMockHelpers.escapeHtml(valueRef.current)}</p>`,
            text: valueRef.current,
          }),
          getEmailHTML: async () => `<p>${editorMockHelpers.escapeHtml(valueRef.current)}</p>`,
          getEmailText: async () => valueRef.current,
          getJSON: () => ({
            type: 'doc',
            content: valueRef.current
              ? [{ type: 'paragraph', content: [{ type: 'text', text: valueRef.current }] }]
              : [],
          }),
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
        'div',
        {
          'aria-label': 'Email body',
          contentEditable: editable,
          role: 'textbox',
          suppressContentEditableWarning: true,
          onInput: (event: React.FormEvent<HTMLDivElement>) => {
            setValue(event.currentTarget.textContent ?? '');
          },
        },
        value,
      );
    },
  );
  EmailEditor.displayName = 'MockEmailEditor';

  return { EmailEditor };
});

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

function openEmailMoreActions() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
}

function clickEmailSaveDraft() {
  openEmailMoreActions();
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
}

describe('EmailPersistedEditorView', () => {
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
  });

  it('loads an existing email document and persists preview, publish, and test-send actions', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    expect(await screen.findByTestId('email-metadata-bar')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Insert content' })).toBeInTheDocument();
    expect(screen.getByText('React Email inspector')).toBeInTheDocument();
    expect(screen.getByTestId('native-email-inspector-host')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse inspector' }));
    expect(screen.getByRole('button', { name: 'Open inspector' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Insert Variables' }));
    expect(screen.getByText('Insert merge tags')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '{{brand.name}}' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse inspector' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse inspector' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open inspector' }));
    expect(screen.getByRole('button', { name: 'Collapse inspector' })).toBeInTheDocument();
    openEmailMoreActions();
    fireEvent.click(screen.getByRole('button', { name: 'Open version history' }));
    expect(screen.getByText('Version history')).toBeInTheDocument();
    openEmailMoreActions();
    fireEvent.click(screen.getByRole('button', { name: 'Open variables panel' }));
    expect(screen.getByText('Insert merge tags')).toBeInTheDocument();
    openEmailMoreActions();
    fireEvent.click(screen.getByRole('button', { name: 'Template details' }));
    expect(screen.getByText('React Email inspector')).toBeInTheDocument();
    openEmailMoreActions();
    fireEvent.click(screen.getByRole('button', { name: 'View JSON payload' }));
    expect(screen.getByText('Saved payload')).toBeInTheDocument();
    openEmailMoreActions();
    fireEvent.click(screen.getByRole('button', { name: 'Review blockers' }));
    expect(await screen.findByText('Current draft review')).toBeInTheDocument();
    openEmailMoreActions();
    fireEvent.click(screen.getByRole('button', { name: 'Template details' }));
    expect(screen.getByText('React Email inspector')).toBeInTheDocument();

    const subject = await screen.findByLabelText('Subject');
    fireEvent.change(subject, {
      target: { value: 'Updated tickets for {{event.title}}' },
    });
    fireEvent.change(screen.getByLabelText('Template key'), {
      target: { value: 'door-reminder' },
    });
    fireEvent.change(screen.getByLabelText('Locale'), {
      target: { value: 'en-US' },
    });
    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'staff' },
    });
    const canvas = screen.getByRole('textbox', { name: 'Email body' });
    canvas.textContent = 'Updated saved email for {{recipient.name}}.';
    fireEvent.input(canvas);
    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({
          subject: 'Updated tickets for {{event.title}}',
          contentJson: expect.objectContaining({
            schemaVersion: 1,
            settings: expect.objectContaining({
              subject: 'Updated tickets for {{event.title}}',
              templateKey: 'door-reminder',
              locale: 'en-US',
              category: 'staff',
            }),
            editor: expect.objectContaining({
              contentJson: expect.objectContaining({ type: 'doc' }),
              contentText: 'Updated saved email for {{recipient.name}}.',
            }),
          }),
          renderedHtml: expect.stringContaining('Updated saved email for Ada Lovelace.'),
        }),
      );
      expect(adminApiMock.previewContent).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({ versionId: 'cver_2' }),
      );
    });

    expect(screen.getByTestId('preview-drawer')).toHaveTextContent('Updated saved email');

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => {
      expect(adminApiMock.publishContentVersion).toHaveBeenCalledWith('cdoc_email', 'cver_2');
    });

    openEmailMoreActions();
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }));
    await waitFor(() => {
      expect(adminApiMock.testSendContent).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({
          versionId: 'cver_2',
          recipient: 'ada@example.test',
        }),
      );
    });

    openEmailMoreActions();
    fireEvent.click(screen.getByRole('button', { name: 'Archive template' }));
    await waitFor(() => {
      expect(adminApiMock.archiveContentDocument).toHaveBeenCalledWith('cdoc_email');
    });
    expect(screen.getByText('Archived email template')).toBeInTheDocument();
  }, 10000);

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
    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Archive template' }));

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

    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    expect(await screen.findByLabelText('Subject')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open preview' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
    openEmailMoreActions();
    expect(screen.getByRole('button', { name: 'Send test' })).toBeDisabled();
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
    clickEmailSaveDraft();
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

  it('adds editor-authored images and reusable components from the insert rail', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    await screen.findByRole('textbox', { name: 'Email body' });

    fireEvent.click(screen.getByRole('button', { name: 'Insert Image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Insert Components' }));
    expect(screen.getByText('Insert email sections')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /QR code/ }));
    fireEvent.click(screen.getByRole('button', { name: /Calendar button/ }));
    fireEvent.click(screen.getByRole('button', { name: /Ticket summary/ }));
    clickEmailSaveDraft();

    await waitFor(() => {
      expect(adminApiMock.saveContentVersion).toHaveBeenCalledWith(
        'cdoc_email',
        expect.objectContaining({
          contentJson: expect.objectContaining({
            editor: expect.objectContaining({
              contentText: expect.stringMatching(/Ticket QR code[\s\S]*Add to calendar/),
              contentJson: expect.objectContaining({ type: 'doc' }),
            }),
          }),
          renderedHtml: expect.stringMatching(/Add to calendar[\s\S]*General Admission/),
        }),
      );
    });
  });

  it('reviews the current email export and blocks publish with local validation errors', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    const subject = await screen.findByLabelText('Subject');
    fireEvent.change(subject, { target: { value: '' } });
    const canvas = screen.getByRole('textbox', { name: 'Email body' });
    canvas.textContent = '{{unknown.value}}';
    fireEvent.input(canvas);

    openEmailMoreActions();
    fireEvent.click(screen.getByRole('button', { name: 'Review blockers' }));

    expect(await screen.findByText('missing_subject')).toBeInTheDocument();
    expect(screen.getByText('unknown_variable')).toBeInTheDocument();
    expect(screen.getByText('Current draft review')).toBeInTheDocument();

    openEmailMoreActions();
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }));

    expect(
      await screen.findByText('Resolve email test-send blockers before sending a test.'),
    ).toBeInTheDocument();
    expect(adminApiMock.testSendContent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect(
      await screen.findByText('Resolve email publish blockers before publishing.'),
    ).toBeInTheDocument();
    expect(adminApiMock.publishContentVersion).not.toHaveBeenCalled();
  });

  it('inserts the selected variable token into the active email block', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    const canvas = await screen.findByRole('textbox', { name: 'Email body' });
    fireEvent.click(screen.getByRole('button', { name: 'Insert Variables' }));
    fireEvent.click(screen.getByRole('button', { name: '{{brand.name}}' }));

    expect(canvas).toHaveTextContent('{{brand.name}}');
    expect(canvas.textContent).not.toContain('{{recipient.name}} {{recipient.name}}');
  });

  it('saves the latest email draft before duplicating the template', async () => {
    render(React.createElement(EmailPersistedEditorView, { eventId: 'evt_1' }));

    const subject = await screen.findByLabelText('Subject');
    fireEvent.change(subject, {
      target: { value: 'Duplicate-ready tickets for {{event.title}}' },
    });

    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate template' }));

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
