import { describe, expect, it, vi } from 'vitest';
import {
  MigrationJobClient,
  formatMigrationResult,
  requireMigrationConfirmation,
} from '../migration-jobs.js';

describe('MigrationJobClient', () => {
  it('lists the ordered importer catalog', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ items: [{ id: 'generic-csv' }] }), { status: 200 }),
      );
    const client = new MigrationJobClient({
      apiBaseUrl: 'https://api.example.test/v1/',
      apiKey: 'test',
      fetch,
    });
    await expect(client.adapters()).resolves.toMatchObject({ ok: true, status: 200 });
    expect(String(fetch.mock.calls[0]![0])).toBe('https://api.example.test/v1/migration-adapters');
  });

  it('registers scanned upload artifacts and saved mappings without URL credentials', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify({ id: 'resource_1' }), { status: 201 }),
      );
    const client = new MigrationJobClient({
      apiBaseUrl: 'https://api.example.test/v1/',
      apiKey: 'test',
      fetch,
    });
    await client.registerFile('imp_1', 'upl_1');
    expect(String(fetch.mock.calls[0]![0])).toBe(
      'https://api.example.test/v1/migration-jobs/imp_1/files',
    );
    expect(fetch.mock.calls[0]![1]?.body).toBe(JSON.stringify({ uploadArtifactId: 'upl_1' }));
    await client.saveMapping({
      organizationId: 'org_1',
      sourceSystem: 'generic-csv',
      name: 'events-v1',
      entityType: 'event',
      mapping: { source_id: 'externalId' },
    });
    expect(String(fetch.mock.calls[1]![0])).toBe('https://api.example.test/v1/migration-mappings');
  });

  it('sends scoped API requests without placing credentials in the URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 'imp_1', status: 'created' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new MigrationJobClient({
      apiBaseUrl: 'https://api.example.test/v1',
      apiKey: 'tk_test_secret',
      fetch,
    });

    await expect(
      client.create({
        organizationId: 'org_1',
        sourceSystem: 'generic-csv',
        adapterVersion: 'rfc4180-v1',
        configuration: {
          sourceMode: 'official-export',
          sourceSystem: 'generic-csv',
          artifactIds: ['upl_12345678'],
        },
      }),
    ).resolves.toMatchObject({ ok: true, status: 201 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://api.example.test/v1/migration-jobs');
    expect(String(url)).not.toContain('tk_test_secret');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tk_test_secret');
    expect(new Headers(init?.headers).get('idempotency-key')).toMatch(/^cli:[a-f0-9]{64}$/u);
  });

  it('uses the lifecycle endpoints and rejects path injection', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify({ status: 'paused' }), { status: 200 }),
      );
    const client = new MigrationJobClient({
      apiBaseUrl: 'http://localhost:4000/',
      apiKey: 'test',
      fetch,
    });
    await client.action('imp_safe-1', 'pause');
    expect(String(fetch.mock.calls[0]![0])).toBe(
      'http://localhost:4000/migration-jobs/imp_safe-1/pause',
    );
    expect(() => client.get('../orders')).toThrow('Invalid migration job ID');
    await client.action('imp_safe-1', 'rollback');
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get('x-tixkit-confirmation')).toBe(
      'rollback:imp_safe-1',
    );
    await client.rollbackAssessment('imp_safe-1');
    expect(String(fetch.mock.calls[2]![0])).toBe(
      'http://localhost:4000/migration-jobs/imp_safe-1/rollback-assessment',
    );
    await client.report('imp_safe-1');
    expect(String(fetch.mock.calls[3]![0])).toBe(
      'http://localhost:4000/migration-jobs/imp_safe-1/report/download',
    );
  });

  it('returns structured non-JSON API errors without throwing', async () => {
    const client = new MigrationJobClient({
      apiBaseUrl: 'https://api.example.test',
      apiKey: 'test',
      fetch: vi.fn().mockResolvedValue(new Response('temporarily unavailable', { status: 503 })),
    });
    await expect(client.get('imp_1')).resolves.toEqual({
      ok: false,
      status: 503,
      data: { message: 'temporarily unavailable' },
      error: 'temporarily unavailable',
    });
  });

  it('requires TLS for remote APIs and rejects URL credentials', () => {
    expect(
      () =>
        new MigrationJobClient({
          apiBaseUrl: 'http://api.example.test',
          apiKey: 'test',
        }),
    ).toThrow('must use HTTPS');
    expect(
      () =>
        new MigrationJobClient({
          apiBaseUrl: 'https://user:password@api.example.test',
          apiKey: 'test',
        }),
    ).toThrow('must not contain credentials');
  });
});

describe('migration command safety', () => {
  it('binds commit and rollback confirmation to the exact job', () => {
    expect(() => requireMigrationConfirmation('commit', 'imp_1', 'COMMIT imp_2')).toThrow(
      'Refusing commit',
    );
    expect(() => requireMigrationConfirmation('rollback', 'imp_1', 'ROLLBACK imp_1')).not.toThrow();
  });

  it('supports stable machine-readable output', () => {
    expect(
      JSON.parse(formatMigrationResult({ ok: false, status: 409, error: 'conflict' }, true)),
    ).toEqual({ ok: false, status: 409, error: 'conflict' });
  });
});
