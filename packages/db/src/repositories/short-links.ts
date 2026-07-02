import { ulid } from 'ulid';
import { sql } from 'kysely';
import { BaseRepository } from './base.js';
import { dayBucket } from '@tixkit/domain/messaging';

export class ShortLinkRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    brandId?: string;
    slug: string;
    destinationUrl: string;
    utmParams?: Record<string, string> | null;
    expiresAt?: Date | null;
  }) {
    const id = `slk_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'short_links',
      {
        id,
        tenant_id: input.tenantId,
        brand_id: input.brandId ?? null,
        slug: input.slug,
        destination_url: input.destinationUrl,
        utm_params: this.serializeUtm(input.utmParams),
        clicks: 0,
        expires_at: input.expiresAt ?? null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  private serializeUtm(params?: Record<string, string> | null): string | null {
    if (!params) return null;
    return JSON.stringify(params);
  }

  async findBySlug(tenantId: string, slug: string) {
    return this.db
      .selectFrom('short_links')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('slug', '=', slug)
      .executeTakeFirst();
  }

  async findBySlugGlobal(slug: string) {
    return this.db
      .selectFrom('short_links')
      .selectAll()
      .where('slug', '=', slug)
      .executeTakeFirst();
  }

  async findById(id: string) {
    return this.db.selectFrom('short_links').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async listByTenant(tenantId: string, limit = 50) {
    return this.db
      .selectFrom('short_links')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
  }

  async listByTenantAndBrands(tenantId: string, brandIds: string[], limit = 50) {
    if (brandIds.length === 0) return [];
    return this.db
      .selectFrom('short_links')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('brand_id', 'in', brandIds)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
  }

  async slugExists(slug: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('short_links')
      .select('id')
      .where('slug', '=', slug)
      .executeTakeFirst();
    return Boolean(row);
  }

  /** Record a privacy-safe click (no PII) and increment the aggregate counter. */
  async recordClick(shortLinkId: string, tenantId: string, at: Date = new Date()) {
    const clickId = `clk_${ulid()}`;
    const bucket = dayBucket(at);
    await this.db.transaction().execute(async (trx) => {
      const trxAny = trx as any;
      await trxAny
        .insertInto('link_clicks')
        .values({
          id: clickId,
          short_link_id: shortLinkId,
          tenant_id: tenantId,
          day_bucket: bucket,
          created_at: at,
        })
        .execute();
      await trxAny
        .updateTable('short_links')
        .set({ clicks: sql`clicks + 1`, updated_at: at })
        .where('id', '=', shortLinkId)
        .execute();
    });
  }

  async getClickAggregate(shortLinkId: string) {
    const rows = await this.db
      .selectFrom('link_clicks')
      .select(({ fn }) => ['day_bucket', fn.countAll<number>().as('clicks')])
      .where('short_link_id', '=', shortLinkId)
      .groupBy('day_bucket')
      .execute();
    const byDay: Record<string, number> = {};
    let totalClicks = 0;
    for (const row of rows) {
      const day = row.day_bucket as string;
      const clicks = Number(row.clicks ?? 0);
      byDay[day] = clicks;
      totalClicks += clicks;
    }
    return { totalClicks, byDay };
  }
}
