import { BaseRepository } from './base.js';
import { ulid } from 'ulid';

export class NotificationTemplateRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    brandId?: string;
    key: string;
    name: string;
    description?: string;
    category: string;
    variables: string[];
  }) {
    const id = `ntf_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'notification_templates',
      {
        id,
        tenant_id: input.tenantId,
        brand_id: input.brandId ?? null,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        category: input.category,
        variables: JSON.stringify(input.variables),
        current_version_id: null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('notification_templates').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByKey(tenantId: string, key: string) {
    return this.db
      .selectFrom('notification_templates')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('key', '=', key)
      .where('brand_id', 'is', null)
      .executeTakeFirst();
  }

  async findByKeyForBrand(tenantId: string, key: string, brandId: string) {
    const brandTemplate = await this.db
      .selectFrom('notification_templates')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('key', '=', key)
      .where('brand_id', '=', brandId)
      .executeTakeFirst();

    return brandTemplate ?? this.findByKey(tenantId, key);
  }
}

export class NotificationTemplateVersionRepository extends BaseRepository {
  async create(input: {
    templateId: string;
    version: number;
    subjectTemplate: string;
    htmlTemplate: string;
    textTemplate?: string;
    locale: string;
    isDefault?: boolean;
  }) {
    const id = `ntv_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'notification_template_versions',
      {
        id,
        template_id: input.templateId,
        version: input.version,
        subject_template: input.subjectTemplate,
        html_template: input.htmlTemplate,
        text_template: input.textTemplate ?? null,
        locale: input.locale,
        is_default: input.isDefault ?? false,
        published_at: input.isDefault ? now : null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('notification_template_versions').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByTemplate(templateId: string) {
    return this.db
      .selectFrom('notification_template_versions')
      .selectAll()
      .where('template_id', '=', templateId)
      .execute();
  }

  async findDefault(templateId: string) {
    return this.db
      .selectFrom('notification_template_versions')
      .selectAll()
      .where('template_id', '=', templateId)
      .where('is_default', '=', true)
      .executeTakeFirst();
  }
}

export class EmailProviderRouteRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    brandId: string;
    providerType: string;
    credentialsRef: string;
    senderDomain: string;
    priority: number;
    isFallback: boolean;
    allowedCategories: string[];
    rateLimitPerHour?: number;
  }) {
    const id = `epr_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'email_provider_routes',
      {
        id,
        tenant_id: input.tenantId,
        brand_id: input.brandId,
        provider_type: input.providerType,
        credentials_ref: input.credentialsRef,
        sender_domain: input.senderDomain,
        priority: input.priority,
        is_fallback: input.isFallback,
        rate_limit_per_hour: input.rateLimitPerHour ?? null,
        allowed_categories: JSON.stringify(input.allowedCategories),
        status: 'pending',
        smoke_send_verified: false,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('email_provider_routes').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByBrand(brandId: string) {
    return this.db
      .selectFrom('email_provider_routes')
      .selectAll()
      .where('brand_id', '=', brandId)
      .execute();
  }

  async findActiveByBrand(brandId: string) {
    return this.db
      .selectFrom('email_provider_routes')
      .selectAll()
      .where('brand_id', '=', brandId)
      .where('status', '=', 'active')
      .where('smoke_send_verified', '=', true)
      .execute();
  }
}

export class BrandSenderIdentityRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    brandId: string;
    email: string;
    name: string;
    replyToEmail?: string;
  }) {
    const id = `bsi_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'brand_sender_identities',
      {
        id,
        tenant_id: input.tenantId,
        brand_id: input.brandId,
        email: input.email,
        name: input.name,
        reply_to_email: input.replyToEmail ?? null,
        verified: false,
        verified_at: null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findByBrand(brandId: string) {
    return this.db
      .selectFrom('brand_sender_identities')
      .selectAll()
      .where('brand_id', '=', brandId)
      .execute();
  }

  async findVerifiedByBrand(brandId: string) {
    return this.db
      .selectFrom('brand_sender_identities')
      .selectAll()
      .where('brand_id', '=', brandId)
      .where('verified', '=', true)
      .executeTakeFirst();
  }

  async findVerifiedByBrandAndDomain(brandId: string, senderDomain: string) {
    return this.db
      .selectFrom('brand_sender_identities')
      .selectAll()
      .where('brand_id', '=', brandId)
      .where('verified', '=', true)
      .where('email', 'like', `%@${senderDomain}`)
      .executeTakeFirst();
  }
}

export class EmailJobRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    brandId: string;
    templateKey: string;
    templateVersionId: string;
    toEmail: string;
    toName?: string;
    variables: Record<string, unknown>;
    providerRouteId: string;
    priority?: string;
    idempotencyKey: string;
    status?: string;
  }) {
    const id = `emj_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'email_jobs',
      {
        id,
        tenant_id: input.tenantId,
        brand_id: input.brandId,
        template_key: input.templateKey,
        template_version_id: input.templateVersionId,
        to_email: input.toEmail,
        to_name: input.toName ?? null,
        variables: JSON.stringify(input.variables),
        provider_route_id: input.providerRouteId,
        status: input.status ?? 'queued',
        priority: input.priority ?? 'normal',
        scheduled_at: null,
        idempotency_key: input.idempotencyKey,
        workflow_id: null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('email_jobs').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string) {
    return this.db
      .selectFrom('email_jobs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
  }

  async findByCampaignKey(tenantId: string, campaignKey: string) {
    return this.db
      .selectFrom('email_jobs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', 'like', `${campaignKey}:%`)
      .execute();
  }

  async findByBrand(tenantId: string, brandId: string) {
    return this.db
      .selectFrom('email_jobs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('brand_id', '=', brandId)
      .execute();
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('email_jobs', id, { ...input, updated_at: new Date() });
  }
}

export class EmailDeliveryRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    jobId: string;
    provider: string;
    providerMessageId?: string;
    status: string;
    attemptedProviders: string[];
    acceptedProvider?: string;
    metadata?: Record<string, unknown>;
  }) {
    const id = `emd_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'email_deliveries',
      {
        id,
        tenant_id: input.tenantId,
        job_id: input.jobId,
        provider: input.provider,
        provider_message_id: input.providerMessageId ?? null,
        status: input.status,
        attempted_providers: JSON.stringify(input.attemptedProviders),
        accepted_provider: input.acceptedProvider ?? null,
        sent_at: null,
        delivered_at: null,
        bounced_at: null,
        bounce_reason: null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : JSON.stringify({}),
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('email_deliveries', id, { ...input, updated_at: new Date() });
  }

  async findByProviderMessageId(provider: string, providerMessageId: string) {
    return this.db
      .selectFrom('email_deliveries')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_message_id', '=', providerMessageId)
      .executeTakeFirst();
  }

  async findByJobIds(tenantId: string, jobIds: string[]) {
    if (jobIds.length === 0) return [];
    return this.db
      .selectFrom('email_deliveries')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('job_id', 'in', jobIds)
      .execute();
  }
}


export class EmailProviderEventRepository extends BaseRepository {
  async findByProviderEventId(provider: string, providerEventId: string) {
    return this.db
      .selectFrom('email_provider_events')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_event_id', '=', providerEventId)
      .executeTakeFirst();
  }

  async findByProviderMessageIds(tenantId: string, providerMessageIds: string[]) {
    if (providerMessageIds.length === 0) return [];
    return this.db
      .selectFrom('email_provider_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('provider_message_id', 'in', providerMessageIds)
      .execute();
  }

  async create(input: {
    tenantId?: string | null;
    provider: string;
    providerEventId: string;
    eventType: string;
    providerMessageId?: string;
    email?: string;
    rawPayload: Record<string, unknown>;
  }) {
    const id = `epe_${ulid()}`;
    return this.insertReturning(
      'email_provider_events',
      {
        id,
        tenant_id: input.tenantId ?? null,
        provider: input.provider,
        provider_event_id: input.providerEventId,
        event_type: input.eventType,
        provider_message_id: input.providerMessageId ?? null,
        email: input.email ?? null,
        raw_payload: JSON.stringify(input.rawPayload),
        processed_at: new Date(),
        created_at: new Date(),
      },
      id,
    );
  }
}
export class EmailSuppressionRepository extends BaseRepository {
  async findByEmail(tenantId: string, email: string) {
    return this.db
      .selectFrom('email_suppressions')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('email', '=', email)
      .executeTakeFirst();
  }

  async create(input: {
    tenantId: string;
    email: string;
    reason: string;
    bounceType?: string;
    source: string;
  }) {
    const id = `esu_${ulid()}`;
    return this.insertReturning(
      'email_suppressions',
      {
        id,
        tenant_id: input.tenantId,
        email: input.email,
        reason: input.reason,
        bounce_type: input.bounceType ?? null,
        source: input.source,
        created_at: new Date(),
      },
      id,
    );
  }
}


  async findOrCreate(input: {
    tenantId: string;
    email: string;
    reason: string;
    bounceType?: string;
    source: string;
  }) {
    const existing = await this.findByEmail(input.tenantId, input.email);
    if (existing) return existing;
    return this.create(input);
  }
export class SmsSenderIdentityRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    brandId: string;
    sender: string;
    kind: string;
    providerType: string;
    providerSenderId?: string;
  }) {
    const id = `ssi_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'sms_sender_identities',
      {
        id,
        tenant_id: input.tenantId,
        brand_id: input.brandId,
        sender: input.sender,
        kind: input.kind,
        provider_type: input.providerType,
        provider_sender_id: input.providerSenderId ?? null,
        verified: false,
        verified_at: null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('sms_sender_identities').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findVerifiedByBrand(brandId: string) {
    return this.db
      .selectFrom('sms_sender_identities')
      .selectAll()
      .where('brand_id', '=', brandId)
      .where('verified', '=', true)
      .executeTakeFirst();
  }
}

export class SmsProviderRouteRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    brandId: string;
    providerType: string;
    credentialsRef: string;
    senderIdentityId: string;
    priority: number;
    isFallback: boolean;
    allowedCategories: string[];
    rateLimitPerHour?: number;
    webhookUrl?: string;
  }) {
    const id = `spr_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'sms_provider_routes',
      {
        id,
        tenant_id: input.tenantId,
        brand_id: input.brandId,
        provider_type: input.providerType,
        credentials_ref: input.credentialsRef,
        sender_identity_id: input.senderIdentityId,
        priority: input.priority,
        is_fallback: input.isFallback,
        rate_limit_per_hour: input.rateLimitPerHour ?? null,
        allowed_categories: JSON.stringify(input.allowedCategories),
        status: 'pending',
        smoke_send_verified: false,
        webhook_url: input.webhookUrl ?? null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('sms_provider_routes').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findActiveByBrand(brandId: string) {
    return this.db
      .selectFrom('sms_provider_routes')
      .selectAll()
      .where('brand_id', '=', brandId)
      .where('status', '=', 'active')
      .execute();
  }
}
      .where('smoke_send_verified', '=', true)

export class SmsJobRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    brandId: string;
    toPhone: string;
    body: string;
    templateKey?: string;
    variables?: Record<string, unknown>;
    providerRouteId: string;
    priority?: string;
    idempotencyKey: string;
    status?: string;
  }) {
    const id = `smj_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'sms_jobs',
      {
        id,
        tenant_id: input.tenantId,
        brand_id: input.brandId,
        to_phone: input.toPhone,
        body: input.body,
        template_key: input.templateKey ?? null,
        variables: JSON.stringify(input.variables ?? {}),
        provider_route_id: input.providerRouteId,
        status: input.status ?? 'queued',
        priority: input.priority ?? 'normal',
        scheduled_at: null,
        idempotency_key: input.idempotencyKey,
        workflow_id: null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('sms_jobs').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByIdempotencyKey(tenantId: string, idempotencyKey: string) {
    return this.db
      .selectFrom('sms_jobs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
  }

  async findByCampaignKey(tenantId: string, campaignKey: string) {
    return this.db
      .selectFrom('sms_jobs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('idempotency_key', 'like', `${campaignKey}:%`)
      .execute();
  }

  async findByBrand(tenantId: string, brandId: string) {
    return this.db
      .selectFrom('sms_jobs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('brand_id', '=', brandId)
      .execute();
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('sms_jobs', id, { ...input, updated_at: new Date() });
  }
}

export class SmsDeliveryRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    jobId: string;
    provider: string;
    providerMessageId?: string;
    status: string;
    attemptedProviders: string[];
    acceptedProvider?: string;
    failureReason?: string;
    metadata?: Record<string, unknown>;
  }) {
    const id = `smd_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'sms_deliveries',
      {
        id,
        tenant_id: input.tenantId,
        job_id: input.jobId,
        provider: input.provider,
        provider_message_id: input.providerMessageId ?? null,
        status: input.status,
        attempted_providers: JSON.stringify(input.attemptedProviders),
        accepted_provider: input.acceptedProvider ?? null,
        sent_at: input.status === 'accepted' || input.status === 'queued' || input.status === 'sent' ? now : null,
        delivered_at: input.status === 'delivered' ? now : null,
        failed_at: input.status === 'failed' ? now : null,
        failure_reason: input.failureReason ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : JSON.stringify({}),
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async update(id: string, input: Record<string, unknown>) {
    return this.updateReturning('sms_deliveries', id, { ...input, updated_at: new Date() });
  }

  async findByProviderMessageId(provider: string, providerMessageId: string) {
    return this.db
      .selectFrom('sms_deliveries')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_message_id', '=', providerMessageId)
      .executeTakeFirst();
  }

  async findByJobIds(tenantId: string, jobIds: string[]) {
    if (jobIds.length === 0) return [];
    return this.db
      .selectFrom('sms_deliveries')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('job_id', 'in', jobIds)
      .execute();
  }
}

export class MessageConsentRepository extends BaseRepository {
  async findActiveByAttendeeIds(tenantId: string, attendeeIds: string[]) {
    if (attendeeIds.length === 0) return [];
    return this.db
      .selectFrom('message_consents')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('attendee_id', 'in', attendeeIds)
      .where('revoked_at', 'is', null)
      .orderBy('consented_at', 'desc')
      .execute();
  }
}

export class SmsProviderEventRepository extends BaseRepository {

  async revokeEmailOptInByEmail(input: { tenantId: string; email: string; revokedAt?: Date }) {
    const revokedAt = input.revokedAt ?? new Date();
    return this.db
      .updateTable('message_consents')
      .set({ email_opt_in: false, revoked_at: revokedAt })
      .where('tenant_id', '=', input.tenantId)
      .where('email', '=', input.email)
      .where('email_opt_in', '=', true)
      .where('revoked_at', 'is', null)
      .execute();
  }

  async revokeSmsOptInByPhone(input: { tenantId: string; phone: string; revokedAt?: Date }) {
    const revokedAt = input.revokedAt ?? new Date();
    return this.db
      .updateTable('message_consents')
      .set({ sms_opt_in: false, revoked_at: revokedAt })
      .where('tenant_id', '=', input.tenantId)
      .where('phone', '=', input.phone)
      .where('sms_opt_in', '=', true)
      .where('revoked_at', 'is', null)
      .execute();
  }
  async findByProviderEventId(provider: string, providerEventId: string) {
    return this.db
      .selectFrom('sms_provider_events')
      .selectAll()
      .where('provider', '=', provider)
      .where('provider_event_id', '=', providerEventId)
      .executeTakeFirst();
  }

  async findByProviderMessageIds(tenantId: string, providerMessageIds: string[]) {
    if (providerMessageIds.length === 0) return [];
    return this.db
      .selectFrom('sms_provider_events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('provider_message_id', 'in', providerMessageIds)
      .execute();
  }

  async create(input: {
    tenantId?: string | null;
    provider: string;
    providerEventId: string;
    eventType: string;
    providerMessageId?: string;
    rawPayload: Record<string, unknown>;
  }) {
    const id = `spe_${ulid()}`;
    return this.insertReturning(
      'sms_provider_events',
      {
        id,
        tenant_id: input.tenantId ?? null,
        provider: input.provider,
        provider_event_id: input.providerEventId,
        event_type: input.eventType,
        provider_message_id: input.providerMessageId ?? null,
        raw_payload: JSON.stringify(input.rawPayload),
        processed_at: new Date(),
        created_at: new Date(),
      },
      id,
    );
  }
}
