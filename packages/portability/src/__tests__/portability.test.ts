import { createHash, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  assertPortablePayloadSafe,
  canonicalPortableManifest,
  createPortableCutoverProof,
  createPortableDryRunReceipt,
  portableManifestSha256,
  portableMappingProvenanceSha256,
  portableOperationId,
  reconcilePortableImport,
  scanPortablePayload,
  scanPortableAsset,
  signPortableMediaAttestation,
  signPortablePayloadAttestation,
  signPortableManifest,
  validatePortableManifest,
  validatePortableFinalCutover,
  validatePortableLineage,
  validatePortableResume,
  verifyPortableManifestSignature,
  verifyAndPreflightPortableImport,
  type PortableBundleManifest,
} from '../index.js';

const mediaSigningKeys = generateKeyPairSync('ed25519');
const payloadSigningKeys = generateKeyPairSync('ed25519');
const payloadPolicy = {
  schemaId: 'events_schema_01',
  schemaSha256: '6'.repeat(64),
  policySha256: '7'.repeat(64),
  scannerId: 'payload_scanner_01',
  validateRecord: () => true,
};

function manifest(overrides: Partial<PortableBundleManifest> = {}): PortableBundleManifest {
  return {
    schemaVersion: 1,
    format: 'tixkit-portable-bundle-v1',
    bundleId: 'bundle_01',
    mode: 'configuration',
    source: {
      operatingModel: 'self-hosted',
      deploymentId: 'deployment_source',
      tenantId: 'tenant_primary',
      exportSequence: 1,
      changeCursor: 'change_100',
      frozenAt: '2026-07-12T17:00:00.000Z',
    },
    apiVersion: '2026-01-01',
    dataSchemaVersion: '0064',
    exportedAt: '2026-07-12T17:00:00.000Z',
    lineage: { kind: 'full', toChangeCursor: 'change_100' },
    compatibility: {
      minimumApiVersion: '2026-01-01',
      maximumApiVersion: '2026-12-31',
      minimumDataSchemaVersion: '0064',
      maximumDataSchemaVersion: '0069',
      requiredCapabilities: ['portable-bundle-v1'],
      requiredEntitlements: [],
    },
    entityCounts: { organizations: 1, events: 2 },
    files: [
      {
        path: 'data/events.jsonl',
        section: 'events',
        sha256: 'a'.repeat(64),
        bytes: 100,
        records: 2,
        contentType: 'application/jsonl',
      },
      {
        path: 'assets/poster.webp',
        section: 'assets',
        sha256: 'b'.repeat(64),
        bytes: 200,
        records: 1,
        contentType: 'application/octet-stream',
      },
    ],
    payloadSafety: {
      policyVersion: 'tixkit-portable-secret-policy-v1',
      scannedFiles: [
        signPortablePayloadAttestation(
          {
            path: 'data/events.jsonl',
            section: 'events',
            sha256: 'a'.repeat(64),
            records: 2,
            portableIdsSha256: createHash('sha256')
              .update(`${JSON.stringify(['event_1', 'event_2'])}\n`)
              .digest('hex'),
            schemaId: 'events_schema_01',
            schemaSha256: '6'.repeat(64),
            policySha256: '7'.repeat(64),
            scannerId: 'payload_scanner_01',
          },
          'key_payload_01',
          payloadSigningKeys.privateKey,
        ),
      ],
      findings: 0,
    },
    assetSafety: {
      policyVersion: 'tixkit-portable-media-policy-v1',
      scannedFiles: [
        signPortableMediaAttestation(
          {
            path: 'assets/poster.webp',
            sha256: 'b'.repeat(64),
            bytes: 200,
            policyVersion: 'tixkit-portable-media-policy-v1',
            policySha256: '9'.repeat(64),
            scannerId: 'media_scanner_01',
            detectedMediaType: 'image/webp',
            width: 1200,
            height: 1800,
            malwareStatus: 'clean',
            metadataStripped: true,
            decompressionSafe: true,
            pixelLimitsSafe: true,
          },
          'key_media_01',
          mediaSigningKeys.privateKey,
        ),
      ],
      findings: 0,
    },
    assets: [
      {
        portableId: 'asset_poster',
        path: 'assets/poster.webp',
        sha256: 'b'.repeat(64),
        bytes: 200,
        mediaType: 'image/webp',
        role: 'poster',
      },
    ],
    identity: {
      namespace: 'tenant_primary',
      preserveSafeIds: true,
      mappingRequired: true,
    },
    dependencies: [{ section: 'events', dependsOn: [] }],
    rebindings: [{ kind: 'provider_account', portableId: 'provider_stripe', required: true }],
    ...overrides,
  };
}

function verifiedPreflight(
  value: PortableBundleManifest,
  destination: Parameters<typeof verifyAndPreflightPortableImport>[1],
) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return verifyAndPreflightPortableImport(
    { manifest: value, signature: signPortableManifest(value, 'key_portability_01', privateKey) },
    destination,
    new Map([['key_portability_01', publicKey]]),
    new Map([['key_payload_01', payloadSigningKeys.publicKey]]),
    new Map(
      value.payloadSafety.scannedFiles.map((receipt) => [
        receipt.section,
        {
          schemaId: receipt.schemaId,
          schemaSha256: receipt.schemaSha256,
          policySha256: receipt.policySha256,
          scannerId: receipt.scannerId,
          keyId: receipt.keyId,
        },
      ]),
    ),
    new Map([['key_media_01', mediaSigningKeys.publicKey]]),
    new Map(
      value.assetSafety.scannedFiles.map((receipt) => [
        receipt.scannerId,
        {
          policySha256: receipt.policySha256,
          scannerId: receipt.scannerId,
          keyId: receipt.keyId,
          detectedMediaTypes: [receipt.detectedMediaType],
        },
      ]),
    ),
  );
}

describe('portable bundle manifest', () => {
  it('publishes a fixed canonical JSON cross-runtime vector', () => {
    const canonical = canonicalPortableManifest({
      z: 1,
      a: { é: 2, a: 3 },
      arr: [{ b: 2, a: 1 }],
    } as never);
    expect(canonical).toBe('{"a":{"a":3,"é":2},"arr":[{"a":1,"b":2}],"z":1}\n');
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(
      '3ab4b26ea46eeb12ef5debfe28a6d54434ccc0431daf721dde35ba374fd5b82a',
    );
  });

  it('verifies every published canonical JSON digest and signature vector', () => {
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../schemas/canonical-json-v1-vectors.json', import.meta.url)),
        'utf8',
      ),
    ) as {
      vectors: Array<{
        input: unknown;
        canonical: string;
        sha256: string;
        publicKeyPem?: string;
        signature?: string;
      }>;
    };
    for (const vector of fixture.vectors) {
      expect(canonicalPortableManifest(vector.input as never)).toBe(vector.canonical);
      expect(createHash('sha256').update(vector.canonical).digest('hex')).toBe(vector.sha256);
      if (vector.publicKeyPem && vector.signature) {
        expect(
          cryptoVerify(
            null,
            Buffer.from(vector.canonical),
            vector.publicKeyPem,
            Buffer.from(vector.signature, 'base64'),
          ),
        ).toBe(true);
      }
    }
  });

  it('keeps the published JSON schema aligned with the executable manifest contract', () => {
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../schemas/portable-bundle-2026-07-12.json', import.meta.url)),
        'utf8',
      ),
    ) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(manifest()), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...manifest(), apiKey: 'forbidden' })).toBe(false);
    expect(
      validate({
        ...manifest(),
        files: [{ ...manifest().files[0], section: 'payment_tokens' }],
        assets: [],
      }),
    ).toBe(false);
    const signatureSchema = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL('../../schemas/portable-bundle-signature-2026-07-12.json', import.meta.url),
        ),
        'utf8',
      ),
    ) as object;
    const validateSignature = ajv.compile(signatureSchema);
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(
      validateSignature(signPortableManifest(manifest(), 'key_portability_01', privateKey)),
    ).toBe(true);
  });

  it('canonicalizes, signs and verifies an immutable manifest digest', () => {
    const value = manifest();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signature = signPortableManifest(value, 'key_portability_01', privateKey);
    expect(canonicalPortableManifest(value)).toMatch(/\n$/u);
    expect(signature.manifestSha256).toBe(portableManifestSha256(value));
    expect(verifyPortableManifestSignature(value, signature, publicKey)).toBe(true);
    expect(
      verifyPortableManifestSignature(
        { ...value, bundleId: 'bundle_tampered' },
        signature,
        publicKey,
      ),
    ).toBe(false);
  });

  it('requires a trusted signature before import preflight', () => {
    const value = manifest();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signature = signPortableManifest(value, 'key_portability_01', privateKey);
    const destination = {
      deploymentId: 'deployment_destination',
      apiVersion: '2026-01-01',
      dataSchemaVersion: '0064',
      capabilities: ['portable-bundle-v1'],
      entitlements: [],
      availableStorageBytes: 1000,
      acceptedSourceOperatingModels: ['self-hosted'] as const,
    };
    expect(
      verifyAndPreflightPortableImport(
        { manifest: value, signature },
        {
          ...destination,
          acceptedSourceOperatingModels: [...destination.acceptedSourceOperatingModels],
        },
        new Map([['key_portability_01', publicKey]]),
        new Map([['key_payload_01', payloadSigningKeys.publicKey]]),
        new Map([
          [
            'events',
            {
              schemaId: 'events_schema_01',
              schemaSha256: '6'.repeat(64),
              policySha256: '7'.repeat(64),
              scannerId: 'payload_scanner_01',
              keyId: 'key_payload_01',
            },
          ],
        ]),
        new Map([['key_media_01', mediaSigningKeys.publicKey]]),
        new Map([
          [
            'media_scanner_01',
            {
              policySha256: '9'.repeat(64),
              scannerId: 'media_scanner_01',
              keyId: 'key_media_01',
              detectedMediaTypes: ['image/webp'],
            },
          ],
        ]),
      ).compatible,
    ).toBe(true);
    expect(() =>
      verifyAndPreflightPortableImport(
        { manifest: value, signature },
        {
          ...destination,
          acceptedSourceOperatingModels: [...destination.acceptedSourceOperatingModels],
        },
        new Map(),
        new Map([['key_payload_01', payloadSigningKeys.publicKey]]),
        new Map(),
        new Map([['key_media_01', mediaSigningKeys.publicKey]]),
        new Map(),
      ),
    ).toThrow(/not trusted/u);
    const roguePayloadKeys = generateKeyPairSync('ed25519');
    const {
      keyId: _keyId,
      signature: _signature,
      ...payloadReceipt
    } = value.payloadSafety.scannedFiles[0]!;
    const rogueManifest = {
      ...value,
      payloadSafety: {
        ...value.payloadSafety,
        scannedFiles: [
          signPortablePayloadAttestation(
            payloadReceipt,
            'key_payload_rogue',
            roguePayloadKeys.privateKey,
          ),
        ],
      },
    };
    expect(() =>
      verifyAndPreflightPortableImport(
        {
          manifest: rogueManifest,
          signature: signPortableManifest(rogueManifest, 'key_portability_01', privateKey),
        },
        {
          ...destination,
          acceptedSourceOperatingModels: [...destination.acceptedSourceOperatingModels],
        },
        new Map([['key_portability_01', publicKey]]),
        new Map([
          ['key_payload_01', payloadSigningKeys.publicKey],
          ['key_payload_rogue', roguePayloadKeys.publicKey],
        ]),
        new Map([
          [
            'events',
            {
              schemaId: 'events_schema_01',
              schemaSha256: '6'.repeat(64),
              policySha256: '7'.repeat(64),
              scannerId: 'payload_scanner_01',
              keyId: 'key_payload_01',
            },
          ],
        ]),
        new Map([['key_media_01', mediaSigningKeys.publicKey]]),
        new Map([
          [
            'media_scanner_01',
            {
              policySha256: '9'.repeat(64),
              scannerId: 'media_scanner_01',
              keyId: 'key_media_01',
              detectedMediaTypes: ['image/webp'],
            },
          ],
        ]),
      ),
    ).toThrow(/payload safety attestation is not trusted/u);
  });

  it('enforces the closed published schema before signing or runtime import', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    for (const invalid of [
      { ...manifest(), apiKey: 'forbidden' },
      { ...manifest(), mode: 'unknown-mode' },
      { ...manifest(), source: { ...manifest().source, providerCredentials: {} } },
      { ...manifest(), compatibility: { ...manifest().compatibility, extra: true } },
    ]) {
      expect(() =>
        signPortableManifest(invalid as never, 'key_portability_01', privateKey),
      ).toThrow(/schema validation/u);
    }
  });

  it('rejects traversal, duplicate paths and assets not bound to file integrity', () => {
    expect(() =>
      validatePortableManifest(
        manifest({ files: [{ ...manifest().files[0]!, path: '../secret.json' }] }),
      ),
    ).toThrow(/schema validation|unsafe or duplicated/u);
    expect(() =>
      validatePortableManifest(
        manifest({ files: [manifest().files[0]!, { ...manifest().files[0]! }] }),
      ),
    ).toThrow(/unsafe or duplicated/u);
    expect(() =>
      validatePortableManifest(
        manifest({ assets: [{ ...manifest().assets[0]!, sha256: 'c'.repeat(64) }] }),
      ),
    ).toThrow(/not bound/u);
    expect(() =>
      validatePortableManifest(
        manifest({
          files: [{ ...manifest().files[0]!, section: 'payment_tokens' as never }],
          assets: [],
        }),
      ),
    ).toThrow(/schema validation|section is unknown/u);
  });

  it('requires explicit unexpired authorization for historical data', () => {
    const historical = manifest({
      mode: 'historical',
      files: [
        ...manifest().files,
        {
          path: 'history/orders.jsonl',
          section: 'orders',
          sha256: 'c'.repeat(64),
          bytes: 50,
          records: 1,
          contentType: 'application/jsonl',
        },
      ],
      payloadSafety: {
        policyVersion: 'tixkit-portable-secret-policy-v1',
        scannedFiles: [
          signPortablePayloadAttestation(
            {
              path: 'data/events.jsonl',
              section: 'events',
              sha256: 'a'.repeat(64),
              records: 2,
              portableIdsSha256: createHash('sha256')
                .update(`${JSON.stringify(['event_1', 'event_2'])}\n`)
                .digest('hex'),
              schemaId: 'events_schema_01',
              schemaSha256: '6'.repeat(64),
              policySha256: '7'.repeat(64),
              scannerId: 'payload_scanner_01',
            },
            'key_payload_01',
            payloadSigningKeys.privateKey,
          ),
          signPortablePayloadAttestation(
            {
              path: 'history/orders.jsonl',
              section: 'orders',
              sha256: 'c'.repeat(64),
              records: 1,
              portableIdsSha256: createHash('sha256')
                .update(`${JSON.stringify(['order_1'])}\n`)
                .digest('hex'),
              schemaId: 'orders_schema_01',
              schemaSha256: '6'.repeat(64),
              policySha256: '7'.repeat(64),
              scannerId: 'payload_scanner_01',
            },
            'key_payload_01',
            payloadSigningKeys.privateKey,
          ),
        ],
        findings: 0,
      },
      dependencies: [
        { section: 'events', dependsOn: [] },
        { section: 'orders', dependsOn: ['events'] },
      ],
    });
    expect(() => validatePortableManifest(historical)).toThrow(
      /schema validation|explicit authorization/u,
    );
    expect(() =>
      validatePortableManifest({
        ...historical,
        historicalAuthorization: {
          authorizationId: 'auth_history_01',
          tenantId: 'tenant_primary',
          grantedByPrincipalId: 'principal_owner',
          grantedAt: '2026-07-12T16:00:00.000Z',
          expiresAt: '2026-07-12T18:00:00.000Z',
          scope: 'tenant-historical-portability',
        },
      }),
    ).not.toThrow();
    expect(() =>
      validatePortableManifest({
        ...historical,
        historicalAuthorization: {
          authorizationId: 'auth_history_02',
          tenantId: 'tenant_primary',
          grantedByPrincipalId: 'principal_owner',
          grantedAt: '2026-07-12T17:30:00.000Z',
          expiresAt: '2026-07-12T18:00:00.000Z',
          scope: 'tenant-historical-portability',
        },
      }),
    ).toThrow(/explicit authorization/u);
    expect(() =>
      validatePortableManifest(
        manifest({
          files: [
            ...manifest().files,
            {
              ...manifest().files[0]!,
              path: 'history/payments.jsonl',
              section: 'payments',
            },
          ],
          payloadSafety: {
            policyVersion: 'tixkit-portable-secret-policy-v1',
            scannedFiles: [
              signPortablePayloadAttestation(
                {
                  path: 'data/events.jsonl',
                  section: 'events',
                  sha256: 'a'.repeat(64),
                  records: 2,
                  portableIdsSha256: createHash('sha256')
                    .update(`${JSON.stringify(['event_1', 'event_2'])}\n`)
                    .digest('hex'),
                  schemaId: 'events_schema_01',
                  schemaSha256: '6'.repeat(64),
                  policySha256: '7'.repeat(64),
                  scannerId: 'payload_scanner_01',
                },
                'key_payload_01',
                payloadSigningKeys.privateKey,
              ),
              signPortablePayloadAttestation(
                {
                  path: 'history/payments.jsonl',
                  section: 'payments',
                  sha256: 'a'.repeat(64),
                  records: 2,
                  portableIdsSha256: createHash('sha256')
                    .update(`${JSON.stringify(['payment_1', 'payment_2'])}\n`)
                    .digest('hex'),
                  schemaId: 'payments_schema_01',
                  schemaSha256: '6'.repeat(64),
                  policySha256: '7'.repeat(64),
                  scannerId: 'payload_scanner_01',
                },
                'key_payload_01',
                payloadSigningKeys.privateKey,
              ),
            ],
            findings: 0,
          },
          dependencies: [
            { section: 'events', dependsOn: [] },
            { section: 'payments', dependsOn: ['events'] },
          ],
        }),
      ),
    ).toThrow(/schema validation|cannot contain historical/u);
  });

  it('derives stable destination-specific operation identities and rejects checkpoint drift', () => {
    const value = manifest();
    const operationId = portableOperationId(value, 'deployment_destination');
    const preflight = verifiedPreflight(value, {
      deploymentId: 'deployment_destination',
      apiVersion: '2026-01-01',
      dataSchemaVersion: '0064',
      capabilities: ['portable-bundle-v1'],
      entitlements: [],
      availableStorageBytes: 1000,
      acceptedSourceOperatingModels: ['self-hosted'],
    });
    const dryRunKeys = generateKeyPairSync('ed25519');
    const receipt = createPortableDryRunReceipt(
      preflight,
      value,
      'deployment_destination',
      'a'.repeat(64),
      'b'.repeat(64),
      '2026-07-12T17:01:00.000Z',
      'key_dry_run_01',
      dryRunKeys.privateKey,
    );
    const trustedDryRunKeys = new Map([['key_dry_run_01', dryRunKeys.publicKey]]);
    expect(operationId).toBe(portableOperationId(value, 'deployment_destination'));
    expect(operationId).not.toBe(portableOperationId(value, 'deployment_other'));
    expect(() =>
      validatePortableResume(
        {
          operationId,
          manifestSha256: portableManifestSha256(value),
          completedFiles: [{ path: 'data/events.jsonl', sha256: '0'.repeat(64) }],
          lastSourceChangeCursor: 'change_100',
          destinationId: 'deployment_destination',
          dryRunReceiptSha256: receipt.sha256,
          mappings: [],
          completedRebindings: [],
          status: 'importing',
        },
        value,
        'deployment_destination',
        receipt,
        trustedDryRunKeys,
      ),
    ).toThrow(/file drift/u);
    expect(() =>
      validatePortableResume(
        {
          operationId,
          manifestSha256: portableManifestSha256(value),
          completedFiles: [],
          lastSourceChangeCursor: 'stale_cursor',
          destinationId: 'deployment_destination',
          dryRunReceiptSha256: receipt.sha256,
          mappings: [],
          completedRebindings: [],
          status: 'importing',
        },
        value,
        'deployment_destination',
        receipt,
        trustedDryRunKeys,
      ),
    ).toThrow(/cursor/u);
    expect(() =>
      validatePortableResume(
        {
          operationId,
          manifestSha256: portableManifestSha256(value),
          completedFiles: [{ path: 'data/events.jsonl', sha256: 'a'.repeat(64) }],
          lastSourceChangeCursor: 'change_100',
          destinationId: 'deployment_destination',
          dryRunReceiptSha256: receipt.sha256,
          mappings: ['event_1', 'event_2'].map((sourcePortableId) => {
            const mapping = {
              filePath: 'data/events.jsonl',
              section: 'events' as const,
              sourcePortableId,
              destinationId: sourcePortableId,
            };
            return { ...mapping, provenanceSha256: portableMappingProvenanceSha256(mapping) };
          }),
          completedRebindings: [],
          status: 'importing',
        },
        value,
        'deployment_destination',
        receipt,
        trustedDryRunKeys,
      ),
    ).not.toThrow();
  });

  it('binds delta lineage to a parent and cutover cursor', () => {
    expect(() =>
      validatePortableManifest(
        manifest({ lineage: { kind: 'delta', toChangeCursor: 'change_100' } }),
      ),
    ).toThrow(/schema validation|parent lineage/u);
    const parent = manifest({ bundleId: 'bundle_parent' });
    const delta = manifest({
      bundleId: 'bundle_delta',
      source: { ...manifest().source, exportSequence: 2 },
      lineage: {
        kind: 'delta',
        fromChangeCursor: 'change_100',
        toChangeCursor: 'change_200',
        parentBundleId: parent.bundleId,
        parentManifestSha256: portableManifestSha256(parent),
        cutoverFreeze: {
          frozenAt: '2026-07-12T17:00:00.000Z',
          receiptSha256: 'f'.repeat(64),
        },
      },
    });
    delta.source.changeCursor = 'change_200';
    const signingKeys = generateKeyPairSync('ed25519');
    const trustedKeys = new Map([['key_portability_01', signingKeys.publicKey]]);
    const signedParent = {
      manifest: parent,
      signature: signPortableManifest(parent, 'key_portability_01', signingKeys.privateKey),
    };
    const signedDelta = {
      manifest: delta,
      signature: signPortableManifest(delta, 'key_portability_01', signingKeys.privateKey),
    };
    expect(() => validatePortableLineage(signedDelta, trustedKeys, signedParent)).not.toThrow();
    const cutoverKeys = generateKeyPairSync('ed25519');
    const cutoverProof = createPortableCutoverProof(
      {
        tenantId: 'tenant_primary',
        deploymentId: 'deployment_source',
        sourceChangeCursor: 'change_200',
        observedAt: '2026-07-12T17:01:00.000Z',
        sourceFrozen: false,
        bundleId: 'bundle_delta',
        manifestSha256: portableManifestSha256(delta),
        destinationId: 'deployment_destination',
        operationId: portableOperationId(delta, 'deployment_destination'),
        issuedAt: '2026-07-12T17:01:00.000Z',
        expiresAt: '2026-07-12T17:05:00.000Z',
        nonce: 'cutover_nonce_01',
      },
      'key_cutover_01',
      cutoverKeys.privateKey,
    );
    const consumedNonces = new Set<string>();
    const consumeNonce = (nonce: string): boolean => {
      if (consumedNonces.has(nonce)) return false;
      consumedNonces.add(nonce);
      return true;
    };
    expect(() =>
      validatePortableFinalCutover(
        signedDelta,
        cutoverProof,
        trustedKeys,
        new Map([['key_cutover_01', cutoverKeys.publicKey]]),
        'deployment_destination',
        '2026-07-12T17:02:00.000Z',
        consumeNonce,
        signedParent,
      ),
    ).not.toThrow();
    expect(() =>
      validatePortableFinalCutover(
        signedDelta,
        cutoverProof,
        trustedKeys,
        new Map([['key_cutover_01', cutoverKeys.publicKey]]),
        'deployment_destination',
        '2026-07-12T17:02:00.000Z',
        consumeNonce,
        signedParent,
      ),
    ).toThrow(/already consumed/u);
    expect(() =>
      validatePortableLineage(signedDelta, trustedKeys, {
        manifest: { ...parent, bundleId: 'wrong_parent' },
        signature: signedParent.signature,
      }),
    ).toThrow(/trusted key/u);
  });

  it('fails closed on secret material and environment-specific infrastructure fields', () => {
    expect(() =>
      assertPortablePayloadSafe({ provider: { webhookSecret: 'redacted-is-still-not-portable' } }),
    ).toThrow(/forbidden field/u);
    expect(() =>
      assertPortablePayloadSafe({ metadata: { clusterId: 'cluster-production' } }),
    ).toThrow(/forbidden field/u);
    expect(() => assertPortablePayloadSafe({ note: `sk_live_${'a'.repeat(24)}` })).toThrow(
      /secret material/u,
    );
    expect(() =>
      assertPortablePayloadSafe({
        providerAccountId: 'portable_provider_1',
        displayName: 'Primary',
      }),
    ).not.toThrow();
    expect(() =>
      (() => {
        const bytes = Buffer.from(`{"note":"prefix whsec_${'a'.repeat(24)} suffix"}\n`);
        return scanPortablePayload(
          {
            ...manifest().files[0]!,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            records: 1,
            bytes: bytes.byteLength,
          },
          bytes,
          payloadPolicy,
          'key_payload_01',
          payloadSigningKeys.privateKey,
        );
      })(),
    ).toThrow(/secret material/u);
    expect(() => assertPortablePayloadSafe({ token: 'tok_live_12345678901234567890' })).toThrow(
      /forbidden field/u,
    );
    expect(() => assertPortablePayloadSafe({ walletPrivateMaterial: 'abc' })).toThrow(
      /forbidden field/u,
    );
    expect(() => assertPortablePayloadSafe({ awsSecretAccessKey: 'credential' })).toThrow(
      /forbidden field/u,
    );
    expect(() => assertPortablePayloadSafe({ mnemonic: 'abandon abandon abandon' })).toThrow(
      /forbidden field/u,
    );
    const duplicateKeyBytes = Buffer.from(
      `{"portableId":"event_1","note":"sk_live_${'a'.repeat(24)}","note":"benign"}\n`,
    );
    expect(() =>
      scanPortablePayload(
        {
          ...manifest().files[0]!,
          sha256: createHash('sha256').update(duplicateKeyBytes).digest('hex'),
          records: 1,
          bytes: duplicateKeyBytes.byteLength,
        },
        duplicateKeyBytes,
        payloadPolicy,
        'key_payload_01',
        payloadSigningKeys.privateKey,
      ),
    ).toThrow(/duplicate key/u);
    for (const [payload, expected] of [
      ['{"portableId":"event_1","__proto__":{"accessToken":"secret"}}\n', /forbidden object key/u],
      ['{"portableId":"event_1","amount":9007199254740993}\n', /safe integer/u],
      ['{"portableId":"event_1"}\u00a0', /trailing content/u],
    ] as const) {
      const bytes = Buffer.from(payload);
      expect(() =>
        scanPortablePayload(
          {
            ...manifest().files[0]!,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            records: 1,
            bytes: bytes.byteLength,
          },
          bytes,
          payloadPolicy,
          'key_payload_01',
          payloadSigningKeys.privateKey,
        ),
      ).toThrow(expected);
    }
    const benignBytes = Buffer.from('{"displayName":"Primary"}\n');
    const differentBytes = Buffer.from('{"accessToken":"not-portable"}\n');
    expect(() =>
      scanPortablePayload(
        {
          ...manifest().files[0]!,
          sha256: createHash('sha256').update(differentBytes).digest('hex'),
          records: 1,
          bytes: benignBytes.byteLength,
        },
        benignBytes,
        payloadPolicy,
        'key_payload_01',
        payloadSigningKeys.privateKey,
      ),
    ).toThrow(/bytes do not match/u);
    const assetBytes = Buffer.from('safe-image-fixture');
    expect(() =>
      scanPortableAsset(
        {
          ...manifest().files[1]!,
          sha256: createHash('sha256').update(assetBytes).digest('hex'),
          bytes: assetBytes.byteLength - 1,
        },
        assetBytes,
        1024,
        signPortableMediaAttestation(
          {
            path: 'assets/poster.webp',
            sha256: createHash('sha256').update(assetBytes).digest('hex'),
            bytes: assetBytes.byteLength,
            policyVersion: 'tixkit-portable-media-policy-v1',
            policySha256: '9'.repeat(64),
            scannerId: 'media_scanner_01',
            detectedMediaType: 'image/webp',
            width: 1200,
            height: 1800,
            malwareStatus: 'clean',
            metadataStripped: true,
            decompressionSafe: true,
            pixelLimitsSafe: true,
          },
          'key_media_01',
          mediaSigningKeys.privateKey,
        ),
        new Map([['key_media_01', mediaSigningKeys.publicKey]]),
      ),
    ).toThrow(/byte size/u);
  });

  it('rejects cyclic dependency ordering', () => {
    expect(() =>
      validatePortableManifest(
        manifest({
          dependencies: [
            { section: 'events', dependsOn: ['venues'] },
            { section: 'venues', dependsOn: ['events'] },
          ],
        }),
      ),
    ).toThrow(/cycle/u);
  });
});

describe('portable import preflight and reconciliation', () => {
  it('reports every incompatible destination constraint before mutation', () => {
    const value = manifest({
      compatibility: {
        ...manifest().compatibility,
        requiredEntitlements: ['historical-import'],
      },
    });
    const result = verifiedPreflight(value, {
      deploymentId: 'destination',
      apiVersion: '2025-01-01',
      dataSchemaVersion: '0063',
      capabilities: [],
      entitlements: [],
      availableStorageBytes: 10,
      acceptedSourceOperatingModels: ['cloud'],
    });
    expect(result.compatible).toBe(false);
    expect(result.errors).toHaveLength(6);
    expect(result.requiredRebindings).toHaveLength(1);
  });

  it('compares numeric version components and derives operation identity internally', () => {
    const value = manifest({
      compatibility: {
        ...manifest().compatibility,
        minimumDataSchemaVersion: '1.9',
        maximumDataSchemaVersion: '1.11',
      },
    });
    const result = verifiedPreflight(value, {
      deploymentId: 'destination',
      apiVersion: '2026-01-01',
      dataSchemaVersion: '1.10',
      capabilities: ['portable-bundle-v1'],
      entitlements: [],
      availableStorageBytes: 1000,
      acceptedSourceOperatingModels: ['self-hosted'],
    });
    expect(result.compatible).toBe(true);
    expect(result.operationId).toBe(portableOperationId(value, 'destination'));
  });

  it('fails readiness on count, asset, financial, dependency and rebinding drift', () => {
    const report = reconcilePortableImport({
      expectedCounts: { events: 2 },
      actualCounts: { events: 1 },
      expectedAssets: [{ portableId: 'asset_poster', sha256: 'a'.repeat(64) }],
      actualAssets: [{ portableId: 'asset_poster', sha256: 'b'.repeat(64) }],
      expectedFinancialTotals: [
        { currency: 'USD', grossMinor: '1000', refundedMinor: '100', netMinor: '900' },
      ],
      actualFinancialTotals: [
        { currency: 'USD', grossMinor: '1000', refundedMinor: '0', netMinor: '1000' },
      ],
      unresolvedDependencies: [{ portableId: 'event_1', reason: 'venue missing' }],
      requiredRebindingsRemaining: ['provider_stripe'],
    });
    expect(report.ready).toBe(false);
    expect(report.countMismatches).toHaveLength(1);
    expect(report.assetMismatches).toHaveLength(1);
    expect(report.financialMismatches).toHaveLength(1);
  });

  it('rejects duplicate and reports extra destination assets and financial totals', () => {
    expect(() =>
      reconcilePortableImport({
        expectedCounts: {},
        actualCounts: {},
        expectedAssets: [],
        actualAssets: [
          { portableId: 'asset_extra', sha256: 'a'.repeat(64) },
          { portableId: 'asset_extra', sha256: 'a'.repeat(64) },
        ],
        unresolvedDependencies: [],
        requiredRebindingsRemaining: [],
      }),
    ).toThrow(/duplicate/u);
    const report = reconcilePortableImport({
      expectedCounts: {},
      actualCounts: {},
      expectedAssets: [],
      actualAssets: [{ portableId: 'asset_extra', sha256: 'a'.repeat(64) }],
      expectedFinancialTotals: [],
      actualFinancialTotals: [
        { currency: 'EUR', grossMinor: '1', refundedMinor: '0', netMinor: '1' },
      ],
      unresolvedDependencies: [],
      requiredRebindingsRemaining: [],
    });
    expect(report.ready).toBe(false);
    expect(report.assetMismatches).toHaveLength(1);
    expect(report.financialMismatches).toHaveLength(1);
  });
});
