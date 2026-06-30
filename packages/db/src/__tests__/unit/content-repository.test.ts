import { describe, expect, it } from 'vitest';
import type { Database } from '../../client.js';
import { ContentRepository } from '../../repositories/content.js';

function createSelectDb() {
  const whereCalls: Array<[string, string, unknown]> = [];
  const query = {
    selectAll() {
      return query;
    },
    where(column: string, op: string, value: unknown) {
      whereCalls.push([column, op, value]);
      return query;
    },
    orderBy() {
      return query;
    },
    limit() {
      return query;
    },
    execute() {
      return Promise.resolve([]);
    },
  };

  return {
    whereCalls,
    db: {
      selectFrom(table: string) {
        expect(table).toBe('content_documents');
        return query;
      },
    } as unknown as Database,
  };
}

type Row = Record<string, unknown>;
type WhereCall = [string, string, unknown?];

function rowMatchesWhereCalls(row: Row, calls: WhereCall[]) {
  return calls.every(([column, op, value]) => {
    if (op === '=') return row[column] === value;
    if (op === 'is') return value === null ? row[column] === null : row[column] === value;
    if (op === 'is not') return value === null ? row[column] !== null : row[column] !== value;
    return false;
  });
}

function createContentLookupDb(input: { documents: Row[]; versions: Row[] }) {
  const whereCalls: Record<string, WhereCall[]> = {
    content_documents: [],
    content_document_versions: [],
  };

  return {
    whereCalls,
    db: {
      selectFrom(table: 'content_documents' | 'content_document_versions') {
        const calls: WhereCall[] = [];
        const rows = table === 'content_documents' ? input.documents : input.versions;
        const query = {
          selectAll() {
            return query;
          },
          where(column: string, op: string, value?: unknown) {
            calls.push([column, op, value]);
            whereCalls[table].push([column, op, value]);
            return query;
          },
          orderBy() {
            return query;
          },
          executeTakeFirst() {
            return Promise.resolve(rows.find((row) => rowMatchesWhereCalls(row, calls)));
          },
        };
        return query;
      },
    } as unknown as Database,
  };
}

function createContentMutationDb(input: {
  documents: Row[];
  versions: Row[];
  renderArtifacts?: Row[];
  testSends?: Row[];
}) {
  const inserted: Record<string, Row[]> = {
    content_documents: [],
    content_document_versions: [],
    content_render_artifacts: [],
    content_test_sends: [],
  };
  const updated: Record<string, Row[]> = {
    content_documents: [],
    content_document_versions: [],
    content_render_artifacts: [],
    content_test_sends: [],
  };

  function rows(table: string) {
    if (table === 'content_documents') return input.documents;
    if (table === 'content_document_versions') return input.versions;
    if (table === 'content_render_artifacts') return input.renderArtifacts ?? [];
    if (table === 'content_test_sends') return input.testSends ?? [];
    return [];
  }

  const db = {
    selectFrom(table: string) {
      const calls: WhereCall[] = [];
      const query = {
        select() {
          return query;
        },
        selectAll() {
          return query;
        },
        where(column: string, op: string, value?: unknown) {
          calls.push([column, op, value]);
          return query;
        },
        orderBy() {
          return query;
        },
        limit() {
          return query;
        },
        execute() {
          return Promise.resolve(rows(table).filter((row) => rowMatchesWhereCalls(row, calls)));
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
    },
    insertInto(
      table:
        | 'content_documents'
        | 'content_document_versions'
        | 'content_render_artifacts'
        | 'content_test_sends',
    ) {
      return {
        values(value: Row) {
          const row = { ...value };
          return {
            returningAll: () => ({
              executeTakeFirstOrThrow: async () => {
                rows(table).push(row);
                inserted[table].push(row);
                return row;
              },
            }),
            execute: async () => {
              rows(table).push(row);
              inserted[table].push(row);
            },
          };
        },
      };
    },
    updateTable(
      table:
        | 'content_documents'
        | 'content_document_versions'
        | 'content_render_artifacts'
        | 'content_test_sends',
    ) {
      return {
        set(value: Row) {
          const calls: WhereCall[] = [];
          const query = {
            where(column: string, op: string, comparison?: unknown) {
              calls.push([column, op, comparison]);
              return query;
            },
            execute: async () => {
              for (const row of rows(table)) {
                if (rowMatchesWhereCalls(row, calls)) {
                  Object.assign(row, value);
                  updated[table].push(value);
                }
              }
            },
          };
          return query;
        },
      };
    },
    transaction() {
      return {
        execute(callback: (trx: Database) => Promise<unknown>) {
          return callback(db as unknown as Database);
        },
      };
    },
  } as unknown as Database;

  return { db, inserted, updated };
}

const publishedDocument = (overrides: Row = {}): Row => ({
  id: 'cdoc_brand',
  tenant_id: 'tnt_1',
  organization_id: 'org_1',
  brand_id: 'brd_1',
  event_id: null,
  channel: 'email',
  key: 'event-update',
  name: 'Event update',
  status: 'published',
  locale: 'en',
  current_draft_version_id: null,
  published_version_id: 'cver_brand',
  created_at: new Date('2026-06-01T00:00:00.000Z'),
  updated_at: new Date('2026-06-01T00:00:00.000Z'),
  ...overrides,
});

const publishedVersion = (overrides: Row = {}): Row => ({
  id: 'cver_brand',
  document_id: 'cdoc_brand',
  version_number: 1,
  status: 'published',
  schema_version: 1,
  subject: 'Update',
  preview_text: null,
  content_json: '{}',
  rendered_html: '<p>Update</p>',
  rendered_text: 'Update',
  variables: '[]',
  validation: '{"valid":true,"severity":"warning","issues":[]}',
  created_by: 'usr_1',
  created_at: new Date('2026-06-01T00:00:00.000Z'),
  published_at: new Date('2026-06-01T00:00:00.000Z'),
  ...overrides,
});

describe('ContentRepository', () => {
  it('applies tenant, scope, and channel filters when listing documents', async () => {
    const { db, whereCalls } = createSelectDb();

    await new ContentRepository(db).listDocuments({
      tenantId: 'tnt_1',
      organizationIds: ['org_1'],
      brandIds: ['brd_1'],
      eventIds: ['evt_1'],
      brandId: 'brd_1',
      eventId: 'evt_1',
      channel: 'email',
    });

    expect(whereCalls).toEqual([
      ['tenant_id', '=', 'tnt_1'],
      ['organization_id', 'in', ['org_1']],
      ['brand_id', 'in', ['brd_1']],
      ['event_id', 'in', ['evt_1']],
      ['channel', '=', 'email'],
      ['brand_id', '=', 'brd_1'],
      ['event_id', '=', 'evt_1'],
    ]);
  });

  it('duplicates documents as fresh draft versions without carrying published state', async () => {
    const { db, inserted, updated } = createContentMutationDb({
      documents: [
        publishedDocument({
          current_draft_version_id: null,
          published_version_id: 'cver_brand',
        }),
      ],
      versions: [
        publishedVersion({
          status: 'published',
          published_at: new Date('2026-06-02T00:00:00.000Z'),
        }),
      ],
    });

    const result = await new ContentRepository(db).duplicateDocument({
      documentId: 'cdoc_brand',
      tenantId: 'tnt_1',
      key: 'event-update-copy',
      name: 'Event update copy',
      createdBy: 'usr_copy',
    });

    expect(result.document).toMatchObject({
      key: 'event-update-copy',
      name: 'Event update copy',
      status: 'draft',
      publishedVersionId: undefined,
    });
    expect(result.document.id).not.toBe('cdoc_brand');
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0]).toMatchObject({
      documentId: result.document.id,
      status: 'draft',
      versionNumber: 1,
      createdBy: 'usr_copy',
      publishedAt: undefined,
    });
    expect(result.versions[0]?.id).not.toBe('cver_brand');
    expect(inserted.content_documents).toEqual([
      expect.objectContaining({
        key: 'event-update-copy',
        status: 'draft',
        published_version_id: null,
      }),
    ]);
    expect(inserted.content_document_versions).toEqual([
      expect.objectContaining({
        document_id: result.document.id,
        status: 'draft',
        published_at: null,
      }),
    ]);
    expect(updated.content_documents).toEqual([
      expect.objectContaining({ current_draft_version_id: result.versions[0]?.id }),
    ]);
  });

  it('refuses to duplicate documents outside the requested tenant', async () => {
    const { db, inserted } = createContentMutationDb({
      documents: [publishedDocument({ tenant_id: 'tnt_other' })],
      versions: [publishedVersion()],
    });

    await expect(
      new ContentRepository(db).duplicateDocument({
        documentId: 'cdoc_brand',
        tenantId: 'tnt_1',
        key: 'event-update-copy',
        name: 'Event update copy',
        createdBy: 'usr_copy',
      }),
    ).rejects.toThrow('Content document not found: cdoc_brand');
    expect(inserted.content_documents).toHaveLength(0);
    expect(inserted.content_document_versions).toHaveLength(0);
  });

  it('records render artifact references with deterministic output metadata', async () => {
    const { db, inserted } = createContentMutationDb({
      documents: [],
      versions: [],
      renderArtifacts: [],
    });

    const artifact = await new ContentRepository(db).recordRenderArtifact({
      tenantId: 'tnt_1',
      documentId: 'cdoc_1',
      versionId: 'cver_1',
      channel: 'sms',
      outputType: 'send',
      artifactRef: 'sms-delivery:smd_1',
      checksum: 'a'.repeat(64),
    });

    expect(artifact).toMatchObject({
      tenantId: 'tnt_1',
      documentId: 'cdoc_1',
      versionId: 'cver_1',
      channel: 'sms',
      outputType: 'send',
      artifactRef: 'sms-delivery:smd_1',
      checksum: 'a'.repeat(64),
    });
    expect(artifact.id).toMatch(/^cra_/);
    expect(inserted.content_render_artifacts).toEqual([
      expect.objectContaining({
        tenant_id: 'tnt_1',
        document_id: 'cdoc_1',
        version_id: 'cver_1',
        channel: 'sms',
        output_type: 'send',
        artifact_ref: 'sms-delivery:smd_1',
        checksum: 'a'.repeat(64),
      }),
    ]);
  });

  it('records test sends with IDs that fit the schema', async () => {
    const { db, inserted } = createContentMutationDb({
      documents: [],
      versions: [],
      testSends: [],
    });

    const send = await new ContentRepository(db).recordTestSend({
      tenantId: 'tnt_1',
      documentId: 'cdoc_1',
      versionId: 'cver_1',
      channel: 'sms',
      recipient: '+15550000001',
      status: 'captured',
      renderedText: 'Hi Ada',
    });

    expect(send.id).toMatch(/^cts_/);
    expect(send.id.length).toBeLessThanOrEqual(32);
    expect(inserted.content_test_sends).toEqual([
      expect.objectContaining({
        id: send.id,
        tenant_id: 'tnt_1',
        document_id: 'cdoc_1',
        version_id: 'cver_1',
        channel: 'sms',
        recipient: '+15550000001',
        status: 'captured',
        rendered_text: 'Hi Ada',
      }),
    ]);
  });

  it('rejects published event-page documents whose current version is stale', async () => {
    const { db } = createContentLookupDb({
      documents: [
        publishedDocument({
          id: 'cdoc_page',
          event_id: 'evt_1',
          channel: 'event_page',
          published_version_id: 'cver_page',
        }),
      ],
      versions: [
        publishedVersion({
          id: 'cver_page',
          document_id: 'cdoc_page',
          status: 'draft',
        }),
      ],
    });

    await expect(
      new ContentRepository(db).findPublishedEventPage({
        tenantId: 'tnt_1',
        eventId: 'evt_1',
      }),
    ).resolves.toBeUndefined();
  });

  it('prefers an event-scoped published email template over brand fallback', async () => {
    const { db, whereCalls } = createContentLookupDb({
      documents: [
        publishedDocument(),
        publishedDocument({
          id: 'cdoc_event',
          event_id: 'evt_1',
          published_version_id: 'cver_event',
        }),
      ],
      versions: [
        publishedVersion(),
        publishedVersion({ id: 'cver_event', document_id: 'cdoc_event', subject: 'Event update' }),
      ],
    });

    const result = await new ContentRepository(db).findPublishedEmailTemplate({
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      eventId: 'evt_1',
      key: 'event-update',
    });

    expect(result?.document.id).toBe('cdoc_event');
    expect(result?.version.id).toBe('cver_event');
    expect(whereCalls.content_documents).toContainEqual(['tenant_id', '=', 'tnt_1']);
    expect(whereCalls.content_documents).toContainEqual(['brand_id', '=', 'brd_1']);
    expect(whereCalls.content_documents).toContainEqual(['channel', '=', 'email']);
    expect(whereCalls.content_documents).toContainEqual(['key', '=', 'event-update']);
    expect(whereCalls.content_documents).toContainEqual(['event_id', '=', 'evt_1']);
  });

  it('falls back to a brand-scoped published email template', async () => {
    const { db, whereCalls } = createContentLookupDb({
      documents: [publishedDocument()],
      versions: [publishedVersion()],
    });

    const result = await new ContentRepository(db).findPublishedEmailTemplate({
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      eventId: 'evt_missing',
      key: 'event-update',
    });

    expect(result?.document.id).toBe('cdoc_brand');
    expect(result?.version.id).toBe('cver_brand');
    expect(whereCalls.content_documents).toContainEqual(['event_id', 'is', null]);
  });

  it('resolves event-scoped published SMS templates without using email content', async () => {
    const { db, whereCalls } = createContentLookupDb({
      documents: [
        publishedDocument(),
        publishedDocument({
          id: 'cdoc_sms',
          event_id: 'evt_1',
          channel: 'sms',
          published_version_id: 'cver_sms',
        }),
      ],
      versions: [
        publishedVersion(),
        publishedVersion({ id: 'cver_sms', document_id: 'cdoc_sms', rendered_text: 'SMS update' }),
      ],
    });

    const result = await new ContentRepository(db).findPublishedSmsTemplate({
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      eventId: 'evt_1',
      key: 'event-update',
    });

    expect(result?.document.id).toBe('cdoc_sms');
    expect(result?.version.id).toBe('cver_sms');
    expect(whereCalls.content_documents).toContainEqual(['channel', '=', 'sms']);
    expect(whereCalls.content_documents).not.toContainEqual(['channel', '=', 'email']);
  });

  it('rejects draft or stale content versions at render lookup time', async () => {
    const { db } = createContentLookupDb({
      documents: [publishedDocument({ published_version_id: 'cver_current' })],
      versions: [publishedVersion({ id: 'cver_stale', status: 'published' })],
    });

    const result = await new ContentRepository(db).findPublishedVersionById({
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      versionId: 'cver_stale',
      channel: 'email',
    });

    expect(result).toBeUndefined();
  });

  it('enforces tenant, brand, and channel when resolving a published content version', async () => {
    const { db } = createContentLookupDb({
      documents: [publishedDocument()],
      versions: [publishedVersion()],
    });

    await expect(
      new ContentRepository(db).findPublishedVersionById({
        tenantId: 'tnt_other',
        brandId: 'brd_1',
        versionId: 'cver_brand',
        channel: 'email',
      }),
    ).resolves.toBeUndefined();
    await expect(
      new ContentRepository(db).findPublishedVersionById({
        tenantId: 'tnt_1',
        brandId: 'brd_other',
        versionId: 'cver_brand',
        channel: 'email',
      }),
    ).resolves.toBeUndefined();
    await expect(
      new ContentRepository(db).findPublishedVersionById({
        tenantId: 'tnt_1',
        brandId: 'brd_1',
        versionId: 'cver_brand',
        channel: 'sms',
      }),
    ).resolves.toBeUndefined();
  });
});
