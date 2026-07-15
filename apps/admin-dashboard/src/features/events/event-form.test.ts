import { describe, expect, it } from 'vitest';
import {
  buildEventDatePayload,
  buildEventUpdatePayload,
  eventSchema,
  planEventFormRecovery,
  type EventFormRecoverySnapshot,
  type EventFormValues,
} from './event-form';

const validBase = {
  title: 'Test Event',
  startsAt: '2026-08-15T19:00',
  timezone: 'America/New_York',
  visibility: 'public',
  currency: 'USD',
};

describe('eventSchema date order refinement', () => {
  it('passes when endsAt is after startsAt', () => {
    const result = eventSchema.safeParse({
      ...validBase,
      endsAt: '2026-08-16T19:00',
    });
    expect(result.success).toBe(true);
  });

  it('passes when endsAt is omitted', () => {
    const result = eventSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it('fails when endsAt is before startsAt', () => {
    const result = eventSchema.safeParse({
      ...validBase,
      endsAt: '2026-08-14T19:00',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('endsAt'));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('after start date');
    }
  });

  it('fails when endsAt equals startsAt', () => {
    const result = eventSchema.safeParse({
      ...validBase,
      endsAt: '2026-08-15T19:00',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional minimum age and rejects unrealistic values', () => {
    expect(eventSchema.safeParse({ ...validBase, minimumAge: 21 }).success).toBe(true);
    expect(eventSchema.safeParse({ ...validBase, minimumAge: -1 }).success).toBe(false);
    expect(eventSchema.safeParse({ ...validBase, minimumAge: 121 }).success).toBe(false);
  });
});

describe('buildEventDatePayload', () => {
  it('converts datetime-local form values to backend ISO timestamps', () => {
    const payload = buildEventDatePayload({
      startsAt: '2026-08-15T19:00',
      endsAt: '2026-08-16T19:00',
      timezone: 'America/New_York',
    });

    expect(payload?.startsAt).toBe('2026-08-15T23:00:00.000Z');
    expect(payload?.endsAt).toBe('2026-08-16T23:00:00.000Z');
  });
});

describe('buildEventUpdatePayload', () => {
  const fullValues = {
    title: 'Updated Event',
    slug: 'updated-event',
    description: '',
    startsAt: '2026-08-15T19:00',
    endsAt: '',
    timezone: 'America/New_York',
    status: 'published' as const,
    visibility: 'private' as const,
    venueName: '',
    address: '',
    city: '',
    region: '',
    postalCode: '',
    country: '',
    capacity: undefined,
    coverImageUrl: '',
    externalUrl: '',
    seoTitle: '',
    seoDescription: '',
    seoImageUrl: '',
    currency: 'USD',
  };

  it('omits unchanged fields from update payloads', () => {
    expect(buildEventUpdatePayload(fullValues, {})).toEqual({});
  });

  it('uses initial values as a fallback when dirty fields omit changed optional values', () => {
    expect(
      buildEventUpdatePayload(
        {
          ...fullValues,
          coverImageUrl: 'https://example.com/cover.jpg',
          externalUrl: 'https://example.com/event',
          seoImageUrl: 'https://example.com/seo.jpg',
        },
        {},
        fullValues,
      ),
    ).toMatchObject({
      coverImageUrl: 'https://example.com/cover.jpg',
      externalUrl: 'https://example.com/event',
      seo: {
        imageUrl: 'https://example.com/seo.jpg',
      },
    });
  });

  it('sends null when nullable detail fields are cleared', () => {
    expect(
      buildEventUpdatePayload(fullValues, {
        capacity: true,
        minimumAge: true,
        coverImageUrl: true,
        externalUrl: true,
        endsAt: true,
        venueName: true,
      }),
    ).toMatchObject({
      capacity: null,
      minimumAge: null,
      coverImageUrl: null,
      externalUrl: null,
      endsAt: null,
      venue: null,
    });
  });

  it('preserves explicit values for editable detail fields', () => {
    expect(
      buildEventUpdatePayload(
        {
          ...fullValues,
          slug: 'new-event-slug',
          description: 'Detailed description',
          endsAt: '2026-08-16T19:00',
          venueName: 'Main Hall',
          address: '1 Market St',
          city: 'New York',
          region: 'NY',
          postalCode: '10001',
          country: 'US',
          capacity: 250,
          minimumAge: 21,
          coverImageUrl: 'https://example.com/cover.jpg',
          externalUrl: 'https://example.com/event',
          seoTitle: 'SEO title',
          seoDescription: 'SEO description',
          seoImageUrl: 'https://example.com/seo.jpg',
        },
        {
          description: true,
          endsAt: true,
          venueName: true,
          address: true,
          city: true,
          region: true,
          postalCode: true,
          country: true,
          capacity: true,
          minimumAge: true,
          coverImageUrl: true,
          externalUrl: true,
          seoTitle: true,
          seoDescription: true,
          seoImageUrl: true,
          visibility: true,
          slug: true,
        },
      ),
    ).toMatchObject({
      slug: 'new-event-slug',
      description: 'Detailed description',
      endsAt: '2026-08-16T23:00:00.000Z',
      venue: {
        name: 'Main Hall',
        address: '1 Market St',
        city: 'New York',
        region: 'NY',
        postalCode: '10001',
        country: 'US',
      },
      capacity: 250,
      minimumAge: 21,
      coverImageUrl: 'https://example.com/cover.jpg',
      externalUrl: 'https://example.com/event',
      seo: {
        title: 'SEO title',
        description: 'SEO description',
        imageUrl: 'https://example.com/seo.jpg',
      },
      visibility: 'private',
    });
  });
});

describe('planEventFormRecovery', () => {
  const base = {
    title: 'Base title',
    slug: 'base-title',
    description: 'Base description',
    startsAt: '2026-08-15T19:00',
    endsAt: '2026-08-15T21:00',
    timezone: 'America/Chicago',
    status: 'draft' as const,
    visibility: 'public' as const,
    venueName: 'Base Hall',
    address: '1 Main St',
    city: 'Chicago',
    region: 'IL',
    postalCode: '60601',
    country: 'US',
    capacity: 100,
    minimumAge: 18,
    coverImageUrl: '',
    externalUrl: '',
    seoTitle: 'Base SEO',
    seoDescription: 'Base SEO description',
    seoImageUrl: '',
    currency: 'USD',
  } satisfies EventFormValues;

  const recovery = (
    values: EventFormValues,
    dirtyFields: Array<keyof EventFormValues>,
    overrides: Partial<EventFormRecoverySnapshot> = {},
  ): EventFormRecoverySnapshot => ({
    schemaVersion: 1,
    values,
    baseValues: base,
    dirtyFields,
    selectedVenueId: 'ven_base',
    baseSelectedVenueId: 'ven_base',
    ...overrides,
  });

  it('merges unrelated local and remote fields without a conflict', () => {
    const plan = planEventFormRecovery(
      { ...base, description: 'Remote description' },
      recovery({ ...base, title: 'My title' }, ['title']),
      'ven_base',
    );

    expect(plan.values).toMatchObject({
      title: 'My title',
      description: 'Remote description',
    });
    expect(plan.conflicts).toEqual([]);
  });

  it('requires an explicit choice when the same scalar changed in both versions', () => {
    const plan = planEventFormRecovery(
      { ...base, title: 'Remote title' },
      recovery({ ...base, title: 'My title' }, ['title']),
      'ven_base',
    );

    expect(plan.values.title).toBe('My title');
    expect(plan.conflicts).toEqual(['title']);
  });

  it('treats schedule, venue, and SEO patch fields as atomic conflict groups', () => {
    const local = {
      ...base,
      startsAt: '2026-08-15T20:00',
      venueName: 'My Hall',
      seoTitle: 'My SEO',
    };
    const latest = {
      ...base,
      timezone: 'America/New_York',
      city: 'Evanston',
      seoDescription: 'Remote SEO description',
    };
    const plan = planEventFormRecovery(
      latest,
      recovery(local, ['startsAt', 'venueName', 'seoTitle'], {
        selectedVenueId: 'ven_local',
      }),
      'ven_remote',
    );

    expect(plan.conflicts).toEqual(expect.arrayContaining(['schedule', 'venue', 'seo']));
    expect(plan.selectedVenueId).toBe('ven_local');
    expect(plan.values).toMatchObject({
      startsAt: '2026-08-15T20:00',
      timezone: 'America/Chicago',
      venueName: 'My Hall',
      city: 'Chicago',
      seoTitle: 'My SEO',
      seoDescription: 'Base SEO description',
    });
  });

  it('detects a remote-only saved venue binding change against local venue edits', () => {
    const plan = planEventFormRecovery(
      base,
      recovery({ ...base, venueName: 'My Hall' }, ['venueName']),
      'ven_remote',
    );
    expect(plan.conflicts).toContain('venue');
    expect(plan.selectedVenueId).toBe('ven_base');
  });

  it('does not conflict when both versions converged on the same value', () => {
    const plan = planEventFormRecovery(
      { ...base, title: 'Shared title' },
      recovery({ ...base, title: 'Shared title' }, ['title']),
      'ven_base',
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.values.title).toBe('Shared title');
  });

  it('fails conservatively when an older recovery snapshot has no base values', () => {
    const plan = planEventFormRecovery(
      base,
      recovery({ ...base, title: 'Recovered title' }, ['title'], {
        baseValues: undefined,
        baseSelectedVenueId: undefined,
      }),
    );
    expect(plan.conflicts).toEqual(expect.arrayContaining(['title', 'venue']));
  });
});
