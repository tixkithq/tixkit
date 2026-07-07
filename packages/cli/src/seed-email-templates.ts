import { createDb, ContentRepository } from '@tixkit/db';
import { MERGE_TAG_REGISTRY, getTemplateLifecycle, type TemplateKey } from '@tixkit/domain';
import {
  createDefaultEmailTemplateForKey,
  SEEDABLE_EMAIL_TEMPLATE_KEYS,
  validateEmailTemplate,
} from '@tixkit/content-email';

/**
 * Idempotently seed published P0 email content documents for a brand/event scope
 * from the lifecycle defaults (`createDefaultEmailTemplateForKey`). This makes
 * the transactional workflow emails (order-confirmed, tickets-issued,
 * order-refunded, ...) resolve a published content version by key/scope so the
 * MergeTagContext wired in C-101 actually renders at send time (C-102).
 *
 * A template key is skipped when a published version already exists for the
 * scope, so re-running is safe and never overwrites organizer-authored content.
 */

export type SeedEmailTemplatesInput = {
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId?: string | null;
  createdBy?: string;
};

export type SeedEmailTemplatesResult = {
  ok: boolean;
  message: string;
  seeded: string[];
};

const EMAIL_VARIABLE_DEFINITIONS = MERGE_TAG_REGISTRY.map((variable) => ({
  key: variable.key,
  required: Boolean(variable.required),
  description: variable.description,
}));

export const SEED_EMAIL_TEMPLATE_KEYS: readonly TemplateKey[] = SEEDABLE_EMAIL_TEMPLATE_KEYS;

export async function seedEmailTemplateDefaults(
  input: SeedEmailTemplatesInput,
): Promise<SeedEmailTemplatesResult> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return {
      ok: false,
      message: 'DATABASE_URL is not set. Create .env.local from .env.local.example.',
      seeded: [],
    };
  }

  const db = createDb(dbUrl);
  try {
    const repo = new ContentRepository(db);
    const createdBy = input.createdBy ?? 'system-seed';

    const seeded: TemplateKey[] = [];
    for (const key of SEED_EMAIL_TEMPLATE_KEYS) {
      // eslint-disable-next-line no-await-in-loop -- Template seeding is sequential so validation and publishing errors point to one key.
      const existing = await repo.findPublishedEmailTemplate({
        tenantId: input.tenantId,
        brandId: input.brandId,
        eventId: input.eventId ?? undefined,
        key,
      });
      if (existing) continue;

      const lifecycle = getTemplateLifecycle(key);
      const document = createDefaultEmailTemplateForKey(key);
      const validation = validateEmailTemplate(document);
      if (!validation.valid) {
        throw new Error(`Generated default email template for ${key} failed validation`);
      }
      // eslint-disable-next-line no-await-in-loop -- Each document must exist before its version and publish step.
      const created = await repo.createDocument({
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        brandId: input.brandId,
        eventId: input.eventId ?? null,
        channel: 'email',
        key,
        name: lifecycle?.name ?? key,
        locale: 'en',
      });
      // eslint-disable-next-line no-await-in-loop -- Versions are tied to the document created in this iteration.
      const version = await repo.createVersion({
        documentId: created.id,
        subject: document.settings.subject,
        previewText: document.settings.previewText,
        contentJson: document,
        variables: EMAIL_VARIABLE_DEFINITIONS,
        validation,
        createdBy,
      });
      // eslint-disable-next-line no-await-in-loop -- Publish the version before reporting the key as seeded.
      await repo.publishVersion({ documentId: created.id, versionId: version.id });
      seeded.push(key);
    }

    return {
      ok: true,
      message: `Seeded ${seeded.length} email template${seeded.length === 1 ? '' : 's'}.`,
      seeded,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Unknown error',
      seeded: [],
    };
  } finally {
    await db.destroy();
  }
}
