import { BaseRepository } from './base.js';
import { ulid } from 'ulid';

export async function bumpEventPublicRevision(
  db: { updateTable: (table: 'events') => any },
  eventId: string,
  revision: Date = new Date(),
): Promise<void> {
  await db
    .updateTable('events')
    .set({ public_revision: revision })
    .where('id', '=', eventId)
    .execute();
}

export class EventRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    organizationId: string;
    brandId: string;
    slug: string;
    title: string;
    description?: string;
    currency: string;
    timezone: string;
    startsAt: Date;
    endsAt?: Date;
    venue?: Record<string, unknown>;
    visibility?: string;
    seo?: Record<string, unknown>;
    capacity?: number;
    minimumAge?: number | null;
    coverImageUrl?: string;
    externalUrl?: string;
  }) {
    const id = `evt_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'events',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        brand_id: input.brandId,
        slug: input.slug,
        title: input.title,
        description: input.description ?? null,
        status: 'draft',
        currency: input.currency,
        timezone: input.timezone,
        starts_at: input.startsAt,
        ends_at: input.endsAt ?? null,
        venue: input.venue ? JSON.stringify(input.venue) : null,
        visibility: input.visibility ?? 'public',
        seo: JSON.stringify(input.seo ?? {}),
        capacity: input.capacity ?? null,
        minimum_age: input.minimumAge ?? null,
        cover_image_url: input.coverImageUrl ?? null,
        external_url: input.externalUrl ?? null,
        public_revision: now,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByTenant(tenantId: string, limit = 50, cursor?: string) {
    let query = this.db
      .selectFrom('events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .orderBy('id', 'asc')
      .limit(limit);
    if (cursor) query = query.where('id', '>', cursor);
    return query.execute();
  }

  async findByBrand(brandId: string) {
    return this.db.selectFrom('events').selectAll().where('brand_id', '=', brandId).execute();
  }

  async findPublished(limit = 50) {
    return this.db
      .selectFrom('events')
      .selectAll()
      .where('status', '=', 'published')
      .limit(limit)
      .execute();
  }

  async findBySlug(tenantId: string, slug: string) {
    return this.db
      .selectFrom('events')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('slug', '=', slug)
      .executeTakeFirst();
  }

  async findByBrandSlug(brandId: string, slug: string) {
    return this.db
      .selectFrom('events')
      .selectAll()
      .where('brand_id', '=', brandId)
      .where('slug', '=', slug)
      .executeTakeFirst();
  }

  async isSlugAvailable(brandId: string, slug: string, excludeEventId?: string) {
    let query = this.db
      .selectFrom('events')
      .select('id')
      .where('brand_id', '=', brandId)
      .where('slug', '=', slug)
      .limit(1);
    if (excludeEventId) query = query.where('id', '!=', excludeEventId);
    const existing = await query.executeTakeFirst();
    return !existing;
  }

  async update(id: string, input: Record<string, unknown>) {
    const now = new Date();
    return this.updateReturning('events', id, {
      ...input,
      public_revision: now,
      updated_at: now,
    });
  }

  async updateStatus(id: string, status: string) {
    const now = new Date();
    return this.updateReturning('events', id, {
      status,
      public_revision: now,
      updated_at: now,
    });
  }
}

export class EventOccurrenceRepository extends BaseRepository {
  async create(input: {
    eventId: string;
    title: string;
    startsAt: Date;
    endsAt: Date;
    timezone: string;
    venue?: Record<string, unknown> | null;
    capacity?: number | null;
    sortOrder?: number;
    status?: string;
  }) {
    const id = `occ_${ulid()}`;
    const now = new Date();
    const occurrence = await this.insertReturning(
      'event_occurrences',
      {
        id,
        event_id: input.eventId,
        title: input.title,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        timezone: input.timezone,
        venue: input.venue ? JSON.stringify(input.venue) : null,
        capacity: input.capacity ?? null,
        sort_order: input.sortOrder ?? 0,
        status: input.status ?? 'scheduled',
        created_at: now,
        updated_at: now,
      },
      id,
    );
    await bumpEventPublicRevision(this.db, input.eventId, now);
    return occurrence;
  }

  async findById(id: string) {
    return this.db
      .selectFrom('event_occurrences')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByEvent(eventId: string) {
    return this.db
      .selectFrom('event_occurrences')
      .selectAll()
      .where('event_id', '=', eventId)
      .orderBy('starts_at', 'asc')
      .orderBy('sort_order', 'asc')
      .execute();
  }

  async update(id: string, input: Record<string, unknown>) {
    const now = new Date();
    const occurrence = await this.updateReturning('event_occurrences', id, {
      ...input,
      updated_at: now,
    });
    await bumpEventPublicRevision(this.db, occurrence.event_id, now);
    return occurrence;
  }
}

export class TicketTypeRepository extends BaseRepository {
  async create(input: {
    eventId: string;
    name: string;
    kind: string;
    currency: string;
    priceCents: number;
    inventoryPoolId: string;
    visibility?: string;
    status?: string;
    description?: string;
    minimumPriceCents?: number;
    salesStartAt?: Date;
    salesEndAt?: Date;
    minPerOrder?: number;
    maxPerOrder?: number;
    requiresAccessCode?: boolean;
    accessCodeHint?: string;
    eventOccurrenceId?: string | null;
  }) {
    const id = `tt_${ulid()}`;
    const now = new Date();
    const ticketType = await this.insertReturning(
      'ticket_types',
      {
        id,
        event_id: input.eventId,
        name: input.name,
        description: input.description ?? null,
        kind: input.kind,
        status: input.status ?? 'active',
        visibility: input.visibility ?? 'public',
        currency: input.currency,
        price_cents: input.priceCents,
        minimum_price_cents: input.minimumPriceCents ?? null,
        sales_start_at: input.salesStartAt ?? null,
        sales_end_at: input.salesEndAt ?? null,
        min_per_order: input.minPerOrder ?? 1,
        max_per_order: input.maxPerOrder ?? 10,
        inventory_pool_id: input.inventoryPoolId,
        sort_order: 0,
        requires_access_code: input.requiresAccessCode ?? false,
        access_code_hint: input.accessCodeHint ?? null,
        event_occurrence_id: input.eventOccurrenceId ?? null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
    await bumpEventPublicRevision(this.db, input.eventId, now);
    return ticketType;
  }

  async findById(id: string) {
    return this.db.selectFrom('ticket_types').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByEvent(eventId: string, limit?: number, cursor?: string) {
    let query = this.db
      .selectFrom('ticket_types')
      .selectAll()
      .where('event_id', '=', eventId)
      .orderBy('id', 'asc');
    if (cursor) query = query.where('id', '>', cursor);
    if (limit) query = query.limit(limit);
    return query.execute();
  }

  async findPublicByEvent(eventId: string) {
    return this.db
      .selectFrom('ticket_types')
      .selectAll()
      .where('event_id', '=', eventId)
      .where('visibility', '=', 'public')
      .where('status', 'in', ['active', 'sold_out'])
      .execute();
  }

  async findPublicOrRequestedByEvent(eventId: string, requestedTicketTypeIds: string[]) {
    const requested = [...new Set(requestedTicketTypeIds.filter(Boolean))];
    let query = this.db
      .selectFrom('ticket_types')
      .selectAll()
      .where('event_id', '=', eventId)
      .where('status', 'in', ['active', 'sold_out']);

    query =
      requested.length > 0
        ? query.where((eb) => eb.or([eb('visibility', '=', 'public'), eb('id', 'in', requested)]))
        : query.where('visibility', '=', 'public');

    return query.orderBy('sort_order', 'asc').orderBy('id', 'asc').execute();
  }

  async update(id: string, input: Record<string, unknown>) {
    const now = new Date();
    const ticketType = await this.updateReturning('ticket_types', id, {
      ...input,
      updated_at: now,
    });
    await bumpEventPublicRevision(this.db, ticketType.event_id, now);
    return ticketType;
  }
}

export class InventoryPoolRepository extends BaseRepository {
  async create(input: {
    eventId: string;
    name: string;
    totalCapacity: number;
    holdTtlSeconds?: number;
  }) {
    const id = `inv_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'inventory_pools',
      {
        id,
        event_id: input.eventId,
        name: input.name,
        total_capacity: input.totalCapacity,
        reserved_count: 0,
        sold_count: 0,
        hold_ttl_seconds: input.holdTtlSeconds ?? 600,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db
      .selectFrom('inventory_pools')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByEvent(eventId: string, limit?: number, cursor?: string) {
    let query = this.db
      .selectFrom('inventory_pools')
      .selectAll()
      .where('event_id', '=', eventId)
      .orderBy('id', 'asc');
    if (cursor) query = query.where('id', '>', cursor);
    if (limit) query = query.limit(limit);
    return query.execute();
  }

  async getAvailable(id: string): Promise<number> {
    const pool = await this.findById(id);
    if (!pool) return 0;
    return pool.total_capacity - pool.reserved_count - pool.sold_count;
  }
}

export class AccessRuleRepository extends BaseRepository {
  async create(input: {
    ticketTypeId: string;
    type: string;
    value: string;
    maxUses?: number;
    expiresAt?: Date;
  }) {
    const id = `acr_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'access_rules',
      {
        id,
        ticket_type_id: input.ticketTypeId,
        type: input.type,
        value: input.value,
        max_uses: input.maxUses ?? null,
        uses_count: 0,
        expires_at: input.expiresAt ?? null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findByTicketType(ticketTypeId: string) {
    return this.db
      .selectFrom('access_rules')
      .selectAll()
      .where('ticket_type_id', '=', ticketTypeId)
      .orderBy('id', 'asc')
      .execute();
  }

  async findByTicketTypes(ticketTypeIds: string[]) {
    if (ticketTypeIds.length === 0) return [];
    return this.db
      .selectFrom('access_rules')
      .selectAll()
      .where('ticket_type_id', 'in', ticketTypeIds)
      .execute();
  }

  async incrementUses(id: string) {
    return this.db
      .updateTable('access_rules')
      .set((eb) => ({ uses_count: eb('uses_count', '+', 1), updated_at: new Date() }))
      .where('id', '=', id)
      .execute();
  }

  async delete(id: string) {
    return this.db.deleteFrom('access_rules').where('id', '=', id).executeTakeFirst();
  }
}

export class ProductCategoryRepository extends BaseRepository {
  async create(input: { eventId: string; name: string; sortOrder?: number }) {
    const id = `pcat_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'product_categories',
      {
        id,
        event_id: input.eventId,
        name: input.name,
        sort_order: input.sortOrder ?? 0,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findById(id: string) {
    return this.db
      .selectFrom('product_categories')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByEvent(eventId: string, limit?: number, cursor?: string) {
    let query = this.db
      .selectFrom('product_categories')
      .selectAll()
      .where('event_id', '=', eventId)
      .orderBy('id', 'asc');
    if (cursor) query = query.where('id', '>', cursor);
    if (limit) query = query.limit(limit);
    return query.execute();
  }
}

export class ProductRepository extends BaseRepository {
  async create(input: {
    eventId: string;
    name: string;
    priceCents: number;
    currency: string;
    description?: string;
    categoryId?: string;
    maxPerOrder?: number;
    availableFrom?: Date;
    availableUntil?: Date;
    status?: string;
    sortOrder?: number;
  }) {
    const id = `prd_${ulid()}`;
    const now = new Date();
    const product = await this.insertReturning(
      'products',
      {
        id,
        event_id: input.eventId,
        name: input.name,
        description: input.description ?? null,
        price_cents: input.priceCents,
        currency: input.currency,
        category_id: input.categoryId ?? null,
        max_per_order: input.maxPerOrder ?? 10,
        available_from: input.availableFrom ?? null,
        available_until: input.availableUntil ?? null,
        status: input.status ?? 'active',
        sort_order: input.sortOrder ?? 0,
        created_at: now,
        updated_at: now,
      },
      id,
    );
    await bumpEventPublicRevision(this.db, input.eventId, now);
    return product;
  }

  async findById(id: string) {
    return this.db.selectFrom('products').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByEvent(eventId: string, limit?: number, cursor?: string) {
    let query = this.db
      .selectFrom('products')
      .selectAll()
      .where('event_id', '=', eventId)
      .orderBy('id', 'asc');
    if (cursor) query = query.where('id', '>', cursor);
    if (limit) query = query.limit(limit);
    return query.execute();
  }

  async update(id: string, input: Record<string, unknown>) {
    const now = new Date();
    const product = await this.updateReturning('products', id, { ...input, updated_at: now });
    await bumpEventPublicRevision(this.db, product.event_id, now);
    return product;
  }
}
