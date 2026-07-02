import { describe, expect, it } from 'vitest';
import { publicEventUrl } from './event-links';
import type { AdminBrand } from './api';

const brand: AdminBrand = {
  id: 'brd_1',
  tenantId: 'tnt_1',
  organizationId: 'org_1',
  name: 'Brand',
  slug: 'brand',
  status: 'active',
  theme: {},
  domains: [],
  legalUrls: {},
  whiteLabel: false,
};

describe('publicEventUrl', () => {
  it('uses the free hosted event-id route without an active verified custom domain', () => {
    expect(publicEventUrl({ id: 'evt_1', slug: 'launch', brandId: 'brd_1' }, [brand])).toBe(
      'http://localhost:3000/e/evt_1',
    );
  });

  it('uses clean root slugs for active verified custom domains', () => {
    expect(
      publicEventUrl({ id: 'evt_1', slug: 'launch', brandId: 'brd_1' }, [
        {
          ...brand,
          whiteLabel: true,
          domains: [
            {
              id: 'bdom_1',
              brandId: 'brd_1',
              domain: 'events.example.com',
              isPrimary: true,
              isVerified: true,
              sslStatus: 'active',
            },
          ],
        },
      ]),
    ).toBe('https://events.example.com/launch');
  });

  it('falls back when a verified domain is not white-label enabled', () => {
    expect(
      publicEventUrl({ id: 'evt_1', slug: 'launch', brandId: 'brd_1' }, [
        {
          ...brand,
          whiteLabel: false,
          domains: [
            {
              id: 'bdom_1',
              brandId: 'brd_1',
              domain: 'events.example.com',
              isPrimary: true,
              isVerified: true,
              sslStatus: 'active',
            },
          ],
        },
      ]),
    ).toBe('http://localhost:3000/e/evt_1');
  });
});
