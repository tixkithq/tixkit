import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adoptionPaths } from '../lib/adoption-paths';
import { docsSiteConfig } from '../lib/site';
import { documentationNavigation } from '../../../../docs/navigation';

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
    expect(homePage).not.toMatch(/\b(?:Kysely|Kubernetes|Redis|Temporal|object storage)\b/i);
  });

  it('keeps each first task inside its selected adoption path', () => {
    const [chooser, sell, platform, , , selfHosted] = documentationNavigation;
    expect(chooser).toMatchObject({
      label: 'Choose how to use Tixkit',
      children: [{ routeId: 'sellTickets' }, { routeId: 'platformApi' }, { routeId: 'selfHosted' }],
    });
    expect(sell?.children?.slice(0, 3).map((item) => item.routeId)).toEqual([
      'sellQuickstart',
      'firstEvent',
      'testCheckout',
    ]);
    expect(platform?.children?.slice(0, 3).map((item) => item.routeId)).toEqual([
      'platformQuickstart',
      'firstApiCall',
      'apiFundamentals',
    ]);
    expect(selfHosted?.children?.slice(0, 3).map((item) => item.routeId)).toEqual([
      'deploymentModel',
      'localQuickstart',
      'platformOverview',
    ]);
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

  it('keeps infrastructure language out of both hosted quickstarts', () => {
    const repositoryRoot = resolve(import.meta.dirname, '../../../..');
    for (const path of ['docs/public/sell/quickstart.mdx', 'docs/public/platform/quickstart.mdx']) {
      const source = readFileSync(resolve(repositoryRoot, path), 'utf8');
      expect(source).not.toMatch(
        /\b(?:Kubernetes|Helm|database|Redis|Temporal|object storage|deployment topology|self-host)\b/i,
      );
      expect(source).toMatch(/experimental private beta/i);
      expect(source).toMatch(/not generally available/i);
    }
  });

  it('keeps infrastructure language out of the first shared Sell and Platform tasks', () => {
    const repositoryRoot = resolve(import.meta.dirname, '../../../..');
    for (const path of [
      'docs/public/getting-started/first-event.mdx',
      'docs/public/getting-started/test-checkout.mdx',
      'docs/public/developers/api-fundamentals/index.mdx',
      'docs/public/getting-started/first-api-call.mdx',
    ]) {
      const source = readFileSync(resolve(repositoryRoot, path), 'utf8');
      expect(source).not.toMatch(
        /\b(?:Kubernetes|Helm|database|Redis|Temporal|object storage|deployment topology|self-host|localhost)\b/i,
      );
    }
  });

  it('never demonstrates a literal Tixkit API secret assignment', () => {
    const repositoryRoot = resolve(import.meta.dirname, '../../../..');
    for (const path of [
      'docs/public/platform/quickstart.mdx',
      'docs/public/getting-started/first-api-call.mdx',
    ]) {
      const source = readFileSync(resolve(repositoryRoot, path), 'utf8');
      expect(source).not.toMatch(/(?:export\s+)?TIXKIT_API_KEY\s*=\s*['"][^$]/);
      expect(source).not.toMatch(/(?:--header|-H)\s+['"][^'"\n]*\$TIXKIT_API_KEY/);
      expect(source).toContain('IFS= read -r -s TIXKIT_API_KEY');
      expect(source).toContain('unset TIXKIT_API_KEY');
      expect(source).toContain('curl --fail-with-body --config - <<EOF');
    }
  });

  it('documents every required agent Platform API safety boundary', () => {
    const repositoryRoot = resolve(import.meta.dirname, '../../../..');
    const source = readFileSync(
      resolve(repositoryRoot, 'docs/public/platform/agent-platform.mdx'),
      'utf8',
    );
    for (const requiredClause of [
      /explicit principals/i,
      /delegation/i,
      /typed action/i,
      /dry[- ]run/i,
      /digest-bound human approval/i,
      /audit/i,
      /revok/i,
      /experimental private beta/i,
      /not generally available/i,
    ]) {
      expect(source).toMatch(requiredClause);
    }
    expect(source).toContain(
      'Agent memory is separately retained, scoped, inspectable, correctable, exportable and deletable.',
    );
  });
});
