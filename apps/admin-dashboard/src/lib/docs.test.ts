import { afterEach, describe, expect, it } from 'vitest';
import { dashboardDocUrl } from './docs';

const originalOrigin = process.env.NEXT_PUBLIC_TIXKIT_DOCS_URL;

afterEach(() => {
  if (originalOrigin === undefined) delete process.env.NEXT_PUBLIC_TIXKIT_DOCS_URL;
  else process.env.NEXT_PUBLIC_TIXKIT_DOCS_URL = originalOrigin;
});

describe('dashboardDocUrl', () => {
  it('uses the local docs app by default', () => {
    delete process.env.NEXT_PUBLIC_TIXKIT_DOCS_URL;
    expect(dashboardDocUrl('apiReference')).toBe('http://localhost:3002/reference/api');
  });

  it('resolves configured production origins and rejects malformed configuration', () => {
    process.env.NEXT_PUBLIC_TIXKIT_DOCS_URL = 'https://docs.example.test';
    expect(dashboardDocUrl('webhookEvents')).toBe(
      'https://docs.example.test/reference/webhook-events',
    );
    process.env.NEXT_PUBLIC_TIXKIT_DOCS_URL = 'not a URL';
    expect(() => dashboardDocUrl('apiReference')).toThrow('Invalid documentation origin');
  });
});
