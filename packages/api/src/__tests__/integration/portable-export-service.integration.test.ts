import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDb,
  BrandRepository,
  ContentRepository,
  EventRepository,
  OrganizationRepository,
  PortableExportAuthorizationRepository,
  PortableExportRepository,
  runMigrations,
  TenantRepository,
  truncateAllData,
  type Database,
} from '@tixkit/db';
import {
  createDefaultEventPageDocument,
  eventPageMediaReference,
} from '@tixkit/content-event-page';
import {
  canonicalPortableJson,
  parsePortableJson,
  portableManifestSha256,
  signPortableManifest,
  type SignedPortableBundle,
} from '@tixkit/portability';
import {
  createPortableExportService,
  PORTABLE_EXPORT_API_VERSION,
  PORTABLE_EXPORT_DATA_SCHEMA_VERSION,
  type PortableExportArtifactStore,
  type PortableExportMediaStore,
} from '../../services/portable-export.js';
import { loadPublicEventMedia } from '../../routes/modules/public.js';
import { loadEventMediaThumbnails, removeEventMedia } from '../../services/event-media.js';
import { parseUploadArtifactMetadata } from '../../services/uploads.js';
import { createPortableHistoricalAuthorizationService } from '../../services/portable-export-authorization.js';
import sharp from 'sharp';

type DriverCase = { driver: 'postgres' | 'mysql'; url: string };
const requestedDriver = process.env.DB_INTEGRATION_DRIVER;
const cases = [
  { driver: 'postgres', url: process.env.DATABASE_URL ?? '' },
  { driver: 'mysql', url: process.env.DATABASE_URL_MYSQL ?? '' },
].filter(
  (item) => item.url && (!requestedDriver || item.driver === requestedDriver),
) as DriverCase[];
if (cases.length === 0)
  it.skip('portable export service integration (database URLs not configured)', () => {});

describe.sequential.each(cases)('portable export service: $driver', ({ driver, url }) => {
  let db: Database;
  let tenantId: string;
  let organizationId: string;
  const objects = new Map<string, Uint8Array>();
  const store: PortableExportArtifactStore = {
    async putIfAbsent(key, bytes) {
      if (objects.has(key)) return 'exists';
      objects.set(key, Uint8Array.from(bytes));
      return 'created';
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) throw new Error('missing test artifact');
      return Uint8Array.from(value);
    },
    async getIfExists(key) {
      const value = objects.get(key);
      return value ? Uint8Array.from(value) : undefined;
    },
  };
  const bundleKeys = generateKeyPairSync('ed25519');
  const payloadKeys = generateKeyPairSync('ed25519');

  beforeAll(async () => {
    process.env.DB_DRIVER = driver;
    await runMigrations(url);
    db = createDb(url);
    await truncateAllData(db);
    tenantId = (
      await new TenantRepository(db).create({
        name: `Portable API ${driver}`,
      })
    ).id;
    organizationId = (
      await new OrganizationRepository(db).create({
        tenantId,
        name: `Portable API ${driver}`,
        slug: `portable-api-${driver}`,
      })
    ).id;
  });

  afterAll(async () => db?.destroy());

  it('builds, persists, and exactly replays one signed organization artifact', async () => {
    const service = createPortableExportService({
      db,
      store,
      signing: {
        deploymentId: `deployment_${driver}_01`,
        operatingModel: 'self-hosted',
        bundleKeyId: 'bundle_key_01',
        bundlePrivateKey: bundleKeys.privateKey,
        payloadKeyId: 'payload_key_01',
        payloadPrivateKey: payloadKeys.privateKey,
      },
    });
    const request = {
      tenantId,
      organizationId,
      requestedBy: 'user_exporter',
      idempotencyKey: 'portable-api-replay',
    };
    const first = await service.exportConfiguration(request);
    const replay = await service.exportConfiguration(request);
    expect(replay.jobId).toBe(first.jobId);
    expect(replay.bundleId).toBe(first.bundleId);
    expect(replay.bytes).toEqual(first.bytes);

    const transport = parsePortableJson(new TextDecoder().decode(first.bytes)) as {
      envelope: SignedPortableBundle;
      payloads: Record<string, string>;
    };
    expect(transport.envelope.manifest).toMatchObject({
      schemaVersion: 2,
      format: 'tixkit-portable-bundle-v2',
      bundleId: first.bundleId,
      mode: 'configuration',
      source: {
        tenantId,
        deploymentId: `deployment_${driver}_01`,
        exportSequence: 1,
      },
    });
    expect(transport.envelope.manifest.compatibility.requiredCapabilities).toEqual([
      'portable-bundle-v2',
      'portable-content-documents-v1',
      'portable-rebinding-kinds-v2',
    ]);
    expect(transport.envelope.manifest.source.changeCursor).toMatch(
      /^snapshot-sha256:[a-f0-9]{64}$/u,
    );
    const job = await db
      .selectFrom('portable_export_jobs')
      .selectAll()
      .where('id', '=', first.jobId)
      .executeTakeFirstOrThrow();
    expect(job).toMatchObject({
      status: 'completed',
      manifest_sha256: portableManifestSha256(transport.envelope.manifest),
      artifact_sha256: createHash('sha256').update(first.bytes).digest('hex'),
    });
    expect(Number(job.artifact_bytes)).toBe(first.bytes.byteLength);
    expect(Object.keys(transport.payloads)).toContain('data/organizations.jsonl');
    const firstObjectKey = [...objects.keys()].find((key) => key.endsWith(`${first.jobId}.json`))!;
    const exportRepository = new PortableExportRepository(db);

    const persistCompatibilityParent = async (
      apiVersion: string,
      dataSchemaVersion: string,
      suffix: string,
    ) => {
      const parentJob = await exportRepository.begin({
        tenantId,
        organizationId,
        mode: 'configuration',
        requestedBy: 'compatibility_test',
        idempotencyKey: `compatibility-parent-${suffix}`,
        requestFingerprint: createHash('sha256').update(`parent:${suffix}`).digest('hex'),
      });
      const ownerSha256 = createHash('sha256').update(`owner:${suffix}`).digest('hex');
      const claimTime = new Date();
      expect(
        await exportRepository.claimBuild({
          tenantId,
          organizationId,
          jobId: parentJob.id,
          ownerSha256,
          now: claimTime,
          leaseExpiresAt: new Date(claimTime.getTime() + 60_000),
        }),
      ).toBe(true);
      const parentManifest = {
        ...transport.envelope.manifest,
        bundleId: parentJob.bundle_id,
        apiVersion,
        dataSchemaVersion,
        source: {
          ...transport.envelope.manifest.source,
          exportSequence: Number(parentJob.export_sequence),
        },
        compatibility: {
          ...transport.envelope.manifest.compatibility,
          minimumDataSchemaVersion: dataSchemaVersion,
          maximumDataSchemaVersion: dataSchemaVersion,
        },
      };
      const parentEnvelope = {
        manifest: parentManifest,
        signature: signPortableManifest(parentManifest, 'bundle_key_01', bundleKeys.privateKey),
      };
      const bytes = new TextEncoder().encode(
        canonicalPortableJson({
          envelope: parentEnvelope,
          payloads: transport.payloads,
        }),
      );
      const manifestSha256 = portableManifestSha256(parentManifest);
      const artifactSha256 = createHash('sha256').update(bytes).digest('hex');
      objects.set(firstObjectKey.replace(first.jobId, parentJob.id), bytes);
      await exportRepository.recordSnapshotCursor({
        tenantId,
        organizationId,
        jobId: parentJob.id,
        ownerSha256,
        sourceChangeCursor: parentManifest.source.changeCursor,
        now: new Date(),
      });
      await exportRepository.complete({
        tenantId,
        organizationId,
        jobId: parentJob.id,
        ownerSha256,
        manifestSha256,
        artifactSha256,
        artifactBytes: bytes.byteLength,
      });
      return parentJob.id;
    };

    for (const [apiVersion, dataSchemaVersion, suffix] of [
      ['2026-07-16', '0080', '16_80'],
      ['2026-07-17', '0079', '17_79'],
    ] as const) {
      const parentExportJobId = await persistCompatibilityParent(
        apiVersion,
        dataSchemaVersion,
        suffix,
      );
      await expect(
        service.exportConfiguration({
          ...request,
          idempotencyKey: `portable-api-cross-pair-${suffix}`,
          parentExportJobId,
        }),
      ).rejects.toThrow('PORTABLE_EXPORT_ARTIFACT_CONFLICT');
    }

    const legacyJob = await exportRepository.begin({
      tenantId,
      organizationId,
      mode: 'configuration',
      requestedBy: 'legacy_exporter',
      idempotencyKey: 'portable-api-legacy-parent',
      requestFingerprint: createHash('sha256').update('legacy-parent').digest('hex'),
    });
    const legacyOwnerSha256 = createHash('sha256').update('legacy-owner').digest('hex');
    const legacyNow = new Date();
    expect(
      await exportRepository.claimBuild({
        tenantId,
        organizationId,
        jobId: legacyJob.id,
        ownerSha256: legacyOwnerSha256,
        now: legacyNow,
        leaseExpiresAt: new Date(legacyNow.getTime() + 60_000),
      }),
    ).toBe(true);
    const legacyManifest = {
      ...transport.envelope.manifest,
      bundleId: legacyJob.bundle_id,
      apiVersion: '2026-07-16',
      dataSchemaVersion: '0079',
      source: {
        ...transport.envelope.manifest.source,
        exportSequence: Number(legacyJob.export_sequence),
      },
      compatibility: {
        ...transport.envelope.manifest.compatibility,
        minimumDataSchemaVersion: '0079',
        maximumDataSchemaVersion: '0079',
      },
    };
    const legacyEnvelope = {
      manifest: legacyManifest,
      signature: signPortableManifest(legacyManifest, 'bundle_key_01', bundleKeys.privateKey),
    };
    const legacyBytes = new TextEncoder().encode(
      canonicalPortableJson({
        envelope: legacyEnvelope,
        payloads: transport.payloads,
      }),
    );
    const legacyObjectKey = firstObjectKey.replace(first.jobId, legacyJob.id);
    objects.set(legacyObjectKey, legacyBytes);
    const legacyManifestSha256 = portableManifestSha256(legacyManifest);
    const legacyArtifactSha256 = createHash('sha256').update(legacyBytes).digest('hex');
    await exportRepository.recordSnapshotCursor({
      tenantId,
      organizationId,
      jobId: legacyJob.id,
      ownerSha256: legacyOwnerSha256,
      sourceChangeCursor: legacyManifest.source.changeCursor,
      now: new Date(),
    });
    await exportRepository.complete({
      tenantId,
      organizationId,
      jobId: legacyJob.id,
      ownerSha256: legacyOwnerSha256,
      manifestSha256: legacyManifestSha256,
      artifactSha256: legacyArtifactSha256,
      artifactBytes: legacyBytes.byteLength,
    });

    await db
      .updateTable('organizations')
      .set({ name: `Portable API delta ${driver}` })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', organizationId)
      .execute();
    const deltaRequest = {
      ...request,
      idempotencyKey: 'portable-api-delta-replay',
      parentExportJobId: legacyJob.id,
    };
    const delta = await service.exportConfiguration(deltaRequest);
    expect((await service.exportConfiguration(deltaRequest)).bytes).toEqual(delta.bytes);
    const deltaTransport = parsePortableJson(new TextDecoder().decode(delta.bytes)) as {
      envelope: SignedPortableBundle;
      parentEnvelope: SignedPortableBundle;
    };
    expect(deltaTransport.parentEnvelope).toEqual(legacyEnvelope);
    expect(deltaTransport.envelope.manifest).toMatchObject({
      dataSchemaVersion: PORTABLE_EXPORT_DATA_SCHEMA_VERSION,
      source: { exportSequence: Number(legacyJob.export_sequence) + 1 },
      lineage: {
        kind: 'delta',
        parentBundleId: legacyJob.bundle_id,
        parentManifestSha256: legacyManifestSha256,
        fromChangeCursor: legacyManifest.lineage.toChangeCursor,
      },
    });

    const finalDelta = await service.exportConfiguration({
      ...request,
      idempotencyKey: 'portable-api-final-delta',
      parentExportJobId: delta.jobId,
      cutoverFreeze: {
        frozenAt: '2026-07-12T23:59:00.000Z',
        receiptSha256: 'f'.repeat(64),
      },
    });
    const finalTransport = parsePortableJson(new TextDecoder().decode(finalDelta.bytes)) as {
      envelope: SignedPortableBundle;
      parentEnvelope: SignedPortableBundle;
    };
    expect(finalTransport.parentEnvelope).toEqual(deltaTransport.envelope);
    expect(finalTransport.envelope.manifest).toMatchObject({
      source: { exportSequence: Number(legacyJob.export_sequence) + 2 },
      lineage: {
        kind: 'delta',
        parentBundleId: delta.bundleId,
        cutoverFreeze: {
          frozenAt: '2026-07-12T23:59:00.000Z',
          receiptSha256: 'f'.repeat(64),
        },
      },
    });

    await db
      .updateTable('portable_export_jobs')
      .set({ bundle_id: 'bundle_mutated_identity_01' })
      .where('id', '=', first.jobId)
      .execute();
    await expect(service.exportConfiguration(request)).rejects.toThrow(/IMMUTABLE_EVIDENCE/u);
    await db
      .updateTable('portable_export_jobs')
      .set({ bundle_id: first.bundleId })
      .where('id', '=', first.jobId)
      .execute();

    const stored = objects.get(firstObjectKey)!;
    objects.set(firstObjectKey, Uint8Array.from([...stored.slice(0, -1), stored.at(-1)! ^ 1]));
    await expect(service.exportConfiguration(request)).rejects.toThrow(/EVIDENCE_MISMATCH/u);
  });

  it('requires destination rebinding without exporting provider, endpoint, or credential values', async () => {
    const brand = await new BrandRepository(db).create({
      tenantId,
      organizationId,
      name: `Portable bindings ${driver}`,
      slug: `portable-bindings-${driver}`,
    });
    const now = new Date('2026-07-12T22:00:00.000Z');
    const taxStatusCases = [
      { id: `txr_active_${driver}`, status: 'active', required: true },
      { id: `txr_inactive_${driver}`, status: 'inactive', required: false },
      { id: `txr_pending_${driver}`, status: 'pending', required: false },
      { id: `txr_revoked_${driver}`, status: 'revoked', required: false },
    ] as const;
    const walletStatusCases = [
      {
        id: `wcr_active_expired_${driver}`,
        status: 'active',
        expiresAt: new Date('2025-07-12T22:00:00.000Z'),
        required: true,
      },
      {
        id: `wcr_active_${driver}`,
        status: 'active',
        expiresAt: new Date('2027-07-12T22:00:00.000Z'),
        required: true,
      },
      {
        id: `wcr_expired_${driver}`,
        status: 'expired',
        expiresAt: now,
        required: false,
      },
      {
        id: `wcr_inactive_${driver}`,
        status: 'inactive',
        expiresAt: null,
        required: false,
      },
      {
        id: `wcr_pending_${driver}`,
        status: 'pending',
        expiresAt: null,
        required: false,
      },
      {
        id: `wcr_revoked_${driver}`,
        status: 'revoked',
        expiresAt: null,
        required: false,
      },
    ] as const;
    await Promise.all([
      db
        .insertInto('payment_accounts')
        .values({
          id: `binding_shared_${driver}`,
          tenant_id: tenantId,
          organization_id: organizationId,
          provider: 'stripe_connect',
          provider_account_id: 'acct_must_not_export',
          status: 'active',
          default_currency: 'USD',
          details_submitted: true,
          charges_enabled: true,
          payouts_enabled: true,
          requirements: null,
          disabled_reason: null,
          created_at: now,
          updated_at: now,
        })
        .execute(),
      db
        .insertInto('tax_registrations')
        .values(
          taxStatusCases.map(({ id, status }, index) => ({
            id,
            tenant_id: tenantId,
            organization_id: organizationId,
            provider: 'managed_tax',
            jurisdiction_code: `US-${String(index).padStart(2, '0')}`,
            registration_type: 'sales_tax',
            custody_reference: `AUTHORITY_CUSTODY_MUST_NOT_EXPORT_${id}`,
            status,
            created_at: now,
            updated_at: now,
          })),
        )
        .execute(),
      db
        .insertInto('wallet_credentials')
        .values(
          walletStatusCases.map(({ id, status, expiresAt }, index) => ({
            id,
            tenant_id: tenantId,
            organization_id: organizationId,
            brand_id: brand.id,
            provider: 'apple_wallet',
            credential_type: `pass_signing_${index}`,
            custody_reference: `AUTHORITY_CUSTODY_MUST_NOT_EXPORT_${id}`,
            status,
            expires_at: expiresAt,
            created_at: now,
            updated_at: now,
          })),
        )
        .execute(),
      db
        .insertInto('brand_domains')
        .values({
          id: `bd_portable_${driver}`,
          brand_id: brand.id,
          domain: 'portable-source.example.test',
          is_primary: true,
          is_verified: true,
          verification_token: 'domain-token-must-not-export',
          ssl_status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute(),
      db
        .insertInto('sender_identities')
        .values({
          id: `si_portable_${driver}`,
          tenant_id: tenantId,
          organization_id: organizationId,
          brand_id: brand.id,
          email: 'source-sender@example.test',
          name: 'Source sender',
          verified: false,
          provider_type: 'resend',
          created_at: now,
          updated_at: now,
        })
        .execute(),
      db
        .insertInto('brand_sender_identities')
        .values({
          id: `bsi_portable_${driver}`,
          tenant_id: tenantId,
          brand_id: brand.id,
          email: 'verified-source@example.test',
          name: 'Verified source',
          reply_to_email: 'reply-source@example.test',
          verified: true,
          verified_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute(),
      db
        .insertInto('sms_sender_identities')
        .values({
          id: `ssi_portable_${driver}`,
          tenant_id: tenantId,
          brand_id: brand.id,
          sender: '+15555550100',
          kind: 'long_code',
          provider_type: 'twilio',
          provider_sender_id: 'PN_must_not_export',
          verified: true,
          verified_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute(),
      db
        .insertInto('webhook_endpoints')
        .values({
          id: `binding_shared_${driver}`,
          tenant_id: tenantId,
          organization_id: organizationId,
          url: 'https://hooks.source.example.test/tixkit',
          secret: 'whsec_must_not_export',
          events: JSON.stringify(['order.completed']),
          status: 'active',
          description: 'Source webhook',
          created_at: now,
          updated_at: now,
        })
        .execute(),
      db
        .insertInto('oauth_applications')
        .values({
          id: `oa_portable_${driver}`,
          tenant_id: tenantId,
          organization_id: organizationId,
          name: 'Source OAuth application',
          client_id: `oauth_client_must_not_export_${driver}`,
          client_secret_hash: 'oauth-secret-hash-must-not-export',
          redirect_uris: JSON.stringify(['https://source.example.test/oauth/callback']),
          scopes: JSON.stringify(['events.read']),
          subject_type: 'resource_owner',
          agent_principal_id: null,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ]);
    await Promise.all([
      db
        .insertInto('email_provider_routes')
        .values({
          id: `epr_portable_${driver}`,
          tenant_id: tenantId,
          brand_id: brand.id,
          provider_type: 'resend',
          credentials_ref: 'EMAIL_PROVIDER_SECRET_MUST_NOT_EXPORT',
          sender_domain: 'mail-source.example.test',
          priority: 0,
          is_fallback: false,
          rate_limit_per_hour: 1000,
          allowed_categories: JSON.stringify(['transactional']),
          status: 'active',
          smoke_send_verified: true,
          created_at: now,
          updated_at: now,
        })
        .execute(),
      db
        .insertInto('sms_provider_routes')
        .values({
          id: `spr_portable_${driver}`,
          tenant_id: tenantId,
          brand_id: brand.id,
          provider_type: 'twilio',
          credentials_ref: 'SMS_PROVIDER_SECRET_MUST_NOT_EXPORT',
          sender_identity_id: `ssi_portable_${driver}`,
          priority: 0,
          is_fallback: false,
          rate_limit_per_hour: 1000,
          allowed_categories: JSON.stringify(['transactional']),
          status: 'active',
          smoke_send_verified: false,
          webhook_url: 'https://sms-source.example.test/provider-webhook',
          created_at: now,
          updated_at: now,
        })
        .execute(),
      db
        .insertInto('marketing_integrations')
        .values({
          id: `mi_portable_${driver}`,
          tenant_id: tenantId,
          organization_id: organizationId,
          brand_id: brand.id,
          event_id: null,
          provider: 'meta_pixel',
          config: JSON.stringify({
            accessToken: 'MARKETING_SECRET_MUST_NOT_EXPORT',
          }),
          consent_required: true,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute(),
    ]);
    const service = createPortableExportService({
      db,
      store,
      signing: {
        deploymentId: `deployment_${driver}_bindings`,
        operatingModel: 'self-hosted',
        bundleKeyId: 'bundle_key_01',
        bundlePrivateKey: bundleKeys.privateKey,
        payloadKeyId: 'payload_key_01',
        payloadPrivateKey: payloadKeys.privateKey,
      },
    });
    const exported = await service.exportConfiguration({
      tenantId,
      organizationId,
      requestedBy: 'user_exporter',
      idempotencyKey: 'portable-api-rebindings',
    });
    const transportText = new TextDecoder().decode(exported.bytes);
    const transport = parsePortableJson(transportText) as {
      envelope: SignedPortableBundle;
      payloads: Record<string, string>;
    };

    expect(transport.envelope.manifest.rebindings).toEqual(
      [
        {
          kind: 'custom_domain',
          portableId: `custom_domain:bd_portable_${driver}`,
          required: true,
        },
        {
          kind: 'email_delivery_route',
          portableId: `email_delivery_route:epr_portable_${driver}`,
          required: true,
        },
        {
          kind: 'marketing_integration',
          portableId: `marketing_integration:mi_portable_${driver}`,
          required: true,
        },
        {
          kind: 'oauth_redirect_origin',
          portableId: `oauth_redirect_origin:oa_portable_${driver}`,
          required: true,
        },
        {
          kind: 'payment_provider_account',
          portableId: `payment_provider_account:binding_shared_${driver}`,
          required: true,
        },
        {
          kind: 'sending_identity',
          portableId: `sending_identity:email:bsi_portable_${driver}`,
          required: true,
        },
        {
          kind: 'sending_identity',
          portableId: `sending_identity:organization:si_portable_${driver}`,
          required: false,
        },
        {
          kind: 'sending_identity',
          portableId: `sending_identity:sms:ssi_portable_${driver}`,
          required: true,
        },
        {
          kind: 'sms_delivery_route',
          portableId: `sms_delivery_route:spr_portable_${driver}`,
          required: false,
        },
        ...taxStatusCases.map(({ id, required }) => ({
          kind: 'tax_registration' as const,
          portableId: `tax_registration:${id}`,
          required,
        })),
        ...walletStatusCases.map(({ id, required }) => ({
          kind: 'wallet_credential' as const,
          portableId: `wallet_credential:${id}`,
          required,
        })),
        {
          kind: 'webhook_endpoint',
          portableId: `webhook_endpoint:binding_shared_${driver}`,
          required: true,
        },
      ].sort((left, right) => (left.portableId < right.portableId ? -1 : 1)),
    );
    const decodedEvidence = `${canonicalPortableJson(transport.envelope.manifest)}${Object.values(
      transport.payloads,
    )
      .map((payload) => Buffer.from(payload, 'base64').toString('utf8'))
      .join('\n')}`;
    expect(decodedEvidence).not.toMatch(
      /acct_must_not_export|domain-token-must-not-export|source-sender@example\.test|verified-source@example\.test|PN_must_not_export|hooks\.source\.example\.test|whsec_must_not_export|oauth_client_must_not_export|oauth-secret-hash-must-not-export|source\.example\.test\/oauth|EMAIL_PROVIDER_SECRET_MUST_NOT_EXPORT|SMS_PROVIDER_SECRET_MUST_NOT_EXPORT|sms-source\.example\.test|MARKETING_SECRET_MUST_NOT_EXPORT|AUTHORITY_CUSTODY_MUST_NOT_EXPORT/u,
    );

    await db
      .updateTable('sender_identities')
      .set({
        verified: true,
        updated_at: new Date('2026-07-12T22:01:00.000Z'),
      })
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('id', '=', `si_portable_${driver}`)
      .execute();
    const changed = await service.exportConfiguration({
      tenantId,
      organizationId,
      requestedBy: 'user_exporter',
      idempotencyKey: 'portable-api-rebindings-changed',
    });
    const changedManifest = (
      parsePortableJson(new TextDecoder().decode(changed.bytes)) as {
        envelope: SignedPortableBundle;
      }
    ).envelope.manifest;
    expect(changedManifest.source.changeCursor).not.toBe(
      transport.envelope.manifest.source.changeCursor,
    );
    expect(
      changedManifest.rebindings.find(({ portableId }) => portableId === `si_portable_${driver}`),
    ).toBeUndefined();
    expect(
      changedManifest.rebindings.find(
        ({ portableId }) => portableId === `sending_identity:organization:si_portable_${driver}`,
      ),
    ).toMatchObject({ kind: 'sending_identity', required: true });
  });

  it('exports owned event media as sanitized signed binary assets', async () => {
    const brand = await new BrandRepository(db).create({
      tenantId,
      organizationId,
      name: `Portable media ${driver}`,
      slug: `portable-media-${driver}`,
    });
    const event = await new EventRepository(db).create({
      tenantId,
      organizationId,
      brandId: brand.id,
      slug: `portable-media-${driver}`,
      title: 'Portable media event',
      currency: 'USD',
      timezone: 'UTC',
      startsAt: new Date('2027-01-01T00:00:00Z'),
    });
    const original = await sharp({
      create: {
        width: 1600,
        height: 1000,
        channels: 3,
        background: '#7c3aed',
      },
    })
      .jpeg()
      .withMetadata({ orientation: 1 })
      .toBuffer();
    const checksum = createHash('sha256').update(original).digest('hex');
    const now = new Date();
    const uploadId = `upl_media_${driver}`;
    const assetId = `ema_media_${driver}`;
    await db
      .insertInto('upload_artifacts')
      .values({
        id: uploadId,
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: brand.id,
        event_id: event.id,
        created_by_user_id: null,
        purpose: 'event_cover',
        status: 'uploaded',
        scan_status: 'clean',
        scan_result: 'clean',
        bucket: 'media',
        object_key: `uploads/${event.id}/final/${uploadId}.jpg/${checksum}`,
        file_name: 'cover.jpg',
        content_type: 'image/jpeg',
        size_bytes: original.byteLength,
        checksum_sha256: checksum,
        client_token_hash: null,
        metadata: JSON.stringify({
          image: { width: 1600, height: 1000, format: 'jpeg' },
        }),
        consumed_by_checkout_session_id: null,
        consumed_at: null,
        completion_owner_token: null,
        completion_started_at: null,
        expires_at: new Date('2028-01-01T00:00:00Z'),
        created_at: now,
        updated_at: now,
      })
      .execute();
    const persistedUpload = await db
      .selectFrom('upload_artifacts')
      .select('metadata')
      .where('id', '=', uploadId)
      .executeTakeFirstOrThrow();
    expect(parseUploadArtifactMetadata(persistedUpload.metadata)).toEqual({
      image: { width: 1600, height: 1000, format: 'jpeg' },
    });
    await db
      .insertInto('event_media_assets')
      .values({
        id: assetId,
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: brand.id,
        event_id: event.id,
        upload_artifact_id: uploadId,
        role: 'cover',
        width: 1600,
        height: 1000,
        format: 'jpeg',
        checksum_sha256: checksum,
        size_bytes: original.byteLength,
        focal_x: '0.5',
        focal_y: '0.5',
        alt_text: 'Purple event cover',
        created_by: 'usr_exporter',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('event_media_renditions')
      .values([
        {
          id: `emr_media_${driver}`,
          asset_id: assetId,
          variant: 'page',
          width: 1600,
          height: 900,
          format: 'webp',
          content_type: 'image/webp',
          bucket: 'media',
          object_key: `event-media/${event.id}/${assetId}/page.webp`,
          checksum_sha256: 'b'.repeat(64),
          size_bytes: 1024,
          created_at: now,
        },
        {
          id: `emr_thumbnail_${driver}`,
          asset_id: assetId,
          variant: 'thumbnail',
          width: 480,
          height: 270,
          format: 'webp',
          content_type: 'image/webp',
          bucket: 'media',
          object_key: `event-media/${event.id}/${assetId}/thumbnail.webp`,
          checksum_sha256: 'c'.repeat(64),
          size_bytes: 512,
          created_at: now,
        },
      ])
      .execute();
    expect(await loadPublicEventMedia(db, event.id)).toEqual([
      {
        role: 'cover',
        altText: 'Purple event cover',
        focalPoint: { x: 0.5, y: 0.5 },
        renditions: [
          {
            variant: 'page',
            width: 1600,
            height: 900,
            url: `/v1/public/event-media/renditions/emr_media_${driver}`,
          },
          {
            variant: 'thumbnail',
            width: 480,
            height: 270,
            url: `/v1/public/event-media/renditions/emr_thumbnail_${driver}`,
          },
        ],
      },
    ]);
    expect(
      (await loadEventMediaThumbnails(db, { tenantId, eventIds: [event.id] })).get(event.id),
    ).toEqual({
      renditionId: `emr_thumbnail_${driver}`,
      role: 'cover',
      variant: 'thumbnail',
      altText: 'Purple event cover',
      width: 480,
      height: 270,
      checksumSha256: 'c'.repeat(64),
      url: `/v1/events/${event.id}/media/renditions/emr_thumbnail_${driver}`,
    });
    expect(
      await loadEventMediaThumbnails(db, {
        tenantId: `tnt_other_${driver}`,
        eventIds: [event.id],
      }),
    ).toEqual(new Map());
    const mediaStore: PortableExportMediaStore = {
      async read(bucket, objectKey, maximumBytes) {
        expect({ bucket, objectKey, maximumBytes }).toEqual({
          bucket: 'media',
          objectKey: `uploads/${event.id}/final/${uploadId}.jpg/${checksum}`,
          maximumBytes: original.byteLength,
        });
        return original;
      },
    };
    const service = createPortableExportService({
      db,
      store,
      mediaStore,
      signing: {
        deploymentId: `deployment_${driver}_01`,
        operatingModel: 'self-hosted',
        bundleKeyId: 'bundle_key_01',
        bundlePrivateKey: bundleKeys.privateKey,
        payloadKeyId: 'payload_key_01',
        payloadPrivateKey: payloadKeys.privateKey,
      },
    });
    const exported = await service.exportConfiguration({
      tenantId,
      organizationId,
      requestedBy: 'user_exporter',
      idempotencyKey: `portable-media-${driver}`,
    });
    const transport = parsePortableJson(new TextDecoder().decode(exported.bytes)) as {
      envelope: SignedPortableBundle;
      payloads: Record<string, string>;
    };
    expect(transport.envelope.manifest.assets).toEqual([
      expect.objectContaining({
        portableId: assetId,
        mediaType: 'image/webp',
        role: `event-media:${event.id}:cover:original`,
      }),
    ]);
    const asset = transport.envelope.manifest.assets[0]!;
    const sanitized = Buffer.from(transport.payloads[asset.path]!, 'base64');
    expect(createHash('sha256').update(sanitized).digest('hex')).toBe(asset.sha256);
    const metadata = await sharp(sanitized).metadata();
    expect(metadata).toMatchObject({
      format: 'webp',
      width: 1600,
      height: 1000,
    });
    expect(metadata.exif).toBeUndefined();
    const socialAssetId = `ema_social_${driver}`;
    await db
      .insertInto('event_media_assets')
      .values({
        id: socialAssetId,
        tenant_id: tenantId,
        organization_id: organizationId,
        brand_id: brand.id,
        event_id: event.id,
        upload_artifact_id: uploadId,
        role: 'social',
        width: 1600,
        height: 1000,
        format: 'jpeg',
        checksum_sha256: checksum,
        size_bytes: original.byteLength,
        focal_x: '0.5',
        focal_y: '0.5',
        alt_text: 'Purple social preview',
        created_by: 'usr_exporter',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('event_media_renditions')
      .values({
        id: `emr_social_guard_${driver}`,
        asset_id: socialAssetId,
        variant: 'social',
        width: 1200,
        height: 630,
        format: 'webp',
        content_type: 'image/webp',
        bucket: 'media',
        object_key: `event-media/${event.id}/${socialAssetId}/social.webp`,
        checksum_sha256: 'd'.repeat(64),
        size_bytes: 768,
        created_at: now,
      })
      .execute();
    const content = new ContentRepository(db);
    const mediaDocument = await content.createDocument({
      tenantId,
      organizationId,
      brandId: brand.id,
      eventId: event.id,
      channel: 'event_page',
      key: 'media-removal-guard',
      name: 'Media removal guard',
      locale: 'en',
    });
    const explicitRenditionUrl = `/v1/public/event-media/renditions/emr_media_${driver}`;
    const mediaVersion = await content.createVersion({
      documentId: mediaDocument.id,
      contentJson: createDefaultEventPageDocument({
        eventId: event.id,
        eventTitle: 'Portable media event',
        coverImageUrl: explicitRenditionUrl,
      }),
      variables: [],
      validation: { valid: true, severity: 'warning', issues: [] },
      createdBy: 'usr_exporter',
    });
    await db
      .updateTable('content_document_versions')
      .set({ status: 'published', published_at: now })
      .where('id', '=', mediaVersion.id)
      .execute();
    await db
      .updateTable('content_documents')
      .set({
        status: 'published',
        published_version_id: mediaVersion.id,
        current_draft_version_id: null,
        updated_at: now,
      })
      .where('id', '=', mediaDocument.id)
      .execute();
    const explicitUrlConflict = await removeEventMedia({
      db,
      tenantId,
      organizationId,
      brandId: brand.id,
      eventId: event.id,
      role: 'cover',
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(explicitUrlConflict).toMatchObject({
      code: 'CONFLICT',
      details: {
        code: 'EVENT_MEDIA_ROLE_REFERENCED',
        role: 'cover',
        referenceCount: 5,
        references: expect.arrayContaining([
          expect.objectContaining({
            path: 'editor.data.root.props.coverImageUrl',
          }),
        ]),
      },
    });
    expect(
      await db
        .selectFrom('media_object_cleanup_jobs')
        .select('id')
        .where('object_key', 'in', [
          `event-media/${event.id}/${assetId}/page.webp`,
          `event-media/${event.id}/${assetId}/thumbnail.webp`,
        ])
        .execute(),
    ).toEqual([]);
    await db
      .updateTable('content_document_versions')
      .set({ content_json: '{"schemaVersion":"2", "escaped":"tixkit:event-media:\\u0073ocial"' })
      .where('id', '=', mediaVersion.id)
      .execute();
    await expect(
      removeEventMedia({
        db,
        tenantId,
        organizationId,
        brandId: brand.id,
        eventId: event.id,
        role: 'social',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: {
        code: 'EVENT_MEDIA_ROLE_REFERENCED',
        role: 'social',
        referenceCount: 1,
        references: [
          expect.objectContaining({
            path: 'unparseable-published-content',
          }),
        ],
      },
    });
    expect(
      await db
        .selectFrom('media_object_cleanup_jobs')
        .select('id')
        .where('object_key', '=', `event-media/${event.id}/${socialAssetId}/social.webp`)
        .execute(),
    ).toEqual([]);
    const boundedReferenceDocument = createDefaultEventPageDocument({
      eventId: event.id,
      eventTitle: 'Portable media event',
      coverImageUrl: eventPageMediaReference('cover'),
    });
    const overlongZoneName = 'overflow-zone-'.repeat(20);
    boundedReferenceDocument.editor.data.zones = {
      [overlongZoneName]: Array.from({ length: 60 }, (_, index) => ({
        type: 'Media' as const,
        props: {
          id: `overflow-media-${index}`,
          imageUrl: eventPageMediaReference('cover'),
          imageAlt: 'Purple event cover',
        },
      })),
    };
    await db
      .updateTable('content_document_versions')
      .set({ content_json: JSON.stringify(boundedReferenceDocument) })
      .where('id', '=', mediaVersion.id)
      .execute();
    await expect(
      removeEventMedia({
        db,
        tenantId,
        organizationId,
        brandId: brand.id,
        eventId: event.id,
        role: 'social',
      }),
    ).resolves.toBe(true);
    expect(
      await db
        .selectFrom('event_media_assets')
        .select('id')
        .where('id', '=', assetId)
        .executeTakeFirst(),
    ).toBeDefined();
    const boundedConflict = await removeEventMedia({
      db,
      tenantId,
      organizationId,
      brandId: brand.id,
      eventId: event.id,
      role: 'cover',
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(boundedConflict).toMatchObject({
      code: 'CONFLICT',
      details: {
        code: 'EVENT_MEDIA_ROLE_REFERENCED',
        role: 'cover',
        referenceCount: 65,
      },
    });
    const boundedDetails = (
      boundedConflict as {
        details: {
          references: Array<{
            documentId: string;
            versionId: string;
            surface: string;
            path: string;
          }>;
        };
      }
    ).details;
    expect(boundedDetails.references).toHaveLength(50);
    expect(
      boundedDetails.references.every((reference) =>
        Object.values(reference).every((value) => value.length <= 200),
      ),
    ).toBe(true);
    expect(boundedDetails.references.some((reference) => reference.path.length === 200)).toBe(true);
    expect(
      await db
        .selectFrom('event_media_assets')
        .select('id')
        .where('id', '=', assetId)
        .executeTakeFirst(),
    ).toBeDefined();
    await db
      .updateTable('content_documents')
      .set({ status: 'archived', updated_at: new Date() })
      .where('id', '=', mediaDocument.id)
      .execute();
    const foreignTenant = await new TenantRepository(db).create({
      name: `Foreign media ${driver}`,
    });
    const foreignOrganization = await new OrganizationRepository(db).create({
      tenantId: foreignTenant.id,
      name: `Foreign media ${driver}`,
      slug: `foreign-media-${driver}`,
    });
    const foreignBrand = await new BrandRepository(db).create({
      tenantId: foreignTenant.id,
      organizationId: foreignOrganization.id,
      name: `Foreign media ${driver}`,
      slug: `foreign-media-${driver}`,
    });
    const foreignContent = new ContentRepository(db);
    const foreignDocument = await foreignContent.createDocument({
      tenantId: foreignTenant.id,
      organizationId: foreignOrganization.id,
      brandId: foreignBrand.id,
      eventId: event.id,
      channel: 'event_page',
      key: 'foreign-media-removal-guard',
      name: 'Foreign media removal guard',
      locale: 'en',
    });
    const foreignVersion = await foreignContent.createVersion({
      documentId: foreignDocument.id,
      contentJson: createDefaultEventPageDocument({
        eventId: event.id,
        eventTitle: 'Foreign media reference',
        coverImageUrl: eventPageMediaReference('cover'),
      }),
      variables: [],
      validation: { valid: true, severity: 'warning', issues: [] },
      createdBy: 'usr_foreign',
    });
    await db
      .updateTable('content_document_versions')
      .set({ status: 'published', published_at: now })
      .where('id', '=', foreignVersion.id)
      .execute();
    await db
      .updateTable('content_documents')
      .set({
        status: 'published',
        published_version_id: foreignVersion.id,
        current_draft_version_id: null,
        updated_at: now,
      })
      .where('id', '=', foreignDocument.id)
      .execute();
    await expect(
      removeEventMedia({
        db,
        tenantId,
        organizationId,
        brandId: brand.id,
        eventId: event.id,
        role: 'cover',
      }),
    ).resolves.toBe(true);
    expect(
      await db
        .selectFrom('media_object_cleanup_jobs')
        .select(['object_key', 'checksum_sha256', 'reason', 'status'])
        .where('reason', '=', 'event-media-removed')
        .execute(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          object_key: `event-media/${event.id}/${assetId}/page.webp`,
          checksum_sha256: 'b'.repeat(64),
          reason: 'event-media-removed',
          status: 'pending',
        }),
        expect.objectContaining({
          object_key: `event-media/${event.id}/${assetId}/thumbnail.webp`,
          checksum_sha256: 'c'.repeat(64),
          reason: 'event-media-removed',
          status: 'pending',
        }),
      ]),
    );
    await db
      .updateTable('content_documents')
      .set({ published_version_id: null, current_draft_version_id: null })
      .where('id', '=', mediaDocument.id)
      .execute();
    await db
      .deleteFrom('content_document_versions')
      .where('document_id', '=', mediaDocument.id)
      .execute();
    await db.deleteFrom('content_documents').where('id', '=', mediaDocument.id).execute();
    await db
      .updateTable('content_documents')
      .set({ published_version_id: null, current_draft_version_id: null })
      .where('id', '=', foreignDocument.id)
      .execute();
    await db
      .deleteFrom('content_document_versions')
      .where('document_id', '=', foreignDocument.id)
      .execute();
    await db.deleteFrom('content_documents').where('id', '=', foreignDocument.id).execute();
    await db.deleteFrom('brands').where('id', '=', foreignBrand.id).execute();
    await db.deleteFrom('organizations').where('id', '=', foreignOrganization.id).execute();
    await db.deleteFrom('tenants').where('id', '=', foreignTenant.id).execute();
    await db.deleteFrom('upload_artifacts').where('id', '=', uploadId).execute();
    await db.deleteFrom('events').where('id', '=', event.id).execute();
    await db.deleteFrom('brands').where('id', '=', brand.id).execute();
  });

  it('recovers a verified immutable object after a crash before database completion', async () => {
    let failFirstRead = true;
    const crashStore: PortableExportArtifactStore = {
      async putIfAbsent(key, bytes) {
        if (objects.has(key)) return 'exists';
        objects.set(key, Uint8Array.from(bytes));
        return 'created';
      },
      async get(key) {
        if (failFirstRead) {
          failFirstRead = false;
          throw new Error('simulated crash after immutable put');
        }
        const value = objects.get(key);
        if (!value) throw new Error('missing test artifact');
        return Uint8Array.from(value);
      },
      async getIfExists(key) {
        const value = objects.get(key);
        return value ? Uint8Array.from(value) : undefined;
      },
    };
    const service = createPortableExportService({
      db,
      store: crashStore,
      signing: {
        deploymentId: `deployment_${driver}_01`,
        operatingModel: 'self-hosted',
        bundleKeyId: 'bundle_key_01',
        bundlePrivateKey: bundleKeys.privateKey,
        payloadKeyId: 'payload_key_01',
        payloadPrivateKey: payloadKeys.privateKey,
      },
    });
    const request = {
      tenantId,
      organizationId,
      requestedBy: 'user_exporter',
      idempotencyKey: 'portable-api-crash-recovery',
    };
    await expect(service.exportConfiguration(request)).rejects.toThrow(/simulated crash/u);
    const building = await db
      .selectFrom('portable_export_jobs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .where('idempotency_key', '=', request.idempotencyKey)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('portable_export_jobs')
      .set({ build_lease_expires_at: new Date(0) })
      .where('id', '=', building.id)
      .execute();
    await db
      .updateTable('organizations')
      .set({ name: `Changed after crash ${driver}` })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', organizationId)
      .execute();

    const recovered = await service.exportConfiguration(request);
    expect(recovered.jobId).toBe(building.id);
    const completed = await db
      .selectFrom('portable_export_jobs')
      .selectAll()
      .where('id', '=', building.id)
      .executeTakeFirstOrThrow();
    expect(completed.status).toBe('completed');
    const transport = parsePortableJson(new TextDecoder().decode(recovered.bytes)) as {
      envelope: SignedPortableBundle;
    };
    expect(completed.source_change_cursor).toBe(transport.envelope.manifest.source.changeCursor);
  });

  it('recovers an already-signed historical artifact after its consumed grant expires', async () => {
    const recoveredObjects = new Map<string, Uint8Array>();
    let failFirstPostWriteRead = true;
    const crashStore: PortableExportArtifactStore = {
      async putIfAbsent(key, bytes) {
        if (recoveredObjects.has(key)) return 'exists';
        recoveredObjects.set(key, Uint8Array.from(bytes));
        return 'created';
      },
      async get(key) {
        if (failFirstPostWriteRead) {
          failFirstPostWriteRead = false;
          throw new Error('simulated historical crash after immutable put');
        }
        const value = recoveredObjects.get(key);
        if (!value) throw new Error('missing test artifact');
        return Uint8Array.from(value);
      },
      async getIfExists(key) {
        const value = recoveredObjects.get(key);
        return value ? Uint8Array.from(value) : undefined;
      },
    };
    const requestedBy = `user_historical_crash_${driver}`;
    const authorization = await new PortableExportAuthorizationRepository(db).grant({
      tenantId,
      organizationId,
      grantedByPrincipalId: requestedBy,
      expiresAt: new Date(Date.now() + 7_000),
    });
    const service = createPortableExportService({
      db,
      store: crashStore,
      signing: {
        deploymentId: `deployment_${driver}_01`,
        operatingModel: 'self-hosted',
        bundleKeyId: 'bundle_key_01',
        bundlePrivateKey: bundleKeys.privateKey,
        payloadKeyId: 'payload_key_01',
        payloadPrivateKey: payloadKeys.privateKey,
      },
    });
    const request = {
      tenantId,
      organizationId,
      requestedBy,
      idempotencyKey: `portable-api-historical-crash-${driver}`,
      authorizationId: authorization.id,
    };
    await expect(service.exportHistorical(request)).rejects.toThrow(/simulated historical crash/u);
    const building = await db
      .selectFrom('portable_export_jobs')
      .selectAll()
      .where('idempotency_key', '=', request.idempotencyKey)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('portable_export_jobs')
      .set({ build_lease_expires_at: new Date(0) })
      .where('id', '=', building.id)
      .execute();
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, new Date(authorization.expires_at).getTime() - Date.now() + 250),
      ),
    );

    const recovered = await service.exportHistorical(request);
    expect(recovered.jobId).toBe(building.id);
    const completed = await db
      .selectFrom('portable_export_jobs')
      .select(['status', 'artifact_sha256'])
      .where('id', '=', building.id)
      .executeTakeFirstOrThrow();
    expect(completed).toMatchObject({
      status: 'completed',
      artifact_sha256: createHash('sha256').update(recovered.bytes).digest('hex'),
    });
  }, 15_000);

  it('fences a concurrent same-key builder before any duplicate immutable write', async () => {
    let releasePut!: () => void;
    let markPutStarted!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      markPutStarted = resolve;
    });
    const putReleased = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    let putCount = 0;
    const blockedStore: PortableExportArtifactStore = {
      async putIfAbsent(key, bytes) {
        putCount += 1;
        markPutStarted();
        await putReleased;
        if (objects.has(key)) return 'exists';
        objects.set(key, Uint8Array.from(bytes));
        return 'created';
      },
      async get(key) {
        const value = objects.get(key);
        if (!value) throw new Error('missing test artifact');
        return Uint8Array.from(value);
      },
      async getIfExists(key) {
        const value = objects.get(key);
        return value ? Uint8Array.from(value) : undefined;
      },
    };
    const service = createPortableExportService({
      db,
      store: blockedStore,
      signing: {
        deploymentId: `deployment_${driver}_01`,
        operatingModel: 'self-hosted',
        bundleKeyId: 'bundle_key_01',
        bundlePrivateKey: bundleKeys.privateKey,
        payloadKeyId: 'payload_key_01',
        payloadPrivateKey: payloadKeys.privateKey,
      },
    });
    const request = {
      tenantId,
      organizationId,
      requestedBy: 'user_exporter',
      idempotencyKey: 'portable-api-concurrent-build',
    };
    const first = service.exportConfiguration(request);
    await putStarted;
    await expect(service.exportConfiguration(request)).rejects.toThrow(/IN_PROGRESS/u);
    releasePut();
    await expect(first).resolves.toMatchObject({
      bundleId: expect.stringMatching(/^bundle_/u),
    });
    expect(putCount).toBe(1);
  });

  it('exports one repeatable-read snapshot while a concurrent source mutation commits', async () => {
    const before = await db
      .selectFrom('organizations')
      .select('name')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow();
    const changedName = `Concurrent mutation ${driver}`;
    const service = createPortableExportService({
      db,
      store,
      signing: {
        deploymentId: `deployment_${driver}_01`,
        operatingModel: 'self-hosted',
        bundleKeyId: 'bundle_key_01',
        bundlePrivateKey: bundleKeys.privateKey,
        payloadKeyId: 'payload_key_01',
        payloadPrivateKey: payloadKeys.privateKey,
      },
      async afterSnapshotRead() {
        await db
          .updateTable('organizations')
          .set({ name: changedName })
          .where('tenant_id', '=', tenantId)
          .where('id', '=', organizationId)
          .execute();
      },
    });
    const result = await service.exportConfiguration({
      tenantId,
      organizationId,
      requestedBy: 'user_exporter',
      idempotencyKey: 'portable-api-repeatable-read',
    });
    const snapshotTransport = parsePortableJson(new TextDecoder().decode(result.bytes)) as {
      payloads: Record<string, string>;
    };
    const organizationRecord = JSON.parse(
      Buffer.from(snapshotTransport.payloads['data/organizations.jsonl']!, 'base64')
        .toString('utf8')
        .trim(),
    ) as { attributes: { name: string } };
    expect(organizationRecord.attributes.name).toBe(before.name);
    expect(organizationRecord.attributes.name).not.toBe(changedName);
    await expect(
      db
        .selectFrom('organizations')
        .select('name')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', organizationId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ name: changedName });
  });

  it('consumes one principal-bound grant into an immutable signed historical artifact', async () => {
    const requestedBy = 'user_historical_exporter';
    const authorization = await new PortableExportAuthorizationRepository(db).grant({
      tenantId,
      organizationId,
      grantedByPrincipalId: requestedBy,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const service = createPortableExportService({
      db,
      store,
      signing: {
        deploymentId: `deployment_${driver}_01`,
        operatingModel: 'self-hosted',
        bundleKeyId: 'bundle_key_01',
        bundlePrivateKey: bundleKeys.privateKey,
        payloadKeyId: 'payload_key_01',
        payloadPrivateKey: payloadKeys.privateKey,
      },
    });
    const request = {
      tenantId,
      organizationId,
      requestedBy,
      idempotencyKey: 'portable-api-historical-replay',
      authorizationId: authorization.id,
    };
    const first = await service.exportHistorical(request);
    const replay = await service.exportHistorical(request);
    expect(replay).toEqual(first);
    const transport = parsePortableJson(new TextDecoder().decode(first.bytes)) as {
      envelope: SignedPortableBundle;
      payloads: Record<string, string>;
    };
    expect(transport.envelope.manifest).toMatchObject({
      mode: 'historical',
      apiVersion: PORTABLE_EXPORT_API_VERSION,
      dataSchemaVersion: PORTABLE_EXPORT_DATA_SCHEMA_VERSION,
      historicalAuthorization: {
        authorizationId: authorization.id,
        tenantId,
        organizationId,
        grantedByPrincipalId: requestedBy,
        scope: 'tenant-historical-portability',
      },
      compatibility: { requiredEntitlements: ['historical-import-v1'] },
    });
    for (const section of [
      'buyers',
      'attendees',
      'orders',
      'payments',
      'refunds',
      'tickets',
      'scans',
    ])
      expect(transport.payloads[`data/${section}.jsonl`]).toBeDefined();
    await expect(
      db
        .selectFrom('portable_export_authorization_events')
        .select(['event_type', 'export_job_id'])
        .where('authorization_id', '=', authorization.id)
        .where('event_type', '=', 'consumed')
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      event_type: 'consumed',
      export_job_id: first.jobId,
    });
    await expect(
      service.exportHistorical({
        ...request,
        idempotencyKey: 'portable-api-historical-reuse',
      }),
    ).rejects.toThrow(/ALREADY_CONSUMED/u);
  });

  it('fails closed without publishing when a consumed grant expires during snapshot work', async () => {
    const requestedBy = `user_expiring_historical_${driver}`;
    const authorization = await new PortableExportAuthorizationRepository(db).grant({
      tenantId,
      organizationId,
      grantedByPrincipalId: requestedBy,
      expiresAt: new Date(Date.now() + 2_500),
    });
    let putCount = 0;
    const rejectingStore: PortableExportArtifactStore = {
      async putIfAbsent() {
        putCount += 1;
        return 'created';
      },
      async get() {
        throw new Error('expired authorization must not publish an artifact');
      },
      async getIfExists() {
        return undefined;
      },
    };
    const service = createPortableExportService({
      db,
      store: rejectingStore,
      signing: {
        deploymentId: `deployment_${driver}_01`,
        operatingModel: 'self-hosted',
        bundleKeyId: 'bundle_key_01',
        bundlePrivateKey: bundleKeys.privateKey,
        payloadKeyId: 'payload_key_01',
        payloadPrivateKey: payloadKeys.privateKey,
      },
      async afterSnapshotRead() {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(0, new Date(authorization.expires_at).getTime() - Date.now() + 250),
          ),
        );
      },
    });
    await expect(
      service.exportHistorical({
        tenantId,
        organizationId,
        requestedBy,
        idempotencyKey: `portable-api-expired-during-build-${driver}`,
        authorizationId: authorization.id,
      }),
    ).rejects.toThrow(/AUTHORIZATION_EXPIRED/u);
    expect(putCount).toBe(0);
    const job = await db
      .selectFrom('portable_export_jobs')
      .select(['id', 'status'])
      .where('idempotency_key', '=', `portable-api-expired-during-build-${driver}`)
      .executeTakeFirstOrThrow();
    expect(job.status).toBe('building');
    await expect(
      db
        .selectFrom('portable_export_events')
        .select('id')
        .where('export_job_id', '=', job.id)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it('rejects a valid signed artifact whose authorization contract does not match recovery', async () => {
    const authorization = await new PortableExportAuthorizationRepository(db).grant({
      tenantId,
      organizationId,
      grantedByPrincipalId: `user_recovery_contract_${driver}`,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const conflictingStore: PortableExportArtifactStore = {
      async putIfAbsent(key, bytes) {
        const transport = parsePortableJson(new TextDecoder().decode(bytes)) as {
          envelope: SignedPortableBundle;
          payloads: Record<string, string>;
        };
        transport.envelope.manifest.historicalAuthorization = {
          ...transport.envelope.manifest.historicalAuthorization!,
          authorizationId: 'authorization_substitution_01',
        };
        transport.envelope.signature = signPortableManifest(
          transport.envelope.manifest,
          'bundle_key_01',
          bundleKeys.privateKey,
        );
        objects.set(
          key,
          new TextEncoder().encode(
            canonicalPortableJson({
              envelope: transport.envelope,
              payloads: transport.payloads,
            }),
          ),
        );
        return 'exists';
      },
      async get(key) {
        const value = objects.get(key);
        if (!value) throw new Error('missing test artifact');
        return Uint8Array.from(value);
      },
      async getIfExists() {
        return undefined;
      },
    };
    const historical = createPortableExportService({
      db,
      store: conflictingStore,
      signing: {
        deploymentId: `deployment_${driver}_01`,
        operatingModel: 'self-hosted',
        bundleKeyId: 'bundle_key_01',
        bundlePrivateKey: bundleKeys.privateKey,
        payloadKeyId: 'payload_key_01',
        payloadPrivateKey: payloadKeys.privateKey,
      },
    });
    await expect(
      historical.exportHistorical({
        tenantId,
        organizationId,
        requestedBy: `user_recovery_contract_${driver}`,
        idempotencyKey: `portable-api-recovery-conflict-${driver}`,
        authorizationId: authorization.id,
      }),
    ).rejects.toThrow(/ARTIFACT_CONFLICT/u);
  });

  it('restricts historical grants and revocation to accepted organization owners and admins', async () => {
    const now = new Date();
    const users = [
      { id: `user_owner_${driver}`, role: 'owner', acceptedAt: now },
      { id: `user_admin_${driver}`, role: 'admin', acceptedAt: now },
      { id: `user_member_${driver}`, role: 'member', acceptedAt: now },
      { id: `user_invited_${driver}`, role: 'admin', acceptedAt: null },
    ] as const;
    for (const user of users) {
      await db
        .insertInto('user_profiles')
        .values({
          id: user.id,
          tenant_id: tenantId,
          clerk_user_id: `clerk_${user.id}`,
          email: `${user.id}@example.test`,
          first_name: null,
          last_name: null,
          avatar_url: null,
          status: 'active',
          last_seen_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('organization_members')
        .values({
          id: `member_${user.id}`,
          tenant_id: tenantId,
          organization_id: organizationId,
          user_id: user.id,
          role: user.role,
          invited_at: now,
          accepted_at: user.acceptedAt,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
    const service = createPortableHistoricalAuthorizationService(db);
    const authorization = await service.grant({
      tenantId,
      organizationId,
      principalId: `user_owner_${driver}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      service.grant({
        tenantId,
        organizationId,
        principalId: `user_member_${driver}`,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(/ADMIN_REQUIRED/u);
    await expect(
      service.grant({
        tenantId,
        organizationId,
        principalId: `user_invited_${driver}`,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(/ADMIN_REQUIRED/u);
    await expect(
      service.revoke({
        tenantId,
        organizationId,
        principalId: `user_admin_${driver}`,
        authorizationId: authorization.authorizationId,
      }),
    ).resolves.toBeUndefined();
    await expect(
      db
        .selectFrom('portable_export_authorization_events')
        .select('actor_principal_id')
        .where('authorization_id', '=', authorization.authorizationId)
        .where('event_type', '=', 'revoked')
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ actor_principal_id: `user_admin_${driver}` });
  });
});
