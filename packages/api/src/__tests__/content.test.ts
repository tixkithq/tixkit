import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type {
  EmailTransport,
  Principal,
  SendEmailInput,
  SendEmailResult,
  SendSmsInput,
  SendSmsResult,
  SmsTransport,
} from '@tixkit/domain';
import type { Database } from '@tixkit/db';
import { REACT_EMAIL_EDITOR_PACKAGE, createDefaultEmailTemplate } from '@tixkit/content-email';
import { createDefaultEventPageDocument } from '@tixkit/content-event-page';
import { createDefaultSmsTemplate } from '@tixkit/content-message';
import type { AppContext } from '../app.js';
import { contentRoutes, publicContentRoutes } from '../routes/modules/content.js';

function valueFor(row: Record<string, unknown>, column: string) {
  return row[column] ?? row[column.split('.').at(-1) ?? column];
}

class TestCaptureEmailTransport implements EmailTransport {
  public sent: SendEmailInput[] = [];

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    this.sent.push(input);
    return {
      deliveryId: input.deliveryId,
      provider: 'capture',
      providerMessageId: 'cap_content_email',
      status: 'accepted',
      attemptedFallbackProviders: [],
      sentAt: '2026-06-29T00:00:00.000Z',
    };
  }
}

class TestCaptureSmsTransport implements SmsTransport {
  public sent: SendSmsInput[] = [];

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    this.sent.push(input);
    return {
      deliveryId: input.deliveryId,
      provider: 'capture',
      providerMessageId: 'cap_content_sms',
      status: 'accepted',
      attemptedFallbackProviders: [],
      sentAt: '2026-06-29T00:00:00.000Z',
    };
  }
}

function createContentDb(seed: Record<string, Record<string, unknown>[]>) {
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];

  function rows(table: string) {
    return seed[table] ?? [];
  }

  function selectFrom(table: string) {
    const conditions: Array<[string, string, unknown]> = [];
    const query = {
      select() {
        return query;
      },
      selectAll() {
        return query;
      },
      where(column: string, op: string, value: unknown) {
        conditions.push([column, op, value]);
        return query;
      },
      orderBy() {
        return query;
      },
      limit() {
        return query;
      },
      execute() {
        return Promise.resolve(
          rows(table).filter((row) =>
            conditions.every(([column, op, value]) => {
              const rowValue = valueFor(row, column);
              if (op === '=') return rowValue === value;
              if (op === 'in') return Array.isArray(value) && value.includes(rowValue as string);
              if (op === 'is not') return rowValue !== value;
              return true;
            }),
          ),
        );
      },
      async executeTakeFirst() {
        return (await query.execute())[0];
      },
      async executeTakeFirstOrThrow() {
        const row = await query.executeTakeFirst();
        if (!row) throw new Error(`No row for ${table}`);
        return row;
      },
    };
    return query;
  }

  function insertInto(table: string) {
    return {
      values(value: Record<string, unknown>) {
        const row = { ...value };
        return {
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              seed[table] ??= [];
              seed[table].push(row);
              inserted.push(row);
              return row;
            },
          }),
          execute: async () => {
            seed[table] ??= [];
            seed[table].push(row);
            inserted.push(row);
          },
        };
      },
    };
  }

  function updateTable(table: string) {
    return {
      set(value: Record<string, unknown>) {
        const conditions: Array<[string, unknown]> = [];
        const query = {
          where(column: string, _op: string, comparison: unknown) {
            conditions.push([column, comparison]);
            return query;
          },
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              const row = rows(table).find((candidate) =>
                conditions.every(
                  ([column, comparison]) => valueFor(candidate, column) === comparison,
                ),
              );
              if (!row) throw new Error(`No row to update for ${table}`);
              Object.assign(row, value);
              updated.push(value);
              return row;
            },
          }),
          execute: async () => {
            for (const row of rows(table)) {
              if (
                conditions.every(([column, comparison]) => valueFor(row, column) === comparison)
              ) {
                Object.assign(row, value);
                updated.push(value);
              }
            }
          },
        };
        return query;
      },
    };
  }

  const db = {
    selectFrom,
    insertInto,
    updateTable,
    transaction() {
      return {
        execute(callback: (trx: Database) => Promise<unknown>) {
          return callback(db as unknown as Database);
        },
      };
    },
  } as unknown as Database;

  return {
    inserted,
    updated,
    db,
  };
}

function documentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cdoc_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    brand_id: 'brd_1',
    event_id: null,
    channel: 'email',
    key: 'order-confirmed',
    name: 'Order confirmed',
    status: 'draft',
    locale: 'en',
    current_draft_version_id: 'cver_1',
    published_version_id: null,
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    updated_at: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cver_1',
    document_id: 'cdoc_1',
    version_number: 1,
    status: 'draft',
    schema_version: 1,
    subject: 'Hi {{recipient.name}}',
    preview_text: null,
    content_json: JSON.stringify(emailDocumentJson()),
    rendered_html: '<h1>{{event.title}}</h1><p>Hi {{recipient.name}}</p>',
    rendered_text: 'Hi {{recipient.name}}',
    variables: JSON.stringify([]),
    validation: JSON.stringify({ valid: true, severity: 'warning', issues: [] }),
    created_by: 'usr_1',
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    published_at: null,
    ...overrides,
  };
}

function emailDocumentJson(overrides: Parameters<typeof createDefaultEmailTemplate>[0] = {}) {
  return createDefaultEmailTemplate({
    editor: {
      provider: REACT_EMAIL_EDITOR_PACKAGE,
      contentHtml: '<h1>{{event.title}}</h1><p>Hi {{recipient.name}}, order {{order.id}}.</p>',
    },
    settings: {
      templateKey: 'order-confirmed',
      subject: 'Hi {{recipient.name}}',
      previewText: 'Preview for {{recipient.name}}',
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
        headline: 'Hi {{recipient.name}}',
        body: 'Your {{event.title}} tickets are ready.',
        ctaLabel: 'View tickets',
        ctaUrl: '{{event.checkoutUrl}}',
      },
      {
        type: 'ticket_summary',
        title: 'Ticket summary',
        body: 'Order {{order.id}} - {{ticket.type}} - {{order.total}}',
      },
      {
        type: 'unsubscribe_footer',
        body: 'You are receiving this because you bought tickets with {{brand.name}}.',
        unsubscribeUrl: '{{brand.supportUrl}}',
      },
    ],
    ...overrides,
  });
}

function legacyEventPageJson(
  overrides: Parameters<typeof createDefaultEventPageDocument>[0] = {
    eventId: 'evt_1',
    eventTitle: 'Published page',
    eventDescription: 'Preview copy',
    startsAt: '2026-07-17T19:00:00.000Z',
    timezone: 'America/Chicago',
    venue: { name: 'The Salt Shed', city: 'Chicago' },
  },
) {
  return {
    settings: {
      locale: overrides.locale ?? 'en',
      publicPath: overrides.publicUrl ?? `/e/${overrides.eventId}`,
      discovery: {
        summary: overrides.eventDescription ?? `Details for ${overrides.eventTitle}.`,
        tags: [],
        seoTitle: overrides.eventTitle,
        seoDescription: overrides.eventDescription,
      },
    },
    blocks: [
      {
        id: 'hero',
        type: 'hero',
        eyebrow: overrides.brandName,
        headline: overrides.eventTitle,
        body: overrides.eventDescription,
        imageUrl: overrides.coverImageUrl,
        imageAlt: overrides.coverImageAlt,
        ctaLabel: 'Get tickets',
        ctaUrl: overrides.publicUrl,
      },
      {
        id: 'details',
        type: 'event_details',
        title: 'Event details',
        items: [
          { label: 'Date', value: overrides.startsAt ?? 'TBA' },
          { label: 'Venue', value: overrides.venue?.name ?? 'Venue to be announced' },
        ],
      },
      {
        id: 'tickets',
        type: 'tickets',
        title: 'Tickets',
      },
    ],
  };
}

function eventPageJson(overrides?: Parameters<typeof createDefaultEventPageDocument>[0]) {
  return createDefaultEventPageDocument(
    overrides ?? {
      eventId: 'evt_1',
      eventTitle: 'Published page',
      eventDescription: 'Preview copy',
      startsAt: '2026-07-17T19:00:00.000Z',
      timezone: 'America/Chicago',
      venue: { name: 'The Salt Shed', city: 'Chicago' },
      publicUrl: '/e/evt_1',
    },
  );
}

async function setupContentApp(
  db: Database,
  principal: Principal,
  overrides: Partial<AppContext> = {},
) {
  const app = Fastify();
  app.decorate('context', {
    db,
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService: {},
    temporalClient: {},
    emailTransport: new TestCaptureEmailTransport(),
    smsTransport: new TestCaptureSmsTransport(),
    ...overrides,
  } as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = principal;
  });
  await app.register(contentRoutes);
  return app;
}

async function setupPublicContentApp(db: Database, overrides: Partial<AppContext> = {}) {
  const app = Fastify();
  app.decorate('context', {
    db,
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService: {},
    temporalClient: {},
    emailTransport: new TestCaptureEmailTransport(),
    smsTransport: new TestCaptureSmsTransport(),
    ...overrides,
  } as unknown as AppContext);
  await app.register(publicContentRoutes);
  return app;
}

describe('content routes', () => {
  const principal: Principal = {
    type: 'user',
    id: 'usr_1',
    tenantId: 'tnt_1',
    organizationIds: ['org_1'],
    scopes: ['events.read', 'events.write', 'messages.write'],
  };

  it('rejects stubbed future channels before creating documents', async () => {
    const { db, inserted } = createContentDb({ content_documents: [] });
    const app = await setupContentApp(db, principal);

    const response = await app.inject({
      method: 'POST',
      url: '/content-documents',
      payload: {
        organizationId: 'org_1',
        brandId: 'brd_1',
        channel: 'imessage',
        key: 'invite',
        name: 'iMessage invite',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message ?? response.json().error?.message).toContain('unavailable');
    expect(inserted).toHaveLength(0);
  });

  it.each(['abc', '0', '-1', '101'])(
    'rejects invalid content document list limit %s',
    async (limit) => {
      const { db } = createContentDb({
        content_documents: [documentRow()],
      });
      const app = await setupContentApp(db, principal);

      const response = await app.inject({
        method: 'GET',
        url: `/content-documents?limit=${encodeURIComponent(limit)}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message ?? response.json().error?.message).toContain(
        'Invalid content query',
      );
    },
  );

  it('rejects unsupported content document list query keys', async () => {
    const { db } = createContentDb({
      content_documents: [documentRow()],
    });
    const app = await setupContentApp(db, principal);

    const response = await app.inject({
      method: 'GET',
      url: '/content-documents?cursor=cdoc_1',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message ?? response.json().error?.message).toContain(
      'Invalid content query',
    );
  });

  it('renders email previews through the React Email adapter and records artifacts', async () => {
    const { db, inserted } = createContentDb({
      brands: [{ id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1' }],
      content_documents: [documentRow()],
      content_document_versions: [versionRow()],
      content_render_artifacts: [],
    });
    const app = await setupContentApp(db, principal);

    const response = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_1/preview',
      payload: {
        versionId: 'cver_1',
        context: {
          event: {
            title: 'All Access',
            checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_1',
          },
          brand: { name: 'Tixkit', supportUrl: 'https://help.example.test/preferences' },
          recipient: { name: 'Ada' },
          ticket: { type: 'General Admission' },
          order: { total: '$35.00' },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      channel: 'email',
      output: {
        subject: 'Hi Ada',
      },
      validation: { valid: true },
      renderArtifact: {
        tenantId: 'tnt_1',
        documentId: 'cdoc_1',
        versionId: 'cver_1',
        channel: 'email',
        outputType: 'preview',
      },
    });
    expect(response.json().renderArtifact.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(response.json().renderArtifact.artifactRef).toContain(
      `content-preview:cdoc_1:cver_1:${response.json().renderArtifact.checksum}`,
    );
    expect(inserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          document_id: 'cdoc_1',
          version_id: 'cver_1',
          output_type: 'preview',
          checksum: response.json().renderArtifact.checksum,
        }),
      ]),
    );
    expect(response.json().output.html).toContain('Hi Ada');
    expect(response.json().output.text).toContain('Hi Ada, order');
  });

  it('saves, previews, and captures canonical email template test sends', async () => {
    const emailTransport = new TestCaptureEmailTransport();
    const emailDocument = emailDocumentJson({
      settings: {
        templateKey: 'order-confirmed',
        subject: 'Tickets for {{event.title}}',
        previewText: 'Ready for {{recipient.name}}',
        locale: 'en',
        category: 'transactional',
        sender: { fromEmail: 'tickets@example.test' },
      },
    });
    const { db, inserted } = createContentDb({
      brands: [{ id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1' }],
      email_provider_routes: [
        {
          id: 'epr_content_email',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          provider_type: 'capture',
          credentials_ref: 'capture',
          sender_domain: 'example.test',
          priority: 0,
          is_fallback: false,
          rate_limit_per_hour: null,
          allowed_categories: JSON.stringify(['transactional']),
          status: 'active',
          smoke_send_verified: true,
          created_at: new Date('2026-06-01T00:00:00.000Z'),
          updated_at: new Date('2026-06-01T00:00:00.000Z'),
        },
      ],
      content_documents: [documentRow()],
      content_document_versions: [],
      content_test_sends: [],
      content_render_artifacts: [],
    });
    const app = await setupContentApp(db, principal, { emailTransport });

    const save = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_1/versions',
      payload: {
        contentJson: emailDocument,
        subject: 'caller supplied subject must not win',
        renderedHtml: '<p>caller supplied html must not win</p>',
        renderedText: 'caller supplied text',
      },
    });

    expect(save.statusCode).toBe(201);
    expect(save.json()).toMatchObject({
      documentId: 'cdoc_1',
      subject: 'Tickets for {{event.title}}',
      previewText: 'Ready for {{recipient.name}}',
      renderedHtml: expect.stringContaining('<p>Hi , order .</p>'),
      renderedText: expect.stringContaining('Hi , order .'),
      validation: { valid: true },
    });
    expect(save.json().renderedHtml).not.toBe('<p>caller supplied html must not win</p>');
    expect(save.json().renderedText).not.toBe('caller supplied text');

    const context = {
      event: {
        title: 'All Access',
        checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_1',
      },
      brand: { name: 'Tixkit', supportUrl: 'https://help.example.test/preferences' },
      recipient: { name: 'Ada' },
      ticket: { type: 'General Admission' },
      order: { total: '$35.00' },
    };
    const preview = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_1/preview',
      payload: { versionId: save.json().id, context },
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      channel: 'email',
      output: { subject: 'Tickets for All Access' },
      validation: { valid: true },
      renderArtifact: {
        documentId: 'cdoc_1',
        versionId: save.json().id,
        channel: 'email',
        outputType: 'preview',
      },
    });
    expect(preview.json().output.html).toContain('Hi Ada');
    expect(preview.json().output.text).toContain('Hi Ada, order');

    const capture = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_1/test-sends',
      payload: {
        versionId: save.json().id,
        recipient: 'ada@example.test',
        context,
      },
    });

    expect(capture.statusCode).toBe(202);
    expect(capture.json()).toMatchObject({
      testSend: {
        channel: 'email',
        recipient: 'ada@example.test',
        status: 'captured',
        renderedSubject: 'Tickets for All Access',
      },
      output: preview.json().output,
      renderArtifact: {
        documentId: 'cdoc_1',
        versionId: save.json().id,
        channel: 'email',
        outputType: 'test_send',
      },
    });
    expect(capture.json().renderArtifact.checksum).toBe(preview.json().renderArtifact.checksum);
    expect(emailTransport.sent).toHaveLength(1);
    expect(emailTransport.sent[0]).toMatchObject({
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
      templateKey: 'order-confirmed',
      templateVersionId: save.json().id,
      providerRouteId: 'epr_content_email',
      from: { email: 'tickets@example.test' },
      to: [{ email: 'ada@example.test' }],
      subject: 'Tickets for All Access',
      html: preview.json().output.html,
      text: preview.json().output.text,
      metadata: {
        notificationType: 'transactional',
      },
    });
    expect(emailTransport.sent[0]?.idempotencyKey).toBe(
      `content-test-send:cdoc_1:${save.json().id}:ada@example.test`,
    );
    expect(inserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          document_id: 'cdoc_1',
          subject: 'Tickets for {{event.title}}',
          rendered_html: expect.stringContaining('<p>Hi , order .</p>'),
        }),
        expect.objectContaining({
          channel: 'email',
          recipient: 'ada@example.test',
          status: 'captured',
        }),
      ]),
    );
  });

  it('fails closed for unsafe email editor HTML when saving rendered output', async () => {
    const unsafeContentHtml =
      '<p>Tickets ready</p><img src="https://cdn.example.test/ticket.png" onerror="alert(1)"><a href="jav&#x61;script&colon;alert(1)">Open tickets</a>';
    const emailDocument = emailDocumentJson({
      editor: {
        provider: REACT_EMAIL_EDITOR_PACKAGE,
        contentHtml: unsafeContentHtml,
      },
    });
    const { db } = createContentDb({
      brands: [{ id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1' }],
      content_documents: [documentRow()],
      content_document_versions: [],
    });
    const app = await setupContentApp(db, principal);

    const save = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_1/versions',
      payload: {
        contentJson: emailDocument,
        renderedHtml: '<p>caller supplied html must not win</p>',
        renderedText: 'caller supplied text',
      },
    });

    expect(save.statusCode).toBe(201);
    expect(save.json()).toMatchObject({
      documentId: 'cdoc_1',
      renderedHtml: '',
      renderedText: '',
      validation: { valid: false },
    });
    expect(save.json().contentJson.editor.contentHtml).toBe(unsafeContentHtml);
    expect(save.json().validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unsafe_editor_html',
          field: 'editor.contentHtml',
        }),
        expect.objectContaining({
          code: 'unsafe_link',
          field: 'editor.contentHtml',
        }),
      ]),
    );
  });

  it('fails closed for malformed email template previews and invalid email test sends', async () => {
    const invalidEmail = emailDocumentJson({
      settings: {
        templateKey: 'order-confirmed',
        subject: 'Invalid email',
        locale: 'en',
        category: 'transactional',
        sender: { fromEmail: 'not-an-email' },
      },
    });
    const { db } = createContentDb({
      brands: [{ id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1' }],
      content_documents: [documentRow()],
      content_document_versions: [
        versionRow({
          id: 'cver_email_bad_shape',
          content_json: JSON.stringify({ editor: { provider: 'legacy-html-editor' } }),
          validation: JSON.stringify({ valid: false, severity: 'error', issues: [] }),
        }),
        versionRow({
          id: 'cver_email_invalid',
          content_json: JSON.stringify(invalidEmail),
          validation: JSON.stringify({ valid: false, severity: 'error', issues: [] }),
        }),
      ],
    });
    const app = await setupContentApp(db, principal);

    const malformedPreview = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_1/preview',
      payload: { versionId: 'cver_email_bad_shape', context: { recipient: { name: 'Ada' } } },
    });
    const invalidTestSend = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_1/test-sends',
      payload: {
        versionId: 'cver_email_invalid',
        recipient: 'ada@example.test',
        context: { recipient: { name: 'Ada' } },
      },
    });

    expect(malformedPreview.statusCode).toBe(400);
    expect(malformedPreview.json().message ?? malformedPreview.json().error?.message).toContain(
      'canonical React Email',
    );
    expect(invalidTestSend.statusCode).toBe(400);
    expect(invalidTestSend.json().message ?? invalidTestSend.json().error?.message).toContain(
      'Email test send has render blockers',
    );
  });

  it('fails closed for valid email test sends without an active verified provider route', async () => {
    const { db, inserted } = createContentDb({
      brands: [{ id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1' }],
      content_documents: [documentRow()],
      content_document_versions: [versionRow()],
      content_test_sends: [],
      content_render_artifacts: [],
    });
    const app = await setupContentApp(db, principal);

    const response = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_1/test-sends',
      payload: {
        versionId: 'cver_1',
        recipient: 'ada@example.test',
        context: {
          event: { title: 'All Access', checkoutUrl: 'https://checkout.example.test' },
          brand: { name: 'Tixkit', supportUrl: 'https://help.example.test/preferences' },
          recipient: { name: 'Ada' },
          ticket: { type: 'General Admission' },
          order: { total: '$35.00' },
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message ?? response.json().error?.message).toContain(
      'active verified provider route',
    );
    expect(inserted).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'email',
          recipient: 'ada@example.test',
        }),
      ]),
    );
  });

  it('duplicates authorized content documents as draft-only copies with fresh versions', async () => {
    const { db, inserted, updated } = createContentDb({
      brands: [{ id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1' }],
      content_documents: [
        documentRow({
          status: 'published',
          current_draft_version_id: null,
          published_version_id: 'cver_1',
        }),
      ],
      content_document_versions: [
        versionRow({
          status: 'published',
          published_at: new Date('2026-06-02T00:00:00.000Z'),
        }),
      ],
    });
    const app = await setupContentApp(db, principal);

    const response = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_1/duplicate',
      payload: {
        key: 'order-confirmed-copy',
        name: 'Order confirmed copy',
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({
      document: {
        tenantId: 'tnt_1',
        organizationId: 'org_1',
        brandId: 'brd_1',
        channel: 'email',
        key: 'order-confirmed-copy',
        name: 'Order confirmed copy',
        status: 'draft',
      },
      versions: [
        {
          documentId: body.document.id,
          versionNumber: 1,
          status: 'draft',
          subject: 'Hi {{recipient.name}}',
        },
      ],
    });
    expect(body.document).not.toHaveProperty('publishedVersionId');
    expect(body.versions[0]).not.toHaveProperty('publishedAt');
    expect(body.document.id).not.toBe('cdoc_1');
    expect(body.versions[0].id).not.toBe('cver_1');
    expect(inserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'order-confirmed-copy',
          status: 'draft',
          published_version_id: null,
        }),
        expect.objectContaining({
          document_id: body.document.id,
          status: 'draft',
          published_at: null,
        }),
      ]),
    );
    expect(updated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ current_draft_version_id: body.versions[0].id }),
      ]),
    );
  });

  it('does not duplicate content documents across tenant boundaries', async () => {
    const { db, inserted } = createContentDb({
      brands: [{ id: 'brd_other', tenant_id: 'tnt_other', organization_id: 'org_other' }],
      content_documents: [
        documentRow({
          id: 'cdoc_other',
          tenant_id: 'tnt_other',
          organization_id: 'org_other',
          brand_id: 'brd_other',
        }),
      ],
      content_document_versions: [versionRow({ document_id: 'cdoc_other' })],
    });
    const app = await setupContentApp(db, principal);

    const response = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_other/duplicate',
      payload: { key: 'stolen-copy' },
    });

    expect(response.statusCode).toBe(404);
    expect(inserted).toHaveLength(0);
  });

  it('saves, previews, and captures canonical SMS template test sends', async () => {
    const smsTransport = new TestCaptureSmsTransport();
    const smsDocument = createDefaultSmsTemplate({
      editor: { body: 'Hi {{recipient.name}}, {{event.title}} starts {{event.startsAt}}.' },
      settings: { templateKey: 'event-update', segmentLimit: 2, estimatedCostPerSegmentCents: 4 },
    });
    const { db, inserted } = createContentDb({
      brands: [{ id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1' }],
      sms_sender_identities: [
        {
          id: 'ssi_content_sms',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          sender: '+15550000001',
          kind: 'phone_number',
          provider_type: 'capture',
          provider_sender_id: 'capture-sender',
          verified: true,
          verified_at: new Date('2026-06-01T00:00:00.000Z'),
          created_at: new Date('2026-06-01T00:00:00.000Z'),
          updated_at: new Date('2026-06-01T00:00:00.000Z'),
        },
      ],
      sms_provider_routes: [
        {
          id: 'spr_content_sms',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
          provider_type: 'capture',
          credentials_ref: 'secret://sms/content-message',
          sender_identity_id: 'ssi_content_sms',
          priority: 0,
          is_fallback: false,
          rate_limit_per_hour: null,
          allowed_categories: JSON.stringify(['bulk']),
          status: 'active',
          smoke_send_verified: true,
          webhook_url: 'https://api.example.test/webhooks/sms',
          created_at: new Date('2026-06-01T00:00:00.000Z'),
          updated_at: new Date('2026-06-01T00:00:00.000Z'),
        },
      ],
      content_documents: [
        documentRow({
          id: 'cdoc_sms',
          channel: 'sms',
          key: 'event-update',
          name: 'Event SMS',
        }),
      ],
      content_document_versions: [],
      content_test_sends: [],
      content_render_artifacts: [],
    });
    const app = await setupContentApp(db, principal, { smsTransport });

    const save = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_sms/versions',
      payload: {
        contentJson: smsDocument,
        renderedText: 'this stored fallback must not win',
      },
    });

    expect(save.statusCode).toBe(201);
    expect(save.json()).toMatchObject({
      documentId: 'cdoc_sms',
      renderedText: smsDocument.editor.body,
      validation: { valid: true },
    });

    const preview = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_sms/preview',
      payload: {
        versionId: save.json().id,
        context: {
          event: { title: 'All Access', startsAt: '2026-07-17 19:00' },
          recipient: { name: 'Ada' },
        },
      },
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      channel: 'sms',
      output: {
        text: 'Hi Ada, All Access starts 2026-07-17 19:00. Reply STOP to opt out',
        segments: 1,
      },
      validation: { valid: true },
      renderArtifact: {
        documentId: 'cdoc_sms',
        versionId: save.json().id,
        channel: 'sms',
        outputType: 'preview',
      },
    });
    expect(preview.json().renderArtifact.checksum).toMatch(/^[a-f0-9]{64}$/);

    const capture = await app.inject({
      method: 'POST',
      url: `/content-documents/cdoc_sms/test-sends`,
      payload: {
        versionId: save.json().id,
        recipient: '+15550000002',
        context: {
          event: { title: 'All Access', startsAt: '2026-07-17 19:00' },
          recipient: { name: 'Ada' },
        },
      },
    });

    expect(capture.statusCode).toBe(202);
    expect(capture.json()).toMatchObject({
      testSend: {
        channel: 'sms',
        recipient: '+15550000002',
        status: 'captured',
        renderedText: 'Hi Ada, All Access starts 2026-07-17 19:00. Reply STOP to opt out',
      },
      output: preview.json().output,
      renderArtifact: {
        documentId: 'cdoc_sms',
        versionId: save.json().id,
        channel: 'sms',
        outputType: 'test_send',
      },
    });
    expect(capture.json().renderArtifact.checksum).toBe(preview.json().renderArtifact.checksum);
    expect(capture.json().renderArtifact.artifactRef).toBe(
      `content-test-send:${capture.json().testSend.id}`,
    );
    expect(smsTransport.sent).toHaveLength(1);
    expect(smsTransport.sent[0]).toMatchObject({
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
      providerRouteId: 'spr_content_sms',
      from: '+15550000001',
      to: '+15550000002',
      body: preview.json().output.text,
      notificationType: 'bulk',
    });
    expect(smsTransport.sent[0]?.jobId).toMatch(/^ctsms_/);
    expect(smsTransport.sent[0]?.deliveryId).toMatch(/^cts_/);
    expect(smsTransport.sent[0]?.idempotencyKey).toBe(
      `content-test-send:cdoc_sms:${save.json().id}:+15550000002`,
    );
    expect(inserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          document_id: 'cdoc_sms',
          rendered_text: smsDocument.editor.body,
        }),
        expect.objectContaining({
          channel: 'sms',
          recipient: '+15550000002',
          status: 'captured',
        }),
        expect.objectContaining({
          document_id: 'cdoc_sms',
          output_type: 'preview',
          checksum: preview.json().renderArtifact.checksum,
        }),
        expect.objectContaining({
          document_id: 'cdoc_sms',
          output_type: 'test_send',
          checksum: capture.json().renderArtifact.checksum,
        }),
      ]),
    );
  });

  it('persists required opt-out segment blockers before SMS publish', async () => {
    const smsDocument = createDefaultSmsTemplate({
      editor: { body: 'A'.repeat(160) },
      settings: {
        templateKey: 'event-update',
        category: 'bulk',
        consentCategory: 'marketing',
        optOutText: 'Reply STOP to opt out',
        segmentLimit: 1,
        estimatedCostPerSegmentCents: 4,
      },
    });
    const { db } = createContentDb({
      brands: [{ id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1' }],
      content_documents: [
        documentRow({
          id: 'cdoc_sms',
          channel: 'sms',
          key: 'event-update',
          name: 'Event SMS',
        }),
      ],
      content_document_versions: [],
    });
    const app = await setupContentApp(db, principal);

    const save = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_sms/versions',
      payload: { contentJson: smsDocument },
    });

    expect(save.statusCode).toBe(201);
    expect(save.json()).toMatchObject({
      documentId: 'cdoc_sms',
      renderedText: smsDocument.editor.body,
      validation: { valid: false },
    });
    expect(save.json().validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'segment_limit_exceeded',
          field: 'renderedText',
        }),
      ]),
    );

    const publish = await app.inject({
      method: 'POST',
      url: `/content-documents/cdoc_sms/versions/${save.json().id}/publish`,
    });

    expect(publish.statusCode).toBe(400);
    expect(publish.json().message ?? publish.json().error?.message).toContain(
      'Content version has publish blockers',
    );
  });

  it('fails closed for unsafe event-page rich-text images before publish', async () => {
    const eventPageDocument = eventPageJson();
    eventPageDocument.editor.data.content.push({
      type: 'Media',
      props: {
        id: 'private-media',
        imageUrl: 'http://127.0.0.1/private-preview.png',
        imageAlt: '',
      },
    });
    const { db } = createContentDb({
      brands: [{ id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1' }],
      content_documents: [
        documentRow({
          id: 'cdoc_event_page',
          channel: 'event_page',
          key: 'main',
          name: 'Main event page',
        }),
      ],
      content_document_versions: [],
      content_render_artifacts: [],
    });
    const app = await setupContentApp(db, principal);

    const save = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_event_page/versions',
      payload: { contentJson: eventPageDocument },
    });

    expect(save.statusCode).toBe(201);
    expect(save.json()).toMatchObject({
      documentId: 'cdoc_event_page',
      contentJson: {
        schemaVersion: 2,
        editor: { provider: '@puckeditor/core' },
      },
      validation: { valid: false },
    });
    expect(save.json().validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unsafe_url' }),
        expect.objectContaining({ code: 'missing_required_text' }),
      ]),
    );

    const preview = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_event_page/preview',
      payload: { versionId: save.json().id },
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      channel: 'event_page',
      output: {
        provider: '@puckeditor/core',
        puckData: { content: expect.any(Array) },
      },
      validation: { valid: false },
    });

    const publish = await app.inject({
      method: 'POST',
      url: `/content-documents/cdoc_event_page/versions/${save.json().id}/publish`,
    });

    expect(publish.statusCode).toBe(400);
    expect(publish.json().message ?? publish.json().error?.message).toContain(
      'Content version has publish blockers',
    );
  });

  it('saves event-page previews as Puck JSON, ignoring caller-supplied renderedHtml', async () => {
    const eventPageDocument = eventPageJson();
    const { db } = createContentDb({
      brands: [{ id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1' }],
      content_documents: [
        documentRow({
          id: 'cdoc_event_page',
          channel: 'event_page',
          key: 'main',
          name: 'Main event page',
        }),
      ],
      content_document_versions: [],
      content_render_artifacts: [],
    });
    const app = await setupContentApp(db, principal);

    const save = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_event_page/versions',
      payload: {
        contentJson: eventPageDocument,
        renderedHtml: '<script>alert(1)</script><p>caller-supplied stale html</p>',
        renderedText: 'caller-supplied stale text',
      },
    });

    expect(save.statusCode).toBe(201);
    expect(save.json().contentJson).toMatchObject({
      schemaVersion: 2,
      editor: {
        provider: '@puckeditor/core',
        data: { content: expect.any(Array) },
      },
    });
    expect(save.json().renderedHtml).toBeUndefined();
    expect(save.json().renderedText).toBeUndefined();
    expect(JSON.stringify(save.json())).not.toContain('caller-supplied stale html');
    expect(JSON.stringify(save.json())).not.toContain('caller-supplied stale text');

    const preview = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_event_page/preview',
      payload: { versionId: save.json().id },
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json().output).toMatchObject({
      provider: '@puckeditor/core',
      puckData: { content: expect.any(Array) },
      settings: { locale: 'en' },
      discovery: { title: 'Published page' },
    });
    expect(JSON.stringify(preview.json())).not.toContain('caller-supplied stale html');
    expect(JSON.stringify(preview.json())).not.toContain('<script>');
  });

  it('migrates legacy event-page blocks to Puck data on save and preview', async () => {
    const eventPageDocument = legacyEventPageJson();
    const { db } = createContentDb({
      brands: [{ id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1' }],
      content_documents: [
        documentRow({
          id: 'cdoc_event_page',
          channel: 'event_page',
          key: 'main',
          name: 'Main event page',
        }),
      ],
      content_document_versions: [],
      content_render_artifacts: [],
    });
    const app = await setupContentApp(db, principal);

    const save = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_event_page/versions',
      payload: { contentJson: eventPageDocument },
    });
    expect(save.statusCode).toBe(201);

    const preview = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_event_page/preview',
      payload: {
        versionId: save.json().id,
        context: { event: { title: 'Published page' } },
      },
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json().output).toMatchObject({
      provider: '@puckeditor/core',
      puckData: {
        content: expect.arrayContaining([
          expect.objectContaining({
            type: 'Hero',
            props: expect.objectContaining({ headline: 'Published page' }),
          }),
        ]),
      },
      discovery: { title: 'Published page' },
    });
    expect(preview.json().validation.valid).toBe(true);
  });

  it('migrates stored legacy event-page versions to Puck JSON', async () => {
    const version = versionRow({
      id: 'cver_legacy_event_page',
      document_id: 'cdoc_event_page',
      content_json: JSON.stringify(legacyEventPageJson()),
      rendered_html: '<main>legacy rendered html</main>',
      rendered_text: 'legacy rendered text',
      validation: JSON.stringify({ valid: true, severity: 'warning', issues: [] }),
    });
    const { db } = createContentDb({
      brands: [{ id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1' }],
      content_documents: [
        documentRow({
          id: 'cdoc_event_page',
          channel: 'event_page',
          key: 'main',
          name: 'Main event page',
        }),
      ],
      content_document_versions: [version],
    });
    const app = await setupContentApp(db, principal);

    const response = await app.inject({
      method: 'POST',
      url: '/content-documents/migrate-event-page-puck',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      documentsScanned: 1,
      versionsChecked: 1,
      versionsMigrated: 1,
      migrated: [
        {
          documentId: 'cdoc_event_page',
          versionId: 'cver_legacy_event_page',
          versionNumber: 1,
        },
      ],
    });
    const migrated = JSON.parse(String(version.content_json));
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      editor: {
        provider: '@puckeditor/core',
        data: { content: expect.any(Array) },
      },
    });
    expect(version.rendered_html).toBeNull();
    expect(version.rendered_text).toBeNull();
    expect(JSON.parse(String(version.validation))).toMatchObject({ valid: true });
  });

  it('fails closed for SMS test sends without an active verified provider route', async () => {
    const smsTransport = new TestCaptureSmsTransport();
    const smsDocument = createDefaultSmsTemplate({
      editor: { body: 'Hi {{recipient.name}}, {{event.title}} starts {{event.startsAt}}.' },
      settings: { templateKey: 'event-update', segmentLimit: 2, estimatedCostPerSegmentCents: 4 },
    });
    const { db, inserted } = createContentDb({
      brands: [{ id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1' }],
      content_documents: [
        documentRow({
          id: 'cdoc_sms',
          channel: 'sms',
          key: 'event-update',
          name: 'Event SMS',
        }),
      ],
      content_document_versions: [
        versionRow({
          id: 'cver_sms',
          document_id: 'cdoc_sms',
          content_json: JSON.stringify(smsDocument),
          rendered_text: smsDocument.editor.body,
          validation: JSON.stringify({ valid: true, severity: 'info', issues: [] }),
        }),
      ],
      content_test_sends: [],
      content_render_artifacts: [],
    });
    const app = await setupContentApp(db, principal, { smsTransport });

    const response = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_sms/test-sends',
      payload: {
        versionId: 'cver_sms',
        recipient: '+15550000002',
        context: {
          event: { title: 'All Access', startsAt: '2026-07-17 19:00' },
          recipient: { name: 'Ada' },
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message ?? response.json().error?.message).toContain(
      'active verified provider route',
    );
    expect(smsTransport.sent).toHaveLength(0);
    expect(inserted).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'sms',
          recipient: '+15550000002',
        }),
      ]),
    );
  });

  it('fails closed for malformed SMS template previews', async () => {
    const { db } = createContentDb({
      brands: [{ id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1' }],
      content_documents: [
        documentRow({
          id: 'cdoc_sms',
          channel: 'sms',
          key: 'event-update',
          name: 'Event SMS',
        }),
      ],
      content_document_versions: [
        versionRow({
          id: 'cver_sms_bad',
          document_id: 'cdoc_sms',
          content_json: JSON.stringify({ editor: { provider: 'legacy', body: 'Hi' } }),
          rendered_text: 'Hi {{recipient.name}}',
          validation: JSON.stringify({ valid: false, severity: 'error', issues: [] }),
        }),
      ],
    });
    const app = await setupContentApp(db, principal);

    const response = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_sms/preview',
      payload: { versionId: 'cver_sms_bad', context: { recipient: { name: 'Ada' } } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message ?? response.json().error?.message).toContain('canonical SMS');
  });

  it('returns a public Puck event page from V2 content JSON without lifecycle fields', async () => {
    const { db } = createContentDb({
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          slug: 'published-page',
          title: 'Published page',
          status: 'published',
          visibility: 'public',
          starts_at: new Date('2026-07-17T19:00:00.000Z'),
          ends_at: null,
          timezone: 'America/Chicago',
          venue: JSON.stringify({ name: 'The Salt Shed', city: 'Chicago' }),
        },
      ],
      ticket_types: [
        {
          id: 'tt_ga',
          event_id: 'evt_1',
          name: 'General Admission',
          description: 'Standing room',
          kind: 'paid',
          status: 'active',
          visibility: 'public',
          currency: 'USD',
          price_cents: 3500,
          minimum_price_cents: null,
        },
        {
          id: 'tt_hidden',
          event_id: 'evt_1',
          name: 'Hidden comp',
          kind: 'free',
          status: 'active',
          visibility: 'hidden',
          currency: 'USD',
          price_cents: 0,
          minimum_price_cents: null,
        },
      ],
      content_documents: [
        documentRow({
          id: 'cdoc_public',
          channel: 'event_page',
          event_id: 'evt_1',
          key: 'main',
          name: 'Main event page',
          status: 'published',
          current_draft_version_id: 'cver_draft',
          published_version_id: 'cver_public',
        }),
      ],
      content_document_versions: [
        versionRow({
          id: 'cver_public',
          document_id: 'cdoc_public',
          version_number: 3,
          status: 'published',
          subject: 'Published page',
          preview_text: 'Preview copy',
          content_json: JSON.stringify(eventPageJson()),
          rendered_html: '<script>alert(1)</script><main>stored html must not render</main>',
          rendered_text: 'stored text must not render',
          variables: JSON.stringify([{ key: 'buyer.name', required: false }]),
          validation: JSON.stringify({ valid: true, severity: 'warning', issues: [] }),
          created_by: 'usr_private',
          published_at: new Date('2026-06-02T00:00:00.000Z'),
        }),
      ],
    });
    const app = await setupPublicContentApp(db);

    const response = await app.inject({
      method: 'GET',
      url: '/public/events/evt_1/content-page',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      document: {
        eventId: 'evt_1',
        channel: 'event_page',
        key: 'main',
        name: 'Main event page',
        locale: 'en',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
      version: {
        versionNumber: 3,
        subject: 'Published page',
        previewText: 'Preview copy',
        publishedAt: '2026-06-02T00:00:00.000Z',
      },
      page: {
        provider: '@puckeditor/core',
        puckData: {
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'Hero',
              props: expect.objectContaining({ headline: 'Published page' }),
            }),
          ]),
        },
        settings: {
          locale: 'en',
        },
        discovery: {
          title: 'Published page',
          summary: 'Preview copy',
        },
      },
    });
    expect(response.json().version).not.toHaveProperty('renderedHtml');
    expect(response.json().version).not.toHaveProperty('renderedText');
    expect(JSON.stringify(response.json())).not.toContain('stored html must not render');
    expect(JSON.stringify(response.json())).not.toContain('<script>');
    expect(JSON.stringify(response.json())).not.toContain('tnt_1');
    expect(JSON.stringify(response.json())).not.toContain('org_1');
    expect(JSON.stringify(response.json())).not.toContain('brd_1');
    expect(JSON.stringify(response.json())).not.toContain('cdoc_public');
    expect(JSON.stringify(response.json())).not.toContain('cver_public');
    expect(JSON.stringify(response.json())).not.toContain('cver_draft');
    expect(JSON.stringify(response.json())).not.toContain('privateEditorState');
    expect(JSON.stringify(response.json())).not.toContain('buyer.name');
    expect(JSON.stringify(response.json())).not.toContain('usr_private');
  });

  it('keeps public Puck event-page route latency bounded under concurrent load', async () => {
    const { db } = createContentDb({
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          slug: 'published-page',
          title: 'Published page',
          status: 'published',
          visibility: 'public',
          starts_at: new Date('2026-07-17T19:00:00.000Z'),
          ends_at: null,
          timezone: 'America/Chicago',
          venue: JSON.stringify({ name: 'The Salt Shed', city: 'Chicago' }),
        },
      ],
      ticket_types: [
        {
          id: 'tt_ga',
          event_id: 'evt_1',
          name: 'General Admission',
          description: 'Standing room',
          kind: 'paid',
          status: 'active',
          visibility: 'public',
          currency: 'USD',
          price_cents: 3500,
          minimum_price_cents: null,
        },
        {
          id: 'tt_vip',
          event_id: 'evt_1',
          name: 'VIP',
          description: 'Balcony',
          kind: 'paid',
          status: 'sold_out',
          visibility: 'public',
          currency: 'USD',
          price_cents: 7500,
          minimum_price_cents: null,
        },
        {
          id: 'tt_hidden',
          event_id: 'evt_1',
          name: 'Hidden comp',
          description: 'Internal hold',
          kind: 'free',
          status: 'active',
          visibility: 'hidden',
          currency: 'USD',
          price_cents: 0,
          minimum_price_cents: null,
        },
      ],
      content_documents: [
        documentRow({
          id: 'cdoc_public',
          channel: 'event_page',
          event_id: 'evt_1',
          key: 'main',
          name: 'Main event page',
          status: 'published',
          published_version_id: 'cver_public',
        }),
      ],
      content_document_versions: [
        versionRow({
          id: 'cver_public',
          document_id: 'cdoc_public',
          version_number: 3,
          status: 'published',
          subject: 'Published page',
          preview_text: 'Preview copy',
          content_json: JSON.stringify(eventPageJson()),
          rendered_html: '<main>stored html must not render</main>',
          rendered_text: 'stored text must not render',
          variables: JSON.stringify([]),
          validation: JSON.stringify({ valid: true, severity: 'warning', issues: [] }),
          created_by: 'usr_private',
          published_at: new Date('2026-06-02T00:00:00.000Z'),
        }),
      ],
    });
    const app = await setupPublicContentApp(db);
    const requestCount = 100;

    const responses = await Promise.all(
      Array.from({ length: requestCount }, async (_, index) => {
        const startedAt = performance.now();
        const response = await app.inject({
          method: 'GET',
          url: `/public/events/evt_1/page?locale=en&request=${index}`,
        });
        return { response, durationMs: performance.now() - startedAt };
      }),
    );
    const maxDurationMs = responses.reduce(
      (currentMax, { durationMs }) => Math.max(currentMax, durationMs),
      0,
    );

    expect(responses).toHaveLength(requestCount);
    expect(responses.every(({ response }) => response.statusCode === 200)).toBe(true);
    expect(maxDurationMs).toBeLessThan(2_000);
    for (const { response } of responses) {
      const payload = response.json();
      expect(payload.page.provider).toBe('@puckeditor/core');
      expect(
        payload.page.puckData.content.map((component: { type: string }) => component.type),
      ).toEqual(['Hero', 'EventDetails', 'Schedule', 'Venue', 'FAQ']);
      expect(payload.page.puckData.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'Hero',
            props: expect.objectContaining({ headline: 'Published page' }),
          }),
        ]),
      );
      expect(payload.version).not.toHaveProperty('renderedHtml');
      expect(JSON.stringify(payload)).not.toContain('tnt_1');
      expect(JSON.stringify(payload)).not.toContain('stored html must not render');
    }
  });

  it('repairs published legacy event-page documents during public load', async () => {
    const legacyContent = {
      settings: {
        locale: 'en',
        publicPath: '/e/legacy-public-page',
        discovery: { summary: 'Legacy public copy.', tags: ['legacy'] },
      },
      blocks: [
        {
          id: 'hero-legacy',
          type: 'hero',
          headline: 'Legacy public page',
          body: 'Legacy page copy.',
        },
        { id: 'tickets-legacy', type: 'tickets', title: 'Tickets' },
      ],
    };
    const { db } = createContentDb({
      events: [
        {
          id: 'evt_legacy_public',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          slug: 'legacy-public-page',
          title: 'Legacy public fallback title',
          description: 'Fallback copy from the event.',
          status: 'published',
          visibility: 'public',
          starts_at: new Date('2026-07-17T19:00:00.000Z'),
          ends_at: null,
          timezone: 'America/Chicago',
          venue: JSON.stringify({ name: 'The Salt Shed', city: 'Chicago' }),
        },
      ],
      ticket_types: [],
      content_documents: [
        documentRow({
          id: 'cdoc_legacy_public',
          channel: 'event_page',
          event_id: 'evt_legacy_public',
          key: 'main',
          name: 'Legacy public event page',
          status: 'published',
          published_version_id: 'cver_legacy_public',
        }),
      ],
      content_document_versions: [
        versionRow({
          id: 'cver_legacy_public',
          document_id: 'cdoc_legacy_public',
          version_number: 1,
          status: 'published',
          schema_version: 1,
          subject: 'Legacy public page',
          preview_text: 'Legacy public copy.',
          content_json: JSON.stringify(legacyContent),
          validation: JSON.stringify({ valid: true, severity: 'warning', issues: [] }),
          published_at: new Date('2026-06-02T00:00:00.000Z'),
        }),
      ],
    });
    const app = await setupPublicContentApp(db);

    const response = await app.inject({
      method: 'GET',
      url: '/public/events/evt_legacy_public/page',
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.page.provider).toBe('@puckeditor/core');
    expect(payload.page.puckData.content).toEqual([
      expect.objectContaining({
        type: 'Hero',
        props: expect.objectContaining({
          id: 'hero-legacy',
          headline: 'Legacy public page',
          body: 'Legacy page copy.',
        }),
      }),
    ]);
    expect(payload.page.puckData.root.props).toEqual(
      expect.objectContaining({
        title: 'Legacy public fallback title',
        description: 'Fallback copy from the event.',
      }),
    );

    const repaired = await db
      .selectFrom('content_document_versions')
      .select(['schema_version', 'content_json', 'rendered_html', 'rendered_text'])
      .where('id', '=', 'cver_legacy_public')
      .executeTakeFirstOrThrow();
    expect(repaired.schema_version).toBe(2);
    expect(repaired.rendered_html).toBeNull();
    expect(repaired.rendered_text).toBeNull();
    expect(JSON.parse(repaired.content_json)).toMatchObject({
      schemaVersion: 2,
      editor: {
        provider: '@puckeditor/core',
        data: {
          content: [
            expect.objectContaining({
              type: 'Hero',
              props: expect.objectContaining({ headline: 'Legacy public page' }),
            }),
          ],
        },
      },
    });
    await app.close();
  });

  it('caches public Puck event pages by event public revision', async () => {
    const event = {
      id: 'evt_render_cache',
      tenant_id: 'tnt_1',
      organization_id: 'org_1',
      brand_id: 'brd_1',
      slug: 'render-cache',
      title: 'Render cache',
      status: 'published',
      visibility: 'public',
      starts_at: new Date('2026-07-17T19:00:00.000Z'),
      ends_at: null,
      timezone: 'America/Chicago',
      venue: null,
      public_revision: new Date('2026-06-01T00:00:00.000Z'),
    };
    const pageDocument = eventPageJson({
      eventId: 'evt_render_cache',
      eventTitle: 'Original headline',
      eventDescription: 'Preview copy',
    });
    const version = versionRow({
      id: 'cver_render_cache',
      document_id: 'cdoc_render_cache',
      version_number: 3,
      status: 'published',
      subject: 'Render cache',
      preview_text: 'Preview copy',
      content_json: JSON.stringify(pageDocument),
      rendered_html: '<main>stored html must not render</main>',
      rendered_text: 'stored text must not render',
      variables: JSON.stringify([]),
      validation: JSON.stringify({ valid: true, severity: 'warning', issues: [] }),
      created_by: 'usr_private',
      published_at: new Date('2026-06-02T00:00:00.000Z'),
    });
    const { db } = createContentDb({
      events: [event],
      ticket_types: [],
      content_documents: [
        documentRow({
          id: 'cdoc_render_cache',
          channel: 'event_page',
          event_id: 'evt_render_cache',
          key: 'main',
          name: 'Main event page',
          status: 'published',
          published_version_id: 'cver_render_cache',
        }),
      ],
      content_document_versions: [version],
    });
    const app = await setupPublicContentApp(db);

    const first = await app.inject({
      method: 'GET',
      url: '/public/events/evt_render_cache/page',
    });
    const updatedPageDocument = eventPageJson({
      eventId: 'evt_render_cache',
      eventTitle: 'Updated headline',
      eventDescription: 'Preview copy',
    });
    version.content_json = JSON.stringify(updatedPageDocument);
    const second = await app.inject({
      method: 'GET',
      url: '/public/events/evt_render_cache/page',
    });
    event.public_revision = new Date('2026-06-01T00:00:01.000Z');
    const third = await app.inject({
      method: 'GET',
      url: '/public/events/evt_render_cache/page',
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(200);
    expect(
      first
        .json()
        .page.puckData.content.find((component: { type: string }) => component.type === 'Hero')
        .props.headline,
    ).toBe('Original headline');
    expect(
      second
        .json()
        .page.puckData.content.find((component: { type: string }) => component.type === 'Hero')
        .props.headline,
    ).toBe('Original headline');
    expect(
      third
        .json()
        .page.puckData.content.find((component: { type: string }) => component.type === 'Hero')
        .props.headline,
    ).toBe('Updated headline');
    await app.close();
  });

  it('returns event-page bootstrap data in one public response', async () => {
    const getAvailabilityBatch = vi.fn(async (poolIds: readonly string[]) => {
      expect(poolIds).toEqual(['inv_ga']);
      return new Map([['inv_ga', { total: 20, sold: 5, reserved: 4, available: 11 }]]);
    });
    const getOccurrenceAvailabilityBatch = vi.fn(async (occurrenceIds: readonly string[]) => {
      expect(occurrenceIds).toEqual([]);
      return new Map<string, unknown>();
    });
    const { db } = createContentDb({
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          slug: 'published-page',
          title: 'Published page',
          description: 'Preview copy',
          status: 'published',
          visibility: 'public',
          timezone: 'America/Chicago',
          starts_at: '2026-07-17T19:00:00.000Z',
          ends_at: null,
          venue: null,
          resale_enabled: false,
        },
      ],
      ticket_types: [
        {
          id: 'tt_ga',
          event_id: 'evt_1',
          event_occurrence_id: null,
          name: 'General Admission',
          description: null,
          kind: 'paid',
          status: 'active',
          visibility: 'public',
          currency: 'USD',
          price_cents: 3500,
          minimum_price_cents: null,
          sales_start_at: null,
          sales_end_at: null,
          min_per_order: 1,
          max_per_order: 4,
          inventory_pool_id: 'inv_ga',
          requires_access_code: false,
          access_code_hint: null,
        },
      ],
      products: [],
      marketing_integrations: [],
      content_documents: [
        documentRow({
          id: 'cdoc_public',
          channel: 'event_page',
          event_id: 'evt_1',
          key: 'main',
          name: 'Main event page',
          status: 'published',
          published_version_id: 'cver_public',
        }),
      ],
      content_document_versions: [
        versionRow({
          id: 'cver_public',
          document_id: 'cdoc_public',
          version_number: 1,
          status: 'published',
          content_json: JSON.stringify(eventPageJson()),
          validation: JSON.stringify({ valid: true, severity: 'warning', issues: [] }),
          published_at: new Date('2026-06-02T00:00:00.000Z'),
        }),
      ],
    });
    const app = await setupPublicContentApp(db, {
      inventoryService: {
        getAvailabilityBatch,
        getOccurrenceAvailabilityBatch,
      },
    } as unknown as Partial<AppContext>);

    const response = await app.inject({
      method: 'GET',
      url: '/public/events/evt_1/page-bootstrap',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      event: { id: 'evt_1', title: 'Published page' },
      availability: [{ ticketTypeId: 'tt_ga', available: 11, status: 'active' }],
      contentPage: {
        document: { eventId: 'evt_1', channel: 'event_page' },
        page: {
          provider: '@puckeditor/core',
          puckData: {
            content: expect.arrayContaining([
              expect.objectContaining({
                type: 'Hero',
                props: expect.objectContaining({ headline: 'Published page' }),
              }),
            ]),
          },
        },
      },
      resaleListings: { items: [], nextCursor: null, hasMore: false },
    });
    await app.close();
  });

  it('fails closed for private events and stale published event-page versions', async () => {
    const { db } = createContentDb({
      events: [
        {
          id: 'evt_private',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          slug: 'private-page',
          title: 'Private page',
          status: 'published',
          visibility: 'private',
          starts_at: new Date('2026-07-17T19:00:00.000Z'),
          timezone: 'America/Chicago',
        },
        {
          id: 'evt_stale',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          slug: 'stale-page',
          title: 'Stale page',
          status: 'published',
          visibility: 'public',
          starts_at: new Date('2026-07-17T19:00:00.000Z'),
          timezone: 'America/Chicago',
        },
      ],
      ticket_types: [],
      content_documents: [
        documentRow({
          id: 'cdoc_private',
          channel: 'event_page',
          event_id: 'evt_private',
          key: 'main',
          status: 'published',
          published_version_id: 'cver_private',
        }),
        documentRow({
          id: 'cdoc_stale',
          channel: 'event_page',
          event_id: 'evt_stale',
          key: 'main',
          status: 'published',
          published_version_id: 'cver_stale',
        }),
      ],
      content_document_versions: [
        versionRow({
          id: 'cver_private',
          document_id: 'cdoc_private',
          status: 'published',
          content_json: JSON.stringify(
            eventPageJson({
              eventId: 'evt_private',
              eventTitle: 'Private page',
              eventDescription: 'Private draft must not leak',
            }),
          ),
          rendered_html: '<main>private draft must not leak</main>',
          rendered_text: 'private draft must not leak',
          validation: JSON.stringify({ valid: true, severity: 'warning', issues: [] }),
          published_at: new Date('2026-06-02T00:00:00.000Z'),
        }),
        versionRow({
          id: 'cver_stale',
          document_id: 'cdoc_stale',
          status: 'draft',
          content_json: JSON.stringify(
            eventPageJson({
              eventId: 'evt_stale',
              eventTitle: 'Stale page',
              eventDescription: 'Stale draft must not leak',
            }),
          ),
          rendered_html: '<main>stale draft must not leak</main>',
          rendered_text: 'stale draft must not leak',
          validation: JSON.stringify({ valid: true, severity: 'warning', issues: [] }),
          published_at: null,
        }),
      ],
    });
    const app = await setupPublicContentApp(db);

    const privateResponse = await app.inject({
      method: 'GET',
      url: '/public/events/evt_private/page',
    });
    const staleResponse = await app.inject({
      method: 'GET',
      url: '/public/events/evt_stale/page',
    });

    expect(privateResponse.statusCode).toBe(404);
    expect(JSON.stringify(privateResponse.json()).toLowerCase()).not.toContain('private draft');
    expect(staleResponse.statusCode).toBe(404);
    expect(JSON.stringify(staleResponse.json()).toLowerCase()).not.toContain('stale draft');
  });

  it('serves event pages by verified custom-domain slug and returns structured discovery cards', async () => {
    const { db } = createContentDb({
      tenants: [{ id: 'tnt_1', plan: 'pro' }],
      brand_domains: [
        {
          id: 'bd_1',
          brand_id: 'brd_1',
          domain: 'events.example.com',
          is_verified: true,
          ssl_status: 'active',
        },
      ],
      brands: [{ id: 'brd_1', white_label: true }],
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          slug: 'published-page',
          title: 'Published page',
          status: 'published',
          visibility: 'public',
          starts_at: new Date('2026-07-17T19:00:00.000Z'),
          ends_at: null,
          timezone: 'America/Chicago',
          venue: JSON.stringify({ name: 'The Salt Shed', city: 'Chicago' }),
        },
      ],
      ticket_types: [],
      content_documents: [
        documentRow({
          id: 'cdoc_public',
          channel: 'event_page',
          event_id: 'evt_1',
          key: 'main',
          name: 'Main event page',
          status: 'published',
          published_version_id: 'cver_public',
        }),
      ],
      content_document_versions: [
        versionRow({
          id: 'cver_public',
          document_id: 'cdoc_public',
          version_number: 1,
          status: 'published',
          content_json: JSON.stringify(
            eventPageJson({
              eventId: 'evt_1',
              eventTitle: 'Published page',
              eventDescription: 'Preview copy',
              startsAt: '2026-07-17T19:00:00.000Z',
              timezone: 'America/Chicago',
              venue: { name: 'The Salt Shed', city: 'Chicago' },
            }),
          ),
          validation: JSON.stringify({ valid: true, severity: 'warning', issues: [] }),
          published_at: new Date('2026-06-02T00:00:00.000Z'),
        }),
      ],
    });
    const app = await setupPublicContentApp(db);

    const page = await app.inject({
      method: 'GET',
      url: '/public/events/by-slug/published-page/page?host=events.example.com',
    });
    const card = await app.inject({
      method: 'GET',
      url: '/public/events/evt_1/discovery-card',
    });

    expect(page.statusCode).toBe(200);
    expect(page.json().document.eventId).toBe('evt_1');
    expect(page.json().page.provider).toBe('@puckeditor/core');
    expect(page.json().page.discovery.publicPath).toBe('https://events.example.com/published-page');
    expect(card.statusCode).toBe(200);
    expect(card.json()).toMatchObject({
      title: 'Published page',
      summary: 'Preview copy',
      startsAt: '2026-07-17T19:00:00.000Z',
      venueName: 'The Salt Shed',
    });
  });

  it('rejects custom-domain event pages when domain, brand, or tenant gates are not production-ready', async () => {
    const { db } = createContentDb({
      tenants: [
        { id: 'tnt_pro', plan: 'pro' },
        { id: 'tnt_free', plan: 'free' },
      ],
      brand_domains: [
        {
          id: 'bd_pending',
          brand_id: 'brd_verified',
          domain: 'pending.example.com',
          is_verified: false,
          ssl_status: 'pending',
        },
        {
          id: 'bd_plain',
          brand_id: 'brd_plain',
          domain: 'plain.example.com',
          is_verified: true,
          ssl_status: 'active',
        },
        {
          id: 'bd_free',
          brand_id: 'brd_free',
          domain: 'free.example.com',
          is_verified: true,
          ssl_status: 'active',
        },
      ],
      brands: [
        { id: 'brd_verified', white_label: true },
        { id: 'brd_plain', white_label: false },
        { id: 'brd_free', white_label: true },
      ],
      events: [
        {
          id: 'evt_pending',
          tenant_id: 'tnt_pro',
          organization_id: 'org_1',
          brand_id: 'brd_verified',
          slug: 'published-page',
          title: 'Pending domain',
          status: 'published',
          visibility: 'public',
        },
        {
          id: 'evt_plain',
          tenant_id: 'tnt_pro',
          organization_id: 'org_1',
          brand_id: 'brd_plain',
          slug: 'published-page',
          title: 'Plain brand',
          status: 'published',
          visibility: 'public',
        },
        {
          id: 'evt_free',
          tenant_id: 'tnt_free',
          organization_id: 'org_1',
          brand_id: 'brd_free',
          slug: 'published-page',
          title: 'Free tenant',
          status: 'published',
          visibility: 'public',
        },
      ],
      ticket_types: [],
      content_documents: [],
      content_document_versions: [],
    });
    const app = await setupPublicContentApp(db);

    const responses = await Promise.all(
      ['pending.example.com', 'plain.example.com', 'free.example.com'].map((host) =>
        app.inject({
          method: 'GET',
          url: `/public/events/by-slug/published-page/page?host=${host}`,
        }),
      ),
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(JSON.stringify(response.json())).not.toContain('tnt_');
      expect(JSON.stringify(response.json())).not.toContain('brd_');
    }
  });

  it('rejects published event-page records that are not Puck event-page JSON', async () => {
    const { db } = createContentDb({
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          title: 'Published page',
          status: 'published',
          visibility: 'public',
        },
      ],
      content_documents: [
        documentRow({
          id: 'cdoc_public',
          channel: 'event_page',
          event_id: 'evt_1',
          status: 'published',
          published_version_id: 'cver_public',
        }),
      ],
      content_document_versions: [
        versionRow({
          id: 'cver_public',
          document_id: 'cdoc_public',
          status: 'published',
          content_json: JSON.stringify({ privateEditorState: true }),
          validation: JSON.stringify({ valid: true, severity: 'warning', issues: [] }),
          published_at: new Date('2026-06-02T00:00:00.000Z'),
        }),
      ],
    });
    const app = await setupPublicContentApp(db);

    const response = await app.inject({ method: 'GET', url: '/public/events/evt_1/page' });

    expect(response.statusCode).toBe(400);
    expect(response.json().message ?? response.json().error?.message).toContain(
      'valid Puck event-page document',
    );
  });
});
