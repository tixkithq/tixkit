import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tixkit/domain';
import type { Database } from '@tixkit/db';
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

  return {
    inserted,
    updated,
    db: { selectFrom, insertInto, updateTable } as unknown as Database,
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

  it('returns an allowlisted public event content page without internal lifecycle fields', async () => {
    const { db } = createContentDb({
      events: [
        {
          id: 'evt_1',
          tenant_id: 'tnt_1',
          organization_id: 'org_1',
          brand_id: 'brd_1',
          status: 'published',
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
          content_json: JSON.stringify({ privateEditorState: true }),
          rendered_html: '<main>Published page</main>',
          rendered_text: 'Published page',
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
    expect(response.json()).toEqual({
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
        renderedHtml: '<main>Published page</main>',
        renderedText: 'Published page',
        publishedAt: '2026-06-02T00:00:00.000Z',
      },
    });
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
});
