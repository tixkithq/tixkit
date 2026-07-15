import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(
  process.env.TIXKIT_DOCUMENTATION_INVENTORY_ROOT ??
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
);
const outputPath = 'docs/internal/documentation-inventory.csv';
const verifiedDate = '2026-07-10';

const publicDocs = [
  'docs/accessibility-conformance-statement.md',
  'docs/email-sms-deliverability-runbook.md',
  'docs/embed-generator.html',
  'docs/performance.md',
  'docs/privacy-retention-policy.md',
  'docs/production-validation-harness.md',
  'docs/security-tenant-isolation-audit.md',
  'docs/telnyx-sms-local.md',
];

const publicPackageDirectories = [
  'packages/admin-table-core',
  'packages/api',
  'packages/cli',
  'packages/content-core',
  'packages/content-editor-shell',
  'packages/content-email',
  'packages/content-event-page',
  'packages/content-event-page-react',
  'packages/content-message',
  'packages/db',
  'packages/domain',
  'packages/email-transport',
  'packages/openapi',
  'packages/sdk-android',
  'packages/sdk-astro',
  'packages/sdk-flutter',
  'packages/sdk-ios',
  'packages/sdk-js',
  'packages/sdk-next',
  'packages/sdk-react-native',
  'packages/sdk-remix',
  'packages/sdk-sveltekit',
  'packages/sdk-vue',
  'packages/shared',
  'packages/widget',
  'packages/workflows',
];

const exactTargets = new Map([
  ['README.md', 'README.md'],
  ['docs/accessibility-conformance-statement.md', 'docs/public/reference/accessibility.mdx'],
  [
    'docs/email-sms-deliverability-runbook.md',
    'docs/public/operations/messaging/deliverability.mdx',
  ],
  [
    'docs/email-template-lifecycle.md',
    'docs/public/operators/messages/email-template-lifecycle.mdx',
  ],
  ['docs/embed-generator.html', 'docs/public/developers/widget/embed-generator.html'],
  ['docs/performance.md', 'docs/public/reference/performance.mdx'],
  ['docs/privacy-retention-policy.md', 'docs/public/reference/privacy-and-retention.mdx'],
  [
    'docs/production-validation-harness.md',
    'docs/public/contributing/validation/production-harness.mdx',
  ],
  [
    'docs/security-tenant-isolation-audit.md',
    'docs/internal/audits/security-tenant-isolation-audit.md',
  ],
  ['docs/telnyx-sms-local.md', 'docs/public/developers/messaging/telnyx-local.mdx'],
  ['docs/testing-coverage.md', 'docs/public/contributing/testing.mdx'],
]);

const textExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdx',
  '.mjs',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

function walk(directory) {
  if (!existsSync(join(root, directory))) return [];
  const result = [];
  const visit = (absoluteDirectory) => {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const absolutePath = join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        const generatedDirectory =
          entry.name.startsWith('.next') ||
          [
            '.expo',
            '.git',
            '.nuxt',
            '.output',
            '.svelte-kit',
            '.turbo',
            'build',
            'coverage',
            'dist',
            'graphify-out',
            'node_modules',
            'out',
            'playwright-report',
            'target',
            'test-results',
          ].includes(entry.name);
        if (!generatedDirectory) {
          visit(absolutePath);
        }
      } else if (entry.isFile()) {
        result.push(relative(root, absolutePath).split(sep).join('/'));
      }
    }
  };
  visit(join(root, directory));
  return result;
}

function isDocumentationAsset(path) {
  if (path === 'README.md') return true;
  if (path === outputPath) return true;
  if (path.startsWith('docs/')) return true;
  if (/^packages\/[^/]+\/(?:.+\/)?README\.md$/.test(path)) return true;
  if (/^apps\/sdk-[^/]+-demo\/(?:.+\/)?README\.md$/.test(path)) return true;
  if (/^\.github\/(?:ISSUE_TEMPLATE\/.*|PULL_REQUEST_TEMPLATE\.md)$/.test(path)) return true;
  if (
    /^apps\/admin-dashboard\/src\/(?:app\/\(dashboard\)\/help|features\/(?:developer|dashboard))\//.test(
      path,
    )
  ) {
    return /\.(?:ts|tsx)$/.test(path);
  }
  return /^packages\/cli\/(?:README\.md|src\/(?:index|quickstart|setup-check|dev-webhooks|scaffold|embed-generator)\.(?:ts|test\.ts))$/.test(
    path,
  );
}

function proposedPath(path) {
  const exact = exactTargets.get(path);
  if (exact) return exact;
  if (path.startsWith('docs/completion/'))
    return path.replace('docs/completion/', 'docs/internal/completion/');
  if (/^docs\/.*(?:plan|spec)\.md$/.test(path)) {
    return path.replace('docs/', 'docs/internal/plans/');
  }
  if (/^docs\/.*(?:audit|evidence).*\.md$/.test(path)) {
    return path.replace('docs/', 'docs/internal/audits/');
  }
  if (path.startsWith('docs/brand/')) return path.replace('docs/brand/', 'docs/assets/brand/');
  if (path.startsWith('docs/internal/')) return path;
  return path;
}

function audience(path) {
  if (
    path.startsWith('docs/internal/') ||
    (path.startsWith('docs/') && /(?:plan|spec|audit|evidence)/.test(path))
  ) {
    return 'contributor';
  }
  if (/sdk|api|webhook|widget|developer|cli|embed|telnyx/.test(path)) return 'developer';
  if (/deployment|database|auth|clerk|temporal|incident|production/.test(path))
    return 'self-hoster';
  if (/contribut|testing|architecture|README|package/.test(path)) return 'contributor';
  return 'operator';
}

function contentType(path) {
  if (/runbook|incident/.test(path)) return 'runbook';
  if (/reference|contract|README/.test(path)) return 'reference';
  if (/quickstart|setup-check/.test(path)) return 'quickstart';
  if (/guide|help|webhook|deployment|sdk/.test(path)) return 'how-to';
  if (path.startsWith('docs/') && /plan|spec|audit|evidence|completion/.test(path))
    return 'internal';
  if (/\.png$|\.json$|\.html$/.test(path)) return 'asset';
  return 'concept';
}

function owner(path) {
  if (/sdk|api-reference|openapi|webhook|developer|packages\/cli/.test(path))
    return 'developer-platform';
  if (/deployment|database|temporal|incident|production|self-host/.test(path))
    return 'platform-operations';
  if (/security|privacy|auth|clerk/.test(path)) return 'security';
  if (path.startsWith('packages/')) return 'package-owner';
  if (/admin-dashboard|operator|content|brand|email/.test(path)) return 'product-ui';
  return 'documentation-architecture';
}

function visibility(path) {
  return proposedPath(path).startsWith('docs/internal/') ||
    (path.startsWith('docs/') && /(?:plan|spec|audit|evidence|completion)/.test(path))
    ? 'internal'
    : 'public';
}

function action(path) {
  const target = proposedPath(path);
  if (path.startsWith('docs/brand/')) return 'move';
  if (target.startsWith('docs/internal/') && target !== path) return 'move';
  if (target.endsWith('/')) return 'split';
  if (path === 'README.md' || /packages\/.*README|apps\/sdk-.*README/.test(path)) return 'rewrite';
  if (/apps\/admin-dashboard|packages\/cli\/src/.test(path)) return 'rewrite';
  return target === path ? 'keep' : 'rewrite';
}

function currentOssInclusion(path) {
  if (path === 'README.md') return 'included';
  if (publicDocs.some((entry) => path === entry || path.startsWith(`${entry}/`))) return 'included';
  if (publicPackageDirectories.some((entry) => path.startsWith(`${entry}/`))) return 'included';
  if (path.startsWith('apps/sdk-')) return 'included-through-app-directory';
  return 'excluded';
}

function sourceContracts(path) {
  if (/api-reference|openapi/.test(path))
    return 'packages/openapi/src/index.ts; packages/api/src/routes';
  if (/webhook/.test(path)) return 'packages/domain; packages/api/src/routes/modules/webhooks.ts';
  if (/sdk|demo/.test(path)) return 'package exports; scripts/sdk-parity-matrix.mjs';
  if (/cli|quickstart|setup-check/.test(path))
    return 'packages/cli/src/index.ts; package.json scripts';
  if (/dashboard|help|developer/.test(path))
    return 'dashboard routes; permissions; packages/docs-core';
  if (/deployment|temporal|incident|database/.test(path))
    return 'infra; runtime configuration; operational tests';
  return 'source; tests; package manifest';
}

function requiredValidation(path) {
  if (visibility(path) === 'internal') return 'public-boundary; oss-exclusion';
  if (/package.*README|^packages\//.test(path)) return 'package-readme; links; oss-export';
  if (/sdk|demo/.test(path)) return 'sdk-parity; typecheck-or-build; links';
  if (/dashboard|help|developer/.test(path)) return 'typecheck; unit; dashboard-doc-links; browser';
  if (/api-reference|webhook/.test(path)) return 'contract-drift; links; browser; performance';
  if (/\.png$|\.html$|\.json$/.test(path)) return 'asset-boundary; privacy-scan; links';
  return 'frontmatter; navigation; links; snippets; oss-export';
}

function csv(value) {
  const normalized = String(value).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  return `"${normalized.replaceAll('"', '""')}"`;
}

const allFiles = [
  'README.md',
  ...walk('docs'),
  ...walk('packages'),
  ...walk('apps'),
  ...walk('.github'),
]
  .filter(isDocumentationAsset)
  .filter((path, index, values) => values.indexOf(path) === index)
  .sort();

const searchableFiles = [
  ...walk('.github'),
  ...walk('apps'),
  ...walk('docs'),
  ...walk('infra'),
  ...walk('packages'),
  ...walk('scripts'),
  'AGENTS.md',
  'README.md',
  'package.json',
]
  .filter((path, index, values) => values.indexOf(path) === index)
  .filter((path) => path !== outputPath)
  .filter((path) => textExtensions.has(extname(path)) && existsSync(join(root, path)))
  .filter((path) => statSync(join(root, path)).size <= 2_000_000);

const searchableContent = searchableFiles.map((path) => ({
  path,
  content: readFileSync(join(root, path), 'utf8'),
}));

const header = [
  'Current path',
  'Proposed path',
  'Audience',
  'Content type',
  'Canonical owner',
  'Public or internal',
  'Action',
  'Source contracts',
  'Required validation',
  'Last verified date',
  'Migration status',
  'Inbound reference count',
  'Inbound reference paths',
  'Current OSS inclusion',
];

const rows = allFiles.map((path) => {
  const inbound = searchableContent
    .filter((candidate) => candidate.path !== path && candidate.content.includes(path))
    .map((candidate) => candidate.path)
    .sort();
  return [
    path,
    proposedPath(path),
    audience(path),
    contentType(path),
    owner(path),
    visibility(path),
    action(path),
    sourceContracts(path),
    requiredValidation(path),
    verifiedDate,
    path === outputPath ? 'active-ledger' : 'not-started',
    inbound.length,
    inbound.join('; '),
    currentOssInclusion(path),
  ];
});

writeFileSync(
  join(root, outputPath),
  `${[header, ...rows].map((row) => row.map(csv).join(',')).join('\n')}\n`,
  'utf8',
);

console.log(`Wrote ${rows.length} documentation assets to ${outputPath}`);
