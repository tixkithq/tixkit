import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tixkit/domain';
import type { Database } from '@tixkit/db';
import { createDefaultEventPageDocument } from '@tixkit/content-event-page';
import { createDefaultSmsTemplate } from '@tixkit/content-message';
import type { AppContext } from '../app.js';
import { contentRoutes, publicContentRoutes } from '../routes/modules/content.js';

function valueFor(row: Record<string, unknown>, column: string) {
  return row[column] ?? row[column.split('.').at(-1) ?? column];
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
                conditions.every(([column, comparison]) => valueFor(candidate, column) === comparison),
              );
              if (!row) throw new Error(`No row to update for ${table}`);
              Object.assign(row, value);
              updated.push(value);
              return row;
            },
          }),
          execute: async () => {
            for (const row of rows(table)) {
              if (conditions.every(([column, comparison]) => valueFor(row, column) === comparison)) {
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
    content_json: JSON.stringify({ blocks: [] }),
    rendered_html: '<p>Hi {{recipient.name}}</p>',
    rendered_text: 'Hi {{recipient.name}}',
    variables: JSON.stringify([]),
    validation: JSON.stringify({ valid: true, severity: 'warning', issues: [] }),
    created_by: 'usr_1',
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    published_at: null,
    ...overrides,
  };
}

function eventPageJson(overrides: Parameters<typeof createDefaultEventPageDocument>[0] = {
  eventId: 'evt_1',
  eventTitle: 'Published page',
  eventDescription: 'Preview copy',
  startsAt: '2026-07-17T19:00:00.000Z',
  timezone: 'America/Chicago',
  venue: { name: 'The Salt Shed', city: 'Chicago' },
  checkoutUrl: 'https://checkout.tixkit.com/checkout?eventId=evt_1',
}) {
  return createDefaultEventPageDocument(overrides);
}

async function setupContentApp(db: Database, principal: Principal) {
  const app = Fastify();
  app.decorate('context', {
    db,
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService: {},
    temporalClient: {},
  } as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = principal;
  });
  await app.register(contentRoutes);
  return app;
}

async function setupPublicContentApp(db: Database) {
  const app = Fastify();
  app.decorate('context', {
    db,
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService: {},
    temporalClient: {},
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

  it('renders previews through the shared content renderer', async () => {
    const { db } = createContentDb({
      brands: [{ id: 'brd_1', tenant_id: 'tnt_1', organization_id: 'org_1' }],
      content_documents: [documentRow()],
      content_document_versions: [versionRow()],
    });
    const app = await setupContentApp(db, principal);

    const response = await app.inject({
      method: 'POST',
      url: '/content-documents/cdoc_1/preview',
      payload: {
        versionId: 'cver_1',
        context: { recipient: { name: 'Ada' } },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      channel: 'email',
      output: {
        subject: 'Hi Ada',
        html: '<p>Hi Ada</p>',
        text: 'Hi Ada',
      },
      validation: { valid: true },
    });
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
      content_document_versions: [],
      content_test_sends: [],
    });
    const app = await setupContentApp(db, principal);

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
    });

    const capture = await app.inject({
      method: 'POST',
      url: `/content-documents/cdoc_sms/test-sends`,
      payload: {
        versionId: save.json().id,
        recipient: '+15550000001',
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
        recipient: '+15550000001',
        status: 'captured',
        renderedText: 'Hi Ada, All Access starts 2026-07-17 19:00. Reply STOP to opt out',
      },
    });
    expect(inserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ document_id: 'cdoc_sms', rendered_text: smsDocument.editor.body }),
        expect.objectContaining({
          channel: 'sms',
          recipient: '+15550000001',
          status: 'captured',
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

  it('returns a rendered public event page from canonical content JSON without lifecycle fields', async () => {
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
        discovery: {
          title: 'Published page',
          summary: 'Preview copy',
        },
      },
    });
    expect(response.json().version.renderedHtml).toContain('class="tixkit-event-page"');
    expect(response.json().version.renderedHtml).toContain('General Admission');
    expect(response.json().version.renderedHtml).not.toContain('Hidden comp');
    expect(response.json().version.renderedHtml).not.toContain('stored html must not render');
    expect(response.json().version.renderedHtml).not.toContain('<script>');
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
              publicUrl: '{{event.publicUrl}}',
              checkoutUrl: '{{event.checkoutUrl}}',
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
    expect(page.json().version.renderedHtml).toContain(
      'href="https://events.example.com/checkout?eventId=evt_1"',
    );
    expect(page.json().page.discovery.publicPath).toBe('https://events.example.com/published-page');
    expect(card.statusCode).toBe(200);
    expect(card.json()).toMatchObject({
      title: 'Published page',
      summary: 'Preview copy',
      startsAt: '2026-07-17T19:00:00.000Z',
      venueName: 'The Salt Shed',
    });
  });

  it('rejects published event-page records that are not canonical event-page JSON', async () => {
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
      'valid event-page document',
    );
  });
});
