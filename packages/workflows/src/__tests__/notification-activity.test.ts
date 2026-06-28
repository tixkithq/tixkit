import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  return {
    createDb: () => db,
    NotificationTemplateVersionRepository: class {
      async findDefault() {
        return undefined;
      }
    },
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

const { sendEmailActivity, sendSmsActivity } = await import('../activities/notification.js');

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
    dbState.destroy.mockClear();
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
