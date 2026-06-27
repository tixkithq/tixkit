import { describe, expect, it } from 'vitest';
import { buildStartupFailureMessage } from '../config/startup-diagnostics.js';

describe('buildStartupFailureMessage', () => {
  it('redacts database credentials from startup diagnostics', () => {
    const databaseUrl = 'postgres://user:supersecret@db.example/prod';
    const message = buildStartupFailureMessage(new Error('password authentication failed'), {
      service: 'API',
      databaseUrl,
    });

    expect(message).not.toContain('supersecret');
    expect(message).not.toContain('user:');
    expect(message).not.toContain(databaseUrl);
    expect(message).toContain('Verify DATABASE_URL points at the local database');
    expect(message).toContain('protocol postgres');
    expect(message).toContain('host db.example');
    expect(message).toContain('database prod');
  });

  it('handles malformed database URLs without throwing', () => {
    expect(() =>
      buildStartupFailureMessage(new Error('database connection failed'), {
        service: 'API',
        databaseUrl: 'postgres://user:secret@[invalid-host/prod',
      }),
    ).not.toThrow();
  });

  it('redacts database credentials from the original error detail', () => {
    const databaseUrl = 'postgres://user:supersecret@db.example/prod';
    const message = buildStartupFailureMessage(
      new Error(`password authentication failed for user "user" while connecting to ${databaseUrl}`),
      {
        service: 'API',
        databaseUrl,
      },
    );

    expect(message).not.toContain('supersecret');
    expect(message).not.toContain('user:');
    expect(message).not.toContain('"user"');
    expect(message).not.toContain(databaseUrl);
    expect(message).toContain('[redacted DATABASE_URL]');
  });
});
