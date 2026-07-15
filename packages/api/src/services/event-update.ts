import { EventRepository, type Database, type DB } from '@tixkit/db';
import { NotFoundError, ValidationError } from '@tixkit/domain';
import type { Selectable, Transaction } from 'kysely';
import { serializeEvent } from '../http/contracts.js';
import { updateEventSchema } from '../http/schemas.js';

type EventRow = Selectable<DB['events']>;
type EventPatch = Omit<ReturnType<typeof updateEventSchema.parse>, 'status'>;
type EventMediaPurpose = 'event_cover' | 'event_seo_image';

interface EventMediaBinding {
  artifactId: string;
  pathname: string;
  purpose: EventMediaPurpose;
}

export interface ResolvedEventPatch {
  eventId: string;
  tenantId: string;
  expectedVersion: number;
  currentVersion: number;
  updateData: Readonly<Record<string, unknown>>;
  requestedFields: readonly string[];
  before: Readonly<Record<string, unknown>>;
  after: Readonly<Record<string, unknown>>;
  mediaBindings: readonly EventMediaBinding[];
}

export type ApplyResolvedEventPatchResult =
  | { applied: true; event: EventRow }
  | { applied: false; currentVersion: number };

class StaleEventPatchError extends Error {
  constructor(readonly currentVersion: number) {
    super('stale event patch');
  }
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function eventPatchProjection(row: EventRow): Record<string, unknown> {
  const serialized = serializeEvent(row as unknown as Record<string, unknown>);
  return {
    title: serialized.title,
    slug: serialized.slug,
    description: serialized.description ?? null,
    currency: serialized.currency,
    timezone: serialized.timezone,
    startsAt: serialized.startsAt,
    endsAt: serialized.endsAt ?? null,
    venue: serialized.venue,
    venueId: row.venue_id ?? null,
    visibility: serialized.visibility,
    seo: serialized.seo,
    capacity: serialized.capacity ?? null,
    minimumAge: serialized.minimumAge,
    coverImageUrl: serialized.coverImageUrl ?? null,
    externalUrl: serialized.externalUrl ?? null,
    coverImageAlt: serialized.coverImageAlt ?? null,
    seoUseCoverImage: serialized.seoUseCoverImage,
    lastSetupSection: serialized.lastSetupSection ?? null,
  };
}

function projectedFields(
  projection: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, projection[field]]));
}

function applyProjectionUpdate(
  existing: EventRow,
  updateData: Readonly<Record<string, unknown>>,
): EventRow {
  return {
    ...existing,
    ...updateData,
    version: Number(existing.version) + 1,
  } as EventRow;
}

function parseEventMediaUrl(
  value: string,
  purpose: EventMediaPurpose,
): { artifactId: string; pathname: string } {
  let pathname: string;
  try {
    pathname = new URL(value, 'http://tixkit.local').pathname;
  } catch {
    throw new ValidationError('Event media URL is invalid');
  }
  const match = new RegExp(`^/v1/public/event-media/${purpose}/(upl_[A-Za-z0-9_-]+)$`).exec(
    pathname,
  );
  if (!match) throw new ValidationError('Event media must use the owned upload pipeline');
  return { artifactId: match[1]!, pathname };
}

async function requireOwnedEventMedia(
  db: Database | Transaction<DB>,
  event: EventRow,
  value: string,
  purpose: EventMediaPurpose,
): Promise<EventMediaBinding> {
  const parsed = parseEventMediaUrl(value, purpose);
  const artifact = await db
    .selectFrom('upload_artifacts')
    .select('id')
    .where('id', '=', parsed.artifactId)
    .where('tenant_id', '=', event.tenant_id)
    .where('organization_id', '=', event.organization_id)
    .where('brand_id', '=', event.brand_id)
    .where('event_id', '=', event.id)
    .where('purpose', '=', purpose)
    .where('status', '=', 'uploaded')
    .where('scan_status', '=', 'clean')
    .executeTakeFirst();
  if (!artifact) throw new NotFoundError('UploadArtifact', parsed.artifactId);
  return { artifactId: parsed.artifactId, pathname: parsed.pathname, purpose };
}

async function renewEventMediaLease(
  db: Transaction<DB>,
  event: EventRow,
  binding: EventMediaBinding,
): Promise<void> {
  const now = new Date();
  const lease = await db
    .updateTable('upload_artifacts')
    .set({
      expires_at: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      updated_at: now,
    })
    .where('id', '=', binding.artifactId)
    .where('tenant_id', '=', event.tenant_id)
    .where('organization_id', '=', event.organization_id)
    .where('brand_id', '=', event.brand_id)
    .where('event_id', '=', event.id)
    .where('purpose', '=', binding.purpose)
    .where('status', '=', 'uploaded')
    .where('scan_status', '=', 'clean')
    .executeTakeFirst();
  if (Number(lease.numUpdatedRows) !== 1)
    throw new NotFoundError('UploadArtifact', binding.artifactId);
}

export class EventUpdateService {
  constructor(private readonly db: Database) {}

  async resolvePatch(input: {
    tenantId: string;
    eventId: string;
    patch: unknown;
  }): Promise<ResolvedEventPatch> {
    const body = updateEventSchema.parse(input.patch);
    if (body.status !== undefined) {
      throw new ValidationError(
        'Use the dedicated publish, pause, or archive endpoint to change event status',
      );
    }
    const patch: EventPatch = body;
    const repo = new EventRepository(this.db);
    const existing = await repo.findById(input.eventId);
    if (!existing || existing.tenant_id !== input.tenantId)
      throw new NotFoundError('Event', input.eventId);

    const updateData: Record<string, unknown> = {};
    const mediaBindings: EventMediaBinding[] = [];
    if (patch.title !== undefined) updateData.title = patch.title;
    if (patch.slug !== undefined) {
      if (!(await repo.isSlugAvailable(existing.brand_id, patch.slug, input.eventId)))
        throw new ValidationError('Event slug is already in use');
      updateData.slug = patch.slug;
    }
    if (patch.description !== undefined) updateData.description = patch.description;
    if (patch.currency !== undefined) {
      updateData.currency = patch.currency;
      updateData.checkout_configuration_updated_at = new Date();
    }
    if (patch.timezone !== undefined) updateData.timezone = patch.timezone;
    if (patch.startsAt !== undefined) updateData.starts_at = new Date(patch.startsAt);
    if (patch.endsAt !== undefined)
      updateData.ends_at = patch.endsAt ? new Date(patch.endsAt) : null;
    if (patch.venueId !== undefined) {
      if (patch.venueId === null) {
        updateData.venue_id = null;
      } else {
        const savedVenue = await this.db
          .selectFrom('venues')
          .selectAll()
          .where('id', '=', patch.venueId)
          .where('tenant_id', '=', input.tenantId)
          .where('organization_id', '=', existing.organization_id)
          .executeTakeFirst();
        if (!savedVenue) throw new NotFoundError('Venue', patch.venueId);
        updateData.venue_id = savedVenue.id;
        updateData.venue = JSON.stringify({
          name: savedVenue.name,
          ...(parseJson(savedVenue.address) as Record<string, unknown> | null),
        });
      }
    }
    if (patch.venue !== undefined)
      updateData.venue = patch.venue ? JSON.stringify(patch.venue) : null;
    if (patch.visibility !== undefined) updateData.visibility = patch.visibility;
    if (patch.seo !== undefined) {
      const seo = { ...patch.seo };
      if (typeof seo.imageUrl === 'string' && seo.imageUrl) {
        const binding = await requireOwnedEventMedia(
          this.db,
          existing,
          seo.imageUrl,
          'event_seo_image',
        );
        mediaBindings.push(binding);
        seo.imageUrl = binding.pathname;
      }
      updateData.seo = JSON.stringify(seo);
    }
    if (patch.capacity !== undefined) updateData.capacity = patch.capacity;
    if (patch.minimumAge !== undefined) updateData.minimum_age = patch.minimumAge;
    if (patch.coverImageUrl !== undefined) {
      if (patch.coverImageUrl) {
        const binding = await requireOwnedEventMedia(
          this.db,
          existing,
          patch.coverImageUrl,
          'event_cover',
        );
        mediaBindings.push(binding);
        updateData.cover_image_url = binding.pathname;
      } else {
        updateData.cover_image_url = patch.coverImageUrl;
      }
    }
    if (patch.externalUrl !== undefined) updateData.external_url = patch.externalUrl;
    if (patch.coverImageAlt !== undefined) updateData.cover_image_alt = patch.coverImageAlt;
    if (patch.seoUseCoverImage !== undefined)
      updateData.seo_use_cover_image = patch.seoUseCoverImage;
    if (patch.lastSetupSection !== undefined)
      updateData.last_setup_section = patch.lastSetupSection;

    const requestedFields = Object.keys(body)
      .filter((field) => field !== 'expectedVersion' && field !== 'status')
      .concat(patch.venueId !== undefined && updateData.venue !== undefined ? ['venue'] : [])
      .filter((field, index, fields) => fields.indexOf(field) === index)
      .sort();
    const beforeProjection = eventPatchProjection(existing);
    const afterProjection = eventPatchProjection(applyProjectionUpdate(existing, updateData));
    return {
      eventId: input.eventId,
      tenantId: input.tenantId,
      expectedVersion: patch.expectedVersion,
      currentVersion: Number(existing.version),
      updateData,
      requestedFields,
      before: projectedFields(beforeProjection, requestedFields),
      after: projectedFields(afterProjection, requestedFields),
      mediaBindings,
    };
  }

  async applyResolvedPatch(resolved: ResolvedEventPatch): Promise<ApplyResolvedEventPatchResult> {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const repo = new EventRepository(transaction as Database);
        const current = await repo.findById(resolved.eventId);
        if (!current || current.tenant_id !== resolved.tenantId)
          throw new NotFoundError('Event', resolved.eventId);
        if (Number(current.version) !== resolved.expectedVersion)
          throw new StaleEventPatchError(Number(current.version));

        if (typeof resolved.updateData.slug === 'string') {
          const slugAvailable = await repo.isSlugAvailable(
            current.brand_id,
            resolved.updateData.slug,
            resolved.eventId,
          );
          if (!slugAvailable) throw new ValidationError('Event slug is already in use');
        }
        if (typeof resolved.updateData.venue_id === 'string') {
          const venue = await transaction
            .selectFrom('venues')
            .select('id')
            .where('id', '=', resolved.updateData.venue_id)
            .where('tenant_id', '=', current.tenant_id)
            .where('organization_id', '=', current.organization_id)
            .executeTakeFirst();
          if (!venue) throw new NotFoundError('Venue', resolved.updateData.venue_id);
        }
        for (const binding of resolved.mediaBindings)
          await renewEventMediaLease(transaction, current, binding);

        const updated = await repo.updateIfVersion(
          resolved.eventId,
          resolved.expectedVersion,
          resolved.updateData,
        );
        if (!updated) {
          const latest = await repo.findById(resolved.eventId);
          throw new StaleEventPatchError(Number(latest?.version ?? resolved.expectedVersion));
        }
        return { applied: true as const, event: updated };
      });
    } catch (error) {
      if (error instanceof StaleEventPatchError)
        return { applied: false, currentVersion: error.currentVersion };
      throw error;
    }
  }
}
