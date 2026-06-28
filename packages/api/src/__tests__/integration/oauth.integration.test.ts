import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Database } from '@tixkit/db';
import type { Principal } from '@tixkit/domain';
import type { AppContext } from '../../app.js';
import { registerErrorHandler } from '../../app.js';
import { oauthAuthorizeRoutes, oauthTokenRoutes } from '../../routes/modules/oauth.js';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type Where = { column: string; op: string; value: unknown };

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function matchesWheres(row: Row, wheres: Where[]) {
  return wheres.every((where) => {
    const rowValue = row[where.column];
    if (where.op === '=') return rowValue === where.value;
    if (where.op === 'is') return rowValue === where.value;
    if (where.op === '>') {
      if (rowValue instanceof Date && where.value instanceof Date) return rowValue > where.value;
      if (typeof rowValue === 'number' && typeof where.value === 'number') {
        return rowValue > where.value;
      }
    }
    throw new Error(`Unsupported OAuth test operator: ${where.op}`);
  });
}

function createOAuthDb(tables: Tables): Database {
  const db = {
    selectFrom(table: string) {
      const wheres: Where[] = [];
      const query = {
        selectAll() {
          return query;
        },
        where(column: string, op: string, value: unknown) {
          wheres.push({ column, op, value });
          return query;
        },
        async executeTakeFirst() {
          return (tables[table] ?? []).find((row) => matchesWheres(row, wheres));
        },
      };
      return query;
    },
    insertInto(table: string) {
      return {
        values(value: Row) {
          return {
            async execute() {
              (tables[table] ??= []).push(value);
            },
          };
        },
      };
    },
    updateTable(table: string) {
      return {
        set(values: Row) {
          const wheres: Where[] = [];
          const query = {
            where(column: string, op: string, value: unknown) {
              wheres.push({ column, op, value });
              return query;
            },
            returningAll() {
              return query;
            },
            async executeTakeFirst() {
              for (const row of tables[table] ?? []) {
                if (matchesWheres(row, wheres)) {
                  Object.assign(row, values);
                  return row;
                }
              }
              return undefined;
            },
            async execute() {
              let updatedRows = 0;
              for (const row of tables[table] ?? []) {
                if (matchesWheres(row, wheres)) {
                  Object.assign(row, values);
                  updatedRows += 1;
                }
              }
              return [{ numUpdatedRows: BigInt(updatedRows) }];
            },
          };
          return query;
        },
      };
    },
  };
  return db as unknown as Database;
}

function oauthApplicationRow(overrides: Row = {}): Row {
  return {
    id: 'oapp_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    name: 'Legacy OAuth app',
    client_id: 'tk_oauth_legacy',
    client_secret_hash: hashSecret('tk_secret_legacy'),
    redirect_uris: JSON.stringify(['https://example.com/callback']),
    scopes: JSON.stringify(['events.read']),
    status: 'active',
    created_at: new Date('2026-06-01T00:00:00Z'),
    updated_at: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

function authorizationCodeRow(overrides: Row = {}): Row {
  return {
    id: 'oac_1',
    oauth_application_id: 'oapp_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    user_id: 'usr_1',
    code_hash: hashSecret('tk_oac_legacy'),
    redirect_uri: 'https://example.com/callback',
    scopes: JSON.stringify(['events.read']),
    expires_at: new Date(Date.now() + 10 * 60 * 1000),
    consumed_at: null,
    created_at: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

function makePrincipal(): Principal {
  return {
    type: 'user',
    id: 'usr_1',
    tenantId: 'tnt_1',
    organizationIds: ['org_1'],
    scopes: ['events.read'],
  };
}

async function setupOAuthApp(tables: Tables, principal: Principal = makePrincipal()) {
  const app = Fastify();
  app.decorate('context', {
    db: createOAuthDb(tables),
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService: {},
    temporalClient: {},
  } as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = principal;
  });
  await app.register(oauthAuthorizeRoutes);
  await app.register(oauthTokenRoutes);
  registerErrorHandler(app);
  return app;
}

describe('OAuth scoped principal authorization', () => {
  it('rejects an event-scoped principal before redirecting or issuing an authorization code', async () => {
    const tables: Tables = {
      oauth_applications: [oauthApplicationRow()],
      oauth_authorization_codes: [],
    };
    const app = await setupOAuthApp(tables, {
      ...makePrincipal(),
      type: 'api_key',
      id: 'key_1',
      scopes: ['events.read', 'developers.write'],
      eventIds: ['evt_1'],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/oauth/authorize?response_type=code&client_id=tk_oauth_legacy&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=events.read&state=abc',
    });

    expect(res.statusCode).toBe(403);
    expect(res.headers.location).toBeUndefined();
    expect(res.json()).toMatchObject({
      error: 'Forbidden',
      message: 'Scoped principals cannot authorize organization-wide OAuth applications',
    });
    expect(tables.oauth_authorization_codes).toHaveLength(0);
    await app.close();
  });
});

describe('OAuth redirect URI validation', () => {
  it('rejects a legacy javascript redirect before issuing an authorization code or redirect', async () => {
    const tables: Tables = {
      oauth_applications: [
        oauthApplicationRow({ redirect_uris: JSON.stringify(['javascript:alert(1)']) }),
      ],
      oauth_authorization_codes: [],
    };
    const app = await setupOAuthApp(tables);

    const res = await app.inject({
      method: 'GET',
      url: '/oauth/authorize?response_type=code&client_id=tk_oauth_legacy&redirect_uri=javascript%3Aalert(1)&scope=events.read&state=abc',
    });

    expect(res.statusCode).not.toBe(302);
    expect(res.headers.location).toBeUndefined();
    expect(tables.oauth_authorization_codes).toHaveLength(0);
    await app.close();
  });

  it('rejects a non-localhost http authorize redirect even if it is registered', async () => {
    const tables: Tables = {
      oauth_applications: [
        oauthApplicationRow({ redirect_uris: JSON.stringify(['http://example.com/callback']) }),
      ],
      oauth_authorization_codes: [],
    };
    const app = await setupOAuthApp(tables);

    const res = await app.inject({
      method: 'GET',
      url: '/oauth/authorize?response_type=code&client_id=tk_oauth_legacy&redirect_uri=http%3A%2F%2Fexample.com%2Fcallback',
    });

    expect(res.statusCode).not.toBe(302);
    expect(res.headers.location).toBeUndefined();
    expect(tables.oauth_authorization_codes).toHaveLength(0);
    await app.close();
  });

  it('accepts localhost http authorize redirects in test mode', async () => {
    const redirectUri = 'http://localhost:3000/callback';
    const tables: Tables = {
      oauth_applications: [oauthApplicationRow({ redirect_uris: JSON.stringify([redirectUri]) })],
      oauth_authorization_codes: [],
    };
    const app = await setupOAuthApp(tables);

    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=tk_oauth_legacy&redirect_uri=${encodeURIComponent(
        redirectUri,
      )}&state=abc`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^http:\/\/localhost:3000\/callback\?code=tk_oac_/);
    expect(res.headers.location).toContain('state=abc');
    expect(tables.oauth_authorization_codes).toHaveLength(1);
    await app.close();
  });

  it('rejects unsafe token redirect_uri before consuming a code or issuing tokens', async () => {
    const tables: Tables = {
      oauth_applications: [
        oauthApplicationRow({ redirect_uris: JSON.stringify(['javascript:alert(1)']) }),
      ],
      oauth_authorization_codes: [authorizationCodeRow({ redirect_uri: 'javascript:alert(1)' })],
      oauth_refresh_tokens: [],
      oauth_access_tokens: [],
    };
    const app = await setupOAuthApp(tables);

    const res = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: {
        grant_type: 'authorization_code',
        client_id: 'tk_oauth_legacy',
        client_secret: 'tk_secret_legacy',
        code: 'tk_oac_legacy',
        redirect_uri: 'javascript:alert(1)',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(tables.oauth_authorization_codes?.[0]?.consumed_at).toBeNull();
    expect(tables.oauth_refresh_tokens).toHaveLength(0);
    expect(tables.oauth_access_tokens).toHaveLength(0);
    await app.close();
  });
});

describe('OAuth authorization code redemption', () => {
  it('issues tokens for a valid authorization code redemption', async () => {
    const tables: Tables = {
      oauth_applications: [oauthApplicationRow()],
      oauth_authorization_codes: [authorizationCodeRow()],
      oauth_refresh_tokens: [],
      oauth_access_tokens: [],
    };
    const app = await setupOAuthApp(tables);

    const res = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: {
        grant_type: 'authorization_code',
        client_id: 'tk_oauth_legacy',
        client_secret: 'tk_secret_legacy',
        code: 'tk_oac_legacy',
        redirect_uri: 'https://example.com/callback',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'events.read',
    });
    expect(tables.oauth_authorization_codes?.[0]?.consumed_at).toBeInstanceOf(Date);
    expect(tables.oauth_refresh_tokens).toHaveLength(1);
    expect(tables.oauth_access_tokens).toHaveLength(1);
    await app.close();
  });

  it('allows only one concurrent exchange for the same authorization code', async () => {
    const tables: Tables = {
      oauth_applications: [oauthApplicationRow()],
      oauth_authorization_codes: [authorizationCodeRow()],
      oauth_refresh_tokens: [],
      oauth_access_tokens: [],
    };
    const app = await setupOAuthApp(tables);
    const tokenRequest = {
      method: 'POST' as const,
      url: '/oauth/token',
      payload: {
        grant_type: 'authorization_code',
        client_id: 'tk_oauth_legacy',
        client_secret: 'tk_secret_legacy',
        code: 'tk_oac_legacy',
        redirect_uri: 'https://example.com/callback',
      },
    };

    const responses = await Promise.all([app.inject(tokenRequest), app.inject(tokenRequest)]);
    // oxlint-disable-next-line unicorn/no-array-sort -- sorting a local two-item result keeps the race assertion deterministic under ES2022.
    const statusCodes = responses.map((res) => res.statusCode).sort((a, b) => a - b);

    expect(statusCodes).toEqual([200, 401]);
    expect(tables.oauth_authorization_codes?.[0]?.consumed_at).toBeInstanceOf(Date);
    expect(tables.oauth_refresh_tokens).toHaveLength(1);
    expect(tables.oauth_access_tokens).toHaveLength(1);
    await app.close();
  });
});
