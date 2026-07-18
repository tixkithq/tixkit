import Fastify, { type FastifyInstance } from 'fastify';
import { createDefaultSmsTemplate } from '@tixkit/content-message';
import {
  AttendeeRepository,
  AuditLogRepository,
  CheckoutSessionRepository,
  createDb,
  EventRepository,
  OrderRepository,
  type Database,
} from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { messagingRoutes } from '../../routes/modules/messaging.js';
import { hashRequest } from '../../services/idempotency.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';

type MessageCampaignCheckpoint = Readonly<{
  stage: 'before_transaction' | 'after_email_jobs' | 'before_audit';
  eventId: string;
  campaignId: string;
}>;

const runId = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_msg_auth_a_${runId}`;
const tenantB = `tnt_msg_auth_b_${runId}`;
const organizationA = `org_msg_auth_a_${runId}`;
const organizationAScoped = `org_msg_auth_scope_${runId}`;
const organizationB = `org_msg_auth_b_${runId}`;
const brandA = `brd_msg_auth_a_${runId}`;
const brandAScoped = `brd_msg_auth_scope_${runId}`;
const brandB = `brd_msg_auth_b_${runId}`;
const actorId = `usr_msg_auth_${runId}`;
const campaignPrefix = `msg-${runId}`;
const attendeeEmail = `campaign-private-${runId}@example.test`;
const attendeePhone = `+1555${runId
  .replaceAll(/[^0-9]/gu, '')
  .padEnd(7, '0')
  .slice(0, 7)}`;
const privateVariable = `private-campaign-variable-${runId}`;

let app: FastifyInstance;
let db: Database;
let previousDriver: string | undefined;
let activePrincipal: Principal;
let basePrincipal: Principal;
let eventA: string;
let eventAScoped: string;
let eventB: string;
let attendeeA: string;
const observedErrors: Error[] = [];

const startNotificationDelivery = vi.fn(async () => undefined);
const startSmsDelivery = vi.fn(async () => undefined);
let checkpointImplementation: (
  input: MessageCampaignCheckpoint,
) => void | Promise<void> = async () => undefined;
const messageCampaignWriteCheckpoint = vi.fn((input: MessageCampaignCheckpoint) =>
  checkpointImplementation(input),
);

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    type: 'user',
    id: actorId,
    tenantId: tenantA,
    organizationIds: [organizationA],
    brandIds: [brandA],
    eventIds: [eventA],
    scopes: ['messages.write'],
    ...overrides,
  };
}

async function insertTenant(id: string, name: string): Promise<void> {
  const now = new Date('2026-07-17T12:00:00.000Z');
  await db
    .insertInto('tenants')
    .values({ id, name, status: 'active', plan: 'test', created_at: now, updated_at: now })
    .execute();
}

async function insertOrganization(id: string, tenantId: string, name: string): Promise<void> {
  const now = new Date('2026-07-17T12:00:00.000Z');
  await db
    .insertInto('organizations')
    .values({
      id,
      tenant_id: tenantId,
      name,
      slug: `${id}-slug`,
      clerk_organization_id: null,
      box_office_settings: '{}',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function insertBrand(
  id: string,
  tenantId: string,
  organizationId: string,
  name: string,
): Promise<void> {
  const now = new Date('2026-07-17T12:00:00.000Z');
  await db
    .insertInto('brands')
    .values({
      id,
      tenant_id: tenantId,
      organization_id: organizationId,
      name,
      slug: `${id}-slug`,
      status: 'active',
      theme: '{}',
      support_url: null,
      legal_urls: '{}',
      white_label: false,
      payment_account_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function createEvent(
  tenantId: string,
  organizationId: string,
  brandId: string,
  title: string,
): Promise<string> {
  const event = await new EventRepository(db).create({
    tenantId,
    organizationId,
    brandId,
    slug: `${title.toLowerCase().replaceAll(' ', '-')}-${runId}`,
    title,
    currency: 'USD',
    timezone: 'UTC',
    startsAt: new Date('2027-01-01T18:00:00.000Z'),
    endsAt: new Date('2027-01-01T22:00:00.000Z'),
    venue: { name: 'Campaign authorization hall' },
  });
  return event.id;
}

async function seedCampaignAudience(): Promise<void> {
  const now = new Date('2026-07-17T12:30:00.000Z');
  const poolId = `pool_msg_auth_${runId}`;
  const ticketTypeId = `tt_msg_auth_${runId}`;
  await db
    .insertInto('inventory_pools')
    .values({
      id: poolId,
      event_id: eventA,
      name: 'Campaign authorization pool',
      total_capacity: 10,
      reserved_count: 0,
      sold_count: 1,
      hold_ttl_seconds: 300,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('ticket_types')
    .values({
      id: ticketTypeId,
      event_id: eventA,
      name: 'Campaign authorization ticket',
      description: null,
      kind: 'paid',
      status: 'active',
      visibility: 'public',
      currency: 'USD',
      price_cents: 2500,
      minimum_price_cents: null,
      sales_start_at: null,
      sales_end_at: null,
      min_per_order: 1,
      max_per_order: 10,
      inventory_pool_id: poolId,
      sort_order: 0,
      requires_access_code: false,
      access_code_hint: null,
      event_occurrence_id: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const checkout = await new CheckoutSessionRepository(db).create({
    tenantId: tenantA,
    eventId: eventA,
    brandId: brandA,
    currency: 'USD',
    cart: { items: [{ ticketTypeId, quantity: 1 }] },
    buyer: { email: attendeeEmail, phone: attendeePhone },
    quote: { totalCents: 2500 },
    expiresAt: new Date('2027-01-01T17:00:00.000Z'),
    idempotencyKey: `campaign-audience-${runId}`,
  });
  const order = await new OrderRepository(db).create({
    tenantId: tenantA,
    organizationId: organizationA,
    brandId: brandA,
    eventId: eventA,
    checkoutSessionId: checkout.id,
    orderNumber: `MSG-AUTH-${runId}`,
    status: 'paid',
    currency: 'USD',
    subtotalCents: 2500,
    discountCents: 0,
    taxCents: 0,
    feeCents: 0,
    totalCents: 2500,
    buyerEmail: attendeeEmail,
  });
  const attendee = await new AttendeeRepository(db).create({
    tenantId: tenantA,
    orderId: order.id,
    eventId: eventA,
    ticketTypeId,
    firstName: 'Private',
    lastName: 'Recipient',
    email: attendeeEmail,
    phone: attendeePhone,
  });
  attendeeA = attendee.id;
  await db
    .updateTable('attendees')
    .set({ status: 'confirmed', updated_at: now })
    .where('id', '=', attendeeA)
    .execute();
  await db
    .insertInto('message_consents')
    .values({
      id: `msc_msg_auth_${runId}`,
      tenant_id: tenantA,
      attendee_id: attendeeA,
      email: attendeeEmail,
      phone: attendeePhone,
      email_opt_in: true,
      sms_opt_in: true,
      consent_text: 'Campaign authorization updates',
      consent_version: 'v1',
      consented_at: now,
      revoked_at: null,
      created_at: now,
    })
    .execute();
}

async function seedCampaignConfiguration(): Promise<void> {
  const now = new Date('2026-07-17T12:35:00.000Z');
  const emailDocumentId = `cdoc_email_${runId}`;
  const emailVersionId = `cver_email_${runId}`;
  const smsDocumentId = `cdoc_sms_${runId}`;
  const smsVersionId = `cver_sms_${runId}`;
  await db
    .insertInto('content_documents')
    .values([
      {
        id: emailDocumentId,
        tenant_id: tenantA,
        organization_id: organizationA,
        brand_id: brandA,
        event_id: eventA,
        channel: 'email',
        key: 'campaign-email',
        name: 'Campaign email',
        status: 'published',
        locale: 'en',
        current_draft_version_id: null,
        published_version_id: emailVersionId,
        created_at: now,
        updated_at: now,
      },
      {
        id: smsDocumentId,
        tenant_id: tenantA,
        organization_id: organizationA,
        brand_id: brandA,
        event_id: eventA,
        channel: 'sms',
        key: 'campaign-sms',
        name: 'Campaign SMS',
        status: 'published',
        locale: 'en',
        current_draft_version_id: null,
        published_version_id: smsVersionId,
        created_at: now,
        updated_at: now,
      },
    ])
    .execute();
  await db
    .insertInto('content_document_versions')
    .values([
      {
        id: emailVersionId,
        document_id: emailDocumentId,
        version_number: 1,
        status: 'published',
        schema_version: 1,
        subject: 'Campaign update',
        preview_text: null,
        content_json: '{}',
        rendered_html: '<p>Campaign update</p>',
        rendered_text: 'Campaign update',
        variables: '[]',
        validation: '{"valid":true,"severity":"warning","issues":[]}',
        created_by: actorId,
        created_at: now,
        published_at: now,
      },
      {
        id: smsVersionId,
        document_id: smsDocumentId,
        version_number: 1,
        status: 'published',
        schema_version: 1,
        subject: null,
        preview_text: null,
        content_json: JSON.stringify(
          createDefaultSmsTemplate({
            editor: { body: 'Hi {{recipient.name}}, {{event.title}} starts soon.' },
            settings: {
              templateKey: 'campaign-sms',
              category: 'bulk',
              consentCategory: 'marketing',
              segmentLimit: 3,
              optOutText: 'Reply STOP to opt out',
            },
          }),
        ),
        rendered_html: null,
        rendered_text: 'Hi {{recipient.name}}, {{event.title}} starts soon.',
        variables: '[]',
        validation: '{"valid":true,"severity":"warning","issues":[]}',
        created_by: actorId,
        created_at: now,
        published_at: now,
      },
    ])
    .execute();
  await db
    .insertInto('email_provider_routes')
    .values({
      id: `epr_msg_auth_${runId}`,
      tenant_id: tenantA,
      brand_id: brandA,
      provider_type: 'capture',
      credentials_ref: 'capture',
      sender_domain: 'example.test',
      priority: 0,
      is_fallback: false,
      rate_limit_per_hour: null,
      allowed_categories: '["bulk"]',
      status: 'active',
      smoke_send_verified: true,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('sms_sender_identities')
    .values({
      id: `ssi_msg_auth_${runId}`,
      tenant_id: tenantA,
      brand_id: brandA,
      sender: '+15555550199',
      kind: 'phone_number',
      provider_type: 'capture',
      provider_sender_id: null,
      verified: true,
      verified_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('sms_provider_routes')
    .values({
      id: `spr_msg_auth_${runId}`,
      tenant_id: tenantA,
      brand_id: brandA,
      provider_type: 'capture',
      credentials_ref: 'capture',
      sender_identity_id: `ssi_msg_auth_${runId}`,
      priority: 0,
      is_fallback: false,
      rate_limit_per_hour: null,
      allowed_categories: '["bulk"]',
      status: 'active',
      smoke_send_verified: true,
      webhook_url: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

function campaignPayload(overrides: Record<string, unknown> = {}) {
  return {
    emailTemplateKey: 'campaign-email',
    smsTemplateKey: 'campaign-sms',
    audience: 'all',
    channel: 'both',
    variables: { supportNote: privateVariable },
    ...overrides,
  };
}

function invokeCampaign(campaignId: string, payload = campaignPayload(), targetEventId = eventA) {
  return app.inject({
    method: 'POST',
    url: `/events/${targetEventId}/messages`,
    headers: { 'idempotency-key': campaignId },
    payload,
  });
}

async function campaignSnapshot() {
  const [events, emailJobs, smsJobs, idempotency, audits] = await Promise.all([
    db
      .selectFrom('events')
      .select(['id', 'tenant_id', 'organization_id', 'brand_id'])
      .where('id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('email_jobs')
      .selectAll()
      .where('tenant_id', 'in', [tenantA, tenantB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('sms_jobs')
      .selectAll()
      .where('tenant_id', 'in', [tenantA, tenantB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('idempotency_records')
      .selectAll()
      .where('tenant_id', 'in', [tenantA, tenantB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .where('action', '=', 'event.message_campaign.queued')
      .orderBy('id')
      .execute(),
  ]);
  return { events, emailJobs, smsJobs, idempotency, audits };
}

async function clearCampaignWrites(): Promise<void> {
  await db
    .deleteFrom('audit_logs')
    .where('actor_id', '=', actorId)
    .where('action', '=', 'event.message_campaign.queued')
    .execute();
  await db.deleteFrom('email_jobs').where('tenant_id', 'in', [tenantA, tenantB]).execute();
  await db.deleteFrom('sms_jobs').where('tenant_id', 'in', [tenantA, tenantB]).execute();
  await db.deleteFrom('idempotency_records').where('tenant_id', 'in', [tenantA, tenantB]).execute();
  await db
    .updateTable('events')
    .set({ tenant_id: tenantA, organization_id: organizationA, brand_id: brandA })
    .where('id', '=', eventA)
    .execute();
}

async function cleanupFixture(): Promise<void> {
  await clearCampaignWrites();
  await db.deleteFrom('message_consents').where('attendee_id', '=', attendeeA).execute();
  await db.updateTable('attendees').set({ ticket_id: null }).where('id', '=', attendeeA).execute();
  await db.deleteFrom('attendees').where('id', '=', attendeeA).execute();
  await db.deleteFrom('orders').where('event_id', '=', eventA).execute();
  await db.deleteFrom('checkout_sessions').where('event_id', '=', eventA).execute();
  await db.deleteFrom('content_document_versions').where('created_by', '=', actorId).execute();
  await db
    .deleteFrom('content_documents')
    .where('tenant_id', '=', tenantA)
    .where('event_id', '=', eventA)
    .execute();
  await db.deleteFrom('email_provider_routes').where('brand_id', '=', brandA).execute();
  await db.deleteFrom('sms_provider_routes').where('brand_id', '=', brandA).execute();
  await db.deleteFrom('sms_sender_identities').where('brand_id', '=', brandA).execute();
  await db.deleteFrom('ticket_types').where('event_id', '=', eventA).execute();
  await db.deleteFrom('inventory_pools').where('event_id', '=', eventA).execute();
  await db.deleteFrom('events').where('id', 'in', [eventA, eventAScoped, eventB]).execute();
  await db.deleteFrom('brands').where('id', 'in', [brandA, brandAScoped, brandB]).execute();
  await db
    .deleteFrom('organizations')
    .where('id', 'in', [organizationA, organizationAScoped, organizationB])
    .execute();
  await db.deleteFrom('tenants').where('id', 'in', [tenantA, tenantB]).execute();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function installTwoPartyCheckpointBarrier(campaignId: string) {
  const bothReached = deferred();
  const release = deferred();
  let arrivals = 0;
  checkpointImplementation = async (input) => {
    if (input.stage !== 'before_transaction' || input.campaignId !== campaignId) return;
    arrivals += 1;
    if (arrivals === 2) bothReached.resolve();
    await release.promise;
  };
  return { bothReached: bothReached.promise, release: release.resolve };
}

async function expectBoundedCheckpoint(promise: Promise<void>, label: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} checkpoint not reached`)), 2000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function databaseJson(value: unknown): Record<string, unknown> {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

describeWithIntegrationDatabase(
  `message campaign write route authorization and atomicity (${integrationDatabaseDriver()})`,
  () => {
    beforeAll(async () => {
      previousDriver = setIntegrationDatabaseDriver();
      db = createDb(integrationDatabaseUrl());
      await insertTenant(tenantA, 'Campaign authorization tenant A');
      await insertTenant(tenantB, 'Campaign authorization tenant B');
      await insertOrganization(organizationA, tenantA, 'Campaign authorization org A');
      await insertOrganization(organizationAScoped, tenantA, 'Campaign authorization scoped org');
      await insertOrganization(organizationB, tenantB, 'Campaign authorization org B');
      await insertBrand(brandA, tenantA, organizationA, 'Campaign authorization brand A');
      await insertBrand(
        brandAScoped,
        tenantA,
        organizationAScoped,
        'Campaign authorization scoped brand',
      );
      await insertBrand(brandB, tenantB, organizationB, 'Campaign authorization brand B');
      eventA = await createEvent(tenantA, organizationA, brandA, 'Allowed campaign event');
      eventAScoped = await createEvent(
        tenantA,
        organizationAScoped,
        brandAScoped,
        'Scoped campaign event',
      );
      eventB = await createEvent(tenantB, organizationB, brandB, 'Foreign campaign event');
      await seedCampaignAudience();
      await seedCampaignConfiguration();

      basePrincipal = principal();
      activePrincipal = basePrincipal;
      app = Fastify({ logger: false });
      app.decorate('context', {
        db,
        temporalClient: { startNotificationDelivery, startSmsDelivery },
        messageCampaignWriteCheckpoint,
      } as unknown as AppContext);
      app.addHook('onRequest', async (request) => {
        request.principal = activePrincipal;
      });
      app.addHook('onError', async (_request, _reply, error) => {
        observedErrors.push(error);
      });
      registerErrorHandler(app);
      await app.register(messagingRoutes);
      await app.ready();
    }, 120_000);

    beforeEach(async () => {
      activePrincipal = basePrincipal;
      checkpointImplementation = async () => undefined;
      messageCampaignWriteCheckpoint.mockClear();
      startNotificationDelivery.mockClear();
      startSmsDelivery.mockClear();
      observedErrors.length = 0;
      await clearCampaignWrites();
    });

    afterAll(async () => {
      const errors: unknown[] = [];
      try {
        if (app) await app.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        if (db) {
          await cleanupFixture();
          await db.destroy();
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        restoreDatabaseDriver(previousDriver);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) throw new AggregateError(errors, 'campaign proof cleanup failed');
    }, 120_000);

    it.each([
      ['permission', () => principal({ scopes: [] }), () => eventA, 403, 'FORBIDDEN'],
      ['tenant', () => basePrincipal, () => eventB, 404, 'NOT_FOUND'],
      [
        'organization',
        () => principal({ organizationIds: [organizationA] }),
        () => eventAScoped,
        404,
        'NOT_FOUND',
      ],
      [
        'brand',
        () =>
          principal({
            organizationIds: [organizationA, organizationAScoped],
            brandIds: [brandA],
            eventIds: [eventA, eventAScoped],
          }),
        () => eventAScoped,
        404,
        'NOT_FOUND',
      ],
      [
        'event',
        () =>
          principal({
            organizationIds: [organizationA, organizationAScoped],
            brandIds: [brandA, brandAScoped],
            eventIds: [eventA],
          }),
        () => eventAScoped,
        404,
        'NOT_FOUND',
      ],
    ] as const)(
      'denies the %s boundary without campaign intent, idempotency, audit, or provider mutation',
      async (_boundary, makePrincipal, targetEvent, status, code) => {
        activePrincipal = makePrincipal();
        const before = await campaignSnapshot();
        const response = await invokeCampaign(
          `${campaignPrefix}-denied-${_boundary}`,
          undefined,
          targetEvent(),
        );
        expect(response.statusCode, response.body).toBe(status);
        expect(response.json()).toMatchObject({ error: { code } });
        await expect(campaignSnapshot()).resolves.toEqual(before);
        expect(startNotificationDelivery).not.toHaveBeenCalled();
        expect(startSmsDelivery).not.toHaveBeenCalled();
      },
    );

    it('revalidates tenant, organization, brand, and event scope after the locked checkpoint', async () => {
      const reached = deferred();
      const release = deferred();
      checkpointImplementation = async (input) => {
        if (input.stage !== 'before_transaction') return;
        reached.resolve();
        await release.promise;
      };
      const before = await campaignSnapshot();
      const responsePromise = invokeCampaign(`${campaignPrefix}-scope-swap`);
      await expect(
        Promise.race([
          reached.promise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('before_transaction checkpoint not reached')), 2000),
          ),
        ]),
      ).resolves.toBeUndefined();
      await db
        .updateTable('events')
        .set({ organization_id: organizationAScoped, brand_id: brandAScoped })
        .where('id', '=', eventA)
        .execute();
      release.resolve();
      const response = await responsePromise;
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      const after = await campaignSnapshot();
      expect({ ...after, events: before.events, idempotency: before.idempotency }).toEqual(before);
      expect(after.emailJobs).toEqual([]);
      expect(after.smsJobs).toEqual([]);
      expect(after.idempotency).toEqual([]);
      expect(after.audits).toEqual([]);
    });

    it('discards idempotency when the event disappears before locked reauthorization', async () => {
      activePrincipal = principal({
        organizationIds: [organizationA, organizationAScoped],
        brandIds: [brandA, brandAScoped],
        eventIds: [eventA, eventAScoped],
      });
      const reached = deferred();
      const release = deferred();
      checkpointImplementation = async (input) => {
        if (input.stage !== 'before_transaction') return;
        reached.resolve();
        await release.promise;
      };
      const campaignId = `${campaignPrefix}-event-deleted`;
      const responsePromise = invokeCampaign(campaignId, undefined, eventAScoped);
      await expectBoundedCheckpoint(reached.promise, 'event deletion');
      await db.deleteFrom('events').where('id', '=', eventAScoped).execute();
      release.resolve();

      const response = await responsePromise;
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(await campaignSnapshot()).toMatchObject({
        emailJobs: [],
        smsJobs: [],
        idempotency: [],
        audits: [],
      });
      expect(startNotificationDelivery).not.toHaveBeenCalled();
      expect(startSmsDelivery).not.toHaveBeenCalled();

      eventAScoped = await createEvent(
        tenantA,
        organizationAScoped,
        brandAScoped,
        'Scoped campaign event',
      );
    });

    it('rolls back the email half, SMS half, idempotency, and audit when both-channel assembly fails', async () => {
      checkpointImplementation = async (input) => {
        if (input.stage === 'after_email_jobs') throw new Error('forced second-half failure');
      };
      const response = await invokeCampaign(`${campaignPrefix}-second-half`);
      expect(response.statusCode, response.body).toBe(500);
      const snapshot = await campaignSnapshot();
      expect(snapshot.emailJobs).toEqual([]);
      expect(snapshot.smsJobs).toEqual([]);
      expect(snapshot.idempotency).toEqual([]);
      expect(snapshot.audits).toEqual([]);
      expect(startNotificationDelivery).not.toHaveBeenCalled();
      expect(startSmsDelivery).not.toHaveBeenCalled();
    });

    it('fails closed and rolls back durable intent when the product audit cannot persist', async () => {
      const auditFailure = vi
        .spyOn(AuditLogRepository.prototype, 'create')
        .mockRejectedValueOnce(new Error('forced campaign audit failure'));
      try {
        const response = await invokeCampaign(`${campaignPrefix}-audit-failure`);
        expect(response.statusCode, response.body).toBe(500);
        const snapshot = await campaignSnapshot();
        expect(snapshot.emailJobs).toEqual([]);
        expect(snapshot.smsJobs).toEqual([]);
        expect(snapshot.idempotency).toEqual([]);
        expect(snapshot.audits).toEqual([]);
        expect(startNotificationDelivery).not.toHaveBeenCalled();
        expect(startSmsDelivery).not.toHaveBeenCalled();
      } finally {
        auditFailure.mockRestore();
      }
    });

    it('keeps the committed campaign recoverable when both Temporal starts fail', async () => {
      startNotificationDelivery.mockRejectedValueOnce(
        new Error(`Temporal email outage ${attendeeEmail} ${privateVariable}`),
      );
      startSmsDelivery.mockRejectedValueOnce(
        new Error(`Temporal SMS outage ${attendeePhone} ${privateVariable}`),
      );

      const response = await invokeCampaign(`${campaignPrefix}-temporal-start-failure`);

      expect(
        response.statusCode,
        `${response.body}\n${observedErrors.map((error) => error.stack).join('\n')}`,
      ).toBe(202);
      expect(response.json()).toMatchObject({
        status: 'failed',
        queuedEmailJobs: 0,
        queuedSmsJobs: 0,
        startFailedEmailJobs: 1,
        startFailedSmsJobs: 1,
      });
      const snapshot = await campaignSnapshot();
      expect(snapshot.emailJobs).toHaveLength(1);
      expect(snapshot.emailJobs[0]).toMatchObject({ status: 'start_failed', workflow_id: null });
      expect(snapshot.smsJobs).toHaveLength(1);
      expect(snapshot.smsJobs[0]).toMatchObject({ status: 'start_failed', workflow_id: null });
      expect(snapshot.idempotency).toHaveLength(1);
      expect(snapshot.audits).toHaveLength(1);
      expect(JSON.stringify(snapshot.audits)).not.toContain(attendeeEmail);
      expect(JSON.stringify(snapshot.audits)).not.toContain(attendeePhone);
      expect(JSON.stringify(snapshot.audits)).not.toContain(privateVariable);
    });

    it('derives bounded job keys from an exact-limit idempotency key and preserves replay lookup', async () => {
      const idempotencyKey = `k${'x'.repeat(254)}`;
      const first = await invokeCampaign(idempotencyKey);
      expect(first.statusCode, first.body).toBe(202);
      const firstBody = first.json<{ campaignId: string }>();
      expect(firstBody.campaignId).toMatch(/^msg_[a-f0-9]{64}$/u);

      const replay = await invokeCampaign(idempotencyKey);
      expect(replay.statusCode, replay.body).toBe(202);
      expect(replay.json()).toEqual(firstBody);

      const detail = await app.inject({
        method: 'GET',
        url: `/events/${eventA}/messages/${firstBody.campaignId}`,
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({ id: firstBody.campaignId, eventId: eventA });

      const snapshot = await campaignSnapshot();
      expect(snapshot.emailJobs).toHaveLength(1);
      expect(snapshot.smsJobs).toHaveLength(1);
      expect(snapshot.emailJobs[0].idempotency_key.length).toBeLessThanOrEqual(255);
      expect(snapshot.smsJobs[0].idempotency_key.length).toBeLessThanOrEqual(255);
      expect(snapshot.idempotency).toHaveLength(1);
      expect(startNotificationDelivery).toHaveBeenCalledTimes(1);
      expect(startSmsDelivery).toHaveBeenCalledTimes(1);
    });

    it('replays a pre-upgrade raw long-key ledger record without creating a second campaign', async () => {
      const idempotencyKey = `l${'y'.repeat(128)}`;
      const payload = campaignPayload();
      const legacyBody = {
        campaignId: idempotencyKey,
        eventId: eventA,
        channel: 'both',
        status: 'queued',
      };
      await db
        .insertInto('idempotency_records')
        .values({
          id: `idm_${ulid()}`,
          key: idempotencyKey,
          tenant_id: tenantA,
          request_hash: hashRequest({ eventId: eventA, body: payload }),
          response_status: 202,
          response_body: JSON.stringify(legacyBody),
          status: 'completed',
          created_at: new Date(),
          expires_at: new Date(Date.now() + 60_000),
        })
        .execute();

      const replay = await invokeCampaign(idempotencyKey, payload);

      expect(replay.statusCode, replay.body).toBe(202);
      expect(replay.json()).toEqual(legacyBody);
      const snapshot = await campaignSnapshot();
      expect(snapshot.emailJobs).toEqual([]);
      expect(snapshot.smsJobs).toEqual([]);
      expect(snapshot.idempotency).toHaveLength(1);
      expect(snapshot.audits).toEqual([]);
      expect(startNotificationDelivery).not.toHaveBeenCalled();
      expect(startSmsDelivery).not.toHaveBeenCalled();
    });

    it('serializes identical idempotency races to one durable campaign intent', async () => {
      const campaignId = `${campaignPrefix}-identical-race`;
      const barrier = installTwoPartyCheckpointBarrier(campaignId);
      const responses = Promise.all([invokeCampaign(campaignId), invokeCampaign(campaignId)]);
      await expectBoundedCheckpoint(barrier.bothReached, 'identical idempotency race');
      barrier.release();
      const [left, right] = await responses;
      expect(
        [left.statusCode, right.statusCode],
        `${left.body}\n${right.body}\n${observedErrors.map((error) => error.stack).join('\n')}`,
      ).toEqual([202, 202]);
      expect(left.json()).toEqual(right.json());
      const snapshot = await campaignSnapshot();
      expect(snapshot.emailJobs).toHaveLength(1);
      expect(snapshot.smsJobs).toHaveLength(1);
      expect(snapshot.idempotency).toHaveLength(1);
      expect(snapshot.audits).toHaveLength(1);
      expect(startNotificationDelivery).toHaveBeenCalledTimes(1);
      expect(startSmsDelivery).toHaveBeenCalledTimes(1);
    });

    it('rejects conflicting idempotency races without a second campaign intent', async () => {
      const campaignId = `${campaignPrefix}-conflicting-race`;
      const barrier = installTwoPartyCheckpointBarrier(campaignId);
      const responses = Promise.all([
        invokeCampaign(campaignId, campaignPayload({ variables: { version: 'left' } })),
        invokeCampaign(campaignId, campaignPayload({ variables: { version: 'right' } })),
      ]);
      await expectBoundedCheckpoint(barrier.bothReached, 'conflicting idempotency race');
      barrier.release();
      const [left, right] = await responses;
      expect(
        [left.statusCode, right.statusCode].sort((a, b) => a - b),
        `${left.body}\n${right.body}\n${observedErrors.map((error) => error.stack).join('\n')}`,
      ).toEqual([202, 409]);
      const snapshot = await campaignSnapshot();
      expect(snapshot.emailJobs).toHaveLength(1);
      expect(snapshot.smsJobs).toHaveLength(1);
      expect(snapshot.idempotency).toHaveLength(1);
      expect(snapshot.audits).toHaveLength(1);
      expect(startNotificationDelivery).toHaveBeenCalledTimes(1);
      expect(startSmsDelivery).toHaveBeenCalledTimes(1);
    });

    it('returns and audits exact durable campaign evidence without contact or variable PII', async () => {
      const campaignId = `${campaignPrefix}-no-pii`;
      const response = await invokeCampaign(campaignId);
      expect(response.statusCode, response.body).toBe(202);
      const body = response.json<Record<string, unknown>>();
      expect(body).toMatchObject({
        campaignId,
        eventId: eventA,
        channel: 'both',
        status: 'queued',
        audienceCount: 1,
        queuedEmailJobs: 1,
        queuedSmsJobs: 1,
        startFailedEmailJobs: 0,
        startFailedSmsJobs: 0,
        suppressedRecipients: 0,
        consentExclusions: 0,
        skippedRecipients: 0,
      });
      const snapshot = await campaignSnapshot();
      expect(snapshot.audits).toHaveLength(1);
      const audit = snapshot.audits[0];
      expect(audit).toMatchObject({
        tenant_id: tenantA,
        organization_id: organizationA,
        brand_id: brandA,
        actor_type: 'user',
        actor_id: actorId,
        action: 'event.message_campaign.queued',
        resource_type: 'MessageCampaign',
        resource_id: expect.stringMatching(/^msg_[a-f0-9]{28}$/u),
      });
      const diffSummary = databaseJson(audit.diff_summary);
      expect(diffSummary).toEqual({
        eventId: eventA,
        campaignIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        channel: 'both',
        audience: 'all',
        emailTemplateKey: 'campaign-email',
        smsTemplateKey: 'campaign-sms',
        emailTemplateVersionId: `cver_email_${runId}`,
        smsTemplateVersionId: `cver_sms_${runId}`,
        requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        audienceCount: 1,
        queuedEmailJobs: 1,
        queuedSmsJobs: 1,
        suppressedRecipients: 0,
        consentExclusions: 0,
        skippedRecipients: 0,
        emailJobIds: body.emailJobIds,
        smsJobIds: body.smsJobIds,
      });
      const responseEvidence = JSON.stringify(body);
      const auditEvidence = JSON.stringify(audit);
      for (const secret of [attendeeEmail, attendeePhone, privateVariable]) {
        expect(responseEvidence).not.toContain(secret);
        expect(auditEvidence).not.toContain(secret);
      }
      expect(audit.request_id).toMatch(/^req-/u);
      expect(audit.ip).toBe('127.0.0.1');
      expect(audit.user_agent).toBe('lightMyRequest');
    });
  },
);
