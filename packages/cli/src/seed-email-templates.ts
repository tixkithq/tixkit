import { createDb, ContentRepository } from '@tixkit/db';
import {
  P0_TEMPLATE_KEYS,
  MERGE_TAG_REGISTRY,
  getTemplateLifecycle,
  type TemplateKey,
} from '@tixkit/domain';
import {
  createDefaultEmailTemplateForKey,
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

export const SEED_EMAIL_TEMPLATE_KEYS: readonly TemplateKey[] = [
  ...P0_TEMPLATE_KEYS,
  'waitlist-invite',
];

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

    const results = await Promise.all(
      SEED_EMAIL_TEMPLATE_KEYS.map(async (key) => {
        const existing = await repo.findPublishedEmailTemplate({
          tenantId: input.tenantId,
          brandId: input.brandId,
          eventId: input.eventId ?? undefined,
          key,
        });
        if (existing) return null;

        const lifecycle = getTemplateLifecycle(key);
        const document = createDefaultEmailTemplateForKey(key);
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
        const version = await repo.createVersion({
          documentId: created.id,
          subject: document.settings.subject,
          previewText: document.settings.previewText,
          contentJson: document,
          variables: EMAIL_VARIABLE_DEFINITIONS,
          validation: validateEmailTemplate(document),
          createdBy,
        });
        await repo.publishVersion({ documentId: created.id, versionId: version.id });
        return key;
      }),
    );
    const seeded = results.filter((key): key is TemplateKey => key !== null);

    return {
      ok: true,
      message: `Seeded ${seeded.length} P0 email template${seeded.length === 1 ? '' : 's'}.`,
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
