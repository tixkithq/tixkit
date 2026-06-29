import { describe, expect, it, vi } from 'vitest';
import { TixkitClient } from '@tixkit/js';
import {
  createTixkitClient,
  loadPublicEventDiscoveryCard,
  loadPublicEventPage,
  loadPublicEventPageBySlug,
  verifyTixkitWebhook,
} from '../server.js';

describe('Remix server helpers', () => {
  it('creates a server-side Tixkit client', () => {
    expect(createTixkitClient({ apiKey: 'tk_test_placeholder' })).toBeInstanceOf(TixkitClient);
  });

  it('loads public content-studio event pages through the JS SDK public client', async () => {
    const client = {
      public: {
        getEventPage: vi.fn(async () => ({ page: { discovery: { title: 'All Access' } } })),
        getEventPageBySlug: vi.fn(async () => ({ document: { eventId: 'evt_1' } })),
        getEventDiscoveryCard: vi.fn(async () => ({ title: 'All Access' })),
      },
    } as unknown as TixkitClient;

    await loadPublicEventPage(client, 'evt_1', { locale: 'en' });
    await loadPublicEventPageBySlug(client, 'all-access', {
      host: 'events.example.com',
      locale: 'en',
    });
    await loadPublicEventDiscoveryCard(client, 'evt_1');

    expect(client.public.getEventPage).toHaveBeenCalledWith('evt_1', { locale: 'en' });
    expect(client.public.getEventPageBySlug).toHaveBeenCalledWith('all-access', {
      host: 'events.example.com',
      locale: 'en',
    });
    expect(client.public.getEventDiscoveryCard).toHaveBeenCalledWith('evt_1', undefined);
  });

  it('returns false for an invalid webhook signature', () => {
    expect(
      verifyTixkitWebhook({
        body: JSON.stringify({ id: 'wevt_1' }),
        secret: 'whsec_test',
        signature: 't=1,v1=bad',
      }),
    ).toBe(false);
  });

  it('returns false for a malformed signature', () => {
    expect(
      verifyTixkitWebhook({
        body: JSON.stringify({ id: 'wevt_1' }),
        secret: 'whsec_test',
        signature: 'not-a-signature',
      }),
    ).toBe(false);
  });

  it('returns false for an empty signature', () => {
    expect(
      verifyTixkitWebhook({
        body: JSON.stringify({ id: 'wevt_1' }),
        secret: 'whsec_test',
        signature: '',
      }),
    ).toBe(false);
  });
});
