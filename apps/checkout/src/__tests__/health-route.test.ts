import { describe, expect, it } from 'vitest';
import { GET } from '../app/health/route';

describe('checkout health route', () => {
  it('returns a non-cacheable ok response', async () => {
    const response = GET();

    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      service: 'tixkit-checkout',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
