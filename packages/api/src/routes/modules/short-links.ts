import type { FastifyPluginAsync } from 'fastify';
import { ShortLinkRepository } from '@tixkit/db';
import { ClerkAuthService } from '../../auth/clerk.js';
import { NotFoundError, ValidationError } from '@tixkit/domain';
import {
  generateUniqueSlug,
  sanitizeUtmParams,
  isAllowedDestination,
  composeRedirectUrl,
} from '@tixkit/domain/messaging';

/**
 * Authenticated short-link CRUD (C-078). Tenant-scoped; requires messages.write.
 */
export const shortLinkRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  app.post('/short-links', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'messages.write');
    ClerkAuthService.requireNoEventScope(principal, 'short links');
    const body = request.body as {
      destinationUrl?: string;
      slug?: string;
      utmParams?: Record<string, unknown>;
      brandId?: string;
      expiresAt?: string;
    };
    const destinationUrl = body.destinationUrl ?? '';
    if (!destinationUrl) {
      throw new ValidationError('destinationUrl is required', { field: 'destinationUrl' });
    }
    if (!isAllowedDestination(destinationUrl)) {
      throw new ValidationError('destinationUrl must be an http(s) public URL', {
        field: 'destinationUrl',
      });
    }
    if (body.brandId) {
      const brand = await db
        .selectFrom('brands')
        .select(['id', 'organization_id'])
        .where('tenant_id', '=', principal.tenantId)
        .where('id', '=', body.brandId)
        .executeTakeFirst();
      if (!brand) throw new NotFoundError('Brand', body.brandId);
      ClerkAuthService.requireOrganizationScope(principal, brand.organization_id);
      ClerkAuthService.requireBrandScope(principal, body.brandId);
    }
    const repo = new ShortLinkRepository(db);
    const slug = body.slug
      ? body.slug
      : await generateUniqueSlug((candidate) => repo.slugExists(candidate));
    if (body.slug && (await repo.slugExists(body.slug))) {
      throw new ValidationError('slug is already in use', { field: 'slug' });
    }
    const utmParams = body.utmParams ? sanitizeUtmParams(body.utmParams) : undefined;
    const created = await repo.create({
      tenantId: principal.tenantId,
      brandId: body.brandId,
      slug,
      destinationUrl,
      utmParams: utmParams && Object.keys(utmParams).length > 0 ? utmParams : undefined,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    });
    return {
      id: created.id,
      slug: created.slug,
      destinationUrl: created.destination_url,
      utmParams: created.utm_params ? JSON.parse(created.utm_params) : undefined,
      clicks: created.clicks,
      createdAt: created.created_at,
    };
  });

  app.get('/short-links', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'messages.write');
    ClerkAuthService.requireNoEventScope(principal, 'short links');
    const repo = new ShortLinkRepository(db);
    const scopedBrandIds = principal.brandIds?.length ? principal.brandIds : undefined;
    const links = scopedBrandIds
      ? await repo.listByTenantAndBrands(principal.tenantId, scopedBrandIds)
      : await repo.listByTenant(principal.tenantId);
    return {
      links: links.map((row) => ({
        id: row.id,
        slug: row.slug,
        destinationUrl: row.destination_url,
        clicks: row.clicks,
        createdAt: row.created_at,
      })),
    };
  });

  app.get('/short-links/:id/clicks', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'messages.write');
    ClerkAuthService.requireNoEventScope(principal, 'short links');
    const { id } = request.params as { id: string };
    const repo = new ShortLinkRepository(db);
    const link = await repo.findById(id);
    if (!link || link.tenant_id !== principal.tenantId) {
      throw new NotFoundError('ShortLink', id);
    }
    if (
      principal.brandIds?.length &&
      (!link.brand_id ||
        !principal.brandIds.includes(link.brand_id as (typeof principal.brandIds)[number]))
    ) {
      throw new NotFoundError('ShortLink', id);
    }
    const aggregate = await repo.getClickAggregate(id);
    return { id, totalClicks: aggregate.totalClicks, byDay: aggregate.byDay };
  });
};

/**
 * Public short-link redirect (C-078). No auth: recipients click links in
 * email/SMS. Resolves the slug globally, records a privacy-safe click
 * (no PII), and 302-redirects to the destination with UTM passthrough.
 */
export const shortLinkRedirectRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  app.get('/s/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const repo = new ShortLinkRepository(db);
    const link = await repo.findBySlugGlobal(slug);
    if (!link) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Short link not found' });
    }
    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return reply.code(410).send({ error: 'EXPIRED', message: 'Short link has expired' });
    }
    // Record a privacy-safe click (no PII stored).
    await repo.recordClick(link.id, link.tenant_id);
    const utmParams = link.utm_params ? JSON.parse(link.utm_params) : undefined;
    const destination = composeRedirectUrl(link.destination_url, utmParams);
    return reply.redirect(destination);
  });
};
