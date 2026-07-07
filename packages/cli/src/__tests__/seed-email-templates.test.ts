import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  publishedKeys: new Set<string>(),
  createdDocuments: [] as Record<string, unknown>[],
  createdVersions: [] as Record<string, unknown>[],
  publishedVersions: [] as { documentId: string; versionId: string }[],
  findPublishedCalls: [] as Record<string, unknown>[],
  destroy: vi.fn(),
}));

vi.mock('@tixkit/db', () => {
  class ContentRepository {
    async findPublishedEmailTemplate(input: Record<string, unknown>) {
      mockState.findPublishedCalls.push(input);
      if (mockState.publishedKeys.has(input.key as string)) {
        return {
          version: { id: `cver_existing_${input.key}` },
          document: { id: `cdoc_existing_${input.key}` },
        };
      }
      return undefined;
    }
    async createDocument(input: Record<string, unknown>) {
      const doc = { id: `cdoc_${mockState.createdDocuments.length + 1}`, ...input };
      mockState.createdDocuments.push(doc);
      return doc;
    }
    async createVersion(input: Record<string, unknown>) {
      const version = { id: `cver_${mockState.createdVersions.length + 1}`, ...input };
      mockState.createdVersions.push(version);
      return version;
    }
    async publishVersion(input: { documentId: string; versionId: string }) {
      mockState.publishedVersions.push(input);
      return input;
    }
  }
  return {
    createDb: () => ({ destroy: mockState.destroy }),
    ContentRepository,
  };
});

const { seedEmailTemplateDefaults, SEED_EMAIL_TEMPLATE_KEYS } = await import(
  '../seed-email-templates.js'
);
const { getTemplateLifecycle, validateMergeTags } = await import('@tixkit/domain');

describe('seedEmailTemplateDefaults', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test';
    mockState.publishedKeys = new Set();
    mockState.createdDocuments = [];
    mockState.createdVersions = [];
    mockState.publishedVersions = [];
    mockState.findPublishedCalls = [];
    mockState.destroy.mockClear();
  });

  it('fails gracefully when DATABASE_URL is missing', async () => {
    delete process.env.DATABASE_URL;
    const result = await seedEmailTemplateDefaults({
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('DATABASE_URL');
    expect(result.seeded).toEqual([]);
  });

  it('creates and publishes a content document per P0 key when none exist', async () => {
    const result = await seedEmailTemplateDefaults({
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
      createdBy: 'ux_seed',
    });

    expect(result.ok).toBe(true);
    expect(result.seeded).toEqual([...SEED_EMAIL_TEMPLATE_KEYS]);
    expect(mockState.createdDocuments).toHaveLength(SEED_EMAIL_TEMPLATE_KEYS.length);
    expect(mockState.createdVersions).toHaveLength(SEED_EMAIL_TEMPLATE_KEYS.length);
    expect(mockState.publishedVersions).toHaveLength(SEED_EMAIL_TEMPLATE_KEYS.length);

    // Every seeded key got a unique email-channel document scoped to the brand.
    const seededKeys = new Set(
      mockState.createdDocuments.map((doc) => doc.key as string),
    );
    expect(seededKeys).toEqual(new Set(SEED_EMAIL_TEMPLATE_KEYS));
    for (const doc of mockState.createdDocuments) {
      expect(doc.channel).toBe('email');
      expect(doc.tenantId).toBe('tnt_1');
      expect(doc.brandId).toBe('brd_1');
      expect(doc.organizationId).toBe('org_1');
    }

    // Each published version is paired with a real created document/version id.
    const createdIds = new Set(mockState.createdDocuments.map((doc) => doc.id as string));
    const versionIds = new Set(mockState.createdVersions.map((version) => version.id as string));
    for (const pub of mockState.publishedVersions) {
      expect(createdIds.has(pub.documentId)).toBe(true);
      expect(versionIds.has(pub.versionId)).toBe(true);
    }

    // Each version carries clean validation and the merge-tag variable definitions.
    for (const version of mockState.createdVersions) {
      expect((version.validation as { valid: boolean }).valid).toBe(true);
      expect((version.variables as unknown[]).length).toBeGreaterThan(0);
      expect(version.createdBy).toBe('ux_seed');
      expect(version.subject).toBeTypeOf('string');
      expect(version.contentJson).toBeTypeOf('object');
    }

    // Every seeded key was probed for an existing published version, scoped to the brand.
    expect(mockState.findPublishedCalls).toHaveLength(SEED_EMAIL_TEMPLATE_KEYS.length);
    for (const call of mockState.findPublishedCalls) {
      expect(call.tenantId).toBe('tnt_1');
      expect(call.brandId).toBe('brd_1');
    }
    expect(mockState.destroy).toHaveBeenCalledTimes(1);
  });

  it('scopes probes by eventId when provided', async () => {
    await seedEmailTemplateDefaults({
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
      eventId: 'evt_1',
    });
    for (const call of mockState.findPublishedCalls) {
      expect(call.eventId).toBe('evt_1');
    }
    for (const doc of mockState.createdDocuments) {
      expect(doc.eventId).toBe('evt_1');
    }
  });

  it('is idempotent: skips every key that already has a published template', async () => {
    mockState.publishedKeys = new Set(SEED_EMAIL_TEMPLATE_KEYS);

    const result = await seedEmailTemplateDefaults({
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
    });

    expect(result.ok).toBe(true);
    expect(result.seeded).toEqual([]);
    expect(mockState.createdDocuments).toHaveLength(0);
    expect(mockState.createdVersions).toHaveLength(0);
    expect(mockState.publishedVersions).toHaveLength(0);
    expect(mockState.findPublishedCalls).toHaveLength(SEED_EMAIL_TEMPLATE_KEYS.length);
  });

  it('seeds only the missing keys when some templates already exist', async () => {
    const [existingKey, ...missingKeys] = SEED_EMAIL_TEMPLATE_KEYS;
    mockState.publishedKeys = new Set([existingKey]);

    const result = await seedEmailTemplateDefaults({
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
    });

    expect(result.ok).toBe(true);
    expect(result.seeded).toEqual(missingKeys);
    expect(mockState.createdDocuments).toHaveLength(missingKeys.length);
    expect(mockState.publishedVersions).toHaveLength(missingKeys.length);
  });

  it('seeds waitlist invite content with registry-required merge tags', async () => {
    await seedEmailTemplateDefaults({
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
    });

    const version = mockState.createdVersions.find(
      (createdVersion) =>
        (createdVersion.contentJson as { settings?: { templateKey?: string } }).settings
          ?.templateKey === 'waitlist-invite',
    );
    expect(version).toBeDefined();
    const document = version!.contentJson as {
      settings: { subject: string; previewText?: string };
      blocks: unknown[];
    };
    const renderedTemplate = [
      document.settings.subject,
      document.settings.previewText,
      JSON.stringify(document.blocks),
    ]
      .filter(Boolean)
      .join('\n');
    const validation = validateMergeTags(renderedTemplate);
    const lifecycle = getTemplateLifecycle('waitlist-invite')!;
    expect(validation.unknownTags).toEqual([]);
    for (const requiredVariable of lifecycle.requiredVariables) {
      expect(renderedTemplate).toContain(`{{${requiredVariable}}}`);
    }
  });
});
