import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REACT_EMAIL_EDITOR_PACKAGE, createDefaultEmailTemplate } from '@tixkit/content-email';
import { createDefaultSmsTemplate } from '@tixkit/content-message';
import {
  MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
  registerMessagingProviderExtension,
} from '@tixkit/domain/messaging';

const dbState = vi.hoisted(() => ({
  emailJob: {
    id: 'emj_1',
    tenant_id: 'tnt_1',
    brand_id: 'brd_1',
    template_key: 'event-update',
    template_version_id: 'ntv_1',
    to_email: 'buyer@example.com',
    to_name: 'Buyer',
    variables: JSON.stringify({ notificationType: 'bulk' }),
    status: 'queued',
  },
  smsJob: {
    id: 'smj_1',
    tenant_id: 'tnt_1',
    brand_id: 'brd_1',
    to_phone: '+15550000001',
    body: 'Update',
    template_key: 'event-update',
    variables: JSON.stringify({ contentVersionId: 'cver_1' }),
    idempotency_key: 'idem_sms',
  },
  emailRoutes: [] as Array<Record<string, unknown>>,
  smsRoutes: [] as Array<Record<string, unknown>>,
  emailSender: undefined as Record<string, unknown> | undefined,
  smsSender: undefined as Record<string, unknown> | undefined,
  smsConsent: {
    tenant_id: 'tnt_1',
    phone: '+15550000001',
    sms_opt_in: true,
    revoked_at: null,
  } as Record<string, unknown> | undefined,
  emailDeliveries: [] as Record<string, unknown>[],
  smsDeliveries: [] as Record<string, unknown>[],
  renderArtifacts: [] as Record<string, unknown>[],
  emailJobUpdates: [] as Record<string, unknown>[],
  smsJobUpdates: [] as Record<string, unknown>[],
  contentDocument: {
    id: 'cdoc_1',
    tenantId: 'tnt_1',
    organizationId: 'org_1',
    brandId: 'brd_1',
    channel: 'email',
    key: 'event-update',
    name: 'Event update',
    status: 'published',
    locale: 'en',
    publishedVersionId: 'cver_1',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  } as Record<string, unknown> | undefined,
  contentVersion: {
    id: 'cver_1',
    documentId: 'cdoc_1',
    versionNumber: 1,
    status: 'published',
    schemaVersion: 1,
    subject: 'Update for {{event.title}}',
    renderedHtml: '<p>Hello {{recipient.name}}</p>',
    renderedText: 'Hello {{recipient.name}}',
    contentJson: {},
    variables: [],
    validation: { valid: true, severity: 'warning', issues: [] },
    createdBy: 'usr_1',
    createdAt: '2026-06-01T00:00:00.000Z',
    publishedAt: '2026-06-01T00:00:00.000Z',
  } as Record<string, unknown> | undefined,
  destroy: vi.fn(),
}));

vi.mock('@tixkit/db', () => {
  const db = {
    destroy: dbState.destroy,
    selectFrom: (table: string) => {
      const query = {
        selectAll: () => query,
        where: () => query,
        orderBy: () => query,
        executeTakeFirst: async () => {
          if (table === 'message_consents') return dbState.smsConsent;
          return undefined;
        },
      };
      return query;
    },
  };

  class EmailJobRepository {
    async findById(id: string) {
      return dbState.emailJob.id === id ? dbState.emailJob : undefined;
    }

    async update(_id: string, input: Record<string, unknown>) {
      dbState.emailJobUpdates.push(input);
      return { ...dbState.emailJob, ...input };
    }
  }

  class EmailProviderRouteRepository {
    async findByBrand() {
      return dbState.emailRoutes;
    }

    async findActiveByBrand() {
      return dbState.emailRoutes.filter(
        (route) => route.status === 'active' && route.smoke_send_verified === true,
      );
    }
  }

  class BrandSenderIdentityRepository {
    async findVerifiedByBrandAndDomain() {
      return dbState.emailSender;
    }
  }

  class EmailDeliveryRepository {
    async create(input: Record<string, unknown>) {
      dbState.emailDeliveries.push(input);
      return { id: 'emd_1', ...input };
    }
  }

  class SmsJobRepository {
    async findById(id: string) {
      return dbState.smsJob.id === id ? dbState.smsJob : undefined;
    }

    async update(_id: string, input: Record<string, unknown>) {
      dbState.smsJobUpdates.push(input);
      return { ...dbState.smsJob, ...input };
    }
  }

  class SmsProviderRouteRepository {
    async findActiveByBrand() {
      return dbState.smsRoutes.filter(
        (route) => route.status === 'active' && route.smoke_send_verified === true,
      );
    }
  }

  class SmsSenderIdentityRepository {
    async findById(id: string) {
      return dbState.smsSender?.id === id ? dbState.smsSender : undefined;
    }
  }

  class SmsDeliveryRepository {
    async create(input: Record<string, unknown>) {
      dbState.smsDeliveries.push(input);
      return { id: 'smd_1', ...input };
    }
  }

  class ContentRepository {
    async findPublishedVersionById(input: {
      tenantId: string;
      brandId?: string;
      versionId: string;
      channel?: string;
    }) {
      const version = dbState.contentVersion;
      const document = dbState.contentDocument;
      if (!version || !document) return undefined;
      if (version.id !== input.versionId) return undefined;
      if (document.tenantId !== input.tenantId) return undefined;
      if (input.brandId && document.brandId !== input.brandId) return undefined;
      if (input.channel && document.channel !== input.channel) return undefined;
      if (document.status !== 'published') return undefined;
      if (version.status !== 'published') return undefined;
      if (document.publishedVersionId !== version.id) return undefined;
      return { document, version };
    }

    async recordRenderArtifact(input: Record<string, unknown>) {
      const artifact = {
        id: `cra_${dbState.renderArtifacts.length + 1}`,
        ...input,
      };
      dbState.renderArtifacts.push(artifact);
      return artifact;
    }
  }

  return {
    createDb: () => db,
    ContentRepository,
    EmailProviderRouteRepository,
    BrandSenderIdentityRepository,
    EmailJobRepository,
    EmailDeliveryRepository,
    SmsProviderRouteRepository,
    SmsSenderIdentityRepository,
    SmsJobRepository,
    SmsDeliveryRepository,
  };
});

const { renderTemplateActivity, sendEmailActivity, sendSmsActivity, markEmailJobFailedActivity } =
  await import('../activities/notification.js');

function activeEmailRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: 'epr_1',
    provider_type: 'opencore_email_sdk',
    credentials_ref: 'cred_email',
    sender_domain: 'example.com',
    priority: 1,
    is_fallback: false,
    rate_limit_per_hour: null,
    allowed_categories: JSON.stringify(['bulk', 'transactional']),
    status: 'active',
    smoke_send_verified: true,
    ...overrides,
  };
}

function activeSmsRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: 'spr_1',
    tenant_id: 'tnt_1',
    brand_id: 'brd_1',
    provider_type: 'telnyx',
    credentials_ref: 'cred_sms',
    sender_identity_id: 'ssi_1',
    priority: 1,
    is_fallback: false,
    rate_limit_per_hour: null,
    allowed_categories: JSON.stringify(['bulk', 'transactional']),
    status: 'active',
    smoke_send_verified: true,
    ...overrides,
  };
}

describe('notification activity deliverability gating', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    dbState.emailJob.template_version_id = 'ntv_1';
    dbState.emailJob.variables = JSON.stringify({ notificationType: 'bulk' });
    dbState.emailJob.status = 'queued';
    dbState.smsJob.variables = JSON.stringify({ contentVersionId: 'cver_1' });
    dbState.emailRoutes = [];
    dbState.smsRoutes = [];
    dbState.emailSender = undefined;
    dbState.smsSender = undefined;
    dbState.smsConsent = {
      tenant_id: 'tnt_1',
      phone: '+15550000001',
      sms_opt_in: true,
      revoked_at: null,
    };
    dbState.emailDeliveries = [];
    dbState.smsDeliveries = [];
    dbState.renderArtifacts = [];
    dbState.emailJobUpdates = [];
    dbState.smsJobUpdates = [];
    dbState.contentDocument = {
      id: 'cdoc_1',
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      brandId: 'brd_1',
      channel: 'email',
      key: 'event-update',
      name: 'Event update',
      status: 'published',
      locale: 'en',
      publishedVersionId: 'cver_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    };
    dbState.contentVersion = {
      id: 'cver_1',
      documentId: 'cdoc_1',
      versionNumber: 1,
      status: 'published',
      schemaVersion: 1,
      subject: 'Update for {{event.title}}',
      renderedHtml: '<p>Hello {{recipient.name}}</p>',
      renderedText: 'Hello {{recipient.name}}',
      contentJson: createDefaultEmailTemplate({
        editor: {
          provider: REACT_EMAIL_EDITOR_PACKAGE,
          contentHtml: '<p>Hello {{recipient.name}}</p>',
          contentText: 'Hello {{recipient.name}}',
          contentJson: { type: 'doc', content: [] },
        },
        settings: {
          templateKey: 'event-update',
          subject: 'Update for {{event.title}}',
          previewText: 'Latest event details.',
          locale: 'en',
          category: 'transactional',
          sender: {
            fromEmail: 'tickets@example.test',
            fromName: 'Tixkit',
            replyToEmail: 'support@example.test',
          },
        },
      }),
      variables: [],
      validation: { valid: true, severity: 'warning', issues: [] },
      createdBy: 'usr_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      publishedAt: '2026-06-01T00:00:00.000Z',
    };
    dbState.destroy.mockClear();
  });

  it('renders published content email versions through the shared renderer', async () => {
    const result = await renderTemplateActivity({
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      templateKey: 'event-update',
      templateVersionId: 'cver_1',
      variables: {
        event: { title: 'All Access' },
        recipient: { name: '<script>alert(1)</script>' },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        subject: 'Update for All Access',
        text: 'Hello <script>alert(1)</script>',
      },
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.html).toContain('<!DOCTYPE html>');
    expect(result.value.html).toContain('<p>Hello &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(result.value.html).not.toContain('<script>alert(1)</script>');
  });

  it('renders the versioned system invitation fallback for durable invite jobs', async () => {
    dbState.contentVersion = undefined;
    const result = await renderTemplateActivity({
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      templateKey: 'organization-member-invited',
      templateVersionId: 'system_organization_member_invited_v1',
      variables: {
        recipient: { name: 'Ada' },
        brand: { name: 'Tixkit Events' },
        dashboard: { url: 'https://admin.example.test/sign-up' },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.value.html).toContain('Tixkit Events');
    expect(result.value.html).toContain('https://admin.example.test/sign-up');
  });

  it('renders content email versions from canonical JSON instead of stored HTML', async () => {
    dbState.contentVersion = {
      ...dbState.contentVersion!,
      renderedHtml: '<script>alert("stored")</script><p>Stored {{recipient.name}}</p>',
      renderedText: 'Stored {{recipient.name}}',
    };

    const result = await renderTemplateActivity({
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      templateKey: 'event-update',
      templateVersionId: 'cver_1',
      variables: {
        event: { title: 'All Access' },
        recipient: { name: 'Ada' },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        subject: 'Update for All Access',
        text: 'Hello Ada',
      },
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.html).toContain('<!DOCTYPE html>');
    expect(result.value.html).toContain('<p>Hello Ada</p>');
    expect(result.value.html).not.toContain('Stored Ada');
    expect(result.value.html).not.toContain('alert("stored")');
  });

  it('fails closed when a published content email version is not canonical JSON', async () => {
    dbState.contentVersion = {
      ...dbState.contentVersion!,
      contentJson: {},
      renderedHtml: '<p>Hello {{recipient.name}}</p>',
    };

    const result = await renderTemplateActivity({
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      templateKey: 'event-update',
      templateVersionId: 'cver_1',
      variables: {
        event: { title: 'All Access' },
        recipient: { name: 'Ada' },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'EMAIL_TEMPLATE_INVALID',
      retryable: false,
    });
  });

  it('renders published content SMS versions through the SMS adapter', async () => {
    dbState.contentDocument = {
      ...dbState.contentDocument!,
      channel: 'sms',
    };
    dbState.contentVersion = {
      ...dbState.contentVersion!,
      subject: null,
      renderedHtml: null,
      renderedText: 'Hi {{recipient.name}}, {{event.title}} starts {{event.startsAt}}.',
      contentJson: createDefaultSmsTemplate({
        editor: { body: 'Hi {{recipient.name}}, {{event.title}} starts {{event.startsAt}}.' },
        settings: {
          templateKey: 'event-update',
          category: 'bulk',
          consentCategory: 'marketing',
          segmentLimit: 2,
          optOutText: 'Reply STOP to opt out',
        },
      }),
    };

    const result = await renderTemplateActivity({
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      channel: 'sms',
      templateKey: 'event-update',
      templateVersionId: 'cver_1',
      variables: {
        event: { title: 'All Access', startsAt: '2026-07-17 19:00' },
        recipient: { name: 'Ada' },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        subject: '',
        html: '',
        text: 'Hi Ada, All Access starts 2026-07-17 19:00. Reply STOP to opt out',
        segments: 1,
      },
    });
  });

  it('fails closed for stale content email versions', async () => {
    dbState.contentDocument = {
      ...dbState.contentDocument!,
      publishedVersionId: 'cver_other',
    };

    const result = await renderTemplateActivity({
      tenantId: 'tnt_1',
      brandId: 'brd_1',
      templateKey: 'event-update',
      templateVersionId: 'cver_1',
      variables: {},
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'CONTENT_TEMPLATE_NOT_PUBLISHED',
      retryable: false,
    });
  });

  it('fails closed when template rendering is requested without tenant scope', async () => {
    const result = await renderTemplateActivity({
      templateKey: 'event-update',
      templateVersionId: 'ntv_1',
      variables: {},
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'CONTENT_TEMPLATE_SCOPE_REQUIRED',
      retryable: false,
    });
  });

  it('marks tenant-scoped email jobs failed for terminal workflow failures', async () => {
    const result = await markEmailJobFailedActivity({
      jobId: 'emj_1',
      tenantId: 'tnt_1',
      activityContext: 'Email render',
      errorCode: 'EMAIL_TEMPLATE_INVALID',
      message: 'Published email template is invalid',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        failed: true,
        errorCode: 'EMAIL_TEMPLATE_INVALID',
        message: 'Published email template is invalid',
      },
    });
    expect(dbState.emailJobUpdates).toEqual([{ status: 'failed' }]);
  });

  it('does not mark email jobs failed across tenant boundaries', async () => {
    const result = await markEmailJobFailedActivity({
      jobId: 'emj_1',
      tenantId: 'tnt_other',
      activityContext: 'Email render',
      errorCode: 'EMAIL_TEMPLATE_INVALID',
      message: 'Published email template is invalid',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'EMAIL_JOB_NOT_FOUND',
      retryable: false,
    });
    expect(dbState.emailJobUpdates).toHaveLength(0);
  });

  it('fails closed when configured email routes lack smoke-send evidence', async () => {
    dbState.emailRoutes = [activeEmailRoute({ smoke_send_verified: false })];

    const result = await sendEmailActivity({
      jobId: 'emj_1',
      providerRouteId: 'epr_1',
      subject: 'Update',
      html: '<p>Update</p>',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'EMAIL_PROVIDER_ROUTE_NOT_VERIFIED',
      retryable: false,
    });
    expect(dbState.emailDeliveries).toHaveLength(0);
    expect(dbState.renderArtifacts).toHaveLength(0);
  });

  it('fails closed without a configured production default email provider', async () => {
    vi.stubEnv('TIXKIT_RUNTIME_MODE', 'production');
    vi.stubEnv('RESEND_API_KEY', '');

    const result = await sendEmailActivity({
      jobId: 'emj_1',
      providerRouteId: 'epr_default',
      subject: 'Update',
      html: '<p>Update</p>',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'EMAIL_PROVIDER_UNSUPPORTED',
      retryable: false,
    });
    expect(dbState.emailDeliveries).toHaveLength(0);
    expect(dbState.renderArtifacts).toHaveLength(0);
  });

  it('fails closed when email routes have no verified sender for the route domain', async () => {
    dbState.emailRoutes = [activeEmailRoute()];

    const result = await sendEmailActivity({
      jobId: 'emj_1',
      providerRouteId: 'epr_1',
      subject: 'Update',
      html: '<p>Update</p>',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'EMAIL_SENDER_NOT_VERIFIED',
      retryable: false,
    });
    expect(dbState.emailDeliveries).toHaveLength(0);
    expect(dbState.renderArtifacts).toHaveLength(0);
  });

  it('fails closed without retrying an unsupported email provider route', async () => {
    dbState.emailRoutes = [activeEmailRoute({ provider_type: 'postmark' })];
    dbState.emailSender = {
      id: 'bsi_1',
      brand_id: 'brd_1',
      email: 'tickets@example.com',
      name: 'Tixkit',
      verified: true,
    };

    const result = await sendEmailActivity({
      jobId: 'emj_1',
      providerRouteId: 'epr_1',
      subject: 'Update',
      html: '<p>Update</p>',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'EMAIL_PROVIDER_UNSUPPORTED',
      retryable: false,
    });
    expect(dbState.emailDeliveries).toHaveLength(0);
    expect(dbState.renderArtifacts).toHaveLength(0);
  });

  it('returns a safe terminal result for a permanent provider rejection', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_secret');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { name: 'validation_error', message: 'buyer@example.com is invalid' },
          { status: 422 },
        ),
      ),
    );
    dbState.emailRoutes = [activeEmailRoute({ provider_type: 'resend' })];
    dbState.emailSender = {
      id: 'bsi_1',
      brand_id: 'brd_1',
      email: 'tickets@example.com',
      name: 'Tixkit',
      verified: true,
    };

    const result = await sendEmailActivity({
      jobId: 'emj_1',
      providerRouteId: 'epr_1',
      subject: 'Update',
      html: '<p>Update</p>',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'EMAIL_SEND_FAILED',
      message: 'resend.send-email failed: validation (HTTP 422)',
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain('buyer@example.com is invalid');
    expect(dbState.emailDeliveries).toHaveLength(0);
  });

  it('throws a safe retryable failure so Temporal owns provider retries', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_secret');
    const fetchMock = vi.fn(async () =>
      Response.json({ message: 'buyer@example.com upstream failure' }, { status: 503 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    dbState.emailRoutes = [activeEmailRoute({ provider_type: 'resend' })];
    dbState.emailSender = {
      id: 'bsi_1',
      brand_id: 'brd_1',
      email: 'tickets@example.com',
      name: 'Tixkit',
      verified: true,
    };

    const failure = sendEmailActivity({
      jobId: 'emj_1',
      providerRouteId: 'epr_1',
      subject: 'Update',
      html: '<p>Update</p>',
    });

    await expect(failure).rejects.toMatchObject({
      kind: 'server',
      retryable: true,
      safeToFailover: false,
      details: {},
    });
    await expect(failure).rejects.not.toThrow('buyer@example.com upstream failure');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(dbState.emailDeliveries).toHaveLength(0);
  });

  it('keeps exhausted permanent fallback rejections terminal', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_secret');
    const fetchMock = vi.fn(async () =>
      Response.json(
        { code: 'invalid_recipient', diagnostic: 'private-provider-text' },
        { status: 422 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    dbState.emailRoutes = [
      activeEmailRoute({ provider_type: 'resend' }),
      activeEmailRoute({
        id: 'epr_fallback',
        provider_type: 'resend',
        is_fallback: true,
        priority: 2,
      }),
    ];
    dbState.emailSender = {
      id: 'bsi_1',
      brand_id: 'brd_1',
      email: 'tickets@example.com',
      name: 'Tixkit',
      verified: true,
    };

    const result = await sendEmailActivity({
      jobId: 'emj_1',
      providerRouteId: 'epr_1',
      subject: 'Update',
      html: '<p>Update</p>',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'EMAIL_SEND_FAILED',
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain('private-provider-text');
    expect(dbState.emailDeliveries).toHaveLength(0);
  });

  it('keeps exhausted rate limits in Temporal activity retry semantics', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_secret');
    const fetchMock = vi.fn(async () =>
      Response.json(
        { code: 'rate_limited', diagnostic: 'private-provider-text' },
        { status: 429, headers: { 'retry-after': '10' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    dbState.emailRoutes = [
      activeEmailRoute({ provider_type: 'resend' }),
      activeEmailRoute({
        id: 'epr_fallback',
        provider_type: 'resend',
        is_fallback: true,
        priority: 2,
      }),
    ];
    dbState.emailSender = {
      id: 'bsi_1',
      brand_id: 'brd_1',
      email: 'tickets@example.com',
      name: 'Tixkit',
      verified: true,
    };

    const failure = sendEmailActivity({
      jobId: 'emj_1',
      providerRouteId: 'epr_1',
      subject: 'Update',
      html: '<p>Update</p>',
    });

    await expect(failure).rejects.toMatchObject({
      kind: 'rate-limit',
      retryable: true,
      safeToFailover: false,
      details: {},
    });
    await expect(failure).rejects.not.toThrow('private-provider-text');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dbState.emailDeliveries).toHaveLength(0);
  });

  it('fails closed when SMS provider routes have no verified sender identity', async () => {
    dbState.smsRoutes = [activeSmsRoute()];
    dbState.smsSender = {
      id: 'ssi_1',
      tenant_id: 'tnt_1',
      brand_id: 'brd_1',
      sender: '+15550000002',
      verified: false,
    };

    const result = await sendSmsActivity({
      jobId: 'smj_1',
      providerRouteId: 'spr_1',
      notificationType: 'bulk',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'NO_SMS_PROVIDER_ROUTE',
      retryable: false,
    });
    expect(dbState.smsDeliveries).toHaveLength(0);
    expect(dbState.renderArtifacts).toHaveLength(0);
  });

  it('fails closed when an SMS provider route uses a sender from another brand', async () => {
    dbState.smsRoutes = [activeSmsRoute()];
    dbState.smsSender = {
      id: 'ssi_1',
      tenant_id: 'tnt_1',
      brand_id: 'brd_other',
      sender: '+15550000002',
      verified: true,
    };

    const result = await sendSmsActivity({
      jobId: 'smj_1',
      providerRouteId: 'spr_1',
      notificationType: 'bulk',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'NO_SMS_PROVIDER_ROUTE',
      retryable: false,
    });
    expect(dbState.smsDeliveries).toHaveLength(0);
    expect(dbState.renderArtifacts).toHaveLength(0);
  });

  it('fails closed without retrying an unsupported SMS provider route', async () => {
    dbState.smsRoutes = [activeSmsRoute({ provider_type: 'operator-extension' })];
    dbState.smsSender = {
      id: 'ssi_1',
      tenant_id: 'tnt_1',
      brand_id: 'brd_1',
      sender: '+15550000002',
      verified: true,
    };

    const result = await sendSmsActivity({
      jobId: 'smj_1',
      providerRouteId: 'spr_1',
      notificationType: 'bulk',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'SMS_PROVIDER_UNSUPPORTED',
      retryable: false,
    });
    expect(dbState.smsDeliveries).toHaveLength(0);
    expect(dbState.renderArtifacts).toHaveLength(0);
  });

  it('executes an operator SMS extension registered through the published domain contract', async () => {
    const sends: Array<{ body: string; credentialsRef: string }> = [];
    let providerReads = 0;
    const unregister = registerMessagingProviderExtension({
      descriptor: {
        contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
        providerType: 'operator_extension',
        displayName: 'Operator Extension',
        channels: ['sms'],
        operations: ['send'],
      },
      createSms: ({ credentialsRef }) => ({
        providerName: 'operator_extension',
        async send(input) {
          sends.push({ body: input.body, credentialsRef });
          return {
            deliveryId: input.deliveryId,
            get provider() {
              providerReads += 1;
              return providerReads === 1 ? 'operator_extension' : 'attacker';
            },
            providerMessageId: 'operator-message-1',
            status: 'accepted',
            attemptedFallbackProviders: [],
            sentAt: new Date().toISOString(),
          };
        },
      }),
    });
    dbState.contentDocument = { ...dbState.contentDocument!, channel: 'sms' };
    dbState.contentVersion = {
      ...dbState.contentVersion!,
      subject: null,
      renderedHtml: null,
      renderedText: 'Update',
      contentJson: createDefaultSmsTemplate({
        editor: { body: 'Update' },
        settings: {
          templateKey: 'event-update',
          category: 'bulk',
          consentCategory: 'marketing',
          segmentLimit: 2,
          optOutText: 'Reply STOP to opt out',
        },
      }),
    };
    dbState.smsRoutes = [activeSmsRoute({ provider_type: 'operator_extension' })];
    dbState.smsSender = {
      id: 'ssi_1',
      tenant_id: 'tnt_1',
      brand_id: 'brd_1',
      sender: '+15550000002',
      verified: true,
    };

    try {
      const result = await sendSmsActivity({
        jobId: 'smj_1',
        providerRouteId: 'spr_1',
        notificationType: 'bulk',
      });

      expect(result).toMatchObject({
        ok: true,
        value: { provider: 'operator_extension' },
      });
      expect(sends).toEqual([{ body: 'Update', credentialsRef: 'cred_sms' }]);
      expect(providerReads).toBe(1);
      expect(dbState.smsDeliveries).toContainEqual(
        expect.objectContaining({ provider: 'operator_extension' }),
      );
    } finally {
      unregister();
    }
  });

  it('persists an operator email extension under its registered descriptor identity', async () => {
    let providerReads = 0;
    const unregister = registerMessagingProviderExtension({
      descriptor: {
        contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
        providerType: 'operator_email',
        displayName: 'Operator Email',
        channels: ['email'],
        operations: ['send'],
      },
      createEmail: () => ({
        providerName: 'operator_email',
        async send(input) {
          return {
            deliveryId: input.deliveryId,
            get provider() {
              providerReads += 1;
              return providerReads === 1 ? 'operator_email' : 'attacker';
            },
            providerMessageId: 'operator-email-1',
            status: 'accepted',
            attemptedFallbackProviders: [],
            sentAt: new Date().toISOString(),
          };
        },
      }),
    });
    dbState.emailJob.template_version_id = 'cver_1';
    dbState.emailRoutes = [activeEmailRoute({ provider_type: 'operator_email' })];
    dbState.emailSender = {
      id: 'bsi_1',
      brand_id: 'brd_1',
      email: 'tickets@example.com',
      name: 'Tixkit',
      reply_to_email: 'support@example.com',
      verified: true,
    };

    try {
      const result = await sendEmailActivity({
        jobId: 'emj_1',
        providerRouteId: 'epr_1',
        subject: 'Update for All Access',
        html: '<p>Hello Ada</p>',
        text: 'Hello Ada',
      });

      expect(result).toMatchObject({
        ok: true,
        value: { provider: 'operator_email' },
      });
      expect(providerReads).toBe(1);
      expect(dbState.emailDeliveries).toContainEqual(
        expect.objectContaining({ provider: 'operator_email' }),
      );
    } finally {
      unregister();
    }
  });

  it('does not persist an operator SMS result with a substituted provider identity', async () => {
    const unregister = registerMessagingProviderExtension({
      descriptor: {
        contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
        providerType: 'operator_sms_spoof',
        displayName: 'Operator SMS Spoof',
        channels: ['sms'],
        operations: ['send'],
      },
      createSms: () => ({
        providerName: 'operator_sms_spoof',
        async send(input) {
          return {
            deliveryId: input.deliveryId,
            provider: 'sk_live_DO_NOT_EXPOSE_123456\nInjected: secret',
            providerMessageId: 'spoofed-message',
            status: 'accepted',
            attemptedFallbackProviders: [],
            sentAt: new Date().toISOString(),
          };
        },
      }),
    });
    dbState.smsRoutes = [activeSmsRoute({ provider_type: 'operator_sms_spoof' })];
    dbState.smsSender = {
      id: 'ssi_1',
      tenant_id: 'tnt_1',
      brand_id: 'brd_1',
      sender: '+15550000002',
      verified: true,
    };

    try {
      const result = await sendSmsActivity({
        jobId: 'smj_1',
        providerRouteId: 'spr_1',
        notificationType: 'bulk',
      });

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'SMS_PROVIDER_IDENTITY_MISMATCH',
        message: 'Messaging provider extension returned an invalid provider identity',
        retryable: false,
      });
      expect(JSON.stringify(result)).not.toContain('sk_live_DO_NOT_EXPOSE_123456');
      expect(dbState.smsDeliveries).toHaveLength(0);
      expect(dbState.smsJobUpdates).toHaveLength(0);
      expect(dbState.renderArtifacts).toHaveLength(0);
    } finally {
      unregister();
    }
  });

  it('does not persist an operator email result with a substituted provider identity', async () => {
    const unregister = registerMessagingProviderExtension({
      descriptor: {
        contractVersion: MESSAGING_PROVIDER_EXTENSION_CONTRACT_VERSION,
        providerType: 'operator_email_spoof',
        displayName: 'Operator Email Spoof',
        channels: ['email'],
        operations: ['send'],
      },
      createEmail: () => ({
        providerName: 'operator_email_spoof',
        async send(input) {
          return {
            deliveryId: input.deliveryId,
            provider: `attacker\n${'x'.repeat(10_000)}`,
            providerMessageId: 'spoofed-message',
            status: 'accepted',
            attemptedFallbackProviders: [],
            sentAt: new Date().toISOString(),
          };
        },
      }),
    });
    dbState.emailRoutes = [activeEmailRoute({ provider_type: 'operator_email_spoof' })];
    dbState.emailSender = {
      id: 'bsi_1',
      brand_id: 'brd_1',
      email: 'tickets@example.com',
      name: 'Tixkit',
      reply_to_email: 'support@example.com',
      verified: true,
    };

    try {
      const result = await sendEmailActivity({
        jobId: 'emj_1',
        providerRouteId: 'epr_1',
        subject: 'Update for All Access',
        html: '<p>Hello Ada</p>',
        text: 'Hello Ada',
      });

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'EMAIL_PROVIDER_IDENTITY_MISMATCH',
        message: 'Messaging provider extension returned an invalid provider identity',
        retryable: false,
      });
      expect(JSON.stringify(result)).not.toContain('attacker');
      expect(JSON.stringify(result).length).toBeLessThan(256);
      expect(dbState.emailDeliveries).toHaveLength(0);
      expect(dbState.emailJobUpdates).toHaveLength(0);
      expect(dbState.renderArtifacts).toHaveLength(0);
    } finally {
      unregister();
    }
  });

  it('records send render artifacts for accepted content email deliveries', async () => {
    dbState.emailJob.template_version_id = 'cver_1';
    dbState.emailRoutes = [
      activeEmailRoute({ provider_type: 'capture' }),
      activeEmailRoute({
        id: 'epr_staff_unsupported',
        provider_type: 'postmark',
        allowed_categories: JSON.stringify(['staff']),
      }),
    ];
    dbState.emailSender = {
      id: 'bsi_1',
      brand_id: 'brd_1',
      email: 'tickets@example.com',
      name: 'Tixkit',
      reply_to_email: 'support@example.com',
      verified: true,
    };

    const result = await sendEmailActivity({
      jobId: 'emj_1',
      providerRouteId: 'epr_1',
      subject: 'Update for All Access',
      html: '<p>Hello Ada</p>',
      text: 'Hello Ada',
    });

    expect(result).toMatchObject({ ok: true });
    expect(dbState.renderArtifacts).toEqual([
      expect.objectContaining({
        tenantId: 'tnt_1',
        documentId: 'cdoc_1',
        versionId: 'cver_1',
        channel: 'email',
        outputType: 'send',
        artifactRef: expect.stringMatching(/^email-delivery:emd_/),
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });

  it('records send render artifacts for accepted content SMS deliveries', async () => {
    dbState.contentDocument = {
      ...dbState.contentDocument!,
      channel: 'sms',
    };
    dbState.contentVersion = {
      ...dbState.contentVersion!,
      subject: null,
      renderedHtml: null,
      renderedText: 'Update',
      contentJson: createDefaultSmsTemplate({
        editor: { body: 'Update' },
        settings: {
          templateKey: 'event-update',
          category: 'bulk',
          consentCategory: 'marketing',
          segmentLimit: 2,
          optOutText: 'Reply STOP to opt out',
        },
      }),
    };
    dbState.smsRoutes = [
      activeSmsRoute({ provider_type: 'capture' }),
      activeSmsRoute({
        id: 'spr_staff_unsupported',
        provider_type: 'operator-extension',
        allowed_categories: JSON.stringify(['staff']),
      }),
    ];
    dbState.smsSender = {
      id: 'ssi_1',
      tenant_id: 'tnt_1',
      brand_id: 'brd_1',
      sender: '+15550000002',
      verified: true,
    };

    const result = await sendSmsActivity({
      jobId: 'smj_1',
      providerRouteId: 'spr_1',
      notificationType: 'bulk',
    });

    expect(result).toMatchObject({ ok: true });
    expect(dbState.renderArtifacts).toEqual([
      expect.objectContaining({
        tenantId: 'tnt_1',
        documentId: 'cdoc_1',
        versionId: 'cver_1',
        channel: 'sms',
        outputType: 'send',
        artifactRef: expect.stringMatching(/^sms-delivery:smd_/),
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });
});
