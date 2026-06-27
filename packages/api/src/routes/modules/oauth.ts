import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '@tixkit/db';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ulid } from 'ulid';
import { ClerkAuthService } from '../../auth/clerk.js';
import { parseJsonValue } from '../../http/contracts.js';
import { parseBody } from '../../http/schemas.js';
import { ForbiddenError, UnauthorizedError, ValidationError } from '@tixkit/domain';

const authorizeQuerySchema = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1),
  redirect_uri: z.string().url(),
  scope: z.string().optional(),
  state: z.string().optional(),
}).strict();

const tokenSchema = z.object({
  grant_type: z.enum(['authorization_code', 'refresh_token']),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  code: z.string().optional(),
  redirect_uri: z.string().url().optional(),
  refresh_token: z.string().optional(),
}).strict();

const revokeSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  token: z.string().min(1),
}).strict();

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
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
  if (clientSecret && hashSecret(clientSecret) !== app.client_secret_hash) {
    throw new UnauthorizedError('Invalid OAuth client');
  }
  return app;
}

function assertScopesAllowed(requestedScopes: string[], allowedScopes: string[], principalScopes?: string[]) {
  const requested = requestedScopes.length > 0 ? requestedScopes : allowedScopes;
  const allowed = new Set(allowedScopes);
  const principalAllowed = principalScopes ? new Set(principalScopes) : undefined;
  for (const scope of requested) {
    if (!allowed.has(scope) || (principalAllowed && !principalAllowed.has(scope))) {
      throw new ForbiddenError(`OAuth scope is not allowed: ${scope}`);
    }
  }
  return requested;
}

export const oauthAuthorizeRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  app.get('/oauth/authorize', async (request, reply) => {
    const principal = request.principal!;
    const query = authorizeQuerySchema.parse(request.query);
    const oauthApp = await loadClient(db, query.client_id);
    ClerkAuthService.requireResourceTenant(principal, oauthApp, 'OAuthApplication', oauthApp.id);
    ClerkAuthService.requireOrganizationScope(principal, oauthApp.organization_id);

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
    await db.insertInto('oauth_authorization_codes').values({
      id: `oac_${ulid()}`,
      oauth_application_id: oauthApp.id,
      tenant_id: oauthApp.tenant_id,
      organization_id: oauthApp.organization_id,
      user_id: principal.type === 'user' ? principal.id : null,
      code_hash: hashSecret(code),
      redirect_uri: query.redirect_uri,
      scopes: JSON.stringify(scopes),
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      consumed_at: null,
      created_at: new Date(),
    }).execute();

    const redirectUrl = new URL(query.redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (query.state) redirectUrl.searchParams.set('state', query.state);
    return reply.redirect(redirectUrl.toString());
  });
};

export const oauthTokenRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  app.post('/oauth/token', async (request) => {
    const body = parseBody(tokenSchema, request.body);
    const oauthApp = await loadClient(db, body.client_id, body.client_secret);
    const now = new Date();

    if (body.grant_type === 'authorization_code') {
      if (!body.code || !body.redirect_uri) throw new ValidationError('code and redirect_uri are required');
      const code = await db
        .selectFrom('oauth_authorization_codes')
        .selectAll()
        .where('code_hash', '=', hashSecret(body.code))
        .where('oauth_application_id', '=', oauthApp.id)
        .executeTakeFirst();
      if (!code || code.consumed_at || new Date(code.expires_at) <= now || code.redirect_uri !== body.redirect_uri) {
        throw new UnauthorizedError('Invalid or expired authorization code');
      }
      await db.updateTable('oauth_authorization_codes').set({ consumed_at: now }).where('id', '=', code.id).execute();
      return issueTokens({
        db,
        oauthApp,
        scopes: parseStringArray(code.scopes),
        now,
      });
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
    return issueAccessToken({
      db,
      oauthApp,
      refreshTokenId: refresh.id,
      scopes: parseStringArray(refresh.scopes),
      now,
    });
  });

  app.post('/oauth/revoke', async (request, reply) => {
    const body = parseBody(revokeSchema, request.body);
    const oauthApp = await loadClient(db, body.client_id, body.client_secret);
    const tokenHash = hashSecret(body.token);
    const now = new Date();
    await db.updateTable('oauth_access_tokens').set({ revoked_at: now, updated_at: now }).where('oauth_application_id', '=', oauthApp.id).where('token_hash', '=', tokenHash).execute();
    await db.updateTable('oauth_refresh_tokens').set({ revoked_at: now, updated_at: now }).where('oauth_application_id', '=', oauthApp.id).where('token_hash', '=', tokenHash).execute();
    return reply.status(200).send({ revoked: true });
  });
};

async function issueTokens(input: {
  db: Database;
  oauthApp: Awaited<ReturnType<typeof loadClient>>;
  scopes: string[];
  now: Date;
}) {
  const refreshToken = newSecret('tk_ort');
  const refreshId = `ort_${ulid()}`;
  await input.db.insertInto('oauth_refresh_tokens').values({
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
  }).execute();
  return {
    ...(await issueAccessToken({ ...input, refreshTokenId: refreshId })),
    refresh_token: refreshToken,
  };
}

async function issueAccessToken(input: {
  db: Database;
  oauthApp: Awaited<ReturnType<typeof loadClient>>;
  refreshTokenId: string;
  scopes: string[];
  now: Date;
}) {
  const accessToken = newSecret('tk_oat');
  const expiresIn = 3600;
  await input.db.insertInto('oauth_access_tokens').values({
    id: `oat_${ulid()}`,
    oauth_application_id: input.oauthApp.id,
    refresh_token_id: input.refreshTokenId,
    tenant_id: input.oauthApp.tenant_id,
    organization_id: input.oauthApp.organization_id,
    token_hash: hashSecret(accessToken),
    scopes: JSON.stringify(input.scopes),
    expires_at: new Date(input.now.getTime() + expiresIn * 1000),
    revoked_at: null,
    created_at: input.now,
    updated_at: input.now,
  }).execute();
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: input.scopes.join(' '),
  };
}
