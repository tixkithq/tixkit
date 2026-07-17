import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import Fastify, { type FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { createDb, EventRepository, type Database } from '@tixkit/db';
import { ALL_PERMISSIONS, type Principal } from '@tixkit/domain';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { registerErrorHandler, type AppContext } from '../../app.js';
import { eventMediaRoutes } from '../../routes/modules/event-media.js';
import {
  describeWithIntegrationDatabase,
  integrationDatabaseDriver,
  integrationDatabaseUrl,
  restoreDatabaseDriver,
  setIntegrationDatabaseDriver,
} from './integration-database.js';
import { EVENT_MEDIA_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS } from './route-authorization-contracts.js';

const contracts = new Map(
  EVENT_MEDIA_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS.map((contract) => [
    contract.operationId,
    contract,
  ]),
);
function requiredContract(operationId: string) {
  const contract = contracts.get(operationId);
  if (!contract) throw new Error(`Missing event media write contract: ${operationId}`);
  return contract;
}

const putContract = requiredContract('putEventsByEventIdMediaByRole');
const deleteContract = requiredContract('deleteEventsByEventIdMediaByRole');

const suffix = ulid().slice(-10).toLowerCase();
const tenantA = `tnt_ema_auth_a_${suffix}`;
const tenantB = `tnt_ema_auth_b_${suffix}`;
const organizationA = `org_ema_auth_a_${suffix}`;
const organizationAScoped = `org_ema_auth_scope_${suffix}`;
const organizationB = `org_ema_auth_b_${suffix}`;
const brandA = `brd_ema_auth_a_${suffix}`;
const brandAScoped = `brd_ema_auth_scope_${suffix}`;
const brandB = `brd_ema_auth_b_${suffix}`;
const actorId = `usr_ema_auth_${suffix}`;
const uploadArtifactId = `upl_ema_auth_${suffix}`;

let app: FastifyInstance;
let db: Database;
let previousDriver: string | undefined;
let activePrincipal: Principal;
let basePrincipal: Principal;
let eventA: string;
let eventAScoped: string;
let eventB: string;
let sourceImage: Buffer;
let s3Send: ReturnType<typeof vi.spyOn>;

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
    slug: `${title.toLowerCase().replaceAll(' ', '-')}-${suffix}`,
    title,
    currency: 'USD',
    timezone: 'UTC',
    startsAt: new Date('2027-01-01T18:00:00.000Z'),
    endsAt: new Date('2027-01-01T22:00:00.000Z'),
    venue: { name: 'Event media authorization hall' },
  });
  return event.id;
}

async function seedUploadArtifact(): Promise<void> {
  const now = new Date('2026-07-17T12:00:00.000Z');
  await db
    .insertInto('upload_artifacts')
    .values({
      id: uploadArtifactId,
      tenant_id: tenantA,
      organization_id: organizationA,
      brand_id: brandA,
      event_id: eventA,
      created_by_user_id: actorId,
      purpose: 'event_cover',
      status: 'uploaded',
      scan_status: 'clean',
      scan_result: 'No malware detected',
      bucket: 'event-media-authorization',
      object_key: `uploads/${tenantA}/event-media/${eventA}/source.png`,
      file_name: 'cover.png',
      content_type: 'image/png',
      size_bytes: sourceImage.length,
      checksum_sha256: createHash('sha256').update(sourceImage).digest('hex'),
      client_token_hash: null,
      metadata: JSON.stringify({ image: { width: 64, height: 64, format: 'png' } }),
      consumed_by_checkout_session_id: null,
      consumed_at: null,
      completion_owner_token: null,
      completion_started_at: null,
      expires_at: new Date('2027-07-17T12:00:00.000Z'),
      created_at: now,
      updated_at: now,
    })
    .execute();
}

async function clearMediaEvidence(): Promise<void> {
  await db
    .deleteFrom('audit_logs')
    .where('actor_id', '=', actorId)
    .where('action', 'in', ['event.media.attach', 'event.media.remove'])
    .execute();
  await db
    .deleteFrom('media_object_cleanup_jobs')
    .where('tenant_id', 'in', [tenantA, tenantB])
    .execute();
  await db
    .deleteFrom('event_media_assets')
    .where('event_id', 'in', [eventA, eventAScoped, eventB])
    .execute();
}

async function evidenceSnapshot() {
  const [events, assets, renditions, cleanupJobs, artifacts, audits] = await Promise.all([
    db
      .selectFrom('events')
      .select(['id', 'public_revision', 'version'])
      .where('id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('event_media_assets')
      .selectAll()
      .where('event_id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('id')
      .execute(),
    db
      .selectFrom('event_media_renditions as rendition')
      .innerJoin('event_media_assets as asset', 'asset.id', 'rendition.asset_id')
      .selectAll('rendition')
      .where('asset.event_id', 'in', [eventA, eventAScoped, eventB])
      .orderBy('rendition.id')
      .execute(),
    db
      .selectFrom('media_object_cleanup_jobs')
      .selectAll()
      .where('tenant_id', 'in', [tenantA, tenantB])
      .orderBy('id')
      .execute(),
    db.selectFrom('upload_artifacts').selectAll().where('id', '=', uploadArtifactId).execute(),
    db
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .where('action', 'in', ['event.media.attach', 'event.media.remove'])
      .orderBy('id')
      .execute(),
  ]);
  return { events, assets, renditions, cleanupJobs, artifacts, audits };
}

function invokePut(targetEventId: string) {
  return app.inject({
    method: putContract.method,
    url: putContract.path.replace('{eventId}', targetEventId).replace('{role}', 'cover'),
    payload: {
      uploadArtifactId,
      altText: 'Authorization proof cover',
      focalPoint: { x: 0.5, y: 0.5 },
    },
  });
}

function invokeDelete(targetEventId: string) {
  return app.inject({
    method: deleteContract.method,
    url: deleteContract.path.replace('{eventId}', targetEventId).replace('{role}', 'cover'),
  });
}

describeWithIntegrationDatabase('event media write route authorization matrix', () => {
  beforeAll(async () => {
    previousDriver = setIntegrationDatabaseDriver();
    db = createDb(integrationDatabaseUrl());
    sourceImage = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#224466' },
    })
      .png()
      .toBuffer();

    await insertTenant(tenantA, 'Event media authorization tenant A');
    await insertTenant(tenantB, 'Event media authorization tenant B');
    await insertOrganization(organizationA, tenantA, 'Event media authorization org A');
    await insertOrganization(organizationAScoped, tenantA, 'Event media authorization scoped org');
    await insertOrganization(organizationB, tenantB, 'Event media authorization org B');
    await insertBrand(brandA, tenantA, organizationA, 'Event media authorization brand A');
    await insertBrand(
      brandAScoped,
      tenantA,
      organizationAScoped,
      'Event media authorization scoped brand',
    );
    await insertBrand(brandB, tenantB, organizationB, 'Event media authorization brand B');
    eventA = await createEvent(tenantA, organizationA, brandA, 'Allowed media event');
    eventAScoped = await createEvent(
      tenantA,
      organizationAScoped,
      brandAScoped,
      'Scoped media event',
    );
    eventB = await createEvent(tenantB, organizationB, brandB, 'Foreign media event');
    await seedUploadArtifact();

    basePrincipal = {
      type: 'user',
      id: actorId,
      tenantId: tenantA,
      organizationIds: [organizationA],
      scopes: [...ALL_PERMISSIONS],
    };
    activePrincipal = basePrincipal;
    app = Fastify({ logger: false });
    app.decorate('context', { db } as AppContext);
    app.addHook('onRequest', async (request) => {
      request.principal = activePrincipal;
    });
    registerErrorHandler(app);
    await app.register(eventMediaRoutes);
    await app.ready();

    s3Send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: unknown) => {
      if (command instanceof GetObjectCommand) {
        return { Body: { transformToByteArray: async () => sourceImage } } as never;
      }
      if (command instanceof PutObjectCommand) return {} as never;
      throw new Error(`Unexpected storage command: ${command?.constructor?.name ?? 'unknown'}`);
    });
  });

  beforeEach(async () => {
    activePrincipal = basePrincipal;
    await clearMediaEvidence();
    await db
      .updateTable('events')
      .set({ public_revision: new Date('2020-01-01T00:00:00.000Z') })
      .where('id', 'in', [eventA, eventAScoped, eventB])
      .execute();
    s3Send.mockClear();
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    await cleanup(() => app.close());
    s3Send?.mockRestore();
    await cleanup(clearMediaEvidence);
    await cleanup(() =>
      db.deleteFrom('upload_artifacts').where('id', '=', uploadArtifactId).execute(),
    );
    for (const eventId of [eventA, eventAScoped, eventB]) {
      await cleanup(() => db.deleteFrom('events').where('id', '=', eventId).execute());
    }
    for (const brandId of [brandA, brandAScoped, brandB]) {
      await cleanup(() => db.deleteFrom('brands').where('id', '=', brandId).execute());
    }
    for (const organizationId of [organizationA, organizationAScoped, organizationB]) {
      await cleanup(() =>
        db.deleteFrom('organizations').where('id', '=', organizationId).execute(),
      );
    }
    for (const tenantId of [tenantA, tenantB]) {
      await cleanup(() => db.deleteFrom('tenants').where('id', '=', tenantId).execute());
    }
    await cleanup(() => db.destroy());
    try {
      restoreDatabaseDriver(previousDriver);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to clean up event media authorization proof');
    }
  });

  it('binds both immutable route contracts to this executable proof', () => {
    expect(putContract).toMatchObject({
      authorizedControl: { status: 200 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      source: 'event-media-route-authorization-db.integration.test.ts',
    });
    expect(deleteContract).toMatchObject({
      authorizedControl: { status: 204 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      source: 'event-media-route-authorization-db.integration.test.ts',
    });
  });

  it('allows the exact principal to attach and remove media with durable state and audit evidence', async () => {
    const before = await evidenceSnapshot();
    const eventBefore = before.events.find((event) => event.id === eventA);
    const revisionBefore = eventBefore?.public_revision;

    const putResponse = await invokePut(eventA);
    expect(putResponse.statusCode, putResponse.body).toBe(putContract.authorizedControl.status);
    expect(
      s3Send.mock.calls.filter((call: unknown[]) => call[0] instanceof GetObjectCommand),
    ).toHaveLength(1);
    expect(
      s3Send.mock.calls.filter((call: unknown[]) => call[0] instanceof PutObjectCommand),
    ).toHaveLength(4);
    const attached = await evidenceSnapshot();
    expect(attached.assets).toHaveLength(1);
    expect(attached.assets[0]).toMatchObject({
      tenant_id: tenantA,
      organization_id: organizationA,
      brand_id: brandA,
      event_id: eventA,
      role: 'cover',
      upload_artifact_id: uploadArtifactId,
      alt_text: 'Authorization proof cover',
    });
    expect(attached.renditions).toHaveLength(4);
    const attachedCleanupObjects = attached.renditions
      .map((rendition) => ({
        tenant_id: tenantA,
        organization_id: organizationA,
        bucket: rendition.bucket,
        object_key: rendition.object_key,
        checksum_sha256: rendition.checksum_sha256,
      }))
      .sort((left, right) => left.object_key.localeCompare(right.object_key));
    expect(attached.audits).toHaveLength(1);
    expect(attached.audits[0]).toMatchObject({
      action: 'event.media.attach',
      actor_id: actorId,
      resource_id: eventA,
      tenant_id: tenantA,
      organization_id: organizationA,
      brand_id: brandA,
    });
    expect(
      attached.events.find((event) => event.id === eventA)?.public_revision?.getTime(),
    ).toBeGreaterThan(revisionBefore?.getTime() ?? 0);
    expect(attached.events.find((event) => event.id === eventA)?.version).toBeGreaterThan(
      eventBefore?.version ?? 0,
    );

    const storageCallsBeforeDelete = s3Send.mock.calls.length;
    const deleteResponse = await invokeDelete(eventA);
    expect(deleteResponse.statusCode, deleteResponse.body).toBe(
      deleteContract.authorizedControl.status,
    );
    expect(s3Send).toHaveBeenCalledTimes(storageCallsBeforeDelete);
    const removed = await evidenceSnapshot();
    expect(removed.assets).toHaveLength(0);
    expect(removed.renditions).toHaveLength(0);
    expect(removed.cleanupJobs).toHaveLength(4);
    expect(new Set(removed.cleanupJobs.map((job) => job.id)).size).toBe(4);
    expect(
      removed.cleanupJobs
        .map((job) => ({
          tenant_id: job.tenant_id,
          organization_id: job.organization_id,
          bucket: job.bucket,
          object_key: job.object_key,
          checksum_sha256: job.checksum_sha256,
        }))
        .sort((left, right) => left.object_key.localeCompare(right.object_key)),
    ).toEqual(attachedCleanupObjects);
    expect(
      removed.cleanupJobs.every(
        (job) => job.reason === 'event-media-removed' && job.status === 'pending',
      ),
    ).toBe(true);
    expect(
      removed.events.find((event) => event.id === eventA)?.public_revision?.getTime(),
    ).toBeGreaterThan(
      attached.events.find((event) => event.id === eventA)?.public_revision?.getTime() ?? 0,
    );
    expect(removed.events.find((event) => event.id === eventA)?.version).toBeGreaterThan(
      attached.events.find((event) => event.id === eventA)?.version ?? 0,
    );
    expect(removed.audits.map((audit) => audit.action)).toEqual([
      'event.media.attach',
      'event.media.remove',
    ]);
  });

  it.each([
    ['permission', () => ({ ...basePrincipal, scopes: [] }), () => eventA, 403, 'FORBIDDEN'],
    ['tenant', () => basePrincipal, () => eventB, 404, 'NOT_FOUND'],
    [
      'organization',
      () => ({ ...basePrincipal, organizationIds: [organizationA] }),
      () => eventAScoped,
      404,
      'NOT_FOUND',
    ],
    [
      'brand',
      () => ({
        ...basePrincipal,
        organizationIds: [organizationA, organizationAScoped],
        brandIds: [brandA],
      }),
      () => eventAScoped,
      404,
      'NOT_FOUND',
    ],
    [
      'event',
      () => ({
        ...basePrincipal,
        organizationIds: [organizationA, organizationAScoped],
        brandIds: [brandA, brandAScoped],
        eventIds: [eventA],
      }),
      () => eventAScoped,
      404,
      'NOT_FOUND',
    ],
  ] as const)(
    'denies the %s boundary before media, cleanup, audit, revision, upload, or object-storage mutation',
    async (_boundary, makePrincipal, targetEvent, expectedStatus, expectedCode) => {
      activePrincipal = makePrincipal();
      const before = await evidenceSnapshot();
      const storageCallsBefore = s3Send.mock.calls.length;

      for (const invoke of [invokePut, invokeDelete]) {
        const response = await invoke(targetEvent());
        expect(response.statusCode, response.body).toBe(expectedStatus);
        expect(response.json()).toMatchObject({ error: { code: expectedCode } });
      }

      await expect(evidenceSnapshot()).resolves.toEqual(before);
      expect(s3Send).toHaveBeenCalledTimes(storageCallsBefore);
    },
  );

  it(`uses the selected ${integrationDatabaseDriver()} integration driver`, () => {
    expect(['postgres', 'mysql']).toContain(integrationDatabaseDriver());
  });
});
