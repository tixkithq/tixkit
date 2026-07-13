import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  portableCutoverTrustFromEnvironment,
  portableDryRunAttestationFromEnvironment,
} from '../services/portable-import-control.js';

function encodedPrivateKey(): string {
  return Buffer.from(
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
  ).toString('base64');
}

describe('portable dry-run attestation custody', () => {
  it('loads a local Self-Hosted Ed25519 key and refuses in-process Cloud custody', () => {
    const environment = {
      TIXKIT_OPERATING_MODEL: 'self-hosted',
      PORTABILITY_DRY_RUN_SIGNING_KEY_ID: 'dry_run_key_01',
      PORTABILITY_DRY_RUN_SIGNING_PRIVATE_KEY_BASE64: encodedPrivateKey(),
    };
    const authority = portableDryRunAttestationFromEnvironment(environment);
    expect(authority.keyId).toBe('dry_run_key_01');
    expect(authority.trustedPublicKeys.get('dry_run_key_01')?.asymmetricKeyType).toBe('ed25519');
    expect(authority.createReceipt).toBeTypeOf('function');
    expect(() =>
      portableDryRunAttestationFromEnvironment({
        ...environment,
        TIXKIT_OPERATING_MODEL: 'cloud',
      }),
    ).toThrow(/OPERATING_MODEL_INVALID/u);
  });
});

describe('portable cutover trust custody', () => {
  it('loads only explicit Ed25519 source verification keys', () => {
    const keys = generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const trust = portableCutoverTrustFromEnvironment({
      PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS: JSON.stringify({ cutover_key_01: publicKey }),
    });
    expect(trust.trustedPublicKeys.get('cutover_key_01')?.asymmetricKeyType).toBe('ed25519');
    expect(() => portableCutoverTrustFromEnvironment({})).toThrow(/TRUST_REQUIRED/u);
    expect(() =>
      portableCutoverTrustFromEnvironment({
        PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS: '{}',
      }),
    ).toThrow(/TRUST_INVALID/u);
    expect(() =>
      portableCutoverTrustFromEnvironment({
        PORTABILITY_CUTOVER_TRUSTED_PUBLIC_KEYS: JSON.stringify({
          cutover_key_01: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        }),
      }),
    ).toThrow(/TRUST_INVALID/u);
  });
});
