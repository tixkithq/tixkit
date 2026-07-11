import { describe, expect, it } from 'vitest';
import { databaseIdentity, resetSandbox, validateSandboxDatabaseUrl } from '../sandbox-reset.js';

describe('sandbox reset safety', () => {
  it('requires a distinct explicitly named local sandbox database', () => {
    expect(
      validateSandboxDatabaseUrl({
        sandboxUrl: 'postgres://localhost:5432/tixkit_sandbox',
        primaryUrl: 'postgres://localhost:5432/tixkit',
      }).pathname,
    ).toBe('/tixkit_sandbox');
    expect(() =>
      validateSandboxDatabaseUrl({
        sandboxUrl: 'postgres://localhost:5432/tixkit',
        primaryUrl: 'postgres://localhost:5432/tixkit',
      }),
    ).toThrow('must be different');
    expect(() =>
      validateSandboxDatabaseUrl({
        sandboxUrl: 'postgres://localhost:5432/tixkit_sandbox',
        primaryUrl: 'postgresql://localhost:5432/tixkit_sandbox',
      }),
    ).toThrow('must be different');
    expect(() =>
      validateSandboxDatabaseUrl({ sandboxUrl: 'postgres://localhost:5432/production' }),
    ).toThrow('must follow');
    expect(() =>
      validateSandboxDatabaseUrl({ sandboxUrl: 'postgres://db.example.test/tixkit_sandbox' }),
    ).toThrow('requires TIXKIT_ALLOW_REMOTE_SANDBOX_RESET=1');
  });

  it('canonicalizes loopback aliases, credentials, defaults, and connection options', () => {
    expect(databaseIdentity('postgres://user:one@localhost/tixkit_sandbox?sslmode=disable')).toBe(
      databaseIdentity('postgres://other:two@127.0.0.1:5432/tixkit_sandbox'),
    );
    expect(() =>
      validateSandboxDatabaseUrl({
        sandboxUrl: 'postgres://127.0.0.1/tixkit_sandbox',
        primaryUrl: 'postgres://localhost:5432/tixkit_sandbox?sslmode=disable',
      }),
    ).toThrow('must be different');
  });

  it('requires authoritative sandbox runtime mode before any database reset', async () => {
    await expect(
      resetSandbox({
        TIXKIT_SANDBOX_DATABASE_URL: 'postgres://localhost:5432/tixkit_sandbox',
        DATABASE_URL: 'postgres://localhost:5432/tixkit',
        TIXKIT_RUNTIME_MODE: 'production',
        TIXKIT_SANDBOX_RESET_COORDINATION: 'STOPPED',
      }),
    ).resolves.toEqual({
      ok: false,
      message: 'Sandbox reset requires TIXKIT_RUNTIME_MODE=sandbox.',
    });
  });
});
