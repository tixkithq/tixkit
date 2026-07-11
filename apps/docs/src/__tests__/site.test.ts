import { afterEach, describe, expect, it } from 'vitest';
import { docsSiteConfig } from '../lib/site';

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
});

describe('docs site configuration', () => {
  it('provides safe local defaults', () => {
    delete process.env.TIXKIT_DOCS_SITE_URL;
    expect(docsSiteConfig()).toMatchObject({
      siteUrl: 'http://localhost:3002',
      apiBaseUrl: 'http://localhost:4000',
      version: 'current',
    });
  });

  it('rejects malformed and credential-bearing URLs', () => {
    process.env.TIXKIT_DOCS_SITE_URL = 'not-a-url';
    expect(() => docsSiteConfig()).toThrow('must be a valid absolute URL');
    process.env.TIXKIT_DOCS_SITE_URL = 'https://user:secret@docs.example.com';
    expect(() => docsSiteConfig()).toThrow('without credentials');
  });
});
