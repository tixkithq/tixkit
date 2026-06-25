import type { BaseEntity, ISO8601Date, Locale, Slug, TenantOrgScopedEntity, Timezone, Ulid } from '../shared/index.js';

export type EventStatus = 'draft' | 'published' | 'paused' | 'ended' | 'archived';
export type EventVisibility = 'public' | 'unlisted' | 'private';

export type Venue = {
  name: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
};

export type SeoMeta = {
  title?: string;
  description?: string;
  imageUrl?: string;
};

export type Event = TenantOrgScopedEntity & {
  brandId: Ulid;
  slug: Slug;
  title: string;
  description?: string;
  status: EventStatus;
  timezone: Timezone;
  startsAt: ISO8601Date;
  endsAt?: ISO8601Date;
  venue?: Venue;
  visibility: EventVisibility;
  seo: SeoMeta;
  capacity?: number;
  coverImageUrl?: string;
  externalUrl?: string;
};

export type EventSchedule = BaseEntity & {
  eventId: Ulid;
  title: string;
  startsAt: ISO8601Date;
  endsAt: ISO8601Date;
  location?: string;
  sortOrder: number;
};

export type OrganizerProfile = TenantOrgScopedEntity & {
  name: string;
  description?: string;
  logoUrl?: string;
  websiteUrl?: string;
  socialLinks?: Record<string, string>;
};

export type EventPage = BaseEntity & {
  eventId: Ulid;
  locale: Locale;
  title: string;
  description?: string;
  contentHtml?: string;
  isDefault: boolean;
};

export type EventLocalization = BaseEntity & {
  eventId: Ulid;
  locale: Locale;
  fields: Record<string, string>;
};

export type CreateEventInput = {
  organizationId: Ulid;
  brandId: Ulid;
  slug: Slug;
  title: string;
  description?: string;
  timezone: Timezone;
  startsAt: ISO8601Date;
  endsAt?: ISO8601Date;
  venue?: Venue;
  visibility?: EventVisibility;
  seo?: Partial<SeoMeta>;
  capacity?: number;
};

export type UpdateEventInput = Partial<
  Pick<
    Event,
    'slug' | 'title' | 'description' | 'status' | 'timezone' | 'startsAt' | 'endsAt' | 'venue' | 'visibility' | 'seo' | 'capacity' | 'coverImageUrl' | 'externalUrl'
  >
>;
