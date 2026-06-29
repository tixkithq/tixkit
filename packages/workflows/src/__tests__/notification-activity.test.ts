import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSmsTemplate } from '@tixkit/content-message';

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
  },
  smsJob: {
    id: 'smj_1',
    tenant_id: 'tnt_1',
    brand_id: 'brd_1',
    to_phone: '+15550000001',
    body: 'Update',
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
    async findById() {
      return dbState.smsSender;
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

const { renderTemplateActivity, sendEmailActivity, sendSmsActivity } = await import(
  '../activities/notification.js'
);

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
  beforeEach(() => {
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
      contentJson: {},
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
        html: '<p>Hello &lt;script&gt;alert(1)&lt;/script&gt;</p>',
        text: 'Hello <script>alert(1)</script>',
      },
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
  });

  it('fails closed when SMS provider routes have no verified sender identity', async () => {
    dbState.smsRoutes = [activeSmsRoute()];
    dbState.smsSender = {
      id: 'ssi_1',
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
  });
});
