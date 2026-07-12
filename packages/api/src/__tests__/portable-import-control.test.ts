import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { portableDryRunAttestationFromEnvironment } from '../services/portable-import-control.js';

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
    expect(portableDryRunAttestationFromEnvironment(environment)).toMatchObject({
      keyId: 'dry_run_key_01',
      privateKey: { asymmetricKeyType: 'ed25519' },
    });
    expect(() =>
      portableDryRunAttestationFromEnvironment({
        ...environment,
        TIXKIT_OPERATING_MODEL: 'cloud',
      }),
    ).toThrow(/OPERATING_MODEL_INVALID/u);
  });
});
