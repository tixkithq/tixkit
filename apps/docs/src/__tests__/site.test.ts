import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adoptionPaths } from '../lib/adoption-paths';
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

describe('adoption-path information architecture', () => {
  it('presents exactly the three accepted paths from the homepage', () => {
    expect(adoptionPaths.map(({ title, href }) => ({ title, href }))).toEqual([
      { title: 'Sell tickets with Tixkit', href: '/sell' },
      { title: 'Add ticketing to my product', href: '/platform' },
      { title: 'Run Tixkit on my infrastructure', href: '/self-hosted' },
    ]);
    const repositoryRoot = resolve(import.meta.dirname, '../../../..');
    const homePage = readFileSync(resolve(repositoryRoot, 'apps/docs/src/app/page.tsx'), 'utf8');
    expect(homePage).toContain('How do you want to use Tixkit?');
  });

  it('keeps infrastructure language out of the Sell and Platform entry paths', () => {
    const repositoryRoot = resolve(import.meta.dirname, '../../../..');
    for (const path of ['docs/public/sell/index.mdx', 'docs/public/platform/index.mdx']) {
      const source = readFileSync(resolve(repositoryRoot, path), 'utf8');
      expect(source).not.toMatch(
        /\b(?:Kubernetes|Helm|database|Redis|Temporal|object storage|deployment topology|self-host)\b/i,
      );
    }
  });
});
