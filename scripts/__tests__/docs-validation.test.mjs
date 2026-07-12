import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkFrontmatter } from '../docs/check-frontmatter.mjs';
import {
  extractHeadings,
  parseFrontmatter,
  validateDocumentLinks,
  validateFrontmatter,
  validateNavigation,
  validatePackageReadmes,
  validateRedirects,
} from '../docs/lib/content.mjs';

const validFrontmatter = {
  title: 'Test page',
  description: 'A complete fixture for documentation validation.',
  audience: ['developer'],
  product_area: 'api',
  content_type: 'how-to',
  status: 'stable',
  owner: 'developer-platform',
  last_verified: '2026-07-10',
  prerequisites: [],
  related: [],
};

function withRoot(callback) {
  const root = mkdtempSync(join(tmpdir(), 'tixkit-docs-validation-'));
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function write(root, path, content) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content, 'utf8');
}

function publicPage(frontmatter = validFrontmatter, body = '## Outcome\n\nThe fixture works.\n') {
  const yaml = Object.entries(frontmatter)
    .map(([key, value]) => {
      if (Array.isArray(value))
        return value.length === 0
          ? `${key}: []`
          : `${key}:\n${value.map((item) => `  - ${item}`).join('\n')}`;
      return `${key}: ${value}`;
    })
    .join('\n');
  return `---\n${yaml}\n---\n${body}`;
}

test('frontmatter parser and validator accept a complete public page', () => {
  const parsed = parseFrontmatter(publicPage(), 'docs/public/test.mdx');
  assert.equal(parsed.data.title, 'Test page');
  assert.deepEqual(validateFrontmatter(parsed.data, 'docs/public/test.mdx'), []);
});

test('frontmatter checks fail on missing files and seeded invalid metadata', () => {
  withRoot((root) => {
    assert.deepEqual(checkFrontmatter(root), ['docs/public: no public documentation pages found']);
    write(
      root,
      'docs/public/test.mdx',
      publicPage({
        ...validFrontmatter,
        audience: ['unknown'],
        status: 'internal',
      }),
    );
    const errors = checkFrontmatter(root);
    assert.ok(errors.some((error) => error.includes('invalid audience unknown')));
    assert.ok(errors.some((error) => error.includes('public content cannot use status internal')));
  });
});

test('heading extraction creates deterministic duplicate deep links', () => {
  assert.deepEqual(extractHeadings('## Verify\n\n### Verify\n\n## Verify\n'), [
    { id: 'verify', text: 'Verify', level: 2 },
    { id: 'verify-1', text: 'Verify', level: 3 },
    { id: 'verify-2', text: 'Verify', level: 2 },
  ]);
});

test('link validation rejects missing routes and anchors', () => {
  const documents = [
    {
      path: 'docs/public/a.mdx',
      route: '/a',
      frontmatter: validFrontmatter,
      body: '[B](/b#missing)',
      headings: [],
    },
    {
      path: 'docs/public/b.mdx',
      route: '/b',
      frontmatter: validFrontmatter,
      body: '',
      headings: [{ id: 'present', text: 'Present', level: 2 }],
    },
  ];
  assert.deepEqual(validateDocumentLinks(documents), [
    'docs/public/a.mdx: broken documentation anchor /b#missing',
  ]);
  documents[0].body = '[Missing](/missing)';
  assert.deepEqual(validateDocumentLinks(documents), [
    'docs/public/a.mdx: broken documentation link /missing',
  ]);
});

test('navigation validation rejects missing targets, duplicates, and orphan pages', () => {
  const documents = [
    {
      path: 'docs/public/orphan.mdx',
      route: '/orphan',
      frontmatter: validFrontmatter,
      body: '',
      headings: [],
    },
  ];
  const navigation = [
    {
      label: 'API',
      children: [
        { label: 'Endpoints', routeId: 'apiReference' },
        { label: 'Endpoints', routeId: 'apiReference' },
      ],
    },
  ];
  const errors = validateNavigation(documents, navigation);
  assert.ok(errors.some((error) => error.includes('duplicate routeId apiReference')));
  assert.ok(errors.some((error) => error.includes('duplicate sibling label Endpoints')));
  assert.ok(errors.some((error) => error.includes('targets missing page /reference/api')));
  assert.ok(errors.some((error) => error.includes('public page is orphaned')));
});

test('package README validation rejects missing and boilerplate documentation', () => {
  withRoot((root) => {
    write(root, 'packages/example/package.json', JSON.stringify({ name: '@tixkit/example' }));
    assert.deepEqual(validatePackageReadmes(root), [
      'packages/example/README.md: missing package README',
    ]);
    write(root, 'packages/example/README.md', '# @tixkit/example\n\nTODO\n');
    const errors = validatePackageReadmes(root);
    assert.ok(errors.some((error) => error.includes('missing required heading Purpose')));
    assert.ok(errors.some((error) => error.includes('placeholder marker')));
  });
});

test('redirect validation rejects chains, duplicate targets, and missing anchors', () => {
  const documents = [
    {
      path: 'docs/public/target.mdx',
      route: '/target',
      frontmatter: validFrontmatter,
      body: '',
      headings: [{ id: 'present', text: 'Present', level: 2 }],
    },
  ];
  const errors = validateRedirects(documents, {
    '/old': '/target#missing',
    '/older': '/old',
    '/duplicate': '/target#missing',
  });
  assert.ok(errors.some((error) => error.includes('redirect chain')));
  assert.ok(errors.some((error) => error.includes('missing anchor')));
  assert.ok(errors.some((error) => error.includes('duplicate destination')));
});

test('SDK guide sections stay synchronized in manifest and local search', () => {
  execFileSync('node', ['scripts/docs/generate-content-manifest.mjs'], {
    stdio: 'pipe',
  });
  const search = JSON.parse(readFileSync('apps/docs/public/search-index.json', 'utf8'));
  const sdkRecords = search.filter((record) => record.url.startsWith('/sdks/'));
  assert.equal(sdkRecords.length, 12);
  for (const record of sdkRecords) {
    assert.deepEqual(
      record.headings.map(({ id }) => id),
      ['install', 'configure', 'first-request', 'troubleshoot', 'verify-and-continue'],
    );
    assert.match(record.body, /version mismatch/);
    assert.match(record.body, /unauthorized credentials/);
  }
});

test('documentation workflows trigger for executable SDK demo changes', () => {
  for (const path of ['.github/workflows/docs-ci.yml', '.github/workflows/trusted-docs-ci.yml']) {
    const workflow = readFileSync(path, 'utf8');
    assert.match(workflow, /- ["']apps\/sdk-\*-demo\/\*\*["']/);
    assert.match(workflow, /bun run sdk:demos:check/);
  }
});
