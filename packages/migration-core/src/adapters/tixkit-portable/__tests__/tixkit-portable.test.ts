import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  buildPortableLogicalExport,
  createPortableConfigurationPayloadPolicies,
  portableManifestSha256,
  scanPortablePayload,
  signPortableManifest,
  type PortableBundleManifest,
} from '@tixkit/portability';
import { describe, expect, it } from 'vitest';
import { runMigrationAdapterConformance } from '../../../conformance.js';
import type { ExtractedMigrationRow } from '../../../index.js';
import {
  prepareTixkitPortableMigration,
  prepareTixkitPortableUpload,
  TixkitPortableMigrationAdapter,
  type TixkitPortableAdapterConfiguration,
} from '../index.js';

function fixture(
  section: 'events' | 'payments' | 'policies' = 'events',
  contentType: 'application/jsonl' | 'application/json' = 'application/jsonl',
) {
  const baseRecord =
    section === 'payments'
      ? {
          portableId: 'payment_1',
          attributes: {},
          dependencies: [{ section: 'orders' as const, portableId: 'order_1' }],
          financialSnapshot: {
            kind: 'historical-payment' as const,
            amountMinor: 2500,
            currency: 'USD',
            occurredAt: '2026-07-01T00:00:00.000Z',
            provenance: {
              sourceSystem: 'tixkit-portable',
              sourceExternalId: 'payment_1',
              importedAt: '2026-07-12T00:00:00.000Z',
            },
            reconciliationStatus: 'unreconciled' as const,
            sideEffects: 'suppressed' as const,
          },
        }
      : { portableId: 'event_1', attributes: { name: 'First event' } };
  const records = [
    baseRecord,
    ...(contentType === 'application/jsonl'
      ? [{ portableId: 'event_2', attributes: { name: 'Second event' } }]
      : []),
  ];
  const bytes = Buffer.from(
    contentType === 'application/jsonl'
      ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
      : JSON.stringify(records[0]),
  );
  const file = {
    path: 'data/events.jsonl',
    section,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    records: records.length,
    contentType,
  };
  const payloadKeys = generateKeyPairSync('ed25519');
  const receipt = scanPortablePayload(
    file,
    bytes,
    {
      schemaId: 'events_schema_01',
      schemaSha256: '1'.repeat(64),
      policySha256: '2'.repeat(64),
      scannerId: 'payload_scanner_01',
      validateRecord: (candidateSection, record) =>
        candidateSection === section &&
        !!record &&
        typeof record === 'object' &&
        (section === 'payments' ||
          typeof (record as { attributes?: { name?: unknown } }).attributes?.name === 'string'),
    },
    'key_payload_01',
    payloadKeys.privateKey,
  );
  const manifest: PortableBundleManifest = {
    schemaVersion: 1,
    format: 'tixkit-portable-bundle-v1',
    bundleId: 'bundle_migration_01',
    mode: section === 'payments' ? 'historical' : 'configuration',
    source: {
      operatingModel: 'self-hosted',
      deploymentId: 'deployment_source',
      tenantId: 'tenant_primary',
      exportSequence: 1,
      changeCursor: 'cursor_01',
    },
    apiVersion: '2026-01-01',
    dataSchemaVersion: '0064',
    exportedAt: '2026-07-12T17:00:00.000Z',
    ...(section === 'payments'
      ? {
          historicalAuthorization: {
            authorizationId: 'authorization_01',
            tenantId: 'tenant_primary',
            grantedByPrincipalId: 'principal_01',
            grantedAt: '2026-07-12T16:00:00.000Z',
            expiresAt: '2026-07-12T18:00:00.000Z',
            scope: 'tenant-historical-portability' as const,
          },
        }
      : {}),
    lineage: { kind: 'full', toChangeCursor: 'cursor_01' },
    compatibility: {
      minimumApiVersion: '2026-01-01',
      maximumApiVersion: '2026-12-31',
      minimumDataSchemaVersion: '0064',
      maximumDataSchemaVersion: '0069',
      requiredCapabilities: ['portable-bundle-v1'],
      requiredEntitlements: [],
    },
    entityCounts: { [section]: records.length },
    files: [file],
    payloadSafety: {
      policyVersion: 'tixkit-portable-secret-policy-v1',
      scannedFiles: [receipt],
      findings: 0,
    },
    assetSafety: {
      policyVersion: 'tixkit-portable-media-policy-v1',
      scannedFiles: [],
      findings: 0,
    },
    assets: [],
    identity: {
      namespace: 'tenant_primary',
      preserveSafeIds: true,
      mappingRequired: true,
    },
    dependencies: [{ section, dependsOn: [] }],
    rebindings: [],
  };
  const bundleKeys = generateKeyPairSync('ed25519');
  return {
    bytes,
    manifest,
    envelope: {
      manifest,
      signature: signPortableManifest(manifest, 'key_bundle_01', bundleKeys.privateKey),
    },
    bundleKeys,
    payloadKeys,
    receipt,
  };
}

function prepareFixture(
  value: ReturnType<typeof fixture>,
  input: {
    envelope?: typeof value.envelope;
    trustedParentEnvelope?: typeof value.envelope;
  } = {},
) {
  const section = value.manifest.files[0]!.section;
  return prepareTixkitPortableMigration({
    envelope: input.envelope ?? value.envelope,
    ...(input.trustedParentEnvelope ? { trustedParentEnvelope: input.trustedParentEnvelope } : {}),
    destination: {
      deploymentId: 'deployment_destination',
      apiVersion: '2026-01-01',
      dataSchemaVersion: '0064',
      capabilities: ['portable-bundle-v1'],
      entitlements: [],
      availableStorageBytes: 1024,
      acceptedSourceOperatingModels: ['self-hosted'],
    },
    trustedBundleKeys: new Map([['key_bundle_01', value.bundleKeys.publicKey]]),
    trustedPayloadKeys: new Map([['key_payload_01', value.payloadKeys.publicKey]]),
    trustedPayloadPolicies: new Map([
      [
        section,
        {
          schemaId: value.receipt.schemaId,
          schemaSha256: value.receipt.schemaSha256,
          policySha256: value.receipt.policySha256,
          scannerId: value.receipt.scannerId,
          keyId: value.receipt.keyId,
        },
      ],
    ]),
    trustedMediaKeys: new Map(),
    trustedMediaPolicies: new Map(),
    destinationTenantId: 'tenant_primary',
    destinationOrganizationId: 'organization_primary',
    payloads: new Map([['data/events.jsonl', value.bytes]]),
  });
}

describe('TixkitPortableMigrationAdapter', () => {
  it('rejects delta imports unless their signed parent lineage matches exactly', () => {
    const value = fixture();
    const deltaManifest: PortableBundleManifest = {
      ...value.manifest,
      bundleId: 'bundle_migration_delta_02',
      source: {
        ...value.manifest.source,
        exportSequence: 2,
        changeCursor: 'cursor_02',
      },
      lineage: {
        kind: 'delta',
        fromChangeCursor: value.manifest.lineage.toChangeCursor,
        toChangeCursor: 'cursor_02',
        parentBundleId: value.manifest.bundleId,
        parentManifestSha256: portableManifestSha256(value.manifest),
      },
    };
    const deltaEnvelope = {
      manifest: deltaManifest,
      signature: signPortableManifest(deltaManifest, 'key_bundle_01', value.bundleKeys.privateKey),
    };
    expect(() => prepareFixture(value, { envelope: deltaEnvelope })).toThrow(
      /delta lineage does not match/u,
    );
    expect(() =>
      prepareFixture(value, {
        envelope: deltaEnvelope,
        trustedParentEnvelope: value.envelope,
      }),
    ).not.toThrow();
    expect(() =>
      prepareFixture(value, {
        envelope: deltaEnvelope,
        trustedParentEnvelope: {
          ...value.envelope,
          manifest: { ...value.manifest, bundleId: 'bundle_wrong_parent' },
        },
      }),
    ).toThrow(/not signed by a trusted key|delta lineage does not match/u);
  });

  it('binds verified media bytes to their normalized event descriptor', async () => {
    const bundleKeys = generateKeyPairSync('ed25519');
    const payloadKeys = generateKeyPairSync('ed25519');
    const policies = createPortableConfigurationPayloadPolicies();
    const mediaBytes = Buffer.from('sanitized-portable-webp');
    const built = buildPortableLogicalExport({
      bundleId: 'bundle_media_01',
      mode: 'configuration',
      source: {
        operatingModel: 'self-hosted',
        deploymentId: 'deployment_source',
        tenantId: 'tenant_source',
        organizationId: 'organization_source',
        exportSequence: 1,
        changeCursor: 'cursor_media_01',
      },
      apiVersion: '2026-01-01',
      dataSchemaVersion: '0075',
      exportedAt: '2026-07-12T20:00:00.000Z',
      currentTime: '2026-07-12T20:00:00.000Z',
      compatibility: {
        minimumApiVersion: '2026-01-01',
        maximumApiVersion: '2026-12-31',
        minimumDataSchemaVersion: '0075',
        maximumDataSchemaVersion: '0075',
        requiredCapabilities: ['portable-bundle-v1'],
        requiredEntitlements: [],
      },
      sections: new Map([
        [
          'events',
          [
            {
              portableId: 'event_1',
              attributes: {
                title: 'Event',
                slug: 'event',
                status: 'draft',
                currency: 'USD',
                timezone: 'UTC',
                startsAt: '2027-01-01T00:00:00.000Z',
                endsAt: null,
                visibility: 'private',
                capacity: null,
                minimumAge: null,
                codeFormat: null,
                mediaAssets: [
                  {
                    portableId: 'media_1',
                    role: 'cover',
                    altText: 'Purple cover',
                    focalPoint: { x: 0.5, y: 0.4 },
                  },
                ],
              },
            },
          ],
        ],
      ]),
      bundleSigning: { keyId: 'bundle_key_01', privateKey: bundleKeys.privateKey },
      payloadSigning: { keyId: 'payload_key_01', privateKey: payloadKeys.privateKey },
      payloadPolicies: new Map([['events', policies.get('events')!]]),
      assets: [
        {
          portableId: 'media_1',
          path: 'assets/media_1/original.webp',
          bytes: mediaBytes,
          mediaType: 'image/webp',
          role: 'event-media:event_1:cover:original',
          width: 1600,
          height: 900,
          policySha256: '9'.repeat(64),
          scannerId: 'media_scanner_01',
        },
      ],
    });
    const configuration = prepareTixkitPortableUpload(built.transport, {
      destination: {
        deploymentId: 'deployment_destination',
        apiVersion: '2026-01-01',
        dataSchemaVersion: '0075',
        capabilities: ['portable-bundle-v1'],
        entitlements: [],
        availableStorageBytes: 1024 * 1024,
        acceptedSourceOperatingModels: ['self-hosted'],
      },
      trustedBundleKeys: new Map([['bundle_key_01', bundleKeys.publicKey]]),
      trustedPayloadKeys: new Map([['payload_key_01', payloadKeys.publicKey]]),
      trustedPayloadPolicies: new Map([
        [
          'events',
          {
            ...policies.get('events')!,
            keyId: 'payload_key_01',
          },
        ],
      ]),
      trustedMediaKeys: new Map([['payload_key_01', payloadKeys.publicKey]]),
      trustedMediaPolicies: new Map([
        [
          'media_scanner_01',
          {
            policySha256: '9'.repeat(64),
            scannerId: 'media_scanner_01',
            keyId: 'payload_key_01',
            detectedMediaTypes: ['image/webp'],
          },
        ],
      ]),
      destinationTenantId: 'tenant_destination',
      destinationOrganizationId: 'organization_destination',
    });
    const adapter = new TixkitPortableMigrationAdapter();
    const context = {
      tenantId: 'tenant_destination',
      organizationId: 'organization_destination',
    };
    const discovery = await adapter.discover(configuration, context);
    const extracted = await adapter.extract({ configuration, discovery, limit: 10, context });
    const normalized = await adapter.normalize(extracted.rows[0]!, context);
    expect(normalized.attributes.mediaAssets).toEqual([
      expect.objectContaining({
        portableId: 'media_1',
        role: 'cover',
        sha256: createHash('sha256').update(mediaBytes).digest('hex'),
        bytes: mediaBytes.byteLength,
      }),
    ]);
  });
  it('requires trusted, compatible, exact payloads and passes importer conformance', async () => {
    const value = fixture();
    const configuration = prepareTixkitPortableMigration({
      envelope: value.envelope,
      destination: {
        deploymentId: 'deployment_destination',
        apiVersion: '2026-01-01',
        dataSchemaVersion: '0064',
        capabilities: ['portable-bundle-v1'],
        entitlements: [],
        availableStorageBytes: 1024,
        acceptedSourceOperatingModels: ['self-hosted'],
      },
      trustedBundleKeys: new Map([['key_bundle_01', value.bundleKeys.publicKey]]),
      trustedPayloadKeys: new Map([['key_payload_01', value.payloadKeys.publicKey]]),
      trustedPayloadPolicies: new Map([
        [
          'events',
          {
            schemaId: value.receipt.schemaId,
            schemaSha256: value.receipt.schemaSha256,
            policySha256: value.receipt.policySha256,
            scannerId: value.receipt.scannerId,
            keyId: value.receipt.keyId,
          },
        ],
      ]),
      trustedMediaKeys: new Map(),
      trustedMediaPolicies: new Map(),
      destinationTenantId: 'tenant_primary',
      destinationOrganizationId: 'organization_primary',
      payloads: new Map([['data/events.jsonl', value.bytes]]),
    });
    const result = await runMigrationAdapterConformance({
      adapter: new TixkitPortableMigrationAdapter(),
      configuration,
      tenantId: 'tenant_primary',
      organizationId: 'organization_primary',
      pageSize: 1,
    });
    expect(result.extractedRows).toBe(2);
    expect(result.firstCommit.dispositions).toEqual(['create', 'create']);
    expect(result.unchangedReimport.dispositions).toEqual(['skip', 'skip']);
    expect(result.dryRun.domainWrites).toBe(0);
  });

  it('prepares the single-artifact transport without weakening exact-byte verification', async () => {
    const value = fixture();
    const configuration = prepareTixkitPortableUpload(
      Buffer.from(
        JSON.stringify({
          envelope: value.envelope,
          payloads: { 'data/events.jsonl': value.bytes.toString('base64') },
        }),
      ),
      {
        destination: {
          deploymentId: 'deployment_destination',
          apiVersion: '2026-01-01',
          dataSchemaVersion: '0064',
          capabilities: ['portable-bundle-v1'],
          entitlements: [],
          availableStorageBytes: 1024,
          acceptedSourceOperatingModels: ['self-hosted'],
        },
        trustedBundleKeys: new Map([['key_bundle_01', value.bundleKeys.publicKey]]),
        trustedPayloadKeys: new Map([['key_payload_01', value.payloadKeys.publicKey]]),
        trustedPayloadPolicies: new Map([
          [
            'events',
            {
              schemaId: value.receipt.schemaId,
              schemaSha256: value.receipt.schemaSha256,
              policySha256: value.receipt.policySha256,
              scannerId: value.receipt.scannerId,
              keyId: value.receipt.keyId,
            },
          ],
        ]),
        trustedMediaKeys: new Map(),
        trustedMediaPolicies: new Map(),
        destinationTenantId: 'tenant_primary',
        destinationOrganizationId: 'organization_primary',
      },
    );
    await expect(
      new TixkitPortableMigrationAdapter().discover(configuration, {
        tenantId: 'tenant_primary',
        organizationId: 'organization_primary',
      }),
    ).resolves.toMatchObject({ source: { sourceSystem: 'tixkit-portable' } });
  });

  it('rejects oversized transport and excessive payload entries before payload decoding', () => {
    const value = fixture();
    expect(() =>
      prepareTixkitPortableUpload(new Uint8Array(50 * 1024 * 1024 + 1), {} as never),
    ).toThrow(/transport exceeds/u);
    const payloads = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [`data/empty-${index}.jsonl`, '']),
    );
    expect(() =>
      prepareTixkitPortableUpload(
        Buffer.from(JSON.stringify({ envelope: value.envelope, payloads })),
        {} as never,
      ),
    ).toThrow(/entry count exceeds/u);
  });

  it('consumes the canonical public export builder transport through hardened preparation', async () => {
    const bundleKeys = generateKeyPairSync('ed25519');
    const payloadKeys = generateKeyPairSync('ed25519');
    const policy = {
      schemaId: 'organizations_schema_01',
      schemaSha256: '1'.repeat(64),
      policySha256: '2'.repeat(64),
      scannerId: 'payload_scanner_01',
      validateRecord: () => true,
    };
    const built = buildPortableLogicalExport({
      bundleId: 'bundle_import_roundtrip_01',
      mode: 'configuration',
      source: {
        operatingModel: 'self-hosted',
        deploymentId: 'deployment_source',
        tenantId: 'tenant_source',
        organizationId: 'organization_source',
        exportSequence: 1,
        changeCursor: 'cursor_1',
      },
      apiVersion: '2026-01-01',
      dataSchemaVersion: '0067',
      exportedAt: '2026-07-12T20:00:00.000Z',
      currentTime: '2026-07-12T20:00:00.000Z',
      compatibility: {
        minimumApiVersion: '2026-01-01',
        maximumApiVersion: '2026-12-31',
        minimumDataSchemaVersion: '0064',
        maximumDataSchemaVersion: '0069',
        requiredCapabilities: ['portable-bundle-v1'],
        requiredEntitlements: [],
      },
      sections: new Map([
        [
          'organizations',
          [{ portableId: 'organization_1', attributes: { name: 'Portable organization' } }],
        ],
      ]),
      bundleSigning: { keyId: 'bundle_key_01', privateKey: bundleKeys.privateKey },
      payloadSigning: { keyId: 'payload_key_01', privateKey: payloadKeys.privateKey },
      payloadPolicies: new Map([['organizations', policy]]),
    });
    const configuration = prepareTixkitPortableUpload(built.transport, {
      destination: {
        deploymentId: 'deployment_destination',
        apiVersion: '2026-01-01',
        dataSchemaVersion: '0067',
        capabilities: ['portable-bundle-v1'],
        entitlements: [],
        availableStorageBytes: 1024,
        acceptedSourceOperatingModels: ['self-hosted'],
      },
      trustedBundleKeys: new Map([['bundle_key_01', bundleKeys.publicKey]]),
      trustedPayloadKeys: new Map([['payload_key_01', payloadKeys.publicKey]]),
      trustedPayloadPolicies: new Map([
        [
          'organizations',
          {
            schemaId: policy.schemaId,
            schemaSha256: policy.schemaSha256,
            policySha256: policy.policySha256,
            scannerId: policy.scannerId,
            keyId: 'payload_key_01',
          },
        ],
      ]),
      trustedMediaKeys: new Map(),
      trustedMediaPolicies: new Map(),
      destinationTenantId: 'tenant_destination',
      destinationOrganizationId: 'organization_destination',
    });
    const adapter = new TixkitPortableMigrationAdapter();
    const context = {
      tenantId: 'tenant_destination',
      organizationId: 'organization_destination',
    };
    const discovery = await adapter.discover(configuration, context);
    const page = await adapter.extract({ configuration, discovery, limit: 10, context });
    await expect(adapter.normalize(page.rows[0]!, context)).resolves.toMatchObject({
      externalId: 'organization_1',
      entityType: 'organization',
      attributes: { name: 'Portable organization' },
    });
  });

  it('rejects payload byte drift before migration discovery', () => {
    const value = fixture();
    expect(() =>
      prepareTixkitPortableMigration({
        envelope: value.envelope,
        destination: {
          deploymentId: 'deployment_destination',
          apiVersion: '2026-01-01',
          dataSchemaVersion: '0064',
          capabilities: ['portable-bundle-v1'],
          entitlements: [],
          availableStorageBytes: 1024,
          acceptedSourceOperatingModels: ['self-hosted'],
        },
        trustedBundleKeys: new Map([['key_bundle_01', value.bundleKeys.publicKey]]),
        trustedPayloadKeys: new Map([['key_payload_01', value.payloadKeys.publicKey]]),
        trustedPayloadPolicies: new Map([
          [
            'events',
            {
              schemaId: value.receipt.schemaId,
              schemaSha256: value.receipt.schemaSha256,
              policySha256: value.receipt.policySha256,
              scannerId: value.receipt.scannerId,
              keyId: value.receipt.keyId,
            },
          ],
        ]),
        trustedMediaKeys: new Map(),
        trustedMediaPolicies: new Map(),
        destinationTenantId: 'tenant_primary',
        destinationOrganizationId: 'organization_primary',
        payloads: new Map([['data/events.jsonl', Buffer.from('tampered')]]),
      }),
    ).toThrow(/payload integrity/u);
  });

  it('retains the verified snapshot when caller-owned inputs mutate', async () => {
    const value = fixture();
    const payloads = new Map([['data/events.jsonl', Uint8Array.from(value.bytes)]]);
    const configuration = prepareTixkitPortableMigration({
      envelope: value.envelope,
      destination: {
        deploymentId: 'deployment_destination',
        apiVersion: '2026-01-01',
        dataSchemaVersion: '0064',
        capabilities: ['portable-bundle-v1'],
        entitlements: [],
        availableStorageBytes: 1024,
        acceptedSourceOperatingModels: ['self-hosted'],
      },
      trustedBundleKeys: new Map([['key_bundle_01', value.bundleKeys.publicKey]]),
      trustedPayloadKeys: new Map([['key_payload_01', value.payloadKeys.publicKey]]),
      trustedPayloadPolicies: new Map([
        [
          'events',
          {
            schemaId: value.receipt.schemaId,
            schemaSha256: value.receipt.schemaSha256,
            policySha256: value.receipt.policySha256,
            scannerId: value.receipt.scannerId,
            keyId: value.receipt.keyId,
          },
        ],
      ]),
      trustedMediaKeys: new Map(),
      trustedMediaPolicies: new Map(),
      destinationTenantId: 'tenant_primary',
      destinationOrganizationId: 'organization_primary',
      payloads,
    });
    payloads.get('data/events.jsonl')?.fill(0);
    value.envelope.manifest.source.deploymentId = 'attacker-controlled';

    const discovery = await new TixkitPortableMigrationAdapter().discover(configuration, {
      tenantId: 'tenant_primary',
      organizationId: 'organization_primary',
    });
    expect(discovery.source.accountId).toBe('deployment_source');
    const page = await new TixkitPortableMigrationAdapter().extract({
      configuration,
      discovery,
      limit: 10,
      context: { tenantId: 'tenant_primary', organizationId: 'organization_primary' },
    });
    expect(page.rows).toHaveLength(2);
    const row = page.rows[0]! as unknown as ExtractedMigrationRow & {
      externalId: string;
      entityType: 'historical-payment';
      data: { attributes: { name: string } };
    };
    row.externalId = 'attacker-controlled';
    row.entityType = 'historical-payment';
    row.data.attributes.name = 'Attacker controlled';
    const normalized = await new TixkitPortableMigrationAdapter().normalize(row, {
      tenantId: 'tenant_primary',
      organizationId: 'organization_primary',
    });
    expect(normalized).toMatchObject({
      externalId: 'event_1',
      entityType: 'event',
      attributes: { name: 'First event' },
    });
    (normalized.attributes as { name: string }).name = 'Unsigned normalized mutation';
    const normalizedAgain = await new TixkitPortableMigrationAdapter().normalize(row, {
      tenantId: 'tenant_primary',
      organizationId: 'organization_primary',
    });
    expect(normalizedAgain.attributes.name).toBe('First event');
  });

  it('rejects configurations that did not pass trusted preflight', async () => {
    await expect(
      new TixkitPortableMigrationAdapter().discover({} as TixkitPortableAdapterConfiguration, {
        tenantId: 'tenant_primary',
        organizationId: 'organization_primary',
      }),
    ).rejects.toThrow(/was not prepared/u);
  });

  it('denies use outside the authorized destination tenant and organization', async () => {
    const configuration = prepareFixture(fixture());
    await expect(
      new TixkitPortableMigrationAdapter().discover(configuration, {
        tenantId: 'tenant_attacker',
        organizationId: 'organization_primary',
      }),
    ).rejects.toThrow(/destination context/u);
  });

  it('parses signed application/json logical records', async () => {
    const configuration = prepareFixture(fixture('events', 'application/json'));
    const adapter = new TixkitPortableMigrationAdapter();
    const context = { tenantId: 'tenant_primary', organizationId: 'organization_primary' };
    const discovery = await adapter.discover(configuration, context);
    const page = await adapter.extract({ configuration, discovery, limit: 10, context });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.externalId).toBe('event_1');
  });

  it('fails preflight closed for sections without canonical persistence support', () => {
    expect(() => prepareFixture(fixture('policies'))).toThrow(/unsupported sections: policies/u);
  });

  it('rejects declared entity counts that disagree with exact payload files', () => {
    const value = fixture();
    value.manifest.entityCounts.events = 99;
    value.envelope.signature = signPortableManifest(
      value.manifest,
      'key_bundle_01',
      value.bundleKeys.privateKey,
    );
    expect(() => prepareFixture(value)).toThrow(/entity counts/u);
  });

  it('normalizes and validates side-effect-suppressed historical payments', async () => {
    const configuration = prepareFixture(fixture('payments', 'application/json'));
    const adapter = new TixkitPortableMigrationAdapter();
    const context = { tenantId: 'tenant_primary', organizationId: 'organization_primary' };
    const discovery = await adapter.discover(configuration, context);
    const page = await adapter.extract({ configuration, discovery, limit: 10, context });
    const entity = await adapter.normalize(page.rows[0]!, context);
    expect(entity.financialSnapshot).toMatchObject({
      kind: 'historical-payment',
      sideEffects: 'suppressed',
      amountMinor: 2500,
    });
    expect(await adapter.validate(entity)).toEqual([]);
  });
});
