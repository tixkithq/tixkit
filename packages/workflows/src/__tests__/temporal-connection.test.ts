import { afterEach, describe, expect, it } from 'vitest';
import { temporalConnectionOptions } from '../temporal-connection.js';

const keys = [
  'TEMPORAL_API_KEY',
  'TEMPORAL_TLS_CA',
  'TEMPORAL_TLS_CERT',
  'TEMPORAL_TLS_ENABLED',
  'TEMPORAL_TLS_KEY',
  'TEMPORAL_TLS_SERVER_NAME',
] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const previous = original[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe('temporalConnectionOptions', () => {
  it('keeps local connections plaintext by default', () => {
    for (const key of keys) delete process.env[key];
    expect(temporalConnectionOptions('temporal:7233')).toEqual({ address: 'temporal:7233' });
  });

  it('configures Temporal Cloud TLS and API-key authentication', () => {
    process.env.TEMPORAL_API_KEY = 'secret';
    process.env.TEMPORAL_TLS_SERVER_NAME = 'namespace.tmprl.cloud';
    expect(temporalConnectionOptions('namespace.tmprl.cloud:7233')).toEqual({
      address: 'namespace.tmprl.cloud:7233',
      apiKey: 'secret',
      tls: { serverNameOverride: 'namespace.tmprl.cloud' },
    });
  });

  it('configures mTLS and rejects incomplete client credentials', () => {
    process.env.TEMPORAL_TLS_CERT = 'certificate';
    expect(() => temporalConnectionOptions()).toThrow(
      'TEMPORAL_TLS_CERT and TEMPORAL_TLS_KEY must be configured together',
    );
    process.env.TEMPORAL_TLS_KEY = 'private-key';
    process.env.TEMPORAL_TLS_CA = 'ca';
    expect(temporalConnectionOptions().tls).toEqual({
      serverRootCACertificate: Buffer.from('ca'),
      clientCertPair: { crt: Buffer.from('certificate'), key: Buffer.from('private-key') },
    });
  });
});
