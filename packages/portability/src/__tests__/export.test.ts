import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildPortableLogicalExport,
  parsePortableJson,
  verifyAndPreflightPortableImport,
} from '../index.js';

describe('portable logical export builder', () => {
  it('emits one exact signed transport consumable by trusted import preflight', () => {
    const bundleKeys = generateKeyPairSync('ed25519');
    const payloadKeys = generateKeyPairSync('ed25519');
    const policy = {
      schemaId: 'organizations_schema_01',
      schemaSha256: '1'.repeat(64),
      policySha256: '2'.repeat(64),
      scannerId: 'payload_scanner_01',
      validateRecord: (section: string, record: unknown) =>
        section === 'organizations' &&
        Boolean(
          record &&
          typeof record === 'object' &&
          typeof (record as { portableId?: unknown }).portableId === 'string',
        ),
    };
    const result = buildPortableLogicalExport({
      bundleId: 'bundle_export_builder_01',
      mode: 'configuration',
      source: {
        operatingModel: 'self-hosted',
        deploymentId: 'deployment_source',
        tenantId: 'tenant_1',
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
          [
            {
              portableId: 'organization_1',
              attributes: { name: 'Example organization' },
            },
          ],
        ],
      ]),
      bundleSigning: { keyId: 'bundle_key_01', privateKey: bundleKeys.privateKey },
      payloadSigning: { keyId: 'payload_key_01', privateKey: payloadKeys.privateKey },
      payloadPolicies: new Map([['organizations', policy]]),
      assets: [
        {
          portableId: 'event_media_asset_1',
          path: 'assets/event_media_asset_1/page.webp',
          bytes: Buffer.from('sanitized-webp-fixture'),
          mediaType: 'image/webp',
          role: 'event-cover:page',
          width: 1600,
          height: 900,
          policySha256: '9'.repeat(64),
          scannerId: 'media_scanner_01',
        },
      ],
    });
    expect(result.envelope.manifest.entityCounts).toEqual({ organizations: 1 });
    expect(result.envelope.manifest.files[0]).toMatchObject({
      path: 'data/organizations.jsonl',
      records: 1,
    });
    expect(
      verifyAndPreflightPortableImport(
        result.envelope,
        {
          deploymentId: 'deployment_destination',
          apiVersion: '2026-01-01',
          dataSchemaVersion: '0067',
          capabilities: ['portable-bundle-v1'],
          entitlements: [],
          availableStorageBytes: 1024,
          acceptedSourceOperatingModels: ['self-hosted'],
        },
        new Map([['bundle_key_01', bundleKeys.publicKey]]),
        new Map([['payload_key_01', payloadKeys.publicKey]]),
        new Map([
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
        new Map([['payload_key_01', payloadKeys.publicKey]]),
        new Map([
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
      ).compatible,
    ).toBe(true);
    const transport = parsePortableJson(new TextDecoder().decode(result.transport)) as {
      payloads: Record<string, string>;
    };
    expect(
      Buffer.from(transport.payloads['data/organizations.jsonl']!, 'base64').equals(
        Buffer.from(result.payloads.get('data/organizations.jsonl')!),
      ),
    ).toBe(true);
    expect(result.envelope.manifest.assets).toEqual([
      expect.objectContaining({
        portableId: 'event_media_asset_1',
        path: 'assets/event_media_asset_1/page.webp',
        mediaType: 'image/webp',
        role: 'event-cover:page',
      }),
    ]);
    expect(
      Buffer.from(transport.payloads['assets/event_media_asset_1/page.webp']!, 'base64').toString(),
    ).toBe('sanitized-webp-fixture');
  });

  it('rejects unsupported runtime sections and duplicate identities', () => {
    const keys = generateKeyPairSync('ed25519');
    const base = {
      bundleId: 'bundle_export_builder_02',
      mode: 'configuration' as const,
      source: {
        operatingModel: 'cloud' as const,
        deploymentId: 'deployment_source',
        tenantId: 'tenant_1',
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
          'organizations' as const,
          [
            { portableId: 'buyer_1', attributes: { email: 'buyer@example.test' } },
            { portableId: 'buyer_1', attributes: { email: 'buyer@example.test' } },
          ],
        ],
      ]),
      bundleSigning: { keyId: 'bundle_key_01', privateKey: keys.privateKey },
      payloadSigning: { keyId: 'payload_key_01', privateKey: keys.privateKey },
      payloadPolicies: new Map([
        [
          'organizations' as const,
          {
            schemaId: 'organizations_schema_01',
            schemaSha256: '1'.repeat(64),
            policySha256: '2'.repeat(64),
            scannerId: 'payload_scanner_01',
            validateRecord: () => true,
          },
        ],
      ]),
    };
    expect(() => buildPortableLogicalExport(base)).toThrow(/duplicated/u);
    expect(() =>
      buildPortableLogicalExport({
        ...base,
        sections: new Map([['policies', []]]),
        payloadPolicies: new Map([['policies', base.payloadPolicies.get('organizations')!]]),
      }),
    ).toThrow(/does not yet support policies/u);
  });

  it('canonicalizes section, record, attribute, dependency, and capability ordering', () => {
    const bundleKeys = generateKeyPairSync('ed25519');
    const payloadKeys = generateKeyPairSync('ed25519');
    const policy = (section: 'organizations' | 'brands') => ({
      schemaId: `${section}_schema_01`,
      schemaSha256: '1'.repeat(64),
      policySha256: '2'.repeat(64),
      scannerId: 'payload_scanner_01',
      validateRecord: () => true,
    });
    const common = {
      bundleId: 'bundle_deterministic_01',
      mode: 'configuration' as const,
      source: {
        operatingModel: 'self-hosted' as const,
        deploymentId: 'deployment_source',
        tenantId: 'tenant_1',
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
        requiredCapabilities: ['z-capability', 'portable-bundle-v1'],
        requiredEntitlements: ['z-entitlement', 'a-entitlement'],
      },
      bundleSigning: { keyId: 'bundle_key_01', privateKey: bundleKeys.privateKey },
      payloadSigning: { keyId: 'payload_key_01', privateKey: payloadKeys.privateKey },
    };
    const organizations = [
      { portableId: 'organization_2', attributes: { slug: 'two', name: 'Two' } },
      { portableId: 'organization_1', attributes: { name: 'One', slug: 'one' } },
    ];
    const brands = [
      {
        portableId: 'brand_1',
        attributes: { slug: 'brand', name: 'Brand' },
        dependencies: [
          { section: 'organizations' as const, portableId: 'organization_2' },
          { section: 'organizations' as const, portableId: 'organization_1' },
        ],
      },
    ];
    const first = buildPortableLogicalExport({
      ...common,
      sections: new Map([
        ['brands', brands],
        ['organizations', organizations],
      ]),
      payloadPolicies: new Map([
        ['brands', policy('brands')],
        ['organizations', policy('organizations')],
      ]),
    });
    const second = buildPortableLogicalExport({
      ...common,
      compatibility: {
        ...common.compatibility,
        requiredCapabilities: common.compatibility.requiredCapabilities.toReversed(),
        requiredEntitlements: common.compatibility.requiredEntitlements.toReversed(),
      },
      sections: new Map([
        ['organizations', organizations.toReversed()],
        [
          'brands',
          [
            {
              ...brands[0]!,
              attributes: { name: 'Brand', slug: 'brand' },
              dependencies: brands[0]!.dependencies.toReversed(),
            },
          ],
        ],
      ]),
      payloadPolicies: new Map([
        ['organizations', policy('organizations')],
        ['brands', policy('brands')],
      ]),
    });
    expect(second.transport).toEqual(first.transport);
    expect(second.envelope.signature).toEqual(first.envelope.signature);
  });

  it('rejects malformed and duplicate record dependencies', () => {
    const keys = generateKeyPairSync('ed25519');
    const build = (dependencies: Array<{ section: 'organizations'; portableId: string }>) =>
      buildPortableLogicalExport({
        bundleId: 'bundle_dependency_validation_01',
        mode: 'configuration',
        source: {
          operatingModel: 'self-hosted',
          deploymentId: 'deployment_source',
          tenantId: 'tenant_1',
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
          requiredCapabilities: [],
          requiredEntitlements: [],
        },
        sections: new Map([
          ['organizations', [{ portableId: 'organization_1', attributes: {}, dependencies }]],
        ]),
        bundleSigning: { keyId: 'bundle_key_01', privateKey: keys.privateKey },
        payloadSigning: { keyId: 'payload_key_01', privateKey: keys.privateKey },
        payloadPolicies: new Map([
          [
            'organizations',
            {
              schemaId: 'organizations_schema_01',
              schemaSha256: '1'.repeat(64),
              policySha256: '2'.repeat(64),
              scannerId: 'payload_scanner_01',
              validateRecord: () => true,
            },
          ],
        ]),
      });
    expect(() => build([{ section: 'organizations', portableId: 'bad\nidentity' }])).toThrow(
      /dependency identity is invalid/u,
    );
    expect(() =>
      build([
        { section: 'organizations', portableId: 'organization_2' },
        { section: 'organizations', portableId: 'organization_2' },
      ]),
    ).toThrow(/duplicate dependencies/u);
    expect(() => build([{ section: 'organizations', portableId: 'organization_missing' }])).toThrow(
      /dependency identity is absent/u,
    );
  });
});
