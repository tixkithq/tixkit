import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import {
  EventPageSurface,
  type SurfaceEditing,
} from '../index.js';
import {
  createDefaultEventPageDocument,
  resolveEventPageDocument,
  type EventPageRenderContext,
} from '@tixkit/content-event-page';

const brandA: EventPageRenderContext = {
  event: {
    title: 'Brand A Event',
    startsAt: '2025-08-15T20:00:00Z',
    endsAt: '2025-08-15T23:00:00Z',
    timezone: 'America/New_York',
    venueName: 'Venue A',
    checkoutUrl: 'https://checkout.test/a/checkout',
    publicUrl: 'https://a.test/e/e1',
  },
  brand: {
    name: 'Brand A',
    supportUrl: 'https://a.test/support',
    termsUrl: 'https://a.test/terms',
    privacyUrl: 'https://a.test/privacy',
    refundUrl: 'https://a.test/refund',
  },
  tickets: [
    { id: 't1', name: 'GA', status: 'active', priceLabel: '$30' },
  ],
};

const brandB: EventPageRenderContext = {
  event: {
    title: 'Brand B Event',
    startsAt: '2025-09-20T19:00:00Z',
    endsAt: '2025-09-20T22:00:00Z',
    timezone: 'Europe/London',
    venueName: 'Venue B',
    checkoutUrl: 'https://checkout.test/b/checkout',
    publicUrl: 'https://b.test/e/e2',
  },
  brand: {
    name: 'Brand B',
    supportUrl: 'https://b.test/support',
    termsUrl: 'https://b.test/terms',
    privacyUrl: 'https://b.test/privacy',
    refundUrl: 'https://b.test/refund',
  },
  tickets: [
    { id: 't2', name: 'VIP', status: 'active', priceLabel: '£75' },
  ],
};

describe('Two-brand isolation', () => {
  it('public surface renders different brand names for two brands', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'e1',
      eventTitle: 'Test Event',
      eventDescription: 'Description.',
      startsAt: '2025-08-15T20:00:00Z',
      endsAt: '2025-08-15T23:00:00Z',
      timezone: 'America/New_York',
    });

    const resolvedA = resolveEventPageDocument(doc, brandA);
    const resolvedB = resolveEventPageDocument(doc, brandB);

    const { container: containerA } = render(<EventPageSurface resolvedPage={resolvedA} mode="public" />);
    const { container: containerB } = render(<EventPageSurface resolvedPage={resolvedB} mode="public" />);

    // Brand footer links should reflect each brand's URLs
    const linksA = Array.from(containerA.querySelectorAll('.tk-ep-footer a')).map((el) => el.getAttribute('href'));
    const linksB = Array.from(containerB.querySelectorAll('.tk-ep-footer a')).map((el) => el.getAttribute('href'));

    expect(linksA).toContain('https://a.test/support');
    expect(linksB).toContain('https://b.test/support');
    expect(linksA).not.toEqual(linksB);
  });

  it('public surface renders different event titles for two brands', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'e1',
      eventTitle: 'Shared Title',
      eventDescription: 'Description.',
    });

    const resolvedA = resolveEventPageDocument(doc, brandA);
    const resolvedB = resolveEventPageDocument(doc, brandB);

    const { container: containerA } = render(<EventPageSurface resolvedPage={resolvedA} mode="public" />);
    const { container: containerB } = render(<EventPageSurface resolvedPage={resolvedB} mode="public" />);

    const titleA = containerA.querySelector('.tk-ep-header__title')?.textContent;
    const titleB = containerB.querySelector('.tk-ep-header__title')?.textContent;

    expect(titleA).toBe('Brand A Event');
    expect(titleB).toBe('Brand B Event');
  });

  it('edit surface does not render white-label or reseller controls', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'e1',
      eventTitle: 'Test Event',
    });
    const resolved = resolveEventPageDocument(doc, brandA, { mode: 'edit' });
    const editing: SurfaceEditing = {
      document: doc,
      disabled: false,
      onChangeBlock: () => {},
    };
    const { container } = render(
      <EventPageSurface resolvedPage={resolved} mode="edit" editing={editing} />,
    );

    // The OSS editor surface should not contain white-label controls
    expect(container.querySelector('[data-white-label]')).toBeNull();
    expect(container.querySelector('.tk-reseller')).toBeNull();
    expect(container.querySelector('.tk-admin-chrome')).toBeNull();
    // The surface should render the standard event-page classes
    expect(container.querySelector('.tixkit-event-page')).not.toBeNull();
    expect(container.querySelector('[data-block-id]')).not.toBeNull();
  });

  it('edit surface produces identical block structure regardless of brand context', () => {
    const doc = createDefaultEventPageDocument({
      eventId: 'e1',
      eventTitle: 'Test Event',
    });
    const editing: SurfaceEditing = {
      document: doc,
      disabled: false,
      onChangeBlock: () => {},
    };
    const resolvedA = resolveEventPageDocument(doc, brandA, { mode: 'edit' });
    const resolvedB = resolveEventPageDocument(doc, brandB, { mode: 'edit' });

    const { container: containerA } = render(
      <EventPageSurface resolvedPage={resolvedA} mode="edit" editing={editing} />,
    );
    const { container: containerB } = render(
      <EventPageSurface resolvedPage={resolvedB} mode="edit" editing={editing} />,
    );

    // The block structure should be identical regardless of brand
    const blocksA = Array.from(containerA.querySelectorAll('[data-block-id]')).map((el) =>
      el.getAttribute('data-block-id'),
    );
    const blocksB = Array.from(containerB.querySelectorAll('[data-block-id]')).map((el) =>
      el.getAttribute('data-block-id'),
    );

    expect(blocksA).toEqual(blocksB);
  });
});
