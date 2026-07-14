import type { FastifyPluginAsync } from 'fastify';
import { getDriver, type Database } from '@tixkit/db';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ulid } from 'ulid';
import { sql } from 'kysely';
import { ClerkAuthService, parseOAuthScopes } from '../../auth/clerk.js';
import { parseJsonValue } from '../../http/contracts.js';
import { oauthRedirectUrlSchema, parseBody } from '../../http/schemas.js';
import type { Permission, Principal } from '@tixkit/domain';
import { ForbiddenError, UnauthorizedError, ValidationError } from '@tixkit/domain';

const authorizeQuerySchema = z
  .object({
    response_type: z.literal('code'),
    client_id: z.string().min(1),
    redirect_uri: oauthRedirectUrlSchema,
    scope: z.string().optional(),
    state: z.string().optional(),
  })
  .strict();

const tokenSchema = z
  .object({
    grant_type: z.enum(['authorization_code', 'refresh_token', 'client_credentials']),
    client_id: z.string().min(1).optional(),
    client_secret: z.string().min(1).optional(),
    code: z.string().optional(),
    redirect_uri: oauthRedirectUrlSchema.optional(),
    refresh_token: z.string().optional(),
  })
  .strict();

type OAuthClientCredentials = { clientId: string; clientSecret: string };

const revokeSchema = z
  .object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    token: z.string().min(1),
  })
  .strict();

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

function parseBasicClientCredentials(header: string | undefined): OAuthClientCredentials | null {
  if (!header?.startsWith('Basic ')) return null;
  const encoded = header.slice(6);
  if (
    encoded.length === 0 ||
    encoded.length > 2_048 ||
    encoded.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
  )
    throw new UnauthorizedError('Invalid OAuth client authentication');
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    throw new UnauthorizedError('Invalid OAuth client authentication');
  }
  const separator = decoded.indexOf(':');
  if (separator < 1) throw new UnauthorizedError('Invalid OAuth client authentication');
  const clientId = decoded.slice(0, separator);
  const clientSecret = decoded.slice(separator + 1);
  if (!clientSecret) throw new UnauthorizedError('Invalid OAuth client authentication');
  return { clientId, clientSecret };
}

function resolveClientCredentials(
  authorization: string | undefined,
  body: z.infer<typeof tokenSchema>,
): OAuthClientCredentials {
  const basic = parseBasicClientCredentials(authorization);
  if (basic && (body.client_id || body.client_secret))
    throw new UnauthorizedError('OAuth client credentials must use one authentication method');
  if (basic) return basic;
  if (!body.client_id || !body.client_secret)
    throw new UnauthorizedError('Missing OAuth client credentials');
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === 'string');
  return parseJsonValue<string[]>(value, []);
}

async function loadClient(db: Database, clientId: string, clientSecret?: string) {
  const app = await db
    .selectFrom('oauth_applications')
    .selectAll()
    .where('client_id', '=', clientId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!app) throw new UnauthorizedError('Invalid OAuth client');
  if (clientSecret) {
    const presented = Buffer.from(hashSecret(clientSecret), 'hex');
    const expected = Buffer.from(app.client_secret_hash, 'hex');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected))
      throw new UnauthorizedError('Invalid OAuth client');
  }
  return app;
}

async function oauthDatabaseNow(db: Database, tenantId: string): Promise<Date> {
  const row = await db
    .selectFrom('tenants')
    .select(sql<Date>`current_timestamp`.as('now'))
    .where('id', '=', tenantId)
    .executeTakeFirst();
  if (!row) throw new UnauthorizedError('Invalid OAuth client tenant');
  const now = new Date(row.now);
  if (!Number.isFinite(now.getTime()))
    throw new UnauthorizedError('OAuth database clock unavailable');
  return now;
}

function assertScopesAllowed(
  requestedScopes: string[],
  allowedScopes: string[],
  principalScopes?: Permission[],
) {
  const requested = requestedScopes.length > 0 ? requestedScopes : allowedScopes;
  const requestedPermissions = parseOAuthScopes(JSON.stringify(requested));
  const allowed = new Set(allowedScopes);
  const principalAllowed = principalScopes ? new Set(principalScopes) : undefined;
  for (const scope of requestedPermissions) {
    if (!allowed.has(scope) || (principalAllowed && !principalAllowed.has(scope))) {
      throw new ForbiddenError(`OAuth scope is not allowed: ${scope}`);
    }
  }
  return requestedPermissions;
}

function assertPrincipalCanAuthorizeOrganizationWideOAuth(principal: {
  brandIds?: string[];
  eventIds?: string[];
}) {
  if ((principal.brandIds?.length ?? 0) > 0 || (principal.eventIds?.length ?? 0) > 0) {
    throw new ForbiddenError(
      'Scoped principals cannot authorize organization-wide OAuth applications',
    );
  }
}

function assertPrincipalCanAuthorizeResourceOwnerOAuth(
  principal: Principal,
): asserts principal is Principal & { type: 'user' } {
  if (principal.type !== 'user') {
    throw new ForbiddenError('Only user principals can authorize OAuth applications');
  }
}

export const oauthAuthorizeRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  app.get('/oauth/authorize', async (request, reply) => {
    const principal = request.principal!;
    const query = authorizeQuerySchema.parse(request.query);
    const oauthApp = await loadClient(db, query.client_id);
    if (oauthApp.subject_type !== 'resource_owner')
      throw new UnauthorizedError('OAuth client does not support authorization code grants');
    ClerkAuthService.requireResourceTenant(principal, oauthApp, 'OAuthApplication', oauthApp.id);
    ClerkAuthService.requireOrganizationScope(principal, oauthApp.organization_id);
    assertPrincipalCanAuthorizeResourceOwnerOAuth(principal);
    assertPrincipalCanAuthorizeOrganizationWideOAuth(principal);

    const redirectUris = parseStringArray(oauthApp.redirect_uris);
    if (!redirectUris.includes(query.redirect_uri)) {
      throw new ValidationError('redirect_uri is not registered for this OAuth application');
    }
    const scopes = assertScopesAllowed(
      query.scope?.split(/\s+/).filter(Boolean) ?? [],
      parseStringArray(oauthApp.scopes),
      principal.scopes,
    );
    const code = newSecret('tk_oac');
    await db
      .insertInto('oauth_authorization_codes')
      .values({
        id: `oac_${ulid()}`,
        oauth_application_id: oauthApp.id,
        tenant_id: oauthApp.tenant_id,
        organization_id: oauthApp.organization_id,
        user_id: principal.id,
        code_hash: hashSecret(code),
        redirect_uri: query.redirect_uri,
        scopes: JSON.stringify(scopes),
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
        consumed_at: null,
        created_at: new Date(),
      })
      .execute();

    const redirectUrl = new URL(query.redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (query.state) redirectUrl.searchParams.set('state', query.state);
    return reply.redirect(redirectUrl.toString());
  });
};

export const oauthTokenRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 16 * 1024 },
      (_request, body, done) => {
        const values: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(body.toString())) {
          if (Object.hasOwn(values, key)) {
            done(new ValidationError(`Duplicate OAuth form field: ${key}`));
            return;
          }
          values[key] = value;
        }
        done(null, values);
      },
    );
  }

  app.post('/oauth/token', async (request, reply) => {
    const body = parseBody(tokenSchema, request.body);
    const credentials = resolveClientCredentials(request.headers.authorization, body);
    const oauthApp = await loadClient(db, credentials.clientId, credentials.clientSecret);
    const now = await oauthDatabaseNow(db, oauthApp.tenant_id);

    if (body.grant_type === 'client_credentials') {
      if (oauthApp.subject_type !== 'agent' || !oauthApp.agent_principal_id)
        throw new UnauthorizedError('OAuth client does not support client credentials');
      return reply
        .header('cache-control', 'no-store')
        .header('pragma', 'no-cache')
        .send(await issueAgentAccessToken({ db, oauthApp, now }));
    }

    if (oauthApp.subject_type !== 'resource_owner')
      throw new UnauthorizedError('OAuth client does not support resource-owner grants');

    if (body.grant_type === 'authorization_code') {
      if (!body.code || !body.redirect_uri)
        throw new ValidationError('code and redirect_uri are required');
      const code = await db
        .selectFrom('oauth_authorization_codes')
        .selectAll()
        .where('code_hash', '=', hashSecret(body.code))
        .where('oauth_application_id', '=', oauthApp.id)
        .executeTakeFirst();
      if (
        !code ||
        code.consumed_at ||
        new Date(code.expires_at) <= now ||
        code.redirect_uri !== body.redirect_uri
      ) {
        throw new UnauthorizedError('Invalid or expired authorization code');
      }
      if (!code.user_id) {
        throw new UnauthorizedError('Invalid or expired authorization code');
      }
      const codeScopes = parseOAuthScopes(code.scopes);
      const consumeQuery = db
        .updateTable('oauth_authorization_codes')
        .set({ consumed_at: now })
        .where('id', '=', code.id)
        .where('consumed_at', 'is', null)
        .where('expires_at', '>', now);
      const consumedCode =
        getDriver() === 'postgres'
          ? await consumeQuery.returningAll().executeTakeFirst()
          : await consumeQuery.executeTakeFirst().then((result) => {
              const updatedRows = Number(result?.numUpdatedRows ?? 0);
              return updatedRows === 1 ? { ...code, consumed_at: now } : undefined;
            });
      if (!consumedCode) {
        throw new UnauthorizedError('Invalid or expired authorization code');
      }
      return reply
        .header('cache-control', 'no-store')
        .header('pragma', 'no-cache')
        .send(
          await issueTokens({
            db,
            oauthApp,
            scopes: codeScopes,
            now,
          }),
        );
    }

    if (!body.refresh_token) throw new ValidationError('refresh_token is required');
    const refresh = await db
      .selectFrom('oauth_refresh_tokens')
      .selectAll()
      .where('token_hash', '=', hashSecret(body.refresh_token))
      .where('oauth_application_id', '=', oauthApp.id)
      .executeTakeFirst();
    if (!refresh || refresh.revoked_at || new Date(refresh.expires_at) <= now) {
      throw new UnauthorizedError('Invalid or expired refresh token');
    }
    return reply
      .header('cache-control', 'no-store')
      .header('pragma', 'no-cache')
      .send(
        await issueAccessToken({
          db,
          oauthApp,
          refreshTokenId: refresh.id,
          scopes: parseOAuthScopes(refresh.scopes),
          now,
        }),
      );
  });

  app.post('/oauth/revoke', async (request, reply) => {
    const body = parseBody(revokeSchema, request.body);
    const oauthApp = await loadClient(db, body.client_id, body.client_secret);
    const tokenHash = hashSecret(body.token);
    const now = new Date();
    await db
      .updateTable('oauth_access_tokens')
      .set({ revoked_at: now, updated_at: now })
      .where('oauth_application_id', '=', oauthApp.id)
      .where('token_hash', '=', tokenHash)
      .execute();
    await db
      .updateTable('oauth_refresh_tokens')
      .set({ revoked_at: now, updated_at: now })
      .where('oauth_application_id', '=', oauthApp.id)
      .where('token_hash', '=', tokenHash)
      .execute();
    return reply.status(200).send({ revoked: true });
  });
};

async function issueTokens(input: {
  db: Database;
  oauthApp: Awaited<ReturnType<typeof loadClient>>;
  scopes: Permission[];
  now: Date;
}) {
  const refreshToken = newSecret('tk_ort');
  const refreshId = `ort_${ulid()}`;
  await input.db
    .insertInto('oauth_refresh_tokens')
    .values({
      id: refreshId,
      oauth_application_id: input.oauthApp.id,
      tenant_id: input.oauthApp.tenant_id,
      organization_id: input.oauthApp.organization_id,
      token_hash: hashSecret(refreshToken),
      scopes: JSON.stringify(input.scopes),
      expires_at: new Date(input.now.getTime() + 30 * 24 * 60 * 60 * 1000),
      revoked_at: null,
      created_at: input.now,
      updated_at: input.now,
    })
    .execute();
  return {
    ...(await issueAccessToken({ ...input, refreshTokenId: refreshId })),
    refresh_token: refreshToken,
  };
}

async function issueAccessToken(input: {
  db: Database;
  oauthApp: Awaited<ReturnType<typeof loadClient>>;
  refreshTokenId: string;
  scopes: Permission[];
  now: Date;
}) {
  const accessToken = newSecret('tk_oat');
  const expiresIn = 3600;
  const accessTokenId = `oat_${ulid()}`;
  await input.db
    .insertInto('oauth_access_tokens')
    .values({
      id: accessTokenId,
      oauth_application_id: input.oauthApp.id,
      refresh_token_id: input.refreshTokenId,
      tenant_id: input.oauthApp.tenant_id,
      organization_id: input.oauthApp.organization_id,
      token_hash: hashSecret(accessToken),
      scopes: JSON.stringify(input.scopes),
      subject_type: 'resource_owner',
      subject_id: accessTokenId,
      expires_at: new Date(input.now.getTime() + expiresIn * 1000),
      revoked_at: null,
      created_at: input.now,
      updated_at: input.now,
    })
    .execute();
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: input.scopes.join(' '),
  };
}

async function issueAgentAccessToken(input: {
  db: Database;
  oauthApp: Awaited<ReturnType<typeof loadClient>>;
  now: Date;
}) {
  const agentPrincipalId = input.oauthApp.agent_principal_id;
  if (!agentPrincipalId) throw new UnauthorizedError('Invalid agent OAuth client');
  const principal = await input.db
    .selectFrom('agent_principals')
    .select(['id', 'tenant_id', 'state', 'protocol_version'])
    .where('tenant_id', '=', input.oauthApp.tenant_id)
    .where('id', '=', agentPrincipalId)
    .where('state', '=', 'active')
    .executeTakeFirst();
  if (!principal) throw new UnauthorizedError('Invalid or inactive agent OAuth client');
  const accessToken = newSecret('tk_aat');
  const expiresIn = 10 * 60;
  await input.db
    .insertInto('oauth_access_tokens')
    .values({
      id: `oat_${ulid()}`,
      oauth_application_id: input.oauthApp.id,
      refresh_token_id: null,
      tenant_id: input.oauthApp.tenant_id,
      organization_id: input.oauthApp.organization_id,
      token_hash: hashSecret(accessToken),
      scopes: '["agent.invoke"]',
      subject_type: 'agent',
      subject_id: principal.id,
      expires_at: new Date(input.now.getTime() + expiresIn * 1000),
      revoked_at: null,
      created_at: input.now,
      updated_at: input.now,
    })
    .execute();
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: 'agent.invoke',
  };
}
