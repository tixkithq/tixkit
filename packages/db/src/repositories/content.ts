import { ulid } from 'ulid';
import type { Selectable } from 'kysely';
import {
  CONTENT_SCHEMA_VERSION,
  transitionDocumentStatus,
  type ContentChannel,
  type ContentDocument,
  type ContentDocumentVersion,
  type ContentDocumentStatus,
  type ContentValidationResult,
  type ContentVariableDefinition,
  type ContentVersionStatus,
} from '@tixkit/content-core';
import { BaseRepository } from './base.js';
import type {
  ContentDocumentTable,
  ContentDocumentVersionTable,
  ContentTestSendTable,
} from '../types/db.js';

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export type ContentDocumentRecord = ContentDocument & {
  currentDraftVersionId?: string;
  publishedVersionId?: string;
};

export type ContentTestSendRecord = {
  id: string;
  tenantId: string;
  documentId: string;
  versionId: string;
  channel: ContentChannel;
  recipient: string;
  status: 'captured' | 'failed';
  renderedSubject?: string;
  renderedHtml?: string;
  renderedText?: string;
  error?: string;
  createdAt: string;
};

export class ContentRepository extends BaseRepository {
  async createDocument(input: {
    tenantId: string;
    organizationId: string;
    brandId: string;
    eventId?: string | null;
    channel: ContentChannel;
    key: string;
    name: string;
    locale?: string;
  }): Promise<ContentDocumentRecord> {
    const id = `cdoc_${ulid()}`;
    const now = new Date();
    const row = await this.insertReturning(
      'content_documents',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        brand_id: input.brandId,
        event_id: input.eventId ?? null,
        channel: input.channel,
        key: input.key,
        name: input.name,
        status: 'draft',
        locale: input.locale ?? 'en',
        current_draft_version_id: null,
        published_version_id: null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
    return this.toDocument(row);
  }

  async listDocuments(input: {
    tenantId: string;
    organizationIds?: readonly string[];
    brandIds?: readonly string[];
    eventIds?: readonly string[];
    channel?: ContentChannel;
    brandId?: string;
    eventId?: string;
    limit?: number;
  }): Promise<ContentDocumentRecord[]> {
    let query = this.db
      .selectFrom('content_documents')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .orderBy('created_at', 'desc')
      .limit(input.limit ?? 50);

    if (input.organizationIds && input.organizationIds.length > 0) {
      query = query.where('organization_id', 'in', [...input.organizationIds]);
    }
    if (input.brandIds && input.brandIds.length > 0) {
      query = query.where('brand_id', 'in', [...input.brandIds]);
    }
    if (input.eventIds && input.eventIds.length > 0) {
      query = query.where('event_id', 'in', [...input.eventIds]);
    }
    if (input.channel) query = query.where('channel', '=', input.channel);
    if (input.brandId) query = query.where('brand_id', '=', input.brandId);
    if (input.eventId) query = query.where('event_id', '=', input.eventId);

    const rows = await query.execute();
    return rows.map((row) => this.toDocument(row));
  }

  async findDocumentById(id: string): Promise<ContentDocumentRecord | undefined> {
    const row = await this.db
      .selectFrom('content_documents')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.toDocument(row) : undefined;
  }

  async findPublishedEventPage(input: {
    tenantId?: string;
    eventId: string;
    locale?: string;
  }): Promise<
    | {
        document: ContentDocumentRecord;
        version: ContentDocumentVersion;
      }
    | undefined
  > {
    let query = this.db
      .selectFrom('content_documents')
      .selectAll()
      .where('event_id', '=', input.eventId)
      .where('channel', '=', 'event_page')
      .where('status', '=', 'published')
      .where('published_version_id', 'is not', null);
    if (input.tenantId) query = query.where('tenant_id', '=', input.tenantId);
    if (input.locale) query = query.where('locale', '=', input.locale);
    const row = await query.executeTakeFirst();
    if (!row || !row.published_version_id) return undefined;
    const version = await this.findVersionById(row.published_version_id);
    if (!version) return undefined;
    return { document: this.toDocument(row), version };
  }

  async findPublishedEmailTemplate(input: {
    tenantId: string;
    brandId: string;
    key: string;
    eventId?: string;
    locale?: string;
  }): Promise<
    | {
        document: ContentDocumentRecord;
        version: ContentDocumentVersion;
      }
    | undefined
  > {
    const eventScoped = input.eventId
      ? await this.findPublishedContentByScope({ ...input, channel: 'email', eventId: input.eventId })
      : undefined;
    return (
      eventScoped ??
      (await this.findPublishedContentByScope({ ...input, channel: 'email', eventId: undefined }))
    );
  }

  async findPublishedVersionById(input: {
    tenantId: string;
    versionId: string;
    brandId?: string;
    channel?: ContentChannel;
  }): Promise<
    | {
        document: ContentDocumentRecord;
        version: ContentDocumentVersion;
      }
    | undefined
  > {
    const version = await this.findVersionById(input.versionId);
    if (!version || version.status !== 'published') return undefined;
    const document = await this.findDocumentById(version.documentId);
    if (!document) return undefined;
    if (document.tenantId !== input.tenantId) return undefined;
    if (input.brandId && document.brandId !== input.brandId) return undefined;
    if (input.channel && document.channel !== input.channel) return undefined;
    if (document.status !== 'published') return undefined;
    if (document.publishedVersionId !== version.id) return undefined;
    return { document, version };
  }

  async listVersions(documentId: string): Promise<ContentDocumentVersion[]> {
    const rows = await this.db
      .selectFrom('content_document_versions')
      .selectAll()
      .where('document_id', '=', documentId)
      .orderBy('version_number', 'desc')
      .execute();
    return rows.map((row) => this.toVersion(row));
  }

  async findVersionById(id: string): Promise<ContentDocumentVersion | undefined> {
    const row = await this.db
      .selectFrom('content_document_versions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? this.toVersion(row) : undefined;
  }

  async createVersion(input: {
    documentId: string;
    subject?: string;
    previewText?: string;
    contentJson: unknown;
    renderedHtml?: string;
    renderedText?: string;
    variables: ContentVariableDefinition[];
    validation: ContentValidationResult;
    createdBy: string;
  }): Promise<ContentDocumentVersion> {
    const versionNumber = (await this.nextVersionNumber(input.documentId)) + 1;
    const id = `cver_${ulid()}`;
    const now = new Date();
    const row = await this.insertReturning(
      'content_document_versions',
      {
        id,
        document_id: input.documentId,
        version_number: versionNumber,
        status: 'draft',
        schema_version: CONTENT_SCHEMA_VERSION,
        subject: input.subject ?? null,
        preview_text: input.previewText ?? null,
        content_json: JSON.stringify(input.contentJson),
        rendered_html: input.renderedHtml ?? null,
        rendered_text: input.renderedText ?? null,
        variables: JSON.stringify(input.variables),
        validation: JSON.stringify(input.validation),
        created_by: input.createdBy,
        created_at: now,
        published_at: null,
      },
      id,
    );

    await (this.db as any)
      .updateTable('content_documents')
      .set({ current_draft_version_id: id, updated_at: now })
      .where('id', '=', input.documentId)
      .execute();

    return this.toVersion(row);
  }

  async publishVersion(input: {
    documentId: string;
    versionId: string;
  }): Promise<{ document: ContentDocumentRecord; version: ContentDocumentVersion }> {
    const now = new Date();
    await (this.db as any)
      .updateTable('content_document_versions')
      .set({ status: 'superseded' })
      .where('document_id', '=', input.documentId)
      .where('status', '=', 'published')
      .execute();
    await (this.db as any)
      .updateTable('content_document_versions')
      .set({ status: 'published', published_at: now })
      .where('id', '=', input.versionId)
      .where('document_id', '=', input.documentId)
      .execute();
    await (this.db as any)
      .updateTable('content_documents')
      .set({
        status: 'published',
        published_version_id: input.versionId,
        current_draft_version_id: null,
        updated_at: now,
      })
      .where('id', '=', input.documentId)
      .execute();
    const document = await this.findDocumentById(input.documentId);
    const version = await this.findVersionById(input.versionId);
    if (!document || !version) throw new Error(`Content version not found: ${input.versionId}`);
    return {
      document,
      version,
    };
  }

  async archiveDocument(id: string): Promise<ContentDocumentRecord> {
    const existing = await this.findDocumentById(id);
    if (!existing) throw new Error(`Content document not found: ${id}`);
    const next = transitionDocumentStatus(existing.status, 'archived');
    const row = await this.updateReturning('content_documents', id, {
      status: next,
      updated_at: new Date(),
    });
    return this.toDocument(row);
  }

  async recordTestSend(input: {
    tenantId: string;
    documentId: string;
    versionId: string;
    channel: ContentChannel;
    recipient: string;
    status: 'captured' | 'failed';
    renderedSubject?: string;
    renderedHtml?: string;
    renderedText?: string;
    error?: string;
  }): Promise<ContentTestSendRecord> {
    const id = `ctsend_${ulid()}`;
    const row = await this.insertReturning(
      'content_test_sends',
      {
        id,
        tenant_id: input.tenantId,
        document_id: input.documentId,
        version_id: input.versionId,
        channel: input.channel,
        recipient: input.recipient,
        status: input.status,
        rendered_subject: input.renderedSubject ?? null,
        rendered_html: input.renderedHtml ?? null,
        rendered_text: input.renderedText ?? null,
        error: input.error ?? null,
        created_at: new Date(),
      },
      id,
    );
    return this.toTestSend(row);
  }

  private async findPublishedContentByScope(input: {
    tenantId: string;
    brandId: string;
    channel: ContentChannel;
    key: string;
    eventId?: string;
    locale?: string;
  }): Promise<
    | {
        document: ContentDocumentRecord;
        version: ContentDocumentVersion;
      }
    | undefined
  > {
    let query = this.db
      .selectFrom('content_documents')
      .selectAll()
      .where('tenant_id', '=', input.tenantId)
      .where('brand_id', '=', input.brandId)
      .where('channel', '=', input.channel)
      .where('key', '=', input.key)
      .where('status', '=', 'published')
      .where('published_version_id', 'is not', null);

    query = input.eventId
      ? query.where('event_id', '=', input.eventId)
      : query.where('event_id', 'is', null);
    if (input.locale) query = query.where('locale', '=', input.locale);

    const row = await query.executeTakeFirst();
    if (!row || !row.published_version_id) return undefined;
    const version = await this.findVersionById(row.published_version_id);
    if (!version || version.status !== 'published') return undefined;
    return { document: this.toDocument(row), version };
  }

  private async nextVersionNumber(documentId: string): Promise<number> {
    const rows = await this.db
      .selectFrom('content_document_versions')
      .select(['version_number'])
      .where('document_id', '=', documentId)
      .execute();
    return rows.reduce((max, row) => Math.max(max, Number(row.version_number)), 0);
  }

  private toDocument(row: Selectable<ContentDocumentTable>): ContentDocumentRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      brandId: row.brand_id,
      eventId: row.event_id ?? undefined,
      channel: row.channel as ContentChannel,
      key: row.key,
      name: row.name,
      status: row.status as ContentDocumentStatus,
      locale: row.locale,
      currentDraftVersionId: row.current_draft_version_id ?? undefined,
      publishedVersionId: row.published_version_id ?? undefined,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  private toVersion(row: Selectable<ContentDocumentVersionTable>): ContentDocumentVersion {
    return {
      id: row.id,
      documentId: row.document_id,
      versionNumber: row.version_number,
      status: row.status as ContentVersionStatus,
      schemaVersion: row.schema_version,
      subject: row.subject ?? undefined,
      previewText: row.preview_text ?? undefined,
      contentJson: parseJson(row.content_json, {}),
      renderedHtml: row.rendered_html ?? undefined,
      renderedText: row.rendered_text ?? undefined,
      variables: parseJson<ContentVariableDefinition[]>(row.variables, []),
      validation: parseJson<ContentValidationResult>(row.validation, {
        valid: false,
        severity: 'error',
        issues: [],
      }),
      createdBy: row.created_by,
      createdAt: iso(row.created_at),
      publishedAt: row.published_at ? iso(row.published_at) : undefined,
    };
  }

  private toTestSend(row: Selectable<ContentTestSendTable>): ContentTestSendRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      documentId: row.document_id,
      versionId: row.version_id,
      channel: row.channel as ContentChannel,
      recipient: row.recipient,
      status: row.status === 'failed' ? 'failed' : 'captured',
      renderedSubject: row.rendered_subject ?? undefined,
      renderedHtml: row.rendered_html ?? undefined,
      renderedText: row.rendered_text ?? undefined,
      error: row.error ?? undefined,
      createdAt: iso(row.created_at),
    };
  }
}
